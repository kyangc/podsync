package builder

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/pkg/errors"
	log "github.com/sirupsen/logrus"

	"github.com/mxpv/podsync/pkg/feed"
	"github.com/mxpv/podsync/pkg/model"
)

const defaultBilibiliUnavailableTTL = 24 * time.Hour

type BilibiliBuilder struct {
	client         *bilibiliAPIClient
	unavailableMu  sync.Mutex
	unavailable    map[string]time.Time
	unavailableTTL time.Duration
	now            func() time.Time
}

func (b *BilibiliBuilder) Build(_ context.Context, cfg *feed.Config) (*model.Feed, error) {
	info, err := ParseURL(cfg.URL)
	if err != nil {
		return nil, err
	}
	if info.Provider != model.ProviderBilibili {
		return nil, errors.New("not a bilibili feed")
	}

	result := &model.Feed{
		ItemID:          info.ItemID,
		Provider:        info.Provider,
		LinkType:        info.LinkType,
		Format:          cfg.Format,
		Quality:         cfg.Quality,
		CoverArtQuality: cfg.Custom.CoverArtQuality,
		PageSize:        pageSizeOrDefault(cfg.PageSize),
		PlaylistSort:    cfg.PlaylistSort,
		PrivateFeed:     cfg.PrivateFeed,
		UpdatedAt:       time.Now().UTC(),
		ItemURL:         cfg.URL,
	}

	client, err := b.client.withCookiesFile(cfg.Bilibili.CookiesFile)
	if err != nil {
		return nil, err
	}
	archives, err := b.populateFeedInfo(client, result, info)
	if err != nil {
		return nil, err
	}
	if err := b.populateEpisodes(client, result, archives, cfg.Bilibili.IncludeUpowerExclusive); err != nil {
		return nil, err
	}

	return result, nil
}

func (b *BilibiliBuilder) populateFeedInfo(client *bilibiliAPIClient, result *model.Feed, info model.Info) ([]bilibiliArchive, error) {
	switch info.LinkType {
	case model.TypeSeason:
		mid, seasonID, err := splitBilibiliListID(info.ItemID)
		if err != nil {
			return nil, err
		}

		user, err := client.user(mid)
		if err != nil {
			return nil, err
		}
		season, err := client.seasonArchives(mid, seasonID, 1, maxBilibiliPageSize)
		if err != nil {
			return nil, err
		}

		result.Author = user.Data.Card.Name
		result.CoverArt = season.Data.Meta.Cover
		result.Title = season.Data.Meta.Name
		result.Description = season.Data.Meta.Description
		result.ItemURL = fmt.Sprintf("https://space.bilibili.com/%s/lists/%s?type=season", mid, seasonID)

		return season.Data.Archives, nil

	case model.TypeSeries:
		mid, seriesID, err := splitBilibiliListID(info.ItemID)
		if err != nil {
			return nil, err
		}

		user, err := client.user(mid)
		if err != nil {
			return nil, err
		}
		series, err := client.series(seriesID)
		if err != nil {
			return nil, err
		}
		archives, err := client.seriesArchives(mid, seriesID, 1, maxBilibiliPageSize)
		if err != nil {
			return nil, err
		}

		result.Author = user.Data.Card.Name
		result.CoverArt = user.Data.Card.Face
		result.Title = series.Data.Meta.Name
		result.Description = series.Data.Meta.Description
		result.ItemURL = fmt.Sprintf("https://space.bilibili.com/%s/lists/%s?type=series", mid, seriesID)

		return archives.Data.Archives, nil

	case model.TypeUser:
		user, err := client.user(info.ItemID)
		if err != nil {
			return nil, err
		}
		archives, err := client.userArchives(info.ItemID, 1, maxBilibiliPageSize)
		if err != nil {
			return nil, err
		}

		result.Author = user.Data.Card.Name
		result.CoverArt = user.Data.Card.Face
		result.Title = user.Data.Card.Name
		result.Description = user.Data.Card.Description
		result.ItemURL = fmt.Sprintf("https://space.bilibili.com/%s", info.ItemID)

		return archives.Data.Archives, nil

	default:
		return nil, errors.New("unsupported bilibili link type")
	}
}

func (b *BilibiliBuilder) populateEpisodes(client *bilibiliAPIClient, result *model.Feed, archives []bilibiliArchive, includeUpowerExclusive bool) error {
	for _, archive := range archives {
		if len(result.Episodes) >= result.PageSize {
			return nil
		}

		if b.isUnavailableCached(archive.Bvid) {
			log.WithField("episode_id", archive.Bvid).Debug("skipping cached unavailable Bilibili episode")
			continue
		}

		episode, err := client.episode(archive.Bvid)
		if err != nil {
			if isBilibiliAPIErrorCode(err, -404) {
				b.markUnavailable(archive.Bvid)
				log.WithField("episode_id", archive.Bvid).Warn("skipping unavailable Bilibili episode")
				continue
			}
			return err
		}
		if episode.Data.IsUpowerExclusive && !includeUpowerExclusive {
			continue
		}

		publishedAt := archive.PublishedAt
		if publishedAt == 0 {
			publishedAt = episode.Data.PublishedAt
		}

		result.Episodes = append(result.Episodes, &model.Episode{
			ID:          episode.Data.Bvid,
			Title:       episode.Data.Title,
			Description: episode.Data.Description,
			Duration:    int64(episode.Data.Duration),
			Size:        int64(episode.Data.Duration * 15000),
			VideoURL:    "https://www.bilibili.com/video/" + episode.Data.Bvid,
			PubDate:     time.Unix(publishedAt, 0),
			Thumbnail:   episode.Data.Thumbnail,
			Status:      model.EpisodeNew,
		})
	}

	return nil
}

func pageSizeOrDefault(pageSize int) int {
	if pageSize == 0 {
		return model.DefaultPageSize
	}
	return pageSize
}

func splitBilibiliListID(id string) (string, string, error) {
	parts := strings.Split(id, ":")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", errors.New("invalid bilibili list id")
	}
	return parts[0], parts[1], nil
}

func (b *BilibiliBuilder) currentTime() time.Time {
	if b.now != nil {
		return b.now()
	}
	return time.Now()
}

func (b *BilibiliBuilder) isUnavailableCached(bvid string) bool {
	if b.unavailableTTL <= 0 || bvid == "" {
		return false
	}
	now := b.currentTime()
	b.unavailableMu.Lock()
	defer b.unavailableMu.Unlock()
	expiry, ok := b.unavailable[bvid]
	if !ok {
		return false
	}
	if !now.Before(expiry) {
		delete(b.unavailable, bvid)
		return false
	}
	return true
}

func (b *BilibiliBuilder) markUnavailable(bvid string) {
	if b.unavailableTTL <= 0 || bvid == "" {
		return
	}
	now := b.currentTime()
	b.unavailableMu.Lock()
	defer b.unavailableMu.Unlock()
	if b.unavailable == nil {
		b.unavailable = make(map[string]time.Time)
	}
	if len(b.unavailable) >= 256 {
		for k, exp := range b.unavailable {
			if !now.Before(exp) {
				delete(b.unavailable, k)
			}
		}
	}
	b.unavailable[bvid] = now.Add(b.unavailableTTL)
}

func NewBilibiliBuilder() (*BilibiliBuilder, error) {
	return &BilibiliBuilder{
		client:         newBilibiliAPIClient(nil, ""),
		unavailable:    make(map[string]time.Time),
		unavailableTTL: defaultBilibiliUnavailableTTL,
		now:            time.Now,
	}, nil
}

package remote

import (
	"crypto/rand"
	"encoding/base32"
	"path"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/mxpv/podsync/pkg/model"
)

const defaultR2Prefix = "audio"

func NewAssetToken() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf[:])), nil
}

func BuildR2Key(prefix string, task *model.RemotePublishTask, assetToken string) string {
	cleanPrefix := sanitizeR2Prefix(prefix)
	if cleanPrefix == "" {
		cleanPrefix = defaultR2Prefix
	}
	feedID := sanitizeR2Segment(task.FeedID)
	if feedID == "" {
		feedID = "feed"
	}
	episodeID := sanitizeR2Segment(task.LocalEpisodeID)
	if episodeID == "" {
		episodeID = "episode"
	}
	ext := strings.ToLower(filepath.Ext(task.MediaPath))
	if ext == "" {
		ext = ".bin"
	}
	return cleanPrefix + "/" + feedID + "/" + episodeID + "-" + assetToken + ext
}

func sanitizeR2Prefix(value string) string {
	value = strings.TrimSpace(value)
	parts := strings.Split(value, "/")
	cleanParts := make([]string, 0, len(parts))
	for _, part := range parts {
		if clean := sanitizeR2Segment(part); clean != "" {
			cleanParts = append(cleanParts, clean)
		}
	}
	if len(cleanParts) == 0 {
		return ""
	}
	return path.Join(cleanParts...)
}

func sanitizeR2Segment(value string) string {
	value = strings.TrimSpace(value)
	var b strings.Builder
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
			continue
		}
		b.WriteByte('_')
	}
	return strings.Trim(b.String(), "._-")
}

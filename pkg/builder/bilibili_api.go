package builder

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/pkg/errors"
)

const (
	defaultBilibiliAPIBaseURL = "https://api.bilibili.com"
	maxBilibiliPageSize       = 100
)

type bilibiliAPIClient struct {
	client  *http.Client
	baseURL string
}

func newBilibiliAPIClient(client *http.Client, baseURL string) *bilibiliAPIClient {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	if baseURL == "" {
		baseURL = defaultBilibiliAPIBaseURL
	}

	return &bilibiliAPIClient{
		client:  client,
		baseURL: baseURL,
	}
}

func (c *bilibiliAPIClient) get(path string, query url.Values, result any) error {
	endpoint, err := url.Parse(c.baseURL)
	if err != nil {
		return errors.Wrap(err, "invalid bilibili api base url")
	}
	endpoint.Path = path
	endpoint.RawQuery = query.Encode()

	req, err := http.NewRequest(http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return errors.Wrap(err, "failed to create bilibili api request")
	}
	setBilibiliRequestHeaders(req)

	resp, err := c.client.Do(req)
	if err != nil {
		return errors.Wrap(err, "failed to send bilibili api request")
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return errors.Wrap(err, "failed to read bilibili api response")
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("bilibili api returned %s: %s", resp.Status, string(body))
	}
	if err := json.Unmarshal(body, result); err != nil {
		return errors.Wrap(err, "failed to decode bilibili api response")
	}

	return nil
}

func setBilibiliRequestHeaders(req *http.Request) {
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	req.Header.Set("Origin", "https://www.bilibili.com")
	req.Header.Set("Referer", "https://www.bilibili.com/")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
}

type bilibiliAPIResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (r bilibiliAPIResponse) err() error {
	if r.Code != 0 {
		return fmt.Errorf("bilibili api error: %s", r.Message)
	}
	return nil
}

type bilibiliEpisodeResponse struct {
	bilibiliAPIResponse
	Data struct {
		Bvid              string `json:"bvid"`
		Title             string `json:"title"`
		Description       string `json:"desc"`
		Thumbnail         string `json:"pic"`
		PublishedAt       int64  `json:"pubdate"`
		Duration          int    `json:"duration"`
		IsUpowerExclusive bool   `json:"is_upower_exclusive"`
	} `json:"data"`
}

func (c *bilibiliAPIClient) episode(bvid string) (*bilibiliEpisodeResponse, error) {
	query := url.Values{}
	query.Set("bvid", bvid)

	var response bilibiliEpisodeResponse
	if err := c.get("/x/web-interface/view", query, &response); err != nil {
		return nil, err
	}
	if err := response.err(); err != nil {
		return nil, err
	}

	return &response, nil
}

type bilibiliUserResponse struct {
	bilibiliAPIResponse
	Data struct {
		Card struct {
			Name        string `json:"name"`
			Face        string `json:"face"`
			Description string `json:"sign"`
		} `json:"card"`
	} `json:"data"`
}

func (c *bilibiliAPIClient) user(mid string) (*bilibiliUserResponse, error) {
	query := url.Values{}
	query.Set("mid", mid)

	var response bilibiliUserResponse
	if err := c.get("/x/web-interface/card", query, &response); err != nil {
		return nil, err
	}
	if err := response.err(); err != nil {
		return nil, err
	}

	return &response, nil
}

type bilibiliArchive struct {
	Bvid        string `json:"bvid"`
	PublishedAt int64  `json:"pubdate"`
}

type bilibiliUserArchivesResponse struct {
	bilibiliAPIResponse
	Data struct {
		Archives []bilibiliArchive `json:"archives"`
	} `json:"data"`
}

func (c *bilibiliAPIClient) userArchives(mid string, pageNum, pageSize int) (*bilibiliUserArchivesResponse, error) {
	if pageSize > maxBilibiliPageSize || pageSize == 0 {
		pageSize = maxBilibiliPageSize
	}

	query := url.Values{}
	query.Set("keywords", "")
	query.Set("mid", mid)
	query.Set("pn", fmt.Sprintf("%d", pageNum))
	query.Set("ps", fmt.Sprintf("%d", pageSize))

	var response bilibiliUserArchivesResponse
	if err := c.get("/x/series/recArchivesByKeywords", query, &response); err != nil {
		return nil, err
	}
	if err := response.err(); err != nil {
		return nil, err
	}

	return &response, nil
}

type bilibiliSeasonArchivesResponse struct {
	bilibiliAPIResponse
	Data struct {
		Archives []bilibiliArchive `json:"archives"`
		Meta     struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Cover       string `json:"cover"`
		} `json:"meta"`
	} `json:"data"`
}

func (c *bilibiliAPIClient) seasonArchives(mid, seasonID string, pageNum, pageSize int) (*bilibiliSeasonArchivesResponse, error) {
	if pageSize > maxBilibiliPageSize || pageSize == 0 {
		pageSize = maxBilibiliPageSize
	}

	query := url.Values{}
	query.Set("season_id", seasonID)
	query.Set("mid", mid)
	query.Set("page_num", fmt.Sprintf("%d", pageNum))
	query.Set("page_size", fmt.Sprintf("%d", pageSize))

	var response bilibiliSeasonArchivesResponse
	if err := c.get("/x/polymer/web-space/seasons_archives_list", query, &response); err != nil {
		return nil, err
	}
	if err := response.err(); err != nil {
		return nil, err
	}

	return &response, nil
}

type bilibiliSeriesResponse struct {
	bilibiliAPIResponse
	Data struct {
		Meta struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"meta"`
	} `json:"data"`
}

func (c *bilibiliAPIClient) series(seriesID string) (*bilibiliSeriesResponse, error) {
	query := url.Values{}
	query.Set("series_id", seriesID)

	var response bilibiliSeriesResponse
	if err := c.get("/x/series/series", query, &response); err != nil {
		return nil, err
	}
	if err := response.err(); err != nil {
		return nil, err
	}

	return &response, nil
}

type bilibiliSeriesArchivesResponse struct {
	bilibiliAPIResponse
	Data struct {
		Archives []bilibiliArchive `json:"archives"`
	} `json:"data"`
}

func (c *bilibiliAPIClient) seriesArchives(mid, seriesID string, pageNum, pageSize int) (*bilibiliSeriesArchivesResponse, error) {
	if pageSize > maxBilibiliPageSize || pageSize == 0 {
		pageSize = maxBilibiliPageSize
	}

	query := url.Values{}
	query.Set("mid", mid)
	query.Set("series_id", seriesID)
	query.Set("ps", fmt.Sprintf("%d", pageSize))
	query.Set("pn", fmt.Sprintf("%d", pageNum))

	var response bilibiliSeriesArchivesResponse
	if err := c.get("/x/series/archives", query, &response); err != nil {
		return nil, err
	}
	if err := response.err(); err != nil {
		return nil, err
	}

	return &response, nil
}

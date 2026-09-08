package web

import (
	"crypto/subtle"
	"encoding/json"
	"expvar"
	"fmt"
	"net/http"
	"strings"
	"time"

	log "github.com/sirupsen/logrus"

	"github.com/mxpv/podsync/pkg/db"
	"github.com/mxpv/podsync/pkg/model"
)

type Server struct {
	http.Server
	db               db.Storage
	healthMaxFeedAge time.Duration
	mediaLifecycle   MediaLifecycle
	mediaToken       string
}

type MediaLifecycle interface {
	Exists(key string) (bool, error)
	Delete(key string) error
}

type Option func(*Server)

func WithMediaLifecycle(lifecycle MediaLifecycle, token string) Option {
	return func(server *Server) {
		server.mediaLifecycle = lifecycle
		server.mediaToken = token
	}
}

type Config struct {
	// Hostname to use for download links
	Hostname string `toml:"hostname"`
	// Port is a server port to listen to
	Port int `toml:"port"`
	// Bind a specific IP addresses for server
	// "*": bind all IP addresses which is default option
	// localhost or 127.0.0.1  bind a single IPv4 address
	BindAddress string `toml:"bind_address"`
	// Flag indicating if the server will use TLS
	TLS bool `toml:"tls"`
	// Path to a certificate file for TLS connections
	CertificatePath string `toml:"certificate_path"`
	// Path to a private key file for TLS connections
	KeyFilePath string `toml:"key_file_path"`
	// Specify path for reverse proxy and only [A-Za-z0-9]
	Path string `toml:"path"`
	// DataDir is a path to a directory to keep XML feeds and downloaded episodes,
	// that will be available to user via web server for download.
	DataDir string `toml:"data_dir"`
	// WebUIEnabled is a flag indicating if web UI is enabled
	WebUIEnabled bool `toml:"web_ui"`
	// DebugEndpoints enables /debug/vars endpoint for runtime metrics (disabled by default)
	DebugEndpoints bool `toml:"debug_endpoints"`
	// NoIndex blocks search engine indexing by serving robots.txt and adding X-Robots-Tag header (disabled by default)
	NoIndex bool `toml:"no_index"`
	// NoListing returns 404 for directory listings, only serving actual files (disabled by default)
	NoListing bool `toml:"no_listing"`
	// HealthMaxFeedAge is the maximum age of the latest successful feed update before /health reports unhealthy.
	HealthMaxFeedAge time.Duration `toml:"health_max_feed_age"`
}

const defaultHealthMaxFeedAge = 24 * time.Hour

func New(cfg Config, storage http.FileSystem, database db.Storage, options ...Option) *Server {
	port := cfg.Port
	if port == 0 {
		port = 8080
	}

	bindAddress := cfg.BindAddress
	if bindAddress == "*" {
		bindAddress = ""
	}

	srv := Server{
		db:               database,
		healthMaxFeedAge: cfg.healthMaxFeedAge(),
	}
	for _, option := range options {
		option(&srv)
	}

	srv.Addr = fmt.Sprintf("%s:%d", bindAddress, port)
	log.Debugf("using address: %s:%s", bindAddress, srv.Addr)

	// Use a custom mux instead of http.DefaultServeMux to avoid exposing
	// debug endpoints registered by imported packages (security fix for #799)
	mux := http.NewServeMux()

	fileServer := http.FileServer(storage)
	mountPath := "/"
	if cfg.Path != "" {
		mountPath = fmt.Sprintf("/%s", cfg.Path)
		fileServer = http.StripPrefix(mountPath, fileServer)
		mountPath += "/"
	}

	log.Debugf("handle path: %s", mountPath)
	mux.Handle(mountPath, fileServer)

	// Add health check endpoint
	mux.HandleFunc("/health", srv.healthCheckHandler)
	if srv.mediaLifecycle != nil && srv.mediaToken != "" {
		mux.HandleFunc("/api/remote-media/", srv.remoteMediaLifecycleHandler)
	}

	// Optionally enable debug endpoints (disabled by default for security)
	if cfg.DebugEndpoints {
		log.Info("debug endpoints enabled at /debug/vars")
		mux.Handle("/debug/vars", expvar.Handler())
	}

	srv.Handler = mux
	if cfg.NoIndex {
		log.Info("search engine indexing blocked (no_index enabled)")
		mux.HandleFunc("/robots.txt", robotsTxtHandler)
		srv.Handler = noIndexMiddleware(srv.Handler)
	}

	return &srv
}

func (s *Server) remoteMediaLifecycleHandler(w http.ResponseWriter, r *http.Request) {
	const prefix = "/api/remote-media/"
	expected := []byte("Bearer " + s.mediaToken)
	provided := []byte(r.Header.Get("Authorization"))
	if len(expected) != len(provided) || subtle.ConstantTimeCompare(expected, provided) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	key := strings.TrimPrefix(r.URL.Path, prefix)
	if key == "" {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodHead:
		exists, err := s.mediaLifecycle.Exists(key)
		if err != nil {
			http.Error(w, "media lifecycle check failed", http.StatusBadGateway)
			return
		}
		if !exists {
			http.NotFound(w, r)
			return
		}
	case http.MethodDelete:
		if err := s.mediaLifecycle.Delete(key); err != nil {
			http.Error(w, "media lifecycle delete failed", http.StatusBadGateway)
			return
		}
	default:
		w.Header().Set("Allow", http.MethodHead+", "+http.MethodDelete)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type HealthStatus struct {
	Status              string     `json:"status"`
	Timestamp           time.Time  `json:"timestamp"`
	FailedEpisodes      int        `json:"failed_episodes,omitempty"`
	LastFeedUpdate      *time.Time `json:"last_feed_update,omitempty"`
	MaxFeedAgeSeconds   int64      `json:"max_feed_age_seconds,omitempty"`
	StaleFeedAgeSeconds int64      `json:"stale_feed_age_seconds,omitempty"`
	Message             string     `json:"message,omitempty"`
}

func (s *Server) healthCheckHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	now := time.Now()
	maxFeedAge := s.healthMaxFeedAge
	status := HealthStatus{
		Timestamp:         now,
		MaxFeedAgeSeconds: int64(maxFeedAge.Seconds()),
	}

	w.Header().Set("Content-Type", "application/json")
	if s.db == nil {
		status.Status = "unhealthy"
		status.Message = "database is not configured"
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(status)
		return
	}

	// Check for recent download failures within the last 24 hours
	failedCount := 0
	cutoffTime := now.Add(-24 * time.Hour)
	feedCount := 0
	var lastFeedUpdate time.Time

	// Walk through all feeds to count recent failures
	err := s.db.WalkFeeds(ctx, func(feed *model.Feed) error {
		feedCount++
		if feed.UpdatedAt.After(lastFeedUpdate) {
			lastFeedUpdate = feed.UpdatedAt
		}
		return s.db.WalkEpisodes(ctx, feed.ID, func(episode *model.Episode) error {
			if episode.Status == model.EpisodeError && episode.PubDate.After(cutoffTime) {
				failedCount++
			}
			return nil
		})
	})

	if !lastFeedUpdate.IsZero() {
		lastUpdate := lastFeedUpdate
		status.LastFeedUpdate = &lastUpdate
		status.StaleFeedAgeSeconds = int64(now.Sub(lastFeedUpdate).Seconds())
	}

	if err != nil {
		log.WithError(err).Error("health check database error")
		status.Status = "unhealthy"
		status.Message = "database error during health check"
		w.WriteHeader(http.StatusServiceUnavailable)
	} else if failedCount > 0 {
		status.Status = "unhealthy"
		status.FailedEpisodes = failedCount
		status.Message = fmt.Sprintf("found %d failed downloads in the last 24 hours", failedCount)
		w.WriteHeader(http.StatusServiceUnavailable)
	} else if feedCount == 0 || lastFeedUpdate.IsZero() {
		status.Status = "unhealthy"
		status.Message = "no successful feed updates recorded"
		w.WriteHeader(http.StatusServiceUnavailable)
	} else if now.Sub(lastFeedUpdate) > maxFeedAge {
		status.Status = "unhealthy"
		status.Message = fmt.Sprintf("latest successful feed update is older than %s", maxFeedAge)
		w.WriteHeader(http.StatusServiceUnavailable)
	} else {
		status.Status = "healthy"
		status.Message = "recent feed updates and downloads look healthy"
		w.WriteHeader(http.StatusOK)
	}

	json.NewEncoder(w).Encode(status)
}

func (cfg Config) healthMaxFeedAge() time.Duration {
	if cfg.HealthMaxFeedAge <= 0 {
		return defaultHealthMaxFeedAge
	}

	return cfg.HealthMaxFeedAge
}

func robotsTxtHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte("User-agent: *\nDisallow: /\n"))
}

func noIndexMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Robots-Tag", "noindex, nofollow")
		next.ServeHTTP(w, r)
	})
}

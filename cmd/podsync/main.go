package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jessevdk/go-flags"
	"github.com/mxpv/podsync/pkg/feed"
	"github.com/mxpv/podsync/pkg/model"
	"github.com/mxpv/podsync/services/migrate"
	"github.com/mxpv/podsync/services/update"
	"github.com/mxpv/podsync/services/web"
	"github.com/robfig/cron/v3"
	log "github.com/sirupsen/logrus"
	"golang.org/x/sync/errgroup"
	"gopkg.in/natefinch/lumberjack.v2"

	"github.com/mxpv/podsync/pkg/db"
	"github.com/mxpv/podsync/pkg/fs"
	"github.com/mxpv/podsync/pkg/ytdl"
)

type Opts struct {
	ConfigPath             string `long:"config" short:"c" default:"config.toml" env:"PODSYNC_CONFIG_PATH"`
	Headless               bool   `long:"headless"`
	MigrateFilenames       bool   `long:"migrate-filenames" description:"Migrate existing downloaded filenames to current filename_template and exit"`
	MigrateFilenamesDryRun bool   `long:"migrate-filenames-dry-run" description:"Preview filename migration without writing changes (requires --migrate-filenames)"`
	Debug                  bool   `long:"debug"`
	NoBanner               bool   `long:"no-banner"`
}

const banner = `
 _______  _______  ______   _______           _        _______ 
(  ____ )(  ___  )(  __  \ (  ____ \|\     /|( (    /|(  ____ \
| (    )|| (   ) || (  \  )| (    \/( \   / )|  \  ( || (    \/
| (____)|| |   | || |   ) || (_____  \ (_) / |   \ | || |      
|  _____)| |   | || |   | |(_____  )  \   /  | (\ \) || |      
| (      | |   | || |   ) |      ) |   ) (   | | \   || |      
| )      | (___) || (__/  )/\____) |   | |   | )  \  || (____/\
|/       (_______)(______/ \_______)   \_/   |/    )_)(_______/
`

var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
	arch    = ""
)

func main() {
	log.SetFormatter(&log.TextFormatter{
		TimestampFormat: time.RFC3339,
		FullTimestamp:   true,
	})

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Parse args
	opts := Opts{}
	_, err := flags.Parse(&opts)
	if err != nil {
		log.WithError(err).Fatal("failed to parse command line arguments")
	}

	if opts.Debug {
		log.SetLevel(log.DebugLevel)
	}
	if opts.MigrateFilenamesDryRun && !opts.MigrateFilenames {
		log.Fatal("--migrate-filenames-dry-run requires --migrate-filenames")
	}

	if !opts.NoBanner {
		log.Info(banner)
	}

	log.WithFields(log.Fields{
		"version": version,
		"commit":  commit,
		"date":    date,
		"arch":    arch,
	}).Info("running podsync")

	// Load TOML file
	log.Debugf("loading configuration %q", opts.ConfigPath)
	cfg, err := LoadConfig(opts.ConfigPath)
	if err != nil {
		log.WithError(err).Fatal("failed to load configuration file")
	}

	if cfg.Log.Filename != "" {
		log.Infof("Using log file: %s", cfg.Log.Filename)

		log.SetOutput(&lumberjack.Logger{
			Filename:   cfg.Log.Filename,
			MaxSize:    cfg.Log.MaxSize,
			MaxBackups: cfg.Log.MaxBackups,
			MaxAge:     cfg.Log.MaxAge,
			Compress:   cfg.Log.Compress,
		})

		// Optionally enable debug mode from config.toml
		if cfg.Log.Debug {
			log.SetLevel(log.DebugLevel)
		}
	}

	remoteClient := &http.Client{Timeout: defaultRemoteFetchTimeout + 5*time.Second}

	database, err := db.NewBadger(&cfg.Database)
	if err != nil {
		log.WithError(err).Fatal("failed to open database")
	}
	defer func() {
		if err := database.Close(); err != nil {
			log.WithError(err).Error("failed to close database")
		}
	}()

	var storage fs.Storage
	switch cfg.Storage.Type {
	case "local":
		storage, err = fs.NewLocal(cfg.Storage.Local.DataDir, cfg.Server.WebUIEnabled, cfg.Server.NoListing)
	case "s3":
		storage, err = fs.NewS3(cfg.Storage.S3) // serving files from S3 is not supported, so no WebUI either
	default:
		log.Fatalf("unknown storage type: %s", cfg.Storage.Type)
	}
	if err != nil {
		log.WithError(err).Fatal("failed to open storage")
	}

	remoteEvents, err := buildRemoteEventRecorder(cfg, newRemoteEventReporter)
	if err != nil {
		log.WithError(err).Warn("remote event reporting disabled")
	}
	recordRemoteRunStarted(remoteEvents)

	resolved, err := resolveFeeds(ctx, cfg, remoteClient)
	recordRemoteConfigEvent(remoteEvents, resolved, err)
	if err != nil {
		log.WithError(err).Error("failed to resolve remote feeds")
	}
	activeFeeds := resolved.Feeds
	if err := writeAcceptedRemoteConfigCache(cfg, resolved); err != nil {
		log.WithError(err).Warn("failed to write accepted remote config cache")
	}
	log.WithField("source", resolved.Source).Info("resolved feed configuration")

	if opts.MigrateFilenames {
		if cfg.Storage.Type == "s3" && !opts.MigrateFilenamesDryRun {
			log.Fatal("--migrate-filenames is not supported with storage.type = \"s3\"; use --migrate-filenames-dry-run or migrate with local storage")
		}

		migration := migrate.New(activeFeeds, database, storage, opts.MigrateFilenamesDryRun)
		result, err := migration.Run(ctx)
		if err != nil {
			log.WithError(err).Fatal("filename migration failed")
		}
		log.WithFields(log.Fields{
			"feeds":                   result.Feeds,
			"episodes":                result.Episodes,
			"migrated":                result.Migrated,
			"already_good":            result.AlreadyGood,
			"missing_old":             result.MissingOld,
			"skipped_existing_target": result.SkippedDueToExistingTarget,
			"dry_run":                 opts.MigrateFilenamesDryRun,
		}).Info("filename migration completed")
		return
	}

	downloader, err := ytdl.New(ctx, cfg.Downloader)
	if err != nil {
		log.WithError(err).Fatal("youtube-dl error")
	}

	// Run updater thread
	log.Debug("creating key providers")
	keys, err := newKeyProviders(cfg.Tokens)
	if err != nil {
		log.WithError(err).Fatal("failed to create key providers")
	}

	log.Debug("creating update manager")
	updateOptions := remotePublishOptions(cfg, database)
	if remoteEvents != nil {
		updateOptions = append(updateOptions, update.WithRemoteEventSink(remoteEvents))
	}
	manager, err := update.NewUpdater(activeFeeds, keys, cfg.Server.Hostname, downloader, database, storage, updateOptions...)
	if err != nil {
		log.WithError(err).Fatal("failed to create updater")
	}
	remoteProcessor, err := buildRemoteProcessor(cfg, database, newRemoteR2Publisher, newRemoteNASUpserter, remoteEvents)
	if err != nil {
		log.WithError(err).Warn("remote publish disabled")
	} else if remoteProcessor == nil && cfg.Remote.Enabled {
		log.Warn("remote publish disabled: R2 requires local storage and complete [r2] config")
	}
	remoteTombstoneSyncer, err := buildRemoteTombstoneSyncer(cfg, database, newRemoteTombstoneFetcher, remoteEvents)
	if err != nil {
		log.WithError(err).Warn("remote tombstone sync disabled")
	}
	syncRemoteTombstonesOnce(ctx, remoteTombstoneSyncer)

	// In Headless mode, do one round of feed updates and quit
	if opts.Headless {
		for _, _feed := range activeFeeds {
			if err := manager.Update(ctx, _feed); err != nil {
				log.WithError(err).Errorf("failed to update feed: %s", _feed.URL)
			}
		}
		processRemotePublishOnce(ctx, remoteProcessor)
		eventFlushCtx, eventFlushCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer eventFlushCancel()
		recordRemoteRunFinishedAndFlush(eventFlushCtx, remoteEvents)
		return
	}

	// Queue of feeds to update
	updates := make(chan *feed.Config, 16)
	defer close(updates)

	group, ctx := errgroup.WithContext(ctx)
	defer func() {
		if err := group.Wait(); err != nil && (err != context.Canceled && err != http.ErrServerClosed) {
			log.WithError(err).Error("wait error")
		}
		log.Info("gracefully stopped")
	}()

	// Create Cron
	c := cron.New(cron.WithChain(cron.SkipIfStillRunning(cron.DiscardLogger)))
	entries := make(map[string]scheduledFeed)
	var entriesMu sync.RWMutex

	if remoteProcessor != nil {
		group.Go(func() error {
			return runRemotePublishLoop(ctx, remoteProcessor, defaultRemotePublishInterval)
		})
	}
	if remoteTombstoneSyncer != nil {
		group.Go(func() error {
			return runRemoteTombstoneLoop(ctx, remoteTombstoneSyncer, defaultRemoteTombstoneInterval)
		})
	}
	if remoteEvents != nil {
		group.Go(func() error {
			return runRemoteEventLoop(ctx, remoteEvents, defaultRemoteEventInterval)
		})
	}

	// Run updates listener
	group.Go(func() error {
		for {
			select {
			case _feed := <-updates:
				entriesMu.RLock()
				currentFeed, ok := manager.Feed(_feed.ID)
				entriesMu.RUnlock()
				if !ok {
					log.WithField("feed_id", _feed.ID).Info("skipping stale queued feed update")
					continue
				}
				if err := manager.Update(ctx, currentFeed); err != nil {
					log.WithError(err).Errorf("failed to update feed: %s", currentFeed.URL)
				} else {
					entriesMu.RLock()
					entry, entryOK := entries[currentFeed.ID]
					entriesMu.RUnlock()
					if entryOK {
						log.Infof("next update of %s: %s", currentFeed.ID, c.Entry(entry.entryID).Next)
					}
				}
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	})

	// Run cron scheduler
	group.Go(func() error {
		entriesMu.Lock()
		feedsToQueue, err := reconcileFeedSchedules(c, entries, activeFeeds, updates)
		if err != nil {
			entriesMu.Unlock()
			log.WithError(err).Fatal("can't reconcile cron tasks")
		}
		entriesMu.Unlock()
		enqueueFeedUpdates(updates, feedsToQueue)

		c.Start()

		var refresh <-chan time.Time
		var ticker *time.Ticker
		if cfg.Remote.Enabled {
			ticker = time.NewTicker(cfg.Remote.ConfigRefreshInterval)
			refresh = ticker.C
			defer ticker.Stop()
		}

		for {
			select {
			case <-refresh:
				resolved, apply, err := refreshFeeds(ctx, cfg, remoteClient)
				recordRemoteConfigEvent(remoteEvents, resolved, err)
				if err != nil {
					log.WithError(err).Error("failed to refresh remote feeds")
				}
				if !apply {
					log.Info("keeping current feed configuration")
					continue
				}

				entriesMu.Lock()
				feedsToQueue, err := reconcileFeedSchedules(c, entries, resolved.Feeds, updates)
				if err != nil {
					entriesMu.Unlock()
					log.WithError(err).Error("failed to reconcile remote feed schedules")
					continue
				}
				manager.SetFeeds(resolved.Feeds)
				activeFeeds = resolved.Feeds
				entriesMu.Unlock()

				syncRemoteTombstonesOnce(ctx, remoteTombstoneSyncer)
				if err := writeAcceptedRemoteConfigCache(cfg, resolved); err != nil {
					log.WithError(err).Warn("failed to write accepted remote config cache")
				}
				enqueueFeedUpdates(updates, feedsToQueue)
				log.WithField("source", resolved.Source).Info("refreshed feed configuration")
			case <-ctx.Done():
				log.Info("shutting down cron")
				c.Stop()

				return ctx.Err()
			}
		}
	})

	if cfg.Storage.Type == "s3" {
		return // S3 content is hosted externally
	}

	// Run web server
	srv := web.New(cfg.Server, storage, database)

	group.Go(func() error {
		log.Infof("running listener at %s", srv.Addr)
		if cfg.Server.TLS {
			return srv.ListenAndServeTLS(cfg.Server.CertificatePath, cfg.Server.KeyFilePath)
		} else {
			return srv.ListenAndServe()
		}
	})

	group.Go(func() error {
		// Shutdown web server
		defer func() {
			ctxShutDown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer func() {
				cancel()
			}()
			log.Info("shutting down web server")
			if err := srv.Shutdown(ctxShutDown); err != nil {
				log.WithError(err).Error("server shutdown failed")
			}
		}()

		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-stop:
				cancel()
				return nil
			}
		}
	})
}

func newKeyProviders(tokens map[model.Provider]StringSlice) (map[model.Provider]feed.KeyProvider, error) {
	keys := map[model.Provider]feed.KeyProvider{}
	for name, list := range tokens {
		if name == model.ProviderBilibili {
			continue
		}

		provider, err := feed.NewKeyProvider(list)
		if err != nil {
			return nil, fmt.Errorf("failed to create key provider for %q: %w", name, err)
		}
		keys[name] = provider
	}

	return keys, nil
}

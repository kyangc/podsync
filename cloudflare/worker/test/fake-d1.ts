import type {
  AdminEpisodeListRow,
  AdminEventRow,
  AdminFeedFilters,
  AdminFeedListRow,
  AdminSubscriptionFeedRow,
  AdminSubscriptionOpmlRow,
  AdminSyncRunRow,
  DownloaderDefaults,
  EpisodeStatus,
  EventLevel,
  FeedTomlRow,
  PublicEpisodeRow,
  PublicFeedRow,
  PublicOpmlFeedRow,
  RemoteEventType,
  SyncRunStatus,
  TombstoneChangeRow,
} from "../src/db";

interface FakeD1Options {
  tomlFeeds?: FeedTomlRow[] | undefined;
  youtubeDefaults?: DownloaderDefaults | null | undefined;
  publicFeedsByHash?: Map<string, PublicFeedRow> | undefined;
  opmlTokenHashes?: Set<string> | undefined;
  opmlTokensByHash?: Map<string, FakeOpmlTokenRow> | undefined;
  feedsByID?: Map<string, FakeFeedRow> | undefined;
  feedMetadataByID?: Map<string, FakeFeedMetadataRow> | undefined;
  episodesByKey?: Map<string, FakeEpisodeRow> | undefined;
  tombstoneChanges?: FakeTombstoneChangeRow[] | undefined;
  syncRunsByID?: Map<string, FakeSyncRunRow> | undefined;
  eventsByKey?: Map<string, FakeEventRow> | undefined;
  sqlLog?: string[] | undefined;
  beforeEpisodeUpsert?: ((key: string, episode: FakeEpisodeRow | undefined, options: FakeD1Options) => void) | undefined;
  beforeEpisodeStatusUpdate?: ((key: string, episode: FakeEpisodeRow | undefined, options: FakeD1Options) => void) | undefined;
  beforeFeedConfigUpdate?: ((feedID: string, options: FakeD1Options) => void) | undefined;
  beforeFeedMetadataUpsert?: ((feedID: string, options: FakeD1Options) => void) | undefined;
  beforeFeedStatusUpdate?: ((feedID: string, options: FakeD1Options) => void) | undefined;
  beforeFeedDeleteTombstoneInsert?: ((episodesByKey: Map<string, FakeEpisodeRow> | undefined) => void) | undefined;
  beforeTombstoneSnapshot?: (() => void) | undefined;
  failTombstoneInsert?: boolean | undefined;
  failPurgeUpdateKeys?: Set<string> | undefined;
  feedInsertUniqueCollision?: ((row: FakeFeedRow) => boolean) | undefined;
  failFeedFiltersUpsert?: boolean | undefined;
  lastChanges?: number | undefined;
}

export interface FakeFeedRow {
  feed_id: string;
  provider: "youtube" | "bilibili";
  url?: string | undefined;
  title_override?: string | null | undefined;
  description_override?: string | null | undefined;
  enabled?: number;
  include_in_opml?: number;
  private_feed?: number | undefined;
  update_period?: string | undefined;
  page_size?: number | undefined;
  keep_last?: number | undefined;
  cookie_profile?: string | null | undefined;
  bilibili_include_upower_exclusive?: number | undefined;
  feed_token_hash?: string | undefined;
  public_path?: string | null | undefined;
  deleted_at?: string | null | undefined;
  metadata_title?: string | null | undefined;
  metadata_description?: string | null | undefined;
  title?: string | null | undefined;
  not_title?: string | null | undefined;
  description?: string | null | undefined;
  not_description?: string | null | undefined;
  min_duration?: number | null | undefined;
  max_duration?: number | null | undefined;
  min_age?: number | null | undefined;
  max_age?: number | null | undefined;
}

interface FakeOpmlTokenRow {
  label: string;
  public_path: string | null;
  enabled?: number | undefined;
}

export interface FakeFeedMetadataRow {
  feed_id: string;
  provider: "youtube" | "bilibili";
  source_url: string;
  title: string | null;
  description: string | null;
  image_url: string | null;
  link: string | null;
  author: string | null;
  category: string | null;
  language: string | null;
  explicit: number | null;
  last_source_update_at: string | null;
  reported_at: string;
}

interface FakeReadableFeed {
  feed_id: string;
  provider: "youtube" | "bilibili";
  url: string;
  title_override: string | null;
  description_override: string | null;
  enabled: number;
  include_in_opml: number;
  private_feed: number;
  update_period: string;
  page_size: number;
  keep_last: number;
  cookie_profile: string | null;
  bilibili_include_upower_exclusive: number;
  feed_token_hash: string;
  public_path: string | null;
  deleted_at: string | null;
  metadata_title: string | null;
  metadata_description: string | null;
  metadata_image_url: string | null;
  metadata_link: string | null;
  metadata_last_source_update_at: string | null;
  metadata_reported_at: string | null;
  latest_episode_published_at: string | null;
  episode_count: number;
  title: string | null;
  not_title: string | null;
  description: string | null;
  not_description: string | null;
  min_duration: number | null;
  max_duration: number | null;
  min_age: number | null;
  max_age: number | null;
}

export interface FakeEpisodeRow {
  feed_id: string;
  provider: "youtube" | "bilibili";
  source_episode_id: string;
  local_episode_id: string;
  source_url: string | null;
  thumbnail: string | null;
  title: string | null;
  description: string | null;
  published_at: string | null;
  duration: number | null;
  status: EpisodeStatus;
  r2_key: string | null;
  size: number;
  mime_type: string;
  asset_token: string;
  deleted_at: string | null;
  purge_after: string | null;
  updated_at: string | null;
}

export interface FakeTombstoneChangeRow extends TombstoneChangeRow {}

export interface FakeSyncRunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: SyncRunStatus;
  feeds_updated: number;
  episodes_downloaded: number;
  episodes_uploaded: number;
  errors_count: number;
}

export interface FakeEventRow {
  run_id: string;
  sequence: number;
  event_time: string;
  level: EventLevel;
  type: RemoteEventType;
  feed_id: string | null;
  local_episode_id: string | null;
  message: string | null;
  error_code: string | null;
  error_detail: string | null;
}

class FakeStatement {
  private params: unknown[] = [];

  constructor(
    private readonly options: FakeD1Options,
    private readonly query: string,
  ) {}

  bind(...params: unknown[]): D1PreparedStatement {
    this.params = params;
    return this as unknown as D1PreparedStatement;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return {
      results: this.allRows() as T[],
      success: true,
      meta: {},
    } as D1Result<T>;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM global_downloader_defaults")) {
      return (this.options.youtubeDefaults ?? null) as T | null;
    }

    if (this.query.includes("FROM feeds f") && this.query.includes("feed_token_hash = ?")) {
      const tokenHash = String(this.params[0] ?? "");
      const feed = this.options.publicFeedsByHash?.get(tokenHash) ?? null;
      if (feed && /f\.enabled\s*=\s*1/.test(this.query)) {
        const tomlFeed = this.options.tomlFeeds?.find((row) => row.feed_id === feed.feed_id);
        const feedRow = this.options.feedsByID?.get(feed.feed_id);
        if ((tomlFeed?.enabled ?? feedRow?.enabled ?? 1) !== 1) return null;
      }
      if (feed) return feed as T;
      const readable = fakeFeedRows(this.options).find((row) => row.feed_token_hash === tokenHash);
      if (!readable) return null;
      if (/f\.enabled\s*=\s*1/.test(this.query) && readable.enabled !== 1) return null;
      return publicFeedRow(readable) as T;
    }

    if (this.query.includes("FROM feeds") && this.query.includes("WHERE feed_id = ?")) {
      const feedID = String(this.params[0] ?? "");
      const feed = this.options.feedsByID?.get(feedID);
      if (feed) {
        if (this.query.includes("deleted_at IS NULL") && feed.deleted_at) return null;
        return feed as T;
      }
      const tomlFeed = this.options.tomlFeeds?.find((row) => row.feed_id === feedID);
      if (tomlFeed && this.query.includes("deleted_at IS NULL") && (tomlFeed as FeedTomlRow & { deleted_at?: string | null }).deleted_at) return null;
      return (tomlFeed ?? null) as T | null;
    }

    if (this.query.includes("COUNT(*) AS candidate_count") && this.query.includes("FROM episodes")) {
      const feedID = String(this.params[0] ?? "");
      const candidateCount = [...(this.options.episodesByKey?.values() ?? [])]
        .filter((episode) => episode.feed_id === feedID && feedDeleteCandidateStatus(episode.status))
        .length;
      return { candidate_count: candidateCount } as T;
    }

    if (this.query.includes("FROM episodes") && this.query.includes("WHERE feed_id = ? AND local_episode_id = ?")) {
      const key = fakeEpisodeKey(String(this.params[0] ?? ""), String(this.params[1] ?? ""));
      const episode = this.options.episodesByKey?.get(key);
      if (!episode) return null;
      if (this.query.includes("SELECT status")) {
        return { status: episode.status } as T;
      }
      return episode as T;
    }

    if (this.query.includes("FROM opml_tokens") && this.query.includes("token_hash = ?")) {
      const tokenHash = String(this.params[0] ?? "");
      const token = this.options.opmlTokensByHash?.get(tokenHash);
      if (token) return (token.enabled ?? 1) === 1 ? ({ id: 1 } as T) : null;
      return (this.options.opmlTokenHashes?.has(tokenHash) ? { id: 1 } : null) as T | null;
    }

    if (this.query.includes("MAX(sequence)") && this.query.includes("FROM tombstone_changes")) {
      const max = (this.options.tombstoneChanges ?? []).reduce((value, change) => Math.max(value, change.sequence), 0);
      return { max_sequence: max === 0 ? null : max } as T;
    }

    const rows = this.allRows();
    return (rows[0] ?? null) as T | null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.runWithOptions(this.options) as D1Result<T>;
  }

  async raw<T = unknown>(): Promise<T[]> {
    return this.allRows() as T[];
  }

  private allRows(): unknown[] {
    if (this.query.includes("FROM feeds f") && this.query.includes("LEFT JOIN feed_filters") && this.query.includes("WHERE f.enabled = 1")) {
      return fakeFeedRows(this.options).filter((feed) => feed.enabled === 1 && !feedDeleted(feed));
    }

    if (
      this.query.includes("FROM feeds f") &&
      this.query.includes("LEFT JOIN feed_metadata") &&
      this.query.includes("f.enabled = 1") &&
      this.query.includes("f.include_in_opml = 1")
    ) {
      return fakeFeedRows(this.options)
        .filter((feed) => !feedDeleted(feed) && feed.enabled === 1 && feed.include_in_opml === 1 && fakePublicPath(feed) !== null)
        .sort(compareFeedIDAsc)
        .map(publicOpmlFeedRow);
    }

    if (
      this.query.includes("FROM feeds f") &&
      this.query.includes("LEFT JOIN feed_metadata") &&
      this.query.includes("f.public_path IS NOT NULL")
    ) {
      return fakeFeedRows(this.options)
        .filter((feed) => !feedDeleted(feed) && fakePublicPath(feed) !== null)
        .sort(compareFeedIDAsc)
        .map(adminSubscriptionFeedRow);
    }

    if (
      this.query.includes("FROM feeds f") &&
      this.query.includes("LEFT JOIN feed_metadata") &&
      this.query.includes("m.title AS metadata_title")
    ) {
      return fakeFeedRows(this.options).filter((feed) => !feedDeleted(feed)).sort(compareFeedIDAsc).map(adminFeedListRow);
    }

    if (this.query.includes("FROM opml_tokens") && this.query.includes("public_path IS NOT NULL")) {
      return [...(this.options.opmlTokensByHash?.values() ?? [])]
        .filter((token) => (token.enabled ?? 1) === 1 && token.public_path !== null && token.public_path !== "")
        .sort((left, right) => left.label.localeCompare(right.label))
        .map(adminSubscriptionOpmlRow);
    }

    if (this.query.includes("FROM episodes") && this.query.includes("ORDER BY COALESCE(datetime(published_at), datetime(updated_at))")) {
      const feedID = String(this.params[0] ?? "");
      const hasStatusFilter = this.query.includes("AND status = ?");
      const status = hasStatusFilter ? String(this.params[1] ?? "") : null;
      const limit = Number(this.params[hasStatusFilter ? 2 : 1] ?? 50);
      const offset = Number(this.params[hasStatusFilter ? 3 : 2] ?? 0);
      return [...(this.options.episodesByKey?.values() ?? [])]
        .filter((episode) => episode.feed_id === feedID && (status === null || episode.status === status))
        .sort(compareAdminEpisodeOrder)
        .slice(offset, offset + limit)
        .map(adminEpisodeListRow);
    }

    if (this.query.includes("FROM episodes") && this.query.includes("status = 'visible'")) {
      const feedID = String(this.params[0] ?? "");
      const limit = Number(this.params[1] ?? 25);
      return [...(this.options.episodesByKey?.values() ?? [])]
        .filter((episode) => episode.feed_id === feedID && episode.status === "visible" && episode.r2_key !== null && episode.r2_key !== "")
        .sort((left, right) => comparePublishedAtDesc(left.published_at, right.published_at))
        .slice(0, limit)
        .map(publicEpisodeRow);
    }

    if (this.query.includes("FROM episodes") && this.query.includes("status = 'delete_pending'") && this.query.includes("purge_after")) {
      const now = sqliteDateTimeMillis(String(this.params[0] ?? ""));
      const limit = Number(this.params[1] ?? 50);
      return [...(this.options.episodesByKey?.values() ?? [])]
        .filter((episode) => episode.status === "delete_pending"
          && episode.purge_after !== null
          && sqliteDateTimeMillis(episode.purge_after) <= now)
        .sort(comparePurgeCandidateOrder)
        .slice(0, limit)
        .map((episode) => ({
          feed_id: episode.feed_id,
          local_episode_id: episode.local_episode_id,
          r2_key: episode.r2_key,
        }));
    }

    if (this.query.includes("FROM episodes") && this.query.includes("status IN ('hidden', 'delete_pending', 'purged')")) {
      this.options.beforeTombstoneSnapshot?.();
      return [...(this.options.episodesByKey?.values() ?? [])]
        .filter((episode) => episode.status === "hidden" || episode.status === "delete_pending" || episode.status === "purged")
        .sort((left, right) => `${left.feed_id}\0${left.local_episode_id}`.localeCompare(`${right.feed_id}\0${right.local_episode_id}`))
        .map((episode) => ({
          sequence: 0,
          feed_id: episode.feed_id,
          local_episode_id: episode.local_episode_id,
          status: episode.status,
          created_at: episode.updated_at ?? "2026-07-06 00:00:00",
        }));
    }

    if (this.query.includes("FROM tombstone_changes") && this.query.includes("sequence > ?")) {
      const cursor = Number(this.params[0] ?? 0);
      const limit = Number(this.params[1] ?? 100);
      return (this.options.tombstoneChanges ?? [])
        .filter((change) => change.sequence > cursor)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, limit);
    }

    if (this.query.includes("FROM sync_runs")) {
      const limit = Number(this.params[0] ?? 50);
      const offset = Number(this.params[1] ?? 0);
      return [...(this.options.syncRunsByID?.values() ?? [])]
        .sort(compareAdminSyncRunOrder)
        .slice(offset, offset + limit)
        .map(adminSyncRunRow);
    }

    if (this.query.includes("FROM events")) {
      const limit = Number(this.params[0] ?? 50);
      const offset = Number(this.params[1] ?? 0);
      return [...(this.options.eventsByKey?.values() ?? [])]
        .sort(compareAdminEventOrder)
        .slice(offset, offset + limit)
        .map(adminEventRow);
    }

    return [];
  }

  runWithOptions(options: FakeD1Options): D1Result {
    options.sqlLog?.push(this.query);
    let changes = 0;
    if (this.query.includes("INSERT INTO feeds")) {
      this.runFeedConfigInsert(options);
      changes = 1;
    } else if (this.query.includes("UPDATE feeds") && this.query.includes("SET url =")) {
      changes = this.runFeedConfigUpdate(options);
    } else if (this.query.includes("INSERT INTO feed_filters") && this.query.includes("ON CONFLICT")) {
      this.runFeedFiltersUpsert(options);
      changes = 1;
    } else if (this.query.includes("INSERT INTO episodes") && this.query.includes("ON CONFLICT")) {
      changes = this.runEpisodeUpsert(options);
    } else if (this.query.includes("INSERT INTO feed_metadata") && this.query.includes("ON CONFLICT")) {
      changes = this.runFeedMetadataUpsert(options);
    } else if (this.query.includes("DELETE FROM events")) {
      changes = this.runEventRetentionDelete(options);
    } else if (this.query.includes("DELETE FROM sync_runs")) {
      changes = this.runSyncRunRetentionDelete(options);
    } else if (this.query.includes("UPDATE feeds") && this.query.includes("deleted_at = CURRENT_TIMESTAMP")) {
      changes = this.runFeedDeleteUpdate(options);
    } else if (this.query.includes("UPDATE feeds") && this.query.includes("include_in_opml")) {
      changes = this.runFeedStatusUpdate(options);
    } else if (this.query.includes("UPDATE episodes") && this.query.includes("status = 'delete_pending'") && !this.query.includes("local_episode_id")) {
      changes = this.runFeedDeleteEpisodeUpdate(options);
    } else if (this.query.includes("UPDATE episodes") && this.query.includes("SET status")) {
      changes = this.runEpisodeStatusUpdate(options);
    } else if (this.query.includes("INSERT INTO tombstone_changes")) {
      changes = this.runTombstoneInsert(options);
    } else if (this.query.includes("INSERT INTO sync_runs") && this.query.includes("ON CONFLICT(id)")) {
      changes = this.runSyncRunUpsert(options);
    } else if (this.query.includes("INSERT OR IGNORE INTO events")) {
      changes = this.runEventInsert(options);
    }
    options.lastChanges = changes;
    return { results: [], success: true, meta: { changes } } as unknown as D1Result;
  }

  private runFeedConfigInsert(options: FakeD1Options): void {
    const [
      feedID,
      provider,
      url,
      titleOverride,
      descriptionOverride,
      enabled,
      includeInOpml,
      privateFeed,
      updatePeriod,
      pageSize,
      keepLast,
      cookieProfile,
      bilibiliIncludeUpowerExclusive,
      feedTokenHash,
      publicPath,
    ] = this.params;
    const id = String(feedID);
    const row: FakeFeedRow = {
      feed_id: id,
      provider: provider as "youtube" | "bilibili",
      url: String(url),
      title_override: nullableString(titleOverride),
      description_override: nullableString(descriptionOverride),
      enabled: Number(enabled),
      include_in_opml: Number(includeInOpml),
      private_feed: Number(privateFeed),
      update_period: String(updatePeriod),
      page_size: Number(pageSize),
      keep_last: Number(keepLast),
      cookie_profile: nullableString(cookieProfile),
      bilibili_include_upower_exclusive: Number(bilibiliIncludeUpowerExclusive),
      feed_token_hash: String(feedTokenHash),
      public_path: nullableString(publicPath),
    };
    if (options.feedInsertUniqueCollision?.(row)) {
      throw new Error("UNIQUE constraint failed: feeds.public_path");
    }
    const feeds = options.feedsByID ?? new Map<string, FakeFeedRow>();
    options.feedsByID = feeds;
    if (feeds.has(id) || options.tomlFeeds?.some((feed) => feed.feed_id === id)) {
      throw new Error("UNIQUE constraint failed: feeds.feed_id");
    }
    for (const feed of fakeFeedRows(options)) {
      if (feed.feed_token_hash === row.feed_token_hash) throw new Error("UNIQUE constraint failed: feeds.feed_token_hash");
      if (row.public_path !== null && feed.public_path === row.public_path) throw new Error("UNIQUE constraint failed: feeds.public_path");
    }
    feeds.set(id, row);
  }

  private runFeedConfigUpdate(options: FakeD1Options): number {
    const [
      url,
      titleOverride,
      descriptionOverride,
      enabled,
      includeInOpml,
      privateFeed,
      updatePeriod,
      pageSize,
      keepLast,
      cookieProfile,
      bilibiliIncludeUpowerExclusive,
      feedID,
    ] = this.params;
    const id = String(feedID);
    options.beforeFeedConfigUpdate?.(id, options);
    const feed = options.feedsByID?.get(id) ?? options.tomlFeeds?.find((row) => row.feed_id === id);
    if (!feed) return 0;
    if (this.query.includes("deleted_at IS NULL") && (feed as FakeFeedRow | (FeedTomlRow & { deleted_at?: string | null })).deleted_at) return 0;
    feed.url = String(url);
    feed.title_override = nullableString(titleOverride);
    feed.description_override = nullableString(descriptionOverride);
    feed.enabled = Number(enabled);
    feed.include_in_opml = Number(includeInOpml);
    feed.private_feed = Number(privateFeed);
    feed.update_period = String(updatePeriod);
    feed.page_size = Number(pageSize);
    feed.keep_last = Number(keepLast);
    feed.cookie_profile = nullableString(cookieProfile);
    feed.bilibili_include_upower_exclusive = Number(bilibiliIncludeUpowerExclusive);
    return 1;
  }

  private runFeedFiltersUpsert(options: FakeD1Options): void {
    if (options.failFeedFiltersUpsert) throw new Error("feed filters upsert failed");
    const [feedID, title, notTitle, description, notDescription, minDuration, maxDuration, minAge, maxAge] = this.params;
    const id = String(feedID);
    const feed = options.feedsByID?.get(id) ?? options.tomlFeeds?.find((row) => row.feed_id === id);
    if (!feed) throw new Error("FOREIGN KEY constraint failed: feed_filters.feed_id");
    setFeedFilters(feed, {
      title: nullableString(title),
      not_title: nullableString(notTitle),
      description: nullableString(description),
      not_description: nullableString(notDescription),
      min_duration: nullableNumber(minDuration),
      max_duration: nullableNumber(maxDuration),
      min_age: nullableNumber(minAge),
      max_age: nullableNumber(maxAge),
    });
  }

  private runEpisodeUpsert(options: FakeD1Options): number {
    const [
      feedID,
      provider,
      sourceEpisodeID,
      localEpisodeID,
      sourceURL,
      thumbnail,
      title,
      description,
      publishedAt,
      duration,
      r2Key,
      size,
      mimeType,
      assetToken,
    ] = this.params;
    const key = fakeEpisodeKey(String(feedID), String(localEpisodeID));
    const episodes = options.episodesByKey ?? new Map<string, FakeEpisodeRow>();
    options.episodesByKey = episodes;
    options.beforeEpisodeUpsert?.(key, episodes.get(key), options);
    if (this.query.includes("feeds.deleted_at IS NULL") && feedIsDeleted(options, String(feedID))) return 0;
    const existing = episodes.get(key);
    const nextStatus: EpisodeStatus = existing
      ? (existing.status === "pending" || existing.status === "visible" ? "visible" : existing.status)
      : "visible";
    episodes.set(key, {
      feed_id: String(feedID),
      provider: provider as "youtube" | "bilibili",
      source_episode_id: String(sourceEpisodeID),
      local_episode_id: String(localEpisodeID),
      source_url: nullableString(sourceURL),
      thumbnail: nullableString(thumbnail),
      title: nullableString(title),
      description: nullableString(description),
      published_at: nullableString(publishedAt),
      duration: typeof duration === "number" ? duration : null,
      status: nextStatus,
      r2_key: String(r2Key),
      size: Number(size),
      mime_type: String(mimeType),
      asset_token: String(assetToken),
      deleted_at: existing?.deleted_at ?? null,
      purge_after: existing?.purge_after ?? null,
      updated_at: "2026-07-06 00:00:00",
    });
    return 1;
  }

  private runFeedMetadataUpsert(options: FakeD1Options): number {
    const [
      feedID,
      provider,
      sourceURL,
      title,
      description,
      imageURL,
      link,
      author,
      category,
      language,
      explicit,
      lastSourceUpdateAt,
      reportedAt,
    ] = this.params;
    options.beforeFeedMetadataUpsert?.(String(feedID), options);
    if (this.query.includes("feeds.deleted_at IS NULL") && feedIsDeleted(options, String(feedID))) return 0;
    const metadata = options.feedMetadataByID ?? new Map<string, FakeFeedMetadataRow>();
    options.feedMetadataByID = metadata;
    metadata.set(String(feedID), {
      feed_id: String(feedID),
      provider: provider as "youtube" | "bilibili",
      source_url: String(sourceURL),
      title: nullableString(title),
      description: nullableString(description),
      image_url: nullableString(imageURL),
      link: nullableString(link),
      author: nullableString(author),
      category: nullableString(category),
      language: nullableString(language),
      explicit: typeof explicit === "number" ? explicit : null,
      last_source_update_at: nullableString(lastSourceUpdateAt),
      reported_at: String(reportedAt),
    });
    return 1;
  }

  private runFeedDeleteUpdate(options: FakeD1Options): number {
    const [feedID] = this.params;
    const id = String(feedID);
    const feed = options.feedsByID?.get(id) ?? options.tomlFeeds?.find((row) => row.feed_id === id);
    if (!feed || (feed as FakeFeedRow | FeedTomlRow).deleted_at) return 0;
    feed.enabled = 0;
    feed.include_in_opml = 0;
    (feed as FakeFeedRow | (FeedTomlRow & { public_path?: string | null })).public_path = null;
    (feed as FakeFeedRow | (FeedTomlRow & { deleted_at?: string | null })).deleted_at = "2026-07-06 00:00:00";
    return 1;
  }

  private runFeedStatusUpdate(options: FakeD1Options): number {
    const [enabled, includeInOpml, feedID] = this.params;
    const id = String(feedID);
    options.beforeFeedStatusUpdate?.(id, options);
    const feed = options.feedsByID?.get(id);
    if (feed) {
      if (this.query.includes("deleted_at IS NULL") && feed.deleted_at) return 0;
      feed.enabled = Number(enabled);
      feed.include_in_opml = Number(includeInOpml);
    }
    const tomlFeed = options.tomlFeeds?.find((row) => row.feed_id === id);
    if (tomlFeed) {
      if (this.query.includes("deleted_at IS NULL") && (tomlFeed as FeedTomlRow & { deleted_at?: string | null }).deleted_at) return 0;
      tomlFeed.enabled = Number(enabled);
      tomlFeed.include_in_opml = Number(includeInOpml);
    }
    return feed || tomlFeed ? 1 : 0;
  }

  private runFeedDeleteEpisodeUpdate(options: FakeD1Options): number {
    const [feedID] = this.params;
    let changes = 0;
    for (const episode of options.episodesByKey?.values() ?? []) {
      if (episode.feed_id !== String(feedID) || !feedDeleteCandidateStatus(episode.status)) continue;
      episode.status = "delete_pending";
      episode.deleted_at = "2026-07-06 00:00:00";
      episode.purge_after = "2026-07-13 00:00:00";
      episode.updated_at = "2026-07-06 00:00:00";
      changes++;
    }
    return changes;
  }

  private runEpisodeStatusUpdate(options: FakeD1Options): number {
    if (this.query.includes("status = 'purged'")) {
      return this.runEpisodePurgeUpdate(options);
    }
    const [feedID, localEpisodeID] = this.params;
    const key = fakeEpisodeKey(String(feedID), String(localEpisodeID));
    const episode = options.episodesByKey?.get(key);
    options.beforeEpisodeStatusUpdate?.(key, episode, options);
    const current = options.episodesByKey?.get(key);
    if (!current) return 0;
    if (this.query.includes("feeds.deleted_at IS NULL") && feedIsDeleted(options, current.feed_id)) return 0;
    const query = this.query;
    if (query.includes("status = 'visible'")) {
      if (query.includes("status = 'hidden'")) {
        if (current.status !== "hidden") return 0;
      } else if (query.includes("r2_key = ?")) {
        if (current.status !== "delete_pending" || current.r2_key !== nullableString(this.params[2])) return 0;
      } else if (query.includes("r2_key IS NULL")) {
        if (current.status !== "delete_pending" || (current.r2_key !== null && current.r2_key !== "")) return 0;
      } else if (current.status !== "hidden" && current.status !== "delete_pending") {
        return 0;
      }
      current.status = "visible";
      current.deleted_at = null;
      current.purge_after = null;
      current.updated_at = "2026-07-06 00:00:00";
      return 1;
    }
    if (query.includes("status = 'delete_pending'")) {
      if (current.status !== "pending" && current.status !== "visible" && current.status !== "hidden") return 0;
      current.status = "delete_pending";
      current.deleted_at = "2026-07-06 00:00:00";
      current.purge_after = "2026-07-13 00:00:00";
      current.updated_at = "2026-07-06 00:00:00";
      return 1;
    }
    if (query.includes("status = 'hidden'")) {
      if (current.status !== "pending" && current.status !== "visible") return 0;
      current.status = "hidden";
      current.updated_at = "2026-07-06 00:00:00";
      return 1;
    }
    return 0;
  }

  private runEpisodePurgeUpdate(options: FakeD1Options): number {
    const [now, feedID, localEpisodeID, nullKey, r2Key] = this.params;
    const key = fakeEpisodeKey(String(feedID), String(localEpisodeID));
    if (options.failPurgeUpdateKeys?.has(key)) return 0;
    const episode = options.episodesByKey?.get(key);
    if (!episode || episode.status !== "delete_pending" || episode.purge_after === null) return 0;
    const expectedR2Key = nullableString(r2Key);
    const expectedNullKey = nullableString(nullKey);
    if (episode.r2_key === null) {
      if (expectedNullKey !== null || expectedR2Key !== null) return 0;
    } else if (episode.r2_key !== expectedR2Key) {
      return 0;
    }
    if (sqliteDateTimeMillis(episode.purge_after) > sqliteDateTimeMillis(String(now))) return 0;
    episode.status = "purged";
    episode.purge_after = null;
    episode.updated_at = String(now);
    return 1;
  }

  private runTombstoneInsert(options: FakeD1Options): number {
    if (this.query.includes("SELECT NULL")) {
      return this.runAssertPreviousChanges(options);
    }
    if (this.query.includes("FROM episodes") && this.query.includes("'delete_pending'") && this.query.includes("'delete'")) {
      return this.runFeedDeleteTombstoneInsert(options);
    }
    if (options.failTombstoneInsert) {
      throw new Error("tombstone insert failed");
    }
    if ((options.lastChanges ?? 0) !== 1) {
      return 0;
    }
    const literalPurge = this.query.includes("'purged'") && this.query.includes("'purge'");
    const [feedID, localEpisodeID, statusParam, actionParam] = this.params;
    const status = literalPurge ? "purged" : statusParam;
    const action = literalPurge ? "purge" : actionParam;
    const createdAt = literalPurge ? nullableString(statusParam) : "2026-07-06 00:00:00";
    const changes = options.tombstoneChanges ?? [];
    options.tombstoneChanges = changes;
    const sequence = changes.reduce((max, change) => Math.max(max, change.sequence), 0) + 1;
    changes.push({
      sequence,
      feed_id: String(feedID),
      local_episode_id: String(localEpisodeID),
      status: status as EpisodeStatus,
      action: action as "hide" | "delete" | "purge" | "restore",
      created_at: createdAt ?? "2026-07-06 00:00:00",
    });
    return 1;
  }

  private runAssertPreviousChanges(options: FakeD1Options): number {
    const [expected] = this.params;
    if ((options.lastChanges ?? 0) !== Number(expected)) {
      throw new Error("NOT NULL constraint failed: tombstone_changes.feed_id");
    }
    return 0;
  }

  private runFeedDeleteTombstoneInsert(options: FakeD1Options): number {
    if (options.failTombstoneInsert) {
      throw new Error("tombstone insert failed");
    }
    const [feedID] = this.params;
    options.beforeFeedDeleteTombstoneInsert?.(options.episodesByKey);
    const changes = options.tombstoneChanges ?? [];
    options.tombstoneChanges = changes;
    let sequence = changes.reduce((max, change) => Math.max(max, change.sequence), 0);
    let inserted = 0;
    for (const episode of options.episodesByKey?.values() ?? []) {
      if (episode.feed_id !== String(feedID) || !feedDeleteCandidateStatus(episode.status)) continue;
      sequence++;
      inserted++;
      changes.push({
        sequence,
        feed_id: episode.feed_id,
        local_episode_id: episode.local_episode_id,
        status: "delete_pending",
        action: "delete",
        created_at: "2026-07-06 00:00:00",
      });
    }
    return inserted;
  }

  private runEventRetentionDelete(options: FakeD1Options): number {
    const cutoff = sqliteDateTimeMillis(String(this.params[0] ?? "")) - 30 * 24 * 60 * 60 * 1000;
    let changes = 0;
    const events = options.eventsByKey;
    if (!events) return 0;
    for (const [key, event] of events) {
      if (sqliteDateTimeMillis(event.event_time) < cutoff) {
        events.delete(key);
        changes++;
      }
    }
    return changes;
  }

  private runSyncRunRetentionDelete(options: FakeD1Options): number {
    const cutoff = sqliteDateTimeMillis(String(this.params[0] ?? "")) - 180 * 24 * 60 * 60 * 1000;
    let changes = 0;
    const runs = options.syncRunsByID;
    if (!runs) return 0;
    for (const [key, run] of runs) {
      if (run.status !== "running" && coalesceSQLiteDateTimeMillis(run.finished_at, run.started_at) < cutoff) {
        runs.delete(key);
        changes++;
      }
    }
    return changes;
  }

  private runSyncRunUpsert(options: FakeD1Options): number {
    const [
      id,
      startedAt,
      finishedAt,
      status,
      feedsUpdated,
      episodesDownloaded,
      episodesUploaded,
      errorsCount,
    ] = this.params;
    const runID = String(id);
    const runs = options.syncRunsByID ?? new Map<string, FakeSyncRunRow>();
    options.syncRunsByID = runs;
    const existing = runs.get(runID);
    const incoming: FakeSyncRunRow = {
      id: runID,
      started_at: String(startedAt),
      finished_at: nullableString(finishedAt),
      status: status as SyncRunStatus,
      feeds_updated: Number(feedsUpdated),
      episodes_downloaded: Number(episodesDownloaded),
      episodes_uploaded: Number(episodesUploaded),
      errors_count: Number(errorsCount),
    };
    if (!existing || existing.status === "running") {
      runs.set(runID, {
        id: runID,
        started_at: earlierTimestamp(existing?.started_at, incoming.started_at),
        finished_at: incoming.finished_at,
        status: incoming.status,
        feeds_updated: Math.max(existing?.feeds_updated ?? 0, incoming.feeds_updated),
        episodes_downloaded: Math.max(existing?.episodes_downloaded ?? 0, incoming.episodes_downloaded),
        episodes_uploaded: Math.max(existing?.episodes_uploaded ?? 0, incoming.episodes_uploaded),
        errors_count: Math.max(existing?.errors_count ?? 0, incoming.errors_count),
      });
    } else {
      runs.set(runID, {
        ...existing,
        feeds_updated: Math.max(existing.feeds_updated, incoming.feeds_updated),
        episodes_downloaded: Math.max(existing.episodes_downloaded, incoming.episodes_downloaded),
        episodes_uploaded: Math.max(existing.episodes_uploaded, incoming.episodes_uploaded),
        errors_count: Math.max(existing.errors_count, incoming.errors_count),
      });
    }
    return 1;
  }

  private runEventInsert(options: FakeD1Options): number {
    const [
      runID,
      sequence,
      eventTime,
      level,
      type,
      feedID,
      localEpisodeID,
      message,
      errorCode,
      errorDetail,
    ] = this.params;
    const key = fakeEventKey(String(runID), Number(sequence));
    const events = options.eventsByKey ?? new Map<string, FakeEventRow>();
    options.eventsByKey = events;
    if (events.has(key)) return 0;
    events.set(key, {
      run_id: String(runID),
      sequence: Number(sequence),
      event_time: String(eventTime),
      level: level as EventLevel,
      type: type as RemoteEventType,
      feed_id: nullableString(feedID),
      local_episode_id: nullableString(localEpisodeID),
      message: nullableString(message),
      error_code: nullableString(errorCode),
      error_detail: nullableString(errorDetail),
    });
    return 1;
  }
}

export function fakeEpisodeKey(feedID: string, localEpisodeID: string): string {
  return `${feedID}\0${localEpisodeID}`;
}

export function fakeEventKey(runID: string, sequence: number): string {
  return `${runID}\0${sequence}`;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function setFeedFilters(feed: FakeFeedRow | FeedTomlRow, filters: AdminFeedFilters): void {
  feed.title = filters.title;
  feed.not_title = filters.not_title;
  feed.description = filters.description;
  feed.not_description = filters.not_description;
  feed.min_duration = filters.min_duration;
  feed.max_duration = filters.max_duration;
  feed.min_age = filters.min_age;
  feed.max_age = filters.max_age;
}

function comparePublishedAtDesc(left: string | null, right: string | null): number {
  const leftTime = left ? Date.parse(left) : 0;
  const rightTime = right ? Date.parse(right) : 0;
  return rightTime - leftTime;
}

function publicEpisodeRow(episode: FakeEpisodeRow): PublicEpisodeRow {
  if (episode.r2_key === null) throw new Error("public episode row requires r2_key");
  return {
    local_episode_id: episode.local_episode_id,
    source_url: episode.source_url,
    title: episode.title,
    description: episode.description,
    published_at: episode.published_at,
    duration: episode.duration,
    r2_key: episode.r2_key,
    size: episode.size,
    mime_type: episode.mime_type,
  };
}

function publicFeedRow(feed: FakeReadableFeed): PublicFeedRow {
  return {
    feed_id: feed.feed_id,
    provider: feed.provider,
    url: feed.url,
    title_override: feed.title_override,
    description_override: feed.description_override,
    page_size: feed.page_size,
    title: feed.metadata_title,
    description: feed.metadata_description,
    image_url: feed.metadata_image_url,
    link: feed.metadata_link,
    deleted_at: feed.deleted_at,
  };
}

function fakeFeedRows(options: FakeD1Options): FakeReadableFeed[] {
  const rows: FakeReadableFeed[] = [];
  const seen = new Set<string>();
  for (const feed of options.tomlFeeds ?? []) {
    rows.push(fakeReadableFeedFromToml(feed, options));
    seen.add(feed.feed_id);
  }
  for (const feed of options.feedsByID?.values() ?? []) {
    if (seen.has(feed.feed_id)) continue;
    rows.push(fakeReadableFeedFromPartial(feed, options));
  }
  return rows;
}

function fakeReadableFeedFromToml(feed: FeedTomlRow, options: FakeD1Options): FakeReadableFeed {
  const extras = feed as FeedTomlRow & {
    public_path?: string | null;
    metadata_title?: string | null;
    metadata_description?: string | null;
    deleted_at?: string | null;
  };
  const metadata = options.feedMetadataByID?.get(feed.feed_id);
  return {
    feed_id: feed.feed_id,
    provider: feed.provider,
    url: feed.url,
    title_override: feed.title_override,
    description_override: feed.description_override,
    enabled: feed.enabled,
    include_in_opml: feed.include_in_opml,
    private_feed: feed.private_feed,
    update_period: feed.update_period,
    page_size: feed.page_size,
    keep_last: feed.keep_last,
    cookie_profile: feed.cookie_profile,
    bilibili_include_upower_exclusive: feed.bilibili_include_upower_exclusive ?? 0,
    feed_token_hash: feed.feed_token_hash,
    public_path: extras.public_path ?? null,
    deleted_at: extras.deleted_at ?? null,
    metadata_title: metadata?.title ?? extras.metadata_title ?? null,
    metadata_description: metadata?.description ?? extras.metadata_description ?? null,
    metadata_image_url: metadata?.image_url ?? null,
    metadata_link: metadata?.link ?? null,
    metadata_last_source_update_at: metadata?.last_source_update_at ?? null,
    metadata_reported_at: metadata?.reported_at ?? null,
    latest_episode_published_at: latestEpisodePublishedAt(options, feed.feed_id),
    episode_count: episodeCount(options, feed.feed_id),
    title: feed.title ?? null,
    not_title: feed.not_title ?? null,
    description: feed.description ?? null,
    not_description: feed.not_description ?? null,
    min_duration: feed.min_duration ?? null,
    max_duration: feed.max_duration ?? null,
    min_age: feed.min_age ?? null,
    max_age: feed.max_age ?? null,
  };
}

function fakeReadableFeedFromPartial(feed: FakeFeedRow, options: FakeD1Options): FakeReadableFeed {
  const metadata = options.feedMetadataByID?.get(feed.feed_id);
  return {
    feed_id: feed.feed_id,
    provider: feed.provider,
    url: feed.url ?? "",
    title_override: feed.title_override ?? null,
    description_override: feed.description_override ?? null,
    enabled: feed.enabled ?? 1,
    include_in_opml: feed.include_in_opml ?? 1,
    private_feed: feed.private_feed ?? 1,
    update_period: feed.update_period ?? "1h",
    page_size: feed.page_size ?? 25,
    keep_last: feed.keep_last ?? 25,
    cookie_profile: feed.cookie_profile ?? null,
    bilibili_include_upower_exclusive: feed.bilibili_include_upower_exclusive ?? 0,
    feed_token_hash: feed.feed_token_hash ?? "",
    public_path: feed.public_path ?? null,
    deleted_at: feed.deleted_at ?? null,
    metadata_title: metadata?.title ?? feed.metadata_title ?? null,
    metadata_description: metadata?.description ?? feed.metadata_description ?? null,
    metadata_image_url: metadata?.image_url ?? null,
    metadata_link: metadata?.link ?? null,
    metadata_last_source_update_at: metadata?.last_source_update_at ?? null,
    metadata_reported_at: metadata?.reported_at ?? null,
    latest_episode_published_at: latestEpisodePublishedAt(options, feed.feed_id),
    episode_count: episodeCount(options, feed.feed_id),
    title: feed.title ?? null,
    not_title: feed.not_title ?? null,
    description: feed.description ?? null,
    not_description: feed.not_description ?? null,
    min_duration: feed.min_duration ?? null,
    max_duration: feed.max_duration ?? null,
    min_age: feed.min_age ?? null,
    max_age: feed.max_age ?? null,
  };
}

function fakePublicPath(feed: FakeReadableFeed): string | null {
  return feed.public_path && feed.public_path !== "" ? feed.public_path : null;
}

function feedDeleted(feed: FakeReadableFeed): boolean {
  return feed.deleted_at !== null && feed.deleted_at !== "";
}

function feedIsDeleted(options: FakeD1Options, feedID: string): boolean {
  const feed = options.feedsByID?.get(feedID) ?? options.tomlFeeds?.find((row) => row.feed_id === feedID);
  return Boolean((feed as FakeFeedRow | (FeedTomlRow & { deleted_at?: string | null }) | undefined)?.deleted_at);
}

function feedDeleteCandidateStatus(status: EpisodeStatus): boolean {
  return status === "pending" || status === "visible" || status === "hidden";
}

function compareFeedIDAsc(left: FakeReadableFeed, right: FakeReadableFeed): number {
  return left.feed_id.localeCompare(right.feed_id);
}

function publicOpmlFeedRow(feed: FakeReadableFeed): PublicOpmlFeedRow {
  return {
    feed_id: feed.feed_id,
    title: feed.metadata_title,
    title_override: feed.title_override,
    public_path: feed.public_path,
  };
}

function adminFeedListRow(feed: FakeReadableFeed): AdminFeedListRow {
  return {
    feed_id: feed.feed_id,
    provider: feed.provider,
    url: feed.url,
    title_override: feed.title_override,
    description_override: feed.description_override,
    enabled: feed.enabled,
    include_in_opml: feed.include_in_opml,
    private_feed: feed.private_feed,
    update_period: feed.update_period,
    page_size: feed.page_size,
    keep_last: feed.keep_last,
    cookie_profile: feed.cookie_profile,
    bilibili_include_upower_exclusive: feed.bilibili_include_upower_exclusive,
    public_path: feed.public_path,
    metadata_title: feed.metadata_title,
    metadata_description: feed.metadata_description,
    metadata_image_url: feed.metadata_image_url,
    metadata_last_source_update_at: feed.metadata_last_source_update_at,
    metadata_reported_at: feed.metadata_reported_at,
    latest_episode_published_at: feed.latest_episode_published_at,
    episode_count: feed.episode_count,
    title: feed.title,
    not_title: feed.not_title,
    description: feed.description,
    not_description: feed.not_description,
    min_duration: feed.min_duration,
    max_duration: feed.max_duration,
    min_age: feed.min_age,
    max_age: feed.max_age,
  };
}

function adminSubscriptionFeedRow(feed: FakeReadableFeed): AdminSubscriptionFeedRow {
  return {
    feed_id: feed.feed_id,
    title: feed.metadata_title,
    title_override: feed.title_override,
    public_path: feed.public_path,
  };
}

function adminSubscriptionOpmlRow(token: FakeOpmlTokenRow): AdminSubscriptionOpmlRow {
  return {
    label: token.label,
    public_path: token.public_path,
  };
}

function sqliteDateTimeMillis(value: string | null): number {
  if (!value) return 0;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function earlierTimestamp(current: string | undefined, incoming: string): string {
  if (current === undefined) return incoming;
  return incoming < current ? incoming : current;
}

function coalesceSQLiteDateTimeMillis(primary: string | null, fallback: string | null): number {
  const primaryTime = sqliteDateTimeMillis(primary);
  if (primaryTime !== 0) return primaryTime;
  return sqliteDateTimeMillis(fallback);
}

function feedEpisodes(options: FakeD1Options, feedID: string): FakeEpisodeRow[] {
  return [...(options.episodesByKey?.values() ?? [])].filter((episode) => episode.feed_id === feedID && episode.status !== "purged");
}

function latestEpisodePublishedAt(options: FakeD1Options, feedID: string): string | null {
  const timestamps = feedEpisodes(options, feedID)
    .map((episode) => coalesceSQLiteDateTimeMillis(episode.published_at, episode.updated_at))
    .filter((time) => time > 0);
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString().replace(".000Z", "Z");
}

function episodeCount(options: FakeD1Options, feedID: string): number {
  return feedEpisodes(options, feedID).length;
}

function compareAdminEpisodeOrder(left: FakeEpisodeRow, right: FakeEpisodeRow): number {
  const leftTime = coalesceSQLiteDateTimeMillis(left.published_at, left.updated_at);
  const rightTime = coalesceSQLiteDateTimeMillis(right.published_at, right.updated_at);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return left.local_episode_id.localeCompare(right.local_episode_id);
}

function comparePurgeCandidateOrder(left: FakeEpisodeRow, right: FakeEpisodeRow): number {
  const timeCompare = sqliteDateTimeMillis(left.purge_after) - sqliteDateTimeMillis(right.purge_after);
  if (timeCompare !== 0) return timeCompare;
  const feedCompare = left.feed_id.localeCompare(right.feed_id);
  if (feedCompare !== 0) return feedCompare;
  return left.local_episode_id.localeCompare(right.local_episode_id);
}

function adminEpisodeListRow(episode: FakeEpisodeRow): AdminEpisodeListRow {
  return {
    local_episode_id: episode.local_episode_id,
    source_episode_id: episode.source_episode_id,
    source_url: episode.source_url,
    title: episode.title,
    published_at: episode.published_at,
    duration: episode.duration,
    status: episode.status,
    r2_key: episode.r2_key,
    size: episode.size,
    mime_type: episode.mime_type,
    updated_at: episode.updated_at ?? "2026-07-06 00:00:00",
  };
}

function compareAdminSyncRunOrder(left: FakeSyncRunRow, right: FakeSyncRunRow): number {
  if (left.started_at !== right.started_at) return right.started_at.localeCompare(left.started_at);
  return right.id.localeCompare(left.id);
}

function adminSyncRunRow(row: FakeSyncRunRow): AdminSyncRunRow {
  return { ...row };
}

function compareAdminEventOrder(left: FakeEventRow, right: FakeEventRow): number {
  if (left.event_time !== right.event_time) return right.event_time.localeCompare(left.event_time);
  const runCompare = right.run_id.localeCompare(left.run_id);
  if (runCompare !== 0) return runCompare;
  return right.sequence - left.sequence;
}

function adminEventRow(row: FakeEventRow): AdminEventRow {
  return { ...row };
}

export function fakeD1(options: FakeD1Options = {}): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      return new FakeStatement(options, query) as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const staged = cloneOptions(options);
      try {
        const results = statements.map((statement) => (statement as unknown as FakeStatement).runWithOptions(staged) as D1Result<T>);
        commitOptions(options, staged);
        return results;
      } catch (error) {
        throw error;
      }
    },
  } as unknown as D1Database;
}

function cloneOptions(options: FakeD1Options): FakeD1Options {
  return {
    ...options,
    tomlFeeds: options.tomlFeeds?.map((feed) => ({ ...feed })),
    publicFeedsByHash: cloneMap(options.publicFeedsByHash),
    opmlTokenHashes: options.opmlTokenHashes ? new Set(options.opmlTokenHashes) : undefined,
    opmlTokensByHash: cloneMap(options.opmlTokensByHash),
    feedsByID: cloneMap(options.feedsByID),
    feedMetadataByID: cloneMap(options.feedMetadataByID),
    episodesByKey: cloneMap(options.episodesByKey),
    tombstoneChanges: options.tombstoneChanges?.map((change) => ({ ...change })),
    syncRunsByID: cloneMap(options.syncRunsByID),
    eventsByKey: cloneMap(options.eventsByKey),
    failPurgeUpdateKeys: options.failPurgeUpdateKeys ? new Set(options.failPurgeUpdateKeys) : undefined,
    lastChanges: undefined,
  };
}

function cloneMap<T extends object>(input: Map<string, T> | undefined): Map<string, T> | undefined {
  if (!input) return undefined;
  return new Map([...input.entries()].map(([key, value]) => [key, { ...value }]));
}

function commitOptions(target: FakeD1Options, staged: FakeD1Options): void {
  commitArray(target.tomlFeeds, staged.tomlFeeds, (value) => ({ ...value }));
  if (!target.tomlFeeds) target.tomlFeeds = staged.tomlFeeds;
  commitMap(target.publicFeedsByHash, staged.publicFeedsByHash);
  if (!target.publicFeedsByHash) target.publicFeedsByHash = staged.publicFeedsByHash;
  commitSet(target.opmlTokenHashes, staged.opmlTokenHashes);
  if (!target.opmlTokenHashes) target.opmlTokenHashes = staged.opmlTokenHashes;
  commitMap(target.opmlTokensByHash, staged.opmlTokensByHash);
  if (!target.opmlTokensByHash) target.opmlTokensByHash = staged.opmlTokensByHash;
  commitMap(target.feedsByID, staged.feedsByID);
  if (!target.feedsByID) target.feedsByID = staged.feedsByID;
  commitMap(target.feedMetadataByID, staged.feedMetadataByID);
  if (!target.feedMetadataByID) target.feedMetadataByID = staged.feedMetadataByID;
  commitMap(target.episodesByKey, staged.episodesByKey);
  if (!target.episodesByKey) target.episodesByKey = staged.episodesByKey;
  commitArray(target.tombstoneChanges, staged.tombstoneChanges, (value) => ({ ...value }));
  if (!target.tombstoneChanges) target.tombstoneChanges = staged.tombstoneChanges;
  commitMap(target.syncRunsByID, staged.syncRunsByID);
  if (!target.syncRunsByID) target.syncRunsByID = staged.syncRunsByID;
  commitMap(target.eventsByKey, staged.eventsByKey);
  if (!target.eventsByKey) target.eventsByKey = staged.eventsByKey;
  target.lastChanges = staged.lastChanges;
}

function commitArray<T>(target: T[] | undefined, staged: T[] | undefined, clone: (value: T) => T): void {
  if (!target || !staged) return;
  target.splice(0, target.length, ...staged.map(clone));
}

function commitMap<T extends object>(target: Map<string, T> | undefined, staged: Map<string, T> | undefined): void {
  if (!target || !staged) return;
  target.clear();
  for (const [key, value] of staged) {
    target.set(key, { ...value });
  }
}

function commitSet<T>(target: Set<T> | undefined, staged: Set<T> | undefined): void {
  if (!target || !staged) return;
  target.clear();
  for (const value of staged) {
    target.add(value);
  }
}

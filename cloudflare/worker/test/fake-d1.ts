import type {
  AdminEpisodeListRow,
  AdminFeedListRow,
  AdminSubscriptionFeedRow,
  AdminSubscriptionOpmlRow,
  DownloaderDefaults,
  EpisodeStatus,
  FeedTomlRow,
  PublicEpisodeRow,
  PublicFeedRow,
  PublicOpmlFeedRow,
  TombstoneChangeRow,
} from "../src/db";

interface FakeD1Options {
  tomlFeeds?: FeedTomlRow[] | undefined;
  youtubeDefaults?: DownloaderDefaults | null | undefined;
  publicFeedsByHash?: Map<string, PublicFeedRow> | undefined;
  opmlTokenHashes?: Set<string> | undefined;
  opmlTokensByHash?: Map<string, FakeOpmlTokenRow> | undefined;
  feedsByID?: Map<string, FakeFeedRow> | undefined;
  episodesByKey?: Map<string, FakeEpisodeRow> | undefined;
  tombstoneChanges?: FakeTombstoneChangeRow[] | undefined;
  sqlLog?: string[] | undefined;
  beforeEpisodeUpsert?: ((key: string, episode: FakeEpisodeRow | undefined) => void) | undefined;
  beforeEpisodeStatusUpdate?: ((key: string, episode: FakeEpisodeRow | undefined) => void) | undefined;
  beforeTombstoneSnapshot?: (() => void) | undefined;
  failTombstoneInsert?: boolean | undefined;
  lastChanges?: number | undefined;
}

interface FakeFeedRow {
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
  feed_token_hash?: string | undefined;
  public_path?: string | null | undefined;
  metadata_title?: string | null | undefined;
  metadata_description?: string | null | undefined;
}

interface FakeOpmlTokenRow {
  label: string;
  public_path: string | null;
  enabled?: number | undefined;
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
  feed_token_hash: string;
  public_path: string | null;
  metadata_title: string | null;
  metadata_description: string | null;
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
      return feed as T | null;
    }

    if (this.query.includes("FROM feeds") && this.query.includes("WHERE feed_id = ?")) {
      const feedID = String(this.params[0] ?? "");
      const feed = this.options.feedsByID?.get(feedID);
      if (feed) return feed as T;
      return (this.options.tomlFeeds?.find((row) => row.feed_id === feedID) ?? null) as T | null;
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
    if (this.query.includes("FROM feeds f") && this.query.includes("LEFT JOIN feed_filters")) {
      return (this.options.tomlFeeds ?? []).filter((feed) => feed.enabled === 1);
    }

    if (
      this.query.includes("FROM feeds f") &&
      this.query.includes("LEFT JOIN feed_metadata") &&
      this.query.includes("f.enabled = 1") &&
      this.query.includes("f.include_in_opml = 1")
    ) {
      return fakeFeedRows(this.options)
        .filter((feed) => feed.enabled === 1 && feed.include_in_opml === 1 && fakePublicPath(feed) !== null)
        .sort(compareFeedIDAsc)
        .map(publicOpmlFeedRow);
    }

    if (
      this.query.includes("FROM feeds f") &&
      this.query.includes("LEFT JOIN feed_metadata") &&
      this.query.includes("f.public_path IS NOT NULL")
    ) {
      return fakeFeedRows(this.options)
        .filter((feed) => fakePublicPath(feed) !== null)
        .sort(compareFeedIDAsc)
        .map(adminSubscriptionFeedRow);
    }

    if (
      this.query.includes("FROM feeds f") &&
      this.query.includes("LEFT JOIN feed_metadata") &&
      this.query.includes("m.title AS metadata_title")
    ) {
      return fakeFeedRows(this.options).sort(compareFeedIDAsc).map(adminFeedListRow);
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

    return [];
  }

  runWithOptions(options: FakeD1Options): D1Result {
    options.sqlLog?.push(this.query);
    let changes = 0;
    if (this.query.includes("INSERT INTO episodes") && this.query.includes("ON CONFLICT")) {
      this.runEpisodeUpsert(options);
      changes = 1;
    } else if (this.query.includes("UPDATE feeds") && this.query.includes("include_in_opml")) {
      changes = this.runFeedStatusUpdate(options);
    } else if (this.query.includes("UPDATE episodes") && this.query.includes("SET status")) {
      changes = this.runEpisodeStatusUpdate(options);
    } else if (this.query.includes("INSERT INTO tombstone_changes")) {
      changes = this.runTombstoneInsert(options);
    }
    options.lastChanges = changes;
    return { results: [], success: true, meta: { changes } } as unknown as D1Result;
  }

  private runEpisodeUpsert(options: FakeD1Options): void {
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
    options.beforeEpisodeUpsert?.(key, episodes.get(key));
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
  }

  private runFeedStatusUpdate(options: FakeD1Options): number {
    const [enabled, includeInOpml, feedID] = this.params;
    const id = String(feedID);
    const feed = options.feedsByID?.get(id);
    if (feed) {
      feed.enabled = Number(enabled);
      feed.include_in_opml = Number(includeInOpml);
    }
    const tomlFeed = options.tomlFeeds?.find((row) => row.feed_id === id);
    if (tomlFeed) {
      tomlFeed.enabled = Number(enabled);
      tomlFeed.include_in_opml = Number(includeInOpml);
    }
    return feed || tomlFeed ? 1 : 0;
  }

  private runEpisodeStatusUpdate(options: FakeD1Options): number {
    const [feedID, localEpisodeID] = this.params;
    const key = fakeEpisodeKey(String(feedID), String(localEpisodeID));
    const episode = options.episodesByKey?.get(key);
    options.beforeEpisodeStatusUpdate?.(key, episode);
    const current = options.episodesByKey?.get(key);
    if (!current) return 0;
    const query = this.query;
    if (query.includes("status = 'delete_pending'")) {
      if (current.status !== "pending" && current.status !== "visible" && current.status !== "hidden") return 0;
      current.status = "delete_pending";
      current.deleted_at = "2026-07-06 00:00:00";
      current.purge_after = "2026-07-13 00:00:00";
      current.updated_at = "2026-07-06 00:00:00";
      return 1;
    }
    if (query.includes("status = 'visible'")) {
      if (current.status !== "hidden" && current.status !== "delete_pending") return 0;
      current.status = "visible";
      current.deleted_at = null;
      current.purge_after = null;
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

  private runTombstoneInsert(options: FakeD1Options): number {
    if (options.failTombstoneInsert) {
      throw new Error("tombstone insert failed");
    }
    if ((options.lastChanges ?? 0) !== 1) {
      return 0;
    }
    const [feedID, localEpisodeID, status, action] = this.params;
    const changes = options.tombstoneChanges ?? [];
    options.tombstoneChanges = changes;
    const sequence = changes.reduce((max, change) => Math.max(max, change.sequence), 0) + 1;
    changes.push({
      sequence,
      feed_id: String(feedID),
      local_episode_id: String(localEpisodeID),
      status: status as EpisodeStatus,
      action: action as "hide" | "delete" | "purge" | "restore",
      created_at: "2026-07-06 00:00:00",
    });
    return 1;
  }
}

export function fakeEpisodeKey(feedID: string, localEpisodeID: string): string {
  return `${feedID}\0${localEpisodeID}`;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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

function fakeFeedRows(options: FakeD1Options): FakeReadableFeed[] {
  const rows: FakeReadableFeed[] = [];
  const seen = new Set<string>();
  for (const feed of options.tomlFeeds ?? []) {
    rows.push(fakeReadableFeedFromToml(feed));
    seen.add(feed.feed_id);
  }
  for (const feed of options.feedsByID?.values() ?? []) {
    if (seen.has(feed.feed_id)) continue;
    rows.push(fakeReadableFeedFromPartial(feed));
  }
  return rows;
}

function fakeReadableFeedFromToml(feed: FeedTomlRow): FakeReadableFeed {
  const extras = feed as FeedTomlRow & {
    public_path?: string | null;
    metadata_title?: string | null;
    metadata_description?: string | null;
  };
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
    feed_token_hash: feed.feed_token_hash,
    public_path: extras.public_path ?? null,
    metadata_title: extras.metadata_title ?? null,
    metadata_description: extras.metadata_description ?? null,
  };
}

function fakeReadableFeedFromPartial(feed: FakeFeedRow): FakeReadableFeed {
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
    feed_token_hash: feed.feed_token_hash ?? "",
    public_path: feed.public_path ?? null,
    metadata_title: feed.metadata_title ?? null,
    metadata_description: feed.metadata_description ?? null,
  };
}

function fakePublicPath(feed: FakeReadableFeed): string | null {
  return feed.public_path && feed.public_path !== "" ? feed.public_path : null;
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
    public_path: feed.public_path,
    metadata_title: feed.metadata_title,
    metadata_description: feed.metadata_description,
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

function coalesceSQLiteDateTimeMillis(primary: string | null, fallback: string | null): number {
  const primaryTime = sqliteDateTimeMillis(primary);
  if (primaryTime !== 0) return primaryTime;
  return sqliteDateTimeMillis(fallback);
}

function compareAdminEpisodeOrder(left: FakeEpisodeRow, right: FakeEpisodeRow): number {
  const leftTime = coalesceSQLiteDateTimeMillis(left.published_at, left.updated_at);
  const rightTime = coalesceSQLiteDateTimeMillis(right.published_at, right.updated_at);
  if (leftTime !== rightTime) return rightTime - leftTime;
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
    episodesByKey: cloneMap(options.episodesByKey),
    tombstoneChanges: options.tombstoneChanges?.map((change) => ({ ...change })),
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
  commitMap(target.episodesByKey, staged.episodesByKey);
  if (!target.episodesByKey) target.episodesByKey = staged.episodesByKey;
  commitArray(target.tombstoneChanges, staged.tombstoneChanges, (value) => ({ ...value }));
  if (!target.tombstoneChanges) target.tombstoneChanges = staged.tombstoneChanges;
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

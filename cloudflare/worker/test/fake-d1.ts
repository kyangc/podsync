import type { DownloaderDefaults, EpisodeStatus, FeedTomlRow, PublicEpisodeRow, PublicFeedRow, TombstoneChangeRow } from "../src/db";

interface FakeD1Options {
  tomlFeeds?: FeedTomlRow[] | undefined;
  youtubeDefaults?: DownloaderDefaults | null | undefined;
  publicFeedsByHash?: Map<string, PublicFeedRow> | undefined;
  opmlTokenHashes?: Set<string> | undefined;
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
  enabled?: number;
  include_in_opml?: number;
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
  r2_key: string;
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

    if (this.query.includes("FROM opml_tokens")) {
      const tokenHash = String(this.params[0] ?? "");
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

    if (this.query.includes("FROM episodes") && this.query.includes("status = 'visible'")) {
      const feedID = String(this.params[0] ?? "");
      const limit = Number(this.params[1] ?? 25);
      return [...(this.options.episodesByKey?.values() ?? [])]
        .filter((episode) => episode.feed_id === feedID && episode.status === "visible" && episode.r2_key !== "")
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

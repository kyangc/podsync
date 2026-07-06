import type { DownloaderDefaults, EpisodeStatus, FeedTomlRow, PublicEpisodeRow, PublicFeedRow } from "../src/db";

interface FakeD1Options {
  tomlFeeds?: FeedTomlRow[];
  youtubeDefaults?: DownloaderDefaults | null;
  publicFeedsByHash?: Map<string, PublicFeedRow>;
  opmlTokenHashes?: Set<string>;
  feedsByID?: Map<string, FakeFeedRow>;
  episodesByKey?: Map<string, FakeEpisodeRow>;
  sqlLog?: string[];
  beforeEpisodeUpsert?: (key: string, episode: FakeEpisodeRow | undefined) => void;
}

interface FakeFeedRow {
  feed_id: string;
  provider: "youtube" | "bilibili";
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
      return (this.options.publicFeedsByHash?.get(tokenHash) ?? null) as T | null;
    }

    if (this.query.includes("FROM feeds") && this.query.includes("WHERE feed_id = ?")) {
      const feedID = String(this.params[0] ?? "");
      return (this.options.feedsByID?.get(feedID) ?? null) as T | null;
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

    const rows = this.allRows();
    return (rows[0] ?? null) as T | null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    this.options.sqlLog?.push(this.query);
    if (this.query.includes("INSERT INTO episodes") && this.query.includes("ON CONFLICT")) {
      this.runEpisodeUpsert();
    }
    return { results: [], success: true, meta: {} } as unknown as D1Result<T>;
  }

  async raw<T = unknown>(): Promise<T[]> {
    return this.allRows() as T[];
  }

  private allRows(): unknown[] {
    if (this.query.includes("FROM feeds f") && this.query.includes("LEFT JOIN feed_filters")) {
      return this.options.tomlFeeds ?? [];
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

    return [];
  }

  private runEpisodeUpsert(): void {
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
    const episodes = this.options.episodesByKey ?? new Map<string, FakeEpisodeRow>();
    this.options.episodesByKey = episodes;
    this.options.beforeEpisodeUpsert?.(key, episodes.get(key));
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
    });
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
  } as unknown as D1Database;
}

import type { DownloaderDefaults, FeedTomlRow, PublicFeedRow } from "../src/db";

interface FakeD1Options {
  tomlFeeds?: FeedTomlRow[];
  youtubeDefaults?: DownloaderDefaults | null;
  publicFeedsByHash?: Map<string, PublicFeedRow>;
  opmlTokenHashes?: Set<string>;
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

    if (this.query.includes("FROM opml_tokens")) {
      const tokenHash = String(this.params[0] ?? "");
      return (this.options.opmlTokenHashes?.has(tokenHash) ? { id: 1 } : null) as T | null;
    }

    const rows = this.allRows();
    return (rows[0] ?? null) as T | null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return { results: [], success: true, meta: {} } as unknown as D1Result<T>;
  }

  async raw<T = unknown>(): Promise<T[]> {
    return this.allRows() as T[];
  }

  private allRows(): unknown[] {
    if (this.query.includes("FROM feeds f") && this.query.includes("LEFT JOIN feed_filters")) {
      return this.options.tomlFeeds ?? [];
    }

    return [];
  }
}

export function fakeD1(options: FakeD1Options = {}): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      return new FakeStatement(options, query) as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

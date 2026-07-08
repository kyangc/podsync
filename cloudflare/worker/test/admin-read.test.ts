import { describe, expect, it } from "vitest";
import type { FeedTomlRow } from "../src/db";
import worker from "../src/index";
import { fakeD1, fakeEpisodeKey, type FakeEpisodeRow, type FakeFeedMetadataRow } from "./fake-d1";

function adminGet(path: string, init: RequestInit = {}): Request {
  const { headers, ...rest } = init;
  return new Request(`https://podcast.example.com${path}`, {
    method: "GET",
    headers: {
      "cf-access-jwt-assertion": "present",
      ...headers,
    },
    ...rest,
  });
}

function feedRow(overrides: Partial<FeedTomlRow & {
  public_path: string | null;
  metadata_title: string | null;
  metadata_description: string | null;
  deleted_at: string | null;
}> = {}): FeedTomlRow & {
  public_path?: string | null;
  metadata_title?: string | null;
  metadata_description?: string | null;
  deleted_at?: string | null;
} {
  return {
    feed_id: "feed",
    provider: "youtube",
    url: "https://www.youtube.com/channel/channel",
    title_override: null,
    description_override: null,
    enabled: 1,
    include_in_opml: 1,
    private_feed: 1,
    update_period: "1h",
    page_size: 25,
    keep_last: 25,
    cookie_profile: null,
    feed_token_hash: "feed-token-hash",
    public_path: "/f/feed-secret.xml",
    metadata_title: "Feed Metadata",
    metadata_description: "Metadata description",
    deleted_at: null,
    ...overrides,
  };
}

function episode(overrides: Partial<FakeEpisodeRow> = {}): FakeEpisodeRow {
  return {
    feed_id: "feed",
    provider: "youtube",
    source_episode_id: "source-episode",
    local_episode_id: "episode",
    source_url: "https://www.youtube.com/watch?v=episode",
    thumbnail: null,
    title: "Episode",
    description: "Description",
    published_at: "2026-07-06T12:00:00Z",
    duration: 123,
    status: "visible",
    r2_key: "audio/feed/episode.mp3",
    size: 456,
    mime_type: "audio/mpeg",
    asset_token: "asset",
    deleted_at: null,
    purge_after: null,
    updated_at: "2026-07-06 00:00:00",
    ...overrides,
  };
}

function metadata(overrides: Partial<FakeFeedMetadataRow> = {}): FakeFeedMetadataRow {
  return {
    feed_id: "feed",
    provider: "youtube",
    source_url: "https://www.youtube.com/channel/channel",
    title: "Feed Metadata",
    description: "Metadata description",
    image_url: null,
    link: null,
    author: null,
    category: null,
    language: null,
    explicit: null,
    last_source_update_at: "2026-07-06T12:00:00Z",
    reported_at: "2026-07-06T12:05:00Z",
    ...overrides,
  };
}

describe("admin read APIs", () => {
  it("requires Cloudflare Access for admin feeds", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/api/admin/feeds"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(403);
  });

  it("requires Cloudflare Access for admin episodes", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/api/admin/episodes?feed_id=feed"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(403);
  });

  it("requires Cloudflare Access for admin subscriptions", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/api/admin/subscriptions"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(403);
  });

  it("lists admin feeds with public URLs and metadata fallback", async () => {
    const response = await worker.fetch(
      adminGet("/api/admin/feeds"),
      {
        DB: fakeD1({
          feedMetadataByID: new Map([
            ["bili", metadata({
              feed_id: "bili",
              provider: "bilibili",
              source_url: "https://space.bilibili.com/10835521",
              title: "Bilibili Metadata",
              description: "Bilibili description",
              last_source_update_at: "2020-07-06T13:00:00Z",
              reported_at: "2026-07-06T13:05:00Z",
            })],
          ]),
          episodesByKey: new Map([
            [fakeEpisodeKey("bili", "old"), episode({
              feed_id: "bili",
              provider: "bilibili",
              source_episode_id: "old",
              local_episode_id: "old",
              published_at: "2026-07-06T10:00:00Z",
            })],
            [fakeEpisodeKey("bili", "latest"), episode({
              feed_id: "bili",
              provider: "bilibili",
              source_episode_id: "latest",
              local_episode_id: "latest",
              published_at: "2026-07-07T10:00:00Z",
            })],
            [fakeEpisodeKey("bili", "purged"), episode({
              feed_id: "bili",
              provider: "bilibili",
              source_episode_id: "purged",
              local_episode_id: "purged",
              published_at: "2026-07-08T10:00:00Z",
              status: "purged",
            })],
          ]),
          tomlFeeds: [
            feedRow({
              feed_id: "bili",
              provider: "bilibili",
              url: "https://space.bilibili.com/10835521",
              not_title: "直播",
              bilibili_include_upower_exclusive: 1,
              public_path: "/f/bili.xml",
            }),
            feedRow({
              feed_id: "yt",
              title_override: "YouTube Override",
              description_override: "Override description",
              metadata_title: null,
              metadata_description: null,
              enabled: 0,
              include_in_opml: 0,
              private_feed: 0,
              update_period: "6h",
              page_size: 10,
              keep_last: 20,
              cookie_profile: "youtube",
              public_path: null,
            }),
          ],
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      feeds: Array<{
        feed_id: string;
        title: string;
        description: string | null;
        title_override: string | null;
        description_override: string | null;
        filters: { not_title: string | null };
        enabled: boolean;
        include_in_opml: boolean;
        private_feed: boolean;
        bilibili: { include_upower_exclusive: boolean };
        public_feed_url: string | null;
        last_source_update_at: string | null;
        metadata_reported_at: string | null;
        latest_episode_published_at: string | null;
        episode_count: number;
      }>;
    };
    expect(body.feeds).toEqual([
      expect.objectContaining({
        feed_id: "bili",
        title: "Bilibili Metadata",
        description: "Bilibili description",
        title_override: null,
        description_override: null,
        filters: expect.objectContaining({ not_title: "直播" }),
        enabled: true,
        include_in_opml: true,
        private_feed: true,
        bilibili: { include_upower_exclusive: true },
        last_source_update_at: "2020-07-06T13:00:00Z",
        metadata_reported_at: "2026-07-06T13:05:00Z",
        latest_episode_published_at: "2026-07-07T10:00:00Z",
        episode_count: 2,
        public_feed_url: "https://podcast.example.com/f/bili.xml",
      }),
      expect.objectContaining({
        feed_id: "yt",
        title: "YouTube Override",
        description: "Override description",
        title_override: "YouTube Override",
        description_override: "Override description",
        filters: expect.objectContaining({ not_title: null }),
        enabled: false,
        include_in_opml: false,
        private_feed: false,
        latest_episode_published_at: null,
        episode_count: 0,
        public_feed_url: null,
      }),
    ]);
  });

  it("requires GET for admin feeds", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds", {
        method: "POST",
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      { DB: fakeD1() },
    );

    expect(response.status).toBe(405);
  });

  it("omits deleted feeds from admin feed list", async () => {
    const response = await worker.fetch(adminGet("/api/admin/feeds"), {
      DB: fakeD1({
        tomlFeeds: [
          feedRow({ feed_id: "visible", metadata_title: "Visible" }),
          feedRow({ feed_id: "deleted", metadata_title: "Deleted", deleted_at: "2026-07-06 00:00:00" }),
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { feeds: Array<{ feed_id: string }> };
    expect(body.feeds.map((feed) => feed.feed_id)).toEqual(["visible"]);
  });

  it("lists admin episodes for one feed", async () => {
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "episode"), episode()],
      [fakeEpisodeKey("other", "episode"), episode({ feed_id: "other", local_episode_id: "episode" })],
    ]);
    const response = await worker.fetch(adminGet("/api/admin/episodes?feed_id=feed"), {
      DB: fakeD1({
        tomlFeeds: [feedRow()],
        episodesByKey,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      feed_id: string;
      limit: number;
      offset: number;
      episodes: Array<{ local_episode_id: string; source_episode_id: string; has_media: boolean; status: string }>;
    };
    expect(body.feed_id).toBe("feed");
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.episodes).toEqual([
      expect.objectContaining({
        local_episode_id: "episode",
        source_episode_id: "source-episode",
        has_media: true,
        status: "visible",
      }),
    ]);
  });

  it("filters admin episodes by status", async () => {
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "visible"), episode({ local_episode_id: "visible", status: "visible" })],
      [fakeEpisodeKey("feed", "hidden"), episode({ local_episode_id: "hidden", status: "hidden", r2_key: "" })],
      [fakeEpisodeKey("feed", "pending"), episode({ local_episode_id: "pending", status: "pending", r2_key: null })],
    ]);
    const response = await worker.fetch(adminGet("/api/admin/episodes?feed_id=feed&status=hidden"), {
      DB: fakeD1({
        tomlFeeds: [feedRow()],
        episodesByKey,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { episodes: Array<{ local_episode_id: string; has_media: boolean; status: string }> };
    expect(body.episodes).toEqual([
      expect.objectContaining({ local_episode_id: "hidden", has_media: false, status: "hidden" }),
    ]);
  });

  it("marks null media keys as missing media in admin episodes", async () => {
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "pending"), episode({ local_episode_id: "pending", status: "pending", r2_key: null })],
    ]);
    const response = await worker.fetch(adminGet("/api/admin/episodes?feed_id=feed&status=pending"), {
      DB: fakeD1({
        tomlFeeds: [feedRow()],
        episodesByKey,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { episodes: Array<{ local_episode_id: string; has_media: boolean; status: string }> };
    expect(body.episodes).toEqual([
      expect.objectContaining({ local_episode_id: "pending", has_media: false, status: "pending" }),
    ]);
  });

  it("orders admin episodes by published date fallback and local id", async () => {
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "older"), episode({ local_episode_id: "older", published_at: "2026-07-06T12:00:00Z" })],
      [fakeEpisodeKey("feed", "fallback"), episode({ local_episode_id: "fallback", published_at: null, updated_at: "2026-07-06 13:00:00" })],
      [fakeEpisodeKey("feed", "b"), episode({ local_episode_id: "b", published_at: "2026-07-06T12:30:00Z" })],
      [fakeEpisodeKey("feed", "a"), episode({ local_episode_id: "a", published_at: "2026-07-06T12:30:00Z" })],
    ]);
    const response = await worker.fetch(adminGet("/api/admin/episodes?feed_id=feed"), {
      DB: fakeD1({
        tomlFeeds: [feedRow()],
        episodesByKey,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { episodes: Array<{ local_episode_id: string }> };
    expect(body.episodes.map((row) => row.local_episode_id)).toEqual(["fallback", "a", "b", "older"]);
  });

  it("applies admin episode limit and offset", async () => {
    const episodesByKey = new Map([
      [fakeEpisodeKey("feed", "new"), episode({ local_episode_id: "new", published_at: "2026-07-06T14:00:00Z" })],
      [fakeEpisodeKey("feed", "middle"), episode({ local_episode_id: "middle", published_at: "2026-07-06T13:00:00Z" })],
      [fakeEpisodeKey("feed", "old"), episode({ local_episode_id: "old", published_at: "2026-07-06T12:00:00Z" })],
    ]);
    const response = await worker.fetch(adminGet("/api/admin/episodes?feed_id=feed&limit=1&offset=1"), {
      DB: fakeD1({
        tomlFeeds: [feedRow()],
        episodesByKey,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { limit: number; offset: number; episodes: Array<{ local_episode_id: string }> };
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);
    expect(body.episodes.map((row) => row.local_episode_id)).toEqual(["middle"]);
  });

  it("validates admin episode query params", async () => {
    for (const path of [
      "/api/admin/episodes",
      "/api/admin/episodes?feed_id=feed&status=bad",
      "/api/admin/episodes?feed_id=feed&limit=0",
      "/api/admin/episodes?feed_id=feed&limit=201",
      "/api/admin/episodes?feed_id=feed&offset=-1",
    ]) {
      const response = await worker.fetch(adminGet(path), {
        DB: fakeD1({ tomlFeeds: [feedRow()] }),
      });

      expect(response.status, path).toBe(400);
    }
  });

  it("returns 404 for missing admin episode feed", async () => {
    const response = await worker.fetch(adminGet("/api/admin/episodes?feed_id=missing"), {
      DB: fakeD1({ tomlFeeds: [feedRow()] }),
    });

    expect(response.status).toBe(404);
  });

  it("returns 404 for deleted admin episode feed", async () => {
    const response = await worker.fetch(adminGet("/api/admin/episodes?feed_id=feed"), {
      DB: fakeD1({ tomlFeeds: [feedRow({ deleted_at: "2026-07-06 00:00:00" })] }),
    });

    expect(response.status).toBe(404);
  });

  it("lists subscription feed and OPML URLs", async () => {
    const response = await worker.fetch(adminGet("/api/admin/subscriptions"), {
      DB: fakeD1({
        tomlFeeds: [feedRow({ feed_id: "feed", metadata_title: "Feed", public_path: "/f/feed-secret.xml" })],
        opmlTokensByHash: new Map([
          ["hash", { label: "default", public_path: "/opml/default.xml" }],
        ]),
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      feeds: Array<{ feed_id: string; title: string; xml_url: string }>;
      opml: Array<{ label: string; xml_url: string }>;
    };
    expect(body.feeds).toEqual([
      { feed_id: "feed", title: "Feed", xml_url: "https://podcast.example.com/f/feed-secret.xml" },
    ]);
    expect(body.opml).toEqual([
      { label: "default", xml_url: "https://podcast.example.com/opml/default.xml" },
    ]);
  });

  it("omits invalid public paths from subscriptions", async () => {
    const response = await worker.fetch(adminGet("/api/admin/subscriptions"), {
      DB: fakeD1({
        tomlFeeds: [
          feedRow({ feed_id: "valid", metadata_title: "Valid", public_path: "/f/valid.xml" }),
          feedRow({ feed_id: "dot", metadata_title: "Dot", public_path: "/f/feed.secret.xml" }),
          feedRow({ feed_id: "encoded", metadata_title: "Encoded", public_path: "/f/%2e%2e/x.xml" }),
          feedRow({ feed_id: "query", metadata_title: "Query", public_path: "/f/feed.xml?x=1" }),
          feedRow({ feed_id: "hash", metadata_title: "Hash", public_path: "/f/feed.xml#x" }),
          feedRow({ feed_id: "slash", metadata_title: "Slash", public_path: "/f//feed.xml" }),
          feedRow({ feed_id: "prefix", metadata_title: "Prefix", public_path: "/opml/feed-secret.xml" }),
        ],
        opmlTokensByHash: new Map([
          ["valid", { label: "valid", public_path: "/opml/valid.xml" }],
          ["dot", { label: "dot", public_path: "/opml/default.secret.xml" }],
          ["encoded", { label: "encoded", public_path: "/opml/%2e%2e/x.xml" }],
          ["query", { label: "query", public_path: "/opml/default.xml?x=1" }],
          ["hash", { label: "hash", public_path: "/opml/default.xml#x" }],
          ["slash", { label: "slash", public_path: "/opml//default.xml" }],
          ["prefix", { label: "prefix", public_path: "/f/default.xml" }],
        ]),
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      feeds: Array<{ feed_id: string; title: string; xml_url: string }>;
      opml: Array<{ label: string; xml_url: string }>;
    };
    expect(body.feeds).toEqual([
      { feed_id: "valid", title: "Valid", xml_url: "https://podcast.example.com/f/valid.xml" },
    ]);
    expect(body.opml).toEqual([
      { label: "valid", xml_url: "https://podcast.example.com/opml/valid.xml" },
    ]);
  });

  it("omits deleted feeds from subscriptions", async () => {
    const response = await worker.fetch(adminGet("/api/admin/subscriptions"), {
      DB: fakeD1({
        tomlFeeds: [
          feedRow({ feed_id: "visible", metadata_title: "Visible", public_path: "/f/visible.xml" }),
          feedRow({ feed_id: "deleted", metadata_title: "Deleted", deleted_at: "2026-07-06 00:00:00", public_path: "/f/deleted.xml" }),
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { feeds: Array<{ feed_id: string }> };
    expect(body.feeds).toEqual([
      expect.objectContaining({ feed_id: "visible" }),
    ]);
  });

  it("rejects multi-segment and encoded-slash public paths from subscription output", async () => {
    const response = await worker.fetch(adminGet("/api/admin/subscriptions"), {
      DB: fakeD1({
        tomlFeeds: [
          feedRow({ feed_id: "nested", metadata_title: "Nested", public_path: "/f/nested/feed.xml" }),
          feedRow({ feed_id: "encoded-slash", metadata_title: "Encoded Slash", public_path: "/f/feed%2Fsecret.xml" }),
        ],
        opmlTokensByHash: new Map([
          ["nested", { label: "nested", public_path: "/opml/nested/default.xml" }],
          ["encoded-slash", { label: "encoded-slash", public_path: "/opml/default%2Fsecret.xml" }],
        ]),
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { feeds: unknown[]; opml: unknown[] };
    expect(body.feeds).toEqual([]);
    expect(body.opml).toEqual([]);
  });

  it("omits disabled OPML tokens from subscriptions", async () => {
    const response = await worker.fetch(adminGet("/api/admin/subscriptions"), {
      DB: fakeD1({
        opmlTokensByHash: new Map([
          ["enabled", { label: "enabled", public_path: "/opml/enabled.xml", enabled: 1 }],
          ["disabled", { label: "disabled", public_path: "/opml/disabled.xml", enabled: 0 }],
        ]),
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { opml: Array<{ label: string; xml_url: string }> };
    expect(body.opml).toEqual([
      { label: "enabled", xml_url: "https://podcast.example.com/opml/enabled.xml" },
    ]);
  });
});

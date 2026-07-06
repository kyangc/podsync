import { describe, expect, it } from "vitest";
import type { FeedTomlRow, PublicFeedRow } from "../src/db";
import worker from "../src/index";
import { sha256Hex } from "../src/tokens";
import { fakeD1, fakeEpisodeKey, type FakeEpisodeRow } from "./fake-d1";

function publicFeed(overrides: Partial<PublicFeedRow> = {}): PublicFeedRow {
  return {
    feed_id: "bili",
    provider: "bilibili",
    url: "https://space.bilibili.com/10835521",
    title_override: null,
    description_override: null,
    page_size: 25,
    title: "Bilibili Feed",
    description: "A feed",
    link: "https://space.bilibili.com/10835521",
    ...overrides,
  };
}

function tomlFeed(overrides: Partial<FeedTomlRow & { public_path: string | null; metadata_title: string | null }> = {}): FeedTomlRow & { public_path?: string | null; metadata_title?: string | null } {
  return {
    feed_id: "bili",
    provider: "bilibili",
    url: "https://space.bilibili.com/10835521",
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
    metadata_title: "Bilibili Feed",
    ...overrides,
  };
}

function visibleEpisode(overrides: Partial<FakeEpisodeRow> = {}): FakeEpisodeRow {
  return {
    feed_id: "bili",
    provider: "bilibili",
    source_episode_id: "BV1",
    local_episode_id: "BV1",
    source_url: "https://www.bilibili.com/video/BV1?foo=1&bar=2",
    thumbnail: null,
    title: "Episode & Title",
    description: "Description <one>",
    published_at: "2026-07-06T12:00:00Z",
    duration: 123,
    status: "visible",
    r2_key: "audio/bili/episode & one.mp3",
    size: 456,
    mime_type: "audio/mpeg",
    asset_token: "asset",
    deleted_at: null,
    purge_after: null,
    updated_at: "2026-07-06 00:00:00",
    ...overrides,
  };
}

describe("public feed contracts", () => {
  it("serves an empty RSS feed for a valid feed token", async () => {
    const tokenHash = await sha256Hex("feed-secret");
    const response = await worker.fetch(
      new Request("https://podcast.example.com/f/feed-secret.xml"),
      {
        DB: fakeD1({
          publicFeedsByHash: new Map([
            [tokenHash, publicFeed()],
          ]),
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/rss+xml");
    const body = await response.text();
    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain('<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">');
    expect(body).toContain("<channel>");
    expect(body).toContain("<title>Bilibili Feed</title>");
    expect(body).not.toContain("<item>");
  });

  it("renders visible episodes with enclosures", async () => {
    const tokenHash = await sha256Hex("feed-secret");
    const episodesByKey = new Map([
      [fakeEpisodeKey("bili", "BV1"), visibleEpisode()],
    ]);
    const response = await worker.fetch(
      new Request("https://podcast.example.com/f/feed-secret.xml"),
      {
        DB: fakeD1({
          publicFeedsByHash: new Map([[tokenHash, publicFeed()]]),
          episodesByKey,
        }),
        MEDIA_PUBLIC_BASE_URL: "https://media.example.com/base",
      },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<item>");
    expect(body).toContain("<title>Episode &amp; Title</title>");
    expect(body).toContain("<description>Description &lt;one&gt;</description>");
    expect(body).toContain("<link>https://www.bilibili.com/video/BV1?foo=1&amp;bar=2</link>");
    expect(body).toContain('<guid isPermaLink="false">BV1</guid>');
    expect(body).toContain("<pubDate>Mon, 06 Jul 2026 12:00:00 GMT</pubDate>");
    expect(body).toContain(
      '<enclosure url="https://media.example.com/base/audio/bili/episode%20%26%20one.mp3" length="456" type="audio/mpeg" />',
    );
    expect(body).toContain("<itunes:duration>123</itunes:duration>");
  });

  it("preserves R2 key path separators while encoding path segments", async () => {
    const tokenHash = await sha256Hex("feed-secret");
    const episodesByKey = new Map([
      [
        fakeEpisodeKey("bili", "BV1"),
        visibleEpisode({
          r2_key: "audio/bili/space name/#1.mp3",
        }),
      ],
    ]);
    const response = await worker.fetch(
      new Request("https://podcast.example.com/f/feed-secret.xml"),
      {
        DB: fakeD1({
          publicFeedsByHash: new Map([[tokenHash, publicFeed()]]),
          episodesByKey,
        }),
        MEDIA_PUBLIC_BASE_URL: "https://media.example.com",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("https://media.example.com/audio/bili/space%20name/%231.mp3");
  });

  it("rejects invalid R2 keys before rendering enclosures", async () => {
    const tokenHash = await sha256Hex("feed-secret");
    const episodesByKey = new Map([
      [fakeEpisodeKey("bili", "BV1"), visibleEpisode({ r2_key: "../bad.mp3" })],
    ]);
    const response = await worker.fetch(
      new Request("https://podcast.example.com/f/feed-secret.xml"),
      {
        DB: fakeD1({
          publicFeedsByHash: new Map([[tokenHash, publicFeed()]]),
          episodesByKey,
        }),
        MEDIA_PUBLIC_BASE_URL: "https://media.example.com",
      },
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("r2_key");
  });

  it("requires a media base URL when visible episodes exist", async () => {
    const tokenHash = await sha256Hex("feed-secret");
    const episodesByKey = new Map([
      [fakeEpisodeKey("bili", "BV1"), visibleEpisode()],
    ]);
    const response = await worker.fetch(
      new Request("https://podcast.example.com/f/feed-secret.xml"),
      {
        DB: fakeD1({
          publicFeedsByHash: new Map([[tokenHash, publicFeed()]]),
          episodesByKey,
        }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("MEDIA_PUBLIC_BASE_URL");
  });

  it("does not render hidden or purged episodes", async () => {
    const tokenHash = await sha256Hex("feed-secret");
    const episodesByKey = new Map([
      [fakeEpisodeKey("bili", "hidden"), visibleEpisode({ local_episode_id: "hidden", title: "Hidden", status: "hidden" })],
      [fakeEpisodeKey("bili", "purged"), visibleEpisode({ local_episode_id: "purged", title: "Purged", status: "purged" })],
      [fakeEpisodeKey("bili", "visible"), visibleEpisode({ local_episode_id: "visible", title: "Visible" })],
    ]);
    const response = await worker.fetch(
      new Request("https://podcast.example.com/f/feed-secret.xml"),
      {
        DB: fakeD1({
          publicFeedsByHash: new Map([[tokenHash, publicFeed()]]),
          episodesByKey,
        }),
        MEDIA_PUBLIC_BASE_URL: "https://media.example.com",
      },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<title>Visible</title>");
    expect(body).not.toContain("Hidden");
    expect(body).not.toContain("Purged");
  });

  it("rejects an invalid feed token", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/f/missing.xml"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(404);
  });

  it("rejects a malformed feed token", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/f/%E0%A4%A.xml"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(404);
  });

  it("requires GET for public feed routes", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/f/feed-secret.xml", { method: "POST" }), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(405);
  });

  it("serves empty OPML for a valid OPML token", async () => {
    const tokenHash = await sha256Hex("opml-secret");
    const response = await worker.fetch(
      new Request("https://podcast.example.com/opml/opml-secret.xml"),
      {
        DB: fakeD1({
          opmlTokenHashes: new Set([tokenHash]),
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/x-opml");
    const body = await response.text();
    expect(body).toContain('<opml version="2.0">');
    expect(body).toContain("<body>");
  });

  it("renders OPML outlines for enabled public feeds", async () => {
    const tokenHash = await sha256Hex("opml-secret");
    const response = await worker.fetch(
      new Request("https://podcast.example.com/opml/opml-secret.xml"),
      {
        DB: fakeD1({
          opmlTokenHashes: new Set([tokenHash]),
          tomlFeeds: [
            tomlFeed({ feed_id: "bili", metadata_title: "Bilibili Feed", public_path: "/f/feed-secret.xml" }),
            tomlFeed({ feed_id: "yt", provider: "youtube", metadata_title: null, title_override: "YouTube Feed", public_path: "/f/youtube_feed.xml" }),
          ],
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<outline type="rss" text="Bilibili Feed" title="Bilibili Feed" xmlUrl="https://podcast.example.com/f/feed-secret.xml" />');
    expect(body).toContain('text="YouTube Feed"');
    expect(body).toContain('xmlUrl="https://podcast.example.com/f/youtube_feed.xml"');
  });

  it("omits disabled non-opml and missing-public-path feeds from OPML", async () => {
    const tokenHash = await sha256Hex("opml-secret");
    const response = await worker.fetch(
      new Request("https://podcast.example.com/opml/opml-secret.xml"),
      {
        DB: fakeD1({
          opmlTokenHashes: new Set([tokenHash]),
          tomlFeeds: [
            tomlFeed({ feed_id: "visible", metadata_title: "Visible", public_path: "/f/visible.xml" }),
            tomlFeed({ feed_id: "disabled", metadata_title: "Disabled", enabled: 0, public_path: "/f/disabled.xml" }),
            tomlFeed({ feed_id: "excluded", metadata_title: "Excluded", include_in_opml: 0, public_path: "/f/excluded.xml" }),
            tomlFeed({ feed_id: "missing", metadata_title: "Missing", public_path: null }),
          ],
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Visible");
    expect(body).not.toContain("Disabled");
    expect(body).not.toContain("Excluded");
    expect(body).not.toContain("Missing");
  });

  it("does not use feed token hashes as OPML URLs", async () => {
    const tokenHash = await sha256Hex("opml-secret");
    const response = await worker.fetch(
      new Request("https://podcast.example.com/opml/opml-secret.xml"),
      {
        DB: fakeD1({
          opmlTokenHashes: new Set([tokenHash]),
          tomlFeeds: [tomlFeed({ feed_token_hash: "feed-token-hash", public_path: "/f/feed-secret.xml" })],
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("https://podcast.example.com/f/feed-secret.xml");
    expect(body).not.toContain("feed-token-hash");
  });

  it("omits malformed public feed paths from OPML", async () => {
    const tokenHash = await sha256Hex("opml-secret");
    const response = await worker.fetch(
      new Request("https://podcast.example.com/opml/opml-secret.xml"),
      {
        DB: fakeD1({
          opmlTokenHashes: new Set([tokenHash]),
          tomlFeeds: [
            tomlFeed({ feed_id: "valid", metadata_title: "Valid", public_path: "/f/valid_1.xml" }),
            tomlFeed({ feed_id: "dot", metadata_title: "Dot", public_path: "/f/feed.secret.xml" }),
            tomlFeed({ feed_id: "encoded", metadata_title: "Encoded", public_path: "/f/%2e%2e/x.xml" }),
            tomlFeed({ feed_id: "query", metadata_title: "Query", public_path: "/f/feed.xml?x=1" }),
            tomlFeed({ feed_id: "hash", metadata_title: "Hash", public_path: "/f/feed.xml#x" }),
            tomlFeed({ feed_id: "slash", metadata_title: "Slash", public_path: "/f//feed.xml" }),
            tomlFeed({ feed_id: "prefix", metadata_title: "Prefix", public_path: "/opml/feed-secret.xml" }),
          ],
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Valid");
    expect(body).not.toContain("Dot");
    expect(body).not.toContain("Encoded");
    expect(body).not.toContain("Query");
    expect(body).not.toContain("Hash");
    expect(body).not.toContain("Slash");
    expect(body).not.toContain("Prefix");
  });

  it("rejects an invalid OPML token", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/opml/missing.xml"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(404);
  });

  it("rejects a malformed OPML token", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/opml/%E0%A4%A.xml"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(404);
  });

  it("requires GET for OPML routes", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/opml/opml-secret.xml", { method: "POST" }), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(405);
  });
});

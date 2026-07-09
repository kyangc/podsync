import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/tokens";
import { fakeD1, type FakeFeedMetadataRow } from "./fake-d1";

const token = "secret-token";

function request(body: unknown, init: RequestInit = {}): Request {
  const { headers, ...rest } = init;
  return new Request("https://podcast.example.com/api/nas/feed-metadata/upsert", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    ...rest,
  });
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    feed_id: "feed",
    provider: "youtube",
    source_url: "https://www.youtube.com/channel/channel",
    title: "Source Title",
    description: "Source description",
    image_url: "https://example.com/cover.jpg",
    link: "https://example.com/channel",
    author: "Creator",
    category: "TV & Film",
    language: "en",
    explicit: false,
    last_source_update_at: "2026-07-06T12:00:00Z",
    reported_at: "2026-07-06T12:05:00Z",
    ...overrides,
  };
}

function feedRow(provider: "youtube" | "bilibili" = "youtube") {
  return { feed_id: "feed", provider, feed_token_hash: "feed-token-hash", public_path: "/f/feed-secret.xml" };
}

describe("NAS feed metadata upsert API", () => {
  it("requires NAS auth", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/feed-metadata/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body()),
      }),
      { DB: fakeD1() },
    );

    expect(response.status).toBe(401);
  });

  it("requires POST", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/feed-metadata/upsert", {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      }),
      { DB: fakeD1(), NAS_TOKEN: token },
    );

    expect(response.status).toBe(405);
  });

  it("validates content type and JSON", async () => {
    const wrongType = await worker.fetch(
      request(body(), { headers: { "content-type": "text/plain" } }),
      { DB: fakeD1(), NAS_TOKEN: token },
    );
    expect(wrongType.status).toBe(400);

    const invalidJSON = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/feed-metadata/upsert", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "{",
      }),
      { DB: fakeD1(), NAS_TOKEN: token },
    );
    expect(invalidJSON.status).toBe(400);
  });

  it("validates required fields and strict timestamps", async () => {
    for (const candidate of [
      body({ feed_id: "" }),
      body({ provider: "vimeo" }),
      body({ source_url: "" }),
      body({ reported_at: "2026-07-06T12:05:00.123Z" }),
      body({ reported_at: "Mon Jul 06 2026 12:05:00 GMT" }),
      body({ last_source_update_at: "2026-07-06T12:00:00.123Z" }),
      body({ explicit: "false" }),
    ]) {
      const response = await worker.fetch(request(candidate), { DB: fakeD1(), NAS_TOKEN: token });
      expect(response.status, JSON.stringify(candidate)).toBe(400);
    }
  });

  it("returns 404 when feed is missing", async () => {
    const response = await worker.fetch(request(body()), { DB: fakeD1(), NAS_TOKEN: token });

    expect(response.status).toBe(404);
  });

  it("returns 404 when feed is deleted", async () => {
    const feedMetadataByID = new Map<string, FakeFeedMetadataRow>();
    const response = await worker.fetch(
      request(body()),
      {
        DB: fakeD1({
          feedsByID: new Map([["feed", { ...feedRow(), deleted_at: "2026-07-06 00:00:00" }]]),
          feedMetadataByID,
        }),
        NAS_TOKEN: token,
      },
    );

    expect(response.status).toBe(404);
    expect(feedMetadataByID.size).toBe(0);
  });

  it("returns 404 when feed is deleted after metadata precheck", async () => {
    const feedMetadataByID = new Map<string, FakeFeedMetadataRow>();
    const feedsByID = new Map([["feed", feedRow()]]);
    const response = await worker.fetch(
      request(body()),
      {
        DB: fakeD1({
          feedsByID,
          feedMetadataByID,
          beforeFeedMetadataUpsert(_feedID, options) {
            const feed = options.feedsByID?.get("feed");
            if (feed) feed.deleted_at = "2026-07-06 00:00:00";
          },
        }),
        NAS_TOKEN: token,
      },
    );

    expect(response.status).toBe(404);
    expect(feedMetadataByID.size).toBe(0);
  });

  it("rejects provider mismatch", async () => {
    const response = await worker.fetch(
      request(body({ provider: "bilibili" })),
      { DB: fakeD1({ feedsByID: new Map([["feed", feedRow("youtube")]]) }), NAS_TOKEN: token },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("provider mismatch");
  });

  it("inserts feed metadata", async () => {
    const feedMetadataByID = new Map<string, FakeFeedMetadataRow>();
    const response = await worker.fetch(
      request(body()),
      { DB: fakeD1({ feedsByID: new Map([["feed", feedRow()]]), feedMetadataByID }), NAS_TOKEN: token },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, feed_id: "feed" });
    expect(feedMetadataByID.get("feed")).toMatchObject({
      provider: "youtube",
      source_url: "https://www.youtube.com/channel/channel",
      title: "Source Title",
      description: "Source description",
      image_url: "https://example.com/cover.jpg",
      link: "https://example.com/channel",
      author: "Creator",
      category: "TV & Film",
      language: "en",
      explicit: 0,
      last_source_update_at: "2026-07-06T12:00:00Z",
      reported_at: "2026-07-06T12:05:00Z",
    });
  });

  it("updates existing feed metadata", async () => {
    const feedMetadataByID = new Map<string, FakeFeedMetadataRow>([
      ["feed", {
        feed_id: "feed",
        provider: "youtube",
        source_url: "old",
        title: "Old",
        description: "Old description",
        image_url: "https://example.com/cover.jpg",
        link: null,
        author: null,
        category: null,
        language: null,
        explicit: null,
        last_source_update_at: null,
        reported_at: "2026-07-01T00:00:00Z",
      }],
    ]);

    const response = await worker.fetch(
      request(body({ title: "New", description: "New description", explicit: true })),
      { DB: fakeD1({ feedsByID: new Map([["feed", feedRow()]]), feedMetadataByID }), NAS_TOKEN: token },
    );

    expect(response.status).toBe(200);
    expect(feedMetadataByID.get("feed")).toMatchObject({
      title: "New",
      description: "New description",
      explicit: 1,
    });
  });

  it("reflects reported metadata in public RSS and admin feed list", async () => {
    const tokenHash = await sha256Hex("feed-secret");
    const feedMetadataByID = new Map<string, FakeFeedMetadataRow>([
      ["feed", {
        feed_id: "feed",
        provider: "youtube",
        source_url: "https://www.youtube.com/channel/channel",
        title: "Reported Title",
        description: "Reported description",
        image_url: "https://example.com/cover.jpg",
        link: "https://example.com/reported",
        author: "Reported Creator",
        category: "Technology",
        language: "zh-CN",
        explicit: 0,
        last_source_update_at: null,
        reported_at: "2026-07-06T12:05:00Z",
      }],
    ]);
    const env = {
      DB: fakeD1({
        feedsByID: new Map([[
          "feed",
          {
            ...feedRow(),
            url: "https://www.youtube.com/channel/channel",
            feed_token_hash: tokenHash,
            title_override: "Override",
          },
        ]]),
        feedMetadataByID,
      }),
    };

    const rss = await worker.fetch(new Request("https://podcast.example.com/f/feed-secret.xml"), env);
    expect(rss.status).toBe(200);
    const rssBody = await rss.text();
    expect(rssBody).toContain("<title>Reported Title</title>");
    expect(rssBody).toContain("<description>Reported description</description>");
    expect(rssBody).toContain("<link>https://example.com/reported</link>");
    expect(rssBody).toContain("<url>https://example.com/cover.jpg</url>");
    expect(rssBody).toContain('<itunes:image href="https://example.com/cover.jpg"></itunes:image>');
    expect(rssBody).toContain("<itunes:author>Reported Creator</itunes:author>");
    expect(rssBody).toContain('<itunes:category text="Technology"></itunes:category>');
    expect(rssBody).toContain("<itunes:explicit>false</itunes:explicit>");
    expect(rssBody).toContain("<language>zh-CN</language>");

    const admin = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds", {
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      env,
    );
    expect(admin.status).toBe(200);
    const adminBody = await admin.json() as { feeds: Array<{ feed_id: string; title: string; description: string; image_url: string | null }> };
    expect(adminBody.feeds).toContainEqual(expect.objectContaining({
      feed_id: "feed",
      title: "Reported Title",
      description: "Reported description",
      image_url: "https://example.com/cover.jpg",
    }));
  });
});

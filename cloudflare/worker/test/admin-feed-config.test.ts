import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/tokens";
import { fakeD1, type FakeFeedRow } from "./fake-d1";

const nasToken = "secret";

function adminRequest(path: string, body: unknown, init: RequestInit = {}): Request {
  const { headers, ...rest } = init;
  return new Request(`https://podcast.example.com${path}`, {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": "present",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    ...rest,
  });
}

function nasConfigRequest(): Request {
  return new Request("https://podcast.example.com/api/nas/config.toml", {
    headers: { authorization: `Bearer ${nasToken}` },
  });
}

function feedBody(overrides: Record<string, unknown> = {}) {
  return {
    feed_id: "new-feed",
    provider: "youtube",
    url: "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
    title_override: "New Feed",
    description_override: null,
    enabled: true,
    include_in_opml: true,
    private_feed: true,
    update_period: "1h",
    page_size: 25,
    keep_last: 25,
    cookie_profile: null,
    filters: {
      title: null,
      not_title: "live",
      description: null,
      not_description: null,
      min_duration: null,
      max_duration: 86400,
      min_age: null,
      max_age: null,
    },
    ...overrides,
  };
}

describe("admin feed config upsert API", () => {
  it("requires Cloudflare Access and POST", async () => {
    const noAccess = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(feedBody()),
      }),
      { DB: fakeD1() },
    );
    expect(noAccess.status).toBe(403);

    const wrongMethod = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds/upsert", {
        method: "GET",
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      { DB: fakeD1() },
    );
    expect(wrongMethod.status).toBe(405);
  });

  it("validates content type, JSON, fields, provider host, and filters", async () => {
    const wrongType = await worker.fetch(
      adminRequest("/api/admin/feeds/upsert", feedBody(), { headers: { "content-type": "text/plain" } }),
      { DB: fakeD1() },
    );
    expect(wrongType.status).toBe(400);

    const invalidJSON = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds/upsert", {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": "present",
          "content-type": "application/json",
        },
        body: "{",
      }),
      { DB: fakeD1() },
    );
    expect(invalidJSON.status).toBe(400);

    const oversizedBody = await worker.fetch(
      adminRequest("/api/admin/feeds/upsert", feedBody({ title_override: "x".repeat(70 * 1024) })),
      { DB: fakeD1() },
    );
    expect(oversizedBody.status).toBe(400);

    for (const candidate of [
      feedBody({ feed_id: "" }),
      feedBody({ feed_id: "../bad" }),
      feedBody({ provider: "vimeo" }),
      feedBody({ url: "ftp://www.youtube.com/channel/x" }),
      feedBody({ url: "https://youtube.com.evil.test/channel/x" }),
      feedBody({ provider: "bilibili", url: "https://evilbilibili.com/10835521" }),
      feedBody({ update_period: "soon" }),
      feedBody({ page_size: 0 }),
      feedBody({ page_size: 201 }),
      feedBody({ keep_last: -1 }),
      feedBody({ enabled: "true" }),
      feedBody({ filters: [] }),
      feedBody({ filters: { min_duration: -1 } }),
    ]) {
      const response = await worker.fetch(adminRequest("/api/admin/feeds/upsert", candidate), { DB: fakeD1() });
      expect(response.status, JSON.stringify(candidate)).toBe(400);
    }
  });

  it("creates a feed with public URL, filters, subscriptions, and NAS TOML output", async () => {
    const feedsByID = new Map();
    const env = {
      DB: fakeD1({
        feedsByID,
        youtubeDefaults: { socket_timeout: 12, retries: 1, fragment_retries: 1 },
      }),
      NAS_TOKEN: nasToken,
    };

    const response = await worker.fetch(adminRequest("/api/admin/feeds/upsert", feedBody({
      url: " https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw ",
    })), env);

    expect(response.status).toBe(200);
    const body = await response.json() as {
      created: boolean;
      feed: { feed_id: string; public_feed_url: string; filters: { not_title: string } };
    };
    expect(body.created).toBe(true);
    expect(body.feed.feed_id).toBe("new-feed");
    expect(body.feed.public_feed_url).toMatch(/^https:\/\/podcast\.example\.com\/f\/[A-Za-z0-9_-]+\.xml$/);
    expect(body.feed.filters.not_title).toBe("live");

    const saved = feedsByID.get("new-feed");
    expect(saved).toMatchObject({
      provider: "youtube",
      url: "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
      title_override: "New Feed",
      enabled: 1,
      include_in_opml: 1,
      not_title: "live",
      max_duration: 86400,
    });
    expect(saved.public_path).toMatch(/^\/f\/[A-Za-z0-9_-]+\.xml$/);
    const token = saved.public_path.slice("/f/".length, -".xml".length);
    await expect(sha256Hex(token)).resolves.toBe(saved.feed_token_hash);

    const subscriptions = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/subscriptions", {
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      env,
    );
    expect(subscriptions.status).toBe(200);
    const subscriptionsBody = await subscriptions.json() as { feeds: Array<{ feed_id: string; xml_url: string }> };
    expect(subscriptionsBody.feeds).toEqual([
      { feed_id: "new-feed", title: "New Feed", xml_url: body.feed.public_feed_url },
    ]);

    const config = await worker.fetch(nasConfigRequest(), env);
    expect(config.status).toBe(200);
    const toml = await config.text();
    expect(toml).toContain('[feeds."new-feed"]');
    expect(toml).toContain('url = "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw"');
    expect(toml).toContain('filters = { not_title = "live", max_duration = 86400 }');
  });

  it("retries generated public token collisions on create", async () => {
    const feedsByID = new Map();
    let collisions = 0;
    const response = await worker.fetch(
      adminRequest("/api/admin/feeds/upsert", feedBody()),
      {
        DB: fakeD1({
          feedsByID,
          feedInsertUniqueCollision: () => collisions++ === 0,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(collisions).toBe(2);
    expect(feedsByID.has("new-feed")).toBe(true);
  });

  it("does not retry feed id unique conflicts on create", async () => {
    const feedsByID = new Map();
    let attempts = 0;
    const response = await worker.fetch(
      adminRequest("/api/admin/feeds/upsert", feedBody()),
      {
        DB: fakeD1({
          feedsByID,
          feedInsertUniqueCollision: () => {
            attempts++;
            throw new Error("UNIQUE constraint failed: feeds.feed_id");
          },
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(attempts).toBe(1);
    expect(feedsByID.size).toBe(0);
  });

  it("rolls back feed creation when filter upsert fails", async () => {
    const feedsByID = new Map();
    const response = await worker.fetch(
      adminRequest("/api/admin/feeds/upsert", feedBody()),
      { DB: fakeD1({ feedsByID, failFeedFiltersUpsert: true }) },
    );

    expect(response.status).toBe(500);
    expect(feedsByID.size).toBe(0);
  });

  it("updates editable fields and filters while preserving public URL material", async () => {
    const feedsByID = new Map<string, FakeFeedRow>([
      ["new-feed", {
        feed_id: "new-feed",
        provider: "youtube",
        url: "https://www.youtube.com/channel/old",
        title_override: "Old",
        description_override: null,
        enabled: 1,
        include_in_opml: 1,
        private_feed: 1,
        update_period: "1h",
        page_size: 25,
        keep_last: 25,
        cookie_profile: null,
        feed_token_hash: "existing-hash",
        public_path: "/f/existing.xml",
        not_title: "old",
      }],
    ]);
    const env = {
      DB: fakeD1({
        feedsByID,
        youtubeDefaults: { socket_timeout: 12, retries: 1, fragment_retries: 1 },
      }),
      NAS_TOKEN: nasToken,
    };

    const response = await worker.fetch(
      adminRequest("/api/admin/feeds/upsert", feedBody({
        title_override: null,
        description_override: "Updated description",
        enabled: false,
        include_in_opml: false,
        private_feed: false,
        update_period: "2h30m",
        page_size: 10,
        keep_last: 0,
        filters: { title: "review", not_title: null },
      })),
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { created: boolean; feed: { public_feed_url: string; filters: { title: string | null; not_title: string | null } } };
    expect(body.created).toBe(false);
    expect(body.feed.public_feed_url).toBe("https://podcast.example.com/f/existing.xml");
    expect(body.feed.filters).toMatchObject({ title: "review", not_title: null });

    const saved = feedsByID.get("new-feed");
    expect(saved).toMatchObject({
      feed_token_hash: "existing-hash",
      public_path: "/f/existing.xml",
      title_override: null,
      description_override: "Updated description",
      enabled: 0,
      include_in_opml: 0,
      private_feed: 0,
      update_period: "2h30m",
      page_size: 10,
      keep_last: 0,
      title: "review",
      not_title: null,
    });

    const config = await worker.fetch(nasConfigRequest(), env);
    expect(config.status).toBe(200);
    await expect(config.text()).resolves.not.toContain('[feeds."new-feed"]');
  });

  it("rolls back feed updates when filter upsert fails", async () => {
    const feedsByID = new Map<string, FakeFeedRow>([
      ["new-feed", {
        feed_id: "new-feed",
        provider: "youtube",
        url: "https://www.youtube.com/channel/old",
        title_override: "Old",
        enabled: 1,
        include_in_opml: 1,
        private_feed: 1,
        update_period: "1h",
        page_size: 25,
        keep_last: 25,
        feed_token_hash: "existing-hash",
        public_path: "/f/existing.xml",
        not_title: "old",
      }],
    ]);

    const response = await worker.fetch(
      adminRequest("/api/admin/feeds/upsert", feedBody({
        url: "https://www.youtube.com/channel/new",
        enabled: false,
        filters: { not_title: "new" },
      })),
      { DB: fakeD1({ feedsByID, failFeedFiltersUpsert: true }) },
    );

    expect(response.status).toBe(500);
    expect(feedsByID.get("new-feed")).toMatchObject({
      url: "https://www.youtube.com/channel/old",
      enabled: 1,
      not_title: "old",
    });
  });

  it("rejects provider changes without mutating the existing feed", async () => {
    const feedsByID = new Map<string, FakeFeedRow>([
      ["new-feed", {
        feed_id: "new-feed",
        provider: "youtube",
        url: "https://www.youtube.com/channel/old",
        enabled: 1,
        include_in_opml: 1,
        feed_token_hash: "existing-hash",
        public_path: "/f/existing.xml",
      }],
    ]);

    const response = await worker.fetch(
      adminRequest("/api/admin/feeds/upsert", feedBody({
        provider: "bilibili",
        url: "https://space.bilibili.com/10835521",
      })),
      { DB: fakeD1({ feedsByID }) },
    );

    expect(response.status).toBe(400);
    expect(feedsByID.get("new-feed")).toMatchObject({
      provider: "youtube",
      url: "https://www.youtube.com/channel/old",
    });
  });
});

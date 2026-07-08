import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/tokens";
import { fakeD1 } from "./fake-d1";

const adminOrigin = "https://podcast.example.com";
const nasToken = "secret";

function adminRequest(path: string, body: unknown): Request {
  return new Request(`${adminOrigin}${path}`, {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": "present",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function adminGet(path: string): Request {
  return new Request(`${adminOrigin}${path}`, {
    headers: { "cf-access-jwt-assertion": "present" },
  });
}

function nasRequest(path: string, body: unknown): Request {
  return new Request(`${adminOrigin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${nasToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function nasConfigRequest(): Request {
  return new Request(`${adminOrigin}/api/nas/config.toml`, {
    headers: { authorization: `Bearer ${nasToken}` },
  });
}

function feedBody(overrides: Record<string, unknown> = {}) {
  return {
    feed_id: "e2e-feed",
    provider: "youtube",
    url: "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
    title_override: "E2E Feed",
    description_override: "Lifecycle feed",
    enabled: true,
    include_in_opml: true,
    private_feed: true,
    update_period: "1h",
    page_size: 25,
    keep_last: 25,
    cookie_profile: null,
    filters: {
      title: null,
      not_title: null,
      description: null,
      not_description: null,
      min_duration: null,
      max_duration: null,
      min_age: null,
      max_age: null,
    },
    ...overrides,
  };
}

function episodeBody(overrides: Record<string, unknown> = {}) {
  return {
    feed_id: "e2e-feed",
    provider: "youtube",
    source_episode_id: "video-1",
    local_episode_id: "video-1",
    source_url: "https://www.youtube.com/watch?v=video-1",
    thumbnail: "https://img.example.com/video-1.jpg",
    title: "Lifecycle Episode",
    description: "Episode from NAS seed",
    published_at: "2026-07-08T12:00:00Z",
    duration: 123,
    r2_key: "audio/e2e-feed/video-1.mp3",
    size: 456,
    mime_type: "audio/mpeg",
    asset_token: "asset-token",
    ...overrides,
  };
}

describe("remote dashboard feed lifecycle e2e", () => {
  it("creates, publishes, disables, enables, and deletes a feed with RSS OPML and TOML assertions", async () => {
    const opmlTokenHash = await sha256Hex("e2e-opml");
    const feedsByID = new Map();
    const episodesByKey = new Map();
    const env = {
      DB: fakeD1({
        feedsByID,
        episodesByKey,
        opmlTokenHashes: new Set([opmlTokenHash]),
        opmlTokensByHash: new Map([
          [opmlTokenHash, { label: "Default", public_path: "/opml/e2e-opml.xml" }],
        ]),
      }),
      MEDIA_PUBLIC_BASE_URL: "https://media.example.com",
      NAS_TOKEN: nasToken,
    };

    const create = await worker.fetch(adminRequest("/api/admin/feeds/upsert", feedBody()), env);
    expect(create.status).toBe(200);
    const createBody = await create.json() as {
      created: boolean;
      feed: { feed_id: string; public_feed_url: string };
    };
    expect(createBody).toMatchObject({
      created: true,
      feed: { feed_id: "e2e-feed" },
    });
    expect(createBody.feed.public_feed_url).toMatch(/^https:\/\/podcast\.example\.com\/f\/[A-Za-z0-9_-]+\.xml$/);

    const subscriptions = await worker.fetch(adminGet("/api/admin/subscriptions"), env);
    expect(subscriptions.status).toBe(200);
    const subscriptionsBody = await subscriptions.json() as {
      feeds: Array<{ feed_id: string; xml_url: string }>;
      opml: Array<{ label: string; xml_url: string }>;
    };
    expect(subscriptionsBody.feeds).toContainEqual({
      feed_id: "e2e-feed",
      title: "E2E Feed",
      xml_url: createBody.feed.public_feed_url,
    });
    expect(subscriptionsBody.opml).toContainEqual({
      label: "Default",
      xml_url: `${adminOrigin}/opml/e2e-opml.xml`,
    });

    const seedEpisode = await worker.fetch(nasRequest("/api/nas/episodes/upsert", episodeBody()), env);
    expect(seedEpisode.status).toBe(200);
    await expect(seedEpisode.json()).resolves.toMatchObject({ ok: true, status: "visible" });

    await expectRssVisible(createBody.feed.public_feed_url, env);
    await expectOpmlContains(env, "E2E Feed", createBody.feed.public_feed_url);
    await expectTomlContainsFeed(env);

    const disable = await worker.fetch(adminRequest("/api/admin/feeds/status", {
      feed_id: "e2e-feed",
      enabled: false,
    }), env);
    expect(disable.status).toBe(200);
    await expect(disable.json()).resolves.toMatchObject({ enabled: false, include_in_opml: true });
    await expectAdminFeedEnabled(env, false);
    await expectRssVisible(createBody.feed.public_feed_url, env);
    await expectOpmlOmits(env, "E2E Feed");
    await expectTomlOmitsFeed(env);

    const enable = await worker.fetch(adminRequest("/api/admin/feeds/status", {
      feed_id: "e2e-feed",
      enabled: true,
    }), env);
    expect(enable.status).toBe(200);
    await expect(enable.json()).resolves.toMatchObject({ enabled: true, include_in_opml: true });
    await expectAdminFeedEnabled(env, true);
    await expectRssVisible(createBody.feed.public_feed_url, env);
    await expectOpmlContains(env, "E2E Feed", createBody.feed.public_feed_url);
    await expectTomlContainsFeed(env);

    const deleted = await worker.fetch(adminRequest("/api/admin/feeds/delete", {
      feed_id: "e2e-feed",
    }), env);
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ ok: true, deleted: true, episodes_marked: 1 });
    await expectAdminFeedMissing(env);

    const deletedRss = await worker.fetch(new Request(createBody.feed.public_feed_url), env);
    expect(deletedRss.status).toBe(410);
    await expect(deletedRss.text()).resolves.toBe("feed deleted");
    await expectOpmlOmits(env, "E2E Feed");
    await expectTomlOmitsFeed(env);
  });
});

async function expectRssVisible(feedUrl: string, env: Parameters<typeof worker.fetch>[1]) {
  const response = await worker.fetch(new Request(feedUrl), env);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/rss+xml");
  const rss = await response.text();
  expect(rss).toContain("<item>");
  expect(rss).toContain("<title>Lifecycle Episode</title>");
  expect(rss).toContain('<guid isPermaLink="false">video-1</guid>');
  expect(rss).toContain("<pubDate>Wed, 08 Jul 2026 12:00:00 GMT</pubDate>");
  expect(rss).toContain(
    '<enclosure url="https://media.example.com/audio/e2e-feed/video-1.mp3" length="456" type="audio/mpeg" />',
  );
}

async function expectOpmlContains(env: Parameters<typeof worker.fetch>[1], title: string, feedUrl: string) {
  const response = await worker.fetch(new Request(`${adminOrigin}/opml/e2e-opml.xml`), env);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/x-opml");
  const opml = await response.text();
  expect(opml).toContain(`text="${title}"`);
  expect(opml).toContain(`xmlUrl="${feedUrl}"`);
}

async function expectOpmlOmits(env: Parameters<typeof worker.fetch>[1], title: string) {
  const response = await worker.fetch(new Request(`${adminOrigin}/opml/e2e-opml.xml`), env);
  expect(response.status).toBe(200);
  await expect(response.text()).resolves.not.toContain(title);
}

async function expectTomlContainsFeed(env: Parameters<typeof worker.fetch>[1]) {
  const response = await worker.fetch(nasConfigRequest(), env);
  expect(response.status).toBe(200);
  const toml = await response.text();
  expect(toml).toContain('[feeds."e2e-feed"]');
  expect(toml).toContain('url = "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw"');
  expect(toml).toContain('update_period = "1h"');
  expect(toml).toContain("page_size = 25");
  expect(toml).toContain("keep_last = 25");
}

async function expectTomlOmitsFeed(env: Parameters<typeof worker.fetch>[1]) {
  const response = await worker.fetch(nasConfigRequest(), env);
  expect(response.status).toBe(200);
  await expect(response.text()).resolves.not.toContain('[feeds."e2e-feed"]');
}

async function expectAdminFeedEnabled(env: Parameters<typeof worker.fetch>[1], enabled: boolean) {
  const response = await worker.fetch(adminGet("/api/admin/feeds"), env);
  expect(response.status).toBe(200);
  const body = await response.json() as { feeds: Array<{ feed_id: string; enabled: boolean }> };
  expect(body.feeds).toContainEqual(expect.objectContaining({ feed_id: "e2e-feed", enabled }));
}

async function expectAdminFeedMissing(env: Parameters<typeof worker.fetch>[1]) {
  const response = await worker.fetch(adminGet("/api/admin/feeds"), env);
  expect(response.status).toBe(200);
  const body = await response.json() as { feeds: Array<{ feed_id: string }> };
  expect(body.feeds).not.toContainEqual(expect.objectContaining({ feed_id: "e2e-feed" }));
}

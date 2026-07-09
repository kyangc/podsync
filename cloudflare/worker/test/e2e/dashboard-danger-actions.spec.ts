import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startE2EServer, type E2EServer } from "./server";

test.describe("dashboard danger actions", () => {
  let server: E2EServer;

  test.beforeEach(async () => {
    server = await startE2EServer();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test("keeps a feed intact when delete is cancelled and removes exports only after confirmation", async ({ page, request }) => {
    await createFeed(request, server.url);
    await seedEpisode(request, server.url);
    const feedUrl = await publicFeedUrl(request, server.url);

    await page.goto(`${server.url}/dashboard/`);
    await expect(feedRow(page)).toBeVisible();

    await feedRow(page).getByRole("button", { name: "删除订阅源" }).click();
    await expect(page.locator("#confirm-modal")).toBeVisible();
    await page.locator("#confirm-cancel").click();
    await expect(page.locator("#confirm-modal")).toBeHidden();
    await expect(feedRow(page)).toBeVisible();
    await expectRssContains(request, feedUrl, "Danger Episode");
    await expectOpmlContains(request, server.url, "Danger Feed", feedUrl);
    await expectTomlContains(request, server.url, '[feeds."danger-feed"]');

    await feedRow(page).getByRole("button", { name: "删除订阅源" }).click();
    await expect(page.locator("#confirm-modal")).toBeVisible();
    await page.locator("#confirm-ok").click();
    await expect(feedRow(page)).toHaveCount(0);
    await expectDeletedRss(request, feedUrl);
    await expectOpmlOmits(request, server.url, "Danger Feed");
    await expectTomlOmits(request, server.url, '[feeds."danger-feed"]');
    await expectDeleteTombstone(request, server.url);
  });
});

function feedRow(page: Page) {
  return page.locator("#feeds-body tr").filter({ hasText: "Danger Feed" });
}

async function createFeed(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.post(`${origin}/api/admin/feeds/upsert`, {
    data: {
      feed_id: "danger-feed",
      provider: "youtube",
      url: "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
      title_override: "Danger Feed",
      description_override: null,
      enabled: true,
      include_in_opml: true,
      private_feed: true,
      update_period: "1h",
      page_size: 25,
      keep_last: 25,
      cookie_profile: null,
      bilibili: { include_upower_exclusive: false },
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
    },
  });
  expect(response.status()).toBe(200);
}

async function seedEpisode(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.post(`${origin}/__test/seed-episode`, {
    data: {
      feed_id: "danger-feed",
      local_episode_id: "danger-video",
      source_episode_id: "danger-video",
      title: "Danger Episode",
      source_url: "https://www.youtube.com/watch?v=danger-video",
      r2_key: "audio/danger-feed/danger-video.mp3",
      size: 456,
    },
  });
  expect(response.status()).toBe(200);
}

async function publicFeedUrl(request: APIRequestContext, origin: string): Promise<string> {
  const response = await request.get(`${origin}/api/admin/feeds`);
  expect(response.status()).toBe(200);
  const body = await response.json() as { feeds: Array<{ feed_id: string; public_feed_url: string }> };
  const feed = body.feeds.find((item) => item.feed_id === "danger-feed");
  expect(feed?.public_feed_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/f\/[A-Za-z0-9_-]+\.xml$/);
  return feed!.public_feed_url;
}

async function expectRssContains(request: APIRequestContext, feedUrl: string, text: string): Promise<void> {
  const response = await request.get(feedUrl);
  expect(response.status()).toBe(200);
  await expect(response.text()).resolves.toContain(text);
}

async function expectDeletedRss(request: APIRequestContext, feedUrl: string): Promise<void> {
  const response = await request.get(feedUrl);
  expect(response.status()).toBe(410);
  await expect(response.text()).resolves.toBe("feed deleted");
}

async function expectOpmlContains(request: APIRequestContext, origin: string, title: string, feedUrl: string): Promise<void> {
  const response = await request.get(`${origin}/opml/e2e-opml.xml`);
  expect(response.status()).toBe(200);
  const opml = await response.text();
  expect(opml).toContain(`text="${title}"`);
  expect(opml).toContain(`xmlUrl="${feedUrl}"`);
}

async function expectOpmlOmits(request: APIRequestContext, origin: string, text: string): Promise<void> {
  const response = await request.get(`${origin}/opml/e2e-opml.xml`);
  expect(response.status()).toBe(200);
  await expect(response.text()).resolves.not.toContain(text);
}

async function expectTomlContains(request: APIRequestContext, origin: string, text: string): Promise<void> {
  const response = await request.get(`${origin}/__test/config.toml`);
  expect(response.status()).toBe(200);
  await expect(response.text()).resolves.toContain(text);
}

async function expectTomlOmits(request: APIRequestContext, origin: string, text: string): Promise<void> {
  const response = await request.get(`${origin}/__test/config.toml`);
  expect(response.status()).toBe(200);
  await expect(response.text()).resolves.not.toContain(text);
}

async function expectDeleteTombstone(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.get(`${origin}/__test/tombstones?cursor=0`);
  expect(response.status()).toBe(200);
  const body = await response.json() as {
    changes: Array<{ feed_id: string; local_episode_id: string; action: string; status: string }>;
  };
  expect(body.changes).toContainEqual(expect.objectContaining({
    feed_id: "danger-feed",
    local_episode_id: "danger-video",
    action: "delete",
    status: "delete_pending",
  }));
}

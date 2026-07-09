import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startE2EServer, type E2EServer } from "./server";

test.describe("dashboard episode actions", () => {
  let server: E2EServer;

  test.beforeEach(async () => {
    server = await startE2EServer();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test("hides, restores, and deletes an episode while keeping RSS and tombstones in sync", async ({ page, request }) => {
    await createFeed(request, server.url);
    await seedEpisode(request, server.url);
    const feedUrl = await publicFeedUrl(request, server.url);
    await expectRssContains(request, feedUrl, "Episode Actions Target");

    await page.goto(`${server.url}/dashboard/`);
    await feedRow(page).getByRole("button", { name: "查看" }).click();
    await expect(page.locator("#episodes-modal")).toBeVisible();
    await expect(episodeRow(page)).toBeVisible();
    await expect(episodeStatus(page, "已发布")).toBeVisible();

    await episodeRow(page).getByRole("button", { name: "隐藏" }).click();
    await expect(episodeStatus(page, "已隐藏")).toBeVisible();
    await expectRssOmits(request, feedUrl, "Episode Actions Target");
    await expectTombstone(request, server.url, "hide", "hidden");

    await episodeRow(page).getByRole("button", { name: "恢复" }).click();
    await expect(episodeStatus(page, "已发布")).toBeVisible();
    await expectRssContains(request, feedUrl, "Episode Actions Target");

    await episodeRow(page).getByRole("button", { name: "删除" }).click();
    await expect(page.locator("#confirm-modal")).toBeVisible();
    await page.locator("#confirm-ok").click();
    await expect(episodeStatus(page, "等待删除")).toBeVisible();
    await expectRssOmits(request, feedUrl, "Episode Actions Target");
    await expectTombstone(request, server.url, "delete", "delete_pending");
  });
});

function feedRow(page: Page) {
  return page.locator("#feeds-body tr").filter({ hasText: "Episode Actions Feed" });
}

function episodeRow(page: Page) {
  return page.locator("#episodes-body tr").filter({ hasText: "Episode Actions Target" });
}

function episodeStatus(page: Page, label: string) {
  return episodeRow(page).locator(".episode-status-cell", { hasText: label });
}

async function createFeed(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.post(`${origin}/api/admin/feeds/upsert`, {
    data: {
      feed_id: "episode-actions-feed",
      provider: "youtube",
      url: "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
      title_override: "Episode Actions Feed",
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
      feed_id: "episode-actions-feed",
      provider: "youtube",
      local_episode_id: "episode-actions-video",
      source_episode_id: "episode-actions-video",
      source_url: "https://www.youtube.com/watch?v=episode-actions-video",
      title: "Episode Actions Target",
      description: "Episode action regression target",
      published_at: "2026-07-08T12:00:00Z",
      duration: 600,
      r2_key: "audio/episode-actions-feed/episode-actions-video.mp3",
      size: 789,
    },
  });
  expect(response.status()).toBe(200);
}

async function publicFeedUrl(request: APIRequestContext, origin: string): Promise<string> {
  const response = await request.get(`${origin}/api/admin/feeds`);
  expect(response.status()).toBe(200);
  const body = await response.json() as { feeds: Array<{ feed_id: string; public_feed_url: string }> };
  const feed = body.feeds.find((item) => item.feed_id === "episode-actions-feed");
  expect(feed?.public_feed_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/f\/[A-Za-z0-9_-]+\.xml$/);
  return feed!.public_feed_url;
}

async function expectRssContains(request: APIRequestContext, feedUrl: string, text: string): Promise<void> {
  const response = await request.get(feedUrl);
  expect(response.status()).toBe(200);
  await expect(response.text()).resolves.toContain(text);
}

async function expectRssOmits(request: APIRequestContext, feedUrl: string, text: string): Promise<void> {
  const response = await request.get(feedUrl);
  expect(response.status()).toBe(200);
  await expect(response.text()).resolves.not.toContain(text);
}

async function expectTombstone(
  request: APIRequestContext,
  origin: string,
  action: "hide" | "delete",
  status: "hidden" | "delete_pending",
): Promise<void> {
  const response = await request.get(`${origin}/__test/tombstones?cursor=0`);
  expect(response.status()).toBe(200);
  const body = await response.json() as {
    changes: Array<{ feed_id: string; local_episode_id: string; action: string; status: string }>;
  };
  expect(body.changes).toContainEqual(expect.objectContaining({
    feed_id: "episode-actions-feed",
    local_episode_id: "episode-actions-video",
    action,
    status,
  }));
}

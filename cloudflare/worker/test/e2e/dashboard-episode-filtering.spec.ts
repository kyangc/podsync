import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startE2EServer, type E2EServer } from "./server";

test.describe("dashboard episode filtering", () => {
  let server: E2EServer;

  test.beforeEach(async () => {
    server = await startE2EServer();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test("filters and searches episode lists while RSS keeps only visible episodes", async ({ page, request }) => {
    await createFeed(request, server.url);
    await seedEpisode(request, server.url, "visible-video", "Search Visible Episode");
    await seedEpisode(request, server.url, "hidden-video", "Hidden Candidate Episode");
    await seedEpisode(request, server.url, "delete-video", "Delete Candidate Episode");
    const feedUrl = await publicFeedUrl(request, server.url);

    await page.goto(`${server.url}/dashboard/`);
    await feedRow(page).getByRole("button", { name: "查看" }).click();
    await expect(page.locator("#episodes-modal")).toBeVisible();
    await expect(episodeRow(page, "Search Visible Episode")).toBeVisible();
    await expect(episodeRow(page, "Hidden Candidate Episode")).toBeVisible();
    await expect(episodeRow(page, "Delete Candidate Episode")).toBeVisible();

    await episodeRow(page, "Hidden Candidate Episode").getByRole("button", { name: "隐藏" }).click();
    await expect(episodeRow(page, "Hidden Candidate Episode").locator(".episode-status-cell")).toHaveText("已隐藏");

    await episodeRow(page, "Delete Candidate Episode").getByRole("button", { name: "删除" }).click();
    await expect(page.locator("#confirm-modal")).toBeVisible();
    await page.locator("#confirm-ok").click();
    await expect(episodeRow(page, "Delete Candidate Episode").locator(".episode-status-cell")).toHaveText("等待删除");

    await selectCustomOption(page, "episode-status-filter", "已隐藏");
    await expect(episodeRow(page, "Hidden Candidate Episode")).toBeVisible();
    await expect(episodeRow(page, "Search Visible Episode")).toHaveCount(0);
    await expect(episodeRow(page, "Delete Candidate Episode")).toHaveCount(0);

    await selectCustomOption(page, "episode-status-filter", "等待删除");
    await expect(episodeRow(page, "Delete Candidate Episode")).toBeVisible();
    await expect(episodeRow(page, "Hidden Candidate Episode")).toHaveCount(0);

    await selectCustomOption(page, "episode-status-filter", "全部剧集");
    await page.locator("#episode-search").fill("Visible");
    await expect(episodeRow(page, "Search Visible Episode")).toBeVisible();
    await expect(episodeRow(page, "Hidden Candidate Episode")).toHaveCount(0);
    await expect(episodeRow(page, "Delete Candidate Episode")).toHaveCount(0);

    await page.locator("#episode-search").fill("");
    await page.getByRole("button", { name: "刷新剧集" }).click();
    await expect(episodeRow(page, "Search Visible Episode")).toBeVisible();
    await expect(episodeRow(page, "Hidden Candidate Episode")).toBeVisible();
    await expect(episodeRow(page, "Delete Candidate Episode")).toBeVisible();

    await expectRssContains(request, feedUrl, "Search Visible Episode");
    await expectRssOmits(request, feedUrl, "Hidden Candidate Episode");
    await expectRssOmits(request, feedUrl, "Delete Candidate Episode");
  });

  test("keeps episode modal inside narrow viewport with unclipped header tooltip", async ({ page, request }) => {
    await page.setViewportSize({ width: 370, height: 890 });
    await createFeed(request, server.url);
    await seedEpisode(request, server.url, "mobile-video", "Mobile Episode Layout");

    await page.goto(`${server.url}/dashboard/`);
    await feedRow(page).getByRole("button", { name: "查看(1)" }).click();

    await expect(page.locator("#episodes-modal")).toBeVisible();
    await expect(page.locator("body")).toHaveClass(/modal-open/);
    await expect(page.locator("#episodes-close")).toHaveText("x");
    await expectModalInsideViewport(page, "#episodes-modal .modal", 10);

    const tooltipPosition = await page.locator("#refresh-episodes").evaluate((element) => {
      const style = window.getComputedStyle(element, "::after");
      return { top: style.top, bottom: style.bottom };
    });
    expect(tooltipPosition.top).not.toBe("auto");
    expect(tooltipPosition.bottom).toBe("auto");
  });
});

function feedRow(page: Page) {
  return page.locator("#feeds-body tr").filter({ hasText: "Episode Filter Feed" });
}

function episodeRow(page: Page, title: string) {
  return page.locator("#episodes-body tr").filter({ hasText: title });
}

async function selectCustomOption(page: Page, selectID: string, label: string): Promise<void> {
  await page.locator(`#${selectID}-trigger`).click();
  await page.locator(`#${selectID}-menu`).getByRole("option", { name: label }).click();
}

async function createFeed(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.post(`${origin}/api/admin/feeds/upsert`, {
    data: {
      feed_id: "episode-filter-feed",
      provider: "youtube",
      url: "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
      title_override: "Episode Filter Feed",
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

async function seedEpisode(request: APIRequestContext, origin: string, id: string, title: string): Promise<void> {
  const response = await request.post(`${origin}/__test/seed-episode`, {
    data: {
      feed_id: "episode-filter-feed",
      source_episode_id: id,
      local_episode_id: id,
      source_url: `https://www.youtube.com/watch?v=${id}`,
      title,
      description: title,
      published_at: "2026-07-08T12:00:00Z",
      r2_key: `audio/episode-filter-feed/${id}.mp3`,
      asset_token: id,
    },
  });
  expect(response.status()).toBe(200);
}

async function publicFeedUrl(request: APIRequestContext, origin: string): Promise<string> {
  const response = await request.get(`${origin}/api/admin/feeds`);
  expect(response.status()).toBe(200);
  const body = await response.json() as { feeds: Array<{ feed_id: string; public_feed_url: string }> };
  const feed = body.feeds.find((item) => item.feed_id === "episode-filter-feed");
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

async function expectModalInsideViewport(page: Page, selector: string, minimumGap: number): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(minimumGap);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width - minimumGap);
}

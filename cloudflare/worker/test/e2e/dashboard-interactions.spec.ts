import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startE2EServer, type E2EServer } from "./server";

test.describe("dashboard interactions", () => {
  let server: E2EServer;

  test.beforeEach(async () => {
    server = await startE2EServer();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test("validates the feed form and closes modals from the backdrop", async ({ page }) => {
    await page.goto(`${server.url}/dashboard/`);

    await page.getByRole("button", { name: "添加订阅源" }).click();
    await expect(page.locator("#feed-modal")).toBeVisible();
    await page.getByRole("button", { name: "保存变更" }).click();

    await expect(page.locator("#feed-id-error")).toHaveText("请填写订阅源 ID");
    await expect(page.locator("#feed-url-error")).toHaveText("请填写来源 URL");
    await expect(page.locator("#toast-region").getByText("请先填写必填项")).toBeVisible();

    await page.locator("#feed-modal").click({ position: { x: 8, y: 8 } });
    await expect(page.locator("#feed-modal")).toBeHidden();
  });

  test("filters, sorts, and reads logs through dashboard controls", async ({ page, request }) => {
    await createFeed(request, server.url, {
      feed_id: "alpha-notes",
      provider: "youtube",
      url: "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
      title_override: "Alpha Notes",
      enabled: false,
    });
    await createFeed(request, server.url, {
      feed_id: "zed-bili",
      provider: "bilibili",
      url: "https://space.bilibili.com/10835521",
      title_override: "Zed Bili",
      cookie_profile: "bilibili-main",
      bilibili: { include_upower_exclusive: true },
    });
    await seedEpisode(request, server.url, {
      feed_id: "alpha-notes",
      provider: "youtube",
      local_episode_id: "older-video",
      source_episode_id: "older-video",
      title: "Older Alpha Episode",
      published_at: "2026-07-08T11:00:00Z",
    });
    await seedEpisode(request, server.url, {
      feed_id: "zed-bili",
      provider: "bilibili",
      local_episode_id: "newer-video",
      source_episode_id: "newer-video",
      source_url: "https://www.bilibili.com/video/BV1uiE2E",
      title: "Newer Bili Episode",
      published_at: "2026-07-08T13:00:00Z",
    });
    await seedEvents(request, server.url);

    await page.goto(`${server.url}/dashboard/`);
    await expect(firstFeedTitle(page)).toHaveText("Zed Bili");

    await selectCustomOption(page, "provider-filter", "B 站");
    await expect(feedRow(page, "Zed Bili")).toBeVisible();
    await expect(feedRow(page, "Alpha Notes")).toHaveCount(0);

    await page.getByRole("button", { name: "重置筛选" }).click();
    await selectCustomOption(page, "feed-state-filter", "已停用");
    await expect(feedRow(page, "Alpha Notes")).toBeVisible();
    await expect(feedRow(page, "Zed Bili")).toHaveCount(0);

    await page.getByRole("button", { name: "重置筛选" }).click();
    await page.locator("#feed-search").fill("alpha");
    await expect(feedRow(page, "Alpha Notes")).toBeVisible();
    await expect(feedRow(page, "Zed Bili")).toHaveCount(0);

    await page.getByRole("button", { name: "重置筛选" }).click();
    await page.locator('[data-sort-key="title"]').click();
    await expect(firstFeedTitle(page)).toHaveText("Alpha Notes");
    await expect(page.locator('th:has([data-sort-key="title"])')).toHaveAttribute("aria-sort", "ascending");

    await page.locator("#open-logs").click();
    await expect(page.locator("#logs-modal")).toBeVisible();
    await expect(page.locator("#metric-logs")).toHaveText("3");
    await expect(page.getByText("YouTube updated")).toBeVisible();
    await expect(page.getByText("Bilibili warning")).toBeVisible();
    await expect(page.getByText("Remote failed")).toBeVisible();

    await selectCustomOption(page, "event-level-filter", "警告");
    await expect(page.getByText("Bilibili warning")).toBeVisible();
    await expect(page.getByText("YouTube updated")).toHaveCount(0);
    await expect(page.getByText("Remote failed")).toHaveCount(0);

    await page.locator("#logs-modal").click({ position: { x: 8, y: 8 } });
    await expect(page.locator("#logs-modal")).toBeHidden();
  });

  test("opens episode lists from the mobile feed card actions", async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 820 });
    await createFeed(request, server.url, {
      feed_id: "mobile-feed",
      provider: "youtube",
      url: "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
      title_override: "Mobile Feed",
    });
    await seedEpisode(request, server.url, {
      feed_id: "mobile-feed",
      local_episode_id: "mobile-video",
      source_episode_id: "mobile-video",
      title: "Mobile Episode",
      published_at: "2026-07-08T14:00:00Z",
    });

    await page.goto(`${server.url}/dashboard/`);
    const row = feedRow(page, "Mobile Feed");
    await expect(row).toBeVisible();
    await expect(row.locator(".mobile-feed-meta").getByText("YouTube")).toBeVisible();
    await expect(row.locator(".mobile-feed-meta").getByText("已启用")).toBeVisible();

    await row.locator(".actions-cell").getByRole("button", { name: "查看剧集" }).click();
    await expect(page.locator("#episodes-modal")).toBeVisible();
    await expect(page.getByText("Mobile Episode")).toBeVisible();

    await page.locator("#episodes-modal").click({ position: { x: 8, y: 8 } });
    await expect(page.locator("#episodes-modal")).toBeHidden();
  });
});

function feedRow(page: Page, title: string) {
  return page.locator("#feeds-body tr").filter({ hasText: title });
}

function firstFeedTitle(page: Page) {
  return page.locator("#feeds-body tr").first().locator(".feed-title-button");
}

async function selectCustomOption(page: Page, selectID: string, label: string): Promise<void> {
  await page.locator(`#${selectID}-trigger`).click();
  await page.locator(`#${selectID}-menu`).getByRole("option", { name: label }).click();
}

async function createFeed(request: APIRequestContext, origin: string, overrides: Record<string, unknown>): Promise<void> {
  const response = await request.post(`${origin}/api/admin/feeds/upsert`, {
    data: {
      feed_id: "test-feed",
      provider: "youtube",
      url: "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
      title_override: null,
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
      ...overrides,
    },
  });
  expect(response.status()).toBe(200);
}

async function seedEpisode(request: APIRequestContext, origin: string, overrides: Record<string, unknown>): Promise<void> {
  const response = await request.post(`${origin}/__test/seed-episode`, { data: overrides });
  expect(response.status()).toBe(200);
}

async function seedEvents(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.post(`${origin}/__test/seed-events`, { data: {} });
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ ok: true, accepted_events: 3 });
}

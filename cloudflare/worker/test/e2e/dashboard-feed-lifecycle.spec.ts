import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startE2EServer, type E2EServer } from "./server";

test.describe("dashboard feed lifecycle", () => {
  let server: E2EServer;

  test.beforeEach(async () => {
    server = await startE2EServer();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test("creates, seeds, disables, enables, and deletes a feed through dashboard clicks", async ({ page, request }) => {
    await page.goto(`${server.url}/dashboard/`);
    await expect(page.getByRole("heading", { name: "Podsync Dashboard" })).toBeVisible();
    await expect(page.getByText("还没有订阅源。")).toBeVisible();

    await page.getByRole("button", { name: "添加订阅源" }).click();
    await page.locator("#feed-id").fill("ui-e2e-feed");
    await page.locator("#feed-url").fill("https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw");
    await page.locator("#feed-title-override").fill("UI E2E Feed");
    await page.locator("#feed-description-override").fill("Created from Playwright");
    await page.getByRole("button", { name: "保存变更" }).click();

    await expect(page.getByText("订阅源已保存")).toBeVisible();
    await expect(feedRow(page)).toBeVisible();
    await expect(feedStatus(page, "已启用")).toBeVisible();

    const feedUrl = await publicFeedUrl(request, server.url);
    await seedEpisode(request, server.url);
    await feedRow(page).getByRole("button", { name: "查看剧集" }).click();
    await expect(page.locator("#episodes-modal")).toBeVisible();
    await expect(page.getByText("UI E2E Episode")).toBeVisible();
    await page.locator("#episodes-footer-close").click();

    await expectRssContains(request, feedUrl, "UI E2E Episode");
    await expectOpmlContains(request, server.url, "UI E2E Feed", feedUrl);
    await expectTomlContains(request, server.url, '[feeds."ui-e2e-feed"]');

    await feedRow(page).getByRole("button", { name: "停用订阅源" }).click();
    await expect(feedStatus(page, "已停用")).toBeVisible();
    await expectRssContains(request, feedUrl, "UI E2E Episode");
    await expectOpmlOmits(request, server.url, "UI E2E Feed");
    await expectTomlOmits(request, server.url, '[feeds."ui-e2e-feed"]');

    await feedRow(page).getByRole("button", { name: "启用订阅源" }).click();
    await expect(feedStatus(page, "已启用")).toBeVisible();
    await expectRssContains(request, feedUrl, "UI E2E Episode");
    await expectOpmlContains(request, server.url, "UI E2E Feed", feedUrl);
    await expectTomlContains(request, server.url, '[feeds."ui-e2e-feed"]');

    await feedRow(page).getByRole("button", { name: "删除订阅源" }).click();
    await expect(page.locator("#confirm-modal")).toBeVisible();
    await page.locator("#confirm-ok").click();
    await expect(feedRow(page)).toHaveCount(0);
    await expect(page.getByText("还没有订阅源。")).toBeVisible();

    const deletedRss = await request.get(feedUrl);
    expect(deletedRss.status()).toBe(410);
    await expect(deletedRss.text()).resolves.toBe("feed deleted");
    await expectOpmlOmits(request, server.url, "UI E2E Feed");
    await expectTomlOmits(request, server.url, '[feeds."ui-e2e-feed"]');
  });
});

function feedRow(page: Page) {
  return page.locator("#feeds-body tr").filter({ hasText: "UI E2E Feed" });
}

function feedStatus(page: Page, label: string) {
  return feedRow(page).locator(".status-cell", { hasText: label });
}

async function publicFeedUrl(request: APIRequestContext, origin: string): Promise<string> {
  const response = await request.get(`${origin}/api/admin/feeds`);
  expect(response.status()).toBe(200);
  const body = await response.json() as { feeds: Array<{ feed_id: string; public_feed_url: string }> };
  const feed = body.feeds.find((item) => item.feed_id === "ui-e2e-feed");
  expect(feed?.public_feed_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/f\/[A-Za-z0-9_-]+\.xml$/);
  return feed!.public_feed_url;
}

async function seedEpisode(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.post(`${origin}/__test/seed-episode`, { data: {} });
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ ok: true, status: "visible" });
}

async function expectRssContains(request: APIRequestContext, feedUrl: string, text: string): Promise<void> {
  const response = await request.get(feedUrl);
  expect(response.status()).toBe(200);
  const rss = await response.text();
  expect(rss).toContain(text);
  expect(rss).toContain('<enclosure url="https://media.example.com/audio/ui-e2e-feed/video-1.mp3" length="456" type="audio/mpeg" />');
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

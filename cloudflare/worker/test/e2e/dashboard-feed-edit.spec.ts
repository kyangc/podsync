import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startE2EServer, type E2EServer } from "./server";

test.describe("dashboard feed editing", () => {
  let server: E2EServer;

  test.beforeEach(async () => {
    server = await startE2EServer();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test("updates Bilibili feed options and reflects them in RSS, OPML, and TOML exports", async ({ page, request }) => {
    await createBilibiliFeed(request, server.url);
    const feedUrl = await publicFeedUrl(request, server.url);
    await expectOpmlContains(request, server.url, "Original Bili Feed", feedUrl);

    await page.goto(`${server.url}/dashboard/`);
    await expect(feedRow(page, "Original Bili Feed")).toBeVisible();

    await feedRow(page, "Original Bili Feed").getByRole("button", { name: "编辑订阅源" }).click();
    await expect(page.locator("#feed-modal")).toBeVisible();
    await page.locator("#feed-title-override").fill("Edited Bili Feed");
    await page.locator("#feed-cookie-profile").fill("bilibili-main");
    await page.locator("#feed-include-in-opml").uncheck();
    await page.locator("#feed-bilibili-include-upower").check();
    await page.getByRole("button", { name: "保存变更" }).click();

    await expect(page.locator("#feed-modal")).toBeHidden();
    await expect(feedRow(page, "Edited Bili Feed")).toBeVisible();
    await expect(feedRow(page, "Original Bili Feed")).toHaveCount(0);

    await expectRssContains(request, feedUrl, "<title>Edited Bili Feed</title>");
    await expectOpmlOmits(request, server.url, "Edited Bili Feed");
    await expectTomlContains(request, server.url, '[feeds."feed-edit-bili"]');
    await expectTomlContains(request, server.url, 'url = "https://space.bilibili.com/10835521"');
    await expectTomlContains(request, server.url, 'cookie_profile = "bilibili-main"');
    await expectTomlContains(request, server.url, '[feeds."feed-edit-bili".bilibili]');
    await expectTomlContains(request, server.url, "include_upower_exclusive = true");
  });
});

function feedRow(page: Page, title: string) {
  return page.locator("#feeds-body tr").filter({ hasText: title });
}

async function createBilibiliFeed(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.post(`${origin}/api/admin/feeds/upsert`, {
    data: {
      feed_id: "feed-edit-bili",
      provider: "bilibili",
      url: "https://space.bilibili.com/10835521",
      title_override: "Original Bili Feed",
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

async function publicFeedUrl(request: APIRequestContext, origin: string): Promise<string> {
  const response = await request.get(`${origin}/api/admin/feeds`);
  expect(response.status()).toBe(200);
  const body = await response.json() as { feeds: Array<{ feed_id: string; public_feed_url: string }> };
  const feed = body.feeds.find((item) => item.feed_id === "feed-edit-bili");
  expect(feed?.public_feed_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/f\/[A-Za-z0-9_-]+\.xml$/);
  return feed!.public_feed_url;
}

async function expectRssContains(request: APIRequestContext, feedUrl: string, text: string): Promise<void> {
  const response = await request.get(feedUrl);
  expect(response.status()).toBe(200);
  await expect(response.text()).resolves.toContain(text);
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

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startE2EServer, type E2EServer } from "./server";

test.describe("dashboard export and toast interactions", () => {
  let server: E2EServer;

  test.beforeEach(async () => {
    server = await startE2EServer();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test("copies the OPML URL, shows a toast, and serves the expected OPML XML", async ({ page, request }) => {
    await installClipboardMock(page);
    await createFeed(request, server.url);
    const feedUrl = await publicFeedUrl(request, server.url);

    await page.goto(`${server.url}/dashboard/`);
    await page.locator("#copy-opml").click();

    await expect(page.locator("#toast-region")).toContainText("已复制到剪贴板");
    const copiedText = await page.evaluate(() => (window as unknown as { __copiedText?: string }).__copiedText);
    expect(copiedText).toBe(`${server.url}/opml/e2e-opml.xml`);

    const opml = await request.get(copiedText!);
    expect(opml.status()).toBe(200);
    const body = await opml.text();
    expect(body).toContain('text="Export Toast Feed"');
    expect(body).toContain(`xmlUrl="${feedUrl}"`);
  });
});

async function installClipboardMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(value: string) {
          (window as unknown as { __copiedText?: string }).__copiedText = value;
          return Promise.resolve();
        },
      },
    });
  });
}

async function createFeed(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.post(`${origin}/api/admin/feeds/upsert`, {
    data: {
      feed_id: "export-toast-feed",
      provider: "youtube",
      url: "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
      title_override: "Export Toast Feed",
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
  const feed = body.feeds.find((item) => item.feed_id === "export-toast-feed");
  expect(feed?.public_feed_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/f\/[A-Za-z0-9_-]+\.xml$/);
  return feed!.public_feed_url;
}

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startE2EServer, type E2EServer } from "./server";

test.describe("dashboard metadata and details", () => {
  let server: E2EServer;

  test.beforeEach(async () => {
    server = await startE2EServer();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test("shows reported feed metadata, avatar, details, and metadata-backed exports", async ({ page, request }) => {
    await createFeed(request, server.url);
    await seedEpisode(request, server.url);
    const feedUrl = await publicFeedUrl(request, server.url);

    const metadata = await request.post(`${server.url}/__test/seed-feed-metadata`, {
      data: {
        feed_id: "metadata-bili",
        provider: "bilibili",
        source_url: "https://space.bilibili.com/10835521",
        title: "Metadata Bili Feed",
        description: "Metadata description from NAS",
        image_url: "https://img.example.com/metadata-bili-avatar.jpg",
        link: "https://space.bilibili.com/10835521",
        author: "Metadata Author",
        category: "Technology",
        language: "zh-CN",
        explicit: false,
        last_source_update_at: "2026-07-08T15:00:00Z",
        reported_at: "2026-07-08T15:05:00Z",
      },
    });
    expect(metadata.status()).toBe(200);

    await page.goto(`${server.url}/dashboard/`);
    const row = feedRow(page);
    await expect(row).toBeVisible();
    await expect(row.locator(".feed-avatar img")).toHaveAttribute("src", "https://img.example.com/metadata-bili-avatar.jpg");
    await expect(row.locator(".feed-title-button")).toHaveText("Metadata Bili Feed");
    await expect(row.locator(".activity-cell")).not.toHaveText("-");

    await row.locator(".feed-title-button").click();
    await expect(page.locator("#feed-details-modal")).toBeVisible();
    await expect(page.locator("#feed-details-title")).toHaveText("Metadata Bili Feed");
    await expect(page.locator("#feed-details-subtitle")).toHaveText("metadata-bili");
    await expect(page.locator("#feed-details-body")).toContainText("B 站");
    await expect(page.locator("#feed-details-body")).toContainText("Cookie");
    await expect(page.locator("#feed-details-body")).toContainText("UP 主专属");
    await expect(page.locator("#feed-details-body")).toContainText("https://space.bilibili.com/10835521");
    await expect(page.locator("#feed-details-body")).toContainText(feedUrl);
    await expect(page.locator("#feed-details-body")).toContainText("Metadata description from NAS");
    await expect(page.locator("#feed-details-body")).toContainText("直播");
    await expect(page.locator("#feed-details-footer")).toContainText("最近更新：");
    await expect(page.locator("#feed-details-footer")).not.toHaveText("最近更新：-");

    await expectRssContains(request, feedUrl, "<title>Metadata Bili Feed</title>");
    await expectRssContains(request, feedUrl, "<description>Metadata description from NAS</description>");
    await expectRssContains(request, feedUrl, "<link>https://space.bilibili.com/10835521</link>");
    await expectOpmlContains(request, server.url, "Metadata Bili Feed", feedUrl);
  });
});

function feedRow(page: Page) {
  return page.locator("#feeds-body tr").filter({ hasText: "Metadata Bili Feed" });
}

async function createFeed(request: APIRequestContext, origin: string): Promise<void> {
  const response = await request.post(`${origin}/api/admin/feeds/upsert`, {
    data: {
      feed_id: "metadata-bili",
      provider: "bilibili",
      url: "https://space.bilibili.com/10835521",
      title_override: "Metadata Bili Override",
      description_override: "Override description",
      enabled: true,
      include_in_opml: true,
      private_feed: true,
      update_period: "1h",
      page_size: 25,
      keep_last: 25,
      cookie_profile: "bilibili-main",
      bilibili: { include_upower_exclusive: true },
      filters: {
        title: null,
        not_title: "直播",
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
      feed_id: "metadata-bili",
      provider: "bilibili",
      source_episode_id: "metadata-video",
      local_episode_id: "metadata-video",
      source_url: "https://www.bilibili.com/video/BV1meta",
      title: "Metadata Episode",
      published_at: "2026-07-08T15:00:00Z",
      r2_key: "audio/metadata-bili/metadata-video.mp3",
    },
  });
  expect(response.status()).toBe(200);
}

async function publicFeedUrl(request: APIRequestContext, origin: string): Promise<string> {
  const response = await request.get(`${origin}/api/admin/feeds`);
  expect(response.status()).toBe(200);
  const body = await response.json() as { feeds: Array<{ feed_id: string; public_feed_url: string }> };
  const feed = body.feeds.find((item) => item.feed_id === "metadata-bili");
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

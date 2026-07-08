import { expect, test, type Page } from "@playwright/test";

const onlineBaseURL = process.env.PODSYNC_E2E_ONLINE_BASE_URL;
const accessJWT = process.env.PODSYNC_E2E_CF_ACCESS_JWT;
const accessCookie = process.env.PODSYNC_E2E_COOKIE;

test.describe("dashboard online smoke", () => {
  test.skip(!onlineBaseURL || (!accessJWT && !accessCookie), "Set PODSYNC_E2E_ONLINE_BASE_URL plus PODSYNC_E2E_COOKIE or PODSYNC_E2E_CF_ACCESS_JWT to run the read-only online smoke.");

  test("loads the live dashboard and verifies read-only subscription exports", async ({ page }) => {
    const baseURL = normalizeBaseURL(onlineBaseURL!);
    await configureOnlineAuth(page, baseURL);

    await page.goto(new URL("/dashboard/", baseURL).toString());
    await expect(page.getByRole("heading", { name: "Podsync Dashboard" })).toBeVisible();
    await expect(page.locator("#metric-feeds")).not.toHaveText("-");
    await expect(page.locator("#feeds-body tr").first()).toBeVisible();

    await page.locator("#open-logs").click();
    await expect(page.locator("#logs-modal")).toBeVisible();
    await page.locator("#logs-modal").click({ position: { x: 8, y: 8 } });
    await expect(page.locator("#logs-modal")).toBeHidden();

    const firstRow = page.locator("#feeds-body tr").filter({ has: page.locator(".feed-title-button") }).first();
    const firstTitle = (await firstRow.locator(".feed-title-button").innerText()).trim();
    await firstRow.locator(".feed-title-button").click();
    await expect(page.locator("#feed-details-modal")).toBeVisible();
    await expect(page.locator("#feed-details-title")).toContainText(firstTitle);
    await page.locator("#feed-details-modal").click({ position: { x: 8, y: 8 } });
    await expect(page.locator("#feed-details-modal")).toBeHidden();

    await firstRow.getByRole("button", { name: "查看剧集" }).click();
    await expect(page.locator("#episodes-modal")).toBeVisible();
    await expect(page.locator("#episodes-title")).toHaveText("剧集列表");
    await page.locator("#episodes-modal").click({ position: { x: 8, y: 8 } });
    await expect(page.locator("#episodes-modal")).toBeHidden();

    const subscriptions = await fetchText(page, "/api/admin/subscriptions");
    expect(subscriptions.status, subscriptions.text).toBe(200);
    const body = JSON.parse(subscriptions.text) as {
      feeds: Array<{ title: string; xml_url: string }>;
      opml: Array<{ label: string; xml_url: string }>;
    };
    expect(body.feeds.length).toBeGreaterThan(0);
    expect(body.opml.length).toBeGreaterThan(0);
    const firstOpml = body.opml[0];
    const firstFeed = body.feeds[0];
    if (!firstOpml || !firstFeed) throw new Error("subscription export did not include OPML and feed URLs");

    const opml = await fetchText(page, firstOpml.xml_url);
    expect(opml.status, opml.text).toBe(200);
    expect(opml.text).toContain("<opml");
    expect(opml.text).toContain("<outline");

    const rss = await fetchText(page, firstFeed.xml_url);
    expect(rss.status, rss.text).toBe(200);
    expect(rss.text).toContain("<rss");
    expect(rss.text).toContain("<channel>");
  });
});

function normalizeBaseURL(rawURL: string): URL {
  const url = new URL(rawURL);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

async function configureOnlineAuth(page: Page, baseURL: URL): Promise<void> {
  if (accessJWT) {
    await page.context().setExtraHTTPHeaders({ "cf-access-jwt-assertion": accessJWT });
  }
  if (!accessCookie) return;
  const cookies = accessCookie.split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const splitAt = part.indexOf("=");
      return { name: part.slice(0, splitAt), value: part.slice(splitAt + 1) };
    })
    .filter((cookie) => cookie.name !== "");
  await page.context().addCookies(cookies.map((cookie) => ({
    ...cookie,
    domain: baseURL.hostname,
    path: "/",
    secure: baseURL.protocol === "https:",
    sameSite: "Lax" as const,
  })));
}

async function fetchText(page: Page, url: string): Promise<{ status: number; text: string }> {
  return page.evaluate(async (input) => {
    const response = await fetch(input);
    return { status: response.status, text: await response.text() };
  }, url);
}

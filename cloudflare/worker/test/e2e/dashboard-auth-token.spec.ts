import { expect, test, type Page } from "@playwright/test";
import { startE2EServer, type E2EServer } from "./server";

test.describe("dashboard admin token auth", () => {
  let server: E2EServer;

  test.beforeEach(async () => {
    server = await startE2EServer({ adminToken: "admin-token", injectAccessHeader: false });
  });

  test.afterEach(async () => {
    await server.close();
  });

  test("logs in with ADMIN_TOKEN query, stores a dashboard cookie, and authorizes admin APIs", async ({ page }) => {
    const browserOrigin = server.url.replace("127.0.0.1", "localhost");
    const forbidden = await page.goto(`${browserOrigin}/dashboard/`);
    expect(forbidden?.status()).toBe(403);
    await expect(page.getByText("forbidden")).toBeVisible();

    const wrongToken = await page.goto(`${browserOrigin}/dashboard/?token=wrong`);
    expect(wrongToken?.status()).toBe(403);

    await page.goto(`${browserOrigin}/dashboard/?token=admin-token`);
    await expect(page).toHaveURL(`${browserOrigin}/dashboard/`);
    await expect(page.getByRole("heading", { name: "Podsync Dashboard" })).toBeVisible();

    const cookies = await page.context().cookies(browserOrigin);
    expect(cookies).toContainEqual(expect.objectContaining({
      name: "podsync_admin_token",
      value: "admin-token",
      httpOnly: true,
    }));

    await expectAdminFeedsFetch(page, 200);
  });
});

async function expectAdminFeedsFetch(page: Page, expectedStatus: number): Promise<void> {
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/admin/feeds");
    return response.status;
  });
  expect(status).toBe(expectedStatus);
}

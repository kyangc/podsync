import { expect, test } from "@playwright/test";
import { startE2EServer, type E2EServer } from "./server";

test.describe("dashboard Cloudflare Access auth", () => {
  let server: E2EServer;

  test.beforeEach(async () => {
    server = await startE2EServer();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test("authorizes browser admin calls without changing non-browser routes", async ({ page, request }) => {
    const dashboard = await page.goto(`${server.url}/dashboard/`);
    expect(dashboard?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Podsync Dashboard" })).toBeVisible();

    const adminStatus = await page.evaluate(async () => (await fetch("/api/admin/feeds")).status);
    expect(adminStatus).toBe(200);

    expect((await request.get(`${server.url}/api/nas/config.toml`)).status()).toBe(401);
    expect((await request.get(`${server.url}/health`)).status()).toBe(200);
    expect((await request.get(`${server.url}/f/not-a-real-token.xml`)).status()).toBe(404);
  });
});

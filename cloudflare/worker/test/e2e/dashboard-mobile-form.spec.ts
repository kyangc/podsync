import { expect, test, type Page } from "@playwright/test";
import { startE2EServer, type E2EServer } from "./server";

test.describe("dashboard mobile feed form", () => {
  let server: E2EServer;

  test.beforeEach(async () => {
    server = await startE2EServer();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test("validates, creates, and edits a feed from a mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 820 });
    await page.goto(`${server.url}/dashboard/`);

    await page.getByRole("button", { name: "添加订阅源" }).click();
    await expect(page.locator("#feed-modal")).toBeVisible();
    await page.getByRole("button", { name: "保存变更" }).click();
    await expect(page.locator("#feed-id-error")).toHaveText("请填写订阅源 ID");
    await expect(page.locator("#feed-url-error")).toHaveText("请填写来源 URL");

    await page.locator("#feed-id").fill("mobile-form-feed");
    await page.locator("#feed-url").fill("https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw");
    await page.locator("#feed-title-override").fill("Mobile Form Feed");
    await scrollFeedFormToBottom(page);
    await expect(page.locator("#feed-form-save")).toBeVisible();
    await page.locator("#feed-form-save").click();

    const createdRow = feedRow(page, "Mobile Form Feed");
    await expect(page.locator("#feed-modal")).toBeHidden();
    await expect(createdRow).toBeVisible();
    await expect(createdRow.locator(".mobile-feed-meta")).toContainText("YouTube");
    await expect(createdRow.locator(".mobile-feed-meta")).toContainText("已启用");

    await createdRow.getByRole("button", { name: "编辑订阅源" }).click();
    await expect(page.locator("#feed-form-title")).toHaveText("编辑订阅源");
    await page.locator("#feed-title-override").fill("Mobile Form Feed Edited");
    await scrollFeedFormToBottom(page);
    await page.locator("#feed-form-save").click();

    await expect(page.locator("#feed-modal")).toBeHidden();
    await expect(feedRow(page, "Mobile Form Feed Edited")).toBeVisible();
    await expect(feedRow(page, "Mobile Form Feed")).toHaveCount(0);
  });

  test("keeps feed modal inside narrow viewport and locks page scroll", async ({ page }) => {
    await page.setViewportSize({ width: 370, height: 890 });
    await page.goto(`${server.url}/dashboard/`);

    await page.getByRole("button", { name: "添加订阅源" }).click();
    await expect(page.locator("#feed-modal")).toBeVisible();
    await expect(page.locator("body")).toHaveClass(/modal-open/);
    await expect(page.locator("#feed-form-close")).toHaveText("x");
    await expectModalInsideViewport(page, "#feed-form", 10);
  });
});

function feedRow(page: Page, title: string) {
  return page.locator("#feeds-body tr").filter({ has: page.getByRole("button", { name: title, exact: true }) });
}

async function scrollFeedFormToBottom(page: Page): Promise<void> {
  await page.locator("#feed-form .form-grid").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
}

async function expectModalInsideViewport(page: Page, selector: string, minimumGap: number): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(minimumGap);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width - minimumGap);
}

import { expect, test } from "@playwright/test";

import { sidewaysOverflow, signIn } from "./fixtures.js";

const PAGES = ["/admin", "/admin/users", "/admin/settings", "/admin/profile?u=sam-lee", "/admin/history?u=sam-lee"];

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("no admin page scrolls sideways", async ({ page }) => {
    await signIn(page);
    for (const path of PAGES) {
      await page.goto(path);
      expect(await sidewaysOverflow(page), path).toBeLessThanOrEqual(1);
    }
  });

  test("the recruits table turns into cards", async ({ page }) => {
    await signIn(page);
    await expect(page.locator("table.recruits tr.head")).toBeHidden();
    await expect(page.locator("table.recruits").getByText("Sam Lee", { exact: true })).toBeVisible();
  });

  test("the sign-in and privacy pages fit", async ({ page }) => {
    for (const path of ["/admin", "/privacy"]) {
      await page.goto(path);
      expect(await sidewaysOverflow(page), path).toBeLessThanOrEqual(1);
    }
  });
});

test("on a wide screen the recruits table grows past 900px", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const width = await page.locator("main").evaluate((m) => m.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(900);
  await expect(page.locator("table.recruits tr.head")).toBeVisible();
});

import { expect, test } from "@playwright/test";

import { hermitShellApi, sidewaysOverflow, signIn } from "./fixtures.js";

// Demo mode is one switch for the whole dashboard, so leave it off for the tests that follow.
test.afterEach(async ({ page }) => {
  await page.goto("/admin/settings");
  if (await page.getByRole("button", { name: "Sign in" }).count()) {
    await signIn(page);
    await page.goto("/admin/settings");
  }
  const off = page.getByRole("button", { name: "Turn off demo mode" });
  if (await off.count()) {
    await off.press("Enter");
    await expect(page).toHaveURL(/done=demo_off#demo$/);
  }
});

test("demo mode fills the dashboard with made-up recruits, saves nothing and turns off again", async ({ page, request }) => {
  await signIn(page);
  await page.goto("/admin/settings");
  await expect(page.getByRole("heading", { name: "Demo mode" })).toBeVisible();
  await page.getByRole("button", { name: "Turn on demo mode" }).click();
  await expect(page).toHaveURL(/done=demo_on#demo$/);
  await expect(page.getByText("Demo mode is on: every dashboard page now shows made-up data")).toBeVisible();

  await page.goto("/admin");
  const ribbon = page.locator(".demoribbon");
  await expect(ribbon).toBeVisible();
  await expect(ribbon).toContainText("made-up data, and nothing you press is saved");
  const recruits = page.locator("table.recruits");
  for (const name of ["Jamie Walsh", "Morgan Ellis", "Taylor Reid", "Riley Chen"]) await expect(recruits.getByText(name, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Pause reports for Jamie Walsh" }).click();
  await expect(page).toHaveURL(/done=queued/);
  const queue = await (await hermitShellApi(request, "GET", "/api/queue?full=1")).json();
  expect(queue.items.filter((i) => i.u === "jamie-walsh")).toEqual([]);

  await page.goto("/admin/stats?u=jamie-walsh");
  await expect(page.locator("svg").first()).toBeVisible();
  await page.goto("/admin/history?u=jamie-walsh");
  await expect(page.getByText("Job report ran").first()).toBeVisible();

  await ribbon.getByRole("link", { name: "Turn off" }).click();
  await expect(page).toHaveURL(/\/admin\/settings#demo$/);
  await page.getByRole("button", { name: "Turn off demo mode" }).click();
  await expect(page).toHaveURL(/done=demo_off#demo$/);
  await page.goto("/admin");
  await expect(page.locator(".demoribbon")).toHaveCount(0);
  await expect(page.locator("table.recruits").getByText("Jamie Walsh")).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the demo pages and their ribbon fit the screen", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/settings");
    await page.getByRole("button", { name: "Turn on demo mode" }).press("Enter");
    await expect(page).toHaveURL(/done=demo_on#demo$/);
    for (const path of ["/admin", "/admin/profile?u=jamie-walsh", "/admin/stats?u=avery-lane", "/admin/sent?u=avery-lane&r=30", "/admin/history?u=sam-lee"]) {
      await page.goto(path);
      expect(await sidewaysOverflow(page), path).toBeLessThanOrEqual(1);
      const box = await page.locator(".demoribbon").boundingBox();
      expect(box.x, path).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, path).toBeLessThanOrEqual(390);
    }
  });
});

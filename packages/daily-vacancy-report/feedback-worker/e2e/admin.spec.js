import { expect, test } from "@playwright/test";

import { signIn } from "./fixtures.js";

test("a wrong password is refused and the right one opens the recruits", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin sign-in" })).toBeVisible();
  await signIn(page, "admin", "not-the-password");
  await expect(page.getByText("Wrong username or password.")).toBeVisible();

  await signIn(page);
  await expect(page.getByRole("heading", { name: "Recruits" })).toBeVisible();
  const table = page.locator("table.recruits");
  for (const name of ["Drew Harper", "Sam Lee", "Jordan Patel"]) await expect(table.getByText(name, { exact: true })).toBeVisible();
  await expect(table.getByText("Alex Morgan", { exact: true })).toHaveCount(0);
  await expect(page.locator("nav.tabs a")).toHaveText(["Recruits", "Desk", "Users and roles", "Global settings"]);
});

test("the search box narrows the recruits", async ({ page }) => {
  await signIn(page);
  await page.locator("label.searchbtn").click();
  await page.getByRole("searchbox", { name: "Search recruits" }).fill("york");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/[?&]q=york/);
  const table = page.locator("table.recruits");
  await expect(table.getByText("Sam Lee", { exact: true })).toBeVisible();
  await expect(table.getByText("Jordan Patel", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Clear the search" }).click();
  await expect(table.getByText("Jordan Patel", { exact: true })).toBeVisible();
});

test("the status dropdown beside the search lists only recruits with that status, with the words too", async ({ page }) => {
  await signIn(page);
  const status = page.getByRole("combobox", { name: "Status" });
  await expect(status).toHaveCSS("opacity", "0");
  await page.locator("label.searchbtn").click();
  await expect(status).toHaveCSS("opacity", "1");
  await status.selectOption("paused");
  await expect(page).toHaveURL(/[?&]s=paused/);
  const table = page.locator("table.recruits");
  await expect(table.getByText("Jordan Patel", { exact: true })).toBeVisible();
  await expect(table.getByText("Sam Lee", { exact: true })).toHaveCount(0);
  await expect(page.locator(".tabletools .count")).toHaveText("1 of 3 recruits");
  await expect(status).toHaveValue("paused");
  await expect(status).toBeVisible();

  await status.selectOption("active");
  await expect(page).toHaveURL(/[?&]s=active/);
  await page.getByRole("searchbox", { name: "Search recruits" }).fill("york");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/s=active&q=york/);
  await expect(table.getByText("Sam Lee", { exact: true })).toBeVisible();
  await expect(table.getByText("Drew Harper", { exact: true })).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search recruits" }).fill("paused");
  await page.keyboard.press("Enter");
  await expect(page.getByText("No recruit matches “paused” and active")).toBeVisible();
  await page.getByRole("link", { name: "Clear the search" }).click();
  await expect(table.getByText("Jordan Patel", { exact: true })).toBeVisible();
  await expect(status).toHaveValue("");
});

test("on a phone the opened search and its status dropdown stay inside the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/admin?s=active");
  const status = page.getByRole("combobox", { name: "Status" });
  await expect(status).toHaveCSS("width", "118px");
  const card = await page.locator("main").boundingBox();
  for (const el of [page.locator("a.tasksbtn"), status, page.getByRole("searchbox", { name: "Search recruits" }), page.locator("label.searchbtn")]) {
    const box = await el.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(card.x);
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
  }
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("Show appears once another status is picked and lists them", async ({ page }) => {
    await signIn(page);
    await page.locator("label.searchbtn").click();
    const show = page.locator("form.search .sgo");
    const status = page.getByRole("combobox", { name: "Status" });
    await expect(show).toBeHidden();
    await expect(status).toHaveCSS("width", "156px");
    await status.selectOption("paused");
    await expect(show).toBeVisible();
    await show.click();
    await expect(page).toHaveURL(/[?&]s=paused/);
    await expect(page.locator("table.recruits").getByText("Sam Lee", { exact: true })).toHaveCount(0);
    await expect(show).toBeHidden();
  });
});

test("the dashboard tabs open Users and roles and Global settings", async ({ page }) => {
  await signIn(page);
  await page.locator("nav.tabs").getByRole("link", { name: "Users and roles" }).click();
  await expect(page.getByRole("heading", { name: "Users and roles" })).toBeVisible();
  await page.locator("nav.tabs").getByRole("link", { name: "Global settings" }).click();
  await expect(page.getByRole("heading", { name: "Global settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save email server" })).toBeVisible();
});

test("signing out closes every admin page", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Admin sign-in" })).toBeVisible();
  for (const path of ["/admin", "/admin/users", "/admin/settings", "/admin/profile?u=sam-lee", "/admin/history?u=sam-lee"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Admin sign-in" })).toBeVisible();
    await expect(page.getByText("Sam Lee")).toHaveCount(0);
  }
});

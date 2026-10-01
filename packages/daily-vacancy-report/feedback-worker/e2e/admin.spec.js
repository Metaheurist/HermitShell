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

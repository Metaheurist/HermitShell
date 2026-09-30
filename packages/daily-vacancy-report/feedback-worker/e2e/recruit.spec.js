import { expect, test } from "@playwright/test";

import { signIn } from "./fixtures.js";

test.describe.configure({ mode: "serial" });

test("a recruit's page has Manage and History tabs, not the dashboard's", async ({ page }) => {
  await signIn(page);
  await page.locator("table.recruits tr", { hasText: "Sam Lee" }).getByRole("link", { name: "Manage" }).click();
  await expect(page.getByRole("heading", { name: "Sam Lee" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Recruit pages" }).getByRole("link")).toHaveText(["Manage", "History"]);
  await expect(page.getByRole("link", { name: "Global settings" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Users and roles" })).toHaveCount(0);
  await page.getByRole("link", { name: "Back to recruits" }).click();
  await expect(page.getByRole("heading", { name: "Recruits" })).toBeVisible();
});

test("a saved change stays in the form and shows on the History tab", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/profile?u=sam-lee");
  const titles = page.getByLabel("Job titles");
  await titles.fill(`${await titles.inputValue()}\nData Platform Engineer`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByLabel("Job titles")).toHaveValue(/Data Platform Engineer/);

  await page.getByRole("navigation", { name: "Recruit pages" }).getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/\/admin\/history\?u=sam-lee/);
  await expect(page.getByText("Changed Job titles")).toBeVisible();
  await expect(page.getByText("by Alex Morgan").first()).toBeVisible();
});

test("Send jobs now and pausing are recorded, newest first", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/profile?u=sam-lee");
  await page.getByRole("button", { name: "Send jobs now" }).click();
  await page.goto("/admin");
  await page.getByRole("button", { name: "Pause reports for Sam Lee" }).click();
  await page.goto("/admin/history?u=sam-lee");
  const entries = page.locator("li.hev b");
  await expect(entries.nth(0)).toHaveText("Paused reports");
  await expect(entries.nth(1)).toHaveText("Asked for jobs now");
  await expect(page.getByText(/^Joined HermitShell on \d{4}-\d{2}-\d{2}\.$/)).toBeVisible();
});

test("the history of someone who isn't a recruit is not found", async ({ page }) => {
  await signIn(page);
  const res = await page.goto("/admin/history?u=nobody-here");
  expect(res.status()).toBe(404);
});

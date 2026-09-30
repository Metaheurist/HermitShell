import { expect, test } from "@playwright/test";

import { RECRUITER, hermitShellStatus, reportStatus, signIn } from "./fixtures.js";

test.describe.configure({ mode: "serial" });

test("an admin adds a recruiter from the Add user window", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/users");
  await page.getByRole("link", { name: "Add user" }).click();
  const modal = page.locator("#user-new");
  await expect(modal).toBeVisible();
  await modal.getByLabel("Name", { exact: true }).fill(RECRUITER.name);
  await modal.getByLabel("Username", { exact: true }).fill(RECRUITER.username);
  await modal.getByLabel("Password", { exact: true }).fill(RECRUITER.password);
  await expect(modal.getByRole("checkbox", { name: "Recruiter" })).toBeChecked();
  await modal.getByRole("button", { name: "Add user" }).click();
  await expect(page.locator("table.list").getByText(RECRUITER.name, { exact: true })).toBeVisible();
});

test("assigning a recruit to them is recorded in the recruit's history", async ({ page }) => {
  await signIn(page);
  await page.getByLabel("Recruiter for Sam Lee").selectOption({ label: RECRUITER.name });
  await page.locator("table.recruits tr", { hasText: "Sam Lee" }).getByRole("button", { name: "Assign" }).click();
  await page.goto("/admin/history?u=sam-lee");
  await expect(page.getByText(`Assigned to ${RECRUITER.name}`)).toBeVisible();
});

test("a recruiter sees only their own recruits and no admin pages", async ({ browser, request }) => {
  // HermitShell applies the assignment and reports it back.
  await reportStatus(request, hermitShellStatus({ samRecruiter: RECRUITER.username }));
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, RECRUITER.username, RECRUITER.password);
  await expect(page.getByRole("heading", { name: "Recruits" })).toBeVisible();
  await expect(page.locator("nav.tabs a")).toHaveText(["Recruits"]);
  await expect(page.locator(".srv")).toHaveCount(0);
  const table = page.locator("table.recruits");
  await expect(table.getByText("Sam Lee", { exact: true })).toBeVisible();
  await expect(table.getByText("Jordan Patel", { exact: true })).toHaveCount(0);
  await expect(table.getByText("Alex Morgan", { exact: true })).toHaveCount(0);

  for (const path of ["/admin/users", "/admin/settings"]) {
    const res = await page.goto(path);
    expect(res.status(), path).toBe(403);
    await expect(page.getByRole("heading", { name: "Admins only" })).toBeVisible();
  }
  expect((await page.goto("/admin/history?u=jordan-patel")).status()).toBe(404);
  expect((await page.goto("/admin/profile?u=jordan-patel")).status()).toBe(404);

  await page.goto("/admin/history?u=sam-lee");
  await expect(page.getByText(`Assigned to ${RECRUITER.name}`)).toBeVisible();
  await context.close();
});

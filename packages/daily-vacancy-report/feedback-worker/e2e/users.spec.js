import { expect, test } from "@playwright/test";

import { RECRUITER, hermitShellApi, hermitShellStatus, reportStatus, signIn } from "./fixtures.js";

const MANAGER = { name: "Morgan Ellis", username: "morgan", password: "e2e-manager-password" };

test.describe.configure({ mode: "serial" });

const line = (n, fees = {}) => ({ sent: n * 4, applied: n * 2, interview: n, offer: n, placed: n, fees });
const ranges = (n, fees) => Object.fromEntries(["7", "30", "90", "365"].map((r) => [r, line(n, fees)]));

async function sendDesk(request) {
  const desk = { v: 1, recruits: { "sam-lee": ranges(1, { GBP: 4500 }), "jordan-patel": ranges(2), "drew-harper": ranges(0) },
    salaries: [{ title: "Data Engineer", n: 4, median: 52000, currency: "GBP" }] };
  expect((await hermitShellApi(request, "POST", "/api/desk", { desk })).ok()).toBe(true);
}

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
  await expect(page.locator("nav.tabs a")).toHaveText(["Recruits", "Desk"]);
  await expect(page.locator(".srv")).toHaveCount(0);
  const table = page.locator("table.recruits");
  await expect(table.getByText("Sam Lee", { exact: true })).toBeVisible();
  await expect(table.getByText("Jordan Patel", { exact: true })).toHaveCount(0);
  await expect(table.getByText("Alex Morgan", { exact: true })).toHaveCount(0);

  for (const [path, heading] of [["/admin/users", "Admins and managers only"], ["/admin/settings", "Admins only"]]) {
    const res = await page.goto(path);
    expect(res.status(), path).toBe(403);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  expect((await page.goto("/admin/history?u=jordan-patel")).status()).toBe(404);
  expect((await page.goto("/admin/profile?u=jordan-patel")).status()).toBe(404);

  await page.goto("/admin/history?u=sam-lee");
  await expect(page.getByText(`Assigned to ${RECRUITER.name}`)).toBeVisible();

  await sendDesk(request);
  await page.goto("/admin");
  await page.locator("nav.tabs").getByRole("link", { name: "Desk" }).click();
  await expect(page.getByRole("heading", { name: "Desk", exact: true })).toBeVisible();
  const desk = page.locator("table.desk");
  await expect(desk.getByRole("link", { name: "Sam Lee" })).toBeVisible();
  await expect(desk.getByText("Jordan Patel")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Fees" })).toHaveCount(0);
  expect(await page.content()).not.toContain("4,500");
  await context.close();
});

test("an admin's desk shows every recruiter's recruits and the fees from placements", async ({ page, request }) => {
  await reportStatus(request, hermitShellStatus({ samRecruiter: RECRUITER.username }));
  await sendDesk(request);
  await signIn(page);
  await page.goto("/admin/desk?r=30");
  const riley = page.locator("section.deskgroup", { hasText: RECRUITER.name });
  await expect(riley.getByRole("link", { name: "Sam Lee" })).toBeVisible();
  await expect(riley.locator("tfoot")).toContainText("\u00a34,500");
  await expect(page.locator("section.deskgroup", { hasText: "No recruiter" }).getByRole("link", { name: "Jordan Patel" })).toBeVisible();
  await expect(page.getByText("Data Engineer")).toBeVisible();
});

test("a manager looks after their team's recruits and fees, and nothing else", async ({ browser, page, request }) => {
  await reportStatus(request, hermitShellStatus({ samRecruiter: RECRUITER.username }));
  await sendDesk(request);
  await signIn(page);
  await page.goto("/admin/users");
  await page.getByRole("link", { name: "Add user" }).click();
  const add = page.locator("#user-new");
  await add.getByLabel("Name", { exact: true }).fill(MANAGER.name);
  await add.getByLabel("Username", { exact: true }).fill(MANAGER.username);
  await add.getByLabel("Password", { exact: true }).fill(MANAGER.password);
  await add.getByRole("checkbox", { name: "Recruiter" }).uncheck();
  await add.getByRole("checkbox", { name: "Manager" }).check();
  await add.getByRole("button", { name: "Add user" }).click();
  await page.getByRole("link", { name: `Edit ${RECRUITER.name}` }).click();
  const edit = page.locator(`#user-${RECRUITER.username}`);
  await edit.getByRole("combobox", { name: "Manager" }).selectOption({ label: `${MANAGER.name}'s team` });
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(`in ${MANAGER.name}'s team`)).toBeVisible();

  const context = await browser.newContext();
  const theirs = await context.newPage();
  await signIn(theirs, MANAGER.username, MANAGER.password);
  await expect(theirs.locator("nav.tabs a")).toHaveText(["Recruits", "Desk", "Your team"]);
  const table = theirs.locator("table.recruits");
  await expect(table.getByText("Sam Lee", { exact: true })).toBeVisible();
  await expect(table.getByText("Jordan Patel", { exact: true })).toHaveCount(0);
  await expect(theirs.getByLabel("Recruiter for Sam Lee")).toHaveValue(RECRUITER.username);
  await theirs.goto("/admin/desk?r=30");
  await expect(theirs.locator("section.deskgroup", { hasText: RECRUITER.name }).locator("tfoot")).toContainText("\u00a34,500");
  await expect(theirs.getByText("Jordan Patel")).toHaveCount(0);
  await theirs.goto("/admin/users");
  await expect(theirs.getByRole("heading", { name: "You and your team" })).toBeVisible();
  await expect(theirs.locator("table.list").getByText(RECRUITER.name, { exact: true })).toBeVisible();
  expect((await theirs.goto("/admin/settings")).status()).toBe(403);
  expect((await theirs.goto("/admin/profile?u=jordan-patel")).status()).toBe(404);
  await context.close();
});

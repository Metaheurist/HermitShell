import { expect, test } from "@playwright/test";

import { emailLink, hermitShellApi, hermitShellStatus, reportStatus, signIn } from "./fixtures.js";

const DAY = 86400000;

function withSamRetired(extra = {}) {
  const status = hermitShellStatus();
  const now = Date.now();
  status.profiles = status.profiles.map((p) => (p.id === "sam-lee"
    ? { ...p, status: "retired", retired: now - 2 * DAY, keep_until: now + 180 * DAY, keep_months: 0, ...extra } : p));
  return status;
}

async function queued(request) {
  return (await (await hermitShellApi(request, "GET", "/api/queue?full=1")).json()).items;
}

async function clearQueue(request) {
  const items = await queued(request);
  if (items.length) await hermitShellApi(request, "POST", "/api/queue/ack", { ids: items.map((i) => i.id) });
}

test.beforeEach(async ({ request }) => clearQueue(request));

test.afterEach(async ({ request }) => {
  await clearQueue(request);
  await reportStatus(request);
});

test("the red Retire button on the bulk bar asks first, then retires the ticked recruits", async ({ page, request }) => {
  await reportStatus(request);
  await signIn(page);
  await page.getByLabel("Tick Sam Lee").check();
  await page.getByLabel("Tick Drew Harper").check();
  await page.locator("form#bulk").getByRole("link", { name: "Retire" }).click();
  const modal = page.locator("#bulk-retire");
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("heading", { name: "Retire the ticked recruits?" })).toBeVisible();
  const button = modal.getByRole("button", { name: "Retire" });
  await expect(button).toHaveCSS("pointer-events", "none");
  await modal.getByRole("checkbox").check();
  await expect(button).not.toHaveCSS("pointer-events", "none");
  await button.click();
  await expect(page).toHaveURL(/done=bulk&n=2&m=0$/);
  expect((await queued(request)).map((i) => [i.op, [...i.us].sort()])).toEqual([["retire", ["drew-harper", "sam-lee"]]]);
});

test("a recruit's page ends with Retire, which asks first and comes back to the page", async ({ page, request }) => {
  await reportStatus(request);
  await signIn(page);
  await page.goto("/admin/profile?u=sam-lee");
  await expect(page.getByRole("heading", { name: "Retire", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Retire Sam Lee" }).click();
  const modal = page.locator("#retire-sam-lee");
  await expect(modal).toBeVisible();
  await modal.getByRole("checkbox").check();
  await modal.getByRole("button", { name: "Retire" }).click();
  await expect(page).toHaveURL(/\/admin\/profile\?u=sam-lee&done=retiring$/);
  expect((await queued(request)).map((i) => [i.action, i.u])).toEqual([["retire", "sam-lee"]]);
});

test("retired recruits are hidden from the list until asked for, and Reactivate brings them back", async ({ page, request }) => {
  await reportStatus(request, withSamRetired());
  await signIn(page);
  await expect(page.getByLabel("Tick Sam Lee")).toHaveCount(0);
  await page.getByRole("link", { name: "1 retired" }).click();
  await expect(page).toHaveURL(/s=retired/);
  await expect(page.getByLabel("Tick Sam Lee")).toBeVisible();
  await page.goto("/admin/profile?u=sam-lee");
  await expect(page.getByRole("heading", { name: "Retired", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reactivate" }).click();
  await expect(page).toHaveURL(/\/admin\/profile\?u=sam-lee&done=reactivating$/);
  expect((await queued(request)).map((i) => [i.action, i.u])).toEqual([["resume", "sam-lee"]]);
});

test("the retired recruit's email link lets them keep their profile for a while or delete it", async ({ page, request }) => {
  await reportStatus(request, withSamRetired());
  await page.goto(await emailLink("retire", "Sam Lee", { job: "profile", profile: "sam-lee" }));
  await expect(page.getByRole("heading", { name: "Keep or delete your data" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Keep it for 6 months/ })).toBeChecked();
  await page.getByRole("radio", { name: /Keep it for 12 months/ }).check();
  await page.getByRole("button", { name: "Confirm my choice" }).click();
  await expect(page.getByText("keeps your profile for 12 months")).toBeVisible();
  expect((await queued(request)).map((i) => [i.type, i.u, i.keep])).toEqual([["retire_choice", "sam-lee", 12]]);
});

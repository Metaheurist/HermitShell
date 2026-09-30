import { expect, test } from "@playwright/test";

import { LINK_DAYS, today } from "../src/lib.js";
import { JOB_TITLE, emailLink, signIn } from "./fixtures.js";

test("an old email button of the admin's asks first, saves once and shows in the history of the recruit it moved to, without the note", async ({ page }) => {
  await page.goto(await emailLink("interested", JOB_TITLE));
  await expect(page.getByText(JOB_TITLE)).toBeVisible();
  await expect(page.getByText("Nothing is saved until you press Confirm.")).toBeVisible();
  await page.getByLabel("Note for HermitShell (optional)").fill("Hybrid suits me");
  await page.getByRole("button", { name: /^Confirm:/ }).click();
  await expect(page.getByRole("heading", { name: "Saved" })).toBeVisible();

  // Pressing Confirm a second time with the same answer is not a second entry.
  await page.goBack();
  await page.getByLabel("Note for HermitShell (optional)").fill("Hybrid suits me");
  await page.getByRole("button", { name: /^Confirm:/ }).click();
  await expect(page.getByRole("heading", { name: "Saved" })).toBeVisible();

  await signIn(page);
  expect((await page.goto("/admin/history?u=owner")).status()).toBe(404);
  await page.goto("/admin/history?u=drew-harper");
  await expect(page.getByText(`Answered Interested: ${JOB_TITLE}`)).toHaveCount(1);
  await expect(page.getByText("from an email button").first()).toBeVisible();
  await expect(page.getByText("Hybrid suits me")).toHaveCount(0);
});

test("a changed link is refused", async ({ page }) => {
  const url = new URL(await emailLink("applied", JOB_TITLE), "http://x");
  url.searchParams.set("n", "Head of Data at Northwind Traders");
  const res = await page.goto(url.pathname + url.search);
  expect(res.status()).toBe(403);
  await expect(page.getByRole("heading", { name: "Link not valid" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Confirm:/ })).toHaveCount(0);
});

test("a link older than the button lifetime is refused", async ({ page }) => {
  const res = await page.goto(await emailLink("applied", JOB_TITLE, { day: today() - LINK_DAYS - 1 }));
  expect(res.status()).toBe(410);
  await expect(page.getByRole("heading", { name: "Link expired" })).toBeVisible();
});

test("the privacy notice is public", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "How your data is handled" })).toBeVisible();
  for (const heading of ["What is kept", "How long", "Deleting your data"]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
});

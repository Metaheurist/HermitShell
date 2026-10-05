// @recruiter: Riley Chen looks after Sam Lee and Jordan Patel: sets where they want to work, tags and notes Sam, and
// presses Send jobs now, which runs a real search (Firecrawl, capped by JOB_SCANNER_MAX_SCRAPE) rated by the local model.

import { expect, test } from "@playwright/test";

import { closeAll } from "../lib/actors.js";
import { note, step } from "../lib/findings.js";
import { RECRUITS, admin, emailShowing, recruitId, recruiter } from "./shared.js";

test.afterAll(closeAll);

async function setSearch(r, id, person) {
  const { page } = r;
  await page.goto(`/admin/profile?u=${id}`);
  await r.say(`${person.name}: jobs around ${person.region}, in the United Kingdom`);
  await r.fill(page.getByLabel("Region or city"), person.region);
  await page.getByLabel("Country").selectOption("gb");
  await r.fill(page.getByLabel("Towns"), person.towns);
  await r.click(page.getByRole("button", { name: "Save changes" }));
  await expect(page).toHaveURL(/done=saved/);
  await expect(page.getByLabel("Region or city")).toHaveValue(person.region);
}

test("@recruiter Riley looks after their recruits", async () => {
  const a = await admin();
  const ids = {};
  for (const [key, person] of Object.entries(RECRUITS)) ids[key] = await recruitId(a, person.name);

  const r = await recruiter();
  const { page } = r;
  await step("recruiter", "Riley sees only their own recruits", page, async () => {
    await page.goto("/admin");
    const table = page.locator("table.recruits");
    await expect(table.getByText(RECRUITS.sam.name, { exact: true })).toBeVisible();
    await expect(table.getByText(RECRUITS.jordan.name, { exact: true })).toBeVisible();
    await expect(table.getByText(RECRUITS.taylor.name, { exact: true })).toHaveCount(0);
    expect((await page.goto(`/admin/profile?u=${ids.taylor}`)).status()).toBe(404);
  });

  await step("recruiter", "Sam's and Jordan's searches are set", page, async () => {
    await setSearch(r, ids.sam, RECRUITS.sam);
    await setSearch(r, ids.jordan, RECRUITS.jordan);
  });

  await step("recruiter", "Sam is tagged and noted", page, async () => {
    await page.goto(`/admin/profile?u=${ids.sam}`);
    await r.say("tagging Sam and adding a note");
    await r.fill(page.getByLabel("Tags"), "shortlist, walkthrough");
    await r.click(page.getByRole("button", { name: "Save tags" }));
    await expect(page.getByText("Tags saved.")).toBeVisible();
    await r.fill(page.getByLabel("Add a note"), "Prefers hybrid roles near York");
    await r.click(page.getByRole("button", { name: "Add note" }));
    await expect(page.locator(".notelist li").first()).toContainText("Prefers hybrid roles near York");
  });

  const since = Date.now();
  await step("recruiter", "Send jobs now brings Sam a report", page, async () => {
    await page.goto(`/admin/profile?u=${ids.sam}`);
    await r.click(page.getByRole("button", { name: "Send jobs now" }));
    const msg = await emailShowing(r, "HermitShell searches the web and rates each advert for Sam",
      { to: RECRUITS.sam.email, subject: "jobs", since }, { timeout: 1800000 });
    await note("recruiter", `Sam's report: ${msg.Subject}`);
  });

  await step("recruiter", "the history shows who did what", page, async () => {
    await page.goto(`/admin/history?u=${ids.sam}`);
    await expect(page.getByText("Asked for jobs now").first()).toBeVisible();
    await expect(page.getByText("Added a note").first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Prefers hybrid roles");
  });
});

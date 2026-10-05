// @retire: the admin retires Taylor Reid, who is emailed a link to keep their data for a while or delete it; Taylor
// keeps it for 12 months. Taylor is then hidden from the list until asked for, and Reactivate brings them back.

import { expect, test } from "@playwright/test";

import { actor, closeAll } from "../lib/actors.js";
import { step } from "../lib/findings.js";
import { link } from "../lib/mailpit.js";
import { waitShowing } from "../lib/show.js";
import { RECRUITS, admin, emailShowing, recruitId } from "./shared.js";

test.afterAll(closeAll);

test("@retire Taylor is retired, keeps their data, and comes back", async () => {
  const taylor = RECRUITS.taylor;
  const a = await admin();
  const { page } = a;
  const id = await recruitId(a, taylor.name);
  const since = Date.now();

  await step("retire", "Retire asks first, then retires", page, async () => {
    await page.goto(`/admin/profile?u=${id}`);
    await a.say(`retiring ${taylor.name}`);
    await a.click(page.getByRole("link", { name: `Retire ${taylor.name}` }));
    const modal = page.locator(`#retire-${id}`);
    await expect(modal).toBeVisible();
    await modal.getByRole("checkbox").check();
    await a.click(modal.getByRole("button", { name: "Retire" }));
    await expect(page).toHaveURL(/done=retiring/);
  });

  const t = await actor("Recruit", { key: "recruit-taylor" });
  await step("retire", "Taylor chooses to keep their data for 12 months", t.page, async () => {
    const msg = await emailShowing(t, "waiting for Taylor's keep-or-delete email", { to: taylor.email, since }, { timeout: 600000 });
    await t.page.goto(link(msg, /keep|choose|data/i));
    await expect(t.page.getByRole("heading", { name: "Keep or delete your data" })).toBeVisible();
    await t.click(t.page.getByRole("radio", { name: /Keep it for 12 months/ }));
    await t.click(t.page.getByRole("button", { name: "Confirm my choice" }));
    await expect(t.page.getByText("keeps your profile for 12 months")).toBeVisible();
  });

  await step("retire", "Taylor is hidden from the list until asked for", page, async () => {
    await waitShowing(page, "Admin", "waiting for HermitShell to report the retirement", async () => {
      await page.goto("/admin");
      return (await page.getByLabel(`Tick ${taylor.name}`).count()) === 0;
    }, { timeout: 300000, every: 10000 });
    await a.click(page.getByRole("link", { name: /\d+ retired/ }));
    await expect(page.getByLabel(`Tick ${taylor.name}`)).toBeVisible();
  });

  await step("retire", "Reactivate brings Taylor back", page, async () => {
    await page.goto(`/admin/profile?u=${id}`);
    await a.click(page.getByRole("button", { name: "Reactivate" }));
    await expect(page).toHaveURL(/done=reactivating/);
    await waitShowing(page, "Admin", "waiting for HermitShell to reactivate Taylor", async () => {
      await page.goto("/admin");
      return (await page.getByLabel(`Tick ${taylor.name}`).count()) > 0;
    }, { timeout: 300000, every: 10000 });
  });
});

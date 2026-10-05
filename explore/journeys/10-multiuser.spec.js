// @multiuser: the admin, the manager and the recruiter work at once in their own windows. Each sees what their role
// allows; a change one makes shows for the others; and no one reaches another person's recruit or pages.

import { expect, test } from "@playwright/test";

import { closeAll } from "../lib/actors.js";
import { step } from "../lib/findings.js";
import { RECRUITER, RECRUITS, admin, manager, recruitId, recruiter } from "./shared.js";

test.afterAll(closeAll);

test("@multiuser three staff at once", async () => {
  const [a, m, r] = [await admin(), await manager(), await recruiter()];
  const ids = {};
  for (const [key, person] of Object.entries(RECRUITS)) ids[key] = await recruitId(a, person.name);

  await step("multiuser", "each role sees the right recruits", a.page, async () => {
    await Promise.all([a.page.goto("/admin"), m.page.goto("/admin"), r.page.goto("/admin")]);
    await Promise.all([a.say("sees everyone"), m.say("sees their team's recruits"), r.say("sees their own recruits")]);
    for (const person of Object.values(RECRUITS)) await expect(a.page.locator("table.recruits").getByText(person.name, { exact: true })).toBeVisible();
    await expect(m.page.locator("table.recruits").getByText(RECRUITS.sam.name, { exact: true })).toBeVisible();
    await expect(m.page.locator("table.recruits").getByText(RECRUITS.taylor.name, { exact: true })).toHaveCount(0);
    await expect(r.page.locator("table.recruits").getByText(RECRUITS.taylor.name, { exact: true })).toHaveCount(0);
  });

  await step("multiuser", "the admin hands Taylor to Riley and Riley sees them", a.page, async () => {
    await a.say(`assigning ${RECRUITS.taylor.name} to ${RECRUITER.name}`);
    await a.page.getByLabel(`Recruiter for ${RECRUITS.taylor.name}`).selectOption({ label: RECRUITER.name });
    await a.click(a.page.locator("table.recruits tr", { hasText: RECRUITS.taylor.name }).getByRole("button", { name: "Assign" }));
    await expect.poll(async () => {
      await r.page.goto("/admin");
      return r.page.locator("table.recruits").getByText(RECRUITS.taylor.name, { exact: true }).count();
    }, { timeout: 300000, intervals: [5000] }).toBeGreaterThan(0);
    await r.say(`now looks after ${RECRUITS.taylor.name} too`);
  });

  await step("multiuser", "a note Riley adds is seen by the manager, not by HermitShell's history text", r.page, async () => {
    await r.page.goto(`/admin/profile?u=${ids.jordan}`);
    await r.fill(r.page.getByLabel("Add a note"), "Has a notice period of one month");
    await r.click(r.page.getByRole("button", { name: "Add note" }));
    await m.page.goto(`/admin/profile?u=${ids.jordan}`);
    await expect(m.page.locator(".notelist")).toContainText("Has a notice period of one month");
    await m.page.goto(`/admin/history?u=${ids.jordan}`);
    await expect(m.page.locator("body")).not.toContainText("notice period");
  });

  await step("multiuser", "staff pages stay closed to the wrong roles", r.page, async () => {
    for (const path of ["/admin/settings", "/admin/users", "/admin/theme"]) expect((await r.page.goto(path)).status(), path).toBe(403);
    expect((await m.page.goto("/admin/settings")).status()).toBe(403);
  });

  await step("multiuser", "the admin takes Taylor back", a.page, async () => {
    await a.page.goto("/admin");
    await a.page.getByLabel(`Recruiter for ${RECRUITS.taylor.name}`).selectOption({ index: 0 });
    await a.click(a.page.locator("table.recruits tr", { hasText: RECRUITS.taylor.name }).getByRole("button", { name: "Assign" }));
  });
});

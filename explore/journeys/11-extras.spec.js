// @extras: the demo image's extra people, run only when asked for (--only extras): Casey Quinn joins Morgan's team as
// a second recruiter, Drew Harper joins Casey's pool and Avery Lane nobody's, both from pasted CVs.

import { expect, test } from "@playwright/test";

import { closeAll } from "../lib/actors.js";
import { step } from "../lib/findings.js";
import { EXTRA_RECRUITER, EXTRA_RECRUITS, MANAGER, addUser, admin, emailShowing, invite, join_ } from "./shared.js";

test.afterAll(closeAll);

test("@extras a second recruiter and two more recruits join", async () => {
  const a = await admin();
  const { page } = a;
  await step("extras", `${EXTRA_RECRUITER.name} is added to ${MANAGER.name}'s team`, page, async () => {
    await addUser(a, EXTRA_RECRUITER);
    await page.goto("/admin/users");
    const edit = page.locator(`#user-${EXTRA_RECRUITER.username}`);
    await a.click(page.getByRole("link", { name: `Edit ${EXTRA_RECRUITER.name}` }));
    await edit.getByRole("combobox", { name: "Manager" }).selectOption({ label: `${MANAGER.name}'s team` });
    await a.click(edit.getByRole("button", { name: "Save changes" }));
    await expect(page.locator("table.list tr", { hasText: EXTRA_RECRUITER.name })).toContainText(`${MANAGER.name}'s team`);
  });

  const since = Date.now();
  for (const [key, person] of Object.entries(EXTRA_RECRUITS)) {
    const pool = key === "drew" ? EXTRA_RECRUITER.name : "";
    const link = await step("extras", `an invite link is made for ${person.name}`, page, () => invite(a, person, pool));
    const r = await step("extras", `${person.name} joins`, null, () => join_(person, link));
    await step("extras", `${person.name}'s profile is built`, r.page, () =>
      emailShowing(r, `HermitShell reads ${person.name}'s CV`, { to: person.email, subject: "profile is ready", since }, { timeout: 900000 }));
  }
});

// @team: the admin adds a recruiter (Riley Chen) and a manager (Morgan Ellis), and puts Riley in Morgan's team. Their
// passwords are made up for this run and kept in the run state, never in the repo.

import { expect, test } from "@playwright/test";

import { closeAll } from "../lib/actors.js";
import { step } from "../lib/findings.js";
import { MANAGER, RECRUITER, addUser, admin, manager, recruiter } from "./shared.js";

test.afterAll(closeAll);

test("@team the admin builds a team", async () => {
  const a = await admin();
  const { page } = a;
  await step("team", "a manager is added", page, () => addUser(a, MANAGER, { asManager: true }));
  await step("team", "a recruiter is added", page, () => addUser(a, RECRUITER));
  await step("team", "the recruiter joins the manager's team", page, async () => {
    await page.goto("/admin/users");
    if (await page.getByText(`in ${MANAGER.name}'s team`).isVisible().catch(() => false)) return;
    await a.say(`putting ${RECRUITER.name} in ${MANAGER.name}'s team`);
    await a.click(page.getByRole("link", { name: `Edit ${RECRUITER.name}` }));
    const edit = page.locator(`#user-${RECRUITER.username}`);
    await edit.getByRole("combobox", { name: "Manager" }).selectOption({ label: `${MANAGER.name}'s team` });
    await a.click(edit.getByRole("button", { name: "Save changes" }));
    await expect(page.getByText(`in ${MANAGER.name}'s team`)).toBeVisible();
  });

  const r = await recruiter();
  await step("team", "the recruiter signs in and sees only recruiter pages", r.page, async () => {
    await r.say("signed in: only Recruits and Desk");
    await expect(r.page.locator("nav.tabs a")).toHaveText(["Recruits", "Desk"]);
    expect((await r.page.goto("/admin/settings")).status()).toBe(403);
    expect((await r.page.goto("/admin/users")).status()).toBe(403);
    await r.page.goto("/admin");
  });

  const m = await manager();
  await step("team", "the manager signs in and sees their team", m.page, async () => {
    await m.say("signed in: Recruits, Desk and Your team");
    await expect(m.page.locator("nav.tabs a")).toHaveText(["Recruits", "Desk", "Your team"]);
    await m.page.goto("/admin/users");
    await expect(m.page.locator("table.list").getByText(RECRUITER.name, { exact: true })).toBeVisible();
    expect((await m.page.goto("/admin/settings")).status()).toBe(403);
  });
});

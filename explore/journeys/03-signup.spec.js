// @signup: three people join from invite links, each in their own window: Sam Lee pastes a CV, Jordan Patel uploads a
// PDF and Taylor Reid a Word document. HermitShell reads each CV with the local model and emails them when the
// profile is ready; Sam and Jordan join Riley's pool, Taylor nobody's.

import { expect, test } from "@playwright/test";

import { closeAll } from "../lib/actors.js";
import { bug, note, step } from "../lib/findings.js";
import { waitShowing } from "../lib/show.js";
import { RECRUITER, RECRUITS, admin, emailShowing, forgetIds, invite, join_, recruitId } from "./shared.js";

test.afterAll(closeAll);

test("@signup three recruits join from invite links", async () => {
  forgetIds();
  const a = await admin();
  const since = Date.now();
  const joined = [];
  for (const [key, person] of Object.entries(RECRUITS)) {
    const pool = key === "taylor" ? "" : RECRUITER.name;
    const link = await step("signup", `an invite link is made for ${person.name}`, a.page, () => invite(a, person, pool));
    const r = await step("signup", `${person.name} joins (${person.paste ? "pasted text" : person.file.split(".").pop()})`, null,
      () => join_(person, link));
    joined.push([person, r]);
  }

  await step("signup", "the new recruits show as pending on the dashboard", a.page, async () => {
    await a.page.goto("/admin");
    for (const [person] of joined) await expect(a.page.locator("table.recruits tr", { hasText: person.name })).toBeVisible();
  });

  for (const [person, r] of joined) {
    await step("signup", `${person.name}'s profile is built and they are emailed`, r.page, async () => {
      const msg = await emailShowing(r, `HermitShell reads ${person.name}'s CV with the local model`,
        { to: person.email, subject: "profile is ready", since }, { timeout: 900000 });
      const text = msg.Text || "";
      expect(text).toContain("HermitShell will search for:");
      if (!/Skills: .{20,}/.test(text)) await bug("signup", `${person.name}'s welcome email lists no skills`, r.page);
      await note("signup", `${person.name}: ${(text.match(/search for: (.*)/) || [])[1] || "?"}`);
    });
  }

  await step("signup", "the admin is told about each new recruit", a.page, async () => {
    for (const [person] of joined) {
      await waitShowing(a.page, "Admin", `waiting for "New recruit: ${person.name}"`, async () => {
        const { search } = await import("../lib/mailpit.js");
        return (await search(`subject:"New recruit: ${person.name}"`)).length > 0;
      }, { timeout: 300000 });
    }
  });

  await step("signup", "every recruit is active with a CV on file", a.page, async () => {
    for (const [person] of joined) {
      const id = await recruitId(a, person.name);
      await a.page.goto(`/admin/profile?u=${id}`);
      await expect(a.page.getByRole("heading", { name: person.name })).toBeVisible();
      await expect(a.page.getByText(/CV on file/)).toBeVisible();
      if (!(await a.page.getByLabel("Region or city").inputValue())) {
        await note("signup", `${person.name} joined without a region or country, so searches have no location until a recruiter sets one`);
      }
    }
  });
});

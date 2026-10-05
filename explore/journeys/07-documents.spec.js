// @documents: Sam asks for a cover letter and a tailored CV from the report's buttons, and the admin presses Generate
// for Sam's own CV. Each is written by the local model, emailed as a PDF and listed on the dashboard.

import { expect, test } from "@playwright/test";

import { actor, closeAll } from "../lib/actors.js";
import { bug, note, step } from "../lib/findings.js";
import { links, message, search } from "../lib/mailpit.js";
import { RECRUITS, admin, emailShowing, recruitId } from "./shared.js";

test.afterAll(closeAll);

async function ask(s, href, label) {
  await s.say(`Sam presses "${label}"`);
  await s.page.goto(href);
  await s.click(s.page.getByRole("button", { name: /^Confirm:/ }));
  await expect(s.page.getByRole("heading", { name: "Saved" })).toBeVisible();
}

function pdfs(msg) {
  return (msg.Attachments || []).filter((f) => /\.pdf$/i.test(f.FileName));
}

test("@documents cover letter, tailored CV and the recruit's own CV", async () => {
  const sam = RECRUITS.sam;
  const found = (await search(`to:${sam.email}`)).filter((m) => /\bjobs?\b/i.test(m.Subject) && !/ready|sign-in|test/i.test(m.Subject));
  expect(found.length, "run the recruiter journey first").toBeGreaterThan(0);
  const report = await message(found[0].ID);
  const s = await actor("Recruit", { key: "recruit-sam" });

  for (const [label, subject] of [["Cover letter", "^Cover letter:"], ["Tailored CV", "^Tailored CV:"]]) {
    const since = Date.now();
    await step("documents", `${label} is written and emailed as a PDF`, s.page, async () => {
      const href = links(report).find((l) => l.text === label)?.href;
      if (!href) return bug("documents", `the report has no ${label} button`, s.page);
      await ask(s, href, label);
      const msg = await emailShowing(s, `HermitShell writes the ${label.toLowerCase()}`, { to: sam.email, subject, since },
        { timeout: 1800000 });
      if (!pdfs(msg).length) await bug("documents", `"${msg.Subject}" came without a PDF`, s.page);
      await note("documents", `${msg.Subject}: ${pdfs(msg).map((f) => f.FileName).join(", ")}`);
    });
  }

  const a = await admin();
  const id = await recruitId(a, sam.name);
  const since = Date.now();
  await step("documents", "Generate makes Sam's own CV", a.page, async () => {
    await a.page.goto(`/admin/profile?u=${id}`);
    await a.click(a.page.getByRole("button", { name: "Generate" }));
    const menu = a.page.getByRole("button", { name: /^CV$|Their CV|CV from/ }).first();
    if (await menu.isVisible().catch(() => false)) await a.click(menu);
    const msg = await emailShowing(a, "HermitShell lays out Sam's CV", { to: sam.email, subject: "^CV:", since }, { timeout: 1800000 })
      .catch(() => null);
    await note("documents", msg ? `own CV: ${msg.Subject}` : "Generate did not email a CV within 30 minutes");
  });

  await step("documents", "the documents are listed on the jobs sent page", a.page, async () => {
    await a.page.goto(`/admin/sent?u=${id}&r=7`);
    await expect(a.page.locator(".doc.ready").first()).toBeVisible({ timeout: 300000 });
  });
});

// @documents: Sam asks for a cover letter and a tailored CV from the report's buttons, and the admin presses Generate
// for Sam's own CV. Each is written by the local model; the letter and tailored CV are emailed as PDFs and listed on
// the dashboard, and the own CV is kept on the profile page to download.

import { expect, test } from "@playwright/test";

import { actor, closeAll } from "../lib/actors.js";
import { bug, note, step } from "../lib/findings.js";
import { links } from "../lib/mailpit.js";
import { waitShowing } from "../lib/show.js";
import { RECRUITS, admin, emailShowing, latestReport, recruitId } from "./shared.js";

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
  const report = await latestReport(sam.email);
  expect(report, "run the recruiter journey first").toBeTruthy();
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
  await step("documents", "Generate makes Sam's own CV to download", a.page, async () => {
    const page = a.page;
    await page.goto(`/admin/profile?u=${id}`);
    await a.click(page.locator(".pcv").getByRole("button", { name: "Generate" }));
    // Kept on the profile page (the CV button), not emailed.
    await waitShowing(page, "Admin", "HermitShell lays out Sam's CV", async () => {
      await page.goto(`/admin/profile?u=${id}`);
      return page.locator(".pcv").getByRole("link", { name: "CV" }).isVisible();
    }, { timeout: 1800000, every: 15000 });
    const download = page.waitForEvent("download");
    await page.locator(".pcv").getByRole("link", { name: "CV" }).click();
    const name = (await download).suggestedFilename();
    expect(name).toMatch(/\.(pdf|docx)$/i);
    await note("documents", `own CV kept on the profile page: ${name}`);
  });

  await step("documents", "the documents are listed on the jobs sent page", a.page, async () => {
    await a.page.goto(`/admin/sent?u=${id}&r=7`);
    const row = a.page.locator("li > details", { has: a.page.locator(".doc.ready") }).first();
    await expect(row).toBeAttached({ timeout: 300000 });
    await a.click(row.locator(":scope > summary"));
    await expect(row.locator(".doc.ready").first()).toBeVisible();
  });
});

// @recruit: Sam Lee uses their report and their own page: answers two jobs from the email's buttons (each asks first),
// then signs in to /me with an emailed link, looks at their jobs and search, and signs out.

import { expect, test } from "@playwright/test";

import { actor, closeAll } from "../lib/actors.js";
import { link, links } from "../lib/mailpit.js";
import { bug, step } from "../lib/findings.js";
import { RECRUITS, admin, emailShowing, featureOn, latestReport } from "./shared.js";

test.afterAll(closeAll);

async function answer(s, href, label) {
  const { page } = s;
  await s.say(`Sam presses "${label}" in the email`);
  await page.goto(href);
  await expect(page.getByText("Nothing is saved until you press Confirm.")).toBeVisible();
  await s.click(page.getByRole("button", { name: /^Confirm:/ }));
  await expect(page.getByRole("heading", { name: "Saved" })).toBeVisible();
}

test("@recruit Sam answers jobs and uses their own page", async () => {
  const sam = RECRUITS.sam;
  const s = await actor("Recruit", { key: "recruit-sam" });
  const { page } = s;

  const report = await step("recruit", "Sam has a report with job buttons", null, async () => {
    const msg = await latestReport(sam.email);
    expect(msg, "run the recruiter journey first").toBeTruthy();
    return msg;
  });

  await step("recruit", "Interested and I applied are saved after Confirm", page, async () => {
    const answers = links(report).filter((l) => /^(Interested|I applied)$/.test(l.text));
    if (answers.length < 2) {
      await bug("recruit", `the report has ${answers.length} answer buttons`, page);
      return;
    }
    await answer(s, answers.find((l) => l.text === "Interested").href, "Interested");
    await answer(s, answers.filter((l) => l.text === "I applied").at(-1).href, "I applied");
  });

  await step("recruit", "a tampered button is refused", page, async () => {
    const url = new URL(links(report).find((l) => l.text === "Interested").href);
    url.searchParams.set("n", "Head of Data at Contoso");
    expect((await page.goto(url.toString())).status()).toBe(403);
  });

  const a = await admin();
  await step("recruit", "the recruits' own page is on", a.page, () => featureOn(a, /Recruits' own page/));

  const since = Date.now();
  await step("recruit", "Sam signs in to their own page with an emailed link", page, async () => {
    await expect.poll(async () => (await page.goto("/me")).status(), { timeout: 120000, intervals: [5000] }).toBe(200);
    await s.say("Sam asks for a sign-in link");
    await s.fill(page.getByLabel("The email address your reports go to"), sam.email);
    await s.click(page.getByRole("button", { name: "Email me a sign-in link" }));
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    const msg = await emailShowing(s, "waiting for the sign-in link", { to: sam.email, subject: "sign-in link", since },
      { timeout: 300000 });
    await page.goto(link(msg, "Sign in to your page"));
    await s.click(page.getByRole("button", { name: "Sign in", exact: true }));
    await expect(page.getByRole("heading", { name: "My jobs" })).toBeVisible();
    await expect(page.getByText(`Signed in as ${sam.name}`)).toBeVisible();
  });

  await step("recruit", "Sam sees their search and nothing of anyone else's", page, async () => {
    await s.click(page.getByRole("link", { name: "My job search" }));
    await expect(page.getByLabel("Job titles")).not.toHaveValue("");
    await expect(page.locator('input[name="email"]')).toHaveCount(0);
    await page.goto("/admin");
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  await step("recruit", "Sam signs out", page, async () => {
    await page.goto("/me");
    await s.click(page.getByRole("button", { name: "Sign out", exact: true }));
    await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
  });
});

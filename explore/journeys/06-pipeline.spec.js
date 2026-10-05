// @pipeline: the jobs Sam answered reach the Pipeline once HermitShell reports them; Riley moves the applied one to
// Interview and asks for an interview prep pack, which HermitShell writes with the local model and emails.

import { expect, test } from "@playwright/test";

import { closeAll } from "../lib/actors.js";
import { note, step } from "../lib/findings.js";
import { waitShowing } from "../lib/show.js";
import { RECRUITS, admin, emailShowing, recruitId, recruiter } from "./shared.js";

test.afterAll(closeAll);

test("@pipeline Riley moves an application along and asks for interview prep", async () => {
  const id = await recruitId(await admin(), RECRUITS.sam.name);
  const r = await recruiter();
  const { page } = r;

  const card = await step("pipeline", "the applied job appears on the Pipeline", page, async () => {
    const applied = page.getByRole("region", { name: "Applied" });
    await waitShowing(page, "Recruiter", "waiting for HermitShell to report Sam's answers", async () => {
      await page.goto(`/admin/pipeline?u=${id}`);
      return (await applied.locator(".pcard").count()) > 0;
    }, { timeout: 900000, every: 15000 });
    return applied.locator(".pcard").first();
  });

  await step("pipeline", "the card moves to Interview", page, async () => {
    await r.say("moving the application to Interview");
    await card.getByLabel("Move to").selectOption("interview");
    await r.click(card.getByRole("button", { name: "Move" }));
    await expect(page.getByRole("status").first()).toContainText("Moved");
  });

  const since = Date.now();
  await step("pipeline", "an interview prep pack is made and emailed", page, async () => {
    const interview = page.getByRole("region", { name: "Interview" });
    await waitShowing(page, "Recruiter", "waiting for the move to reach the board", async () => {
      await page.goto(`/admin/pipeline?u=${id}`);
      return (await interview.getByRole("button", { name: "Interview prep" }).count()) > 0;
    }, { timeout: 900000, every: 15000 });
    await r.click(interview.getByRole("button", { name: "Interview prep" }).first());
    await expect(page.getByRole("status").first()).toContainText("prep pack");
    const msg = await emailShowing(r, "HermitShell writes the prep pack with the local model",
      { to: RECRUITS.sam.email, subject: "Interview prep", since }, { timeout: 1800000 });
    await note("pipeline", `prep pack emailed: ${msg.Subject} (${(msg.Attachments || []).length} attachment(s))`);
  });
});

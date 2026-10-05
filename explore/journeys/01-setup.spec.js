// @setup: the admin's first visit. HermitShell has connected by itself; the email server comes from the backend's
// settings, so the test email has to arrive in the inbox before the setup list is done.

import { expect, test } from "@playwright/test";

import { closeAll } from "../lib/actors.js";
import { step } from "../lib/findings.js";
import { waitShowing } from "../lib/show.js";
import { admin, emailShowing, featureOn } from "./shared.js";

test.afterAll(closeAll);

test("@setup the admin finishes setting up", async () => {
  const a = await admin();
  const { page } = a;
  await step("setup", "the dashboard says HermitShell is online", page, async () => {
    await a.say("HermitShell should report in by itself");
    await expect(page.getByRole("heading", { name: "Recruits" })).toBeVisible();
    await waitShowing(page, "Admin", "waiting for HermitShell to report in", async () => {
      await page.goto("/admin");
      return page.getByText("HermitShell is online").isVisible();
    }, { timeout: 300000, every: 5000 });
  });

  const since = Date.now();
  await step("setup", "a test email reaches the inbox", page, async () => {
    await a.say("sending a test email through the backend's mail server (STARTTLS)");
    await page.goto("/admin/settings#email");
    await a.click(page.getByRole("button", { name: "Send a test email" }));
    const msg = await emailShowing(a, "waiting for the test email", { subject: "test email", since }, { timeout: 180000 });
    expect(msg.Subject).toMatch(/test email/i);
  });

  await step("setup", "the setup list ticks the test email", page, async () => {
    await page.goto("/admin");
    const list = page.getByRole("heading", { name: "Finish setting up" }).locator("..");
    if (await list.isVisible().catch(() => false)) {
      await expect(page.getByRole("listitem").filter({ hasText: "Test email received" })).toBeVisible();
      await expect(page.getByRole("listitem").filter({ hasText: "Web search key set" })).toBeVisible();
    }
  });

  await step("setup", "Global settings shows the server, model and keys", page, async () => {
    await a.say("checking Global settings");
    await page.locator("nav.tabs").getByRole("link", { name: "Global settings" }).click();
    await expect(page.getByRole("heading", { name: "Global settings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI model API keys" })).toBeVisible();
    await expect(page.getByText(/Server model asked first/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save email server" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("fc-");
  });

  await step("setup", "the recruits' own page is switched on", page, () => featureOn(a, /Recruits' own page/));
});

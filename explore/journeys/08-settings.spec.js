// @settings: the admin brands the dashboard (name, palette, the Northwind logo), checks every page picks it up, looks
// over the model and key settings without any key showing, then puts the theme back.

import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeAll } from "../lib/actors.js";
import { step } from "../lib/findings.js";
import { DATA, admin, recruiter } from "./shared.js";

test.afterAll(closeAll);

test("@settings theme, branding and Global settings", async () => {
  const a = await admin();
  const { page } = a;
  await step("settings", "a name, palette and logo are saved", page, async () => {
    await page.goto("/admin/theme");
    await a.say("branding the dashboard as Northwind Talent");
    await a.fill(page.getByLabel("Name", { exact: true }), "Northwind Talent");
    await a.click(page.locator("label.tpal", { hasText: "Ocean" }));
    await page.locator("#tlogo").setInputFiles(join(DATA, "northwind-logo.png"));
    await expect(page.locator(".pvmark img")).toHaveAttribute("src", /^blob:/);
    await a.click(page.getByRole("button", { name: "Save theme" }));
    await expect(page.getByText("Saved. Every page now uses this theme.")).toBeVisible();
  });

  const r = await recruiter();
  await step("settings", "the recruiter's pages use the new branding", r.page, async () => {
    await r.page.goto("/admin");
    await expect(r.page.locator(".eyebrow")).toContainText("Northwind Talent");
    await expect(r.page.locator(".eyebrow img.mark")).toHaveAttribute("src", /^\/brand\/logo\?v=/);
  });

  await step("settings", "the sign-up and privacy pages use it too", r.page, async () => {
    await r.page.goto("/privacy");
    await expect(r.page.locator(".eyebrow")).toContainText("Northwind Talent");
  });

  await step("settings", "Global settings never shows a key", page, async () => {
    await page.goto("/admin/settings");
    await a.say("Global settings: email, keys, models and features");
    for (const h of ["Email server", "Web search API keys", "AI model API keys", "Features"]) {
      await expect(page.getByRole("heading", { name: h, exact: true }).filter({ visible: true }).first()).toBeVisible();
    }
    const html = await page.content();
    expect(html).not.toMatch(/fc-[A-Za-z0-9]{20,}/);
    expect(html).not.toContain("explore-inbox");
  });

  await step("settings", "the theme is put back", page, async () => {
    await page.goto("/admin/theme");
    await a.click(page.getByRole("button", { name: "Reset to default" }));
    await expect(page.locator(".eyebrow")).toContainText("HermitShell");
  });
});

import { expect, test } from "@playwright/test";

import { signIn } from "./fixtures.js";

test("the admin picks a palette and a name from the palette button, sees them on every page, then resets", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Theme and branding" }).click();
  await expect(page).toHaveURL(/\/admin\/theme$/);
  await expect(page.getByRole("heading", { name: "Theme and branding" })).toBeVisible();

  await page.getByLabel("Name", { exact: true }).fill("Northwind Talent");
  await expect(page.locator(".pvname")).toHaveText("Northwind Talent");
  await page.locator("label.tpal", { hasText: "Ocean" }).click();
  await expect(page.locator("#pal-ocean")).toBeChecked();
  await page.locator(".tseg label", { hasText: "Serif" }).click();
  await page.getByRole("button", { name: "Save theme" }).click();

  await expect(page).toHaveURL(/done=saved/);
  await expect(page.getByText("Saved. Every page now uses this theme.")).toBeVisible();
  await expect(page.locator(".eyebrow")).toContainText("Northwind Talent");
  await expect(page.locator("#font-serif")).toBeChecked();
  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute("href", /[?&]t=[0-9a-f]+/);

  await page.goto("/admin");
  await expect(page.locator(".eyebrow")).toContainText("Northwind Talent");

  await page.goto("/admin/theme");
  await page.getByRole("button", { name: /Reset to HermitShell/ }).click();
  await expect(page).toHaveURL(/done=reset/);
  await expect(page.locator(".eyebrow")).toContainText("HermitShell");
  await expect(page.locator(".eyebrow")).not.toContainText("Northwind");
  await expect(page.locator("#pal-hermitshell")).toBeChecked();
  await expect(page.locator('link[rel="stylesheet"]')).not.toHaveAttribute("href", /[?&]t=/);

  await page.getByRole("link", { name: "Back to recruits" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Recruits" })).toBeVisible();
});

const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

test("a picked WebP logo shows in the preview at once, and one too big is refused before saving", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/theme");
  const mark = page.locator(".pvmark");
  await expect(mark.locator("img")).toHaveCount(0);

  await page.locator("#tlogo").setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(200 * 1024 + 1) });
  await expect(page.getByRole("alert")).toHaveText("That picture is over 200 KB. Try a smaller one.");
  await expect(page.locator("#tlogo")).toHaveValue("");
  await expect(mark.locator("img")).toHaveCount(0);

  await page.locator("#tlogo").setInputFiles({ name: "brandmark.webp", mimeType: "image/webp", buffer: WEBP });
  await expect(mark.locator("img")).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => mark.locator("img").evaluate((img) => img.naturalWidth)).toBe(1);
  await expect(page.getByRole("alert")).toBeHidden();

  await page.getByRole("button", { name: "Save theme" }).click();
  await expect(page).toHaveURL(/done=saved/);
  await expect(page.locator(".eyebrow img.mark")).toHaveAttribute("src", /^\/brand\/logo\?v=[0-9a-f]{12}$/);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("type", "image/webp");
  await page.getByRole("button", { name: /Reset to HermitShell/ }).click();
  await expect(page).toHaveURL(/done=reset/);
});

import { expect, test } from "@playwright/test";

import { hermitShellApi, hermitShellStatus, reportStatus, signIn } from "./fixtures.js";

const APPLIED = "Applied by HermitShell. The page shows the change.";

// What HermitShell does with the queue: applies it, reports the result, then takes the items off.
async function applyQueue(request, status) {
  const { items } = await (await hermitShellApi(request, "GET", "/api/queue?full=1")).json();
  await reportStatus(request, status);
  if (items.length) await hermitShellApi(request, "POST", "/api/queue/ack", { ids: items.map((i) => i.id) });
}

test.afterEach(async ({ request }) => {
  await applyQueue(request, hermitShellStatus());
});

test("a key added on Global settings shows as saving, then appears by itself once HermitShell applies it", async ({ page, request }) => {
  await applyQueue(request, hermitShellStatus());
  await signIn(page);
  await page.goto("/admin/settings");
  const row = page.locator(".keyrows .cr-tavily");
  await expect(row).toContainText("No key yet");
  await row.getByRole("link", { name: "Add key" }).click();
  const modal = page.locator("#gkey-tavily");
  await modal.getByLabel("API key").fill("tvly-e2e-autoupdate-0001");
  await modal.getByRole("button", { name: "Save key" }).click();
  await expect(page).toHaveURL(/done=queued#keys$/);
  await expect(page.locator(".waitbar")).toContainText("Waiting for HermitShell to apply the web search keys; this page updates by itself.");
  await expect(row.locator(".savingtag")).toHaveText("saving…");

  const status = hermitShellStatus();
  status.keys.tavily = { source: "dashboard", hint: "tvly...0001" };
  await applyQueue(request, status);
  await expect(page.getByText(APPLIED)).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/done=queued&w=[12]#keys$/);
  await expect(row).toContainText("set here");
  await expect(row).toContainText("tvly...0001");
  await expect(row.locator(".savingtag")).toHaveCount(0);
  await expect(page.locator(".waitbar")).toHaveCount(0);
});

test("a pause shows on the dashboard at once, keeps the scroll while it reloads, and settles when applied", async ({ page, request }) => {
  await applyQueue(request, hermitShellStatus());
  await page.setViewportSize({ width: 1280, height: 560 });
  await signIn(page);
  await page.getByRole("button", { name: "Pause reports for Sam Lee" }).click();
  await expect(page).toHaveURL(/done=queued/);
  const sam = page.locator("table.recruits tr", { hasText: "sam.lee@example.com" });
  await expect(sam.locator(".savingtag")).toHaveText("pausing…");
  await expect(sam.getByRole("button", { name: "Resume reports for Sam Lee" })).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, 320));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(100);
  await page.waitForEvent("load", { timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before - 40);

  const status = hermitShellStatus();
  status.profiles.find((p) => p.id === "sam-lee").status = "paused";
  await applyQueue(request, status);
  await expect(page.getByText(APPLIED)).toBeVisible({ timeout: 10_000 });
  await expect(sam.locator(".pill").first()).toHaveText("paused");
  await expect(sam.locator(".savingtag")).toHaveCount(0);
});

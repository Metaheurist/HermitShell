import { expect, test } from "@playwright/test";

import { hermitShellApi, reportStatus, sealing, signIn } from "./fixtures.js";

test("the server button shows the machine and the models on hover, and on focus from the keyboard", async ({ page }) => {
  await signIn(page);
  const panel = page.locator(".srvpanel");
  await expect(panel).toBeHidden();
  await page.locator(".srv").hover();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Contoso Server CPU");
  await expect(panel).toContainText("8 threads");
  await expect(panel.locator(".smodels li")).toHaveText([/OpenRouter/, /Local Ollama/]);
  await expect(panel).toContainText("Last answer from OpenRouter");
  await page.mouse.move(5, 500);
  await expect(panel).toBeHidden();
  await page.locator(".srv").focus();
  await expect(panel).toBeVisible();
  await panel.getByRole("link", { name: "Model settings" }).click();
  await expect(page).toHaveURL(/\/admin\/settings#models$/);
  await expect(page.getByRole("heading", { name: "AI model API keys" })).toBeVisible();
});

test("on a phone the server panel stays inside the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.locator(".srv").focus();
  const box = await page.locator(".srvpanel").boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

test("an AI model key is added from its modal and queued for HermitShell, sealed", async ({ page, request }) => {
  await reportStatus(request);
  await signIn(page);
  await page.goto("/admin/settings");
  const row = page.locator(".cr-featherless.keyrow");
  await expect(row).toContainText("No key yet");
  await row.getByRole("link", { name: "Add key" }).click();
  const modal = page.locator("#mkey-featherless");
  await expect(modal).toBeVisible();
  await expect(modal.locator('input[value="featherless"]')).toBeChecked();
  await modal.getByLabel("API key").fill("rc-e2e-featherless-0001");
  await modal.getByLabel(/^Model/).fill("Qwen/Qwen2.5-14B-Instruct");
  await modal.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/done=queued#models$/);
  await expect(page.locator(".waitbar")).toContainText("Waiting for HermitShell to apply the AI model settings");
  await expect(row.locator(".savingtag")).toHaveText("saving…");
  await expect(page.locator("body")).not.toContainText("rc-e2e-featherless-0001");
  const res = await hermitShellApi(request, "GET", "/api/queue?full=1");
  expect(res.ok()).toBe(true);
  const text = await res.text();
  expect(text).not.toContain("rc-e2e-featherless-0001");
  const item = JSON.parse(text).items.find((i) => i.action === "model_keys" && i.provider === "featherless");
  expect(item.sealed).toEqual(["key"]);
  expect(await (await sealing()).open(item.key, "key")).toBe("rc-e2e-featherless-0001");
});

test("a bad model name is refused with a message", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/settings#mkey-openrouter");
  const modal = page.locator("#mkey-openrouter");
  await modal.getByLabel(/^Model/).fill("not a model!");
  await modal.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/done=badmodel#models$/);
  await expect(page.getByText("Choose a provider and paste its API key or a model name")).toBeVisible();
});
import { expect, test } from "@playwright/test";

import { hermitShellApi, hermitShellStatus, reportStatus, signIn } from "./fixtures.js";

const APPLIED = "Done. The page shows the change.";

// What HermitShell does with the queue: applies it, reports the result, then takes the items off.
async function applyQueue(request, status) {
  const { items } = await (await hermitShellApi(request, "GET", "/api/queue?full=1")).json();
  await reportStatus(request, status);
  if (items.length) await hermitShellApi(request, "POST", "/api/queue/ack", { ids: items.map((i) => i.id) });
}

test.afterEach(async ({ request }) => {
  await applyQueue(request, hermitShellStatus());
});

// Without scripts Playwright can't wait for a button to settle, so that test sends the form with Enter.
async function addTavilyKey(page, { enter = false } = {}) {
  await page.goto("/admin/settings");
  const row = page.locator(".keyrows .cr-tavily");
  await expect(row).toContainText("No key yet");
  await row.getByRole("link", { name: "Add key" }).click();
  const modal = page.locator("#gkey-tavily");
  await modal.getByLabel("API key").fill("not-a-real-key");
  if (enter) await modal.getByLabel("API key").press("Enter");
  else await modal.getByRole("button", { name: "Save key" }).click();
  await expect(page).toHaveURL(/done=queued#keys$/);
  return row;
}

test("a key added on Global settings shows as saving, then appears by itself once HermitShell applies it", async ({ page, request }) => {
  await applyQueue(request, hermitShellStatus());
  await signIn(page);
  const row = await addTavilyKey(page);
  await expect(page.locator(".waitbar")).toContainText("Working on the web search keys… This page updates by itself.");
  await expect(row.locator(".savingtag")).toHaveText("saving…");

  const status = hermitShellStatus();
  status.keys.tavily = { source: "dashboard", hint: "tvly...0001" };
  await applyQueue(request, status);
  await page.evaluate(() => { window.stayed = true; });
  await expect(page.getByText(APPLIED)).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/done=queued#keys$/);
  expect(await page.evaluate(() => window.stayed)).toBe(true);
  await expect(row).toContainText("set here");
  await expect(row).toContainText("tvly...0001");
  await expect(row.locator(".savingtag")).toHaveCount(0);
  await expect(page.locator(".waitbar")).toHaveCount(0);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the settings page reloads itself at its section until HermitShell applies the key", async ({ page, request }) => {
    await applyQueue(request, hermitShellStatus());
    await signIn(page);
    const row = await addTavilyKey(page, { enter: true });
    const status = hermitShellStatus();
    status.keys.tavily = { source: "dashboard", hint: "tvly...0001" };
    await applyQueue(request, status);
    await expect(page.getByText(APPLIED)).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/done=queued&w=[12]#keys$/);
    await expect(row).toContainText("tvly...0001");
  });
});

test("the Tasks count follows the open task list and clears when the task finishes, without a reload", async ({ page, request }) => {
  const running = hermitShellStatus();
  running.tasks = [{ id: "report:sam-lee", kind: "report", u: "sam-lee", state: "running", trigger: "schedule", at: Date.now(), stage: "Searching" }];
  await applyQueue(request, running);
  await signIn(page);
  const button = page.locator("a.tasksbtn");
  await expect(button.locator(".tcount")).toHaveText("1");
  await button.click();
  const list = page.frameLocator("iframe.tasksframe");
  await expect(list.locator("li.task")).toHaveCount(1);
  await page.evaluate(() => { window.stayed = true; });

  await applyQueue(request, hermitShellStatus());
  await expect(list.getByText("Nothing waiting or running")).toBeVisible({ timeout: 15_000 });
  await expect(button.locator(".tcount")).toHaveCount(0);
  await expect(button).toHaveAttribute("title", "Tasks");
  await expect(button).not.toHaveClass(/busy/);
  expect(await page.evaluate(() => window.stayed)).toBe(true);
});

test("a pause shows on the dashboard at once, keeps the scroll while it updates, and settles when applied", async ({ page, request }) => {
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
  await page.evaluate(() => { window.stayed = true; });
  await page.waitForTimeout(5000);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before - 40);

  const status = hermitShellStatus();
  status.profiles.find((p) => p.id === "sam-lee").status = "paused";
  await applyQueue(request, status);
  await expect(page.getByText(APPLIED)).toBeVisible({ timeout: 10_000 });
  await expect(sam.locator(".pill").first()).toHaveText("paused");
  await expect(sam.locator(".savingtag")).toHaveCount(0);
  expect(await page.evaluate(() => window.stayed)).toBe(true);
});

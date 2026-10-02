import { expect, test } from "@playwright/test";

import { hermitShellApi, hermitShellStatus, reportStatus, sealing, signIn } from "./fixtures.js";

test("the server button shows the machine and the models on hover, and on focus from the keyboard", async ({ page }) => {
  await signIn(page);
  const panel = page.locator(".srvpanel");
  await expect(panel).toBeHidden();
  await page.locator(".srv").hover();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Contoso Server CPU");
  await expect(panel).toContainText("8 threads");
  await expect(panel.locator(".smodels li")).toHaveText([/OpenRouter/, /Server model/]);
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

test("the server panel shows the last backup, and Back up now queues one for HermitShell", async ({ page, request }) => {
  await reportStatus(request, { ...hermitShellStatus(),
    backup: { at: Date.now() - 2 * 3600000, size: 5_400_000, kept: 9, error: "", failed_at: null, encrypted: true } });
  await signIn(page);
  await page.locator(".srv").focus();
  const panel = page.locator(".srvpanel");
  await expect(panel).toContainText("Last backup 2 hours ago · 5.1 MB · 9 kept");
  await expect(panel).toContainText("keep a copy of it away from this server");
  await panel.getByRole("button", { name: "Back up now" }).click();
  await expect(page).toHaveURL(/\/admin\?done=backup$/);
  await expect(page.getByText("Backing up. The backup appears in the server panel")).toBeVisible();
  const res = await hermitShellApi(request, "GET", "/api/queue?full=1");
  expect((await res.json()).items.some((i) => i.type === "admin" && i.action === "backup_now")).toBe(true);
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
  await expect(page.locator(".waitbar")).toContainText("Working on the AI model settings");
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

test("a Features switch is turned off and queued for HermitShell as false, alone", async ({ page, request }) => {
  await reportStatus(request);
  await signIn(page);
  await page.goto("/admin/settings");
  const alerts = page.getByRole("checkbox", { name: /Admin alerts by email/ });
  await expect(alerts).toBeChecked();
  await alerts.uncheck();
  await page.getByRole("button", { name: "Save features" }).click();
  await expect(page).toHaveURL(/done=queued#features$/);
  await expect(page.locator(".waitbar")).toContainText("the features");
  await expect(alerts).not.toBeChecked();
  const res = await hermitShellApi(request, "GET", "/api/queue?full=1");
  const item = (await res.json()).items.findLast((i) => i.action === "features");
  expect(item).toMatchObject({ type: "admin", action: "features", alerts: false });
  expect(Object.keys(item).filter((k) => !["type", "action", "id", "at"].includes(k))).toEqual(["alerts"]);
});

test("a new server model is picked, then its download shows on the dashboard and in Tasks until it is ready", async ({ page, request }) => {
  await reportStatus(request);
  await signIn(page);
  await page.goto("/admin/settings");
  const row = page.locator(".cr-ollama.keyrow");
  await expect(row).toContainText("from .env");
  await row.getByRole("link", { name: "Change" }).click();
  const modal = page.locator("#mlocal");
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("radio", { name: /^Default/ })).toBeChecked();
  await expect(modal.getByRole("radio", { name: /qwen3:30b/ })).toBeDisabled();
  await modal.getByText("qwen2.5:7b-instruct-q4_K_M").click();
  await expect(modal.getByRole("radio", { name: /qwen2\.5:7b-instruct/ })).toBeChecked();
  await modal.getByRole("button", { name: "Use this model" }).click();
  await expect(page).toHaveURL(/done=queued#models$/);
  await expect(page.locator(".waitbar")).toContainText("the server model");
  await expect(row.locator(".savingtag")).toBeVisible();
  const res = await hermitShellApi(request, "GET", "/api/queue?full=1");
  expect((await res.json()).items.findLast((i) => i.action === "local_model")).toMatchObject({ type: "admin", model: "qwen2.5:7b-instruct-q4_K_M" });

  const status = hermitShellStatus();
  const pull = { model: "qwen2.5:7b-instruct-q4_K_M", status: "downloading", done_mb: 1200, total_mb: 4700, started: Date.now() - 60000,
    finished: null, error: "", switch: true, stopping: false };
  await reportStatus(request, { ...status, llm: { ...status.llm, local: { ...status.llm.local, pull } },
    tasks: [{ id: "model:pull", kind: "model", u: "", state: "running", at: pull.started, trigger: "dashboard", title: pull.model,
      stage: "Downloading", done: 1200, total: 4700 }] });
  await page.goto("/admin");
  const notice = page.locator(".mnotice");
  await expect(notice).toContainText("Downloading qwen2.5:7b-instruct-q4_K_M: 26%");
  await expect(notice.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "26");
  await notice.getByRole("link", { name: "Follow it in Tasks" }).click();
  const tasks = page.frameLocator("iframe.tasksframe");
  await expect(tasks.locator(".task.k-model")).toContainText("Server model download");
  await expect(tasks.locator(".task.k-model")).toContainText("1.2 of 4.6 GB");
  await tasks.getByRole("button", { name: "Stop" }).click();
  await expect(tasks.locator(".task.k-model")).toContainText("Stopping");
  const queue = await (await hermitShellApi(request, "GET", "/api/queue?full=1")).json();
  expect(queue.items.some((i) => i.action === "cancel" && i.task === "model:pull")).toBe(true);

  await reportStatus(request, { ...status, llm: { ...status.llm, local: { ...status.llm.local, model: pull.model, source: "dashboard",
    pull: { ...pull, status: "ready", done_mb: 4700, finished: Date.now() } } } });
  await page.goto("/admin");
  await expect(page.locator(".mnotice.ok")).toContainText("qwen2.5:7b-instruct-q4_K_M is downloaded and is now the server model");
});

test("while Tasks is open the dashboard behind it pauses and is not blurred, and starts again once it closes", async ({ page, request }) => {
  const status = hermitShellStatus();
  const pull = { model: "qwen2.5:7b-instruct-q4_K_M", status: "downloading", done_mb: 1200, total_mb: 4700, started: Date.now() - 60000,
    finished: null, error: "", switch: true, stopping: false };
  await reportStatus(request, { ...status, llm: { ...status.llm, local: { ...status.llm.local, pull } },
    tasks: [{ id: "model:pull", kind: "model", u: "", state: "running", at: pull.started, trigger: "dashboard", title: pull.model,
      stage: "Downloading", done: 1200, total: 4700 }, { id: "report:owner", kind: "report", u: "owner", state: "running",
      at: Date.now() - 30000, trigger: "schedule", stage: "Rating jobs", done: 12, total: 40 }] });
  await signIn(page);
  await page.goto("/admin");
  const ring = page.locator(".tasksbtn.busy .tring");
  const state = (loc, pseudo) => loc.evaluate((el, p) => getComputedStyle(el, p).animationPlayState, pseudo);
  await expect.poll(() => state(ring, "::before")).toBe("running");
  await page.locator(".tasksbtn").click();
  await expect(page.locator("#tasks")).toBeVisible();
  await expect.poll(() => state(ring, "::before")).toBe("paused");
  expect(await page.locator("#tasks .scrim").evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none");
  await expect.poll(() => state(page.locator("#tasks .sheeticon svg").first())).toBe("running");
  const bar = page.frameLocator("iframe.tasksframe").locator(".task.k-report .bar i");
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((el) => getComputedStyle(el, "::after").animationName)).toBe("tflow");
  await page.goto("/admin#");
  await expect.poll(() => state(ring, "::before")).toBe("running");
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
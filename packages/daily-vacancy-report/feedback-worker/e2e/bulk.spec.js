import { expect, test } from "@playwright/test";

import { hermitShellApi, reportStatus, signIn } from "./fixtures.js";

test.afterEach(async ({ request }) => {
  const { items } = await (await hermitShellApi(request, "GET", "/api/queue?full=1")).json();
  if (items.length) await hermitShellApi(request, "POST", "/api/queue/ack", { ids: items.map((i) => i.id) });
});

test("ticking recruits shows the bar, and Pause queues one change for them all", async ({ page, request }) => {
  await reportStatus(request);
  await signIn(page);
  const bar = page.locator("form#bulk");
  await expect(bar).toBeHidden();
  await page.getByLabel("Tick Sam Lee").check();
  await page.getByLabel("Tick Jordan Patel").check();
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Pause" }).click();
  await expect(page).toHaveURL(/done=bulk&n=1&m=1$/);
  await expect(page.getByText("1 done, 1 skipped.")).toBeVisible();
  const { items } = await (await hermitShellApi(request, "GET", "/api/queue?full=1")).json();
  expect(items.map((i) => [i.action, i.op, i.us])).toEqual([["bulk", "pause", ["sam-lee"]]]);
  await page.goto("/admin/history?u=sam-lee");
  await expect(page.getByText("Paused reports").first()).toBeVisible();
});

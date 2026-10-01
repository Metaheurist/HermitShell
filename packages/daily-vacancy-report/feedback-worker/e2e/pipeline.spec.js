import { expect, test } from "@playwright/test";

import { hermitShellApi, reportStatus, sidewaysOverflow, signIn } from "./fixtures.js";

const day = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
const BOARD = [
  { key: "job-e2e-pipeline-1", title: "Data Engineer", employer: "Northwind Traders", stage: "applied", day: day(3) },
  { key: "job-e2e-pipeline-2", title: "Analytics Engineer", employer: "Contoso", stage: "interview", day: day(8) },
  { key: "job-e2e-pipeline-3", title: "BI Developer", employer: "Fabrikam", stage: "placed", day: day(40) },
];

async function sendBoard(request) {
  await reportStatus(request);
  const res = await hermitShellApi(request, "POST", "/api/stats", { u: "sam-lee", stats: { days: {}, sent: [], board: BOARD } });
  expect(res.ok()).toBe(true);
}

test("the Pipeline shows where each application stands, and a move waits for HermitShell to collect it", async ({ page, request }) => {
  await sendBoard(request);
  await signIn(page);
  await page.goto("/admin/profile?u=sam-lee");
  await page.getByRole("navigation", { name: "Recruit pages" }).getByRole("link", { name: "Pipeline" }).click();
  await expect(page).toHaveURL(/\/admin\/pipeline\?u=sam-lee$/);
  const applied = page.getByRole("region", { name: "Applied" });
  await expect(applied).toContainText("Data Engineer");
  await expect(page.getByRole("region", { name: "Interview" })).toContainText("Analytics Engineer");
  await expect(page.getByRole("region", { name: "Placed" })).toContainText("BI Developer");

  const card = applied.locator(".pcard", { hasText: "Data Engineer" });
  await card.getByLabel("Move to").selectOption("interview");
  await card.getByRole("button", { name: "Move" }).click();
  await expect(page).toHaveURL(/done=stage#card-[0-9a-f]{16}$/);
  await expect(page.getByRole("status")).toContainText("Moved. HermitShell collects it within about 5 minutes");

  const events = (await (await hermitShellApi(request, "GET", "/events?u=sam-lee")).json()).events;
  const moved = events.filter((e) => e.j === "job-e2e-pipeline-1" && e.a === "interview" && e.via === "dashboard");
  expect(moved).toHaveLength(1);
  expect(moved[0].meta).toBeUndefined();
  await hermitShellApi(request, "POST", "/ack", { ids: moved.map((e) => e.id) });
});

test("an interview card asks HermitShell for a prep pack and shows it is being made", async ({ page, request }) => {
  await sendBoard(request);
  await signIn(page);
  await page.goto("/admin/pipeline?u=sam-lee");
  const card = page.getByRole("region", { name: "Interview" }).locator(".pcard", { hasText: "Analytics Engineer" });
  await card.getByRole("button", { name: "Interview prep" }).click();
  await expect(page).toHaveURL(/done=doc#card-[0-9a-f]{16}$/);
  await expect(page.getByRole("status").first()).toContainText("HermitShell is making the prep pack");
  await expect(page.getByRole("region", { name: "Interview" })).toContainText("Prep pack being made");

  const events = (await (await hermitShellApi(request, "GET", "/events?u=sam-lee")).json()).events;
  const asked = events.filter((e) => e.j === "job-e2e-pipeline-2" && e.a === "interview_prep" && e.via === "dashboard");
  expect(asked).toHaveLength(1);
  await hermitShellApi(request, "POST", "/ack", { ids: asked.map((e) => e.id) });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the columns stack, and nothing runs off the side", async ({ page, request }) => {
    await sendBoard(request);
    await signIn(page);
    await page.goto("/admin/pipeline?u=sam-lee");
    const first = await page.getByRole("region", { name: "Interested" }).boundingBox();
    const last = await page.getByRole("region", { name: "Rejected" }).boundingBox();
    expect(Math.abs(first.x - last.x)).toBeLessThanOrEqual(1);
    expect(last.y).toBeGreaterThan(first.y);
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
    expect(await page.locator(".pboard").evaluate((b) => b.scrollWidth <= b.clientWidth + 1)).toBe(true);
  });
});

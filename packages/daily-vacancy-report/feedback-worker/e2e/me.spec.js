import { expect, test } from "@playwright/test";

import { hermitShellApi, hermitShellStatus, reportStatus, sealing } from "./fixtures.js";

async function queued(request) {
  return (await (await hermitShellApi(request, "GET", "/api/queue?full=1")).json()).items;
}

test.afterEach(async ({ request }) => {
  const items = await queued(request);
  if (items.length) await hermitShellApi(request, "POST", "/api/queue/ack", { ids: items.map((i) => i.id) });
  await reportStatus(request);
});

test("a recruit's own page is a 404 while its switch is off", async ({ request }) => {
  await reportStatus(request);
  expect((await request.get("/me")).status()).toBe(404);
});

test("a recruit asks for a link, signs in once with it, sees only their own page and signs out", async ({ page, request }) => {
  await reportStatus(request, { ...hermitShellStatus(), features: { alerts: true, self_service: true } });
  await page.goto("/me");
  await page.getByLabel("The email address your reports go to").fill("drew.harper@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  let item;
  await expect.poll(async () => (item = (await queued(request)).find((i) => i.type === "login_link"))?.u).toBe("drew-harper");
  const token = await (await sealing()).open(item.token, "token");

  // Opening the link changes nothing until Sign in is pressed, as a mail scanner opening it would.
  await page.goto(`/me/login?t=${token}`);
  await page.goto(`/me/login?t=${token}`);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My jobs" })).toBeVisible();
  await expect(page.getByText("Signed in as Drew Harper")).toBeVisible();

  await page.getByRole("link", { name: "My job search" }).click();
  await expect(page.getByLabel("Job titles")).toHaveValue("Data Engineer\nAnalytics Engineer");
  await expect(page.locator('input[name="email"]')).toHaveCount(0);

  // The recruit's session opens nothing on /admin.
  await page.goto("/admin");
  await expect(page.getByLabel("Password")).toBeVisible();

  // The link worked once.
  await page.goto(`/me/login?t=${token}`);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Link used or expired" })).toBeVisible();

  await page.goto("/me");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
  await page.goto("/me");
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
});

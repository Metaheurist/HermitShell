import { expect, test } from "@playwright/test";

import { API_TOKEN, signIn, signedHeaders } from "./fixtures.js";

test("the session cookie is HttpOnly, Secure and SameSite=Strict", async ({ page, context }) => {
  await signIn(page);
  const cookie = (await context.cookies()).find((c) => c.name === "__Host-hv_admin");
  expect(cookie).toBeTruthy();
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.secure).toBe(true);
  expect(cookie.sameSite).toBe("Strict");
  expect(cookie.path).toBe("/");
});

test("pages send a locked-down Content-Security-Policy and no-store", async ({ page }) => {
  for (const path of ["/admin", "/privacy"]) {
    const res = await page.goto(path);
    const headers = res.headers();
    expect(headers["content-security-policy"], path).toContain("default-src 'none'");
    expect(headers["content-security-policy"], path).toContain("frame-ancestors 'none'");
    expect(headers["cache-control"], path).toBe("no-store");
    expect(headers["x-content-type-options"], path).toBe("nosniff");
  }
});

test("a signed-in form with a forged CSRF token is refused", async ({ page }) => {
  await signIn(page);
  const row = page.locator("table.recruits tr", { hasText: "Jordan Patel" });
  await row.locator('input[name="csrf"]').evaluateAll((inputs) => inputs.forEach((i) => { i.value = "forged"; }));
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/admin/action")),
    row.getByRole("button", { name: "Resume reports for Jordan Patel" }).click()]);
  expect(res.status()).toBe(403);
  await expect(page.getByRole("heading", { name: "Expired form" })).toBeVisible();
  await page.goto("/admin/history?u=jordan-patel");
  await expect(page.getByText("Resumed reports")).toHaveCount(0);
});

test("HermitShell's API needs its token", async ({ request }) => {
  const res = await request.post("/api/status", { data: { profiles: [] } });
  expect(res.status()).toBe(401);
  const wrong = await request.post("/api/status", { headers: { Authorization: "Bearer wrong" }, data: { profiles: [] } });
  expect(wrong.status()).toBe(401);
});

test("HermitShell's API refuses a copied, altered or replayed request, even with the token", async ({ request }) => {
  const headers = await signedHeaders("GET", "/api/queue/flag");
  const first = await request.get("/api/queue/flag", { headers });
  expect(first.status()).toBe(200);
  expect(first.headers()["x-hermitshell-protocol"]).toBe("2");
  const replayed = await request.get("/api/queue/flag", { headers });
  expect(replayed.status()).toBe(401);
  expect(await replayed.json()).toEqual({ error: "replayed" });
  const altered = await request.get("/api/queue?full=1", { headers: await signedHeaders("GET", "/api/queue/flag") });
  expect(await altered.json()).toEqual({ error: "bad signature" });
  const tokenOnly = await request.get("/api/queue", { headers: { Authorization: `Bearer ${API_TOKEN}` } });
  expect(tokenOnly.status()).toBe(401);
  expect(await tokenOnly.json()).toEqual({ error: "signature required" });
});

test("markup typed into an invite note is shown as text, never run", async ({ page }) => {
  const hostile = `<img src=x onerror="window.pwned=1">`;
  await signIn(page);
  await page.getByPlaceholder("Who it is for (only you see this)").fill(hostile);
  await page.getByRole("button", { name: "Create invite link" }).click();
  await expect(page.getByText(`Send this link to ${hostile}`, { exact: false })).toBeVisible();
  await page.goto("/admin");
  await expect(page.getByText(hostile)).toBeVisible();
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});

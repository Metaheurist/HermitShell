import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

import { hermitShellApi, hermitShellStatus, hermitShellUpload, reportStatus, signIn } from "./fixtures.js";

const PART = 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// What maintenance.send_offsite sends: an encrypted backup (HSEAL1 and random bytes stand in for it), part by part.
async function sendBackup(request, name, size) {
  const data = Buffer.concat([Buffer.from("HSEAL1"), randomBytes(size - 6)]);
  const n = Math.ceil(size / PART);
  for (let i = 0; i < n; i++) {
    const res = await hermitShellUpload(request, `/api/backup/part?${new URLSearchParams({ name, i: String(i), n: String(n), sha: sha256(data) })}`,
      data.subarray(i * PART, (i + 1) * PART));
    expect(res.status()).toBe(200);
  }
  return data;
}

test("HermitShell's backup goes up in parts and comes back the same, in the real Durable Object", async ({ request }) => {
  const name = `hermitshell-20261002-${String(Date.now() % 1e6).padStart(6, "0")}.tar.gz.enc`;
  const data = await sendBackup(request, name, 2 * PART + 4321);
  const listed = (await (await hermitShellApi(request, "GET", "/api/backups")).json()).backups.find((b) => b.name === name);
  expect(listed).toMatchObject({ parts: 3, size: data.length, sha: sha256(data) });
  const parts = [];
  for (let i = 0; i < 3; i++) parts.push(await (await hermitShellApi(request, "GET", `/api/backup/part?name=${name}&i=${i}`)).body());
  expect(sha256(Buffer.concat(parts))).toBe(sha256(data));
  const plain = await hermitShellUpload(request, `/api/backup/part?name=hermitshell-20261002-000001.tar.gz.enc&i=0&n=1&sha=${"0".repeat(64)}`,
    Buffer.from("a plain archive"));
  expect(plain.status()).toBe(400);
  expect((await request.get("/api/backups")).status()).toBe(401);
  const gone = await hermitShellApi(request, "POST", "/api/backup/delete", { name });
  expect(await gone.json()).toEqual({ deleted: true });
});

test("an admin follows the server panel to the backups on Cloudflare and downloads one", async ({ page, request }) => {
  const name = `hermitshell-20261001-${String(Date.now() % 1e6).padStart(6, "0")}.tar.gz.enc`;
  const data = await sendBackup(request, name, PART + 999);
  await reportStatus(request, { ...hermitShellStatus(), backup: { at: Date.now() - 3600000, size: data.length, kept: 9, error: "",
    failed_at: null, encrypted: true, offsite: { on: true, why: "", at: Date.now() - 3600000, kept: 7, error: "", failed_at: null } } });
  await signIn(page);
  await page.locator(".srv").focus();
  const panel = page.locator(".srvpanel");
  await expect(panel).toContainText("On Cloudflare too: last sent 1 hour ago · 7 kept");
  await panel.getByRole("link", { name: "Download" }).click();
  await expect(page).toHaveURL(/\/admin\/backups$/);
  await expect(page.getByRole("heading", { name: "Backups on Cloudflare" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("1.0 MB");
  const [download] = await Promise.all([page.waitForEvent("download"), row.getByRole("link", { name: "Download" }).click()]);
  expect(download.suggestedFilename()).toBe(name);
  expect(sha256(await readFile(await download.path()))).toBe(sha256(data));
  await hermitShellApi(request, "POST", "/api/backup/delete", { name });
});

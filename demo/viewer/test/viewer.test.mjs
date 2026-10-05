// The viewer's guards: files only from inside /out and the page folder, and POST /run only in test mode, same-origin
// and as JSON. Run with: node --test demo/viewer/test/viewer.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { inside, sameOrigin, start } from "../server.mjs";

test("inside keeps paths in their folder", () => {
  const root = mkdtempSync(join(tmpdir(), "viewer-"));
  assert.equal(inside(root, "run/report/index.html"), join(root, "run", "report", "index.html"));
  for (const bad of ["../secret", "..%2Fsecret", "%2e%2e/%2e%2e/etc/passwd", "a/../../b", "%00", "%E0%A4%A"]) {
    const got = inside(root, bad);
    assert.ok(got === null || got.startsWith(root), `${bad} escaped: ${got}`);
  }
  assert.equal(inside(root, "..%2Fsecret"), null);
});

test("sameOrigin needs an Origin matching the Host", () => {
  assert.equal(sameOrigin({ headers: { host: "localhost:8080", origin: "http://localhost:8080" } }), true);
  assert.equal(sameOrigin({ headers: { host: "localhost:8080", origin: "http://evil.example" } }), false);
  assert.equal(sameOrigin({ headers: { host: "localhost:8080" } }), false);
  assert.equal(sameOrigin({ headers: { host: "localhost:8080", origin: "null" } }), false);
});

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function serve(mode, onRun) {
  const out = mkdtempSync(join(tmpdir(), "viewer-out-"));
  writeFileSync(join(out, "findings.md"), "# findings\n");
  const port = 18000 + Math.floor(Math.random() * 1000);
  servers.push(start({ mode, port, internalPort: port + 1000, out, journeys: ["setup", "team"], onRun }));
  await new Promise((r) => setTimeout(r, 100));
  return `http://127.0.0.1:${port}`;
}

test("the page, its files and the report folder are served with security headers", async () => {
  const base = await serve("autorun", null);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await fetch(`${base}/out/findings.md`)).status, 200);
  assert.equal((await fetch(`${base}/out/..%2F..%2Fetc%2Fpasswd`)).status, 404);
  assert.equal((await fetch(`${base}/..%2Fserver.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/run`, { method: "POST" })).status, 404);
});

test("POST /run is test mode only, same-origin and JSON", async () => {
  const runs = [];
  const base = await serve("test", async (only) => { runs.push(only); return true; });
  const host = new URL(base).host;
  const post = (headers, body = "{}") => fetch(`${base}/run`, { method: "POST", headers, body });
  assert.equal((await post({ "content-type": "application/json" })).status, 403);
  assert.equal((await post({ "content-type": "application/json", origin: "http://evil.example" })).status, 403);
  assert.equal((await post({ "content-type": "text/plain", origin: `http://${host}` })).status, 403);
  const ok = await post({ "content-type": "application/json", origin: `http://${host}` }, JSON.stringify({ only: ["team", "rm -rf"] }));
  assert.equal(ok.status, 202);
  assert.deepEqual(runs, [["team"]]);
});

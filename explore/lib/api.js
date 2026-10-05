// Calls to the Worker from the runner: plain https with the test CA, and HermitShell's signed API (read-only use:
// the runner never posts /api/status, which would replace the real backend's report).

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:https";

import { CA_FILE, TARGET, loadEnv } from "./config.js";
import { PROTOCOL, signature } from "../../packages/daily-vacancy-report/feedback-worker/src/apiauth.js";

const ca = () => (existsSync(CA_FILE) ? readFileSync(CA_FILE) : undefined);

// A small https client that trusts the test CA: { status, headers, body }.
export function fetchTarget(path, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(path, TARGET);
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, ca: ca(), timeout: 20000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout on ${url.pathname}`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function signedApi(method, path, data) {
  const env = loadEnv();
  const body = data === undefined ? "" : JSON.stringify(data);
  const bytes = body ? new TextEncoder().encode(body) : null;
  const stamp = Date.now();
  const nonce = randomBytes(16).toString("hex");
  const mac = await signature(env.EXPLORE_LINK_SECRET, method, path, stamp, nonce, bytes);
  const headers = { Authorization: `Bearer ${env.EXPLORE_API_TOKEN}`, "X-HermitShell-Protocol": String(PROTOCOL),
    "X-HermitShell-Time": String(stamp), "X-HermitShell-Nonce": nonce, "X-HermitShell-Signature": `v1=${mac}`,
    ...(bytes ? { "Content-Type": "application/json" } : {}) };
  const res = await fetchTarget(path, { method, headers, body: bytes ? Buffer.from(bytes) : undefined });
  if (res.status >= 400) throw new Error(`${method} ${path} answered ${res.status}`);
  return JSON.parse(res.body.toString("utf8") || "{}");
}

// What is still waiting for HermitShell (the items, without their sealed contents).
export async function queued() {
  const { items = [] } = await signedApi("GET", "/api/queue?full=1");
  return items;
}

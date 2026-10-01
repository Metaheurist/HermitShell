// Shared settings and helpers for the Playwright tests. Everything here is made up: the Worker runs locally
// under `wrangler dev` with these throwaway secrets and an empty local KV.

import { PROTOCOL, signature } from "../src/apiauth.js";
import { sign, today } from "../src/lib.js";
import { sealingKeys } from "../test/helpers.js";

export const PORT = 8787;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const LINK_SECRET = "e2e-link-secret";
export const API_TOKEN = "e2e-api-token";
export const ADMIN_PASSWORD = "e2e-admin-password";
export const RECRUITER = { name: "Riley Chen", username: "riley", password: "e2e-recruiter-password" };
export const JOB_TITLE = "Data Engineer (Python, Airflow) at Northwind Traders";

const DAY = 86400000;
const JOB = { titles: ["Data Engineer", "Analytics Engineer"], region: "Greater Manchester", places: ["Manchester", "Salford"],
  country: "gb", remote_anywhere: true, level: "mid", types: ["Permanent"], modes: ["Hybrid", "Remote"], min_salary: "45000",
  currency: "GBP", hide_agency: true };

function person(id, name, email, location, extra = {}) {
  const now = Date.now();
  return { id, name, email, status: "active", has_cv: true, created: now - 30 * DAY, last_run: now - 3 * 3600000,
    details: { name, email, phone: "", location }, job: JOB,
    report: { time: "08:00", days: "daily", schedule: "0 8 * * *", job: true, pending: false }, ...extra };
}

// What HermitShell reports every few minutes (profiles.py): the main admin as a staff row, whose own job search
// HermitShell moved to the recruit Drew Harper, and three more fictional recruits.
export function hermitShellStatus({ samRecruiter = "" } = {}) {
  return {
    protocol: PROTOCOL,
    profiles: [
      { id: "owner", name: "Alex Morgan", email: "alex.morgan@example.com", status: "active", owner: true, recruiter: "", has_cv: false,
        recruit: "drew-harper", created: Date.now() - 30 * DAY },
      person("drew-harper", "Drew Harper", "drew.harper@example.com", "Salford"),
      person("sam-lee", "Sam Lee", "sam.lee@example.com", "York", { recruiter: samRecruiter }),
      person("jordan-patel", "Jordan Patel", "jordan.patel@example.net", "Leeds", { status: "paused" }),
    ],
    scheduler: true,
    timezone: "Europe/London",
    email: { host: "smtp.example.com", port: "587", user: "alex.morgan@example.com", from: "", password_set: true, source: "dashboard" },
    keys: { firecrawl: { source: "none", hint: "" }, tavily: { source: "none", hint: "" }, scrapfly: { source: "none", hint: "" } },
    models: {
      openrouter: { source: "env", hint: "sk-...0e2e", model: "openrouter/free", today: 7, resting_until: null, why: "",
        keys: [{ hint: "sk-...0e2e", role: "main", at: Date.now() - 60000,
          usage: { used: 7, limit: 50, left: 43, plan: "Free models", resets: "", unit: "requests" } }] },
      bazaarlink: { source: "none", hint: "" }, featherless: { source: "none", hint: "" }, huggingface: { source: "none", hint: "" },
    },
    llm: { order: "cloud", cloud: ["openrouter"], local: { model: "qwen3:4b-instruct-2507-q4_K_M", suggested: "qwen3:4b-instruct-2507-q4_K_M",
      where: "8192 context, on the CPU" }, last: { provider: "openrouter", model: "openrouter/free", at: Date.now() - 120000 } },
    server: { cpu: { model: "Contoso Server CPU", cores: 8 }, load: 1.2, ram_mb: { total: 16384, available: 9000 }, gpus: [],
      disk_mb: { total: 500000, free: 200000 } },
    problems: [],
    tasks: [],
    features: { alerts: true },
  };
}

let keys;
// This test process's sealing key pair; the Worker seals for whichever process reported its status last.
export async function sealing() {
  keys ??= await sealingKeys();
  return keys;
}

// The headers common/worker_link.py sends: the token, the protocol and a fresh signature.
export async function signedHeaders(method, path, body = "") {
  const stamp = Date.now();
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const bytes = typeof body === "string" ? (body ? new TextEncoder().encode(body) : null) : body;
  const type = typeof body === "string" ? "application/json" : "application/octet-stream";
  const mac = await signature(LINK_SECRET, method, path, stamp, nonce, bytes);
  return { Authorization: `Bearer ${API_TOKEN}`, "X-HermitShell-Protocol": String(PROTOCOL), "X-HermitShell-Time": String(stamp),
    "X-HermitShell-Nonce": nonce, "X-HermitShell-Signature": `v1=${mac}`, ...(bytes ? { "Content-Type": type } : {}) };
}

// A call to HermitShell's API, signed as HermitShell signs it.
export async function hermitShellApi(request, method, path, data) {
  const body = data === undefined ? "" : JSON.stringify(data);
  return request.fetch(path, { method, headers: await signedHeaders(method, path, body), ...(body ? { data: body } : {}) });
}

// A document upload (POST /api/doc and the like), its bytes signed as HermitShell signs them.
export async function hermitShellUpload(request, path, bytes) {
  return request.fetch(path, { method: "POST", headers: await signedHeaders("POST", path, bytes), data: Buffer.from(bytes) });
}

export async function reportStatus(request, status = hermitShellStatus()) {
  const res = await hermitShellApi(request, "POST", "/api/status", { ...status, seal: (await sealing()).seal });
  if (!res.ok()) throw new Error(`/api/status answered ${res.status()}`);
}

export async function signIn(page, username = "admin", password = ADMIN_PASSWORD) {
  await page.goto("/admin");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

// An email button's link, signed the way job_tracker.sign() signs it in HermitShell.
export async function emailLink(action, title, { job = "job-northwind-data-engineer", profile = "", day = today() } = {}) {
  const params = { j: job, a: action, n: title };
  if (profile) params.u = profile;
  params.d = String(day);
  params.t = await sign(LINK_SECRET, job, action, title, "", profile, params.d);
  return `/f?${new URLSearchParams(params)}`;
}

// A document's width beyond its window, in pixels; 0 when nothing scrolls sideways.
export function sidewaysOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

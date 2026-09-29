// Writes every feedback Worker page as a static HTML file, using fictional profiles and an in-memory KV.
// Usage: node scripts/screenshots/worker_pages.mjs <output dir>   (called by make.py)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import worker from "../../packages/daily-vacancy-report/feedback-worker/src/index.js";
import { LINK_DAYS, sign, today } from "../../packages/daily-vacancy-report/feedback-worker/src/lib.js";

const BASE = "https://vacancy-feedback.example.workers.dev";
const SECRET = "docs-secret";
const TOKEN = "docs-token";
const PASSWORD = "docs-password";
const out = process.argv[2] || "screenshots-out/worker";
mkdirSync(out, { recursive: true });

function memoryKV() {
  const store = new Map();
  return {
    async put(key, value) { store.set(key, value); },
    async get(key, type) {
      const value = store.get(key);
      if (value == null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async list({ prefix, limit = 1000 }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })) };
    },
    async delete(key) { store.delete(key); },
  };
}

function freshEnv(extra = {}) {
  return { FEEDBACK: memoryKV(), JOB_FEEDBACK_SECRET: SECRET, JOB_FEEDBACK_API_TOKEN: TOKEN, ADMIN_PASSWORD: PASSWORD, ...extra };
}

let env = freshEnv();

async function call(path, { method = "GET", form, json, headers = {} } = {}) {
  const init = { method, headers: { "CF-Connecting-IP": "203.0.113.7", ...headers } };
  if (form) init.body = form instanceof FormData ? form : new URLSearchParams(form);
  if (json) {
    init.body = JSON.stringify(json);
    init.headers["Content-Type"] = "application/json";
  }
  return worker.fetch(new Request(`${BASE}${path}`, init), env, {});
}

async function save(name, response) {
  writeFileSync(join(out, `${name}.html`), await response.text());
}

async function link(action, title, { skills = "", profile = "", day = today(), job = "job-northwind-data-engineer" } = {}) {
  const params = { j: job, a: action, n: title };
  if (skills) params.s = skills;
  if (profile) params.u = profile;
  params.d = String(day);
  params.t = await sign(SECRET, job, action, title, skills, profile, params.d);
  return params;
}

const TITLE = "Data Engineer (Python, Airflow) at Northwind Traders";
const SKILLS = "Kubernetes|Terraform|Snowflake";

// Button confirmation pages, one per action.
for (const action of ["good_match", "not_for_me", "interested", "applied", "heard_back", "rejected", "cover_letter", "tailored_cv"]) {
  await save(`confirm-${action.replaceAll("_", "-")}`, await call(`/f?${new URLSearchParams(await link(action, TITLE))}`));
}
await save("confirm-add-skill", await call(`/f?${new URLSearchParams({ ...(await link("add_skill", TITLE, { skills: SKILLS })), p: "Terraform" })}`));
await save("confirm-unsubscribe", await call(`/f?${new URLSearchParams(await link("unsubscribe", "Sam Lee", { job: "profile", profile: "sam-lee" }))}`));
await save("confirm-unsubscribe-owner", await call(`/f?${new URLSearchParams(await link("unsubscribe", "you", { job: "profile-pause" }))}`));

// What each Confirm press shows.
await save("saved", await call("/f", { method: "POST", form: { ...(await link("good_match", TITLE)), r: "Right stack and hybrid" } }));
await save("saved-cover-letter", await call("/f", { method: "POST", form: { ...(await link("cover_letter", TITLE)), r: "" } }));
await save("saved-tailored-cv", await call("/f", { method: "POST", form: { ...(await link("tailored_cv", TITLE)), r: "" } }));
const skillForm = new URLSearchParams({ ...(await link("add_skill", TITLE, { skills: SKILLS })), o: "dbt Cloud" });
skillForm.append("k", "Terraform");
await save("saved-add-skill", await call("/f", { method: "POST", form: skillForm }));
await save("saved-nothing-selected", await call("/f", { method: "POST", form: await link("add_skill", TITLE, { skills: SKILLS }) }));
await save("saved-unsubscribe", await call("/f", { method: "POST", form: { ...(await link("unsubscribe", "Sam Lee", { job: "profile", profile: "sam-lee" })), r: "" } }));

await save("privacy", await call("/privacy"));

// Link problems.
await save("link-invalid", await call(`/f?${new URLSearchParams({ ...(await link("interested", TITLE)), n: "Changed title" })}`));
await save("link-expired", await call(`/f?${new URLSearchParams(await link("interested", TITLE, { day: today() - LINK_DAYS - 1 }))}`));
env = freshEnv();

// HermitShell reports its profiles (what profiles.py sends every few minutes).
const now = Date.now();
const day = 86400000;
const JOB = { titles: ["Data Engineer", "Analytics Engineer", "Python Developer"], region: "Greater Manchester",
  places: ["Manchester", "Salford", "Stockport", "Trafford"], country: "gb", remote_anywhere: true,
  level: "mid", types: ["Permanent", "Contract"], modes: ["Hybrid", "Remote"], min_salary: "45000", currency: "£", hide_agency: true };
const STATUS = {
  profiles: [
    { id: "owner", name: "Alex Morgan", email: "alex.morgan@example.com", status: "active", owner: true, crawler: "global",
      has_cv: true, created: now - 60 * day, last_run: now - 3 * 3600000, cv_updated: now - 20 * day,
      details: { name: "Alex Morgan", email: "alex.morgan@example.com", phone: "07700 900123", location: "Salford" }, job: JOB },
    { id: "sam-lee", name: "Sam Lee", email: "sam.lee@example.com", status: "active", crawler: "own", key_hint: "fc-...9d2a",
      has_cv: true, created: now - 12 * day, last_run: now - 3 * 3600000,
      details: { name: "Sam Lee", email: "sam.lee@example.com", phone: "", location: "York" },
      job: { ...JOB, titles: ["Data Analyst", "BI Developer"], region: "North Yorkshire", places: ["York", "Harrogate"] } },
    { id: "jordan-patel", name: "Jordan Patel", email: "jordan.patel@example.net", status: "paused", crawler: "global",
      has_cv: true, created: now - 30 * day, last_run: now - 9 * day,
      details: { name: "Jordan Patel", email: "jordan.patel@example.net", phone: "", location: "Leeds" }, job: JOB },
  ],
  email: { host: "smtp.gmail.com", port: "587", user: "alex.morgan@example.com", from: "", password_set: true,
    source: "dashboard", last_test: { at: now - 2 * day, ok: true, to: "alex.morgan@example.com", error: "" } },
  keys: { firecrawl: { source: "env", hint: "fc-...41b7", backups: 1 }, tavily: { source: "dashboard", hint: "tvly...8c1e" },
    scrapfly: { source: "none", hint: "" } },
  problems: [],
  timezone: "Europe/London",
};
await call("/api/status", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, json: STATUS });
await save("link-profile-removed", await call(`/f?${new URLSearchParams(await link("interested", TITLE, { profile: "casey-quinn" }))}`));

// Invite sign-up.
const invite = await (await call("/api/invite", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, json: { note: "Riley from the meetup" } })).json();
const inviteId = new URL(invite.link).searchParams.get("i");
await save("join-form", await call(`/join?i=${inviteId}`));
const partial = new FormData();
for (const [k, v] of Object.entries({ i: inviteId, name: "Riley Chen", email: "riley.chen@example.com", roles: "Data analyst or BI developer, hybrid", consent: "yes" })) partial.append(k, v);
await save("join-error", await call(`/join?i=${inviteId}`, { method: "POST", form: partial }));
const full = new FormData();
for (const [k, v] of Object.entries({ i: inviteId, name: "Riley Chen", email: "riley.chen@example.com", location: "Manchester",
  roles: "Data analyst or BI developer, hybrid", consent: "yes" })) full.append(k, v);
full.append("cv", new File(["Riley Chen\nData analyst with four years of SQL, Power BI and Python experience.\n".repeat(6)], "riley-chen-cv.txt", { type: "text/plain" }));
await save("join-thanks", await call(`/join?i=${inviteId}`, { method: "POST", form: full }));
await save("join-expired", await call(`/join?i=${inviteId}`));

// Admin sign-in.
await save("admin-login", await call("/admin"));
await save("admin-login-wrong", await call("/admin/login", { method: "POST", form: { username: "admin", password: "wrong" } }));
const login = await call("/admin/login", { method: "POST", form: { username: "admin", password: PASSWORD } });
const cookie = (login.headers.get("Set-Cookie") || "").split(";")[0];
const admin = (path, options = {}) => call(path, { ...options, headers: { Cookie: cookie, ...(options.headers || {}) } });
const dashboard = await (await admin("/admin")).text();
const csrf = dashboard.match(/name="csrf" value="([^"]+)"/)[1];
await call("/api/invite", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, json: { note: "Taylor, former colleague" } });
await save("admin-invite-link", await admin("/admin/action", { method: "POST", form: { csrf, action: "invite", note: "Casey from the course" } }));
await admin("/admin/action", { method: "POST", form: { csrf, action: "resume", u: "jordan-patel" } });
await save("admin-dashboard", await admin("/admin?done=queued"));
await save("admin-profile", await admin("/admin/profile?u=owner"));
await save("admin-settings", await admin("/admin/settings"));

// A fresh install: HermitShell has connected, nothing else is set yet.
const fresh = { ...STATUS, profiles: [{ ...STATUS.profiles[0], has_cv: false, job: { ...JOB, titles: [], region: "", places: [] } }],
  email: { host: "smtp.gmail.com", port: "587", user: "", from: "", password_set: false, source: "none", last_test: null },
  keys: { firecrawl: { source: "none", hint: "" }, tavily: { source: "none", hint: "" }, scrapfly: { source: "none", hint: "" } },
  problems: [{ at: now - 600000, what: "email", error: "invalid email server settings" }] };
await call("/api/status", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, json: fresh });
await save("admin-dashboard-setup", await admin("/admin"));
await call("/api/status", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, json: STATUS });

for (let i = 0; i < 5; i++) await call("/admin/login", { method: "POST", form: { username: "admin", password: `wrong-${i}` } });
await save("admin-locked", await call("/admin/login", { method: "POST", form: { username: "admin", password: "wrong" } }));

env = freshEnv();
await save("admin-dashboard-empty", await call("/admin").then(async () => {
  const again = await call("/admin/login", { method: "POST", form: { username: "admin", password: PASSWORD } });
  return call("/admin", { headers: { Cookie: (again.headers.get("Set-Cookie") || "").split(";")[0] } });
}));
env = freshEnv({ ACCESS_AUD: "docs-aud" });
await save("admin-access-required", await call("/admin"));

console.log(`Worker pages written to ${out}`);

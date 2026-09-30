// Writes every feedback Worker page as a static HTML file, using fictional profiles and an in-memory KV.
// Usage: node scripts/screenshots/worker_pages.mjs <output dir>   (called by make.py)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import worker from "../../packages/daily-vacancy-report/feedback-worker/src/index.js";
import { LINK_DAYS, sign, today } from "../../packages/daily-vacancy-report/feedback-worker/src/lib.js";
import { jobHash } from "../../packages/daily-vacancy-report/feedback-worker/src/docs.js";
import { zonedToday } from "../../packages/daily-vacancy-report/feedback-worker/src/stats.js";

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

// The live link's Durable Object, as it answers while HermitShell is connected.
const LIVE_HUB = {
  idFromName: (name) => name,
  get: () => ({ fetch: async (url) => Response.json(String(url).endsWith("/presence") ? { live: true, seen: Date.now() } : { sent: 1 }) }),
};

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

// A profile page with its save-status frame inlined, since the screenshots open the pages as files.
async function framed(response, get) {
  const html = await response.text();
  const src = html.match(/<iframe class="saving" src="([^"]+)"/)?.[1];
  if (!src) return new Response(html);
  const box = (await (await get(src.replaceAll("&amp;", "&"))).text()).replace(/<meta http-equiv="refresh"[^>]*>/, "");
  const escaped = box.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return new Response(html.replace(`src="${src}"`, `srcdoc="${escaped}"`));
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
env = freshEnv({ HUB: LIVE_HUB });

// HermitShell reports its profiles (what profiles.py sends every few minutes).
const now = Date.now();
const day = 86400000;
const JOB = { titles: ["Data Engineer", "Analytics Engineer", "Python Developer"], region: "Greater Manchester",
  places: ["Manchester", "Salford", "Stockport", "Trafford"], country: "gb", remote_anywhere: true,
  level: "mid", types: ["Permanent", "Contract"], modes: ["Hybrid", "Remote"], min_salary: "45000", currency: "GBP", hide_agency: true };
const STATUS = {
  profiles: [
    { id: "owner", name: "Alex Morgan", email: "alex.morgan@example.com", status: "active", owner: true,
      has_cv: true, created: now - 60 * day, last_run: now - 3 * 3600000, cv_updated: now - 20 * day,
      details: { name: "Alex Morgan", email: "alex.morgan@example.com", phone: "07700 900123", location: "Salford" }, job: JOB,
      report: { time: "08:00", days: "daily", schedule: "0 8 * * *", job: true, pending: false } },
    { id: "sam-lee", name: "Sam Lee", email: "sam.lee@example.com", status: "active", recruiter: "casey",
      has_cv: true, created: now - 12 * day, last_run: now - 3 * 3600000, scanning: now - 4 * 60000,
      details: { name: "Sam Lee", email: "sam.lee@example.com", phone: "", location: "York" },
      job: { ...JOB, titles: ["Data Analyst", "BI Developer"], region: "North Yorkshire", places: ["York", "Harrogate"] },
      report: { time: "08:15", days: "weekdays", schedule: "15 8 * * 1-5", job: true, pending: false } },
    { id: "jordan-patel", name: "Jordan Patel", email: "jordan.patel@example.net", status: "paused", recruiter: "admin",
      has_cv: true, created: now - 30 * day, last_run: now - 9 * day,
      details: { name: "Jordan Patel", email: "jordan.patel@example.net", phone: "", location: "Leeds" }, job: JOB,
      report: { time: "08:30", days: "daily", schedule: "30 8 * * *", job: true, pending: false } },
  ],
  scheduler: true,
  email: { host: "smtp.gmail.com", port: "587", user: "alex.morgan@example.com", from: "", password_set: true,
    source: "dashboard", last_test: { at: now - 2 * day, ok: true, to: "alex.morgan@example.com", error: "" } },
  keys: { firecrawl: { source: "env", hint: "fc-...41b7", backups: 1 }, tavily: { source: "dashboard", hint: "tvly...8c1e" },
    scrapfly: { source: "none", hint: "" } },
  problems: [],
  timezone: "Europe/London",
  tasks: [
    { id: "report:sam-lee", kind: "report", u: "sam-lee", state: "running", at: now - 4 * 60000, trigger: "schedule",
      stage: "Rating jobs", done: 14, total: 25, expected: 18 * 60000 },
    { id: "letter:owner:event:_:5f0c2a9e1b7d4c3a8e6f0b2d4a6c8e1f:1a2b3c4d5e6f", kind: "cover_letter", u: "owner", state: "running",
      at: now - 90000, trigger: "email", title: "Data Engineer (Python, Airflow)", employer: "Northwind Traders", retry: false },
    { id: "letter:owner:event:_:7d1e3b5c9a2f4e6d8c0b1a3e5d7f9c2b:6f5e4d3c2b1a", kind: "tailored_cv", u: "owner", state: "waiting",
      at: now - 60000, trigger: "email", title: "Analytics Engineer (dbt, Snowflake)", employer: "Contoso", retry: false },
  ],
};
await call("/api/status", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, json: STATUS });

// What each job's email card showed, sent with the jobs sent list.
const MORE = [
  { company: "Contoso Recruitment", type: "Permanent", seniority: "Senior", published: "2 days ago",
    closing: new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10), confidence: 85, coverage: 78,
    reasoning: "Strong overlap: five years of Python and Airflow pipelines, dbt models and AWS match the core of the role. "
      + "The advert asks for Kubernetes, which the CV does not show.",
    about: "Build and run the batch and streaming pipelines behind Northwind's pricing and logistics data, working with "
      + "analysts and the platform team.",
    profile: "Wholesale food distributor, 2,000 staff", site: "https://northwind.example",
    matched: ["Python", "Airflow", "SQL", "dbt", "AWS", "Docker"], gaps: ["Kubernetes", "Terraform"] },
  { type: "Permanent", seniority: "Mid", published: "today", confidence: 80, coverage: 70,
    reasoning: "dbt and Snowflake experience lines up with the modelling work described.",
    matched: ["dbt", "Snowflake", "SQL"], gaps: ["Looker"] },
];

// Stats HermitShell sends for each profile (profile_stats.py): made-up daily counts, the same every time.
function fakeStats(daysBack, scale, seed) {
  let x = seed;
  const rand = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const end = Date.parse(`${zonedToday("Europe/London")}T00:00:00Z`);
  const days = {};
  for (let i = daysBack - 1; i >= 0; i--) {
    const iso = new Date(end - i * day).toISOString().slice(0, 10);
    const weekend = [0, 6].includes(new Date(end - i * day).getUTCDay());
    const growth = 0.7 + 0.5 * (1 - i / daysBack);
    const rated = Math.round((weekend ? 5 : 13) * scale * growth * (0.6 + rand() * 0.8));
    const sent = Math.round(rated * (0.35 + rand() * 0.25));
    const pick = (p) => (rand() < p ? 1 + (rand() < p / 3 ? 1 : 0) : 0);
    days[iso] = [Math.round(rated * (7 + rand() * 5)), rated, sent, Math.round(sent * (6.3 + rand() * 1.6)), sent,
      Math.round(sent * rand() * 0.45), 1, pick(0.4), pick(0.25), pick(0.3), pick(0.16), pick(0.06), pick(0.05),
      pick(0.1), pick(0.05), pick(0.06)];
  }
  const range = (n) => ({
    employers: [["Northwind Traders", 9], ["Contoso", 7], ["Fabrikam", 6], ["Adventure Works", 4], ["Tailspin Toys", 3]].map(([e, c]) => [e, Math.ceil(c * n / 30)]),
    sources: [["uk.indeed.com", 21], ["reed.co.uk", 14], ["web search", 11], ["cv-library.co.uk", 6], ["jobs.ac.uk", 3]].map(([s, c]) => [s, Math.ceil(c * n / 30)]),
    modes: [["Hybrid", 18], ["Remote", 9], ["On-site", 5]].map(([m, c]) => [m, Math.ceil(c * n / 30)]),
    fit: [0, 1, 3, 6, 11, 19, 27, 31, 18, 7, 2].map((c) => Math.ceil(c * n / 30)),
    salary: 52000,
    best: [{ title: "Senior Data Engineer (Python, Airflow)", employer: "Northwind Traders", fit: 9, day: new Date(end - 2 * day).toISOString().slice(0, 10) },
      { title: "Analytics Engineer (dbt, Snowflake)", employer: "Contoso", fit: 9, day: new Date(end - 5 * day).toISOString().slice(0, 10) },
      { title: "Data Platform Engineer", employer: "Fabrikam", fit: 8, day: new Date(end - 9 * day).toISOString().slice(0, 10) }],
  });
  const JOBS = [
    ["Senior Data Engineer (Python, Airflow)", "Northwind Traders", "York", "Hybrid", "£60,000 - £70,000", 9, "reed.co.uk", "applied"],
    ["Analytics Engineer (dbt, Snowflake)", "Contoso", "Leeds", "Remote", "£55,000", 9, "uk.indeed.com", "heard_back"],
    ["Data Platform Engineer", "Fabrikam", "Harrogate", "Hybrid", "", 8, "web search", "interested"],
    ["Data Engineer", "Adventure Works", "York", "On-site", "£48,000 - £52,000", 8, "cv-library.co.uk", ""],
    ["BI Developer (Power BI)", "Tailspin Toys", "Selby", "Hybrid", "£45,000", 7, "reed.co.uk", "good_match"],
    ["Machine Learning Engineer", "Contoso", "Remote (UK)", "Remote", "", 7, "uk.indeed.com", ""],
    ["Data Analyst", "Northwind Traders", "Wakefield", "Hybrid", "£38,000", 6, "jobs.ac.uk", "not_for_me"],
    ["Cloud Data Engineer (Azure)", "Fabrikam", "Dublin", "Remote", "£55,700 - £64,300 a year", 8, "web search", ""],
    ["Lead Data Engineer", "Adventure Works", "York", "Hybrid", "£75,000", 7, "reed.co.uk", "rejected"],
  ];
  const sent = JOBS.map(([title, employer, location, mode, salary, fit, source, answer], i) => ({
    title, employer, location, mode, salary, fit, source, answer,
    day: new Date(end - [0, 0, 0, 1, 1, 2, 4, 5, 8][i] * day).toISOString().slice(0, 10),
    url: i % 4 === 3 ? "" : `https://jobs.example.com/ad/${1000 + i}`, key: `https://jobs.example.com/ad/${1000 + i}`,
    more: MORE[i] || { type: "Permanent", confidence: 70, matched: ["Python", "SQL"], gaps: ["Kubernetes"] } }));
  return { v: 1, today: new Date(end).toISOString().slice(0, 10), since: new Date(end - (daysBack - 1) * day).toISOString().slice(0, 10), days,
    ranges: { 7: range(7), 30: range(30), 90: range(90), 365: range(365) },
    pipeline: { interested: 9, good_match: 4, not_for_me: 12, applied: 6, heard_back: 3, rejected: 2 }, sent };
}
for (const [u, stats] of [["owner", fakeStats(75, 1, 7)], ["sam-lee", fakeStats(12, 0.6, 11)]]) {
  await call("/api/stats", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, json: { u, stats } });
}
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
// Dashboard users: Casey Quinn recruits Sam Lee, Drew Harper is a second admin, and the main admin
// (Alex Morgan) also has the Recruiter role, with Jordan Patel in their pool.
await admin("/admin/users", { method: "POST", form: { csrf, op: "admin_roles", roles: "recruiter" } });
await admin("/admin/users", { method: "POST", form: { csrf, op: "add", name: "Casey Quinn", username: "casey", password: "docs-recruiter-password", roles: "recruiter" } });
await admin("/admin/users", { method: "POST", form: { csrf, op: "add", name: "Drew Harper", username: "drew", password: "docs-pw", roles: "admin" } });
const caseyLogin = await call("/admin/login", { method: "POST", form: { username: "casey", password: "docs-recruiter-password" } });
const caseyCookie = (caseyLogin.headers.get("Set-Cookie") || "").split(";")[0];
const casey = (path, options = {}) => call(path, { ...options, headers: { Cookie: caseyCookie, ...(options.headers || {}) } });
const caseyCsrf = (await (await casey("/admin")).text()).match(/name="csrf" value="([^"]+)"/)[1];
await casey("/admin/action", { method: "POST", form: { csrf: caseyCsrf, action: "invite", note: "Morgan, met at the careers fair" } });
await call("/api/invite", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, json: { note: "Taylor, former colleague" } });
await save("admin-invite-link", await admin("/admin/action", { method: "POST", form: { csrf, action: "invite", note: "Jamie from the course" } }));
await admin("/admin/action", { method: "POST", form: { csrf, action: "resume", u: "jordan-patel" } });
await call("/f", { method: "POST", form: { ...(await link("tailored_cv", "BI Developer at Fabrikam", { profile: "sam-lee" })), r: "" } });
await save("admin-dashboard", await admin("/admin?done=queued"));
// The Tasks modal, open, with its self-refreshing list inlined (opened as files, pages get no #tasks fragment).
const tasksList = (await (await admin("/admin/tasks")).text()).replace(/<meta http-equiv="refresh"[^>]*>/, "");
const withTasks = (await (await admin("/admin")).text()).replace("</head>", "<style>#tasks{display:grid}</style></head>")
  .replace('src="/admin/tasks" loading="lazy"', `srcdoc="${tasksList.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`);
await save("admin-tasks", new Response(withTasks));
await save("admin-dashboard-search", await admin("/admin?q=york"));
await save("admin-recruiter-search", await admin("/admin?q=casey"));
await save("admin-recruiter-view", await casey("/admin"));
await save("admin-signed-in", await casey("/admin"));
await save("admin-users", await admin("/admin/users"));
// Opened as files, pages cannot be given the fragment that opens a modal, so it is opened with a style.
const withOpenModal = async (path, id, as = admin) => new Response((await (await as(path)).text()).replace("</head>", `<style>#${id}{display:grid}</style></head>`));
await save("admin-user-modal", await withOpenModal("/admin/users", "user-new"));
await save("admin-user-reset-modal", await withOpenModal("/admin/users", "reset-casey"));
await save("admin-password-modal", await withOpenModal("/admin", "password", casey));
await save("admin-delete-modal", await withOpenModal("/admin", "del-jordan-patel"));
await save("admin-global-key-modal", await withOpenModal("/admin/settings", "gkey-scrapfly"));
await save("admin-profile", await framed(await admin("/admin/profile?u=owner"), admin));
await save("admin-profile-scanning", await framed(await admin("/admin/profile?u=sam-lee"), admin));
await save("admin-settings", await admin("/admin/settings"));
await save("admin-stats", await admin("/admin/stats?u=owner"));
await save("admin-stats-90-days", await admin("/admin/stats?u=owner&r=90"));
await save("admin-stats-new-profile", await admin("/admin/stats?u=sam-lee&r=7"));
await save("admin-stats-empty", await admin("/admin/stats?u=jordan-patel"));
await save("admin-sent", await admin("/admin/sent?u=owner&r=7"));
await save("admin-sent-applied", await admin("/admin/sent?u=owner&r=30&a=applied"));

// A cover letter already made for the newest job (kept for download) and its CV asked for from the
// dashboard (being made), shown on its opened card and on the email button's page.
const FIRST = "https://jobs.example.com/ad/1000";
const FIRST_TITLE = "Senior Data Engineer (Python, Airflow) at Northwind Traders";
await worker.fetch(new Request(`${BASE}/api/doc?${new URLSearchParams({ u: "owner", j: FIRST, k: "cover_letter", days: "7",
  name: "Cover letter - Alex Morgan - Senior Data Engineer.pdf" })}`, { method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/pdf" }, body: "%PDF-1.4\n%%EOF" }), env, {});
await admin("/admin/doc", { method: "POST", form: { csrf, u: "owner", j: FIRST, k: "tailored_cv", n: "Senior Data Engineer (Python, Airflow)", back: "r=7" } });
const firstId = (await jobHash(FIRST)).slice(0, 16);
const opened = (await (await admin(`/admin/sent?u=owner&r=7&open=${firstId}`)).text()).replace(/<meta http-equiv="refresh"[^>]*>/, "");
await save("admin-sent-open", new Response(opened));
await save("confirm-cover-letter-ready", await call(`/f?${new URLSearchParams(await link("cover_letter", FIRST_TITLE, { job: FIRST }))}`));

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

// Saving a profile: the saved values stay on the page while HermitShell applies them, and a clash with
// someone else's change to the same field is shown before anything is saved.
const unescape = (s) => s.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
async function profileForm(u) {
  const html = await (await admin(`/admin/profile?u=${u}`)).text();
  const base = unescape(html.match(/name="base" value="([^"]*)"/)[1]);
  const v = JSON.parse(base);
  const form = new URLSearchParams({ csrf, action: "profile", u, base, name: v.name, email: v.email, phone: v.phone,
    location: v.location, titles: v.titles.join("\n"), region: v.region, places: v.places.join(", "), country: v.country,
    level: v.level, min_salary: v.min_salary, currency: v.currency, report_time: v.report_time, report_days: v.report_days });
  v.types.forEach((t) => form.append("types", t));
  v.modes.forEach((m) => form.append("modes", m));
  if (v.remote_anywhere) form.append("remote_anywhere", "1");
  if (v.hide_agency) form.append("hide_agency", "1");
  return form;
}
const mine = await profileForm("owner");
const theirs = await profileForm("owner");
theirs.set("email", "alex.m@example.com");
await admin("/admin/action", { method: "POST", form: theirs });
await save("admin-profile-saved", await framed(await admin("/admin/profile?u=owner&done=saved"), admin));
mine.set("email", "alex@example.org");
mine.set("titles", `${mine.get("titles")}\nData Platform Engineer`);
await save("admin-profile-conflict", await framed(await admin("/admin/action", { method: "POST", form: mine }), admin));

env = freshEnv();
await save("admin-dashboard-empty", await call("/admin").then(async () => {
  const again = await call("/admin/login", { method: "POST", form: { username: "admin", password: PASSWORD } });
  return call("/admin", { headers: { Cookie: (again.headers.get("Set-Cookie") || "").split(";")[0] } });
}));
env = freshEnv({ ACCESS_AUD: "docs-aud" });
await save("admin-access-required", await call("/admin"));

console.log(`Worker pages written to ${out}`);

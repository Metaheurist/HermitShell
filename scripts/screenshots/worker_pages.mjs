// Writes every feedback Worker page as a static HTML file, using fictional profiles and an in-memory KV.
// Usage: node scripts/screenshots/worker_pages.mjs <output dir>   (called by make.py)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PROTOCOL } from "../../packages/daily-vacancy-report/feedback-worker/src/apiauth.js";
import worker from "../../packages/daily-vacancy-report/feedback-worker/src/index.js";
import { sealingKeys } from "../../packages/daily-vacancy-report/feedback-worker/test/helpers.js";
import { LINK_DAYS, sign, today } from "../../packages/daily-vacancy-report/feedback-worker/src/lib.js";
import { jobHash } from "../../packages/daily-vacancy-report/feedback-worker/src/docs.js";
import { record } from "../../packages/daily-vacancy-report/feedback-worker/src/history.js";
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
  ...(await sealingKeys()).status,
  profiles: [
    { id: "avery-lane", name: "Avery Lane", email: "avery.lane@example.com", status: "active", recruiter: "admin",
      has_cv: true, created: now - 60 * day, last_run: now - 3 * 3600000, cv_updated: now - 20 * day,
      details: { name: "Avery Lane", email: "avery.lane@example.com", phone: "07700 900123", location: "Salford" }, job: JOB,
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
    // The main admin: staff, with no job search of their own (HermitShell moved theirs to Avery Lane).
    { id: "owner", name: "Alex Morgan", email: "alex.morgan@example.com", status: "active", owner: true, recruiter: "",
      has_cv: false, recruit: "avery-lane", created: now - 60 * day },
  ],
  scheduler: true,
  email: { host: "smtp.gmail.com", port: "587", user: "alex.morgan@example.com", from: "", password_set: true,
    source: "dashboard", last_test: { at: now - 2 * day, ok: true, to: "alex.morgan@example.com", error: "" } },
  keys: {
    firecrawl: { source: "env", hint: "fc-...41b7", backups: 1, keys: [
      { hint: "fc-...41b7", role: "main", at: now - 18 * 60000,
        usage: { used: 2360, limit: 3000, left: 640, plan: "Hobby", resets: new Date(now + 12 * day).toISOString().slice(0, 10) } },
      { hint: "fc-...9a03", role: "backup", at: now - 18 * 60000,
        usage: { used: 120, limit: 500, left: 380, plan: "Free", resets: new Date(now + 20 * day).toISOString().slice(0, 10) } }] },
    tavily: { source: "dashboard", hint: "tvly...8c1e", keys: [{ hint: "tvly...8c1e", role: "main", at: now - 18 * 60000,
      usage: { used: 412, limit: 1000, left: 588, plan: "Researcher", resets: "" } }] },
    scrapfly: { source: "none", hint: "" } },
  models: {
    openrouter: { source: "dashboard", hint: "sk-...7f2a", model: "openrouter/free", resting_until: null, why: "", today: 38, failed: 1,
      last_ok: now - 6 * 60000, keys: [{ hint: "sk-...7f2a", role: "main", at: now - 18 * 60000,
        usage: { used: 38, limit: 1000, left: 962, plan: "Free models", resets: new Date(now + day).toISOString().slice(0, 10), unit: "requests" } }] },
    bazaarlink: { source: "none", hint: "", model: "auto:free", resting_until: null, why: "", today: 0, failed: 0, last_ok: null },
    featherless: { source: "none", hint: "", model: "Qwen/Qwen2.5-7B-Instruct", resting_until: null, why: "", today: 0, failed: 0, last_ok: null },
    huggingface: { source: "env", hint: "hf_...c9d1", model: "openai/gpt-oss-20b:cheapest", resting_until: now + 5 * 3600000,
      why: "out of credits", today: 0, failed: 2, last_ok: now - 2 * day, keys: [{ hint: "hf_...c9d1", role: "main", at: now - 18 * 60000,
        usage: { used: null, limit: null, left: null, plan: "Free", resets: "", unit: "plan" } }] },
  },
  llm: { order: "cloud", cloud: ["openrouter", "huggingface"],
    local: { model: "qwen3:4b-instruct-2507-q4_K_M", suggested: "qwen3:4b-instruct-2507-q4_K_M", where: "8192 context, on the GPU",
      level: "normal", seconds: 14.2 },
    last: { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free", at: now - 6 * 60000 } },
  usage: { days: 7, since: new Date(now - 6 * day).toISOString().slice(0, 10), tasks: [
    { task: "triage", today: { calls: 6, failed: 0, in: 5400, out: 1900, avg_ms: 2100, estimated: 0 }, period: { calls: 41, failed: 0, in: 37800, out: 13100, avg_ms: 2300, estimated: 0 } },
    { task: "rating", today: { calls: 64, failed: 1, in: 131000, out: 20500, avg_ms: 4200, estimated: 0 }, period: { calls: 402, failed: 3, in: 820000, out: 129000, avg_ms: 4400, estimated: 0 } },
    { task: "verify", today: { calls: 5, failed: 0, in: 7200, out: 600, avg_ms: 1800, estimated: 0 }, period: { calls: 29, failed: 0, in: 41800, out: 3500, avg_ms: 1900, estimated: 0 } },
    { task: "summary", today: { calls: 3, failed: 0, in: 1500, out: 420, avg_ms: 1500, estimated: 0 }, period: { calls: 19, failed: 0, in: 9500, out: 2700, avg_ms: 1600, estimated: 0 } },
    { task: "letter", today: { calls: 2, failed: 0, in: 11800, out: 1300, avg_ms: 14800, estimated: 2 }, period: { calls: 9, failed: 0, in: 53100, out: 5900, avg_ms: 15200, estimated: 9 } },
    { task: "cv_tailor", today: { calls: 1, failed: 0, in: 4700, out: 1450, avg_ms: 16900, estimated: 0 }, period: { calls: 5, failed: 0, in: 23400, out: 7200, avg_ms: 17300, estimated: 0 } },
  ] },
  server: { cpu: { model: "AMD Ryzen 7 5700G", cores: 16 }, load: 3.4, ram_mb: { total: 32768, available: 19000 },
    gpus: [{ name: "NVIDIA GeForce RTX 3060", vram_mb: 12288, free_mb: 7400 }], disk_mb: { total: 953000, free: 512000 } },
  problems: [],
  timezone: "Europe/London",
  tasks: [
    { id: "report:sam-lee", kind: "report", u: "sam-lee", state: "running", at: now - 4 * 60000, trigger: "schedule",
      stage: "Rating jobs", done: 14, total: 25, expected: 18 * 60000 },
    { id: "letter:avery-lane:event:avery-lane:5f0c2a9e1b7d4c3a8e6f0b2d4a6c8e1f:1a2b3c4d5e6f", kind: "cover_letter", u: "avery-lane", state: "running",
      at: now - 90000, trigger: "email", title: "Data Engineer (Python, Airflow)", employer: "Northwind Traders", retry: false },
    { id: "letter:avery-lane:event:avery-lane:7d1e3b5c9a2f4e6d8c0b1a3e5d7f9c2b:6f5e4d3c2b1a", kind: "tailored_cv", u: "avery-lane", state: "waiting",
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
    matched: ["Python", "Airflow", "SQL", "dbt", "AWS", "Docker"], gaps: ["Kubernetes", "Terraform", "Snowflake"] },
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
// Avery Lane already counts Snowflake as on the CV (added from an earlier email).
for (const [u, stats] of [["avery-lane", { ...fakeStats(75, 1, 7), skills: ["Snowflake"] }], ["sam-lee", fakeStats(12, 0.6, 11)]]) {
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
// (Alex Morgan) also has the Recruiter role, with Avery Lane and Jordan Patel in their pool.
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
await save("admin-profile", await framed(await admin("/admin/profile?u=avery-lane"), admin));
await save("admin-profile-scanning", await framed(await admin("/admin/profile?u=sam-lee"), admin));
await save("admin-settings", await admin("/admin/settings"));
// Firecrawl's card pressed open: its main and backup keys with what is left of each.
await save("admin-settings-key-usage", new Response((await (await admin("/admin/settings")).text())
  .replace('<details class="keycard cr-firecrawl">', '<details class="keycard cr-firecrawl" open>')));
// The AI model keys, OpenRouter's card pressed open, and the modal that adds one.
await save("admin-settings-models", new Response((await (await admin("/admin/settings")).text())
  .replace('<details class="keycard cr-openrouter">', '<details class="keycard cr-openrouter" open>')
  .replace("</head>", "<style>main>:not(.eyebrow):not(h1):not(#models):not(#models~*),main>.usage{display:none!important}</style></head>")));
// The tokens each task used over the last week.
await save("admin-settings-usage", new Response((await (await admin("/admin/settings")).text())
  .replace("</head>", "<style>main>:not(.eyebrow):not(h1):not(.usage){display:none!important}</style></head>")));
await save("admin-model-key-modal", await withOpenModal("/admin/settings", "mkey-openrouter"));
// The server button's panel, as hovering over it shows it.
await save("admin-server-panel", new Response((await (await admin("/admin")).text())
  .replace("</head>", "<style>.me .srv .srvpanel{display:block}</style></head>")));
await save("admin-stats", await admin("/admin/stats?u=avery-lane"));
await save("admin-stats-90-days", await admin("/admin/stats?u=avery-lane&r=90"));
await save("admin-stats-new-profile", await admin("/admin/stats?u=sam-lee&r=7"));
await save("admin-stats-empty", await admin("/admin/stats?u=jordan-patel"));
await save("admin-sent", await admin("/admin/sent?u=avery-lane&r=7"));
await save("admin-sent-applied", await admin("/admin/sent?u=avery-lane&r=30&a=applied"));

// A cover letter already made for the newest job (kept for download) and its CV asked for from the
// dashboard (being made), shown on its opened card and on the email button's page.
const FIRST = "https://jobs.example.com/ad/1000";
const FIRST_TITLE = "Senior Data Engineer (Python, Airflow) at Northwind Traders";
await worker.fetch(new Request(`${BASE}/api/doc?${new URLSearchParams({ u: "avery-lane", j: FIRST, k: "cover_letter", days: "7",
  name: "Cover letter - Avery Lane - Senior Data Engineer.pdf" })}`, { method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/pdf" }, body: "%PDF-1.4\n%%EOF" }), env, {});
await admin("/admin/doc", { method: "POST", form: { csrf, u: "avery-lane", j: FIRST, k: "tailored_cv", n: "Senior Data Engineer (Python, Airflow)", back: "r=7" } });
// Terraform just added from its missing-skill chip, not yet counted by HermitShell.
await admin("/admin/skill", { method: "POST", form: { csrf, u: "avery-lane", j: FIRST, s: "Terraform", back: "r=7" } });
const firstId = (await jobHash(FIRST)).slice(0, 16);
const opened = (await (await admin(`/admin/sent?u=avery-lane&r=7&open=${firstId}`)).text()).replace(/<meta http-equiv="refresh"[^>]*>/, "");
await save("admin-sent-open", new Response(opened));
await save("confirm-cover-letter-ready", await call(`/f?${new URLSearchParams(await link("cover_letter", FIRST_TITLE, { job: FIRST, profile: "avery-lane" }))}`));

// A fresh install: HermitShell has connected, nothing else is set yet.
const fresh = { ...STATUS, profiles: STATUS.profiles.filter((p) => p.owner).map((p) => ({ ...p, recruit: "" })),
  email: { host: "smtp.gmail.com", port: "587", user: "", from: "", password_set: false, source: "none", last_test: null },
  keys: { firecrawl: { source: "none", hint: "" }, tavily: { source: "none", hint: "" }, scrapfly: { source: "none", hint: "" } },
  problems: [{ at: now - 600000, what: "email", error: "invalid email server settings" }] };
await call("/api/status", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, json: fresh });
await save("admin-dashboard-setup", await admin("/admin"));
// HermitShell updated but its Worker not yet redeployed: the warning at the top of the admin pages.
await call("/api/status", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, json: { ...STATUS, protocol: PROTOCOL + 1 } });
await save("admin-settings-mismatch", await admin("/admin/settings"));
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
const mine = await profileForm("avery-lane");
const theirs = await profileForm("avery-lane");
theirs.set("email", "avery.l@example.com");
await admin("/admin/action", { method: "POST", form: theirs });
await save("admin-profile-saved", await framed(await admin("/admin/profile?u=avery-lane&done=saved"), admin));
mine.set("email", "avery@example.org");
mine.set("titles", `${mine.get("titles")}\nData Platform Engineer`);
await save("admin-profile-conflict", await framed(await admin("/admin/action", { method: "POST", form: mine }), admin));

// Sam Lee's history: two weeks of reports, changes and answers, then Casey asking for jobs now.
const hour = 3600000;
for (const [ago, kind, text, by, via] of [
  [11 * day + 2 * hour, "cv_read", "Read the new CV and rebuilt the skills jobs are rated against", "", "hermitshell"],
  [10 * day, "report", "Job report ran", "", "hermitshell"],
  [8 * day + 5 * hour, "job", "Changed Job titles and Places", "Casey Quinn", "dashboard"],
  [7 * day, "report", "Job report ran", "", "hermitshell"],
  [6 * day + 3 * hour, "answer", "Answered Interested: BI Developer at Fabrikam", "", "email"],
  [5 * day + 2 * hour, "tailored_cv", "Asked for a tailored CV: BI Developer at Fabrikam", "", "email"],
  [5 * day + hour, "cancel", "Cancelled the tailored CV: BI Developer at Fabrikam", "Casey Quinn", "dashboard"],
  [4 * day + 5 * hour, "tailored_cv", "Emailed the tailored CV: Data Analyst at Litware", "Casey Quinn", "dashboard"],
  [3 * day + 4 * hour, "pause", "Paused reports", "Casey Quinn", "dashboard"],
  [2 * day + 6 * hour, "resume", "Resumed reports", "Casey Quinn", "dashboard"],
  [day, "report", "Job report ran", "", "hermitshell"],
]) await record(env, "sam-lee", kind, text, { by, via, at: now - ago });
await casey("/admin/action", { method: "POST", form: { csrf: caseyCsrf, action: "send_now", u: "sam-lee" } });
await save("admin-history", await casey("/admin/history?u=sam-lee"));

// Demo mode, switched on from Global settings: the made-up desk on every signed-in page, then off again. The ribbon
// is fixed to the window's foot, which the screenshots' tall window would push far below the page, so it is drawn
// under the card, where it sits once the page is scrolled to the end.
const ribbonAtFoot = async (response, style = "") => new Response((await response.text())
  .replace("</head>", `<style>body{position:relative;min-height:0!important;padding-bottom:60px}.demoribbon{position:absolute!important;bottom:10px!important}${style}</style></head>`));
await admin("/admin/demo", { method: "POST", form: { csrf, on: "1" } });
await save("admin-dashboard-demo", await ribbonAtFoot(await admin("/admin")));
await save("admin-settings-demo", await ribbonAtFoot(await admin("/admin/settings?done=demo_on"),
  "main>:not(.eyebrow):not(h1):not(.note):not(#demo):not(#demo~*){display:none!important}"));
await save("admin-stats-demo", await ribbonAtFoot(await admin("/admin/stats?u=jamie-walsh")));
await admin("/admin/demo", { method: "POST", form: { csrf, on: "0" } });

env = freshEnv();
await save("admin-dashboard-empty", await call("/admin").then(async () => {
  const again = await call("/admin/login", { method: "POST", form: { username: "admin", password: PASSWORD } });
  return call("/admin", { headers: { Cookie: (again.headers.get("Set-Cookie") || "").split(";")[0] } });
}));
env = freshEnv({ ACCESS_AUD: "docs-aud" });
await save("admin-access-required", await call("/admin"));

console.log(`Worker pages written to ${out}`);

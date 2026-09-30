// Demo mode (Global settings): every signed-in page shows a made-up recruitment desk (recruits, recruiters, stats,
// jobs sent, history, tasks, invites, settings and a kept cover letter) instead of the real one, so HermitShell can
// be shown to someone without showing anyone's data. The pages get an in-memory KV seeded with fictional data and a
// live link that answers "connected" but reaches nothing, so whatever is pressed while it is on only changes that
// request's copy: nothing reaches KV, the queue or HermitShell. Only the switch itself ("demo:mode") is stored. The
// API, email buttons, sign-up and privacy pages never see demo data, and reports carry on as normal.

import { PROTOCOL } from "./apiauth.js";
import { storeDoc } from "./docs.js";
import { historyKey } from "./history.js";
import { esc, limitedForm, newId, page, redirect, safeEqual, when } from "./lib.js";
import { SEAL_ALG } from "./seal.js";
import { SETTINGS_URL } from "./settings.js";
import { splitStats, zonedToday } from "./stats.js";

export const DEMO_URL = "/admin/demo";
const DEMO_KEY = "demo:mode";
const TZ = "Europe/London";
const DAY = 86400000;
const HOUR = 3600000;
// Seeded data is rebuilt this often, so "ago" times and today's numbers stay current.
const RESEED_MS = 10 * 60 * 1000;
// Only the public half of a throwaway key: settings saved in demo mode are sealed with it and then dropped.
const DEMO_SPKI = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAg+K1WTrvU4iw+ll3aFdVwXAI1rNNhwgEg9L4SKaHLgD6lP5h3fpde0gpHR2W3E3y40KRY2wuvQWGy1zxIHtep0AGrEeqmeHNkZ+mJTTWBF5dFe1CQK5SqN2f7RBxMHgh54yeM5vwT5SYdgHbbcUR78fTrW4Whu9pNKtt/4SbjbarToT1NIVKheO0jQrE7CTp0iXxuzxpYk1FL3uPkL8IqulyRqfkOpRRXUHf9EeSz+TOi/uTj2KLq4ipnfI7hdXTCnnoDkW9zP8gQrta2eb62KhfmhdZpr31K+RP9yjXLjX3fHfHDIKQoAi7oZegd8czVeIFbu3fhytYcuEr6THQzwIDAQAB";

export const DEMO_DONE = {
  demo_on: "Demo mode is on: every dashboard page now shows made-up data, and nothing pressed there is saved.",
  demo_off: "Demo mode is off: the dashboard shows your real recruits again.",
};

// ------------------------------------------------------------------------- the switch

// { at } while demo mode is on, else null.
export async function demoMode(env) {
  const got = await env.FEEDBACK.get(DEMO_KEY, "json");
  return got && Number.isFinite(got.at) ? got : null;
}

// POST /admin/demo: admins turn it on or off. Always against the real KV.
export async function demoToggle(request, env, s) {
  if (!s.me.admin) return page("Admins only", '<p>Only an admin can open this page. <a href="/admin">Back to recruits</a></p>', { status: 403 });
  const form = await limitedForm(request, 4096);
  if (!form || !safeEqual(String(form.get("csrf") || ""), s.csrf)) {
    return page("Expired form", "<p>Reload the admin page and try again.</p>", { status: 403 });
  }
  const on = form.get("on") === "1";
  if (on) await env.FEEDBACK.put(DEMO_KEY, JSON.stringify({ at: Date.now() }));
  else await env.FEEDBACK.delete(DEMO_KEY);
  return redirect(`${SETTINGS_URL}?done=${on ? "demo_on" : "demo_off"}#demo`);
}

function demoButton(csrf, on, label, cls) {
  return `<form method="post" action="${DEMO_URL}" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="on" value="${on ? "1" : "0"}"><button class="${cls}">${label}</button></form>`;
}

// `tz` is the timezone HermitShell reported, so the time matches the rest of the real settings.
export function demoSection(demo, csrf, tz) {
  return `<h2 id="demo">Demo mode</h2>
<p class="muted">Shows a made-up recruitment desk on every dashboard page instead of the real one: recruits, recruiters,
stats, jobs sent, history, tasks and settings, all fictional. Use it to show HermitShell to someone without showing
anyone's data. While it is on, nothing pressed on the dashboard is saved or reaches HermitShell, and it applies to
everyone signed in. Reports, email buttons and sign-ups carry on as normal.</p>
${demo ? `<p>Demo mode is <b>on</b>, since ${esc(when(demo.at, tz || TZ))}.</p>${demoButton(csrf, false, "Turn off demo mode", "small")}`
    : demoButton(csrf, true, "Turn on demo mode", "small quiet")}`;
}

// Centred on the screen (50vw), not the fixed box (50%): on phones the background glows widen the layout viewport past
// the screen.
const RIBBON_STYLE = `.demoribbon{position:fixed;left:50vw;bottom:16px;transform:translateX(-50%);z-index:30;display:flex;gap:10px;align-items:center;
width:max-content;max-width:calc(100vw - 32px);padding:9px 16px;border-radius:99px;background:#1e1b4b;color:#e0e7ff;font-size:13px;font-weight:600;
box-shadow:0 12px 30px -12px rgba(30,27,75,.7)}
.demoribbon b{color:#fff}.demoribbon a{color:#c7d2fe;white-space:nowrap}.demoribbon a:hover{color:#fff}
.demoribbon::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:#fbbf24;box-shadow:0 0 0 4px rgba(251,191,36,.25)}`;

// Shown at the foot of every signed-in page while demo mode is on.
export function demoRibbon(admin) {
  return `<style>${RIBBON_STYLE}</style><div class="demoribbon" role="status"><span><b>Demo mode:</b> made-up data, and nothing you press is saved.</span>${
    admin ? `<a href="${SETTINGS_URL}#demo">Turn off</a>` : ""}</div>`;
}

// ------------------------------------------------------------------------- the pretend KV and live link

function memoryKV(entries) {
  const store = new Map(entries);
  return {
    async get(key, type) {
      const value = store.get(key);
      if (value == null) return null;
      if (type === "json") return JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value));
      if (type === "arrayBuffer") return typeof value === "string" ? new TextEncoder().encode(value).buffer : value;
      return typeof value === "string" ? value : new TextDecoder().decode(value);
    },
    async put(key, value) {
      store.set(key, typeof value === "string" ? value : value instanceof ArrayBuffer ? value : new Uint8Array(value).slice().buffer);
    },
    async delete(key) { store.delete(key); },
    async list({ prefix = "", limit = 1000 } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })), list_complete: true };
    },
    store,
  };
}

const DEMO_HUB = {
  idFromName: (name) => name,
  get: () => ({ fetch: async (url) => Response.json(String(url).endsWith("/presence") ? { live: true, seen: Date.now() } : { sent: 0 }) }),
};

let seeded = null;

// The env the signed-in pages get while demo mode is on.
export async function demoEnv(env) {
  if (!seeded || seeded.secret !== env.JOB_FEEDBACK_SECRET || Date.now() - seeded.at > RESEED_MS) {
    const kv = memoryKV([]);
    await seed({ ...env, FEEDBACK: kv, HUB: DEMO_HUB });
    seeded = { secret: env.JOB_FEEDBACK_SECRET, at: Date.now(), entries: [...kv.store] };
  }
  return { ...env, FEEDBACK: memoryKV(seeded.entries), HUB: DEMO_HUB };
}

// ------------------------------------------------------------------------- the made-up desk

const ADMIN_NAME = "Alex Morgan";
const RECRUITERS = [
  { id: "casey", name: "Casey Quinn", roles: ["recruiter"] },
  { id: "drew", name: "Drew Harper", roles: ["admin", "recruiter"] },
];

// Each recruit: who they are, their search, and the jobs HermitShell found them.
const PEOPLE = [
  { id: "avery-lane", name: "Avery Lane", email: "avery.lane@example.com", place: "Belfast", recruiter: "drew", age: 75, time: "07:30",
    titles: ["Automation Engineer", "AI Engineer", "Python Developer"], employers: ["Northwind Traders", "Contoso", "Fabrikam", "Proseware", "Litware"],
    places: ["Belfast", "Lisburn", "Remote (UK)"], salary: 55000, skills: ["Python", "Power Automate", "SQL", "Azure", "REST APIs", "Docker"],
    gaps: ["Kubernetes", "Terraform"], scale: 1, added: ["Power Automate"] },
  { id: "sam-lee", name: "Sam Lee", email: "sam.lee@example.com", place: "Lisburn", recruiter: "casey", age: 40, time: "08:00",
    titles: ["Data Analyst", "BI Developer"], employers: ["Contoso", "Litware", "Northwind Traders", "Fabrikam", "Proseware"],
    places: ["Belfast", "Lisburn", "Banbridge"], salary: 38000, skills: ["SQL", "Power BI", "Excel", "DAX", "Python"], gaps: ["Azure Synapse", "dbt"],
    scale: 0.7 },
  { id: "jordan-patel", name: "Jordan Patel", email: "jordan.patel@example.net", place: "Newry", recruiter: "admin", age: 30, time: "08:30",
    status: "paused", titles: ["Mechanical Design Engineer", "Design Engineer"], employers: ["Fabrikam", "Proseware", "Northwind Traders", "Litware", "Contoso"],
    places: ["Newry", "Armagh", "Craigavon"], salary: 42000, skills: ["SolidWorks", "AutoCAD", "GD&T", "FEA"], gaps: ["Creo", "Six Sigma"], scale: 0.5 },
  { id: "morgan-ellis", name: "Morgan Ellis", email: "morgan.ellis@example.org", place: "Belfast", recruiter: "casey", age: 60, time: "07:45",
    titles: ["Management Accountant", "Financial Analyst"], employers: ["Litware", "Contoso", "Proseware", "Fabrikam", "Northwind Traders"],
    places: ["Belfast", "Holywood", "Remote (UK)"], salary: 45000, skills: ["CIMA", "Excel", "Sage", "Budgeting", "Forecasting"], gaps: ["SAP", "Power BI"],
    scale: 0.8 },
  { id: "taylor-reid", name: "Taylor Reid", email: "taylor.reid@example.com", place: "Craigavon", recruiter: "casey", age: 5, time: "09:00",
    titles: ["Sales Executive", "Account Manager"], employers: ["Northwind Traders", "Proseware", "Contoso", "Litware", "Fabrikam"],
    places: ["Craigavon", "Portadown", "Belfast"], salary: 32000, skills: ["B2B sales", "CRM", "Negotiation", "Account management"], gaps: ["Salesforce"],
    scale: 0.6 },
  { id: "jamie-walsh", name: "Jamie Walsh", email: "jamie.walsh@example.net", place: "Derry~Londonderry", recruiter: "drew", age: 50, time: "08:15",
    scanning: true, titles: ["Software Engineer (Java)", "Backend Developer"], employers: ["Proseware", "Contoso", "Fabrikam", "Northwind Traders", "Litware"],
    places: ["Derry~Londonderry", "Letterkenny", "Remote (UK)"], salary: 48000, skills: ["Java", "Spring Boot", "SQL", "AWS", "Microservices"],
    gaps: ["Kafka", "Kubernetes"], scale: 0.9 },
  { id: "robin-shaw", name: "Robin Shaw", email: "robin.shaw@example.org", place: "Ballymena", recruiter: "drew", age: 1, time: "08:00", noCv: true,
    titles: ["HR Business Partner"], employers: [], places: ["Ballymena", "Antrim"], salary: 40000, skills: [], gaps: [], scale: 0 },
];

const SOURCES = ["nijobs.com", "uk.indeed.com", "web search", "reed.co.uk", "cv-library.co.uk"];
const MODES = ["Hybrid", "Remote", "On-site"];
const LEVELS = ["Senior ", "", "", "Lead ", "", "Graduate ", "", "", "Senior "];
const FITS = [9, 9, 8, 8, 7, 8, 6, 7, 7];
const ANSWERS = ["applied", "heard_back", "interested", "", "good_match", "", "not_for_me", "", "rejected"];
const DAYS_AGO = [0, 0, 1, 1, 2, 3, 5, 6, 9];
const ANSWER_LABELS = { applied: "I applied", heard_back: "Heard back", interested: "Interested", good_match: "Good match", not_for_me: "Not for me",
  rejected: "Rejected" };

function random(seedValue) {
  let x = seedValue;
  return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const pounds = (n) => `\u00a3${Math.round(n).toLocaleString("en-GB")}`;

// A paused recruit's jobs stop when their reports did.
const pausedFor = (p) => (p.status === "paused" ? 6 : 0);

function jobsFor(p, end) {
  return FITS.map((fit, i) => {
    const title = `${LEVELS[i]}${p.titles[i % p.titles.length]}`;
    const employer = p.employers[i % p.employers.length];
    const place = p.places[i % p.places.length];
    const pay = p.salary * (LEVELS[i].startsWith("Senior") || LEVELS[i].startsWith("Lead") ? 1.25 : LEVELS[i] ? 0.75 : 1);
    const matched = p.skills.slice(0, 3 + (i % 3));
    const gaps = p.gaps.slice(0, 1 + (i % 2));
    const key = `https://jobs.example.com/demo/${p.id}/${1000 + i}`;
    return {
      title, employer, location: place, mode: place.startsWith("Remote") ? "Remote" : MODES[i % 2], fit, source: SOURCES[i % SOURCES.length],
      salary: i % 3 === 2 ? "" : i % 2 ? pounds(pay) : `${pounds(pay * 0.95)} - ${pounds(pay * 1.1)}`, answer: ANSWERS[i],
      day: isoDay(end - (DAYS_AGO[i] + pausedFor(p)) * DAY), url: i % 4 === 3 ? "" : key, key,
      more: { company: employer, type: i === 5 ? "Contract" : "Permanent", seniority: LEVELS[i].trim() || "Mid", published: i ? `${i} days ago` : "today",
        closing: isoDay(end + (12 - i) * DAY), confidence: 70 + fit * 2, coverage: 60 + fit * 3,
        reasoning: `Strong overlap with the CV: ${matched.join(", ")} match the core of the role.${gaps.length
          ? ` The advert also asks for ${gaps.join(" and ")}, which the CV does not show.` : ""}`,
        about: `${employer} is growing its ${place.replace("Remote (UK)", "remote")} team and needs a ${title.toLowerCase()} to join it.`,
        profile: `${employer}: a fictional company used for this demo`, site: "https://example.com", matched, gaps },
    };
  });
}

// Made-up daily counts in profile_stats.py's field order, the same every time for the same person.
function statsFor(p, end, n) {
  const rand = random(7 + n * 13);
  const days = {};
  for (let i = p.age - 1; i >= 0; i--) {
    const at = end - i * DAY;
    if (i < pausedFor(p)) {
      days[isoDay(at)] = new Array(16).fill(0);
      continue;
    }
    const weekend = [0, 6].includes(new Date(at).getUTCDay());
    const growth = 0.7 + 0.5 * (1 - i / p.age);
    const rated = Math.round((weekend ? 5 : 13) * p.scale * growth * (0.6 + rand() * 0.8));
    const sent = Math.round(rated * (0.35 + rand() * 0.25));
    const pick = (chance) => (rand() < chance ? 1 + (rand() < chance / 3 ? 1 : 0) : 0);
    days[isoDay(at)] = [Math.round(rated * (7 + rand() * 5)), rated, sent, Math.round(sent * (6.3 + rand() * 1.6)), sent,
      Math.round(sent * rand() * 0.45), 1, pick(0.4), pick(0.25), pick(0.3), pick(0.16), pick(0.06), pick(0.05), pick(0.1), pick(0.05), pick(0.06)];
  }
  const sent = jobsFor(p, end);
  const scaled = (pairs, k) => pairs.map(([name, c]) => [name, Math.ceil(c * k * p.scale)]);
  const range = (k) => ({
    employers: scaled(p.employers.map((e, i) => [e, 9 - i * 2]), k / 30),
    sources: scaled(SOURCES.map((s, i) => [s, 21 - i * 4]), k / 30),
    modes: scaled([["Hybrid", 18], ["Remote", 9], ["On-site", 5]], k / 30),
    fit: [0, 1, 3, 6, 11, 19, 27, 31, 18, 7, 2].map((c) => Math.ceil(c * k * p.scale / 30)),
    salary: p.salary,
    best: sent.slice(0, 3).map((j) => ({ title: j.title, employer: j.employer, fit: j.fit, day: j.day })),
  });
  const pipeline = Object.fromEntries(Object.entries({ interested: 9, good_match: 4, not_for_me: 12, applied: 6, heard_back: 3, rejected: 2 })
    .map(([k, v]) => [k, Math.max(1, Math.round(v * p.scale))]));
  return { v: 1, today: isoDay(end), since: isoDay(end - (p.age - 1) * DAY), days,
    ranges: { 7: range(7), 30: range(30), 90: range(90), 365: range(365) }, pipeline, sent,
    ...(p.added ? { skills: p.added } : {}), updated: Date.now() };
}

function profileOf(p, now) {
  const minutes = Number(p.time.slice(3));
  const job = { titles: p.titles, region: "Northern Ireland", places: p.places.filter((x) => !x.startsWith("Remote")), country: "gb",
    remote_anywhere: p.places.some((x) => x.startsWith("Remote")), level: "mid", types: ["Permanent", "Contract"], modes: ["Hybrid", "Remote"],
    min_salary: String(Math.round(p.salary * 0.85 / 1000) * 1000), currency: "GBP", hide_agency: true };
  return {
    id: p.id, name: p.name, email: p.email, status: p.status || "active", recruiter: p.recruiter,
    has_cv: !p.noCv, created: now - p.age * DAY, last_run: p.age > 1 ? now - (p.status === "paused" ? 6 * DAY : 4 * HOUR) : null,
    cv_updated: p.noCv ? null : now - Math.min(p.age, 20) * DAY, ...(p.scanning ? { scanning: now - 3 * 60000 } : {}),
    details: { name: p.name, email: p.email, phone: p.id === "avery-lane" ? "07700 900123" : "", location: p.place }, job,
    report: { time: p.time, days: p.id === "sam-lee" ? "weekdays" : "daily", schedule: `${minutes} ${p.time.slice(0, 2)} * * ${p.id === "sam-lee" ? "1-5" : "*"}`,
      job: true, pending: false },
  };
}

function statusOf(now) {
  return {
    protocol: PROTOCOL, seal: { alg: SEAL_ALG, kid: "", spki: DEMO_SPKI },
    // The main admin is staff: HermitShell reports them only so the dashboard can name them.
    profiles: [{ id: "owner", name: ADMIN_NAME, email: "alex.morgan@example.com", status: "active", owner: true, recruiter: "", has_cv: false,
      recruit: "", created: now - 90 * DAY }, ...PEOPLE.map((p) => profileOf(p, now))],
    scheduler: true, timezone: TZ, updated: now - 2 * 60000, problems: [],
    email: { host: "smtp.example.com", port: "587", user: "reports@example.com", from: "", password_set: true, source: "dashboard",
      last_test: { at: now - 2 * DAY, ok: true, to: "alex.morgan@example.com", error: "" } },
    keys: {
      firecrawl: { source: "dashboard", hint: "fc-...demo", backups: 1, keys: [
        { hint: "fc-...demo", role: "main", at: now - 18 * 60000, usage: { used: 2360, limit: 3000, left: 640, plan: "Hobby", resets: isoDay(now + 12 * DAY) } },
        { hint: "fc-...dem2", role: "backup", at: now - 18 * 60000, usage: { used: 120, limit: 500, left: 380, plan: "Free", resets: isoDay(now + 20 * DAY) } }] },
      tavily: { source: "dashboard", hint: "tvly...demo", keys: [{ hint: "tvly...demo", role: "main", at: now - 18 * 60000,
        usage: { used: 412, limit: 1000, left: 588, plan: "Researcher", resets: "" } }] },
      scrapfly: { source: "none", hint: "" },
    },
    models: {
      openrouter: { source: "dashboard", hint: "or-...demo", model: "openrouter/free", resting_until: null, why: "", today: 38, failed: 1,
        last_ok: now - 6 * 60000, keys: [{ hint: "or-...demo", role: "main", at: now - 18 * 60000,
          usage: { used: 38, limit: 1000, left: 962, plan: "Free models", resets: isoDay(now + DAY), unit: "requests" } }] },
      bazaarlink: { source: "none", hint: "", model: "auto:free", resting_until: null, why: "", today: 0, failed: 0, last_ok: null },
      featherless: { source: "none", hint: "", model: "Qwen/Qwen2.5-7B-Instruct", resting_until: null, why: "", today: 0, failed: 0, last_ok: null },
      huggingface: { source: "dashboard", hint: "hf-...demo", model: "openai/gpt-oss-20b:cheapest", resting_until: now + 5 * HOUR,
        why: "out of credits", today: 0, failed: 2, last_ok: now - 2 * DAY, keys: [{ hint: "hf-...demo", role: "main", at: now - 18 * 60000,
          usage: { used: null, limit: null, left: null, plan: "Free", resets: "", unit: "plan" } }] },
    },
    llm: { order: "local", cloud: ["openrouter", "huggingface"],
      local: { model: "qwen3:30b-a3b-instruct-2507-q4_K_M", suggested: "qwen3:30b-a3b-instruct-2507-q4_K_M", where: "16384 context, on the GPU",
        level: "normal", seconds: 9.8 },
      last: { provider: "ollama", model: "qwen3:30b-a3b-instruct-2507-q4_K_M", at: now - 3 * 60000 } },
    server: { cpu: { model: "AMD Ryzen 9 7950X", cores: 32 }, load: 4.1, ram_mb: { total: 65536, available: 38000 },
      gpus: [{ name: "NVIDIA GeForce RTX 4090", vram_mb: 24576, free_mb: 6100 }], disk_mb: { total: 1907000, free: 1210000 } },
    tasks: [
      { id: "report:jamie-walsh", kind: "report", u: "jamie-walsh", state: "running", at: now - 3 * 60000, trigger: "schedule",
        stage: "Rating jobs", done: 17, total: 26, expected: 12 * 60000 },
      { id: "letter:avery-lane:event:avery-lane:demo0a1b2c3d4e5f60718293a4b5c6d7e8f9:0a1b2c3d4e5f", kind: "cover_letter", u: "avery-lane", state: "running",
        at: now - 70000, trigger: "email", title: "AI Engineer", employer: "Contoso", retry: false },
    ],
  };
}

// A one-page PDF of plain text lines, for the kept cover letter.
function textPdf(lines) {
  const content = lines.map((line, i) => `BT /F1 ${i ? 11 : 17} Tf 72 ${770 - (i ? 30 + i * 17 : 0)} Td (${line.replace(/[\\()]/g, "\\$&")}) Tj ET`).join("\n");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  return new TextEncoder().encode(`${out}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

async function put(env, key, value) {
  await env.FEEDBACK.put(key, JSON.stringify(value));
}

async function seed(env) {
  const now = Date.now();
  const end = Date.parse(`${zonedToday(TZ, now)}T00:00:00Z`);
  const status = statusOf(now);
  await put(env, "status:profiles", status);
  await put(env, "accounts", { admin: { roles: ["admin", "recruiter"] },
    users: RECRUITERS.map((r) => ({ ...r, hash: "0".repeat(64), salt: "0".repeat(32), iter: 30000, v: "demo" })) });

  for (const [n, p] of PEOPLE.entries()) {
    if (p.noCv || !p.employers.length) continue;
    const { stats, sent } = splitStats(statsFor(p, end, n));
    await put(env, `stats:${p.id}`, stats);
    await put(env, `sent:${p.id}`, sent);
  }

  // Each recruit's history, in the entries record() writes, one KV value per month.
  const names = Object.fromEntries([["admin", ADMIN_NAME], ...RECRUITERS.map((r) => [r.id, r.name])]);
  const months = new Map();
  const log = (pid, k, t, at, { by = "", via = "dashboard" } = {}) => {
    const key = historyKey(pid, at);
    months.set(key, [...(months.get(key) || []), { at, k, t, v: via, ...(by ? { by } : {}) }]);
  };
  for (const p of PEOPLE) {
    const created = now - p.age * DAY;
    log(p.id, "assign", `Assigned to ${names[p.recruiter]}`, created + HOUR, { by: ADMIN_NAME });
    if (!p.noCv) log(p.id, "cv_read", "Read the new CV and rebuilt the skills jobs are rated against", created + 2 * HOUR, { via: "hermitshell" });
    if (p.age > 8) log(p.id, "job", "Changed Job titles and Towns", now - 8 * DAY - 3 * HOUR, { by: names[p.recruiter] || ADMIN_NAME });
    for (let d = Math.min(p.age - 1, 10); d >= 1 && !p.noCv; d--) {
      if (d < pausedFor(p)) break;
      log(p.id, "report", "Job report ran", now - d * DAY - 2 * HOUR, { via: "hermitshell" });
    }
    if (pausedFor(p)) log(p.id, "pause", "Paused reports", now - 5 * DAY - 4 * HOUR, { by: names[p.recruiter] });
    for (const j of p.employers.length ? jobsFor(p, end).filter((x) => x.answer) : []) {
      log(p.id, "answer", `Answered ${ANSWER_LABELS[j.answer]}: ${j.title} at ${j.employer}`, Date.parse(`${j.day}T12:00:00Z`) + 5 * HOUR, { via: "email" });
    }
  }
  for (const [key, entries] of months) await put(env, key, entries);

  const signup = `queue:${now - 20 * 60000}:${newId()}`;
  await put(env, signup, { id: signup, at: now - 20 * 60000, type: "signup", name: "Riley Chen", email: "riley.chen@example.com", location: "Belfast",
    roles: "Marketing executive or content manager, hybrid", recruiter: "casey", consent: true });
  await env.FEEDBACK.put("flag:queue", signup);
  for (const [note, recruiter, daysLeft] of [["Careers fair, marketing graduate", "casey", 6], ["Referral from Jamie Walsh", "drew", 3]]) {
    const id = newId();
    await put(env, `invite:${id}`, { id, note, created: now - (7 - daysLeft) * DAY, expires: now + daysLeft * DAY, recruiter });
  }
  const sam = jobsFor(PEOPLE[1], end)[4];
  await put(env, "tasks:requests", [{ id: "event:sam-lee:demo-tailored-cv", a: "tailored_cv", n: `${sam.title} at ${sam.employer}`, u: "sam-lee",
    at: now - 40000, j: sam.key }]);

  const first = jobsFor(PEOPLE[0], end)[0];
  const letter = textPdf([
    "Cover letter (demo)", "", "Avery Lane, Belfast", "", `Dear Hiring Manager at ${first.employer},`, "",
    `I am writing to apply for the ${first.title} role. Over the last six years I have built Python`,
    "automations, Power Automate flows and Azure-hosted APIs that took hours of manual work out of",
    "busy operations teams, and I would like to bring that experience to yours.", "",
    "This letter is sample output from HermitShell's demo mode: the candidate, the company and the",
    "role are all made up.", "", "Yours sincerely,", "Avery Lane",
  ]);
  const query = new URLSearchParams({ u: "avery-lane", j: first.key, k: "cover_letter", days: "7", name: `Cover letter - Avery Lane - ${first.title}` });
  await storeDoc(new Request(`https://demo.invalid/api/doc?${query}`, { method: "POST", body: letter }), env);
}

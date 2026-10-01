// Demo mode (Global settings): every signed-in page shows a made-up recruitment desk (recruits, recruiters, stats,
// jobs sent, history, tasks, invites, settings and a kept cover letter) instead of the real one, so HermitShell can
// be shown to someone without showing anyone's data. The pages get an in-memory KV seeded with fictional data and a
// live link that answers "connected" but reaches nothing, so whatever is pressed while it is on never reaches the
// real data, the queue or HermitShell. The API, email buttons, sign-up and privacy pages never see demo data, and
// reports carry on as normal.
//
// Presses still play out, as they would for real: a pretend HermitShell (pretendWork) takes what they queued a few
// seconds later, so a letter or tailored CV asked for is "being made" and then ready to download (a made-up PDF), a job
// emailed shows as sent, an added skill as counted, and a pause, assignment, scan or recruit change shows on the
// dashboard. What the demo needs to remember for that is kept in one KV value, "demo:state", for two hours and
// cleared when the switch is pressed: only the demo's own keys (requests, kept documents, marks, history, invites and
// the plain dashboard changes) and what the pretend HermitShell did. Nothing typed into settings, CVs, users or
// passwords is kept there, and the switch itself is "demo:mode".

import { PROTOCOL } from "./apiauth.js";
import { DOC_KINDS, PROFILE_CV, jobHash, markEmailed, storeDoc, storeProfileCv } from "./docs.js";
import { historyKey } from "./history.js";
import { STAGE_LABELS } from "./pipeline.js";
import { esc, limitedForm, newId, page, redirect, rememberWeek, safeEqual, when } from "./lib.js";
import { SEAL_ALG } from "./seal.js";
import { SETTINGS_URL } from "./settings.js";
import { splitStats, zonedToday } from "./stats.js";
import { forgetRequests, requests } from "./tasks.js";

export const DEMO_URL = "/admin/demo";
const DEMO_KEY = "demo:mode";
const STATE_KEY = "demo:state";
const STATE_TTL_SECONDS = 2 * 3600;
const MAX_STATE_BYTES = 256 * 1024;
// How long the pretend HermitShell takes over each kind of work.
export const WORK_MS = { send_job: 6000, cover_letter: 12000, tailored_cv: 14000, profile_cv: 8000, interview_prep: 14000, skill: 5000, change: 4000,
  scan: 25000 };
// The demo's own keys worth remembering between pages. Queue items are only kept for the plain dashboard changes.
const KEPT = /^(event:[a-z0-9_-]{1,40}:dash-|tasks:requests$|docs?:|cvpdf(info)?:|emailed:|skilladd:|history:|invite:|queue:|flag:queue$)/;
const KEPT_CHANGES = new Set(["pause", "resume", "assign", "send_now", "delete", "cancel", "profile"]);
const TZ = "Europe/London";
const DAY = 86400000;
const HOUR = 3600000;
// Seeded data is rebuilt this often, so "ago" times and today's numbers stay current.
const RESEED_MS = 10 * 60 * 1000;
// Only the public half of a throwaway key: settings saved in demo mode are sealed with it and then dropped.
const DEMO_SPKI = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAg+K1WTrvU4iw+ll3aFdVwXAI1rNNhwgEg9L4SKaHLgD6lP5h3fpde0gpHR2W3E3y40KRY2wuvQWGy1zxIHtep0AGrEeqmeHNkZ+mJTTWBF5dFe1CQK5SqN2f7RBxMHgh54yeM5vwT5SYdgHbbcUR78fTrW4Whu9pNKtt/4SbjbarToT1NIVKheO0jQrE7CTp0iXxuzxpYk1FL3uPkL8IqulyRqfkOpRRXUHf9EeSz+TOi/uTj2KLq4ipnfI7hdXTCnnoDkW9zP8gQrta2eb62KhfmhdZpr31K+RP9yjXLjX3fHfHDIKQoAi7oZegd8czVeIFbu3fhytYcuEr6THQzwIDAQAB";

export const DEMO_DONE = {
  demo_on: "Demo mode is on: every dashboard page now shows made-up data, and what is pressed there plays out on it without reaching anyone.",
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
  await env.FEEDBACK.delete(STATE_KEY);
  return redirect(`${SETTINGS_URL}?done=${on ? "demo_on" : "demo_off"}#demo`);
}

const SWITCH_STYLE = `.demoswitch{display:flex;align-items:center;gap:14px;flex-wrap:wrap;width:max-content;max-width:100%;margin-top:14px;
padding:12px 18px 12px 14px;border:1px solid #e5e7f5;border-radius:16px;background:#f8f9ff}
.demoswitch.on{border-color:#c7d2fe;background:linear-gradient(135deg,#eef2ff,#f5f3ff)}
.demoswitch label{display:inline;margin:0;font-size:14.5px;font-weight:700;cursor:pointer}.demoswitch .state{font-size:13px;color:var(--muted)}
.demoswitch.on .state b{color:var(--brand-ink)}
button.switch{flex:none;position:relative;margin:0;padding:0;width:50px;height:28px;border-radius:99px;background:#cbd5e1;
box-shadow:inset 0 1px 3px rgba(15,23,42,.2);transition:background .25s,box-shadow .25s}
button.switch:hover{transform:none;filter:none;background:#b8c2d3;box-shadow:inset 0 1px 3px rgba(15,23,42,.2)}
button.switch[aria-checked="true"]{background:linear-gradient(135deg,var(--brand),var(--brand2));box-shadow:0 6px 16px -8px rgba(99,102,241,.9)}
button.switch[aria-checked="true"]:hover{filter:brightness(1.06)}
.switch .knob{position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;
box-shadow:0 2px 6px rgba(15,23,42,.3);transition:transform .25s cubic-bezier(.3,1.4,.5,1)}
.switch[aria-checked="true"] .knob{transform:translateX(22px)}
.switch:active .knob{transform:scale(.88)}.switch[aria-checked="true"]:active .knob{transform:translateX(22px) scale(.88)}
.switch.moved .knob{animation:knob-off .35s cubic-bezier(.3,1.4,.5,1) both}
.switch.moved[aria-checked="true"] .knob{animation-name:knob-on}
@keyframes knob-on{from{transform:translateX(0)}}@keyframes knob-off{from{transform:translateX(22px)}}`;

// A plain form, so it works without scripts: pressing the switch posts the opposite state and the page reloads with
// the knob sliding over (`moved`).
function demoSwitch(demo, csrf, tz, moved) {
  const state = demo ? `<b>On</b> since ${esc(when(demo.at, tz || TZ))}` : "Off";
  return `<style>${SWITCH_STYLE}</style><form method="post" action="${DEMO_URL}" class="demoswitch${demo ? " on" : ""}">
<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="on" value="${demo ? "0" : "1"}">
<button id="demo-switch" class="switch${moved ? " moved" : ""}" role="switch" aria-checked="${demo ? "true" : "false"}"><span class="knob"></span></button>
<label for="demo-switch">Demo mode</label><span class="state">${state}</span></form>`;
}

// `tz` is the timezone HermitShell reported, so the time matches the rest of the real settings. `moved` is set on the
// page shown straight after the switch was pressed.
export function demoSection(demo, csrf, tz, moved = false) {
  return `<h2 id="demo">Demo mode</h2>
<p class="muted">Shows a made-up recruitment desk on every dashboard page instead of the real one: recruits, recruiters,
stats, jobs sent, history, tasks and settings, all fictional. Use it to show HermitShell to someone without showing
anyone's data. While it is on, what is pressed on the dashboard plays out on the made-up data, a pretend HermitShell
answering within seconds, and never reaches HermitShell or the real data. It applies to everyone signed in, and starts
afresh each time it is turned on. Reports, email buttons and sign-ups carry on as normal.</p>
${demoSwitch(demo, csrf, tz, moved)}`;
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
  return `<style>${RIBBON_STYLE}</style><div class="demoribbon" role="status"><span><b>Demo mode:</b> made-up data, and nothing you press reaches anyone.</span>${
    admin ? `<a href="${SETTINGS_URL}#demo">Turn off</a>` : ""}</div>`;
}

// ------------------------------------------------------------------------- the pretend KV and live link

function memoryKV(entries) {
  const store = new Map(entries);
  const touched = new Set();
  return {
    async get(key, type) {
      const value = store.get(key);
      if (value == null) return null;
      if (type === "json") return JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value));
      if (type === "arrayBuffer") return typeof value === "string" ? new TextEncoder().encode(value).buffer : value;
      return typeof value === "string" ? value : new TextDecoder().decode(value);
    },
    async put(key, value) {
      touched.add(key);
      store.set(key, typeof value === "string" ? value : value instanceof ArrayBuffer ? value : new Uint8Array(value).slice().buffer);
    },
    async delete(key) {
      touched.add(key);
      store.delete(key);
    },
    async list({ prefix = "", limit = 1000 } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })), list_complete: true };
    },
    store,
    touched,
  };
}

const DEMO_HUB = {
  idFromName: (name) => name,
  get: () => ({ fetch: async (url) => Response.json(String(url).endsWith("/presence") ? { live: true, seen: Date.now() } : { sent: 0 }) }),
};

let seeded = null;
const states = new WeakMap();

// The env the signed-in pages get while demo mode is on: the made-up desk, what earlier presses changed, and what the
// pretend HermitShell has done with them since. saveDemo keeps what this request changes.
export async function demoEnv(env, now = Date.now()) {
  if (!seeded || seeded.secret !== env.JOB_FEEDBACK_SECRET || now - seeded.at > RESEED_MS) {
    const kv = memoryKV([]);
    await seed({ ...env, FEEDBACK: kv, HUB: DEMO_HUB });
    seeded = { secret: env.JOB_FEEDBACK_SECRET, at: now, entries: [...kv.store], keys: new Set(kv.store.keys()) };
  }
  const kv = memoryKV(seeded.entries);
  const state = await loadState(env);
  for (const [key, value] of Object.entries(state.keys)) {
    if (value === null) kv.store.delete(key);
    else kv.store.set(key, typeof value.s === "string" ? value.s : fromBase64(value.b));
  }
  const pretend = { ...env, FEEDBACK: kv, HUB: DEMO_HUB };
  await pretendWork(pretend, state, now);
  applyPatch(kv, state.patch, now);
  states.set(pretend, state);
  return pretend;
}

// Keep what a request in demo mode changed in the demo's own keys, for the next page.
export async function saveDemo(env, pretend) {
  const state = states.get(pretend);
  if (!state) return;
  const kv = pretend.FEEDBACK;
  let changed = state.dirty;
  for (const key of kv.touched) {
    if (!KEPT.test(key)) continue;
    const value = kv.store.get(key);
    if (value == null) {
      if (seeded.keys.has(key)) state.keys[key] = null;
      else delete state.keys[key];
      changed = true;
    } else if (!key.startsWith("queue:") || keptChange(value)) {
      state.keys[key] = typeof value === "string" ? { s: value } : { b: toBase64(value) };
      changed = true;
    }
  }
  if (!changed) return;
  const body = JSON.stringify({ v: 1, keys: state.keys, patch: state.patch });
  if (body.length <= MAX_STATE_BYTES) await env.FEEDBACK.put(STATE_KEY, body, { expirationTtl: STATE_TTL_SECONDS });
}

function keptChange(value) {
  try {
    const item = JSON.parse(value);
    return item?.type === "admin" && KEPT_CHANGES.has(item.action);
  } catch {
    return false;
  }
}

const emptyPatch = () => ({ profiles: {}, skills: {}, stages: {}, cancelled: [] });
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

async function loadState(env) {
  const got = await env.FEEDBACK.get(STATE_KEY, "json");
  const keys = {};
  for (const [key, value] of Object.entries(isObject(got?.keys) ? got.keys : {})) {
    if (KEPT.test(key) && (value === null || typeof value?.s === "string" || typeof value?.b === "string")) keys[key] = value;
  }
  const patch = isObject(got?.patch) ? got.patch : {};
  return { keys, dirty: false, patch: { profiles: isObject(patch.profiles) ? patch.profiles : {}, skills: isObject(patch.skills) ? patch.skills : {},
    stages: isObject(patch.stages) ? patch.stages : {}, cancelled: Array.isArray(patch.cancelled) ? patch.cancelled.filter((t) => typeof t === "string") : [] } };
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer;
}

// ------------------------------------------------------------------------- the pretend HermitShell

const dashId = (id) => typeof id === "string" && id.includes(":dash-");

// What HermitShell would have done by `now` with what was pressed: letters and CVs made, jobs emailed, skills counted
// and dashboard changes applied. Sign-ups and the made-up desk's own requests stay waiting, as they are seeded.
async function pretendWork(env, state, now) {
  const kv = env.FEEDBACK;
  const current = await kv.get("status:profiles", "json");
  const names = new Map((current?.profiles || []).map((p) => [p.id, p.name]));
  const ready = (await requests(env)).filter((r) => dashId(r.id) && now - Number(r.at) >= (WORK_MS[r.a] ?? WORK_MS.change));
  for (const r of ready) {
    const q = new URLSearchParams({ u: r.u, j: r.j });
    if (r.a === "send_job") {
      await markEmailed(new Request(`https://demo.invalid/api/emailed?${q}`, { method: "POST" }), env);
    } else if (r.a === PROFILE_CV) {
      const name = `CV - ${names.get(r.u) || "Recruit"}`;
      await storeProfileCv(new Request(`https://demo.invalid/api/cv?${new URLSearchParams({ u: r.u, name })}`, { method: "POST",
        body: demoDoc(r, {}, names.get(r.u)) }), env);
    } else if (!r.send && DOC_KINDS[r.a]) {
      const event = (await kv.get(r.id, "json")) || {};
      q.set("k", r.a);
      q.set("days", "7");
      q.set("name", `${DOC_KINDS[r.a]} - ${names.get(r.u) || "Recruit"} - ${r.n || "a job"}`);
      await storeDoc(new Request(`https://demo.invalid/api/doc?${q}`, { method: "POST", body: demoDoc(r, event, names.get(r.u)) }), env);
    }
    await kv.delete(r.id);
  }
  if (ready.length) await forgetRequests(env, ready.map((r) => r.id));

  for (const { name } of (await kv.list({ prefix: "event:" })).keys) {
    if (!dashId(name)) continue;
    const event = await kv.get(name, "json");
    if (Object.hasOwn(STAGE_LABELS, event?.a) && now - Number(event.at) >= WORK_MS.change) {
      const moves = isObject(state.patch.stages[event.u]) ? state.patch.stages[event.u] : {};
      state.patch.stages[event.u] = Object.fromEntries(Object.entries({ ...moves, [event.j]: event.a }).slice(-50));
      state.dirty = true;
      await kv.delete(name);
      continue;
    }
    if (event?.a !== "add_skill" || now - Number(event.at) < WORK_MS.skill) continue;
    const list = Array.isArray(state.patch.skills[event.u]) ? state.patch.skills[event.u] : [];
    state.patch.skills[event.u] = [...new Set([...list, ...(event.skills || [])])].slice(-50);
    state.dirty = true;
    await kv.delete(name);
  }

  for (const { name } of (await kv.list({ prefix: "queue:" })).keys) {
    const item = await kv.get(name, "json");
    if (item?.type !== "admin" || now - Number(item.at) < WORK_MS.change) continue;
    applyChange(state.patch, item, now);
    state.dirty = true;
    await kv.delete(name);
  }
}

function applyChange(patch, item, now) {
  const u = String(item.u || "");
  const mine = () => (patch.profiles[u] = isObject(patch.profiles[u]) ? patch.profiles[u] : {});
  if (item.action === "pause" || item.action === "resume") mine().status = item.action === "pause" ? "paused" : "active";
  else if (item.action === "assign") mine().recruiter = String(item.recruiter || "");
  else if (item.action === "delete") mine().deleted = true;
  else if (item.action === "send_now") Object.assign(mine(), { scan: now, stopped: false });
  else if (item.action === "profile") {
    for (const part of ["details", "job", "report"]) if (isObject(item[part])) mine()[part] = { ...mine()[part], ...item[part] };
  } else if (item.action === "cancel" && typeof item.task === "string") {
    patch.cancelled = [...new Set([...patch.cancelled, item.task])].slice(-50);
    if (item.task === `report:${u}`) Object.assign(mine(), { stopped: true, scan: 0 });
  }
}

// Lay the pretend HermitShell's changes over the made-up desk, as its next check-in would report them.
function applyPatch(kv, patch, now) {
  const current = JSON.parse(kv.store.get("status:profiles"));
  const scans = [];
  current.profiles = current.profiles.filter((p) => !patch.profiles[p.id]?.deleted).map((p) => {
    const c = patch.profiles[p.id];
    if (!isObject(c)) return p;
    const next = { ...p, details: { ...p.details, ...c.details }, job: { ...p.job, ...c.job }, report: { ...p.report, ...c.report } };
    if (c.status) next.status = c.status;
    if (typeof c.recruiter === "string") next.recruiter = c.recruiter;
    if (c.details?.name) next.name = c.details.name;
    if (c.details?.email) next.email = c.details.email;
    if (c.stopped) delete next.scanning;
    if (c.scan && now - c.scan < WORK_MS.scan) {
      next.scanning = c.scan;
      scans.push({ id: `report:${p.id}`, kind: "report", u: p.id, state: "running", at: c.scan, trigger: "dashboard", stage: "Rating jobs",
        done: Math.floor(((now - c.scan) / WORK_MS.scan) * 20), total: 20, expected: WORK_MS.scan });
    } else if (c.scan) {
      delete next.scanning;
      next.last_run = c.scan + WORK_MS.scan;
    }
    return next;
  });
  const left = new Set(current.profiles.map((p) => p.id));
  current.tasks = [...(current.tasks || []).filter((t) => !patch.cancelled.includes(t.id) && left.has(t.u)
    && !(t.kind === "report" && (patch.profiles[t.u]?.stopped || scans.some((s) => s.u === t.u)))), ...scans];
  kv.store.set("status:profiles", JSON.stringify(current));
  for (const [u, added] of Object.entries(patch.skills)) {
    const stats = kv.store.get(`stats:${u}`);
    if (!stats || !Array.isArray(added)) continue;
    const parsed = JSON.parse(stats);
    parsed.skills = [...new Set([...(Array.isArray(parsed.skills) ? parsed.skills : []), ...added.filter((s) => typeof s === "string")])];
    kv.store.set(`stats:${u}`, JSON.stringify(parsed));
  }
  const today = zonedToday(TZ, now);
  for (const [u, moves] of Object.entries(patch.stages)) {
    const sent = kv.store.get(`sent:${u}`);
    const parsed = sent ? JSON.parse(sent) : null;
    if (!isObject(moves) || !Array.isArray(parsed?.board)) continue;
    parsed.board = parsed.board.map((c) => (moves[c.key] && moves[c.key] !== c.stage ? { ...c, stage: moves[c.key], day: today } : c));
    kv.store.set(`sent:${u}`, JSON.stringify(parsed));
  }
}

// The made-up PDF the pretend HermitShell "writes" for a letter or tailored CV asked for in demo mode.
function demoDoc(r, event, name = "The recruit") {
  const [title, employer] = String(r.n || "the role").split(" at ");
  const style = [event.len, event.tone].filter(Boolean).join(", ");
  const lines = r.a === "cover_letter"
    ? [`Cover letter (demo${style ? `, ${style}` : ""})`, "", name, "", `Dear Hiring Manager${employer ? ` at ${employer}` : ""},`, "",
      `I am writing to apply for the ${title} role. This letter was made in HermitShell's demo mode,`,
      "so the candidate, the company and the role are all made up, and no model wrote it.", "", "Yours sincerely,", name]
    : r.a === PROFILE_CV ? ["CV (demo)", "", name, "", "This CV was made in HermitShell's demo mode: the candidate and every role on it are",
      "made up, and no model wrote it."]
    : r.a === "interview_prep" ? ["Interview prep (demo)", "", name, "", `For: ${r.n || "the role"}`, "",
      "1. Tell us about a project you are proud of.", "2. Why this role?", "",
      "This pack was made in HermitShell's demo mode: the candidate, the company and the role are all", "made up, and no model wrote it."]
    : ["Tailored CV (demo)", "", name, "", `Tailored for: ${r.n || "the role"}`, "",
      "This CV was made in HermitShell's demo mode: the candidate, the company and the role are all", "made up, and no model wrote it."];
  return textPdf(lines.map((line) => line.replace(/[^\x20-\x7e]/g, "-")));
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
const ANSWERS = ["applied", "heard_back", "interested", "interview", "good_match", "", "not_for_me", "offer", "rejected"];
const DAYS_AGO = [0, 0, 1, 1, 2, 3, 5, 6, 9];
const ANSWER_LABELS = { applied: "I applied", heard_back: "Heard back", interested: "Interested", good_match: "Good match", not_for_me: "Not for me",
  rejected: "Rejected", interview: "Got an interview", offer: "Offer" };
// Older applications already on the board: [title, employer, stage, days ago].
const EARLIER = [["Analyst", "Litware", "placed", 34], ["Consultant", "Proseware", "interview", 12], ["Team Lead", "Fabrikam", "applied", 15],
  ["Specialist", "Northwind", "rejected", 21]];

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
      days[isoDay(at)] = new Array(19).fill(0);
      continue;
    }
    const weekend = [0, 6].includes(new Date(at).getUTCDay());
    const growth = 0.7 + 0.5 * (1 - i / p.age);
    const rated = Math.round((weekend ? 5 : 13) * p.scale * growth * (0.6 + rand() * 0.8));
    const sent = Math.round(rated * (0.35 + rand() * 0.25));
    const pick = (chance) => (rand() < chance ? 1 + (rand() < chance / 3 ? 1 : 0) : 0);
    days[isoDay(at)] = [Math.round(rated * (7 + rand() * 5)), rated, sent, Math.round(sent * (6.3 + rand() * 1.6)), sent,
      Math.round(sent * rand() * 0.45), 1, pick(0.4), pick(0.25), pick(0.3), pick(0.16), pick(0.06), pick(0.05), pick(0.1), pick(0.05), pick(0.06),
      pick(0.04), pick(0.015), pick(0.008)];
  }
  const sent = jobsFor(p, end);
  const board = [...sent.filter((j) => j.answer && j.answer !== "not_for_me").map((j) => ({ key: j.key, title: j.title, employer: j.employer,
    stage: j.answer, day: j.day })), ...EARLIER.filter((_, i) => i < Math.ceil(p.scale * 4)).map(([title, employer, stage, ago], i) => ({
    key: `https://jobs.example.com/demo/${p.id}/${900 + i}`, title: `${title}, ${p.titles[0]}`.slice(0, 90), employer, stage,
    day: isoDay(end - (ago + pausedFor(p)) * DAY) }))];
  const scaled = (pairs, k) => pairs.map(([name, c]) => [name, Math.ceil(c * k * p.scale)]);
  const range = (k) => ({
    employers: scaled(p.employers.map((e, i) => [e, 9 - i * 2]), k / 30),
    sources: scaled(SOURCES.map((s, i) => [s, 21 - i * 4]), k / 30),
    modes: scaled([["Hybrid", 18], ["Remote", 9], ["On-site", 5]], k / 30),
    fit: [0, 1, 3, 6, 11, 19, 27, 31, 18, 7, 2].map((c) => Math.ceil(c * k * p.scale / 30)),
    salary: p.salary,
    best: sent.slice(0, 3).map((j) => ({ title: j.title, employer: j.employer, fit: j.fit, day: j.day })),
  });
  const pipeline = Object.fromEntries(Object.entries({ interested: 9, good_match: 4, not_for_me: 12, applied: 6, heard_back: 3, rejected: 2,
    interview: 2, offer: 1, placed: 1 }).map(([k, v]) => [k, Math.max(1, Math.round(v * p.scale))]));
  return { v: 1, today: isoDay(end), since: isoDay(end - (p.age - 1) * DAY), days,
    ranges: { 7: range(7), 30: range(30), 90: range(90), 365: range(365) }, pipeline, sent, board,
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
    usage: { days: 7, since: isoDay(now - 6 * DAY), tasks: [
      { task: "triage", today: { calls: 6, failed: 0, in: 5400, out: 1900, avg_ms: 2100, estimated: 0 }, period: { calls: 41, failed: 0, in: 37800, out: 13100, avg_ms: 2300, estimated: 0 } },
      { task: "rating", today: { calls: 64, failed: 1, in: 131000, out: 20500, avg_ms: 4200, estimated: 0 }, period: { calls: 402, failed: 3, in: 820000, out: 129000, avg_ms: 4400, estimated: 12 } },
      { task: "verify", today: { calls: 5, failed: 0, in: 7200, out: 600, avg_ms: 1800, estimated: 0 }, period: { calls: 29, failed: 0, in: 41800, out: 3500, avg_ms: 1900, estimated: 0 } },
      { task: "summary", today: { calls: 3, failed: 0, in: 1500, out: 420, avg_ms: 1500, estimated: 0 }, period: { calls: 19, failed: 0, in: 9500, out: 2700, avg_ms: 1600, estimated: 0 } },
      { task: "letter", today: { calls: 2, failed: 0, in: 11800, out: 1300, avg_ms: 14800, estimated: 0 }, period: { calls: 9, failed: 0, in: 53100, out: 5900, avg_ms: 15200, estimated: 0 } },
      { task: "cv_tailor", today: { calls: 1, failed: 0, in: 4700, out: 1450, avg_ms: 16900, estimated: 0 }, period: { calls: 5, failed: 0, in: 23400, out: 7200, avg_ms: 17300, estimated: 0 } },
    ] },
    server: { cpu: { model: "AMD Ryzen 9 7950X", cores: 32 }, load: 4.1, ram_mb: { total: 65536, available: 38000 },
      gpus: [{ name: "NVIDIA GeForce RTX 4090", vram_mb: 24576, free_mb: 6100 }], disk_mb: { total: 1907000, free: 1210000 } },
    backup: { at: now - 5 * 3600000, size: 18_400_000, kept: 14, error: "", failed_at: null, encrypted: true },
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
    await rememberWeek(env, p.id, stats, now);
  }

  // Each recruit's history, in the entries record() writes, one KV value per month.
  const names = Object.fromEntries([["admin", ADMIN_NAME], ...RECRUITERS.map((r) => [r.id, r.name])]);
  const months = new Map();
  const log = (pid, k, t, at, { by = "", via = "dashboard", h = "" } = {}) => {
    const key = historyKey(pid, at);
    months.set(key, [...(months.get(key) || []), { at, k, t, v: via, ...(by ? { by } : {}), ...(h ? { h } : {}) }]);
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
      // Today's answers late in the afternoon, or just now early in the day: never in the future.
      const at = Math.min(Date.parse(`${j.day}T12:00:00Z`) + 5 * HOUR, now - 20 * 60000);
      log(p.id, "answer", `Answered ${ANSWER_LABELS[j.answer]}: ${j.title} at ${j.employer}`, at, { via: "email" });
    }
  }
  // The request for the cover letter kept below, the newest entry, so its history entry has a Download button.
  const first = jobsFor(PEOPLE[0], end)[0];
  log(PEOPLE[0].id, "cover_letter", `Asked for a cover letter: ${first.title} at ${first.employer}`, now - 10 * 60000,
    { by: names[PEOPLE[0].recruiter], h: await jobHash(first.key) });
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

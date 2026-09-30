// A recruit's history (/admin/history): a timeline of everything done to or for them, from the dashboard, their
// email buttons and HermitShell itself. It is kept until they unsubscribe or are deleted (purgeProfileEvents);
// the letters and CVs it mentions are not. One KV value per recruit and month (history:<id>:YYYY-MM), so an
// event costs one read and one write, and the page one list and one read.

import { BACK_TO_RECRUITS, esc, historyPrefix, page, when, PROFILE_RE } from "./lib.js";

export const HISTORY_URL = "/admin/history";
export const MAX_MONTH = 1000;
const MAX_TEXT = 200;
const MAX_BY = 80;
const MAX_MONTHS_SHOWN = 24;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const VIA = { dashboard: "", email: "from an email button", hermitshell: "HermitShell" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ICON = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const PATHS = {
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/><path d="m11 13 9-9"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.8 3.4-5.5 7-5.5s6.2 1.7 7 5.5"/>',
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
  star: '<path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z"/>',
  reply: '<path d="M10 8 5 12l5 4"/><path d="M5 12h9a5 5 0 0 1 5 5v1"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2.5"/>',
  cross: '<circle cx="12" cy="12" r="8"/><path d="m9 9 6 6M15 9l-6 6"/>',
};
// Each kind of event: its icon and colour.
const KINDS = {
  details: ["edit", "brand"], job: ["edit", "brand"], report_time: ["clock", "brand"], send: ["send", "violet"],
  report: ["send", "violet"], pause: ["pause", "amber"], resume: ["play", "green"], assign: ["person", "teal"],
  cv: ["doc", "blue"], cv_read: ["doc", "blue"], cover_letter: ["doc", "brand"], tailored_cv: ["doc", "brand"],
  send_job: ["mail", "brand"], skill: ["star", "amber"], answer: ["reply", "slate"], cancel: ["cross", "slate"],
};

function clean(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function historyKey(pid, at) {
  return `${historyPrefix(pid)}${new Date(at).toISOString().slice(0, 7)}`;
}

// "a", "a and b", "a, b and c".
export function listed(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// A full KV write limit, or any other failure, must not stop the action being recorded.
export async function record(env, pid, kind, text, { by = "", via = "dashboard", at = Date.now() } = {}) {
  if (!PROFILE_RE.test(pid || "") || !Object.hasOwn(KINDS, kind) || !clean(text, MAX_TEXT)) return;
  const entry = { at, k: kind, t: clean(text, MAX_TEXT), v: Object.hasOwn(VIA, via) ? via : "dashboard",
    ...(clean(by, MAX_BY) ? { by: clean(by, MAX_BY) } : {}) };
  try {
    const key = historyKey(pid, at);
    const stored = await env.FEEDBACK.get(key, "json");
    await env.FEEDBACK.put(key, JSON.stringify([...(Array.isArray(stored) ? stored : []), entry].slice(-MAX_MONTH)));
  } catch {
    // Nothing to do: the action itself has already been queued.
  }
}

// HermitShell's own events for each recruit, from the status it has just reported compared with the one before:
// a report that ran and a CV it has read. One at a time, as two writes to the same month would overwrite each other.
export async function recordReported(env, before, after) {
  const old = new Map((Array.isArray(before?.profiles) ? before.profiles : []).map((p) => [p?.id, p]));
  for (const p of Array.isArray(after?.profiles) ? after.profiles : []) {
    const was = old.get(p?.id);
    if (!was || !PROFILE_RE.test(p.id || "")) continue;
    if (Number(p.last_run) > Number(was.last_run || 0)) {
      await record(env, p.id, "report", "Job report ran", { via: "hermitshell", at: Number(p.last_run) });
    }
    if (Number(p.cv_updated) > Number(was.cv_updated || 0)) {
      await record(env, p.id, "cv_read", "Read the new CV and rebuilt the skills jobs are rated against",
        { via: "hermitshell", at: Number(p.cv_updated) });
    }
  }
}

// The main admin is staff, not a recruit: when HermitShell first reports that it moved their own job search to a
// recruit (the admin row's `recruit`), the history kept for the admin moves with it, month by month.
export async function moveOwnerHistory(env, before, after) {
  const ownerOf = (s) => (Array.isArray(s?.profiles) ? s.profiles : []).find((p) => p?.owner) || null;
  const owner = ownerOf(after);
  const to = owner?.recruit;
  if (typeof to !== "string" || !PROFILE_RE.test(to) || to === owner.id || ownerOf(before)?.recruit === to
    || !PROFILE_RE.test(owner.id || "")) return 0;
  const from = historyPrefix(owner.id);
  const { keys } = await env.FEEDBACK.list({ prefix: from, limit: 1000 });
  let moved = 0;
  for (const { name } of keys) {
    const month = name.slice(from.length);
    if (!MONTH_RE.test(month)) continue;
    const [mine, theirs] = await Promise.all([env.FEEDBACK.get(name, "json"), env.FEEDBACK.get(`${historyPrefix(to)}${month}`, "json")]);
    const merged = [...(Array.isArray(mine) ? mine : []), ...(Array.isArray(theirs) ? theirs : [])].filter(validEntry)
      .sort((a, b) => Number(a.at) - Number(b.at)).slice(-MAX_MONTH);
    await env.FEEDBACK.put(`${historyPrefix(to)}${month}`, JSON.stringify(merged));
    await env.FEEDBACK.delete(name);
    moved += 1;
  }
  return moved;
}

function validEntry(e) {
  return e && typeof e === "object" && Number.isFinite(Number(e.at)) && Number(e.at) > 0 && Object.hasOwn(KINDS, e.k)
    && typeof e.t === "string" && e.t;
}

async function months(env, pid) {
  const prefix = historyPrefix(pid);
  const { keys } = await env.FEEDBACK.list({ prefix, limit: 1000 });
  return keys.map((k) => k.name.slice(prefix.length)).filter((m) => MONTH_RE.test(m)).sort().reverse();
}

function monthName(m) {
  return `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
}

function dayName(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${Number(date.slice(8))} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
}

// Manage and History for one recruit, in place of the dashboard's tabs.
export function profileTabs(pid, active) {
  const tabs = [["manage", `/admin/profile?u=${esc(pid)}`, "Manage"], ["history", `${HISTORY_URL}?u=${esc(pid)}`, "History"]];
  return `<nav class="tabs" aria-label="Recruit pages">${tabs.map(([id, href, label]) =>
    `<a href="${href}"${id === active ? ' class="on" aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

function entryRow(e, tz) {
  const [shape, tone] = KINDS[e.k];
  const who = e.v === "dashboard" ? (e.by ? `by ${esc(e.by)}` : "") : esc(VIA[e.v] || "");
  const stamp = when(e.at, tz);
  return `<li class="hev"><span class="hdot ${tone}"><svg ${ICON}>${PATHS[shape]}</svg></span><div><b>${esc(e.t)}</b>
<small title="${esc(stamp)}">${esc(stamp.slice(11, 16))}${who ? ` &middot; ${who}` : ""}</small></div></li>`;
}

export const HISTORY_STYLE = `
.hmonths{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
.hmonths a{padding:5px 12px;border-radius:99px;border:1px solid var(--line);font-size:13px;font-weight:650;color:var(--muted);text-decoration:none;background:var(--field)}
.hmonths a:hover{color:var(--ink);border-color:#c9cfe0}.hmonths a.on{color:var(--brand-ink);background:var(--soft);border-color:#c7d2fe}
.hday{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:700;margin:18px 0 6px}
ol.htime{list-style:none;margin:0;padding:0 0 0 4px;position:relative}
ol.htime::before{content:"";position:absolute;left:18px;top:6px;bottom:6px;width:2px;background:var(--line);border-radius:2px}
.hev{position:relative;display:flex;gap:12px;align-items:flex-start;padding:7px 0}
.hev b{display:block;font-size:14px;font-weight:600;color:var(--ink);line-height:1.4;overflow-wrap:anywhere}
.hev small{font-size:12.5px;color:var(--muted)}
.hdot{flex:none;position:relative;z-index:1;width:30px;height:30px;border-radius:10px;display:grid;place-items:center;border:1px solid}
.hdot svg{width:15px;height:15px}
.hdot.brand{color:#4338ca;background:#eef2ff;border-color:#c7d2fe}.hdot.violet{color:#7c3aed;background:#f5f3ff;border-color:#ddd6fe}
.hdot.amber{color:#b45309;background:#fffbeb;border-color:#fde68a}.hdot.green{color:#047857;background:#ecfdf5;border-color:#a7f3d0}
.hdot.teal{color:#0e7490;background:#ecfeff;border-color:#a5f3fc}.hdot.blue{color:#1d4ed8;background:#eff6ff;border-color:#bfdbfe}
.hdot.slate{color:#475569;background:#f8fafc;border-color:#e2e8f0}
.hstart{margin:14px 0 0;padding:10px 14px;border:1px dashed var(--line);border-radius:12px;font-size:13px;color:var(--muted)}
`;

export async function historyPage(env, status, pid, monthParam) {
  const p = (status.profiles || []).find((x) => x.id === pid);
  if (!p) return page("Recruit not found", '<p>HermitShell has not reported this recruit. <a href="/admin">Back to recruits</a></p>', { status: 404 });
  const tz = status.timezone;
  const all = await months(env, pid);
  const month = all.includes(monthParam) ? monthParam : all[0] || "";
  const stored = month ? await env.FEEDBACK.get(`${historyPrefix(pid)}${month}`, "json") : null;
  const rows = (Array.isArray(stored) ? stored : []).filter(validEntry).map((e, i) => [e, i])
    .sort(([a, i], [b, j]) => b.at - a.at || j - i).map(([e]) => e);
  const days = [];
  for (const e of rows) {
    const date = when(e.at, tz).slice(0, 10);
    if (days.at(-1)?.date !== date) days.push({ date, rows: [] });
    days.at(-1).rows.push(e);
  }
  const picker = all.length > 1 ? `<nav class="hmonths" aria-label="Month">${all.slice(0, MAX_MONTHS_SHOWN).map((m) =>
    `<a href="${HISTORY_URL}?u=${esc(pid)}&amp;m=${m}"${m === month ? ' class="on" aria-current="page"' : ""}>${monthName(m)}</a>`).join("")}</nav>` : "";
  const oldest = !all.length || month === all.at(-1);
  const start = oldest && p.created ? `<p class="hstart">Joined HermitShell on ${esc(when(p.created, tz).slice(0, 10))}.</p>` : "";
  const timeline = days.map((d) => `<div class="hday">${esc(dayName(d.date))}</div><ol class="htime">${d.rows.map((e) => entryRow(e, tz)).join("")}</ol>`).join("");
  const intro = `<p class="muted">Everything done to or for this recruit: changes and requests from the dashboard, answers from their email buttons, and the reports HermitShell ran. Kept until they unsubscribe or are deleted; letters and CVs are only kept for a short time.</p>`;
  return page(p.name, `<style>${HISTORY_STYLE}</style>${profileTabs(pid, "history")}${intro}${picker}
${timeline || '<p class="muted">Nothing recorded yet. Changes, requests, answers and reports show here from now on.</p>'}${start}`,
  { wide: true, before: BACK_TO_RECRUITS });
}

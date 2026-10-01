// A profile's stats page (/admin/stats): KPI tiles, charts and top lists for the last 7 days, 30 days, 90 days or
// 12 months, drawn from the daily counts profiles.py sends (profile_stats.py; POST /api/stats, KV "stats:<id>").
// Pages may not run scripts (see CSP), so the charts are inline SVG, the motion is CSS (off for reduced motion)
// and hovering a bar shows its numbers through the SVG <title>.

import { currencyCode, currencySymbol, moneyIcon } from "./currency.js";
import { DOC_STYLE, SKILL_URL, docActions, jobHash, validJobKey } from "./docs.js";
import { HISTORY_URL, PIPELINE_URL } from "./history.js";
import { BACK_TO_RECRUITS, EXTERNAL_ICON, PROFILE_RE, ago, cleanSkill, esc, page, reloadTo, MONTHS_SHORT as MONTHS } from "./lib.js";

export const STATS_URL = "/admin/stats";
export const SENT_URL = "/admin/sent";
// The jobs sent carry each job's details ("more"), which are kept apart from the stats ("sent:<id>") so the
// dashboard, which reads every profile's stats, stays quick.
export const MAX_STATS_BYTES = 600 * 1024;
const MAX_SENT = 200;
// Same order as FIELDS in profile_stats.py. A day's row is read by position, so an older, shorter row reads 0 for
// the counts added since.
export const FIELDS = ["scanned", "rated", "sent", "fit_sum", "fit_n", "strong", "runs", "interested", "good_match",
  "not_for_me", "applied", "heard_back", "rejected", "cover_letter", "tailored_cv", "add_skill", "interview", "offer", "placed"];
// The Pipeline board (profile_stats.BOARD_STATUSES and BOARD_MAX): each job's latest stage, title and employer.
export const BOARD_STAGES = ["interested", "good_match", "applied", "heard_back", "interview", "offer", "placed", "rejected"];
export const MAX_BOARD = 200;
export const RANGES = { 7: "7 days", 30: "30 days", 90: "90 days", 365: "12 months" };
export const DEFAULT_RANGE = 30;
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// The skills HermitShell counts as on the CV (profile_stats.MAX_POOL).
const MAX_POOL = 200;
// "Also suits" (profile_stats.OTHERS_MAX) and salaries by job title (profile_stats.SALARY_MIN_N).
export const OTHERS_MAX = 5;
export const SALARY_MIN_N = 3;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ------------------------------------------------------------------------- what HermitShell may store

export function validStats(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  const days = s.days ?? {};
  if (!days || typeof days !== "object" || Array.isArray(days)) return false;
  const entries = Object.entries(days);
  return entries.length <= 800 && entries.every(([k, v]) => DATE_RE.test(k) && Array.isArray(v) && v.length <= 40 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))) &&
    (s.ranges == null || (typeof s.ranges === "object" && !Array.isArray(s.ranges))) &&
    (s.pipeline == null || (typeof s.pipeline === "object" && !Array.isArray(s.pipeline))) &&
    (s.skills == null || (Array.isArray(s.skills) && s.skills.length <= MAX_POOL && s.skills.every((k) => typeof k === "string" && k.length <= 60))) &&
    (s.sent == null || (Array.isArray(s.sent) && s.sent.length <= MAX_SENT &&
      s.sent.every((j) => j && typeof j === "object" && !Array.isArray(j) &&
        (j.more == null || (typeof j.more === "object" && !Array.isArray(j.more))) && validOthers(j.others)))) &&
    (s.board == null || (Array.isArray(s.board) && s.board.length <= MAX_BOARD && s.board.every(validCard)));
}

const shortText = (v, n) => v == null || (typeof v === "string" && v.length <= n);
const validFit = (n) => Number.isInteger(n) && n >= 0 && n <= 10;

function validOthers(v) {
  return v == null || (Array.isArray(v) && v.length <= OTHERS_MAX &&
    v.every((o) => o && typeof o === "object" && typeof o.u === "string" && PROFILE_RE.test(o.u) && validFit(o.fit)));
}

function validCard(c) {
  return Boolean(c) && typeof c === "object" && !Array.isArray(c) && validJobKey(c.key) && BOARD_STAGES.includes(c.stage) &&
    DATE_RE.test(c.day || "") && shortText(c.title, 200) && shortText(c.employer, 120);
}

// What is stored: the stats without the jobs' details, "Also suits" or the board, and "sent:<id>" with them all:
// { jobs, board }.
export function splitStats(stats) {
  const { board, ...rest } = stats;
  const sent = Array.isArray(stats.sent) ? stats.sent : [];
  return { stats: { ...rest, sent: sent.map(({ more, others, ...job }) => job) }, sent: { jobs: sent, board: Array.isArray(board) ? board : null } };
}

// "sent:<id>" as stored: { jobs, board }, or the jobs alone from before the board. null for what isn't there.
export function sentParts(value) {
  if (Array.isArray(value)) return { jobs: value, board: null };
  const ok = value && typeof value === "object";
  return { jobs: ok && Array.isArray(value.jobs) ? value.jobs : null, board: ok && Array.isArray(value.board) ? value.board : null };
}

// ------------------------------------------------------------------------- numbers

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const msOf = (iso) => Date.parse(`${iso}T00:00:00Z`);
const shortDay = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const weekday = (iso) => WEEKDAYS[new Date(msOf(iso)).getUTCDay()];

export function zonedToday(timeZone, now = Date.now()) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return isoOf(now);
  }
}

function dayList(end, count) {
  const last = msOf(end);
  return Array.from({ length: count }, (_, i) => isoOf(last - (count - 1 - i) * DAY_MS));
}

// The days of a range, split into chart bars (days; weeks for 90 days; calendar months for 12 months), and the
// same number of days before it for the change arrows (none for 12 months: older data is pruned after a year).
export function windowFor(range, today) {
  if (range === 365) {
    const [y, m] = today.split("-").map(Number);
    const months = Array.from({ length: 12 }, (_, i) => isoOf(Date.UTC(y, m - 12 + i, 1)).slice(0, 7));
    const days = dayList(today, Math.round((msOf(today) - msOf(`${months[0]}-01`)) / DAY_MS) + 1);
    return { days, previous: null, buckets: months.map((mo) => ({ label: MONTHS[Number(mo.slice(5)) - 1], name: `${MONTHS[Number(mo.slice(5)) - 1]} ${mo.slice(0, 4)}`, days: days.filter((d) => d.startsWith(mo)) })) };
  }
  const size = range === 90 ? 7 : 1;
  const days = dayList(today, range === 90 ? 91 : range);
  const buckets = [];
  for (let i = 0; i < days.length; i += size) {
    const part = days.slice(i, i + size);
    const n = buckets.length;
    const label = range === 7 ? weekday(part[0]) : range === 30 ? (n % 5 === 0 || i === days.length - 1 ? String(Number(part[0].slice(8))) : "")
      : n % 3 === 0 ? shortDay(part[0]) : "";
    buckets.push({ label, name: size === 1 ? `${weekday(part[0])} ${shortDay(part[0])}` : `Week of ${shortDay(part[0])}`, days: part });
  }
  return { days, buckets, previous: dayList(isoOf(msOf(days[0]) - DAY_MS), days.length) };
}

export function totals(stats, days) {
  const t = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  for (const d of days) {
    const row = stats?.days?.[d];
    if (Array.isArray(row)) FIELDS.forEach((f, i) => { t[f] += num(row[i]); });
  }
  t.liked = t.interested + t.good_match;
  t.letters = t.cover_letter + t.tailored_cv;
  t.fit = t.fit_n ? t.fit_sum / t.fit_n : 0;
  return t;
}

function compact(n) {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

// ------------------------------------------------------------------------- icons (24x24, animated by CSS)

const ICONS = {
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5" stroke-dasharray="2 2" opacity=".6"/><g class="spin"><path d="M12 12L12 3A9 9 0 0 1 19.8 7.5z" fill="currentColor" opacity=".3" stroke="none"/><path d="M12 12L19.8 7.5"/></g><circle cx="8" cy="15" r="1.3" fill="currentColor" stroke="none" class="ping"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" class="ping"/>',
  mail: '<g class="bob"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/></g>',
  heart: '<path class="beat" d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z" fill="currentColor" fill-opacity=".18"/>',
  plane: '<g class="float"><path d="M21 3L3 10.5l7 2.5 2.5 7z" fill="currentColor" fill-opacity=".15"/><path d="M21 3l-11 10"/></g>',
  chat: '<path d="M5 4.5h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-8.5L6 20.5V17H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z"/><circle class="dot" cx="8.5" cy="10.8" r="1.1" fill="currentColor" stroke="none"/><circle class="dot" cx="12" cy="10.8" r="1.1" fill="currentColor" stroke="none"/><circle class="dot" cx="15.5" cy="10.8" r="1.1" fill="currentColor" stroke="none"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path class="write" pathLength="1" d="M10 12.5h6M10 15.5h6M10 18.5h3.5"/>',
  star: '<path class="beat" d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="currentColor" fill-opacity=".18"/>',
  chart: '<path d="M4 20h16"/><rect class="grow" x="5.5" y="11" width="3" height="7" rx="1"/><rect class="grow g2" x="10.5" y="6" width="3" height="12" rx="1"/><rect class="grow g3" x="15.5" y="9" width="3" height="9" rx="1"/>',
  bolt: '<path class="beat" d="M13 2.5L5 13.5h6l-1 8 8-11h-6z" fill="currentColor" fill-opacity=".18"/>',
  coin: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  "money-gbp": '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="M8 12h4M10 16V9.5a2.5 2.5 0 0 1 5 0M8 16h7"/>',
  "money-eur": '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="M7 12h5M15 9.4a4 4 0 1 0 0 5.2"/>',
  "money-usd": '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8M12 18V6"/>',
};

export function icon(name, cls = "") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

// ------------------------------------------------------------------------- small charts

export function sparkline(values, { width = 120, height = 34, cls = "spark" } = {}) {
  const max = Math.max(...values, 0);
  if (!values.length) return "";
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const y = (v) => (max ? height - 3 - (v / max) * (height - 8) : height - 3).toFixed(1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${y(v)}`);
  if (values.length === 1) points.push(`${width},${y(values[0])}`);
  return `<svg class="${cls}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
<path class="area" d="M0,${height} L${points.join(" L")} L${width},${height} Z"/><path class="line" pathLength="1" d="M${points.join(" L")}"/></svg>`;
}

function delta(now, before) {
  if (before === null) return "";
  if (!before && !now) return '<span class="delta flat">&ndash;</span>';
  if (!before) return '<span class="delta up">new</span>';
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return '<span class="delta flat">0%</span>';
  return `<span class="delta ${pct > 0 ? "up" : "down"}" title="Compared with the period before">${pct > 0 ? "&#9650;" : "&#9660;"} ${Math.abs(pct)}%</span>`;
}

// One colour scale for match scores wherever they show: the rings, the match scores chart and the jobs sent list.
export function scoreTone(fit) {
  return fit >= 8 ? "green" : fit >= 6 ? "amber" : fit >= 5 ? "orange" : "slate";
}

const TONE_HEX = { green: "#059669", amber: "#d97706", orange: "#ea580c", slate: "#64748b", sky: "#0284c7" };

// A score ring in one of the k- tones: a tinted disc and track, an arc that sweeps in (again on hover) and, for
// strong scores (`hot`), a soft glow that breathes.
function ring(value, max, { size = 44, tone = "indigo", label = "", sub = "", hot = false } = {}) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return `<svg class="ring k-${tone}${hot ? " hot" : ""}" viewBox="0 0 36 36" width="${size}" height="${size}" aria-hidden="true">
<circle class="disc" cx="18" cy="18" r="12.4"/><circle class="track" cx="18" cy="18" r="15.915"/>
<circle class="arc" cx="18" cy="18" r="15.915" stroke-dasharray="${pct.toFixed(1)} ${(100 - pct).toFixed(1)}" stroke-dashoffset="25"/>${
    label ? `<text class="val" x="18" y="${sub ? 19.6 : 21.6}" text-anchor="middle">${esc(label)}</text>` : ""}${
    sub ? `<text class="sub" x="18" y="25.4" text-anchor="middle">${esc(sub)}</text>` : ""}</svg>`;
}

// ------------------------------------------------------------------------- the page's sections

const TILES = [
  ["scanned", "Scanned", "radar", "indigo", "Postings the job boards and searches returned"],
  ["rated", "Rated", "target", "violet", "Jobs HermitShell read and scored against the CV"],
  ["sent", "Sent", "mail", "blue", "Jobs in the reports"],
  ["fit", "Avg match", "star", "amber", "Average score of the jobs sent, out of 10"],
  ["liked", "Liked", "heart", "rose", "Interested or Good match presses"],
  ["applied", "Applied", "plane", "green", "I applied presses"],
  ["interview", "Interviews", "chat", "sky", "Jobs moved to Interview, from an email button or the Pipeline"],
  ["letters", "Letters & CVs", "doc", "orange", "Cover letters and tailored CVs asked for"],
];

function bucketValue(stats, bucket, key) {
  const t = totals(stats, bucket.days);
  return key === "fit" ? t.fit : t[key];
}

function tiles(stats, win, now, before) {
  return `<div class="kpis">${TILES.map(([key, label, ico, color, hint], i) => {
    const value = now[key];
    const shown = key === "fit" ? (now.fit_n ? `${value.toFixed(1)}<small>/10</small>` : "&ndash;") : compact(value);
    const change = before ? delta(value, key === "fit" && !before.fit_n ? null : before[key]) : "";
    return `<div class="kpi k-${color}" style="animation-delay:${i * 45}ms" title="${esc(hint)}">
<div class="kpi-top"><span class="ico">${icon(ico)}</span>${change}</div>
<div class="kpi-num">${shown}</div><div class="kpi-label">${esc(label)}</div>
${sparkline(win.buckets.map((b) => bucketValue(stats, b, key)))}</div>`;
  }).join("")}</div>`;
}

function chips(stats, win, now, range, currency) {
  const best = win.buckets.map((b) => ({ b, t: totals(stats, b.days) })).filter((x) => x.t.sent)
    .sort((a, b) => b.t.sent - a.t.sent)[0];
  const salary = num(stats.ranges?.[range]?.salary);
  const items = [
    ["bolt", `<b>${compact(now.strong)}</b> strong matches (8+)`],
    ["radar", `<b>${compact(now.runs)}</b> scan${now.runs === 1 ? "" : "s"}`],
    best ? ["chart", `Best ${range === 365 ? "month" : range === 90 ? "week" : "day"} <b>${esc(best.b.name)}</b> (${compact(best.t.sent)} sent)`] : null,
    salary ? [moneyIcon("", currency), `Median salary <b>${esc(currencySymbol(currencyCode(currency)))}${compact(salary)}</b>`] : null,
    now.not_for_me ? ["target", `<b>${compact(now.not_for_me)}</b> not for me`] : null,
  ].filter(Boolean);
  return `<div class="chips">${items.map(([ico, html], i) => `<span class="chip" style="animation-delay:${300 + i * 60}ms"><span class="ci">${icon(ico)}</span>${html}</span>`).join("")}</div>`;
}

function activity(stats, win) {
  const W = 720, H = 210, left = 34, bottom = 24, top = 10;
  const rows = win.buckets.map((b) => ({ b, t: totals(stats, b.days) }));
  const max = Math.max(1, ...rows.map((r) => r.t.rated), ...rows.map((r) => r.t.sent));
  const slot = (W - left) / rows.length;
  const bw = Math.min(26, slot * 0.64);
  const y = (v) => top + (H - top - bottom) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const grid = [...new Set(ticks)].map((v) => `<line x1="${left}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="gridline"/>
<text x="${left - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="axis">${compact(v)}</text>`).join("");
  const bars = rows.map(({ b, t }, i) => {
    const x = left + i * slot + (slot - bw) / 2;
    const delay = `style="animation-delay:${Math.round(i * (600 / rows.length))}ms"`;
    const applied = t.applied ? `<circle cx="${(x + bw / 2).toFixed(1)}" cy="${(y(Math.max(t.rated, t.sent)) - 9).toFixed(1)}" r="${t.applied > 1 ? 7 : 4.5}" class="applied" ${delay}/>${t.applied > 1 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(y(Math.max(t.rated, t.sent)) - 5.8).toFixed(1)}" text-anchor="middle" class="count">${t.applied}</text>` : ""}` : "";
    return `<g><title>${esc(b.name)}: ${t.rated} rated, ${t.sent} sent, ${t.liked} liked, ${t.applied} applied</title>
<rect x="${x.toFixed(1)}" y="${top}" width="${bw.toFixed(1)}" height="${H - top - bottom}" class="hover"/>
<rect x="${x.toFixed(1)}" y="${y(t.rated).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - bottom - y(t.rated)).toFixed(1)}" rx="4" class="bar rated" ${delay}/>
<rect x="${(x + bw * 0.18).toFixed(1)}" y="${y(t.sent).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${(H - bottom - y(t.sent)).toFixed(1)}" rx="3" class="bar sent" ${delay}/>
${applied}${b.label ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="axis">${esc(b.label)}</text>` : ""}</g>`;
  }).join("");
  const empty = rows.every((r) => !r.t.rated && !r.t.sent) ? `<text x="${(W + left) / 2}" y="${H / 2}" text-anchor="middle" class="empty">Nothing in this period yet</text>` : "";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Jobs rated, sent and applied for over time">
<defs><linearGradient id="g-sent" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
${grid}${bars}${empty}</svg>`;
}

function funnel(now) {
  const steps = [["Scanned", now.scanned, "indigo"], ["Rated", now.rated, "violet"], ["Sent", now.sent, "blue"],
    ["Liked", now.liked, "rose"], ["Applied", now.applied, "green"], ["Interview", now.interview, "sky"],
    ["Placed", now.placed, "amber"]];
  const max = Math.max(1, ...steps.map((s) => s[1]));
  return `<div class="funnel">${steps.map(([label, value, color], i) => {
    const width = value ? Math.max(6, Math.sqrt(value / max) * 100) : 0;
    const prev = i ? steps[i - 1][1] : 0;
    const conv = i && prev ? `<span class="conv">${Math.round((value / prev) * 100)}%</span>` : i ? '<span class="conv">&ndash;</span>' : "";
    return `<div class="step k-${color}"><span class="step-label">${label}</span><span class="track"><span class="fillbar" style="width:${width.toFixed(1)}%;animation-delay:${i * 90}ms"></span></span><b>${compact(value)}</b>${conv}</div>`;
  }).join("")}</div>`;
}

// The same colours as the tiles and bubbles for the same answers: rose for liked, green applied, sky heard back.
export const ANSWERS = [["interested", "Interested", "#e11d48"], ["good_match", "Good match", "#d97706"], ["applied", "Applied", "#059669"],
  ["heard_back", "Heard back", "#0284c7"], ["interview", "Interview", "#7c3aed"], ["offer", "Offer", "#db2777"],
  ["placed", "Placed", "#4f46e5"], ["rejected", "Rejected", "#64748b"], ["not_for_me", "Not for me", "#ea580c"]];

function donut(now) {
  const parts = ANSWERS.map(([k, label, color]) => [label, now[k], color]).filter((p) => p[1]);
  const total = parts.reduce((s, p) => s + p[1], 0);
  let offset = 25;
  const arcs = parts.map(([label, value, color], i) => {
    const pct = (value / total) * 100;
    const arc = `<circle class="arc" cx="21" cy="21" r="15.915" fill="none" stroke="${color}" stroke-width="5.5" stroke-dasharray="${Math.max(0, pct - 0.8).toFixed(2)} ${(100 - Math.max(0, pct - 0.8)).toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" style="animation-delay:${i * 120}ms"><title>${esc(label)}: ${value}</title></circle>`;
    offset -= pct;
    return arc;
  }).join("");
  const legend = parts.length ? parts.map(([label, value, color]) => `<li><span class="sw" style="background:${color}"></span>${esc(label)}<b>${compact(value)}</b></li>`).join("")
    : '<li class="muted">No button presses in this period</li>';
  return `<div class="donut"><svg viewBox="0 0 42 42" role="img" aria-label="Answers given with the report buttons">
<circle cx="21" cy="21" r="15.915" fill="none" stroke="#eceef6" stroke-width="5.5"/>${arcs}
<text x="21" y="22" text-anchor="middle" class="big">${compact(total)}</text><text x="21" y="27.5" text-anchor="middle" class="small">answers</text></svg>
<ul class="legend">${legend}</ul></div>`;
}

function histogram(fit) {
  const counts = Array.from({ length: 11 }, (_, i) => num(fit?.[i]));
  const W = 330, H = 150, bottom = 20, max = Math.max(1, ...counts);
  const slot = W / 11;
  const bars = counts.map((c, i) => {
    const h = ((H - bottom - 8) * c) / max;
    return `<g><title>Score ${i}: ${c} job${c === 1 ? "" : "s"}</title><rect x="${(i * slot + 3).toFixed(1)}" y="${(H - bottom - h).toFixed(1)}" width="${(slot - 6).toFixed(1)}" height="${h.toFixed(1)}" rx="3" class="bar score k-${scoreTone(i)}" style="animation-delay:${i * 50}ms"/>
<text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle" class="axis">${i}</text></g>`;
  }).join("");
  const empty = counts.every((c) => !c) ? `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="empty">No jobs rated yet</text>` : "";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="How well the jobs rated matched, from 0 to 10">${bars}${empty}</svg>`;
}

function pipeline(p) {
  const items = [["applied", "Waiting", "plane", "green"], ["heard_back", "Heard back", "chat", "sky"],
    ["interview", "Interview", "chat", "violet"], ["offer", "Offer", "star", "rose"], ["placed", "Placed", "star", "amber"],
    ["rejected", "Rejected", "target", "slate"]];
  const replies = ["heard_back", "interview", "offer", "placed", "rejected"].reduce((s, k) => s + num(p?.[k]), 0);
  const applications = num(p?.applied) + replies;
  const rate = applications ? Math.round((replies / applications) * 100) : 0;
  return `<div class="pipe"><div class="rate">${ring(replies, applications, { size: 96, tone: "sky", label: applications ? `${rate}%` : "–" })}
<span class="muted">reply rate</span></div><div class="bubbles">${items.map(([k, label, ico, color]) =>
    `<div class="bubble k-${color}"><span class="ico">${icon(ico)}</span><b>${compact(num(p?.[k]))}</b><span>${label}</span></div>`).join("")}</div></div>`;
}

function topList(pairs, color) {
  const rows = (Array.isArray(pairs) ? pairs : []).filter((p) => Array.isArray(p) && p[0]).slice(0, 5);
  if (!rows.length) return '<p class="muted">Nothing sent in this period yet.</p>';
  const max = Math.max(1, ...rows.map((p) => num(p[1])));
  return `<ul class="toplist k-${color}">${rows.map(([name, n], i) => `<li><span class="name" title="${esc(name)}">${esc(String(name).slice(0, 60))}</span>
<span class="track"><span class="fillbar" style="width:${Math.max(4, (num(n) / max) * 100).toFixed(1)}%;animation-delay:${i * 70}ms"></span></span><b>${compact(num(n))}</b></li>`).join("")}</ul>`;
}

// Salaries by job title ([{title, n, median, currency?}]): only titles with SALARY_MIN_N salaries or more, so no
// single advert's salary is shown on its own. A row's own currency wins over the recruit's.
export function salaryList(rows, currency = "") {
  const shown = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.title === "string" && r.title.trim() &&
    Number.isInteger(r.n) && r.n >= SALARY_MIN_N && num(r.median)).slice(0, 12);
  if (!shown.length) return `<p class="muted">Shown once ${SALARY_MIN_N} jobs with the same title give a salary.</p>`;
  const max = Math.max(...shown.map((r) => num(r.median)));
  return `<ul class="toplist money k-green">${shown.map((r, i) => {
    const symbol = currencySymbol(currencyCode(typeof r.currency === "string" ? r.currency : currency));
    return `<li><span class="name" title="${esc(r.title)}">${esc(r.title.slice(0, 60))} <small class="muted">${r.n} jobs</small></span>
<span class="track"><span class="fillbar" style="width:${Math.max(4, (num(r.median) / max) * 100).toFixed(1)}%;animation-delay:${i * 70}ms"></span></span><b>${esc(symbol)}${compact(num(r.median))}</b></li>`;
  }).join("")}</ul>`;
}

function modes(pairs) {
  const rows = (Array.isArray(pairs) ? pairs : []).filter((p) => Array.isArray(p) && p[0] && num(p[1]));
  const total = rows.reduce((s, p) => s + num(p[1]), 0);
  if (!total) return "";
  const colors = ["#6366f1", "#10b981", "#f59e0b", "#94a3b8"];
  return `<div class="stack">${rows.map(([name, n], i) => `<span style="flex:${num(n)};background:${colors[i % 4]}" title="${esc(name)}: ${num(n)}"></span>`).join("")}</div>
<ul class="legend row">${rows.map(([name, n], i) => `<li><span class="sw" style="background:${colors[i % 4]}"></span>${esc(String(name).slice(0, 20))}<b>${Math.round((num(n) / total) * 100)}%</b></li>`).join("")}</ul>`;
}

function bestMatches(best) {
  const rows = (Array.isArray(best) ? best : []).filter((b) => b && b.title).slice(0, 3);
  if (!rows.length) return '<p class="muted">No jobs sent in this period yet.</p>';
  return `<ul class="best">${rows.map((b, i) => {
    const fit = Math.min(10, num(b.fit));
    const tone = scoreTone(fit);
    return `<li class="k-${tone}" style="animation-delay:${i * 80}ms">${ring(fit, 10, { size: 56, tone, label: String(fit), sub: "/ 10", hot: fit >= 8 })}<div><b>${esc(String(b.title).slice(0, 90))}</b>
<span class="muted">${esc(String(b.employer || "").slice(0, 60))}${DATE_RE.test(b.day || "") ? ` &middot; ${shortDay(b.day)}` : ""}</span></div></li>`;
  }).join("")}</ul>`;
}

function card(title, ico, body, cls = "", tone = "indigo") {
  return `<section class="card ${cls}"><h3><span class="ico sm k-${tone}">${icon(ico)}</span>${esc(title)}</h3>${body}</section>`;
}

function rangeTabs(pid, range) {
  return `<nav class="tabs" aria-label="Time range">${Object.entries(RANGES).map(([r, label]) =>
    `<a href="${STATS_URL}?u=${esc(pid)}&amp;r=${r}"${Number(r) === range ? ' class="on" aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

// The dashboard row's two buttons: this week's jobs sent as a sparkline (the stats page) and a number (the jobs).
export function statsLink(p, stats, timeZone) {
  const href = `${STATS_URL}?u=${esc(p.id)}`;
  if (!stats) return `<a class="statlink" href="${href}">${icon("chart")}Stats</a>`;
  const days = dayList(zonedToday(timeZone), 7);
  const week = totals(stats, days);
  return `<span class="statpair"><a class="statlink" href="${href}" title="Stats and charts. The line: jobs sent each day this week" aria-label="Stats and charts">${sparkline(days.map((d) => totals(stats, [d]).sent), { width: 56, height: 20, cls: "mini" })}</a><a class="statlink" href="${SENT_URL}?u=${esc(p.id)}&amp;r=7" title="The jobs sent this week"><b>${compact(week.sent)}</b> sent</a></span>`;
}

// ------------------------------------------------------------------------- the jobs sent (/admin/sent)

export const SENT_RANGES = { 7: "7 days", 30: "30 days", 90: "90 days" };
const ANSWER_LABELS = Object.fromEntries(ANSWERS.map(([k, label, color]) => [k, [label, color]]));
const LINK_RE = /^https?:\/\/[^\s"'<>]+$/i;
const cut = (v, n) => String(v ?? "").slice(0, n);

export function sentJobs(stats) {
  return (Array.isArray(stats?.sent) ? stats.sent : []).filter((j) => j && typeof j === "object" && j.title && DATE_RE.test(j.day || ""))
    .slice(0, MAX_SENT);
}

function sentTabs(pid, range, answer) {
  const a = answer ? `&amp;a=${esc(answer)}` : "";
  return `<nav class="tabs" aria-label="Time range">${Object.entries(SENT_RANGES).map(([r, label]) =>
    `<a href="${SENT_URL}?u=${esc(pid)}&amp;r=${r}${a}"${Number(r) === range ? ' class="on" aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

function answerFilter(pid, range, answer, jobs) {
  const counts = { "": jobs.length, none: jobs.filter((j) => !ANSWER_LABELS[j.answer]).length };
  for (const [k] of ANSWERS) counts[k] = jobs.filter((j) => j.answer === k).length;
  const options = [["", "All"], ["none", "No answer yet"], ...ANSWERS.map(([k, label]) => [k, label])]
    .filter(([k]) => k === "" || counts[k] || k === answer);
  return `<nav class="answers" aria-label="Filter by answer">${options.map(([k, label]) =>
    `<a href="${SENT_URL}?u=${esc(pid)}&amp;r=${range}${k ? `&amp;a=${k}` : ""}"${k === answer ? ' class="on" aria-current="page"' : ""}>${esc(label)} <b>${counts[k]}</b></a>`).join("")}</nav>`;
}

const text = (v, n) => (typeof v === "string" ? v.slice(0, n).trim() : "");
const percent = (v) => (Number.isInteger(v) && v >= 0 && v <= 100 ? v : null);
const words = (v, n) => (Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim()).slice(0, n).map((s) => s.slice(0, 60)) : []);
const safeUrl = (v) => (typeof v === "string" && v.length <= 500 && LINK_RE.test(v) ? v : "");
const domain = (url) => url.replace(/^https?:\/\/(www\.)?/i, "").split(/[/?#]/)[0].slice(0, 60);

function closingPill(closing, today) {
  if (!DATE_RE.test(closing || "")) return "";
  const days = Math.round((msOf(closing) - msOf(today)) / DAY_MS);
  const label = days < 0 ? "Closed" : days === 0 ? "Closes today" : days === 1 ? "Closes tomorrow" : `Closes in ${days} days`;
  return `<span class="fact${days <= 3 ? " soon" : ""}" title="Closing date ${esc(closing)}">${label}</span>`;
}

function meter(label, value, max, color, suffix) {
  if (value === null) return "";
  return `<div class="meter"><span>${label}</span><b>${value}${suffix}</b><i><em style="width:${Math.max(3, Math.round((value / max) * 100))}%;background:${color}"></em></i></div>`;
}

function skillChips(label, items, cls) {
  return items.length ? `<div class="skills ${cls}"><span class="lbl">${label}</span><div>${items.map((s) => `<span>${esc(s)}</span>`).join("")}</div></div>` : "";
}

const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

// The skills missing from the CV. Each is a button that adds it to the skills HermitShell counts as on the CV; one
// already counted has a tick, and one added here that HermitShell has not reported back yet shows as being added.
function gapChips(items, key, ctx) {
  if (!items.length) return "";
  let open = 0;
  const chips = items.map((shown) => {
    const skill = cleanSkill(shown);
    const low = skill.toLowerCase();
    if (skill && ctx.skills.has(low)) return `<span class="added" title="Counted as on the CV">${TICK}${esc(shown)}</span>`;
    if (skill && ctx.adding.has(low)) {
      return `<span class="adding" title="Added. HermitShell counts it from its next check-in">${TICK}${esc(shown)}</span>`;
    }
    if (!skill || !key || !ctx.csrf) return `<span>${esc(shown)}</span>`;
    open += 1;
    return `<form method="post" action="${SKILL_URL}"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
<input type="hidden" name="u" value="${esc(ctx.profile)}"><input type="hidden" name="j" value="${esc(key)}"><input type="hidden" name="s" value="${esc(skill)}">
<input type="hidden" name="back" value="${esc(ctx.back)}"><button title="Add ${esc(skill)} to the skills on the CV">${PLUS}${esc(shown)}</button></form>`;
  }).join("");
  const hint = open ? `<small class="skillhint">Press a skill they have to count it as on the CV.</small>` : "";
  return `<div class="skills gap"><span class="lbl">Missing from the CV</span><div>${chips}</div>${hint}</div>`;
}

// The other recruits HermitShell rated this job a fit for, each linking to their jobs sent; only those the person
// looking may see (ctx.visible: id to name), whatever HermitShell sent.
function alsoSuits(others, ctx) {
  const seen = (Array.isArray(others) ? others : []).filter((o) => o && ctx.visible?.has(o.u) && validFit(o.fit)).slice(0, OTHERS_MAX);
  if (!seen.length) return "";
  return `<div class="skills also"><span class="lbl">Also suits</span><div>${seen.map((o) => {
    const name = cut(ctx.visible.get(o.u) || o.u, 60);
    return `<a href="${SENT_URL}?u=${esc(o.u)}" title="Rated ${o.fit}/10 for ${esc(name)}">${esc(name)} <b>${o.fit}/10</b></a>`;
  }).join("")}</div></div>`;
}

// What the job's email card showed, below its title line.
function jobMore(j, fit, color, docs, key, ctx) {
  const { today, currency = "" } = ctx;
  const m = j.more && typeof j.more === "object" && !Array.isArray(j.more) ? j.more : {};
  const chips = [closingPill(m.closing, today), ...[m.type, j.mode, m.seniority].map((v) => text(v, 40)).filter((v) => v && v !== "Unknown")
    .map((v) => `<span class="fact">${esc(v)}</span>`), text(m.published, 30) ? `<span class="fact soft">Posted ${esc(text(m.published, 30))}</span>` : "",
  j.salary ? "" : '<span class="fact soft">Salary not listed</span>'].join("");
  const salary = text(j.salary, 60) ? `<div class="salary">${icon(moneyIcon(j.salary, currency))}<b>${esc(text(j.salary, 60))}</b></div>` : "";
  const meters = [meter("HermitShell fit", fit, 10, color, "/10"), meter("Confidence", percent(m.confidence), 100, "#6366f1", "%"),
    meter("CV keyword match", percent(m.coverage), 100, "#0ea5e9", "%")].join("");
  const why = text(m.reasoning, 600) ? `<p class="why">${esc(text(m.reasoning, 600))}</p>` : "";
  const site = safeUrl(m.site);
  const company = [text(j.employer, 60) ? `<b>${esc(text(j.employer, 60))}</b>` : "", esc(text(m.profile, 120)),
    site ? `<a href="${esc(site)}" target="_blank" rel="noopener noreferrer nofollow">${esc(domain(site))}${EXTERNAL_ICON}</a>` : ""].filter(Boolean).join(" &middot; ");
  const about = text(m.about, 400) || text(m.company, 60) ? `<div class="about"><span class="lbl">About the company</span>${company ? `<div>${company}</div>` : ""}${
    text(m.about, 400) ? `<p>${esc(text(m.about, 400))}</p>` : ""}${text(m.company, 60) ? `<div class="muted">Advertised by <b>${esc(text(m.company, 60))}</b></div>` : ""}</div>` : "";
  const url = safeUrl(j.url);
  const advert = url ? `<a class="advert" href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">View the advert on ${esc(domain(url))}${EXTERNAL_ICON}</a>` : "";
  return `<div class="more">${chips ? `<div class="facts">${chips}</div>` : ""}${salary}${meters ? `<div class="meters">${meters}</div>` : ""}${why}${about}
${skillChips("Strongest matches with the CV", words(m.matched, 12), "have")}${gapChips(words(m.gaps, 6), key, ctx)}${alsoSuits(j.others, ctx)}
${docs ? `<div class="docs">${docs}</div>` : ""}${advert}</div>`;
}

async function sentRow(j, i, ctx) {
  const fit = Number.isInteger(j.fit) && j.fit >= 0 && j.fit <= 10 ? j.fit : null;
  const tone = fit === null ? "slate" : scoreTone(fit);
  const color = TONE_HEX[tone];
  const key = validJobKey(j.key) ? j.key : "";
  const h = key ? await jobHash(key) : "";
  const id = h ? h.slice(0, 16) : `n${i}`;
  const meta = [j.employer, j.location, j.mode, j.salary].map((v) => cut(v, 60).trim()).filter(Boolean).map(esc).join(" &middot; ");
  const [label, answerColor] = ANSWER_LABELS[j.answer] || [];
  const badge = label ? `<span class="answer" style="--a:${answerColor}">${esc(label)}</span>` : "";
  const source = j.source ? `<span class="source">${esc(cut(j.source, 60))}</span>` : "";
  const title = [cut(j.title, 90), cut(j.employer, 60)].filter(Boolean).join(" at ");
  const docs = key ? docActions(key, h, { ...ctx, title: title.slice(0, 120), answer: j.answer }) : "";
  return `<li id="job-${id}" style="animation-delay:${Math.min(i, 12) * 35}ms"><details${ctx.open === id ? " open" : ""}><summary>${
    fit === null ? '<span class="nofit">&ndash;</span>' : ring(fit, 10, { size: 46, tone, label: String(fit), hot: fit >= 8 })}
<div class="job"><b>${esc(cut(j.title, 90))}</b><span class="muted">${meta}</span></div><div class="tags">${badge}${source}</div><span class="chev" aria-hidden="true"></span></summary>
${jobMore(j, fit, color, docs, key, ctx)}</details></li>`;
}

const SENT_NOTES = {
  doc: ["ok", "HermitShell is making it. It shows here to download within a few minutes, and this page checks every 15 seconds while it waits."],
  docbad: ["bad", "That request could not be made. Reload the page and try again."],
  docgone: ["bad", "That document is no longer kept. Generate a new one below."],
  mail: ["ok", "HermitShell will email this job within a few minutes. This page checks every 15 seconds until it has gone."],
  docmail: ["ok", "HermitShell will email it within a few minutes, the same PDF you can download. This page checks every 15 seconds until it has gone."],
  skill: ["ok", "Added. HermitShell counts it as on the CV within a few minutes, for ratings, cover letters and tailored CVs."],
  skillbad: ["bad", "That skill could not be added. Reload the page and try again."],
};

// `opts`: range and answer (the filters), open (the job to show opened), done (a note), csrf, sent (the jobs with
// their details), docs (the letters and CVs kept), emailed (the jobs emailed from here), pending (those being
// made or sent), added (the skills added from here, docs.addedSkills), visible (the other recruits the person
// looking may see, id to name, for "Also suits") and here (the page's address, for reloads).
export async function sentPage(status, stats, pid, opts = {}) {
  const p = (status.profiles || []).find((x) => x.id === pid);
  const back = { wide: true, before: BACK_TO_RECRUITS };
  if (!p) return page("Recruit not found", '<p>HermitShell has not reported this recruit. <a href="/admin">Back to recruits</a></p>', { status: 404 });
  const range = SENT_RANGES[opts.range] ? Number(opts.range) : DEFAULT_RANGE;
  const answer = opts.answer === "none" || ANSWER_LABELS[opts.answer] ? opts.answer : "";
  const heading = `Jobs sent to ${p.name || "this recruit"}`;
  const links = `<a class="small" href="${STATS_URL}?u=${esc(pid)}">Stats</a> &middot; <a class="small" href="/admin/profile?u=${esc(pid)}">Manage recruit</a> &middot; <a class="small" href="${PIPELINE_URL}?u=${esc(pid)}">Pipeline</a> &middot; <a class="small" href="${HISTORY_URL}?u=${esc(pid)}">History</a>`;
  const today = zonedToday(status.timezone);
  const first = dayList(today, range)[0];
  const inRange = sentJobs(Array.isArray(opts.sent) ? { sent: opts.sent } : stats).filter((j) => j.day >= first);
  const shown = inRange.filter((j) => !answer || (answer === "none" ? !ANSWER_LABELS[j.answer] : j.answer === answer));
  const open = /^[0-9a-f]{16}$/.test(opts.open || "") ? opts.open : "";
  const recipient = cut(String(p.name || "").trim().split(/\s+/)[0], 40) || "this recruit";
  const ctx = { profile: pid, csrf: opts.csrf || "", docs: opts.docs || [], emailed: opts.emailed || [], recipient,
    pending: opts.pending || new Map(), visible: opts.visible || new Map(), today, open, currency: p.job?.currency, back: `r=${range}${answer ? `&a=${answer}` : ""}`,
    skills: new Set((Array.isArray(stats?.skills) ? stats.skills : []).map((k) => cleanSkill(k).toLowerCase()).filter(Boolean)) };
  ctx.adding = new Set((opts.added || []).map((e) => e.s.toLowerCase()).filter((k) => !ctx.skills.has(k)));
  const rows = await Promise.all(shown.map((j, i) => sentRow(j, i, ctx)));
  const byDay = [];
  shown.forEach((j, i) => {
    if (byDay.at(-1)?.day !== j.day) byDay.push({ day: j.day, rows: [] });
    byDay.at(-1).rows.push(rows[i]);
  });
  const waiting = open && shown.some((j, i) => rows[i].startsWith(`<li id="job-${open}"`) && rows[i].includes('class="doc busy"'));
  const updated = stats?.updated ? `Updated ${esc(ago(stats.updated))} &middot; ` : "";
  const empty = !stats ? "HermitShell sends the list within a few minutes of its next check-in, and after every report."
    : inRange.length ? "No job sent in this period has that answer." : "No jobs were sent in this period.";
  const [tone, message] = SENT_NOTES[opts.done] || [];
  const body = byDay.length ? byDay.map((g) => `<section class="sentday"><h3>${weekday(g.day)} ${shortDay(g.day)}<span>${g.rows.length} job${g.rows.length === 1 ? "" : "s"}</span></h3>
<ul class="sentlist">${g.rows.join("")}</ul></section>`).join("")
    : `<div class="nostats">${icon("mail", "hero")}<p><b>Nothing to show.</b> ${empty}</p></div>`;
  return page(heading, `<style>${STYLE}${SENT_STYLE}${DOC_STYLE}</style>${message ? `<p class="note ${tone}" role="status">${esc(message)}</p>` : ""}
<div class="statbar">${sentTabs(pid, range, answer)}<span class="muted">${updated}${links}</span></div>
${inRange.length ? answerFilter(pid, range, answer, inRange) : ""}${body}
<p class="muted small">Press a job for everything its email showed, the advert, and its cover letter and tailored CV. Letters and CVs made from
here are kept to download for a few days, and emailed only when you press &ldquo;Email to ${esc(recipient)}&rdquo; beside one. The last tile sends the job itself
to the recruit, as its report card.
Notes typed on the buttons are never shown here.</p>`, { ...back, refresh: waiting ? 15 : 0, refreshTo: waiting && opts.here ? reloadTo(opts.here, `job-${open}`) : "" });
}

export function statsPage(status, stats, pid, rangeParam) {
  const p = (status.profiles || []).find((x) => x.id === pid);
  const back = { wide: true, before: BACK_TO_RECRUITS };
  if (!p) return page("Recruit not found", '<p>HermitShell has not reported this recruit. <a href="/admin">Back to recruits</a></p>', { status: 404 });
  const range = RANGES[rangeParam] ? Number(rangeParam) : DEFAULT_RANGE;
  const heading = `${p.name || "Recruit"}: stats`;
  const manage = `<a class="small" href="${SENT_URL}?u=${esc(pid)}&amp;r=${range === 365 ? 90 : range}">Jobs sent</a> &middot; <a class="small" href="/admin/profile?u=${esc(pid)}">Manage recruit</a> &middot; <a class="small" href="${PIPELINE_URL}?u=${esc(pid)}">Pipeline</a> &middot; <a class="small" href="${HISTORY_URL}?u=${esc(pid)}">History</a>`;
  if (!stats) {
    return page(heading, `<style>${STYLE}</style>${rangeTabs(pid, range)}
<div class="nostats">${icon("radar", "hero")}<p><b>No stats yet.</b> HermitShell sends them within a few minutes of its next check-in, and after every report.</p>${manage}</div>`, back);
  }
  const today = zonedToday(status.timezone);
  const win = windowFor(range, today);
  const now = totals(stats, win.days);
  const covered = win.previous && DATE_RE.test(stats.since || "") && stats.since <= win.previous[0];
  const before = covered ? totals(stats, win.previous) : null;
  const r = stats.ranges?.[String(range)] || {};
  const updated = stats.updated ? `Updated ${esc(ago(stats.updated))}` : "";
  return page(heading, `<style>${STYLE}</style>
<div class="statbar">${rangeTabs(pid, range)}<span class="muted">${updated}${updated ? " &middot; " : ""}${manage}</span></div>
${tiles(stats, win, now, before)}${chips(stats, win, now, String(range), p.job?.currency)}
${card("Activity", "chart", `<div class="legend row key"><span><i class="sw" style="background:#e0e7ff"></i>Rated</span><span><i class="sw" style="background:#6366f1"></i>Sent</span><span><i class="sw round" style="background:#059669"></i>Applied</span></div>${activity(stats, win)}`, "wide")}
<div class="cards">
${card("Funnel", "bolt", funnel(now), "", "violet")}
${card("Answers", "heart", donut(now), "", "rose")}
${card("Match scores", "star", histogram(r.fit), "", "amber")}
${card("Where applications stand", "plane", pipeline(stats.pipeline), "", "green")}
${card("Top employers", "target", topList(r.employers, "violet"), "", "violet")}
${card("Top sources", "radar", `${topList(r.sources, "blue")}${modes(r.modes)}`, "", "blue")}
${card("Salaries by job title", moneyIcon("", p.job?.currency), `${salaryList(r.salary_titles, p.job?.currency)}<p class="muted small">The median of each advert's lowest yearly figure, across every job rated.</p>`, "", "green")}
</div>
${card("Best matches sent", "star", bestMatches(r.best), "wide", "green")}`, back);
}

// ------------------------------------------------------------------------- look and motion

const STYLE = `
.statbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px}
.statbar nav.tabs{margin:6px 0 10px}
.k-indigo{--c:#6366f1;--cb:#eef0ff}.k-violet{--c:#8b5cf6;--cb:#f3efff}.k-blue{--c:#2563eb;--cb:#e8f0ff}
.k-amber{--c:#d97706;--cb:#fff4de}.k-rose{--c:#e11d48;--cb:#ffecf1}.k-green{--c:#059669;--cb:#e6f8f0}
.k-sky{--c:#0284c7;--cb:#e4f5fd}.k-orange{--c:#ea580c;--cb:#ffefe4}.k-slate{--c:#64748b;--cb:#eceff5}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:4px 0 14px}
.kpi{position:relative;overflow:hidden;background:#fff;border:1px solid var(--line);border-radius:18px;padding:14px 14px 0;
animation:rise .5s var(--ease) both;transition:transform .2s var(--ease),box-shadow .2s}
.kpi:hover{transform:translateY(-3px);box-shadow:0 16px 30px -18px rgba(30,27,75,.4)}
.kpi-top{display:flex;justify-content:space-between;align-items:center;gap:6px}
.ico{flex:none;width:44px;height:44px;border-radius:14px;display:grid;place-items:center;color:var(--c);background:var(--cb);
box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 14%,transparent)}
.ico svg{width:25px;height:25px;overflow:visible}
.ico.sm{width:32px;height:32px;border-radius:10px}.ico.sm svg{width:19px;height:19px}
.kpi-num{font-size:32px;font-weight:800;letter-spacing:-.035em;line-height:1.05;margin-top:12px;color:var(--ink)}
.kpi-num small{font-size:14px;color:var(--muted);font-weight:650;letter-spacing:0;margin-left:2px}
.kpi-label{font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.09em;margin-top:3px}
svg.spark{display:block;width:calc(100% + 28px);height:36px;margin:8px -14px 0}
svg.spark .line,svg.mini .line{fill:none;stroke:var(--c,#6366f1);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;
stroke-dasharray:1;animation:draw 1.4s var(--ease) both .25s}
svg.spark .area{fill:var(--cb);animation:fade 1s ease both .6s}svg.mini .area{fill:#eef0ff}
.delta{font-size:11.5px;font-weight:750;border-radius:99px;padding:2px 8px;white-space:nowrap}
.delta.up{background:var(--ok-bg);color:#047857}.delta.down{background:var(--bad-bg);color:#b91c1c}.delta.flat{background:#f1f5f9;color:var(--muted)}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
.chip{display:inline-flex;align-items:center;gap:8px;padding:5px 14px 5px 5px;border-radius:99px;background:#fff;border:1px solid var(--line);
font-size:13.5px;color:var(--text);animation:rise .45s var(--ease) both}
.chip .ci{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--soft);color:var(--brand)}
.chip svg{width:18px;height:18px;overflow:visible}.chip b{color:var(--ink)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:14px;margin:14px 0}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:16px 18px;animation:rise .55s var(--ease) both .1s;min-width:0}
.card.wide{margin:14px 0}
.card h3{display:flex;align-items:center;gap:10px;margin:0 0 14px;font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;color:#475569;font-weight:750}
svg.chart{display:block;width:100%;height:auto;overflow:visible}
.chart .gridline{stroke:#eef0f5;stroke-width:1}.chart .axis{font-size:11px;fill:#94a3b8}
.chart .empty{font-size:14px;fill:#94a3b8;font-weight:600}
.chart .hover{fill:transparent}.chart g:hover .hover{fill:#f5f6ff}
.chart .bar{transform-box:fill-box;transform-origin:50% 100%;animation:grow .8s var(--ease) both}
.chart .rated{fill:#e0e7ff}.chart .sent{fill:url(#g-sent)}
.chart .applied{fill:#10b981;stroke:#fff;stroke-width:2;transform-box:fill-box;transform-origin:center;animation:popscale .5s var(--ease) both .6s}
.chart .count{font-size:9px;font-weight:800;fill:#fff}
.legend{list-style:none;padding:0;margin:0;display:grid;gap:7px;font-size:13px;color:var(--text)}
.legend li{display:flex;align-items:center;gap:8px}.legend b{margin-left:auto;color:var(--ink)}
.legend.row{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px}.legend.row b{margin-left:4px}
.legend.key{margin:0 0 8px;font-size:12.5px;color:var(--muted)}.legend.key span{display:inline-flex;align-items:center;gap:6px}
.score{fill:var(--c)}.chart .score.k-slate{fill:#cbd5e1}
.sw{display:inline-block;width:12px;height:12px;border-radius:4px;flex:none}.sw.round{border-radius:50%}
.funnel{display:grid;gap:9px}
.step{display:grid;grid-template-columns:82px 1fr 44px 40px;align-items:center;gap:8px;font-size:13px}
.step-label{color:var(--text);font-weight:600}.step b{text-align:right;color:var(--ink);font-size:15px}
.track{display:block;height:12px;border-radius:99px;background:#f1f3f9;overflow:hidden}
.fillbar{display:block;height:100%;border-radius:inherit;background:var(--c);background:linear-gradient(90deg,var(--c),color-mix(in srgb,var(--c) 60%,#fff));
transform-origin:left;animation:growx .9s var(--ease) both}
.conv{font-size:11px;font-weight:700;color:var(--muted);text-align:right}
.donut{display:grid;grid-template-columns:130px 1fr;gap:16px;align-items:center}
.donut svg{width:130px;height:130px}.donut .big{font-size:9px;font-weight:800;fill:var(--ink)}.donut .small{font-size:3.6px;fill:#94a3b8;font-weight:600}
.arc{animation:arc 1.1s var(--ease) both .2s}
.ring{flex:none;overflow:visible}
.ring .disc{fill:var(--cb);transform-box:fill-box;transform-origin:center;animation:popscale .5s var(--ease) both .1s}
.ring .track{fill:none;stroke:color-mix(in srgb,var(--c) 16%,#fff);stroke-width:3.6}
.ring .arc{fill:none;stroke:var(--c);stroke-width:3.6;stroke-linecap:round;animation:arc 1.3s var(--ease) both .2s;
filter:drop-shadow(0 1px 1.5px color-mix(in srgb,var(--c) 45%,transparent))}
.ring .val{font-size:11px;font-weight:800;fill:var(--c);animation:fade .5s ease both .7s}
.ring .sub{font-size:4.4px;font-weight:700;fill:var(--muted);letter-spacing:.02em}
.ring.hot{animation:halo 2.6s ease-in-out 1.5s 2;transition:filter .25s ease}
li:hover .ring.hot,summary:hover .ring.hot{filter:drop-shadow(0 0 3px color-mix(in srgb,var(--c) 35%,transparent))}
@keyframes halo{50%{filter:drop-shadow(0 0 5px color-mix(in srgb,var(--c) 60%,transparent))}}
.pipe{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:center}
.rate{display:grid;justify-items:center;gap:2px}
.bubbles{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.bubble{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;column-gap:9px;align-items:center;padding:8px 10px;
border-radius:14px;background:var(--cb)}
.bubble .ico{grid-row:span 2;width:38px;height:38px;border-radius:12px;background:#fff}.bubble .ico svg{width:21px;height:21px}
.bubble b{font-size:19px;line-height:1.1;color:var(--ink)}.bubble span:last-child{font-size:11.5px;color:var(--muted);font-weight:650}
.toplist{list-style:none;padding:0;margin:0;display:grid;gap:9px}
.toplist li{display:grid;grid-template-columns:minmax(0,1.3fr) 1fr 30px;gap:10px;align-items:center;font-size:13px}
.toplist .name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);font-weight:600}.toplist b{text-align:right}
.toplist.money li{grid-template-columns:minmax(0,1.6fr) 1fr 56px}.toplist .name small{font-weight:600}
.stack{display:flex;height:12px;border-radius:99px;overflow:hidden;gap:2px;margin-top:16px;animation:growx .9s var(--ease) both .3s;transform-origin:left}
.best{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.best li{position:relative;overflow:hidden;display:flex;gap:14px;align-items:center;padding:12px 16px 12px 12px;border-radius:16px;
border:1px solid color-mix(in srgb,var(--c) 22%,var(--line));background:linear-gradient(135deg,var(--cb),#fff 65%);
animation:rise .45s var(--ease) both;transition:transform .2s var(--ease),box-shadow .2s}
.best li::before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:var(--c)}
.best li:hover{transform:translateY(-3px);box-shadow:0 16px 30px -20px color-mix(in srgb,var(--c) 70%,#1e1b4b)}
.best li div{min-width:0;display:grid;gap:2px}.best b{font-size:14.5px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.best .muted{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.best svg{flex:none}
.nostats{display:grid;justify-items:center;text-align:center;gap:6px;padding:30px 10px}
.nostats svg.hero{width:84px;height:84px;color:var(--brand)}
.ico .spin,.hero .spin{transform-box:view-box;transform-origin:12px 12px;animation:spin 3.2s linear infinite}
.ico .ping,.hero .ping{transform-box:fill-box;transform-origin:center;animation:ping 2s ease-out infinite}
.ico .beat{transform-box:fill-box;transform-origin:center;animation:heart 1.8s ease-in-out infinite}
.ico .float{animation:float 2.8s ease-in-out infinite}.ico .bob{animation:bob 2.4s ease-in-out infinite}
.ico .dot{animation:blink .9s ease-in-out infinite alternate}.ico .dot:nth-of-type(2){animation-delay:.3s}.ico .dot:nth-of-type(3){animation-delay:.6s}
.ico .write{stroke-dasharray:1;animation:draw 2.4s ease-in-out infinite alternate}
svg .grow{transform-box:fill-box;transform-origin:50% 100%;animation:grow 1.6s var(--ease) infinite alternate}
svg .g2{animation-delay:.25s}svg .g3{animation-delay:.5s}
.ico *,.hero *,svg .grow{animation-iteration-count:4!important}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes ping{0%{transform:scale(.7);opacity:1}100%{transform:scale(1.7);opacity:.2}}
@keyframes heart{0%,100%{transform:scale(1)}14%{transform:scale(1.16)}28%{transform:scale(1)}42%{transform:scale(1.08)}}
@keyframes float{50%{transform:translate(1.5px,-1.5px)}}
@keyframes bob{50%{transform:translateY(-1.5px)}}
@keyframes draw{from{stroke-dashoffset:1}}
@keyframes grow{from{transform:scaleY(0)}}
@keyframes growx{from{transform:scaleX(0)}}
@keyframes fade{from{opacity:0}}
@keyframes popscale{from{transform:scale(0)}}
@keyframes arc{from{stroke-dasharray:0 100}}
@media (max-width:760px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.donut{grid-template-columns:1fr;justify-items:center}}
`;

const SENT_STYLE = `
nav.answers{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 18px}
nav.answers a{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:99px;border:1px solid var(--line);background:#fff;
font-size:13px;font-weight:650;color:var(--text);text-decoration:none;transition:background .15s,border-color .15s,color .15s}
nav.answers a b{font-size:11.5px;color:var(--muted);background:#f1f3f9;border-radius:99px;padding:1px 7px}
nav.answers a:hover{border-color:#c7cbf5;background:#f7f7ff}
nav.answers a.on{background:var(--soft);border-color:#c7cbf5;color:var(--brand-ink)}nav.answers a.on b{background:#fff;color:var(--brand-ink)}
.sentday{margin:0 0 18px}
.sentday h3{display:flex;align-items:baseline;gap:10px;margin:0 0 8px;font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:750}
.sentday h3 span{letter-spacing:0;text-transform:none;font-weight:600;color:#94a3b8}
.sentlist{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.sentlist>li:not(:has(details[open])){content-visibility:auto;contain-intrinsic-size:auto 76px}
.sentlist li{background:#fff;border:1px solid var(--line);border-radius:16px;animation:rise .45s var(--ease) both;scroll-margin-top:80px;
transition:box-shadow .2s,border-color .2s}
.sentlist li:hover{box-shadow:0 14px 26px -20px rgba(30,27,75,.45)}
.sentlist li:has(details[open]){border-color:#c7cbf5;box-shadow:0 18px 40px -26px rgba(30,27,75,.5)}
.sentlist summary{display:grid;grid-template-columns:46px minmax(0,1fr) auto 16px;gap:14px;align-items:center;padding:12px 16px;cursor:pointer;
list-style:none;border-radius:16px;transition:background .15s}
.sentlist summary::-webkit-details-marker{display:none}
.sentlist summary:hover{background:#fafaff}
.sentlist summary:focus-visible{outline:3px solid rgba(99,102,241,.35);outline-offset:-3px}
.sentlist details[open]>summary{border-radius:16px 16px 0 0;background:linear-gradient(180deg,#f7f7ff,#fff)}
.chev{width:9px;height:9px;border:solid var(--muted);border-width:0 2px 2px 0;transform:rotate(45deg) translate(-2px,-2px);
transition:transform .25s var(--ease),border-color .15s;justify-self:center}
summary:hover .chev{border-color:var(--brand-ink)}
details[open] .chev{transform:rotate(225deg) translate(-2px,-2px)}
.sentlist .job{display:grid;gap:3px;min-width:0}
.sentlist .job b{font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}
.sentlist details[open] .job b{white-space:normal}
.sentlist .job .muted{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sentlist .tags{display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.more{padding:4px 18px 18px 70px;display:grid;gap:12px;animation:unfold .35s var(--ease) both}
@keyframes unfold{from{opacity:0;transform:translateY(-6px)}}
.facts{display:flex;flex-wrap:wrap;gap:6px}
.fact{font-size:12px;font-weight:650;padding:3px 9px;border-radius:7px;background:#eef2ff;color:#3730a3}
.fact.soft{background:#f1f3f9;color:var(--muted)}.fact.soon{background:#fff7ed;color:#c2410c}
.salary{display:inline-flex;align-items:center;gap:8px;justify-self:start;padding:6px 12px 6px 9px;border-radius:10px;
background:var(--ok-bg);border:1px solid var(--ok-line);color:#065f46;font-size:15px}
.salary svg{width:18px;height:18px}
.meters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.meter{display:grid;grid-template-columns:1fr auto;gap:2px 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.meter b{font-size:14px;letter-spacing:0;color:var(--ink)}
.meter i{grid-column:1/-1;height:6px;border-radius:99px;background:#e9ecf4;overflow:hidden}
.meter em{display:block;height:100%;border-radius:inherit;animation:growx .8s var(--ease) both .1s;transform-origin:0 50%}
.why{margin:0;padding:11px 14px;border-left:3px solid var(--brand);border-radius:10px;background:#f8fafc;font-size:14px;line-height:1.55;color:var(--text)}
.about{padding:11px 14px;border:1px solid var(--line);border-radius:12px;font-size:13.5px;color:var(--text);line-height:1.5}
.about p{margin:4px 0 0;font-size:13.5px}.about .muted{margin-top:6px}
.more .lbl{display:block;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:650;margin-bottom:5px}
.skills div{display:flex;flex-wrap:wrap;gap:6px}
.skills span:not(.lbl){font-size:12px;font-weight:650;padding:3px 10px;border-radius:99px;border:1px solid}
.skills.have span:not(.lbl){background:#ecfdf5;border-color:#6ee7b7;color:#047857}
.skills.gap .lbl{color:#92400e}.skills.gap span:not(.lbl){background:#fffbeb;border-color:#fcd34d;color:#92400e}
.skills.gap form{margin:0}.skills.gap button{display:inline-flex;align-items:center;gap:4px;margin:0;font:inherit;font-size:12px;font-weight:650;
padding:3px 10px 3px 7px;border-radius:99px;border:1px solid #fcd34d;background:#fffbeb;color:#92400e;cursor:pointer;box-shadow:none;
transition:background .15s,border-color .15s,transform .15s}
.skills.gap button:hover{background:#fef3c7;border-color:#f59e0b;transform:translateY(-1px);filter:none;box-shadow:none}
.skills.gap button:focus-visible{outline:3px solid rgba(245,158,11,.35);outline-offset:1px}
.skills.gap svg{width:12px;height:12px;flex:none}
.skills.also .lbl{color:#4338ca}.skills.also a{font-size:12px;font-weight:650;padding:3px 10px;border-radius:99px;border:1px solid #c7d2fe;
background:#eef2ff;color:#4338ca;text-decoration:none;transition:background .15s,transform .15s}
.skills.also a:hover{background:#e0e7ff;transform:translateY(-1px)}.skills.also a b{font-weight:800}
.skills.gap span.added,.skills.gap span.adding{display:inline-flex;align-items:center;gap:4px;padding-left:7px;background:#ecfdf5;border-color:#6ee7b7;color:#047857}
.skills.gap span.adding{border-style:dashed;background:#f0fdf4}
.skillhint{display:block;margin-top:6px;font-size:12px;color:var(--muted)}
.more .docs{margin-top:2px}
a.advert{justify-self:start;font-size:13px;font-weight:650;text-decoration:none}a.advert:hover{text-decoration:underline}
.answer{font-size:11.5px;font-weight:750;padding:3px 10px;border-radius:99px;color:var(--a);background:color-mix(in srgb,var(--a) 13%,#fff);white-space:nowrap}
.source{font-size:11.5px;color:#94a3b8;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}
.nofit{width:46px;height:46px;display:grid;place-items:center;border-radius:50%;background:#f1f3f9;color:var(--muted);font-weight:700}
@media (max-width:640px){.sentlist summary{grid-template-columns:46px minmax(0,1fr) 16px}.sentlist .tags{grid-column:2;flex-direction:row;align-items:center}
.sentlist .chev{grid-row:1;grid-column:3}.more{padding:4px 14px 16px}.meters{grid-template-columns:1fr}}
`;

// The dashboard's Stats links; added to the shared page style.
export const LINK_STYLE = `
a.statlink{display:inline-flex;align-items:center;gap:6px;margin-top:6px;padding:4px 10px 4px 6px;border-radius:10px;background:var(--soft);white-space:nowrap;
color:var(--brand-ink);font-size:12.5px;font-weight:650;text-decoration:none;transition:transform .15s var(--ease),background .15s}
a.statlink:hover{background:#e2e5ff;transform:translateY(-1px)}
.statpair{display:inline-flex;align-items:stretch;gap:2px;margin-top:6px}
.statpair a.statlink{margin-top:0;border-radius:4px}
.statpair a.statlink:first-child{border-radius:10px 4px 4px 10px;padding:4px 7px}
.statpair a.statlink:last-child{border-radius:4px 10px 10px 4px;padding:4px 10px 4px 8px}
a.statlink svg{width:18px;height:18px}a.statlink svg.mini{width:56px;height:20px}
a.statlink .line{fill:none;stroke:#6366f1;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;
animation:draw 1.4s var(--ease) both .25s}
a.statlink .area{fill:#dfe3ff}
a.statlink .grow{transform-box:fill-box;transform-origin:50% 100%;animation:grow 1.6s var(--ease) infinite alternate}
a.statlink:hover .grow{animation-iteration-count:infinite!important}
a.statlink .g2{animation-delay:.25s}a.statlink .g3{animation-delay:.5s}
@keyframes draw{from{stroke-dashoffset:1}}@keyframes grow{from{transform:scaleY(0)}}
`;

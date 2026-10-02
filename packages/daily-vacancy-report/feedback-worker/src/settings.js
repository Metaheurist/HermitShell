// Settings pages of the admin dashboard: the setup checklist, the global settings page (email server and web
// search API keys, shared by every profile) and each profile's page (details, job search and daily report time
// in one form, Send jobs now, and the CV). Forms open prefilled from the last status HermitShell reported plus the changes still waiting for
// it; saving only queues the change, which profiles.py validates again and applies, within seconds over the live link.

import { COUNTRIES, countryCode, savedCountry } from "./countries.js";
import { CURRENCIES, currencyCode, currencySymbol } from "./currency.js";
import { MAX_CV_BYTES, SECRET_TTL_SECONDS, cvKind, queueItem, storeCv } from "./join.js";
import { PROTOCOL } from "./apiauth.js";
import { sealInfo, sealItem } from "./seal.js";
import { BACK_TO_RECRUITS, CSP, SECURITY_HEADERS, ago, esc, limitedForm, note, page, redirect, reloadTo, safeEqual, waitBar, waitRefresh, when, PROFILE_RE, hidden } from "./lib.js";
import { KEY_STYLE, MODAL_STYLE, PROVIDERS, keyModals, keysSection } from "./keys.js";
import { MODEL_KEY_RE, MODEL_PROVIDERS, MODEL_RE, MODEL_STYLE, OLLAMA_RE, localModal, modelModals, modelsSection, usageSection } from "./models.js";
import { LINK_STYLE, STATS_URL, icon } from "./stats.js";
import { profileTabs } from "./history.js";
import { DOC_STYLE, PROFILE_CV_STYLE, profileCvButtons } from "./docs.js";
import { NOTES_STYLE } from "./notes.js";
import { CONFIRM_STYLE, RETIRE_ICON, RETIRE_INTRO, deleteModal } from "./confirm.js";

export const LEVELS = ["junior", "mid", "senior", "lead", "any"];
export const EMPLOYMENT_TYPES = ["Permanent", "Contract", "Temporary", "Part-time", "Internship"];
export const WORK_MODES = ["On-site", "Hybrid", "Remote"];
const KEY_RE = /^[A-Za-z0-9_-]{8,120}$/;
const HOST_RE = /^[A-Za-z0-9.-]{3,120}$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_TITLES = 8;
const MAX_PLACES = 30;
const MAX_CV_TEXT = 20000;
const MAX_CV_FORM_BYTES = MAX_CV_BYTES + 256 * 1024;

function tidy(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function field(form, name, max) {
  return tidy(form.get(name), max);
}

function list(value, sep, limit, maxLen) {
  return [...new Set(String(value || "").split(sep).map((v) => tidy(v, maxLen)).filter(Boolean))].slice(0, limit);
}

function checked(on) {
  return on ? " checked" : "";
}

// ------------------------------------------------------------------------- dashboard sections

export const SETTINGS_URL = "/admin/settings";

export const USERS_URL = "/admin/users";

// Recruiters only have the Recruits tab: users and global settings are for admins.
// `admin`: true for an admin's tabs, "manager" for a manager's (no Global settings), false for a recruiter's.
export function nav(active, admin = true) {
  const tabs = [["profiles", "/admin", "Recruits"], ["desk", "/admin/desk", "Desk"],
    ...(admin ? [["users", USERS_URL, admin === true ? "Users and roles" : "Your team"]] : []),
    ...(admin === true ? [["settings", SETTINGS_URL, "Global settings"]] : [])];
  return `<nav class="tabs">${tabs.map(([id, href, label]) =>
    `<a href="${href}"${id === active ? ' class="on" aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

export function ownerOf(status) {
  return (status.profiles || []).find((p) => p.owner) || null;
}

export function checklist(status) {
  const email = status.email || {};
  const keys = status.keys || {};
  const items = [
    [Boolean(status.updated), "HermitShell is connected",
      "HermitShell has not reported yet. It checks in every few minutes once the vacancy-profiles job runs."],
    [email.source && email.source !== "none" && email.password_set, "Email server set",
      `<a href="${SETTINGS_URL}#email">Set the email server</a> in Global settings so reports can be sent.`],
    [email.last_test?.ok === true, "Test email received",
      `<a href="${SETTINGS_URL}#email">Send a test email</a> to check the settings.`],
    [Object.values(keys).some((k) => k && k.source && k.source !== "none"), "Web search key set",
      `<a href="${SETTINGS_URL}#keys">Add a web search key</a> in Global settings (Firecrawl, Tavily or Scrapfly; all have free plans).`],
    [(status.profiles || []).some((p) => !p.owner), "First recruit joined",
      '<a href="#invite">Create an invite link</a> below and send it to someone looking for work. You and your recruiters manage recruits; you have no job search of your own here.'],
  ];
  const todo = items.filter(([ok]) => !ok);
  if (!todo.length) return '<p class="muted">Setup complete.</p>';
  const done = items.length - todo.length;
  return `<h2>Finish setting up</h2>
<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${items.length}" aria-valuenow="${done}"><span style="width:${Math.round(done / items.length * 100)}%"></span></div>
<p class="muted">${done} of ${items.length} done</p><ul class="steps">${items.map(([ok, label, help]) =>
    `<li class="${ok ? "done" : "todo"}"><span class="tick" aria-hidden="true"></span><div><b>${esc(label)}</b>${ok ? "" : `<div class="muted">${help}</div>`}</div></li>`).join("")}</ul>`;
}

export function problems(status) {
  const recent = (status.problems || []).slice(-5);
  return versionNote(status) + (recent.length ? `<div class="warn"><b>HermitShell could not apply:</b><ul>${recent.map((p) =>
    `<li>${esc(p.what)}: ${esc(p.error)} <span class="muted">(${esc(when(p.at, status.timezone))})</span></li>`).join("")}</ul></div>` : "");
}

// Once HermitShell has reported, a warning when it and this Worker speak different protocols (apiauth.js).
export function versionNote(status) {
  if (!Number.isFinite(status.updated)) return "";
  const theirs = Number.isInteger(status.protocol) ? status.protocol : 1;
  if (theirs === PROTOCOL) return "";
  const fix = theirs < PROTOCOL
    ? `HermitShell (protocol ${theirs}) is older than this Worker (protocol ${PROTOCOL}), so passwords and API keys can't be saved here until it is updated. The container updates itself; a service install needs <code>git pull</code> and <code>install.sh</code>.`
    : `This Worker (protocol ${PROTOCOL}) is older than HermitShell (protocol ${theirs}). Redeploy it: <code>docker exec hermitshell /app/entrypoint.sh worker</code>, or <code>python3 scripts/cloudflare_worker.py</code>.`;
  return `<div class="warn"><b>HermitShell and this Worker don&rsquo;t match:</b> ${fix}</div>`;
}

export function emailSection(status, csrf) {
  const e = status.email || {};
  const owner = ownerOf(status);
  const now = e.source === "dashboard" ? "set here" : e.source === "env" ? "from HermitShell's .env" : "not set";
  const test = e.last_test ? (e.last_test.ok ? `worked, sent to ${e.last_test.to} ${when(e.last_test.at, status.timezone)}`
    : `failed ${when(e.last_test.at, status.timezone)}: ${e.last_test.error}`) : "none yet";
  return `<h2 id="email">Email server</h2>
<p class="muted">Sends every report, cover letter and tailored CV. Now: ${esc(now)}. Last test: ${esc(test)}.</p>
<form method="post" action="/admin/action">${hidden({ csrf, action: "email" })}
<div class="grid2"><div><label for="smtp_host">SMTP server</label><input id="smtp_host" name="host" value="${esc(e.host || "smtp.gmail.com")}" required maxlength="120"></div>
<div><label for="smtp_port">Port</label><input id="smtp_port" name="port" value="${esc(e.port || "587")}" inputmode="numeric" maxlength="5"></div>
<div><label for="smtp_user">Username</label><input id="smtp_user" name="user" value="${esc(e.user || "")}" required maxlength="120" autocomplete="off">${hint("Usually your email address.")}</div>
<div><label for="smtp_pass">Password or app password</label><input id="smtp_pass" name="password" type="password" maxlength="200" autocomplete="new-password" placeholder="${e.password_set ? "unchanged (leave empty to keep it)" : "Gmail: a 16-letter app password"}"></div></div>
<label for="smtp_from">Send as</label><input id="smtp_from" name="from" value="${esc(e.from || "")}" maxlength="120" type="email">${hint("Optional. Leave empty to send from the username.")}
<button>Save email server</button></form>
<p class="muted">Gmail needs 2-Step Verification and an <a href="https://myaccount.google.com/apppasswords" rel="noopener">app password</a>; Outlook.com uses smtp-mail.outlook.com.</p>
<form method="post" action="/admin/action" class="inline">${hidden({ csrf, action: "test_email" })}
<input name="to" type="email" maxlength="120" placeholder="${esc(owner?.email || "Send the test to")}"><button class="small quiet">Send a test email</button></form>
${e.source === "dashboard" ? `<p>${button(csrf, "email_clear", "Go back to the .env email settings")}</p>` : ""}`;
}

export function button(csrf, action, label, fields = {}, cls = "small quiet") {
  return `<form method="post" action="/admin/action" style="display:inline">${hidden({ csrf, action, ...fields })}<button class="${cls}">${esc(label)}</button></form>`;
}

// The email server as it will be once HermitShell applies any saved change, so the form keeps what was typed.
function pendingEmail(email, queue) {
  return byId(queue.filter((i) => i.type === "admin" && i.action === "email")).reduce((e, i) => i.clear ? email
    : { ...e, host: i.host || e.host, port: i.port || e.port, user: i.user || e.user, from: i.from ?? e.from }, email);
}

const WAITING_LABELS = { email: "the email server", test_email: "the test email", api_keys: "the web search keys", model_keys: "the AI model settings",
  local_model: "the server model", features: "the features" };
const WAITING_SECTIONS = { email: "email", test_email: "email", api_keys: "keys", model_keys: "models", local_model: "models", features: "features" };

// Global settings, Features: switch name (profiles.py FEATURES), label, explanation and default.
export const FEATURES = [
  ["alerts", "Admin alerts by email", "Emails you once when credits run low, a provider stops answering, a backup fails or the disk fills up, and again when it clears.", true],
  ["prep_auto", "Interview prep packs on Interview", "Makes an interview prep pack as soon as a job reaches Interview. The button on the job always works.", false],
  ["word_copies", "Word copies of letters and CVs", "Saves and emails a Word file beside each PDF cover letter, tailored CV and interview prep pack, and offers it on Download.", false],
  ["self_service", "Recruits' own page (/me)", "Lets recruits sign in with a link sent to their email and see their jobs, documents and search.", false],
];

export function featureOn(status, name) {
  const value = status?.features?.[name];
  return typeof value === "boolean" ? value : Boolean(FEATURES.find(([n]) => n === name)?.[3]);
}

// The switches HermitShell reports (an older one knows fewer), as they will be once it applies a saved change.
function pendingFeatures(status, queue) {
  const known = FEATURES.filter(([n]) => typeof status?.features?.[n] === "boolean");
  const now = Object.fromEntries(known.map(([n]) => [n, status.features[n]]));
  for (const i of byId(queue.filter((x) => x.type === "admin" && x.action === "features"))) {
    for (const [n] of known) if (typeof i[n] === "boolean") now[n] = i[n];
  }
  return now;
}

const FEATURE_STYLE = `.featurelist{display:grid;gap:8px;margin:6px 0 14px}
.featurelist .check{padding:10px 13px;border:1px solid var(--line);border-radius:10px;background:var(--field)}
.featurelist .check:has(input:checked){background:var(--soft)}.featurelist .check .muted{color:var(--muted)}`;

function featuresSection(on, csrf) {
  if (!Object.keys(on).length) return "";
  return `<h2 id="features">Features</h2>
<p class="muted">Parts of HermitShell you can switch on or off. HermitShell applies a change within seconds while it is connected.</p>
<form method="post" action="/admin/action">${hidden({ csrf, action: "features" })}<div class="featurelist">
${FEATURES.filter(([n]) => Object.hasOwn(on, n)).map(([n, label, help]) => `<input type="hidden" name="shown" value="${n}"><label class="check"><input type="checkbox" name="${n}" value="1"${checked(on[n])}> <span><b>${esc(label)}</b><br><span class="muted">${esc(help)}</span></span></label>`).join("\n")}
</div><button>Save features</button></form>`;
}

// Global settings changes still waiting for HermitShell.
export function settingsWaiting(queue) {
  return queue.filter((i) => i.type === "admin" && Object.hasOwn(WAITING_LABELS, i.action));
}

// The providers with a key change waiting (sealed keys keep the provider as their field name).
function savingKeys(waiting) {
  const names = new Set();
  for (const i of waiting.filter((x) => x.action === "api_keys")) {
    for (const name of Object.keys(PROVIDERS)) if (Object.hasOwn(i, name)) names.add(name);
    for (const name of Array.isArray(i.clear) ? i.clear : []) names.add(String(name));
  }
  return names;
}

function savingModels(waiting) {
  const models = waiting.filter((i) => i.action === "model_keys");
  return { providers: new Set(models.map((i) => String(i.provider || "")).filter(Boolean)),
    order: models.map((i) => i.order).filter((o) => o === "cloud" || o === "local").at(-1) || "",
    local: waiting.some((i) => i.action === "local_model") };
}

// `here` is the page's address, so a reload keeps the section of the change it is waiting for.
export function settingsPage(status, csrf, { done = "", queue = [], demo = "", here = "" } = {}) {
  const waiting = settingsWaiting(queue);
  const refresh = waitRefresh(waiting);
  const refreshTo = refresh && here ? reloadTo(here, WAITING_SECTIONS[waiting.at(-1).action]) : "";
  const what = [...new Set(waiting.map((i) => WAITING_LABELS[i.action]))].join(", ");
  return page("Global settings", `<style>${MODAL_STYLE}${KEY_STYLE}${MODEL_STYLE}${FEATURE_STYLE}</style>${nav("settings")}
${done ? note(done) : ""}${versionNote(status)}${waiting.length ? waitBar(what, refresh) : ""}
<p class="muted">These apply to the whole of HermitShell and every recruit. Where each person's reports go, their job search
and CV are on their own page under <a href="/admin">Recruits</a>.</p>
${emailSection({ ...status, email: pendingEmail(status.email || {}, queue) }, csrf)}
${keysSection(status, csrf, savingKeys(waiting))}
${modelsSection(status, csrf, savingModels(waiting))}
${usageSection(status)}
${featuresSection(pendingFeatures(status, queue), csrf)}
${demo}`, { wide: true, before: keyModals(csrf) + modelModals(csrf) + localModal(status, csrf), refresh, refreshTo });
}

// ------------------------------------------------------------------------- one profile's page

function select(name, options, current) {
  return `<select id="${name}" name="${name}">${options.map((o) => `<option value="${esc(o)}"${o === current ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
}

function hint(text) {
  return `<span class="hint">${esc(text)}</span>`;
}

function currencySelect(current) {
  return `<select id="currency" name="currency"><option value="">As advertised</option>${CURRENCIES.map(([c, s, name]) =>
    `<option value="${c}"${c === current ? " selected" : ""}>${esc(`${s} ${name} (${c})`)}</option>`).join("")}</select>`;
}

// A saved code that isn't in the list stays as its own option, so opening and saving the form keeps it.
function countrySelect(current) {
  const code = savedCountry(current);
  const other = code && !countryCode(code) ? `<option value="${esc(code)}" selected>${esc(code.toUpperCase())} (not in the list)</option>` : "";
  return `<select id="country" name="country"><option value="">Any country</option>${other}${COUNTRIES.map(([c, name]) =>
    `<option value="${c}"${c === code ? " selected" : ""}>${esc(name)}</option>`).join("")}</select>`;
}

function boxes(name, options, current) {
  return `<div class="checks">${options.map((o) => `<label class="check"><input type="checkbox" name="${name}" value="${esc(o)}"${checked(current.includes(o))}> <span>${esc(o)}</span></label>`).join("")}</div>`;
}

// ------------------------------------------------------------------------- saved values and conflicts
//
// HermitShell applies saved changes a little later, so a page shows what it last reported with every change
// still waiting in the queue laid over it: what was saved stays on screen. Each form carries the values it
// opened with ("base"); saving queues only the fields changed since then, so two people editing one profile
// only clash when both changed the same field, and then the second is shown both versions before anything is
// saved.

const DETAIL_FIELDS = ["name", "email", "phone", "location"];
const JOB_FIELDS = ["titles", "region", "places", "max_km", "country", "remote_anywhere", "level", "types", "modes",
  "min_salary", "currency", "hide_agency"];
const MAX_DISTANCE_KM = 500;
const REPORT_FIELDS = ["report_time", "report_days"];
const PROFILE_FIELDS = [...DETAIL_FIELDS, ...JOB_FIELDS, ...REPORT_FIELDS];
const REPORT_DAYS = [["daily", "Every day"], ["weekdays", "Weekdays (Monday to Friday)"]];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const LABELS = {
  report_time: "Daily report time", report_days: "Report days",
  name: "Name", email: "Email for reports", phone: "Phone", location: "Home town", titles: "Job titles",
  region: "Region or city", places: "Towns", max_km: "Distance from home town", country: "Country", remote_anywhere: "Fully remote jobs", level: "Seniority",
  types: "Employment types", modes: "Work location", min_salary: "Minimum salary", currency: "Currency",
  hide_agency: "Hide agency adverts",
};

function items(value, limit, maxLen) {
  return list(Array.isArray(value) ? value.join("\n") : value, /[\n,]/, limit, maxLen);
}

function salary(value) {
  const m = /^(\d+(?:\.\d+)?)(k?)$/i.exec(String(value ?? "").replace(/[,\s£€$]/g, ""));
  return m ? String(Math.trunc(Number(m[1]) * (m[2] ? 1000 : 1))) : "0";
}

// Whole kilometres from 0 (no limit) to MAX_DISTANCE_KM, as job_settings.distance_km takes them.
function distance(value) {
  const text = String(value ?? "").trim();
  return /^\d{1,3}$/.test(text) && Number(text) <= MAX_DISTANCE_KM ? String(Number(text)) : "0";
}

function byId(list) {
  return [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// The same normalised shape whether the values come from a form, HermitShell's report, a queued change or a
// form's (untrusted) base.
export function profileValues(src = {}) {
  const level = String(src.level || "any");
  return {
    name: tidy(src.name, 80), email: tidy(src.email, 120), phone: tidy(src.phone, 40), location: tidy(src.location, 80),
    titles: items(src.titles, MAX_TITLES, 60), region: tidy(src.region, 80), places: items(src.places, MAX_PLACES, 40),
    max_km: distance(src.max_km),
    country: savedCountry(tidy(src.country, 2)), remote_anywhere: src.remote_anywhere === true,
    level: LEVELS.includes(level) ? level : "any",
    types: EMPLOYMENT_TYPES.filter((t) => items(src.types, 10, 20).includes(t)),
    modes: WORK_MODES.filter((m) => items(src.modes, 5, 20).includes(m)),
    min_salary: salary(src.min_salary), currency: currencyCode(tidy(src.currency, 4)), hide_agency: src.hide_agency === true,
    report_time: TIME_RE.test(String(src.report_time ?? "")) ? String(src.report_time) : "",
    report_days: src.report_days === "weekdays" ? "weekdays" : "daily",
  };
}

// A queued change carries the report time as report: { time, days }, the shape profiles.py takes.
function reportPart(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return {};
  return Object.fromEntries([["report_time", report.time], ["report_days", report.days]].filter(([, v]) => v !== undefined));
}

function patchFields(item) {
  const part = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
  return Object.fromEntries(Object.entries({ ...part(item.details), ...part(item.job), ...reportPart(item.report) })
    .filter(([k]) => PROFILE_FIELDS.includes(k)));
}

// What HermitShell reported for the profile, with the changes still waiting for it applied in order.
export function latestValues(p, queue = []) {
  const changes = byId(queue.filter((i) => i.type === "admin" && i.action === "profile" && i.u === p.id));
  return changes.reduce((v, i) => profileValues({ ...v, ...patchFields(i) }),
    profileValues({ name: p.name, email: p.email, ...(p.details || {}), ...(p.job || {}), ...reportPart(p.report) }));
}

function formValues(form) {
  return profileValues({
    ...Object.fromEntries(PROFILE_FIELDS.map((k) => [k, form.get(k)])),
    types: form.getAll("types"), modes: form.getAll("modes"),
    remote_anywhere: form.get("remote_anywhere") === "1", hide_agency: form.get("hide_agency") === "1",
  });
}

function baseValues(form, fallback) {
  try {
    const base = JSON.parse(String(form.get("base") || ""));
    if (base && typeof base === "object" && !Array.isArray(base)) return profileValues(base);
  } catch {
    // no usable base: compare with the latest values instead
  }
  return fallback;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function pick(values, keys) {
  return Object.fromEntries(keys.map((k) => [k, values[k]]));
}

// A saved profile form checked against the latest values (reported plus queued): { item } to queue with only
// the changed fields, { conflicts } when someone else changed the same fields meanwhile, { error }, or nothing
// to do. `mine` and `base` let the page be shown again without losing what was typed.
export function profileChange(p, queue, form) {
  const latest = latestValues(p, queue);
  const mine = formValues(form);
  if (!countryCode(mine.country) && mine.country !== latest.country) mine.country = "";
  const base = baseValues(form, latest);
  const changed = PROFILE_FIELDS.filter((k) => !same(mine[k], base[k]) && !same(mine[k], latest[k]));
  const conflicts = changed.filter((k) => !same(latest[k], base[k]));
  if (conflicts.length) return { mine, base: latest, latest, conflicts };
  if (!changed.length) return { mine, nothing: true };
  const merged = { ...latest, ...pick(mine, changed) };
  if (!merged.name || !EMAIL_RE.test(merged.email)) return { mine, base, error: "baddetails" };
  if (changed.some((k) => REPORT_FIELDS.includes(k)) && !merged.report_time) return { mine, base, error: "badtime" };
  const details = changed.filter((k) => DETAIL_FIELDS.includes(k));
  const job = changed.filter((k) => JOB_FIELDS.includes(k));
  const report = changed.filter((k) => REPORT_FIELDS.includes(k));
  return {
    mine,
    changed: changed.map((k) => LABELS[k]),
    item: { type: "admin", action: "profile", u: p.id, ...(details.length ? { details: pick(mine, details) } : {}),
      ...(job.length ? { job: pick(mine, job) } : {}),
      ...(report.length ? { report: Object.fromEntries(report.map((k) => [k.slice(7), mine[k]])) } : {}) },
  };
}

// What a recruit may send from their own page (/me): their job search and report time, never their details.
export const OWN_FIELDS = new Set(["csrf", "base", ...JOB_FIELDS, ...REPORT_FIELDS]);

// profileChange for a recruit's own page: anything else in the form refuses the whole save ({ refused }), and the
// details always stay as they are, whatever the form's base says.
export function ownSearchChange(p, queue, form) {
  if ([...form.keys()].some((k) => !OWN_FIELDS.has(k))) return { refused: true };
  const latest = latestValues(p, queue);
  const safe = new FormData();
  for (const [k, v] of form.entries()) safe.append(k, v);
  for (const k of DETAIL_FIELDS) safe.set(k, latest[k]);
  const change = profileChange(p, queue, safe);
  return change.item ? { ...change, item: { ...change.item, self: 1 } } : change;
}

function shown(key, value) {
  if (key === "min_salary" && value === "0") return "no minimum";
  if (key === "max_km") return value === "0" ? "no limit" : `within ${value} km`;
  if (key === "currency") return value ? `${currencySymbol(value)} (${value})` : "as advertised";
  if (key === "report_days") return REPORT_DAYS.find(([d]) => d === value)?.[1] || value;
  if (key === "country") return COUNTRIES.find(([c]) => c === value)?.[1] || value.toUpperCase() || "any country";
  if (Array.isArray(value)) return value.join(", ") || "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return value || "empty";
}

function conflictBox(conflicts, latest, mine) {
  return `<div class="warn" id="conflict"><b>Someone else changed this recruit while you were editing.</b>
<p>Nothing has been saved yet. Your version is in the form below; Save again to keep it, or change these back:</p>
<ul>${conflicts.map((k) => `<li><b>${esc(LABELS[k])}</b>: now <i>${esc(shown(k, latest[k]))}</i>, yours <i>${esc(shown(k, mine[k]))}</i></li>`).join("")}</ul></div>`;
}

// ------------------------------------------------------------------------- one profile's page, and its save status

export const STATUS_URL = "/admin/profile/status";

function reportHint(p, status) {
  const zone = status.timezone ? ` (${status.timezone})` : "";
  if (p.report?.pending) return `HermitShell moves the report to this time when it next checks in${zone}.`;
  if ((status.scheduler ?? status.hermes_jobs) === false) return `Saved, but HermitShell's scheduler isn't set up, so the time applies once it is${zone}.`;
  return `When HermitShell sends their report${zone}. Each recruit's report is its own scheduled job.`;
}

// A report now, rather than at the daily time; the email follows when the scan finishes.
export function sendButton(p, csrf, fields = {}, label = "Send jobs now") {
  if (p.scanning) return '<button class="small" disabled>Scanning&hellip;</button>';
  return p.has_cv === false ? "" : button(csrf, "send_now", label, { u: p.id, ...fields }, "small");
}

export function sendSection(p, csrf, tz) {
  const state = p.scanning ? `Scanning now (started ${esc(when(p.scanning, tz))}); the email follows when it finishes.`
    : p.has_cv === false ? "Upload a CV first: jobs are rated against it."
      : `Runs their report straight away instead of waiting for the daily time, and emails it even if nothing new turned up. A scan usually takes 10 to 20 minutes.`;
  return `<h2 id="send">Send jobs now</h2><p class="muted">${state}</p>${sendButton(p, csrf, { back: "profile" })}`;
}

// The foot of a recruit's page: Retire, with a confirm window, or for a retired recruit how long their data is kept
// and Reactivate.
function retireSection(p, csrf, tz) {
  if (p.status === "retired") {
    const until = !p.keep_until ? "" : ` Their data is kept until <b>${esc(when(p.keep_until, tz).slice(0, 10))}</b>${p.keep_months
      ? `, as they chose (${esc(p.keep_months)} months)` : ", unless they choose otherwise from the email they were sent"}, then deleted, backups included.`;
    return `<h2 id="retire">Retired</h2><p class="muted">Retired${p.retired ? ` on ${esc(when(p.retired, tz).slice(0, 10))}` : ""}: they get no reports.${until} Reactivate starts their reports again.</p>
${button(csrf, "resume", "Reactivate", { u: p.id, back: "profile" }, "small")}`;
  }
  return `<h2 id="retire">Retire</h2><p class="muted">${esc(RETIRE_INTRO)}</p><a class="redbtn" href="#retire-${esc(p.id)}">${RETIRE_ICON}Retire ${esc(p.name)}</a>`;
}

function retireModal(p, csrf) {
  return p.status === "retired" ? "" : deleteModal({ id: `retire-${p.id}`, title: `Retire ${p.name}?`, intro: RETIRE_INTRO, action: "/admin/action",
    fields: { csrf, action: "retire", u: p.id, back: "profile" }, check: "Retire them and email them to choose what happens to their data",
    label: "Retire", icon: RETIRE_ICON });
}

export function profilePage(status, pid, csrf,
  { done = "", error = "", queue = [], saving = false, draft = null, base = null, conflicts = [], code = 200, cv = null, notes = "" } = {}) {
  const p = (status.profiles || []).find((x) => x.id === pid);
  if (!p) {
    return page("Recruit not found", '<p>HermitShell has not reported this recruit. <a href="/admin">Back to recruits</a></p>', { status: 404 });
  }
  const latest = latestValues(p, queue);
  const v = draft || latest;
  const message = error ? note(error, "bad") : done ? note(done) : "";
  return page(p.name, `<style>${LINK_STYLE}${MODAL_STYLE}${CONFIRM_STYLE}${cv ? DOC_STYLE + PROFILE_CV_STYLE : ""}${notes ? NOTES_STYLE : ""}</style>${cv ? profileCvButtons(p, { csrf, ...cv }) : ""}${profileTabs(pid, "manage")}
<p><a class="statlink" href="${STATS_URL}?u=${esc(pid)}">${icon("chart")}View stats</a></p>
${message}<iframe class="saving" src="${STATUS_URL}?u=${esc(pid)}${saving ? "&amp;n=1" : ""}" title="Save status"></iframe>
${conflicts.length ? conflictBox(conflicts, latest, v) : ""}
<form method="post" action="/admin/action">${hidden({ csrf, action: "profile", u: pid, base: JSON.stringify(base || latest) })}
<h2 id="details">Details</h2>
<div class="grid2"><div><label for="d_name">Name</label><input id="d_name" name="name" value="${esc(v.name)}" required maxlength="80" autocomplete="off"></div>
<div><label for="d_email">Email for reports</label><input id="d_email" name="email" type="email" value="${esc(v.email)}" required maxlength="120" autocomplete="off"></div>
<div><label for="d_phone">Phone</label><input id="d_phone" name="phone" value="${esc(v.phone)}" maxlength="40" autocomplete="off">${hint("Optional. Shown on cover letters.")}</div>
<div><label for="d_loc">Home town</label><input id="d_loc" name="location" value="${esc(v.location)}" maxlength="80" autocomplete="off">${hint("Shown on cover letters.")}</div></div>
${searchFields(v, reportHint(p, status))}
<button>Save changes</button></form>
${p.status === "retired" ? "" : sendSection(p, csrf, status.timezone)}
${notes}
<h2 id="cv">CV</h2>
<p class="muted">${p.has_cv ? `HermitShell has a CV${p.cv_updated ? ` (updated ${esc(when(p.cv_updated, status.timezone))})` : ""}. A new one replaces it and rebuilds the skills and profile the jobs are rated against.` : "No CV yet: jobs can't be rated until one is uploaded."}</p>
<form method="post" action="/admin/cv" enctype="multipart/form-data">${hidden({ csrf, u: pid })}
<label for="cv">CV file</label><input id="cv" name="cv" type="file" accept=".pdf,.docx,.txt,.md">${hint("PDF, Word (.docx) or text, up to 5 MB.")}
<label for="cv_text">Or paste the CV text</label><textarea id="cv_text" name="cv_text" maxlength="${MAX_CV_TEXT}"></textarea>
<label for="roles">Roles you're after</label><input id="roles" name="roles" maxlength="300">${hint("Optional. Helps suggest job titles from the CV.")}
<button>Upload CV</button></form>
${retireSection(p, csrf, status.timezone)}`, { wide: true, status: code, before: retireModal(p, csrf) + BACK_TO_RECRUITS, headers: { "Content-Security-Policy": `${CSP}; frame-src 'self'` },
    refresh: cv?.busy ? 15 : 0, refreshTo: cv?.busy ? `/admin/profile?u=${pid}` : "" });
}

// The job search and daily report boxes, on a recruit's page and on their own (/me).
export function searchFields(v, timeHint) {
  return `<h2 id="job">Job search</h2>
<label for="titles">Job titles</label><textarea id="titles" name="titles" maxlength="600" placeholder="Data Engineer&#10;Analytics Engineer">${esc(v.titles.join("\n"))}</textarea>${hint(`One per line, up to ${MAX_TITLES}.`)}
<div class="grid2"><div><label for="region">Region or city</label><input id="region" name="region" value="${esc(v.region)}" maxlength="80" placeholder="Greater Manchester">${hint("Where to look. Web searches use this.")}</div>
<div><label for="country">Country</label>${countrySelect(v.country)}${hint("Searches favour jobs in this country.")}</div></div>
<label for="places">Towns</label><input id="places" name="places" value="${esc(v.places.join(", "))}" maxlength="1200" placeholder="Salford, Stockport, Trafford">${hint("Towns in the region whose jobs count as local, separated by commas.")}
<label for="max_km">Within N km of home town (as the crow flies)</label><input id="max_km" name="max_km" type="number" min="0" max="${MAX_DISTANCE_KM}" step="1" value="${esc(v.max_km === "0" ? "" : v.max_km)}" placeholder="No limit" inputmode="numeric">${hint(`Up to ${MAX_DISTANCE_KM} km from the Home town in the details. Where a job's town is known, its distance decides instead of the region and towns; remote and hybrid jobs, and towns that aren't found, still go by the region.`)}<span class="hint">Place data from <a href="https://www.geonames.org/" rel="noopener noreferrer">GeoNames</a>, CC BY 4.0.</span>
<label class="check"><input type="checkbox" name="remote_anywhere" value="1"${checked(v.remote_anywhere)}> <span>Include fully remote jobs based anywhere</span></label>
<div class="grid2"><div><label for="level">Seniority</label>${select("level", LEVELS, v.level)}</div>
<div><label for="min_salary">Minimum salary</label><input id="min_salary" name="min_salary" value="${esc(v.min_salary === "0" ? "" : v.min_salary)}" maxlength="12" placeholder="No minimum" inputmode="decimal">${hint("For example 45000 or 45k. Jobs that don't show a salary are always included.")}</div>
<div><label for="currency">Currency</label>${currencySelect(v.currency)}${hint("Salaries in other currencies are converted to this one at the day's exchange rate, and the minimum is in it. As advertised leaves them as they are.")}</div></div>
<label>Employment types</label>${boxes("types", EMPLOYMENT_TYPES, v.types)}
<label>Work location</label>${boxes("modes", WORK_MODES, v.modes)}
<label class="check"><input type="checkbox" name="hide_agency" value="1"${checked(v.hide_agency)}> <span>Hide agency adverts that don't name the employer</span></label>

<h2 id="report">Daily report</h2>
<div class="grid2"><div><label for="report_time">Time</label><input id="report_time" name="report_time" type="time" value="${esc(v.report_time)}">${hint(timeHint)}</div>
<div><label for="report_days">Days</label><select id="report_days" name="report_days">${REPORT_DAYS.map(([d, label]) =>
    `<option value="${d}"${d === v.report_days ? " selected" : ""}>${label}</option>`).join("")}</select></div></div>`;
}

const WAIT_FAST = 12; // checks 5 seconds apart, then
const WAIT_SLOW = 21; // 20 seconds apart, then stop: each check lists the KV queue (1,000 lists a day on the free plan)
const SCAN_CHECKS = 80; // a running scan is checked every 30 seconds, from the reported status only, for up to 40 minutes

// The small box at the top of a profile page, reloading itself while a change for the profile is waiting for
// HermitShell. `n` counts the checks; it starts at 1 right after a save so "applied" can be said once it is.
export function saveStatus(status, pid, queue, n) {
  const mine = queue.filter((i) => i.type === "admin" && i.u === pid);
  const tz = status.timezone;
  const failed = (status.problems || []).filter((x) => x.what?.endsWith(` for ${pid}`) && Date.now() - x.at < 15 * 60 * 1000);
  let body;
  let refresh = 0;
  const scan = (status.profiles || []).find((x) => x.id === pid)?.scanning;
  if (mine.length) {
    refresh = n < WAIT_FAST ? 5 : n < WAIT_SLOW ? 20 : 0;
    const cv = mine.some((i) => i.action === "cv");
    body = !refresh ? `Still waiting for HermitShell. <a href="/admin/profile?u=${esc(pid)}" target="_top">Reload</a> to check again; <a href="/admin" target="_top">Recruits</a> shows when it last reported.`
      : cv ? "Saved. HermitShell is reading the new CV; this takes a few minutes."
        : mine.every((i) => i.action === "send_now") ? "Starting the scan&hellip;"
          : "Saved. Waiting for HermitShell to apply it (a few seconds while it is connected)&hellip;";
  } else if (scan && !failed.length) {
    refresh = n < SCAN_CHECKS ? 30 : 0;
    body = `Scanning for jobs since ${esc(when(scan, tz))}; the email follows when it finishes.`;
  } else if (failed.length) {
    body = `<b>HermitShell could not apply a change:</b> ${esc(failed.at(-1).error)}`;
  } else if (n > 0) {
    body = `Applied by HermitShell${status.updated ? ` at ${esc(when(status.updated, tz))}` : ""}.`;
  } else {
    body = status.updated ? `Up to date. HermitShell last reported ${esc(ago(status.updated))}.` : "HermitShell hasn't reported yet.";
  }
  const next = refresh ? `<meta http-equiv="refresh" content="${refresh};url=${STATUS_URL}?u=${esc(pid)}&amp;n=${n + 1}">` : "";
  const state = mine.length || (scan && !failed.length) ? (refresh ? "wait" : "idle") : failed.length ? "bad" : n > 0 ? "done" : "ok";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">${next}<style>${WIDGET_STYLE}</style></head>
<body class="${state}${n > 0 ? " again" : ""}" style="--spin:-${((Date.now() % 800) / 1000).toFixed(2)}s">${body}</body></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'",
      ...SECURITY_HEADERS,
    },
  });
}

const WIDGET_STYLE = `
body{margin:0;height:44px;box-sizing:border-box;padding:0 14px 0 42px;display:block;line-height:42px;white-space:nowrap;overflow:hidden;
text-overflow:ellipsis;font:500 14px/42px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;border:1px solid;border-radius:12px;
position:relative;color:#334155;background:#f8fafc;border-color:#e5e8f0;-webkit-font-smoothing:antialiased;animation:in .4s ease both}
body::before{content:"";position:absolute;left:14px;top:12px;width:18px;height:18px;box-sizing:border-box;border-radius:50%}
body.wait{background:#eef0ff;border-color:#c7d2fe;color:#3730a3}
body.wait::before{border:2px solid #c7d2fe;border-top-color:#6366f1;animation:spin .8s linear var(--spin,0s) infinite}
body.again{animation:none}
body.idle{background:#fffbeb;border-color:#fde68a;color:#92400e}body.idle::before{border:2px solid #f59e0b}
body.ok,body.done{background:#f0fdf6;border-color:#bbf7d0;color:#166534}
body.ok::before{background:#22c55e;width:8px;height:8px;left:19px;top:17px;box-shadow:0 0 0 4px rgba(34,197,94,.2)}
body.done::before{background:#059669;animation:donepop .45s cubic-bezier(.2,.8,.2,1) both}
body.done::after{content:"";position:absolute;left:21px;top:15px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;
transform:rotate(45deg)}
body.bad{background:#fef2f2;border-color:#fecaca;color:#991b1b}body.bad::before{background:#dc2626}
body.bad::after{content:"!";position:absolute;left:14px;top:0;width:18px;text-align:center;color:#fff;font-weight:800;font-size:12px}
a{color:inherit;text-underline-offset:3px}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes donepop{from{transform:scale(.3);opacity:0}}@keyframes in{from{opacity:0}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important}}`;

// ------------------------------------------------------------------------- turning forms into queue items

// The queue item for a settings form, or { error } with a message key for the dashboard.
export function settingsItem(act, form) {
  if (act === "email") {
    const host = field(form, "host", 120);
    const port = field(form, "port", 5) || "587";
    const user = field(form, "user", 120);
    const from = field(form, "from", 120);
    if (!HOST_RE.test(host) || !/^\d{1,5}$/.test(port) || !(Number(port) > 0 && Number(port) < 65536) || !user ||
        (from && !EMAIL_RE.test(from))) return { error: "bademail" };
    const password = String(form.get("password") || "").trim().slice(0, 200);
    return { item: { type: "admin", action: "email", host, port, user, from, ...(password ? { password } : {}) },
      ttl: password ? SECRET_TTL_SECONDS : undefined };
  }
  if (act === "email_clear") return { item: { type: "admin", action: "email", clear: true } };
  if (act === "features") {
    // Only the switches the form showed: each is on the form with its checkbox and a hidden "shown" field.
    const shown = new Set(form.getAll("shown").map(String));
    if (!FEATURES.some(([n]) => shown.has(n))) return { error: "nochange" };
    return { item: { type: "admin", action: "features",
      ...Object.fromEntries(FEATURES.filter(([n]) => shown.has(n)).map(([n]) => [n, form.get(n) === "1"])) } };
  }
  if (act === "test_email") {
    const to = field(form, "to", 120);
    if (to && !EMAIL_RE.test(to)) return { error: "bademail" };
    return { item: { type: "admin", action: "test_email", to } };
  }
  if (act === "api_keys") {
    const firecrawl = String(form.get("firecrawl") || form.get("keys") || "").split(/[\s,]+/).filter(Boolean);
    const single = Object.fromEntries(["tavily", "scrapfly"].map((n) => [n, String(form.get(n) || "").trim()]).filter(([, v]) => v));
    if ((!firecrawl.length && !Object.keys(single).length) || [...firecrawl, ...Object.values(single)].some((k) => !KEY_RE.test(k))) {
      return { error: "badkey" };
    }
    return { item: { type: "admin", action: "api_keys", ...(firecrawl.length ? { firecrawl: firecrawl.slice(0, 5) } : {}), ...single },
      ttl: SECRET_TTL_SECONDS };
  }
  if (act === "api_key") {
    const provider = String(form.get("provider") || "firecrawl");
    const keys = String(form.get("key") || "").split(/[\s,]+/).filter(Boolean);
    if (!Object.hasOwn(PROVIDERS, provider) || !keys.length || keys.some((k) => !KEY_RE.test(k)) || (provider !== "firecrawl" && keys.length > 1)) {
      return { error: "badkey" };
    }
    return { item: { type: "admin", action: "api_keys", ...(provider === "firecrawl" ? { firecrawl: keys.slice(0, 5) } : { [provider]: keys[0] }) },
      ttl: SECRET_TTL_SECONDS };
  }
  if (act === "api_keys_clear") {
    const provider = String(form.get("provider") || "firecrawl");
    return Object.hasOwn(PROVIDERS, provider) ? { item: { type: "admin", action: "api_keys", clear: [provider] } } : { error: "badkey" };
  }
  if (act === "model_key") {
    const provider = String(form.get("provider") || "");
    const key = String(form.get("key") || "").trim();
    const model = String(form.get("model") || "").trim();
    if (!Object.hasOwn(MODEL_PROVIDERS, provider) || (!key && !model) || (key && !MODEL_KEY_RE.test(key)) || (model && !MODEL_RE.test(model))) {
      return { error: "badmodel" };
    }
    return { item: { type: "admin", action: "model_keys", provider, ...(key ? { key } : {}), ...(model ? { model } : {}) },
      ttl: key ? SECRET_TTL_SECONDS : undefined };
  }
  if (act === "model_key_clear") {
    const provider = String(form.get("provider") || "");
    return Object.hasOwn(MODEL_PROVIDERS, provider) ? { item: { type: "admin", action: "model_keys", provider, clear: true } } : { error: "badmodel" };
  }
  if (act === "model_order") {
    const order = String(form.get("order") || "");
    return ["cloud", "local"].includes(order) ? { item: { type: "admin", action: "model_keys", order } } : { error: "badmodel" };
  }
  if (act === "model_local") {
    const picked = String(form.get("model") ?? "").trim();
    const model = picked === "custom" ? String(form.get("custom") || "").trim() : picked;
    return (model === "" && picked !== "custom") || OLLAMA_RE.test(model) ? { item: { type: "admin", action: "local_model", model } } : { error: "badlocal" };
  }
  return null;
}

// POST /admin/cv: a CV uploaded for a profile, stored like a sign-up's until HermitShell collects it. `allow(u)`
// says whether the signed-in user may change that recruit.
export async function cvUpload(request, env, s, allow = async () => true, recorded = async () => {}) {
  const form = await limitedForm(request, MAX_CV_FORM_BYTES);
  if (!form) return page("CV too large", '<p>The CV file is larger than 5 MB. <a href="/admin">Back</a></p>', { status: 413 });
  if (!safeEqual(String(form.get("csrf") || ""), s.csrf)) return page("Expired form", "<p>Reload the admin page and try again.</p>", { status: 403 });
  const u = String(form.get("u") || "");
  if (!PROFILE_RE.test(u)) return page("Unknown recruit", "<p>Reload the admin page and try again.</p>", { status: 400 });
  if (!(await allow(u))) return page("Recruit not found", '<p>HermitShell has not reported this recruit. <a href="/admin">Back to recruits</a></p>', { status: 404 });
  const back = (done) => redirect(`/admin/profile?u=${u}&done=${done}`);
  const file = form.get("cv");
  const cvText = String(form.get("cv_text") ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, MAX_CV_TEXT);
  let cv = null;
  const info = sealInfo(await env.FEEDBACK.get("status:profiles", "json"));
  if (file && typeof file === "object" && file.size) {
    if (file.size > MAX_CV_BYTES) return back("cvsize");
    const bytes = await file.arrayBuffer();
    const kind = cvKind(file, bytes);
    if (!kind) return back("cvtype");
    cv = await storeCv(env, info, bytes, { kind, name: file.name.slice(0, 120), size: file.size }, 60 * 60 * 24 * 30);
  }
  if (!cv && cvText.length < 200) return back("cvmissing");
  const item = { type: "admin", action: "cv", u, cv, cv_text: cvText, roles: field(form, "roles", 300) };
  await queueItem(env, info ? await sealItem(info, item) : item);
  await recorded(u, cv ? `Uploaded a new CV (${cv.name})` : "Pasted new CV text");
  return back("cvqueued");
}

export const SETTINGS_DONE = {
  bademail: "Check the email settings: the server, port, username and addresses must be valid.",
  badmodel: "Choose a provider and paste its API key or a model name (letters, numbers and . _ : / @ + -).",
  badlocal: "Pick a server model, or type an Ollama model name such as mistral:7b (letters, numbers and . _ - / :).",
  nokey: "Not saved: HermitShell hasn't sent the key that keeps passwords and API keys encrypted until it collects them. Save again once it is connected and up to date.",
  baddetails: "A name and a valid email address are needed.",
  profile: "Unknown recruit. Reload the admin page and try again.",
  cvsize: "The CV file is larger than 5 MB.",
  cvtype: "The CV must be a PDF, a Word .docx file or a text file.",
  cvmissing: "Upload a CV file or paste the CV (at least a few lines).",
  cvqueued: "CV uploaded. HermitShell reads it and rebuilds the profile within about 10 minutes, then emails a summary.",
  badtime: "Choose a time for the daily report.",
  sending: "Sending. HermitShell starts the scan within seconds while it is connected; the email follows when it finishes, usually in 10 to 20 minutes.",
};

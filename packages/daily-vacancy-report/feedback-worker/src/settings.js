// Settings pages of the admin dashboard: the setup checklist, the global settings page (email server and web
// search API keys, shared by every profile) and each profile's page (details, job search, CV). Forms open
// prefilled from the last status HermitShell reported; saving only queues the change, which profiles.py
// validates again and applies within about 5 minutes.

import { COUNTRIES, countryCode } from "./countries.js";
import { MAX_CV_BYTES, SECRET_TTL_SECONDS, cvKind, queueItem } from "./join.js";
import { esc, limitedForm, newId, page, redirect, safeEqual, when } from "./lib.js";

export const LEVELS = ["junior", "mid", "senior", "lead", "any"];
export const EMPLOYMENT_TYPES = ["Permanent", "Contract", "Temporary", "Part-time", "Internship"];
export const WORK_MODES = ["On-site", "Hybrid", "Remote"];
const PROVIDERS = {
  firecrawl: { label: "Firecrawl", signup: "https://www.firecrawl.dev/app/api-keys" },
  tavily: { label: "Tavily", signup: "https://app.tavily.com/home" },
  scrapfly: { label: "Scrapfly", signup: "https://scrapfly.io/dashboard" },
};
const KEY_RE = /^[A-Za-z0-9_-]{8,120}$/;
const HOST_RE = /^[A-Za-z0-9.-]{3,120}$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const PROFILE_RE = /^[a-z0-9-]{1,40}$/;
const MAX_TITLES = 8;
const MAX_PLACES = 30;
const MAX_CV_TEXT = 20000;
const MAX_CV_FORM_BYTES = MAX_CV_BYTES + 256 * 1024;

function field(form, name, max) {
  return String(form.get(name) ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function list(value, sep, limit, maxLen) {
  return [...new Set(String(value || "").split(sep).map((v) => v.replace(/\s+/g, " ").trim().slice(0, maxLen)).filter(Boolean))]
    .slice(0, limit);
}

function hidden(fields) {
  return Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");
}

function checked(on) {
  return on ? " checked" : "";
}

// ------------------------------------------------------------------------- dashboard sections

export const SETTINGS_URL = "/admin/settings";

export function nav(active) {
  const tabs = [["profiles", "/admin", "Profiles"], ["settings", SETTINGS_URL, "Global settings"]];
  return `<nav class="tabs">${tabs.map(([id, href, label]) =>
    `<a href="${href}"${id === active ? ' class="on" aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

export function ownerOf(status) {
  return (status.profiles || []).find((p) => p.owner) || null;
}

export function checklist(status) {
  const owner = ownerOf(status);
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
    [owner?.has_cv, "Your CV uploaded",
      owner ? `<a href="/admin/profile?u=owner#cv">Upload your CV</a> so jobs can be rated against it.` : "Upload your CV once HermitShell has connected."],
    [(owner?.job?.titles || []).length > 0, "Job search set",
      owner ? `<a href="/admin/profile?u=owner#job">Choose the job titles and location</a> to search for.` : "Set the job search once HermitShell has connected."],
  ];
  const todo = items.filter(([ok]) => !ok);
  if (!todo.length) return '<p class="muted">Setup complete.</p>';
  return `<h2>Finish setting up</h2><ul class="steps">${items.map(([ok, label, help]) =>
    `<li class="${ok ? "done" : "todo"}"><b>${ok ? "&#10003;" : "&#9675;"} ${esc(label)}</b>${ok ? "" : `<div class="muted">${help}</div>`}</li>`).join("")}</ul>`;
}

export function problems(status) {
  const recent = (status.problems || []).slice(-5);
  return recent.length ? `<div class="warn"><b>HermitShell could not apply:</b><ul>${recent.map((p) =>
    `<li>${esc(p.what)}: ${esc(p.error)} <span class="muted">(${esc(when(p.at, status.timezone))})</span></li>`).join("")}</ul></div>` : "";
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

export function keysSection(status, csrf) {
  const keys = status.keys || {};
  const rows = Object.entries(PROVIDERS).map(([name, info]) => {
    const k = keys[name] || {};
    const now = k.source === "dashboard" ? `set here ${k.hint || ""}` : k.source === "env" ? `HermitShell's .env ${k.hint || ""}` : "none";
    const extra = name === "firecrawl" && k.backups ? `, plus ${k.backups} backup key${k.backups === 1 ? "" : "s"}` : "";
    return `<tr><td><b>${info.label}</b><div class="muted"><a href="${info.signup}" rel="noopener">get a key</a></div></td>
<td class="muted">${esc(now + extra)}</td><td>${k.source === "dashboard" ? button(csrf, "api_keys_clear", "Use the .env key", { provider: name }) : ""}</td></tr>`;
  }).join("");
  return `<h2 id="keys">Web search API keys</h2>
<p class="muted">Used to search job boards for everyone without their own key. Firecrawl is tried first, then Tavily, then Scrapfly.</p>
<table class="list">${rows}</table>
<form method="post" action="/admin/action">${hidden({ csrf, action: "api_keys" })}
<div class="grid2"><div><label for="k_fc">Firecrawl key</label><input id="k_fc" name="firecrawl" type="password" autocomplete="off" maxlength="700">${hint("Several keys can be separated by commas.")}</div>
<div><label for="k_tv">Tavily key</label><input id="k_tv" name="tavily" type="password" autocomplete="off" maxlength="120"></div>
<div><label for="k_sf">Scrapfly key</label><input id="k_sf" name="scrapfly" type="password" autocomplete="off" maxlength="120"></div></div>
<button>Save keys</button></form><p class="muted">Empty boxes leave that key as it is. Keys are only shown as their last four characters.</p>`;
}

export function settingsPage(status, csrf, { done = "", queued = [] } = {}) {
  const waiting = queued.filter((q) => /^(email|test email|api keys)$/.test(q));
  return page("Global settings", `${nav("settings")}
${done ? `<p style="color:#047857">${esc(done)}</p>` : ""}${waiting.length ? `<p class="muted">Waiting for HermitShell: ${esc(waiting.join("; "))}.</p>` : ""}
<p class="muted">These apply to the whole of HermitShell and every profile. Where each person's reports go, their job search
and CV are on their own page under <a href="/admin">Profiles</a>.</p>
${emailSection(status, csrf)}
${keysSection(status, csrf)}`, { wide: true });
}

// ------------------------------------------------------------------------- one profile's page

function select(name, options, current) {
  return `<select id="${name}" name="${name}">${options.map((o) => `<option value="${esc(o)}"${o === current ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
}

function hint(text) {
  return `<span class="hint">${esc(text)}</span>`;
}

function countrySelect(current) {
  const code = countryCode(current);
  return `<select id="country" name="country"><option value="">Any country</option>${COUNTRIES.map(([c, name]) =>
    `<option value="${c}"${c === code ? " selected" : ""}>${esc(name)}</option>`).join("")}</select>`;
}

function boxes(name, options, current) {
  return `<div class="checks">${options.map((o) => `<label class="check"><input type="checkbox" name="${name}" value="${esc(o)}"${checked(current.includes(o))}> <span>${esc(o)}</span></label>`).join("")}</div>`;
}

export function profilePage(status, pid, csrf, { done = "", queued = [] } = {}) {
  const p = (status.profiles || []).find((x) => x.id === pid);
  if (!p) {
    return page("Profile not found", '<p>HermitShell has not reported this profile. <a href="/admin">Back to profiles</a></p>', { status: 404 });
  }
  const d = p.details || { name: p.name, email: p.email };
  const j = p.job || {};
  const waiting = queued.filter((q) => q.endsWith(` for ${pid}`));
  const salary = j.min_salary && j.min_salary !== "0" ? j.min_salary : "";
  return page(p.owner ? "Your profile" : p.name, `<a class="back" href="/admin">&larr; Back to profiles</a>${nav("profiles")}
${done ? `<p style="color:#047857">${esc(done)}</p>` : ""}${waiting.length ? `<p class="muted">Waiting for HermitShell: ${esc(waiting.join("; "))}.</p>` : ""}
<h2 id="details">Details</h2>
<form method="post" action="/admin/action">${hidden({ csrf, action: "profile", section: "details", u: pid })}
<div class="grid2"><div><label for="d_name">Name</label><input id="d_name" name="name" value="${esc(d.name)}" required maxlength="80" autocomplete="off"></div>
<div><label for="d_email">Email for reports</label><input id="d_email" name="email" type="email" value="${esc(d.email)}" required maxlength="120" autocomplete="off"></div>
<div><label for="d_phone">Phone</label><input id="d_phone" name="phone" value="${esc(d.phone || "")}" maxlength="40" autocomplete="off">${hint("Optional. Shown on cover letters.")}</div>
<div><label for="d_loc">Home town</label><input id="d_loc" name="location" value="${esc(d.location || "")}" maxlength="80" autocomplete="off">${hint("Shown on cover letters.")}</div></div>
<button>Save details</button></form>

<h2 id="job">Job search</h2>
<form method="post" action="/admin/action">${hidden({ csrf, action: "profile", section: "job", u: pid })}
<label for="titles">Job titles</label><textarea id="titles" name="titles" maxlength="600" placeholder="Data Engineer&#10;Analytics Engineer">${esc((j.titles || []).join("\n"))}</textarea>${hint(`One per line, up to ${MAX_TITLES}.`)}
<div class="grid2"><div><label for="region">Region or city</label><input id="region" name="region" value="${esc(j.region || "")}" maxlength="80" placeholder="Greater Manchester">${hint("Where to look. Web searches use this.")}</div>
<div><label for="country">Country</label>${countrySelect(j.country || "")}${hint("Searches favour jobs in this country.")}</div></div>
<label for="places">Towns</label><input id="places" name="places" value="${esc((j.places || []).join(", "))}" maxlength="1200" placeholder="Salford, Stockport, Trafford">${hint("Towns in the region whose jobs count as local, separated by commas.")}
<label class="check"><input type="checkbox" name="remote_anywhere" value="1"${checked(j.remote_anywhere)}> <span>Include fully remote jobs based anywhere</span></label>
<div class="grid2"><div><label for="level">Seniority</label>${select("level", LEVELS, j.level || "any")}</div>
<div><label for="min_salary">Minimum salary</label><input id="min_salary" name="min_salary" value="${esc(salary)}" maxlength="12" placeholder="No minimum" inputmode="decimal">${hint("For example 45000 or 45k. Jobs that don't show a salary are always included.")}</div>
<div><label for="currency">Currency</label><input id="currency" name="currency" value="${esc(j.currency || "")}" maxlength="4" placeholder="£">${hint("The symbol adverts use, such as £, € or $.")}</div></div>
<label>Employment types</label>${boxes("types", EMPLOYMENT_TYPES, j.types || [])}
<label>Work location</label>${boxes("modes", WORK_MODES, j.modes || [])}
<label class="check"><input type="checkbox" name="hide_agency" value="1"${checked(j.hide_agency)}> <span>Hide agency adverts that don't name the employer</span></label>
<button>Save job search</button></form>

<h2 id="cv">CV</h2>
<p class="muted">${p.has_cv ? `HermitShell has a CV${p.cv_updated ? ` (updated ${esc(when(p.cv_updated, status.timezone))})` : ""}. A new one replaces it and rebuilds the skills and profile the jobs are rated against.` : "No CV yet: jobs can't be rated until one is uploaded."}</p>
<form method="post" action="/admin/cv" enctype="multipart/form-data">${hidden({ csrf, u: pid })}
<label for="cv">CV file</label><input id="cv" name="cv" type="file" accept=".pdf,.docx,.txt,.md">${hint("PDF, Word (.docx) or text, up to 5 MB.")}
<label for="cv_text">Or paste the CV text</label><textarea id="cv_text" name="cv_text" maxlength="${MAX_CV_TEXT}"></textarea>
<label for="roles">Roles you're after</label><input id="roles" name="roles" maxlength="300">${hint("Optional. Helps suggest job titles from the CV.")}
<button>Upload CV</button></form>`, { wide: true });
}

// ------------------------------------------------------------------------- turning forms into queue items

// The queue item for a settings form, or { error } with a message key for the dashboard.
export function settingsItem(act, form) {
  const u = String(form.get("u") || "");
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
  if (act === "api_keys_clear") {
    const provider = String(form.get("provider") || "firecrawl");
    return PROVIDERS[provider] ? { item: { type: "admin", action: "api_keys", clear: [provider] } } : { error: "badkey" };
  }
  if (act === "profile") {
    if (!PROFILE_RE.test(u)) return { error: "profile" };
    if (form.get("section") === "details") {
      const details = { name: field(form, "name", 80), email: field(form, "email", 120), phone: field(form, "phone", 40),
        location: field(form, "location", 80) };
      if (!details.name || !EMAIL_RE.test(details.email)) return { error: "baddetails" };
      return { item: { type: "admin", action: "profile", u, details } };
    }
    const salary = field(form, "min_salary", 16).replace(/[,\s£€$]/g, "");
    const job = {
      titles: list(form.get("titles"), /[\n,]/, MAX_TITLES, 60),
      region: field(form, "region", 80),
      places: list(form.get("places"), /[\n,]/, MAX_PLACES, 40),
      country: countryCode(field(form, "country", 2)),
      remote_anywhere: form.get("remote_anywhere") === "1",
      level: LEVELS.includes(form.get("level")) ? form.get("level") : "any",
      types: form.getAll("types").filter((t) => EMPLOYMENT_TYPES.includes(t)),
      modes: form.getAll("modes").filter((m) => WORK_MODES.includes(m)),
      min_salary: /^\d+(\.\d+)?k?$/i.test(salary) ? salary : "0",
      currency: field(form, "currency", 4),
      hide_agency: form.get("hide_agency") === "1",
    };
    return { item: { type: "admin", action: "profile", u, job } };
  }
  return null;
}

// POST /admin/cv: a CV uploaded for a profile, stored like a sign-up's until HermitShell collects it.
export async function cvUpload(request, env, s) {
  const form = await limitedForm(request, MAX_CV_FORM_BYTES);
  if (!form) return page("CV too large", '<p>The CV file is larger than 5 MB. <a href="/admin">Back</a></p>', { status: 413 });
  if (!safeEqual(String(form.get("csrf") || ""), s.csrf)) return page("Expired form", "<p>Reload the admin page and try again.</p>", { status: 403 });
  const u = String(form.get("u") || "");
  if (!PROFILE_RE.test(u)) return page("Unknown profile", "<p>Reload the admin page and try again.</p>", { status: 400 });
  const back = (done) => redirect(`/admin/profile?u=${u}&done=${done}#cv`);
  const file = form.get("cv");
  const cvText = String(form.get("cv_text") ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, MAX_CV_TEXT);
  let cv = null;
  if (file && typeof file === "object" && file.size) {
    if (file.size > MAX_CV_BYTES) return back("cvsize");
    const bytes = await file.arrayBuffer();
    const kind = cvKind(file, bytes);
    if (!kind) return back("cvtype");
    cv = { key: `cvfile:${newId()}`, kind, name: file.name.slice(0, 120), size: file.size };
    await env.FEEDBACK.put(cv.key, bytes, { expirationTtl: 60 * 60 * 24 * 30 });
  }
  if (!cv && cvText.length < 200) return back("cvmissing");
  await queueItem(env, { type: "admin", action: "cv", u, cv, cv_text: cvText, roles: field(form, "roles", 300) });
  return back("cvqueued");
}

export const SETTINGS_DONE = {
  bademail: "Check the email settings: the server, port, username and addresses must be valid.",
  baddetails: "A name and a valid email address are needed.",
  profile: "Unknown profile. Reload the admin page and try again.",
  cvsize: "The CV file is larger than 5 MB.",
  cvtype: "The CV must be a PDF, a Word .docx file or a text file.",
  cvmissing: "Upload a CV file or paste the CV (at least a few lines).",
  cvqueued: "CV uploaded. HermitShell reads it and rebuilds the profile within about 10 minutes, then emails a summary.",
};

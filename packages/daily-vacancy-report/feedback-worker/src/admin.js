// Admin gateway (/admin) and the HermitShell API (/api/*).
//
// /admin: when ACCESS_AUD is set, Cloudflare Access (email one-time code) must let the request through
// first. Then sign in as the main admin (ADMIN_USER, default "admin", and the ADMIN_PASSWORD secret) or as a
// dashboard user made on the Users and roles page (users.js). Five wrong attempts lock that address, and 30 from
// anywhere lock sign-in, for 15 minutes. Everyone changes their own password from the Recruits page (the main
// admin's is the ADMIN_PASSWORD secret, so they are shown how to change that). Admins see every recruit; a recruiter sees only their own pool, and every
// route below checks that, not just the links on the page. Signed-in pages create invite links, show the recruits
// HermitShell reports, and queue changes that HermitShell applies as soon as the live link tells it (settings pages:
// settings.js; each recruit's stats page: stats.js; web search keys: keys.js; recruit search: search.js; the task
// list: tasks.js; the live link: hub.js; demo mode, made-up data on every signed-in page: demo.js). Nothing here can
// reach the HermitShell server: HermitShell connects out to /api/live and reads /api/queue with its API token.

import { DEMO_DONE, DEMO_URL, demoEnv, demoMode, demoRibbon, demoSection, demoToggle } from "./demo.js";
import { HISTORY_URL, historyPage, listed, record, recordReported } from "./history.js";
import { hubConnect, hubPresence, hubSeen } from "./hub.js";
import { createInvite, queueItem } from "./join.js";
import {
  CSP, SECURITY_HEADERS, accessUser, ago, authorised, cleanSkill, deleteAndUnflag, esc, hmacHex, json, limitedForm, limitedJson, listFlagged,
  purgeProfileEvents,
  note, page, redirect, safeEqual, secretEqual, text, when,
} from "./lib.js";
import {
  SETTINGS_DONE, SETTINGS_URL, STATUS_URL, USERS_URL, button, checklist, cvUpload, nav, problems, profileChange, profilePage, saveStatus,
  sendButton, settingsItem, settingsPage,
} from "./settings.js";
import { CONFIRM_STYLE, binButton, deleteModal } from "./confirm.js";
import { MODAL_STYLE } from "./keys.js";
import { SERVER_STYLE, serverBox } from "./models.js";
import { needsSeal, sealInfo, sealItem } from "./seal.js";
import { SEARCH_STYLE, matchesProfile, noMatch, recruiterHits, recruiterRow, searchBar, searchQuery } from "./search.js";
import {
  DOC_URL, REQUEST_KINDS, SKILL_URL, addedSkills, docIndex, emailedIndex, markEmailed, pdfResponse, pendingDocs, readDoc, requestDoc,
  requestSkill, storeDoc, validJobKey,
} from "./docs.js";
import { LINK_STYLE, MAX_STATS_BYTES, SENT_RANGES, SENT_URL, STATS_URL, sentPage, splitStats, statsLink, statsPage, validStats } from "./stats.js";
import { TASKS_STYLE, TASKS_URL, cancelTask, requests, taskRows, tasksButton, tasksModal, tasksPage } from "./tasks.js";
import {
  ADMIN_ID, KEY_ICON, PASSWORD_URL, ROLES, USERS_DONE, USERS_STYLE, USER_RE, accounts, canSee, changeOwnPassword, checkUser, displayName, initials,
  passwordModal, recruiterOf, recruiters, signOutUser, signedIn, userAction, usersPage,
} from "./users.js";

const SESSION_SECONDS = 12 * 3600;
const LOCK_SECONDS = 15 * 60;
const MAX_FAILURES = 5;
const MAX_GLOBAL_FAILURES = 30;
const MAX_FORM_BYTES = 64 * 1024;
const COOKIE = "__Host-hv_admin";
const PROFILE_RE = /^[a-z0-9-]{1,40}$/;
// What a recruiter may do from the dashboard, and then only for their own recruits.
const RECRUITER_ACTIONS = new Set(["invite", "revoke", "profile", "send_now", "pause", "resume"]);
const DONE = {
  queued: "Saved. HermitShell applies it within seconds while it is connected.",
  saved: "Saved. The box above shows when HermitShell has applied it, within seconds while it is connected.",
  nochange: "Nothing had changed, so nothing was saved.",
  revoked: "Invite revoked.",
  confirm: "Tick the confirmation box to delete a recruit.",
  badkey: "That does not look like an API key.",
  assigned: "Assigned. HermitShell records it within seconds while it is connected.",
  badrecruiter: "Pick a recruiter from the list.",
  password: "Password changed. You are still signed in here, and signed out everywhere else.",
  badcurrent: "Your current password was wrong, so nothing changed.",
  pwlocked: "Too many wrong current passwords. Try again in 15 minutes.",
  mainpass: "The main admin's password is the ADMIN_PASSWORD secret; change it with wrangler.",
  ...SETTINGS_DONE,
  ...DEMO_DONE,
  badpass: USERS_DONE.badpass,
  mismatch: USERS_DONE.mismatch,
};
const NOT_FOUND = ["Recruit not found", '<p>HermitShell has not reported this recruit. <a href="/admin">Back to recruits</a></p>', { status: 404 }];
const ADMINS_ONLY = ["Admins only", '<p>Only an admin can open this page. <a href="/admin">Back to recruits</a></p>', { status: 403 }];

// The main admin's sessions are signed with an epoch that signing out bumps; a user's with their own version,
// which a new password, deletion or signing out changes. Either way old cookies stop working.
async function epoch(env) {
  return (await env.FEEDBACK.get("admin:epoch")) || "0";
}

function sessionKey(env) {
  return `${env.JOB_FEEDBACK_SECRET}\n${env.ADMIN_PASSWORD}`;
}

async function sessionFor(env, exp, id, v) {
  return (await hmacHex(sessionKey(env), `admin-session\n${id}\n${v}\n${exp}`)).slice(0, 40);
}

async function csrfFor(env, exp, id, v) {
  return (await hmacHex(sessionKey(env), `csrf\n${id}\n${v}\n${exp}`)).slice(0, 32);
}

async function versionOf(env, id, acc) {
  if (id === ADMIN_ID) return epoch(env);
  return acc.users.find((u) => u.id === id)?.v || null;
}

async function session(request, env) {
  const cookie = (request.headers.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  const parts = (cookie || "").slice(COOKIE.length + 1).split(".");
  const [exp, id, sig] = parts;
  if (parts.length !== 3 || !sig || !(Number(exp) > Date.now()) || !(id === ADMIN_ID || USER_RE.test(id || ""))) return null;
  const acc = await accounts(env);
  const v = await versionOf(env, id, acc);
  const me = v === null ? null : signedIn(id, acc);
  if (!me || !safeEqual(sig, await sessionFor(env, exp, id, v))) return null;
  return { exp, csrf: await csrfFor(env, exp, id, v), me, acc };
}

function cookieHeader(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function loginPage(message = "", status = 200) {
  return page("Admin sign-in", `${message ? note(message, "bad") : ""}
<form method="post" action="/admin/login">
<label for="u">Username</label><input id="u" name="username" autocomplete="username" required>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form>`, { status });
}

async function login(request, env) {
  const ip = (request.headers.get("CF-Connecting-IP") || "unknown").replace(/[^0-9a-fA-F:.]/g, "").slice(0, 45);
  // IPv6 users can change the last 64 bits at will, so count failures per /64.
  const lockKey = `lock:${ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip}`;
  const [failures, globalFailures] = (await Promise.all([env.FEEDBACK.get(lockKey), env.FEEDBACK.get("lock:all")]))
    .map((v) => Number(v) || 0);
  if (failures >= MAX_FAILURES || globalFailures >= MAX_GLOBAL_FAILURES) {
    return loginPage("Too many attempts. Try again in 15 minutes.", 429);
  }
  const form = await limitedForm(request, 4096);
  if (!form) return loginPage("Wrong username or password.", 401);
  const [acc, userOk, passOk] = await Promise.all([accounts(env),
    secretEqual(env.JOB_FEEDBACK_SECRET, form.get("username"), env.ADMIN_USER || "admin"),
    secretEqual(env.JOB_FEEDBACK_SECRET, form.get("password"), env.ADMIN_PASSWORD)]);
  const user = userOk && passOk ? null : await checkUser(env, acc, form.get("username"), form.get("password"));
  // A failure count that cannot be recorded (for example the daily KV write limit) must not allow guessing,
  // and a right password must not show through as a different answer.
  if (!((userOk && passOk) || user)) {
    try {
      await Promise.all([
        env.FEEDBACK.put(lockKey, String(failures + 1), { expirationTtl: LOCK_SECONDS }),
        env.FEEDBACK.put("lock:all", String(globalFailures + 1), { expirationTtl: LOCK_SECONDS }),
      ]);
    } catch {
      return loginPage("Sign-in is unavailable right now. Try again later.", 503);
    }
    return loginPage("Wrong username or password.", 401);
  }
  try {
    await env.FEEDBACK.delete(lockKey);
  } catch {
    return loginPage("Sign-in is unavailable right now. Try again later.", 503);
  }
  const id = user ? user.id : ADMIN_ID;
  const v = user ? user.v : await epoch(env);
  const exp = String(Date.now() + SESSION_SECONDS * 1000);
  const sig = await sessionFor(env, exp, id, v);
  return redirect("/admin", { "Set-Cookie": cookieHeader(`${exp}.${id}.${sig}`, SESSION_SECONDS) });
}

async function status(env) {
  const stored = await env.FEEDBACK.get("status:profiles", "json");
  return stored && Array.isArray(stored.profiles) ? stored : { profiles: [] };
}

// What is still waiting for HermitShell. The queue flag is only set while something is queued, so an empty
// queue costs one read rather than one of the free plan's 1,000 daily list operations.
async function queued(env) {
  if (!(await env.FEEDBACK.get("flag:queue"))) return [];
  const listed = await env.FEEDBACK.list({ prefix: "queue:", limit: 50 });
  return (await Promise.all(listed.keys.map((k) => env.FEEDBACK.get(k.name, "json")))).filter(Boolean);
}

function describe(items) {
  return items.map((i) => i.type === "signup" ? `Sign-up from ${i.name}` : i.type === "unsubscribe"
    ? `Unsubscribe ${i.u || "owner"}` : `${String(i.action || i.type).replaceAll("_", " ")}${i.u ? ` for ${i.u}` : ""}`);
}

// The recruit `u` when the signed-in user may see it, else null. Recruiters are checked against the recruiter
// HermitShell last reported for the recruit.
function visible(s, current, u) {
  const p = (current.profiles || []).find((x) => x.id === u) || null;
  return p && canSee(s.me, p) ? p : null;
}

function allowed(s, current, u) {
  return s.me.admin || Boolean(visible(s, current, u));
}

// Sign-ups still in the queue, shown as pending rows until HermitShell reports the profile it built. HermitShell
// reports the new profile before it takes the sign-up off the queue, and a profile with the same email hides
// its pending row, so a new person never drops off the dashboard in between.
function pendingSignups(items, profiles) {
  const known = new Set(profiles.map((p) => String(p.email || "").toLowerCase()).filter(Boolean));
  return items.filter((i) => i.type === "signup" && !known.has(String(i.email || "").toLowerCase()))
    .map((i) => ({ pending: true, id: "", name: String(i.name || "New sign-up"), email: String(i.email || ""),
      status: "pending", at: Number(i.at) || 0, roles: String(i.roles || ""), recruiter: String(i.recruiter || ""),
      details: { location: String(i.location || "") } }));
}

// A recruiter's view of the queue: only what concerns their own recruits and the people they invited.
function mineOnly(s, current, queue) {
  if (s.me.admin) return queue;
  const mine = new Set((current.profiles || []).filter((p) => canSee(s.me, p)).map((p) => p.id));
  return queue.filter((i) => (i.type === "signup" ? i.recruiter === s.me.id : mine.has(String(i.u || ""))));
}

// One save for a profile's details and job search: only the fields changed since the form opened are queued,
// and a clash with someone else's change shows the page again, with both versions, before anything is saved.
async function saveProfile(env, s, form, u) {
  if (!PROFILE_RE.test(u)) return redirect("/admin?done=profile");
  const [current, queue] = await Promise.all([status(env), queued(env)]);
  const p = (current.profiles || []).find((x) => x.id === u);
  if (!p) return profilePage(current, u, s.csrf);
  const change = profileChange(p, queue, form);
  if (change.conflicts || change.error) {
    return profilePage(current, u, s.csrf, { queue, draft: change.mine, base: change.base, conflicts: change.conflicts || [],
      error: change.conflicts ? "" : DONE[change.error], code: change.conflicts ? 409 : 400 });
  }
  if (!change.item) return redirect(`/admin/profile?u=${u}&done=nochange`);
  await queueItem(env, change.item);
  const kind = change.item.job ? "job" : change.item.details ? "details" : "report_time";
  await record(env, u, kind, `Changed ${listed(change.changed)}`, { by: displayName(s.me, current) });
  return redirect(`/admin/profile?u=${u}&done=saved`);
}

// HermitShell checks in at least every 15 minutes, so a much older check-in means its profiles job has stopped.
const STALE_MS = 45 * 60 * 1000;

function lastUpdate(current, queued, presence, admin) {
  const count = `Waiting for HermitShell: ${queued.length} change${queued.length === 1 ? "" : "s"}`;
  const waiting = !queued.length ? "" : admin ? ` <a href="#tasks">${count}</a>.` : ` ${count}.`;
  const report = current.updated ? ` Recruits last reported ${esc(ago(current.updated))}.` : "";
  if (presence.live) {
    return `<p class="muted"><span class="live" aria-hidden="true"></span><b>HermitShell is connected</b>: changes reach it within seconds.${report}${waiting}</p>`;
  }
  const seen = Math.max(presence.seen, current.updated || 0);
  if (!seen) return `<p class="muted">HermitShell hasn't reported yet.${waiting}</p>`;
  const stale = Date.now() - seen > STALE_MS
    ? `<div class="warn">HermitShell last checked in ${esc(ago(seen))}. Check that HermitShell is running (<code>docker logs hermitshell</code>) and its <b>vacancy-profiles</b> job is scheduled (<code>python3 scheduler.py list</code>).</div>` : "";
  return `${stale}<p class="muted">HermitShell last checked in ${esc(ago(seen))} (${esc(when(seen, current.timezone))}).${waiting}</p>`;
}

function schedule(p) {
  const r = p.report || {};
  if (!r.time) return "";
  return `<div class="muted">${r.days === "weekdays" ? "Weekdays" : "Daily"} at ${esc(r.time)}${r.pending ? " (moving)" : ""}</div>`;
}

// When something happened, with the exact time in a tooltip.
function whenTip(at, tz, prefix, never = "never") {
  if (!at) return `<div class="muted">${esc(prefix)} ${esc(never)}</div>`;
  return `<div class="muted" title="${esc(when(at, tz))}">${esc(prefix)} ${esc(ago(at))}</div>`;
}

const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.3"/><rect x="13.5" y="5" width="4" height="14" rx="1.3"/></svg>';
const RESUME_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.2-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z"/></svg>';

function toggleButton(p, csrf) {
  const [action, label, icon] = p.status === "paused" ? ["resume", "Resume reports", RESUME_ICON] : ["pause", "Pause reports", PAUSE_ICON];
  return `<form method="post" action="/admin/action" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="u" value="${esc(p.id)}"><button class="iconbtn" title="${label}" aria-label="${label} for ${esc(p.name)}">${icon}</button></form>`;
}

const PENDING_STYLE = `
.pill.pending{background:#fff7ed;color:#c2410c}.pill.pending::before{animation:blink .8s ease-in-out infinite alternate}
tr.pendingrow td{background:linear-gradient(90deg,rgba(255,247,237,0),rgba(255,247,237,.7),rgba(255,247,237,0)) 0 0/200% 100%;
animation:sweep 2.4s linear infinite}
tr.pendingrow .avatar{background:linear-gradient(135deg,#fdba74,#fb923c);box-shadow:0 6px 14px -8px rgba(234,88,12,.9)}
@keyframes sweep{to{background-position:-200% 0}}
`;

const RECRUITER_STYLE = `
.avatar.rec{background:linear-gradient(135deg,#2dd4bf,#0891b2);box-shadow:0 6px 14px -8px rgba(8,145,178,.9)}
.avatar.sm{width:30px;height:30px;border-radius:10px;font-size:12px}
table.list .avatar.rec.none{background:#eef0f5;color:#94a3b8;box-shadow:none}
.recpick{display:flex;gap:9px;align-items:center;font-size:13.5px}
form.assign{display:flex;gap:6px;align-items:center;flex-wrap:nowrap}
form.assign select{width:auto;min-width:0;max-width:150px;padding:6px 8px;font-size:13.5px;font-weight:600;border-radius:10px;
border-color:transparent;background:transparent;cursor:pointer}
form.assign select:hover{border-color:var(--line);background:var(--field)}
@supports selector(:has(a)){form.assign button{display:none}form.assign:has(option:checked:not([selected])) button{display:inline-block}}
.rowacts{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:nowrap}
.rowacts button.small{white-space:nowrap}
.iconbtn{margin:0;display:inline-grid;place-items:center;width:34px;height:34px;padding:0;border-radius:10px;
background:var(--soft);color:var(--brand-ink);box-shadow:none}
.iconbtn:hover{background:#e2e5ff;filter:none;box-shadow:none}.iconbtn svg{width:15px;height:15px}
.rowlinks{display:flex;gap:10px;align-items:center;flex-wrap:nowrap;margin-top:8px}
.rowlinks .statpair,.rowlinks .statlink{margin-top:0}
table.recruits th:first-child{width:34%}
@media (max-width:900px){table.recruits .rowacts{justify-content:flex-start;flex-wrap:wrap}}
`;

// The recruiter's initials and a list to pick another; Assign shows once the pick changes (where the browser
// supports :has, otherwise always).
function recruiterCell(p, rec, recs, csrf) {
  if (p.owner) return '<span class="muted">The main admin</span>';
  const r = recs.find((x) => x.id === rec);
  const face = `<span class="avatar rec sm${r ? "" : " none"}" aria-hidden="true">${r ? esc(initials(r.name)) : "?"}</span>`;
  if (p.pending || !recs.length) {
    const add = !p.pending && !recs.length ? ` <a class="small" href="${USERS_URL}">Add a recruiter</a>` : "";
    return `<div class="recpick">${face}<span class="${r ? "" : "muted"}">${r ? esc(r.name) : "Unassigned"}</span>${add}</div>`;
  }
  const options = [["", "Unassigned"], ...recs.map((x) => [x.id, x.name])].map(([id, name]) =>
    `<option value="${esc(id)}"${id === (r ? rec : "") ? " selected" : ""}>${esc(name)}</option>`).join("");
  return `<form method="post" action="/admin/action" class="assign">
<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="assign"><input type="hidden" name="u" value="${esc(p.id)}">
${face}<select name="recruiter" aria-label="Recruiter for ${esc(p.name)}">${options}</select><button class="small">Assign</button></form>`;
}

function pendingRow(p, tz, live, third) {
  const roles = p.roles ? `<div class="muted">looking for ${esc(p.roles.slice(0, 80))}</div>` : "";
  const doing = live ? "HermitShell is reading their CV and setting them up. They show here in full within a few minutes."
    : "HermitShell sets them up as soon as it connects.";
  return `<tr class="pendingrow"><td><div class="who"><span class="avatar" aria-hidden="true">${esc(initials(p.name))}</span><div>
<b>${esc(p.name)}</b><div class="muted">${esc(p.email)}</div>${whenTip(p.at, tz, "Signed up", "just now")}${roles}</div></div></td>
<td><span class="pill pending">pending</span><div class="muted">${doing}</div></td>${third === null ? "" : `<td>${third}</td>`}<td></td></tr>`;
}

function profileRow(p, csrf, tz, stats, { admin, third, inPool }) {
  const status = `<span class="pill${p.owner ? " owner" : p.status === "paused" ? " paused" : ""}">${p.owner ? "owner, " : ""}${esc(p.status)}</span>`
    + (p.scanning ? ' <span class="pill scanning">scanning now</span>' : "");
  const remove = p.owner || !admin ? "" : binButton(`del-${p.id}`, `Delete ${p.name}`);
  const cv = p.has_cv === false ? ' <span class="pill paused">no CV</span>' : "";
  const joined = p.created ? `<div class="muted" title="${esc(when(p.created, tz))}">Joined ${esc(when(p.created, tz).slice(0, 10))}</div>` : "";
  return `<tr${inPool ? ' class="inpool"' : ""}><td><div class="who"><span class="avatar" aria-hidden="true">${esc(initials(p.name))}</span><div>
<b>${esc(p.name)}</b>${cv}<div class="muted">${esc(p.email || "")}</div>${joined}
<div class="rowlinks"><a class="small" href="/admin/profile?u=${esc(p.id)}">Manage</a>${statsLink(p, stats, tz)}</div></div></div></td>
<td>${status}${whenTip(p.last_run, tz, "Last report")}${schedule(p)}</td>
${third === null ? "" : `<td>${third}</td>`}
<td><div class="rowacts">${sendButton(p, csrf, {}, "Send jobs")}${toggleButton(p, csrf)}${remove}</div></td></tr>`;
}

function deleteRecruitModal(p, csrf) {
  return deleteModal({ id: `del-${p.id}`, title: `Delete ${p.name}?`, action: "/admin/action",
    intro: "They stop getting reports and are removed from HermitShell and this dashboard. This can't be undone.",
    fields: { csrf, action: "delete", u: p.id }, check: "Delete their CV and history (jobs found, answers, letters and CVs) from the server" });
}

function inviteForm(s, recs) {
  const assign = s.me.admin && recs.length
    ? `<select name="recruiter" aria-label="Whose recruit they become" style="width:auto;flex:none">${[["", "Nobody's recruit"], ...recs.map((r) => [r.id, `${r.name}'s recruit`])]
      .map(([id, label]) => `<option value="${esc(id)}"${id === (s.me.recruiter ? s.me.id : "") ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>` : "";
  return `<h2>Invite someone</h2>
<form method="post" action="/admin/action" class="inline"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><input type="hidden" name="action" value="invite">
<input name="note" maxlength="80" placeholder="Who it is for (only you see this)">${assign}<button class="small">Create invite link</button></form>
<p class="muted">Each link works once and expires after 7 days.${s.me.admin ? " The person joins the recruiter picked here." : " The person joins your recruits."}</p>`;
}

async function dashboard(request, env, s) {
  const url = new URL(request.url);
  const admin = s.me.admin;
  const [current, invites, queue, presence, held] = await Promise.all([
    status(env), env.FEEDBACK.list({ prefix: "invite:", limit: 100 }), queued(env), hubPresence(env), requests(env)]);
  const recs = recruiters(s.acc, current, env);
  const byId = new Map(recs.map((r) => [r.id, r]));
  const tasks = admin ? tasksButton(taskRows(current, queue, held).length) : "";
  const signups = pendingSignups(queue, current.profiles || []).filter((p) => admin || p.recruiter === s.me.id);
  const mine = mineOnly(s, current, queue);
  const waiting = describe(mine.filter((i) => !signups.some((p) => i.type === "signup" && p.email === String(i.email || ""))));
  const profiles = (current.profiles || []).filter((p) => canSee(s.me, p));
  const stats = await Promise.all(profiles.map((p) => PROFILE_RE.test(p.id || "") ? env.FEEDBACK.get(`stats:${p.id}`, "json") : null));
  const inviteRows = (await Promise.all(invites.keys.map((k) => env.FEEDBACK.get(k.name, "json"))))
    .filter((i) => i && (admin || i.recruiter === s.me.id))
    .map((i) => `<tr><td>${esc(i.note || "No note")}</td>${admin ? `<td class="muted">${i.recruiter && byId.get(i.recruiter)
      ? `joins ${esc(byId.get(i.recruiter).name)}` : "no recruiter"}</td>` : ""}<td class="muted">expires ${esc(when(i.expires, current.timezone))}</td>
<td>${button(s.csrf, "revoke", "Revoke", { invite: i.id })}</td></tr>`).join("");
  const done = DONE[url.searchParams.get("done")];
  const q = searchQuery(url);
  const all = [...profiles.map((p, i) => ({ p, stats: stats[i], rec: admin ? recruiterOf(p, queue) : String(p.recruiter || "") })),
    ...signups.map((p) => ({ p, rec: p.recruiter }))];
  const shown = all.filter(({ p, rec }) => matchesProfile(p, q, byId.get(rec)));
  const hits = admin ? recruiterHits(recs, q, new Set(shown.map((e) => e.rec).filter(Boolean))) : [];
  const row = (e, inPool) => {
    const third = admin ? recruiterCell(e.p, e.rec, recs, s.csrf) : null;
    return e.p.pending ? pendingRow(e.p, current.timezone, presence.live, third)
      : profileRow(e.p, s.csrf, current.timezone, e.stats, { admin, third, inPool });
  };
  const listed = new Set();
  const grouped = hits.map((r) => {
    const theirs = shown.filter((e) => e.rec === r.id);
    theirs.forEach((e) => listed.add(e));
    return recruiterRow(r, all.filter((e) => e.rec === r.id).length) + theirs.map((e) => row(e, true)).join("");
  }).join("");
  const rows = grouped + shown.filter((e) => !listed.has(e)).map((e) => row(e, false)).join("")
    || (all.length ? noMatch(q) : `<tr><td colspan="4" class="muted">${admin ? "HermitShell has not reported any recruits yet."
      : "You have no recruits yet. The people you invite join your recruits, and an admin can assign others to you."}</td></tr>`);
  const deletes = admin ? shown.filter(({ p }) => !p.owner && !p.pending).map(({ p }) => deleteRecruitModal(p, s.csrf)).join("") : "";
  return page("Recruits", `<style>${LINK_STYLE}${MODAL_STYLE}${CONFIRM_STYLE}${SEARCH_STYLE}${PENDING_STYLE}${TASKS_STYLE}${RECRUITER_STYLE}</style>${nav("profiles", admin)}${done ? note(done) : ""}
${lastUpdate(current, waiting, presence, admin)}
${admin ? `${problems(current)}${checklist(current)}` : ""}
${all.length ? searchBar(q, shown.length, all.length, tasks) : tasks ? `<div class="tabletools"><span></span><div class="tools">${tasks}</div></div>` : ""}
<table class="list stack recruits"><tr class="head"><th>Recruit</th><th>Status</th>${admin ? "<th>Recruiter</th>" : ""}<th></th></tr>
${rows}</table>
${inviteForm(s, recs)}
${inviteRows ? `<table class="list">${inviteRows}</table>` : ""}
`,
  { wide: "full", before: (admin ? tasksModal() : "") + passwordModal(s.me, s.csrf, env) + deletes,
    headers: admin ? { "Content-Security-Policy": `${CSP}; frame-src 'self'` } : {} });
}

async function tasksAction(request, env, s) {
  const form = await limitedForm(request, 4096);
  if (!form || !safeEqual(String(form.get("csrf") || ""), s.csrf)) {
    return page("Expired form", "<p>Reload the admin page and try again.</p>", { status: 403 });
  }
  const [current, queue, held] = await Promise.all([status(env), queued(env), requests(env)]);
  const task = String(form.get("task") || "").slice(0, 200);
  const row = taskRows(current, queue, held).find((t) => t.id === task);
  const done = await cancelTask(env, task, current, queue);
  if (row?.u && row.state !== "stopping" && done !== "gone") await record(env, row.u, "cancel", cancelNote(row), { by: displayName(s.me, current) });
  return redirect(`${TASKS_URL}?done=${done}`);
}

// A cancelled task as the recruit's history tells it.
function cancelNote(t) {
  const what = { cover_letter: "cover letter", tailored_cv: "tailored CV", send_job: "job email" }[t.kind];
  if (what) return `Cancelled the ${what}: ${t.title || "a job"}`;
  if (t.kind === "report") return "Stopped the job report";
  if (t.kind === "unsubscribe") return "Cancelled the unsubscribe";
  return `Cancelled: ${t.title || "a change"}`;
}

// Where a letter or CV request from the list of jobs sent comes back to: the same filters, the job opened.
function sentBack(u, back, open, done) {
  const given = new URLSearchParams(String(back || "").slice(0, 60));
  const r = SENT_RANGES[given.get("r")] ? given.get("r") : "7";
  const a = /^[a-z_]{1,20}$/.test(given.get("a") || "") ? `&a=${given.get("a")}` : "";
  return `${SENT_URL}?u=${u}&r=${r}${a}${open ? `&open=${open}` : ""}&done=${done}${open ? `#job-${open}` : ""}`;
}

async function docRequest(request, env, s) {
  const form = await limitedForm(request, 8192);
  if (!form || !safeEqual(String(form.get("csrf") || ""), s.csrf)) {
    return page("Expired form", "<p>Reload the admin page and try again.</p>", { status: 403 });
  }
  const [u, j, kind, title] = ["u", "j", "k", "n"].map((k) => String(form.get(k) || ""));
  if (!PROFILE_RE.test(u)) return page("Unknown recruit", "<p>Reload the admin page and try again.</p>", { status: 400 });
  const current = await status(env);
  const p = visible(s, current, u);
  if (!p && !s.me.admin) return page(...NOT_FOUND);
  if (!p || !validJobKey(j) || !REQUEST_KINDS[kind] || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title)) {
    return redirect(sentBack(u, form.get("back"), "", "docbad"));
  }
  const fresh = form.get("fresh") === "1";
  const send = !fresh && kind !== "send_job" && form.get("send") === "1";
  const h = await requestDoc(env, { profile: u, owner: Boolean(p.owner), j, kind, title, fresh, send });
  const doc = kind === "cover_letter" ? "cover letter" : "tailored CV";
  const asked = kind === "send_job" ? "Emailed the job" : send ? `Emailed the ${doc}` : `Asked for a ${fresh ? "new " : ""}${doc}`;
  await record(env, u, kind, `${asked}: ${title || "a job"}`, { by: displayName(s.me, current) });
  return redirect(sentBack(u, form.get("back"), h.slice(0, 16), kind === "send_job" ? "mail" : send ? "docmail" : "doc"));
}

// A skill missing from the CV, added from the list of jobs sent (admins, and a recruiter for their own pool).
async function skillRequest(request, env, s) {
  const form = await limitedForm(request, 8192);
  if (!form || !safeEqual(String(form.get("csrf") || ""), s.csrf)) {
    return page("Expired form", "<p>Reload the admin page and try again.</p>", { status: 403 });
  }
  const [u, j, given] = ["u", "j", "s"].map((k) => String(form.get(k) || ""));
  if (!PROFILE_RE.test(u)) return page("Unknown recruit", "<p>Reload the admin page and try again.</p>", { status: 400 });
  const current = await status(env);
  const p = visible(s, current, u);
  if (!p && !s.me.admin) return page(...NOT_FOUND);
  const skill = cleanSkill(given);
  if (!p || !validJobKey(j) || !skill || given.length > 120) return redirect(sentBack(u, form.get("back"), "", "skillbad"));
  const h = await requestSkill(env, { profile: u, owner: Boolean(p.owner), j, skill });
  await record(env, u, "skill", `Added the skill ${skill}, missing from the CV`, { by: displayName(s.me, current) });
  return redirect(sentBack(u, form.get("back"), h.slice(0, 16), "skill"));
}

async function docDownload(request, env, s) {
  const url = new URL(request.url);
  const [u, kind, h] = ["u", "k", "h"].map((k) => url.searchParams.get(k) || "");
  if (!PROFILE_RE.test(u)) return text("Not found", 404);
  if (!s.me.admin && !visible(s, await status(env), u)) return text("Not found", 404);
  const doc = await readDoc(env, u, kind, h);
  if (doc) return pdfResponse(doc);
  return redirect(`${SENT_URL}?u=${u}&r=7${/^[0-9a-f]{32}$/.test(h) ? `&open=${h.slice(0, 16)}` : ""}&done=docgone${/^[0-9a-f]{32}$/.test(h) ? `#job-${h.slice(0, 16)}` : ""}`);
}

async function action(request, env, s) {
  const form = await limitedForm(request, MAX_FORM_BYTES);
  if (!form) return text("Request too large", 413);
  if (!safeEqual(String(form.get("csrf") || ""), s.csrf)) return page("Expired form", "<p>Reload the admin page and try again.</p>", { status: 403 });
  const act = String(form.get("action") || "");
  const u = String(form.get("u") || "");
  if (!s.me.admin && !RECRUITER_ACTIONS.has(act)) return page(...ADMINS_ONLY);
  if (["assign", "pause", "resume", "delete", "send_now"].includes(act) && !PROFILE_RE.test(u)) {
    return page("Unknown recruit", "<p>Reload the admin page and try again.</p>", { status: 400 });
  }
  const current = await status(env);
  if (["pause", "resume", "send_now", "profile"].includes(act) && !allowed(s, current, u)) return page(...NOT_FOUND);
  const recs = recruiters(s.acc, current, env);
  if (act === "invite") {
    const chosen = s.me.admin ? String(form.get("recruiter") ?? (s.me.recruiter ? s.me.id : "")) : s.me.id;
    if (chosen && !recs.some((r) => r.id === chosen)) return redirect("/admin?done=badrecruiter");
    const invite = await createInvite(env, form.get("note") || "", chosen);
    const link = `${new URL(request.url).origin}/join?i=${invite.id}`;
    const joins = recs.find((r) => r.id === chosen);
    return page("Invite link", `<p>Send this link to ${esc(invite.note || "the person")}. It works once and expires on ${esc(when(invite.expires, current.timezone))}.${joins
      ? ` They join ${chosen === s.me.id ? "your" : `${esc(joins.name)}'s`} recruits.` : ""}</p>
<code class="link">${esc(link)}</code><p><a href="/admin">Back to recruits</a></p>`);
  }
  if (act === "revoke") {
    const id = String(form.get("invite") || "").replace(/[^0-9a-f]/g, "");
    const invite = id ? await env.FEEDBACK.get(`invite:${id}`, "json") : null;
    if (invite && (s.me.admin || invite.recruiter === s.me.id)) await env.FEEDBACK.delete(`invite:${id}`);
    return redirect("/admin?done=revoked");
  }
  if (act === "profile") return saveProfile(env, s, form, u);
  const by = { by: displayName(s.me, current) };
  if (act === "send_now") {
    await queueItem(env, { type: "admin", action: act, u });
    await record(env, u, "send", "Asked for jobs now", by);
    return redirect(form.get("back") === "profile" ? `/admin/profile?u=${u}&done=sending` : "/admin?done=sending");
  }
  if (act === "assign") {
    const recruiter = String(form.get("recruiter") || "");
    const p = (current.profiles || []).find((x) => x.id === u);
    if (!p || p.owner || (recruiter && !recs.some((r) => r.id === recruiter))) return redirect("/admin?done=badrecruiter");
    await queueItem(env, { type: "admin", action: "assign", u, recruiter });
    const to = recs.find((r) => r.id === recruiter);
    await record(env, u, "assign", to ? `Assigned to ${to.name}` : "Unassigned from their recruiter", by);
    return redirect("/admin?done=assigned");
  }
  const setting = settingsItem(act, form);
  if (setting) {
    const back = `${SETTINGS_URL}?done=`;
    const anchor = act.startsWith("api_key") ? "#keys" : act.startsWith("model_") ? "#models" : "#email";
    if (setting.error) return redirect(`${back}${setting.error}${anchor}`);
    let item = setting.item;
    if (needsSeal(item)) {
      const info = sealInfo(current);
      if (!info) return redirect(`${back}nokey${anchor}`);
      item = await sealItem(info, item);
    }
    await queueItem(env, item, setting.ttl);
    return redirect(`${back}queued${anchor}`);
  }
  if (act === "delete") {
    if (form.get("confirm") !== "yes") return redirect("/admin?done=confirm");
    await queueItem(env, { type: "admin", action: act, u });
    await purgeProfileEvents(env, u);
  } else if (["pause", "resume"].includes(act)) {
    await queueItem(env, { type: "admin", action: act, u });
    await record(env, u, act, act === "pause" ? "Paused reports" : "Resumed reports", by);
  } else {
    return page("Unknown action", "<p>Reload the admin page and try again.</p>", { status: 400 });
  }
  return redirect("/admin?done=queued");
}

// A new password changes the user's session version, which signs out their other sessions; this one gets a
// cookie signed with the new version and the same expiry.
async function passwordRequest(request, env, s) {
  const form = await limitedForm(request, 4096);
  if (!form || !safeEqual(String(form.get("csrf") || ""), s.csrf)) {
    return page("Expired form", "<p>Reload the admin page and try again.</p>", { status: 403 });
  }
  const { done, v } = await changeOwnPassword(env, form, s.me);
  if (!v) return redirect(`/admin?done=${done}#password`);
  const sig = await sessionFor(env, s.exp, s.me.id, v);
  const left = Math.max(1, Math.floor((Number(s.exp) - Date.now()) / 1000));
  return redirect(`/admin?done=${done}`, { "Set-Cookie": cookieHeader(`${s.exp}.${s.me.id}.${sig}`, left) });
}

async function usersRequest(request, env, s) {
  if (!s.me.admin) return page(...ADMINS_ONLY);
  if (request.method === "POST") {
    const form = await limitedForm(request, 8192);
    if (!form || !safeEqual(String(form.get("csrf") || ""), s.csrf)) {
      return page("Expired form", "<p>Reload the admin page and try again.</p>", { status: 403 });
    }
    const [current, queue] = await Promise.all([status(env), queued(env)]);
    return userAction(env, form, s.me, current, queue);
  }
  const current = await status(env);
  return usersPage(s.acc, current, s.csrf, s.me, env, USERS_DONE[new URL(request.url).searchParams.get("done")] || "");
}

export async function handleAdmin(request, env, ctx) {
  if (!env.ADMIN_PASSWORD || !env.JOB_FEEDBACK_SECRET) return text("Not found", 404);
  if (env.ACCESS_AUD && !(await accessUser(request, env, ctx))) {
    return page("Sign-in required", "<p>This page is protected by Cloudflare Access. Open it again to sign in with your email.</p>", { status: 403 });
  }
  const path = new URL(request.url).pathname;
  if (path === "/admin/login" && request.method === "POST") return login(request, env);
  const s = await session(request, env);
  if (path === "/admin/logout" && request.method === "POST") {
    if (s?.me.main) await env.FEEDBACK.put("admin:epoch", String(Date.now()));
    else if (s) await signOutUser(env, s.me.id);
    return redirect("/admin", { "Set-Cookie": cookieHeader("", 0) });
  }
  if (!s) return loginPage();
  // The switch and each user's own password are real whether or not demo mode is on.
  if (path === DEMO_URL && request.method === "POST") return demoToggle(request, env, s);
  if (path === PASSWORD_URL && request.method === "POST") return passwordRequest(request, env, s);
  const demo = await demoMode(env);
  if (!demo) return withSignedIn(await signedInRoute(request, env, s, path), env, s, path, request.method);
  const pretend = await demoEnv(env);
  const seen = { ...s, acc: await accounts(pretend), demo };
  return withSignedIn(await signedInRoute(request, pretend, seen, path), pretend, seen, path, request.method);
}

const LOGOUT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14"/><path d="M10 16.5 5.5 12 10 7.5M5.5 12H15"/></svg>';
// Wide screens keep it fixed like the Back button; narrower ones let it scroll away, and phones put it in
// the flow above the card. The card's 56px top margin collapses into the body, which the absolute box is
// placed against, hence the negative top. Full-width cards reach the corner sooner, so they get the compact box
// up to 1860px, where the card stops growing and leaves room beside it.
const ME_STYLE = `
.me{position:fixed;top:20px;right:20px;z-index:10;display:flex;flex-direction:column;align-items:flex-end;gap:8px;animation:drop .45s var(--ease) both}
.mecard{display:flex;align-items:center;gap:10px;padding:6px 14px 6px 6px;background:rgba(255,255,255,.92);border:1px solid var(--line);
border-radius:14px;box-shadow:0 8px 24px -12px rgba(15,23,42,.25)}
.mecard .avatar{width:34px;height:34px;border-radius:11px;font-size:13px}
.mecard .avatar.rec{background:linear-gradient(135deg,#2dd4bf,#0891b2);box-shadow:0 6px 14px -8px rgba(8,145,178,.9)}
.mename{display:flex;flex-direction:column;line-height:1.25}.mename b{font-size:13.5px;color:var(--ink)}
.mename small{font-size:11.5px;color:var(--muted);font-weight:600}
.mebtns{display:flex;gap:6px}.mebtns form{margin:0}
.mebtn{margin:0;display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 13px;border-radius:12px;font:inherit;font-size:13.5px;
font-weight:650;color:var(--brand-ink);text-decoration:none;background:rgba(255,255,255,.92);border:1px solid var(--line);
box-shadow:0 8px 24px -12px rgba(15,23,42,.25);cursor:pointer;transition:transform .18s var(--ease),box-shadow .18s,background .18s}
.mebtn:hover{transform:translateY(-1px);background:#fff;filter:none;box-shadow:0 12px 28px -12px rgba(15,23,42,.3)}
a.mebtn{width:34px;padding:0;justify-content:center}.mebtn svg{flex:none;width:16px;height:16px}
@media (max-width:1360px){.me{position:absolute;top:-46px;right:10px;flex-direction:row;align-items:center}
.mecard{padding:3px}.mename{display:none}.mecard .avatar{width:30px;height:30px;border-radius:10px;font-size:12px}}
@media (max-width:1860px){body:has(main.full) .me{position:absolute;top:-46px;right:10px;flex-direction:row;align-items:center}
body:has(main.full) .mecard{padding:3px}body:has(main.full) .mename{display:none}
body:has(main.full) .mecard .avatar{width:30px;height:30px;border-radius:10px;font-size:12px}}
@media (max-width:560px){.me,body:has(main.full) .me{position:static;justify-content:flex-end;margin:12px 16px 0}}
`;

// The signed-in user's initials, name and roles, with Change password and Sign out; admins also get the server
// button, whose panel shows the machine and the models.
function signedInBox(s, current) {
  const name = displayName(s.me, current);
  const roles = s.me.roles.map((r) => ROLES[r].label).join(", ");
  const label = `Signed in as ${name} (${roles.toLowerCase()})`;
  return `<style>${ME_STYLE}${s.me.admin ? SERVER_STYLE : ""}</style><div class="me" role="region" aria-label="${esc(label)}">
<div class="mecard" title="${esc(label)}"><span class="avatar${s.me.admin ? "" : " rec"}" aria-hidden="true">${esc(initials(name))}</span><span class="mename"><b>${esc(name)}</b><small>${esc(roles)}</small></span></div>
<div class="mebtns">${s.me.admin ? serverBox(current) : ""}<a class="mebtn" href="/admin#password" title="Change password" aria-label="Change password">${KEY_ICON}</a><form method="post" action="/admin/logout"><button class="mebtn">${LOGOUT_ICON}Sign out</button></form></div></div>`;
}

// Every signed-in page gets the box, except those shown inside another page (the Tasks window, save status).
async function withSignedIn(res, env, s, path, method) {
  if (method === "GET" && [TASKS_URL, STATUS_URL].includes(path)) return res;
  if (!(res.headers.get("Content-Type") || "").startsWith("text/html")) return res;
  const [html, current] = await Promise.all([res.text(), status(env)]);
  const ribbon = s.demo ? demoRibbon(s.me.admin) : "";
  return new Response(html.replace("<body>", () => `<body>${signedInBox(s, current)}${ribbon}`), { status: res.status, headers: res.headers });
}

async function signedInRoute(request, env, s, path) {
  if (path === "/admin" && request.method === "GET") return dashboard(request, env, s);
  if (path === "/admin/action" && request.method === "POST") return action(request, env, s);
  if (path === "/admin/cv" && request.method === "POST") {
    return cvUpload(request, env, s, async (u) => allowed(s, await status(env), u),
      async (u, what) => record(env, u, "cv", what, { by: displayName(s.me, await status(env)) }));
  }
  if (path === USERS_URL && ["GET", "POST"].includes(request.method)) return usersRequest(request, env, s);
  if (path === TASKS_URL && !s.me.admin) return page(...ADMINS_ONLY);
  if (path === TASKS_URL && request.method === "POST") return tasksAction(request, env, s);
  if (path === TASKS_URL && request.method === "GET") {
    const url = new URL(request.url);
    const [current, queue, held] = await Promise.all([status(env), queued(env), requests(env)]);
    return tasksPage(taskRows(current, queue, held), s.csrf, current.timezone,
      Math.min(Math.max(Math.trunc(Number(url.searchParams.get("n"))) || 0, 0), 99), url.searchParams.get("done") || "");
  }
  if (path === SETTINGS_URL && request.method === "GET") {
    if (!s.me.admin) return page(...ADMINS_ONLY);
    const url = new URL(request.url);
    const [current, queue] = await Promise.all([status(env), queued(env)]);
    return settingsPage(current, s.csrf, { done: DONE[url.searchParams.get("done")] || "", queued: describe(queue), queue,
      demo: demoSection(s.demo, s.csrf, current.timezone) });
  }
  const url = new URL(request.url);
  const u = url.searchParams.get("u") || "";
  if (path === "/admin/profile" && request.method === "GET") {
    const [current, queue] = await Promise.all([status(env), queued(env)]);
    if (!allowed(s, current, u)) return page(...NOT_FOUND);
    const done = url.searchParams.get("done");
    return profilePage(current, u, s.csrf,
      { done: DONE[done] || "", queue, saving: ["saved", "cvqueued", "sending"].includes(done) });
  }
  if (path === HISTORY_URL && request.method === "GET") {
    if (!PROFILE_RE.test(u)) return text("Not found", 404);
    const current = await status(env);
    if (!allowed(s, current, u)) return page(...NOT_FOUND);
    return historyPage(env, current, u, url.searchParams.get("m") || "");
  }
  if (path === STATS_URL && request.method === "GET") {
    if (!PROFILE_RE.test(u)) return text("Not found", 404);
    const [current, stats] = await Promise.all([status(env), env.FEEDBACK.get(`stats:${u}`, "json")]);
    if (!allowed(s, current, u)) return page(...NOT_FOUND);
    return statsPage(current, stats, u, url.searchParams.get("r"));
  }
  if (path === SENT_URL && request.method === "GET") {
    if (!PROFILE_RE.test(u)) return text("Not found", 404);
    const current = await status(env);
    if (!allowed(s, current, u)) return page(...NOT_FOUND);
    const [stats, sent, docs, emailed, held, added] = await Promise.all([env.FEEDBACK.get(`stats:${u}`, "json"),
      env.FEEDBACK.get(`sent:${u}`, "json"), docIndex(env, u), emailedIndex(env, u), requests(env), addedSkills(env, u)]);
    const owner = Boolean((current.profiles || []).find((x) => x.id === u)?.owner);
    const q = (k) => url.searchParams.get(k) || "";
    return sentPage(current, stats, u, { range: q("r"), answer: q("a"), open: q("open"), done: q("done"), csrf: s.csrf,
      sent: Array.isArray(sent) ? sent : null, docs, emailed, pending: pendingDocs(current, held, u, owner), added });
  }
  if (path === DOC_URL && request.method === "GET") return docDownload(request, env, s);
  if (path === DOC_URL && request.method === "POST") return docRequest(request, env, s);
  if (path === SKILL_URL && request.method === "POST") return skillRequest(request, env, s);
  if (path === STATUS_URL && request.method === "GET") {
    if (!PROFILE_RE.test(u)) return text("Not found", 404);
    const [current, queue] = await Promise.all([status(env), queued(env)]);
    if (!allowed(s, current, u)) return text("Not found", 404);
    return saveStatus(current, u, queue, Math.min(Math.max(Math.trunc(Number(url.searchParams.get("n"))) || 0, 0), 99));
  }
  return text("Not found", 404);
}

export async function handleApi(request, env) {
  if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
  const url = new URL(request.url);
  if (url.pathname === "/api/queue" && request.method === "GET") {
    return json({ items: await listFlagged(env, request, "queue:", "flag:queue", 100) });
  }
  // HermitShell's live link (hub.js): a WebSocket that is told the moment anything is queued.
  if (url.pathname === "/api/live" && request.method === "GET") {
    return (await hubConnect(request, env)) || json({ error: "no live link" }, 404);
  }
  // Polled by profiles.py when it has no live link: one KV read, and a new value whenever something is queued.
  if (url.pathname === "/api/queue/flag" && request.method === "GET") {
    const [flag] = await Promise.all([env.FEEDBACK.get("flag:queue"), hubSeen(env)]);
    return json({ flag: flag || "" });
  }
  if (url.pathname === "/api/file" && request.method === "GET") {
    const key = url.searchParams.get("k") || "";
    const bytes = /^cvfile:[0-9a-f]{32}$/.test(key) ? await env.FEEDBACK.get(key, "arrayBuffer") : null;
    return bytes ? new Response(bytes, { headers: { "Content-Type": "application/octet-stream", ...SECURITY_HEADERS } })
      : json({ error: "not found" }, 404);
  }
  if (url.pathname === "/api/queue/ack" && request.method === "POST") {
    const body = (await limitedJson(request, 100000)) || {};
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id) => typeof id === "string" && id.startsWith("queue:")).slice(0, 100);
    const items = await Promise.all(ids.map((id) => env.FEEDBACK.get(id, "json")));
    await Promise.all(items.filter((item) => item?.cv?.key).map((item) => env.FEEDBACK.delete(item.cv.key)));
    await deleteAndUnflag(env, ids, "queue:", "flag:queue");
    return json({ deleted: ids.length });
  }
  if (url.pathname === "/api/status" && request.method === "POST") {
    const status = await limitedJson(request, 200000);
    if (status === null) return json({ error: "too large" }, 413);
    if (!status || typeof status !== "object" || Array.isArray(status) || (status.profiles && !Array.isArray(status.profiles))) {
      return json({ error: "invalid status" }, 400);
    }
    const before = await env.FEEDBACK.get("status:profiles", "json");
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ ...status, updated: Date.now() }));
    await recordReported(env, before, status);
    return json({ saved: true });
  }
  // One profile's stats page numbers (profile_stats.py), or null to remove them.
  if (url.pathname === "/api/stats" && request.method === "POST") {
    const body = await limitedJson(request, MAX_STATS_BYTES);
    if (body === null) return json({ error: "too large" }, 413);
    const u = typeof body?.u === "string" ? body.u : "";
    if (!PROFILE_RE.test(u)) return json({ error: "bad profile" }, 400);
    if (body.stats === null) {
      await Promise.all([env.FEEDBACK.delete(`stats:${u}`), env.FEEDBACK.delete(`sent:${u}`)]);
      return json({ deleted: true });
    }
    if (!validStats(body.stats)) return json({ error: "invalid stats" }, 400);
    const { stats, sent } = splitStats(body.stats);
    await Promise.all([env.FEEDBACK.put(`stats:${u}`, JSON.stringify({ ...stats, updated: Date.now() })),
      env.FEEDBACK.put(`sent:${u}`, JSON.stringify(sent))]);
    return json({ saved: true });
  }
  // A cover letter or tailored CV HermitShell has made, kept encrypted for download (docs.js).
  if (url.pathname === "/api/doc" && request.method === "POST") return storeDoc(request, env);
  // A job emailed to its profile from the list of jobs sent (job_mail.py), for its "Emailed" mark there.
  if (url.pathname === "/api/emailed" && request.method === "POST") return markEmailed(request, env);
  if (url.pathname === "/api/invite" && request.method === "POST") {
    const body = (await limitedJson(request, 10000)) || {};
    const invite = await createInvite(env, body.note || "");
    return json({ link: `${url.origin}/join?i=${invite.id}`, expires: invite.expires });
  }
  return json({ error: "not found" }, 404);
}

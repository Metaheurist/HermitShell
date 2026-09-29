// Admin gateway (/admin) and the HermitShell API (/api/*).
//
// /admin: when ACCESS_AUD is set, Cloudflare Access (email one-time code) must let the request through
// first. Then sign in as the main admin (ADMIN_USER, default "admin", and the ADMIN_PASSWORD secret) or as a
// dashboard user made on the Users and roles page (users.js). Five wrong attempts lock that address, and 30 from
// anywhere lock sign-in, for 15 minutes. Admins see every recruit; a recruiter sees only their own pool, and every
// route below checks that, not just the links on the page. Signed-in pages create invite links, show the recruits
// HermitShell reports, and queue changes that HermitShell applies as soon as the live link tells it (settings pages:
// settings.js; each recruit's stats page: stats.js; web search keys: keys.js; recruit search: search.js; the task
// list: tasks.js; the live link: hub.js). Nothing here can reach the HermitShell server: HermitShell connects out to
// /api/live and reads /api/queue with its API token.

import { hubConnect, hubPresence, hubSeen } from "./hub.js";
import { createInvite, queueItem } from "./join.js";
import {
  CSP, SECURITY_HEADERS, accessUser, ago, authorised, deleteAndUnflag, esc, hmacHex, json, limitedForm, limitedJson, listFlagged,
  purgeProfileEvents,
  note, page, redirect, safeEqual, secretEqual, text, when,
} from "./lib.js";
import {
  SETTINGS_DONE, SETTINGS_URL, STATUS_URL, USERS_URL, button, checklist, cvUpload, nav, problems, profileChange, profilePage, saveStatus,
  sendButton, settingsItem, settingsPage,
} from "./settings.js";
import { CONFIRM_STYLE, binButton, deleteModal } from "./confirm.js";
import { MODAL_STYLE } from "./keys.js";
import { SEARCH_STYLE, matchesProfile, noMatch, recruiterHits, recruiterRow, searchBar, searchQuery } from "./search.js";
import {
  DOC_URL, REQUEST_KINDS, docIndex, emailedIndex, markEmailed, pdfResponse, pendingDocs, readDoc, requestDoc, storeDoc, validJobKey,
} from "./docs.js";
import { LINK_STYLE, MAX_STATS_BYTES, SENT_RANGES, SENT_URL, STATS_URL, sentPage, splitStats, statsLink, statsPage, validStats } from "./stats.js";
import { TASKS_STYLE, TASKS_URL, cancelTask, requests, taskRows, tasksButton, tasksModal, tasksPage } from "./tasks.js";
import {
  ADMIN_ID, ROLES, USERS_DONE, USERS_STYLE, USER_RE, accounts, canSee, checkUser, displayName, initials, recruiterOf, recruiters,
  signOutUser, signedIn, userAction, usersPage,
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
  ...SETTINGS_DONE,
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

function tasksFor(s, current, queue, held) {
  const rows = taskRows(current, queue, held);
  if (s.me.admin) return rows;
  const mine = new Set((current.profiles || []).filter((p) => canSee(s.me, p)).map((p) => p.id));
  return rows.filter((r) => (r.kind === "signup" ? r.recruiter === s.me.id : mine.has(r.u)));
}

// One save for a profile's details and job search: only the fields changed since the form opened are queued,
// and a clash with someone else's change shows the page again, with both versions, before anything is saved.
async function saveProfile(env, s, form, u) {
  if (!PROFILE_RE.test(u)) return redirect("/admin?done=profile");
  const [current, queue] = await Promise.all([status(env), queued(env)]);
  const p = (current.profiles || []).find((x) => x.id === u);
  if (!p) return profilePage(current, u, s.csrf, { admin: s.me.admin });
  const change = profileChange(p, queue, form);
  if (change.conflicts || change.error) {
    return profilePage(current, u, s.csrf, { queue, draft: change.mine, base: change.base, conflicts: change.conflicts || [],
      error: change.conflicts ? "" : DONE[change.error], code: change.conflicts ? 409 : 400, admin: s.me.admin });
  }
  if (!change.item) return redirect(`/admin/profile?u=${u}&done=nochange`);
  await queueItem(env, change.item);
  return redirect(`/admin/profile?u=${u}&done=saved`);
}

// HermitShell checks in at least every 15 minutes, so a much older check-in means its profiles job has stopped.
const STALE_MS = 45 * 60 * 1000;

function lastUpdate(current, queued, presence) {
  const waiting = queued.length
    ? ` <a href="#tasks">Waiting for HermitShell: ${queued.length} change${queued.length === 1 ? "" : "s"}</a>.` : "";
  const report = current.updated ? ` Recruits last reported ${esc(ago(current.updated))}.` : "";
  if (presence.live) {
    return `<p class="muted"><span class="live" aria-hidden="true"></span><b>HermitShell is connected</b>: changes reach it within seconds.${report}${waiting}</p>`;
  }
  const seen = Math.max(presence.seen, current.updated || 0);
  if (!seen) return `<p class="muted">HermitShell hasn't reported yet.${waiting}</p>`;
  const stale = Date.now() - seen > STALE_MS
    ? `<div class="warn">HermitShell last checked in ${esc(ago(seen))}. Check that its <b>vacancy-profiles</b> job is running (<code>hermes cron list</code>).</div>` : "";
  return `${stale}<p class="muted">HermitShell last checked in ${esc(ago(seen))} (${esc(when(seen, current.timezone))}).${waiting}</p>`;
}

function schedule(p) {
  const r = p.report || {};
  if (!r.time) return "";
  return `<div class="muted">daily report ${esc(r.time)}${r.days === "weekdays" ? " on weekdays" : ""}${r.pending ? " (moving)" : ""}</div>`;
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
.reccell .who{align-items:center;gap:9px}.reccell b{font-size:13.5px}
form.assign{display:flex;gap:6px;align-items:center;margin-top:8px}
form.assign select{width:auto;min-width:0;max-width:150px;padding:6px 30px 6px 10px;font-size:13px;height:auto}
.whoami{display:flex;align-items:center;gap:10px;margin-top:32px}.whoami .signout{margin:0 0 0 auto}
`;

function recruiterCell(p, rec, recs, csrf) {
  if (p.owner) return '<span class="muted">The main admin</span>';
  const r = recs.find((x) => x.id === rec);
  const current = r ? `<div class="who"><span class="avatar rec sm" aria-hidden="true">${esc(initials(r.name))}</span><div><b>${esc(r.name)}</b>
<div class="muted"><code>${esc(r.username)}</code></div></div></div>` : '<span class="muted">Unassigned</span>';
  if (p.pending) return current;
  if (!recs.length) return `${current}<div class="muted"><a href="${USERS_URL}">Add a recruiter</a></div>`;
  const options = [["", "Unassigned"], ...recs.map((x) => [x.id, x.name])].map(([id, name]) =>
    `<option value="${esc(id)}"${id === (r ? rec : "") ? " selected" : ""}>${esc(name)}</option>`).join("");
  return `<div class="reccell">${current}</div><form method="post" action="/admin/action" class="assign">
<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="assign"><input type="hidden" name="u" value="${esc(p.id)}">
<select name="recruiter" aria-label="Recruiter for ${esc(p.name)}">${options}</select><button class="small quiet">Assign</button></form>`;
}

function pendingRow(p, tz, live, third) {
  const roles = p.roles ? `<div class="muted">looking for ${esc(p.roles.slice(0, 80))}</div>` : "";
  const doing = live ? "HermitShell is reading their CV and setting them up. They show here in full within a few minutes."
    : "HermitShell sets them up as soon as it connects.";
  return `<tr class="pendingrow"><td><div class="who"><span class="avatar" aria-hidden="true">${esc(initials(p.name))}</span><div>
<b>${esc(p.name)}</b><div class="muted">${esc(p.email)}</div><div class="muted">signed up ${esc(p.at ? `${ago(p.at)} (${when(p.at, tz)})` : "just now")}</div>${roles}</div></div></td>
<td><span class="pill pending">pending</span><div class="muted">${doing}</div></td>${third === null ? "" : `<td>${third}</td>`}<td></td></tr>`;
}

function profileRow(p, csrf, tz, stats, { admin, third, inPool }) {
  const status = `<span class="pill${p.owner ? " owner" : p.status === "paused" ? " paused" : ""}">${p.owner ? "owner, " : ""}${esc(p.status)}</span>`
    + (p.scanning ? ' <span class="pill scanning">scanning now</span>' : "");
  const toggle = p.status === "paused" ? button(csrf, "resume", "Resume", { u: p.id }) : button(csrf, "pause", "Pause", { u: p.id });
  const remove = p.owner || !admin ? "" : binButton(`del-${p.id}`, `Delete ${p.name}`);
  const cv = p.has_cv === false ? ' <span class="pill paused">no CV</span>' : "";
  return `<tr${inPool ? ' class="inpool"' : ""}><td><div class="who"><span class="avatar" aria-hidden="true">${esc(initials(p.name))}</span><div>
<b>${esc(p.name)}</b>${cv}<div class="muted">${esc(p.email || "")}</div><div class="muted">since ${esc(when(p.created, tz))}</div>
<a class="small" href="/admin/profile?u=${esc(p.id)}">Manage</a><div>${statsLink(p, stats, tz)}</div></div></div></td>
<td>${status}<div class="muted">last report ${esc(p.last_run ? `${ago(p.last_run)} (${when(p.last_run, tz)})` : "never")}</div>${schedule(p)}</td>
${third === null ? "" : `<td>${third}</td>`}
<td><div class="actions">${sendButton(p, csrf)}${toggle}${remove}</div></td></tr>`;
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
  const tasks = tasksButton(tasksFor(s, current, queue, held).length);
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
  const who = `${esc(displayName(s.me, current))} (${s.me.roles.map((r) => ROLES[r].label.toLowerCase()).join(", ")})`;
  const deletes = admin ? shown.filter(({ p }) => !p.owner && !p.pending).map(({ p }) => deleteRecruitModal(p, s.csrf)).join("") : "";
  return page("Recruits", `<style>${LINK_STYLE}${MODAL_STYLE}${CONFIRM_STYLE}${SEARCH_STYLE}${PENDING_STYLE}${TASKS_STYLE}${RECRUITER_STYLE}</style>${nav("profiles", admin)}${done ? note(done) : ""}
${lastUpdate(current, waiting, presence)}
${admin ? `${problems(current)}${checklist(current)}` : ""}
${all.length ? searchBar(q, shown.length, all.length, tasks) : `<div class="tabletools"><span></span><div class="tools">${tasks}</div></div>`}
<table class="list"><tr><th>Recruit</th><th>Status</th>${admin ? "<th>Recruiter</th>" : ""}<th></th></tr>
${rows}</table>
${admin ? `<p class="muted">The email server and web search keys everyone shares are under <a href="${SETTINGS_URL}">Global settings</a>; dashboard users and recruiters under <a href="${USERS_URL}">Users and roles</a>.</p>` : ""}
${inviteForm(s, recs)}
${inviteRows ? `<table class="list">${inviteRows}</table>` : ""}
<div class="whoami"><span class="muted">Signed in as <b>${who}</b></span><form method="post" action="/admin/logout" class="signout"><button class="small quiet">Sign out</button></form></div>`,
  { wide: true, before: tasksModal() + deletes, headers: { "Content-Security-Policy": `${CSP}; frame-src 'self'` } });
}

async function tasksAction(request, env, s) {
  const form = await limitedForm(request, 4096);
  if (!form || !safeEqual(String(form.get("csrf") || ""), s.csrf)) {
    return page("Expired form", "<p>Reload the admin page and try again.</p>", { status: 403 });
  }
  const [current, queue, held] = await Promise.all([status(env), queued(env), requests(env)]);
  const task = String(form.get("task") || "").slice(0, 200);
  if (!s.me.admin && !tasksFor(s, current, queue, held).some((r) => r.id === task)) return redirect(`${TASKS_URL}?done=gone`);
  const done = await cancelTask(env, task, current, queue);
  return redirect(`${TASKS_URL}?done=${done}`);
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
  const h = await requestDoc(env, { profile: u, owner: Boolean(p.owner), j, kind, title, fresh: form.get("fresh") === "1" });
  return redirect(sentBack(u, form.get("back"), h.slice(0, 16), kind === "send_job" ? "mail" : "doc"));
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
  if (act === "send_now") {
    await queueItem(env, { type: "admin", action: act, u });
    return redirect(form.get("back") === "profile" ? `/admin/profile?u=${u}&done=sending` : "/admin?done=sending");
  }
  if (act === "assign") {
    const recruiter = String(form.get("recruiter") || "");
    const p = (current.profiles || []).find((x) => x.id === u);
    if (!p || p.owner || (recruiter && !recs.some((r) => r.id === recruiter))) return redirect("/admin?done=badrecruiter");
    await queueItem(env, { type: "admin", action: "assign", u, recruiter });
    return redirect("/admin?done=assigned");
  }
  const setting = settingsItem(act, form);
  if (setting) {
    const back = `${SETTINGS_URL}?done=`;
    const anchor = act.startsWith("api_key") ? "#keys" : "#email";
    if (setting.error) return redirect(`${back}${setting.error}${anchor}`);
    await queueItem(env, setting.item, setting.ttl);
    return redirect(`${back}queued${anchor}`);
  }
  if (act === "delete") {
    if (form.get("confirm") !== "yes") return redirect("/admin?done=confirm");
    await queueItem(env, { type: "admin", action: act, u });
    await purgeProfileEvents(env, u);
  } else if (["pause", "resume"].includes(act)) {
    await queueItem(env, { type: "admin", action: act, u });
  } else {
    return page("Unknown action", "<p>Reload the admin page and try again.</p>", { status: 400 });
  }
  return redirect("/admin?done=queued");
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
  if (path === "/admin" && request.method === "GET") return dashboard(request, env, s);
  if (path === "/admin/action" && request.method === "POST") return action(request, env, s);
  if (path === "/admin/cv" && request.method === "POST") {
    return cvUpload(request, env, s, async (u) => allowed(s, await status(env), u));
  }
  if (path === USERS_URL && ["GET", "POST"].includes(request.method)) return usersRequest(request, env, s);
  if (path === TASKS_URL && request.method === "POST") return tasksAction(request, env, s);
  if (path === TASKS_URL && request.method === "GET") {
    const url = new URL(request.url);
    const [current, queue, held] = await Promise.all([status(env), queued(env), requests(env)]);
    return tasksPage(tasksFor(s, current, queue, held), s.csrf, current.timezone,
      Math.min(Math.max(Math.trunc(Number(url.searchParams.get("n"))) || 0, 0), 99), url.searchParams.get("done") || "");
  }
  if (path === SETTINGS_URL && request.method === "GET") {
    if (!s.me.admin) return page(...ADMINS_ONLY);
    const url = new URL(request.url);
    const [current, queue] = await Promise.all([status(env), queued(env)]);
    return settingsPage(current, s.csrf, { done: DONE[url.searchParams.get("done")] || "", queued: describe(queue), queue });
  }
  const url = new URL(request.url);
  const u = url.searchParams.get("u") || "";
  if (path === "/admin/profile" && request.method === "GET") {
    const [current, queue] = await Promise.all([status(env), queued(env)]);
    if (!allowed(s, current, u)) return page(...NOT_FOUND);
    const done = url.searchParams.get("done");
    return profilePage(current, u, s.csrf,
      { done: DONE[done] || "", queue, saving: ["saved", "cvqueued", "sending"].includes(done), admin: s.me.admin });
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
    const [stats, sent, docs, emailed, held] = await Promise.all([env.FEEDBACK.get(`stats:${u}`, "json"),
      env.FEEDBACK.get(`sent:${u}`, "json"), docIndex(env, u), emailedIndex(env, u), requests(env)]);
    const owner = Boolean((current.profiles || []).find((x) => x.id === u)?.owner);
    const q = (k) => url.searchParams.get(k) || "";
    return sentPage(current, stats, u, { range: q("r"), answer: q("a"), open: q("open"), done: q("done"), csrf: s.csrf,
      sent: Array.isArray(sent) ? sent : null, docs, emailed, pending: pendingDocs(current, held, u, owner) });
  }
  if (path === DOC_URL && request.method === "GET") return docDownload(request, env, s);
  if (path === DOC_URL && request.method === "POST") return docRequest(request, env, s);
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
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ ...status, updated: Date.now() }));
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

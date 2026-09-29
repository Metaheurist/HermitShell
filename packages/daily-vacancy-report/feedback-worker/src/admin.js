// Admin gateway (/admin) and the HermitShell API (/api/*).
//
// /admin: when ACCESS_AUD is set, Cloudflare Access (email one-time code) must let the request through
// first. Then sign in with ADMIN_USER (default "admin") and the ADMIN_PASSWORD secret; five wrong attempts
// lock that address, and 30 from anywhere lock sign-in, for 15 minutes. Signed-in pages create invite
// links, show the profiles HermitShell reports, and queue changes that HermitShell applies as soon as the live
// link tells it (settings pages: settings.js; each profile's stats page: stats.js; crawler keys: keys.js; profile search: search.js; the task list: tasks.js; the live link: hub.js). Nothing here can reach the HermitShell
// server: HermitShell connects out to /api/live and reads /api/queue with its API token.

import { hubConnect, hubPresence, hubSeen } from "./hub.js";
import { SECRET_TTL_SECONDS, createInvite, queueItem } from "./join.js";
import {
  CSP, SECURITY_HEADERS, accessUser, ago, authorised, deleteAndUnflag, esc, hmacHex, json, limitedForm, limitedJson, listFlagged,
  purgeProfileEvents,
  note, page, redirect, safeEqual, secretEqual, text, when,
} from "./lib.js";
import {
  SETTINGS_DONE, SETTINGS_URL, STATUS_URL, button, checklist, cvUpload, nav, problems, profileChange, profilePage, saveStatus,
  sendButton, settingsItem, settingsPage,
} from "./settings.js";
import { CRAWLERS, KEY_STYLE, crawlerCell, keyModal } from "./keys.js";
import { SEARCH_STYLE, matchesProfile, noMatch, searchBar, searchQuery } from "./search.js";
import { LINK_STYLE, MAX_STATS_BYTES, STATS_URL, statsLink, statsPage, validStats } from "./stats.js";
import { TASKS_STYLE, TASKS_URL, cancelTask, requests, taskRows, tasksButton, tasksModal, tasksPage } from "./tasks.js";

const SESSION_SECONDS = 12 * 3600;
const LOCK_SECONDS = 15 * 60;
const MAX_FAILURES = 5;
const MAX_GLOBAL_FAILURES = 30;
const MAX_FORM_BYTES = 64 * 1024;
const COOKIE = "__Host-hv_admin";
const KEY_RE = /^[A-Za-z0-9_-]{8,120}$/;
const PROFILE_RE = /^[a-z0-9-]{1,40}$/;
const DONE = {
  queued: "Saved. HermitShell applies it within seconds while it is connected.",
  saved: "Saved. The box above shows when HermitShell has applied it, within seconds while it is connected.",
  nochange: "Nothing had changed, so nothing was saved.",
  revoked: "Invite revoked.",
  confirm: "Tick the confirmation box to delete a profile.",
  badkey: "That does not look like an API key.",
  ...SETTINGS_DONE,
};

// Signing out bumps the epoch, which is part of every session signature, so old cookies stop working.
async function epoch(env) {
  return (await env.FEEDBACK.get("admin:epoch")) || "0";
}

function sessionKey(env) {
  return `${env.JOB_FEEDBACK_SECRET}\n${env.ADMIN_PASSWORD}`;
}

async function sessionFor(env, exp, ep) {
  return (await hmacHex(sessionKey(env), `admin-session\n${ep}\n${exp}`)).slice(0, 40);
}

async function csrfFor(env, exp, ep) {
  return (await hmacHex(sessionKey(env), `csrf\n${ep}\n${exp}`)).slice(0, 32);
}

async function session(request, env) {
  const cookie = (request.headers.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  const [exp, sig] = (cookie || "").slice(COOKIE.length + 1).split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return null;
  const ep = await epoch(env);
  return safeEqual(sig, await sessionFor(env, exp, ep)) ? { exp, csrf: await csrfFor(env, exp, ep) } : null;
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
  const userOk = await secretEqual(env.JOB_FEEDBACK_SECRET, form.get("username"), env.ADMIN_USER || "admin");
  const passOk = await secretEqual(env.JOB_FEEDBACK_SECRET, form.get("password"), env.ADMIN_PASSWORD);
  // A failure count that cannot be recorded (for example the daily KV write limit) must not allow guessing,
  // and a right password must not show through as a different answer.
  if (!(userOk && passOk)) {
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
  const exp = String(Date.now() + SESSION_SECONDS * 1000);
  const sig = await sessionFor(env, exp, await epoch(env));
  return redirect("/admin", { "Set-Cookie": cookieHeader(`${exp}.${sig}`, SESSION_SECONDS) });
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

// Sign-ups still in the queue, shown as pending rows until HermitShell reports the profile it built. HermitShell
// reports the new profile before it takes the sign-up off the queue, and a profile with the same email hides
// its pending row, so a new person never drops off the dashboard in between.
function pendingSignups(items, profiles) {
  const known = new Set(profiles.map((p) => String(p.email || "").toLowerCase()).filter(Boolean));
  return items.filter((i) => i.type === "signup" && !known.has(String(i.email || "").toLowerCase()))
    .map((i) => ({ pending: true, id: "", name: String(i.name || "New sign-up"), email: String(i.email || ""),
      status: "pending", at: Number(i.at) || 0, roles: String(i.roles || ""), details: { location: String(i.location || "") } }));
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
  return redirect(`/admin/profile?u=${u}&done=saved`);
}

// HermitShell checks in at least every 15 minutes, so a much older check-in means its profiles job has stopped.
const STALE_MS = 45 * 60 * 1000;

function lastUpdate(current, queued, presence) {
  const waiting = queued.length
    ? ` <a href="#tasks">Waiting for HermitShell: ${queued.length} change${queued.length === 1 ? "" : "s"}</a>.` : "";
  const report = current.updated ? ` Profiles last reported ${esc(ago(current.updated))}.` : "";
  if (presence.live) {
    return `<p class="muted"><span class="live" aria-hidden="true"></span><b>HermitShell is connected</b>: changes reach it within seconds.${report}${waiting}</p>`;
  }
  const seen = Math.max(presence.seen, current.updated || 0);
  if (!seen) return `<p class="muted">HermitShell hasn't reported yet.${waiting}</p>`;
  const stale = Date.now() - seen > STALE_MS
    ? `<div class="warn">HermitShell last checked in ${esc(ago(seen))}. Check that its <b>vacancy-profiles</b> job is running (<code>hermes cron list</code>).</div>` : "";
  return `${stale}<p class="muted">HermitShell last checked in ${esc(ago(seen))} (${esc(when(seen, current.timezone))}).${waiting}</p>`;
}

function initials(name) {
  const words = String(name || "").replace(/<[^>]*>/g, " ").match(/\p{L}[\p{L}'-]*/gu) || [];
  return (words.length > 1 ? words[0][0] + words.at(-1)[0] : (words[0] || "?").slice(0, 2)).toUpperCase();
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

function pendingRow(p, tz, live) {
  const roles = p.roles ? `<div class="muted">looking for ${esc(p.roles.slice(0, 80))}</div>` : "";
  const doing = live ? "HermitShell is reading their CV and building the profile. It shows here in full within a few minutes."
    : "HermitShell builds the profile as soon as it connects.";
  return `<tr class="pendingrow"><td><div class="who"><span class="avatar" aria-hidden="true">${esc(initials(p.name))}</span><div>
<b>${esc(p.name)}</b><div class="muted">${esc(p.email)}</div><div class="muted">signed up ${esc(p.at ? `${ago(p.at)} (${when(p.at, tz)})` : "just now")}</div>${roles}</div></div></td>
<td><span class="pill pending">pending</span><div class="muted">${doing}</div></td><td></td><td></td></tr>`;
}

function profileRow(p, csrf, tz, stats) {
  const status = `<span class="pill${p.owner ? " owner" : p.status === "paused" ? " paused" : ""}">${p.owner ? "owner, " : ""}${esc(p.status)}</span>`
    + (p.scanning ? ' <span class="pill scanning">scanning now</span>' : "");
  const toggle = p.status === "paused" ? button(csrf, "resume", "Resume", { u: p.id }) : button(csrf, "pause", "Pause", { u: p.id });
  const remove = p.owner ? "" : `<form method="post" action="/admin/action" class="inline" style="margin-top:6px">
<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="delete"><input type="hidden" name="u" value="${esc(p.id)}">
<label class="check" style="margin:0"><input type="checkbox" name="confirm" value="yes"> <span class="muted">delete CV and history</span></label>
<button class="small danger">Delete</button></form>`;
  const cv = p.has_cv === false ? ' <span class="pill paused">no CV</span>' : "";
  return `<tr><td><div class="who"><span class="avatar" aria-hidden="true">${esc(initials(p.name))}</span><div>
<b>${esc(p.name)}</b>${cv}<div class="muted">${esc(p.email || "")}</div><div class="muted">since ${esc(when(p.created, tz))}</div>
<a class="small" href="/admin/profile?u=${esc(p.id)}">Manage</a><div>${statsLink(p, stats, tz)}</div></div></div></td>
<td>${status}<div class="muted">last report ${esc(p.last_run ? `${ago(p.last_run)} (${when(p.last_run, tz)})` : "never")}</div>${schedule(p)}</td>
<td>${crawlerCell(p, csrf)}</td>
<td><div class="actions">${sendButton(p, csrf)}${toggle}</div>${remove}</td></tr>`;
}

async function dashboard(request, env, s) {
  const url = new URL(request.url);
  const [current, invites, queue, presence, held] = await Promise.all([
    status(env), env.FEEDBACK.list({ prefix: "invite:", limit: 100 }), queued(env), hubPresence(env), requests(env)]);
  const tasks = tasksButton(taskRows(current, queue, held).length);
  const signups = pendingSignups(queue, current.profiles || []);
  const waiting = describe(queue.filter((i) => !signups.some((p) => i.type === "signup" && p.email === String(i.email || ""))));
  const stats = await Promise.all((current.profiles || []).map((p) =>
    PROFILE_RE.test(p.id || "") ? env.FEEDBACK.get(`stats:${p.id}`, "json") : null));
  const inviteRows = (await Promise.all(invites.keys.map((k) => env.FEEDBACK.get(k.name, "json")))).filter(Boolean)
    .map((i) => `<tr><td>${esc(i.note || "No note")}</td><td class="muted">expires ${esc(when(i.expires, current.timezone))}</td>
<td>${button(s.csrf, "revoke", "Revoke", { invite: i.id })}</td></tr>`).join("");
  const done = DONE[url.searchParams.get("done")];
  const q = searchQuery(url);
  const all = [...(current.profiles || []).map((p, i) => ({ p, stats: stats[i] })), ...signups.map((p) => ({ p }))];
  const shown = all.filter(({ p }) => matchesProfile(p, q));
  const modals = shown.filter(({ p }) => !p.pending && PROFILE_RE.test(p.id || "")).map(({ p }) => keyModal(p, s.csrf)).join("");
  const rows = shown.map(({ p, stats: st }) => p.pending ? pendingRow(p, current.timezone, presence.live)
    : profileRow(p, s.csrf, current.timezone, st)).join("")
    || (all.length ? noMatch(q) : '<tr><td colspan="4" class="muted">HermitShell has not reported any profiles yet.</td></tr>');
  return page("Profiles", `<style>${LINK_STYLE}${KEY_STYLE}${SEARCH_STYLE}${PENDING_STYLE}${TASKS_STYLE}</style>${nav("profiles")}${done ? note(done) : ""}
${lastUpdate(current, waiting, presence)}
${problems(current)}${checklist(current)}
${all.length ? searchBar(q, shown.length, all.length, tasks) : `<div class="tabletools"><span></span><div class="tools">${tasks}</div></div>`}
<table class="list"><tr><th>Profile</th><th>Status</th><th>Crawler</th><th></th></tr>
${rows}</table>
<p class="muted">The email server and web search keys everyone shares are under <a href="${SETTINGS_URL}">Global settings</a>.</p>
<h2>Invite someone</h2>
<form method="post" action="/admin/action" class="inline"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><input type="hidden" name="action" value="invite">
<input name="note" maxlength="80" placeholder="Who it is for (only you see this)"><button class="small">Create invite link</button></form>
<p class="muted">Each link works once and expires after 7 days.</p>
${inviteRows ? `<table class="list">${inviteRows}</table>` : ""}
<form method="post" action="/admin/logout" class="signout"><button class="small quiet">Sign out</button></form>`,
  { wide: true, before: modals + tasksModal(), headers: { "Content-Security-Policy": `${CSP}; frame-src 'self'` } });
}

async function tasksAction(request, env, s) {
  const form = await limitedForm(request, 4096);
  if (!form || !safeEqual(String(form.get("csrf") || ""), s.csrf)) {
    return page("Expired form", "<p>Reload the admin page and try again.</p>", { status: 403 });
  }
  const [current, queue] = await Promise.all([status(env), queued(env)]);
  const done = await cancelTask(env, String(form.get("task") || "").slice(0, 200), current, queue);
  return redirect(`${TASKS_URL}?done=${done}`);
}

async function action(request, env, s) {
  const form = await limitedForm(request, MAX_FORM_BYTES);
  if (!form) return text("Request too large", 413);
  if (!safeEqual(String(form.get("csrf") || ""), s.csrf)) return page("Expired form", "<p>Reload the admin page and try again.</p>", { status: 403 });
  const act = String(form.get("action") || "");
  const u = String(form.get("u") || "");
  if (["set_key", "use_global", "pause", "resume", "delete", "send_now"].includes(act) && !PROFILE_RE.test(u)) {
    return page("Unknown profile", "<p>Reload the admin page and try again.</p>", { status: 400 });
  }
  if (act === "invite") {
    const [invite, current] = await Promise.all([createInvite(env, form.get("note") || ""), status(env)]);
    const link = `${new URL(request.url).origin}/join?i=${invite.id}`;
    return page("Invite link", `<p>Send this link to ${esc(invite.note || "the person")}. It works once and expires on ${esc(when(invite.expires, current.timezone))}.</p>
<code class="link">${esc(link)}</code><p><a href="/admin">Back to profiles</a></p>`);
  }
  if (act === "revoke") {
    await env.FEEDBACK.delete(`invite:${String(form.get("invite") || "").replace(/[^0-9a-f]/g, "")}`);
    return redirect("/admin?done=revoked");
  }
  if (act === "profile") return saveProfile(env, s, form, u);
  if (act === "send_now") {
    await queueItem(env, { type: "admin", action: act, u });
    return redirect(form.get("back") === "profile" ? `/admin/profile?u=${u}&done=sending` : "/admin?done=sending");
  }
  const setting = settingsItem(act, form);
  if (setting) {
    const back = `${SETTINGS_URL}?done=`;
    const anchor = act.startsWith("api_keys") ? "#keys" : "#email";
    if (setting.error) return redirect(`${back}${setting.error}${anchor}`);
    await queueItem(env, setting.item, setting.ttl);
    return redirect(`${back}queued${anchor}`);
  }
  if (act === "set_key") {
    const key = String(form.get("key") || "").trim();
    const provider = String(form.get("provider") || "firecrawl");
    if (!KEY_RE.test(key) || !CRAWLERS.includes(provider)) return redirect("/admin?done=badkey");
    await queueItem(env, { type: "admin", action: act, u, key, provider }, SECRET_TTL_SECONDS);
  } else if (act === "delete") {
    if (form.get("confirm") !== "yes") return redirect("/admin?done=confirm");
    await queueItem(env, { type: "admin", action: act, u });
    await purgeProfileEvents(env, u);
  } else if (["use_global", "pause", "resume"].includes(act)) {
    await queueItem(env, { type: "admin", action: act, u });
  } else {
    return page("Unknown action", "<p>Reload the admin page and try again.</p>", { status: 400 });
  }
  return redirect("/admin?done=queued");
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
    if (s) await env.FEEDBACK.put("admin:epoch", String(Date.now()));
    return redirect("/admin", { "Set-Cookie": cookieHeader("", 0) });
  }
  if (!s) return loginPage();
  if (path === "/admin" && request.method === "GET") return dashboard(request, env, s);
  if (path === "/admin/action" && request.method === "POST") return action(request, env, s);
  if (path === "/admin/cv" && request.method === "POST") return cvUpload(request, env, s);
  if (path === TASKS_URL && request.method === "POST") return tasksAction(request, env, s);
  if (path === TASKS_URL && request.method === "GET") {
    const url = new URL(request.url);
    const [current, queue, held] = await Promise.all([status(env), queued(env), requests(env)]);
    return tasksPage(taskRows(current, queue, held), s.csrf, current.timezone,
      Math.min(Math.max(Math.trunc(Number(url.searchParams.get("n"))) || 0, 0), 99), url.searchParams.get("done") || "");
  }
  if (path === SETTINGS_URL && request.method === "GET") {
    const url = new URL(request.url);
    const [current, queue] = await Promise.all([status(env), queued(env)]);
    return settingsPage(current, s.csrf, { done: DONE[url.searchParams.get("done")] || "", queued: describe(queue), queue });
  }
  if (path === "/admin/profile" && request.method === "GET") {
    const url = new URL(request.url);
    const [current, queue] = await Promise.all([status(env), queued(env)]);
    const done = url.searchParams.get("done");
    return profilePage(current, url.searchParams.get("u") || "", s.csrf,
      { done: DONE[done] || "", queue, saving: ["saved", "cvqueued", "sending"].includes(done) });
  }
  if (path === STATS_URL && request.method === "GET") {
    const url = new URL(request.url);
    const u = url.searchParams.get("u") || "";
    if (!PROFILE_RE.test(u)) return text("Not found", 404);
    const [current, stats] = await Promise.all([status(env), env.FEEDBACK.get(`stats:${u}`, "json")]);
    return statsPage(current, stats, u, url.searchParams.get("r"));
  }
  if (path === STATUS_URL && request.method === "GET") {
    const url = new URL(request.url);
    const u = url.searchParams.get("u") || "";
    if (!PROFILE_RE.test(u)) return text("Not found", 404);
    const [current, queue] = await Promise.all([status(env), queued(env)]);
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
      await env.FEEDBACK.delete(`stats:${u}`);
      return json({ deleted: true });
    }
    if (!validStats(body.stats)) return json({ error: "invalid stats" }, 400);
    await env.FEEDBACK.put(`stats:${u}`, JSON.stringify({ ...body.stats, updated: Date.now() }));
    return json({ saved: true });
  }
  if (url.pathname === "/api/invite" && request.method === "POST") {
    const body = (await limitedJson(request, 10000)) || {};
    const invite = await createInvite(env, body.note || "");
    return json({ link: `${url.origin}/join?i=${invite.id}`, expires: invite.expires });
  }
  return json({ error: "not found" }, 404);
}

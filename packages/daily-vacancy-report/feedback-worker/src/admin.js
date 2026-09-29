// Admin gateway (/admin) and the Hermes API (/api/*).
//
// /admin: when ACCESS_AUD is set, Cloudflare Access (email one-time code) must let the request through
// first. Then sign in with ADMIN_USER (default "admin") and the ADMIN_PASSWORD secret; five wrong attempts
// lock that address, and 30 from anywhere lock sign-in, for 15 minutes. Signed-in pages create invite
// links, show the profiles Hermes reports, and queue changes that Hermes applies on its next check.
// Nothing here can reach the Hermes server; it only reads /api/queue with its API token.

import { SECRET_TTL_SECONDS, createInvite, queueItem } from "./join.js";
import {
  SECURITY_HEADERS, accessUser, authorised, deleteAndUnflag, esc, hmacHex, json, limitedForm, limitedJson, listFlagged,
  page, redirect, safeEqual, secretEqual, text, when,
} from "./lib.js";

const SESSION_SECONDS = 12 * 3600;
const LOCK_SECONDS = 15 * 60;
const MAX_FAILURES = 5;
const MAX_GLOBAL_FAILURES = 30;
const MAX_FORM_BYTES = 64 * 1024;
const COOKIE = "__Host-hv_admin";
const KEY_RE = /^[A-Za-z0-9_-]{8,120}$/;
const PROFILE_RE = /^[a-z0-9-]{1,40}$/;
const DONE = {
  queued: "Saved. Hermes applies it within about 5 minutes.",
  revoked: "Invite revoked.",
  confirm: "Tick the confirmation box to delete a profile.",
  badkey: "That does not look like an API key.",
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
  return page("Admin sign-in", `${message ? `<p style="color:#b91c1c">${esc(message)}</p>` : ""}
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

function button(csrf, action, label, fields = {}, cls = "small quiet") {
  const hidden = Object.entries({ csrf, action, ...fields })
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");
  return `<form method="post" action="/admin/action" style="display:inline">${hidden}<button class="${cls}">${esc(label)}</button></form>`;
}

async function pending(env) {
  const listed = await env.FEEDBACK.list({ prefix: "queue:", limit: 50 });
  const items = (await Promise.all(listed.keys.map((k) => env.FEEDBACK.get(k.name, "json")))).filter(Boolean);
  return items.map((i) => i.type === "signup" ? `Sign-up from ${i.name}` : i.type === "unsubscribe"
    ? `Unsubscribe ${i.u || "owner"}` : `${String(i.action || i.type).replaceAll("_", " ")}${i.u ? ` for ${i.u}` : ""}`);
}

function profileRow(p, csrf) {
  const status = `<span class="pill${p.owner ? " owner" : p.status === "paused" ? " paused" : ""}">${p.owner ? "owner, " : ""}${esc(p.status)}</span>`;
  const crawler = p.crawler === "own" ? `own key ${esc(p.key_hint || "")}` : "global key";
  const toggle = p.status === "paused" ? button(csrf, "resume", "Resume", { u: p.id }) : button(csrf, "pause", "Pause", { u: p.id });
  const remove = p.owner ? "" : `<form method="post" action="/admin/action" class="inline" style="margin-top:6px">
<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="delete"><input type="hidden" name="u" value="${esc(p.id)}">
<label class="check" style="margin:0"><input type="checkbox" name="confirm" value="yes"> <span class="muted">delete CV and history</span></label>
<button class="small danger">Delete</button></form>`;
  return `<tr><td><b>${esc(p.name)}</b><div class="muted">${esc(p.email || "")}</div><div class="muted">since ${esc(when(p.created))}</div></td>
<td>${status}<div class="muted">last report ${esc(when(p.last_run))}</div></td>
<td><div class="muted">${crawler}</div>
<form method="post" action="/admin/action" class="inline" style="margin-top:6px">
<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="set_key"><input type="hidden" name="u" value="${esc(p.id)}">
<input name="key" type="password" placeholder="Their Firecrawl key" autocomplete="off"><button class="small">Save</button></form>
${p.crawler === "own" ? button(csrf, "use_global", "Use global key", { u: p.id }) : ""}</td>
<td>${toggle}${remove}</td></tr>`;
}

async function dashboard(request, env, s) {
  const url = new URL(request.url);
  const [stored, invites, queued] = await Promise.all([
    env.FEEDBACK.get("status:profiles", "json"), env.FEEDBACK.list({ prefix: "invite:", limit: 100 }), pending(env)]);
  const status = stored && Array.isArray(stored.profiles) ? stored : { profiles: [] };
  const inviteRows = (await Promise.all(invites.keys.map((k) => env.FEEDBACK.get(k.name, "json")))).filter(Boolean)
    .map((i) => `<tr><td>${esc(i.note || "No note")}</td><td class="muted">expires ${esc(when(i.expires))}</td>
<td>${button(s.csrf, "revoke", "Revoke", { invite: i.id })}</td></tr>`).join("");
  const done = DONE[url.searchParams.get("done")];
  const firecrawl = status.keys?.firecrawl || {};
  return page("Profiles", `${done ? `<p style="color:#047857">${esc(done)}</p>` : ""}
<p class="muted">Last update from Hermes: ${esc(when(status.updated))}.${queued.length ? ` Waiting for Hermes: ${esc(queued.join("; "))}.` : ""}</p>
<table class="list"><tr><th>Profile</th><th>Status</th><th>Crawler</th><th></th></tr>
${(status.profiles || []).map((p) => profileRow(p, s.csrf)).join("") || '<tr><td colspan="4" class="muted">Hermes has not reported any profiles yet.</td></tr>'}</table>
<h2>Global crawler key</h2>
<p class="muted">Used by every profile without its own key. Now: ${esc(firecrawl.source === "dashboard" ? `set here ${firecrawl.hint || ""}`
    : firecrawl.source === "env" ? `the key in Hermes' .env ${firecrawl.hint || ""}` : "none")}.</p>
<form method="post" action="/admin/action" class="inline"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><input type="hidden" name="action" value="api_keys">
<input name="keys" type="password" placeholder="Firecrawl key (several: comma separated)" autocomplete="off"><button class="small">Save</button></form>
${firecrawl.source === "dashboard" ? button(s.csrf, "api_keys_clear", "Go back to the .env keys") : ""}
<h2>Invite someone</h2>
<form method="post" action="/admin/action" class="inline"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><input type="hidden" name="action" value="invite">
<input name="note" maxlength="80" placeholder="Who it is for (only you see this)"><button class="small">Create invite link</button></form>
<p class="muted">Each link works once and expires after 7 days.</p>
${inviteRows ? `<table class="list">${inviteRows}</table>` : ""}
<form method="post" action="/admin/logout"><button class="small quiet" style="margin-top:28px">Sign out</button></form>`, { wide: true });
}

async function action(request, env, s) {
  const form = await limitedForm(request, MAX_FORM_BYTES);
  if (!form) return text("Request too large", 413);
  if (!safeEqual(String(form.get("csrf") || ""), s.csrf)) return page("Expired form", "<p>Reload the admin page and try again.</p>", { status: 403 });
  const act = String(form.get("action") || "");
  const u = String(form.get("u") || "");
  if (["set_key", "use_global", "pause", "resume", "delete"].includes(act) && !PROFILE_RE.test(u)) {
    return page("Unknown profile", "<p>Reload the admin page and try again.</p>", { status: 400 });
  }
  if (act === "invite") {
    const invite = await createInvite(env, form.get("note") || "");
    const link = `${new URL(request.url).origin}/join?i=${invite.id}`;
    return page("Invite link", `<p>Send this link to ${esc(invite.note || "the person")}. It works once and expires on ${esc(when(invite.expires))}.</p>
<code class="link">${esc(link)}</code><p><a href="/admin">Back to profiles</a></p>`);
  }
  if (act === "revoke") {
    await env.FEEDBACK.delete(`invite:${String(form.get("invite") || "").replace(/[^0-9a-f]/g, "")}`);
    return redirect("/admin?done=revoked");
  }
  if (act === "set_key") {
    const key = String(form.get("key") || "").trim();
    if (!KEY_RE.test(key)) return redirect("/admin?done=badkey");
    await queueItem(env, { type: "admin", action: act, u, key }, SECRET_TTL_SECONDS);
  } else if (act === "api_keys") {
    const keys = String(form.get("keys") || "").split(/[\s,]+/).filter(Boolean);
    if (!keys.length || keys.some((k) => !KEY_RE.test(k))) return redirect("/admin?done=badkey");
    await queueItem(env, { type: "admin", action: act, firecrawl: keys.slice(0, 5) }, SECRET_TTL_SECONDS);
  } else if (act === "api_keys_clear") {
    await queueItem(env, { type: "admin", action: "api_keys", clear: ["firecrawl"] });
  } else if (act === "delete") {
    if (form.get("confirm") !== "yes") return redirect("/admin?done=confirm");
    await queueItem(env, { type: "admin", action: act, u });
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
  return text("Not found", 404);
}

export async function handleApi(request, env) {
  if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
  const url = new URL(request.url);
  if (url.pathname === "/api/queue" && request.method === "GET") {
    return json({ items: await listFlagged(env, request, "queue:", "flag:queue", 100) });
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
  if (url.pathname === "/api/invite" && request.method === "POST") {
    const body = (await limitedJson(request, 10000)) || {};
    const invite = await createInvite(env, body.note || "");
    return json({ link: `${url.origin}/join?i=${invite.id}`, expires: invite.expires });
  }
  return json({ error: "not found" }, 404);
}

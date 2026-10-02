// A recruit's own page (/me): the jobs sent to them, their job search and report time, and their documents.
// Off unless the "self_service" switch is on (HERMES_SELF_SERVICE) and HermitShell speaks PROTOCOL 6; otherwise
// every /me address is a 404.
//
// Signing in is by a link emailed to the address HermitShell has for an active recruit (never the main admin, a
// paused recruit or anyone else). Asking for one is counted in the hub before anything is written to KV (per
// address range, per address and in total), always gets the same answer whether or not the address is known, and
// does the matching after the answer is sent. A link's token is 32 random bytes; the hub keeps only its SHA-256 for
// 15 minutes and spends it with one statement, so it works once even when two requests race. The token itself
// reaches HermitShell sealed in a "login_link" queue item, and HermitShell emails the link it builds from its own
// JOB_FEEDBACK_URL. Without the hub nothing is sent: links are refused rather than kept in KV, where a deleted
// token can still be read elsewhere for a minute or more.
//
// Opening the link only shows a Sign in button (mail scanners open links); pressing it spends the token and sets
// the __Host-hv_me cookie for 7 days, signed under its own label with the recruit's epoch ("meepoch:<id>"), which
// Sign out everywhere moves on. A recruit's session never opens /admin, and an admin's never opens /me: separate
// cookies, signing labels and form tokens. Notes, tags, fees and other recruits are never shown here.

import { DOC_KINDS, DOC_NAMES, DOC_STYLE, docIndex, docResponse, downloadMenu, profileCvBusy, profileCvInfo, readDoc, readProfileCv, requestProfileCv } from "./docs.js";
import { hubLimit, hubTokenPut, hubTokenSpend } from "./hub.js";
import { listed, record } from "./history.js";
import { queueItem } from "./join.js";
import { esc, flaggedItems, hmacHex, limitedForm, note, page, purgeProfileEvents, redirect, safeEqual, sha256Hex, text, when, PROFILE_RE } from "./lib.js";
import { sealInfo, sealItem } from "./seal.js";
import { featureOn, latestValues, ownSearchChange, searchFields } from "./settings.js";
import { ANSWERS, sentJobs, sentParts } from "./stats.js";
import { requests } from "./tasks.js";

export const ME_URL = "/me";
export const ME_PROTOCOL = 6;
const COOKIE = "__Host-hv_me";
const PRE_COOKIE = "__Host-hv_mepre";
const SESSION_SECONDS = 7 * 86400;
const PRE_SECONDS = 3600;
const LINK_MS = 15 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const LINK_RE = /^https?:\/\/[^\s"'<>]+$/i;
// [max, window ms]: link requests per address range, per address and in total, and sign-in presses per range.
const LIMITS = { range: [5, 60 * 1000], address: [3, 3600 * 1000], all: [50, 3600 * 1000], spend: [10, 15 * 60 * 1000] };
const MAX_FORM_BYTES = 16 * 1024;
const MAX_JOBS = 60;
const ANSWER_LABELS = Object.fromEntries(ANSWERS.map(([k, label]) => [k, label]));

const UNAVAILABLE = ["Sign-in links unavailable", "<p>Sign-in links are unavailable right now. Try again later.</p>", { status: 503 }];
const TOO_MANY = ["Too many requests", "<p>Too many requests. Try again later.</p>", { status: 429 }];
const EXPIRED_FORM = ["Expired form", `<p>This form has expired. <a href="${ME_URL}">Start again</a>.</p>`, { status: 403 }];

export function selfService(status) {
  return featureOn(status, "self_service") && Number.isInteger(status?.protocol) && status.protocol >= ME_PROTOCOL;
}

function signingKey(env) {
  return `${env.JOB_FEEDBACK_SECRET}\nrecruit-session`;
}

function cookieValue(request, name) {
  const found = (request.headers.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : "";
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Whose requests are counted together: the IP address, or for IPv6 its /64, which one user can move around in.
function addressRange(request) {
  const ip = (request.headers.get("CF-Connecting-IP") || "unknown").replace(/[^0-9a-fA-F:.]/g, "").slice(0, 45) || "unknown";
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip;
}

// Every limit counted at once: true to go on, false when one is used up, null when the hub can't count.
async function counted(env, keys) {
  const got = await Promise.all(keys.map(([key, [max, windowMs]]) => hubLimit(env, key, max, windowMs, true)));
  return got.every(Boolean) ? got.every((g) => g.ok) : null;
}

async function status(env) {
  const stored = await env.FEEDBACK.get("status:profiles", "json");
  return stored && Array.isArray(stored.profiles) ? stored : { profiles: [] };
}

function activeRecruit(current, u) {
  return (current.profiles || []).find((p) => p && p.id === u && !p.owner && p.status === "active" && PROFILE_RE.test(p.id)) || null;
}

// ------------------------------------------------------------------------- signed out: asking for a link

// The form token before there is a session: an HMAC of a random value kept in its own short-lived cookie.
async function preToken(request, env) {
  const kept = cookieValue(request, PRE_COOKIE);
  const value = /^[0-9a-f]{32}$/.test(kept) ? kept : crypto.randomUUID().replaceAll("-", "");
  return { value, csrf: (await hmacHex(signingKey(env), `me-pre\n${value}`)).slice(0, 32),
    headers: value === kept ? {} : { "Set-Cookie": cookie(PRE_COOKIE, value, PRE_SECONDS) } };
}

async function preTokenOk(request, env, form) {
  const kept = cookieValue(request, PRE_COOKIE);
  if (!/^[0-9a-f]{32}$/.test(kept)) return false;
  return safeEqual(String(form.get("csrf") || ""), (await hmacHex(signingKey(env), `me-pre\n${kept}`)).slice(0, 32));
}

async function askPage(request, env, message = "", code = 200) {
  const pre = await preToken(request, env);
  return page("Your job search", `${message}<p>Get a link to sign in to your own page: the jobs HermitShell has sent you, your letters and CVs, and your job search.</p>
<form method="post" action="${ME_URL}/link"><input type="hidden" name="csrf" value="${pre.csrf}">
<label for="email">The email address your reports go to</label><input id="email" name="email" type="email" maxlength="120" autocomplete="email" required>
<button>Email me a sign-in link</button></form>
<p class="muted">The link works once, within 15 minutes. <a href="/privacy">How your data is handled</a>.</p>`, { status: code, headers: pre.headers });
}

// The same answer for every address, known or not; the matching runs after it is sent.
async function askLink(request, env, ctx) {
  const form = await limitedForm(request, 4096);
  if (!form || !(await preTokenOk(request, env, form))) return page(...EXPIRED_FORM);
  const email = String(form.get("email") || "").trim().toLowerCase();
  if (email.length > 120 || !EMAIL_RE.test(email)) return askPage(request, env, note("Enter the email address your reports go to.", "bad"), 400);
  const range = addressRange(request);
  const ok = await counted(env, [[`melink:${range}`, LIMITS.range], [`meaddr:${(await sha256Hex(email)).slice(0, 32)}`, LIMITS.address],
    ["meall:links", LIMITS.all]]);
  if (ok === null) return page(...UNAVAILABLE);
  if (!ok) return page(...TOO_MANY);
  const work = sendLink(env, email).catch((err) => console.error(`me link: ${err?.name || "Error"}`));
  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;
  return page("Check your email", `<p>If that address gets job reports from HermitShell, a sign-in link is on its way. It works once, within 15 minutes.</p>
<p class="muted">Nothing after a few minutes? Check the address and your spam folder, then ask again.</p>`);
}

async function sendLink(env, email) {
  const current = await status(env);
  const p = (current.profiles || []).find((x) => x && !x.owner && x.status === "active" && String(x.email || "").toLowerCase() === email);
  const info = sealInfo(current);
  if (!p || !PROFILE_RE.test(p.id) || !info) return;
  const token = randomToken();
  if ((await hubTokenPut(env, await sha256Hex(token), p.id, LINK_MS)) !== true) return;
  await queueItem(env, await sealItem(info, { type: "login_link", u: p.id, token }), LINK_MS / 1000);
}

// ------------------------------------------------------------------------- the link: a button, then the spend

async function loginPage(request, env) {
  const t = new URL(request.url).searchParams.get("t") || "";
  if (!TOKEN_RE.test(t)) return page("Link not valid", `<p>This sign-in link is incomplete. <a href="${ME_URL}">Ask for a new one</a>.</p>`, { status: 400 });
  const pre = await preToken(request, env);
  return page("Sign in", `<p>Sign in to your own page. The link works once.</p>
<form method="post" action="${ME_URL}/login"><input type="hidden" name="csrf" value="${pre.csrf}"><input type="hidden" name="t" value="${esc(t)}">
<button>Sign in</button></form>`, { headers: pre.headers });
}

async function sessionSig(env, u, epoch, exp) {
  return (await hmacHex(signingKey(env), `recruit-session\n${u}\n${epoch}\n${exp}`)).slice(0, 40);
}

async function spend(request, env, current) {
  const form = await limitedForm(request, 4096);
  if (!form || !(await preTokenOk(request, env, form))) return page(...EXPIRED_FORM);
  const t = String(form.get("t") || "");
  if (!TOKEN_RE.test(t)) return page("Link not valid", `<p>This sign-in link is incomplete. <a href="${ME_URL}">Ask for a new one</a>.</p>`, { status: 400 });
  const ok = await counted(env, [[`melogin:${addressRange(request)}`, LIMITS.spend]]);
  if (ok === null) return page(...UNAVAILABLE);
  if (!ok) return page(...TOO_MANY);
  const u = await hubTokenSpend(env, await sha256Hex(t));
  if (u === null) return page(...UNAVAILABLE);
  if (!u) return page("Link used or expired", `<p>Each sign-in link works once, within 15 minutes. <a href="${ME_URL}">Ask for a new one</a>.</p>`, { status: 410 });
  if (!activeRecruit(current, u)) return page("Page not available", "<p>Your page isn't available. Your reports may be paused. Ask the person who invited you.</p>", { status: 403 });
  const epoch = (await env.FEEDBACK.get(`meepoch:${u}`)) || "0";
  const exp = String(Date.now() + SESSION_SECONDS * 1000);
  const res = redirect(ME_URL);
  res.headers.append("Set-Cookie", cookie(COOKIE, `${exp}.${u}.${await sessionSig(env, u, epoch, exp)}`, SESSION_SECONDS));
  res.headers.append("Set-Cookie", cookie(PRE_COOKIE, "", 0));
  return res;
}

// ------------------------------------------------------------------------- signed in

async function meSession(request, env, current) {
  const parts = cookieValue(request, COOKIE).split(".");
  const [exp, u, sig] = parts;
  if (parts.length !== 3 || !sig || !(Number(exp) > Date.now()) || !PROFILE_RE.test(u || "")) return null;
  const p = activeRecruit(current, u);
  if (!p) return null;
  const epoch = (await env.FEEDBACK.get(`meepoch:${u}`)) || "0";
  if (!safeEqual(sig, await sessionSig(env, u, epoch, exp))) return null;
  return { u, p, csrf: (await hmacHex(signingKey(env), `me-csrf\n${u}\n${epoch}\n${exp}`)).slice(0, 32) };
}

const ME_STYLE = `.mytop{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin:0 0 14px}
.mytop form{margin:0}.mytop .btns{display:flex;gap:6px;flex-wrap:wrap}
.myjobs{list-style:none;padding:0;margin:0}.myjobs li{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid var(--line)}
.myjobs .fit{flex:none;min-width:42px;padding:4px 0;border-radius:10px;background:var(--soft);text-align:center;font-weight:700}
.myjobs .job{display:flex;flex-direction:column;gap:2px;min-width:0}.myjobs .job b{overflow-wrap:anywhere}
.myjobs .answer{font-size:12px;font-weight:650;color:var(--brand-ink)}.mycv{margin:12px 0 0}`;

function tabs(active) {
  return `<nav class="tabs" aria-label="Your page">${[["jobs", ME_URL, "My jobs"], ["search", `${ME_URL}/search`, "My job search"],
    ["docs", `${ME_URL}/docs`, "My documents"]].map(([id, href, label]) =>
    `<a href="${href}"${id === active ? ' class="on" aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

function myPage(s, title, active, body, opts = {}) {
  const top = `<div class="mytop"><span class="muted">Signed in as ${esc(s.p.name || "you")}</span><div class="btns">
<form method="post" action="${ME_URL}/logout"><input type="hidden" name="csrf" value="${s.csrf}"><button class="small quiet">Sign out</button></form>
<form method="post" action="${ME_URL}/logout"><input type="hidden" name="csrf" value="${s.csrf}"><input type="hidden" name="all" value="1"><button class="small quiet">Sign out everywhere</button></form></div></div>`;
  return page(title, `<style>${ME_STYLE}${opts.style || ""}</style>${top}${tabs(active)}${body}`, { wide: true, status: opts.status || 200 });
}

async function jobsPage(env, s, current) {
  const [stats, sent] = await Promise.all([env.FEEDBACK.get(`stats:${s.u}`, "json"), env.FEEDBACK.get(`sent:${s.u}`, "json")]);
  const listedJobs = sentParts(sent).jobs;
  const jobs = sentJobs(listedJobs ? { sent: listedJobs } : stats).sort((a, b) => b.day.localeCompare(a.day)).slice(0, MAX_JOBS);
  const rows = jobs.map((j) => {
    const fit = Number.isInteger(j.fit) && j.fit >= 0 && j.fit <= 10 ? `${j.fit}/10` : "&ndash;";
    const meta = [j.employer, j.location, j.mode, j.salary].filter((v) => typeof v === "string" && v.trim())
      .map((v) => esc(v.slice(0, 60))).join(" &middot; ");
    const url = typeof j.url === "string" && j.url.length <= 500 && LINK_RE.test(j.url) ? j.url : "";
    const title = esc(String(j.title).slice(0, 90));
    const answer = ANSWER_LABELS[j.answer] ? `<span class="answer">${esc(ANSWER_LABELS[j.answer])}</span>` : "";
    return `<li><span class="fit">${fit}</span><span class="job">${url ? `<a href="${esc(url)}" rel="noopener noreferrer" target="_blank"><b>${title}</b></a>` : `<b>${title}</b>`}
<span class="muted">${meta}${meta ? " &middot; " : ""}${esc(j.day)}</span>${answer}</span></li>`;
  });
  const body = rows.length ? `<ul class="myjobs">${rows.join("")}</ul>`
    : `<p class="muted">${stats || listedJobs ? "No jobs have been sent to you recently." : "Your list appears after your next report."}</p>`;
  return myPage(s, "My jobs", "jobs", `<p class="muted">The jobs in your recent reports, newest first, with their fit score out of 10. Use the buttons in your report emails to tell us how each one went.</p>${body}`);
}

async function queued(env) {
  const flag = await env.FEEDBACK.get("flag:queue");
  return flag ? flaggedItems(env, "queue:", "flag:queue", 50, flag) : [];
}

const SEARCH_DONE = {
  saved: ["ok", "Saved. Your changes take effect within a few minutes."],
  nochange: ["ok", "Nothing had changed, so nothing was saved."],
  conflict: ["bad", "Someone else changed your search while you were editing, so nothing was saved. This is the latest version. Make your changes again if you still need them."],
  badtime: ["bad", "Pick a time for your daily report."],
};

function searchPage(s, current, queue, done = "", code = 200) {
  const v = latestValues(s.p, queue);
  const [tone, message] = SEARCH_DONE[done] || [];
  const zone = current.timezone ? ` (${current.timezone})` : "";
  return myPage(s, "My job search", "search", `${message ? note(message, tone) : ""}
<form method="post" action="${ME_URL}/search"><input type="hidden" name="csrf" value="${s.csrf}"><input type="hidden" name="base" value="${esc(JSON.stringify(v))}">
${searchFields(v, `When HermitShell sends your report${zone}.`)}
<button>Save changes</button></form>
<h2 id="stop">Stop my reports</h2>
<form method="post" action="${ME_URL}/unsubscribe"><input type="hidden" name="csrf" value="${s.csrf}">
<p class="muted">HermitShell stops your reports and deletes your profile, CV and history, then emails you to confirm. <a href="/privacy">How your data is handled</a>.</p>
<label class="check"><input type="checkbox" name="confirm" value="yes" required> <span>Yes, delete my profile</span></label>
<button class="danger">Unsubscribe</button></form>`, { status: code });
}

async function saveSearch(request, env, s, current) {
  const form = await limitedForm(request, MAX_FORM_BYTES);
  if (!form || !safeEqual(String(form.get("csrf") || ""), s.csrf)) return page(...EXPIRED_FORM);
  const queue = await queued(env);
  const change = ownSearchChange(s.p, queue, form);
  if (change.refused) return myPage(s, "My job search", "search", note("Only your job search and report time can be changed here.", "bad"), { status: 400 });
  if (change.conflicts) return searchPage(s, current, queue, "conflict", 409);
  if (change.error) return searchPage(s, current, queue, change.error === "badtime" ? "badtime" : "conflict", 400);
  if (!change.item) return redirect(`${ME_URL}/search?done=nochange`);
  await queueItem(env, change.item);
  await record(env, s.u, change.item.job ? "job" : "report_time", `Changed ${listed(change.changed)}`, { by: s.p.name || "", via: "self" });
  return redirect(`${ME_URL}/search?done=saved`);
}

const DOCS_DONE = {
  cvmaking: ["ok", "HermitShell is making your CV from the one you sent. It shows here within a few minutes."],
  cvnone: ["bad", "HermitShell doesn't have a CV for you yet."],
  gone: ["bad", "That document is no longer kept."],
};

async function docsPage(env, s, current, done) {
  const [docs, cv, held] = await Promise.all([docIndex(env, s.u), profileCvInfo(env, s.u), requests(env)]);
  const busy = profileCvBusy(current, held, s.u);
  const [tone, message] = DOCS_DONE[done] || [];
  const rows = docs.slice().reverse().map((d) => `<div class="doc ready"><span><b>${esc(DOC_KINDS[d.k])}</b><small>${esc(d.name)} &middot; made ${esc(when(d.at, current.timezone))}, kept until ${esc(new Date(d.exp).toISOString().slice(0, 10))}</small></span>
${downloadMenu(`${ME_URL}/doc?k=${d.k}&amp;h=${d.h}`, d, DOC_NAMES[d.k])}</div>`);
  const own = cv ? `<div class="doc ready"><span><b>Your CV</b><small>made ${esc(when(cv.at, current.timezone))}</small></span><a class="dl" href="${ME_URL}/cv" download>Download</a></div>` : "";
  const generate = s.p.has_cv === false ? "" : busy ? '<p class="muted">Making your CV&hellip;</p>'
    : `<form class="mycv" method="post" action="${ME_URL}/cv"><input type="hidden" name="csrf" value="${s.csrf}"><button class="small">${cv ? "Make it again" : "Make my CV"}</button></form>`;
  return myPage(s, "My documents", "docs", `${message ? note(message, tone) : ""}
<h2>Your CV</h2><p class="muted">A neat copy of the CV you sent, with every job on it.</p>${own}${generate}
<h2>Cover letters, tailored CVs and interview prep</h2><p class="muted">Kept for a few days after they are made. Ask for new ones with the buttons in your report emails.</p>
${rows.join("") || '<p class="muted">None kept at the moment.</p>'}`, { style: DOC_STYLE });
}

async function makeCv(request, env, s, current) {
  const form = await limitedForm(request, 4096);
  if (!form || !safeEqual(String(form.get("csrf") || ""), s.csrf)) return page(...EXPIRED_FORM);
  if (s.p.has_cv === false) return redirect(`${ME_URL}/docs?done=cvnone`);
  if (!profileCvBusy(current, await requests(env), s.u)) {
    await requestProfileCv(env, s.u);
    await record(env, s.u, "profile_cv", "Asked for their CV", { by: s.p.name || "", via: "self" });
  }
  return redirect(`${ME_URL}/docs?done=cvmaking`);
}

function signedOut(title, body) {
  return page(title, body, { headers: { "Set-Cookie": cookie(COOKIE, "", 0) } });
}

async function logout(request, env, s) {
  const form = await limitedForm(request, 4096);
  if (!form || !safeEqual(String(form.get("csrf") || ""), s.csrf)) return page(...EXPIRED_FORM);
  const all = form.get("all") === "1";
  if (all) await env.FEEDBACK.put(`meepoch:${s.u}`, String(Date.now()));
  return signedOut("Signed out", all
    ? "<p>Signed out on this device, and on all your other devices within about a minute.</p>"
    : `<p>Signed out. <a href="${ME_URL}">Sign in again</a>.</p>`);
}

async function unsubscribe(request, env, s) {
  const form = await limitedForm(request, 4096);
  if (!form || !safeEqual(String(form.get("csrf") || ""), s.csrf)) return page(...EXPIRED_FORM);
  if (form.get("confirm") !== "yes") return redirect(`${ME_URL}/search#stop`);
  await queueItem(env, { type: "unsubscribe", u: s.u, reason: "" });
  await purgeProfileEvents(env, s.u);
  return signedOut("Unsubscribed", "<p>Done. HermitShell deletes your profile, CV and history within about 5 minutes and emails you when it is done.</p>");
}

export async function handleMe(request, env, ctx) {
  if (!env.JOB_FEEDBACK_SECRET) return text("Not found", 404);
  const current = await status(env);
  if (!selfService(current)) return text("Not found", 404);
  const url = new URL(request.url);
  const path = url.pathname;
  const post = request.method === "POST";
  if (path === `${ME_URL}/link` && post) return askLink(request, env, ctx);
  if (path === `${ME_URL}/login` && request.method === "GET") return loginPage(request, env);
  if (path === `${ME_URL}/login` && post) return spend(request, env, current);
  const s = await meSession(request, env, current);
  if (!s) return path === ME_URL && request.method === "GET" ? askPage(request, env) : post ? page(...EXPIRED_FORM) : redirect(ME_URL);
  if (path === ME_URL && request.method === "GET") return jobsPage(env, s, current);
  if (path === `${ME_URL}/search` && request.method === "GET") {
    return searchPage(s, current, await queued(env), url.searchParams.get("done") || "");
  }
  if (path === `${ME_URL}/search` && post) return saveSearch(request, env, s, current);
  if (path === `${ME_URL}/docs` && request.method === "GET") return docsPage(env, s, current, url.searchParams.get("done") || "");
  if (path === `${ME_URL}/doc` && request.method === "GET") {
    const [kind, h] = ["k", "h"].map((k) => url.searchParams.get(k) || "");
    const doc = DOC_KINDS[kind] && /^[0-9a-f]{32}$/.test(h) ? await readDoc(env, s.u, kind, h) : null;
    return doc ? docResponse(doc, url.searchParams.get("f") || "pdf") : redirect(`${ME_URL}/docs?done=gone`);
  }
  if (path === `${ME_URL}/cv` && request.method === "GET") {
    const doc = await readProfileCv(env, s.u);
    return doc ? docResponse(doc) : redirect(`${ME_URL}/docs?done=gone`);
  }
  if (path === `${ME_URL}/cv` && post) return makeCv(request, env, s, current);
  if (path === `${ME_URL}/logout` && post) return logout(request, env, s);
  if (path === `${ME_URL}/unsubscribe` && post) return unsubscribe(request, env, s);
  return text("Not found", 404);
}

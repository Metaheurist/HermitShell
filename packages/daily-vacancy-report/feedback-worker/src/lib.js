// Shared helpers: signing, escaping, pages, JSON responses, KV layout and Cloudflare Access.

const encoder = new TextEncoder();

export const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
export const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";
export const DAY_MS = 86400000;
// Links in emails stop working after this many days.
export const LINK_DAYS = 90;
export const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const hmacKeys = new Map();

export async function hmacHex(secret, message) {
  let cryptoKey = hmacKeys.get(secret);
  if (!cryptoKey) {
    cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    if (hmacKeys.size > 8) hmacKeys.clear();
    hmacKeys.set(secret, cryptoKey);
  }
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function today() {
  return Math.floor(Date.now() / DAY_MS);
}

// Same message as job_tracker.sign() in Python: a fixed list of fields, empty ones included. Fields may
// not contain control characters (validLink rejects them), so every message has exactly one reading.
export async function sign(secret, key, action, title, skills = "", profile = "", day = "") {
  const message = ["v2", key, action, title, skills, profile, String(day)].join("\n");
  return (await hmacHex(secret, message)).slice(0, 32);
}

// Events are stored per profile ("_" is the owner) with one "something is waiting" flag each.
export function eventPrefix(profile) {
  return `event:${profile || "_"}:`;
}

export function eventFlag(profile) {
  return `flag:events:${profile || "_"}`;
}

export async function setFlag(env, flag, ttl) {
  if (!(await env.FEEDBACK.get(flag))) await env.FEEDBACK.put(flag, "1", { expirationTtl: ttl });
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Compares secrets of any length in constant time by comparing their HMACs.
export async function secretEqual(key, given, expected) {
  return safeEqual(await hmacHex(key, String(given ?? "")), await hmacHex(key, String(expected ?? "")));
}

export function authorised(request, env) {
  const header = request.headers.get("Authorization") || "";
  return Boolean(env.JOB_FEEDBACK_API_TOKEN) && safeEqual(header, `Bearer ${env.JOB_FEEDBACK_API_TOKEN}`);
}

export function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function newId() {
  return crypto.randomUUID().replaceAll("-", "");
}

function validMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 && n < 8.64e15 ? n : null;
}

function zoned(n, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(n).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

// A time in the owner's timezone (HERMES_TIMEZONE, as HermitShell reports it), or UTC if that isn't valid.
export function when(ms, timeZone = "UTC") {
  const n = validMs(ms);
  if (n === null) return "never";
  try {
    return zoned(n, timeZone || "UTC");
  } catch {
    return zoned(n, "UTC");
  }
}

export function ago(ms, now = Date.now()) {
  const n = validMs(ms);
  if (n === null) return "never";
  const seconds = Math.round((now - n) / 1000);
  const size = Math.abs(seconds);
  if (size < 60) return "just now";
  const [value, unit] = size < 3600 ? [Math.round(size / 60), "minute"] : size < 86400 ? [Math.round(size / 3600), "hour"]
    : [Math.round(size / 86400), "day"];
  const span = `${value} ${unit}${value === 1 ? "" : "s"}`;
  return seconds < 0 ? `in ${span}` : `${span} ago`;
}

// Pages may not load scripts, fonts or images (see CSP), so the look and the motion are CSS only, and
// every animation stops for people who ask their system for reduced motion.
const STYLE = `
:root{--ink:#0f172a;--text:#334155;--muted:#64748b;--line:#e5e8f0;--field:#fbfcfe;--brand:#6366f1;--brand2:#8b5cf6;
--brand-ink:#4338ca;--soft:#eef0ff;--ok:#059669;--ok-bg:#ecfdf5;--ok-line:#a7f3d0;--todo:#b45309;--todo-bg:#fffbeb;
--todo-line:#fde68a;--bad:#dc2626;--bad-bg:#fef2f2;--bad-line:#fecaca;--ease:cubic-bezier(.2,.8,.2,1)}
*{box-sizing:border-box}
html{background:#eef1f7}
body{margin:0;min-height:100vh;font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--ink);
-webkit-font-smoothing:antialiased;position:relative;overflow-x:hidden}
body::before,body::after{content:"";position:absolute;z-index:-1;width:900px;height:900px;pointer-events:none;
animation:drift 26s ease-in-out infinite alternate}
body::before{top:-480px;left:-380px;background:radial-gradient(closest-side,rgba(165,180,252,.55),rgba(165,180,252,0))}
body::after{top:-420px;right:-400px;background:radial-gradient(closest-side,rgba(216,180,254,.5),rgba(216,180,254,0));
animation-duration:32s;animation-direction:alternate-reverse}
main{max-width:480px;margin:56px auto;background:rgba(255,255,255,.94);border:1px solid rgba(226,232,240,.9);border-radius:22px;padding:32px;
box-shadow:0 1px 2px rgba(15,23,42,.04),0 18px 50px -18px rgba(30,27,75,.18);animation:rise .5s var(--ease) both}
main.wide{max-width:900px}
.eyebrow{display:flex;align-items:center;gap:9px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:750;
color:var(--brand-ink)}
.eyebrow::before{content:"";width:20px;height:20px;border-radius:7px;background:linear-gradient(135deg,var(--brand),var(--brand2));
box-shadow:0 4px 12px -3px rgba(99,102,241,.7),inset 0 1px 0 rgba(255,255,255,.35)}
h1{font-size:27px;line-height:1.2;letter-spacing:-.025em;margin:14px 0 6px;font-weight:750}
h2{font-size:16px;letter-spacing:-.01em;margin:32px 0 10px;font-weight:700}
p{color:var(--text);margin:10px 0}
a{color:var(--brand-ink);text-underline-offset:3px;text-decoration-thickness:1px;transition:color .15s}a:hover{color:var(--brand2)}
label{display:block;font-size:13.5px;font-weight:650;margin:16px 0 6px;color:var(--ink)}
textarea,select,input:not([type=checkbox]):not([type=hidden]):not([type=submit]):not([type=file]){width:100%;border:1px solid var(--line);
border-radius:12px;padding:11px 13px;font:inherit;color:var(--ink);background:var(--field);
transition:border-color .15s,box-shadow .15s,background .15s}
input[type=file]{width:100%;font:inherit;font-size:14px;color:var(--muted);padding:10px;border:1px dashed #cdd3e1;border-radius:12px;
background:var(--field);transition:border-color .15s,background .15s}
input[type=file]:hover{border-color:var(--brand);background:#fff}
input[type=file]::file-selector-button{font:inherit;font-size:13px;font-weight:650;border:0;border-radius:9px;padding:7px 12px;
margin-right:12px;background:var(--soft);color:var(--brand-ink);cursor:pointer}
textarea:hover,select:hover,input:not([type=checkbox]):not([type=file]):hover{border-color:#c9cfe0}
textarea:focus,select:focus,input:not([type=checkbox]):focus{outline:0;border-color:var(--brand);background:#fff;
box-shadow:0 0 0 4px rgba(99,102,241,.15)}
textarea{min-height:92px;resize:vertical}
input::placeholder,textarea::placeholder{color:#9aa4b6}
input[type=checkbox]{width:17px;height:17px;margin:2px 0 0;accent-color:var(--brand);flex:none;cursor:pointer}
button{margin-top:18px;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;border:0;border-radius:12px;padding:12px 22px;
font:inherit;font-size:15px;font-weight:650;cursor:pointer;box-shadow:0 8px 20px -8px rgba(99,102,241,.75),inset 0 1px 0 rgba(255,255,255,.2);
transition:transform .15s var(--ease),box-shadow .15s,filter .15s}
button:hover{transform:translateY(-1px);filter:brightness(1.05);box-shadow:0 12px 26px -10px rgba(99,102,241,.85)}
button:active{transform:translateY(0) scale(.98)}
button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid rgba(99,102,241,.35);outline-offset:2px}
button.small{margin:0;padding:7px 13px;font-size:13px;border-radius:10px}
button.quiet{background:var(--soft);color:var(--brand-ink);box-shadow:none}button.quiet:hover{background:#e2e5ff;filter:none}
button.danger{background:linear-gradient(135deg,#ef4444,#dc2626);box-shadow:0 8px 18px -10px rgba(220,38,38,.8)}
.skill{display:block;margin:0 0 10px;padding:11px 13px;border:1px solid var(--todo-line);background:var(--todo-bg);border-radius:12px;
color:#92400e;font-weight:600;cursor:pointer;transition:transform .15s var(--ease),box-shadow .15s}
.skill:hover{transform:translateY(-1px);box-shadow:0 6px 16px -10px rgba(180,83,9,.5)}
.skill input{margin-right:8px}.check{font-weight:450;display:flex;gap:9px;align-items:flex-start;cursor:pointer}
.check span{color:var(--text)}
table.list{width:100%;border-collapse:separate;border-spacing:0;font-size:14px;margin-top:6px}
table.list th{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:650;padding:0 12px 10px;text-align:left}
table.list td{border-top:1px solid var(--line);padding:16px 12px;text-align:left;vertical-align:top;transition:background .2s}
table.list tr:hover td{background:rgba(238,240,255,.45)}
.who{display:flex;gap:12px;align-items:flex-start}
.avatar{flex:none;width:38px;height:38px;border-radius:12px;display:grid;place-items:center;color:#fff;font-weight:700;font-size:14px;
background:linear-gradient(135deg,var(--brand),var(--brand2));box-shadow:0 6px 14px -8px rgba(99,102,241,.9)}
.muted{color:var(--muted);font-size:13px}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:99px;padding:3px 10px;font-size:12px;font-weight:650;
background:var(--soft);color:var(--brand-ink)}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.paused{background:#fef3c7;color:#92400e}.pill.owner{background:var(--ok-bg);color:#047857}
.inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.inline input:not([type=checkbox]){width:auto;flex:1;min-width:170px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:0 16px}
.checks{display:flex;gap:8px;flex-wrap:wrap}
.checks .check{margin:2px 0;padding:8px 13px;border:1px solid var(--line);border-radius:99px;background:var(--field);font-size:14px;
align-items:center;transition:border-color .15s,background .15s}
.checks .check:hover{border-color:#c9cfe0}.checks .check:has(input:checked){border-color:#c7d2fe;background:var(--soft)}
.progress{height:8px;border-radius:99px;background:#eceef6;overflow:hidden;margin:4px 0 6px}
.progress span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--brand),var(--brand2));
animation:fill 1s var(--ease) both .15s}
ul.steps{list-style:none;padding:0;margin:12px 0 22px;display:grid;gap:8px}
ul.steps li{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border:1px solid;border-radius:14px;font-size:14px;
animation:rise .45s var(--ease) both}
ul.steps li:nth-child(2){animation-delay:.05s}ul.steps li:nth-child(3){animation-delay:.1s}ul.steps li:nth-child(4){animation-delay:.15s}
ul.steps li:nth-child(5){animation-delay:.2s}ul.steps li:nth-child(6){animation-delay:.25s}
ul.steps li.done{background:var(--ok-bg);border-color:var(--ok-line);color:#047857}
ul.steps li.todo{background:var(--todo-bg);border-color:var(--todo-line);color:#92400e}
ul.steps .muted{margin-top:2px}
.tick{flex:none;width:22px;height:22px;border-radius:50%;margin-top:-1px;position:relative}
li.done .tick{background:var(--ok);box-shadow:0 4px 10px -4px rgba(5,150,105,.8)}
li.done .tick::after{content:"";position:absolute;left:7.5px;top:4px;width:5px;height:10px;border:solid #fff;border-width:0 2px 2px 0;
transform:rotate(45deg)}
li.todo .tick{border:2px solid #f59e0b;animation:pulse 2.2s ease-out infinite}
.warn{background:var(--bad-bg);border:1px solid var(--bad-line);border-left:4px solid var(--bad);color:#991b1b;border-radius:12px;
padding:12px 16px;font-size:14px;margin:0 0 16px;animation:rise .4s var(--ease) both}
.warn p{color:inherit}.warn ul{margin:6px 0 0;padding-left:18px}
.note{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border:1px solid;border-radius:12px;font-size:14px;font-weight:550;
margin:0 0 16px;animation:drop .45s var(--ease) both}
.note::before{flex:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:800}
.note.ok{background:var(--ok-bg);border-color:var(--ok-line);color:#065f46}.note.ok::before{content:"\\2713";background:var(--ok)}
.note.bad{background:var(--bad-bg);border-color:var(--bad-line);color:#991b1b}.note.bad::before{content:"!";background:var(--bad)}
a.small{font-size:13px;font-weight:650;text-decoration:none}a.small:hover{text-decoration:underline}
.hint{display:block;margin-top:6px;font-size:12.5px;color:var(--muted);line-height:1.45}
a.back{position:fixed;top:20px;left:20px;z-index:10;display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.92);
color:var(--brand-ink);border:1px solid var(--line);border-radius:12px;
padding:9px 15px;font-size:14px;font-weight:650;text-decoration:none;box-shadow:0 8px 24px -12px rgba(15,23,42,.25);
transition:transform .18s var(--ease),box-shadow .18s,background .18s;animation:drop .45s var(--ease) both}
a.back:hover{transform:translateX(-2px);background:#fff;box-shadow:0 12px 28px -12px rgba(15,23,42,.3)}
@media (max-width:1240px){a.back{top:10px;left:10px;padding:7px 12px;font-size:13px}}
nav.tabs{display:inline-flex;gap:2px;margin:10px 0 24px;padding:4px;background:#f0f2f8;border:1px solid var(--line);border-radius:14px}
nav.tabs a{padding:7px 16px;font-size:14px;font-weight:650;color:var(--muted);text-decoration:none;border-radius:10px;
transition:color .15s,background .2s,box-shadow .2s}
nav.tabs a:hover{color:var(--ink)}
nav.tabs a.on{color:var(--brand-ink);background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.1),0 1px 1px rgba(15,23,42,.04)}
iframe.saving{display:block;width:100%;height:44px;border:0;border-radius:12px;margin:0 0 18px;animation:drop .45s var(--ease) both}
code.link{display:block;word-break:break-all;background:#f7f8fc;border:1px solid var(--line);border-radius:12px;padding:12px 14px;
font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink)}
.signout{margin-top:32px}
@keyframes rise{from{opacity:0;transform:translateY(10px)}}
@keyframes drop{from{opacity:0;transform:translateY(-6px)}}
@keyframes fill{from{width:0}}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(245,158,11,.45)}70%,100%{box-shadow:0 0 0 8px rgba(245,158,11,0)}}
@keyframes drift{to{transform:translate(120px,80px) scale(1.12)}}
@media (max-width:560px){main{margin:16px;padding:24px 20px;border-radius:18px}h1{font-size:23px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

export function note(text, kind = "ok") {
  return `<p class="note ${kind}" role="status">${esc(text)}</p>`;
}

// `before` goes outside the card: main's entrance animation would otherwise pin a fixed element to the card.
export function page(heading, body, { status = 200, wide = false, headers = {}, before = "" } = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(heading)}</title><style>${STYLE}</style></head><body>${before}<main${wide ? ' class="wide"' : ""}>
<div class="eyebrow">HermitShell</div><h1>${esc(heading)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CSP,
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

// Free-plan KV allows 1,000 list operations a day, so polling reads a flag key (set when something
// is stored) and only lists when it is set or when ?full=1 asks for a real listing.
export async function listFlagged(env, request, prefix, flag, limit) {
  if (new URL(request.url).searchParams.get("full") !== "1" && !(await env.FEEDBACK.get(flag))) return [];
  const listed = await env.FEEDBACK.list({ prefix, limit });
  return (await Promise.all(listed.keys.map((k) => env.FEEDBACK.get(k.name, "json")))).filter(Boolean);
}

export async function deleteAndUnflag(env, ids, prefix, flag) {
  await Promise.all(ids.map((id) => env.FEEDBACK.delete(id)));
  if (ids.length && !(await env.FEEDBACK.list({ prefix, limit: 1 })).keys.length) await env.FEEDBACK.delete(flag);
}

// An extra profile that unsubscribes or is deleted: its answers not yet collected by HermitShell are dropped.
export async function purgeProfileEvents(env, profile) {
  if (!profile) return;
  let cursor;
  do {
    const listed = await env.FEEDBACK.list({ prefix: eventPrefix(profile), cursor });
    await Promise.all(listed.keys.map((k) => env.FEEDBACK.delete(k.name)));
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  await env.FEEDBACK.delete(eventFlag(profile));
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
  });
}

export function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS, ...headers } });
}

export function redirect(location, headers = {}) {
  return new Response(null, { status: 303, headers: { Location: location, ...SECURITY_HEADERS, ...headers } });
}

// The request body, read up to `max` bytes; null when it is larger.
async function limitedBytes(request, max) {
  if (Number(request.headers.get("Content-Length")) > max) return null;
  const chunks = [];
  let total = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      reader.releaseLock();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  chunks.reduce((offset, chunk) => (body.set(chunk, offset), offset + chunk.byteLength), 0);
  return body;
}

// The request's form: null when the body is larger than `max`, an empty form when it is not a form.
export async function limitedForm(request, max) {
  const body = await limitedBytes(request, max);
  if (!body) return null;
  try {
    return await new Response(body, { headers: { "Content-Type": request.headers.get("Content-Type") || "" } }).formData();
  } catch {
    return new FormData();
  }
}

// The request's JSON: null when the body is larger than `max`, undefined when it is not JSON.
export async function limitedJson(request, max) {
  const body = await limitedBytes(request, max);
  if (!body) return null;
  try {
    return JSON.parse(new TextDecoder().decode(body) || "{}");
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------------- Cloudflare Access

let accessCerts = { url: "", at: 0, keys: [] };

function b64url(part) {
  return Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

async function certs(team) {
  const url = `https://${team}/cdn-cgi/access/certs`;
  if (accessCerts.url !== url || Date.now() - accessCerts.at > 3600000) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Access certs HTTP ${resp.status}`);
    accessCerts = { url, at: Date.now(), keys: (await resp.json()).keys || [] };
  }
  return accessCerts.keys;
}

async function verifyAccessJwt(token, env) {
  const [head, body, sig] = String(token || "").split(".");
  if (!head || !body || !sig) return null;
  const header = JSON.parse(new TextDecoder().decode(b64url(head)));
  const jwk = header.alg === "RS256" && (await certs(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), encoder.encode(`${head}.${body}`)))) return null;
  const claims = JSON.parse(new TextDecoder().decode(b64url(body)));
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = Date.now() / 1000;
  if (!aud.includes(env.ACCESS_AUD) || claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}` || !(claims.exp > now) ||
      (claims.nbf && claims.nbf > now + 60)) return null;
  return claims.email || claims.sub || "access";
}

// The signed-in Cloudflare Access user for this request, or null. Only used when ACCESS_AUD is set.
export async function accessUser(request, env, ctx) {
  try {
    if (ctx?.access) {
      const aud = Array.isArray(ctx.access.aud) ? ctx.access.aud : [ctx.access.aud];
      if (aud.includes(env.ACCESS_AUD)) return (await ctx.access.getIdentity())?.email || "access";
    }
    return env.ACCESS_TEAM_DOMAIN ? await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), env) : null;
  } catch (err) {
    console.error(`Access check failed: ${err.message}`);
    return null;
  }
}

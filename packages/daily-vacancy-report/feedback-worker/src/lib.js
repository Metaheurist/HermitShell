// Shared helpers: signing, escaping, pages, JSON responses, KV layout and Cloudflare Access.

const encoder = new TextEncoder();

export const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
export const CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'";

// The HermitShell mark: a spiral shell on the brand's indigo-to-violet tile, lit from the top left like the buttons.
// It is the tab icon and sits next to "HermitShell" on every page (inline there, so pages load nothing more).
const SHELL = "M25.7 32.8C25.5 32.1 24.5 29.9 24.5 28.3C24.4 26.8 24.7 25 25.4 23.5C26.1 22 27.2 20.4 28.5 19.2C29.9 18.1 31.7 17.1 33.5 16.6"
  + "C35.3 16.2 37.5 16 39.4 16.4C41.4 16.8 43.5 17.7 45.2 19C46.9 20.2 48.6 22.1 49.6 24.1C50.7 26.1 51.4 28.6 51.5 31"
  + "C51.5 33.4 51.1 36.2 50 38.5C49 40.9 47.3 43.3 45.2 45.1C43.1 46.8 40.4 48.4 37.5 49.1C34.7 49.8 31.4 50.1 28.3 49.5"
  + "C25.3 48.9 22 47.5 19.3 45.5C16.7 43.5 13.6 38.9 12.5 37.6Z";
const WHORL = "M32 25.5C32.4 25.2 33.4 24.4 34.2 24.1C35 23.9 36.1 23.8 37 24C37.9 24.2 38.9 24.7 39.6 25.3C40.4 26 41.1 26.9 41.5 27.9"
  + "C41.8 28.9 42 30.2 41.8 31.3C41.7 32.4 41.2 33.7 40.4 34.7C39.7 35.7 38.6 36.6 37.4 37.2C36.1 37.7 34.6 38 33.2 37.9"
  + "C31.8 37.7 30.2 37.2 28.9 36.4C27.7 35.5 26.2 33.4 25.7 32.8";

function brandMark(id, attrs) {
  return `<svg ${attrs} viewBox="0 0 64 64"><defs><linearGradient id="${id}t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient>`
    + `<radialGradient id="${id}l" cx=".28" cy=".18" r=".85"><stop offset="0" stop-color="#fff" stop-opacity=".32"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></radialGradient>`
    + `<linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#e0e7ff"/></linearGradient></defs>`
    + `<rect width="64" height="64" rx="18" fill="url(#${id}t)"/><rect width="64" height="64" rx="18" fill="url(#${id}l)"/>`
    + `<rect x=".75" y=".75" width="62.5" height="62.5" rx="17.25" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="1.5"/>`
    + `<path d="${SHELL}" fill="#312e81" fill-opacity=".28" transform="translate(0 1.6)"/><path d="${SHELL}" fill="url(#${id}s)"/>`
    + `<path d="${WHORL}" fill="none" stroke="#6366f1" stroke-width="3" stroke-linecap="round"/></svg>`;
}

export const FAVICON = brandMark("", 'xmlns="http://www.w3.org/2000/svg"');
export const BRAND_MARK = brandMark("hs-", 'class="mark" aria-hidden="true" focusable="false"');

const LINE_ICON = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
export const EXTERNAL_ICON = `<svg class="ext" ${LINE_ICON}><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>`;
export const BACK_TO_RECRUITS = `<a class="back" href="/admin"><svg ${LINE_ICON}><path d="M19 12H5M11 6l-6 6 6 6"/></svg>Back to recruits</a>`;

export const PROFILE_RE = /^[a-z0-9-]{1,40}$/;
export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

// A 32-bit FNV-1a hash as 8 hex digits: for cache-busting URLs, never for security.
export function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export function hidden(fields) {
  return Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");
}

// `paint` repaints its colours for the theme (theme.js).
export function favicon(paint = null) {
  return new Response(paint ? paint(FAVICON) : FAVICON, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      ...SECURITY_HEADERS,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
export const DAY_MS = 86400000;
// Links in emails stop working after this many days.
export const LINK_DAYS = 90;
export const CONTROL_RE = /[\u0000-\u001f\u007f]/;
export const MAX_SKILL = 60;

// A skill as HermitShell keeps it (job_tracker.clean_skill): letters, numbers and a few signs, one space apart.
export function cleanSkill(text) {
  return String(text ?? "").replace(/[^\p{L}\p{N}_ .+#/&()-]/gu, "").split(/\s+/).filter(Boolean).join(" ")
    .slice(0, MAX_SKILL).trim();
}

const hmacKeys = new Map();

export async function hmacHex(secret, message) {
  let cryptoKey = hmacKeys.get(secret);
  if (!cryptoKey) {
    cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    if (hmacKeys.size > 8) hmacKeys.clear();
    hmacKeys.set(secret, cryptoKey);
  }
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return hex(mac);
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return hex(digest);
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

// Events are stored per profile ("_" for links in the main admin's reports from before they were staff only) with
// one "something is waiting" flag each.
export function eventPrefix(profile) {
  return `event:${profile || "_"}:`;
}

export function eventFlag(profile) {
  return `flag:events:${profile || "_"}`;
}

// A flag holds when it was last set, so a flag left on after its items went can be told from one just set.
export async function setFlag(env, flag, ttl) {
  await env.FEEDBACK.put(flag, String(Date.now()), { expirationTtl: ttl });
}

// KV lists can lag deletes by about a minute: an empty listing only proves nothing is waiting once the flag was last
// set longer ago than that.
const FLAG_SETTLE_MS = 2 * 60 * 1000;

function flagAge(value, now) {
  const at = /^\d{12,}$/.test(value) ? Number(value) : Number((/^queue:(\d{12,}):/.exec(value) || [])[1] || 0);
  return now - at;
}

// Read the items under a set flag; a flag with nothing left under it, set long enough ago, is taken down so the
// next poll costs one read again instead of a list.
export async function flaggedItems(env, prefix, flag, limit, value, now = Date.now()) {
  const listed = await env.FEEDBACK.list({ prefix, limit });
  const items = (await Promise.all(listed.keys.map((k) => env.FEEDBACK.get(k.name, "json")))).filter(Boolean);
  if (!items.length && value && flagAge(value, now) > FLAG_SETTLE_MS) await env.FEEDBACK.delete(flag);
  return items;
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
--todo-line:#fde68a;--bad:#dc2626;--bad-bg:#fef2f2;--bad-line:#fecaca;--ease:cubic-bezier(.2,.8,.2,1);
--ease-spring:cubic-bezier(.3,1.4,.5,1);--t-fast:.15s;--t-med:.25s;--t-enter:.45s}
[id]{scroll-margin-top:84px}
*{box-sizing:border-box}
html{background:#eef1f7}
body{margin:0;min-height:100vh;font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--ink);
-webkit-font-smoothing:antialiased;position:relative;overflow-x:hidden}
body::before,body::after{content:"";position:absolute;z-index:-1;width:900px;height:900px;pointer-events:none;
animation:drift 26s ease-in-out infinite alternate;animation-delay:var(--drift,0s)}
body::before{top:-480px;left:-380px;background:radial-gradient(closest-side,rgba(165,180,252,.55),rgba(165,180,252,0))}
body::after{top:-420px;right:-400px;background:radial-gradient(closest-side,rgba(216,180,254,.5),rgba(216,180,254,0));
animation-duration:32s;animation-direction:alternate-reverse}
main{max-width:480px;margin:56px auto;background:rgba(255,255,255,.94);border:1px solid rgba(226,232,240,.9);border-radius:22px;padding:32px;
box-shadow:0 1px 2px rgba(15,23,42,.04),0 18px 50px -18px rgba(30,27,75,.18)}
body:has(.modal:target)::before,body:has(.modal:target)::after{animation-play-state:paused}
main.wide{max-width:900px}
main.full{max-width:min(1320px,calc(100vw - 48px))}
.eyebrow{display:flex;align-items:center;gap:9px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:750;
color:var(--brand-ink)}
.eyebrow svg.mark{flex:none;width:24px;height:24px;border-radius:7px;box-shadow:0 3px 8px -4px rgba(79,70,229,.6)}
h1{font-size:27px;line-height:1.2;letter-spacing:-.025em;margin:14px 0 6px;font-weight:750}
h2{font-size:16px;letter-spacing:-.01em;margin:32px 0 10px;font-weight:700}
p{color:var(--text);margin:10px 0}
a{color:var(--brand-ink);text-underline-offset:3px;text-decoration-thickness:1px;transition:color var(--t-fast)}a:hover{color:var(--brand2)}
label{display:block;font-size:13.5px;font-weight:650;margin:16px 0 6px;color:var(--ink)}
textarea,select,input:not([type=checkbox]):not([type=hidden]):not([type=submit]):not([type=file]){width:100%;border:1px solid var(--line);
border-radius:12px;padding:11px 13px;font:inherit;color:var(--ink);background:var(--field);
transition:border-color var(--t-fast),box-shadow var(--t-fast),background var(--t-fast)}
input[type=file]{width:100%;font:inherit;font-size:14px;color:var(--muted);padding:10px;border:1px dashed #cdd3e1;border-radius:12px;
background:var(--field);transition:border-color var(--t-fast),background var(--t-fast)}
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
transition:transform var(--t-fast) var(--ease),box-shadow var(--t-fast),filter var(--t-fast)}
button:hover{transform:translateY(-1px);filter:brightness(1.05);box-shadow:0 12px 26px -10px rgba(99,102,241,.85)}
button:active{transform:translateY(0) scale(.98)}
button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid rgba(99,102,241,.35);outline-offset:2px}
button.small{margin:0;padding:7px 13px;font-size:13px;border-radius:10px}
button.quiet{background:var(--soft);color:var(--brand-ink);box-shadow:none}button.quiet:hover{background:#e2e5ff;filter:none}
button.danger{background:linear-gradient(135deg,#ef4444,#dc2626);box-shadow:0 8px 18px -10px rgba(220,38,38,.8)}
.skill{display:block;margin:0 0 10px;padding:11px 13px;border:1px solid var(--todo-line);background:var(--todo-bg);border-radius:12px;
color:#92400e;font-weight:600;cursor:pointer;transition:transform var(--t-fast) var(--ease),box-shadow var(--t-fast)}
.skill:hover{transform:translateY(-1px);box-shadow:0 6px 16px -10px rgba(180,83,9,.5)}
.skill input{margin-right:8px}.check{font-weight:450;display:flex;gap:9px;align-items:flex-start;cursor:pointer}
.check span{color:var(--text)}
table.list{width:100%;border-collapse:separate;border-spacing:0;font-size:14px;margin-top:6px}
table.list th{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:650;padding:0 12px 10px;text-align:left}
table.list td{border-top:1px solid var(--line);padding:16px 12px;text-align:left;vertical-align:top;transition:background .2s}
table.list tr:hover td{background:rgba(238,240,255,.45)}
table.list.stack td:last-child{width:1%;white-space:nowrap}table.list.stack .pill{white-space:nowrap}
@media (max-width:900px){table.list.stack,table.list.stack tbody{display:block}table.list.stack tr.head{display:none}
table.list.stack tr{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0 16px;border-top:1px solid var(--line);padding:8px 0}
table.list.stack td,table.list.stack td:last-child{display:block;width:auto;border:0;padding:8px 10px;white-space:normal}
table.list.stack td:first-child,table.list.stack td:last-child,table.list.stack td[colspan]{grid-column:1/-1}}
.who{display:flex;gap:12px;align-items:flex-start}
.avatar{flex:none;width:38px;height:38px;border-radius:12px;display:grid;place-items:center;color:#fff;font-weight:700;font-size:14px;
background:linear-gradient(135deg,var(--brand),var(--brand2));box-shadow:0 6px 14px -8px rgba(99,102,241,.9)}
.muted{color:var(--muted);font-size:13px}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:99px;padding:3px 10px;font-size:12px;font-weight:650;
background:var(--soft);color:var(--brand-ink)}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.paused{background:#fef3c7;color:#92400e}
.pill.scanning{background:#eef0ff;color:#4338ca}.pill.scanning::before{animation:blink .9s ease-in-out var(--phase,0s) infinite alternate}
button:disabled{opacity:.55;cursor:default;transform:none;filter:none;box-shadow:none}
.actions{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.live{position:relative;display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ok);margin-right:8px;
vertical-align:1px}
.live::after{content:"";position:absolute;inset:0;border-radius:50%;background:var(--ok);animation:ripple 2s ease-out var(--phase,0s) infinite}
.inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.inline input:not([type=checkbox]){width:auto;flex:1;min-width:170px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:0 16px}
.checks{display:flex;gap:8px;flex-wrap:wrap}
.checks .check{margin:2px 0;padding:8px 13px;border:1px solid var(--line);border-radius:99px;background:var(--field);font-size:14px;
align-items:center;transition:border-color var(--t-fast),background var(--t-fast)}
.checks .check:hover{border-color:#c9cfe0}.checks .check:has(input:checked){border-color:#c7d2fe;background:var(--soft)}
.progress{height:8px;border-radius:99px;background:#eceef6;overflow:hidden;margin:4px 0 6px}
.progress span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--brand),var(--brand2));
transform-origin:left;animation:fill 1s var(--ease) both var(--t-fast)}
ul.steps{list-style:none;padding:0;margin:12px 0 22px;display:grid;gap:8px}
ul.steps li{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border:1px solid;border-radius:14px;font-size:14px;
animation:rise var(--t-enter) var(--ease) both}
ul.steps li:nth-child(2){animation-delay:.05s}ul.steps li:nth-child(3){animation-delay:.1s}ul.steps li:nth-child(4){animation-delay:.15s}
ul.steps li:nth-child(5){animation-delay:.2s}ul.steps li:nth-child(6){animation-delay:.25s}
ul.steps li.done{background:var(--ok-bg);border-color:var(--ok-line);color:#047857}
ul.steps li.todo{background:var(--todo-bg);border-color:var(--todo-line);color:#92400e}
ul.steps .muted{margin-top:2px}
.tick{flex:none;width:22px;height:22px;border-radius:50%;margin-top:-1px;position:relative}
li.done .tick{background:var(--ok);box-shadow:0 4px 10px -4px rgba(5,150,105,.8)}
li.done .tick::after{content:"";position:absolute;left:7.5px;top:4px;width:5px;height:10px;border:solid #fff;border-width:0 2px 2px 0;
transform:rotate(45deg)}
li.todo .tick{border:2px solid #f59e0b}
li.todo .tick::before{content:"";position:absolute;inset:-2px;border-radius:50%;border:2px solid #f59e0b;
animation:ripple 2.2s ease-out var(--phase,0s) infinite}
.warn{background:var(--bad-bg);border:1px solid var(--bad-line);border-left:4px solid var(--bad);color:#991b1b;border-radius:12px;
padding:12px 16px;font-size:14px;margin:0 0 16px;animation:rise .4s var(--ease) both}
.warn p{color:inherit}.warn ul{margin:6px 0 0;padding-left:18px}
.note{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border:1px solid;border-radius:12px;font-size:14px;font-weight:550;
margin:0 0 16px;animation:drop var(--t-enter) var(--ease) both}
.note::before{flex:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:800}
.note.ok{background:var(--ok-bg);border-color:var(--ok-line);color:#065f46}.note.ok::before{content:"\\2713";background:var(--ok)}
.note.bad{background:var(--bad-bg);border-color:var(--bad-line);color:#991b1b}.note.bad::before{content:"!";background:var(--bad)}
a.small{font-size:13px;font-weight:650;text-decoration:none}a.small:hover{text-decoration:underline}
.hint{display:block;margin-top:6px;font-size:12.5px;color:var(--muted);line-height:1.45}
a.back{position:fixed;top:20px;left:20px;z-index:10;display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.92);
color:var(--brand-ink);border:1px solid var(--line);border-radius:12px;
padding:9px 15px;font-size:14px;font-weight:650;text-decoration:none;box-shadow:0 8px 24px -12px rgba(15,23,42,.25);
transition:transform .18s var(--ease),box-shadow .18s,background .18s}
a.back:hover{transform:translateX(-2px);background:#fff;box-shadow:0 12px 28px -12px rgba(15,23,42,.3)}
a.back svg{flex:none;width:16px;height:16px;transition:transform .18s var(--ease)}a.back:hover svg{transform:translateX(-2px)}
svg.ext{display:inline-block;width:13px;height:13px;margin-left:3px;vertical-align:-2px;flex:none}
@media (max-width:1240px){a.back{top:10px;left:10px;padding:7px 12px;font-size:13px}}
nav.tabs{display:inline-flex;gap:2px;margin:10px 0 24px;padding:4px;background:#f0f2f8;border:1px solid var(--line);border-radius:14px}
nav.tabs a{padding:7px 16px;font-size:14px;font-weight:650;color:var(--muted);text-decoration:none;border-radius:10px;
transition:color var(--t-fast),background .2s,box-shadow .2s}
nav.tabs a:hover{color:var(--ink)}
nav.tabs a.on{color:var(--brand-ink);background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.1),0 1px 1px rgba(15,23,42,.04)}
iframe.saving{display:block;width:100%;height:44px;border:0;border-radius:12px;margin:0 0 18px;animation:drop var(--t-enter) var(--ease) both}
code.link{display:block;word-break:break-all;background:#f7f8fc;border:1px solid var(--line);border-radius:12px;padding:12px 14px;
font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink)}
.signout{margin-top:32px}
.waitbar{display:flex;gap:10px;align-items:center;padding:11px 14px;margin:0 0 16px;border:1px solid #c7d2fe;border-radius:12px;
background:linear-gradient(90deg,#eef2ff,#f5f3ff);color:var(--brand-ink);font-size:14px}
.waitbar.late{border-color:#fde68a;background:var(--todo-bg);color:#92400e}
.spinner{flex:none;width:16px;height:16px;box-sizing:border-box;border-radius:50%;border:2.5px solid rgba(99,102,241,.25);
border-top-color:var(--brand);animation:spin .8s linear var(--phase,0s) infinite}
.savingtag{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;color:#c2410c;background:#fff7ed;
border-radius:99px;padding:1px 8px;vertical-align:1px}
.savingtag::before{content:"";width:6px;height:6px;border-radius:50%;background:#f97316;animation:blink .8s ease-in-out var(--phase,0s) infinite alternate}
body.still *,body.still *::before,body.still *::after{animation-delay:calc(var(--phase,0s) - 60s)!important}
@media (pointer:coarse){.skills.gap button{position:relative}.skills.gap button::after{content:"";position:absolute;inset:-9px -2px}
.x{min-width:44px;min-height:44px}.mebtn{min-width:40px;min-height:40px}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes rise{from{opacity:0;transform:translateY(10px)}}
@keyframes drop{from{opacity:0;transform:translateY(-6px)}}
@keyframes fill{from{transform:scaleX(0)}}
@keyframes ripple{from{transform:scale(1);opacity:.55}70%,to{transform:scale(1.9);opacity:0}}
@keyframes drift{to{transform:translate(120px,80px) scale(1.12)}}
@keyframes blink{to{opacity:.25}}
@media (max-width:560px){main,main.full{max-width:none;margin:16px;padding:24px 20px;border-radius:18px}h1{font-size:23px}
nav.tabs{max-width:100%;overflow-x:auto;box-sizing:border-box}nav.tabs a{flex:none;padding:7px 9px;font-size:13px;white-space:nowrap}}
button.pressing{cursor:progress;opacity:.7}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

// Where the looping animations are now, from the clock: a page drawn a few seconds after the last one (a reload, the
// next page) carries its spinners, dots and background on from where they were instead of starting over. 792 s is a
// whole number of every short loop here (0.8 to 2.2 s), 832 s of the two background drifts (52 and 64 s there and back).
export function phaseStyle(now = Date.now()) {
  return `:root{--phase:-${((now % 792000) / 1000).toFixed(2)}s;--drift:-${((now % 832000) / 1000).toFixed(2)}s}`;
}

export function note(text, kind = "ok") {
  return `<p class="note ${kind}" role="status">${esc(text)}</p>`;
}

// While a change a page shows is waiting for HermitShell, the page reloads itself (pages run no scripts): every 4
// seconds for the first 45, then every 20 until the change is 5 minutes old. Then it stops, so an offline HermitShell
// doesn't use up the free plan's daily KV list operations. A reload keeps the address, its #section and the scroll.
export function waitRefresh(items, now = Date.now()) {
  if (!items.length) return 0;
  const age = now - Math.min(...items.map((i) => Number(i.at) || now));
  return age < 45000 ? 4 : age < 300000 ? 20 : 0;
}

export const APPLIED = "Applied by HermitShell. The page shows the change.";

// Where a page reloads to so it keeps its place at #section. Reloading its own address would not do: with a #section
// in it the browser only scrolls there, so `w` flips to make each reload a real one.
export function reloadTo(url, section) {
  const next = new URL(url);
  next.searchParams.set("w", next.searchParams.get("w") === "1" ? "2" : "1");
  return `${next.pathname}${next.search}#${section}`;
}

export function waitBar(what, refresh) {
  return refresh
    ? `<p class="waitbar" role="status"><span class="spinner" aria-hidden="true"></span><span><b>Saving.</b> Waiting for HermitShell to apply ${esc(what)}; this page updates by itself.</span></p>`
    : `<p class="waitbar late" role="status"><span><b>Still waiting for HermitShell</b> to apply ${esc(what)}. It may be offline or busy; reload the page to check again.</span></p>`;
}

export function savingTag(label = "saving") {
  return `<span class="savingtag">${esc(label)}&hellip;</span>`;
}

// Every page's shared styles, fetched once and then cached for good: the URL changes whenever they do.
export const STYLE_PATH = "/app.css";
export const STYLE_URL = `${STYLE_PATH}?v=${fnv(STYLE)}`;

export function stylesheet(paint = null) {
  return new Response(paint ? paint(STYLE) : STYLE, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// `before` goes outside the card: main's entrance animation would otherwise pin a fixed element to the card.
export function page(heading, body, { status = 200, wide = false, headers = {}, before = "", refresh = 0, refreshTo = "" } = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${
  refresh > 0 ? `<meta http-equiv="refresh" content="${Math.trunc(refresh)}${refreshTo ? `;url=${esc(refreshTo)}` : ""}">` : ""}
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>${phaseStyle()}</style><title>${esc(heading)}</title><link rel="stylesheet" href="${STYLE_URL}"></head><body${refresh > 0 ? ' class="still"' : ""}>${before}<main${wide === "full" ? ' class="wide full"' : wide ? ' class="wide"' : ""}>
<div class="eyebrow">${BRAND_MARK}HermitShell</div><h1>${esc(heading)}</h1>${body}</main></body></html>`;
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
  const value = await env.FEEDBACK.get(flag);
  if (new URL(request.url).searchParams.get("full") !== "1" && !value) return [];
  return flaggedItems(env, prefix, flag, limit, value);
}

export async function deleteAndUnflag(env, ids, prefix, flag) {
  await Promise.all(ids.map((id) => env.FEEDBACK.delete(id)));
  if (ids.length && !(await env.FEEDBACK.list({ prefix, limit: 1 })).keys.length) await env.FEEDBACK.delete(flag);
}

// Answers are kept until HermitShell collects them, for at most this long.
export const EVENT_TTL_SECONDS = 60 * 60 * 24 * 30;

// A cover letter or tailored CV kept for download (docs.js), and the list of those a profile has.
export function docKey(profile, kind, hash) {
  return `doc:${profile}:${kind}:${hash}`;
}

export function docIndexKey(profile) {
  return `docs:${profile}`;
}

// A recruit's own CV made from the one they uploaded (docs.js), and its file name and when it was made.
export function profileCvKey(profile) {
  return `cvpdf:${profile}`;
}

export function profileCvInfoKey(profile) {
  return `cvpdfinfo:${profile}`;
}

export function emailedKey(profile) {
  return `emailed:${profile}`;
}

export function skillAddKey(profile) {
  return `skilladd:${profile}`;
}

export function historyPrefix(profile) {
  return `history:${profile}:`;
}

async function deletePrefix(env, prefix) {
  let cursor;
  do {
    const listed = await env.FEEDBACK.list({ prefix, cursor });
    await Promise.all(listed.keys.map((k) => env.FEEDBACK.delete(k.name)));
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
}

// The last few days of every recruit's stats in one key, for the dashboard's sparklines: one read instead of one per
// recruit. Rewritten only when a recruit's days change; profiles.py sends stats one recruit at a time, so two updates
// never race. A recruit missing from it (stats sent before it existed) is read from "stats:<id>".
export const WEEKS_KEY = "statsweeks";
const WEEK_KEEP_DAYS = 9;

export async function rememberWeek(env, profile, stats, now = Date.now()) {
  const all = (await env.FEEDBACK.get(WEEKS_KEY, "json")) || {};
  const from = new Date(now - WEEK_KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const next = stats ? { days: Object.fromEntries(Object.entries(stats.days || {}).filter(([d]) => d >= from)) } : undefined;
  if (JSON.stringify(all[profile]) === JSON.stringify(next)) return;
  if (next) all[profile] = next;
  else delete all[profile];
  await env.FEEDBACK.put(WEEKS_KEY, JSON.stringify(all));
}

// The recent stats of each profile id, in order; null for none.
export async function recentStats(env, ids) {
  const all = (await env.FEEDBACK.get(WEEKS_KEY, "json")) || {};
  return Promise.all(ids.map((u) => !PROFILE_RE.test(u || "") ? null
    : Object.hasOwn(all, u) ? all[u] : env.FEEDBACK.get(`stats:${u}`, "json")));
}

// An extra profile that unsubscribes or is deleted: its answers not yet collected by HermitShell, its stats, its
// list of jobs sent, the skills added from it, the letters and CVs kept for download, their own CV and their history
// are dropped.
export async function purgeProfileEvents(env, profile) {
  if (!profile) return;
  const docs = await env.FEEDBACK.get(docIndexKey(profile), "json");
  await Promise.all((Array.isArray(docs) ? docs : []).filter((d) => d && /^[0-9a-f]{32}$/.test(d.h) && /^[a-z_]{1,20}$/.test(d.k))
    .map((d) => env.FEEDBACK.delete(docKey(profile, d.k, d.h))));
  await Promise.all([env.FEEDBACK.delete(docIndexKey(profile)), env.FEEDBACK.delete(emailedKey(profile)), env.FEEDBACK.delete(skillAddKey(profile)),
    env.FEEDBACK.delete(profileCvKey(profile)), env.FEEDBACK.delete(profileCvInfoKey(profile)),
    env.FEEDBACK.delete(`sent:${profile}`), env.FEEDBACK.delete(`stats:${profile}`), rememberWeek(env, profile, null)]);
  await Promise.all([deletePrefix(env, eventPrefix(profile)), deletePrefix(env, historyPrefix(profile))]);
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
export async function limitedBytes(request, max) {
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

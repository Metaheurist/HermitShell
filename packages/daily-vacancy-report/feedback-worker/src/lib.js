// Shared helpers: signing, escaping, pages, JSON responses, KV layout and Cloudflare Access.

const encoder = new TextEncoder();

export const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
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

export function when(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 && n < 8.64e15 ? new Date(n).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never";
}

const STYLE = `
body{margin:0;background:#eef1f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a}
main{max-width:460px;margin:48px auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px}
main.wide{max-width:880px}
.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#4f46e5;font-weight:700}
h1{font-size:22px;margin:8px 0 6px}h2{font-size:16px;margin:28px 0 8px}p{color:#475569;line-height:1.5}
label{display:block;font-size:14px;font-weight:600;margin:14px 0 4px}
textarea,input:not([type=checkbox]):not([type=hidden]):not([type=submit]){width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:10px;padding:10px;font:inherit}
textarea{min-height:80px}
button{margin-top:14px;background:#4f46e5;color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:15px;font-weight:600;cursor:pointer}
button.small{margin:0;padding:7px 12px;font-size:13px}button.quiet{background:#eef2ff;color:#3730a3}button.danger{background:#b91c1c}
.skill{display:block;margin:0 0 10px;padding:10px 12px;border:1px solid #fde68a;background:#fffbeb;border-radius:10px;color:#92400e;font-weight:600;cursor:pointer}
.skill input{margin-right:8px}.check{font-weight:400;display:flex;gap:8px;align-items:flex-start}
table.list{width:100%;border-collapse:collapse;font-size:14px}table.list td,table.list th{border-top:1px solid #e2e8f0;padding:10px 6px;text-align:left;vertical-align:top}
.muted{color:#64748b;font-size:13px}.pill{display:inline-block;border-radius:99px;padding:2px 9px;font-size:12px;font-weight:600;background:#eef2ff;color:#3730a3}
.pill.paused{background:#fef3c7;color:#92400e}.pill.owner{background:#ecfdf5;color:#047857}
.inline{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.inline input:not([type=checkbox]){width:auto;flex:1;min-width:160px}
select{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:10px;padding:10px;font:inherit;background:#fff}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 14px}
.checks{display:flex;gap:6px 18px;flex-wrap:wrap}.checks .check{margin:4px 0}
ul.steps{list-style:none;padding:0;margin:0 0 18px}ul.steps li{padding:8px 12px;border-radius:10px;margin-bottom:6px;font-size:14px}
ul.steps li.done{background:#ecfdf5;color:#047857}ul.steps li.todo{background:#fffbeb;color:#92400e}
.warn{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:10px;padding:10px 14px;font-size:14px;margin-bottom:14px}
.warn ul{margin:6px 0 0;padding-left:18px}a.small{font-size:13px;color:#4f46e5}
.hint{display:block;margin-top:5px;font-size:12px;color:#64748b;line-height:1.4}
a.back{position:fixed;top:20px;left:20px;z-index:10;display:inline-block;background:#fff;color:#3730a3;border:1px solid #e2e8f0;
border-radius:10px;padding:9px 14px;font-size:14px;font-weight:600;text-decoration:none;box-shadow:0 4px 14px rgba(15,23,42,.08)}
a.back:hover{background:#eef2ff}
@media (max-width:1220px){a.back{top:8px;left:8px;padding:7px 11px;font-size:13px}}
nav.tabs{display:flex;gap:4px;margin:6px 0 18px;border-bottom:1px solid #e2e8f0}
nav.tabs a{padding:8px 12px;font-size:14px;font-weight:600;color:#475569;text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px}
nav.tabs a.on{color:#4f46e5;border-bottom-color:#4f46e5}
code.link{display:block;word-break:break-all;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px;font-size:13px}
`;

export function page(heading, body, { status = 200, wide = false, headers = {} } = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(heading)}</title><style>${STYLE}</style></head><body><main${wide ? ' class="wide"' : ""}>
<div class="eyebrow">Daily Vacancy Report</div><h1>${esc(heading)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
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

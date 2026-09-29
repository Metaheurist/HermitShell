// Shared helpers: signing, escaping, pages and JSON responses.

const encoder = new TextEncoder();

export const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export async function hmacHex(secret, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Same message layout as job_tracker.sign() in Python; skills and profile are only added when set.
export async function sign(secret, key, action, title, skills = "", profile = "") {
  const message = `${key}\n${action}\n${title}` + (skills ? `\n${skills}` : "") + (profile ? `\nu=${profile}` : "");
  return (await hmacHex(secret, message)).slice(0, 32);
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
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never";
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

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
  });
}

export function redirect(location, headers = {}) {
  return new Response(null, { status: 303, headers: { Location: location, ...SECURITY_HEADERS, ...headers } });
}

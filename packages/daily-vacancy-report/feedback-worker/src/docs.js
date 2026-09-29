// Cover letters and tailored CVs kept for download. When HermitShell has made one it sends the PDF to POST /api/doc
// (cover_letter.py), and it is kept for COVER_LETTER_KEEP_DAYS (7 by default, at most 30), encrypted with a key
// derived from JOB_FEEDBACK_SECRET and bound to its KV key, so it only opens through this Worker and only as the
// document it was stored as. It can be downloaded from the dashboard's list of jobs sent (signed in) or from the
// job's email button (the signed link). Each profile has one index key ("docs:<id>") listing what it has, so the
// list costs a read rather than one of the free plan's 1,000 daily list operations.
//
// Asking from the dashboard stores the same request an email button does, marked "via: dashboard" (kept for
// download, not emailed) and "fresh" for Regenerate (a new one even if one was made recently).

import {
  CONTROL_RE, EVENT_TTL_SECONDS, SECURITY_HEADERS, ago, docIndexKey, docKey, esc, eventFlag, eventPrefix, json, limitedBytes,
  setFlag, sha256Hex,
} from "./lib.js";
import { rememberRequest } from "./tasks.js";

export const DOC_URL = "/admin/doc";
export const DOC_KINDS = { cover_letter: "Cover letter", tailored_cv: "Tailored CV" };
// The owner's profile id, as HermitShell reports it; the owner's email links carry no profile id.
export const OWNER_ID = "owner";
export const MAX_DOC_BYTES = 2 * 1024 * 1024;
export const MAX_DOC_DAYS = 30;
const MAX_INDEX = 300;
const MAX_JOB_KEY = 300;
const PROFILE_RE = /^[a-z0-9-]{1,40}$/;
const HASH_RE = /^[0-9a-f]{32}$/;
const IV_BYTES = 12;
const encoder = new TextEncoder();
const ciphers = new Map();

export function validJobKey(j) {
  return typeof j === "string" && j.length > 0 && j.length <= MAX_JOB_KEY && !CONTROL_RE.test(j);
}

export async function jobHash(j) {
  return (await sha256Hex(`job\n${j}`)).slice(0, 32);
}

function cleanName(name, kind) {
  const base = String(name || "").replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().replace(/\.pdf$/i, "")
    .slice(0, 116).trim();
  return `${base || DOC_KINDS[kind]}.pdf`;
}

async function cipher(secret) {
  let key = ciphers.get(secret);
  if (!key) {
    const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
    key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: encoder.encode("hermitshell-docs"), info: encoder.encode("v1") },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    if (ciphers.size > 8) ciphers.clear();
    ciphers.set(secret, key);
  }
  return key;
}

// What a profile has kept, dropping entries that have expired or do not look right.
export async function docIndex(env, profile, now = Date.now()) {
  if (!PROFILE_RE.test(profile || "")) return [];
  const list = await env.FEEDBACK.get(docIndexKey(profile), "json");
  return (Array.isArray(list) ? list : []).filter((d) => d && DOC_KINDS[d.k] && HASH_RE.test(d.h) && Number(d.exp) > now &&
    typeof d.name === "string");
}

// POST /api/doc?u=<id>&j=<job key>&k=<kind>&days=<n>&name=<file name>, the PDF as the body (HermitShell's API token).
export async function storeDoc(request, env) {
  const url = new URL(request.url);
  const q = (k) => url.searchParams.get(k) || "";
  const [u, j, kind, days] = [q("u"), q("j"), q("k"), Number(q("days"))];
  if (!PROFILE_RE.test(u) || !validJobKey(j) || !DOC_KINDS[kind] || !Number.isInteger(days) || days < 1 || days > MAX_DOC_DAYS) {
    return json({ error: "bad document" }, 400);
  }
  if (!env.JOB_FEEDBACK_SECRET) return json({ error: "not configured" }, 503);
  const body = await limitedBytes(request, MAX_DOC_BYTES);
  if (!body) return json({ error: "too large" }, 413);
  if (body.length < 8 || new TextDecoder().decode(body.subarray(0, 5)) !== "%PDF-") return json({ error: "not a PDF" }, 400);
  const h = await jobHash(j);
  const key = docKey(u, kind, h);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(key) },
    await cipher(env.JOB_FEEDBACK_SECRET), body));
  const stored = new Uint8Array(IV_BYTES + sealed.length);
  stored.set(iv);
  stored.set(sealed, IV_BYTES);
  const at = Date.now();
  await env.FEEDBACK.put(key, stored.buffer, { expirationTtl: days * 86400 });
  const index = (await docIndex(env, u, at)).filter((d) => !(d.k === kind && d.h === h));
  index.push({ k: kind, h, name: cleanName(q("name"), kind), at, exp: at + days * 86400000 });
  await env.FEEDBACK.put(docIndexKey(u), JSON.stringify(index.slice(-MAX_INDEX)), { expirationTtl: MAX_DOC_DAYS * 86400 });
  return json({ saved: true });
}

// A kept document, decrypted: { bytes, name, at }, or null when there is none (or it does not open).
export async function readDoc(env, profile, kind, h) {
  if (!DOC_KINDS[kind] || !HASH_RE.test(h || "") || !env.JOB_FEEDBACK_SECRET) return null;
  const entry = (await docIndex(env, profile)).find((d) => d.k === kind && d.h === h);
  const stored = entry ? await env.FEEDBACK.get(docKey(profile, kind, h), "arrayBuffer") : null;
  if (!stored || stored.byteLength <= IV_BYTES) return null;
  const bytes = new Uint8Array(stored);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: encoder.encode(docKey(profile, kind, h)) },
      await cipher(env.JOB_FEEDBACK_SECRET), bytes.subarray(IV_BYTES));
    return { bytes: plain, name: entry.name, at: entry.at };
  } catch {
    return null;
  }
}

// The kept document for a job, if any: its index entry.
export async function docFor(env, profile, kind, j) {
  if (!validJobKey(j) || !DOC_KINDS[kind]) return null;
  const h = await jobHash(j);
  return (await docIndex(env, profile)).find((d) => d.k === kind && d.h === h) || null;
}

export function pdfResponse(doc) {
  const ascii = doc.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "");
  return new Response(doc.bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...SECURITY_HEADERS,
      "Cache-Control": "private, no-store",
    },
  });
}

// A request from the dashboard, stored as the email button would store it. Asking again in the same minute is the
// same request, so a double press makes one.
export async function requestDoc(env, { profile, owner, j, kind, title, fresh }) {
  const at = Date.now();
  const u = owner ? "" : profile;
  const h = await jobHash(j);
  const event = { j, a: kind, r: "", at, via: "dashboard", ...(fresh ? { fresh: 1 } : {}), ...(u ? { u } : {}) };
  event.id = `${eventPrefix(u)}dash-${h.slice(0, 20)}:${kind === "cover_letter" ? "c" : "v"}${fresh ? "n" : "g"}${Math.floor(at / 60000)}`;
  await env.FEEDBACK.put(event.id, JSON.stringify(event), { expirationTtl: EVENT_TTL_SECONDS });
  await setFlag(env, eventFlag(u), EVENT_TTL_SECONDS);
  await rememberRequest(env, event, title, EVENT_TTL_SECONDS);
  return h;
}

// Letters and CVs asked for and not made yet, as "<kind>\n<job key>": from HermitShell's task list and from the
// requests it has not collected yet.
export function pendingDocs(status, held, profile, owner) {
  const busy = new Set();
  for (const t of Array.isArray(status.tasks) ? status.tasks : []) {
    if (t && t.u === profile && DOC_KINDS[t.kind] && typeof t.j === "string") busy.add(`${t.kind}\n${t.j}`);
  }
  for (const r of held) {
    if (r && (r.u || (owner ? profile : "")) === profile && DOC_KINDS[r.a] && typeof r.j === "string") busy.add(`${r.a}\n${r.j}`);
  }
  return busy;
}

const DOC_ICONS = {
  cover_letter: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
  tailored_cv: '<rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9" cy="11" r="2"/><path d="M6.5 16c.6-1.6 4.4-1.6 5 0M14 10h3.5M14 13.5h3.5"/>',
};

function docIcon(kind) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DOC_ICONS[kind]}</svg>`;
}

// One job's letter and CV on the dashboard's list of jobs sent: Download and Regenerate when one is kept, a spinner
// while one is being made, Generate otherwise. `ctx` has the profile, the job's hash, the kept documents, what is
// pending, the CSRF token and where to come back to.
export function docActions(j, h, ctx) {
  if (!validJobKey(j) || !HASH_RE.test(h || "")) return "";
  const hidden = (kind, fresh) => `<input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="u" value="${esc(ctx.profile)}">
<input type="hidden" name="j" value="${esc(j)}"><input type="hidden" name="k" value="${kind}"><input type="hidden" name="n" value="${esc(ctx.title)}">
<input type="hidden" name="back" value="${esc(ctx.back)}">${fresh ? '<input type="hidden" name="fresh" value="1">' : ""}`;
  return Object.entries(DOC_KINDS).map(([kind, label]) => {
    const kept = ctx.docs.find((d) => d.k === kind && d.h === h);
    if (ctx.pending.has(`${kind}\n${j}`)) {
      return `<div class="doc busy">${docIcon(kind)}<span><b>${label}</b><small>Being made&hellip;</small></span><span class="dspin" aria-hidden="true"></span></div>`;
    }
    if (kept) {
      return `<div class="doc ready">${docIcon(kind)}<span><b>${label}</b><small title="Kept for download until ${esc(new Date(kept.exp).toISOString().slice(0, 10))}">made ${esc(ago(kept.at))}</small></span>
<a class="dl" href="${DOC_URL}?u=${esc(ctx.profile)}&amp;k=${kind}&amp;h=${h}" download>Download</a>
<form method="post" action="${DOC_URL}">${hidden(kind, true)}<button class="small quiet" title="Write a new one">Regenerate</button></form></div>`;
    }
    return `<form class="doc" method="post" action="${DOC_URL}">${docIcon(kind)}<span><b>${label}</b><small>for this job</small></span>${hidden(kind, false)}
<button class="small">Generate</button></form>`;
  }).join("");
}

export const DOC_STYLE = `
.docs{display:flex;flex-wrap:wrap;gap:10px;align-items:stretch;margin-top:14px}
.doc{display:flex;align-items:center;gap:10px;margin:0;padding:9px 10px 9px 12px;border:1px solid var(--line);border-radius:14px;background:#fff;
flex:1 1 250px;min-width:0;transition:border-color .15s,box-shadow .15s}
.doc:hover{border-color:#c7cbf5;box-shadow:0 10px 22px -18px rgba(30,27,75,.5)}
.doc>svg{flex:none;width:30px;height:30px;padding:6px;border-radius:10px;background:var(--soft);color:var(--brand-ink)}
.doc span{display:grid;min-width:0;flex:1}.doc span b{font-size:13.5px}.doc small{font-size:12px;color:var(--muted)}
.doc form{margin:0}.doc button{margin:0;white-space:nowrap}
.doc.ready>svg{background:var(--ok-bg);color:#047857}
.doc a.dl{display:inline-flex;align-items:center;padding:7px 13px;border-radius:10px;font-size:13px;font-weight:650;color:#fff;text-decoration:none;
background:linear-gradient(135deg,#10b981,#059669);box-shadow:0 8px 18px -10px rgba(5,150,105,.8);transition:transform .15s var(--ease),filter .15s}
.doc a.dl:hover{transform:translateY(-1px);filter:brightness(1.05);color:#fff}
.doc.busy{background:linear-gradient(90deg,#fff,#f5f3ff,#fff) 0 0/200% 100%;animation:sweep 2.4s linear infinite}
.dspin{flex:none;width:22px;height:22px;border-radius:50%;background:conic-gradient(from 0deg,rgba(139,92,246,0),#8b5cf6 250deg,#6366f1 350deg,rgba(99,102,241,0));
-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));
mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));animation:dspin 1s linear infinite}
@keyframes dspin{to{transform:rotate(1turn)}}@keyframes sweep{to{background-position:-200% 0}}
`;

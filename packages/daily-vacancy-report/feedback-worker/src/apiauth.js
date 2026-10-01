// Who may use /events, /ack and /api/*: HermitShell, through common/worker_link.py. Besides the API token, each
// request carries an HMAC-SHA256 signature under a key derived from JOB_FEEDBACK_SECRET over the method, path and
// query, a timestamp, a one-time nonce and the SHA-256 of the body. A signature more than SIGN_WINDOW_MS from now,
// a nonce already used (kept by the hub, hub.js) or an altered request is refused. Once one signed request has
// arrived, requests without a signature are refused for good (KV key api:signed), so an older HermitShell still
// works until it is updated but a copied token alone no longer does. Without the hub, nonces aren't kept and
// the five-minute window is the only limit on replaying.
//
// Both sides state PROTOCOL (X-HermitShell-Protocol); HermitShell reports its own with its status and the
// dashboard warns when they differ.

import { POLL_PATH, hubNonce } from "./hub.js";
import { authorised, limitedBytes, safeEqual, hex } from "./lib.js";

// 3: the Pipeline (interview, offer and placed answers, the stats' board, POST /admin/stage).
export const PROTOCOL = 3;
export const SIGN_WINDOW_MS = 5 * 60 * 1000;
// The largest signed body: a kept cover letter or CV (docs.js) with room to spare.
export const MAX_SIGNED_BYTES = 2.5 * 1024 * 1024;
export const LATCH_KEY = "api:signed";
const CONTEXT = "hermitshell api v1";
const encoder = new TextEncoder();
const keys = new Map();
const latchedStores = new WeakSet();


async function signingKey(secret) {
  let key = keys.get(secret);
  if (!key) {
    const base = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const derived = await crypto.subtle.sign("HMAC", base, encoder.encode(CONTEXT));
    key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    if (keys.size > 4) keys.clear();
    keys.set(secret, key);
  }
  return key;
}

// Same message as signature() in worker_link.py.
export async function signature(secret, method, target, stamp, nonce, body) {
  const digest = hex(await crypto.subtle.digest("SHA-256", body || new Uint8Array()));
  const message = ["v1", method.toUpperCase(), target, String(stamp), nonce, digest].join("\n");
  return hex(await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(message)));
}

// Remembered per KV store, not per request's memo of it (memo.js), so after the first signed request it costs no read.
const store = (env) => env.FEEDBACK.raw || env.FEEDBACK;

async function latched(env) {
  if (latchedStores.has(store(env))) return true;
  if ((await env.FEEDBACK.get(LATCH_KEY)) !== "1") return false;
  latchedStores.add(store(env));
  return true;
}

async function latch(env) {
  if (await latched(env)) return;
  await env.FEEDBACK.put(LATCH_KEY, "1");
  latchedStores.add(store(env));
}

// Signed polls of the queue flag whose check-in (hub.js) was recorded along with their nonce.
const checkedIn = new WeakSet();
export const hasCheckedIn = (request) => checkedIn.has(request);

const refused = (status, error) => ({ ok: false, status, error });

// { ok: true, request } with the body re-attached (it is read to check the signature), or { ok: false, status, error }.
export async function verifyApi(request, env) {
  if (!authorised(request, env)) return refused(401, "unauthorised");
  const given = request.headers.get("X-HermitShell-Signature") || "";
  if (!given) return (await latched(env)) ? refused(401, "signature required") : { ok: true, request, signed: false };
  if (!env.JOB_FEEDBACK_SECRET) return refused(401, "signing is not set up");
  const stamp = Number(request.headers.get("X-HermitShell-Time") || "");
  const nonce = request.headers.get("X-HermitShell-Nonce") || "";
  if (!/^v1=[0-9a-f]{64}$/.test(given) || !/^[0-9a-f]{32}$/.test(nonce) || !Number.isSafeInteger(stamp)) return refused(401, "bad signature");
  if (Math.abs(Date.now() - stamp) > SIGN_WINDOW_MS) return refused(401, "signature expired");
  const method = request.method.toUpperCase();
  let body = null;
  if (method !== "GET" && method !== "HEAD") {
    body = await limitedBytes(request, MAX_SIGNED_BYTES);
    if (!body) return refused(413, "too large");
  }
  const url = new URL(request.url);
  const expected = await signature(env.JOB_FEEDBACK_SECRET, method, url.pathname + url.search, stamp, nonce, body);
  if (!safeEqual(given, `v1=${expected}`)) return refused(401, "bad signature");
  const seen = url.pathname === POLL_PATH;
  if (!(await hubNonce(env, nonce, seen))) return refused(401, "replayed");
  await latch(env);
  const passed = body ? new Request(request.url, { method, headers: request.headers, body }) : request;
  if (seen) checkedIn.add(passed);
  return { ok: true, request: passed, signed: true };
}

// Every API answer states the Worker's protocol; a WebSocket upgrade is passed on untouched.
export function withProtocol(response) {
  if (response.status === 101 || response.webSocket) return response;
  const out = new Response(response.body, response);
  out.headers.set("X-HermitShell-Protocol", String(PROTOCOL));
  return out;
}

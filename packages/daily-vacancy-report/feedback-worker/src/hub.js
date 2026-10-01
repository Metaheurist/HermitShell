// The live link to HermitShell: one Durable Object (binding HUB) holding the WebSocket that profiles.py keeps
// open. Queueing anything pushes {"flag": <item id>} down it, so a dashboard save reaches HermitShell in about a
// second, and the dashboard asks it whether HermitShell is connected right now.
// The WebSocket is hibernatable and HermitShell's "ping" is answered by the runtime without waking the object,
// so an idle link costs nothing on the free plan. Without the binding (or when the free daily Durable Object
// allowance runs out) everything still works: HermitShell falls back to polling /api/queue/flag.
// It also remembers the nonces of signed API requests (apiauth.js) for ten minutes, so none is accepted twice,
// counts attempts for rate limits (a counted attempt is a row here rather than one of KV's 1,000 daily writes),
// and holds one-time sign-in tokens, spent by a single statement so each works once even when two requests race.

const NAME = "hub";
const LIMIT_KEY_RE = /^[a-z]{1,12}:[0-9A-Za-z:._-]{1,80}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const PROFILE_ID_RE = /^[a-z0-9-]{1,40}$/;
const MAX_WINDOW_MS = 24 * 3600 * 1000;
const MAX_TOKEN_MS = 60 * 60 * 1000;
// HermitShell pings every 30 seconds; a link with no ping for this long is treated as dropped.
export const LIVE_MS = 90 * 1000;
// Polled by profiles.py when it has no live link.
export const POLL_PATH = "/api/queue/flag";
// SIGN_WINDOW_MS in apiauth.js, which imports this file.
const NONCE_WINDOW_MS = 5 * 60 * 1000;

function hub(env) {
  return env.HUB ? env.HUB.get(env.HUB.idFromName(NAME)) : null;
}

// Calls the hub; null when there is no hub or it fails, so a save never fails because of the live link.
async function call(env, path, init) {
  const stub = hub(env);
  if (!stub) return null;
  try {
    const res = await stub.fetch(`https://hub${path}`, init);
    return res.ok ? await res.json() : null;
  } catch (err) {
    console.error(`hub ${path}: ${err?.name || "Error"}`);
    return null;
  }
}

// Whether a signed API request's nonce is new (apiauth.js); true when there is no hub to ask. `seen` also records
// HermitShell's check-in, so a signed poll of the queue flag is one call to the hub.
export async function hubNonce(env, nonce, seen = false) {
  const got = await call(env, "/nonce", { method: "POST", body: JSON.stringify({ nonce, ...(seen ? { seen: true } : {}) }) });
  return got?.fresh !== false;
}

export function hubBump(env, flag) {
  return call(env, "/bump", { method: "POST", body: JSON.stringify({ flag }) });
}

// Attempts at `key` within the last `windowMs`: { ok, n }, where ok says another attempt is allowed (or, with
// `hit`, that this counted one was within `max`). null when there is no hub to ask, so callers keep a fallback.
export function hubLimit(env, key, max, windowMs, hit = false) {
  return call(env, "/limit", { method: "POST", body: JSON.stringify({ key, max, window: windowMs, hit }) });
}

export function hubLimitClear(env, key) {
  return call(env, "/limit", { method: "POST", body: JSON.stringify({ key, clear: true }) });
}

// A one-time token, stored as the SHA-256 hex of the secret the user holds: put { h, u, ms } or spend { h }.
// Spending returns the profile it was for once, then ""; null when there is no hub.
export async function hubTokenPut(env, h, u, ms) {
  const got = await call(env, "/token", { method: "POST", body: JSON.stringify({ op: "put", h, u, ms }) });
  return got ? got.ok === true : null;
}

export async function hubTokenSpend(env, h) {
  const got = await call(env, "/token", { method: "POST", body: JSON.stringify({ op: "spend", h }) });
  return got ? String(got.u || "") : null;
}

// HermitShell polled instead of holding the link: still counts as a check-in.
export function hubSeen(env) {
  return call(env, "/seen", { method: "POST" });
}

// { live, seen }: live while HermitShell holds the link, seen = when it last checked in (ms, 0 if never).
export async function hubPresence(env) {
  const got = await call(env, "/presence");
  return { live: Boolean(got?.live), seen: Number(got?.seen) || 0 };
}

export function hubConnect(request, env) {
  const stub = hub(env);
  if (!stub) return null;
  return stub.fetch("https://hub/connect", { headers: { Upgrade: request.headers.get("Upgrade") || "" } });
}

export class Hub {
  constructor(state) {
    this.state = state;
    if (typeof WebSocketRequestResponsePair === "function") {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
  }

  open() {
    const cutoff = Date.now() - LIVE_MS;
    return this.state.getWebSockets().filter((ws) => {
      if (ws.readyState !== undefined && ws.readyState !== 1) return false;
      const pinged = this.state.getWebSocketAutoResponseTimestamp?.(ws)?.getTime?.() || 0;
      return Math.max(pinged, ws.deserializeAttachment()?.at || 0) > cutoff;
    });
  }

  // A signed API request's nonce (apiauth.js): false when it was used within twice the signature window. Kept in the
  // object's SQLite storage, which is on the free plan; without it (an older runtime) every nonce counts as fresh.
  nonce(value) {
    const sql = this.state.storage.sql;
    if (!sql || !/^[0-9a-f]{32}$/.test(value)) return /^[0-9a-f]{32}$/.test(value);
    sql.exec("CREATE TABLE IF NOT EXISTS nonces (n TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    sql.exec("DELETE FROM nonces WHERE at < ?", Date.now() - 2 * NONCE_WINDOW_MS);
    try {
      sql.exec("INSERT INTO nonces (n, at) VALUES (?, ?)", value, Date.now());
      return true;
    } catch {
      return false;
    }
  }

  // null without SQLite storage, so the Worker falls back to what it did before (KV locks, or refusing).
  limit({ key, max, window: windowMs, hit, clear }) {
    const sql = this.state.storage.sql;
    if (!sql || typeof key !== "string" || !LIMIT_KEY_RE.test(key)) return null;
    sql.exec("CREATE TABLE IF NOT EXISTS limits (k TEXT NOT NULL, exp INTEGER NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS limits_k ON limits (k)");
    if (clear === true) {
      sql.exec("DELETE FROM limits WHERE k = ?", key);
      return { ok: true, n: 0 };
    }
    if (!Number.isInteger(max) || max < 1 || !Number.isInteger(windowMs) || windowMs < 1000 || windowMs > MAX_WINDOW_MS) return null;
    const now = Date.now();
    sql.exec("DELETE FROM limits WHERE exp < ?", now);
    if (hit === true) sql.exec("INSERT INTO limits (k, exp) VALUES (?, ?)", key, now + windowMs);
    const n = Number(sql.exec("SELECT COUNT(*) AS n FROM limits WHERE k = ?", key).toArray()[0]?.n) || 0;
    return { ok: hit === true ? n <= max : n < max, n };
  }

  token({ op, h, u, ms }) {
    const sql = this.state.storage.sql;
    if (!sql || typeof h !== "string" || !TOKEN_RE.test(h)) return null;
    sql.exec("CREATE TABLE IF NOT EXISTS tokens (h TEXT PRIMARY KEY, u TEXT NOT NULL, exp INTEGER NOT NULL)");
    const now = Date.now();
    sql.exec("DELETE FROM tokens WHERE exp < ?", now);
    if (op === "put") {
      if (typeof u !== "string" || !PROFILE_ID_RE.test(u) || !Number.isInteger(ms) || ms < 1000 || ms > MAX_TOKEN_MS) return null;
      try {
        sql.exec("INSERT INTO tokens (h, u, exp) VALUES (?, ?, ?)", h, u, now + ms);
      } catch {
        return { ok: false };
      }
      return { ok: true };
    }
    if (op === "spend") {
      return { u: String(sql.exec("DELETE FROM tokens WHERE h = ? AND exp >= ? RETURNING u", h, now).toArray()[0]?.u || "") };
    }
    return null;
  }

  async presence() {
    return { live: this.open().length > 0, seen: (await this.state.storage.get("seen")) || 0 };
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/connect") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ at: Date.now() });
      await this.state.storage.put("seen", Date.now());
      server.send(JSON.stringify({ flag: (await this.state.storage.get("flag")) || "" }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === "/bump" && request.method === "POST") {
      const flag = String((await request.json())?.flag || "").slice(0, 100);
      await this.state.storage.put("flag", flag);
      let sent = 0;
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(JSON.stringify({ flag }));
          sent++;
        } catch {
          // a socket closing as we send; HermitShell syncs again when it reconnects
        }
      }
      return Response.json({ sent });
    }
    if (path === "/seen" && request.method === "POST") {
      await this.state.storage.put("seen", Date.now());
      return Response.json(await this.presence());
    }
    if (path === "/presence") return Response.json(await this.presence());
    if (path === "/nonce" && request.method === "POST") {
      const body = await request.json();
      const fresh = this.nonce(String(body?.nonce || ""));
      if (fresh && body?.seen === true) await this.state.storage.put("seen", Date.now());
      return Response.json({ fresh });
    }
    if ((path === "/limit" || path === "/token") && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const got = body && typeof body === "object" ? (path === "/limit" ? this.limit(body) : this.token(body)) : null;
      return got ? Response.json(got) : Response.json({ error: "unavailable" }, { status: 503 });
    }
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws, message) {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws, code, reason) {
    await this.state.storage.put("seen", Date.now());
    try {
      ws.close(code, reason);
    } catch {
      // 1005 and 1006 cannot be sent back
    }
  }

  async webSocketError() {
    await this.state.storage.put("seen", Date.now());
  }
}

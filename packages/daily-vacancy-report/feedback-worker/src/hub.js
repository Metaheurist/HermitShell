// The live link to HermitShell: one Durable Object (binding HUB) holding the WebSocket that profiles.py keeps
// open. Queueing anything pushes {"flag": <item id>} down it, so a dashboard save reaches HermitShell in about a
// second, and the dashboard asks it whether HermitShell is connected right now.
// The WebSocket is hibernatable and HermitShell's "ping" is answered by the runtime without waking the object,
// so an idle link costs nothing on the free plan. Without the binding (or when the free daily Durable Object
// allowance runs out) everything still works: HermitShell falls back to polling /api/queue/flag.

const NAME = "hub";
// HermitShell pings every 30 seconds; a link with no ping for this long is treated as dropped.
export const LIVE_MS = 90 * 1000;

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

export function hubBump(env, flag) {
  return call(env, "/bump", { method: "POST", body: JSON.stringify({ flag }) });
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

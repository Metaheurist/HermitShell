import { describe, expect, it } from "vitest";
import { LATCH_KEY, MAX_SIGNED_BYTES, PROTOCOL, SIGN_WINDOW_MS, signature, withProtocol } from "../src/apiauth.js";
import worker from "../src/index.js";
import { BASE, keysWith, memoryHub, testEnv } from "./helpers.js";

const TOKEN = { Authorization: "Bearer api-token" };
const nonce = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

// A request as common/worker_link.py sends it; `sign` overrides what goes into the signature.
async function signed(method, target, body = null, { secret = "test-secret", stamp = Date.now(), id = nonce(), sign = {}, headers = TOKEN } = {}) {
  const bytes = body == null ? null : new TextEncoder().encode(body);
  const s = { method, target, stamp, id, bytes, ...sign };
  const mac = await signature(secret, s.method, s.target, s.stamp, s.id, s.bytes);
  return new Request(`${BASE}${target}`, { method, body: bytes, headers: { ...headers, "X-HermitShell-Time": String(stamp),
    "X-HermitShell-Nonce": id, "X-HermitShell-Signature": `v1=${mac}`, "X-HermitShell-Protocol": String(PROTOCOL) } });
}

describe("signed API requests", () => {
  it("signs the same message as worker_link.py", async () => {
    expect(await signature("test-secret", "post", "/ack?x=1", 1790000000000, "0123456789abcdef0123456789abcdef",
      new TextEncoder().encode('{"ids":["a"]}'))).toBe("ed9149b6ac2cff3537a05145cd562d56126dd4371e77a457118b64c35ddcd7c9");
  });

  it("answers a signed request with the Worker's protocol, and passes the body on", async () => {
    const env = testEnv();
    await env.FEEDBACK.put("event:_:1:abc", JSON.stringify({ a: "applied" }));
    const events = await worker.fetch(await signed("GET", "/events?since=0"), env);
    expect(events.status).toBe(200);
    expect(events.headers.get("X-HermitShell-Protocol")).toBe(String(PROTOCOL));
    const ack = await worker.fetch(await signed("POST", "/ack", JSON.stringify({ ids: ["event:_:1:abc"] })), env);
    expect(ack.status).toBe(200);
    expect(keysWith(env, "event:")).toEqual([]);
  });

  it("still takes the token alone from an older HermitShell, until the first signed request", async () => {
    const env = testEnv();
    expect((await worker.fetch(new Request(`${BASE}/api/queue`, { headers: TOKEN }), env)).status).toBe(200);
    expect(await env.FEEDBACK.get(LATCH_KEY)).toBeNull();
    expect((await worker.fetch(await signed("GET", "/api/queue"), env)).status).toBe(200);
    expect(await env.FEEDBACK.get(LATCH_KEY)).toBe("1");
    for (const [method, path] of [["GET", "/api/queue"], ["GET", "/events"], ["POST", "/api/status"]]) {
      const res = await worker.fetch(new Request(`${BASE}${path}`, { method, headers: TOKEN, body: method === "POST" ? "{}" : null }), env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "signature required" });
      expect(res.headers.get("X-HermitShell-Protocol")).toBe(String(PROTOCOL));
    }
  });

  it("refuses a request signed with another secret, or altered on the way", async () => {
    const env = testEnv();
    const body = JSON.stringify({ ids: ["event:_:1:abc"] });
    const cases = [
      await signed("GET", "/api/queue", null, { secret: "another-secret" }),
      await signed("GET", "/api/queue?limit=500", null, { sign: { target: "/api/queue" } }),
      await signed("POST", "/ack", body, { sign: { method: "GET" } }),
      await signed("POST", "/ack", body, { sign: { bytes: new TextEncoder().encode('{"ids":[]}') } }),
      await signed("GET", "/api/queue", null, { sign: { stamp: Date.now() - 1 } }),
      await signed("GET", "/api/queue", null, { id: "not-a-nonce" }),
    ];
    for (const request of cases) {
      const res = await worker.fetch(request, env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "bad signature" });
    }
    const bad = await signed("GET", "/api/queue");
    bad.headers.set("X-HermitShell-Signature", "v1=zz");
    expect((await worker.fetch(bad, env)).status).toBe(401);
    expect(await env.FEEDBACK.get(LATCH_KEY)).toBeNull();
  });

  it("refuses a signature from outside the five-minute window, either side", async () => {
    const env = testEnv();
    for (const stamp of [Date.now() - SIGN_WINDOW_MS - 5000, Date.now() + SIGN_WINDOW_MS + 5000]) {
      const res = await worker.fetch(await signed("GET", "/api/queue", null, { stamp }), env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "signature expired" });
    }
    expect((await worker.fetch(await signed("GET", "/api/queue", null, { stamp: Date.now() - SIGN_WINDOW_MS + 5000 }), env)).status).toBe(200);
  });

  it("refuses a replayed request: the hub remembers each nonce", async () => {
    const HUB = memoryHub({ sql: true });
    const env = testEnv({ HUB });
    const first = await signed("GET", "/api/queue");
    const again = first.clone();
    expect((await worker.fetch(first, env)).status).toBe(200);
    const res = await worker.fetch(again, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "replayed" });
    expect(HUB.state.storage.sql.rows.size).toBe(1);
    expect((await worker.fetch(await signed("GET", "/api/queue"), env)).status).toBe(200);
  });

  it("still needs the API token, and a secret to check signatures against", async () => {
    const env = testEnv();
    const noToken = await worker.fetch(await signed("GET", "/api/queue", null, { headers: {} }), env);
    expect(noToken.status).toBe(401);
    expect(await noToken.json()).toEqual({ error: "unauthorised" });
    const unset = await worker.fetch(await signed("GET", "/api/queue"), testEnv({ JOB_FEEDBACK_SECRET: "" }));
    expect(unset.status).toBe(401);
    expect(await unset.json()).toEqual({ error: "signing is not set up" });
  });

  it("refuses a signed body too large to check", async () => {
    const res = await worker.fetch(await signed("POST", "/api/doc", "x".repeat(MAX_SIGNED_BYTES + 1)), testEnv());
    expect(res.status).toBe(413);
  });

  it("answers an unknown API path with a JSON 404 once the caller is known, and 401 before", async () => {
    const env = testEnv();
    const known = await worker.fetch(await signed("GET", "/api/nothing"), env);
    expect(known.status).toBe(404);
    expect(await known.json()).toEqual({ error: "not found" });
    expect((await worker.fetch(new Request(`${BASE}/api/nothing`), env)).status).toBe(401);
  });

  it("leaves a WebSocket upgrade untouched", () => {
    const upgrade = { status: 101, webSocket: {}, headers: new Headers() };
    expect(withProtocol(upgrade)).toBe(upgrade);
    expect(withProtocol(new Response("{}")).headers.get("X-HermitShell-Protocol")).toBe(String(PROTOCOL));
  });
});

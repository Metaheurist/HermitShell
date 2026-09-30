import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { queueItems } from "../src/join.js";
import { BASE, keysWith, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const MINUTE = 60 * 1000;

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

async function admin(env) {
  const res = await worker.fetch(post("/admin/login", { username: "admin", password: ADMIN.ADMIN_PASSWORD }, { "CF-Connecting-IP": "203.0.113.9" }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = async (path) => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
  const text = async (path) => (await get(path)).text();
  const csrf = (await text("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const send = async (path, fields) => worker.fetch(post(path, { csrf, ...fields }, { Cookie: cookie }), env);
  return { get, text, send };
}

const events = (env, u) => worker.fetch(new Request(`${BASE}/events?u=${u}`, { headers: API }), env);

describe("waiting flags", () => {
  it("takes down an events flag left on with nothing under it, once KV's listings have caught up", async () => {
    const env = testEnv();
    await env.FEEDBACK.put("flag:events:sam-lee", String(Date.now() - 5 * MINUTE));
    expect((await (await events(env, "sam-lee")).json()).events).toEqual([]);
    expect(env.FEEDBACK.store.has("flag:events:sam-lee")).toBe(false);
  });

  it("keeps a flag set in the last two minutes, whose items a listing may not show yet", async () => {
    const env = testEnv();
    await env.FEEDBACK.put("flag:events:sam-lee", String(Date.now() - 30 * 1000));
    await events(env, "sam-lee");
    expect(env.FEEDBACK.store.has("flag:events:sam-lee")).toBe(true);
  });

  it("takes down an old-style flag with nothing under it", async () => {
    const env = testEnv();
    await env.FEEDBACK.put("flag:events:sam-lee", "1");
    await events(env, "sam-lee");
    expect(env.FEEDBACK.store.has("flag:events:sam-lee")).toBe(false);
  });

  it("keeps a flag with items under it, however old", async () => {
    const env = testEnv();
    await env.FEEDBACK.put("event:sam-lee:1:abc", JSON.stringify({ a: "interested" }));
    await env.FEEDBACK.put("flag:events:sam-lee", String(Date.now() - 60 * MINUTE));
    expect((await (await events(env, "sam-lee")).json()).events).toHaveLength(1);
    expect(env.FEEDBACK.store.has("flag:events:sam-lee")).toBe(true);
  });

  it("takes down a queue flag left on once the dashboard finds the queue empty", async () => {
    const env = testEnv(ADMIN);
    const a = await admin(env);
    await env.FEEDBACK.put("flag:queue", `queue:${Date.now() - 5 * MINUTE}:0123456789abcdef`);
    await a.get("/admin");
    expect(env.FEEDBACK.store.has("flag:queue")).toBe(false);
  });

  it("writes the flag once for several queued items, in the order given", async () => {
    const env = testEnv();
    const puts = [];
    const put = env.FEEDBACK.put.bind(env.FEEDBACK);
    env.FEEDBACK.put = (key, ...rest) => (puts.push(key), put(key, ...rest));
    const ids = await queueItems(env, ["a", "b", "c"].map((u) => ({ type: "admin", action: "assign", u, recruiter: "" })));
    expect(puts.filter((k) => k === "flag:queue")).toHaveLength(1);
    expect([...ids].sort()).toEqual(ids);
    expect(env.FEEDBACK.store.get("flag:queue")).toBe(ids[2]);
    expect(keysWith(env, "queue:").sort()).toEqual(ids);
  });
});

describe("pages that update by themselves", () => {
  it("keep the signed-in box while waiting for HermitShell", async () => {
    const env = testEnv(ADMIN);
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API,
      body: JSON.stringify({ profiles: [{ id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true }] }) }), env);
    const a = await admin(env);
    await a.send("/admin/action", { action: "pause", u: "sam-lee" });
    const body = await a.text("/admin?done=queued");
    expect(body).toContain('<body class="still">');
    expect(body).toContain("Sign out");
  });
});

describe("presses that must not happen twice", () => {
  it("shows a new invite on its own address, so reloading it makes no other", async () => {
    const env = testEnv(ADMIN);
    const a = await admin(env);
    const where = (await a.send("/admin/action", { action: "invite", note: "Riley" })).headers.get("Location");
    expect(where).toMatch(/^\/admin\/invite\?i=[0-9a-f]{32}$/);
    expect(await a.text(where)).toContain("Send this link to Riley");
    await a.get(where);
    expect(keysWith(env, "invite:")).toHaveLength(1);
  });

  it("says an invite that is gone or made up is not found", async () => {
    const env = testEnv(ADMIN);
    const a = await admin(env);
    expect((await a.get(`/admin/invite?i=${"0".repeat(32)}`)).status).toBe(404);
    expect((await a.get("/admin/invite?i=../../x")).status).toBe(404);
  });
});

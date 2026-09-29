// The live link (src/hub.js): pushes to HermitShell, presence on the dashboard, and life without the binding.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_MS } from "../src/hub.js";
import worker from "../src/index.js";
import { queueItem } from "../src/join.js";
import { BASE, FakeSocket, memoryHub, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };

// Node's Response refuses status 101, which the Workers runtime uses for an accepted WebSocket.
class UpgradeResponse extends Response {
  constructor(body, init = {}) {
    super(body, init.status === 101 ? { ...init, status: 200 } : init);
    if (init.status === 101) this.webSocket = init.webSocket;
  }
}

function acceptUpgrades() {
  const client = new FakeSocket();
  const server = new FakeSocket();
  vi.stubGlobal("WebSocketPair", function WebSocketPair() { return { 0: client, 1: server }; });
  vi.stubGlobal("Response", UpgradeResponse);
  return { client, server };
}

afterEach(() => vi.unstubAllGlobals());

function get(path, env, headers = {}) {
  return worker.fetch(new Request(`${BASE}${path}`, { headers }), env);
}

async function dashboard(env) {
  const login = await worker.fetch(new Request(`${BASE}/admin/login`, {
    method: "POST", body: new URLSearchParams({ username: "admin", password: ADMIN.ADMIN_PASSWORD }),
    headers: { "CF-Connecting-IP": "203.0.113.20" } }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  return (await get("/admin", env, { Cookie: cookie })).text();
}

describe("pushes", () => {
  it("sends every queued item's id down each open link, and nothing else", async () => {
    const HUB = memoryHub();
    const env = testEnv({ HUB });
    const [open, closed] = [new FakeSocket(), new FakeSocket()];
    HUB.state.acceptWebSocket(open);
    HUB.state.acceptWebSocket(closed);
    closed.close();
    const id = await queueItem(env, { type: "admin", action: "email", host: "smtp.example.com", password: "hunter2-secret" });
    expect(open.sent).toEqual([JSON.stringify({ flag: id })]);
    expect(closed.sent).toEqual([]);
    expect(open.sent.join("")).not.toContain("hunter2");
    expect(HUB.storage.get("flag")).toBe(id);
  });

  it("never lets a failing live link fail a save", async () => {
    const env = testEnv({ HUB: { idFromName: () => "hub", get: () => ({ fetch: async () => { throw new Error("limit reached"); } }) } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await queueItem(env, { type: "admin", action: "pause", u: "sam-lee" });
    expect(await env.FEEDBACK.get("flag:queue")).toBe(id);
  });

  it("still queues and flags without the binding", async () => {
    const env = testEnv();
    const id = await queueItem(env, { type: "admin", action: "pause", u: "sam-lee" });
    expect(await env.FEEDBACK.get("flag:queue")).toBe(id);
  });
});

describe("connecting", () => {
  it("accepts HermitShell's WebSocket and tells it the latest flag at once", async () => {
    const HUB = memoryHub();
    const env = testEnv({ HUB });
    await queueItem(env, { type: "admin", action: "pause", u: "sam-lee" });
    const { client, server } = acceptUpgrades();
    const res = await get("/api/live", env, { ...API, Upgrade: "websocket" });
    expect(res.webSocket).toBe(client);
    expect(HUB.state.sockets).toEqual([server]);
    expect(JSON.parse(server.sent[0]).flag).toBe(await env.FEEDBACK.get("flag:queue"));
    expect(HUB.storage.get("seen")).toBeGreaterThan(Date.now() - 5000);
  });

  it("needs the upgrade header and the binding", async () => {
    expect((await get("/api/live", testEnv({ HUB: memoryHub() }), API)).status).toBe(426);
    expect((await get("/api/live", testEnv(), { ...API, Upgrade: "websocket" })).status).toBe(404);
  });

  it("answers a ping that reaches the object and records when a link closes", async () => {
    const HUB = memoryHub();
    const ws = new FakeSocket();
    await HUB.hub.webSocketMessage(ws, "ping");
    await HUB.hub.webSocketMessage(ws, "anything else");
    expect(ws.sent).toEqual(["pong"]);
    await HUB.hub.webSocketClose(ws, 1000, "bye");
    expect(ws.readyState).toBe(3);
    expect(HUB.storage.get("seen")).toBeGreaterThan(Date.now() - 5000);
  });
});

describe("presence on the dashboard", () => {
  const STATUS = JSON.stringify({ profiles: [], updated: Date.now() - 8 * 60 * 1000 });

  it("shows HermitShell as connected while its link is fresh", async () => {
    const HUB = memoryHub();
    const env = testEnv({ ...ADMIN, HUB });
    await env.FEEDBACK.put("status:profiles", STATUS);
    const ws = new FakeSocket();
    ws.serializeAttachment({ at: Date.now() });
    HUB.state.acceptWebSocket(ws);
    const page = await dashboard(env);
    expect(page).toContain('<span class="live" aria-hidden="true"></span><b>HermitShell is connected</b>');
    expect(page).toContain("Profiles last reported 8 minutes ago");
  });

  it("drops to the last check-in when the link has gone quiet", async () => {
    const HUB = memoryHub();
    const env = testEnv({ ...ADMIN, HUB });
    await env.FEEDBACK.put("status:profiles", STATUS);
    const ws = new FakeSocket();
    ws.serializeAttachment({ at: Date.now() - LIVE_MS - 1000 });
    HUB.state.acceptWebSocket(ws);
    HUB.storage.set("seen", Date.now() - 3 * 60 * 1000);
    const page = await dashboard(env);
    expect(page).not.toContain('class="live"');
    expect(page).toContain("HermitShell last checked in 3 minutes ago");
    ws.pinged = Date.now();
    expect(await dashboard(env)).toContain('class="live"');
  });

  it("counts a poll as a check-in when HermitShell has no link", async () => {
    const HUB = memoryHub();
    const env = testEnv({ ...ADMIN, HUB });
    await env.FEEDBACK.put("status:profiles", STATUS);
    expect(await dashboard(env)).toContain("HermitShell last checked in 8 minutes ago");
    await get("/api/queue/flag", env, API);
    expect(await dashboard(env)).toContain("HermitShell last checked in just now");
  });

  it("falls back to the last report without the binding", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", STATUS);
    expect(await dashboard(env)).toContain("HermitShell last checked in 8 minutes ago");
  });
});

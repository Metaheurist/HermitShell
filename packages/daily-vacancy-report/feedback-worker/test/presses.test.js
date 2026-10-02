import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { BASE, memoryHub, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const PROFILES = [
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true },
  { id: "jordan-patel", name: "Jordan Patel", email: "jordan@contoso.example", status: "active", has_cv: true },
  { id: "riley-chen", name: "Riley Chen", email: "riley@fabrikam.example", status: "paused", has_cv: true },
];

// `fields` values may be lists, sent as one field each (the bulk bar's ticked rows).
function post(path, fields, headers = {}) {
  const body = new URLSearchParams(Object.entries(fields).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => [k, x])));
  return new Request(`${BASE}${path}`, { method: "POST", body, headers });
}

// The main admin signed in, with or without the hub (`hub`: memoryHub options, or null for none).
async function setup(hub = { sql: "sqlite" }) {
  const env = testEnv({ ...ADMIN, ...(hub ? { HUB: memoryHub(hub) } : {}) });
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles: PROFILES }) }), env);
  const res = await worker.fetch(post("/admin/login", { username: "admin", password: ADMIN.ADMIN_PASSWORD }, { "CF-Connecting-IP": "203.0.113.9" }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const page = await (await worker.fetch(new Request(`${BASE}/admin`, { headers: { Cookie: cookie } }), env)).text();
  const csrf = page.match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const press = async (fields) => (await worker.fetch(post("/admin/action", { csrf, ...fields }, { Cookie: cookie }), env)).headers.get("Location");
  const items = () => valuesWith(env, "queue:").filter((i) => i.type === "admin");
  const history = (u) => valuesWith(env, `history:${u}:`).flat();
  return { env, press, items, history };
}

describe("pressing the same button again", () => {
  it("queues a pause once however often it is pressed, and records it once", async () => {
    const { press, items, history } = await setup();
    for (let i = 0; i < 4; i++) expect(await press({ action: "pause", u: "sam-lee" })).toBe("/admin?done=queued");
    expect(items()).toEqual([expect.objectContaining({ action: "pause", u: "sam-lee" })]);
    expect(history("sam-lee").filter((h) => h.t === "Paused reports")).toHaveLength(1);
  });

  it("queues one of several presses arriving at the same moment", async () => {
    const { press, items } = await setup();
    await Promise.all(Array.from({ length: 5 }, () => press({ action: "pause", u: "sam-lee" })));
    expect(items()).toHaveLength(1);
  });

  it("does the same without the hub, from a short-lived key", async () => {
    const { env, press, items } = await setup(null);
    for (let i = 0; i < 3; i++) await press({ action: "pause", u: "sam-lee" });
    expect(items()).toHaveLength(1);
    expect(env.FEEDBACK.store.get("press:state:sam-lee")).toMatch(/^pause:\d+$/);
  });

  it("still queues a real change of mind: pause, resume, then pause again", async () => {
    const { press, items } = await setup();
    for (const action of ["pause", "resume", "pause"]) await press({ action, u: "sam-lee" });
    expect(items().map((i) => i.action)).toEqual(["pause", "resume", "pause"]);
  });

  it("lets the same press through again once HermitShell has reported since", async () => {
    const { env, press, items } = await setup();
    await press({ action: "pause", u: "sam-lee" });
    for (const k of [...env.FEEDBACK.store.keys()].filter((k) => k.startsWith("queue:"))) env.FEEDBACK.store.delete(k);
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles: PROFILES }) }), env);
    await new Promise((r) => setTimeout(r, 5));
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles: PROFILES }) }), env);
    expect(await press({ action: "pause", u: "sam-lee" })).toBe("/admin?done=queued");
    expect(items()).toEqual([expect.objectContaining({ action: "pause", u: "sam-lee" })]);
  });

  it("keeps each recruit's presses apart", async () => {
    const { press, items } = await setup();
    await press({ action: "pause", u: "sam-lee" });
    await press({ action: "pause", u: "jordan-patel" });
    expect(items().map((i) => i.u).sort()).toEqual(["jordan-patel", "sam-lee"]);
  });

  it("queues nothing for a recruit who already is what was pressed", async () => {
    const { press, items } = await setup();
    expect(await press({ action: "pause", u: "riley-chen" })).toBe("/admin?done=nochange");
    expect(items()).toEqual([]);
  });

  it("counts a change still waiting, even once the moment for repeats has passed", async () => {
    const { env, press, items } = await setup();
    await press({ action: "pause", u: "sam-lee" });
    env.HUB.state.storage.sql.exec("DELETE FROM presses");
    expect(await press({ action: "pause", u: "sam-lee" })).toBe("/admin?done=queued");
    expect(items()).toHaveLength(1);
  });

  it("deletes, retires and assigns once", async () => {
    const { press, items } = await setup();
    for (let i = 0; i < 3; i++) await press({ action: "delete", u: "sam-lee", confirm: "yes" });
    for (let i = 0; i < 3; i++) await press({ action: "retire", u: "jordan-patel", confirm: "yes" });
    for (let i = 0; i < 3; i++) await press({ action: "assign", u: "riley-chen", recruiter: "" });
    expect(items().map((i) => `${i.action} ${i.u}`)).toEqual(["delete sam-lee", "retire jordan-patel"]);
    expect(await press({ action: "assign", u: "riley-chen", recruiter: "" })).toBe("/admin?done=nochange");
  });

  it("skips recruits a bulk change was just asked for", async () => {
    const { press, items } = await setup();
    expect(await press({ action: "bulk", op: "pause", u: ["sam-lee", "jordan-patel"] })).toBe("/admin?done=bulk&n=2&m=0");
    expect(await press({ action: "bulk", op: "pause", u: ["sam-lee", "jordan-patel"] })).toBe("/admin?done=bulk&n=0&m=2");
    expect(await press({ action: "pause", u: "sam-lee" })).toBe("/admin?done=queued");
    expect(items()).toHaveLength(1);
  });
});

describe("the hub's record of presses", () => {
  const ask = (env, body) => env.HUB.get().fetch("https://hub/press", { method: "POST", body: JSON.stringify(body) });

  it("refuses keys and values that aren't plain, and windows out of range", async () => {
    const env = testEnv({ HUB: memoryHub({ sql: "sqlite" }) });
    for (const body of [{ key: "state:sam-lee", value: "<script>", ms: 60000 }, { key: "STATE:x", value: "pause", ms: 60000 },
      { key: "state:sam-lee", value: "pause", ms: 10 }, { key: "state:sam-lee", value: "pause", ms: 2 * 86400000 },
      { key: "state:sam-lee", value: "x".repeat(81), ms: 60000 }]) {
      expect((await ask(env, body)).status).toBe(503);
    }
    expect(await (await ask(env, { key: "state:sam-lee", value: "pause", ms: 60000 })).json()).toEqual({ fresh: true });
    expect(await (await ask(env, { key: "state:sam-lee", value: "pause", ms: 60000 })).json()).toEqual({ fresh: false });
  });
});

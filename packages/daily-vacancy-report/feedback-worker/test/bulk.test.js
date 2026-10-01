import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { BASE, keysWith, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const CASEY_PASSWORD = "a long enough passphrase";
const PROFILES = [
  { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false, recruit: "" },
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true, recruiter: "casey" },
  { id: "jordan-patel", name: "Jordan Patel", email: "jordan@contoso.example", status: "active", has_cv: true },
  { id: "riley-chen", name: "Riley Chen", email: "riley@example.com", status: "paused", has_cv: true },
];

// Form fields where an array is the same field repeated, as ticked checkboxes are sent.
function post(path, fields, headers = {}) {
  const pairs = Object.entries(fields).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]));
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(pairs), headers });
}

async function signIn(env, username, password, ip) {
  const res = await worker.fetch(post("/admin/login", { username, password }, { "CF-Connecting-IP": ip }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const text = async (path) => (await worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env)).text();
  const csrf = async () => (await text("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const raw = (fields, path = "/admin/action") => worker.fetch(post(path, fields, { Cookie: cookie }), env);
  const send = async (fields, path = "/admin/action") => raw({ csrf: await csrf(), ...fields }, path);
  const bulk = async (op, us, extra = {}) => (await send({ action: "bulk", op, u: us, ...extra })).headers.get("Location");
  return { text, raw, send, bulk };
}

async function setup() {
  const env = testEnv(ADMIN);
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles: PROFILES }) }), env);
  const admin = await signIn(env, "admin", ADMIN.ADMIN_PASSWORD, "203.0.113.9");
  await admin.send({ op: "add", name: "Casey Quinn", username: "casey", password: CASEY_PASSWORD, roles: "recruiter" }, "/admin/users");
  const casey = await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.10");
  return { env, admin, casey };
}

const queue = (env) => valuesWith(env, "queue:");
const history = (env, u) => valuesWith(env, `history:${u}:`).flat().map((e) => [e.k, e.t, e.by]);

describe("bulk actions", () => {
  it("queues one item for the ticked recruits the admin may change and says how many were skipped", async () => {
    const { env, admin } = await setup();
    expect(await admin.bulk("pause", ["sam-lee", "jordan-patel", "riley-chen", "owner", "no-such-recruit", "../x"]))
      .toBe("/admin?done=bulk&n=2&m=4");
    const items = queue(env);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "admin", action: "bulk", op: "pause", us: ["sam-lee", "jordan-patel"] });
    expect(history(env, "sam-lee")).toEqual([["pause", "Paused reports", "Alex Morgan"]]);
    expect(history(env, "jordan-patel")).toEqual([["pause", "Paused reports", "Alex Morgan"]]);
    expect(keysWith(env, "history:riley-chen:")).toEqual([]);
    const page = await admin.text("/admin?done=bulk&n=2&m=4");
    expect(page).toContain("2 done, 4 skipped.");
    expect(page.match(/pausing/g)?.length).toBeGreaterThanOrEqual(2);
    expect(page).toContain("Waiting for HermitShell: 2 changes");
  });

  it("shows a checkbox on each recruit's row for the bar's form, and Assign only to admins", async () => {
    const { admin, casey } = await setup();
    const page = await admin.text("/admin");
    for (const u of ["sam-lee", "jordan-patel", "riley-chen"]) {
      expect(page).toContain(`<input type="checkbox" class="pick" name="u" value="${u}" form="bulk"`);
    }
    expect(page).not.toContain('value="owner" form="bulk"');
    expect(page).toContain('<form id="bulk" method="post" action="/admin/action" class="bulkbar">');
    expect(page).toContain('name="op" value="assign"');
    const theirs = await casey.text("/admin");
    expect(theirs.match(/class="pick"/g)).toHaveLength(1);
    expect(theirs).toContain('name="op" value="send_now"');
    expect(theirs).not.toContain('name="op" value="assign"');
    expect(await admin.text("/admin?done=bulk&n=99&m=-4")).toContain("25 done, 0 skipped.");
    expect(await admin.text("/admin?done=bulk&n=<b>&m=1")).toContain("0 done, 1 skipped.");
  });

  it("lets a recruiter pause, resume and send only their own recruits, and never assign or delete", async () => {
    const { env, casey } = await setup();
    expect(await casey.bulk("pause", ["sam-lee", "jordan-patel", "riley-chen"])).toBe("/admin?done=bulk&n=1&m=2");
    expect(queue(env)[0].us).toEqual(["sam-lee"]);
    const assign = await casey.send({ action: "bulk", op: "assign", u: ["sam-lee"], recruiter: "casey" });
    expect(assign.status).toBe(403);
    const remove = await casey.send({ action: "bulk", op: "delete", u: ["sam-lee"] });
    expect(remove.status).toBe(400);
    expect(queue(env)).toHaveLength(1);
  });

  it("does not ask twice for jobs within a minute, singly or in bulk", async () => {
    const { env, admin, casey } = await setup();
    await casey.send({ action: "send_now", u: "sam-lee" });
    expect(await admin.bulk("send_now", ["sam-lee", "jordan-patel"])).toBe("/admin?done=bulk&n=1&m=1");
    expect(queue(env).map((i) => [i.action, i.op || "", i.us || i.u])).toEqual([["send_now", "", "sam-lee"], ["bulk", "send_now", ["jordan-patel"]]]);
    expect(env.FEEDBACK.store.has("sendnow:jordan-patel")).toBe(true);
    expect(await admin.bulk("send_now", ["sam-lee", "jordan-patel"])).toBe("/admin?done=bulk&n=0&m=2");
    expect(queue(env)).toHaveLength(2);
    expect(history(env, "jordan-patel")).toEqual([["send", "Asked for jobs now", "Alex Morgan"]]);
  });

  it("assigns the ticked recruits, skipping those already that recruiter's, shown as assigning until applied", async () => {
    const { env, admin } = await setup();
    expect(await admin.bulk("assign", ["sam-lee", "jordan-patel"], { recruiter: "casey" })).toBe("/admin?done=bulk&n=1&m=1");
    expect(queue(env)[0]).toMatchObject({ op: "assign", us: ["jordan-patel"], recruiter: "casey" });
    expect(history(env, "jordan-patel")).toEqual([["assign", "Assigned to Casey Quinn", "Alex Morgan"]]);
    expect(await admin.text("/admin")).toContain("assigning");
    expect(await admin.bulk("assign", ["jordan-patel"], { recruiter: "nobody-here" })).toBe("/admin?done=badrecruiter");
  });

  it("refuses an empty tick list, more than 25 recruits and an expired form", async () => {
    const { env, admin } = await setup();
    expect(await admin.bulk("pause", [])).toBe("/admin?done=bulknone");
    expect(await admin.bulk("pause", Array.from({ length: 26 }, (_, i) => `r-${i}`))).toBe("/admin?done=bulkmany");
    expect(await admin.text("/admin?done=bulkmany")).toContain("Tick at most 25 recruits at a time.");
    expect((await admin.raw({ csrf: "0".repeat(64), action: "bulk", op: "pause", u: ["sam-lee"] })).status).toBe(403);
    expect(queue(env)).toEqual([]);
  });

  it("lists a bulk change as a task per recruit; cancelling one cancels the batch and notes it on each", async () => {
    const { env, admin } = await setup();
    await admin.bulk("resume", ["riley-chen", "jordan-patel"]);
    await admin.bulk("pause", ["jordan-patel", "sam-lee"]);
    const [, batch] = queue(env).sort((a, b) => a.id.localeCompare(b.id));
    const tasks = await admin.text("/admin/tasks");
    expect(tasks.split(`name="task" value="${batch.id}"`)).toHaveLength(3);
    const res = await admin.send({ task: batch.id }, "/admin/tasks");
    expect(res.headers.get("Location")).toBe("/admin/tasks?done=cancelled");
    expect(queue(env).map((i) => i.op)).toEqual(["resume"]);
    expect(history(env, "sam-lee").map((h) => h[1])).toEqual(["Paused reports", "Cancelled: Pause reports"]);
  });
});

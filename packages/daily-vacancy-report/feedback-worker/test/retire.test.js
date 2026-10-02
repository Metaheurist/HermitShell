import { describe, expect, it } from "vitest";
import worker, { sign } from "../src/index.js";
import { today } from "../src/lib.js";
import { BASE, keysWith, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const CASEY_PASSWORD = "a long enough passphrase";
const DAY = 86400000;
const RETIRED_AT = Date.UTC(2026, 8, 1, 12);
const PROFILES = [
  { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false, recruit: "" },
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true, recruiter: "casey" },
  { id: "jordan-patel", name: "Jordan Patel", email: "jordan@contoso.example", status: "active", has_cv: true },
  { id: "riley-chen", name: "Riley Chen", email: "riley@example.com", status: "retired", has_cv: true, recruiter: "casey",
    retired: RETIRED_AT, keep_until: RETIRED_AT + 182 * DAY, keep_months: 0 },
];

function post(path, fields, headers = {}) {
  const pairs = Object.entries(fields).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]));
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(pairs), headers });
}

async function signIn(env, username, password, ip) {
  const res = await worker.fetch(post("/admin/login", { username, password }, { "CF-Connecting-IP": ip }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = (path) => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
  const text = async (path) => (await get(path)).text();
  const csrf = async () => (await text("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const send = async (fields, path = "/admin/action") => worker.fetch(post(path, { csrf: await csrf(), ...fields }, { Cookie: cookie }), env);
  const raw = (fields) => worker.fetch(post("/admin/action", fields, { Cookie: cookie }), env);
  const to = async (fields) => (await send(fields)).headers.get("Location");
  return { get, text, raw, send, to };
}

async function report(env, profiles = PROFILES) {
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles }) }), env);
}

async function setup() {
  const env = testEnv(ADMIN);
  await report(env);
  const admin = await signIn(env, "admin", ADMIN.ADMIN_PASSWORD, "203.0.113.9");
  await admin.send({ op: "add", name: "Casey Quinn", username: "casey", password: CASEY_PASSWORD, roles: "recruiter" }, "/admin/users");
  const casey = await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.10");
  return { env, admin, casey };
}

const queue = (env) => valuesWith(env, "queue:");
const history = (env, u) => valuesWith(env, `history:${u}:`).flat().map((e) => [e.k, e.t, e.by || e.v]);
const listed = (html) => [...html.matchAll(/class="pick" name="u" value="([^"]+)"/g)].map((m) => m[1]);

async function retireLink(profile = "riley-chen", day = today(), name = "Riley Chen") {
  const t = await sign("test-secret", "profile", "retire", name, "", profile, day);
  return { j: "profile", a: "retire", n: name, ...(profile ? { u: profile } : {}), d: String(day), t };
}
const open = (env, params) => worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(params)}`), env);
const choose = (env, params, k) => worker.fetch(post("/f", { ...params, ...(k === undefined ? {} : { k }) }), env);

describe("retiring recruits from the dashboard", () => {
  it("has a red Retire button on the bulk bar that opens a confirm window for the ticked rows", async () => {
    const { admin } = await setup();
    const page = await admin.text("/admin");
    expect(page).toContain('<a class="redbtn" href="#bulk-retire">');
    expect(page).toContain('<div class="modal" id="bulk-retire" role="dialog"');
    expect(page).toContain('<input type="checkbox" name="confirm" value="yes" form="bulk">');
    expect(page).toContain('<button class="danger" form="bulk" name="op" value="retire">');
    expect(page).toContain("reports");
  });

  it("retires the ticked recruits only with the tick box, skipping anyone already retired", async () => {
    const { env, admin } = await setup();
    expect(await admin.to({ action: "bulk", op: "retire", u: ["sam-lee", "jordan-patel"] })).toBe("/admin?done=retireconfirm");
    expect(await admin.text("/admin?done=retireconfirm")).toContain("Tick the confirmation box to retire them.");
    expect(queue(env)).toEqual([]);
    expect(await admin.to({ action: "bulk", op: "retire", u: ["sam-lee", "jordan-patel", "riley-chen", "owner"], confirm: "yes" }))
      .toBe("/admin?done=bulk&n=2&m=2");
    expect(queue(env)).toMatchObject([{ type: "admin", action: "bulk", op: "retire", us: ["sam-lee", "jordan-patel"] }]);
    expect(history(env, "sam-lee")).toEqual([["retire", "Retired: no more reports, and emailed to choose what happens to their data", "Alex Morgan"]]);
    expect(keysWith(env, "history:riley-chen:")).toEqual([]);
  });

  it("skips retired recruits in every other bulk change", async () => {
    const { env, admin } = await setup();
    for (const op of ["pause", "resume", "send_now"]) {
      expect(await admin.to({ action: "bulk", op, u: ["riley-chen"] })).toBe("/admin?done=bulk&n=0&m=1");
    }
    expect(await admin.to({ action: "bulk", op: "assign", u: ["riley-chen"], recruiter: "" })).toBe("/admin?done=bulk&n=0&m=1");
    expect(queue(env)).toEqual([]);
  });

  it("hides retired recruits from the list unless the Retired status is picked, with a link to them", async () => {
    const { admin } = await setup();
    const board = await admin.text("/admin");
    expect(listed(board)).toEqual(["sam-lee", "jordan-patel"]);
    expect(board).toContain('<a class="retiredlink" href="/admin?s=retired">1 retired</a>');
    expect(board).toContain('<option value="retired">Retired</option>');
    const retired = await admin.text("/admin?s=retired");
    expect(listed(retired)).toEqual(["riley-chen"]);
    expect(retired).toContain('<span class="pill retired">retired</span>');
    expect(retired).toContain("Retired ");
    expect(retired).not.toContain('class="retiredlink"');
    expect(retired).not.toMatch(/name="action" value="(send_now|pause|resume)"[^>]*>\s*<input type="hidden" name="u" value="riley-chen"/);
  });
});

describe("retiring a recruit from their page", () => {
  it("ends the Manage section with a Retire button and a confirm window that comes back to the page", async () => {
    const { env, admin } = await setup();
    const page = await admin.text("/admin/profile?u=sam-lee");
    expect(page).toContain('<h2 id="retire">Retire</h2>');
    expect(page).toContain('<a class="redbtn" href="#retire-sam-lee">');
    expect(page).toContain('<div class="modal" id="retire-sam-lee" role="dialog"');
    expect(page.indexOf('id="retire-sam-lee"')).toBeLessThan(page.indexOf('<main class="wide">'));
    expect(await admin.to({ action: "retire", u: "sam-lee", back: "profile" })).toBe("/admin/profile?u=sam-lee&done=retireconfirm");
    expect(queue(env)).toEqual([]);
    expect(await admin.to({ action: "retire", u: "sam-lee", back: "profile", confirm: "yes" })).toBe("/admin/profile?u=sam-lee&done=retiring");
    expect(queue(env)).toMatchObject([{ type: "admin", action: "retire", u: "sam-lee" }]);
    expect(await admin.to({ action: "retire", u: "sam-lee", confirm: "yes" })).toBe("/admin?done=retiring");
  });

  it("shows a retired recruit's dates and a Reactivate button instead, with no Send button", async () => {
    const { env, admin } = await setup();
    const page = await admin.text("/admin/profile?u=riley-chen");
    expect(page).toContain('<h2 id="retire">Retired</h2>');
    expect(page).toContain("Retired on 2026-09-01");
    expect(page).toContain("kept until <b>2026-03-02</b>".replace("2026-03-02", new Date(RETIRED_AT + 182 * DAY).toISOString().slice(0, 10)));
    expect(page).toContain("unless they choose otherwise");
    expect(page).toContain('value="resume"');
    expect(page).not.toContain('id="retire-riley-chen"');
    expect(await admin.to({ action: "retire", u: "riley-chen", confirm: "yes" })).toBe("/admin?done=retiring");
    expect(await admin.to({ action: "pause", u: "riley-chen", back: "profile" })).toBe("/admin/profile?u=riley-chen&done=nochange");
    expect(queue(env)).toEqual([]);
    expect(await admin.to({ action: "resume", u: "riley-chen", back: "profile" })).toBe("/admin/profile?u=riley-chen&done=reactivating");
    expect(queue(env)).toMatchObject([{ type: "admin", action: "resume", u: "riley-chen" }]);
    expect(history(env, "riley-chen")).toEqual([["resume", "Reactivated: reports start again", "Alex Morgan"]]);
  });

  it("names the recruit's own choice of months once they have made it", async () => {
    const { env, admin } = await setup();
    await report(env, PROFILES.map((p) => (p.id === "riley-chen" ? { ...p, keep_months: 12 } : p)));
    expect(await admin.text("/admin/profile?u=riley-chen")).toContain("as they chose (12 months)");
  });
});

describe("the retired recruit's email link", () => {
  it("offers 6, 12 or 24 months or deleting everything now", async () => {
    const { env } = await setup();
    const res = await open(env, await retireLink());
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const m of [6, 12, 24]) expect(body).toContain(`<input type="radio" name="k" value="${m}"`);
    expect(body).toContain('<input type="radio" name="k" value="6" checked>');
    expect(body).toContain('<input type="radio" name="k" value="delete">');
    expect(body).toContain("backups included");
    expect(body).toContain('href="/privacy"');
  });

  it("queues a keep choice with the link's day and notes it on their history", async () => {
    const { env } = await setup();
    const params = await retireLink();
    const body = await (await choose(env, params, "12")).text();
    expect(body).toContain("keeps your profile for 12 months");
    expect(queue(env)).toMatchObject([{ type: "retire_choice", u: "riley-chen", keep: 12, d: today() }]);
    expect(history(env, "riley-chen")).toEqual([["retire", "Chose to keep their profile for 12 months", "email"]]);
  });

  it("queues deleting and drops what the Worker keeps of them at once", async () => {
    const { env } = await setup();
    await env.FEEDBACK.put("event:riley-chen:1", JSON.stringify({ a: "applied", u: "riley-chen" }));
    const body = await (await choose(env, await retireLink(), "delete")).text();
    expect(body).toContain("removes them from every backup");
    expect(queue(env)).toMatchObject([{ type: "retire_choice", u: "riley-chen", keep: 0 }]);
    expect([...env.FEEDBACK.store.keys()].filter((k) => k.includes("riley-chen") && !k.startsWith("queue:"))).toEqual([]);
  });

  it("refuses a missing or made-up choice", async () => {
    const { env } = await setup();
    const params = await retireLink();
    for (const k of [undefined, "", "7", "0", "6 ", "-1", "true"]) {
      expect((await choose(env, params, k)).status, String(k)).toBe(400);
    }
    expect(queue(env)).toEqual([]);
  });

  it("has nothing to choose once the recruit is active again", async () => {
    const { env } = await setup();
    const params = await retireLink("sam-lee", today(), "Sam Lee");
    expect(await (await open(env, params)).text()).toContain("Nothing to choose");
    expect(await (await choose(env, params, "delete")).text()).toContain("Nothing to choose");
    expect(queue(env)).toEqual([]);
  });

  it("rejects a link without a recruit, with a forged signature, or past its days", async () => {
    const { env } = await setup();
    expect((await open(env, await retireLink(""))).status).toBe(403);
    const forged = { ...(await retireLink()), u: "jordan-patel" };
    expect((await open(env, forged)).status).not.toBe(200);
    expect((await choose(env, forged, "delete")).status).not.toBe(200);
    expect((await open(env, await retireLink("riley-chen", today() - 91))).status).not.toBe(200);
    expect(queue(env)).toEqual([]);
  });
});

describe("retiring: who may", () => {
  it("lets a recruiter retire only their own recruits, singly or in bulk", async () => {
    const { env, casey } = await setup();
    expect((await casey.send({ action: "retire", u: "jordan-patel", confirm: "yes" })).status).toBe(404);
    expect(await casey.to({ action: "bulk", op: "retire", u: ["sam-lee", "jordan-patel"], confirm: "yes" })).toBe("/admin?done=bulk&n=1&m=1");
    expect(queue(env)).toMatchObject([{ op: "retire", us: ["sam-lee"] }]);
    expect((await casey.send({ action: "resume", u: "jordan-patel" })).status).toBe(404);
  });

  it("refuses an expired form and a malformed recruit id", async () => {
    const { env, admin } = await setup();
    expect((await admin.raw({ csrf: "0".repeat(64), action: "retire", u: "sam-lee", confirm: "yes" })).status).toBe(403);
    const anon = await worker.fetch(post("/admin/action", { csrf: "0".repeat(64), action: "retire", u: "sam-lee", confirm: "yes" }), env);
    expect(anon.status).not.toBe(302);
    expect((await admin.send({ action: "retire", u: "../owner", confirm: "yes" })).status).toBe(400);
    expect(queue(env)).toEqual([]);
  });
});

describe("/api/forget", () => {
  const forget = (env, body, headers = API) => worker.fetch(new Request(`${BASE}/api/forget`, { method: "POST", headers, body }), env);

  it("drops what the Worker keeps of a recruit HermitShell has deleted", async () => {
    const env = testEnv();
    await env.FEEDBACK.put("event:riley-chen:1", JSON.stringify({ a: "applied", u: "riley-chen" }));
    const res = await forget(env, JSON.stringify({ u: "riley-chen" }));
    expect(await res.json()).toEqual({ deleted: true });
    expect([...env.FEEDBACK.store.keys()].filter((k) => k.includes("riley-chen"))).toEqual([]);
  });

  it("needs the API token and a valid recruit id other than the owner", async () => {
    const env = testEnv();
    await env.FEEDBACK.put("event:riley-chen:1", JSON.stringify({ a: "applied", u: "riley-chen" }));
    expect((await forget(env, JSON.stringify({ u: "riley-chen" }), {})).status).toBe(401);
    expect((await forget(env, JSON.stringify({ u: "riley-chen" }), { Authorization: "Bearer wrong" })).status).toBe(401);
    for (const body of ['{"u":"owner"}', '{"u":"../x"}', '{"u":5}', "{}", "not json", JSON.stringify({ u: "x".repeat(2000) })]) {
      expect((await forget(env, body)).status, body.slice(0, 20)).toBe(400);
    }
    expect(env.FEEDBACK.store.has("event:riley-chen:1")).toBe(true);
  });
});

// Managers: a team of recruiter accounts (the "manager" kept on each account), whose recruits, invites, desk and fees
// they see and manage, and nothing else: no other team, no unassigned recruits, no admin page or account.
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { forViewer } from "../src/desk.js";
import { accounts, signedIn } from "../src/users.js";
import { BASE, keysWith, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const PASSWORD = "a long enough passphrase";
const PROFILES = [
  { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false },
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true, recruiter: "casey" },
  { id: "jordan-patel", name: "Jordan Patel", email: "jordan@contoso.example", status: "active", has_cv: true, recruiter: "riley" },
  { id: "robin-shaw", name: "Robin Shaw", email: "robin@fabrikam.example", status: "active", has_cv: true, recruiter: "taylor" },
  { id: "avery-lane", name: "Avery Lane", email: "avery@litware.example", status: "active", has_cv: true },
];
const line = (n, fees = {}) => ({ sent: n * 10, applied: n * 3, interview: n * 2, offer: n, placed: n, fees });
const ranges = (n, fees) => ({ 7: line(n, fees), 30: line(n, fees), 90: line(n, fees), 365: line(n, fees) });
const DESK = { recruits: { "sam-lee": ranges(1, { GBP: 12345 }), "jordan-patel": ranges(2, { GBP: 6789 }), "robin-shaw": ranges(3, { GBP: 4321 }) } };

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

async function signIn(env, username, ip) {
  const password = username === "admin" ? ADMIN.ADMIN_PASSWORD : PASSWORD;
  const res = await worker.fetch(post("/admin/login", { username, password }, { "CF-Connecting-IP": ip }), env);
  return (res.headers.get("Set-Cookie") || "").split(";")[0];
}

// `fields` values that are arrays are sent as repeated fields (roles, ticked recruits).
function client(env, cookie) {
  const get = async (path) => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
  const text = async (path) => (await get(path)).text();
  const csrf = async () => (await text("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  const send = async (path, fields) => {
    const body = new URLSearchParams({ csrf: await csrf() });
    for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) body.append(k, one);
    return worker.fetch(new Request(`${BASE}${path}`, { method: "POST", body, headers: { Cookie: cookie } }), env);
  };
  const where = async (path, fields) => (await send(path, fields)).headers.get("Location");
  return { get, text, send, where };
}

// Morgan Ellis manages Casey Quinn (Sam Lee's recruiter); Drew Harper manages Taylor Reid (Robin Shaw's); Riley Chen
// (Jordan Patel's) is in no team, and Avery Lane is nobody's recruit.
async function setup({ morganRoles = ["manager"] } = {}) {
  const env = testEnv(ADMIN);
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles: PROFILES }) }), env);
  await worker.fetch(new Request(`${BASE}/api/desk`, { method: "POST", headers: API, body: JSON.stringify({ desk: DESK }) }), env);
  const admin = client(env, await signIn(env, "admin", "203.0.113.50"));
  const add = (fields) => admin.where("/admin/users", { op: "add", password: PASSWORD, ...fields });
  expect(await add({ name: "Morgan Ellis", username: "morgan", roles: morganRoles })).toBe("/admin/users?done=added");
  expect(await add({ name: "Drew Harper", username: "drew", roles: "manager" })).toBe("/admin/users?done=added");
  expect(await add({ name: "Casey Quinn", username: "casey", roles: "recruiter", manager: "morgan" })).toBe("/admin/users?done=added");
  expect(await add({ name: "Taylor Reid", username: "taylor", roles: "recruiter", manager: "drew" })).toBe("/admin/users?done=added");
  expect(await add({ name: "Riley Chen", username: "riley", roles: "recruiter" })).toBe("/admin/users?done=added");
  const morgan = client(env, await signIn(env, "morgan", "203.0.113.51"));
  const casey = client(env, await signIn(env, "casey", "203.0.113.52"));
  return { env, admin, morgan, casey };
}

const stored = (env) => JSON.parse(env.FEEDBACK.store.get("accounts")).users;

describe("teams", () => {
  it("keeps a team only for a recruiter-only account under someone with the Manager role", async () => {
    const env = testEnv();
    const u = (id, roles, manager) => ({ id, name: id, salt: "00", hash: "00", roles, manager });
    await env.FEEDBACK.put("accounts", JSON.stringify({ admin: { roles: ["admin", "manager"] }, users: [
      u("morgan", ["manager"]), u("boss", ["admin", "manager"]), u("riley", ["recruiter"]),
      u("casey", ["recruiter"], "morgan"), u("jamie", ["recruiter", "manager"], "morgan"), u("taylor", ["recruiter"], "riley"),
      u("robin", ["recruiter"], "boss"), u("drew", ["recruiter"], "admin"), u("avery", ["recruiter"], "nobody")] }));
    const acc = await accounts(env);
    expect(acc.admin.roles).toEqual(["admin"]);
    expect(Object.fromEntries(acc.users.map((x) => [x.id, x.manager]))).toEqual({
      morgan: "", boss: "", riley: "", casey: "morgan", jamie: "", taylor: "", robin: "", drew: "", avery: "" });
    expect(signedIn("morgan", acc)).toMatchObject({ manager: true, admin: false, recruiter: false, team: ["casey"] });
    expect(signedIn("jamie", acc)).toMatchObject({ manager: true, recruiter: true, team: ["jamie"] });
    expect(signedIn("boss", acc)).toMatchObject({ admin: true, manager: false });
    expect(signedIn("casey", acc)).toMatchObject({ manager: false, team: [] });
  });

  it("empties a team when its manager is demoted or deleted", async () => {
    const { env, admin } = await setup();
    expect(stored(env).find((x) => x.id === "casey").manager).toBe("morgan");
    expect(await admin.where("/admin/users", { op: "edit", id: "morgan", name: "Morgan Ellis", roles: "recruiter" })).toBe("/admin/users?done=updated");
    expect((await accounts(env)).users.find((x) => x.id === "casey").manager).toBe("");
    expect(await admin.where("/admin/users", { op: "delete", id: "drew", confirm: "yes" })).toBe("/admin/users?done=deleted");
    expect((await accounts(env)).users.find((x) => x.id === "taylor").manager).toBe("");
  });

  it("lets an admin pick a recruiter's manager, and lists each team", async () => {
    const { env, admin } = await setup();
    const page = await admin.text("/admin/users");
    expect(page).toContain('<span class="role manager">Manager</span>');
    expect(page).toContain("<div class=\"muted\">in Morgan Ellis's team</div>");
    expect(page).toContain('<b>1</b> <span class="muted">recruiter in their team</span>');
    expect(page).toContain('<select id="ue-casey-team" name="manager"><option value="">No manager</option><option value="morgan" selected>');
    expect(page).toContain('<div class="rolecard manager">');
    expect(page.split('id="user-admin"')[1].split("</form>")[0]).not.toContain('value="manager"');
    expect(await admin.where("/admin/users", { op: "edit", id: "riley", name: "Riley Chen", roles: "recruiter", manager: "drew" }))
      .toBe("/admin/users?done=updated");
    expect(stored(env).find((x) => x.id === "riley").manager).toBe("drew");
    expect(await admin.where("/admin/users", { op: "edit", id: "riley", name: "Riley Chen", roles: "recruiter", manager: "casey" }))
      .toBe("/admin/users?done=updated");
    expect(stored(env).find((x) => x.id === "riley").manager).toBe("");
  });
});

describe("what a manager sees", () => {
  it("shows their team's recruits with the recruiter column, and no admin controls", async () => {
    const { morgan } = await setup();
    const board = await morgan.text("/admin");
    expect(board).toContain("/admin/profile?u=sam-lee");
    for (const other of ["jordan-patel", "robin-shaw", "avery-lane", "/admin/profile?u=owner"]) expect(board).not.toContain(other);
    expect(board).toContain("<th>Recruiter</th>");
    expect(board).toContain('<option value="casey" selected>Casey Quinn</option>');
    expect(board).not.toContain('<option value="riley"');
    expect(board).not.toContain('<option value="">Unassigned</option>');
    expect(board).not.toContain('<option value="">Nobody&#39;s recruit</option>');
    expect(board).toContain('<nav class="tabs"><a href="/admin" class="on" aria-current="page">Recruits</a><a href="/admin/desk">Desk</a><a href="/admin/users">Your team</a></nav>');
    expect(board).not.toContain("Global settings");
    expect(board).not.toContain('class="binbtn"');
    expect(board).not.toContain('id="tasks"');
    expect(board).toContain('aria-label="Signed in as Morgan Ellis (manager)"');
    expect(board).toContain('<span class="avatar mgr"');
  });

  it("stops a manager at every admin-only page and action", async () => {
    const { env, morgan } = await setup();
    for (const path of ["/admin/settings", "/admin/tasks", "/admin/theme", "/admin/notes/export?u=sam-lee"]) {
      expect((await morgan.get(path)).status, path).toBe(403);
    }
    for (const fields of [{ action: "delete", u: "sam-lee", confirm: "yes" }, { action: "api_key", provider: "tavily", key: "tvly-new-key-123" },
      { action: "smtp", host: "smtp.example.com" }, { action: "backup_now" }, { action: "features", self_service: "1" }]) {
      expect((await morgan.send("/admin/action", fields)).status).toBe(403);
    }
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("treats other teams' and unassigned recruits as not found", async () => {
    const { env, morgan } = await setup();
    for (const u of ["jordan-patel", "robin-shaw", "avery-lane", "owner"]) {
      for (const path of [`/admin/profile?u=${u}`, `/admin/stats?u=${u}`, `/admin/sent?u=${u}&r=7`, `/admin/history?u=${u}`, `/admin/pipeline?u=${u}`]) {
        expect((await morgan.get(path)).status, path).toBe(404);
      }
      for (const act of ["pause", "send_now", "profile", "assign"]) {
        expect((await morgan.send("/admin/action", { action: act, u, recruiter: "casey" })).status).toBe(404);
      }
    }
    expect(valuesWith(env, "queue:")).toEqual([]);
    expect((await morgan.get("/admin/profile?u=sam-lee")).status).toBe(200);
  });

  it("shows the team's desk with fees, and nobody else's", async () => {
    const { morgan, casey } = await setup();
    const html = await morgan.text("/admin/desk?r=7");
    expect(html).toContain("Sam Lee");
    expect(html).toContain("\u00a312,345");
    for (const other of ["Jordan", "Robin", "6,789", "4,321"]) expect(html).not.toContain(other);
    expect(html).toContain("Your team's recruits, grouped by recruiter.");
    expect(await casey.text("/admin/desk?r=7")).not.toContain("12,345");
    const me = { id: "morgan", manager: true, team: ["casey"] };
    expect(JSON.stringify(forViewer(DESK, me, PROFILES))).toContain("12345");
    expect(Object.keys(forViewer(DESK, me, PROFILES).recruits)).toEqual(["sam-lee"]);
  });
});

describe("what a manager changes", () => {
  it("assigns only to recruiters in their team, and never leaves a recruit with nobody", async () => {
    const { env, morgan } = await setup();
    expect(await morgan.where("/admin/users", { op: "add", name: "Jamie Walsh", username: "jamie", password: PASSWORD })).toBe("/admin/users?done=added");
    expect(await morgan.where("/admin/action", { action: "assign", u: "sam-lee", recruiter: "riley" })).toBe("/admin?done=badrecruiter");
    expect(await morgan.where("/admin/action", { action: "assign", u: "sam-lee", recruiter: "" })).toBe("/admin?done=badrecruiter");
    expect(await morgan.where("/admin/action", { action: "bulk", op: "assign", u: "sam-lee", recruiter: "" })).toBe("/admin?done=badrecruiter");
    expect(valuesWith(env, "queue:")).toEqual([]);
    expect(await morgan.where("/admin/action", { action: "assign", u: "sam-lee", recruiter: "jamie" })).toBe("/admin?done=assigned");
    expect(valuesWith(env, "queue:").map(({ action, u, recruiter }) => [action, u, recruiter])).toEqual([["assign", "sam-lee", "jamie"]]);
  });

  it("assigns ticked recruits in bulk, skipping anyone outside the team", async () => {
    const { env, morgan } = await setup();
    await morgan.where("/admin/users", { op: "add", name: "Jamie Walsh", username: "jamie", password: PASSWORD });
    expect(await morgan.where("/admin/action", { action: "bulk", op: "assign", recruiter: "jamie", u: ["sam-lee", "jordan-patel", "robin-shaw"] }))
      .toBe("/admin?done=bulk&n=1&m=2");
    expect(valuesWith(env, "queue:").map(({ us }) => us)).toEqual([["sam-lee"]]);
  });

  it("makes and revokes invites only for their team", async () => {
    const { env, admin, morgan } = await setup();
    expect(await morgan.where("/admin/action", { action: "invite", note: "For Avery", recruiter: "riley" })).toBe("/admin?done=badrecruiter");
    expect(await morgan.where("/admin/action", { action: "invite", note: "For Avery", recruiter: "" })).toBe("/admin?done=badrecruiter");
    expect(await morgan.where("/admin/action", { action: "invite", note: "For Avery", recruiter: "casey" })).toMatch(/^\/admin\/invite\?i=[0-9a-f]{32}$/);
    expect(valuesWith(env, "invite:").map((i) => i.recruiter)).toEqual(["casey"]);
    const riley = (await admin.where("/admin/action", { action: "invite", note: "Riley's", recruiter: "riley" })).split("=")[1];
    expect((await morgan.get(`/admin/invite?i=${riley}`)).status).toBe(404);
    await morgan.where("/admin/action", { action: "revoke", invite: riley });
    expect(keysWith(env, "invite:")).toContain(`invite:${riley}`);
    const board = await morgan.text("/admin");
    expect(board).toContain("For Avery");
    expect(board).not.toContain("Riley&#39;s");
  });

  it("sets a placement fee, where a recruiter can't", async () => {
    const { morgan, casey } = await setup();
    const move = (who, fields) => who.send("/admin/stage", { u: "sam-lee", j: "a".repeat(16), a: "placed", ...fields });
    expect((await move(casey, { fee: "900", currency: "GBP" })).status).toBe(403);
    expect((await move(morgan, { fee: "900", currency: "GBP" })).headers.get("Location")).toBe("/admin/pipeline?u=sam-lee&done=feeseal");
  });
});

describe("a manager's team page", () => {
  it("lists only them and their team, without roles, teams or the main admin", async () => {
    const { morgan } = await setup();
    const page = await morgan.text("/admin/users");
    expect(page).toContain("<b>Casey Quinn</b>");
    expect(page).toContain("<b>Morgan Ellis</b> <span class=\"muted\">(you)</span>");
    for (const other of ["<b>Riley Chen</b>", "Drew Harper", "Taylor Reid", "Alex Morgan", 'id="user-admin"', 'name="roles"', 'name="manager"']) {
      expect(page).not.toContain(other);
    }
    expect(page).toContain("<title>Your team");
    expect(page).toContain("They get the Recruiter role and join your team.");
    expect(page).toContain('href="#reset-casey"');
    expect(page).toContain('href="#deluser-casey"');
    expect(page).not.toContain('href="#user-morgan"');
  });

  it("adds recruiters to their own team only, whatever the form says", async () => {
    const { env, morgan } = await setup();
    expect(await morgan.where("/admin/users", { op: "add", name: "Jamie Walsh", username: "jamie", password: PASSWORD, manager: "drew",
      roles: ["admin", "manager"] })).toBe("/admin/users?done=added");
    expect(stored(env).find((x) => x.id === "jamie")).toMatchObject({ roles: ["recruiter"], manager: "morgan" });
  });

  it("renames, resets and deletes their team's recruiters, and nobody else", async () => {
    const { env, morgan } = await setup();
    expect(await morgan.where("/admin/users", { op: "edit", id: "casey", name: "Casey Q", roles: "admin", manager: "" })).toBe("/admin/users?done=updated");
    expect(stored(env).find((x) => x.id === "casey")).toMatchObject({ name: "Casey Q", roles: ["recruiter"], manager: "morgan" });
    for (const fields of [{ op: "edit", id: "riley", name: "R" }, { op: "edit", id: "drew", name: "D" }, { op: "edit", id: "morgan", name: "M" },
      { op: "reset", id: "taylor", password: "new password!", again: "new password!" }, { op: "delete", id: "riley", confirm: "yes" },
      { op: "admin_roles", roles: "recruiter" }, { op: "edit", id: "admin", name: "A" }]) {
      expect(await morgan.where("/admin/users", fields), JSON.stringify(fields)).toMatch(/^\/admin\/users\?done=(notyours|baduser)$/);
    }
    expect(stored(env).map((x) => x.name)).toEqual(["Morgan Ellis", "Drew Harper", "Casey Q", "Taylor Reid", "Riley Chen"]);
    const before = stored(env).find((x) => x.id === "casey").hash;
    expect(await morgan.where("/admin/users", { op: "reset", id: "casey", password: "new password!", again: "new password!" })).toBe("/admin/users?done=reset");
    expect(stored(env).find((x) => x.id === "casey").hash).not.toBe(before);
    expect(await morgan.where("/admin/users", { op: "delete", id: "casey", confirm: "yes" })).toBe("/admin/users?done=deleted");
    expect(valuesWith(env, "queue:").map(({ action, u, recruiter }) => [action, u, recruiter])).toEqual([["assign", "sam-lee", ""]]);
  });

  it("keeps a deleted recruiter's recruits when the manager recruits too", async () => {
    const { env, morgan } = await setup({ morganRoles: ["manager", "recruiter"] });
    expect(await morgan.where("/admin/users", { op: "delete", id: "casey", confirm: "yes" })).toBe("/admin/users?done=deletedmine");
    expect(valuesWith(env, "queue:").map(({ action, u, recruiter }) => [action, u, recruiter])).toEqual([["assign", "sam-lee", "morgan"]]);
  });

  it("is closed to a recruiter", async () => {
    const { casey } = await setup();
    expect((await casey.get("/admin/users")).status).toBe(403);
    expect(await casey.text("/admin")).not.toContain("Your team");
  });
});

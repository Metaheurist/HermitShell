import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { queueItem } from "../src/join.js";
import { accounts, canSee, checkUser, hashPassword, recruiterOf } from "../src/users.js";
import { BASE, keysWith, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const CASEY_PASSWORD = "a long enough passphrase";
const PROFILES = [
  { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, has_cv: true },
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true, recruiter: "casey" },
  { id: "jordan-patel", name: "Jordan Patel", email: "jordan@contoso.example", status: "active", has_cv: true },
];

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

async function signIn(env, username, password, ip = "203.0.113.9") {
  const res = await worker.fetch(post("/admin/login", { username, password }, { "CF-Connecting-IP": ip }), env);
  return { res, cookie: (res.headers.get("Set-Cookie") || "").split(";")[0] };
}

function client(env, cookie) {
  const get = async (path) => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
  const text = async (path) => (await get(path)).text();
  const csrf = async () => (await text("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  const send = async (path, fields) => worker.fetch(post(path, { csrf: await csrf(), ...fields }, { Cookie: cookie }), env);
  const where = async (path, fields) => (await send(path, fields)).headers.get("Location");
  return { cookie, get, text, csrf, send, where };
}

// The main admin signed in, with Casey Quinn added as a recruiter who already has Sam Lee.
async function setup(profiles = PROFILES) {
  const env = testEnv(ADMIN);
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles }) }), env);
  const admin = client(env, (await signIn(env, "admin", ADMIN.ADMIN_PASSWORD)).cookie);
  expect(await admin.where("/admin/users", { op: "add", name: "Casey Quinn", username: "casey", password: CASEY_PASSWORD, roles: "recruiter" }))
    .toBe("/admin/users?done=added");
  const casey = client(env, (await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.10")).cookie);
  return { env, admin, casey };
}

describe("dashboard users", () => {
  it("keeps only a salted hash of each password, and lists users with their roles and recruits", async () => {
    const { env, admin } = await setup();
    expect(await admin.where("/admin/users", { op: "add", name: "Riley Chen", username: "Riley", password: "abc", roles: "recruiter" }))
      .toBe("/admin/users?done=added");
    const stored = env.FEEDBACK.store.get("accounts");
    expect(stored).not.toContain(CASEY_PASSWORD);
    const { users } = JSON.parse(stored);
    expect(users.map(({ id, name, roles, iter, weak }) => ({ id, name, roles, iter, weak }))).toEqual([
      { id: "casey", name: "Casey Quinn", roles: ["recruiter"], iter: 30000, weak: false },
      { id: "riley", name: "Riley Chen", roles: ["recruiter"], iter: 30000, weak: true },
    ]);
    expect(users[0].salt).toMatch(/^[0-9a-f]{32}$/);
    expect(users[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(users[0].salt).not.toBe(users[1].salt);
    const page = await admin.text("/admin/users");
    expect(page).toContain('<a href="/admin/users" class="on" aria-current="page">Users and roles</a>');
    expect(page).toContain("<b>Casey Quinn</b>");
    expect(page).toContain("<code>casey</code>");
    expect(page).toContain('<span class="role recruiter">Recruiter</span>');
    expect(page).toContain('<b>1</b> <span class="muted">recruit</span>');
    expect(page).toContain('<span class="role weak" title="Shorter than the recommended length">short password</span>');
    expect(page).toContain("<b>Alex Morgan</b> <span class=\"muted\">(you)</span>");
    expect(page).toContain('<div class="modal" id="user-new"');
    expect(page).toContain('<div class="modal" id="user-casey"');
    expect(page).toContain('<a class="binbtn" href="#deluser-casey" title="Delete Casey Quinn"');
    expect(page).toContain('<div class="modal" id="deluser-casey"');
    expect(page).toContain("Delete Casey Quinn&#39;s dashboard account");
    expect(page).not.toContain('href="#deluser-admin"');
    expect(page).not.toContain('<span class="muted">delete</span>');
    expect(page).not.toContain(users[0].hash);
    expect(page).not.toContain(users[0].salt);
  });

  it("refuses bad, reserved and taken usernames, missing roles and passwords that are too short", async () => {
    const { admin } = await setup();
    const add = (fields) => admin.where("/admin/users", { op: "add", name: "Riley Chen", username: "riley", password: "good password", roles: "recruiter", ...fields });
    expect(await add({ username: "r" })).toBe("/admin/users?done=baduser");
    expect(await add({ username: "riley.chen" })).toBe("/admin/users?done=baduser");
    expect(await add({ username: "<b>" })).toBe("/admin/users?done=baduser");
    expect(await add({ name: "" })).toBe("/admin/users?done=baduser");
    for (const username of ["admin", "owner", "root", "casey"]) expect(await add({ username })).toBe("/admin/users?done=taken");
    expect(await add({ password: "ab" })).toBe("/admin/users?done=badpass");
    expect(await add({ roles: "" })).toBe("/admin/users?done=badroles");
    expect(await add({ roles: "superuser" })).toBe("/admin/users?done=badroles");
    expect(await add({ username: "__proto__" })).toBe("/admin/users?done=baduser");
  });

  it("hashes the same way every time, and checks a password without saying whether the username exists", async () => {
    const env = testEnv();
    const one = await hashPassword(env, "sam", "ab".repeat(16), 1000);
    expect(await hashPassword(env, "sam", "ab".repeat(16), 1000)).toEqual(one);
    expect((await hashPassword({ JOB_FEEDBACK_SECRET: "other" }, "sam", "ab".repeat(16), 1000)).hash).not.toBe(one.hash);
    const acc = { admin: { roles: ["admin"] }, users: [{ id: "casey", ...one }] };
    expect((await checkUser(env, acc, " Casey ", "sam"))?.id).toBe("casey");
    expect(await checkUser(env, acc, "casey", "Sam")).toBeNull();
    expect(await checkUser(env, acc, "nobody", "sam")).toBeNull();
    expect(await checkUser(env, acc, "casey", undefined)).toBeNull();
  });

  it("ignores stored accounts that are malformed or use a reserved name", async () => {
    const env = testEnv();
    await env.FEEDBACK.put("accounts", JSON.stringify({ admin: { roles: ["recruiter", "superuser"] }, users: [
      { id: "admin", salt: "00", hash: "00", roles: ["admin"] }, { id: "casey", salt: "00", hash: "00", roles: ["nothing"] },
      { id: "riley", salt: "00", hash: "00", roles: ["recruiter", "boss"] }, null, "x"] }));
    const acc = await accounts(env);
    expect(acc.admin.roles).toEqual(["admin", "recruiter"]);
    expect(acc.users.map((u) => [u.id, u.roles])).toEqual([["riley", ["recruiter"]]]);
  });
});

describe("recruiter sign-in and what they can see", () => {
  it("signs a recruiter in with their own session and shows only their pool", async () => {
    const { casey } = await setup();
    expect(casey.cookie).toMatch(/^__Host-hv_admin=\d+\.casey\.[0-9a-f]{40}$/);
    const board = await casey.text("/admin");
    expect(board).toContain("/admin/profile?u=sam-lee");
    expect(board).not.toContain("jordan-patel");
    expect(board).not.toContain("Jordan Patel");
    expect(board).not.toContain("/admin/profile?u=owner");
    expect(board).not.toContain("<th>Recruiter</th>");
    expect(board).not.toContain("Users and roles");
    expect(board).not.toContain("Global settings");
    expect(board).not.toContain('value="delete"');
    expect(board).not.toContain('class="binbtn"');
    expect(board).not.toContain('id="del-sam-lee"');
    expect(board).toContain("Signed in as <b>Casey Quinn (recruiter)</b>");
    expect(board).toContain("The person joins your recruits.");
    expect(board).not.toContain('name="recruiter"');
  });

  it("says when a recruiter has nobody yet", async () => {
    const { casey } = await setup(PROFILES.map((p) => ({ ...p, recruiter: undefined })));
    expect(await casey.text("/admin")).toContain("You have no recruits yet.");
  });

  it("refuses a wrong password, a forged cookie and a cookie for someone else", async () => {
    const { env, casey } = await setup();
    expect((await signIn(env, "casey", "wrong password", "203.0.113.11")).res.status).toBe(401);
    const [exp, , sig] = casey.cookie.split("=")[1].split(".");
    for (const forged of [`${exp}.admin.${sig}`, `${exp}.riley.${sig}`, `${Number(exp) + 1}.casey.${sig}`, `${exp}.casey.${"0".repeat(40)}`]) {
      const body = await client(env, `__Host-hv_admin=${forged}`).text("/admin");
      expect(body).toContain("Admin sign-in");
    }
  });

  it("stops a recruiter at every admin-only page and action", async () => {
    const { env, casey } = await setup();
    for (const path of ["/admin/settings", "/admin/users"]) {
      const res = await casey.get(path);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Only an admin can open this page.");
    }
    expect((await casey.send("/admin/users", { op: "add", name: "Riley Chen", username: "riley", password: "good password", roles: "admin" })).status).toBe(403);
    for (const fields of [{ action: "delete", u: "sam-lee", confirm: "yes" }, { action: "assign", u: "jordan-patel", recruiter: "casey" },
      { action: "api_key", provider: "tavily", key: "tvly-new-key-123" }, { action: "api_keys_clear", provider: "tavily" },
      { action: "smtp", host: "smtp.example.com" }, { action: "set_key", u: "sam-lee" }]) {
      expect((await casey.send("/admin/action", fields)).status).toBe(403);
    }
    expect(JSON.parse(env.FEEDBACK.store.get("accounts")).users).toHaveLength(1);
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("treats anyone else's recruit as not found, on every page and action", async () => {
    const { env, casey } = await setup();
    for (const u of ["jordan-patel", "owner"]) {
      for (const path of [`/admin/profile?u=${u}`, `/admin/stats?u=${u}`, `/admin/sent?u=${u}&r=7`]) {
        expect((await casey.get(path)).status).toBe(404);
      }
      expect((await casey.get(`/admin/status?u=${u}`)).status).toBe(404);
      expect((await casey.get(`/admin/doc?u=${u}&k=cover_letter&h=${"a".repeat(32)}`)).status).toBe(404);
      for (const act of ["pause", "resume", "send_now", "profile"]) {
        expect((await casey.send("/admin/action", { action: act, u })).status).toBe(404);
      }
      expect((await casey.send("/admin/doc", { u, j: "a".repeat(16), k: "cover_letter", n: "Analyst" })).status).toBe(404);
      expect((await casey.send("/admin/cv", { u })).status).toBe(404);
    }
    expect(valuesWith(env, "queue:")).toEqual([]);
    expect((await casey.get("/admin/profile?u=sam-lee")).status).toBe(200);
    expect(await casey.where("/admin/action", { action: "pause", u: "sam-lee" })).toBe("/admin?done=queued");
    expect(valuesWith(env, "queue:").map(({ action, u }) => [action, u])).toEqual([["pause", "sam-lee"]]);
  });

  it("shows a recruiter's profile page without admin-only controls", async () => {
    const { admin, casey } = await setup();
    expect(await casey.text("/admin/profile?u=sam-lee")).not.toContain("Global settings");
    expect(await admin.text("/admin/profile?u=sam-lee")).toContain("Global settings");
  });

  it("lists only a recruiter's own tasks and will not cancel anyone else's", async () => {
    const { env, casey } = await setup();
    const theirs = await queueItem(env, { type: "admin", action: "pause", u: "jordan-patel" });
    await queueItem(env, { type: "admin", action: "pause", u: "sam-lee" });
    const tasks = await casey.text("/admin/tasks");
    expect(tasks).toContain('<span class="twho">Sam Lee</span>');
    expect(tasks).not.toContain("Jordan Patel");
    expect(await casey.where("/admin/tasks", { task: theirs })).toBe("/admin/tasks?done=gone");
    expect(keysWith(env, "queue:")).toContain(theirs);
  });
});

describe("recruiters' pools", () => {
  it("puts the people a recruiter invites in that recruiter's pool, whatever the form says", async () => {
    const { env, admin, casey } = await setup();
    await admin.where("/admin/users", { op: "add", name: "Riley Chen", username: "riley", password: "another good one", roles: "recruiter" });
    const made = await (await casey.send("/admin/action", { action: "invite", note: "Jamie", recruiter: "riley" })).text();
    expect(made).toContain("They join your recruits.");
    const id = made.match(/\/join\?i=([0-9a-f]{32})/)[1];
    expect(JSON.parse(env.FEEDBACK.store.get(`invite:${id}`)).recruiter).toBe("casey");
    const form = new FormData();
    Object.entries({ i: id, name: "Jamie Doe", email: "jamie@example.com", roles: "Analyst", consent: "yes", cv_text: "Data analyst with SQL and Python. ".repeat(10) })
      .forEach(([k, v]) => form.append(k, v));
    await worker.fetch(new Request(`${BASE}/join?i=${id}`, { method: "POST", body: form }), env);
    const signup = valuesWith(env, "queue:").find((i) => i.type === "signup");
    expect(signup.recruiter).toBe("casey");
    expect(await casey.text("/admin")).toContain("<b>Jamie Doe</b>");
    const riley = client(env, (await signIn(env, "riley", "another good one", "203.0.113.12")).cookie);
    expect(await riley.text("/admin")).not.toContain("Jamie Doe");
    const board = await admin.text("/admin");
    expect(board).toContain("<b>Jamie Doe</b>");
  });

  it("lets a recruiter revoke only their own invites", async () => {
    const { env, admin, casey } = await setup();
    const own = (await (await casey.send("/admin/action", { action: "invite", note: "Mine" })).text()).match(/\/join\?i=([0-9a-f]{32})/)[1];
    const other = (await (await admin.send("/admin/action", { action: "invite", note: "Theirs", recruiter: "" })).text()).match(/\/join\?i=([0-9a-f]{32})/)[1];
    expect(await casey.text("/admin")).not.toContain("Theirs");
    await casey.send("/admin/action", { action: "revoke", invite: other });
    await casey.send("/admin/action", { action: "revoke", invite: own });
    expect(keysWith(env, "invite:")).toEqual([`invite:${other}`]);
  });

  it("lets the admin pick whose recruit an invite makes, and refuses someone who is not a recruiter", async () => {
    const { env, admin } = await setup();
    let board = await admin.text("/admin");
    expect(board).toContain('<option value="" selected>Nobody&#39;s recruit</option>');
    expect(board).toContain('<option value="casey">Casey Quinn&#39;s recruit</option>');
    expect(await admin.where("/admin/users", { op: "admin_roles", roles: "recruiter" })).toBe("/admin/users?done=updated");
    board = await admin.text("/admin");
    expect(board).toContain('<option value="admin" selected>Alex Morgan&#39;s recruit</option>');
    expect(board).toContain("Signed in as <b>Alex Morgan (admin, recruiter)</b>");
    const made = await (await admin.send("/admin/action", { action: "invite", note: "For me", recruiter: "admin" })).text();
    expect(made).toContain("They join your recruits.");
    expect(await admin.where("/admin/action", { action: "invite", recruiter: "nobody" })).toBe("/admin?done=badrecruiter");
    expect(valuesWith(env, "invite:").map((i) => i.recruiter)).toEqual(["admin"]);
  });

  it("keeps the main admin an admin whatever roles are ticked", async () => {
    const { env, admin } = await setup();
    await admin.where("/admin/users", { op: "admin_roles" });
    expect((await accounts(env)).admin.roles).toEqual(["admin"]);
    expect((await admin.get("/admin/settings")).status).toBe(200);
  });

  it("assigns a recruit to a recruiter, shows it at once, and refuses the owner or someone who is not a recruiter", async () => {
    const { env, admin } = await setup();
    await admin.where("/admin/users", { op: "add", name: "Riley Chen", username: "riley", password: "another good one", roles: "admin" });
    const board = await admin.text("/admin");
    expect(board).toContain("<th>Recruiter</th>");
    expect(board).toContain('<select name="recruiter" aria-label="Recruiter for Jordan Patel">');
    expect(board).toContain('<span class="muted">The main admin</span>');
    expect(await admin.where("/admin/action", { action: "assign", u: "jordan-patel", recruiter: "casey" })).toBe("/admin?done=assigned");
    for (const fields of [{ u: "owner", recruiter: "casey" }, { u: "jordan-patel", recruiter: "riley" }, { u: "nobody", recruiter: "casey" },
      { u: "jordan-patel", recruiter: "admin" }]) {
      expect(await admin.where("/admin/action", { action: "assign", ...fields })).toBe("/admin?done=badrecruiter");
    }
    expect(await admin.where("/admin/action", { action: "assign", u: "sam-lee", recruiter: "" })).toBe("/admin?done=assigned");
    expect(valuesWith(env, "queue:").map(({ type, action, u, recruiter }) => ({ type, action, u, recruiter }))).toEqual([
      { type: "admin", action: "assign", u: "jordan-patel", recruiter: "casey" },
      { type: "admin", action: "assign", u: "sam-lee", recruiter: "" },
    ]);
    const after = await admin.text("/admin");
    const jordan = after.slice(after.indexOf("Recruiter for Jordan Patel"));
    expect(jordan.slice(0, jordan.indexOf("</select>"))).toContain('<option value="casey" selected>Casey Quinn</option>');
    expect(await admin.text("/admin/tasks")).toContain("Assign to a recruiter");
  });

  it("works out a recruit's recruiter from the queue first, and never lets a recruiter see the owner", () => {
    const p = { id: "sam-lee", recruiter: "casey" };
    const queue = [{ id: "queue:2", type: "admin", action: "assign", u: "sam-lee", recruiter: "riley" },
      { id: "queue:1", type: "admin", action: "assign", u: "sam-lee", recruiter: "" }];
    expect(recruiterOf(p)).toBe("casey");
    expect(recruiterOf(p, queue)).toBe("riley");
    expect(recruiterOf(p, queue.slice(1))).toBe("");
    expect(canSee({ id: "casey" }, p)).toBe(true);
    expect(canSee({ id: "riley" }, p)).toBe(false);
    expect(canSee({ id: "casey" }, { id: "owner", owner: true, recruiter: "casey" })).toBe(false);
    expect(canSee({ id: "x", admin: true }, { id: "owner", owner: true })).toBe(true);
  });
});

describe("signing users out", () => {
  it("signs a user out when an admin resets their password, and each user's sign-out leaves the others signed in", async () => {
    const { env, admin, casey } = await setup();
    expect(await casey.text("/admin")).toContain("Casey Quinn");
    expect(await admin.where("/admin/users", { op: "edit", id: "casey", name: "Casey Q", roles: "recruiter" }))
      .toBe("/admin/users?done=updated");
    expect(await casey.text("/admin")).toContain("Casey Q (recruiter)");
    expect(await admin.where("/admin/users", { op: "reset", id: "casey", password: "a new passphrase here", again: "a new passphrase here" }))
      .toBe("/admin/users?done=reset");
    expect(await casey.text("/admin")).toContain("Admin sign-in");
    expect((await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.13")).res.status).toBe(401);
    const again = client(env, (await signIn(env, "casey", "a new passphrase here", "203.0.113.14")).cookie);
    expect(await again.text("/admin")).toContain("Signed in as <b>Casey Q (recruiter)</b>");
    await worker.fetch(post("/admin/logout", {}, { Cookie: again.cookie }), env);
    expect(await again.text("/admin")).toContain("Admin sign-in");
    expect(await admin.text("/admin")).toContain("Signed in as");
    await worker.fetch(post("/admin/logout", {}, { Cookie: admin.cookie }), env);
    expect(await admin.text("/admin")).toContain("Admin sign-in");
  });

  it("keeps a name change from signing the user out, and never lets an admin demote themselves", async () => {
    const { env, admin, casey } = await setup();
    await admin.where("/admin/users", { op: "edit", id: "casey", name: "Casey Quinn", roles: ["recruiter"] });
    expect(await casey.text("/admin")).toContain("Signed in as");
    await admin.where("/admin/users", { op: "add", name: "Riley Chen", username: "riley", password: "another good one", roles: "admin" });
    const riley = client(env, (await signIn(env, "riley", "another good one", "203.0.113.15")).cookie);
    expect(await riley.where("/admin/users", { op: "edit", id: "riley", name: "Riley Chen", roles: "recruiter" })).toBe("/admin/users?done=self");
    expect(await riley.where("/admin/users", { op: "delete", id: "riley", confirm: "yes" })).toBe("/admin/users?done=self");
    expect(await riley.where("/admin/users", { op: "reset", id: "casey", password: "ab", again: "ab" })).toBe("/admin/users?done=badpass");
  });

  it("deletes a user only when confirmed, signs them out, unassigns their recruits and drops their invites", async () => {
    const { env, admin, casey } = await setup();
    await casey.send("/admin/action", { action: "invite", note: "Mine" });
    const adminInvite = await admin.send("/admin/action", { action: "invite", note: "Admin's", recruiter: "" });
    expect(adminInvite.status).toBe(200);
    expect(await admin.where("/admin/users", { op: "delete", id: "casey" })).toBe("/admin/users?done=confirmuser");
    expect(await admin.where("/admin/users", { op: "delete", id: "casey", confirm: "yes" })).toBe("/admin/users?done=deleted");
    expect(JSON.parse(env.FEEDBACK.store.get("accounts")).users).toEqual([]);
    expect(await casey.text("/admin")).toContain("Admin sign-in");
    expect(valuesWith(env, "queue:").map(({ action, u, recruiter }) => ({ action, u, recruiter })))
      .toEqual([{ action: "assign", u: "sam-lee", recruiter: "" }]);
    expect(valuesWith(env, "invite:").map((i) => i.note)).toEqual(["Admin's"]);
  });
});

describe("passwords", () => {
  const changeTo = (password, current = CASEY_PASSWORD, again = password) => ({ current, password, again });

  it("lets a recruiter change their own password from the Recruits page, keeping this session and ending the others", async () => {
    const { env, casey } = await setup();
    const other = client(env, (await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.20")).cookie);
    const page = await casey.text("/admin");
    expect(page).toContain('<a class="small quiet mine" href="#password">Change password</a>');
    expect(page).toContain('<div class="modal" id="password"');
    expect(page).toContain('<form method="post" action="/admin/password">');
    expect(page).toContain('autocomplete="current-password"');
    expect(page).toContain('<input type="text" name="username" value="casey" autocomplete="username" hidden readonly>');
    const res = await casey.send("/admin/password", changeTo("my brand new passphrase"));
    expect(res.headers.get("Location")).toBe("/admin?done=password");
    const cookie = res.headers.get("Set-Cookie");
    expect(cookie).toMatch(/^__Host-hv_admin=\d+\.casey\.[0-9a-f]{40}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
    expect(cookie.split(";")[0].split(".")[0]).toBe(casey.cookie.split(".")[0]);
    const kept = client(env, cookie.split(";")[0]);
    expect(await kept.text("/admin?done=password")).toContain("Password changed. You are still signed in here");
    expect(await casey.text("/admin")).toContain("Admin sign-in");
    expect(await other.text("/admin")).toContain("Admin sign-in");
    expect((await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.21")).res.status).toBe(401);
    expect((await signIn(env, "casey", "my brand new passphrase", "203.0.113.22")).res.status).toBe(303);
    expect(env.FEEDBACK.store.get("accounts")).not.toContain("my brand new passphrase");
  });

  it("changes nothing on a wrong current password, a mismatch or a password that is too short", async () => {
    const { env, casey } = await setup();
    const before = env.FEEDBACK.store.get("accounts");
    expect(await casey.where("/admin/password", changeTo("my brand new passphrase", "not my password"))).toBe("/admin?done=badcurrent#password");
    expect(await casey.where("/admin/password", changeTo("my brand new passphrase", CASEY_PASSWORD, "something else"))).toBe("/admin?done=mismatch#password");
    expect(await casey.where("/admin/password", changeTo("ab"))).toBe("/admin?done=badpass#password");
    expect(await casey.where("/admin/password", changeTo("x".repeat(201)))).toBe("/admin?done=badpass#password");
    expect(env.FEEDBACK.store.get("accounts")).toBe(before);
    expect(await casey.text("/admin?done=badcurrent")).toContain("Your current password was wrong");
    expect(await casey.text("/admin?done=mismatch")).toContain("The two new passwords were different");
  });

  it("locks changing a password after five wrong current passwords, even with the right one", async () => {
    const { env, admin, casey } = await setup();
    for (let i = 0; i < 5; i++) {
      expect(await casey.where("/admin/password", changeTo("my brand new passphrase", `wrong ${i}`))).toBe("/admin?done=badcurrent#password");
    }
    expect(await casey.where("/admin/password", changeTo("my brand new passphrase"))).toBe("/admin?done=pwlocked#password");
    expect((await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.23")).res.status).toBe(303);
    expect(await admin.where("/admin/users", { op: "reset", id: "casey", password: "reset by an admin", again: "reset by an admin" }))
      .toBe("/admin/users?done=reset");
    expect(env.FEEDBACK.store.has("pwlock:casey")).toBe(false);
  });

  it("refuses a forged or missing CSRF token and a signed-out request", async () => {
    const { env, casey } = await setup();
    const forged = await worker.fetch(post("/admin/password", { csrf: "0".repeat(32), ...changeTo("my brand new passphrase") },
      { Cookie: casey.cookie }), env);
    expect(forged.status).toBe(403);
    const missing = await worker.fetch(post("/admin/password", changeTo("my brand new passphrase"), { Cookie: casey.cookie }), env);
    expect(missing.status).toBe(403);
    const anon = await worker.fetch(post("/admin/password", changeTo("my brand new passphrase")), env);
    expect(await anon.text()).toContain("Admin sign-in");
    expect((await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.24")).res.status).toBe(303);
  });

  it("shows the main admin how to change the ADMIN_PASSWORD secret instead of a form", async () => {
    const { admin } = await setup();
    const page = await admin.text("/admin");
    expect(page).toContain('<div class="modal" id="password"');
    expect(page).toContain("npx wrangler secret put ADMIN_PASSWORD");
    expect(page).not.toContain('action="/admin/password"');
    expect(await admin.where("/admin/password", changeTo("my brand new passphrase", ADMIN.ADMIN_PASSWORD))).toBe("/admin?done=mainpass#password");
    expect(await admin.text("/admin")).toContain("Signed in as");
  });

  it("lets an admin reset another user's password from Users and roles, but not their own or the main admin's", async () => {
    const { env, admin, casey } = await setup();
    const page = await admin.text("/admin/users");
    expect(page).toContain('href="#reset-casey"');
    expect(page).toContain('<div class="modal" id="reset-casey"');
    expect(page).toContain("Reset Casey Quinn&#39;s password");
    expect(page).not.toContain('href="#reset-admin"');
    expect(page).not.toContain('value="casey" autocomplete="username"');
    expect(page).not.toContain('placeholder="Leave empty to keep it"');
    expect(await admin.where("/admin/users", { op: "reset", id: "casey", password: "reset by an admin", again: "not the same" }))
      .toBe("/admin/users?done=mismatch");
    expect(await casey.text("/admin")).toContain("Signed in as");
    expect(await admin.where("/admin/users", { op: "reset", id: "admin", password: "reset by an admin", again: "reset by an admin" }))
      .toBe("/admin/users?done=baduser");
    await admin.where("/admin/users", { op: "add", name: "Riley Chen", username: "riley", password: "another good one", roles: "admin" });
    const riley = client(env, (await signIn(env, "riley", "another good one", "203.0.113.25")).cookie);
    expect(await riley.text("/admin/users")).not.toContain('href="#reset-riley"');
    expect(await riley.text("/admin/users")).toContain('<a class="small quiet" href="/admin#password">Change password</a>');
    expect(await riley.where("/admin/users", { op: "reset", id: "riley", password: "reset by an admin", again: "reset by an admin" }))
      .toBe("/admin/users?done=ownpass");
    expect(await riley.where("/admin/users", { op: "reset", id: "casey", password: "reset by riley", again: "reset by riley" }))
      .toBe("/admin/users?done=reset");
    expect(await casey.text("/admin")).toContain("Admin sign-in");
  });

  it("never lets a recruiter reset anyone's password", async () => {
    const { env, admin, casey } = await setup();
    await admin.where("/admin/users", { op: "add", name: "Drew Harper", username: "drew", password: "drew's passphrase", roles: "recruiter" });
    const before = env.FEEDBACK.store.get("accounts");
    const res = await casey.send("/admin/users", { op: "reset", id: "drew", password: "taken over", again: "taken over" });
    expect(res.status).toBe(403);
    expect(env.FEEDBACK.store.get("accounts")).toBe(before);
    expect(await casey.text("/admin")).not.toContain("#reset-");
  });
});

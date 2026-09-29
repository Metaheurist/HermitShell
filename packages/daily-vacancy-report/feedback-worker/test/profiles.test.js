import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { BASE, keysWith, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const CV_TEXT = "Sam Lee. Data analyst with five years of SQL, Power BI and Python. ".repeat(4);

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

async function signIn(env, username = "admin", password = ADMIN.ADMIN_PASSWORD) {
  const res = await worker.fetch(post("/admin/login", { username, password }, { "CF-Connecting-IP": "203.0.113.9" }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  return { res, cookie };
}

async function dashboard(env, cookie, query = "") {
  const res = await worker.fetch(new Request(`${BASE}/admin${query}`, { headers: { Cookie: cookie } }), env);
  const body = await res.text();
  return { res, body, csrf: (body.match(/name="csrf" value="([0-9a-f]+)"/) || [])[1] };
}

async function adminAction(env, cookie, csrf, fields) {
  return worker.fetch(post("/admin/action", { csrf, ...fields }, { Cookie: cookie }), env);
}

async function invite(env) {
  const res = await worker.fetch(new Request(`${BASE}/api/invite`, { method: "POST", headers: API, body: "{}" }), env);
  return new URL((await res.json()).link).searchParams.get("i");
}

function joinForm(id, fields = {}, file = null) {
  const form = new FormData();
  Object.entries({ i: id, name: "Sam Lee", email: "sam@example.com", roles: "Data analyst", consent: "yes", ...fields })
    .forEach(([k, v]) => form.append(k, v));
  if (file) form.append("cv", file);
  return new Request(`${BASE}/join`, { method: "POST", body: form });
}

describe("invite sign-up", () => {
  it("only opens with a live invite and uses it once", async () => {
    const env = testEnv();
    expect((await worker.fetch(new Request(`${BASE}/join?i=${"0".repeat(32)}`), env)).status).toBe(410);
    const id = await invite(env);
    const form = await worker.fetch(new Request(`${BASE}/join?i=${id}`), env);
    expect(await form.text()).toContain('enctype="multipart/form-data"');
    expect((await worker.fetch(joinForm(id, { cv_text: CV_TEXT }), env)).status).toBe(200);
    expect(keysWith(env, "invite:")).toEqual([]);
    expect((await worker.fetch(joinForm(id, { cv_text: CV_TEXT }), env)).status).toBe(410);
    expect(valuesWith(env, "queue:")).toHaveLength(1);
  });

  it("stores an uploaded PDF as-is and queues the sign-up", async () => {
    const env = testEnv();
    const id = await invite(env);
    const pdf = new File([new TextEncoder().encode("%PDF-1.4 test")], "Sam Lee CV.pdf", { type: "application/pdf" });
    await worker.fetch(joinForm(id, { phone: "07700 900123" }, pdf), env);
    const [item] = valuesWith(env, "queue:");
    expect(item).toMatchObject({ type: "signup", name: "Sam Lee", email: "sam@example.com", phone: "07700 900123",
      cv: { kind: "pdf", name: "Sam Lee CV.pdf", size: 13 } });
    const bytes = new Uint8Array(env.FEEDBACK.store.get(item.cv.key));
    expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.4 test");
  });

  it("refuses files that are not what they claim, and sign-ups without a CV", async () => {
    const env = testEnv();
    const id = await invite(env);
    const fake = new File(["MZ not a pdf"], "cv.pdf");
    expect(await (await worker.fetch(joinForm(id, {}, fake), env)).text()).toContain("must be a PDF");
    expect(await (await worker.fetch(joinForm(id, { cv_text: "too short" }), env)).text()).toContain("upload your CV");
    expect(await (await worker.fetch(joinForm(id, { email: "nope", cv_text: CV_TEXT }), env)).text()).toContain("valid email");
    expect(await (await worker.fetch(joinForm(id, { consent: "", cv_text: CV_TEXT }), env)).text()).toContain("tick the box");
    expect(valuesWith(env, "queue:")).toEqual([]);
    expect(keysWith(env, "invite:")).toHaveLength(1);
  });
});

describe("admin gateway", () => {
  it("is switched off until ADMIN_PASSWORD is set", async () => {
    expect((await worker.fetch(new Request(`${BASE}/admin`), testEnv())).status).toBe(404);
  });

  it("shows the sign-in form instead of the dashboard without a session", async () => {
    const env = testEnv(ADMIN);
    const body = await (await worker.fetch(new Request(`${BASE}/admin`), env)).text();
    expect(body).toContain("Admin sign-in");
    expect(body).not.toContain("Invite someone");
    const forged = await worker.fetch(new Request(`${BASE}/admin`, { headers: { Cookie: `hv_admin=${Date.now() + 1e6}.abc` } }), env);
    expect(await forged.text()).toContain("Admin sign-in");
  });

  it("signs in with the right password and sets a locked-down cookie", async () => {
    const env = testEnv(ADMIN);
    const { res, cookie } = await signIn(env);
    expect(res.status).toBe(303);
    expect(res.headers.get("Set-Cookie")).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const { body } = await dashboard(env, cookie);
    expect(body).toContain("Invite someone");
    expect(body).toContain("Hermes has not reported any profiles yet");
  });

  it("locks an address out after five wrong passwords", async () => {
    const env = testEnv(ADMIN);
    for (let i = 0; i < 5; i++) expect((await signIn(env, "admin", "guess")).res.status).toBe(401);
    expect((await signIn(env)).res.status).toBe(429);
    expect((await signIn(env, "root", ADMIN.ADMIN_PASSWORD)).res.status).toBe(429);
  });

  it("rejects actions without the form's CSRF token", async () => {
    const env = testEnv(ADMIN);
    const { cookie } = await signIn(env);
    expect((await adminAction(env, cookie, "0".repeat(32), { action: "pause", u: "sam-lee" })).status).toBe(403);
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("creates and revokes invites", async () => {
    const env = testEnv(ADMIN);
    const { cookie } = await signIn(env);
    const { csrf } = await dashboard(env, cookie);
    const res = await adminAction(env, cookie, csrf, { action: "invite", note: "Sam from the meetup" });
    const link = (await res.text()).match(/\/join\?i=([0-9a-f]{32})/)[1];
    expect(keysWith(env, "invite:")).toEqual([`invite:${link}`]);
    expect((await dashboard(env, cookie)).body).toContain("Sam from the meetup");
    await adminAction(env, cookie, csrf, { action: "revoke", invite: link });
    expect(keysWith(env, "invite:")).toEqual([]);
  });

  it("lists reported profiles and queues crawler key, pause and delete changes", async () => {
    const env = testEnv(ADMIN);
    const status = { profiles: [
      { id: "owner", name: "Owner", email: "owner@example.com", status: "active", owner: true, crawler: "global" },
      { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", crawler: "own", key_hint: "fc-...9f2" },
    ], global: { source: "env" } };
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify(status) }), env);
    const { cookie } = await signIn(env);
    const { body, csrf } = await dashboard(env, cookie);
    expect(body).toContain("Sam Lee");
    expect(body).toContain("own key fc-...9f2");
    expect(body.match(/delete CV and history/g)).toHaveLength(1);

    await adminAction(env, cookie, csrf, { action: "set_key", u: "sam-lee", key: "fc-test-own-key" });
    await adminAction(env, cookie, csrf, { action: "pause", u: "sam-lee" });
    expect((await adminAction(env, cookie, csrf, { action: "delete", u: "sam-lee" })).headers.get("Location")).toBe("/admin?done=confirm");
    await adminAction(env, cookie, csrf, { action: "delete", u: "sam-lee", confirm: "yes" });
    expect((await adminAction(env, cookie, csrf, { action: "global_keys", keys: "bad key!" })).headers.get("Location")).toBe("/admin?done=badkey");
    await adminAction(env, cookie, csrf, { action: "global_keys", keys: "fc-one11111, fc-two22222" });
    expect((await adminAction(env, cookie, csrf, { action: "pause", u: "../etc" })).status).toBe(400);

    const queued = valuesWith(env, "queue:").map(({ action, u, key, keys }) => ({ action, u, key, keys }));
    expect(queued).toEqual([
      { action: "set_key", u: "sam-lee", key: "fc-test-own-key", keys: undefined },
      { action: "pause", u: "sam-lee", key: undefined, keys: undefined },
      { action: "delete", u: "sam-lee", key: undefined, keys: undefined },
      { action: "global_keys", u: undefined, key: undefined, keys: ["fc-one11111", "fc-two22222"] },
    ]);
    expect((await dashboard(env, cookie)).body).toContain("Waiting for Hermes");
  });

  it("signs out", async () => {
    const env = testEnv(ADMIN);
    const { cookie } = await signIn(env);
    const res = await worker.fetch(post("/admin/logout", {}, { Cookie: cookie }), env);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});

describe("Hermes API", () => {
  it("needs the API token", async () => {
    const env = testEnv();
    for (const path of ["/api/queue", "/api/file?k=cvfile:x"]) {
      expect((await worker.fetch(new Request(`${BASE}${path}`), env)).status).toBe(401);
    }
    expect((await worker.fetch(new Request(`${BASE}/api/invite`, { method: "POST", body: "{}" }), env)).status).toBe(401);
  });

  it("hands over queued sign-ups with their CV and forgets them once acknowledged", async () => {
    const env = testEnv();
    const id = await invite(env);
    await worker.fetch(joinForm(id, {}, new File(["plain text CV ".repeat(20)], "cv.txt")), env);
    const { items } = await (await worker.fetch(new Request(`${BASE}/api/queue`, { headers: API }), env)).json();
    expect(items).toMatchObject([{ type: "signup", cv: { kind: "txt" } }]);
    const file = await worker.fetch(new Request(`${BASE}/api/file?k=${items[0].cv.key}`, { headers: API }), env);
    expect(await file.text()).toContain("plain text CV");
    expect((await worker.fetch(new Request(`${BASE}/api/file?k=invite:x`, { headers: API }), env)).status).toBe(404);
    const ack = new Request(`${BASE}/api/queue/ack`, { method: "POST", headers: API, body: JSON.stringify({ ids: [items[0].id, "event:x"] }) });
    expect(await (await worker.fetch(ack, env)).json()).toEqual({ deleted: 1 });
    expect(env.FEEDBACK.store.size).toBe(0);
  });

  it("refuses a malformed status report", async () => {
    const env = testEnv();
    const res = await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: "{not json" }), env);
    expect(res.status).toBe(400);
  });
});

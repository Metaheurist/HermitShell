import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { queueItem } from "../src/join.js";
import { BASE, keysWith, testEnv, valuesWith } from "./helpers.js";

describe("queue order", () => {
  it("keeps changes saved in the same millisecond in the order they were saved", async () => {
    const env = testEnv();
    for (let n = 0; n < 20; n++) await queueItem(env, { type: "admin", action: "pause", u: `p${n}` });
    const ids = keysWith(env, "queue:");
    expect([...ids].sort().map((id) => JSON.parse(env.FEEDBACK.store.get(id)).u))
      .toEqual(Array.from({ length: 20 }, (_, n) => `p${n}`));
  });
});

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
  return new Request(`${BASE}/join?i=${id}`, { method: "POST", body: form });
}

// A minimal zip whose central directory lists the given part names.
function zipWith(names) {
  const parts = names.map((n) => `PK\u0001\u0002${"\u0000".repeat(42)}${n}`).join("");
  return new TextEncoder().encode(`PK\u0003\u0004${"\u0000".repeat(26)}${parts}PK\u0005\u0006`);
}

describe("invite sign-up", () => {
  it("only opens with a live invite and uses it once", async () => {
    const env = testEnv();
    expect((await worker.fetch(new Request(`${BASE}/join?i=${"0".repeat(32)}`), env)).status).toBe(410);
    const id = await invite(env);
    const form = await (await worker.fetch(new Request(`${BASE}/join?i=${id}`), env)).text();
    expect(form).toContain('enctype="multipart/form-data"');
    expect(form).toContain('href="/privacy"');
    expect(form).toContain("HermitShell checks job boards");
    expect(form).toContain("<h1>Join HermitShell</h1>");
    expect(form).not.toContain("Hermes");
    expect(form).not.toContain("Daily Vacancy Report");
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

  it("checks Word and text files more closely", async () => {
    const env = testEnv();
    const id = await invite(env);
    const notWord = new File([zipWith(["xl/workbook.xml"])], "cv.docx");
    expect(await (await worker.fetch(joinForm(id, {}, notWord), env)).text()).toContain("must be a PDF");
    const binary = new File([new Uint8Array([0xff, 0xfe, 0x00, 0x41])], "cv.txt");
    expect(await (await worker.fetch(joinForm(id, {}, binary), env)).text()).toContain("must be a PDF");
    const word = new File([zipWith(["[Content_Types].xml", "word/document.xml"])], "cv.docx");
    await worker.fetch(joinForm(id, {}, word), env);
    expect(valuesWith(env, "queue:")).toMatchObject([{ type: "signup", cv: { kind: "docx" } }]);
  });

  it("needs the invite in the address before reading the upload", async () => {
    const env = testEnv();
    const id = await invite(env);
    const noInvite = new Request(`${BASE}/join`, { method: "POST", body: joinForm(id, { cv_text: CV_TEXT }).body, duplex: "half" });
    expect((await worker.fetch(noInvite, env)).status).toBe(410);
    const big = new File([new Uint8Array(6 * 1024 * 1024)], "cv.pdf");
    expect(await (await worker.fetch(joinForm(id, {}, big), env)).text()).toContain("larger than 5 MB");
    expect(valuesWith(env, "queue:")).toEqual([]);
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
    expect(body).toContain("HermitShell has not reported any profiles yet");
  });

  it("locks an address out after five wrong passwords", async () => {
    const env = testEnv(ADMIN);
    for (let i = 0; i < 5; i++) expect((await signIn(env, "admin", "guess")).res.status).toBe(401);
    expect((await signIn(env)).res.status).toBe(429);
    expect((await signIn(env, "root", ADMIN.ADMIN_PASSWORD)).res.status).toBe(429);
  });

  it("locks sign-in for everyone after 30 wrong passwords from anywhere", async () => {
    const env = testEnv(ADMIN);
    for (let i = 0; i < 30; i++) {
      const req = post("/admin/login", { username: "admin", password: "guess" }, { "CF-Connecting-IP": `198.51.100.${i}` });
      expect((await worker.fetch(req, env)).status).toBe(401);
    }
    expect((await signIn(env)).res.status).toBe(429);
  });

  it("counts IPv6 failures per /64", async () => {
    const env = testEnv(ADMIN);
    for (let i = 0; i < 5; i++) {
      const req = post("/admin/login", { username: "admin", password: "guess" }, { "CF-Connecting-IP": `2001:db8:1:2::${i + 1}` });
      await worker.fetch(req, env);
    }
    const next = post("/admin/login", { username: "admin", password: ADMIN.ADMIN_PASSWORD }, { "CF-Connecting-IP": "2001:db8:1:2::99" });
    expect((await worker.fetch(next, env)).status).toBe(429);
  });

  it("fails closed when a wrong password cannot be counted", async () => {
    const env = testEnv(ADMIN);
    env.FEEDBACK.put = async () => { throw new Error("KV write limit"); };
    expect((await signIn(env, "admin", "guess")).res.status).toBe(503);
  });

  it("requires Cloudflare Access when ACCESS_AUD is set", async () => {
    const env = testEnv({ ...ADMIN, ACCESS_AUD: "aud-123", ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com" });
    expect((await worker.fetch(new Request(`${BASE}/admin`), env, {})).status).toBe(403);
    const forged = new Request(`${BASE}/admin`, { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } });
    expect((await worker.fetch(forged, env, {})).status).toBe(403);
    const ctx = { access: { aud: "aud-123", getIdentity: async () => ({ email: "owner@example.com" }) } };
    expect(await (await worker.fetch(new Request(`${BASE}/admin`), env, ctx)).text()).toContain("Admin sign-in");
    const otherApp = { access: { aud: "aud-999", getIdentity: async () => ({ email: "x@example.com" }) } };
    expect((await worker.fetch(new Request(`${BASE}/admin`), { ...env, ACCESS_TEAM_DOMAIN: "" }, otherApp)).status).toBe(403);
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
      { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", crawler: "own", provider: "firecrawl", key_hint: "fc-...9f2" },
    ], keys: { firecrawl: { source: "env", hint: "fc-...0001" } } };
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify(status) }), env);
    await env.FEEDBACK.put("event:sam-lee:1:abc", JSON.stringify({ a: "interested" }));
    await env.FEEDBACK.put("flag:events:sam-lee", "1");
    await env.FEEDBACK.put("event:_:1:def", JSON.stringify({ a: "applied" }));
    const { cookie } = await signIn(env);
    const { body, csrf } = await dashboard(env, cookie);
    expect(body).toContain("Sam Lee");
    expect(body).toContain("<b>Firecrawl</b>");
    expect(body).toContain("fc-...9f2");
    expect(body).toContain('<a class="small" href="/admin/profile?u=sam-lee">Manage</a>');
    expect(body.match(/delete CV and history/g)).toHaveLength(1);

    await adminAction(env, cookie, csrf, { action: "set_key", u: "sam-lee", key: "fc-test-own-key" });
    await adminAction(env, cookie, csrf, { action: "pause", u: "sam-lee" });
    expect((await adminAction(env, cookie, csrf, { action: "delete", u: "sam-lee" })).headers.get("Location")).toBe("/admin?done=confirm");
    expect(keysWith(env, "event:sam-lee:")).toHaveLength(1);
    await adminAction(env, cookie, csrf, { action: "delete", u: "sam-lee", confirm: "yes" });
    expect(keysWith(env, "event:sam-lee:")).toEqual([]);
    expect(keysWith(env, "flag:events:sam-lee")).toEqual([]);
    expect(keysWith(env, "event:_:")).toHaveLength(1);
    const settings = await (await worker.fetch(new Request(`${BASE}/admin/settings`, { headers: { Cookie: cookie } }), env)).text();
    expect(settings).toContain("HermitShell&#39;s .env fc-...0001");
    expect((await adminAction(env, cookie, csrf, { action: "api_keys", keys: "bad key!" })).headers.get("Location")).toBe("/admin/settings?done=badkey#keys");
    await adminAction(env, cookie, csrf, { action: "api_keys", keys: "fc-one11111, fc-two22222" });
    await adminAction(env, cookie, csrf, { action: "api_keys_clear" });
    expect((await adminAction(env, cookie, csrf, { action: "pause", u: "../etc" })).status).toBe(400);

    const queued = valuesWith(env, "queue:").map(({ action, u, key, firecrawl, clear }) => ({ action, u, key, firecrawl, clear }));
    expect(valuesWith(env, "queue:")[0].provider).toBe("firecrawl");
    expect(queued).toEqual([
      { action: "set_key", u: "sam-lee", key: "fc-test-own-key", firecrawl: undefined, clear: undefined },
      { action: "pause", u: "sam-lee", key: undefined, firecrawl: undefined, clear: undefined },
      { action: "delete", u: "sam-lee", key: undefined, firecrawl: undefined, clear: undefined },
      { action: "api_keys", u: undefined, key: undefined, firecrawl: ["fc-one11111", "fc-two22222"], clear: undefined },
      { action: "api_keys", u: undefined, key: undefined, firecrawl: undefined, clear: ["firecrawl"] },
    ]);
    expect((await dashboard(env, cookie)).body).toContain("Waiting for HermitShell");
  });

  it("signs out", async () => {
    const env = testEnv(ADMIN);
    const { cookie } = await signIn(env);
    const res = await worker.fetch(post("/admin/logout", {}, { Cookie: cookie }), env);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await dashboard(env, cookie)).body).toContain("Admin sign-in");
  });
});

describe("HermitShell API", () => {
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
    const list = await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: '{"profiles":"x"}' }), env);
    expect(list.status).toBe(400);
    const huge = await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: "x".repeat(300000) }), env);
    expect(huge.status).toBe(413);
  });
});

import { describe, expect, it } from "vitest";
import { jobHash } from "../src/docs.js";
import worker from "../src/index.js";
import { BASE, memoryHub, sealingKeys, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const KEYS = await sealingKeys();
const JOB = { titles: ["Office Manager"], region: "County Down", places: ["Bangor"], country: "gb", remote_anywhere: false, level: "any",
  types: ["Permanent"], modes: ["On-site"], min_salary: "0", currency: "GBP", hide_agency: false };
const REAL = {
  ...KEYS.status, timezone: "Europe/London",
  profiles: [
    { id: "owner", name: "Real Owner", email: "real.owner@example.com", status: "active", owner: true, has_cv: true,
      details: { name: "Real Owner", email: "real.owner@example.com", phone: "", location: "Bangor" }, job: JOB },
    { id: "real-recruit", name: "Real Recruit", email: "real.recruit@example.com", status: "active", has_cv: true, recruiter: "casey",
      details: { name: "Real Recruit", email: "real.recruit@example.com", phone: "", location: "Bangor" }, job: JOB },
  ],
  email: { host: "smtp.example.com", port: "587", user: "real.owner@example.com", from: "", password_set: true, source: "dashboard", last_test: null },
  keys: { firecrawl: { source: "none", hint: "" }, tavily: { source: "none", hint: "" }, scrapfly: { source: "none", hint: "" } },
};
const REAL_WORDS = ["Real Owner", "Real Recruit", "real.owner@example.com", "real.recruit@example.com"];

function form(fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x));
  return body;
}

async function signIn(env, username, password) {
  const res = await worker.fetch(new Request(`${BASE}/admin/login`, { method: "POST", body: form({ username, password }),
    headers: { "CF-Connecting-IP": "203.0.113.9" } }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = async (path) => {
    const r = await worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
    return { res: r, body: r.headers.get("Content-Type")?.startsWith("text/html") ? await r.text() : "" };
  };
  const csrf = (await get("/admin")).body.match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const post = (path, fields, token = csrf) => worker.fetch(new Request(`${BASE}${path}`, { method: "POST",
    body: fields instanceof FormData ? fields : form({ csrf: token, ...fields }), headers: { Cookie: cookie } }), env);
  return { get, post, csrf };
}

async function setup() {
  const env = testEnv({ ...ADMIN, HUB: memoryHub() });
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify(REAL) }), env);
  const admin = await signIn(env, "admin", ADMIN.ADMIN_PASSWORD);
  return { env, admin };
}

async function addRecruiter(admin, env) {
  await admin.post("/admin/users", { op: "add", name: "Casey Quinn", username: "casey", password: "a-long-recruiter-password", roles: "recruiter" });
  return signIn(env, "casey", "a-long-recruiter-password");
}

const demoOn = (admin) => admin.post("/admin/demo", { on: "1" });
const demoOff = (admin) => admin.post("/admin/demo", { on: "0" });
const snapshot = (env) => new Map(env.FEEDBACK.store);

describe("demo mode switch", () => {
  it("is on Global settings, off by default", async () => {
    const { admin } = await setup();
    const { body } = await admin.get("/admin/settings");
    expect(body).toContain('<h2 id="demo">Demo mode</h2>');
    expect(body).toContain('action="/admin/demo"');
    expect(body).toMatch(/<button id="demo-switch" class="switch" role="switch" aria-checked="false">/);
    expect(body).toContain('<label for="demo-switch">Demo mode</label><span class="state">Off</span>');
    expect(body).toContain('<input type="hidden" name="on" value="1">');
    expect(body).not.toContain("Turn on demo mode");
    expect(body).not.toContain("demoribbon");
  });

  it("shows the switch on, with since when, and slides the knob only straight after a press", async () => {
    const { admin } = await setup();
    await demoOn(admin);
    const moved = (await admin.get("/admin/settings?done=demo_on")).body;
    expect(moved).toMatch(/<button id="demo-switch" class="switch moved" role="switch" aria-checked="true">/);
    expect(moved).toMatch(/class="demoswitch on"/);
    expect(moved).toMatch(/<span class="state"><b>On<\/b> since [^<]+<\/span>/);
    expect(moved).toContain('<input type="hidden" name="on" value="0">');
    const still = (await admin.get("/admin/settings")).body;
    expect(still).toMatch(/class="switch" role="switch" aria-checked="true"/);
    expect((await admin.get("/admin/settings?done=saved")).body).not.toContain("switch moved");
    await demoOff(admin);
    expect((await admin.get("/admin/settings?done=demo_off")).body).toMatch(/class="switch moved" role="switch" aria-checked="false"/);
  });

  it("turns on and off, storing only the switch", async () => {
    const { env, admin } = await setup();
    const before = new Set(env.FEEDBACK.store.keys());
    const on = await demoOn(admin);
    expect(on.status).toBe(303);
    expect(on.headers.get("Location")).toBe("/admin/settings?done=demo_on#demo");
    expect([...env.FEEDBACK.store.keys()].filter((k) => !before.has(k))).toEqual(["demo:mode"]);
    const settings = (await admin.get("/admin/settings?done=demo_on")).body;
    expect(settings).toContain("Demo mode is on: every dashboard page now shows made-up data");
    expect(settings).toContain('role="switch" aria-checked="true"');
    const off = await demoOff(admin);
    expect(off.headers.get("Location")).toBe("/admin/settings?done=demo_off#demo");
    expect(env.FEEDBACK.store.has("demo:mode")).toBe(false);
    const dashboard = (await admin.get("/admin")).body;
    expect(dashboard).toContain("Real Recruit");
    expect(dashboard).not.toContain("demoribbon");
  });

  it("can only be switched by an admin, with the form's token", async () => {
    const { env, admin } = await setup();
    const casey = await addRecruiter(admin, env);
    expect((await casey.post("/admin/demo", { on: "1" })).status).toBe(403);
    expect((await admin.post("/admin/demo", { on: "1" }, "0".repeat(32))).status).toBe(403);
    expect(env.FEEDBACK.store.has("demo:mode")).toBe(false);
    const signedOut = await worker.fetch(new Request(`${BASE}/admin/demo`, { method: "POST", body: form({ on: "1" }) }), env);
    expect(signedOut.status).toBe(200);
    expect(await signedOut.text()).toContain("Admin sign-in");
    expect(env.FEEDBACK.store.has("demo:mode")).toBe(false);
  });
});

describe("demo mode pages", () => {
  it("fill every signed-in page with made-up data and none of the real", async () => {
    const { admin } = await setup();
    await demoOn(admin);
    const pages = ["/admin", "/admin/profile?u=sam-lee", "/admin/history?u=sam-lee", "/admin/stats?u=avery-lane", "/admin/stats?u=morgan-ellis&r=90",
      "/admin/sent?u=avery-lane&r=30", "/admin/users", "/admin/settings", "/admin/tasks"];
    for (const path of pages) {
      const { res, body } = await admin.get(path);
      expect(res.status, path).toBe(200);
      for (const word of REAL_WORDS) expect(body, `${path} shows ${word}`).not.toContain(word);
    }
    const dashboard = (await admin.get("/admin")).body;
    expect(dashboard).not.toContain("/admin/profile?u=owner");
    for (const name of ["Alex Morgan", "Avery Lane", "Sam Lee", "Jordan Patel", "Morgan Ellis", "Taylor Reid", "Jamie Walsh", "Robin Shaw", "Riley Chen", "Casey Quinn",
      "Drew Harper"]) expect(dashboard).toContain(name);
    expect(dashboard).toContain("HermitShell is connected");
    expect(dashboard).toContain("scanning now");
    expect(dashboard).toContain("Careers fair, marketing graduate");
    expect(dashboard).toContain('<div class="demoribbon" role="status">');
    expect(dashboard).toContain('href="/admin/settings#demo">Turn off</a>');
    expect((await admin.get("/admin/history?u=sam-lee")).body).toContain("Job report ran");
    expect((await admin.get("/admin/sent?u=avery-lane&r=30")).body).toContain("jobs.example.com/demo/avery-lane/1000");
    expect((await admin.get("/admin/tasks")).body).toContain("Rating jobs");
    expect((await admin.get("/admin/users")).body).toContain("Drew Harper");
  });

  it("keep a made-up cover letter that downloads as a PDF", async () => {
    const { admin } = await setup();
    await demoOn(admin);
    const h = await jobHash("https://jobs.example.com/demo/avery-lane/1000");
    const { res } = await admin.get(`/admin/doc?u=avery-lane&k=cover_letter&h=${h}`);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    const pdf = new TextDecoder().decode(await res.arrayBuffer());
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("sample output from HermitShell's demo mode");
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("show a recruiter only their own made-up pool, without the switch", async () => {
    const { env, admin } = await setup();
    const casey = await addRecruiter(admin, env);
    await demoOn(admin);
    const { body } = await casey.get("/admin");
    for (const name of ["Sam Lee", "Morgan Ellis", "Taylor Reid"]) expect(body).toContain(name);
    for (const name of ["Jamie Walsh", "Robin Shaw", "Real Recruit"]) expect(body).not.toContain(name);
    expect(body).toContain("demoribbon");
    expect(body).not.toContain("Turn off</a>");
  });
});

describe("demo mode keeps real data apart", () => {
  it("saves nothing pressed on the dashboard and never tells HermitShell", async () => {
    const { env, admin } = await setup();
    await demoOn(admin);
    const before = snapshot(env);
    const hub = env.HUB.storage;
    const cv = new FormData();
    for (const [k, v] of Object.entries({ csrf: admin.csrf, u: "sam-lee", cv_text: "Sam Lee. Data analyst with SQL and Power BI. ".repeat(8) })) cv.append(k, v);
    const presses = [
      ["/admin/action", { action: "pause", u: "sam-lee" }],
      ["/admin/action", { action: "send_now", u: "jamie-walsh" }],
      ["/admin/action", { action: "delete", u: "taylor-reid", confirm: "yes" }],
      ["/admin/action", { action: "assign", u: "robin-shaw", recruiter: "casey" }],
      ["/admin/action", { action: "invite", note: "Demo invite" }],
      ["/admin/action", { action: "email", host: "smtp.example.com", port: "587", user: "demo@example.com", password: "demo-password" }],
      ["/admin/action", { action: "model_key", provider: "openrouter", key: "test-openrouter-key" }],
      ["/admin/action", { action: "api_key", provider: "tavily", key: "not-a-real-search-key" }],
      ["/admin/users", { op: "add", name: "Demo User", username: "demouser", password: "a-long-demo-password", roles: "recruiter" }],
      ["/admin/doc", { u: "avery-lane", j: "https://jobs.example.com/demo/avery-lane/1001", k: "tailored_cv", n: "AI Engineer" }],
      ["/admin/doc", { u: "avery-lane", j: "https://jobs.example.com/demo/avery-lane/1001", k: "cover_letter", n: "AI Engineer", send: "1" }],
      ["/admin/tasks", { task: "report:jamie-walsh" }],
      ["/admin/skill", { u: "avery-lane", j: "https://jobs.example.com/demo/avery-lane/1000", s: "Kubernetes" }],
      ["/admin/cv", cv],
    ];
    for (const [path, fields] of presses) {
      const res = await admin.post(path, fields);
      expect(res.status, path).toBeLessThan(400);
      expect(res.headers.get("Location") || "", path).not.toContain("nokey");
    }
    expect(snapshot(env)).toEqual(before);
    expect(hub.has("flag")).toBe(false);
    const queue = await (await worker.fetch(new Request(`${BASE}/api/queue?full=1`, { headers: API }), env)).json();
    expect(queue.items).toEqual([]);
  });

  it("leaves HermitShell's API, email buttons and reports on the real data", async () => {
    const { env, admin } = await setup();
    await admin.post("/admin/action", { action: "pause", u: "real-recruit" });
    await demoOn(admin);
    const queue = await (await worker.fetch(new Request(`${BASE}/api/queue?full=1`, { headers: API }), env)).json();
    expect(queue.items.map((i) => [i.action, i.u])).toEqual([["pause", "real-recruit"]]);
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API,
      body: JSON.stringify({ ...REAL, profiles: [...REAL.profiles, { ...REAL.profiles[1], id: "new-real", name: "New Real" }] }) }), env);
    expect((await admin.get("/admin")).body).not.toContain("New Real");
    await demoOff(admin);
    expect((await admin.get("/admin")).body).toContain("New Real");
  });

  it("still changes a user's own password for real", async () => {
    const { env, admin } = await setup();
    const casey = await addRecruiter(admin, env);
    await demoOn(admin);
    const res = await casey.post("/admin/password", { current: "a-long-recruiter-password", password: "another-long-password", again: "another-long-password" });
    expect(res.headers.get("Location")).toBe("/admin?done=password");
    await demoOff(admin);
    const again = await worker.fetch(new Request(`${BASE}/admin/login`, { method: "POST",
      body: form({ username: "casey", password: "another-long-password" }), headers: { "CF-Connecting-IP": "203.0.113.10" } }), env);
    expect(again.headers.get("Location")).toBe("/admin");
  });
});

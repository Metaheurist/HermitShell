import { afterEach, describe, expect, it, vi } from "vitest";
import { PULL_MS, WORK_MS } from "../src/demo.js";
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
    const history = (await admin.get("/admin/history?u=sam-lee")).body;
    const months = [...history.matchAll(/href="(\/admin\/history\?u=sam-lee&amp;m=\d{4}-\d\d)"/g)].map((m) => m[1].replace("&amp;", "&"));
    const shown = [history, ...(await Promise.all(months.map(async (m) => (await admin.get(m)).body)))];
    expect(shown.some((b) => b.includes("Job report ran"))).toBe(true);
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
    const history = (await admin.get("/admin/history?u=avery-lane")).body;
    expect(history).toMatch(/Asked for a cover letter: [^<]+<\/b>[\s\S]*?by Drew Harper<\/small><\/div><a class="hdl"/);
    expect(history).toContain(`href="/admin/doc?u=avery-lane&amp;k=cover_letter&amp;h=${h}"`);
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

describe("demo mode's desk under load", () => {
  it("has 35 recruits, two managers with their teams, more recruiters, sign-ups and invites", async () => {
    const { admin } = await setup();
    await demoOn(admin);
    const dashboard = (await admin.get("/admin")).body;
    expect(new Set(dashboard.match(/aria-label="Recruiter for (?!the ticked)[^"]+"/g)).size).toBe(35);
    expect(dashboard.match(/scanning now/g).length).toBeGreaterThanOrEqual(4);
    for (const note of ["Engineering open evening", "Graduate scheme, cyber security"]) expect(dashboard).toContain(note);
    const users = (await admin.get("/admin/users")).body;
    for (const name of ["Jamie Chen", "Robin Ellis", "Riley Morgan", "Sam Patel", "Avery Reid", "Jordan Lane", "Taylor Shaw"]) expect(users).toContain(name);
    expect(users.match(/<b>3<\/b> <span class="muted">recruiters in their team/g)).toHaveLength(1);
    expect(users.match(/<b>2<\/b> <span class="muted">recruiters in their team/g)).toHaveLength(1);
    expect(users.match(/in Jamie Chen.{1,6}s team/g)).toHaveLength(3);
    const desk = (await admin.get("/admin/desk")).body;
    for (const name of ["Riley Morgan", "Avery Reid", "Taylor Shaw"]) expect(desk).toContain(name);
    const tasks = (await admin.get("/admin/tasks")).body;
    for (const words of ["Server model download", "Interview prep", "Rating jobs", "Searching job sites"]) expect(tasks).toContain(words);
  });

  it("names only made-up people, from the same first names and surnames, at example addresses", async () => {
    const { admin } = await setup();
    await demoOn(admin);
    const first = new Set(["Alex", "Sam", "Jordan", "Riley", "Casey", "Drew", "Morgan", "Taylor", "Jamie", "Robin", "Avery"]);
    const last = new Set(["Morgan", "Lee", "Patel", "Chen", "Quinn", "Harper", "Ellis", "Reid", "Walsh", "Shaw", "Lane"]);
    const dashboard = (await admin.get("/admin")).body;
    const names = [...dashboard.matchAll(/aria-label="Recruiter for (?!the ticked)([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      const [a, b, more] = name.split(" ");
      expect(first.has(a) && last.has(b) && more === undefined, name).toBe(true);
    }
    for (const email of dashboard.match(/[a-z0-9.]+@[a-z0-9.-]+/g)) expect(email, email).toMatch(/@example\.(com|net|org)$/);
  });

  it("shows a real manager a made-up team and a real recruiter a made-up pool, never the admin pages", async () => {
    const { env, admin } = await setup();
    await admin.post("/admin/users", { op: "add", name: "Real Manager", username: "boss", password: "a-long-manager-password", roles: "manager" });
    await admin.post("/admin/users", { op: "add", name: "Real Solo Recruiter", username: "solo", password: "a-long-recruiter-password", roles: "recruiter" });
    const boss = await signIn(env, "boss", "a-long-manager-password");
    const solo = await signIn(env, "solo", "a-long-recruiter-password");
    await demoOn(admin);
    const team = (await boss.get("/admin")).body;
    for (const name of ["Sam Lee", "Morgan Ellis", "Taylor Reid"]) expect(team).toContain(name);
    for (const name of ["Jamie Walsh", "Avery Lane", "Real Recruit"]) expect(team).not.toContain(name);
    expect(team).toContain("Real Manager");
    const users = (await boss.get("/admin/users")).body;
    for (const name of ["Casey Quinn", "Riley Morgan", "Sam Patel"]) expect(users).toContain(name);
    for (const name of ["Avery Reid", "Drew Harper"]) expect(users).not.toContain(name);
    expect((await boss.get("/admin/settings")).res.status).toBe(403);
    expect((await boss.get("/admin/backups")).res.status).toBe(403);
    const pool = (await solo.get("/admin")).body;
    expect(pool).toContain("Sam Lee");
    for (const name of ["Jamie Walsh", "Riley Morgan", "Real Recruit"]) expect(pool).not.toContain(name);
    expect((await solo.get("/admin/desk")).body).not.toContain("fees");
  });
});

describe("demo mode's newer features", () => {
  it("shows the features, the server model downloading and the backups on Cloudflare", async () => {
    const { admin } = await setup();
    await demoOn(admin);
    const settings = (await admin.get("/admin/settings")).body;
    for (const label of ["Admin alerts by email", "Interview prep packs on Interview", "Word copies of letters and CVs"]) expect(settings).toContain(label);
    expect(settings).toContain('id="mlocal"');
    expect(settings).toContain('value="qwen3:30b-a3b-instruct-2507-q4_K_M"');
    expect(settings).toMatch(/Downloading <code class="mname">qwen3:30b-a3b-instruct-2507-q4_K_M<\/code>: \d+%/);
    const dashboard = (await admin.get("/admin")).body;
    expect(dashboard).toContain("Follow it in Tasks");
    expect(dashboard).toMatch(/On Cloudflare too: last sent [^<]+ &middot; 11 kept/);
    const page = (await admin.get("/admin/backups")).body;
    expect(page).toContain("11 kept");
    const names = [...page.matchAll(/href="\/admin\/backups\?name=(hermitshell-\d{8}-\d{6}\.tar\.gz\.enc)"/g)].map((m) => m[1]);
    expect(names).toHaveLength(11);
    const { res } = await admin.get(`/admin/backups?name=${names[0]}`);
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="${names[0]}"`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(Number(res.headers.get("Content-Length")));
    expect(bytes.length).toBeGreaterThan(6_000_000);
    expect(new TextDecoder().decode(bytes.slice(0, 40))).toBe("HSEAL1 HermitShell demo mode: made-up by");
  });
});

describe("demo mode keeps real data apart", () => {
  it("keeps only the demo's own state, with nothing typed into it, and never tells HermitShell", async () => {
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
    const after = snapshot(env);
    const state = after.get("demo:state");
    after.delete("demo:state");
    expect(after).toEqual(before);
    for (const typed of ["demo-password", "test-openrouter-key", "not-a-real-search-key", "a-long-demo-password", "demouser", "Data analyst with SQL",
      "cvfile:", "smtp.example.com", "Real Recruit"]) expect(state, typed).not.toContain(typed);
    expect(hub.has("flag")).toBe(false);
    const queue = await (await worker.fetch(new Request(`${BASE}/api/queue?full=1`, { headers: API }), env)).json();
    expect(queue.items).toEqual([]);
    await demoOff(admin);
    expect(env.FEEDBACK.store.has("demo:state")).toBe(false);
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

  it("never gives a real user a role they don't have, even with a made-up account's username", async () => {
    const { env, admin } = await setup();
    await admin.post("/admin/users", { op: "add", name: "Real Drew", username: "drew", password: "a-long-recruiter-password", roles: "recruiter" });
    await admin.post("/admin/users", { op: "add", name: "Real Taylor", username: "taylor-shaw", password: "a-long-manager-password", roles: "manager" });
    const drew = await signIn(env, "drew", "a-long-recruiter-password");
    const taylor = await signIn(env, "taylor-shaw", "a-long-manager-password");
    await demoOn(admin);
    for (const path of ["/admin/settings", "/admin/backups", "/admin/tasks", "/admin/theme"]) expect((await drew.get(path)).res.status, path).toBe(403);
    const pool = (await drew.get("/admin")).body;
    expect(pool).toContain("Sam Lee");
    expect(pool).not.toContain('aria-label="Recruiter for');
    expect((await drew.get("/admin/users")).res.status).toBe(403);
    const team = (await taylor.get("/admin/users")).body;
    for (const name of ["Casey Quinn", "Riley Morgan", "Sam Patel"]) expect(team).toContain(name);
    expect((await taylor.get("/admin/settings")).res.status).toBe(403);
    expect((await drew.post("/admin/demo", { on: "0" })).status).toBe(403);
    expect((await admin.get("/admin")).body).toContain("Jamie Walsh");
  });

  it("cleans a hand-made model pick, features and backup before showing them", async () => {
    const { env, admin } = await setup();
    await demoOn(admin);
    await env.FEEDBACK.put("demo:state", JSON.stringify({ v: 1, keys: {}, patch: {
      local: { model: "<script>alert(1)</script>", at: Date.now(), current: '"><img src=x onerror=alert(1)>', source: "dashboard", have: ["<b>x</b>", 7] },
      features: { alerts: "<b>on</b>", prep_auto: false, nope: true }, backup: "<i>soon</i>" } }));
    for (const path of ["/admin", "/admin/settings", "/admin/tasks", "/admin/backups"]) {
      const { res, body } = await admin.get(path);
      expect(res.status, path).toBe(200);
      for (const bad of ["<script>alert(1)", "<img src=x", "<b>x</b>", "<b>on</b>", "<i>soon</i>", "alert(1)"]) expect(body, `${path} ${bad}`).not.toContain(bad);
    }
    expect((await admin.get("/admin/settings")).body).toMatch(/name="prep_auto" value="1">/);
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

describe("demo mode presses play out", () => {
  afterEach(() => vi.useRealTimers());

  const later = (ms) => vi.setSystemTime(Date.now() + ms);
  const SENT = "/admin/sent?u=avery-lane&r=30";
  const JOB = "https://jobs.example.com/demo/avery-lane/1001";

  async function demoAdmin() {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { env, admin } = await setup();
    await demoOn(admin);
    return { env, admin };
  }

  it("makes a letter and a tailored CV a few seconds after they are asked for, ready to download", async () => {
    const { admin } = await demoAdmin();
    await admin.post("/admin/doc", { u: "avery-lane", j: JOB, k: "cover_letter", n: "Data Engineer at Northwind", len: "short", tone: "warm" });
    await admin.post("/admin/doc", { u: "avery-lane", j: JOB, k: "tailored_cv", n: "Data Engineer at Northwind" });
    const h = await jobHash(JOB);
    const job = (body) => body.slice(body.indexOf(`id="job-${h.slice(0, 16)}"`)).split("</li>")[0];
    expect(job((await admin.get(SENT)).body).match(/Being made/g)).toHaveLength(2);
    expect((await admin.get("/admin/tasks")).body).toContain("Data Engineer at Northwind");
    later(WORK_MS.tailored_cv + 1000);
    const ready = job((await admin.get(SENT)).body);
    expect(ready).not.toContain("Being made");
    expect(ready.match(/>Download</g)).toHaveLength(2);
    const letter = await admin.get(`/admin/doc?u=avery-lane&k=cover_letter&h=${h}`);
    expect(letter.res.headers.get("Content-Type")).toBe("application/pdf");
    const pdf = new TextDecoder().decode(await letter.res.arrayBuffer());
    expect(pdf).toContain("Cover letter \\(demo, short, warm\\)");
    expect(pdf).toContain("Dear Hiring Manager at Northwind");
    const cvPdf = new TextDecoder().decode(await (await admin.get(`/admin/doc?u=avery-lane&k=tailored_cv&h=${h}`)).res.arrayBuffer());
    expect(cvPdf).toContain("Tailored CV \\(demo\\)");
    expect((await admin.get("/admin/tasks")).body).not.toContain("Data Engineer at Northwind");
  });

  it("marks a job emailed once the pretend HermitShell has sent it", async () => {
    const { admin } = await demoAdmin();
    await admin.post("/admin/doc", { u: "avery-lane", j: JOB, k: "send_job", n: "Data Engineer at Northwind" });
    expect((await admin.get(SENT)).body).toContain("Sending&hellip;");
    later(WORK_MS.send_job + 1000);
    const body = (await admin.get(SENT)).body;
    expect(body).not.toContain("Sending&hellip;");
    expect(body).toContain("<b>Emailed to Avery</b>");
  });

  it("shows an added skill as being added, then counted as on the CV", async () => {
    const { admin } = await demoAdmin();
    await admin.post("/admin/skill", { u: "avery-lane", j: "https://jobs.example.com/demo/avery-lane/1000", s: "Kubernetes" });
    expect((await admin.get(SENT)).body).toMatch(/<span class="adding"[^>]*>.*?Kubernetes<\/span>/);
    later(WORK_MS.skill + 1000);
    const body = (await admin.get(SENT)).body;
    expect(body).toMatch(/<span class="added" title="Counted as on the CV">.*?Kubernetes<\/span>/);
    expect(body).not.toMatch(/<span class="adding"[^>]*>.*?Kubernetes/);
  });

  it("applies pauses, assignments, deletions and scans to the dashboard", async () => {
    const { admin } = await demoAdmin();
    await admin.post("/admin/action", { action: "pause", u: "sam-lee" });
    await admin.post("/admin/action", { action: "assign", u: "robin-shaw", recruiter: "casey" });
    await admin.post("/admin/action", { action: "delete", u: "taylor-reid", confirm: "yes" });
    await admin.post("/admin/action", { action: "send_now", u: "morgan-ellis" });
    expect((await admin.get("/admin")).body).toContain("Saving.");
    later(WORK_MS.change + 1000);
    const body = (await admin.get("/admin")).body;
    expect(body).not.toContain("Saving.");
    expect(body).toContain('aria-label="Resume reports for Sam Lee"');
    const robin = body.slice(body.indexOf('aria-label="Recruiter for Robin Shaw"')).split("</select>")[0];
    expect(robin).toContain('<option value="casey" selected>');
    expect(body).not.toContain("Taylor Reid");
    const morgan = () => body.slice(body.indexOf("<b>Morgan Ellis</b>")).split("</tr>")[0];
    expect(morgan()).toContain("scanning now");
    later(WORK_MS.scan);
    const done = (await admin.get("/admin")).body;
    expect(done.slice(done.indexOf("<b>Morgan Ellis</b>")).split("</tr>")[0]).not.toContain("scanning now");
  });

  it("starts afresh each time it is turned on", async () => {
    const { env, admin } = await demoAdmin();
    await admin.post("/admin/action", { action: "delete", u: "taylor-reid", confirm: "yes" });
    later(WORK_MS.change + 1000);
    expect((await admin.get("/admin")).body).not.toContain("Taylor Reid");
    await demoOff(admin);
    await demoOn(admin);
    expect(env.FEEDBACK.store.has("demo:state")).toBe(false);
    expect((await admin.get("/admin")).body).toContain("Taylor Reid");
  });

  it("plays out a feature switched, a server model picked, a download stopped and Back up now", async () => {
    const { admin } = await demoAdmin();
    const shown = ["alerts", "prep_auto", "word_copies", "self_service"];
    await admin.post("/admin/action", { action: "features", shown, alerts: "1" });
    await admin.post("/admin/action", { action: "model_local", model: "llama3.1:8b-instruct-q4_K_M" });
    await admin.post("/admin/action", { action: "backup_now" });
    expect((await admin.get("/admin/settings")).body).toContain("Saving");
    later(WORK_MS.change + 1000);
    let settings = (await admin.get("/admin/settings")).body;
    expect(settings).toMatch(/name="alerts" value="1" checked/);
    expect(settings).toMatch(/name="prep_auto" value="1">/);
    expect(settings).toContain('<code class="keyhint">llama3.1:8b-instruct-q4_K_M</code>');
    const dashboard = (await admin.get("/admin")).body;
    expect(dashboard).toMatch(/On Cloudflare too: last sent (just now|\d+ seconds? ago) &middot; 12 kept/);
    expect((await admin.get("/admin/backups")).body).toContain("12 kept");

    await admin.post("/admin/action", { action: "model_local", model: "qwen2.5:7b-instruct-q4_K_M" });
    later(WORK_MS.change + 1000);
    expect((await admin.get("/admin")).body).toMatch(/Downloading <code class="mname">qwen2.5:7b-instruct-q4_K_M<\/code>: \d+%/);
    later(PULL_MS);
    const ready = (await admin.get("/admin")).body;
    expect(ready).toContain('<code class="mname">qwen2.5:7b-instruct-q4_K_M</code> is downloaded and is now the server model');
    expect((await admin.get("/admin/tasks")).body).not.toContain("Server model download");

    await admin.post("/admin/action", { action: "model_local", model: "qwen2.5:1.5b-instruct" });
    later(WORK_MS.change + 1000);
    expect((await admin.get("/admin/tasks")).body).toContain("Server model download");
    await admin.post("/admin/tasks", { task: "model:pull" });
    later(WORK_MS.change + 1000);
    settings = (await admin.get("/admin/settings")).body;
    expect(settings).toContain('<code class="keyhint">qwen2.5:7b-instruct-q4_K_M</code>');
    expect(settings).toContain("The download of");
    expect((await admin.get("/admin/tasks")).body).not.toContain("Server model download");
  });

  it("ignores a hand-made state with keys outside the demo's own", async () => {
    const { env, admin } = await demoAdmin();
    await env.FEEDBACK.put("demo:state", JSON.stringify({ v: 1, keys: { "status:profiles": { s: "{}" }, accounts: { s: "{}" },
      "invite:ffff": { s: JSON.stringify({ id: "ffff", note: "Kept invite", created: Date.now(), expires: Date.now() + 86400000, recruiter: "" }) } },
      patch: { profiles: "nope", skills: [], cancelled: [1, "x"] } }));
    const body = (await admin.get("/admin")).body;
    expect(body).toContain("Avery Lane");
    expect(body).toContain("Kept invite");
  });
});

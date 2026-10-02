import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { BASE, keysWith, memoryHub, sealingKeys, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const KEYS = await sealingKeys();
const JOB = { titles: ["Data Engineer"], region: "Greater Manchester", places: ["Salford"], search_location: "", country: "gb",
  remote_anywhere: false, level: "any", types: ["Permanent"], modes: ["Hybrid"], min_salary: "0", currency: "£", hide_agency: false, max_km: "0" };
const ALEX = { id: "alex-morgan", name: "Alex Morgan", email: "alex@example.com", status: "active", has_cv: true,
  details: { name: "Alex Morgan", email: "alex@example.com", phone: "07700 900111", location: "Salford" }, job: JOB,
  report: { time: "08:00", days: "daily" } };
const SAM = { ...ALEX, id: "sam-lee", name: "Sam Lee", email: "sam@example.com",
  details: { name: "Sam Lee", email: "sam@example.com", phone: "", location: "Leeds" } };
const RILEY = { ...ALEX, id: "riley-chen", name: "Riley Chen", email: "riley@example.com", status: "paused" };
const OWNER = { id: "owner", name: "Casey Quinn", email: "casey@example.com", status: "active", owner: true, has_cv: false };
const STATUS = { ...KEYS.status, features: { self_service: true }, timezone: "UTC", profiles: [ALEX, SAM, RILEY, OWNER] };
const IP = "203.0.113.20";

afterEach(() => vi.useRealTimers());

async function setup(status = STATUS, extra = {}) {
  const env = testEnv({ ...ADMIN, HUB: memoryHub({ sql: "sqlite" }), ...extra });
  if (status) await env.FEEDBACK.put("status:profiles", JSON.stringify(status));
  return env;
}

function call(env, path, { method = "GET", fields = null, cookie = "", ip = IP, ctx } = {}) {
  const body = fields ? new URLSearchParams() : undefined;
  for (const [k, v] of Object.entries(fields || {})) (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x));
  const headers = { "CF-Connecting-IP": ip, ...(cookie ? { Cookie: cookie } : {}) };
  return worker.fetch(new Request(`${BASE}${path}`, { method: fields ? "POST" : method, body, headers }), env, ctx);
}

const csrfOf = (html) => html.match(/name="csrf" value="([0-9a-f]+)"/)?.[1] || "";
const cookiesOf = (res) => (res.headers.get("Set-Cookie") || "").split(/,\s*(?=__Host-)/).map((c) => c.split(";")[0]);
const cookieNamed = (res, name) => cookiesOf(res).find((c) => c.startsWith(`${name}=`)) || "";

// The sign-in form's cookie and token, as a browser gets them from GET /me.
async function preForm(env, path = "/me", ip = IP) {
  const res = await call(env, path, { ip });
  return { pre: cookieNamed(res, "__Host-hv_mepre"), csrf: csrfOf(await res.text()) };
}

async function askLink(env, email, ip = IP) {
  const { pre, csrf } = await preForm(env, "/me", ip);
  return call(env, "/me/link", { fields: { csrf, email }, cookie: pre, ip });
}

// The token HermitShell would email, unsealed from the newest login_link queue item.
async function emailedToken(env) {
  const items = valuesWith(env, "queue:").filter((i) => i.type === "login_link");
  return items.length ? KEYS.open(items.at(-1).token, "token") : "";
}

async function spend(env, token, ip = IP) {
  const page = await call(env, `/me/login?t=${token}`, { ip });
  const pre = cookieNamed(page, "__Host-hv_mepre");
  return call(env, "/me/login", { fields: { csrf: csrfOf(await page.text()), t: token }, cookie: pre, ip });
}

async function signIn(env, email = ALEX.email) {
  await askLink(env, email);
  const res = await spend(env, await emailedToken(env));
  const cookie = cookieNamed(res, "__Host-hv_me");
  const home = await call(env, "/me/search", { cookie });
  return { cookie, csrf: csrfOf(await home.text()), res };
}

describe("recruits' own page: switched off", () => {
  it("is a 404 everywhere unless the switch is on and HermitShell speaks protocol 6", async () => {
    for (const status of [{ ...STATUS, features: {} }, { ...STATUS, features: { self_service: false } }, { ...STATUS, protocol: 5 },
      { ...STATUS, protocol: undefined }, null]) {
      const env = await setup(status);
      for (const path of ["/me", "/me/login?t=x", "/me/search", "/me/docs"]) expect((await call(env, path)).status).toBe(404);
      expect((await call(env, "/me/link", { fields: { email: ALEX.email } })).status).toBe(404);
      expect(keysWith(env, "queue:")).toEqual([]);
    }
  });
});

describe("asking for a sign-in link", () => {
  it("queues a sealed login_link for an active recruit, keeping only the token's hash in the hub", async () => {
    const env = await setup();
    const res = await askLink(env, "  Alex@Example.com ");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("If that address gets job reports from HermitShell");
    const [item] = valuesWith(env, "queue:");
    expect(item).toMatchObject({ type: "login_link", u: "alex-morgan", sealed: ["token"] });
    const token = await KEYS.open(item.token, "token");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify([...env.FEEDBACK.store.values()])).not.toContain(token);
  });

  it("answers every address the same and sends nothing for the admin, a paused recruit or a stranger", async () => {
    const env = await setup();
    const known = await (await askLink(env, ALEX.email)).text();
    const pages = [];
    for (const email of [OWNER.email, RILEY.email, "drew@example.com"]) pages.push(await (await askLink(env, email, `198.51.100.${pages.length + 1}`)).text());
    const strip = (html) => html.replace(/--phase:[^;]+;--drift:[^}]+/, "");
    for (const html of pages) expect(strip(html)).toBe(strip(known));
    expect(valuesWith(env, "queue:").map((i) => i.u)).toEqual(["alex-morgan"]);
  });

  it("refuses a form without its cookie and token, or with a bad address", async () => {
    const env = await setup();
    expect((await call(env, "/me/link", { fields: { email: ALEX.email } })).status).toBe(403);
    const { pre, csrf } = await preForm(env);
    expect((await call(env, "/me/link", { fields: { csrf: "0".repeat(32), email: ALEX.email }, cookie: pre })).status).toBe(403);
    expect((await call(env, "/me/link", { fields: { csrf, email: ALEX.email } })).status).toBe(403);
    expect((await call(env, "/me/link", { fields: { csrf, email: "not an address" }, cookie: pre })).status).toBe(400);
    expect(keysWith(env, "queue:")).toEqual([]);
  });

  it("limits requests per address range and per address, counted before anything is written", async () => {
    const env = await setup();
    for (let i = 0; i < 5; i++) expect((await askLink(env, `stranger${i}@example.com`)).status).toBe(200);
    expect((await askLink(env, "stranger9@example.com")).status).toBe(429);
    const env2 = await setup();
    for (let i = 0; i < 3; i++) expect((await askLink(env2, ALEX.email, `198.51.100.${i + 1}`)).status).toBe(200);
    expect((await askLink(env2, ALEX.email, "198.51.100.9")).status).toBe(429);
    expect(valuesWith(env2, "queue:").length).toBe(3);
  });

  it("counts an IPv6 address by its /64, so one user can't walk around the limit", async () => {
    const env = await setup();
    for (let i = 0; i < 5; i++) await askLink(env, `stranger${i}@example.com`, `2001:db8:1:2::${i + 1}`);
    expect((await askLink(env, "stranger9@example.com", "2001:db8:1:2:ffff::1")).status).toBe(429);
    expect((await askLink(env, "stranger9@example.com", "2001:db8:1:3::1")).status).toBe(200);
  });

  it("fails closed without the hub: no link, no token in KV", async () => {
    const env = await setup(STATUS, { HUB: undefined });
    expect((await askLink(env, ALEX.email)).status).toBe(503);
    expect(keysWith(env, "queue:")).toEqual([]);
  });

  it("sends nothing while HermitShell has no sealing key", async () => {
    const { seal, ...unsealed } = STATUS;
    const env = await setup(unsealed);
    expect(seal).toBeTruthy();
    expect((await askLink(env, ALEX.email)).status).toBe(200);
    expect(keysWith(env, "queue:")).toEqual([]);
  });

  it("matches the address after answering when the runtime offers waitUntil", async () => {
    const env = await setup();
    const waits = [];
    const { pre, csrf } = await preForm(env);
    const res = await call(env, "/me/link", { fields: { csrf, email: ALEX.email }, cookie: pre, ctx: { waitUntil: (p) => waits.push(p) } });
    expect(res.status).toBe(200);
    expect(waits.length).toBe(1);
    await Promise.all(waits);
    expect(valuesWith(env, "queue:").length).toBe(1);
  });
});

describe("signing in with the link", () => {
  it("only shows a button on GET, so a mail scanner opening the link doesn't spend it", async () => {
    const env = await setup();
    await askLink(env, ALEX.email);
    const token = await emailedToken(env);
    for (let i = 0; i < 3; i++) {
      const page = await call(env, `/me/login?t=${token}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<button>Sign in</button>");
      expect(cookieNamed(page, "__Host-hv_me")).toBe("");
    }
    expect((await spend(env, token)).status).toBe(303);
  });

  it("sets a strict, host-only session cookie and opens the recruit's own page", async () => {
    const env = await setup();
    const { res, cookie } = await signIn(env);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/me");
    expect(res.headers.get("Set-Cookie")).toMatch(/__Host-hv_me=[^;]+; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict/);
    const home = await (await call(env, "/me", { cookie })).text();
    expect(home).toContain("Signed in as Alex Morgan");
  });

  it("works once, even when two presses race", async () => {
    const env = await setup();
    await askLink(env, ALEX.email);
    const token = await emailedToken(env);
    const both = await Promise.all([spend(env, token), spend(env, token)]);
    expect(both.map((r) => r.status).sort()).toEqual([303, 410]);
    expect((await spend(env, token)).status).toBe(410);
  });

  it("expires after 15 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
    const env = await setup();
    await askLink(env, ALEX.email);
    const token = await emailedToken(env);
    vi.setSystemTime(new Date("2026-03-02T09:16:00Z"));
    expect((await spend(env, token)).status).toBe(410);
  });

  it("refuses a made-up token, a malformed one and a press without the form's cookie", async () => {
    const env = await setup();
    expect((await spend(env, "A".repeat(43))).status).toBe(410);
    expect((await call(env, "/me/login?t=short")).status).toBe(400);
    await askLink(env, ALEX.email);
    const token = await emailedToken(env);
    const page = await call(env, `/me/login?t=${token}`);
    expect((await call(env, "/me/login", { fields: { csrf: csrfOf(await page.text()), t: token } })).status).toBe(403);
    expect((await spend(env, token)).status).toBe(303);
  });

  it("refuses a recruit paused after the link was sent", async () => {
    const env = await setup();
    await askLink(env, ALEX.email);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ ...STATUS, profiles: [{ ...ALEX, status: "paused" }, SAM, OWNER] }));
    expect((await spend(env, await emailedToken(env))).status).toBe(403);
  });

  it("limits sign-in presses per address range", async () => {
    const env = await setup();
    for (let i = 0; i < 10; i++) await spend(env, `${"B".repeat(42)}${i}`);
    await askLink(env, ALEX.email, "198.51.100.40");
    expect((await spend(env, await emailedToken(env))).status).toBe(429);
  });
});

describe("a recruit's session", () => {
  it("can't be swapped to another recruit, forged or used after it expires", async () => {
    const env = await setup();
    const { cookie } = await signIn(env);
    const [exp, , sig] = cookie.split("=")[1].split(".");
    for (const bad of [`__Host-hv_me=${exp}.sam-lee.${sig}`, `__Host-hv_me=${Number(exp) + 1000}.alex-morgan.${sig}`,
      `__Host-hv_me=${exp}.alex-morgan.${"0".repeat(40)}`, "__Host-hv_me=garbage", `__Host-hv_me=${exp}.alex-morgan`]) {
      const page = await (await call(env, "/me", { cookie: bad })).text();
      expect(page).toContain("Email me a sign-in link");
      expect(page).not.toContain("Signed in as");
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Number(exp) + 1);
    expect(await (await call(env, "/me", { cookie })).text()).toContain("Email me a sign-in link");
  });

  it("never opens /admin, and an admin's session never opens /me", async () => {
    const env = await setup();
    const { cookie } = await signIn(env);
    const admin = await (await call(env, "/admin", { cookie })).text();
    expect(admin).toContain('name="password"');
    expect(admin).not.toContain("Alex Morgan");
    const login = await call(env, "/admin/login", { fields: { username: "admin", password: ADMIN.ADMIN_PASSWORD }, ip: "192.0.2.50" });
    const adminCookie = (login.headers.get("Set-Cookie") || "").split(";")[0];
    expect(adminCookie).toMatch(/^__Host-hv_admin=/);
    expect(await (await call(env, "/me", { cookie: adminCookie })).text()).toContain("Email me a sign-in link");
    expect(await (await call(env, "/me", { cookie: adminCookie.replace("__Host-hv_admin", "__Host-hv_me") })).text())
      .toContain("Email me a sign-in link");
  });

  it("ends when the recruit is paused or removed", async () => {
    const env = await setup();
    const { cookie } = await signIn(env);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ ...STATUS, profiles: [{ ...ALEX, status: "paused" }, SAM, OWNER] }));
    expect(await (await call(env, "/me", { cookie })).text()).toContain("Email me a sign-in link");
  });

  it("signs out here, and everywhere by moving the recruit's epoch on", async () => {
    const env = await setup();
    const one = await signIn(env);
    const two = await signIn(env);
    const out = await call(env, "/me/logout", { fields: { csrf: one.csrf }, cookie: one.cookie });
    expect(cookieNamed(out, "__Host-hv_me")).toBe("__Host-hv_me=");
    expect(await (await call(env, "/me", { cookie: two.cookie })).text()).toContain("Signed in as");
    const all = await call(env, "/me/logout", { fields: { csrf: two.csrf, all: "1" }, cookie: two.cookie });
    expect(await all.text()).toContain("on all your other devices within about a minute");
    expect(await (await call(env, "/me", { cookie: two.cookie })).text()).toContain("Email me a sign-in link");
    expect(await (await call(env, "/me", { cookie: one.cookie })).text()).toContain("Email me a sign-in link");
  });

  it("refuses a signed-in form without its token", async () => {
    const env = await setup();
    const { cookie } = await signIn(env);
    for (const path of ["/me/search", "/me/cv", "/me/logout", "/me/unsubscribe"]) {
      expect((await call(env, path, { fields: { csrf: "0".repeat(32), confirm: "yes" }, cookie })).status).toBe(403);
    }
    expect(keysWith(env, "queue:").length).toBe(1);
  });
});

describe("my jobs", () => {
  it("lists the jobs sent to the recruit, never notes, other recruits or fees", async () => {
    const env = await setup();
    await env.FEEDBACK.put("sent:alex-morgan", JSON.stringify({ jobs: [
      { title: "Data Engineer", employer: "Northwind", location: "Salford", mode: "Hybrid", salary: "£50k", fit: 8,
        url: "https://jobs.example.com/1", day: "2026-03-01", answer: "interested", others: [{ u: "sam-lee", name: "Sam Lee" }],
        fee: "4500", stage: "interview" },
      { title: "<script>x</script>", employer: "Contoso", fit: 6, url: "javascript:alert(1)", day: "2026-03-02" },
    ], board: [{ fee: "4500" }] }));
    await env.FEEDBACK.put("notes:alex-morgan", "a private note");
    const { cookie } = await signIn(env);
    const page = await (await call(env, "/me", { cookie })).text();
    expect(page).toContain("Data Engineer");
    expect(page).toContain("Northwind");
    expect(page).toContain("8/10");
    expect(page).toContain("Interested");
    expect(page).toContain('href="https://jobs.example.com/1"');
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain("javascript:");
    expect(page).not.toContain("Sam Lee");
    expect(page).not.toContain("4500");
    expect(page).not.toContain("private note");
    expect(page.indexOf("Contoso")).toBeLessThan(page.indexOf("Northwind"));
  });
});

describe("my job search", () => {
  it("saves a change to the search as the recruit's own, and records it", async () => {
    const env = await setup();
    const { cookie } = await signIn(env);
    const form = await (await call(env, "/me/search", { cookie })).text();
    expect(form).not.toContain('name="email"');
    expect(form).not.toContain('name="name"');
    const base = form.match(/name="base" value="([^"]+)"/)[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    const csrf = csrfOf(form);
    const fields = { csrf, base, titles: "Data Engineer\nAnalytics Engineer", region: JOB.region, country: "gb", places: "Salford",
      max_km: "25", level: "any", min_salary: "0", currency: "£", types: "Permanent", modes: "Hybrid", report_time: "08:00",
      report_days: "daily" };
    const res = await call(env, "/me/search", { fields, cookie });
    expect(res.headers.get("Location")).toBe("/me/search?done=saved");
    const item = valuesWith(env, "queue:").find((i) => i.type === "admin");
    expect(item).toMatchObject({ action: "profile", u: "alex-morgan", self: 1 });
    expect(item.job.titles).toEqual(["Data Engineer", "Analytics Engineer"]);
    expect(item.job.max_km).toBe("25");
    expect(item.details).toBeUndefined();
    const history = valuesWith(env, "history:alex-morgan:").flat();
    expect(history.at(-1)).toMatchObject({ k: "job", v: "self", by: "Alex Morgan" });
  });

  it("refuses the whole save when the form carries details or anything else", async () => {
    const env = await setup();
    const { cookie, csrf } = await signIn(env);
    for (const extra of [{ email: "drew@example.com" }, { name: "Drew Harper" }, { u: "sam-lee" }, { phone: "1" }, { action: "delete" }]) {
      const res = await call(env, "/me/search", { fields: { csrf, titles: "Hacker", ...extra }, cookie });
      expect(res.status).toBe(400);
    }
    expect(valuesWith(env, "queue:").filter((i) => i.type === "admin")).toEqual([]);
  });

  it("never sends the details, whatever the form's base says", async () => {
    const env = await setup();
    const { cookie, csrf } = await signIn(env);
    const base = JSON.stringify({ ...JOB, name: "Drew Harper", email: "drew@example.com", phone: "", location: "",
      report_time: "08:00", report_days: "daily" });
    await call(env, "/me/search", { fields: { csrf, base, titles: "Data Engineer", region: JOB.region, country: "gb",
      places: "Salford", level: "any", min_salary: "1000", currency: "£", types: "Permanent", modes: "Hybrid",
      report_time: "08:00", report_days: "daily" }, cookie });
    const [item] = valuesWith(env, "queue:").filter((i) => i.type === "admin");
    expect(item.details).toBeUndefined();
    expect(item.u).toBe("alex-morgan");
  });
});

describe("my documents", () => {
  it("serves only the signed-in recruit's documents, whatever the address says", async () => {
    const env = await setup();
    const h = "c".repeat(32);
    const exp = Date.now() + 86400000;
    await env.FEEDBACK.put("docs:sam-lee", JSON.stringify([{ k: "cover_letter", h, name: "Sam Lee cover letter.pdf", at: Date.now(), exp }]));
    const { cookie } = await signIn(env);
    const page = await (await call(env, "/me/docs", { cookie })).text();
    expect(page).toContain("None kept at the moment.");
    expect(page).not.toContain("Sam Lee");
    for (const path of [`/me/doc?k=cover_letter&h=${h}`, `/me/doc?k=cover_letter&h=${h}&u=sam-lee`, "/me/doc?k=../x&h=1"]) {
      const res = await call(env, path, { cookie });
      expect(res.status).toBe(303);
      expect(res.headers.get("Location")).toBe("/me/docs?done=gone");
    }
    expect((await call(env, "/me/cv", { cookie })).headers.get("Location")).toBe("/me/docs?done=gone");
  });

  it("asks for the recruit's CV once while it is being made", async () => {
    const env = await setup();
    const { cookie, csrf } = await signIn(env);
    expect((await call(env, "/me/cv", { fields: { csrf }, cookie })).headers.get("Location")).toBe("/me/docs?done=cvmaking");
    expect(await (await call(env, "/me/docs", { cookie })).text()).toContain("Making your CV");
    await call(env, "/me/cv", { fields: { csrf }, cookie });
    expect(keysWith(env, "event:alex-morgan:").length).toBe(1);
    expect(valuesWith(env, "history:alex-morgan:").flat().filter((e) => e.k === "profile_cv")).toMatchObject([{ v: "self" }]);
  });
});

describe("unsubscribing from my page", () => {
  it("needs the box ticked, then queues the unsubscribe, drops the Worker's copies and ends the session", async () => {
    const env = await setup();
    await env.FEEDBACK.put("sent:alex-morgan", JSON.stringify({ jobs: [] }));
    const { cookie, csrf } = await signIn(env);
    expect((await call(env, "/me/unsubscribe", { fields: { csrf }, cookie })).headers.get("Location")).toBe("/me/search#stop");
    expect(valuesWith(env, "queue:").filter((i) => i.type === "unsubscribe")).toEqual([]);
    const res = await call(env, "/me/unsubscribe", { fields: { csrf, confirm: "yes" }, cookie });
    expect(cookieNamed(res, "__Host-hv_me")).toBe("__Host-hv_me=");
    expect(valuesWith(env, "queue:").filter((i) => i.type === "unsubscribe")).toMatchObject([{ u: "alex-morgan" }]);
    expect(keysWith(env, "sent:alex-morgan")).toEqual([]);
  });
});

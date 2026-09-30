// Security properties of the feedback Worker: headers, escaping, authentication, CSRF and size limits.
import { describe, expect, it } from "vitest";
import worker, { sign } from "../src/index.js";
import { record } from "../src/history.js";
import { today } from "../src/lib.js";
import { usageSection } from "../src/models.js";
import { letterStyle, requestDoc, styleLabel } from "../src/docs.js";
import { BASE, memoryHub, sealingKeys, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const HOSTILE = `<script>alert(1)</script>"'><img src=x onerror=alert(2)>`;

// Signed-in pages may load the dashboard's own script file and nothing else: no inline script, no other origin.
function onlyOwnScript(csp) {
  expect(csp).toContain("default-src 'none'; script-src 'self'; connect-src 'self';");
  expect(csp.match(/script-src[^;]*/g)).toEqual(["script-src 'self'"]);
  expect(csp.match(/style-src[^;]*/g)).toEqual(["style-src 'self' 'unsafe-inline'"]);
}

async function signed(action, key, title, profile = "") {
  const d = String(today());
  const t = await sign("test-secret", key, action, title, "", profile, d);
  return { j: key, a: action, n: title, ...(profile ? { u: profile } : {}), d, t };
}

function get(path, env, headers = {}) {
  return worker.fetch(new Request(`${BASE}${path}`, { headers }), env);
}

describe("security headers", () => {
  it("are on every kind of response", async () => {
    const env = testEnv(ADMIN);
    const responses = [
      await get("/privacy", env), await get("/admin", env), await get("/join?i=bad", env),
      await get("/f?j=x&a=applied&n=x&d=1&t=0", env), await get("/events", env), await get("/nope", env),
    ];
    for (const res of responses) {
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      if ((res.headers.get("Content-Type") || "").includes("text/html")) {
        const csp = res.headers.get("Content-Security-Policy");
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).not.toContain("script-src");
        expect(csp).toContain("img-src 'self';");
      }
    }
  });

  it("serves the tab icon as a script-free SVG, linked from every page and loadable only from the Worker", async () => {
    const env = testEnv(ADMIN);
    for (const path of ["/favicon.svg", "/favicon.ico"]) {
      const res = await get(path, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
      const svg = await res.text();
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(svg).not.toMatch(/<script|on\w+=|href=|<foreignObject|<image|<style|@import/i);
      expect(svg.match(/url\([^)]*\)/g).every((u) => /^url\(#[a-z]\)$/.test(u))).toBe(true);
    }
    expect((await worker.fetch(new Request(`${BASE}/favicon.svg`, { method: "POST" }), env)).status).toBe(404);
    for (const path of ["/admin", "/privacy", "/join?i=bad"]) {
      expect(await (await get(path, env)).text(), path).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    }
  });

  it("draws the brand mark in every page inline, with nothing that runs or loads from elsewhere", async () => {
    const env = testEnv(ADMIN);
    for (const path of ["/admin", "/privacy", "/join?i=bad"]) {
      const body = await (await get(path, env)).text();
      const mark = body.match(/<svg class="mark"[\s\S]*?<\/svg>/)[0];
      expect(mark, path).toContain('aria-hidden="true"');
      expect(mark, path).not.toMatch(/<script|on\w+=|href=|<foreignObject|<image|<style/i);
      expect(mark.match(/url\([^)]*\)/g).every((u) => /^url\(#hs-[tls]\)$/.test(u)), path).toBe(true);
      expect(body.match(/id="hs-t"/g), path).toHaveLength(1);
    }
  });
});

describe("escaping", () => {
  it("never reflects a signed title or note as markup", async () => {
    const env = testEnv();
    const params = await signed("applied", "nijobs:1", HOSTILE);
    const confirm = await (await get(`/f?${new URLSearchParams(params)}`, env)).text();
    expect(confirm).not.toContain("<script>");
    expect(confirm).not.toContain("<img");
    expect(confirm).toContain("&lt;script&gt;");
  });

  it("escapes an invite note on the admin page", async () => {
    const env = testEnv(ADMIN);
    const login = await worker.fetch(new Request(`${BASE}/admin/login`, {
      method: "POST", body: new URLSearchParams({ username: "admin", password: ADMIN.ADMIN_PASSWORD }),
      headers: { "CF-Connecting-IP": "203.0.113.7" } }), env);
    const cookie = login.headers.get("Set-Cookie").split(";")[0];
    const dash = await (await get("/admin", env, { Cookie: cookie })).text();
    const csrf = dash.match(/name="csrf" value="([0-9a-f]+)"/)[1];
    const res = await worker.fetch(new Request(`${BASE}/admin/action`, {
      method: "POST", body: new URLSearchParams({ csrf, action: "invite", note: HOSTILE }), headers: { Cookie: cookie } }), env);
    const body = await (await get(res.headers.get("Location"), env, { Cookie: cookie })).text();
    expect(body).toContain("Invite link");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
  });

  it("never echoes or queues a hostile country, whether reported or posted", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "sam-lee", name: "Sam Lee",
      email: "sam@example.com", job: { country: HOSTILE, titles: [], places: [] } }] }));
    const cookie = await signIn(env, "203.0.113.8");
    const body = await (await get("/admin/profile?u=sam-lee", env, { Cookie: cookie })).text();
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
    expect(body).toContain('<option value="">Any country</option>');
    expect(body.match(/<select id="country"[\s\S]*?<\/select>/)[0]).not.toContain("selected");
    const csrf = body.match(/name="csrf" value="([0-9a-f]+)"/)[1];
    await worker.fetch(new Request(`${BASE}/admin/action`, { method: "POST", headers: { Cookie: cookie },
      body: new URLSearchParams({ csrf, action: "profile", u: "sam-lee", name: "Sam Lee", email: "sam@example.com",
        country: HOSTILE, level: "any", types: "Permanent", modes: "Remote" }) }), env);
    expect(valuesWith(env, "queue:").map((i) => i.job?.country)).not.toContain(HOSTILE);
    expect(JSON.stringify(valuesWith(env, "queue:"))).not.toContain("<script>");
  });

  it("never trusts or echoes a tampered form base", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "sam-lee", name: "Sam Lee",
      email: "sam@example.com" }] }));
    const cookie = await signIn(env, "203.0.113.6");
    const page = await (await get("/admin/profile?u=sam-lee", env, { Cookie: cookie })).text();
    const csrf = page.match(/name="csrf" value="([0-9a-f]+)"/)[1];
    for (const base of [JSON.stringify({ name: HOSTILE, email: HOSTILE, titles: [HOSTILE], level: HOSTILE, country: HOSTILE }),
      "not json", '["array"]', JSON.stringify({ __proto__: { polluted: true } })]) {
      const res = await worker.fetch(new Request(`${BASE}/admin/action`, { method: "POST", headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf, action: "profile", u: "sam-lee", base, name: HOSTILE, email: "nope" }) }), env);
      const body = await res.text();
      expect([400, 409]).toContain(res.status);
      expect(body).not.toContain("<script>");
      expect(body).not.toContain("<img");
    }
    expect({}.polluted).toBeUndefined();
    expect(valuesWith(env, "queue:")).toEqual([]);
  });
});

async function signIn(env, ip) {
  const login = await worker.fetch(new Request(`${BASE}/admin/login`, {
    method: "POST", body: new URLSearchParams({ username: "admin", password: ADMIN.ADMIN_PASSWORD }),
    headers: { "CF-Connecting-IP": ip } }), env);
  return login.headers.get("Set-Cookie").split(";")[0];
}

describe("queue flag", () => {
  it("changes with every queued item and clears once HermitShell has collected them", async () => {
    const env = testEnv(ADMIN);
    const api = { Authorization: "Bearer api-token" };
    const flag = async () => (await (await get("/api/queue/flag", env, api)).json()).flag;
    expect(await flag()).toBe("");
    const { queueItem } = await import("../src/join.js");
    await queueItem(env, { type: "admin", action: "pause", u: "sam-lee" });
    const first = await flag();
    await queueItem(env, { type: "admin", action: "resume", u: "sam-lee" });
    const second = await flag();
    expect(first).toMatch(/^queue:\d+:[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
    const ids = (await (await get("/api/queue", env, api)).json()).items.map((i) => i.id);
    await worker.fetch(new Request(`${BASE}/api/queue/ack`, { method: "POST", headers: api, body: JSON.stringify({ ids }) }), env);
    expect(await flag()).toBe("");
  });
});

describe("live link", () => {
  it("never opens a socket or bumps the hub without the token, and its internal routes are not public", async () => {
    const HUB = memoryHub();
    const env = testEnv({ HUB });
    for (const headers of [{ Upgrade: "websocket" }, { Upgrade: "websocket", Authorization: "Bearer wrong-token" }]) {
      expect((await get("/api/live", env, headers)).status).toBe(401);
    }
    for (const path of ["/bump", "/seen", "/presence", "/connect", "/api/bump", "/api/presence"]) {
      const res = await worker.fetch(new Request(`${BASE}${path}`, { method: "POST", body: JSON.stringify({ flag: HOSTILE }),
        headers: { Upgrade: "websocket" } }), env);
      expect([401, 404]).toContain(res.status);
    }
    expect(HUB.state.sockets).toEqual([]);
    expect(HUB.storage.size).toBe(0);
  });
});

describe("authentication", () => {
  it("keeps every HermitShell API route behind the token", async () => {
    const env = testEnv();
    const routes = [["GET", "/events"], ["POST", "/ack"], ["GET", "/api/queue"], ["GET", "/api/queue/flag"], ["GET", "/api/live"], ["POST", "/api/queue/ack"],
      ["GET", "/api/file?key=cvfile:1"], ["POST", "/api/status"], ["POST", "/api/stats"], ["POST", "/api/invite"]];
    for (const [method, path] of routes) {
      for (const headers of [{}, { Authorization: "Bearer wrong-token" }, { Authorization: "api-token" }]) {
        const res = await worker.fetch(new Request(`${BASE}${path}`, { method, headers, body: method === "POST" ? "{}" : undefined }), env);
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    }
  });

  it("refuses admin actions without a session or with a forged CSRF token", async () => {
    const env = testEnv(ADMIN);
    const noSession = await worker.fetch(new Request(`${BASE}/admin/action`, {
      method: "POST", body: new URLSearchParams({ action: "delete", u: "sam-lee", confirm: "yes" }) }), env);
    expect(await noSession.text()).toContain("Admin sign-in");
    const forged = await worker.fetch(new Request(`${BASE}/admin/action`, {
      method: "POST", body: new URLSearchParams({ action: "delete", u: "sam-lee", confirm: "yes" }),
      headers: { Cookie: "__Host-hermes_admin=forged.value" } }), env);
    expect(await forged.text()).toContain("Admin sign-in");
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("only starts a report for a real profile id, with a session and its CSRF token", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "sam-lee", name: "Sam Lee", has_cv: true,
      scanning: HOSTILE, report: { time: HOSTILE, days: HOSTILE, pending: false } }] }));
    const noSession = await worker.fetch(new Request(`${BASE}/admin/action`, {
      method: "POST", body: new URLSearchParams({ action: "send_now", u: "sam-lee" }) }), env);
    expect(await noSession.text()).toContain("Admin sign-in");
    const cookie = await signIn(env, "203.0.113.5");
    const dash = await (await get("/admin", env, { Cookie: cookie })).text();
    expect(dash).not.toContain("<script>");
    const csrf = dash.match(/name="csrf" value="([0-9a-f]+)"/)[1];
    const send = (fields) => worker.fetch(new Request(`${BASE}/admin/action`, { method: "POST", headers: { Cookie: cookie },
      body: new URLSearchParams(fields) }), env);
    expect((await send({ csrf: "0".repeat(64), action: "send_now", u: "sam-lee" })).status).toBe(403);
    for (const u of ["../owner", "Sam", "sam lee", "sam&u=owner", "a".repeat(41)]) {
      expect((await send({ csrf, action: "send_now", u })).status).toBe(400);
    }
    const page = await (await get("/admin/profile?u=sam-lee", env, { Cookie: cookie })).text();
    expect(page).not.toContain("<script>");
    expect(page).toContain('name="report_time" type="time" value=""');
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("keeps stats behind a session, escapes what HermitShell sends and takes only real profile ids", async () => {
    const env = testEnv(ADMIN);
    const api = { Authorization: "Bearer api-token" };
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "sam-lee", name: HOSTILE, has_cv: true }] }));
    const stats = { days: { "2026-09-29": [5, 4, 3, 21, 3, 1, 1] }, since: HOSTILE, today: HOSTILE,
      ranges: { 30: { employers: [[HOSTILE, 2]], sources: [[HOSTILE, 1]], modes: [[HOSTILE, 1]], fit: [HOSTILE], salary: HOSTILE,
        best: [{ title: HOSTILE, employer: HOSTILE, fit: HOSTILE, day: HOSTILE }] } }, pipeline: { applied: HOSTILE } };
    const put = (body) => worker.fetch(new Request(`${BASE}/api/stats`, { method: "POST", headers: api, body: JSON.stringify(body) }), env);
    for (const u of ["../owner", "Sam", "stats:x", "a".repeat(41), "", 7]) expect((await put({ u, stats })).status).toBe(400);
    expect((await put({ u: "sam-lee", stats: { days: { "<b>": [1] } } })).status).toBe(400);
    expect((await put({ u: "sam-lee", stats })).status).toBe(200);
    const anonymous = await (await get("/admin/stats?u=sam-lee", env)).text();
    expect(anonymous).toContain("Admin sign-in");
    expect(anonymous).not.toContain("<script>");
    const cookie = await signIn(env, "203.0.113.6");
    for (const r of ["30", "7", "90", "365", "<script>"]) {
      const res = await get(`/admin/stats?u=sam-lee&r=${encodeURIComponent(r)}`, env, { Cookie: cookie });
      onlyOwnScript(res.headers.get("Content-Security-Policy"));
      const body = await res.text();
      expect(body, r).not.toContain("<script>");
      expect(body, r).not.toContain("<img src=x");
    }
    expect((await get("/admin/stats?u=..%2Fowner", env, { Cookie: cookie })).status).toBe(404);
    const big = await worker.fetch(new Request(`${BASE}/api/stats`, {
      method: "POST", headers: { ...api, "Content-Length": "5000000" }, body: "{}" }), env);
    expect(big.status).toBe(413);
  });

  it("keeps the jobs sent behind a session, escapes them and only links to web adverts", async () => {
    const env = testEnv(ADMIN);
    const api = { Authorization: "Bearer api-token" };
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "sam-lee", name: HOSTILE, has_cv: true }] }));
    const today = new Date().toISOString().slice(0, 10);
    const job = (url, extra = {}) => ({ title: HOSTILE, employer: HOSTILE, location: HOSTILE, mode: HOSTILE, salary: HOSTILE,
      source: HOSTILE, fit: 9, day: today, url, answer: HOSTILE, ...extra });
    const sent = [job("javascript:alert(1)"), job("data:text/html,<script>x</script>"), job('https://jobs.example.com/a" onmouseover="x'),
      job("https://jobs.example.com/ok?id=1&ref=2"), job("//evil.example/x"), job(`https://jobs.example.com/${"a".repeat(600)}`)];
    const put = (stats) => worker.fetch(new Request(`${BASE}/api/stats`, { method: "POST", headers: api, body: JSON.stringify({ u: "sam-lee", stats }) }), env);
    for (const bad of [{ days: {}, sent: "x" }, { days: {}, sent: [1] }, { days: {}, sent: [[]] }, { days: {}, sent: new Array(201).fill({ title: "x" }) }]) {
      expect((await put(bad)).status).toBe(400);
    }
    expect((await put({ days: {}, sent })).status).toBe(200);
    const anonymous = await (await get("/admin/sent?u=sam-lee", env)).text();
    expect(anonymous).toContain("Admin sign-in");
    expect(anonymous).not.toContain("jobs.example.com");
    const cookie = await signIn(env, "203.0.113.7");
    for (const q of ["r=7", "r=<script>", "a=<script>", "r=90&a=applied"]) {
      const res = await get(`/admin/sent?u=sam-lee&${q.replaceAll("<script>", encodeURIComponent("<script>"))}`, env, { Cookie: cookie });
      onlyOwnScript(res.headers.get("Content-Security-Policy"));
      const body = await res.text();
      expect(body, q).not.toContain("<script>");
      expect(body, q).not.toContain("<img src=x");
    }
    const body = await (await get("/admin/sent?u=sam-lee&r=7", env, { Cookie: cookie })).text();
    const hrefs = [...body.matchAll(/href="([^"]*)" target="_blank"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["https://jobs.example.com/ok?id=1&amp;ref=2"]);
    expect(body).toContain('rel="noopener noreferrer nofollow"');
    expect(body).not.toMatch(/href="(javascript|data):/);
    expect((await get("/admin/sent?u=..%2Fowner", env, { Cookie: cookie })).status).toBe(404);
  });

  it("only queues a global key from the modal with an admin session and its CSRF token, sealed, and never shows it back", async () => {
    const env = testEnv(ADMIN);
    const keys = await sealingKeys();
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ ...keys.status, keys: { firecrawl: { source: "dashboard", hint: HOSTILE } },
      profiles: [{ id: "sam-lee", name: HOSTILE, has_cv: true, provider: HOSTILE, key_hint: HOSTILE }] }));
    const secret = "tvly-never-shown-back-0001";
    const noSession = await worker.fetch(new Request(`${BASE}/admin/action`, {
      method: "POST", body: new URLSearchParams({ action: "api_key", provider: "tavily", key: secret }) }), env);
    expect(await noSession.text()).toContain("Admin sign-in");
    const cookie = await signIn(env, "203.0.113.7");
    const dash = await (await get("/admin", env, { Cookie: cookie })).text();
    expect(dash).not.toContain("<script>");
    expect(dash).not.toContain("<img src=x");
    const settings = await (await get("/admin/settings", env, { Cookie: cookie })).text();
    expect(settings).not.toContain("<script>");
    expect(settings).not.toContain("<img src=x");
    const csrf = settings.match(/name="csrf" value="([0-9a-f]+)"/)[1];
    const send = (fields) => worker.fetch(new Request(`${BASE}/admin/action`, { method: "POST", headers: { Cookie: cookie },
      body: new URLSearchParams(fields) }), env);
    expect((await send({ csrf: "0".repeat(32), action: "api_key", provider: "tavily", key: secret })).status).toBe(403);
    for (const provider of ["PATH", HOSTILE, "firecrawl_backup", "__proto__"]) {
      expect((await send({ csrf, action: "api_key", key: secret, provider })).headers.get("Location")).toBe("/admin/settings?done=badkey#keys");
    }
    expect((await send({ csrf, action: "set_key", u: "sam-lee", key: secret, provider: "tavily" })).status).toBe(400);
    expect(valuesWith(env, "queue:")).toEqual([]);
    const done = await send({ csrf, action: "api_key", provider: "tavily", key: secret });
    expect(done.headers.get("Location")).toBe("/admin/settings?done=queued#keys");
    for (const path of ["/admin?done=queued", "/admin/settings?done=queued"]) {
      expect(await (await get(path, env, { Cookie: cookie })).text()).not.toContain(secret);
    }
    const stored = [...env.FEEDBACK.store.values()].join("\n");
    expect(stored).not.toContain(secret);
    const [item] = valuesWith(env, "queue:");
    expect(await keys.open(item.tavily, "tavily")).toBe(secret);
    await expect(keys.open(item.tavily, "firecrawl")).rejects.toThrow();
  });

  it("shows a pending sign-up only to a session, without its phone, CV or invite, and escaped", async () => {
    const env = testEnv(ADMIN);
    const { queueItem } = await import("../src/join.js");
    await queueItem(env, { type: "signup", invite: "invite-id-0123456789abcdef", name: HOSTILE, email: HOSTILE, roles: HOSTILE,
      location: HOSTILE, phone: "07700 900999", cv: "cvfile:secret-cv-key", cv_text: "Private CV text" });
    const anonymous = await (await get("/admin", env)).text();
    expect(anonymous).toContain("Admin sign-in");
    expect(anonymous).not.toContain("pendingrow");
    const cookie = await signIn(env, "203.0.113.4");
    const body = await (await get("/admin", env, { Cookie: cookie })).text();
    expect(body).toContain('class="pendingrow"');
    for (const hidden of ["<script>", "<img src=x", "07700 900999", "secret-cv-key", "Private CV text", "invite-id-0123456789abcdef"]) {
      expect(body).not.toContain(hidden);
    }
  });

  it("keeps profile search behind a session and never reflects the query as markup", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "sam-lee", name: "Sam Lee", has_cv: true }] }));
    const q = encodeURIComponent(HOSTILE);
    const anonymous = await (await get(`/admin?q=${q}`, env)).text();
    expect(anonymous).toContain("Admin sign-in");
    expect(anonymous).not.toContain("Sam Lee");
    const cookie = await signIn(env, "203.0.113.8");
    for (const query of [q, `${q}${"a".repeat(5000)}`, encodeURIComponent('" autofocus onfocus="alert(1)'), "%00%0a%1b"]) {
      const res = await get(`/admin?q=${query}`, env, { Cookie: cookie });
      const body = await res.text();
      onlyOwnScript(res.headers.get("Content-Security-Policy"));
      expect(body).not.toContain("<script>");
      expect(body).not.toContain("<img src=x");
      expect(body).not.toContain('" autofocus');
      const value = body.match(/name="q" value="([^"]*)"/)[1]
        .replace(/&(lt|gt|quot|#39|amp);/g, (m) => ({ "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&amp;": "&" })[m]);
      expect(value.length).toBeLessThanOrEqual(60);
    }
  });

  it("keeps the settings pages, including email and key forms, behind a session", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "owner", owner: true, name: "Alex Morgan" }],
      email: { user: "alex@example.com", password_set: true } }));
    for (const path of ["/admin/profile?u=owner", "/admin/settings", "/admin/settings?done=queued", "/admin/profile/status?u=owner"]) {
      const body = await (await worker.fetch(new Request(`${BASE}${path}`), env)).text();
      expect(body, path).toContain("Admin sign-in");
      expect(body, path).not.toContain("alex@example.com");
    }
    const cv = new FormData();
    cv.append("u", "owner");
    cv.append("cv_text", "x".repeat(300));
    expect(await (await worker.fetch(new Request(`${BASE}/admin/cv`, { method: "POST", body: cv }), env)).text()).toContain("Admin sign-in");
    for (const fields of [{ action: "email", host: "smtp.example.com", port: "587", user: "x@example.com", password: "p" },
      { action: "api_keys", firecrawl: "fc-attacker1" }, { action: "test_email", to: "x@example.com" }]) {
      await worker.fetch(new Request(`${BASE}/admin/action`, { method: "POST", body: new URLSearchParams(fields) }), env);
    }
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("does not accept a link signed for another profile, action or job", async () => {
    const env = testEnv();
    const sam = await signed("interested", "nijobs:9", "Analyst", "sam-lee");
    for (const change of [{ u: "alex-kim" }, { a: "applied" }, { j: "nijobs:10" }, { n: "Other" }, { d: String(today() - 1) }]) {
      const res = await worker.fetch(new Request(`${BASE}/f`, { method: "POST", body: new URLSearchParams({ ...sam, ...change, r: "" }) }), env);
      expect(res.status, JSON.stringify(change)).toBe(403);
    }
    expect(env.FEEDBACK.store.size).toBe(0);
  });
});

describe("size limits", () => {
  it("rejects oversized forms before reading them", async () => {
    const env = testEnv();
    const params = await signed("applied", "nijobs:1", "Analyst");
    const big = new Request(`${BASE}/f`, { method: "POST", body: new URLSearchParams({ ...params, r: "x".repeat(200_000) }),
      headers: { "Content-Length": "200500" } });
    expect((await worker.fetch(big, env)).status).toBe(413);
    expect(env.FEEDBACK.store.size).toBe(0);
  });

  it("rejects an oversized HermitShell status report", async () => {
    const env = testEnv();
    const res = await worker.fetch(new Request(`${BASE}/api/status`, {
      method: "POST", headers: { Authorization: "Bearer api-token", "Content-Length": "5000000" }, body: "{}" }), env);
    expect(res.status).toBe(413);
  });
});

describe("task list", () => {
  const reported = (tasks) => JSON.stringify({ profiles: [{ id: "owner", owner: true, name: "Alex Morgan", email: "alex@example.com" },
    { id: "sam-lee-456789", name: "Sam Lee", email: "sam@example.com" }], tasks });

  it("needs a signed-in session to see or cancel anything", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", reported([{ id: "report:sam-lee-456789", kind: "report", u: "sam-lee-456789", state: "running" }]));
    const page = await (await get("/admin/tasks", env)).text();
    expect(page).toContain("Admin sign-in");
    expect(page).not.toContain("Daily report");
    const res = await worker.fetch(new Request(`${BASE}/admin/tasks`, { method: "POST",
      body: new URLSearchParams({ csrf: "x", task: "report:sam-lee-456789" }) }), env);
    expect(await res.text()).toContain("Admin sign-in");
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("refuses a cancel without the form's CSRF token", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", reported([{ id: "report:sam-lee-456789", kind: "report", u: "sam-lee-456789", state: "running" }]));
    const cookie = await signIn(env, "203.0.113.20");
    const res = await worker.fetch(new Request(`${BASE}/admin/tasks`, { method: "POST", headers: { Cookie: cookie },
      body: new URLSearchParams({ csrf: "0".repeat(32), task: "report:sam-lee-456789" }) }), env);
    expect(res.status).toBe(403);
    expect(valuesWith(env, "queue:")).toEqual([]);
    expect(valuesWith(env, "history:")).toEqual([]);
  });

  it("cannot delete a feedback answer, invent a task or send HermitShell a hostile one", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", reported([]));
    const answer = "event:_:0123456789abcdef0123456789abcdef:0a1b2c3d4e5f";
    await env.FEEDBACK.put(answer, JSON.stringify({ id: answer, a: "applied" }));
    const cookie = await signIn(env, "203.0.113.21");
    const csrf = (await (await get("/admin/tasks", env, { Cookie: cookie })).text()).match(/name="csrf" value="([0-9a-f]+)"/)?.[1]
      || (await (await get("/admin", env, { Cookie: cookie })).text()).match(/name="csrf" value="([0-9a-f]+)"/)[1];
    for (const task of [answer, "report:sam-lee-456789", "report:../../etc", `letter:owner:${HOSTILE}`, "status:profiles",
      "invite:abc", "queue:1:../x", "x".repeat(500)]) {
      const res = await worker.fetch(new Request(`${BASE}/admin/tasks`, { method: "POST", headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf, task }) }), env);
      expect(res.headers.get("Location")).toBe("/admin/tasks?done=gone");
    }
    expect(env.FEEDBACK.store.has(answer)).toBe(true);
    expect(env.FEEDBACK.store.has("status:profiles")).toBe(true);
    expect(valuesWith(env, "queue:")).toEqual([]);
    expect(valuesWith(env, "history:")).toEqual([]);
  });

  it("escapes everything a task shows and never offers to cancel a malformed one", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", reported([
      { id: "report:sam-lee-456789", kind: "report", u: "sam-lee-456789", state: "running", stage: HOSTILE, trigger: HOSTILE },
      { id: `letter:owner:event:_:${HOSTILE}`, kind: "cover_letter", u: "owner", state: "waiting", title: HOSTILE },
      { id: "letter:owner:event:_:abc:0a1b2c", kind: HOSTILE, u: "owner", state: HOSTILE, title: HOSTILE, employer: HOSTILE },
    ]));
    await env.FEEDBACK.put("tasks:requests", JSON.stringify([{ id: "event:_:abc:ffffff", a: "cover_letter", n: HOSTILE, u: "", at: 1 }]));
    const cookie = await signIn(env, "203.0.113.22");
    const body = await (await get("/admin/tasks", env, { Cookie: cookie })).text();
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;script&gt;");
    expect(body.split('<li class="task')).toHaveLength(4);
    expect(body).not.toContain(`value="letter:owner:event:_:&lt;`);
  });

  it("puts nothing a task reports into the inline style that phases its loading circle", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", reported([
      { id: "report:sam-lee-456789", kind: "report", u: "sam-lee-456789", state: "running", stage: HOSTILE, spin: HOSTILE, style: HOSTILE },
      { id: "letter:owner:event:_:abc:0a1b2c", kind: `x" style="background:url(//evil)`, u: "owner", state: `running" style="x`, title: HOSTILE },
    ]));
    const cookie = await signIn(env, "203.0.113.23");
    const res = await get("/admin/tasks", env, { Cookie: cookie });
    const body = await res.text();
    const styles = [...body.matchAll(/<li [^>]*style="([^"]*)"/g)].map((m) => m[1]);
    expect(styles.length).toBeGreaterThan(0);
    for (const s of styles) expect(s).toMatch(/^--spin:-\d\.\d\ds$/);
    expect(body).not.toContain('style="background');
    expect(body).not.toContain('style="x');
    expect(res.headers.get("Content-Security-Policy")).not.toContain("script-src");
  });
});

describe("web search key usage", () => {
  it("shows only checked, escaped fields from the keys HermitShell reports, at most six", async () => {
    const { keysSection } = await import("../src/keys.js");
    const hostile = { hint: HOSTILE, role: HOSTILE, at: HOSTILE, error: HOSTILE,
      usage: { used: "9", limit: -1, left: 1.5, plan: HOSTILE, resets: `2026-13-01${HOSTILE}` } };
    const html = keysSection({ keys: { firecrawl: { source: "env", hint: "fc-...0001", backups: HOSTILE,
      keys: [hostile, { hint: "fc-...0002", usage: { left: 5, limit: 10, plan: HOSTILE, resets: "2026-99-01" } },
        ...Array.from({ length: 10 }, (_, i) => ({ hint: `fc-...10${i}` })), "x", null, { hint: 5 }] } } }, "c".repeat(32));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("resets");
    expect(html).not.toContain("backup key");
    expect(html.match(/<li>/g)).toHaveLength(6);
    expect([...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1])).toEqual(["width:50%"]);
  });
});

describe("AI models and the server panel", () => {
  const status = {
    models: { openrouter: { source: "dashboard", hint: HOSTILE, model: HOSTILE, why: HOSTILE, resting_until: Date.now() + 60000, today: HOSTILE,
      keys: [{ hint: HOSTILE, usage: { used: "1", limit: Infinity, left: -2, plan: HOSTILE, unit: HOSTILE } }] }, __proto__: { source: "env" } },
    llm: { order: HOSTILE, cloud: ["openrouter", HOSTILE, "__proto__"], local: { model: HOSTILE, suggested: HOSTILE, where: HOSTILE },
      last: { provider: HOSTILE, model: HOSTILE, at: HOSTILE } },
    server: { cpu: { model: HOSTILE, cores: HOSTILE }, load: HOSTILE, ram_mb: { total: HOSTILE, available: 5 },
      gpus: [{ name: HOSTILE, vram_mb: 1e30, free_mb: -1 }, HOSTILE, null], disk_mb: HOSTILE },
  };

  it("escapes and checks every field HermitShell reports", async () => {
    const { modelsSection, serverBox } = await import("../src/models.js");
    for (const html of [modelsSection(status, "c".repeat(32)), serverBox(status)]) {
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("onerror=alert(2)>");
      expect(html).not.toContain("Last answer from");
      expect([...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).every((s) => /^(width:\d{1,3}%|display:inline)$/.test(s))).toBe(true);
    }
    const panel = serverBox(status);
    expect(panel).not.toContain("smeter");
    expect([...panel.matchAll(/<li[^>]*>.*?<b>([^<]+)<\/b>/g)].map((m) => m[1])).toEqual(["OpenRouter", "Local Ollama"]);
  });

  it("never lets a recruiter see the server, and never queues a model key from a recruiter", async () => {
    const env = testEnv({ ADMIN_PASSWORD: "correct horse battery" });
    const form = (path, fields, headers = {}) => new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: { Authorization: "Bearer api-token" },
      body: JSON.stringify({ profiles: [], server: { cpu: { model: "Secret CPU", cores: 4 } } }) }), env);
    const signIn = async (username, password) => {
      const res = await worker.fetch(form("/admin/login", { username, password }, { "CF-Connecting-IP": "203.0.113.9" }), env);
      const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
      const page = await (await worker.fetch(new Request(`${BASE}/admin`, { headers: { Cookie: cookie } }), env)).text();
      return { cookie, page, csrf: page.match(/name="csrf" value="([0-9a-f]+)"/)[1] };
    };
    const admin = await signIn("admin", "correct horse battery");
    await worker.fetch(form("/admin/users", { csrf: admin.csrf, op: "add", name: "Casey Quinn", username: "casey", password: "recruiter-password-1", roles: "recruiter" },
      { Cookie: admin.cookie }), env);
    const casey = await signIn("casey", "recruiter-password-1");
    expect(casey.page).not.toContain("Secret CPU");
    const res = await worker.fetch(form("/admin/action", { csrf: casey.csrf, action: "model_key", provider: "openrouter", key: "test-openrouter-key" },
      { Cookie: casey.cookie }), env);
    expect(res.status).not.toBe(302);
    expect(valuesWith(env, "queue:").filter((i) => i.action === "model_keys")).toEqual([]);
  });
});

describe("letters and CVs kept for download", () => {
  const PDF = new TextEncoder().encode("%PDF-1.4\nprivate letter text\n%%EOF");
  const API = { Authorization: "Bearer api-token" };
  const JOB = "https://jobs.example.com/1";
  const upload = (env, params = {}, body = PDF, headers = API) => worker.fetch(new Request(`${BASE}/api/doc?${new URLSearchParams({
    u: "sam-lee", j: JOB, k: "cover_letter", days: "7", name: "Letter.pdf", ...params })}`, { method: "POST", headers, body }), env);
  const reportedStatus = (env) => env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [
    { id: "owner", owner: true, name: "Alex Morgan" }, { id: "sam-lee", name: "Sam Lee" }, { id: "riley-chen", name: "Riley Chen" }] }));

  it("only takes documents from HermitShell's API token, as PDFs within the size limit, for a real profile id", async () => {
    const env = testEnv(ADMIN);
    expect((await upload(env, {}, PDF, {})).status).toBe(401);
    expect((await upload(env, {}, PDF, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await upload(env, {}, new TextEncoder().encode("<html><script>alert(1)</script>"))).status).toBe(400);
    expect((await upload(env, {}, new Uint8Array(2 * 1024 * 1024 + 1).fill(37))).status).toBe(413);
    for (const params of [{ u: "../owner" }, { u: "" }, { k: "applied" }, { j: "" }, { j: "x".repeat(301) }, { j: "a\nb" }, { days: "0" }, { days: "31" }, { days: "7.5" }]) {
      expect((await upload(env, params)).status).toBe(400);
    }
    expect([...env.FEEDBACK.store.keys()].filter((k) => k.startsWith("doc"))).toEqual([]);
  });

  it("stores them encrypted and bound to their key, so tampered or moved copies do not open", async () => {
    const env = testEnv(ADMIN);
    await reportedStatus(env);
    await upload(env);
    const { jobHash } = await import("../src/docs.js");
    const h = await jobHash(JOB);
    const key = `doc:sam-lee:cover_letter:${h}`;
    const stored = new Uint8Array(env.FEEDBACK.store.get(key));
    expect(new TextDecoder().decode(stored)).not.toContain("private letter text");
    const cookie = await signIn(env, "203.0.113.30");
    const download = () => get(`/admin/doc?u=sam-lee&k=cover_letter&h=${h}`, env, { Cookie: cookie });
    expect((await download()).status).toBe(200);
    const tampered = stored.slice();
    tampered[tampered.length - 1] ^= 1;
    env.FEEDBACK.store.set(key, tampered.buffer);
    expect((await download()).status).toBe(303);
    env.FEEDBACK.store.set(key, stored.buffer);
    await upload(env, { u: "riley-chen", j: "https://jobs.example.com/2" });
    const h2 = await jobHash("https://jobs.example.com/2");
    env.FEEDBACK.store.set(`doc:riley-chen:cover_letter:${h2}`, stored.buffer);
    expect((await get(`/admin/doc?u=riley-chen&k=cover_letter&h=${h2}`, env, { Cookie: cookie })).status).toBe(303);
    const other = await testEnv({ ...ADMIN, JOB_FEEDBACK_SECRET: "another-secret" });
    other.FEEDBACK = env.FEEDBACK;
    const { readDoc } = await import("../src/docs.js");
    expect(await readDoc(other, "sam-lee", "cover_letter", h)).toBeNull();
    expect(await readDoc(env, "sam-lee", "cover_letter", h)).not.toBeNull();
  });

  it("downloads only for a signed-in admin, as an attachment that cannot run in the page", async () => {
    const env = testEnv(ADMIN);
    await reportedStatus(env);
    await upload(env, { name: `Letter"; filename=evil.html\r\n<script>.pdf` });
    const { jobHash } = await import("../src/docs.js");
    const path = `/admin/doc?u=sam-lee&k=cover_letter&h=${await jobHash(JOB)}`;
    const anonymous = await get(path, env);
    expect(anonymous.headers.get("Content-Type")).toContain("text/html");
    expect(await anonymous.text()).toContain("Admin sign-in");
    const res = await get(path, env, { Cookie: await signIn(env, "203.0.113.31") });
    const disposition = res.headers.get("Content-Disposition");
    expect(disposition).toMatch(/^attachment; filename="[^"\r\n;]*"; filename\*=UTF-8''\S+$/);
    expect(disposition).not.toContain("evil.html\"");
    expect(disposition).not.toMatch(/[\r\n<>]/);
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await get("/admin/doc?u=sam-lee&k=cover_letter&h=../../x", env, { Cookie: await signIn(env, "203.0.113.32") })).status).toBe(303);
    expect((await get("/admin/doc?u=../sam-lee&k=cover_letter&h=0", env, { Cookie: await signIn(env, "203.0.113.33") })).status).toBe(404);
  });

  it("needs a signed-in session and the form's CSRF token to ask for one from the dashboard", async () => {
    const env = testEnv(ADMIN);
    await reportedStatus(env);
    const cookie = await signIn(env, "203.0.113.34");
    for (const extra of [{}, { send: "1" }]) {
      const fields = { u: "sam-lee", j: JOB, k: "cover_letter", n: "Data Engineer", ...extra };
      const anonymous = await worker.fetch(new Request(`${BASE}/admin/doc`, { method: "POST", body: new URLSearchParams({ csrf: "x", ...fields }) }), env);
      expect(await anonymous.text()).toContain("Admin sign-in");
      const forged = await worker.fetch(new Request(`${BASE}/admin/doc`, { method: "POST", headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf: "0".repeat(32), ...fields }) }), env);
      expect(forged.status).toBe(403);
    }
    expect([...env.FEEDBACK.store.keys()].filter((k) => k.startsWith("event:"))).toEqual([]);
    expect(valuesWith(env, "history:")).toEqual([]);
  });

  it("serves an email button's document only for that link's job, profile and kind, and never for a changed or expired link", async () => {
    const env = testEnv(ADMIN);
    await reportedStatus(env);
    await upload(env);
    const fetchDoc = (p) => worker.fetch(new Request(`${BASE}/f/doc?${new URLSearchParams(p)}`), env);
    const good = await signed("cover_letter", JOB, "Data Engineer", "sam-lee");
    expect((await fetchDoc(good)).headers.get("Content-Type")).toBe("application/pdf");
    expect((await fetchDoc({ ...good, u: "riley-chen" })).status).toBe(403);
    expect((await fetchDoc({ ...good, a: "tailored_cv" })).status).toBe(403);
    expect((await fetchDoc({ ...good, j: "https://jobs.example.com/2" })).status).toBe(403);
    expect((await fetchDoc(await signed("cover_letter", JOB, "Data Engineer", "riley-chen"))).status).toBe(404);
    expect((await fetchDoc(await signed("tailored_cv", JOB, "Data Engineer", "sam-lee"))).status).toBe(404);
    expect((await fetchDoc(await signed("applied", JOB, "Data Engineer", "sam-lee"))).status).toBe(404);
    const old = String(today() - 91);
    const expired = { ...good, d: old, t: await sign("test-secret", JOB, "cover_letter", "Data Engineer", "", "sam-lee", old) };
    expect((await fetchDoc(expired)).status).toBe(410);
  });

  it("escapes every job detail on the list of jobs sent and links only real web addresses", async () => {
    const env = testEnv(ADMIN);
    await reportedStatus(env);
    const job = { title: HOSTILE, employer: HOSTILE, day: new Date().toISOString().slice(0, 10), fit: 8, key: `k${HOSTILE}`, url: "javascript:alert(1)",
      more: { reasoning: HOSTILE, about: HOSTILE, profile: HOSTILE, company: HOSTILE, type: HOSTILE, closing: HOSTILE, published: HOSTILE,
        site: "javascript:alert(1)", matched: [HOSTILE], gaps: [HOSTILE], confidence: "100%\"><script>", coverage: 1e9 } };
    await worker.fetch(new Request(`${BASE}/api/stats`, { method: "POST", headers: API, body: JSON.stringify({ u: "sam-lee", stats: { days: {}, sent: [job] } }) }), env);
    const body = await (await get("/admin/sent?u=sam-lee&r=7", env, { Cookie: await signIn(env, "203.0.113.35") })).text();
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("javascript:");
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("Confidence</span>");
    expect(body).not.toContain("CV keyword match</span>");
    expect(body).toContain('name="j" value="k&lt;script&gt;');
  });

  it("refuses details that are not an object", async () => {
    const env = testEnv(ADMIN);
    const put = (sent) => worker.fetch(new Request(`${BASE}/api/stats`, { method: "POST", headers: API,
      body: JSON.stringify({ u: "sam-lee", stats: { days: {}, sent } }) }), env);
    expect((await put([{ title: "x", more: "text" }])).status).toBe(400);
    expect((await put([{ title: "x", more: [1] }])).status).toBe(400);
    expect((await put([{ title: "x", more: {} }])).status).toBe(200);
  });
});

describe("jobs emailed from the list of jobs sent", () => {
  const API = { Authorization: "Bearer api-token" };
  const JOB = "https://jobs.example.com/1";
  const mark = (env, params = {}, headers = API) => worker.fetch(new Request(`${BASE}/api/emailed?${new URLSearchParams({
    u: "sam-lee", j: JOB, ...params })}`, { method: "POST", headers }), env);
  const sentList = (env, u = "sam-lee") => worker.fetch(new Request(`${BASE}/api/stats`, { method: "POST", headers: API,
    body: JSON.stringify({ u, stats: { days: {}, sent: [{ title: "Data Engineer", day: new Date().toISOString().slice(0, 10), fit: 8, key: JOB }] } }) }), env);

  it("only takes the emailed mark from HermitShell's API token, for a real profile id and job key", async () => {
    const env = testEnv(ADMIN);
    expect((await mark(env, {}, {})).status).toBe(401);
    expect((await mark(env, {}, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await worker.fetch(new Request(`${BASE}/api/emailed?u=sam-lee&j=x`, { headers: API }), env)).status).toBe(404);
    for (const params of [{ u: "../owner" }, { u: "Sam Lee" }, { u: "" }, { j: "" }, { j: "x".repeat(301) }, { j: "a\u0000b" }]) {
      expect((await mark(env, params)).status).toBe(400);
    }
    expect([...env.FEEDBACK.store.keys()].filter((k) => k.startsWith("emailed:"))).toEqual([]);
  });

  it("keeps only a hash and a time per job, capped, and drops entries that do not look right", async () => {
    const env = testEnv(ADMIN);
    for (let i = 0; i < 305; i += 1) await mark(env, { j: `https://jobs.example.com/${i}` });
    const index = JSON.parse(env.FEEDBACK.store.get("emailed:sam-lee"));
    expect(index).toHaveLength(300);
    expect(index.every((e) => Object.keys(e).join() === "h,at" && /^[0-9a-f]{32}$/.test(e.h))).toBe(true);
    expect(env.FEEDBACK.store.get("emailed:sam-lee")).not.toContain("jobs.example.com");
    await env.FEEDBACK.put("emailed:sam-lee", JSON.stringify([{ h: HOSTILE, at: 1 }, { h: "0".repeat(32), at: "soon" }, "x"]));
    const { emailedIndex } = await import("../src/docs.js");
    expect(await emailedIndex(env, "sam-lee")).toEqual([]);
  });

  it("needs a signed-in session and the form's CSRF token to ask for one", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "sam-lee", name: "Sam Lee" }] }));
    const fields = { u: "sam-lee", j: JOB, k: "send_job", n: "Data Engineer" };
    const anonymous = await worker.fetch(new Request(`${BASE}/admin/doc`, { method: "POST", body: new URLSearchParams({ csrf: "x", ...fields }) }), env);
    expect(await anonymous.text()).toContain("Admin sign-in");
    const cookie = await signIn(env, "203.0.113.36");
    const forged = await worker.fetch(new Request(`${BASE}/admin/doc`, { method: "POST", headers: { Cookie: cookie },
      body: new URLSearchParams({ csrf: "0".repeat(32), ...fields }) }), env);
    expect(forged.status).toBe(403);
    expect([...env.FEEDBACK.store.keys()].filter((k) => k.startsWith("event:"))).toEqual([]);
  });

  it("needs a signed-in session and the form's CSRF token to add a skill, and keeps only a cleaned skill", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "sam-lee", name: "Sam Lee" }] }));
    const fields = { u: "sam-lee", j: JOB, s: "dbt" };
    const anonymous = await worker.fetch(new Request(`${BASE}/admin/skill`, { method: "POST", body: new URLSearchParams({ csrf: "x", ...fields }) }), env);
    expect(await anonymous.text()).toContain("Admin sign-in");
    const cookie = await signIn(env, "203.0.113.38");
    const send = (extra) => worker.fetch(new Request(`${BASE}/admin/skill`, { method: "POST", headers: { Cookie: cookie },
      body: new URLSearchParams({ ...fields, ...extra }) }), env);
    expect((await send({ csrf: "0".repeat(32) })).status).toBe(403);
    expect((await send({ csrf: "0".repeat(32), u: "../sam-lee" })).status).toBe(403);
    expect([...env.FEEDBACK.store.keys()].filter((k) => k.startsWith("event:") || k.startsWith("skilladd:"))).toEqual([]);
    const csrf = (await (await get("/admin", env, { Cookie: cookie })).text()).match(/name="csrf" value="([0-9a-f]+)"/)[1];
    expect((await send({ csrf, u: "../sam-lee" })).status).toBe(400);
    expect((await send({ csrf, s: `${HOSTILE} dbt` })).status).toBe(303);
    const [event] = [...env.FEEDBACK.store.entries()].filter(([k]) => k.startsWith("event:")).map(([, v]) => JSON.parse(v));
    const [added] = JSON.parse(env.FEEDBACK.store.get("skilladd:sam-lee"));
    for (const skill of [event.skills[0], added.s]) {
      expect(skill).toMatch(/dbt$/);
      expect(skill).not.toMatch(/[<>"'`=]/);
      expect(skill.length).toBeLessThanOrEqual(60);
    }
  });

  it("escapes skills from the stats and from the skills added, and drops added ones that do not look right", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "sam-lee", name: "Sam Lee" }] }));
    await worker.fetch(new Request(`${BASE}/api/stats`, { method: "POST", headers: API, body: JSON.stringify({ u: "sam-lee", stats: { days: {},
      skills: [HOSTILE.slice(0, 60)], sent: [{ title: "Data Engineer", day: new Date().toISOString().slice(0, 10), fit: 8, key: JOB,
        more: { gaps: [HOSTILE, "dbt"] } }] } }) }), env);
    await env.FEEDBACK.put("skilladd:sam-lee", JSON.stringify([{ s: HOSTILE, at: Date.now() }, { s: "dbt", at: "now" }, "x", { s: 5 }]));
    const { addedSkills } = await import("../src/docs.js");
    expect(await addedSkills(env, "sam-lee")).toEqual([]);
    const body = await (await get("/admin/sent?u=sam-lee&r=7", env, { Cookie: await signIn(env, "203.0.113.39") })).text();
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
    expect(body).toContain('<button title="Add dbt to the skills on the CV">');
  });

  it("escapes the profile's name on the tile and never shows its email address", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "sam-lee", name: `${HOSTILE} Lee`, email: "sam@example.com" }] }));
    await sentList(env);
    await mark(env);
    const body = await (await get("/admin/sent?u=sam-lee&r=7", env, { Cookie: await signIn(env, "203.0.113.37") })).text();
    expect(body).toContain("Emailed to &lt;script&gt;");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("sam@example.com");
  });
});

describe("changing and resetting passwords", () => {
  const form = (path, fields, cookie) => new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields),
    headers: cookie ? { Cookie: cookie } : {} });
  const csrfOf = async (env, cookie) => (await (await get("/admin", env, { Cookie: cookie })).text()).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  const userCookie = async (env, username, password, ip) => (await worker.fetch(new Request(`${BASE}/admin/login`, {
    method: "POST", body: new URLSearchParams({ username, password }), headers: { "CF-Connecting-IP": ip } }), env))
    .headers.get("Set-Cookie")?.split(";")[0];

  async function twoRecruiters() {
    const env = testEnv(ADMIN);
    const admin = await signIn(env, "203.0.113.60");
    for (const [name, username, password] of [["Casey Quinn", "casey", "casey's passphrase"], ["Drew Harper", "drew", "drew's passphrase"]]) {
      await worker.fetch(form("/admin/users", { csrf: await csrfOf(env, admin), op: "add", name, username, password, roles: "recruiter" }, admin), env);
    }
    const casey = await userCookie(env, "casey", "casey's passphrase", "203.0.113.61");
    return { env, admin, casey };
  }

  it("only ever changes the signed-in user's own password, whatever the form names", async () => {
    const { env, casey } = await twoRecruiters();
    const drewBefore = JSON.parse(env.FEEDBACK.store.get("accounts")).users.find((u) => u.id === "drew");
    const res = await worker.fetch(form("/admin/password", { csrf: await csrfOf(env, casey), username: "drew", id: "drew", u: "admin",
      current: "casey's passphrase", password: "chosen by casey", again: "chosen by casey" }, casey), env);
    expect(res.headers.get("Location")).toBe("/admin?done=password");
    const users = JSON.parse(env.FEEDBACK.store.get("accounts")).users;
    expect(users.find((u) => u.id === "drew")).toEqual(drewBefore);
    expect(await userCookie(env, "drew", "chosen by casey", "203.0.113.62")).toBeUndefined();
    expect(await userCookie(env, "casey", "chosen by casey", "203.0.113.63")).toMatch(/\.casey\./);
    expect(await userCookie(env, "admin", "chosen by casey", "203.0.113.64")).toBeUndefined();
  });

  it("stops an old cookie from changing the password back once it has changed", async () => {
    const { env, casey } = await twoRecruiters();
    const csrf = await csrfOf(env, casey);
    await worker.fetch(form("/admin/password", { csrf, current: "casey's passphrase", password: "first new one", again: "first new one" }, casey), env);
    const replay = await worker.fetch(form("/admin/password",
      { csrf, current: "first new one", password: "attacker's choice", again: "attacker's choice" }, casey), env);
    expect(await replay.text()).toContain("Admin sign-in");
    expect(await userCookie(env, "casey", "first new one", "203.0.113.65")).toMatch(/\.casey\./);
  });

  it("keeps no password in storage, in the lock or in any page, and a recruiter's reset is refused", async () => {
    const { env, casey } = await twoRecruiters();
    const csrf = await csrfOf(env, casey);
    await worker.fetch(form("/admin/password", { csrf, current: "a wrong guess here", password: "not stored", again: "not stored" }, casey), env);
    expect(env.FEEDBACK.store.get("pwlock:casey")).toBe("1");
    const reset = await worker.fetch(form("/admin/users", { csrf, op: "reset", id: "drew", password: "casey took over", again: "casey took over" }, casey), env);
    expect(reset.status).toBe(403);
    for (const value of env.FEEDBACK.store.values()) {
      for (const secret of ["casey's passphrase", "drew's passphrase", "a wrong guess here", "not stored", "casey took over"]) {
        expect(String(value)).not.toContain(secret);
      }
    }
    expect(await (await get("/admin", env, { Cookie: casey })).text()).not.toContain("passphrase");
  });
});

describe("the signed-in box", () => {
  it("escapes the signed-in user's name", async () => {
    const env = testEnv(ADMIN);
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: { Authorization: "Bearer api-token" },
      body: JSON.stringify({ profiles: [{ id: "owner", name: HOSTILE, email: "alex@example.com", status: "active", owner: true }] }) }), env);
    const cookie = await signIn(env, "203.0.113.70");
    const body = await (await get("/admin/users", env, { Cookie: cookie })).text();
    const box = body.slice(body.indexOf('<div class="me"'), body.indexOf("<main"));
    expect(box).toContain("&lt;script&gt;");
    expect(box).not.toContain("<script>");
    expect(box).not.toContain("<img");
  });

  it("stays once, before the full-width card, when a recruit is named with page tags", async () => {
    const env = testEnv(ADMIN);
    const tags = '<body><main class="wide full"></main>';
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: { Authorization: "Bearer api-token" },
      body: JSON.stringify({ profiles: [{ id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true },
        { id: "sam-lee-abc123", name: tags, email: "sam@example.com", status: "active" }] }) }), env);
    const cookie = await signIn(env, "203.0.113.71");
    const body = await (await get("/admin", env, { Cookie: cookie })).text();
    expect(body.match(/<div class="me"/g)).toHaveLength(1);
    expect(body.match(/<body>/g)).toHaveLength(1);
    expect(body.match(/<main class="wide full">/g)).toHaveLength(1);
    expect(body.indexOf('<div class="me"')).toBeLessThan(body.indexOf('<main class="wide full">'));
    expect(body).toContain("&lt;body&gt;&lt;main class=&quot;wide full&quot;&gt;");
  });
});

describe("a recruit's history", () => {
  const API = { Authorization: "Bearer api-token" };
  const PROFILES = [{ id: "owner", name: HOSTILE, email: "alex@example.com", status: "active", owner: true },
    { id: "sam-lee", name: HOSTILE, email: "sam@example.com", status: "active", last_run: 1000 }];

  async function setup(ip) {
    const env = testEnv(ADMIN);
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles: PROFILES }) }), env);
    const cookie = await signIn(env, ip);
    const csrf = (await (await get("/admin", env, { Cookie: cookie })).text()).match(/name="csrf" value="([0-9a-f]+)"/)[1];
    const act = (fields) => worker.fetch(new Request(`${BASE}/admin/action`, { method: "POST", body: new URLSearchParams({ csrf, ...fields }),
      headers: { Cookie: cookie } }), env);
    return { env, cookie, act, page: async (q = "") => (await get(`/admin/history?u=sam-lee${q}`, env, { Cookie: cookie })).text() };
  }

  it("escapes job titles from email links, names and the month asked for", async () => {
    const { env, act, page } = await setup("203.0.113.80");
    await worker.fetch(new Request(`${BASE}/f`, { method: "POST", body: new URLSearchParams({ ...(await signed("applied", "nijobs:1", HOSTILE, "sam-lee")), r: "" }) }), env);
    await act({ action: "pause", u: "sam-lee" });
    const body = await page(`&m=${encodeURIComponent('2026-09"><script>alert(3)</script>')}`);
    expect(body).toContain("Answered Applied: &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("by &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("alert(3)");
  });

  it("drops tampered entries and escapes what is left", async () => {
    const { env, page } = await setup("203.0.113.81");
    const key = `history:sam-lee:${new Date().toISOString().slice(0, 7)}`;
    await env.FEEDBACK.put(key, JSON.stringify([null, "text", { at: "soon", k: "send", t: "x" }, { at: Date.now(), k: "format_disk", t: "bad kind" },
      { at: Date.now(), k: "send", t: "" }, { at: Date.now(), k: "send", t: HOSTILE, v: "javascript:", by: HOSTILE }]));
    const body = await page();
    expect(body.match(/<li class="hev">/g)).toHaveLength(1);
    expect(body).not.toContain("bad kind");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("javascript:");
    await env.FEEDBACK.put(key, JSON.stringify({ not: "a list" }));
    expect(await page()).toContain("Nothing recorded yet.");
  });

  it("stores entries cleaned and capped, never raw", async () => {
    const { env } = await setup("203.0.113.82");
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API,
      body: JSON.stringify({ profiles: PROFILES.map((p) => ({ ...p, last_run: Date.now() })) }) }), env);
    await worker.fetch(new Request(`${BASE}/f`, { method: "POST", body: new URLSearchParams({
      ...(await signed("applied", "nijobs:2", `Engineer ${"x".repeat(111)}`, "sam-lee")), r: "" }) }), env);
    await record(env, "sam-lee", "send", `Asked\u0007\u001b[31m for ${"y".repeat(400)}`, { by: `Casey\n${"z".repeat(200)}` });
    const rows = valuesWith(env, "history:sam-lee:").flat();
    expect(rows).toHaveLength(3);
    expect(rows[2].by.length).toBeLessThanOrEqual(80);
    for (const row of rows) {
      expect(Object.keys(row).every((k) => ["at", "k", "t", "v", "by"].includes(k))).toBe(true);
      expect(row.t.length).toBeLessThanOrEqual(200);
      expect(`${row.t}${row.by || ""}`).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });

  it("never stops the action it records, even when KV refuses the write", async () => {
    const { env, act } = await setup("203.0.113.83");
    const put = env.FEEDBACK.put.bind(env.FEEDBACK);
    env.FEEDBACK.put = async (key, ...rest) => {
      if (key.startsWith("history:")) throw new Error("KV put() limit exceeded for the day.");
      return put(key, ...rest);
    };
    const res = await act({ action: "pause", u: "sam-lee" });
    expect(res.headers.get("Location")).toBe("/admin?done=queued");
    expect(valuesWith(env, "queue:")).toMatchObject([{ action: "pause", u: "sam-lee" }]);
  });

  it("needs a signed-in session, and HermitShell's token to add its own events", async () => {
    const env = testEnv(ADMIN);
    expect((await get("/admin/history?u=sam-lee", env)).status).toBe(200);
    expect(await (await get("/admin/history?u=sam-lee", env)).text()).toContain("Admin sign-in");
    const forged = await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", body: JSON.stringify({ profiles: PROFILES }) }), env);
    expect(forged.status).toBe(401);
    expect(valuesWith(env, "history:")).toEqual([]);
  });
});

describe("pages that update themselves", () => {
  it("never show a queued item's own text, however hostile, and only reload for what the page shows", async () => {
    const env = testEnv(ADMIN);
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: { Authorization: "Bearer api-token" },
      body: JSON.stringify({ profiles: [{ id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active" }] }) }), env);
    const at = Date.now();
    const items = [{ type: "admin", action: "api_keys", clear: [HOSTILE], [HOSTILE]: HOSTILE },
      { type: "admin", action: "model_keys", provider: HOSTILE, order: HOSTILE }, { type: "admin", action: "pause", u: HOSTILE }];
    for (const [n, item] of items.entries()) {
      await env.FEEDBACK.put(`queue:${at + n}:x${n}`, JSON.stringify({ id: `queue:${at + n}:x${n}`, at: at + n, ...item }));
    }
    await env.FEEDBACK.put("flag:queue", "x");
    const cookie = await signIn(env, "203.0.113.90");
    const settings = await (await get("/admin/settings", env, { Cookie: cookie })).text();
    const board = await (await get("/admin", env, { Cookie: cookie })).text();
    for (const body of [settings, board]) {
      expect(body).not.toContain("<script>");
      expect(body).not.toContain("<img");
      expect(body).toMatch(/<meta http-equiv="refresh" content="4(;url=\/admin\/settings\?w=1#models)?">/);
    }
    expect(settings).not.toContain("savingtag keepanim");
    expect(board).not.toContain("savingtag keepanim");
  });
});

describe("the admin is staff, not a recruit", () => {
  const API = { Authorization: "Bearer api-token" };
  const STAFF = { id: "owner", owner: true, name: "Alex Morgan", email: "alex@example.com", status: "active", recruiter: "", has_cv: false,
    recruit: "sam-lee" };

  async function setup(ip) {
    const env = testEnv(ADMIN);
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API,
      body: JSON.stringify({ profiles: [STAFF, { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active" }] }) }), env);
    const cookie = await signIn(env, ip);
    const csrf = (await (await get("/admin", env, { Cookie: cookie })).text()).match(/name="csrf" value="([0-9a-f]+)"/)[1];
    const post = (path, fields) => worker.fetch(new Request(`${BASE}${path}`, { method: "POST", headers: { Cookie: cookie },
      body: new URLSearchParams({ csrf, ...fields }) }), env);
    return { env, cookie, post };
  }

  it("has no recruit pages of their own, even for the main admin", async () => {
    const { env, cookie } = await setup("203.0.113.90");
    const board = await (await get("/admin", env, { Cookie: cookie })).text();
    expect(board).not.toContain("u=owner");
    expect(board).toContain("/admin/profile?u=sam-lee");
    for (const path of ["/admin/profile?u=owner", "/admin/stats?u=owner", "/admin/sent?u=owner&r=7", "/admin/history?u=owner",
      "/admin/status?u=owner"]) {
      expect((await get(path, env, { Cookie: cookie })).status, path).toBe(404);
    }
  });

  it("cannot be given a job search, a CV or reports from the dashboard", async () => {
    const { env, post } = await setup("203.0.113.91");
    for (const fields of [{ action: "profile", u: "owner", name: "Alex Morgan", email: "alex@example.com", roles: "Data analyst" },
      { action: "send_now", u: "owner" }, { action: "pause", u: "owner" }, { action: "resume", u: "owner" },
      { action: "delete", u: "owner", confirm: "yes" }, { action: "assign", u: "owner", recruiter: "" }, { action: "set_key", u: "owner" }]) {
      const res = await post("/admin/action", fields);
      expect(res.status, fields.action).not.toBe(200);
      expect(res.headers.get("Location") || "", fields.action).not.toMatch(/done=(queued|assigned|deleted)/);
    }
    await post("/admin/doc", { u: "owner", j: "https://jobs.example.com/1", k: "cover_letter", n: "Analyst" });
    await post("/admin/skill", { u: "owner", j: "https://jobs.example.com/1", s: "SQL" });
    expect(valuesWith(env, "queue:")).toEqual([]);
    expect([...env.FEEDBACK.store.keys()].filter((k) => k.startsWith("event:") || k.startsWith("skilladd:"))).toEqual([]);
  });

  it("moves only to a real recruit id, never over another admin row or out of the history prefix", async () => {
    const env = testEnv(ADMIN);
    await record(env, "owner", "send", "Asked for jobs now");
    for (const recruit of ["../sam-lee", "owner", "history:x", "a".repeat(41), 7]) {
      await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API,
        body: JSON.stringify({ profiles: [{ ...STAFF, recruit }] }) }), env);
      expect([...env.FEEDBACK.store.keys()].filter((k) => k.startsWith("history:")), String(recruit)).toHaveLength(1);
    }
  });
});

describe("model tokens from HermitShell's status", () => {
  it("shows no markup, unknown task or impossible number from a tampered status", () => {
    const bad = { calls: HOSTILE, failed: -4, in: 1e99, out: "12", avg_ms: Infinity, estimated: NaN };
    const html = usageSection({ usage: { days: HOSTILE, tasks: [
      { task: HOSTILE, today: bad, period: { calls: 5, in: 10, out: 10 } },
      { task: "__proto__", period: { calls: 5 } },
      { task: "rating", label: HOSTILE, today: bad, period: { calls: 3, failed: HOSTILE, in: 900, out: 300, avg_ms: HOSTILE } },
      ...Array.from({ length: 40 }, () => ({ task: "letter", period: { calls: 1, in: 1, out: 1 } })),
    ] } });
    expect(html).not.toMatch(/<script|<img|onerror/);
    expect(html).toContain("Job ratings");
    expect(html).toContain('0 <span class="muted">/ 3</span></td><td>900</td><td>300</td>');
    expect(html).toContain("over the last 7 days");
    expect(html.match(/Cover letters/g)).toHaveLength(17);
  });
});

describe("a cover letter's length and tone", () => {
  it("are only ever one of the fixed choices", () => {
    for (const bad of [HOSTILE, "short\nfresh", "__proto__", "constructor", "hasOwnProperty", "SHORT", " warm", "long"]) {
      expect(letterStyle(new URLSearchParams({ len: bad, tone: bad }))).toEqual({});
    }
    expect(letterStyle(null)).toEqual({});
    expect(styleLabel({ len: HOSTILE, tone: "warm" })).toBe("warm");
  });

  it("cannot change anything else about the request they ride on", async () => {
    const env = testEnv();
    await requestDoc(env, { profile: "sam-lee", j: "https://jobs.example.com/1", kind: "cover_letter", title: "Data Engineer",
      style: { len: "short", tone: "formal", a: "unsubscribe", u: "owner", id: "event:owner:x", send: 1, r: HOSTILE } });
    const [event] = valuesWith(env, "event:sam-lee:");
    expect(event).toMatchObject({ a: "cover_letter", u: "sam-lee", r: "", len: "short", tone: "formal" });
    expect(event.send).toBeUndefined();
    expect(event.id).toMatch(/^event:sam-lee:dash-[0-9a-f]{20}:cglstf\d+$/);
  });
});

describe("the shared stylesheet", () => {
  it("is linked from this Worker only, and public pages still run no script", async () => {
    const res = await worker.fetch(new Request(`${BASE}/join?i=${"0".repeat(32)}`), testEnv());
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp.match(/style-src[^;]*/g)).toEqual(["style-src 'self' 'unsafe-inline'"]);
    expect(csp).not.toContain("script-src");
    const links = [...(await res.text()).matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(/^\/app\.css\?v=[0-9a-f]{8}$/);
  });

  it("holds no script, import or outside address", async () => {
    const css = await (await worker.fetch(new Request(`${BASE}/app.css`), testEnv())).text();
    expect(css.length).toBeGreaterThan(1000);
    expect(css).not.toMatch(/<\/?script|@import|expression\(|url\((?!#)|https?:/i);
  });
});

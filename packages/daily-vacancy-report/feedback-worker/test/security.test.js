// Security properties of the feedback Worker: headers, escaping, authentication, CSRF and size limits.
import { describe, expect, it } from "vitest";
import worker, { sign } from "../src/index.js";
import { today } from "../src/lib.js";
import { BASE, memoryHub, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const HOSTILE = `<script>alert(1)</script>"'><img src=x onerror=alert(2)>`;

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
      }
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
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
  });

  it("never echoes or queues a hostile country, whether reported or posted", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "owner", owner: true, name: "Alex Morgan",
      email: "alex@example.com", job: { country: HOSTILE, titles: [], places: [] } }] }));
    const cookie = await signIn(env, "203.0.113.8");
    const body = await (await get("/admin/profile?u=owner", env, { Cookie: cookie })).text();
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
    expect(body).toContain('<option value="">Any country</option>');
    expect(body.match(/<select id="country"[\s\S]*?<\/select>/)[0]).not.toContain("selected");
    const csrf = body.match(/name="csrf" value="([0-9a-f]+)"/)[1];
    await worker.fetch(new Request(`${BASE}/admin/action`, { method: "POST", headers: { Cookie: cookie },
      body: new URLSearchParams({ csrf, action: "profile", u: "owner", name: "Alex Morgan", email: "alex@example.com",
        country: HOSTILE, level: "any", types: "Permanent", modes: "Remote" }) }), env);
    expect(valuesWith(env, "queue:").map((i) => i.job?.country)).not.toContain(HOSTILE);
    expect(JSON.stringify(valuesWith(env, "queue:"))).not.toContain("<script>");
  });

  it("never trusts or echoes a tampered form base", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "owner", owner: true, name: "Alex Morgan",
      email: "alex@example.com" }] }));
    const cookie = await signIn(env, "203.0.113.6");
    const page = await (await get("/admin/profile?u=owner", env, { Cookie: cookie })).text();
    const csrf = page.match(/name="csrf" value="([0-9a-f]+)"/)[1];
    for (const base of [JSON.stringify({ name: HOSTILE, email: HOSTILE, titles: [HOSTILE], level: HOSTILE, country: HOSTILE }),
      "not json", '["array"]', JSON.stringify({ __proto__: { polluted: true } })]) {
      const res = await worker.fetch(new Request(`${BASE}/admin/action`, { method: "POST", headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf, action: "profile", u: "owner", base, name: HOSTILE, email: "nope" }) }), env);
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
      expect(res.headers.get("Content-Security-Policy")).not.toContain("script-src");
      const body = await res.text();
      expect(body, r).not.toContain("<script>");
      expect(body, r).not.toContain("<img src=x");
    }
    expect((await get("/admin/stats?u=..%2Fowner", env, { Cookie: cookie })).status).toBe(404);
    const big = await worker.fetch(new Request(`${BASE}/api/stats`, {
      method: "POST", headers: { ...api, "Content-Length": "5000000" }, body: "{}" }), env);
    expect(big.status).toBe(413);
  });

  it("only queues a crawler key from the modal with a session and its CSRF token, and never shows it back", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [
      { id: "sam-lee", name: HOSTILE, has_cv: true, crawler: "own", provider: HOSTILE, key_hint: HOSTILE },
      { id: "jordan-patel", name: "Jordan Patel", has_cv: true, crawler: "own", provider: "tavily", key_hint: HOSTILE },
      { id: "../x", name: "Bad id", has_cv: true, provider: "", key_hint: "" }] }));
    const secret = "tvly-never-shown-back-0001";
    const noSession = await worker.fetch(new Request(`${BASE}/admin/action`, {
      method: "POST", body: new URLSearchParams({ action: "set_key", u: "sam-lee", key: secret, provider: "tavily" }) }), env);
    expect(await noSession.text()).toContain("Admin sign-in");
    const cookie = await signIn(env, "203.0.113.7");
    const dash = await (await get("/admin", env, { Cookie: cookie })).text();
    expect(dash).not.toContain("<script>");
    expect(dash).not.toContain("<img src=x");
    expect(dash).not.toContain('id="key-../x"');
    const csrf = dash.match(/name="csrf" value="([0-9a-f]+)"/)[1];
    const send = (fields) => worker.fetch(new Request(`${BASE}/admin/action`, { method: "POST", headers: { Cookie: cookie },
      body: new URLSearchParams(fields) }), env);
    expect((await send({ csrf: "0".repeat(32), action: "set_key", u: "sam-lee", key: secret, provider: "tavily" })).status).toBe(403);
    for (const provider of ["scrapfly", "PATH", HOSTILE, "firecrawl_backup"]) {
      expect((await send({ csrf, action: "set_key", u: "sam-lee", key: secret, provider })).headers.get("Location")).toBe("/admin?done=badkey");
    }
    expect(valuesWith(env, "queue:")).toEqual([]);
    const done = await send({ csrf, action: "set_key", u: "sam-lee", key: secret, provider: "tavily" });
    expect(done.headers.get("Location")).toBe("/admin?done=queued");
    const after = await (await get("/admin?done=queued", env, { Cookie: cookie })).text();
    expect(after).not.toContain(secret);
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
      expect(res.headers.get("Content-Security-Policy")).not.toContain("script-src");
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

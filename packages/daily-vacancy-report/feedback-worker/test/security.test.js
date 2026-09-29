// Security properties of the feedback Worker: headers, escaping, authentication, CSRF and size limits.
import { describe, expect, it } from "vitest";
import worker, { sign } from "../src/index.js";
import { today } from "../src/lib.js";
import { BASE, testEnv, valuesWith } from "./helpers.js";

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
});

describe("authentication", () => {
  it("keeps every Hermes API route behind the token", async () => {
    const env = testEnv();
    const routes = [["GET", "/events"], ["POST", "/ack"], ["GET", "/api/queue"], ["POST", "/api/queue/ack"],
      ["GET", "/api/file?key=cvfile:1"], ["POST", "/api/status"], ["POST", "/api/invite"]];
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

  it("keeps the settings pages, including email and key forms, behind a session", async () => {
    const env = testEnv(ADMIN);
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "owner", owner: true, name: "Alex Morgan" }],
      email: { user: "alex@example.com", password_set: true } }));
    for (const path of ["/admin/profile?u=owner"]) {
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

  it("rejects an oversized Hermes status report", async () => {
    const env = testEnv();
    const res = await worker.fetch(new Request(`${BASE}/api/status`, {
      method: "POST", headers: { Authorization: "Bearer api-token", "Content-Length": "5000000" }, body: "{}" }), env);
    expect(res.status).toBe(413);
  });
});

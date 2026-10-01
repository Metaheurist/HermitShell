import { describe, expect, it } from "vitest";
import { ENHANCE_URL, enhance } from "../src/enhance.js";
import worker from "../src/index.js";
import { BASE, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

async function signedIn(env) {
  const res = await worker.fetch(post("/admin/login", { username: "admin", password: ADMIN.ADMIN_PASSWORD }, { "CF-Connecting-IP": "203.0.113.9" }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = (path) => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
  const csrf = (await (await get("/admin")).text()).match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const send = (path, fields) => worker.fetch(post(path, { csrf, ...fields }, { Cookie: cookie }), env);
  return { get, send };
}

describe("the dashboard script", () => {
  it("is one file, kept by browsers for a year, under an address that changes with it", async () => {
    const res = await worker.fetch(new Request(`${BASE}${ENHANCE_URL}`), testEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(ENHANCE_URL).toMatch(/^\/enhance\.js\?v=[0-9a-f]{8}$/);
    const source = await res.text();
    expect(source).not.toMatch(/eval|innerHTML|document\.write|Function\(/);
  });

  it("goes on signed-in pages only, with the refresh kept for browsers without scripts", async () => {
    const env = testEnv(ADMIN);
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API,
      body: JSON.stringify({ profiles: [{ id: "sam-lee", name: "<script>alert(1)</script>", email: "sam@example.com", status: "active", has_cv: true }] }) }), env);
    const a = await signedIn(env);
    await a.send("/admin/action", { action: "pause", u: "sam-lee" });
    const html = await (await a.get("/admin?done=queued")).text();
    expect(html).toMatch(/<noscript><meta http-equiv="refresh" content="4"><\/noscript><meta name="hs-refresh" content="4">/);
    expect(html.match(/<script/g)).toEqual(["<script"]);
    expect(html).toContain(`<script src="${ENHANCE_URL}" defer></script></body>`);
    expect(html).not.toContain("<script>alert");
    for (const path of ["/privacy", "/join?i=bad", "/f?j=x&a=applied&n=x&d=1&t=0", "/admin/tasks"]) {
      const res = path === "/admin/tasks" ? await a.get(path) : await worker.fetch(new Request(`${BASE}${path}`), env);
      expect(await res.text(), path).not.toContain("<script");
      expect(res.headers.get("Content-Security-Policy") || "", path).not.toContain("script-src");
    }
  });

  it("swaps a waiting page's card at once, only when it changed, without replaying entrances", async () => {
    const source = await (await worker.fetch(new Request(`${BASE}${ENHANCE_URL}`), testEnv())).text();
    expect(source).not.toContain("startViewTransition");
    expect(source).toContain("if (!next.isEqualNode(now))");
    expect(source).toMatch(/getAnimations\(\{ subtree: true \}\)\) if \(a\.effect && a\.effect\.getTiming\(\)\.iterations !== Infinity\) a\.finish\(\)/);
  });

  it("leaves the sign-in page without it", async () => {
    const res = await worker.fetch(new Request(`${BASE}/admin`), testEnv(ADMIN));
    expect(await res.text()).not.toContain("<script");
  });

  it("moves only the first refresh into <noscript> and adds the script once", () => {
    const html = enhance('<html><head><meta http-equiv="refresh" content="20;url=/admin/settings?w=1#keys"></head><body><main></main></body></html>');
    expect(html).toContain('<noscript><meta http-equiv="refresh" content="20;url=/admin/settings?w=1#keys"></noscript><meta name="hs-refresh" content="20;url=/admin/settings?w=1#keys">');
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(enhance("<body></body>")).not.toContain("hs-refresh");
  });
});

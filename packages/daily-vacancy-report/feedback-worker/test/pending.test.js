import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { queueItem } from "../src/join.js";
import { BASE, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const OWNER = { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false, recruit: "" };
const SIGNUP = { type: "signup", invite: "abc", name: "Riley Chen", email: "Riley.Chen@example.com", location: "Manchester",
  roles: "Data analyst or BI developer, hybrid", cv: "cvfile:1", phone: "07700 900456" };

async function setup(profiles = [OWNER]) {
  const env = testEnv(ADMIN);
  const report = (list) => worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles: list }) }), env);
  await report(profiles);
  const res = await worker.fetch(new Request(`${BASE}/admin/login`, { method: "POST",
    body: new URLSearchParams({ username: "admin", password: ADMIN.ADMIN_PASSWORD }), headers: { "CF-Connecting-IP": "203.0.113.9" } }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = async (query = "") => (await worker.fetch(new Request(`${BASE}/admin${query}`, { headers: { Cookie: cookie } }), env)).text();
  return { env, get, report };
}

describe("pending sign-ups", () => {
  it("shows a queued sign-up as a pending row, not only as waiting text", async () => {
    const { env, get } = await setup();
    await queueItem(env, SIGNUP);
    const body = await get();
    const row = body.split("<tr").find((r) => r.includes('class="pendingrow"'));
    expect(row).toContain("<b>Riley Chen</b>");
    expect(row).toContain("Riley.Chen@example.com");
    expect(row).toContain('<span class="pill pending">pending</span>');
    expect(row).toContain("looking for Data analyst or BI developer, hybrid");
    expect(row).toContain("Signed up");
    expect(row).not.toContain("07700");
    expect(row).not.toContain("cvfile");
    expect(row).not.toContain(">Send jobs<");
    expect(body).not.toContain("Sign-up from Riley Chen");
    expect(body).toContain('<span class="count">1 recruit</span>');
    expect(body).not.toContain("/admin/profile?u=owner");
    expect(body).not.toContain('id="key-"');
  });

  it("sweeps one shine across the whole row, not a separate one in each cell", async () => {
    const { env, get } = await setup();
    await queueItem(env, SIGNUP);
    const body = await get();
    expect(body).toMatch(/tr\.pendingrow\{background:linear-gradient\([^}]*animation:sweep/);
    expect(body).not.toMatch(/tr\.pendingrow td\{[^}]*animation/);
  });

  it("keeps the row until HermitShell reports the profile, then shows the profile instead", async () => {
    const { env, get, report } = await setup();
    await queueItem(env, SIGNUP);
    await report([OWNER, { id: "riley-chen-1a2b3c", name: "Riley Chen", email: "riley.chen@example.com", status: "active", has_cv: true }]);
    const body = await get();
    expect(body).not.toContain('class="pendingrow"');
    expect(body.match(/<b>Riley Chen<\/b>/g)).toHaveLength(1);
    expect(body).toContain("/admin/profile?u=riley-chen-1a2b3c");
  });

  it("can be found with the search by name, or with Pending sign-up from the status dropdown", async () => {
    const { env, get } = await setup();
    await queueItem(env, SIGNUP);
    const pending = await get("?s=pending");
    expect(pending).toContain('class="pendingrow"');
    expect(pending).toContain('<span class="count">1 of ');
    expect(await get("?q=pending")).not.toContain('class="pendingrow"');
    expect(await get("?s=active")).not.toContain('class="pendingrow"');
    expect(await get("?q=riley")).toContain('class="pendingrow"');
    expect(await get("?q=alex")).not.toContain('class="pendingrow"');
  });

  it("escapes what the sign-up form sent", async () => {
    const { env, get } = await setup();
    await queueItem(env, { ...SIGNUP, name: "<script>alert(1)</script>", email: '"><img src=x>', roles: "<b>x</b>" });
    const body = await get();
    expect(body).not.toContain("<script>alert");
    expect(body).not.toContain("<img src=x");
    expect(body).not.toContain("<b>x</b>");
  });
});

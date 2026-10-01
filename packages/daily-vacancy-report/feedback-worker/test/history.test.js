import { describe, expect, it } from "vitest";
import worker, { sign } from "../src/index.js";
import { jobHash } from "../src/docs.js";
import { MAX_MONTH, historyKey, listed, record } from "../src/history.js";
import { today } from "../src/lib.js";
import { BASE, keysWith, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const CASEY_PASSWORD = "a long enough passphrase";
const PROFILES = [
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true, recruiter: "casey",
    created: Date.UTC(2026, 8, 18), last_run: Date.UTC(2026, 8, 29, 8), cv_updated: Date.UTC(2026, 8, 18) },
  { id: "jordan-patel", name: "Jordan Patel", email: "jordan@contoso.example", status: "active", has_cv: true },
  { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false, recruit: "" },
];
// HermitShell has moved the admin's own job search to Riley Chen, a recruit like any other.
const MOVED = [...PROFILES.map((p) => (p.owner ? { ...p, recruit: "riley-chen" } : p)),
  { id: "riley-chen", name: "Riley Chen", email: "riley@example.com", status: "active", has_cv: true }];

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

function report(env, profiles) {
  return worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles }) }), env);
}

async function signIn(env, username, password, ip) {
  const res = await worker.fetch(post("/admin/login", { username, password }, { "CF-Connecting-IP": ip }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = (path) => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
  const text = async (path) => (await get(path)).text();
  const csrf = async () => (await text("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const send = async (path, fields) => worker.fetch(post(path, { csrf: await csrf(), ...fields }, { Cookie: cookie }), env);
  const act = (fields) => send("/admin/action", fields);
  return { get, text, send, act };
}

// The main admin signed in, with Casey Quinn as a recruiter who has Sam Lee.
async function withCasey() {
  const env = testEnv(ADMIN);
  await report(env, PROFILES);
  const admin = await signIn(env, "admin", ADMIN.ADMIN_PASSWORD, "203.0.113.9");
  await admin.send("/admin/users", { op: "add", name: "Casey Quinn", username: "casey", password: CASEY_PASSWORD, roles: "recruiter" });
  return { env, admin, casey: await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.10") };
}

const setup = withCasey;

async function answer(env, action, title, profile = "") {
  const d = String(today());
  const t = await sign("test-secret", "nijobs:123", action, title, "", profile, d);
  return worker.fetch(post("/f", { j: "nijobs:123", a: action, n: title, ...(profile ? { u: profile } : {}), d, t, r: "" }), env);
}

// HermitShell has made the document and sent it to be kept for download.
function keep(env, u, j, k) {
  const q = new URLSearchParams({ u, j, k, days: "7", name: `${k} - Sam Lee` });
  return worker.fetch(new Request(`${BASE}/api/doc?${q}`, { method: "POST", headers: { ...API, "Content-Type": "application/pdf" },
    body: "%PDF-1.4\n%%EOF" }), env);
}

const downloads = (body) => [...body.matchAll(/<a class="hdl" href="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));

describe("a recruit's history", () => {
  it("records dashboard actions with who did them, newest first", async () => {
    const { env, admin, casey } = await withCasey();
    await admin.act({ action: "pause", u: "sam-lee" });
    await admin.act({ action: "resume", u: "sam-lee" });
    await admin.act({ action: "assign", u: "jordan-patel", recruiter: "casey" });
    await casey.act({ action: "send_now", u: "sam-lee" });
    const body = await admin.text("/admin/history?u=sam-lee");
    expect(body).toContain('<nav class="tabs" aria-label="Recruit pages"><a href="/admin/profile?u=sam-lee">Manage</a><a href="/admin/pipeline?u=sam-lee">Pipeline</a><a href="/admin/history?u=sam-lee" class="on" aria-current="page">History</a></nav>');
    expect(body).not.toContain("Global settings");
    expect(body).not.toContain("Users and roles");
    expect(body).toContain("<b>Asked for jobs now</b>");
    expect(body).toMatch(/Asked for jobs now<\/b>\s*<small[^>]*>\d\d:\d\d &middot; by Casey Quinn<\/small>/);
    expect(body).toMatch(/Paused reports<\/b>\s*<small[^>]*>\d\d:\d\d &middot; by Alex Morgan<\/small>/);
    expect(body.indexOf("Asked for jobs now")).toBeLessThan(body.indexOf("Resumed reports"));
    expect(body.indexOf("Resumed reports")).toBeLessThan(body.indexOf("Paused reports"));
    expect(body).not.toContain("Assigned to Casey Quinn");
    expect(await admin.text("/admin/history?u=jordan-patel")).toContain("<b>Assigned to Casey Quinn</b>");
    expect(keysWith(env, "history:").sort()).toEqual([historyKey("jordan-patel", Date.now()), historyKey("sam-lee", Date.now())]);
  });

  it("shows a recruiter only their own recruits' history", async () => {
    const { casey } = await withCasey();
    expect((await casey.get("/admin/history?u=sam-lee")).status).toBe(200);
    expect((await casey.get("/admin/history?u=jordan-patel")).status).toBe(404);
    expect((await casey.get("/admin/history?u=Not%20valid")).status).toBe(404);
  });

  it("records answers from email buttons once, and an old report of the admin's under the recruit it moved to", async () => {
    const { env, admin } = await setup();
    await report(env, MOVED);
    await answer(env, "applied", "Data Engineer at Northwind", "sam-lee");
    await answer(env, "applied", "Data Engineer at Northwind", "sam-lee");
    await answer(env, "cover_letter", "BI Developer at Contoso", "sam-lee");
    await answer(env, "interested", "Analyst at Fabrikam");
    const body = await admin.text("/admin/history?u=sam-lee");
    expect(body.match(/Answered Applied: Data Engineer at Northwind/g)).toHaveLength(1);
    expect(body).toMatch(/Answered Applied: Data Engineer at Northwind<\/b>\s*<small[^>]*>\d\d:\d\d &middot; from an email button<\/small>/);
    expect(body).toContain("<b>Asked for a cover letter: BI Developer at Contoso</b>");
    expect(await admin.text("/admin/history?u=riley-chen")).toContain("<b>Answered Interested: Analyst at Fabrikam</b>");
    expect((await admin.get("/admin/history?u=owner")).status).toBe(404);
    expect(keysWith(env, "history:owner:")).toEqual([]);
    expect(keysWith(env, "event:riley-chen:")).toHaveLength(1);
    expect(keysWith(env, "event:_:")).toEqual([]);
    expect(env.FEEDBACK.store.has("flag:events:riley-chen")).toBe(true);
  });

  it("moves what was kept for the admin to the recruit their job search moved to, once", async () => {
    const { env, admin } = await setup();
    await answer(env, "interested", "Analyst at Fabrikam");
    expect(keysWith(env, "history:owner:")).toHaveLength(1);
    await record(env, "riley-chen", "send", "Asked for jobs now", { by: "Alex Morgan", at: Date.now() - 1000 });
    await report(env, MOVED.map((p) => (p.owner ? { ...p, recruit: "../x" } : p)));
    expect(keysWith(env, "history:owner:")).toHaveLength(1);
    await report(env, MOVED);
    expect(keysWith(env, "history:owner:")).toEqual([]);
    const body = await admin.text("/admin/history?u=riley-chen");
    expect(body).toContain("<b>Answered Interested: Analyst at Fabrikam</b>");
    expect(body.indexOf("Answered Interested")).toBeLessThan(body.indexOf("Asked for jobs now"));
    await record(env, "owner", "send", "Asked for jobs now");
    await report(env, MOVED);
    expect(keysWith(env, "history:owner:")).toHaveLength(1);
  });

  it("records the reports HermitShell ran and the CVs it read, once each", async () => {
    const { env, admin } = await setup();
    const ran = Date.UTC(2026, 8, 30, 8, 15);
    const later = PROFILES.map((p) => (p.id === "sam-lee" ? { ...p, last_run: ran, cv_updated: ran - 60000 } : p));
    await report(env, later);
    await report(env, later);
    const body = await admin.text("/admin/history?u=sam-lee&m=2026-09");
    expect(body.match(/<b>Job report ran<\/b>/g)).toHaveLength(1);
    expect(body.match(/Read the new CV/g)).toHaveLength(1);
    expect(body).toMatch(/Job report ran<\/b>\s*<small title="2026-09-30 08:15 UTC">08:15 &middot; HermitShell<\/small>/);
    expect(body).toContain('<div class="hday">Wed 30 Sep</div>');
  });

  it("switches between months, newest first, and ignores a month that isn't there", async () => {
    const { env, admin } = await setup();
    await record(env, "sam-lee", "pause", "Paused reports", { by: "Alex Morgan", at: Date.UTC(2026, 7, 20, 10) });
    await record(env, "sam-lee", "resume", "Resumed reports", { by: "Alex Morgan", at: Date.UTC(2026, 8, 2, 10) });
    const newest = await admin.text("/admin/history?u=sam-lee");
    expect(newest).toContain('<nav class="hmonths" aria-label="Month"><a href="/admin/history?u=sam-lee&amp;m=2026-09" class="on" aria-current="page">September 2026</a><a href="/admin/history?u=sam-lee&amp;m=2026-08">August 2026</a></nav>');
    expect(newest).toContain("Resumed reports");
    expect(newest).not.toContain("Paused reports");
    expect(newest).not.toContain("Joined HermitShell");
    const august = await admin.text("/admin/history?u=sam-lee&m=2026-08");
    expect(august).toContain("Paused reports");
    expect(august).toContain('<p class="hstart">Joined HermitShell on 2026-09-18.</p>');
    expect(await admin.text("/admin/history?u=sam-lee&m=1999-01")).toContain("Resumed reports");
  });

  it("says when nothing has been recorded yet", async () => {
    const { admin } = await setup();
    const body = await admin.text("/admin/history?u=jordan-patel");
    expect(body).toContain("Nothing recorded yet.");
    expect(body).not.toContain('class="hmonths"');
  });

  it("is deleted with the recruit, whether they unsubscribe or an admin deletes them", async () => {
    const { env, admin } = await setup();
    await admin.act({ action: "pause", u: "sam-lee" });
    await admin.act({ action: "pause", u: "jordan-patel" });
    await record(env, "sam-lee", "resume", "Resumed reports", { at: Date.UTC(2026, 0, 5) });
    expect(keysWith(env, "history:sam-lee:")).toHaveLength(2);
    await answer(env, "unsubscribe", "Sam Lee", "sam-lee");
    expect(keysWith(env, "history:sam-lee:")).toEqual([]);
    await admin.act({ action: "delete", u: "jordan-patel", confirm: "yes" });
    expect(keysWith(env, "history:jordan-patel:")).toEqual([]);
  });

  it("offers a letter or CV asked for from the dashboard for download while it is kept", async () => {
    const { env, casey } = await withCasey();
    await casey.send("/admin/doc", { u: "sam-lee", j: "nijobs:9", k: "tailored_cv", n: "Data Analyst at Litware" });
    await casey.send("/admin/doc", { u: "sam-lee", j: "nijobs:9", k: "send_job", n: "Data Analyst at Litware" });
    await casey.act({ action: "send_now", u: "sam-lee" });
    expect(downloads(await casey.text("/admin/history?u=sam-lee"))).toEqual([]);
    await keep(env, "sam-lee", "nijobs:9", "tailored_cv");
    const body = await casey.text("/admin/history?u=sam-lee");
    const path = `/admin/doc?u=sam-lee&k=tailored_cv&h=${await jobHash("nijobs:9")}`;
    expect(downloads(body)).toEqual([path]);
    expect(body).toMatch(/Asked for a tailored CV: Data Analyst at Litware<\/b>[\s\S]*?<\/div><a class="hdl"[^>]*download[^>]*aria-label="Download the tailored CV">/);
    const res = await casey.get(path);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("offers a letter asked for from an email button once HermitShell has made it", async () => {
    const { env, admin } = await setup();
    await answer(env, "cover_letter", "BI Developer at Contoso", "sam-lee");
    await keep(env, "sam-lee", "nijobs:123", "cover_letter");
    await keep(env, "sam-lee", "nijobs:123", "tailored_cv");
    expect(downloads(await admin.text("/admin/history?u=sam-lee"))).toEqual([`/admin/doc?u=sam-lee&k=cover_letter&h=${await jobHash("nijobs:123")}`]);
  });

  it("has no Download button for an entry recorded without its job, or a job with nothing kept", async () => {
    const { env, admin } = await setup();
    await record(env, "sam-lee", "tailored_cv", "Asked for a tailored CV: Data Analyst at Litware");
    await keep(env, "sam-lee", "nijobs:9", "tailored_cv");
    expect(downloads(await admin.text("/admin/history?u=sam-lee"))).toEqual([]);
    await record(env, "sam-lee", "tailored_cv", "Asked for a tailored CV: BI Developer at Fabrikam", { h: await jobHash("nijobs:77") });
    expect(downloads(await admin.text("/admin/history?u=sam-lee"))).toEqual([]);
  });

  it("reads the kept documents only when an entry could have one", async () => {
    const { env, admin } = await setup();
    await admin.act({ action: "pause", u: "sam-lee" });
    const reads = [];
    const get = env.FEEDBACK.get.bind(env.FEEDBACK);
    env.FEEDBACK.get = (key, ...rest) => (reads.push(key), get(key, ...rest));
    await admin.text("/admin/history?u=sam-lee");
    expect(reads).not.toContain("docs:sam-lee");
  });

  it("is linked from the recruit's stats and jobs sent pages", async () => {
    const { admin } = await setup();
    for (const path of ["/admin/stats?u=sam-lee", "/admin/sent?u=sam-lee&r=7"]) {
      expect(await admin.text(path)).toContain('<a class="small" href="/admin/history?u=sam-lee">History</a>');
    }
  });
});

describe("recording", () => {
  it("keeps the newest entries of a month and ignores unknown kinds and profiles", async () => {
    const env = testEnv();
    const at = Date.UTC(2026, 8, 1);
    const key = historyKey("sam-lee", at);
    await env.FEEDBACK.put(key, JSON.stringify(Array.from({ length: MAX_MONTH }, (_, i) => ({ at: at + i, k: "send", t: `old ${i}`, v: "dashboard" }))));
    await record(env, "sam-lee", "send", "newest", { at: at + MAX_MONTH });
    const rows = JSON.parse(env.FEEDBACK.store.get(key));
    expect(rows).toHaveLength(MAX_MONTH);
    expect(rows[0].t).toBe("old 1");
    expect(rows.at(-1)).toEqual({ at: at + MAX_MONTH, k: "send", t: "newest", v: "dashboard" });
    await record(env, "sam-lee", "format_disk", "no");
    await record(env, "../owner", "send", "no");
    await record(env, "sam-lee", "send", "   ");
    expect(keysWith(env, "history:")).toEqual([key]);
  });

  it("joins lists like a sentence", () => {
    expect(listed([])).toBe("");
    expect(listed(["Name"])).toBe("Name");
    expect(listed(["Name", "Phone"])).toBe("Name and Phone");
    expect(listed(["Name", "Phone", "Towns"])).toBe("Name, Phone and Towns");
  });
});

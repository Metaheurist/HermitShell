// A recruit's own CV on their profile page: Generate asks HermitShell for it, POST /api/cv keeps it, and CV
// downloads it until the next one replaces it or the recruit unsubscribes or is deleted.
import { describe, expect, it } from "vitest";
import worker, { sign } from "../src/index.js";
import { PROFILE_CV_STYLE } from "../src/docs.js";
import { today } from "../src/lib.js";
import { BASE, keysWith, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const CASEY_PASSWORD = "a long enough passphrase";
const PDF = "%PDF-1.4\nSam Lee, Data Engineer at Northwind\n%%EOF";
const PROFILES = [
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true, recruiter: "casey" },
  { id: "jordan-patel", name: "Jordan Patel", email: "jordan@contoso.example", status: "active", has_cv: true },
  { id: "riley-chen", name: "Riley Chen", email: "riley@example.com", status: "active", has_cv: false },
  { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false, recruit: "" },
];

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

function report(env, extra = {}) {
  return worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles: PROFILES, ...extra }) }), env);
}

function keep(env, { u = "sam-lee", name = "CV - Sam Lee.pdf" } = {}, body = PDF, headers = API) {
  return worker.fetch(new Request(`${BASE}/api/cv?${new URLSearchParams({ u, name })}`, { method: "POST",
    headers: { ...headers, "Content-Type": "application/pdf" }, body }), env);
}

async function signIn(env, username, password, ip) {
  const res = await worker.fetch(post("/admin/login", { username, password }, { "CF-Connecting-IP": ip }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = (path) => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
  const text = async (path) => (await get(path)).text();
  const csrf = async () => (await text("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const send = async (path, fields) => worker.fetch(post(path, { csrf: await csrf(), ...fields }, { Cookie: cookie }), env);
  return { get, text, send, act: (fields) => send("/admin/action", fields) };
}

async function setup() {
  const env = testEnv(ADMIN);
  await report(env);
  const admin = await signIn(env, "admin", ADMIN.ADMIN_PASSWORD, "203.0.113.9");
  await admin.send("/admin/users", { op: "add", name: "Casey Quinn", username: "casey", password: CASEY_PASSWORD, roles: "recruiter" });
  return { env, admin, casey: await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.10") };
}

const buttons = (body) => body.match(/<div class="pcv">[\s\S]*?<\/div>/)?.[0] || "";

describe("a recruit's own CV from HermitShell", () => {
  it("is kept encrypted with no expiry, replaced by the next one, and downloaded as the PDF it was", async () => {
    const { env, admin } = await setup();
    const ttls = [];
    const put = env.FEEDBACK.put.bind(env.FEEDBACK);
    env.FEEDBACK.put = (key, value, options) => { if (key.startsWith("cvpdf")) ttls.push(options?.expirationTtl); return put(key, value, options); };
    expect((await keep(env, { name: "First.pdf" })).status).toBe(200);
    expect((await keep(env)).status).toBe(200);
    expect(ttls).toEqual([undefined, undefined, undefined, undefined]);
    expect(new TextDecoder().decode(new Uint8Array(env.FEEDBACK.store.get("cvpdf:sam-lee")))).not.toContain("Northwind");
    expect(JSON.parse(env.FEEDBACK.store.get("cvpdfinfo:sam-lee")).name).toBe("CV - Sam Lee.pdf");
    const res = await admin.get("/admin/cvpdf?u=sam-lee");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain('attachment; filename="CV - Sam Lee.pdf"');
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.text()).toBe(PDF);
  });

  it("is refused without the API token, for a bad profile, when it is not a PDF or when it is too large", async () => {
    const env = testEnv(ADMIN);
    expect((await keep(env, {}, PDF, {})).status).toBe(401);
    expect((await keep(env, { u: "Not valid" })).status).toBe(400);
    expect((await keep(env, {}, "<html>not a pdf</html>")).status).toBe(400);
    expect((await keep(env, {}, `%PDF-${"x".repeat(2 * 1024 * 1024)}`)).status).toBe(413);
    expect(keysWith(env, "cvpdf")).toEqual([]);
  });

  it("does not open under another recruit's key", async () => {
    const { env, admin } = await setup();
    await keep(env);
    env.FEEDBACK.store.set("cvpdf:jordan-patel", env.FEEDBACK.store.get("cvpdf:sam-lee"));
    env.FEEDBACK.store.set("cvpdfinfo:jordan-patel", env.FEEDBACK.store.get("cvpdfinfo:sam-lee"));
    const res = await admin.get("/admin/cvpdf?u=jordan-patel");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/profile?u=jordan-patel&done=cvgone");
  });

  it("is deleted with the recruit, whether they unsubscribe or an admin deletes them", async () => {
    const { env, admin } = await setup();
    await keep(env);
    await keep(env, { u: "jordan-patel" });
    const d = String(today());
    const t = await sign("test-secret", "profile", "unsubscribe", "Sam Lee", "", "sam-lee", d);
    await worker.fetch(post("/f", { j: "profile", a: "unsubscribe", n: "Sam Lee", u: "sam-lee", d, t, r: "" }), env);
    expect(keysWith(env, "cvpdf:sam-lee")).toEqual([]);
    expect(keysWith(env, "cvpdfinfo:sam-lee")).toEqual([]);
    await admin.act({ action: "delete", u: "jordan-patel", confirm: "yes" });
    expect(keysWith(env, "cvpdf")).toEqual([]);
  });
});

describe("the profile page's CV and Generate buttons", () => {
  it("show only Generate until a CV has been made, then CV to download it beside Generate", async () => {
    const { env, admin } = await setup();
    let pcv = buttons(await admin.text("/admin/profile?u=sam-lee"));
    expect(pcv).toContain('action="/admin/cvpdf"');
    expect(pcv).toMatch(/<svg[^>]*>[\s\S]*?<\/svg>Generate<\/button>/);
    expect(pcv).not.toContain('class="pcvbtn dl"');
    await keep(env);
    pcv = buttons(await admin.text("/admin/profile?u=sam-lee"));
    expect(pcv).toMatch(/<a class="pcvbtn dl" href="\/admin\/cvpdf\?u=sam-lee" download title="Download their CV, made just now"><svg[^>]*><path d="M12 4v11/);
    expect(pcv).toMatch(/>CV<\/a>/);
    expect(pcv).toContain("Generate</button>");
  });

  it("turn Generate off until a CV is uploaded", async () => {
    const { admin } = await setup();
    expect(buttons(await admin.text("/admin/profile?u=riley-chen"))).toMatch(/<button class="pcvbtn" disabled title="Upload a CV first">/);
    const res = await admin.send("/admin/cvpdf", { u: "riley-chen" });
    expect(res.headers.get("Location")).toBe("/admin/profile?u=riley-chen&done=cvnone");
  });

  it("asks HermitShell for the CV, once for a double press, and spins until it is made", async () => {
    const { env, admin } = await setup();
    const res = await admin.send("/admin/cvpdf", { u: "sam-lee" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/profile?u=sam-lee&done=cvmaking");
    await admin.send("/admin/cvpdf", { u: "sam-lee" });
    const events = valuesWith(env, "event:sam-lee:");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ j: "profile:cv", a: "profile_cv", r: "", u: "sam-lee", via: "dashboard", fresh: 1 });
    expect(events[0].id).toMatch(/^event:sam-lee:dash-cv:p\d+$/);
    expect(env.FEEDBACK.store.get("flag:events:sam-lee")).toMatch(/^\d{13}$/);
    expect(JSON.parse(env.FEEDBACK.store.get("tasks:requests"))).toEqual([expect.objectContaining({ id: events[0].id, a: "profile_cv", u: "sam-lee" })]);
    const body = await admin.text("/admin/profile?u=sam-lee&done=cvmaking");
    expect(buttons(body)).toContain('<span class="pcvbtn busy" role="status">');
    expect(buttons(body)).not.toContain("<form");
    expect(body).toContain("HermitShell is making their CV");
    expect(body).toMatch(/<meta name="hs-refresh" content="15;url=\/admin\/profile\?u=sam-lee">/);
    const tasks = await admin.text("/admin/tasks");
    expect(tasks).toContain("<b>CV</b>");
    expect(await admin.text("/admin/history?u=sam-lee")).toContain("Asked for their CV");
  });

  it("keep spinning while HermitShell makes it, and stop once it is kept", async () => {
    const { env, admin } = await setup();
    await report(env, { tasks: [{ id: "letter:sam-lee:event:sam-lee:dash-cv:p1", kind: "profile_cv", u: "sam-lee", state: "running", at: Date.now() }] });
    expect(buttons(await admin.text("/admin/profile?u=sam-lee"))).toContain("Generating&hellip;");
    expect(await admin.text("/admin/tasks")).toContain("Laying out the CV");
    await report(env, { tasks: [] });
    await keep(env);
    const body = await admin.text("/admin/profile?u=sam-lee");
    expect(buttons(body)).toContain(">CV</a>");
    expect(body).not.toContain('name="hs-refresh"');
  });

  it("are only for recruits the signed-in user can see, never the main admin, and need the form's token", async () => {
    const { env, admin, casey } = await setup();
    await keep(env, { u: "jordan-patel" });
    expect((await casey.get("/admin/cvpdf?u=jordan-patel")).status).toBe(404);
    expect((await casey.send("/admin/cvpdf", { u: "jordan-patel" })).status).toBe(404);
    expect((await admin.send("/admin/cvpdf", { u: "owner" })).status).toBe(404);
    expect((await admin.get("/admin/cvpdf?u=owner")).status).toBe(404);
    expect((await admin.send("/admin/cvpdf", { u: "Not valid" })).status).toBe(400);
    expect((await worker.fetch(post("/admin/cvpdf", { u: "sam-lee", csrf: "0".repeat(32) }), env)).status).not.toBe(303);
    expect((await casey.send("/admin/cvpdf", { u: "sam-lee" })).headers.get("Location")).toBe("/admin/profile?u=sam-lee&done=cvmaking");
    expect(keysWith(env, "event:jordan-patel:")).toEqual([]);
    expect(keysWith(env, "event:owner:")).toEqual([]);
    expect(keysWith(env, "event:_:")).toEqual([]);
  });

  it("move under the heading on a narrow screen", () => {
    expect(PROFILE_CV_STYLE).toMatch(/\.pcv\{position:absolute;top:28px;right:32px/);
    expect(PROFILE_CV_STYLE).toMatch(/@media \(max-width:640px\)\{\.pcv\{position:static/);
  });
});

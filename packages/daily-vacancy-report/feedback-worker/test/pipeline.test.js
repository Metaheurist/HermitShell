// The Pipeline: interview, offer and placed as answers, the board HermitShell sends with the jobs sent, moves made
// from the dashboard (POST /admin/stage) and placement details, with the fee for admins only and sealed.
import { describe, expect, it } from "vitest";
import worker, { sign } from "../src/index.js";
import { jobHash } from "../src/docs.js";
import { today } from "../src/lib.js";
import { stageMeta } from "../src/pipeline.js";
import { FIELDS, sentParts, splitStats, totals, validStats } from "../src/stats.js";
import { BASE, keysWith, sealingKeys, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const CASEY_PASSWORD = "a long enough passphrase";
const JOB = "https://jobs.example.com/1";
const PROFILES = [
  { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false, recruit: "" },
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true, recruiter: "casey", job: { currency: "EUR" } },
  { id: "jordan-patel", name: "Jordan Patel", email: "jordan@contoso.example", status: "active", has_cv: true },
];
const day = (ago = 0) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
const BOARD = [
  { key: JOB, title: "Data Engineer", employer: "Northwind", stage: "applied", day: day(2) },
  { key: "https://jobs.example.com/2", title: "Analyst", employer: "Contoso", stage: "interview", day: day(5) },
  { key: "https://jobs.example.com/3", title: "Consultant", employer: "Fabrikam", stage: "heard_back", day: day(9) },
  { key: "https://jobs.example.com/4", title: "Team Lead", employer: "Litware", stage: "placed", day: day(30) },
];

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

async function signIn(env, username, password, ip) {
  const res = await worker.fetch(post("/admin/login", { username, password }, { "CF-Connecting-IP": ip }), env);
  return (res.headers.get("Set-Cookie") || "").split(";")[0];
}

function client(env, cookie) {
  const get = (path) => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
  const text = async (path) => (await get(path)).text();
  const csrf = async () => (await text("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  const move = async (fields) => worker.fetch(post("/admin/stage", { csrf: await csrf(), u: "sam-lee", j: JOB, ...fields }, { Cookie: cookie }), env);
  return { get, text, csrf, move, cookie };
}

function api(env, path, body) {
  return worker.fetch(new Request(`${BASE}${path}`, { method: "POST", headers: API, body: JSON.stringify(body) }), env);
}

async function setup({ sealed = true } = {}) {
  const env = testEnv(ADMIN);
  const keys = await sealingKeys();
  await api(env, "/api/status", { profiles: PROFILES, ...(sealed ? keys.status : {}) });
  await api(env, "/api/stats", { u: "sam-lee", stats: { days: {}, sent: [{ title: "Data Engineer", day: day(2), fit: 8, key: JOB }], board: BOARD } });
  const cookie = await signIn(env, "admin", ADMIN.ADMIN_PASSWORD, "203.0.113.21");
  const admin = client(env, cookie);
  await worker.fetch(post("/admin/users", { csrf: await admin.csrf(), op: "add", name: "Casey Quinn", username: "casey", password: CASEY_PASSWORD,
    roles: "recruiter" }, { Cookie: cookie }), env);
  const casey = client(env, await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.23"));
  return { env, admin, casey, keys };
}

const stageEvents = (env) => valuesWith(env, "event:sam-lee:dash-st-");

describe("the board", () => {
  it("is kept with the jobs sent, not with the stats every dashboard load reads", async () => {
    const { env } = await setup();
    const stats = JSON.parse(env.FEEDBACK.store.get("stats:sam-lee"));
    expect(stats.board).toBeUndefined();
    const sent = JSON.parse(env.FEEDBACK.store.get("sent:sam-lee"));
    expect(sent.board).toEqual(BOARD);
    expect(sent.jobs[0].key).toBe(JOB);
    expect(sentParts([{ title: "x" }])).toEqual({ jobs: [{ title: "x" }], board: null });
    expect(sentParts(null)).toEqual({ jobs: null, board: null });
    expect(splitStats({ days: {}, sent: [] }).sent).toEqual({ jobs: [], board: null });
  });

  it("refuses a board with an unknown stage, a bad key or date, long text, or too many cards", async () => {
    const card = BOARD[0];
    for (const board of [{}, [null], [{ ...card, stage: "not_for_me" }], [{ ...card, stage: "hired" }], [{ ...card, key: "" }],
      [{ ...card, key: "x\u0000y" }], [{ ...card, key: "k".repeat(301) }], [{ ...card, day: "soon" }], [{ ...card, title: 5 }],
      [{ ...card, title: "t".repeat(201) }], [{ ...card, employer: "e".repeat(121) }], new Array(201).fill(card)]) {
      expect(validStats({ days: {}, board })).toBe(false);
    }
    expect(validStats({ days: {}, board: [card, { key: "k", stage: "offer", day: day() }] })).toBe(true);
    const { env } = await setup();
    const res = await api(env, "/api/stats", { u: "sam-lee", stats: { days: {}, board: [{ ...card, stage: "<script>" }] } });
    expect(res.status).toBe(400);
  });

  it("shows each job in its column, with Heard back inside Applied", async () => {
    const { admin } = await setup();
    const page = await admin.text("/admin/pipeline?u=sam-lee");
    expect(page).toContain('<a href="/admin/pipeline?u=sam-lee" class="on" aria-current="page">Pipeline</a>');
    const column = (label) => page.split(`aria-label="${label}"`)[1].split("</section>")[0];
    expect(column("Applied")).toContain("Data Engineer");
    expect(column("Applied")).toContain("Consultant");
    expect(column("Applied")).toContain('<span class="ptag">Heard back</span>');
    expect(column("Interview")).toContain("Analyst");
    expect(column("Placed")).toContain("Team Lead");
    expect(column("Offer")).toContain("None");
    expect(page).toContain(`id="card-${(await jobHash(JOB)).slice(0, 16)}"`);
    expect(page).toContain("within about 5 minutes");
  });

  it("says when HermitShell has not sent a board yet", async () => {
    const { env, admin } = await setup();
    await env.FEEDBACK.put("sent:sam-lee", JSON.stringify([{ title: "Data Engineer", day: day(), key: JOB }]));
    expect(await admin.text("/admin/pipeline?u=sam-lee")).toContain("No board yet.");
  });

  it("is only shown to an admin or the recruit's own recruiter, and never for the main admin's row", async () => {
    const { casey, admin } = await setup();
    expect((await casey.get("/admin/pipeline?u=sam-lee")).status).toBe(200);
    expect((await casey.get("/admin/pipeline?u=jordan-patel")).status).toBe(404);
    expect((await admin.get("/admin/pipeline?u=owner")).status).toBe(404);
    expect((await admin.get("/admin/pipeline?u=..%2Fx")).status).toBe(404);
  });
});

describe("moving a job", () => {
  it("stores the move as the email's answer would be, once per minute, and records it in the history", async () => {
    const { env, admin } = await setup();
    const h = await jobHash(JOB);
    const res = await admin.move({ a: "interview" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/admin/pipeline?u=sam-lee&done=stage#card-${h.slice(0, 16)}`);
    await admin.move({ a: "interview" });
    const events = stageEvents(env);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ j: JOB, a: "interview", r: "", via: "dashboard", u: "sam-lee" });
    expect(events[0].meta).toBeUndefined();
    expect(events[0].id).toMatch(new RegExp(`^event:sam-lee:dash-st-${h.slice(0, 20)}:interview\\d+$`));
    expect(keysWith(env, "flag:events:sam-lee")).toEqual(["flag:events:sam-lee"]);
    const history = valuesWith(env, "history:sam-lee:").flat();
    expect(history.map((e) => [e.k, e.t])).toContainEqual(["stage", "Moved to Interview: Data Engineer at Northwind"]);
    expect(await admin.text("/admin/pipeline?u=sam-lee&done=stage")).toContain("Moved. The board shows it");
  });

  it("refuses an unknown stage or job, and a stale form", async () => {
    const { env, admin, casey } = await setup();
    for (const fields of [{ a: "not_for_me" }, { a: "hired" }, { a: "add_skill" }, { a: "interview", j: "" }, { a: "interview", j: "x".repeat(301) }]) {
      expect((await admin.move(fields)).headers.get("Location")).toBe("/admin/pipeline?u=sam-lee&done=stagebad");
    }
    const anonymous = await worker.fetch(post("/admin/stage", { csrf: "0".repeat(64), u: "sam-lee", j: JOB, a: "interview" }), env);
    expect(await anonymous.text()).not.toContain("Moved.");
    const stale = await worker.fetch(post("/admin/stage", { csrf: "0".repeat(64), u: "sam-lee", j: JOB, a: "interview" },
      { Cookie: admin.cookie }), env);
    expect(stale.status).toBe(403);
    expect((await casey.move({ a: "interview", u: "jordan-patel" })).status).toBe(404);
    expect((await admin.move({ a: "interview", u: "owner" })).status).toBe(404);
    expect(stageEvents(env)).toEqual([]);
  });

  it("seals an admin's fee for HermitShell and keeps the start date and currency beside it", async () => {
    const { env, admin, keys } = await setup();
    const start = day(-30);
    await admin.move({ a: "placed", start, fee: "4,250.50", currency: "gbp" });
    const [event] = stageEvents(env);
    expect(event.meta.start).toBe(start);
    expect(event.meta.currency).toBe("GBP");
    expect(event.meta.fee).toMatch(/^sealed:/);
    expect(JSON.stringify(event)).not.toContain("4250");
    expect(await keys.open(event.meta.fee, "fee")).toBe("4250.5");
    const history = JSON.stringify(valuesWith(env, "history:sam-lee:"));
    expect(history).toContain("Moved to Placed");
    expect(history).not.toContain("4250");
  });

  it("ignores placement details on other stages, and refuses bad ones", async () => {
    const { env, admin } = await setup();
    await admin.move({ a: "interview", fee: "100", currency: "GBP", start: day(-3) });
    expect(stageEvents(env)[0].meta).toBeUndefined();
    for (const bad of [{ fee: "-5" }, { fee: "1000001" }, { fee: "12.345" }, { fee: "lots" }, { fee: "10", currency: "XYZ" },
      { start: "2026-02-30" }, { start: "31/12/2026" }, { start: day(-800) }]) {
      expect((await admin.move({ a: "offer", currency: "GBP", ...bad })).headers.get("Location")).toBe("/admin/pipeline?u=sam-lee&done=stagebad");
    }
    expect(stageEvents(env)).toHaveLength(1);
  });

  it("does not store a fee when HermitShell has not sent the key it is sealed with", async () => {
    const { env, admin } = await setup({ sealed: false });
    expect((await admin.move({ a: "offer", fee: "900", currency: "GBP" })).headers.get("Location"))
      .toBe("/admin/pipeline?u=sam-lee&done=feeseal");
    expect(stageEvents(env)).toEqual([]);
    expect((await admin.move({ a: "offer" })).headers.get("Location")).toContain("done=stage");
  });

  it("lets a recruiter move their own recruit's jobs but not see or set a fee", async () => {
    const { env, casey, admin } = await setup();
    const page = await casey.text("/admin/pipeline?u=sam-lee");
    expect(page).toContain('action="/admin/stage"');
    expect(page).not.toContain('name="fee"');
    expect(await admin.text("/admin/pipeline?u=sam-lee")).toContain('name="fee"');
    expect((await casey.move({ a: "placed", fee: "900", currency: "GBP" })).status).toBe(403);
    expect((await casey.move({ a: "placed", currency: "GBP" })).status).toBe(403);
    expect(stageEvents(env)).toEqual([]);
    await casey.move({ a: "offer", start: day(-10) });
    const [event] = stageEvents(env);
    expect(event.a).toBe("offer");
    expect(event.meta).toBeUndefined();
  });
});

describe("placement details", () => {
  it("are checked before they are stored", () => {
    const form = (fields) => new URLSearchParams(fields);
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(stageMeta(form({}), now)).toEqual({});
    expect(stageMeta(form({ start: "2026-11-02", fee: "1200", currency: "€" }), now)).toEqual({ start: "2026-11-02", fee: 1200, currency: "EUR" });
    expect(stageMeta(form({ fee: "1200" }), now)).toBeNull();
    expect(stageMeta(form({ start: "2029-01-01" }), now)).toBeNull();
    expect(stageMeta(form({ currency: "GBP" }), now)).toEqual({});
  });
});

describe("email buttons", () => {
  async function link(action, title = "Data Engineer at Northwind") {
    const d = String(today());
    const t = await sign("test-secret", JOB, action, title, "", "sam-lee", d);
    return { j: JOB, a: action, n: title, u: "sam-lee", d, t };
  }

  it("record Got an interview and Offer, but Placed is only set from the dashboard", async () => {
    const { env } = await setup();
    for (const action of ["interview", "offer"]) {
      const fields = await link(action);
      const confirm = await (await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(fields)}`), env)).text();
      expect(confirm).toContain(action === "interview" ? "Confirm: Got an interview" : "Confirm: Offer");
      const saved = await worker.fetch(post("/f", { ...fields, r: "" }), env);
      expect(saved.status).toBe(200);
    }
    const answers = valuesWith(env, "event:sam-lee:").filter((e) => !e.id.includes(":dash-")).map((e) => e.a).sort();
    expect(answers).toEqual(["interview", "offer"]);
    const history = valuesWith(env, "history:sam-lee:").flat().map((e) => e.t);
    expect(history).toContain("Answered Got an interview: Data Engineer at Northwind");
    const placed = await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(await link("placed"))}`), env);
    expect(placed.status).toBe(403);
  });
});

describe("the stats", () => {
  it("read an older 16-number day as 0 for interview, offer and placed", () => {
    expect(FIELDS.slice(16)).toEqual(["interview", "offer", "placed"]);
    const old = { days: { "2026-09-29": [10, 5, 2, 14, 2, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0] } };
    const t = totals(old, ["2026-09-29"]);
    expect([t.interview, t.offer, t.placed, t.applied]).toEqual([0, 0, 0, 1]);
    const now = { days: { "2026-09-29": [...old.days["2026-09-29"], 2, 1, 1] } };
    expect(totals(now, ["2026-09-29"])).toMatchObject({ interview: 2, offer: 1, placed: 1 });
  });

  it("show interviews on the stats page and link to the Pipeline", async () => {
    const { env, admin } = await setup();
    const row = Array(FIELDS.length).fill(0);
    row[FIELDS.indexOf("interview")] = 3;
    await api(env, "/api/stats", { u: "sam-lee", stats: { days: { [day()]: row }, pipeline: { applied: 2, interview: 1, placed: 1 } } });
    const page = await admin.text("/admin/stats?u=sam-lee");
    expect(page).toMatch(/kpi-num">3<\/div><div class="kpi-label">Interviews/);
    expect(page).toContain('href="/admin/pipeline?u=sam-lee">Pipeline</a>');
    expect(page).toContain("<span>Placed</span>");
  });
});

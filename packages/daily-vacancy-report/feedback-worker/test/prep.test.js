// Interview prep packs: asked for from the jobs sent (once they have applied) and from the Pipeline (Interview and
// Offer), kept for download like letters, shown on the task list and in the history.
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { DOC_KINDS, PREP_ANSWERS, REQUEST_KINDS, docActions, jobHash } from "../src/docs.js";
import { REQUEST_ACTIONS, taskRows } from "../src/tasks.js";
import { BASE, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const CASEY_PASSWORD = "a long enough passphrase";
const APPLIED = "https://jobs.example.com/1";
const INTERVIEW = "https://jobs.example.com/2";
const PROFILES = [
  { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false, recruit: "" },
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true, recruiter: "casey" },
  { id: "jordan-patel", name: "Jordan Patel", email: "jordan@contoso.example", status: "active", has_cv: true },
];
const day = (ago = 0) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
const BOARD = [
  { key: APPLIED, title: "Data Engineer", employer: "Northwind", stage: "applied", day: day(2) },
  { key: INTERVIEW, title: "Analyst <b>", employer: "Contoso", stage: "interview", day: day(5) },
];
const SENT = [{ title: "Data Engineer", employer: "Northwind", day: day(2), fit: 8, key: APPLIED, answer: "applied" },
  { title: "Analyst", employer: "Contoso", day: day(3), fit: 7, key: INTERVIEW }];

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
  const ask = async (fields) => worker.fetch(post("/admin/doc", { csrf: await csrf(), u: "sam-lee", j: INTERVIEW, k: "interview_prep",
    n: "Analyst at Contoso", ...fields }, { Cookie: cookie }), env);
  return { get, text, ask, cookie };
}

function api(env, path, body) {
  return worker.fetch(new Request(`${BASE}${path}`, { method: "POST", headers: API, body: JSON.stringify(body) }), env);
}

function keep(env, j, kind = "interview_prep") {
  const q = new URLSearchParams({ u: "sam-lee", j, k: kind, days: "7", name: "Interview prep - Sam Lee - Analyst" });
  return worker.fetch(new Request(`${BASE}/api/doc?${q}`, { method: "POST", headers: { ...API, "Content-Type": "application/pdf" },
    body: "%PDF-1.4\n%%EOF" }), env);
}

async function setup(tasks = []) {
  const env = testEnv(ADMIN);
  await api(env, "/api/status", { profiles: PROFILES, tasks });
  await api(env, "/api/stats", { u: "sam-lee", stats: { days: {}, sent: SENT, board: BOARD } });
  const cookie = await signIn(env, "admin", ADMIN.ADMIN_PASSWORD, "203.0.113.31");
  const admin = client(env, cookie);
  const csrf = (await admin.text("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  await worker.fetch(post("/admin/users", { csrf, op: "add", name: "Casey Quinn", username: "casey", password: CASEY_PASSWORD, roles: "recruiter" },
    { Cookie: cookie }), env);
  const casey = client(env, await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.33"));
  return { env, admin, casey };
}

const prepEvents = (env) => valuesWith(env, "event:sam-lee:dash-").filter((e) => e.a === "interview_prep");
const column = (page, label) => page.split(`aria-label="${label}"`)[1].split("</section>")[0];

describe("the request kind", () => {
  it("is a document HermitShell makes, keeps and lists", () => {
    expect(DOC_KINDS.interview_prep).toBe("Interview prep");
    expect(REQUEST_KINDS.interview_prep).toBe("Interview prep");
    expect(REQUEST_ACTIONS).toContain("interview_prep");
    expect(PREP_ANSWERS).toEqual(["applied", "heard_back", "interview", "offer", "placed"]);
  });

  it("shows on the task list with its own label and stage", () => {
    const rows = taskRows({ profiles: PROFILES, tasks: [{ id: "letter:sam-lee:event:sam-lee:auto-prep-0123456789abcdef01234567",
      kind: "interview_prep", u: "sam-lee", state: "running", title: "Analyst", employer: "Contoso" }] }, [], []);
    expect(rows).toMatchObject([{ kind: "interview_prep", state: "running", title: "Analyst at Contoso", where: "server" }]);
  });
});

describe("on the jobs sent", () => {
  const ctx = (extra = {}) => ({ profile: "sam-lee", csrf: "c".repeat(64), docs: [], pending: new Map(), emailed: [], back: "r=7",
    title: "Data Engineer at Northwind", ...extra });

  it("is offered once they have applied, or when one is kept or on its way", async () => {
    const h = await jobHash(APPLIED);
    expect(docActions(APPLIED, h, ctx())).not.toContain("Interview prep");
    expect(docActions(APPLIED, h, ctx({ answer: "interested" }))).not.toContain("Interview prep");
    for (const answer of PREP_ANSWERS) expect(docActions(APPLIED, h, ctx({ answer }))).toContain('value="interview_prep"');
    const kept = [{ k: "interview_prep", h, name: "Interview prep.pdf", at: Date.now(), exp: Date.now() + 86400000 }];
    expect(docActions(APPLIED, h, ctx({ docs: kept }))).toContain(`k=interview_prep&amp;h=${h}`);
    expect(docActions(APPLIED, h, ctx({ pending: new Map([[`interview_prep\n${APPLIED}`, "make"]]) }))).toContain("Being made");
  });

  it("is on the page for a job they applied for, not for one with no answer", async () => {
    const { admin } = await setup();
    const page = await admin.text("/admin/sent?u=sam-lee&r=7");
    const [applied, other] = [APPLIED, INTERVIEW].map(async (j) => page.split(`id="job-${(await jobHash(j)).slice(0, 16)}"`)[1].split("</li>")[0]);
    expect(await applied).toContain('value="interview_prep"');
    expect(await other).not.toContain('value="interview_prep"');
  });

  it("is stored as a dashboard request with its note and recorded in the history", async () => {
    const { env, admin } = await setup();
    const h = (await jobHash(APPLIED)).slice(0, 16);
    const res = await admin.ask({ j: APPLIED, n: "Data Engineer at Northwind", back: "r=7", r: "they said there is a test" });
    expect(res.headers.get("Location")).toBe(`/admin/sent?u=sam-lee&r=7&open=${h}&done=doc#job-${h}`);
    const [event] = prepEvents(env);
    expect(event).toMatchObject({ j: APPLIED, a: "interview_prep", r: "they said there is a test", via: "dashboard", u: "sam-lee" });
    expect(event.id).toMatch(/:p/);
    const history = valuesWith(env, "history:sam-lee:").flat().map((e) => e.t);
    expect(history).toContain("Asked for an interview prep pack (with a note): Data Engineer at Northwind");
  });
});

describe("on the Pipeline", () => {
  it("has a button on Interview and Offer cards only, coming back to the card", async () => {
    const { env, admin } = await setup();
    const page = await admin.text("/admin/pipeline?u=sam-lee");
    expect(column(page, "Interview")).toContain("Interview prep</button>");
    expect(column(page, "Applied")).not.toContain("Interview prep</button>");
    expect(column(page, "Interview")).toContain('value="Analyst &lt;b&gt; at Contoso"');
    expect(column(page, "Interview")).not.toContain("Analyst <b>");
    const h = (await jobHash(INTERVIEW)).slice(0, 16);
    const res = await admin.ask({ back: "pipeline" });
    expect(res.headers.get("Location")).toBe(`/admin/pipeline?u=sam-lee&done=doc#card-${h}`);
    expect(prepEvents(env)).toHaveLength(1);
    expect(await admin.text("/admin/pipeline?u=sam-lee&done=doc")).toContain("HermitShell is making the prep pack");
    expect((await admin.ask({ back: "pipeline", j: "" })).headers.get("Location")).toBe("/admin/pipeline?u=sam-lee&done=docbad");
  });

  it("shows the pack being made, then a download once HermitShell has kept it", async () => {
    const { env, admin } = await setup();
    await admin.ask({ back: "pipeline" });
    expect(column(await admin.text("/admin/pipeline?u=sam-lee"), "Interview")).toContain("Prep pack being made");
    expect((await keep(env, INTERVIEW)).status).toBe(200);
    const page = await admin.text("/admin/pipeline?u=sam-lee");
    const h = await jobHash(INTERVIEW);
    expect(column(page, "Interview")).toContain(`href="/admin/doc?u=sam-lee&amp;k=interview_prep&amp;h=${h}"`);
    const pdf = await admin.get(`/admin/doc?u=sam-lee&k=interview_prep&h=${h}`);
    expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
    expect(pdf.headers.get("Content-Disposition")).toContain("Interview prep - Sam Lee - Analyst.pdf");
  });

  it("lets a recruiter ask for their own recruit only", async () => {
    const { env, casey } = await setup();
    expect((await casey.ask({ back: "pipeline" })).status).toBe(303);
    expect((await casey.ask({ back: "pipeline", u: "jordan-patel" })).status).toBe(404);
    expect(prepEvents(env)).toHaveLength(1);
    expect(valuesWith(env, "event:jordan-patel:")).toEqual([]);
  });
});

// The recruiter desk: HermitShell's sealed upload of every recruit's totals, the /admin/desk page by recruiter (fees for
// admins only), "Also suits" on the jobs sent (only recruits the person looking may see) and salaries by job title.
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { DESK_KEY, deskPage, forViewer, validDesk } from "../src/desk.js";
import { splitStats, validStats } from "../src/stats.js";
import { jobHash } from "../src/docs.js";
import { BASE, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const CASEY_PASSWORD = "a long enough passphrase";
const SHARED = "https://jobs.example.com/shared";
const PROFILES = [
  { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false },
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true, recruiter: "casey" },
  { id: "jordan-patel", name: "Jordan <Patel>", email: "jordan@contoso.example", status: "active", has_cv: true },
];
const line = (n, fees = {}) => ({ sent: n * 10, applied: n * 3, interview: n * 2, offer: n, placed: n, fees });
const ranges = (n, fees) => ({ 7: line(n, fees), 30: line(n * 2, fees), 90: line(n * 3, fees), 365: line(n * 4, fees) });
const DESK = {
  v: 1,
  recruits: { "sam-lee": ranges(1, { GBP: 12345 }), "jordan-patel": ranges(2, { EUR: 6789.5 }), "gone-away": ranges(5, { GBP: 99999 }) },
  salaries: [{ title: "Data Engineer", n: 5, median: 52000, currency: "GBP" }, { title: "Analyst <i>", n: 3, median: 30000, currency: "EUR" }],
};
const day = (ago = 0) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

function api(env, path, body, headers = API) {
  return worker.fetch(new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env);
}

async function signIn(env, username, password, ip) {
  const res = await worker.fetch(post("/admin/login", { username, password }, { "CF-Connecting-IP": ip }), env);
  return (res.headers.get("Set-Cookie") || "").split(";")[0];
}

const page = (env, cookie, path) => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env).then((r) => r.text());

async function setup({ desk = DESK, sent = [] } = {}) {
  const env = testEnv(ADMIN);
  await api(env, "/api/status", { profiles: PROFILES });
  if (desk) expect((await api(env, "/api/desk", { desk })).status).toBe(200);
  await api(env, "/api/stats", { u: "sam-lee", stats: { days: {}, sent } });
  const admin = await signIn(env, "admin", ADMIN.ADMIN_PASSWORD, "203.0.113.41");
  const csrf = (await page(env, admin, "/admin")).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  await worker.fetch(post("/admin/users", { csrf, op: "add", name: "Casey Quinn", username: "casey", password: CASEY_PASSWORD, roles: "recruiter" },
    { Cookie: admin }), env);
  const casey = await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.43");
  return { env, admin, casey };
}

describe("the desk upload", () => {
  it("is kept sealed, so KV never holds a fee or a recruit id in the clear", async () => {
    const { env } = await setup();
    const stored = new TextDecoder().decode(new Uint8Array(env.FEEDBACK.store.get(DESK_KEY)));
    for (const plain of ["12345", "6789", "sam-lee", "Data Engineer", "GBP"]) expect(stored).not.toContain(plain);
  });

  it("needs HermitShell's API token and refuses what doesn't fit", async () => {
    const env = testEnv(ADMIN);
    expect((await api(env, "/api/desk", { desk: DESK }, {})).status).toBe(401);
    expect((await api(env, "/api/desk", { desk: { recruits: { "Bad Id": ranges(1) } } })).status).toBe(400);
    expect((await api(env, "/api/desk", { desk: { recruits: {}, padding: "x".repeat(310 * 1024) } })).status).toBe(413);
    expect((await api(testEnv({ ...ADMIN, JOB_FEEDBACK_SECRET: "" }), "/api/desk", { desk: DESK })).status).toBe(503);
    expect(env.FEEDBACK.store.has(DESK_KEY)).toBe(false);
  });

  it("checks every number, currency and salary row", () => {
    expect(validDesk(DESK)).toBe(true);
    expect(validDesk({ recruits: {} })).toBe(true);
    const bad = [
      { recruits: { "sam-lee": { 7: { ...line(1), applied: -1 } } } },
      { recruits: { "sam-lee": { 7: { ...line(1), placed: 1.5 } } } },
      { recruits: { "sam-lee": { 14: line(1) } } },
      { recruits: { "sam-lee": { 7: line(1, { gbp: 5 }) } } },
      { recruits: { "sam-lee": { 7: line(1, { GBP: -5 }) } } },
      { recruits: { "sam-lee": { 7: line(1, { GBP: Infinity }) } } },
      { recruits: {}, salaries: [{ title: "A", n: 3, median: 1, currency: "pounds" }] },
      { recruits: {}, salaries: Array.from({ length: 13 }, () => DESK.salaries[0]) },
      { recruits: [] },
      null,
    ];
    for (const desk of bad) expect(validDesk(desk)).toBe(false);
  });
});

describe("the desk page", () => {
  it("groups an admin's view by recruiter, with fees, and leaves out recruits HermitShell no longer reports", async () => {
    const { env, admin } = await setup();
    const html = await page(env, admin, "/admin/desk?r=7");
    expect(html).toContain('aria-current="page">Desk</a>');
    const casey = html.split("Casey Quinn")[1].split("</section>")[0];
    expect(casey).toContain("Sam Lee");
    expect(casey).not.toContain("Jordan");
    expect(casey).toContain("\u00a312,345");
    const none = html.split("No recruiter")[1].split("</section>")[0];
    expect(none).toContain("Jordan &lt;Patel&gt;");
    expect(none).toContain("\u20ac6,790");
    expect(html).not.toContain("99,999");
    expect(html).not.toContain("Alex Morgan</a>");
    expect(html).toContain("<b>30</b><span>Sent</span>");
    expect(html).toContain("Data Engineer");
    expect(html).toContain("Analyst &lt;i&gt;");
  });

  it("shows a recruiter only their own recruits and never a fee", async () => {
    const { env, casey } = await setup();
    const html = await page(env, casey, "/admin/desk?r=365");
    expect(html).toContain("Sam Lee");
    expect(html).not.toContain("Jordan");
    expect(html).not.toContain("Fees");
    expect(html).not.toContain("12,345");
    expect(html).not.toContain("6,790");
    expect(html).toContain("Your recruits only.");
    expect(html).toContain("<b>40</b><span>Sent</span>");
  });

  it("takes the fees out before the page is drawn for anyone but an admin", () => {
    const view = forViewer({ ...DESK, updated: 1 }, { id: "casey", admin: false }, PROFILES);
    expect(Object.keys(view.recruits)).toEqual(["sam-lee"]);
    expect(JSON.stringify(view)).not.toContain("fees");
    expect(JSON.stringify(forViewer(DESK, { id: "admin", admin: true }, PROFILES))).toContain("12345");
  });

  it("says when HermitShell has not sent the desk yet", async () => {
    const { env, admin } = await setup({ desk: null });
    const html = await page(env, admin, "/admin/desk");
    expect(html).toContain("HermitShell sends the desk within 30 minutes");
    expect(html).toContain("Shown once 3 jobs with the same title give a salary.");
  });

  it("draws 200 recruits well inside the free plan's 10 ms of CPU", () => {
    const profiles = Array.from({ length: 200 }, (_, i) => ({ id: `recruit-${i}`, name: `Recruit ${i}`, recruiter: `r${i % 7}` }));
    const desk = { recruits: Object.fromEntries(profiles.map((p, i) => [p.id, ranges(i % 9, { GBP: i * 100 })])), salaries: DESK.salaries, updated: 1 };
    const people = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, name: `Recruiter ${i}` }));
    deskPage({ profiles }, desk, { id: "admin", admin: true }, people, "30");
    // The fastest of several runs: a shared CI runner's pauses would otherwise be counted as the page's own time.
    const times = Array.from({ length: 7 }, () => {
      const start = performance.now();
      deskPage({ profiles }, desk, { id: "admin", admin: true }, people, "30");
      return performance.now() - start;
    });
    expect(Math.min(...times)).toBeLessThan(10);
  });
});

describe("Also suits on the jobs sent", () => {
  const SENT = [{ title: "Data Engineer", employer: "Northwind", day: day(1), fit: 8, key: SHARED,
    others: [{ u: "jordan-patel", fit: 7 }, { u: "owner", fit: 9 }, { u: "ghost", fit: 6 }] }];

  it("shows the other recruits an admin may see, linking to their jobs sent", async () => {
    const { env, admin } = await setup({ sent: SENT });
    const html = await page(env, admin, `/admin/sent?u=sam-lee&r=7&open=${(await jobHash(SHARED)).slice(0, 16)}`);
    const also = html.split('class="skills also"')[1].split("</div></div>")[0];
    expect(also).toContain('href="/admin/sent?u=jordan-patel"');
    expect(also).toContain("Jordan &lt;Patel&gt; <b>7/10</b>");
    expect(also).not.toContain("owner");
    expect(also).not.toContain("ghost");
  });

  it("shows a recruiter none of the recruits outside their pool", async () => {
    const { env, casey } = await setup({ sent: SENT });
    const html = await page(env, casey, "/admin/sent?u=sam-lee&r=7");
    expect(html).toContain("Data Engineer");
    expect(html).not.toContain('class="skills also"');
    expect(html).not.toContain("Jordan");
  });

  it("is checked when stored and kept only with the jobs' details", () => {
    const ok = { days: {}, sent: SENT };
    expect(validStats(ok)).toBe(true);
    for (const others of [[{ u: "Bad Id", fit: 7 }], [{ u: "sam-lee", fit: 11 }], Array.from({ length: 6 }, () => ({ u: "sam-lee", fit: 5 })), "x"]) {
      expect(validStats({ days: {}, sent: [{ ...SENT[0], others }] })).toBe(false);
    }
    const { stats, sent } = splitStats(ok);
    expect(stats.sent[0].others).toBeUndefined();
    expect(sent.jobs[0].others).toHaveLength(3);
  });
});

describe("salaries by job title on the stats page", () => {
  it("lists only titles with three salaries or more, escaped", async () => {
    const { env, admin } = await setup({ desk: null });
    const ranges30 = { salary_titles: [{ title: "Data <Engineer>", n: 4, median: 52000 }, { title: "Lone", n: 1, median: 99000 }] };
    await api(env, "/api/stats", { u: "sam-lee", stats: { days: {}, ranges: { 30: ranges30 } } });
    const html = await page(env, admin, "/admin/stats?u=sam-lee&r=30");
    const card = html.split("Salaries by job title")[1].split("</section>")[0];
    expect(card).toContain("Data &lt;Engineer&gt;");
    expect(card).toContain("4 jobs");
    expect(card).toContain("52k");
    expect(card).not.toContain("Lone");
  });
});

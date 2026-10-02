// The recruiter desk: HermitShell's sealed upload of every recruit's totals, the /admin/desk page by recruiter (fees for
// admins only), "Also suits" on the jobs sent (only recruits the person looking may see) and salaries by job title.
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { DESK_KEY, deskPage, forViewer, validDesk } from "../src/desk.js";
import { splitStats, validStats } from "../src/stats.js";
import { teams } from "../src/users.js";
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
    const casey = html.split('id="rec-casey"')[1].split("</details>")[0];
    expect(casey).toContain("Casey Quinn");
    expect(casey).toContain("Sam Lee");
    expect(casey).not.toContain("Jordan");
    expect(casey).toContain("\u00a312,345");
    const none = html.split('id="rec-none"')[1].split("</details>")[0];
    expect(none).toContain("No recruiter");
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
    expect(html).toContain("The numbers appear within about 30 minutes");
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

describe("the desk at scale", () => {
  const L = (counts, fees = {}) => ({ 30: { sent: 0, applied: 0, interview: 0, offer: 0, placed: 0, ...counts, fees } });
  const people = [{ id: "casey", name: "Casey Quinn" }, { id: "riley", name: "Riley Chen" }, { id: "drew", name: "Drew Harper" },
    { id: "jamie", name: "Jamie Walsh" }, { id: "robin", name: "Robin Shaw" }];
  const org = { managers: new Map([["morgan", "Morgan Ellis"]]), leads: new Map([["casey", "morgan"], ["riley", "morgan"]]) };
  const profiles = [
    { id: "sam-lee", name: "Sam Lee", recruiter: "casey" }, { id: "jordan-patel", name: "Jordan Patel", recruiter: "casey" },
    { id: "avery-lane", name: "Avery Lane", recruiter: "riley" }, { id: "taylor-reid", name: "Taylor Reid", recruiter: "drew" },
    { id: "alex-chen", name: "Alex Chen", recruiter: "drew" }, { id: "morgan-lee", name: "Morgan Lee", recruiter: "jamie" },
    { id: "casey-lane", name: "Casey Lane", recruiter: "" },
  ];
  const desk = { updated: 1, salaries: [], recruits: {
    "sam-lee": L({ sent: 40, applied: 6, interview: 3, offer: 2, placed: 2 }, { GBP: 9000 }), "jordan-patel": L({}),
    "avery-lane": L({ sent: 20, applied: 3, interview: 1, offer: 1 }), "taylor-reid": L({ sent: 30, applied: 4, interview: 2 }),
    "morgan-lee": L({ sent: 10, applied: 1 }), "casey-lane": L({ sent: 5 }) } };
  const ADMIN_ME = { id: "admin", admin: true };
  const draw = (me = ADMIN_ME, opts = {}) => deskPage({ profiles }, desk, me, people, "30", { org, ...opts }).text();
  const boardOf = (html) => html.split('class="desk board"')[1].split("</table>")[0];
  const order = (text, names) => names.map((n) => text.indexOf(n));
  const ascending = (xs) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));

  it("ranks the recruiters by placements, highlights the best figures, and re-ranks by the column pressed", async () => {
    const board = boardOf(await draw());
    expect(ascending(order(board, ["Casey Quinn", "Riley Chen", "Drew Harper", "Jamie Walsh", "Robin Shaw", "No recruiter"]))).toBe(true);
    expect(board).toMatch(/<span class="rk r1">1<\/span><\/td><th scope="row"><span class="who"><span class="davatar"[^>]*>CQ<\/span>/);
    expect(board).toContain('<th scope="col" aria-sort="descending" class="sorted"><a href="/admin/desk?r=30">Placed</a></th>');
    expect(board).toContain('<td class="top">2</td>');
    expect(board).toContain('<a href="/admin/desk?r=30&amp;rec=casey#rec-casey">Casey Quinn</a>');
    expect(board).toMatch(/<span>Robin Shaw<\/span><\/span><\/th>\n<td>0<\/td>/);
    expect(board).toContain('<tr class="quiet"><td class="rank"></td>');
    const byName = boardOf(await draw(ADMIN_ME, { sort: "name" }));
    expect(ascending(order(byName, ["Casey Quinn", "Drew Harper", "Jamie Walsh", "Riley Chen", "Robin Shaw"]))).toBe(true);
    expect(byName).not.toContain('class="rk r1"');
    expect(byName).toContain('aria-sort="ascending" class="sorted"><a href="/admin/desk?r=30&amp;sort=name">Recruiter</a>');
    const bySent = boardOf(await draw(ADMIN_ME, { sort: "sent" }));
    expect(ascending(order(bySent, ["Casey Quinn", "Drew Harper", "Riley Chen", "Jamie Walsh"]))).toBe(true);
    expect(boardOf(await draw(ADMIN_ME, { sort: "toString" }))).toContain('aria-sort="descending" class="sorted"><a href="/admin/desk?r=30">Placed</a>');
  });

  it("shows an admin the teams, each a filter, and the team of every recruiter", async () => {
    const html = await draw();
    expect(html.match(/<a class="teamcard/g)).toHaveLength(2);
    expect(html).toContain("<b>Morgan Ellis&rsquo;s team</b>\n<small>2 recruiters &middot; 3 recruits</small>");
    expect(html).toContain("<b>No team</b>\n<small>3 recruiters &middot; 4 recruits</small>");
    expect(html).toContain('href="/admin/desk?r=30&amp;team=morgan"');
    expect(boardOf(html)).toContain('class="teamchip" style="--team:#6366f1">Morgan Ellis&rsquo;s team</span>');
    const theirs = await draw(ADMIN_ME, { team: "morgan" });
    expect(theirs).toContain('<a class="teamcard on" href="/admin/desk?r=30"');
    expect(theirs).toContain("Showing <b>Morgan Ellis&rsquo;s team</b>");
    expect(boardOf(theirs)).toContain("Casey Quinn");
    for (const other of ["Drew Harper", "Jamie Walsh", "Robin Shaw", "No recruiter"]) expect(boardOf(theirs)).not.toContain(other);
    for (const other of ["Taylor Reid", "Casey Lane"]) expect(theirs).not.toContain(other);
    expect(theirs).toContain("<b>2</b><span>Placed</span>");
    const lone = await draw(ADMIN_ME, { team: "none" });
    expect(boardOf(lone)).not.toContain("Casey Quinn");
    expect(boardOf(lone)).toContain("No recruiter");
    const bogus = await draw(ADMIN_ME, { team: "<script>x</script>" });
    expect(bogus).not.toContain("<script>x");
    expect(bogus).not.toContain("Showing <b>");
  });

  it("gives a manager their own team only, with no team cards, whatever ?team= says", async () => {
    const morgan = { id: "morgan", manager: true, team: ["casey", "riley"] };
    for (const team of ["", "none", "morgan"]) {
      const html = await draw(morgan, { team });
      expect(html).not.toContain('class="teamcard');
      expect(html).not.toContain("Showing <b>");
      expect(boardOf(html)).toContain("Riley Chen");
      for (const other of ["Drew Harper", "Jamie Walsh", "Taylor Reid", "Casey Lane", "No recruiter"]) expect(html).not.toContain(other);
      expect(html).toContain("\u00a39,000");
    }
  });

  it("lists each recruiter's recruits furthest along first, folds the groups away at scale and opens the one asked for", async () => {
    const html = await draw();
    expect(html).toContain('<details class="deskgroup" id="rec-casey"><summary>');
    expect(html).toContain('<h2 class="dh">Recruits by recruiter<span>press a recruiter to open their recruits</span></h2>');
    const casey = html.split('id="rec-casey"')[1].split("</details>")[0];
    expect(ascending(order(casey, ["Sam Lee", "Jordan Patel"]))).toBe(true);
    expect(casey).toContain('<span class="stage st-placed">Placed</span>');
    expect(casey).toMatch(/<tr class="quiet"><th scope="row"><a href="\/admin\/stats\?u=jordan-patel[^"]*">Jordan Patel<\/a>/);
    expect(casey).toContain('<span class="stage st-idle">No activity</span>');
    expect(casey).toContain("2 recruits &middot; 1 with no activity");
    const drew = (await draw(ADMIN_ME, { rec: "drew" })).split('id="rec-drew"')[1].split("</details>")[0];
    expect(drew.startsWith(" open>")).toBe(true);
    expect(ascending(order(drew, ["Taylor Reid", "Alex Chen"]))).toBe(true);
    expect(drew).toContain('<span class="stage st-interview">Interviewing</span>');
    expect(drew).toContain('<span class="stage st-none">No data yet</span>');
    expect(await draw(ADMIN_ME, { team: "morgan" })).toContain('<details class="deskgroup" id="rec-casey" open>');
  });

  it("shows a recruiter just their recruits, open, with no ranking, teams or fees", async () => {
    const html = await draw({ id: "casey" });
    for (const absent of ['class="desk board"', 'class="teamcard', "Recruits by recruiter", "Fees", "9,000", "Riley Chen", 'class="teamchip"']) {
      expect(html).not.toContain(absent);
    }
    expect(html).toContain('<details class="deskgroup" id="rec-casey" open>');
    expect(html).toContain("<b>40</b><span>Sent</span><em>jobs emailed</em>");
    expect(html).toContain("<b>6</b><span>Applied</span><em>15% of sent</em>");
  });

  it("works out each recruiter's team from the accounts", async () => {
    const acc = { users: [
      { id: "morgan", name: "Morgan Ellis", roles: ["manager"] }, { id: "lee", name: "Sam Lee", roles: ["manager", "recruiter"] },
      { id: "casey", name: "Casey Quinn", roles: ["recruiter"], manager: "morgan" }, { id: "riley", name: "Riley Chen", roles: ["recruiter"], manager: "" },
      { id: "boss", name: "Avery Lane", roles: ["admin", "manager"] }, { id: "drew", name: "Drew Harper", roles: ["recruiter"], manager: "gone" },
    ] };
    const { managers, leads } = teams(acc);
    expect([...managers]).toEqual([["morgan", "Morgan Ellis"], ["lee", "Sam Lee"]]);
    expect([...leads]).toEqual([["lee", "lee"], ["casey", "morgan"]]);
  });

  it("never echoes what ?team=, ?sort= or ?rec= say", async () => {
    const { env, admin } = await setup();
    const html = await page(env, admin, `/admin/desk?r=30&team=${encodeURIComponent('"><script>a</script>')}&sort=${encodeURIComponent("<img src=x>")}&rec=${encodeURIComponent('"><b>x')}`);
    for (const bad of ["<script>a", "<img src=x>", '"><b>x']) expect(html).not.toContain(bad);
    expect(html).toContain('aria-sort="descending" class="sorted"');
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

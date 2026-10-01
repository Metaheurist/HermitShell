import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { jobHash } from "../src/docs.js";
import { FIELDS, scoreTone, sentPage, splitStats, statsPage, totals, validStats, windowFor, zonedToday } from "../src/stats.js";
import { BASE, keysWith, styled, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const STATUS = {
  timezone: "Europe/London",
  profiles: [
    { id: "riley-chen", name: "Riley Chen", email: "riley@example.com", status: "active", has_cv: true, job: { currency: "£" } },
    { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false, recruit: "" },
    { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true, job: { currency: "£" } },
  ],
};

function row(values) {
  return FIELDS.map((f) => values[f] || 0);
}

function daysAgo(n) {
  const today = zonedToday("Europe/London");
  return new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
}

function sample() {
  return {
    v: 1, today: daysAgo(0), since: daysAgo(80),
    days: {
      [daysAgo(0)]: row({ scanned: 120, rated: 10, sent: 4, fit_sum: 30, fit_n: 4, strong: 2, runs: 1, applied: 1, interested: 2 }),
      [daysAgo(3)]: row({ scanned: 80, rated: 6, sent: 2, fit_sum: 14, fit_n: 2, runs: 1, good_match: 1, cover_letter: 1 }),
      [daysAgo(40)]: row({ scanned: 50, rated: 5, sent: 1, fit_sum: 6, fit_n: 1, runs: 1 }),
    },
    ranges: {
      30: { employers: [["Northwind <script>alert(1)</script>", 3], ["Contoso", 2]], sources: [["reed.co.uk", 4]],
        modes: [["Hybrid", 3], ["Remote", 1]], fit: [0, 0, 0, 0, 0, 1, 2, 3, 2, 1, 0], salary: 52000,
        best: [{ title: "Data Engineer <img src=x>", employer: "Fabrikam", fit: 9, day: daysAgo(3) }] },
    },
    pipeline: { applied: 2, heard_back: 1, rejected: 1, interested: 3 },
    sent: [
      { title: "Data Engineer", employer: "Northwind", location: "York", mode: "Hybrid", salary: "£55,000", fit: 9, day: daysAgo(0),
        source: "reed.co.uk", url: "https://jobs.example.com/1", answer: "applied" },
      { title: "Analytics Engineer", employer: "Contoso", location: "Leeds", mode: "Remote", salary: "", fit: 7, day: daysAgo(0),
        source: "web search", url: "", answer: "" },
      { title: "BI Developer", employer: "Fabrikam", location: "", mode: "", salary: "", fit: null, day: daysAgo(3),
        source: "", url: "https://jobs.example.com/3", answer: "not_for_me" },
      { title: "Data Analyst", employer: "Tailspin Toys", location: "Hull", mode: "", salary: "", fit: 6, day: daysAgo(40),
        source: "", url: "https://jobs.example.com/4", answer: "interested" },
    ],
  };
}

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

function putStats(env, body, headers = API) {
  return worker.fetch(new Request(`${BASE}/api/stats`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), env);
}

async function setup() {
  const env = testEnv(ADMIN);
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify(STATUS) }), env);
  const res = await worker.fetch(post("/admin/login", { username: "admin", password: ADMIN.ADMIN_PASSWORD }, { "CF-Connecting-IP": "203.0.113.9" }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = async (path) => {
    const r = await worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
    return { res: r, body: await r.text() };
  };
  const csrf = (await get("/admin")).body.match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const act = (fields) => worker.fetch(post("/admin/action", { csrf, ...fields }, { Cookie: cookie }), env);
  return { env, get, act };
}

describe("time ranges", () => {
  it("splits 7 and 30 days into days, 90 days into weeks and 12 months into calendar months", () => {
    const week = windowFor(7, "2026-09-29");
    expect(week.days).toEqual(["2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"]);
    expect(week.buckets.map((b) => b.label)).toEqual(["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"]);
    expect(week.previous.at(-1)).toBe("2026-09-22");
    expect(windowFor(30, "2026-09-29").buckets).toHaveLength(30);
    const quarter = windowFor(90, "2026-09-29");
    expect(quarter.buckets).toHaveLength(13);
    expect(quarter.buckets.every((b) => b.days.length === 7)).toBe(true);
    const year = windowFor(365, "2026-09-29");
    expect(year.buckets.map((b) => b.label)).toEqual(["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"]);
    expect(year.days[0]).toBe("2025-10-01");
    expect(year.previous).toBeNull();
  });

  it("uses today's date in HermitShell's timezone", () => {
    const late = Date.parse("2026-09-28T23:30:00Z");
    expect(zonedToday("Europe/London", late)).toBe("2026-09-29");
    expect(zonedToday("UTC", late)).toBe("2026-09-28");
    expect(zonedToday("Not/AZone", late)).toBe("2026-09-28");
  });

  it("adds up a range and works out likes, letters and the average match", () => {
    const t = totals(sample(), windowFor(7, daysAgo(0)).days);
    expect(t).toMatchObject({ rated: 16, sent: 6, applied: 1, liked: 3, letters: 1, runs: 2 });
    expect(t.fit).toBeCloseTo(44 / 6);
  });
});

describe("stats page", () => {
  it("shows KPI tiles, charts and change against the period before", () => {
    const html = statsPage(STATUS, sample(), "riley-chen", "30");
    return html.text().then((body) => {
      expect(body).toContain("Riley Chen: stats");
      expect(body).toMatch(/kpi-num">16<\/div><div class="kpi-label">Rated/);
      expect(body).toMatch(/kpi-num">7\.3<small>\/10<\/small>/);
      expect(body).toContain('class="delta');
      expect(body).toContain("Median salary <b>£52k</b>");
      expect(body).toContain('aria-current="page">30 days');
      expect(body).toContain(">50%</text>");
      expect(body).not.toContain("<script>alert(1)</script>");
      expect(body).toContain("Northwind &lt;script&gt;");
      expect(body).not.toContain("<img src=x>");
    });
  });

  it("shows the median salary with the profile's currency symbol and icon", async () => {
    const withCurrency = (currency) => ({ ...STATUS, profiles: [{ ...STATUS.profiles[0], job: { currency } }] });
    const pound = await statsPage(STATUS, sample(), "riley-chen", "30").text();
    expect(pound).toMatch(/<svg [^>]*>[^<]*<path d="M3\.85[^"]*"\/><path d="M8 12h4M10 16V9\.5[^"]*"\/><\/svg><\/span>Median salary <b>£52k/);
    const euro = await statsPage(withCurrency("EUR"), sample(), "riley-chen", "30").text();
    expect(euro).toMatch(/<path d="M7 12h5M15 9\.4[^"]*"\/><\/svg><\/span>Median salary <b>€52k/);
    const plain = await statsPage(withCurrency(""), sample(), "riley-chen", "30").text();
    expect(plain).toMatch(/<rect width="20" height="12"[^>]*\/>.*<\/svg><\/span>Median salary <b>52k/);
    const odd = await statsPage(withCurrency("<b>"), sample(), "riley-chen", "30").text();
    expect(odd).toContain("Median salary <b>52k");
  });

  it("falls back to 30 days for an unknown range and has no arrows without earlier data", async () => {
    const body = await statsPage(STATUS, { ...sample(), since: daysAgo(3) }, "riley-chen", "9999").text();
    expect(body).toContain('aria-current="page">30 days');
    expect(body).not.toContain('class="delta');
  });

  it("explains when HermitShell hasn't sent stats and 404s for an unknown profile", async () => {
    expect(await statsPage(STATUS, null, "sam-lee", "7").text()).toContain("No stats yet");
    expect(statsPage(STATUS, sample(), "casey-quinn", "7").status).toBe(404);
  });

  it("colours match scores on one scale: green from 8, amber from 6, orange at 5, grey below", () => {
    expect([10, 8, 7, 6, 5, 4, 0].map(scoreTone)).toEqual(["green", "green", "amber", "amber", "orange", "slate", "slate"]);
  });

  it("draws best-match rings and score bars in the score's colour, with the top scores glowing", async () => {
    const body = await statsPage(STATUS, sample(), "riley-chen", "30").text();
    const best = body.slice(body.indexOf('class="best"'));
    const cards = [...best.matchAll(/<li class="k-(\w+)"[^>]*>[\s\S]*?<svg class="ring k-(\w+)( hot)?"[\s\S]*?<text class="val"[^>]*>(\d+)<\/text><text class="sub"[^>]*>\/ 10<\/text>/g)];
    expect(cards.length).toBeGreaterThan(0);
    for (const m of cards) {
      const fit = Number(m[4]);
      expect(m[1]).toBe(scoreTone(fit));
      expect(m[2]).toBe(scoreTone(fit));
      expect(Boolean(m[3])).toBe(fit >= 8);
    }
    expect(best).toMatch(/<svg class="ring k-green hot"/);
    const arcs = [...body.matchAll(/class="arc" cx="18" cy="18" r="15\.915" stroke-dasharray="([\d.]+) ([\d.]+)"/g)];
    expect(arcs.length).toBeGreaterThanOrEqual(2);
    for (const [, dash, gap] of arcs) {
      expect(Number(dash) + Number(gap)).toBeCloseTo(100, 5);
    }
    expect(body).toMatch(/class="bar score k-green"/);
    expect(body).not.toMatch(/class="bar score" fill=/);
    expect(body).toContain("@keyframes halo");
    expect(body).toContain(".ring.hot{animation:halo 2.6s ease-in-out 1.5s 2;");
    expect(body).not.toMatch(/\.ring[^{]*\{[^}]*infinite/);
    expect(styled(body)).toContain("prefers-reduced-motion");
  });

  it("gives every card a tinted icon badge and every chip a round icon", async () => {
    const body = await statsPage(STATUS, sample(), "riley-chen", "30").text();
    const heads = [...body.matchAll(/<h3><span class="ico sm k-(\w+)"><svg /g)].map((m) => m[1]);
    expect(heads.length).toBeGreaterThanOrEqual(6);
    expect(new Set(heads).size).toBeGreaterThan(3);
    expect(body).not.toMatch(/<h3><svg /);
    expect(body).toMatch(/<span class="ci"><svg /);
  });

  it("draws empty charts rather than failing on a profile with nothing yet", async () => {
    const body = await statsPage(STATUS, { v: 1, days: {}, ranges: {}, pipeline: {} }, "sam-lee", "90").text();
    expect(body).toContain("Nothing in this period yet");
    expect(body).toContain("No jobs rated yet");
  });
});

const MORE = {
  closing: daysAgo(-2), type: "Full-time permanent", seniority: "Mid", published: "2 days ago", confidence: 80, coverage: 65,
  reasoning: "Strong SQL and Python overlap with the CV.", about: "Northwind makes kitchen tools.", profile: "Manufacturer",
  site: "https://www.northwind.example.com/about", company: "Contoso Recruitment", matched: ["Python", "SQL"], gaps: ["dbt"],
};

function detailed() {
  const s = sample();
  s.sent[0] = { ...s.sent[0], key: "https://jobs.example.com/1", more: MORE };
  s.sent[1] = { ...s.sent[1], key: "nijobs:1234567" };
  return s;
}

const sentOf = async (stats, pid, opts) => (await sentPage(STATUS, stats, pid, opts)).text();

describe("jobs sent page", () => {
  it("lists the jobs sent in the range, newest day first, with their score, details, answer and advert link", async () => {
    const body = await sentOf(sample(), "sam-lee", { range: "7" });
    expect(body).toContain("Jobs sent to Sam Lee");
    expect(body).toContain('aria-current="page">7 days');
    expect(body.indexOf("Data Engineer")).toBeLessThan(body.indexOf("BI Developer"));
    expect(body).not.toContain("Data Analyst");
    expect(body).toContain('<a class="advert" href="https://jobs.example.com/1" target="_blank" rel="noopener noreferrer nofollow">View the advert on jobs.example.com');
    expect(body).toContain("<b>Analytics Engineer</b>");
    expect(body).toContain("Northwind &middot; York &middot; Hybrid &middot; £55,000");
    expect(body).toMatch(/class="answer"[^>]*>Applied</);
    expect(body).toMatch(/2 jobs<\/span>/);
    expect(body).toContain(">All <b>3</b>");
    expect(body).toContain(">No answer yet <b>1</b>");
    expect(body).toContain('href="/admin/stats?u=sam-lee"');
    expect(body).toContain('href="/admin/profile?u=sam-lee"');
  });

  it("filters by answer, keeps the filter across ranges and says when nothing matches", async () => {
    const applied = await sentOf(sample(), "riley-chen", { range: "30", answer: "applied" });
    expect(applied).toContain("Jobs sent to Riley Chen");
    expect(applied).toContain("Data Engineer");
    expect(applied).not.toContain("Analytics Engineer");
    expect(applied).toContain('href="/admin/sent?u=riley-chen&amp;r=90&amp;a=applied"');
    const none = await sentOf(sample(), "riley-chen", { range: "30", answer: "none" });
    expect(none).toContain("Analytics Engineer");
    expect(none).not.toContain(">Data Engineer<");
    const nothing = await sentOf(sample(), "riley-chen", { range: "7", answer: "heard_back" });
    expect(nothing).toContain("No job sent in this period has that answer.");
    const odd = await sentOf(sample(), "riley-chen", { range: "365", answer: "bogus" });
    expect(odd).toContain('aria-current="page">30 days');
    expect(odd).toContain(">All <b>3</b>");
  });

  it("explains an empty list and 404s for an unknown profile", async () => {
    expect(await sentOf(null, "sam-lee", { range: "7" })).toContain("HermitShell sends the list");
    expect(await sentOf({ days: {} }, "sam-lee", { range: "7" })).toContain("No jobs were sent in this period.");
    expect((await sentPage(STATUS, sample(), "casey-quinn", { range: "7" })).status).toBe(404);
  });

  it("opens each job, when pressed, to everything its email card showed", async () => {
    const body = await sentOf(detailed(), "sam-lee", { range: "7" });
    expect(body).toMatch(/<details><summary><svg class="ring k-green hot"[\s\S]*?<b>Data Engineer<\/b>[\s\S]*?<span class="chev"/);
    expect(body).not.toContain("<details open");
    for (const part of ["Closes in 2 days", "Full-time permanent", "Hybrid", "Mid", "Posted 2 days ago", "HermitShell fit</span><b>9/10",
      "Confidence</span><b>80%", "CV keyword match</span><b>65%", '<p class="why">Strong SQL and Python overlap with the CV.</p>',
      "About the company", "<b>Northwind</b> &middot; Manufacturer", 'href="https://www.northwind.example.com/about"',
      'northwind.example.com<svg class="ext"', "Northwind makes kitchen tools.", "Advertised by <b>Contoso Recruitment</b>",
      "Strongest matches with the CV", "<span>Python</span><span>SQL</span>", "Missing from the CV", "<span>dbt</span>",
      '<div class="salary">']) {
      expect(body).toContain(part);
    }
    expect(body).toContain("Salary not listed");
  });

  it("draws each salary's icon from its own symbol, else the profile's currency", async () => {
    const s = sample();
    s.sent[1] = { ...s.sent[1], salary: "C$90,000 a year" };
    s.sent[2] = { ...s.sent[2], salary: "55,000 a year" };
    const body = await sentOf(s, "sam-lee", { range: "7" });
    const icons = [...body.matchAll(/<div class="salary"><svg [^>]*>(.*?)<\/svg><b>([^<]*)<\/b>/g)].map((m) => [m[2], m[1]]);
    expect(icons.map(([t]) => t)).toEqual(["£55,000", "C$90,000 a year", "55,000 a year"]);
    expect(icons[0][1]).toContain("M8 12h4M10 16V9.5");
    expect(icons[1][1]).toContain("M16 8h-6a2 2 0 1 0 0 4h4");
    expect(icons[2][1]).toContain("M8 12h4M10 16V9.5");
  });

  it("draws its arrows as icons, never as arrow characters", async () => {
    const pages = [await sentOf(detailed(), "sam-lee", { range: "7", open: "n0" }), await (await statsPage(STATUS, sample(), "sam-lee", "30")).text()];
    for (const body of pages) {
      expect(body).toContain('<a class="back" href="/admin"><svg ');
      expect(body).not.toMatch(/&larr;|&rarr;|&#8599;|&#8592;|&#8594;|&nearr;|[\u2190-\u21ff]/);
    }
  });

  it("offers each job's cover letter and tailored CV: Generate, then Download and Regenerate, and a spinner while one is made", async () => {
    const h = await jobHash("https://jobs.example.com/1");
    const other = await jobHash("nijobs:1234567");
    const docs = [{ k: "cover_letter", h, name: "Cover letter.pdf", at: Date.now() - 3600000, exp: Date.now() + 86400000 }];
    const pending = new Map([["tailored_cv\nnijobs:1234567", "make"]]);
    const body = await sentOf(detailed(), "sam-lee", { range: "7", csrf: "c".repeat(32), docs, pending, open: h.slice(0, 16), done: "doc" });
    expect(body).toContain(`<li id="job-${h.slice(0, 16)}"`);
    expect(body).toContain(`<li id="job-${h.slice(0, 16)}" style="animation-delay:0ms"><details open>`);
    expect(body).toContain(`href="/admin/doc?u=sam-lee&amp;k=cover_letter&amp;h=${h}" download>Download</a>`);
    expect(body).toMatch(/name="k" value="cover_letter">[\s\S]*?name="fresh" value="1">[\s\S]*?>Regenerate</);
    expect(body).toMatch(/name="k" value="cover_letter">[^]*?name="send" value="1"><button class="small quiet" title="Email this cover letter to Sam">Email to Sam</);
    expect(body).toMatch(/name="k" value="tailored_cv">[\s\S]*?<button class="small">Generate<\/button>/);
    expect(body).toContain('name="j" value="https://jobs.example.com/1"');
    expect(body).toContain(`name="csrf" value="${"c".repeat(32)}"`);
    expect(body).toContain('name="back" value="r=7"');
    expect(body).toContain('name="n" value="Data Engineer at Northwind"');
    expect(body).toMatch(new RegExp(`<li id="job-${other.slice(0, 16)}"[\\s\\S]*?class="doc busy"[\\s\\S]*?Tailored CV`));
    expect(body).toContain("HermitShell is making it.");
    expect(body).not.toContain('http-equiv="refresh"');
    expect(body.match(/<li id="job-n\d+"[\s\S]*?<\/li>/)[0]).not.toContain('class="doc');
    const waiting = await sentOf(detailed(), "sam-lee", { range: "7", pending, open: other.slice(0, 16) });
    expect(waiting).toContain('<meta http-equiv="refresh" content="15">');
    expect(waiting).toContain(`<li id="job-${other.slice(0, 16)}" style="animation-delay:35ms"><details open>`);
    expect(waiting).toContain("Being made&hellip;");
    const emailing = await sentOf(detailed(), "sam-lee", { range: "7", pending: new Map([["tailored_cv\nnijobs:1234567", "send"]]) });
    expect(emailing).toContain("<b>Tailored CV</b><small>Emailing to Sam&hellip;</small>");
  });

  it("turns each missing skill into a button that adds it, and ticks those counted or being added", async () => {
    const s = detailed();
    s.sent[0].more = { ...MORE, gaps: ["dbt", "Airflow", "Power BI", "<>"] };
    const h = await jobHash("https://jobs.example.com/1");
    const body = await sentOf({ ...s, skills: ["airflow"] }, "sam-lee", { range: "7", csrf: "c".repeat(32),
      added: [{ s: "Power BI", at: Date.now() }, { s: "Airflow", at: Date.now() }] });
    const gaps = body.match(/<div class="skills gap">[\s\S]*?<\/small><\/div>/)[0];
    expect(gaps).toMatch(/<form method="post" action="\/admin\/skill">[\s\S]*?name="s" value="dbt">[\s\S]*?<button title="Add dbt to the skills on the CV"><svg [^>]*>.*?<\/svg>dbt<\/button><\/form>/);
    expect(gaps).toContain('name="u" value="sam-lee"');
    expect(gaps).toContain('name="j" value="https://jobs.example.com/1"');
    expect(gaps).toContain(`name="csrf" value="${"c".repeat(32)}"`);
    expect(gaps).toContain('name="back" value="r=7"');
    expect(gaps).toMatch(/<span class="added" title="Counted as on the CV"><svg [^>]*>.*?<\/svg>Airflow<\/span>/);
    expect(gaps).toMatch(/<span class="adding" title="Added\. HermitShell counts it from its next check-in"><svg [^>]*>.*?<\/svg>Power BI<\/span>/);
    expect(gaps).toContain("<span>&lt;&gt;</span>");
    expect(gaps).toContain("Press a skill they have to count it as on the CV.");
    expect(body).toContain(`<li id="job-${h.slice(0, 16)}"`);
    const added = await sentOf(s, "riley-chen", { range: "7", csrf: "c".repeat(32), done: "skill" });
    expect(added).not.toContain("Press a skill you have");
    expect(added).toContain("Press a skill they have to count it as on the CV.");
    expect(added).toContain("Added. HermitShell counts it as on the CV within a few minutes");
    const noForm = await sentOf(s, "sam-lee", { range: "7" });
    expect(noForm).not.toContain('action="/admin/skill"');
    expect(noForm).toContain("<span>dbt</span>");
  });

  it("reads the jobs with their details when they are kept apart from the stats", async () => {
    const { stats, sent } = splitStats(detailed());
    expect(stats.sent[0].more).toBeUndefined();
    expect(stats.sent[0].key).toBe("https://jobs.example.com/1");
    expect(sent.jobs[0].more.reasoning).toBe(MORE.reasoning);
    expect(sent.board).toBeNull();
    expect(await sentOf(stats, "sam-lee", { range: "7" })).not.toContain("Strong SQL");
    expect(await sentOf(stats, "sam-lee", { range: "7", sent: sent.jobs })).toContain("Strong SQL");
  });
});

describe("stats from HermitShell", () => {
  it("stores and removes a profile's stats and shows them behind the dashboard's Stats link", async () => {
    const { env, get } = await setup();
    expect((await putStats(env, { u: "riley-chen", stats: sample() })).status).toBe(200);
    expect(JSON.parse(env.FEEDBACK.store.get("stats:riley-chen")).updated).toBeGreaterThan(0);
    const dashboard = (await get("/admin")).body;
    expect(dashboard).toContain('href="/admin/stats?u=riley-chen"');
    expect(dashboard).toMatch(/<a class="statlink" href="\/admin\/sent\?u=riley-chen&amp;r=7"[^>]*><b>6<\/b> sent<\/a>/);
    expect(dashboard).toMatch(/<a class="statlink" href="\/admin\/stats\?u=riley-chen"[^>]*><svg class="mini"/);
    expect(dashboard).toContain('href="/admin/stats?u=sam-lee"');
    expect(dashboard).not.toContain('href="/admin/sent?u=sam-lee');
    const stats = (await get("/admin/stats?u=riley-chen&r=7")).body;
    expect(stats).toContain("Riley Chen: stats");
    expect(stats).toContain('href="/admin/sent?u=riley-chen&amp;r=7"');
    expect((await get("/admin/sent?u=riley-chen&r=7")).body).toContain("Jobs sent to Riley Chen");
    expect((await get("/admin/sent?u=../owner")).res.status).toBe(404);
    expect((await get("/admin/profile?u=riley-chen")).body).toContain('href="/admin/stats?u=riley-chen"');
    expect((await putStats(env, { u: "riley-chen", stats: null })).status).toBe(200);
    expect(keysWith(env, "stats:")).toEqual([]);
  });

  it("drops a profile's stats when it is deleted from the dashboard", async () => {
    const { env, act } = await setup();
    await putStats(env, { u: "sam-lee", stats: sample() });
    await env.FEEDBACK.put("skilladd:sam-lee", JSON.stringify([{ s: "dbt", at: Date.now() }]));
    await act({ action: "delete", u: "sam-lee", confirm: "yes" });
    expect(keysWith(env, "stats:")).toEqual([]);
    expect(keysWith(env, "skilladd:")).toEqual([]);
  });

  it("accepts only well-formed stats", () => {
    expect(validStats(sample())).toBe(true);
    expect(validStats({ days: {} })).toBe(true);
    expect(validStats({ days: {}, skills: ["dbt", "Power BI"] })).toBe(true);
    for (const bad of [null, [], "x", { days: [] }, { days: { yesterday: [1] } }, { days: { "2026-09-29": ["1"] } },
      { days: { "2026-09-29": [Infinity] } }, { days: { "2026-09-29": new Array(41).fill(0) } }, { ranges: [] }, { pipeline: [] },
      { sent: {} }, { sent: [null] }, { sent: ["job"] }, { sent: new Array(201).fill({}) }, { skills: "dbt" }, { skills: [1] },
      { skills: ["x".repeat(61)] }, { skills: new Array(201).fill("dbt") }]) {
      expect(validStats(bad)).toBe(false);
    }
  });
});

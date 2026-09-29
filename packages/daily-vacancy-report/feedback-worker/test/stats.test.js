import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { jobHash } from "../src/docs.js";
import { FIELDS, sentPage, splitStats, statsPage, totals, validStats, windowFor, zonedToday } from "../src/stats.js";
import { BASE, keysWith, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const STATUS = {
  timezone: "Europe/London",
  profiles: [
    { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, has_cv: true, job: { currency: "£" } },
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
    const html = statsPage(STATUS, sample(), "owner", "30");
    return html.text().then((body) => {
      expect(body).toContain("Your stats");
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

  it("falls back to 30 days for an unknown range and has no arrows without earlier data", async () => {
    const body = await statsPage(STATUS, { ...sample(), since: daysAgo(3) }, "owner", "9999").text();
    expect(body).toContain('aria-current="page">30 days');
    expect(body).not.toContain('class="delta');
  });

  it("explains when HermitShell hasn't sent stats and 404s for an unknown profile", async () => {
    expect(await statsPage(STATUS, null, "sam-lee", "7").text()).toContain("No stats yet");
    expect(statsPage(STATUS, sample(), "casey-quinn", "7").status).toBe(404);
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
    const applied = await sentOf(sample(), "owner", { range: "30", answer: "applied" });
    expect(applied).toContain("Jobs sent to you");
    expect(applied).toContain("Data Engineer");
    expect(applied).not.toContain("Analytics Engineer");
    expect(applied).toContain('href="/admin/sent?u=owner&amp;r=90&amp;a=applied"');
    const none = await sentOf(sample(), "owner", { range: "30", answer: "none" });
    expect(none).toContain("Analytics Engineer");
    expect(none).not.toContain(">Data Engineer<");
    const nothing = await sentOf(sample(), "owner", { range: "7", answer: "heard_back" });
    expect(nothing).toContain("No job sent in this period has that answer.");
    const odd = await sentOf(sample(), "owner", { range: "365", answer: "bogus" });
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
    expect(body).toMatch(/<details><summary><svg class="ring"[\s\S]*?<b>Data Engineer<\/b>[\s\S]*?<span class="chev"/);
    expect(body).not.toContain("<details open");
    for (const part of ["Closes in 2 days", "Full-time permanent", "Hybrid", "Mid", "Posted 2 days ago", "HermitShell fit</span><b>9/10",
      "Confidence</span><b>80%", "CV keyword match</span><b>65%", '<p class="why">Strong SQL and Python overlap with the CV.</p>',
      "About the company", "<b>Northwind</b> &middot; Manufacturer", 'href="https://www.northwind.example.com/about"',
      "northwind.example.com &#8599;", "Northwind makes kitchen tools.", "Advertised by <b>Contoso Recruitment</b>",
      "Strongest matches with the CV", "<span>Python</span><span>SQL</span>", "Missing from the CV", "<span>dbt</span>",
      '<div class="salary">']) {
      expect(body).toContain(part);
    }
    expect(body).toContain("Salary not listed");
  });

  it("offers each job's cover letter and tailored CV: Generate, then Download and Regenerate, and a spinner while one is made", async () => {
    const h = await jobHash("https://jobs.example.com/1");
    const other = await jobHash("nijobs:1234567");
    const docs = [{ k: "cover_letter", h, name: "Cover letter.pdf", at: Date.now() - 3600000, exp: Date.now() + 86400000 }];
    const pending = new Set(["tailored_cv\nnijobs:1234567"]);
    const body = await sentOf(detailed(), "sam-lee", { range: "7", csrf: "c".repeat(32), docs, pending, open: h.slice(0, 16), done: "doc" });
    expect(body).toContain(`<li id="job-${h.slice(0, 16)}"`);
    expect(body).toContain(`<li id="job-${h.slice(0, 16)}" style="animation-delay:0ms"><details open>`);
    expect(body).toContain(`href="/admin/doc?u=sam-lee&amp;k=cover_letter&amp;h=${h}" download>Download</a>`);
    expect(body).toMatch(/name="k" value="cover_letter">[\s\S]*?name="fresh" value="1">[\s\S]*?>Regenerate</);
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
  });

  it("reads the jobs with their details when they are kept apart from the stats", async () => {
    const { stats, sent } = splitStats(detailed());
    expect(stats.sent[0].more).toBeUndefined();
    expect(stats.sent[0].key).toBe("https://jobs.example.com/1");
    expect(sent[0].more.reasoning).toBe(MORE.reasoning);
    expect(await sentOf(stats, "sam-lee", { range: "7" })).not.toContain("Strong SQL");
    expect(await sentOf(stats, "sam-lee", { range: "7", sent })).toContain("Strong SQL");
  });
});

describe("stats from HermitShell", () => {
  it("stores and removes a profile's stats and shows them behind the dashboard's Stats link", async () => {
    const { env, get } = await setup();
    expect((await putStats(env, { u: "owner", stats: sample() })).status).toBe(200);
    expect(JSON.parse(env.FEEDBACK.store.get("stats:owner")).updated).toBeGreaterThan(0);
    const dashboard = (await get("/admin")).body;
    expect(dashboard).toContain('href="/admin/stats?u=owner"');
    expect(dashboard).toMatch(/<a class="statlink" href="\/admin\/sent\?u=owner&amp;r=7"[^>]*><b>6<\/b> sent<\/a>/);
    expect(dashboard).toMatch(/<a class="statlink" href="\/admin\/stats\?u=owner"[^>]*><svg class="mini"/);
    expect(dashboard).toContain('href="/admin/stats?u=sam-lee"');
    expect(dashboard).not.toContain('href="/admin/sent?u=sam-lee');
    const stats = (await get("/admin/stats?u=owner&r=7")).body;
    expect(stats).toContain("Your stats");
    expect(stats).toContain('href="/admin/sent?u=owner&amp;r=7"');
    expect((await get("/admin/sent?u=owner&r=7")).body).toContain("Jobs sent to you");
    expect((await get("/admin/sent?u=../owner")).res.status).toBe(404);
    expect((await get("/admin/profile?u=owner")).body).toContain('href="/admin/stats?u=owner"');
    expect((await putStats(env, { u: "owner", stats: null })).status).toBe(200);
    expect(keysWith(env, "stats:")).toEqual([]);
  });

  it("drops a profile's stats when it is deleted from the dashboard", async () => {
    const { env, act } = await setup();
    await putStats(env, { u: "sam-lee", stats: sample() });
    await act({ action: "delete", u: "sam-lee", confirm: "yes" });
    expect(keysWith(env, "stats:")).toEqual([]);
  });

  it("accepts only well-formed stats", () => {
    expect(validStats(sample())).toBe(true);
    expect(validStats({ days: {} })).toBe(true);
    for (const bad of [null, [], "x", { days: [] }, { days: { yesterday: [1] } }, { days: { "2026-09-29": ["1"] } },
      { days: { "2026-09-29": [Infinity] } }, { days: { "2026-09-29": new Array(41).fill(0) } }, { ranges: [] }, { pipeline: [] },
      { sent: {} }, { sent: [null] }, { sent: ["job"] }, { sent: new Array(201).fill({}) }]) {
      expect(validStats(bad)).toBe(false);
    }
  });
});

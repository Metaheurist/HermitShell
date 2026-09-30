// Cover letters and tailored CVs kept for download: from HermitShell (POST /api/doc) to the dashboard's list of
// jobs sent and the email button's confirmation page.
import { describe, expect, it } from "vitest";
import worker, { sign } from "../src/index.js";
import { DOC_STYLE, jobHash } from "../src/docs.js";
import { today } from "../src/lib.js";
import { BASE, keysWith, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const PDF = new TextEncoder().encode("%PDF-1.4\nA letter for Northwind\n%%EOF");
const STATUS = {
  timezone: "Europe/London",
  profiles: [
    { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active" },
    { id: "riley-chen", name: "Riley Chen", email: "riley@example.com", status: "active" },
    { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false, recruit: "riley-chen" },
  ],
};
const JOB = "https://jobs.example.com/1";

function upload(env, { u = "sam-lee", j = JOB, k = "cover_letter", days = "7", name = "Cover letter - Sam Lee - Data Engineer.pdf" } = {},
  body = PDF, headers = API) {
  const q = new URLSearchParams({ u, j, k, days, name });
  return worker.fetch(new Request(`${BASE}/api/doc?${q}`, { method: "POST", headers: { ...headers, "Content-Type": "application/pdf" }, body }), env);
}

async function setup() {
  const env = testEnv(ADMIN);
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify(STATUS) }), env);
  const login = await worker.fetch(new Request(`${BASE}/admin/login`, { method: "POST",
    body: new URLSearchParams({ username: "admin", password: ADMIN.ADMIN_PASSWORD }), headers: { "CF-Connecting-IP": "203.0.113.40" } }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const get = (path) => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
  const csrf = (await (await get("/admin")).text()).match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const ask = (fields) => worker.fetch(new Request(`${BASE}/admin/doc`, { method: "POST", headers: { Cookie: cookie },
    body: new URLSearchParams({ csrf, u: "sam-lee", j: JOB, k: "cover_letter", n: "Data Engineer at Northwind", back: "r=30&a=applied", ...fields }) }), env);
  return { env, get, ask, csrf, cookie };
}

async function link(action, key, title, profile = "") {
  const d = String(today());
  const t = await sign("test-secret", key, action, title, "", profile, d);
  return new URLSearchParams({ j: key, a: action, n: title, ...(profile ? { u: profile } : {}), d, t }).toString();
}

describe("letters and CVs from HermitShell", () => {
  it("are kept encrypted, listed for the profile and downloaded from the dashboard as the PDF they were", async () => {
    const { env, get } = await setup();
    expect((await upload(env)).status).toBe(200);
    const h = await jobHash(JOB);
    const stored = new Uint8Array(env.FEEDBACK.store.get(`doc:sam-lee:cover_letter:${h}`));
    expect(new TextDecoder().decode(stored)).not.toContain("Northwind");
    const [entry] = JSON.parse(env.FEEDBACK.store.get("docs:sam-lee"));
    expect(entry).toMatchObject({ k: "cover_letter", h, name: "Cover letter - Sam Lee - Data Engineer.pdf" });
    expect(entry.exp - entry.at).toBe(7 * 86400000);
    const res = await get(`/admin/doc?u=sam-lee&k=cover_letter&h=${h}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain('attachment; filename="Cover letter - Sam Lee - Data Engineer.pdf"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
  });

  it("replace the one kept for the same job and kind, and keep the other kind beside it", async () => {
    const { env } = await setup();
    await upload(env);
    await upload(env, { name: "Newer.pdf" });
    await upload(env, { k: "tailored_cv", name: "CV.pdf" });
    const index = JSON.parse(env.FEEDBACK.store.get("docs:sam-lee"));
    expect(index.map((d) => [d.k, d.name])).toEqual([["cover_letter", "Newer.pdf"], ["tailored_cv", "CV.pdf"]]);
  });

  it("show on the job in the list of jobs sent, with Download and Regenerate", async () => {
    const { env, get } = await setup();
    const stats = { days: {}, sent: [{ title: "Data Engineer", employer: "Northwind", day: new Date().toISOString().slice(0, 10), fit: 8, key: JOB,
      more: { reasoning: "Good overlap." } }] };
    await worker.fetch(new Request(`${BASE}/api/stats`, { method: "POST", headers: API, body: JSON.stringify({ u: "sam-lee", stats }) }), env);
    await upload(env);
    const body = await (await get("/admin/sent?u=sam-lee&r=7")).text();
    expect(body).toContain("Good overlap.");
    expect(body).toMatch(/Cover letter<\/b><small[^>]*>made just now<\/small>[\s\S]*?>Download<\/a>[\s\S]*?>Regenerate</);
    expect(body).toMatch(/Tailored CV<\/b><small>for this job<\/small>[\s\S]*?>Generate</);
    expect(JSON.parse(env.FEEDBACK.store.get("stats:sam-lee")).sent[0].more).toBeUndefined();
    expect(JSON.parse(env.FEEDBACK.store.get("sent:sam-lee"))[0].more.reasoning).toBe("Good overlap.");
  });

  it("send you back to the job when one is no longer kept", async () => {
    const { get } = await setup();
    const h = await jobHash(JOB);
    const res = await get(`/admin/doc?u=sam-lee&k=cover_letter&h=${h}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/admin/sent?u=sam-lee&r=7&open=${h.slice(0, 16)}&done=docgone#job-${h.slice(0, 16)}`);
  });
});

describe("asking for a letter or CV from the dashboard", () => {
  it("keeps the loading circle round: the rule that stretches a document's text does not reach it", () => {
    expect(DOC_STYLE).toMatch(/\.dspin\{flex:none;width:22px;height:22px/);
    expect(DOC_STYLE).not.toMatch(/\.doc span\{[^}]*flex:1/);
  });

  it("stores the request as an email button would, kept for download rather than emailed, and opens the job again", async () => {
    const { env, ask, get } = await setup();
    const res = await ask({});
    const h = await jobHash(JOB);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/admin/sent?u=sam-lee&r=30&a=applied&open=${h.slice(0, 16)}&done=doc#job-${h.slice(0, 16)}`);
    const [event] = valuesWith(env, "event:sam-lee:");
    expect(event).toMatchObject({ j: JOB, a: "cover_letter", r: "", u: "sam-lee", via: "dashboard" });
    expect(event.fresh).toBeUndefined();
    expect(event.id).toMatch(/^event:sam-lee:dash-[0-9a-f]{20}:cg\d+$/);
    expect(env.FEEDBACK.store.get("flag:events:sam-lee")).toBe("1");
    const [held] = JSON.parse(env.FEEDBACK.store.get("tasks:requests"));
    expect(held).toMatchObject({ id: event.id, a: "cover_letter", j: JOB, via: "dashboard", n: "Data Engineer at Northwind" });
    expect(await (await get("/admin/tasks")).text()).toContain("from the dashboard");
    const page = await (await get(`/admin/sent?u=sam-lee&r=30&open=${h.slice(0, 16)}&done=doc`)).text();
    expect(page).toContain("HermitShell is making it.");
  });

  it("asks for a new one with Regenerate, makes one request for a double press, and never for the admin", async () => {
    const { env, ask } = await setup();
    await ask({ fresh: "1" });
    await ask({ fresh: "1" });
    const events = valuesWith(env, "event:sam-lee:");
    expect(events).toHaveLength(1);
    expect(events[0].fresh).toBe(1);
    expect(events[0].id).toMatch(/:cn\d+$/);
    expect((await ask({ u: "owner", k: "tailored_cv" })).headers.get("Location")).toContain("done=docbad");
    expect(keysWith(env, "event:_:")).toEqual([]);
    expect(keysWith(env, "event:owner:")).toEqual([]);
  });

  it("emails the kept one with its Email button, and says so on the job and in the history", async () => {
    const { env, ask, get } = await setup();
    await sentWith(env);
    await upload(env);
    const h = await jobHash(JOB);
    const res = await ask({ send: "1" });
    expect(res.headers.get("Location")).toBe(`/admin/sent?u=sam-lee&r=30&a=applied&open=${h.slice(0, 16)}&done=docmail#job-${h.slice(0, 16)}`);
    const [event] = valuesWith(env, "event:sam-lee:");
    expect(event).toMatchObject({ a: "cover_letter", via: "dashboard", send: 1 });
    expect(event.fresh).toBeUndefined();
    expect(event.id).toMatch(/:ce\d+$/);
    const [held] = JSON.parse(env.FEEDBACK.store.get("tasks:requests"));
    expect(held).toMatchObject({ id: event.id, send: 1 });
    const page = await (await get(`/admin/sent?u=sam-lee&r=7&open=${h.slice(0, 16)}&done=docmail`)).text();
    expect(page).toContain("the same PDF you can download");
    expect(page).toContain("<b>Cover letter</b><small>Emailing to Sam&hellip;</small>");
    const [entry] = valuesWith(env, "history:sam-lee:").flat();
    expect(entry).toMatchObject({ k: "cover_letter", t: "Emailed the cover letter: Data Engineer at Northwind" });
  });

  it("does not email when Regenerate or a job email carries the Email flag", async () => {
    const { env, ask } = await setup();
    await ask({ fresh: "1", send: "1" });
    await ask({ k: "send_job", send: "1" });
    const events = valuesWith(env, "event:sam-lee:");
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.send === undefined)).toBe(true);
    expect(events.map((e) => e.id.match(/:([a-z]{2})\d+$/)[1]).sort()).toEqual(["cn", "mg"]);
  });

  it("refuses a bad job, kind or profile without storing anything", async () => {
    const { env, ask } = await setup();
    for (const fields of [{ k: "applied" }, { j: "" }, { j: "x".repeat(301) }, { j: "a\nb" }, { u: "casey-quinn" }, { n: "x".repeat(201) }]) {
      const res = await ask(fields);
      expect(res.status).toBe(303);
      expect(res.headers.get("Location")).toContain("done=docbad");
    }
    expect((await ask({ u: "../owner" })).status).toBe(400);
    expect(keysWith(env, "event:")).toEqual([]);
  });
});

describe("the email button when one was made", () => {
  it("offers the kept PDF to download and a new one to be written", async () => {
    const { env } = await setup();
    await upload(env);
    const q = await link("cover_letter", JOB, "Data Engineer", "sam-lee");
    const body = await (await worker.fetch(new Request(`${BASE}/f?${q}`), env)).text();
    expect(body).toContain("Your cover letter is ready");
    const href = body.match(/href="(\/f\/doc\?[^"]+)" download>Download PDF<\/a>/)[1].replaceAll("&amp;", "&");
    expect(Object.fromEntries(new URL(href, BASE).searchParams)).toEqual(Object.fromEntries(new URLSearchParams(q)));
    expect(body).toContain('<input type="hidden" name="fresh" value="1">');
    expect(body).toContain("Confirm: write a new cover letter");
    const res = await worker.fetch(new Request(`${BASE}/f/doc?${q}`), env);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
  });

  it("writes a new one only when asked, and the plain form still shows when none is kept", async () => {
    const { env } = await setup();
    const q = await link("tailored_cv", JOB, "Data Engineer", "sam-lee");
    const plain = await (await worker.fetch(new Request(`${BASE}/f?${q}`), env)).text();
    expect(plain).toContain("Guidance for the CV");
    expect(plain).not.toContain("is ready");
    const form = new URLSearchParams(q);
    form.set("r", "");
    await worker.fetch(new Request(`${BASE}/f`, { method: "POST", body: form }), env);
    form.set("fresh", "1");
    const saved = await (await worker.fetch(new Request(`${BASE}/f`, { method: "POST", body: form }), env)).text();
    expect(saved).toContain("tailoring your CV to this job again");
    const events = valuesWith(env, "event:sam-lee:").sort((a, b) => Number(Boolean(a.fresh)) - Number(Boolean(b.fresh)));
    expect(events).toHaveLength(2);
    expect(events[0].fresh).toBeUndefined();
    expect(events[1].fresh).toBe(1);
  });

  it("uses the documents of the recruit the admin's job search moved to for old links, which carry no profile", async () => {
    const { env } = await setup();
    await upload(env, { u: "owner" });
    const q = await link("cover_letter", JOB, "Data Engineer");
    expect(await (await worker.fetch(new Request(`${BASE}/f?${q}`), env)).text()).not.toContain("is ready");
    await upload(env, { u: "riley-chen" });
    expect(await (await worker.fetch(new Request(`${BASE}/f?${q}`), env)).text()).toContain("Your cover letter is ready");
    expect((await worker.fetch(new Request(`${BASE}/f/doc?${q}`), env)).status).toBe(200);
  });
});

function emailed(env, { u = "sam-lee", j = JOB } = {}, headers = API) {
  return worker.fetch(new Request(`${BASE}/api/emailed?${new URLSearchParams({ u, j })}`, { method: "POST", headers }), env);
}

async function sentWith(env, u = "sam-lee") {
  const stats = { days: {}, sent: [{ title: "Data Engineer", employer: "Northwind", day: new Date().toISOString().slice(0, 10), fit: 8, key: JOB }] };
  await worker.fetch(new Request(`${BASE}/api/stats`, { method: "POST", headers: API, body: JSON.stringify({ u, stats }) }), env);
}

describe("emailing a job to its profile from the list of jobs sent", () => {
  it("shows a third tile, addressed to the profile by first name, that asks HermitShell to email the job", async () => {
    const { env, ask, get } = await setup();
    await sentWith(env);
    const before = await (await get("/admin/sent?u=sam-lee&r=7")).text();
    expect(before).toMatch(/Email to Sam<\/b><small>this job&rsquo;s card<\/small>[\s\S]*?name="k" value="send_job"[\s\S]*?>Send<\/button>/);
    expect(before).not.toContain("sam@example.com");
    const h = await jobHash(JOB);
    const res = await ask({ k: "send_job", fresh: "1" });
    expect(res.headers.get("Location")).toBe(`/admin/sent?u=sam-lee&r=30&a=applied&open=${h.slice(0, 16)}&done=mail#job-${h.slice(0, 16)}`);
    const [event] = valuesWith(env, "event:sam-lee:");
    expect(event).toMatchObject({ j: JOB, a: "send_job", u: "sam-lee", via: "dashboard" });
    expect(event.fresh).toBeUndefined();
    expect(event.id).toMatch(/:mg\d+$/);
    const page = await (await get(`/admin/sent?u=sam-lee&r=7&open=${h.slice(0, 16)}&done=mail`)).text();
    expect(page).toContain("HermitShell will email this job within a few minutes.");
    expect(page).toMatch(/Email to Sam<\/b><small>Sending&hellip;<\/small><\/span><span class="dspin"/);
    expect(page).toContain(`http-equiv="refresh" content="15;url=/admin/sent?u=sam-lee&amp;r=7&amp;open=${h.slice(0, 16)}&amp;done=mail&amp;w=1#job-${h.slice(0, 16)}"`);
    expect(await (await get("/admin/tasks")).text()).toContain("Job email");
  });

  it("marks the job as emailed once HermitShell says it went, with Send again", async () => {
    const { env, get } = await setup();
    await sentWith(env);
    expect((await emailed(env)).status).toBe(200);
    const [entry] = JSON.parse(env.FEEDBACK.store.get("emailed:sam-lee"));
    expect(entry).toEqual({ h: await jobHash(JOB), at: expect.any(Number) });
    expect(env.FEEDBACK.store.get("emailed:sam-lee")).not.toContain("jobs.example.com");
    await emailed(env);
    expect(JSON.parse(env.FEEDBACK.store.get("emailed:sam-lee"))).toHaveLength(1);
    const page = await (await get("/admin/sent?u=sam-lee&r=7")).text();
    expect(page).toMatch(/class="doc ready"[^>]*>[\s\S]*?Emailed to Sam<\/b><small>just now<\/small>[\s\S]*?>Send again<\/button>/);
  });

  it("lists jobs sent only for recruits, never for the admin, and addresses each by first name", async () => {
    const { env, get } = await setup();
    await sentWith(env, "owner");
    await sentWith(env, "riley-chen");
    expect((await get("/admin/sent?u=owner&r=7")).status).toBe(404);
    const page = await (await get("/admin/sent?u=riley-chen&r=7")).text();
    expect(page).toContain("Email to Riley</b>");
    expect(page).not.toContain("Email to you");
  });

  it("only takes the mark from HermitShell's token, for a good profile and job", async () => {
    const { env } = await setup();
    expect((await emailed(env, {}, {})).status).toBe(401);
    expect((await emailed(env, {}, { Authorization: "Bearer wrong" })).status).toBe(401);
    for (const bad of [{ u: "../owner" }, { u: "" }, { j: "" }, { j: "x".repeat(301) }, { j: "a\nb" }]) {
      expect((await emailed(env, bad)).status).toBe(400);
    }
    expect(keysWith(env, "emailed:")).toEqual([]);
  });

  it("cannot be asked for from a signed email link", async () => {
    const { env } = await setup();
    const q = await link("send_job", JOB, "Data Engineer", "sam-lee");
    const res = await worker.fetch(new Request(`${BASE}/f?${q}`), env);
    expect(res.status).toBe(403);
    const form = new URLSearchParams(q);
    form.set("r", "");
    expect((await worker.fetch(new Request(`${BASE}/f`, { method: "POST", body: form }), env)).status).toBe(403);
    expect(keysWith(env, "event:")).toEqual([]);
  });
});

describe("removing a profile", () => {
  it("drops its kept letters and CVs, their list, the jobs it was emailed and its jobs sent", async () => {
    const { env, csrf, cookie } = await setup();
    await upload(env);
    await upload(env, { k: "tailored_cv" });
    await emailed(env);
    await env.FEEDBACK.put("sent:sam-lee", "[]");
    await worker.fetch(new Request(`${BASE}/admin/action`, { method: "POST", headers: { Cookie: cookie },
      body: new URLSearchParams({ csrf, action: "delete", u: "sam-lee", confirm: "yes" }) }), env);
    expect(keysWith(env, "doc:sam-lee:")).toEqual([]);
    expect(keysWith(env, "docs:sam-lee")).toEqual([]);
    expect(keysWith(env, "emailed:sam-lee")).toEqual([]);
    expect(keysWith(env, "sent:sam-lee")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { SECRET_TTL_SECONDS } from "../src/join.js";
import { BASE, keysWith, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const CV_TEXT = "Alex Morgan. Data engineer with six years of Python, Airflow and SQL. ".repeat(4);

const STATUS = {
  profiles: [
    { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, crawler: "global",
      has_cv: false, details: { name: "Alex Morgan", email: "alex@example.com", phone: "", location: "Leeds" },
      job: { titles: [], region: "", places: [], search_location: "", country: "gb", remote_anywhere: false, level: "any",
        types: ["Permanent", "Contract"], modes: ["Hybrid", "Remote"], min_salary: "0", currency: "£", hide_agency: false } },
    { id: "sam-lee", name: "Sam <b>Lee</b>", email: "sam@example.com", status: "active", crawler: "global", has_cv: true,
      details: { name: "Sam <b>Lee</b>", email: "sam@example.com", phone: "07700 900123", location: "York" },
      job: { titles: ["Data Analyst", "BI Developer"], region: "North Yorkshire", places: ["York", "Harrogate"],
        search_location: "", country: "gb", remote_anywhere: true, level: "mid", types: ["Permanent"], modes: ["Hybrid"],
        min_salary: "35000", currency: "£", hide_agency: true } },
  ],
  email: { host: "smtp.gmail.com", port: "587", user: "", from: "", password_set: false, source: "none", last_test: null },
  keys: { firecrawl: { source: "none", hint: "" }, tavily: { source: "none", hint: "" }, scrapfly: { source: "none", hint: "" } },
};

function post(path, fields, headers = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x));
  return new Request(`${BASE}${path}`, { method: "POST", body, headers });
}

async function setup(status = STATUS) {
  const env = testEnv(ADMIN);
  if (status) {
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify(status) }), env);
  }
  const res = await worker.fetch(post("/admin/login", { username: "admin", password: ADMIN.ADMIN_PASSWORD },
    { "CF-Connecting-IP": "203.0.113.9" }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = async (path) => {
    const r = await worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
    return { res: r, body: await r.text() };
  };
  const { body } = await get("/admin");
  const csrf = body.match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const act = (fields) => worker.fetch(post("/admin/action", { csrf, ...fields }, { Cookie: cookie }), env);
  const upload = (fields, file = null) => {
    const form = new FormData();
    Object.entries({ csrf, ...fields }).forEach(([k, v]) => form.append(k, v));
    if (file) form.append("cv", file);
    return worker.fetch(new Request(`${BASE}/admin/cv`, { method: "POST", body: form, headers: { Cookie: cookie } }), env);
  };
  return { env, get, act, upload, csrf, cookie };
}

function unescape(html) {
  return html.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// The profile form as a browser would send it: the values it opened with (its hidden base) plus any edits.
async function openForm(get, u) {
  const { body } = await get(`/admin/profile?u=${u}`);
  const base = unescape(body.match(/name="base" value="([^"]*)"/)[1]);
  const v = JSON.parse(base);
  const fields = { action: "profile", u, base, name: v.name, email: v.email, phone: v.phone, location: v.location,
    titles: v.titles.join("\n"), region: v.region, places: v.places.join(", "), country: v.country, level: v.level,
    types: v.types, modes: v.modes, min_salary: v.min_salary === "0" ? "" : v.min_salary, currency: v.currency,
    report_time: v.report_time, report_days: v.report_days,
    ...(v.remote_anywhere ? { remote_anywhere: "1" } : {}), ...(v.hide_agency ? { hide_agency: "1" } : {}) };
  return (edits = {}) => ({ ...fields, ...edits });
}

async function save(get, act, u, edits) {
  return act((await openForm(get, u))(edits));
}

function ttlOf(env, prefix) {
  return env.FEEDBACK.ttls.get(keysWith(env, prefix)[0]);
}

function withTtls(env) {
  env.FEEDBACK.ttls = new Map();
  const put = env.FEEDBACK.put;
  env.FEEDBACK.put = async (key, value, opts = {}) => {
    env.FEEDBACK.ttls.set(key, opts.expirationTtl);
    return put(key, value, opts);
  };
  return env;
}

describe("setup checklist", () => {
  it("lists what is still to do, with links to each form", async () => {
    const { get } = await setup();
    const { body } = await get("/admin");
    expect(body).toContain("Finish setting up");
    expect(body).toContain('href="/admin/settings#email"');
    expect(body).toContain('href="/admin/settings#keys"');
    expect(body).toContain('href="/admin/profile?u=owner#cv"');
    expect(body).toContain('href="/admin/profile?u=owner#job"');
    expect(body).toContain("no CV");
  });

  it("shows progress and each step's state as styled items", async () => {
    const { get } = await setup();
    const { body } = await get("/admin?done=queued");
    expect(body).toContain('<p class="note ok" role="status">Saved. HermitShell applies it within seconds while it is connected.</p>');
    expect(body).toContain("1 of 6 done");
    expect(body).toMatch(/role="progressbar"[^>]*aria-valuenow="1"><span style="width:17%"><\/span>/);
    expect(body).toContain('<li class="done"><span class="tick" aria-hidden="true"></span><div><b>HermitShell is connected</b>');
    expect(body.match(/<li class="todo">/g)).toHaveLength(5);
  });

  it("gives each profile an initials avatar, never markup", async () => {
    const { get } = await setup({ ...STATUS, profiles: [...STATUS.profiles,
      { id: "riley", name: "<img src=x onerror=alert(1)>", email: "r@example.com", status: "active" }] });
    const { body } = await get("/admin");
    expect(body).toContain('<span class="avatar" aria-hidden="true">AM</span>');
    expect(body).toContain('<span class="avatar" aria-hidden="true">SL</span>');
    expect(body).not.toContain("<img");
  });

  it("says so when everything is set", async () => {
    const owner = { ...STATUS.profiles[0], has_cv: true, job: { ...STATUS.profiles[0].job, titles: ["Data Engineer"] } };
    const { get } = await setup({ ...STATUS, profiles: [owner],
      email: { ...STATUS.email, user: "alex@example.com", password_set: true, source: "dashboard", last_test: { ok: true, at: 1, to: "alex@example.com" } },
      keys: { ...STATUS.keys, tavily: { source: "env", hint: "tvly...abcd" } } });
    const { body } = await get("/admin");
    expect(body).toContain("Setup complete");
    expect(body).not.toContain("Finish setting up");
  });

  it("shows the last update as time ago in the owner's timezone", async () => {
    const { get } = await setup({ ...STATUS, timezone: "Europe/London" });
    const { body } = await get("/admin");
    expect(body).toMatch(/HermitShell last checked in just now \(\d{4}-\d\d-\d\d \d\d:\d\d (BST|GMT)\)/);
    expect(body).not.toContain('class="warn"');
  });

  it("warns when HermitShell has stopped reporting", async () => {
    const { env, get } = await setup();
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ ...STATUS, updated: Date.now() - 3 * 3600 * 1000 }));
    const { body } = await get("/admin");
    expect(body).toContain('<div class="warn">HermitShell last checked in 3 hours ago');
    expect(body).toContain("vacancy-profiles");
  });

  it("asks for HermitShell to connect before anything else", async () => {
    const { get } = await setup(null);
    const { body } = await get("/admin");
    expect(body).toContain("HermitShell has not reported yet");
    expect(body).toContain("Upload your CV once HermitShell has connected");
  });

  it("shows changes HermitShell rejected, escaped", async () => {
    const { get } = await setup({ ...STATUS, problems: [{ at: Date.now(), what: "email", error: "invalid <script>" }] });
    const { body } = await get("/admin");
    expect(body).toContain("HermitShell could not apply");
    expect(body).toContain("invalid &lt;script&gt;");
  });
});

describe("global settings page", () => {
  it("holds the email server and web search keys, not the profiles page", async () => {
    const { get, csrf } = await setup();
    const profiles = (await get("/admin")).body;
    expect(profiles).not.toContain('id="email"');
    expect(profiles).not.toContain('id="keys"');
    expect(profiles).toContain('<a href="/admin/settings">Global settings</a>');
    const { res, body } = await get("/admin/settings");
    expect(res.status).toBe(200);
    expect(body).toContain("<h1>Global settings</h1>");
    expect(body).toContain('<h2 id="email">Email server</h2>');
    expect(body).toContain('<h2 id="keys">Web search API keys</h2>');
    expect(body).toContain('href="/admin/settings" class="on" aria-current="page"');
    expect(body.match(/name="csrf" value="([0-9a-f]+)"/)[1]).toBe(csrf);
  });

  it("shows the result of a save and what is still waiting for HermitShell", async () => {
    const { get, act } = await setup();
    await act({ action: "test_email", to: "alex@example.com" });
    await act({ action: "pause", u: "sam-lee" });
    const { body } = await get("/admin/settings?done=queued");
    expect(body).toContain("Saved. HermitShell applies it within seconds while it is connected.");
    expect(body).toContain("Waiting for HermitShell: test email.");
    expect(body).not.toContain("pause for sam-lee");
  });

  it("keeps a saved email server in the form until HermitShell applies it, but never the password", async () => {
    const { get, act } = await setup();
    await act({ action: "email", host: "smtp.office365.com", port: "587", user: "alex@example.com", password: "abcd efgh ijkl mnop" });
    const { body } = await get("/admin/settings");
    expect(body).toContain('value="smtp.office365.com"');
    expect(body).toContain('id="smtp_user" name="user" value="alex@example.com"');
    expect(body).not.toContain("abcd efgh");
    await act({ action: "email_clear" });
    expect((await get("/admin/settings")).body).toContain('value="smtp.gmail.com"');
  });

  it("links every profile page back to it", async () => {
    const { get } = await setup();
    const { body } = await get("/admin/profile?u=sam-lee");
    expect(body).toContain('<a href="/admin/settings">Global settings</a>');
    expect(body).toContain('href="/admin" class="on" aria-current="page"');
  });
});

describe("email server", () => {
  it("queues the settings, with the password expiring early", async () => {
    const { env, act } = await setup();
    withTtls(env);
    const res = await act({ action: "email", host: "smtp.gmail.com", port: "587", user: "alex@example.com",
      password: "abcd efgh ijkl mnop", from: "" });
    expect(res.headers.get("Location")).toBe("/admin/settings?done=queued#email");
    expect(valuesWith(env, "queue:")).toMatchObject([{ type: "admin", action: "email", host: "smtp.gmail.com", port: "587",
      user: "alex@example.com", password: "abcd efgh ijkl mnop" }]);
    expect(ttlOf(env, "queue:")).toBe(SECRET_TTL_SECONDS);
  });

  it("keeps the saved password when the box is left empty", async () => {
    const { env, act } = await setup();
    await act({ action: "email", host: "smtp.office365.com", port: "587", user: "alex@example.com", password: "" });
    const [item] = valuesWith(env, "queue:");
    expect(item).not.toHaveProperty("password");
  });

  it("refuses a bad server, port or address", async () => {
    const { env, act } = await setup();
    for (const bad of [{ host: "smtp gmail com" }, { port: "70000" }, { port: "25a" }, { user: "" }, { from: "not-an-email" }]) {
      const res = await act({ action: "email", host: "smtp.gmail.com", port: "587", user: "a@example.com", ...bad });
      expect(res.headers.get("Location")).toBe("/admin/settings?done=bademail#email");
    }
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("queues a test email and a reset to the .env settings", async () => {
    const { env, act } = await setup();
    await act({ action: "test_email", to: "alex@example.com" });
    await act({ action: "email_clear" });
    expect((await act({ action: "test_email", to: "nope" })).headers.get("Location")).toBe("/admin/settings?done=bademail#email");
    expect(valuesWith(env, "queue:").map(({ action, to, clear }) => ({ action, to, clear }))).toEqual([
      { action: "test_email", to: "alex@example.com", clear: undefined },
      { action: "email", to: undefined, clear: true },
    ]);
  });

  it("never shows the password, only whether one is set", async () => {
    const { get } = await setup({ ...STATUS, email: { ...STATUS.email, user: "alex@example.com", password_set: true, source: "env",
      last_test: { ok: false, at: 1, error: "SMTPAuthenticationError: 535 <bad>" } } });
    const { body } = await get("/admin/settings");
    expect(body).toContain("unchanged (leave empty to keep it)");
    expect(body).toContain("535 &lt;bad&gt;");
    expect(body).not.toMatch(/name="password"[^>]*value=/);
  });
});

describe("web search keys", () => {
  it("queues Firecrawl, Tavily and Scrapfly keys together", async () => {
    const { env, act } = await setup();
    withTtls(env);
    const res = await act({ action: "api_keys", firecrawl: "fc-aaaa1111, fc-bbbb2222", tavily: "tvly-cccc3333", scrapfly: "" });
    expect(res.headers.get("Location")).toBe("/admin/settings?done=queued#keys");
    expect(valuesWith(env, "queue:")).toMatchObject([{ action: "api_keys", firecrawl: ["fc-aaaa1111", "fc-bbbb2222"], tavily: "tvly-cccc3333" }]);
    expect(valuesWith(env, "queue:")[0]).not.toHaveProperty("scrapfly");
    expect(ttlOf(env, "queue:")).toBe(SECRET_TTL_SECONDS);
  });

  it("refuses nothing or anything that isn't a key, and clears one provider at a time", async () => {
    const { env, act } = await setup();
    expect((await act({ action: "api_keys" })).headers.get("Location")).toBe("/admin/settings?done=badkey#keys");
    expect((await act({ action: "api_keys", scrapfly: "key with spaces" })).headers.get("Location")).toBe("/admin/settings?done=badkey#keys");
    expect((await act({ action: "api_keys_clear", provider: "github" })).headers.get("Location")).toBe("/admin/settings?done=badkey#keys");
    await act({ action: "api_keys_clear", provider: "tavily" });
    expect(valuesWith(env, "queue:")).toMatchObject([{ action: "api_keys", clear: ["tavily"] }]);
  });
});

describe("profile page", () => {
  it("opens prefilled and escaped", async () => {
    const { get } = await setup();
    const { res, body } = await get("/admin/profile?u=sam-lee");
    expect(res.status).toBe(200);
    expect(body).toContain("Sam &lt;b&gt;Lee&lt;/b&gt;");
    expect(body).not.toContain("<b>Lee</b>");
    expect(body).toContain(">Data Analyst\nBI Developer</textarea>");
    expect(body).toContain('value="York, Harrogate"');
    expect(body).toMatch(/name="remote_anywhere" value="1" checked/);
    expect(body).toMatch(/<option value="mid" selected>/);
    expect(body).toMatch(/name="types" value="Permanent" checked/);
    expect(body).not.toMatch(/name="types" value="Contract" checked/);
    expect(body).toContain('enctype="multipart/form-data"');
  });

  it("is not found for a profile HermitShell hasn't reported", async () => {
    const { get } = await setup();
    expect((await get("/admin/profile?u=casey-quinn")).res.status).toBe(404);
    expect((await get("/admin/profile?u=../x")).res.status).toBe(404);
  });

  it("needs a signed-in session", async () => {
    const env = testEnv(ADMIN);
    const body = await (await worker.fetch(new Request(`${BASE}/admin/profile?u=owner`), env)).text();
    expect(body).toContain("Admin sign-in");
  });

  it("has one form with one Save for details, job search and report time, then Send jobs now and the CV upload", async () => {
    const { get } = await setup();
    const { body } = await get("/admin/profile?u=sam-lee");
    expect(body.match(/<button>Save changes<\/button>/g)).toHaveLength(1);
    expect(body.match(/<button>Upload CV<\/button>/g)).toHaveLength(1);
    expect(body.match(/<button class="small">Send jobs now<\/button>/g)).toHaveLength(1);
    expect(body.match(/<form /g)).toHaveLength(3);
    expect(body).not.toContain("Save details");
    expect(body).not.toContain("Save job search");
    expect(body.indexOf('id="details"')).toBeGreaterThan(body.indexOf('action="/admin/action"'));
    expect(body.indexOf('id="job"')).toBeLessThan(body.indexOf("Save changes"));
    expect(body.indexOf('id="report"')).toBeLessThan(body.indexOf("Save changes"));
    expect(body.indexOf('id="send"')).toBeGreaterThan(body.indexOf("Save changes"));
  });

  it("queues only the fields that changed, cleaned", async () => {
    const { env, get, act } = await setup();
    const saved = await save(get, act, "owner", { email: "alex.m@example.com", phone: "07700 900456",
      titles: "Data Engineer\nAnalytics Engineer\n\nData Engineer", region: "West Yorkshire", places: "Leeds, Bradford",
      remote_anywhere: "1", level: "senior", types: ["Permanent", "Bogus"], modes: ["Remote"], min_salary: "55,000" });
    expect(saved.headers.get("Location")).toBe("/admin/profile?u=owner&done=saved");
    const [item] = valuesWith(env, "queue:");
    expect(item).toMatchObject({ type: "admin", action: "profile", u: "owner" });
    expect(item.details).toEqual({ email: "alex.m@example.com", phone: "07700 900456" });
    expect(item.job).toEqual({ titles: ["Data Engineer", "Analytics Engineer"], region: "West Yorkshire",
      places: ["Leeds", "Bradford"], remote_anywhere: true, level: "senior", types: ["Permanent"], modes: ["Remote"],
      min_salary: "55000" });
  });

  it("keeps what was saved on the page until HermitShell applies it, with a live status box", async () => {
    const { get, act } = await setup();
    await save(get, act, "sam-lee", { email: "sam.lee@example.com", titles: "Data Analyst" });
    const { body } = await get("/admin/profile?u=sam-lee&done=saved");
    expect(body).toContain('value="sam.lee@example.com"');
    expect(body).toContain(">Data Analyst</textarea>");
    expect(body).toContain("The box above shows when HermitShell has applied it");
    expect(body).toContain('<iframe class="saving" src="/admin/profile/status?u=sam-lee&amp;n=1"');
    expect((await get("/admin/profile?u=sam-lee")).body).toContain('src="/admin/profile/status?u=sam-lee"');
  });

  it("saves nothing when nothing changed", async () => {
    const { env, get, act } = await setup();
    const res = await save(get, act, "sam-lee", { min_salary: "35k", places: "York,Harrogate", types: ["Permanent", "Bogus"] });
    expect(res.headers.get("Location")).toBe("/admin/profile?u=sam-lee&done=nochange");
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("merges two people's changes to different fields of one profile", async () => {
    const { env, get, act } = await setup();
    const first = await openForm(get, "sam-lee");
    const second = await openForm(get, "sam-lee");
    await act(second({ phone: "07700 900999" }));
    const res = await act(first({ region: "West Yorkshire" }));
    expect(res.headers.get("Location")).toBe("/admin/profile?u=sam-lee&done=saved");
    expect(valuesWith(env, "queue:").map((i) => [i.details, i.job])).toEqual([
      [{ phone: "07700 900999" }, undefined], [undefined, { region: "West Yorkshire" }]]);
    const { body } = await get("/admin/profile?u=sam-lee");
    expect(body).toContain('value="07700 900999"');
    expect(body).toContain('value="West Yorkshire"');
  });

  it("shows a clash on the same field instead of overwriting it, and saves once confirmed", async () => {
    const { env, get, act } = await setup();
    const first = await openForm(get, "sam-lee");
    await save(get, act, "sam-lee", { email: "sam.other@example.com" });
    const res = await act(first({ email: "sam.mine@example.com", location: "Leeds" }));
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain("Someone else changed this recruit while you were editing.");
    expect(body).toContain("<b>Email for reports</b>: now <i>sam.other@example.com</i>, yours <i>sam.mine@example.com</i>");
    expect(body).toContain('value="sam.mine@example.com"');
    expect(body).toContain('value="Leeds"');
    expect(valuesWith(env, "queue:")).toHaveLength(1);
    const base = unescape(body.match(/name="base" value="([^"]*)"/)[1]);
    expect(JSON.parse(base).email).toBe("sam.other@example.com");
    await act(first({ base, email: "sam.mine@example.com", location: "Leeds" }));
    expect(valuesWith(env, "queue:").map((i) => i.details)).toEqual([
      { email: "sam.other@example.com" }, { email: "sam.mine@example.com", location: "Leeds" }]);
  });

  it("offers countries by name and stores only known codes", async () => {
    const { env, act, get } = await setup();
    const { body } = await get("/admin/profile?u=sam-lee");
    expect(body).toContain('<select id="country" name="country"><option value="">Any country</option>');
    expect(body).toContain('<option value="gb" selected>United Kingdom</option>');
    expect(body).toContain('<option value="ie">Ireland</option>');
    expect(body).not.toContain('name="search_location"');
    for (const country of ["IE", "zz", "uk", "g<"]) await save(get, act, "owner", { country });
    expect(valuesWith(env, "queue:").map((i) => i.job.country)).toEqual(["ie", "", "gb", ""]);
    expect(valuesWith(env, "queue:")[0].job).not.toHaveProperty("search_location");
  });

  it("uses plain labels with hints, an empty salary box for no minimum, and a back button", async () => {
    const { env, act, get } = await setup();
    const { body } = await get("/admin/profile?u=sam-lee");
    expect(body).toContain('<label for="places">Towns</label>');
    expect(body).toContain('<label for="min_salary">Minimum salary</label>');
    expect(body).toContain("Jobs that don&#39;t show a salary are always included.");
    expect(body).not.toContain("All profiles");
    expect(body).toMatch(/<body><a class="back" href="\/admin"><svg [^>]*aria-hidden="true"><path [^>]*\/><\/svg>Back to recruits<\/a><main class="wide">/);
    expect(body).not.toMatch(/&larr;|[\u2190-\u21ff]/);
    expect((await get("/admin/profile?u=owner")).body).toContain('id="min_salary" name="min_salary" value=""');
    for (const min_salary of ["£45,000", "", "45k"]) await save(get, act, "owner", { min_salary });
    expect(valuesWith(env, "queue:").map((i) => i.job.min_salary)).toEqual(["45000", "0", "45000"]);
  });

  it("refuses a bad email without losing what was typed, and ignores an unknown level or a bad profile id", async () => {
    const { env, get, act } = await setup();
    const bad = await save(get, act, "owner", { name: "Alex M", email: "nope", location: "Bradford" });
    expect(bad.status).toBe(400);
    const body = await bad.text();
    expect(body).toContain("A name and a valid email address are needed.");
    expect(body).toContain('value="Alex M"');
    expect(body).toContain('value="Bradford"');
    expect((await save(get, act, "owner", { name: "" })).status).toBe(400);
    expect((await act({ action: "profile", u: "../etc" })).headers.get("Location")).toBe("/admin?done=profile");
    const res = await save(get, act, "owner", { level: "wizard", min_salary: "lots" });
    expect(res.headers.get("Location")).toBe("/admin/profile?u=owner&done=nochange");
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("applies changes still waiting for HermitShell in order", async () => {
    const { get, act } = await setup();
    await save(get, act, "owner", { titles: "Data Engineer" });
    await save(get, act, "owner", { titles: "Data Engineer\nML Engineer", location: "York" });
    const { body } = await get("/admin/profile?u=owner");
    expect(body).toContain(">Data Engineer\nML Engineer</textarea>");
    expect(body).toContain('value="York"');
  });
});

describe("daily report and Send jobs now", () => {
  const scheduled = (sam = {}) => ({ ...STATUS, timezone: "Europe/London", hermes_jobs: true, profiles: [
    { ...STATUS.profiles[0], report: { time: "08:00", days: "daily", schedule: "0 8 * * *", hermes_job: true, pending: false } },
    { ...STATUS.profiles[1], report: { time: "08:15", days: "weekdays", schedule: "15 8 * * 1-5", hermes_job: true, pending: false },
      ...sam }] });

  it("shows each profile's report time and queues a new one as { time, days }", async () => {
    const { env, get, act } = await setup(scheduled());
    const dash = (await get("/admin")).body;
    expect(dash).toContain("daily report 08:00</div>");
    expect(dash).toContain("daily report 08:15 on weekdays</div>");
    const { body } = await get("/admin/profile?u=sam-lee");
    expect(body).toContain('<input id="report_time" name="report_time" type="time" value="08:15">');
    expect(body).toContain('<option value="weekdays" selected>Weekdays (Monday to Friday)</option>');
    expect(body).toContain("(Europe/London). Each recruit&#39;s report is its own Hermes job.");
    await save(get, act, "sam-lee", { report_time: "06:45", report_days: "daily" });
    await save(get, act, "owner", { report_days: "weekdays" });
    expect(valuesWith(env, "queue:").map((i) => [i.u, i.report, i.details, i.job])).toEqual([
      ["sam-lee", { time: "06:45", days: "daily" }, undefined, undefined], ["owner", { days: "weekdays" }, undefined, undefined]]);
    expect((await get("/admin/profile?u=sam-lee")).body).toContain('name="report_time" type="time" value="06:45"');
  });

  it("refuses a missing or impossible time without losing the rest", async () => {
    const { env, get, act } = await setup(scheduled());
    for (const report_time of ["", "25:00", "8am", "08:00; rm -rf /"]) {
      const res = await save(get, act, "sam-lee", { report_time, location: "Leeds" });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Choose a time for the daily report.");
      expect(body).toContain('value="Leeds"');
    }
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("says when a new time is still to be applied, or can't be", async () => {
    const pending = await setup(scheduled({ report: { time: "07:00", days: "daily", schedule: "0 7 * * *", pending: true } }));
    expect((await pending.get("/admin")).body).toContain("daily report 07:00 (moving)");
    expect((await pending.get("/admin/profile?u=sam-lee")).body).toContain("HermitShell moves the report to this time when it next checks in");
    const outside = await setup({ ...scheduled(), hermes_jobs: false });
    expect((await outside.get("/admin/profile?u=owner")).body).toContain("isn&#39;t running under Hermes&#39; scheduler");
  });

  it("queues Send jobs now for one profile, from the dashboard or its page", async () => {
    const { env, get, act } = await setup(scheduled());
    const dash = (await get("/admin")).body;
    expect(dash.match(/>Send jobs now</g)).toHaveLength(1);
    expect(dash).toContain('name="action" value="send_now"><input type="hidden" name="u" value="sam-lee">');
    const res = await act({ action: "send_now", u: "sam-lee" });
    expect(res.headers.get("Location")).toBe("/admin?done=sending");
    expect((await get("/admin?done=sending")).body).toContain("HermitShell starts the scan within seconds");
    const back = await act({ action: "send_now", u: "sam-lee", back: "profile" });
    expect(back.headers.get("Location")).toBe("/admin/profile?u=sam-lee&done=sending");
    expect(valuesWith(env, "queue:")).toEqual([
      expect.objectContaining({ type: "admin", action: "send_now", u: "sam-lee" }),
      expect.objectContaining({ type: "admin", action: "send_now", u: "sam-lee" })]);
    const page = (await get("/admin/profile?u=sam-lee&done=sending")).body;
    expect(page).toContain('src="/admin/profile/status?u=sam-lee&amp;n=1"');
    expect((await get("/admin/profile/status?u=sam-lee&n=1")).body).toContain("Starting the scan&hellip;");
    expect((await get("/admin/profile?u=owner")).body).toContain("Upload a CV first");
    expect((await act({ action: "send_now", u: "../owner" })).status).toBe(400);
  });

  it("shows a scan that is running instead of the button", async () => {
    const started = Date.now() - 3 * 60 * 1000;
    const { get } = await setup(scheduled({ scanning: started }));
    const dash = (await get("/admin")).body;
    expect(dash).toContain('<span class="pill scanning">scanning now</span>');
    expect(dash).toContain('<button class="small" disabled>Scanning&hellip;</button>');
    expect(dash).not.toContain(">Send jobs now<");
    expect((await get("/admin/profile?u=sam-lee")).body).toContain("Scanning now (started ");
    const box = (await get("/admin/profile/status?u=sam-lee&n=1")).body;
    expect(box).toContain('<body class="wait">');
    expect(box).toContain("Scanning for jobs since");
    expect(box).toContain('content="30;url=/admin/profile/status?u=sam-lee&amp;n=2"');
    expect((await get("/admin/profile/status?u=sam-lee&n=80")).body).not.toContain("http-equiv");
  });
});

describe("save status box", () => {
  const API_HEADERS = { ...API, "Content-Type": "application/json" };

  it("says when HermitShell is up to date, is waiting and has applied a save", async () => {
    const { env, get, act } = await setup();
    const idle = await get("/admin/profile/status?u=sam-lee");
    expect(idle.res.status).toBe(200);
    expect(idle.body).toContain('<body class="ok">');
    expect(idle.body).toContain("Up to date. HermitShell last reported just now.");
    expect(idle.body).not.toContain("http-equiv");
    await save(get, act, "sam-lee", { phone: "07700 900111" });
    const waiting = await get("/admin/profile/status?u=sam-lee&n=1");
    expect(waiting.body).toContain("Waiting for HermitShell to apply it");
    expect(waiting.body).toContain('<body class="wait">');
    expect(waiting.body).toContain('<meta http-equiv="refresh" content="5;url=/admin/profile/status?u=sam-lee&amp;n=2">');
    expect((await get("/admin/profile/status?u=owner")).body).toContain("Up to date");
    const ids = keysWith(env, "queue:");
    await worker.fetch(new Request(`${BASE}/api/queue/ack`, { method: "POST", headers: API_HEADERS, body: JSON.stringify({ ids }) }), env);
    const applied = await get("/admin/profile/status?u=sam-lee&n=3");
    expect(applied.body).toContain("Applied by HermitShell");
    expect(applied.body).toContain('<body class="done">');
    expect(applied.body).not.toContain("http-equiv");
  });

  it("slows down and then stops checking, to spare the free plan's KV list quota", async () => {
    const { get, act } = await setup();
    await save(get, act, "sam-lee", { phone: "07700 900111" });
    expect((await get("/admin/profile/status?u=sam-lee&n=15")).body).toContain('content="20;url=');
    const stopped = await get("/admin/profile/status?u=sam-lee&n=21");
    expect(stopped.body).toContain("Still waiting for HermitShell");
    expect(stopped.body).toContain('<body class="idle">');
    expect(stopped.body).not.toContain("http-equiv");
    expect((await get("/admin/profile/status?u=sam-lee&n=-5")).body).toContain('content="5;url=/admin/profile/status?u=sam-lee&amp;n=1"');
  });

  it("shows a change HermitShell could not apply, escaped", async () => {
    const { get } = await setup({ ...STATUS, problems: [{ at: Date.now(), what: "profile for sam-lee", error: "invalid <b>email</b>" }] });
    const { body } = await get("/admin/profile/status?u=sam-lee&n=1");
    expect(body).toContain("HermitShell could not apply a change:</b> invalid &lt;b&gt;email&lt;/b&gt;");
  });

  it("says a CV takes longer", async () => {
    const { get, upload } = await setup();
    await upload({ u: "owner", cv_text: CV_TEXT });
    expect((await get("/admin/profile/status?u=owner&n=1")).body).toContain("reading the new CV");
  });

  it("can only be framed by the dashboard itself", async () => {
    const { get } = await setup();
    const { res } = await get("/admin/profile/status?u=owner");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const page = await get("/admin/profile?u=owner");
    expect(page.res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(page.res.headers.get("Content-Security-Policy")).toContain("frame-src 'self'");
    expect((await get("/admin/profile/status?u=../x")).res.status).toBe(404);
  });
});

describe("CV upload", () => {
  it("stores the file like a sign-up and queues a rebuild", async () => {
    const { env, upload } = await setup();
    const pdf = new File([new TextEncoder().encode("%PDF-1.4 cv")], "Alex Morgan CV.pdf", { type: "application/pdf" });
    const res = await upload({ u: "owner", roles: "Data engineering" }, pdf);
    expect(res.headers.get("Location")).toBe("/admin/profile?u=owner&done=cvqueued");
    const [item] = valuesWith(env, "queue:");
    expect(item).toMatchObject({ type: "admin", action: "cv", u: "owner", roles: "Data engineering", cv: { kind: "pdf", size: 11 } });
    expect(new TextDecoder().decode(new Uint8Array(env.FEEDBACK.store.get(item.cv.key)))).toBe("%PDF-1.4 cv");
  });

  it("accepts pasted text and refuses too little, the wrong type or too much", async () => {
    const { env, upload } = await setup();
    expect((await upload({ u: "sam-lee", cv_text: "short" })).headers.get("Location")).toContain("done=cvmissing");
    expect((await upload({ u: "sam-lee" }, new File(["MZ"], "cv.pdf"))).headers.get("Location")).toContain("done=cvtype");
    expect((await upload({ u: "sam-lee" }, new File([new Uint8Array(6 * 1024 * 1024)], "cv.pdf"))).status).toBe(413);
    expect(keysWith(env, "cvfile:")).toEqual([]);
    await upload({ u: "sam-lee", cv_text: CV_TEXT });
    expect(valuesWith(env, "queue:")).toMatchObject([{ action: "cv", u: "sam-lee", cv: null }]);
  });

  it("needs the CSRF token and a valid profile id", async () => {
    const { env, cookie } = await setup();
    const form = new FormData();
    form.append("csrf", "0".repeat(32));
    form.append("u", "owner");
    form.append("cv_text", CV_TEXT);
    const res = await worker.fetch(new Request(`${BASE}/admin/cv`, { method: "POST", body: form, headers: { Cookie: cookie } }), env);
    expect(res.status).toBe(403);
    const { upload } = await setup();
    expect((await upload({ u: "../../x", cv_text: CV_TEXT })).status).toBe(400);
    expect(valuesWith(env, "queue:")).toEqual([]);
  });
});

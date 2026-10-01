import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { SECRET_TTL_SECONDS } from "../src/join.js";
import { APPLIED, waitRefresh } from "../src/lib.js";
import { BASE, keysWith, sealingKeys, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const CV_TEXT = "Alex Morgan. Data engineer with six years of Python, Airflow and SQL. ".repeat(4);
const KEYS = await sealingKeys();

// The main admin, staff only: HermitShell reports them so the dashboard can name them.
const STAFF = { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false, recruit: "" };
const STATUS = {
  ...KEYS.status,
  profiles: [
    { id: "jordan-patel", name: "Jordan Patel", email: "jordan@example.com", status: "active", crawler: "global",
      has_cv: false, details: { name: "Jordan Patel", email: "jordan@example.com", phone: "", location: "Leeds" },
      job: { titles: [], region: "", places: [], search_location: "", country: "gb", remote_anywhere: false, level: "any",
        types: ["Permanent", "Contract"], modes: ["Hybrid", "Remote"], min_salary: "0", currency: "£", hide_agency: false } },
    { id: "sam-lee", name: "Sam <b>Lee</b>", email: "sam@example.com", status: "active", crawler: "global", has_cv: true,
      details: { name: "Sam <b>Lee</b>", email: "sam@example.com", phone: "07700 900123", location: "York" },
      job: { titles: ["Data Analyst", "BI Developer"], region: "North Yorkshire", places: ["York", "Harrogate"],
        search_location: "", country: "gb", remote_anywhere: true, level: "mid", types: ["Permanent"], modes: ["Hybrid"],
        min_salary: "35000", currency: "£", hide_agency: true } },
    STAFF,
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
    expect(body).not.toContain("Your CV uploaded");
    expect(body).not.toContain("u=owner");
    expect(body).toContain("no CV");
  });

  it("asks for a first recruit, never for the admin's own CV or job search", async () => {
    const { get } = await setup({ ...STATUS, profiles: [STAFF] });
    const { body } = await get("/admin");
    expect(body).toContain("<b>First recruit joined</b>");
    expect(body).toContain('<a href="#invite">Create an invite link</a>');
    expect(body).toContain('<h2 id="invite">Invite someone</h2>');
    expect(body).not.toContain("Job search set");
    expect(body).toContain("HermitShell has not reported any recruits yet.");
    expect(body).not.toContain("u=owner");
  });

  it("shows progress and each step's state as styled items", async () => {
    const { get } = await setup();
    const { body } = await get("/admin?done=queued");
    expect(body).toContain(`<p class="note ok" role="status">${APPLIED}</p>`);
    expect(body).toContain("2 of 5 done");
    expect(body).toMatch(/role="progressbar"[^>]*aria-valuenow="2"><span style="width:40%"><\/span>/);
    expect(body).toContain('<li class="done"><span class="tick" aria-hidden="true"></span><div><b>HermitShell is connected</b>');
    expect(body).toContain('<li class="done"><span class="tick" aria-hidden="true"></span><div><b>First recruit joined</b>');
    expect(body.match(/<li class="todo">/g)).toHaveLength(3);
  });

  it("gives each profile an initials avatar, never markup", async () => {
    const { get } = await setup({ ...STATUS, profiles: [...STATUS.profiles,
      { id: "riley", name: "<img src=x onerror=alert(1)>", email: "r@example.com", status: "active" }] });
    const { body } = await get("/admin");
    expect(body).toContain('<span class="avatar" aria-hidden="true">JP</span>');
    expect(body).toContain('<span class="avatar" aria-hidden="true">SL</span>');
    expect(body).not.toContain("<img");
  });

  it("says so when everything is set", async () => {
    const { get } = await setup({ ...STATUS, profiles: [STATUS.profiles[1], STAFF],
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
    expect(body).toContain("0 of 5 done");
  });

  it("warns when HermitShell and the Worker speak different protocols, with the fix for whichever is older", async () => {
    const older = (await (await setup({ ...STATUS, protocol: undefined })).get("/admin")).body;
    expect(older).toContain("HermitShell and this Worker don&rsquo;t match:");
    expect(older).toContain("HermitShell (protocol 1) is older than this Worker (protocol 4)");
    const newer = (await (await setup({ ...STATUS, protocol: 5 })).get("/admin/settings")).body;
    expect(newer).toContain("This Worker (protocol 4) is older than HermitShell (protocol 5). Redeploy it");
    expect((await (await setup()).get("/admin")).body).not.toContain("don&rsquo;t match");
    expect((await (await setup(null)).get("/admin")).body).not.toContain("don&rsquo;t match");
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
    expect(profiles).not.toContain("everyone shares");
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
    expect(body).toContain("Waiting for HermitShell to apply the test email; this page updates by itself.");
    expect(body).not.toContain("sam-lee");
  });
});

// The pages run no scripts, so while one of their changes is waiting for HermitShell they reload themselves.
const clearQueue = async (env) => {
  for (const key of keysWith(env, "queue:")) await env.FEEDBACK.delete(key);
  await env.FEEDBACK.delete("flag:queue");
};
const refreshOf = (body) => body.match(/<meta http-equiv="refresh" content="(\d+)(?:;url=[^"]*)?">/)?.[1] || null;

describe("pages that update themselves", () => {
  it("reload every 4 seconds at first, every 20 after 45 seconds, and stop at 5 minutes", () => {
    const now = 1_000_000_000;
    expect(waitRefresh([], now)).toBe(0);
    expect(waitRefresh([{ at: now - 1000 }], now)).toBe(4);
    expect(waitRefresh([{ at: now - 60_000 }], now)).toBe(20);
    expect(waitRefresh([{ at: now - 1000 }, { at: now - 301_000 }], now)).toBe(0);
    expect(waitRefresh([{}], now)).toBe(4);
  });

  it("marks the key being saved, reloads Global settings until it is applied, then says so", async () => {
    const { env, get, act } = await setup();
    expect(refreshOf((await get("/admin/settings")).body)).toBeNull();
    await act({ action: "api_key", provider: "tavily", key: "not-a-real-key" });
    const waiting = (await get("/admin/settings?done=queued")).body;
    expect(refreshOf(waiting)).toBe("4");
    expect(waiting).toContain('<meta http-equiv="refresh" content="4;url=/admin/settings?done=queued&amp;w=1#keys">');
    expect((await get("/admin/settings?done=queued&w=1")).body).toContain('content="4;url=/admin/settings?done=queued&amp;w=2#keys"');
    expect(waiting).toContain('<body class="still">');
    expect(waiting).toContain("Waiting for HermitShell to apply the web search keys");
    expect(waiting).toContain("Saved. HermitShell applies it within seconds while it is connected.");
    const keys = waiting.slice(waiting.indexOf('<h2 id="keys">'), waiting.indexOf('<h2 id="models">'));
    const tavily = keys.slice(keys.indexOf("cr-tavily"), keys.indexOf("cr-scrapfly"));
    expect(tavily).toContain('<span class="savingtag">saving&hellip;</span>');
    expect(waiting.match(/savingtag/g)).toHaveLength(1);
    await clearQueue(env);
    const applied = (await get("/admin/settings?done=queued")).body;
    expect(refreshOf(applied)).toBeNull();
    expect(applied).toContain(APPLIED);
    expect(applied).not.toContain('class="waitbar');
    expect(applied).not.toContain("savingtag");
  });

  it("shows a saved model order and model key at once", async () => {
    const { get, act } = await setup();
    await act({ action: "model_order", order: "local" });
    await act({ action: "model_key_clear", provider: "openrouter" });
    const body = (await get("/admin/settings")).body;
    expect(body).toMatch(/name="order" value="local" checked/);
    expect(body).toContain('Save order</button> <span class="savingtag">');
    const models = body.slice(body.indexOf('<h2 id="models">'));
    const or = models.slice(models.indexOf("cr-openrouter"), models.indexOf("cr-bazaarlink"));
    expect(models.slice(models.indexOf("cr-bazaarlink"), models.indexOf("cr-ollama"))).not.toContain("savingtag");
    expect(or).toContain("savingtag");
    expect(refreshOf(body)).toBe("4");
  });

  it("slows down after 45 seconds and stops after 5 minutes, saying HermitShell may be offline", async () => {
    const { env, get } = await setup();
    const queue = async (ago) => {
      const at = Date.now() - ago;
      await env.FEEDBACK.put(`queue:${at}:abc`, JSON.stringify({ id: `queue:${at}:abc`, at, type: "admin", action: "test_email", to: "" }));
      await env.FEEDBACK.put("flag:queue", "x");
    };
    await queue(60_000);
    expect(refreshOf((await get("/admin/settings")).body)).toBe("20");
    await clearQueue(env);
    await queue(6 * 60_000);
    const late = (await get("/admin/settings")).body;
    expect(refreshOf(late)).toBeNull();
    expect(late).not.toContain('<body class="still">');
    expect(late).toContain("Still waiting for HermitShell</b> to apply the test email. It may be offline or busy");
  });

  it("shows a pause on the dashboard at once and reloads until HermitShell applies it", async () => {
    const { env, get, act } = await setup();
    await act({ action: "pause", u: "sam-lee" });
    const body = (await get("/admin?done=queued")).body;
    expect(refreshOf(body)).toBe("4");
    expect(body).toContain("Waiting for HermitShell to apply the change; this page updates by itself.");
    const row = body.slice(body.indexOf("Sam &lt;b&gt;Lee"));
    expect(row).toMatch(/<span class="pill paused">paused<\/span> <span class="savingtag">pausing&hellip;<\/span>/);
    expect(row).toContain('aria-label="Resume reports for Sam &lt;b&gt;Lee&lt;/b&gt;"');
    const jordan = body.slice(body.indexOf("Jordan Patel"), body.indexOf("Sam &lt;b&gt;Lee") > body.indexOf("Jordan Patel") ? body.indexOf("Sam &lt;b&gt;Lee") : undefined);
    expect(jordan).not.toContain("savingtag");
    await clearQueue(env);
    const after = (await get("/admin?done=queued")).body;
    expect(refreshOf(after)).toBeNull();
    expect(after).toContain(APPLIED);
  });

  it("doesn't reload for a sign-up or a CV, which take minutes and show their own progress", async () => {
    const { env, get } = await setup();
    const at = Date.now();
    await env.FEEDBACK.put(`queue:${at}:s1`, JSON.stringify({ id: `queue:${at}:s1`, at, type: "signup", name: "Casey Quinn", email: "casey@example.com" }));
    await env.FEEDBACK.put(`queue:${at + 1}:c1`, JSON.stringify({ id: `queue:${at + 1}:c1`, at: at + 1, type: "admin", action: "cv", u: "sam-lee" }));
    await env.FEEDBACK.put("flag:queue", "x");
    const body = (await get("/admin")).body;
    expect(refreshOf(body)).toBeNull();
    expect(body).not.toContain('class="waitbar');
    expect(refreshOf((await get("/admin/settings")).body)).toBeNull();
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

  it("keeps its tab to the dashboard: a profile page has Manage and History instead", async () => {
    const { get } = await setup();
    const { body } = await get("/admin/profile?u=sam-lee");
    expect(body).not.toContain("Global settings");
    expect(body).not.toContain("Users and roles");
    expect(body).toContain('<nav class="tabs" aria-label="Recruit pages"><a href="/admin/profile?u=sam-lee" class="on" aria-current="page">Manage</a><a href="/admin/pipeline?u=sam-lee">Pipeline</a><a href="/admin/history?u=sam-lee">History</a></nav>');
    expect(body).toContain("Back to recruits</a>");
  });
});

describe("email server", () => {
  it("queues the settings, with the password expiring early", async () => {
    const { env, act } = await setup();
    withTtls(env);
    const res = await act({ action: "email", host: "smtp.gmail.com", port: "587", user: "alex@example.com",
      password: "abcd efgh ijkl mnop", from: "" });
    expect(res.headers.get("Location")).toBe("/admin/settings?done=queued#email");
    const [item] = valuesWith(env, "queue:");
    expect(item).toMatchObject({ type: "admin", action: "email", host: "smtp.gmail.com", port: "587", user: "alex@example.com",
      sealed: ["password"] });
    expect(JSON.stringify(item)).not.toContain("abcd efgh");
    expect(await KEYS.open(item.password, "password")).toBe("abcd efgh ijkl mnop");
    expect(ttlOf(env, "queue:")).toBe(SECRET_TTL_SECONDS);
  });

  it("refuses to queue a password before HermitShell has sent its sealing key", async () => {
    const { env, act } = await setup({ ...STATUS, seal: undefined });
    const res = await act({ action: "email", host: "smtp.gmail.com", port: "587", user: "alex@example.com", password: "abcd efgh ijkl mnop" });
    expect(res.headers.get("Location")).toBe("/admin/settings?done=nokey#email");
    expect(valuesWith(env, "queue:")).toEqual([]);
    const settings = await act({ action: "email", host: "smtp.gmail.com", port: "587", user: "alex@example.com", password: "" });
    expect(settings.headers.get("Location")).toBe("/admin/settings?done=queued#email");
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
    const [item] = valuesWith(env, "queue:");
    expect(item).toMatchObject({ action: "api_keys", sealed: ["firecrawl", "tavily"] });
    expect(await Promise.all(item.firecrawl.map((v) => KEYS.open(v, "firecrawl")))).toEqual(["fc-aaaa1111", "fc-bbbb2222"]);
    expect(await KEYS.open(item.tavily, "tavily")).toBe("tvly-cccc3333");
    expect(item).not.toHaveProperty("scrapfly");
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

  it("offers the currency as a list, opening an old symbol setting on its code", async () => {
    const { get } = await setup();
    const { body } = await get("/admin/profile?u=sam-lee");
    expect(body).toContain('<select id="currency" name="currency"><option value="">As advertised</option>');
    expect(body).toContain('<option value="GBP" selected>£ Pound sterling (GBP)</option>');
    expect(body).toContain('<option value="CAD">C$ Canadian dollar (CAD)</option>');
    expect(body).not.toContain('<input id="currency"');
    expect(body).toContain("converted to this one at the day&#39;s exchange rate");
  });

  it("queues a picked currency, and one that isn't offered as salaries as advertised", async () => {
    const { env, get, act } = await setup();
    await save(get, act, "jordan-patel", { currency: "EUR" });
    await save(get, act, "sam-lee", { currency: "<script>alert(1)</script>" });
    expect(valuesWith(env, "queue:").map((i) => [i.u, i.job])).toEqual([["jordan-patel", { currency: "EUR" }], ["sam-lee", { currency: "" }]]);
    expect((await get("/admin/profile?u=jordan-patel")).body).toContain('<option value="EUR" selected>');
  });

  it("is not found for a profile HermitShell hasn't reported", async () => {
    const { get } = await setup();
    expect((await get("/admin/profile?u=casey-quinn")).res.status).toBe(404);
    expect((await get("/admin/profile?u=../x")).res.status).toBe(404);
  });

  it("needs a signed-in session", async () => {
    const env = testEnv(ADMIN);
    const body = await (await worker.fetch(new Request(`${BASE}/admin/profile?u=jordan-patel`), env)).text();
    expect(body).toContain("Admin sign-in");
  });

  it("has one form with one Save for details, job search and report time, then Send jobs now and the CV upload", async () => {
    const { get } = await setup();
    const { body } = await get("/admin/profile?u=sam-lee");
    expect(body.match(/<button>Save changes<\/button>/g)).toHaveLength(1);
    expect(body.match(/<button>Upload CV<\/button>/g)).toHaveLength(1);
    expect(body.match(/<button class="small">Send jobs now<\/button>/g)).toHaveLength(1);
    expect(body.slice(body.indexOf("<main")).match(/<form (?![^>]*action="\/admin\/notes")/g)).toHaveLength(4);
    expect(body.slice(body.indexOf("<main")).match(/<form [^>]*action="\/admin\/notes"/g)).toHaveLength(2);
    expect(body.slice(body.indexOf("<main")).match(/<form [^>]*action="\/admin\/cvpdf"/g)).toHaveLength(1);
    expect(body).not.toContain("Save details");
    expect(body).not.toContain("Save job search");
    expect(body.indexOf('id="details"')).toBeGreaterThan(body.indexOf('action="/admin/action"'));
    expect(body.indexOf('id="job"')).toBeLessThan(body.indexOf("Save changes"));
    expect(body.indexOf('id="report"')).toBeLessThan(body.indexOf("Save changes"));
    expect(body.indexOf('id="send"')).toBeGreaterThan(body.indexOf("Save changes"));
  });

  it("queues only the fields that changed, cleaned", async () => {
    const { env, get, act } = await setup();
    const saved = await save(get, act, "jordan-patel", { email: "alex.m@example.com", phone: "07700 900456",
      titles: "Data Engineer\nAnalytics Engineer\n\nData Engineer", region: "West Yorkshire", places: "Leeds, Bradford",
      remote_anywhere: "1", level: "senior", types: ["Permanent", "Bogus"], modes: ["Remote"], min_salary: "55,000" });
    expect(saved.headers.get("Location")).toBe("/admin/profile?u=jordan-patel&done=saved");
    const [item] = valuesWith(env, "queue:");
    expect(item).toMatchObject({ type: "admin", action: "profile", u: "jordan-patel" });
    expect(item.details).toEqual({ email: "alex.m@example.com", phone: "07700 900456" });
    expect(item.job).toEqual({ titles: ["Data Engineer", "Analytics Engineer"], region: "West Yorkshire",
      places: ["Leeds", "Bradford"], remote_anywhere: true, level: "senior", types: ["Permanent"], modes: ["Remote"],
      min_salary: "55000" });
    expect(valuesWith(env, "history:jordan-patel:")).toMatchObject([[{ k: "job", by: "Alex Morgan", v: "dashboard",
      t: "Changed Email for reports, Phone, Job titles, Region or city, Towns, Fully remote jobs, Seniority, Employment types, Work location and Minimum salary" }]]);
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
    for (const country of ["IE", "zz", "uk", "g<"]) await save(get, act, "jordan-patel", { country });
    expect(valuesWith(env, "queue:").map((i) => i.job.country)).toEqual(["ie", "", "gb", ""]);
    expect(valuesWith(env, "queue:")[0].job).not.toHaveProperty("search_location");
  });

  it("keeps a saved code that isn't in the list selected, and saving other fields leaves it alone", async () => {
    const zz = { ...STATUS, profiles: STATUS.profiles.map((p) => (p.id === "sam-lee" ? { ...p, job: { ...p.job, country: "ZZ" } } : p)) };
    const { env, act, get } = await setup(zz);
    const { body } = await get("/admin/profile?u=sam-lee");
    const select = body.match(/<select id="country"[\s\S]*?<\/select>/)[0];
    expect(select).toContain('<option value="">Any country</option><option value="zz" selected>ZZ (not in the list)</option>');
    expect(select.match(/ selected/g)).toHaveLength(1);
    expect((await save(get, act, "sam-lee", { region: "West Yorkshire" })).headers.get("Location")).toBe("/admin/profile?u=sam-lee&done=saved");
    expect(valuesWith(env, "queue:").map((i) => i.job)).toEqual([{ region: "West Yorkshire" }]);
    await save(get, act, "sam-lee", { country: "yy" });
    expect(valuesWith(env, "queue:").map((i) => i.job.country)).toEqual([undefined, ""]);
  });

  it("uses plain labels with hints, an empty salary box for no minimum, and a back button", async () => {
    const { env, act, get } = await setup();
    const { body } = await get("/admin/profile?u=sam-lee");
    expect(body).toContain('<label for="places">Towns</label>');
    expect(body).toContain('<label for="min_salary">Minimum salary</label>');
    expect(body).toContain("Jobs that don&#39;t show a salary are always included.");
    expect(body).not.toContain("All profiles");
    expect(body).toMatch(/<\/div><\/div><a class="back" href="\/admin"><svg [^>]*aria-hidden="true"><path [^>]*\/><\/svg>Back to recruits<\/a><main class="wide">/);
    expect(body).toMatch(/<body><style>[^<]*<\/style><div class="me" role="region" aria-label="Signed in as /);
    expect(body).not.toMatch(/&larr;|[\u2190-\u21ff]/);
    expect((await get("/admin/profile?u=jordan-patel")).body).toContain('id="min_salary" name="min_salary" value=""');
    for (const min_salary of ["£45,000", "", "45k"]) await save(get, act, "jordan-patel", { min_salary });
    expect(valuesWith(env, "queue:").map((i) => i.job.min_salary)).toEqual(["45000", "0", "45000"]);
  });

  it("refuses a bad email without losing what was typed, and ignores an unknown level or a bad profile id", async () => {
    const { env, get, act } = await setup();
    const bad = await save(get, act, "jordan-patel", { name: "Alex M", email: "nope", location: "Bradford" });
    expect(bad.status).toBe(400);
    const body = await bad.text();
    expect(body).toContain("A name and a valid email address are needed.");
    expect(body).toContain('value="Alex M"');
    expect(body).toContain('value="Bradford"');
    expect((await save(get, act, "jordan-patel", { name: "" })).status).toBe(400);
    expect((await act({ action: "profile", u: "../etc" })).headers.get("Location")).toBe("/admin?done=profile");
    const res = await save(get, act, "jordan-patel", { level: "wizard", min_salary: "lots" });
    expect(res.headers.get("Location")).toBe("/admin/profile?u=jordan-patel&done=nochange");
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("applies changes still waiting for HermitShell in order", async () => {
    const { get, act } = await setup();
    await save(get, act, "jordan-patel", { titles: "Data Engineer" });
    await save(get, act, "jordan-patel", { titles: "Data Engineer\nML Engineer", location: "York" });
    const { body } = await get("/admin/profile?u=jordan-patel");
    expect(body).toContain(">Data Engineer\nML Engineer</textarea>");
    expect(body).toContain('value="York"');
  });
});

describe("daily report and Send jobs now", () => {
  const scheduled = (sam = {}) => ({ ...STATUS, timezone: "Europe/London", scheduler: true, profiles: [
    { ...STATUS.profiles[0], report: { time: "08:00", days: "daily", schedule: "0 8 * * *", job: true, pending: false } },
    { ...STATUS.profiles[1], report: { time: "08:15", days: "weekdays", schedule: "15 8 * * 1-5", job: true, pending: false },
      ...sam }] });

  it("shows each profile's report time and queues a new one as { time, days }", async () => {
    const { env, get, act } = await setup(scheduled());
    const dash = (await get("/admin")).body;
    expect(dash).toContain("Daily at 08:00</div>");
    expect(dash).toContain("Weekdays at 08:15</div>");
    const { body } = await get("/admin/profile?u=sam-lee");
    expect(body).toContain('<input id="report_time" name="report_time" type="time" value="08:15">');
    expect(body).toContain('<option value="weekdays" selected>Weekdays (Monday to Friday)</option>');
    expect(body).toContain("When HermitShell sends their report (Europe/London). Each recruit&#39;s report is its own scheduled job.");
    expect(body).not.toContain("Hermes ");
    await save(get, act, "sam-lee", { report_time: "06:45", report_days: "daily" });
    await save(get, act, "jordan-patel", { report_days: "weekdays" });
    expect(valuesWith(env, "queue:").map((i) => [i.u, i.report, i.details, i.job])).toEqual([
      ["sam-lee", { time: "06:45", days: "daily" }, undefined, undefined], ["jordan-patel", { days: "weekdays" }, undefined, undefined]]);
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
    expect((await pending.get("/admin")).body).toContain("Daily at 07:00 (moving)");
    expect((await pending.get("/admin/profile?u=sam-lee")).body).toContain("HermitShell moves the report to this time when it next checks in");
    const outside = await setup({ ...scheduled(), scheduler: false });
    expect((await outside.get("/admin/profile?u=jordan-patel")).body).toContain("HermitShell&#39;s scheduler isn&#39;t set up");
    const older = await setup({ ...scheduled(), scheduler: undefined, hermes_jobs: false });
    expect((await older.get("/admin/profile?u=jordan-patel")).body).toContain("HermitShell&#39;s scheduler isn&#39;t set up");
  });

  it("queues Send jobs now for one profile, from the dashboard or its page", async () => {
    const { env, get, act } = await setup(scheduled());
    const dash = (await get("/admin")).body;
    expect(dash.match(/>Send jobs</g)).toHaveLength(1);
    expect(dash).toContain('name="action" value="send_now"><input type="hidden" name="u" value="sam-lee">');
    const res = await act({ action: "send_now", u: "sam-lee" });
    expect(res.headers.get("Location")).toBe("/admin?done=sending");
    expect((await get("/admin?done=sending")).body).toContain("HermitShell starts the scan within seconds");
    const back = await act({ action: "send_now", u: "sam-lee", back: "profile" });
    expect(back.headers.get("Location")).toBe("/admin/profile?u=sam-lee&done=sending");
    // The second press came within a minute, so it is the same scan and is not queued again.
    expect(valuesWith(env, "queue:")).toEqual([expect.objectContaining({ type: "admin", action: "send_now", u: "sam-lee" })]);
    const page = (await get("/admin/profile?u=sam-lee&done=sending")).body;
    expect(page).toContain('src="/admin/profile/status?u=sam-lee&amp;n=1"');
    expect((await get("/admin/profile/status?u=sam-lee&n=1")).body).toContain("Starting the scan&hellip;");
    expect((await get("/admin/profile?u=jordan-patel")).body).toContain("Upload a CV first");
    expect((await act({ action: "send_now", u: "../owner" })).status).toBe(400);
  });

  it("shows a scan that is running instead of the button", async () => {
    const started = Date.now() - 3 * 60 * 1000;
    const { get } = await setup(scheduled({ scanning: started }));
    const dash = (await get("/admin")).body;
    expect(dash).toContain('<span class="pill scanning">scanning now</span>');
    expect(dash).toContain('<button class="small" disabled>Scanning&hellip;</button>');
    expect(dash).not.toContain(">Send jobs<");
    expect((await get("/admin/profile?u=sam-lee")).body).toContain("Scanning now (started ");
    const box = (await get("/admin/profile/status?u=sam-lee&n=1")).body;
    expect(box).toContain('<body class="wait');
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
    expect(idle.body).toContain('<body class="ok');
    expect(idle.body).toContain("Up to date. HermitShell last reported just now.");
    expect(idle.body).not.toContain("http-equiv");
    await save(get, act, "sam-lee", { phone: "07700 900111" });
    const waiting = await get("/admin/profile/status?u=sam-lee&n=1");
    expect(waiting.body).toContain("Waiting for HermitShell to apply it");
    expect(waiting.body).toContain('<body class="wait');
    expect(waiting.body).toContain('<meta http-equiv="refresh" content="5;url=/admin/profile/status?u=sam-lee&amp;n=2">');
    expect((await get("/admin/profile/status?u=jordan-patel")).body).toContain("Up to date");
    const ids = keysWith(env, "queue:");
    await worker.fetch(new Request(`${BASE}/api/queue/ack`, { method: "POST", headers: API_HEADERS, body: JSON.stringify({ ids }) }), env);
    const applied = await get("/admin/profile/status?u=sam-lee&n=3");
    expect(applied.body).toContain("Applied by HermitShell");
    expect(applied.body).toContain('<body class="done');
    expect(applied.body).not.toContain("http-equiv");
  });

  it("slows down and then stops checking, to spare the free plan's KV list quota", async () => {
    const { get, act } = await setup();
    await save(get, act, "sam-lee", { phone: "07700 900111" });
    expect((await get("/admin/profile/status?u=sam-lee&n=15")).body).toContain('content="20;url=');
    const stopped = await get("/admin/profile/status?u=sam-lee&n=21");
    expect(stopped.body).toContain("Still waiting for HermitShell");
    expect(stopped.body).toContain('<body class="idle');
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
    await upload({ u: "jordan-patel", cv_text: CV_TEXT });
    expect((await get("/admin/profile/status?u=jordan-patel&n=1")).body).toContain("reading the new CV");
  });

  it("can only be framed by the dashboard itself", async () => {
    const { get } = await setup();
    const { res } = await get("/admin/profile/status?u=jordan-patel");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const page = await get("/admin/profile?u=jordan-patel");
    expect(page.res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(page.res.headers.get("Content-Security-Policy")).toContain("frame-src 'self'");
    expect((await get("/admin/profile/status?u=../x")).res.status).toBe(404);
  });
});

describe("CV upload", () => {
  it("stores the file like a sign-up and queues a rebuild", async () => {
    const { env, upload } = await setup();
    const pdf = new File([new TextEncoder().encode("%PDF-1.4 cv")], "Alex Morgan CV.pdf", { type: "application/pdf" });
    const res = await upload({ u: "jordan-patel", roles: "Data engineering" }, pdf);
    expect(res.headers.get("Location")).toBe("/admin/profile?u=jordan-patel&done=cvqueued");
    const [item] = valuesWith(env, "queue:");
    expect(item).toMatchObject({ type: "admin", action: "cv", u: "jordan-patel", roles: "Data engineering", cv: { kind: "pdf", size: 11, sealed: true } });
    const stored = new Uint8Array(env.FEEDBACK.store.get(item.cv.key));
    expect(new TextDecoder().decode(stored)).not.toContain("%PDF");
    expect(new TextDecoder().decode(await KEYS.openBytes(stored, item.cv.key))).toBe("%PDF-1.4 cv");
    await expect(KEYS.openBytes(stored, "cvfile:another")).rejects.toThrow();
    expect(valuesWith(env, "history:jordan-patel:")).toMatchObject([[{ k: "cv", t: "Uploaded a new CV (Alex Morgan CV.pdf)", by: "Alex Morgan" }]]);
  });

  it("accepts pasted text and refuses too little, the wrong type or too much", async () => {
    const { env, upload } = await setup();
    expect((await upload({ u: "sam-lee", cv_text: "short" })).headers.get("Location")).toContain("done=cvmissing");
    expect((await upload({ u: "sam-lee" }, new File(["MZ"], "cv.pdf"))).headers.get("Location")).toContain("done=cvtype");
    expect((await upload({ u: "sam-lee" }, new File([new Uint8Array(6 * 1024 * 1024)], "cv.pdf"))).status).toBe(413);
    expect(keysWith(env, "cvfile:")).toEqual([]);
    expect(keysWith(env, "history:")).toEqual([]);
    await upload({ u: "sam-lee", cv_text: CV_TEXT });
    const queued = valuesWith(env, "queue:");
    expect(queued).toMatchObject([{ action: "cv", u: "sam-lee", cv: null, sealed: ["cv_text"] }]);
    expect(await KEYS.open(queued[0].cv_text, "cv_text")).toBe(CV_TEXT.trim());
    expect(valuesWith(env, "history:sam-lee:")).toMatchObject([[{ k: "cv", t: "Pasted new CV text" }]]);
  });

  it("needs the CSRF token and a valid profile id", async () => {
    const { env, cookie } = await setup();
    const form = new FormData();
    form.append("csrf", "0".repeat(32));
    form.append("u", "jordan-patel");
    form.append("cv_text", CV_TEXT);
    const res = await worker.fetch(new Request(`${BASE}/admin/cv`, { method: "POST", body: form, headers: { Cookie: cookie } }), env);
    expect(res.status).toBe(403);
    const { upload } = await setup();
    expect((await upload({ u: "../../x", cv_text: CV_TEXT })).status).toBe(400);
    expect(valuesWith(env, "queue:")).toEqual([]);
  });
});

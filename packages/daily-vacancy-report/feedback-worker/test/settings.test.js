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
    expect(body).toContain('href="#email"');
    expect(body).toContain('href="#keys"');
    expect(body).toContain('href="/admin/profile?u=owner#cv"');
    expect(body).toContain('href="/admin/profile?u=owner#job"');
    expect(body).toContain("no CV");
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

describe("email server", () => {
  it("queues the settings, with the password expiring early", async () => {
    const { env, act } = await setup();
    withTtls(env);
    const res = await act({ action: "email", host: "smtp.gmail.com", port: "587", user: "alex@example.com",
      password: "abcd efgh ijkl mnop", from: "" });
    expect(res.headers.get("Location")).toBe("/admin?done=queued#email");
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
      expect(res.headers.get("Location")).toBe("/admin?done=bademail#email");
    }
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("queues a test email and a reset to the .env settings", async () => {
    const { env, act } = await setup();
    await act({ action: "test_email", to: "alex@example.com" });
    await act({ action: "email_clear" });
    expect((await act({ action: "test_email", to: "nope" })).headers.get("Location")).toBe("/admin?done=bademail#email");
    expect(valuesWith(env, "queue:").map(({ action, to, clear }) => ({ action, to, clear }))).toEqual([
      { action: "test_email", to: "alex@example.com", clear: undefined },
      { action: "email", to: undefined, clear: true },
    ]);
  });

  it("never shows the password, only whether one is set", async () => {
    const { get } = await setup({ ...STATUS, email: { ...STATUS.email, user: "alex@example.com", password_set: true, source: "env",
      last_test: { ok: false, at: 1, error: "SMTPAuthenticationError: 535 <bad>" } } });
    const { body } = await get("/admin");
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
    expect(res.headers.get("Location")).toBe("/admin?done=queued#keys");
    expect(valuesWith(env, "queue:")).toMatchObject([{ action: "api_keys", firecrawl: ["fc-aaaa1111", "fc-bbbb2222"], tavily: "tvly-cccc3333" }]);
    expect(valuesWith(env, "queue:")[0]).not.toHaveProperty("scrapfly");
    expect(ttlOf(env, "queue:")).toBe(SECRET_TTL_SECONDS);
  });

  it("refuses nothing or anything that isn't a key, and clears one provider at a time", async () => {
    const { env, act } = await setup();
    expect((await act({ action: "api_keys" })).headers.get("Location")).toBe("/admin?done=badkey#keys");
    expect((await act({ action: "api_keys", scrapfly: "key with spaces" })).headers.get("Location")).toBe("/admin?done=badkey#keys");
    expect((await act({ action: "api_keys_clear", provider: "github" })).headers.get("Location")).toBe("/admin?done=badkey#keys");
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

  it("queues details and job search changes separately", async () => {
    const { env, act } = await setup();
    const saved = await act({ action: "profile", section: "details", u: "owner", name: "Alex Morgan", email: "alex.m@example.com",
      phone: "07700 900456", location: "Leeds" });
    expect(saved.headers.get("Location")).toBe("/admin/profile?u=owner&done=queued#details");
    await act({ action: "profile", section: "job", u: "owner", titles: "Data Engineer\nAnalytics Engineer\n\nData Engineer",
      region: "West Yorkshire", places: "Leeds, Bradford", country: "GB", remote_anywhere: "1", level: "senior",
      types: ["Permanent", "Bogus"], modes: ["Remote"], min_salary: "55,000", currency: "£" });
    const [details, job] = valuesWith(env, "queue:");
    expect(details).toMatchObject({ action: "profile", u: "owner",
      details: { name: "Alex Morgan", email: "alex.m@example.com", phone: "07700 900456", location: "Leeds" } });
    expect(details).not.toHaveProperty("job");
    expect(job.job).toEqual({ titles: ["Data Engineer", "Analytics Engineer"], region: "West Yorkshire", places: ["Leeds", "Bradford"],
      search_location: "", country: "gb", remote_anywhere: true, level: "senior", types: ["Permanent"], modes: ["Remote"],
      min_salary: "55000", currency: "£", hide_agency: false });
  });

  it("refuses a bad email, an unknown level and a bad profile id", async () => {
    const { env, act } = await setup();
    const bad = await act({ action: "profile", section: "details", u: "owner", name: "Alex", email: "nope" });
    expect(bad.headers.get("Location")).toBe("/admin/profile?u=owner&done=baddetails#details");
    expect((await act({ action: "profile", section: "job", u: "../etc" })).headers.get("Location")).toBe("/admin?done=profile#job");
    await act({ action: "profile", section: "job", u: "owner", level: "wizard", min_salary: "lots" });
    expect(valuesWith(env, "queue:")).toMatchObject([{ job: { level: "any", min_salary: "0" } }]);
  });
});

describe("CV upload", () => {
  it("stores the file like a sign-up and queues a rebuild", async () => {
    const { env, upload } = await setup();
    const pdf = new File([new TextEncoder().encode("%PDF-1.4 cv")], "Alex Morgan CV.pdf", { type: "application/pdf" });
    const res = await upload({ u: "owner", roles: "Data engineering" }, pdf);
    expect(res.headers.get("Location")).toBe("/admin/profile?u=owner&done=cvqueued#cv");
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

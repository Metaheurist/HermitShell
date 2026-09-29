import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { crawlerCell, keyModal } from "../src/keys.js";
import { BASE, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const STATUS = {
  timezone: "Europe/London",
  profiles: [
    { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, has_cv: true,
      crawler: "global", provider: "firecrawl", key_hint: "fc-...0001" },
    { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true,
      crawler: "own", provider: "tavily", key_hint: "tvl...9d2a" },
    { id: "jordan-patel", name: "Jordan <b>Patel</b>", email: "jordan@example.net", status: "active", has_cv: true,
      crawler: "global", provider: "", key_hint: "" },
  ],
};

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

async function setup(status = STATUS) {
  const env = testEnv(ADMIN);
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify(status) }), env);
  const res = await worker.fetch(post("/admin/login", { username: "admin", password: ADMIN.ADMIN_PASSWORD }, { "CF-Connecting-IP": "203.0.113.9" }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const body = await (await worker.fetch(new Request(`${BASE}/admin`, { headers: { Cookie: cookie } }), env)).text();
  const csrf = body.match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const act = (fields) => worker.fetch(post("/admin/action", { csrf, ...fields }, { Cookie: cookie }), env);
  return { env, body, act };
}

function rowOf(body, id) {
  return body.split("<tr>").find((r) => r.includes(`/admin/profile?u=${id}"`));
}

describe("crawler keys on the dashboard", () => {
  it("shows the provider and a masked key only when one is set, else an Add key button", async () => {
    const { body } = await setup();
    const sam = rowOf(body, "sam-lee");
    expect(sam).toContain("<b>Tavily</b>");
    expect(sam).toContain('<code class="keyhint"');
    expect(sam).toContain("tvl...9d2a");
    expect(sam).toContain('href="#key-sam-lee">Change</a>');
    expect(sam).toContain('name="action" value="use_global"');
    const jordan = rowOf(body, "jordan-patel");
    expect(jordan).toContain('<a class="addkey" href="#key-jordan-patel">');
    expect(jordan).not.toContain("keyhint");
    expect(jordan).not.toContain("global key");
    expect(body).not.toContain('name="key" type="password" placeholder="Their Firecrawl key"');
  });

  it("shows the owner's global key with a link to Global settings instead of Remove", async () => {
    const { body } = await setup();
    const owner = rowOf(body, "owner");
    expect(owner).toContain("<b>Firecrawl</b>");
    expect(owner).toContain('<span class="crtag">global</span>');
    expect(owner).toContain('href="/admin/settings#keys">Change</a>');
    expect(owner).not.toContain("use_global");
  });

  it("renders one modal per profile outside <main>, opened by :target", async () => {
    const { body } = await setup();
    const main = body.indexOf("<main");
    for (const id of ["owner", "sam-lee", "jordan-patel"]) {
      const at = body.indexOf(`<div class="modal" id="key-${id}"`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(main);
    }
    expect(body).toContain(".modal:target{display:grid}");
    expect(body).toContain('href="#_" aria-label="Close"');
    expect(body).toContain("Jordan &lt;b&gt;Patel&lt;/b&gt;'s searches will use only this key");
    expect(body).not.toContain("<b>Patel</b>");
  });

  it("preselects the current provider and offers only providers that can search", () => {
    const modal = keyModal(STATUS.profiles[1], "c".repeat(32));
    expect(modal).toContain('value="tavily" checked');
    expect(modal).not.toContain('value="firecrawl" checked');
    expect(modal).not.toContain("scrapfly");
    expect(modal).toContain('name="key" type="password" autocomplete="off" required');
    expect(keyModal(STATUS.profiles[2], "c".repeat(32))).toContain('value="firecrawl" checked');
  });

  it("treats an unknown provider as no key and escapes the hint", () => {
    expect(crawlerCell({ id: "x", provider: "other", key_hint: "abc" }, "c")).toContain('class="addkey"');
    expect(crawlerCell({ id: "x", provider: "firecrawl", key_hint: "<i>" }, "c")).toContain("&lt;i&gt;");
  });

  it("queues the key with its provider, defaults to Firecrawl and refuses other providers", async () => {
    const { env, act } = await setup();
    expect((await act({ action: "set_key", u: "jordan-patel", key: "tvly-new-key-123", provider: "tavily" })).headers.get("Location"))
      .toBe("/admin?done=queued");
    await act({ action: "set_key", u: "jordan-patel", key: "fc-new-key-4567" });
    expect((await act({ action: "set_key", u: "jordan-patel", key: "scp-new-key-890", provider: "scrapfly" })).headers.get("Location"))
      .toBe("/admin?done=badkey");
    expect((await act({ action: "set_key", u: "jordan-patel", key: "bad key!", provider: "tavily" })).headers.get("Location"))
      .toBe("/admin?done=badkey");
    expect(valuesWith(env, "queue:").map(({ action, u, key, provider }) => ({ action, u, key, provider }))).toEqual([
      { action: "set_key", u: "jordan-patel", key: "tvly-new-key-123", provider: "tavily" },
      { action: "set_key", u: "jordan-patel", key: "fc-new-key-4567", provider: "firecrawl" },
    ]);
  });
});

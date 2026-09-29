import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { PROVIDERS, keyModals, keysSection } from "../src/keys.js";
import { BASE, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const STATUS = {
  timezone: "Europe/London",
  keys: { firecrawl: { source: "env", hint: "fc-...0001", backups: 2 }, tavily: { source: "dashboard", hint: "tvl...9d2a" }, scrapfly: { source: "none" } },
  profiles: [
    { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, has_cv: true },
    { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true },
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
  const get = async (path) => (await worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env)).text();
  const settings = await get("/admin/settings");
  const csrf = settings.match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const act = (fields) => worker.fetch(post("/admin/action", { csrf, ...fields }, { Cookie: cookie }), env);
  return { env, settings, get, act };
}

describe("web search keys in Global settings", () => {
  it("shows one row per provider with where the key comes from, a masked hint and Add key or Change", async () => {
    const { settings } = await setup();
    const row = (name) => settings.split('<div class="keyrow').find((r) => r.startsWith(` cr-${name}"`));
    expect(row("firecrawl")).toContain('<span class="crtag env">from .env</span>');
    expect(row("firecrawl")).toContain("fc-...0001");
    expect(row("firecrawl")).toContain("plus 2 backup keys");
    expect(row("firecrawl")).toContain('href="#gkey-firecrawl">Change</a>');
    expect(row("firecrawl")).not.toContain("api_keys_clear");
    expect(row("tavily")).toContain('<span class="crtag">set here</span>');
    expect(row("tavily")).toContain('name="action" value="api_keys_clear"');
    expect(row("scrapfly")).toContain('<a class="addkey" href="#gkey-scrapfly">');
    expect(row("scrapfly")).toContain("No key yet");
    expect(settings).not.toContain('name="firecrawl" type="password"');
    expect(settings).not.toContain("Save keys");
  });

  it("renders one modal per provider outside <main>, each preselecting its own provider", async () => {
    const { settings } = await setup();
    const main = settings.indexOf("<main");
    for (const name of Object.keys(PROVIDERS)) {
      const at = settings.indexOf(`<div class="modal" id="gkey-${name}"`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(main);
      const modal = settings.slice(at).split('<div class="modal"')[1];
      expect(modal).toContain(`value="${name}" checked`);
      expect(modal.match(/ checked/g)).toHaveLength(1);
      expect(modal).toContain('name="action" value="api_key"');
      expect(modal).toContain('name="key" type="password" autocomplete="off" required');
    }
    expect(settings).toContain(".modal:target{display:grid}");
    expect(keyModals("c".repeat(32))).toContain('class="crchoices three"');
  });

  it("offers every provider in the modal but never shows a key or a hint unescaped", () => {
    const html = keysSection({ keys: { firecrawl: { source: "dashboard", hint: "<i>x</i>" } } }, "c");
    expect(html).toContain("&lt;i&gt;x&lt;/i&gt;");
    expect(html).not.toContain("<i>x</i>");
    for (const name of ["firecrawl", "tavily", "scrapfly"]) expect(keyModals("c")).toContain(`value="${name}"`);
  });

  it("queues the key for the chosen provider, several Firecrawl keys at once, and refuses anything else", async () => {
    const { env, act } = await setup();
    const at = async (fields) => (await act({ action: "api_key", ...fields })).headers.get("Location");
    expect(await at({ provider: "tavily", key: "tvly-new-key-123" })).toBe("/admin/settings?done=queued#keys");
    expect(await at({ provider: "firecrawl", key: "fc-one11111, fc-two22222" })).toBe("/admin/settings?done=queued#keys");
    expect(await at({ key: "fc-default-provider" })).toBe("/admin/settings?done=queued#keys");
    for (const bad of [{ provider: "tavily", key: "bad key!" }, { provider: "PATH", key: "fc-one11111" }, { provider: "tavily", key: "tvly-a1234567, tvly-b1234567" },
      { provider: "scrapfly", key: "" }]) {
      expect(await at(bad)).toBe("/admin/settings?done=badkey#keys");
    }
    expect(valuesWith(env, "queue:").map(({ action, firecrawl, tavily }) => ({ action, firecrawl, tavily }))).toEqual([
      { action: "api_keys", firecrawl: undefined, tavily: "tvly-new-key-123" },
      { action: "api_keys", firecrawl: ["fc-one11111", "fc-two22222"], tavily: undefined },
      { action: "api_keys", firecrawl: ["fc-default-provider"], tavily: undefined },
    ]);
  });

  it("has no per-recruit crawler keys any more: no Crawler column, no key modals, set_key refused", async () => {
    const { env, get, act } = await setup();
    const dash = await get("/admin");
    expect(dash).not.toContain("<th>Crawler</th>");
    expect(dash).not.toContain('id="key-');
    expect(dash).not.toContain("Add key");
    for (const action of ["set_key", "use_global"]) {
      expect((await act({ action, u: "sam-lee", key: "tvly-new-key-123", provider: "tavily" })).status).toBe(400);
    }
    expect(valuesWith(env, "queue:")).toEqual([]);
  });
});

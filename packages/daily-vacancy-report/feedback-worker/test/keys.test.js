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

  it("opens a provider with a key, when pressed, to each key masked with what is left of it", () => {
    const at = Date.now() - 12 * 60000;
    const html = keysSection({ keys: {
      firecrawl: { source: "env", hint: "fc-...0001", backups: 2, keys: [
        { hint: "fc-...0001", role: "main", at, usage: { used: 2000, limit: 3000, left: 1000, plan: "Hobby", resets: "2026-10-01" } },
        { hint: "fc-...0002", role: "backup", at, error: "the key was rejected" },
        { hint: "fc-...0003", role: "backup" }] },
      tavily: { source: "dashboard", hint: "tvl...9d2a", keys: [{ hint: "tvl...9d2a", role: "main", at, usage: { used: 950, limit: 1000, left: 50 } }] },
      scrapfly: { source: "none", keys: [{ hint: "scp...0001", role: "main" }] } } }, "c".repeat(32));
    const card = (name) => html.split('<details class="keycard').find((r) => r.startsWith(` cr-${name}"`))?.split("</details>")[0];
    const fc = card("firecrawl");
    expect(fc).toMatch(/^ cr-firecrawl"><summary class="keyrow" title="Show the keys and their usage">/);
    expect(fc).toContain('<span class="kleft">1,000 credits left across 3 keys</span> &middot; plus 2 backup keys &middot; ');
    expect(fc).toContain('href="#gkey-firecrawl">Change</a>');
    expect(fc).toMatch(/<svg class="kchev"[^>]*>.*?<\/svg><\/summary>/);
    expect(fc).toContain('<span class="krole">Main key</span><code>fc-...0001</code><span class="kpct mid">33% left</span>');
    expect(fc).toContain('<div class="kbar mid" role="progressbar" aria-valuenow="33"');
    expect(fc).toContain("<b>1,000</b> of 3,000 credits left");
    expect(fc).toContain("Hobby plan &middot; resets 1 Oct &middot; checked 12 minutes ago");
    expect(fc).toContain('<span class="krole">Backup key 1</span><code>fc-...0002</code>');
    expect(fc).toContain('<div class="kuse bad">Couldn&rsquo;t check it: the key was rejected</div>');
    expect(fc).toContain('<span class="krole">Backup key 2</span><code>fc-...0003</code>');
    expect(fc).toContain("Not checked yet.");
    const tv = card("tavily");
    expect(tv).toContain('<span class="kleft low">50 credits left</span>');
    expect(tv).toContain('<span class="kpct low">5% left</span>');
    expect(tv).toContain('name="action" value="api_keys_clear"');
    expect(card("scrapfly")).toBeUndefined();
    expect(html).toContain('<div class="keyrow cr-scrapfly">');
    expect(html).toContain("Press a provider to see its keys");
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

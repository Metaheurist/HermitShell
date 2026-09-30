import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { MODEL_PROVIDERS, modelModals, modelsSection, serverBox } from "../src/models.js";
import { BASE, sealingKeys, testEnv, valuesWith } from "./helpers.js";

const CLOUD_ICON = '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.7 4.7 0 0 0 7 18.5Z"/>';

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const NOW = Date.now();
const STATUS = {
  timezone: "Europe/London",
  keys: { firecrawl: { source: "none" }, tavily: { source: "none" }, scrapfly: { source: "none" } },
  models: {
    openrouter: { source: "dashboard", hint: "sk-...7f2a", model: "openrouter/free", today: 38, resting_until: null, why: "",
      keys: [{ hint: "sk-...7f2a", role: "main", at: NOW - 60000, usage: { used: 38, limit: 1000, left: 962, plan: "Free models", resets: "2026-10-01", unit: "requests" } }] },
    bazaarlink: { source: "env", hint: "sk-...b1b1", model: "auto:free", today: 0,
      keys: [{ hint: "sk-...b1b1", role: "main", at: NOW - 60000, usage: { used: 1.25, limit: 5, left: 3.75, plan: "Credits", resets: "", unit: "usd" } }] },
    featherless: { source: "none", hint: "" },
    huggingface: { source: "env", hint: "hf_...c9d1", model: "openai/gpt-oss-20b:cheapest", resting_until: NOW + 3600000, why: "out of credits",
      keys: [{ hint: "hf_...c9d1", role: "main", at: NOW - 60000, usage: { plan: "PRO", unit: "plan" } }] },
  },
  llm: { order: "cloud", cloud: ["openrouter", "bazaarlink", "huggingface"],
    local: { model: "qwen3:4b-instruct-2507-q4_K_M", suggested: "qwen2.5:1.5b-instruct", where: "8192 context, on the GPU" },
    last: { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free", at: NOW - 5 * 60000 } },
  server: { cpu: { model: "AMD Ryzen 7 5700G", cores: 16 }, load: 3.4, ram_mb: { total: 32768, available: 16384 },
    gpus: [{ name: "NVIDIA GeForce RTX 3060", vram_mb: 12288, free_mb: 1024 }], disk_mb: { total: 1000000, free: 500000 } },
  profiles: [{ id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, has_cv: true }],
};

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

async function login(env, username, password) {
  const res = await worker.fetch(post("/admin/login", { username, password }, { "CF-Connecting-IP": "203.0.113.9" }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = async (path) => (await worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env)).text();
  const csrf = (await get("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)[1];
  return { cookie, csrf, get };
}

async function setup(status = STATUS) {
  const env = testEnv(ADMIN);
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify(status) }), env);
  const admin = await login(env, "admin", ADMIN.ADMIN_PASSWORD);
  const act = (fields) => worker.fetch(post("/admin/action", { csrf: admin.csrf, ...fields }, { Cookie: admin.cookie }), env);
  return { env, admin, act, settings: await admin.get("/admin/settings") };
}

const card = (html, name) => html.split(/<(?:details class="keycard|div class="keyrow)/).find((r) => r.startsWith(` cr-${name}"`));

describe("AI model keys in Global settings", () => {
  it("lists each provider with its logo, masked key, model, state and usage, then the local Ollama", async () => {
    const { settings } = await setup();
    expect(settings).toContain('<h2 id="models">AI model API keys</h2>');
    const or = card(settings, "openrouter");
    expect(or).toContain('<span class="crtag">set here</span>');
    expect(or).toContain("sk-...7f2a");
    expect(or).toContain('<code class="mname">openrouter/free</code> &middot; 38 requests today');
    expect(or).toContain('<span class="kleft">962 requests left today</span>');
    expect(or).toContain("<b>962</b> of 1,000 requests left today");
    expect(or).toContain('name="action" value="model_key_clear"');
    expect(card(settings, "bazaarlink")).toContain("<b>$3.75</b> of $5.00 left");
    const hf = card(settings, "huggingface");
    expect(hf).toContain('<span class="mrest">resting: out of credits</span>');
    expect(hf).toContain("<b>PRO</b> plan");
    expect(hf).not.toContain("model_key_clear");
    expect(card(settings, "featherless")).toContain('<a class="addkey" href="#mkey-featherless">');
    const local = card(settings, "ollama");
    expect(local).toContain("<b>Local Ollama</b>");
    expect(local).toContain('<span class="crtag env">fallback</span>');
    expect(local).toContain("last ran at 8192 context, on the GPU");
    expect(local).toContain('this machine suits <code class="mname">qwen2.5:1.5b-instruct</code>');
    expect(settings).toMatch(/name="order" value="cloud" checked/);
    for (const name of Object.keys(MODEL_PROVIDERS)) expect(settings).toContain(`cr-${name}`);
  });

  it("renders one modal per provider outside <main>, each preselecting its own provider", async () => {
    const { settings } = await setup();
    const main = settings.indexOf("<main");
    for (const name of Object.keys(MODEL_PROVIDERS)) {
      const at = settings.indexOf(`<div class="modal" id="mkey-${name}"`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(main);
      const modal = settings.slice(at).split('<div class="modal"')[1].split("</form>")[0];
      expect(modal).toContain(`value="${name}" checked`);
      expect(modal.match(/ checked/g)).toHaveLength(1);
      expect(modal).toContain('name="action" value="model_key"');
      expect(modal).toContain('name="key" type="password" autocomplete="off"');
      expect(modal).toContain('name="model"');
    }
  });

  it("queues a sealed key, a model, a clear and the order, and refuses anything else", async () => {
    const keys = await sealingKeys();
    const { env, act } = await setup({ ...STATUS, ...keys.status });
    const at = async (fields) => (await act(fields)).headers.get("Location");
    expect(await at({ action: "model_key", provider: "openrouter", key: "test-openrouter-key" })).toBe("/admin/settings?done=queued#models");
    const [sealed] = valuesWith(env, "queue:");
    expect(sealed.sealed).toEqual(["key"]);
    expect(await keys.open(sealed.key, "key")).toBe("test-openrouter-key");
    expect(await at({ action: "model_key", provider: "featherless", model: "meta-llama/Llama-3.1-8B-Instruct" })).toBe("/admin/settings?done=queued#models");
    expect(await at({ action: "model_key_clear", provider: "huggingface" })).toBe("/admin/settings?done=queued#models");
    expect(await at({ action: "model_order", order: "local" })).toBe("/admin/settings?done=queued#models");
    for (const bad of [{ action: "model_key", provider: "openai", key: "test-openai-key" }, { action: "model_key", provider: "openrouter" },
      { action: "model_key", provider: "openrouter", key: "bad key!" }, { action: "model_key", provider: "openrouter", model: "a b" },
      { action: "model_key_clear", provider: "__proto__" }, { action: "model_order", order: "sideways" }]) {
      expect(await at(bad)).toBe("/admin/settings?done=badmodel#models");
    }
    expect(valuesWith(env, "queue:").map(({ action, provider, key, model, clear, order }) =>
      ({ action, provider, key: key === sealed.key ? "<sealed>" : key, model, clear, order }))).toEqual([
      { action: "model_keys", provider: "openrouter", key: "<sealed>", model: undefined, clear: undefined, order: undefined },
      { action: "model_keys", provider: "featherless", key: undefined, model: "meta-llama/Llama-3.1-8B-Instruct", clear: undefined, order: undefined },
      { action: "model_keys", provider: "huggingface", key: undefined, model: undefined, clear: true, order: undefined },
      { action: "model_keys", provider: undefined, key: undefined, model: undefined, clear: undefined, order: "local" },
    ]);
  });

  it("draws Cloud first with a cloud and Local first with a computer", async () => {
    const { settings } = await setup();
    const choice = (value) => settings.split('<label class="crchoice">').find((c) => c.includes(`value="${value}"`));
    expect(choice("cloud")).toContain(CLOUD_ICON);
    expect(choice("local")).toContain('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>');
    expect(card(settings, "ollama")).toContain('<rect x="7" y="7" width="10" height="10" rx="2"/>');
  });

  it("shows sensible rows before HermitShell reports any models", () => {
    const html = modelsSection({}, "c");
    for (const name of Object.keys(MODEL_PROVIDERS)) expect(html).toContain(`href="#mkey-${name}"`);
    expect(html).toContain("No model yet");
    expect(modelModals("c")).toContain("openrouter/free");
  });
});

describe("the admin's server panel", () => {
  it("sits beside Sign out with the machine, the models in order and the last answer", async () => {
    const { admin } = await setup();
    const dash = await admin.get("/admin");
    const box = dash.slice(dash.indexOf('<div class="mebtns">'), dash.indexOf("Sign out"));
    expect(box).toContain('<div class="srv" tabindex="0"');
    expect(box).toContain('role="tooltip"');
    expect(box).toContain("AMD Ryzen 7 5700G &middot; 16 threads &middot; load 3.4");
    expect(box).toContain("16 GB of 32 GB used");
    expect(box).toContain("NVIDIA GeForce RTX 3060 &middot; 11 GB of 12 GB");
    expect(box).toMatch(/<b>GPU<\/b>.*?<div class="sbar low"/s);
    expect(box).toContain("488 GB free of 977 GB");
    const order = [...box.matchAll(/<li[^>]*>.*?<b>([^<]+)<\/b>/g)].map((m) => m[1]);
    expect(order).toEqual(["OpenRouter", "BazaarLink", "Hugging Face", "Local Ollama"]);
    expect(box).toContain("Last answer from OpenRouter");
    expect(box).toContain('href="/admin/settings#models"');
    expect(dash).toContain(".srv:hover .srvpanel,.srv:focus-within .srvpanel{display:block}");
  });

  it("puts the local Ollama first when it is asked first", () => {
    const html = serverBox({ ...STATUS, llm: { ...STATUS.llm, order: "local" } });
    expect([...html.matchAll(/<li[^>]*>.*?<b>([^<]+)<\/b>/g)].map((m) => m[1])[0]).toBe("Local Ollama");
  });

  it("is not shown to recruiters", async () => {
    const { env, admin } = await setup();
    await worker.fetch(post("/admin/users", { csrf: admin.csrf, op: "add", name: "Casey Quinn", username: "casey", password: "recruiter-password-1", roles: "recruiter" },
      { Cookie: admin.cookie }), env);
    const casey = await login(env, "casey", "recruiter-password-1");
    const dash = await casey.get("/admin");
    expect(dash).toContain("Sign out");
    expect(dash).not.toContain('class="srv"');
    expect(dash).not.toContain("AMD Ryzen");
  });

  it("says so when the machine hasn't been reported", () => {
    const html = serverBox({ profiles: [] });
    expect(html).toContain("HermitShell hasn&rsquo;t reported the machine yet.");
    expect(html).toContain("not reported yet");
  });
});

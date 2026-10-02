import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { OLLAMA_RE, localChoices, localModal, localPull, pullNotice, pullText, serverBox } from "../src/models.js";
import { taskRows } from "../src/tasks.js";
import { BASE, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const NOW = Date.now();
const SEVEN = "qwen2.5:7b-instruct-q4_K_M";
const CHOICES = [
  { model: "qwen3:30b-a3b-instruct-2507-q4_K_M", about: "The best answers", mb: 18600, gpu: 0, fits: false, speed: "quick", installed: false, recommended: false },
  { model: SEVEN, about: "Reliable skills", mb: 4700, gpu: 49, fits: true, speed: "quick", installed: false, recommended: false },
  { model: "qwen3:4b-instruct-2507-q4_K_M", about: "The default", mb: 2500, gpu: 100, fits: true, speed: "quick", installed: true, recommended: true },
  { model: "qwen3:8b", about: "Already on the server", mb: 5200, gpu: 0, fits: true, speed: "steady", installed: true, recommended: false },
];
const LOCAL = { model: "qwen3:4b-instruct-2507-q4_K_M", suggested: "qwen3:4b-instruct-2507-q4_K_M", where: "8192 context, on the CPU",
  source: "env", override: "", online: true, pull: null, choices: CHOICES };
const STATUS = {
  timezone: "Europe/London",
  keys: { firecrawl: { source: "none" }, tavily: { source: "none" }, scrapfly: { source: "none" } },
  models: {}, llm: { order: "cloud", cloud: [], local: LOCAL },
  profiles: [{ id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, has_cv: true }],
  tasks: [],
};
const PULL = { model: SEVEN, status: "downloading", done_mb: 2048, total_mb: 4700, started: NOW - 60000, finished: null, error: "", switch: true, stopping: false };
const withLocal = (local, extra = {}) => ({ ...STATUS, llm: { ...STATUS.llm, local: { ...LOCAL, ...local } }, ...extra });
const PULL_TASK = { id: "model:pull", kind: "model", u: "", state: "running", at: NOW - 60000, trigger: "dashboard", title: SEVEN,
  stage: "Downloading", done: 2048, total: 4700 };

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
  const act = (fields, as = admin) => worker.fetch(post("/admin/action", { csrf: as.csrf, ...fields }, { Cookie: as.cookie }), env);
  return { env, admin, act };
}

const modalOf = (html) => html.slice(html.indexOf('<div class="modal" id="mlocal"'), html.indexOf("</form>", html.indexOf('id="mlocal"')));
const row = (html) => html.split('<div class="keyrow cr-ollama">')[1].split('<div class="crchoices">')[0];

describe("the server model's row and its Change window", () => {
  it("shows where the model was set, and a Change link to every model HermitShell offers", async () => {
    const { admin } = await setup();
    const settings = await admin.get("/admin/settings");
    expect(row(settings)).toContain('<span class="crtag env">from .env</span>');
    expect(row(settings)).toContain('<a class="small" href="#mlocal">Change</a>');
    const modal = modalOf(settings);
    expect(settings.indexOf('id="mlocal"')).toBeLessThan(settings.indexOf("<main"));
    expect(modal).toContain('name="action" value="model_local"');
    expect(modal).toMatch(/name="model" value="" checked>/);
    expect(modal.match(/ checked/g)).toHaveLength(1);
    const choice = (name) => modal.split('<label class="crchoice mchoice').find((c) => c.includes(`value="${name}"`));
    expect(choice("qwen3:4b-instruct-2507-q4_K_M")).toContain('<em class="crtag">recommended</em> <em class="crtag env">downloaded</em> <em class="crtag env">in use</em>');
    expect(choice("qwen3:4b-instruct-2507-q4_K_M")).toContain("2.4 GB &middot; fits the GPU, quick here");
    expect(choice(SEVEN)).toContain("download 4.6 GB &middot; 49% on the GPU, the rest on the CPU, quick here");
    expect(choice("qwen3:8b")).toContain("on the CPU, steady here");
    expect(choice("qwen3:30b-a3b-instruct-2507-q4_K_M")).toMatch(/ off"><input [^>]*disabled>/);
    expect(choice("qwen3:30b-a3b-instruct-2507-q4_K_M")).toContain("needs more memory than this machine has");
    expect(modal).toContain('name="custom" autocomplete="off" maxlength="120" value=""');
  });

  it("preselects a model picked here, or an Ollama name of its own in the custom field", async () => {
    const picked = await setup(withLocal({ source: "dashboard", model: SEVEN }));
    const settings = await picked.admin.get("/admin/settings");
    expect(row(settings)).toContain('<span class="crtag">set here</span>');
    expect(modalOf(settings)).toMatch(new RegExp(`value="${SEVEN.replaceAll(".", "\\.")}" checked`));
    const custom = await setup(withLocal({ source: "dashboard", model: "mistral:7b" }));
    const modal = modalOf(await custom.admin.get("/admin/settings"));
    expect(modal).toMatch(/value="custom" checked/);
    expect(modal).toContain('value="mistral:7b" placeholder');
  });

  it("only lets downloaded models be picked while Ollama isn't answering", () => {
    const modal = localModal(withLocal({ online: false }), "c");
    expect(modal).toContain("<b>Ollama isn&rsquo;t answering</b>");
    expect(modal).toMatch(new RegExp(`value="${SEVEN.replaceAll(".", "\\.")}" disabled`));
    expect(modal).toMatch(/value="qwen3:8b">/);
    expect(modal).toMatch(/value="custom" disabled/);
  });

  it("notes a JOB_SCANNER_MODEL in .env, which beats the pick for reports", async () => {
    const { admin } = await setup(withLocal({ override: "JOB_SCANNER_MODEL" }));
    expect(row(await admin.get("/admin/settings"))).toContain("<code>JOB_SCANNER_MODEL</code> in .env picks the reports&rsquo; model");
  });

  it("has no Change link or window for a HermitShell that doesn't offer models", async () => {
    const { admin } = await setup(withLocal({ choices: undefined, source: undefined }));
    const settings = await admin.get("/admin/settings");
    expect(settings).not.toContain('href="#mlocal"');
    expect(settings).not.toContain('id="mlocal"');
  });

  it("drops anything in the offered list that isn't a model, and escapes what it shows", () => {
    const choices = localChoices({ choices: [...CHOICES, { model: "x\" onmouseover=\"y" }, { model: "a b" }, "junk", null,
      { model: "ok:1b", about: "<script>x</script>", mb: -5, gpu: 500, speed: "warp", installed: "yes" }] });
    expect(choices.map((c) => c.model)).toEqual([...CHOICES.map((c) => c.model), "ok:1b"]);
    expect(choices.at(-1)).toEqual({ model: "ok:1b", about: "<script>x</script>", mb: 0, gpu: 0, fits: true, speed: "", installed: false, recommended: false });
    const modal = localModal(withLocal({ choices: [{ model: "ok:1b", about: "<script>x</script>" }] }), "c");
    expect(modal).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(modal).not.toContain("<script>");
  });

  it("queues the pick, the default or another Ollama name, and refuses anything else", async () => {
    const { env, act } = await setup();
    const at = async (fields) => (await act(fields)).headers.get("Location");
    expect(await at({ action: "model_local", model: SEVEN })).toBe("/admin/settings?done=queued#models");
    expect(await at({ action: "model_local", model: "" })).toBe("/admin/settings?done=queued#models");
    expect(await at({ action: "model_local", model: "custom", custom: " hf.co/Owner/Repo-GGUF:Q4_K_M " })).toBe("/admin/settings?done=queued#models");
    for (const bad of [{ model: "a b" }, { model: "custom", custom: "" }, { model: "custom", custom: "x;rm -rf /" }, { model: "../../etc" },
      { model: "a/b/c/d" }, { model: "x".repeat(121) }, { model: "custom", custom: "http://evil.example/x" }]) {
      expect(await at({ action: "model_local", ...bad })).toBe("/admin/settings?done=badlocal#models");
    }
    expect(valuesWith(env, "queue:").map(({ type, action, model }) => ({ type, action, model }))).toEqual([
      { type: "admin", action: "local_model", model: SEVEN },
      { type: "admin", action: "local_model", model: "" },
      { type: "admin", action: "local_model", model: "hf.co/Owner/Repo-GGUF:Q4_K_M" },
    ]);
  });

  it("shows the change as saving until HermitShell applies it", async () => {
    const { admin, act } = await setup();
    await act({ action: "model_local", model: SEVEN });
    const settings = await admin.get("/admin/settings?done=queued");
    expect(settings).toContain("Waiting for HermitShell to apply the server model");
    expect(row(settings)).toContain('<span class="savingtag">saving&hellip;</span>');
  });

  it("is for admins only", async () => {
    const { env, admin, act } = await setup();
    await worker.fetch(post("/admin/users", { csrf: admin.csrf, op: "add", name: "Morgan Ellis", username: "morgan", password: "manager-password-1", roles: "manager" },
      { Cookie: admin.cookie }), env);
    const morgan = await login(env, "morgan", "manager-password-1");
    const res = await act({ action: "model_local", model: SEVEN }, morgan);
    expect(res.status).toBe(403);
    expect(valuesWith(env, "queue:")).toEqual([]);
  });
});

describe("a server model downloading", () => {
  it("shows its progress in the model row, the server panel and the admin's dashboard", async () => {
    const { admin } = await setup(withLocal({ pull: PULL }, { tasks: [PULL_TASK] }));
    const settings = await admin.get("/admin/settings");
    expect(row(settings)).toContain(`Downloading <code class="mname">${SEVEN}</code>: 44% &middot; 2.0 GB of 4.6 GB`);
    expect(row(settings)).toContain('role="progressbar" aria-label="Download" aria-valuenow="44"');
    const dash = await admin.get("/admin");
    const notice = dash.slice(dash.indexOf('<div class="mnotice'), dash.indexOf("</div></div>", dash.indexOf('<div class="mnotice')));
    expect(notice).toContain('<div class="mnotice" role="status">');
    expect(notice).toContain("44% &middot; 2.0 GB of 4.6 GB");
    expect(notice).toContain('<a href="#tasks">Follow it in Tasks</a>');
    expect(dash).toContain('<span class="tcount">1</span>');
    expect(serverBox(withLocal({ pull: PULL }))).toContain(`<small>Downloading <code class="mname">${SEVEN}</code>: 44%`);
  });

  it("tells the admin when it is ready, or why it failed, for a day", async () => {
    const ready = await setup(withLocal({ pull: { ...PULL, status: "ready", done_mb: 4700, finished: NOW - 60000 } }));
    const dash = await ready.admin.get("/admin");
    expect(dash).toContain('<div class="mnotice ok" role="status">');
    expect(dash).toContain(`<code class="mname">${SEVEN}</code> is downloaded and is now the server model.`);
    expect(dash).not.toContain('aria-label="Download"');
    const failed = await setup(withLocal({ pull: { ...PULL, status: "failed", error: "not enough disk space: 4700 MB needed, 900 MB free", finished: NOW } }));
    const bad = await failed.admin.get("/admin");
    expect(bad).toContain('<div class="mnotice bad" role="status">');
    expect(bad).toContain("Could not download");
    expect(bad).toContain("not enough disk space: 4700 MB needed, 900 MB free");
    expect(bad).toContain('<a href="/admin/settings#models">Model settings</a>');
  });

  it("says nothing on the dashboard after a stopped download, and nothing to recruiters", async () => {
    const stopped = await setup(withLocal({ pull: { ...PULL, status: "cancelled", finished: NOW } }));
    expect(await stopped.admin.get("/admin")).not.toContain('class="mnotice');
    expect(pullText(localPull(withLocal({ pull: { ...PULL, status: "cancelled" } })))).toContain("was stopped");
    const { env, admin } = await setup(withLocal({ pull: PULL }));
    await worker.fetch(post("/admin/users", { csrf: admin.csrf, op: "add", name: "Casey Quinn", username: "casey", password: "recruiter-password-1", roles: "recruiter" },
      { Cookie: admin.cookie }), env);
    const casey = await login(env, "casey", "recruiter-password-1");
    expect(await casey.get("/admin")).not.toContain("mnotice");
  });

  it("ignores a download it can't trust and escapes its error", () => {
    expect(localPull(withLocal({ pull: { ...PULL, model: "a b" } }))).toBeNull();
    expect(localPull(withLocal({ pull: { ...PULL, status: "exploded" } }))).toBeNull();
    expect(localPull(withLocal({ pull: "downloading" }))).toBeNull();
    expect(localPull({})).toBeNull();
    expect(pullNotice(withLocal({ pull: { ...PULL, status: "failed", error: "<img src=x onerror=alert(1)>" } }))).toContain("&lt;img src=x");
    expect(pullText(localPull(withLocal({ pull: { ...PULL, total_mb: 0, done_mb: 0 } })))).toContain(": starting");
    expect(pullText(localPull(withLocal({ pull: { ...PULL, stopping: true } })))).toContain("Stopping the download of");
    expect(pullText(localPull(withLocal({ pull: { ...PULL, status: "ready", switch: false } })))).not.toContain("now the server model");
  });

  it("lists the download in Tasks with its size, and Stop asks HermitShell to stop it", async () => {
    const status = withLocal({ pull: PULL }, { tasks: [PULL_TASK] });
    const [t] = taskRows(status, [], []);
    expect(t).toMatchObject({ id: "model:pull", kind: "model", who: "Server", u: "owner", state: "running", title: SEVEN });
    const { env, admin } = await setup(status);
    const list = await admin.get("/admin/tasks");
    expect(list).toContain("<b>Server model download</b>");
    expect(list).toContain('<span class="twho">Server</span>');
    expect(list).toContain(`<div class="ttitle">${SEVEN}</div>`);
    expect(list).toContain("Downloading &middot; 2.0 of 4.6 GB &middot; started");
    expect(list).toContain('aria-valuenow="44"');
    const res = await worker.fetch(post("/admin/tasks", { csrf: admin.csrf, task: "model:pull" }, { Cookie: admin.cookie }), env);
    expect(res.headers.get("Location")).toBe("/admin/tasks?done=stopping");
    expect(valuesWith(env, "queue:").map(({ type, action, u, task }) => ({ type, action, u, task }))).toEqual([
      { type: "admin", action: "cancel", u: "", task: "model:pull" }]);
    expect(await admin.get("/admin/tasks")).toContain("Stopping&hellip;");
    expect(taskRows({ ...status, tasks: [{ ...PULL_TASK, id: "model:other" }] }, [], [])).toEqual([]);
  });
});

describe("Ollama names", () => {
  it("match what model_pull.py accepts", () => {
    for (const good of [SEVEN, "llama3", "qwen3:8b", "hf.co/Owner/Repo-GGUF:Q4_K_M", "library/mistral:7b"]) expect(OLLAMA_RE.test(good)).toBe(true);
    for (const bad of ["", "-x", "a b", "x;rm", "a/b/c/d", "x:", ":tag", "a".repeat(121), "../etc", "x\n", "http://x/y"]) expect(OLLAMA_RE.test(bad)).toBe(false);
  });
});

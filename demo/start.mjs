// The demo image's entry point (docs/demo-image.md). Starts, inside one container and on fictional data only:
//   Mailpit (the inbox, STARTTLS), the replay servers (fictional adverts in Firecrawl and Tavily shapes and recorded
//   AI answers), the feedback Worker under wrangler dev (https) and the HermitShell backend's scheduler,
// all over https with a private CA made on first start. Every secret is random per container and kept in /data.
//
// Modes (the first argument, or HERMITSHELL_DEMO_MODE):
//   app      seed the demo people and jobs, then leave the app running to use by hand (the default)
//   demo     a clean showcase: the viewer on :8080 plays the walkthrough feature by feature
//   test     the viewer with a test panel: pick journeys, run them, read the report
//   autorun  run every journey, write the report and video to /out, exit 0 if all passed
//
// Live mode (HERMITSHELL_DEMO_LIVE=1, with FIRECRAWL_API_KEY and OLLAMA_HOST given at run time) uses real search and
// a real model instead of the replay servers.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { join } from "node:path";

import { start as startViewer } from "./viewer/server.mjs";

const MODES = ["app", "demo", "test", "autorun"];
const mode = process.argv[2] || process.env.HERMITSHELL_DEMO_MODE || "app";
const live = process.env.HERMITSHELL_DEMO_LIVE === "1";
const DATA = process.env.DEMO_DATA || "/data";
const OUT = process.env.DEMO_OUT || "/out";
const EXPLORE = "/opt/explore";
const HOME = join(DATA, "explore");
const CERTS = join(HOME, "certs");
const HERMIT = join(DATA, "hermit");
const JOURNEYS = ["setup", "team", "signup", "recruiter", "recruit", "pipeline", "documents", "settings", "retire", "multiuser"];
const SEED = ["setup", "team", "signup", "extras", "recruiter"];
// These create the demo people, so on seeded data they can only run again in a fresh container.
const ONCE = ["setup", "team", "signup", "extras"];
const children = [];
// wrangler's offline complaints about the Request.cf placeholder (it falls back on its own).
const NOISE = /Request\.cf|EAI_AGAIN|GetAddrInfoReqWrap|CERTIFICATE_UNKNOWN/;

function say(text) {
  console.log(`[demo] ${text}`);
}

function fail(text) {
  console.error(`[demo] ${text}`);
  process.exit(2);
}

// One long-running service; its output is prefixed, and if it dies the container stops.
function service(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  const prefix = (chunk) => chunk.toString().split("\n").filter((l) => l && !NOISE.test(l)).forEach((l) => console.log(`[${name}] ${l}`));
  child.stdout.on("data", prefix);
  child.stderr.on("data", prefix);
  child.on("exit", (code) => {
    if (!stopping) fail(`${name} stopped (exit ${code})`);
  });
  children.push(child);
  return child;
}

let stopping = false;
function stop(code = 0) {
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));

async function waitFor(what, check, timeout = 300000) {
  const startAt = Date.now();
  while (Date.now() - startAt < timeout) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`timed out waiting for ${what}`);
}

function secrets() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const file = join(HOME, ".env.explore");
  const env = existsSync(file) ? Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])) : {};
  const want = { EXPLORE_LINK_SECRET: [32, "hex"], EXPLORE_API_TOKEN: [32, "hex"], EXPLORE_ADMIN_PASSWORD: [18, "base64url"] };
  for (const [name, [bytes, enc]] of Object.entries(want)) env[name] ||= randomBytes(bytes).toString(enc);
  if (process.env.DEMO_ADMIN_PASSWORD) env.EXPLORE_ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD;
  writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  return env;
}

// True when the Worker answers over https, trusting only the container's own CA.
function workerUp() {
  return new Promise((resolve) => {
    const req = get("https://127.0.0.1:8787/privacy", { ca: readFileSync(join(CERTS, "ca.pem")), servername: "localhost", timeout: 5000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function certs() {
  const res = spawnSync("sh", ["/opt/demo/certs.sh", CERTS], { stdio: "inherit" });
  if (res.status !== 0) fail("could not make the test certificates");
}

function worker(env) {
  const dir = join(DATA, "worker");
  rmSync(join(dir, "src"), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of ["src", "package.json", "wrangler.jsonc"]) cpSync(join("/opt/worker", f), join(dir, f), { recursive: true });
  if (!existsSync(join(dir, "node_modules"))) symlinkSync("/opt/worker/node_modules", join(dir, "node_modules"));
  writeFileSync(join(dir, ".dev.vars"), `JOB_FEEDBACK_SECRET=${env.EXPLORE_LINK_SECRET}\nJOB_FEEDBACK_API_TOKEN=${env.EXPLORE_API_TOKEN}\n`
    + `ADMIN_PASSWORD=${env.EXPLORE_ADMIN_PASSWORD}\n`, { mode: 0o600 });
  service("worker", "node", [join(dir, "node_modules", "wrangler", "bin", "wrangler.js"), "dev", "--ip", "0.0.0.0", "--port", "8787",
    "--local-protocol", "https", "--https-key-path", join(CERTS, "server-key.pem"), "--https-cert-path", join(CERTS, "server.pem"),
    "--persist-to", join(DATA, "worker-state"), "--show-interactive-dev-session=false"],
  { cwd: dir, env: { ...process.env, HOME: join(DATA, "worker-home"), WRANGLER_SEND_METRICS: "false", CI: "1" } });
}

function mailpit() {
  service("mailpit", "/usr/local/bin/mailpit", ["--listen", "0.0.0.0:8025", "--smtp", "127.0.0.1:1025", "--quiet"], {
    env: { ...process.env, MP_SMTP_TLS_CERT: join(CERTS, "server.pem"), MP_SMTP_TLS_KEY: join(CERTS, "server-key.pem"),
      MP_SMTP_REQUIRE_STARTTLS: "true", MP_SMTP_AUTH_ACCEPT_ANY: "true", MP_MAX_MESSAGES: "5000" } });
}

function replay() {
  service("replay", "node", [join(EXPLORE, "replay", "server.mjs")], {
    env: { ...process.env, REPLAY_TLS_CERT: join(CERTS, "server.pem"), REPLAY_TLS_KEY: join(CERTS, "server-key.pem") } });
}

function backendEnv(env) {
  const base = {
    ...process.env, HERMITSHELL_HOME: HERMIT, TZ: "UTC", HERMES_TIMEZONE: "UTC", HERMES_AUTOFIT: "0", LLM_ORDER: "local",
    REQUESTS_CA_BUNDLE: join(CERTS, "bundle.pem"), SSL_CERT_FILE: join(CERTS, "bundle.pem"),
    JOB_FEEDBACK_URL: "https://localhost:8787", JOB_FEEDBACK_SECRET: env.EXPLORE_LINK_SECRET, JOB_FEEDBACK_API_TOKEN: env.EXPLORE_API_TOKEN,
    SMTP_HOST: "localhost", SMTP_PORT: "1025", SMTP_USER: "demo", SMTP_PASSWORD: "demo-inbox",
    SMTP_FROM: "hermitshell@example.com", ALERT_EMAIL: "alex.morgan@example.com",
    OLLAMA_MODEL: process.env.OLLAMA_MODEL || "qwen3:4b-instruct-2507-q4_K_M", JOB_SCANNER_MAX_SCRAPE: "5", JOB_TRIAGE_MAX: "5",
  };
  if (live) return { ...base, OLLAMA_HOST: process.env.OLLAMA_HOST, FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY };
  return { ...base, EXPLORE_OFFLINE: "1", FIRECRAWL_API_KEY: "replay", FIRECRAWL_API_BASE: "https://localhost:8443",
    TAVILY_API_BASE: "https://localhost:8443/tavily", OLLAMA_HOST: "http://127.0.0.1:11434" };
}

async function backend(env) {
  const benv = backendEnv(env);
  delete benv.HERMITSHELL_DEMO_LIVE;
  const packages = readdirSync("/app/packages");
  const install = spawnSync("sh", ["/app/scripts/install.sh", ...packages], { env: { ...benv, HERMITSHELL_SETUP: "1" }, stdio: "ignore" });
  if (install.status !== 0) fail("installing the HermitShell scripts failed");
  const scripts = join(HERMIT, "scripts");
  await waitFor("the TLS probes", async () => spawnSync("python3", [join(EXPLORE, "stack", "probe.py")], { cwd: scripts, env: benv, stdio: "ignore" }).status === 0);
  const py = (...args) => spawnSync("python3", ["scheduler.py", ...args], { cwd: scripts, env: benv, stdio: "ignore" });
  py("defaults", "--if-new");
  for (const job of ["vacancy-profiles", "vacancy-cover-letters"]) py("edit", job, "--schedule", "* * * * *");
  for (const job of ["daily-vacancy-report", "weekly-vacancy-report", "vacancy-maintenance"]) py("pause", job);
  service("backend", "python3", ["scheduler.py", "run"], { cwd: scripts, env: benv });
}

// Runs the walkthrough (explore/run.mjs) headless, streaming windows to the viewer; resolves to { code, out }.
function walkthrough(only, { slow = 0, video = true, viewer = null } = {}) {
  return new Promise((resolve) => {
    const args = [join(EXPLORE, "run.mjs"), "run", "--headless", ...(video ? ["--slow", String(slow)] : ["--fast"])];
    if (only.length) args.push("--only", only.join(","));
    const child = spawn("node", args, { cwd: EXPLORE, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, EXPLORE_HOME: HOME, EXPLORE_OUT_ROOT: OUT, EXPLORE_TARGET: "https://127.0.0.1:8787",
      EXPLORE_INBOX: "http://127.0.0.1:8025", EXPLORE_BACKEND_WORKER: "https://localhost:8787",
      EXPLORE_SCREENCAST: viewer ? "http://127.0.0.1:8081" : "", FORCE_COLOR: "0" } });
    let out = "";
    const onLine = (chunk) => chunk.toString().split("\n").forEach((line) => {
      const m = line.match(/Findings and recordings: (.*)$/);
      if (m) out = m[1].trim();
      if (viewer) viewer.log(line); else if (line.trim()) console.log(`[walkthrough] ${line}`);
    });
    child.stdout.on("data", onLine);
    child.stderr.on("data", onLine);
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
}

function reportLinks(out) {
  if (!out.startsWith(OUT)) return {};
  const rel = out.slice(OUT.length).replace(/^[/\\]/, "");
  return { Report: `/out/${rel}/report/index.html`, Findings: `/out/${rel}/findings.md` };
}

async function seed(viewer) {
  const flag = join(HOME, "seeded");
  if (existsSync(flag)) return true;
  say("seeding the demo people and jobs (first start only)...");
  viewer?.status("running", "Seeding the demo people and jobs...");
  const { code } = await walkthrough(SEED, { video: false, viewer });
  if (code === 0) writeFileSync(flag, new Date().toISOString());
  else say("seeding finished with failures; the app is still usable");
  return code === 0;
}

async function main() {
  if (!MODES.includes(mode)) fail(`unknown mode ${mode} (choose from ${MODES.join(", ")})`);
  if (live && !(process.env.FIRECRAWL_API_KEY && process.env.OLLAMA_HOST)) fail("live mode needs FIRECRAWL_API_KEY and OLLAMA_HOST");
  mkdirSync(OUT, { recursive: true });
  const env = secrets();
  certs();
  mailpit();
  if (!live) replay();
  worker(env);
  await waitFor("the Worker", workerUp);
  await backend(env);
  say(`ready${live ? " (live search and model)" : " (fictional adverts and recorded AI answers)"}`);
  say(`app: https://localhost:8787/admin  user admin, password in ${join(HOME, ".env.explore")} `
    + "(docker exec <container> cat /data/explore/.env.explore), or set DEMO_ADMIN_PASSWORD");
  say("inbox: http://localhost:8025");

  const links = { App: "https://{host}:8787/admin", Inbox: "http://{host}:8025" };
  if (mode === "app") {
    await seed(null);
    say("demo data ready");
    return;
  }

  let running = false;
  const viewer = startViewer({ mode, out: OUT, journeys: [...JOURNEYS, "extras"], links, onRun: async (only) => {
    if (running) return false;
    running = true;
    viewer.clearWindows();
    const picked = only.length ? only : JOURNEYS.filter((j) => !ONCE.includes(j));
    viewer.status("running", `Running ${picked.join(", ")}...`);
    walkthrough(picked, { slow: 200, viewer }).then(({ code, out }) => {
      running = false;
      viewer.status(code === 0 ? "passed" : "failed", code === 0 ? "All passed" : "Some steps failed", { links: reportLinks(out) });
    });
    return true;
  } });
  say("viewer: http://localhost:8080");

  if (mode === "demo") {
    viewer.status("running", "Playing the walkthrough...");
    const { code } = await walkthrough([...JOURNEYS.slice(0, 3), "extras", ...JOURNEYS.slice(3)].filter((j) => j !== "retire"),
      { slow: Number(process.env.DEMO_SLOW || 500), viewer });
    viewer.status(code === 0 ? "passed" : "failed", "The tour has finished: the app is yours to explore");
  } else if (mode === "test") {
    running = true;
    await seed(viewer);
    running = false;
    viewer.status("idle", "Ready: pick journeys and press Run (none picked runs all but setup, team, signup and extras, "
      + "which made the demo people)");
  } else {
    viewer.status("running", "Running every journey...");
    const { code, out } = await walkthrough([], { slow: 0, viewer });
    const summary = { passed: code === 0, finished: new Date().toISOString(), report: out };
    writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
    viewer.status(code === 0 ? "passed" : "failed", code === 0 ? "All passed" : "Some steps failed", { links: reportLinks(out) });
    say(`autorun ${code === 0 ? "passed" : "failed"}; report in ${out}`);
    if (process.env.DEMO_KEEP !== "1") stop(code === 0 ? 0 : 1);
  }
}

main().catch((err) => fail(err.stack || String(err)));

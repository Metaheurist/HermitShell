// Driving the Docker Compose stack: start, stop, wipe, health, checkpoints. The secrets folder is passed to compose
// as EXPLORE_HOME and the settings file as its --env-file; nothing secret is ever printed.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { fetchTarget } from "./api.js";
import { CHECKPOINTS_DIR, ENV_FILE, HOME, SESSIONS_DIR, STACK_DIR, STATE_FILE, loadEnv, readState } from "./config.js";

const VOLUMES = ["data", "worker-state"];
const ALPINE = "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";

// "replay" or "record" (fictional adverts and recorded AI answers instead of Firecrawl and Ollama), else "".
export function replayMode() {
  return process.env.EXPLORE_REPLAY ?? readState().replay ?? "";
}

function files(env) {
  const list = ["-f", join(STACK_DIR, "docker-compose.explore.yml")];
  if (env.EXPLORE_GPU !== "0") list.push("-f", join(STACK_DIR, "docker-compose.gpu.yml"));
  if (replayMode()) list.push("-f", join(STACK_DIR, "docker-compose.replay.yml"));
  return list;
}

export function compose(args, { quiet = false, check = true } = {}) {
  const env = loadEnv();
  const res = spawnSync("docker", ["compose", ...files(env), "--env-file", ENV_FILE, ...args], {
    cwd: STACK_DIR, env: { ...process.env, EXPLORE_HOME: HOME, EXPLORE_REPLAY_RECORD: replayMode() === "record" ? "1" : "" },
    encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });
  if (check && res.status !== 0) throw new Error(`docker compose ${args.join(" ")} failed${quiet ? `:\n${res.stderr}` : ""}`);
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(what, check, { timeout = 300000, every = 3000, log = true } = {}) {
  const start = Date.now();
  let last = "";
  for (;;) {
    try {
      const ok = await check();
      if (ok) return ok;
    } catch (err) {
      last = err.message;
    }
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}${last ? ` (${last})` : ""}`);
    if (log) process.stdout.write(".");
    await sleep(every);
  }
}

export async function workerUp() {
  return (await fetchTarget("/privacy")).status === 200;
}

function logs(service, tail = 200) {
  return compose(["logs", "--no-color", "--tail", String(tail), service], { quiet: true, check: false }).stdout || "";
}

function exec(service, cmd) {
  return compose(["exec", "-T", service, ...cmd], { quiet: true, check: false });
}

// The backend has proved its TLS paths and its scheduler is running.
export function backendUp() {
  const lines = probeLines();
  if (!lines.length || lines.some((l) => !l.trimEnd().endsWith(": ok"))) return false;
  return exec("backend", ["python3", "/data/scripts/scheduler.py", "health"]).status === 0;
}

export function probeLines() {
  const lines = logs("backend", 400).split("\n").map((l) => l.replace(/^.*?\| /, ""));
  const at = lines.findLastIndex((l) => /^probes: \d+/.test(l));
  if (at < 0) return [];
  const n = Number(lines[at].match(/\d+/)[0]);
  const block = lines.slice(at + 1).filter((l) => l.startsWith("probe:")).slice(0, n);
  return block.length === n ? block : [];
}

export function gpuSeen() {
  const res = exec("ollama", ["nvidia-smi", "-L"]);
  return res.status === 0 ? res.stdout.trim().split("\n").map((l) => l.replace(/\(UUID.*\)/, "").trim()) : [];
}

export async function ensureModel(model) {
  const list = exec("ollama", ["ollama", "list"]).stdout || "";
  if (!list.includes(model)) {
    console.log(`Downloading ${model} (first run only)...`);
    compose(["exec", "-T", "ollama", "ollama", "pull", model], { quiet: true });
  }
  exec("ollama", ["ollama", "run", model, "--keepalive", "30m", "Reply with the word ready."]);
}

export async function up({ build = true } = {}) {
  const env = loadEnv();
  mkdirSync(join(HOME, "certs"), { recursive: true });
  compose(["up", "-d", ...(build ? ["--build"] : [])]);
  process.stdout.write("Worker");
  await until("the Worker", workerUp, { timeout: 600000 });
  console.log(" up");
  if (env.EXPLORE_GPU !== "0") {
    const gpus = gpuSeen();
    console.log(gpus.length ? `GPU: ${gpus.join("; ")}` : "GPU: not visible to Ollama; it will run on the CPU (set EXPLORE_GPU=0 to silence)");
  }
  await ensureModel(env.EXPLORE_MODEL || "qwen3:4b-instruct-2507-q4_K_M");
  console.log("Model warm");
  process.stdout.write("Backend");
  await until("the backend", () => backendUp(), { timeout: 600000, every: 5000 });
  console.log(" up");
  for (const line of probeLines()) console.log(`  ${line}`);
  const mode = replayMode();
  console.log(mode ? `Replay: ${mode} (fictional adverts${mode === "record" ? ", recording new AI answers" : ", recorded AI answers"})`
    : `Firecrawl key: ${env.FIRECRAWL_API_KEY ? "present" : "missing (scans will fail)"}`);
}

export function down() {
  compose(["stop"]);
}

// Wipes what the walkthrough made (backend data, Worker state, inbox, sessions); keeps the model and node_modules.
export function reset() {
  compose(["down", "--remove-orphans"]);
  for (const v of VOLUMES) spawnSync("docker", ["volume", "rm", "-f", volumeName(v)], { stdio: "ignore" });
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  rmSync(STATE_FILE, { force: true });
}

export async function status() {
  compose(["ps"]);
  console.log(`Worker: ${(await workerUp().catch(() => false)) ? "up" : "down"}`);
  console.log(`Backend: ${backendUp() ? "up" : "down"}`);
  for (const line of probeLines()) console.log(`  ${line}`);
}

function volumeName(v) {
  return `hermitshell-explore_${v}`;
}

function tar(args) {
  const res = spawnSync("docker", ["run", "--rm", ...args], { stdio: "inherit" });
  if (res.status !== 0) throw new Error("checkpoint copy failed");
}

// Snapshots the backend data and the Worker's state (and the runner's sessions and state) under a name.
async function ready() {
  await until("the Worker", workerUp, { timeout: 300000, log: false });
  await until("the backend", () => backendUp(), { timeout: 300000, every: 5000, log: false });
}

export async function checkpoint(name) {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error("checkpoint names are lower-case letters, digits and dashes");
  const dir = join(CHECKPOINTS_DIR, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  compose(["stop", "backend", "worker"], { quiet: true });
  for (const v of VOLUMES) tar(["-v", `${volumeName(v)}:/v:ro`, "-v", `${dir}:/b`, ALPINE, "tar", "-C", "/v", "-czf", `/b/${v}.tgz`, "."]);
  if (existsSync(STATE_FILE)) cpSync(STATE_FILE, join(dir, "state.json"));
  if (existsSync(SESSIONS_DIR)) cpSync(SESSIONS_DIR, join(dir, "sessions"), { recursive: true });
  compose(["start", "worker", "backend"], { quiet: true });
  await ready();
  console.log(`Checkpoint ${name} saved`);
}

export async function restore(name) {
  const dir = join(CHECKPOINTS_DIR, name);
  if (!existsSync(dir)) throw new Error(`no checkpoint called ${name}`);
  compose(["stop", "backend", "worker"], { quiet: true });
  for (const v of VOLUMES) {
    tar(["-v", `${volumeName(v)}:/v`, "-v", `${dir}:/b:ro`, ALPINE, "sh", "-c", `rm -rf /v/* /v/.[!.]* 2>/dev/null; tar -C /v -xzf /b/${v}.tgz`]);
  }
  rmSync(STATE_FILE, { force: true });
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  if (existsSync(join(dir, "state.json"))) cpSync(join(dir, "state.json"), STATE_FILE);
  if (existsSync(join(dir, "sessions"))) cpSync(join(dir, "sessions"), SESSIONS_DIR, { recursive: true });
  compose(["start", "worker", "backend"], { quiet: true });
  await ready();
  console.log(`Checkpoint ${name} restored`);
}

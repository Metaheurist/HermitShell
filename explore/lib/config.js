// Where the explore stack keeps its secrets and output, and the checks on its settings file. Everything secret lives
// outside the repo and outside OneDrive, in %LOCALAPPDATA%\HermitShell\explore (or EXPLORE_HOME).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPLORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = resolve(EXPLORE_DIR, "..");
export const STACK_DIR = join(EXPLORE_DIR, "stack");

export const HOME = process.env.EXPLORE_HOME
  || join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "HermitShell", "explore");
export const ENV_FILE = join(HOME, ".env.explore");
export const CA_FILE = join(HOME, "certs", "ca.pem");
export const STATE_FILE = join(HOME, "state.json");
export const SESSIONS_DIR = join(HOME, "sessions");
export const CHECKPOINTS_DIR = join(HOME, "checkpoints");
export const OUT_ROOT = process.env.EXPLORE_OUT_ROOT || join(HOME, "out");

export const TARGET = process.env.EXPLORE_TARGET || "https://127.0.0.1:8787";
export const INBOX = process.env.EXPLORE_INBOX || "http://127.0.0.1:8025";
// Links in emails carry the backend's address for the Worker; the browser reaches the same Worker here.
export const BACKEND_WORKER = process.env.EXPLORE_BACKEND_WORKER || "https://worker:8787";

const ALLOWED = new Set(["FIRECRAWL_API_KEY", "EXPLORE_LINK_SECRET", "EXPLORE_API_TOKEN", "EXPLORE_ADMIN_PASSWORD",
  "EXPLORE_MODEL", "EXPLORE_GPU", "EXPLORE_GPUS", "JOB_SCANNER_MAX_SCRAPE", "JOB_TRIAGE_MAX"]);
const GENERATED = { EXPLORE_LINK_SECRET: 32, EXPLORE_API_TOKEN: 32, EXPLORE_ADMIN_PASSWORD: 18 };
// Names that would point the stack at production or hand it production credentials.
const FORBIDDEN = /^(CLOUDFLARE_|HERMES_DATA_KEY|JOB_FEEDBACK_|SMTP_|ALERT_EMAIL|OPENROUTER_|BAZAARLINK_|FEATHERLESS_|HUGGINGFACE_|TAVILY_|SCRAPFLY_|FIRECRAWL_BACKUP)/;

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 1) throw new Error(`.env.explore: a line without NAME=value (line starting ${JSON.stringify(line.slice(0, 12))})`);
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

// The settings, checked against the allow-list; refuses anything that could reach production.
export function checkEnv(env) {
  const problems = [];
  for (const name of Object.keys(env)) {
    if (FORBIDDEN.test(name)) problems.push(`${name} is not allowed in the explore stack (it could reach production)`);
    else if (!ALLOWED.has(name)) problems.push(`${name} is not a known explore setting`);
  }
  for (const name of Object.keys(process.env)) {
    if (/^(JOB_FEEDBACK_URL|CLOUDFLARE_API_TOKEN|HERMES_DATA_KEY)$/.test(name)) problems.push(`${name} is set in this shell; unset it first`);
  }
  if (env.FIRECRAWL_API_KEY && !/^[A-Za-z0-9_-]{16,200}$/.test(env.FIRECRAWL_API_KEY)) problems.push("FIRECRAWL_API_KEY doesn't look like a key");
  return problems;
}

// Reads .env.explore, creating it (or filling empty secrets) with random values; never prints a value.
export function loadEnv() {
  mkdirSync(HOME, { recursive: true });
  const env = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")) : {};
  let changed = !existsSync(ENV_FILE);
  for (const [name, bytes] of Object.entries(GENERATED)) {
    if (!env[name]) { env[name] = randomBytes(bytes).toString(name.endsWith("PASSWORD") ? "base64url" : "hex"); changed = true; }
  }
  if (changed) writeFileSync(ENV_FILE, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  const problems = checkEnv(env);
  if (problems.length) throw new Error(`.env.explore has problems:\n  ${problems.join("\n  ")}`);
  return env;
}

// Small run state shared between journeys: the staff passwords the team journey chose, invite links and so on.
export function readState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
}

export function writeState(patch) {
  const next = { ...readState(), ...patch };
  mkdirSync(HOME, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

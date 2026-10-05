#!/usr/bin/env node
// The exploratory walkthrough's command line (docs/exploratory-testing.md). Not part of CI.
//
//   node explore/run.mjs up [--replay | --record] | down | reset | status | logs [service]
//   node explore/run.mjs checkpoint <name> | restore <name>
//   node explore/run.mjs run [--only setup,team,...] [--from <checkpoint>] [--slow 300 | --fast] [--list]
//   node explore/run.mjs run --target https://localhost:8787 [--inbox http://localhost:8025]   (a demo container)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { EXPLORE_DIR, HOME, OUT_ROOT, loadEnv, writeState } from "./lib/config.js";
import { checkpoint, compose, down, reset, restore, status, up } from "./lib/stack.js";

export const JOURNEYS = ["setup", "team", "signup", "recruiter", "recruit", "pipeline", "documents", "settings", "retire", "multiuser"];
// Run only when named with --only (the demo image's seed).
export const EXTRA_JOURNEYS = ["extras"];

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

// Another HermitShell to walk through, such as the demo image: its address, its inbox and its admin password (in
// its own settings folder, so the local stack's secrets are never sent to it).
function targetSettings(target, inbox) {
  if (!target && !inbox) return {};
  const out = {};
  if (inbox) out.EXPLORE_INBOX = new URL(inbox).origin;
  if (target) {
    const url = new URL(target);
    if (url.protocol !== "https:") throw new Error("--target must be an https address");
    const home = process.env.EXPLORE_TARGET_HOME || join(HOME, "target");
    if (!existsSync(join(home, ".env.explore"))) {
      throw new Error(`--target needs the target's admin password in ${join(home, ".env.explore")}; for the demo image:\n`
        + `  docker cp <container>:/data/explore/.env.explore "${home}"`);
    }
    Object.assign(out, { EXPLORE_HOME: home, EXPLORE_TARGET: url.origin, EXPLORE_BACKEND_WORKER: process.env.EXPLORE_BACKEND_WORKER || "https://localhost:8787" });
    out.EXPLORE_INBOX ||= `http://${url.hostname}:8025`;
  }
  return out;
}

async function run(args) {
  const only = (option(args, "--only") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const known = [...JOURNEYS, ...EXTRA_JOURNEYS];
  const unknown = only.filter((j) => !known.includes(j));
  if (unknown.length) throw new Error(`unknown journeys: ${unknown.join(", ")} (choose from ${known.join(", ")})`);
  const from = option(args, "--from");
  const targetEnv = targetSettings(option(args, "--target"), option(args, "--inbox"));
  if (from && targetEnv.EXPLORE_TARGET) throw new Error("--from restores the local stack; it can't be used with --target");
  if (from && !args.includes("--list")) await restore(from);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = join(OUT_ROOT, stamp);
  mkdirSync(out, { recursive: true });
  const fast = args.includes("--fast");
  const pw = [join(EXPLORE_DIR, "node_modules", "@playwright", "test", "cli.js"), "test", "-c", "playwright.explore.config.js"];
  if (only.length) pw.push("--grep", only.map((j) => `@${j}\\b`).join("|"));
  else pw.push("--grep-invert", EXTRA_JOURNEYS.map((j) => `@${j}\\b`).join("|"));
  if (args.includes("--list")) pw.push("--list");
  if (args.includes("--headless")) process.env.EXPLORE_HEADLESS = "1";
  const { NO_COLOR, ...env } = process.env;
  const res = spawnSync(process.execPath, pw, { cwd: EXPLORE_DIR, stdio: "inherit",
    env: { ...env, ...targetEnv, EXPLORE_OUT: out, EXPLORE_SLOW: fast ? "0" : option(args, "--slow") || "300",
      EXPLORE_FAST: fast ? "1" : "", EXPLORE_ONLY: only.join(",") } });
  if (!args.includes("--list")) console.log(`\nFindings and recordings: ${out}`);
  return res.status ?? 1;
}

async function main() {
  const [cmd = "help", ...args] = process.argv.slice(2);
  switch (cmd) {
    case "up":
      loadEnv();
      writeState({ replay: args.includes("--record") ? "record" : args.includes("--replay") ? "replay" : "" });
      await up({ build: !args.includes("--no-build") });
      return 0;
    case "down": down(); return 0;
    case "reset": reset(); return 0;
    case "status": await status(); return 0;
    case "logs": compose(["logs", "--tail", "200", ...(args[0] ? [args[0]] : [])]); return 0;
    case "checkpoint": await checkpoint(args[0] || ""); return 0;
    case "restore": await restore(args[0] || ""); return 0;
    case "run": return await run(args);
    default:
      console.log("Usage: node explore/run.mjs up [--replay|--record] [--no-build]|down|reset|status|logs [service]|checkpoint <name>|restore <name>|"
        + `run [--only ${[...JOURNEYS, ...EXTRA_JOURNEYS].join(",")}] [--from <checkpoint>] [--slow ms|--fast] [--headless] [--list] `
        + "[--target https://host:8787] [--inbox http://host:8025]");
      return cmd === "help" ? 0 : 1;
  }
}

main().then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(1); });

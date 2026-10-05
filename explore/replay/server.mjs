#!/usr/bin/env node
// replay-search and replay-ollama in one process, for the demo image and `explore run --replay|--record`.
//
//   search (https, REPLAY_SEARCH_PORT, default 8443): Firecrawl /v1/search, /v1/scrape and the credit checks, and
//     Tavily under /tavily (search, extract, usage), all answered from the fictional adverts in adverts.js.
//   ollama (http, REPLAY_OLLAMA_PORT, default 11434): /api/tags, show, ps, version, pull and chat. Chat answers come
//     from recordings.json by a normalised prompt key; a request with no recording gets a schema-shaped fallback
//     and counts as a miss. With REPLAY_RECORD=1 and REPLAY_UPSTREAM (a real Ollama), misses are asked upstream and
//     recorded; REPLAY_RECORD=all asks upstream every time.
//   GET /replay/stats on the ollama port: hits, misses (by task) and recordings; POST /replay/reset clears counts.
//
// The search side needs REPLAY_TLS_CERT and REPLAY_TLS_KEY (the backend only talks https to search providers).

import { readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ADVERTS, byUrl, markdown, matching, snippet } from "./adverts.js";
import { fallback } from "./fallback.js";
import { requestKey, taskOf } from "./normalise.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.env.REPLAY_FILE || join(HERE, "recordings.json");
const MODEL = process.env.REPLAY_MODEL || "qwen3:4b-instruct-2507-q4_K_M";
const RECORD = process.env.REPLAY_RECORD || "";
const UPSTREAM = (process.env.REPLAY_UPSTREAM || "").replace(/\/$/, "");
const MAX_BODY = 4 * 1024 * 1024;

export const stats = { hits: 0, misses: 0, recorded: 0, missed: {} };
let recordings = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};

export function load(data) {
  recordings = data;
}

function save() {
  const sorted = Object.fromEntries(Object.entries(recordings).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(`${FILE}.tmp`, `${JSON.stringify(sorted, null, 1)}\n`);
  renameSync(`${FILE}.tmp`, FILE);
}

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try { resolve(text ? JSON.parse(text) : {}); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function send(res, status, data, type = "application/json") {
  const out = type === "application/json" ? JSON.stringify(data) : data;
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(out), "Cache-Control": "no-store" });
  res.end(out);
}

// ------------------------------------------------------------------ search

export function firecrawlSearch(payload) {
  return { success: true, data: matching(payload.query, Math.min(payload.limit || 8, 20))
    .map((ad) => ({ url: ad.url, title: `${ad.title} - ${ad.company}`, description: snippet(ad) })) };
}

export function firecrawlScrape(payload) {
  const ad = byUrl(payload.url);
  return ad ? { success: true, data: { markdown: markdown(ad), metadata: { sourceURL: ad.url, statusCode: 200 } } }
    : { success: false, error: "not found" };
}

export async function search(req, res) {
  const url = new URL(req.url, "https://replay");
  const p = url.pathname;
  if (req.method === "GET" && /^\/v[12]\/team\/credit-usage$/.test(p)) {
    return send(res, 200, p.startsWith("/v1")
      ? { success: true, data: { remaining_credits: 1000 } }
      : { success: true, data: { remainingCredits: 1000, planCredits: 1000 } });
  }
  if (req.method === "GET" && p === "/tavily/usage") return send(res, 200, { key: { usage: 0, limit: 1000 }, account: { current_plan: "Demo" } });
  if (req.method !== "POST") return send(res, 404, { error: "not found" });
  const payload = await body(req);
  if (p === "/v1/search") return send(res, 200, firecrawlSearch(payload));
  if (p === "/v1/scrape") {
    const out = firecrawlScrape(payload);
    return send(res, out.success ? 200 : 404, out);
  }
  if (p === "/tavily/search") {
    return send(res, 200, { results: matching(payload.query, payload.max_results || 8)
      .map((ad) => ({ url: ad.url, title: `${ad.title} - ${ad.company}`, content: snippet(ad) })) });
  }
  if (p === "/tavily/extract") {
    return send(res, 200, { results: (payload.urls || []).map(byUrl).filter(Boolean)
      .map((ad) => ({ url: ad.url, raw_content: markdown(ad) })) });
  }
  return send(res, 404, { error: "not found" });
}

// ------------------------------------------------------------------ ollama

async function upstream(path, init) {
  const res = await fetch(`${UPSTREAM}${path}`, init);
  return [res.status, await res.json()];
}

export async function chat(payload) {
  const key = requestKey(payload);
  const task = taskOf(payload);
  const known = recordings[key];
  if (known && RECORD !== "all") {
    stats.hits += 1;
    return known.content;
  }
  if (RECORD && UPSTREAM) {
    const [status, reply] = await upstream("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, stream: false }) });
    if (status !== 200) throw new Error(`upstream answered ${status}`);
    recordings[key] = { task, content: reply.message?.content ?? "" };
    stats.recorded += 1;
    save();
    return recordings[key].content;
  }
  stats.misses += 1;
  stats.missed[task] = (stats.missed[task] || 0) + 1;
  return fallback(payload);
}

function chatReply(content) {
  return { model: MODEL, created_at: new Date().toISOString(), message: { role: "assistant", content },
    done: true, done_reason: "stop", prompt_eval_count: 0, eval_count: Math.ceil(content.length / 4) };
}

export async function ollama(req, res) {
  const p = new URL(req.url, "http://replay").pathname;
  if (p === "/replay/stats") return send(res, 200, { ...stats, recordings: Object.keys(recordings).length });
  if (p === "/replay/reset" && req.method === "POST") {
    Object.assign(stats, { hits: 0, misses: 0, recorded: 0, missed: {} });
    return send(res, 200, stats);
  }
  if (RECORD && UPSTREAM && p !== "/api/chat" && p !== "/api/pull") {
    const init = req.method === "POST" ? { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await body(req)) } : {};
    const [status, data] = await upstream(p, init);
    return send(res, status, data);
  }
  if (p === "/api/version") return send(res, 200, { version: "0.0.0-replay" });
  if (p === "/api/tags") {
    return send(res, 200, { models: [{ name: MODEL, model: MODEL, size: 2500000000, digest: "replay",
      details: { family: "replay", parameter_size: "4B", quantization_level: "Q4_K_M" } }] });
  }
  if (p === "/api/show") return send(res, 200, { details: { parameter_size: "4B" }, model_info: { "general.parameter_count": 4e9 } });
  if (p === "/api/ps") return send(res, 200, { models: [] });
  if (p === "/api/pull") return send(res, 200, `${JSON.stringify({ status: "success" })}\n`, "application/x-ndjson");
  if (p === "/api/chat" && req.method === "POST") {
    const payload = await body(req);
    return send(res, 200, chatReply(await chat(payload)));
  }
  return send(res, 404, { error: "not found" });
}

function guard(handler) {
  return (req, res) => handler(req, res).catch((err) => {
    if (!res.headersSent) send(res, 502, { error: String(err.message || err).slice(0, 200) });
  });
}

export function start() {
  const searchPort = Number(process.env.REPLAY_SEARCH_PORT || 8443);
  const ollamaPort = Number(process.env.REPLAY_OLLAMA_PORT || 11434);
  const cert = process.env.REPLAY_TLS_CERT;
  const key = process.env.REPLAY_TLS_KEY;
  if (!cert || !key) throw new Error("REPLAY_TLS_CERT and REPLAY_TLS_KEY are needed: the backend only uses https for search");
  createHttps({ cert: readFileSync(cert), key: readFileSync(key) }, guard(search)).listen(searchPort, "0.0.0.0");
  createHttp(guard(ollama)).listen(ollamaPort, "0.0.0.0");
  console.log(`replay: search https :${searchPort} (${ADVERTS.length} adverts), ollama http :${ollamaPort} `
    + `(${Object.keys(recordings).length} recordings${RECORD ? `, recording from ${UPSTREAM || "nowhere"}` : ""})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start();

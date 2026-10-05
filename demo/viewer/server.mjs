// The demo image's viewer (docs/demo-image.md): one page on :8080 showing every browser window the walkthrough opens,
// streamed with the Chrome DevTools screencast. In test and autorun modes a side panel adds the run log, the
// journeys, a Run button (test mode) and links to the report and video in /out.
//
// The walkthrough posts frames to a second, internal port bound to 127.0.0.1 only. The public page is read-only
// except POST /run, which is test mode only, needs a JSON body and a same-origin request, and runs one walkthrough
// at a time.

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".webm": "video/webm", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".zip": "application/zip", ".svg": "image/svg+xml" };
const SECURITY = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" };

// Resolves a request path inside `root`, or null if it would escape it.
export function inside(root, path) {
  let rel;
  try { rel = decodeURIComponent(path); } catch { return null; }
  if (rel.includes("\0")) return null;
  const base = resolve(root);
  const full = resolve(base, normalize(rel).replace(/^([/\\])+/, ""));
  return full === base || full.startsWith(base + sep) ? full : null;
}

// Same-origin check for the one state-changing request: the browser always sends Origin on a cross-site POST.
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function body(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function start({ mode, port = 8080, internalPort = 8081, out = "/out", journeys = [], onRun = null, links = {} }) {
  const clients = new Set();
  const windows = new Map();
  const log = [];
  let status = { state: "starting", text: "Starting HermitShell..." };

  function send(event, data) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(line);
  }

  const api = {
    status(state, text, extra = {}) { status = { state, text, ...extra }; send("status", status); },
    log(line) {
      const clean = String(line).replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
      if (!clean) return;
      log.push(clean);
      if (log.length > 2000) log.shift();
      send("log", clean);
    },
    clearWindows() { windows.clear(); send("reset", {}); },
  };

  // Internal: frames, windows and captions from the walkthrough.
  const internal = createServer(async (req, res) => {
    try {
      const data = await body(req, 4 * 1024 * 1024);
      const key = String(data.key || data.role || "").slice(0, 120);
      if (req.url === "/frame" && typeof data.data === "string") send("frame", { key, role: data.role, data: data.data });
      else if (req.url === "/window") {
        if (data.open) windows.set(key, data.role); else windows.delete(key);
        send("window", { key, role: data.role, open: !!data.open });
      } else if (req.url === "/caption") send("caption", { role: String(data.role).slice(0, 40), text: String(data.text).slice(0, 300) });
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
  }).listen(internalPort, "127.0.0.1");

  const config = { mode, journeys, links, panel: mode === "test" || mode === "autorun", canRun: mode === "test" && !!onRun };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://viewer");
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { ...SECURITY, "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`event: hello\ndata: ${JSON.stringify({ config, status, log: log.slice(-300), windows: [...windows] })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === "POST" && url.pathname === "/run") {
      if (!config.canRun) return res.writeHead(404, SECURITY).end();
      if (!sameOrigin(req) || !String(req.headers["content-type"] || "").startsWith("application/json")) return res.writeHead(403, SECURITY).end();
      try {
        const { only = [] } = await body(req, 4096);
        const picked = Array.isArray(only) ? only.filter((j) => journeys.includes(j)) : [];
        const started = await onRun(picked);
        res.writeHead(started ? 202 : 409, { ...SECURITY, "content-type": "application/json" }).end(JSON.stringify({ started }));
      } catch {
        res.writeHead(400, SECURITY).end();
      }
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405, SECURITY).end();
    if (url.pathname.startsWith("/out/")) {
      const file = inside(out, url.pathname.slice(5));
      if (!file || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404, SECURITY).end();
      res.writeHead(200, { ...SECURITY, "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      return createReadStream(file).pipe(res);
    }
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = inside(join(HERE, "public"), name);
    if (!file || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404, SECURITY).end();
    res.writeHead(200, { ...SECURITY, "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  }).listen(port, "0.0.0.0");

  api.close = () => {
    for (const res of clients) res.end();
    internal.close();
    server.close();
  };
  return api;
}

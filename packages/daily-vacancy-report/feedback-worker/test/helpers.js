import { createRequire } from "node:module";
import { PROTOCOL } from "../src/apiauth.js";
import { Hub } from "../src/hub.js";
import { STYLE_URL, stylesheet } from "../src/lib.js";
import { SEAL_ALG, SEAL_PREFIX, fieldAad } from "../src/seal.js";

// What a current HermitShell adds to its status: its protocol and the public key the Worker seals secrets with.
export async function sealingKeys() {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const seal = { alg: SEAL_ALG, kid: "", spki: btoa(String.fromCharCode(...spki)) };
  // worker_seal.open_bytes, in JavaScript.
  async function openBytes(blob, aad) {
    const bytes = new Uint8Array(blob);
    if (String.fromCharCode(...bytes.subarray(0, 3)) !== "HS1") throw new Error("not sealed");
    const size = (bytes[11] << 8) | bytes[12];
    const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, pair.privateKey, bytes.subarray(13, 13 + size));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(13 + size, 25 + size),
      additionalData: new TextEncoder().encode(aad) }, key, bytes.subarray(25 + size)));
  }
  async function open(value, field) {
    if (!String(value).startsWith(SEAL_PREFIX)) throw new Error(`not sealed: ${value}`);
    const b64 = value.slice(SEAL_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    return new TextDecoder().decode(await openBytes(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), fieldAad(field)));
  }
  return { seal, status: { protocol: PROTOCOL, seal }, open, openBytes };
}

export const BASE = "https://vacancy-feedback.example.workers.dev";

// A WebSocket as the hub sees it; readyState 1 is open.
export class FakeSocket {
  constructor() { this.readyState = 1; this.sent = []; this.attachment = null; this.pinged = 0; }
  send(message) {
    if (this.readyState !== 1) throw new Error("closed");
    this.sent.push(message);
  }
  serializeAttachment(value) { this.attachment = value; }
  deserializeAttachment() { return this.attachment; }
  close() { this.readyState = 3; }
}

// Just enough of a Durable Object's SQLite storage for the hub's nonce table.
function memorySql() {
  const rows = new Map();
  return {
    rows,
    exec(query, ...args) {
      if (query.startsWith("CREATE TABLE")) return;
      if (query.startsWith("DELETE FROM nonces")) { for (const [n, at] of rows) if (at < args[0]) rows.delete(n); return; }
      if (query.startsWith("INSERT INTO nonces")) {
        if (rows.has(args[0])) throw new Error("UNIQUE constraint failed: nonces.n");
        rows.set(args[0], args[1]);
        return;
      }
      throw new Error(`unexpected SQL: ${query}`);
    },
  };
}

// A Durable Object's SQLite storage on a real in-memory SQLite database (node:sqlite), for the hub's rate
// limits, one-time tokens and backups: exec returns a cursor with toArray(), and BLOBs go in and come back as
// ArrayBuffers, as the runtime's do.
export function realSql() {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const blob = (v) => (v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v);
  return {
    db,
    exec(query, ...args) {
      const rows = db.prepare(query).all(...args.map((a) => (a instanceof ArrayBuffer ? new Uint8Array(a) : a)))
        .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, blob(v)])));
      return { toArray: () => rows };
    },
  };
}

// The HUB binding: the real Hub class on an in-memory Durable Object state, with SQLite storage when asked
// (sql: true for the nonce table's stand-in, "sqlite" for a real database).
export function memoryHub({ sql = false } = {}) {
  const storage = new Map();
  const sockets = [];
  const state = {
    storage: { async get(key) { return storage.get(key); }, async put(key, value) { storage.set(key, value); },
      ...(sql === "sqlite" ? { sql: realSql() } : sql ? { sql: memorySql() } : {}) },
    sockets,
    acceptWebSocket(ws) { sockets.push(ws); },
    getWebSockets() { return sockets.filter((ws) => ws.readyState !== 3); },
    setWebSocketAutoResponse() {},
    getWebSocketAutoResponseTimestamp(ws) { return ws.pinged ? new Date(ws.pinged) : null; },
  };
  const hub = new Hub(state);
  return { state, hub, storage, idFromName: (name) => name, get: () => ({ fetch: (url, init) => hub.fetch(new Request(url, init)) }) };
}

export function memoryKV() {
  const store = new Map();
  const metadata = new Map();
  return {
    store,
    metadata,
    async put(key, value, options) {
      store.set(key, value);
      if (options?.metadata) metadata.set(key, structuredClone(options.metadata));
      else metadata.delete(key);
    },
    async get(key, type) {
      const value = store.get(key);
      if (value == null) return null;
      if (type === "json") return JSON.parse(value);
      if (type === "arrayBuffer") return value;
      return value;
    },
    async list({ prefix, limit = 1000 }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit)
        .map((name) => (metadata.has(name) ? { name, metadata: structuredClone(metadata.get(name)) } : { name })) };
    },
    async delete(key) { store.delete(key); metadata.delete(key); },
  };
}

// A page with the shared stylesheet it links to put back inline, for checking its styles.
const STYLESHEET = await stylesheet().text();
export function styled(html) {
  return html.replace(`<link rel="stylesheet" href="${STYLE_URL}">`, () => `<style>${STYLESHEET}</style>`);
}

export function testEnv(extra = {}) {
  return { FEEDBACK: memoryKV(), JOB_FEEDBACK_SECRET: "test-secret", JOB_FEEDBACK_API_TOKEN: "api-token", ...extra };
}

export function keysWith(env, prefix) {
  return [...env.FEEDBACK.store.keys()].filter((k) => k.startsWith(prefix));
}

export function valuesWith(env, prefix) {
  return keysWith(env, prefix).map((k) => JSON.parse(env.FEEDBACK.store.get(k)));
}

export { WORD_PARTS, bundle, zipOf } from "./zip.js";

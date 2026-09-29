import { Hub } from "../src/hub.js";

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

// The HUB binding: the real Hub class on an in-memory Durable Object state.
export function memoryHub() {
  const storage = new Map();
  const sockets = [];
  const state = {
    storage: { async get(key) { return storage.get(key); }, async put(key, value) { storage.set(key, value); } },
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
  return {
    store,
    async put(key, value) { store.set(key, value); },
    async get(key, type) {
      const value = store.get(key);
      if (value == null) return null;
      if (type === "json") return JSON.parse(value);
      if (type === "arrayBuffer") return value;
      return value;
    },
    async list({ prefix, limit = 1000 }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })) };
    },
    async delete(key) { store.delete(key); },
  };
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

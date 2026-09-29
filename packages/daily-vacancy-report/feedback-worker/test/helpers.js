export const BASE = "https://vacancy-feedback.example.workers.dev";

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

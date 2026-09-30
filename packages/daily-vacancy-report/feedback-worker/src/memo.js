// One request's view of KV: a key read twice in the same request (the recruits' status by the page and by the
// signed-in box, the task list by each step of a cancel) costs one read. Only text and JSON reads are kept, as text,
// so every caller parses its own copy and can change it freely. A write or delete in the request replaces what is
// kept for that key; lists, metadata and binary reads go straight to KV.
export function memoKV(kv) {
  const kept = new Map();
  return {
    raw: kv,
    get(key, options) {
      const type = typeof options === "string" ? options : options?.type || "text";
      if (type !== "text" && type !== "json") return kv.get(key, options);
      if (!kept.has(key)) {
        const read = kv.get(key, typeof options === "object" && options?.cacheTtl ? { type: "text", cacheTtl: options.cacheTtl } : "text");
        kept.set(key, read);
        read.catch(() => kept.get(key) === read && kept.delete(key));
      }
      return kept.get(key).then((text) => (type === "json" && text !== null ? JSON.parse(text) : text));
    },
    async put(key, value, options) {
      kept.delete(key);
      await kv.put(key, value, options);
      if (typeof value === "string") kept.set(key, Promise.resolve(value));
    },
    async delete(key) {
      kept.delete(key);
      await kv.delete(key);
      kept.set(key, Promise.resolve(null));
    },
    list: (options) => kv.list(options),
    getWithMetadata: (key, options) => kv.getWithMetadata(key, options),
  };
}

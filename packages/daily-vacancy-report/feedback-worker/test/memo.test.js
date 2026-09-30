import { describe, expect, it } from "vitest";
import { memoKV } from "../src/memo.js";
import { BASE, memoryKV, testEnv } from "./helpers.js";
import worker from "../src/index.js";

function counted() {
  const kv = memoryKV();
  const reads = [];
  const get = kv.get;
  kv.get = (key, type) => { reads.push(key); return get(key, type); };
  return { kv, reads };
}

describe("per-request KV memo", () => {
  it("reads each key from KV once however often it is asked for", async () => {
    const { kv, reads } = counted();
    await kv.put("user:a", JSON.stringify({ name: "Alex Morgan" }));
    const memo = memoKV(kv);
    const [one, two] = await Promise.all([memo.get("user:a", "json"), memo.get("user:a", "json")]);
    expect(await memo.get("user:a")).toBe(JSON.stringify({ name: "Alex Morgan" }));
    expect(await memo.get("missing")).toBeNull();
    expect(await memo.get("missing", { type: "json" })).toBeNull();
    expect(one).toEqual({ name: "Alex Morgan" });
    expect(two).toEqual(one);
    expect(reads).toEqual(["user:a", "missing"]);
  });

  it("hands every caller its own copy so changing one cannot leak into later reads", async () => {
    const { kv } = counted();
    await kv.put("user:a", JSON.stringify({ skills: ["SQL"] }));
    const memo = memoKV(kv);
    const first = await memo.get("user:a", "json");
    first.skills.push("Terraform");
    expect(await memo.get("user:a", "json")).toEqual({ skills: ["SQL"] });
  });

  it("sees its own writes and deletes without asking KV again", async () => {
    const { kv, reads } = counted();
    await kv.put("k", "old");
    const memo = memoKV(kv);
    expect(await memo.get("k")).toBe("old");
    await memo.put("k", JSON.stringify({ v: 2 }));
    expect(await memo.get("k", "json")).toEqual({ v: 2 });
    expect(kv.store.get("k")).toBe(JSON.stringify({ v: 2 }));
    await memo.delete("k");
    expect(await memo.get("k")).toBeNull();
    expect(kv.store.has("k")).toBe(false);
    expect(reads).toEqual(["k"]);
  });

  it("does not keep a failed read, so the next ask tries KV again", async () => {
    const kv = memoryKV();
    let fail = true;
    const get = kv.get;
    kv.get = (key, type) => (fail ? Promise.reject(new Error("KV unavailable")) : get(key, type));
    await kv.put("k", "v");
    const memo = memoKV(kv);
    await expect(memo.get("k")).rejects.toThrow("KV unavailable");
    await new Promise((r) => setTimeout(r, 0));
    fail = false;
    expect(await memo.get("k")).toBe("v");
  });

  it("passes other read types and listing straight through", async () => {
    const { kv, reads } = counted();
    await kv.put("blob", "bytes");
    await kv.put("p:1", "x");
    const memo = memoKV(kv);
    await memo.get("blob", "arrayBuffer");
    await memo.get("blob", "arrayBuffer");
    expect(reads).toEqual(["blob", "blob"]);
    expect((await memo.list({ prefix: "p:" })).keys.map((k) => k.name)).toEqual(["p:1"]);
    expect(memo.raw).toBe(kv);
  });

  it("is a fresh memo per request, so one request never sees another's reads", async () => {
    const env = testEnv();
    const { reads } = (() => {
      const r = [];
      const get = env.FEEDBACK.get;
      env.FEEDBACK.get = (key, type) => { r.push(key); return get(key, type); };
      return { reads: r };
    })();
    await worker.fetch(new Request(`${BASE}/api/queue`, { headers: { Authorization: "Bearer api-token" } }), env, {});
    const afterFirst = reads.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(new Set(reads).size).toBe(afterFirst);
    await worker.fetch(new Request(`${BASE}/api/queue`, { headers: { Authorization: "Bearer api-token" } }), env, {});
    expect(reads.length - afterFirst).toBe(afterFirst);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { hubLimit, hubLimitClear, hubTokenPut, hubTokenSpend } from "../src/hub.js";
import { BASE, keysWith, memoryHub, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const H = "a".repeat(64);
const H2 = "b".repeat(64);

function login(env, password, ip = "203.0.113.9") {
  return worker.fetch(new Request(`${BASE}/admin/login`, { method: "POST", body: new URLSearchParams({ username: "admin", password }),
    headers: { "CF-Connecting-IP": ip } }), env);
}

afterEach(() => vi.useRealTimers());

describe("hub rate limits", () => {
  it("counts attempts per key and refuses past the limit", async () => {
    const env = { HUB: memoryHub({ sql: "sqlite" }) };
    expect(await hubLimit(env, "test:one", 2, 60000)).toEqual({ ok: true, n: 0 });
    expect(await hubLimit(env, "test:one", 2, 60000, true)).toEqual({ ok: true, n: 1 });
    expect(await hubLimit(env, "test:one", 2, 60000, true)).toEqual({ ok: true, n: 2 });
    expect(await hubLimit(env, "test:one", 2, 60000)).toEqual({ ok: false, n: 2 });
    expect(await hubLimit(env, "test:one", 2, 60000, true)).toEqual({ ok: false, n: 3 });
    expect((await hubLimit(env, "test:two", 2, 60000)).ok).toBe(true);
  });

  it("forgets attempts once their window has passed, and on clear", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T10:00:00Z"));
    const env = { HUB: memoryHub({ sql: "sqlite" }) };
    await hubLimit(env, "test:w", 1, 60000, true);
    expect((await hubLimit(env, "test:w", 1, 60000)).ok).toBe(false);
    vi.setSystemTime(new Date("2026-01-05T10:01:01Z"));
    expect(await hubLimit(env, "test:w", 1, 60000)).toEqual({ ok: true, n: 0 });
    await hubLimit(env, "test:w", 1, 60000, true);
    expect(await hubLimitClear(env, "test:w")).toEqual({ ok: true, n: 0 });
    expect((await hubLimit(env, "test:w", 1, 60000)).ok).toBe(true);
  });

  it("answers null for bad input or a hub without SQLite, so callers fall back", async () => {
    const env = { HUB: memoryHub({ sql: "sqlite" }) };
    expect(await hubLimit(env, "Bad Key", 1, 60000)).toBeNull();
    expect(await hubLimit(env, "test:x", 0, 60000)).toBeNull();
    expect(await hubLimit(env, "test:x", 1, 2 * 24 * 3600 * 1000)).toBeNull();
    expect(await hubLimit({ HUB: memoryHub() }, "test:x", 1, 60000)).toBeNull();
    expect(await hubLimit({}, "test:x", 1, 60000)).toBeNull();
  });
});

describe("hub one-time tokens", () => {
  it("spends a token exactly once", async () => {
    const env = { HUB: memoryHub({ sql: "sqlite" }) };
    expect(await hubTokenPut(env, H, "alex-morgan", 15 * 60000)).toBe(true);
    expect(await hubTokenPut(env, H, "sam-lee", 15 * 60000)).toBe(false);
    const both = await Promise.all([hubTokenSpend(env, H), hubTokenSpend(env, H)]);
    expect(both.sort()).toEqual(["", "alex-morgan"]);
    expect(await hubTokenSpend(env, H)).toBe("");
  });

  it("does not spend an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T10:00:00Z"));
    const env = { HUB: memoryHub({ sql: "sqlite" }) };
    await hubTokenPut(env, H2, "riley-chen", 15 * 60000);
    vi.setSystemTime(new Date("2026-01-05T10:15:01Z"));
    expect(await hubTokenSpend(env, H2)).toBe("");
  });

  it("refuses malformed tokens, profiles and lifetimes, and answers null without a hub", async () => {
    const env = { HUB: memoryHub({ sql: "sqlite" }) };
    expect(await hubTokenPut(env, "short", "alex-morgan", 60000)).toBeNull();
    expect(await hubTokenPut(env, H, "Alex Morgan", 60000)).toBeNull();
    expect(await hubTokenPut(env, H, "alex-morgan", 2 * 3600 * 1000)).toBeNull();
    expect(await hubTokenSpend(env, "z".repeat(64))).toBeNull();
    expect(await hubTokenSpend({}, H)).toBeNull();
    expect(await hubTokenSpend({ HUB: memoryHub() }, H)).toBeNull();
  });
});

describe("admin sign-in lock in the hub", () => {
  it("counts wrong passwords in the hub without writing to KV, then locks", async () => {
    const env = testEnv({ ...ADMIN, HUB: memoryHub({ sql: "sqlite" }) });
    for (let i = 0; i < 5; i++) expect((await login(env, "wrong")).status).toBe(401);
    expect((await login(env, ADMIN.ADMIN_PASSWORD)).status).toBe(429);
    expect((await login(env, ADMIN.ADMIN_PASSWORD, "198.51.100.7")).status).toBe(303);
    expect(keysWith(env, "lock:")).toEqual([]);
  });

  it("clears an address's failures after a right password", async () => {
    const env = testEnv({ ...ADMIN, HUB: memoryHub({ sql: "sqlite" }) });
    for (let i = 0; i < 4; i++) await login(env, "wrong");
    expect((await login(env, ADMIN.ADMIN_PASSWORD)).status).toBe(303);
    for (let i = 0; i < 4; i++) expect((await login(env, "wrong")).status).toBe(401);
    expect((await login(env, ADMIN.ADMIN_PASSWORD)).status).toBe(303);
  });

  it("locks sign-in everywhere after 30 failures from many addresses", async () => {
    const env = testEnv({ ...ADMIN, HUB: memoryHub({ sql: "sqlite" }) });
    for (let i = 0; i < 30; i++) await login(env, "wrong", `198.51.100.${i + 1}`);
    expect((await login(env, ADMIN.ADMIN_PASSWORD, "192.0.2.50")).status).toBe(429);
  });

  it("falls back to the KV locks without a hub that can count", async () => {
    const env = testEnv({ ...ADMIN, HUB: memoryHub() });
    for (let i = 0; i < 5; i++) await login(env, "wrong");
    expect(keysWith(env, "lock:").sort()).toEqual(["lock:203.0.113.9", "lock:all"]);
    expect((await login(env, ADMIN.ADMIN_PASSWORD)).status).toBe(429);
  });
});

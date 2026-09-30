import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { WEEKS_KEY, purgeProfileEvents, recentStats } from "../src/lib.js";
import { BASE, testEnv } from "./helpers.js";

const API = { Authorization: "Bearer api-token", "Content-Type": "application/json" };
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function post(env, u, stats) {
  return worker.fetch(new Request(`${BASE}/api/stats`, { method: "POST", headers: API, body: JSON.stringify({ u, stats }) }), env);
}

function counting(env) {
  const log = { reads: [], writes: [] };
  const { get, put } = env.FEEDBACK;
  env.FEEDBACK.get = (key, type) => { log.reads.push(key); return get(key, type); };
  env.FEEDBACK.put = (key, value, options) => { log.writes.push(key); return put(key, value, options); };
  return log;
}

describe("recent stats for the dashboard's sparklines", () => {
  it("keep the last few days of every recruit in one key when HermitShell sends stats", async () => {
    const env = testEnv();
    const now = Date.now();
    const stats = { days: { [iso(now)]: [3, 1], [iso(now - 2 * DAY)]: [5], [iso(now - 30 * DAY)]: [9] }, skills: ["SQL"] };
    await post(env, "sam-lee", stats);
    await post(env, "alex-morgan", { days: { [iso(now)]: [1] } });
    const kept = JSON.parse(env.FEEDBACK.store.get(WEEKS_KEY));
    expect(kept["sam-lee"]).toEqual({ days: { [iso(now)]: [3, 1], [iso(now - 2 * DAY)]: [5] } });
    expect(Object.keys(kept).sort()).toEqual(["alex-morgan", "sam-lee"]);
  });

  it("are not rewritten when a recruit's recent days have not changed", async () => {
    const env = testEnv();
    const days = { [iso(Date.now())]: [2] };
    await post(env, "sam-lee", { days });
    const log = counting(env);
    await post(env, "sam-lee", { days, skills: ["Terraform"] });
    expect(log.writes).not.toContain(WEEKS_KEY);
  });

  it("are read once for every recruit, and fall back to a recruit's own stats when missing", async () => {
    const env = testEnv();
    await post(env, "sam-lee", { days: { [iso(Date.now())]: [4] } });
    await env.FEEDBACK.put("stats:alex-morgan", JSON.stringify({ days: { [iso(Date.now())]: [6] } }));
    const log = counting(env);
    const [sam, alex, none, bad] = await recentStats(env, ["sam-lee", "alex-morgan", "jordan-patel", "Not An Id"]);
    expect(sam.days[iso(Date.now())]).toEqual([4]);
    expect(alex.days[iso(Date.now())]).toEqual([6]);
    expect(none).toBeNull();
    expect(bad).toBeNull();
    expect(log.reads.sort()).toEqual([WEEKS_KEY, "stats:alex-morgan", "stats:jordan-patel"].sort());
  });

  it("forget a recruit whose stats are removed or who is deleted", async () => {
    const env = testEnv();
    await post(env, "sam-lee", { days: { [iso(Date.now())]: [1] } });
    await post(env, "alex-morgan", { days: { [iso(Date.now())]: [1] } });
    await post(env, "sam-lee", null);
    expect(Object.keys(JSON.parse(env.FEEDBACK.store.get(WEEKS_KEY)))).toEqual(["alex-morgan"]);
    await purgeProfileEvents(env, "alex-morgan");
    expect(JSON.parse(env.FEEDBACK.store.get(WEEKS_KEY))).toEqual({});
  });
});

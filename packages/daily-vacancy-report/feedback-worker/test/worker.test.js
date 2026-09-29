import { describe, expect, it } from "vitest";
import worker, { sign } from "../src/index.js";

// Same value as KNOWN_SIGNATURE in packages/daily-vacancy-report/tests/test_vacancy_report.py.
const KNOWN_SIGNATURE = "7a1921b9bd33f759be1489d932b2a57f";
const BASE = "https://vacancy-feedback.example.workers.dev";

function memoryKV() {
  const store = new Map();
  return {
    store,
    async put(key, value) { store.set(key, value); },
    async get(key, type) {
      const value = store.get(key);
      if (value == null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
    async delete(key) { store.delete(key); },
  };
}

function testEnv() {
  return { FEEDBACK: memoryKV(), JOB_FEEDBACK_SECRET: "test-secret", JOB_FEEDBACK_API_TOKEN: "api-token" };
}

async function link(action = "applied", key = "nijobs:123", title = "AI Engineer") {
  const t = await sign("test-secret", key, action, title);
  return { j: key, a: action, n: title, t };
}

function formRequest(fields) {
  return new Request(`${BASE}/f`, { method: "POST", body: new URLSearchParams(fields) });
}

describe("feedback worker", () => {
  it("signs links exactly like the Python scanner", async () => {
    expect(await sign("test-secret", "nijobs:123", "applied", "AI Engineer")).toBe(KNOWN_SIGNATURE);
  });

  it("shows a confirmation page for a valid link without saving anything", async () => {
    const env = testEnv();
    const res = await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(await link())}`), env);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("AI Engineer");
    expect(body).toContain('method="post"');
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(env.FEEDBACK.store.size).toBe(0);
  });

  it("rejects tampered links and unknown actions", async () => {
    const env = testEnv();
    const tampered = { ...(await link()), n: "Head of AI" };
    expect((await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(tampered)}`), env)).status).toBe(403);
    const unknown = { ...(await link()), a: "delete" };
    expect((await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(unknown)}`), env)).status).toBe(403);
    expect((await worker.fetch(formRequest({ ...tampered, r: "" }), env)).status).toBe(403);
    expect(env.FEEDBACK.store.size).toBe(0);
  });

  it("saves one event when the answer is confirmed", async () => {
    const env = testEnv();
    const res = await worker.fetch(formRequest({ ...(await link("not_for_me")), r: "too senior" }), env);
    expect(res.status).toBe(200);
    const [event] = [...env.FEEDBACK.store.values()].map((v) => JSON.parse(v));
    expect(event).toMatchObject({ j: "nijobs:123", a: "not_for_me", r: "too senior" });
    expect(event.id).toMatch(/^event:\d+:/);
  });

  it("queues a cover letter request with its guidance and says when it arrives", async () => {
    const env = testEnv();
    const confirm = await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(await link("cover_letter"))}`), env);
    const form = await confirm.text();
    expect(form).toContain("Guidance for the letter");
    expect(form).toContain("Confirm: Generate cover letter");
    const res = await worker.fetch(formRequest({ ...(await link("cover_letter")), r: "mention Azure" }), env);
    expect(await res.text()).toContain("within about 10 minutes");
    const [event] = [...env.FEEDBACK.store.values()].map((v) => JSON.parse(v));
    expect(event).toMatchObject({ j: "nijobs:123", a: "cover_letter", r: "mention Azure" });
  });

  it("accepts thumbs up as a good match", async () => {
    const env = testEnv();
    const res = await worker.fetch(formRequest({ ...(await link("good_match")), r: "" }), env);
    expect(await res.text()).toContain("Good match: AI Engineer");
    expect(env.FEEDBACK.store.size).toBe(1);
  });

  it("requires the API token for /events and /ack", async () => {
    const env = testEnv();
    expect((await worker.fetch(new Request(`${BASE}/events`), env)).status).toBe(401);
    const wrong = { headers: { Authorization: "Bearer nope" } };
    expect((await worker.fetch(new Request(`${BASE}/events`, wrong), env)).status).toBe(401);
    const ack = new Request(`${BASE}/ack`, { method: "POST", body: JSON.stringify({ ids: [] }) });
    expect((await worker.fetch(ack, env)).status).toBe(401);
  });

  it("lists waiting events and deletes acknowledged ones", async () => {
    const env = testEnv();
    await worker.fetch(formRequest({ ...(await link("applied")), r: "" }), env);
    await worker.fetch(formRequest({ ...(await link("interested", "indeed:abc", "ML Engineer")), r: "" }), env);
    const auth = { Authorization: "Bearer api-token" };
    const { events } = await (await worker.fetch(new Request(`${BASE}/events`, { headers: auth }), env)).json();
    expect(events.map((e) => e.a).sort()).toEqual(["applied", "interested"]);
    const ack = new Request(`${BASE}/ack`, {
      method: "POST", headers: auth, body: JSON.stringify({ ids: [events[0].id, "not-an-event"] }),
    });
    expect(await (await worker.fetch(ack, env)).json()).toEqual({ deleted: 1 });
    expect(env.FEEDBACK.store.size).toBe(1);
  });
});

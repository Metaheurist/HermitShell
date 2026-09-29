import { describe, expect, it } from "vitest";
import worker, { sign } from "../src/index.js";
import { BASE, testEnv, valuesWith } from "./helpers.js";

// Same values as the KNOWN_*SIGNATURE constants in packages/daily-vacancy-report/tests/test_vacancy_report.py.
const KNOWN_SIGNATURE = "7a1921b9bd33f759be1489d932b2a57f";
const KNOWN_SKILL_SIGNATURE = "2852e1bfe92031fafbd79fffc07522f5";
const KNOWN_PROFILE_SIGNATURE = "4cab135492aab3ae0e242e623e497477";

async function link(action = "applied", key = "nijobs:123", title = "AI Engineer", profile = "") {
  const t = await sign("test-secret", key, action, title, "", profile);
  return { j: key, a: action, n: title, t, ...(profile ? { u: profile } : {}) };
}

async function skillLink(skills = "Kubernetes|Terraform|Go") {
  const t = await sign("test-secret", "nijobs:123", "add_skill", "AI Engineer", skills);
  return { j: "nijobs:123", a: "add_skill", n: "AI Engineer", s: skills, t };
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
    expect(valuesWith(env, "event:")).toHaveLength(1);
  });

  it("signs skill lists exactly like the Python scanner", async () => {
    expect(await sign("test-secret", "nijobs:123", "add_skill", "AI Engineer", "Kubernetes|Terraform|Go"))
      .toBe(KNOWN_SKILL_SIGNATURE);
  });

  it("offers the job's missing skills with the tapped one ticked", async () => {
    const env = testEnv();
    const res = await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams({ ...(await skillLink()), p: "Terraform" })}`), env);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('value="Terraform" checked');
    expect(body).toContain('value="Kubernetes">');
    expect(body).toContain("Other skills you have");
    expect(env.FEEDBACK.store.size).toBe(0);
  });

  it("rejects skill links whose skill list was changed", async () => {
    const env = testEnv();
    const tampered = { ...(await skillLink()), s: "Kubernetes|Terraform|Go|Rust" };
    expect((await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(tampered)}`), env)).status).toBe(403);
    const unsigned = { ...(await link("add_skill")) };
    expect((await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(unsigned)}`), env)).status).toBe(403);
  });

  it("saves ticked and typed skills, ignoring ticks that were not offered", async () => {
    const env = testEnv();
    const fields = new URLSearchParams({ ...(await skillLink()), r: "", o: "Rust, <Helm>!" });
    fields.append("k", "Terraform");
    fields.append("k", "Cobol");
    const res = await worker.fetch(new Request(`${BASE}/f`, { method: "POST", body: fields }), env);
    expect(await res.text()).toContain("Added to your skills: Terraform, Rust, Helm.");
    const [event] = [...env.FEEDBACK.store.values()].map((v) => JSON.parse(v));
    expect(event).toMatchObject({ j: "nijobs:123", a: "add_skill", skills: ["Terraform", "Rust", "Helm"] });
  });

  it("asks again when no skill was chosen", async () => {
    const env = testEnv();
    const res = await worker.fetch(formRequest({ ...(await skillLink()), r: "", o: " , " }), env);
    expect(res.status).toBe(400);
    expect(env.FEEDBACK.store.size).toBe(0);
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
    expect(valuesWith(env, "event:")).toHaveLength(1);
    expect(env.FEEDBACK.store.has("flag:events")).toBe(true);
  });

  it("answers polls from a flag without listing KV, and clears it once everything is acknowledged", async () => {
    const env = testEnv();
    let lists = 0;
    const list = env.FEEDBACK.list;
    env.FEEDBACK.list = (...args) => { lists += 1; return list(...args); };
    const auth = { headers: { Authorization: "Bearer api-token" } };
    await env.FEEDBACK.put("event:1:old", JSON.stringify({ id: "event:1:old", j: "nijobs:1", a: "applied" }));
    expect((await (await worker.fetch(new Request(`${BASE}/events`, auth), env)).json()).events).toEqual([]);
    expect(lists).toBe(0);
    const { events } = await (await worker.fetch(new Request(`${BASE}/events?full=1`, auth), env)).json();
    expect(events).toHaveLength(1);
    await worker.fetch(formRequest({ ...(await link("applied")), r: "" }), env);
    const flagged = await (await worker.fetch(new Request(`${BASE}/events`, auth), env)).json();
    const ids = flagged.events.map((e) => e.id);
    expect(ids).toHaveLength(2);
    await worker.fetch(new Request(`${BASE}/ack`, { method: "POST", ...auth, body: JSON.stringify({ ids }) }), env);
    expect(env.FEEDBACK.store.size).toBe(0);
  });

  it("signs profile links exactly like the Python scanner", async () => {
    expect(await sign("test-secret", "nijobs:123", "applied", "AI Engineer", "", "sam-lee")).toBe(KNOWN_PROFILE_SIGNATURE);
  });

  it("keeps each profile's answers apart and rejects a swapped profile id", async () => {
    const env = testEnv();
    const auth = { headers: { Authorization: "Bearer api-token" } };
    await worker.fetch(formRequest({ ...(await link("applied")), r: "" }), env);
    await worker.fetch(formRequest({ ...(await link("interested", "nijobs:9", "Analyst", "sam-lee")), r: "" }), env);
    const swapped = { ...(await link("applied", "nijobs:9", "Analyst", "sam-lee")), u: "alex-kim" };
    expect((await worker.fetch(formRequest({ ...swapped, r: "" }), env)).status).toBe(403);
    const bad = { ...(await link("applied")), u: "Not Valid!" };
    expect((await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(bad)}`), env)).status).toBe(403);
    const owner = await (await worker.fetch(new Request(`${BASE}/events`, auth), env)).json();
    expect(owner.events.map((e) => e.a)).toEqual(["applied"]);
    const sam = await (await worker.fetch(new Request(`${BASE}/events?u=sam-lee`, auth), env)).json();
    expect(sam.events).toMatchObject([{ a: "interested", u: "sam-lee" }]);
  });

  it("asks before unsubscribing and queues the removal for Hermes", async () => {
    const env = testEnv();
    const params = await link("unsubscribe", "profile", "Sam Lee", "sam-lee");
    const confirm = await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(params)}`), env);
    const body = await confirm.text();
    expect(body).toContain("deletes this profile");
    expect(body).toContain("Confirm: unsubscribe");
    expect(env.FEEDBACK.store.size).toBe(0);
    const res = await worker.fetch(formRequest({ ...params, r: "found a job" }), env);
    expect(await res.text()).toContain("gets no more reports");
    expect(valuesWith(env, "queue:")).toMatchObject([{ type: "unsubscribe", u: "sam-lee", reason: "found a job" }]);
    expect(valuesWith(env, "event:")).toEqual([]);
  });

  it("only pauses when the owner unsubscribes", async () => {
    const env = testEnv();
    const params = await link("unsubscribe", "profile-pause", "Your reports");
    const body = await (await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(params)}`), env)).text();
    expect(body).toContain("profile is kept");
    await worker.fetch(formRequest({ ...params, r: "" }), env);
    expect(valuesWith(env, "queue:")).toMatchObject([{ type: "unsubscribe", u: "" }]);
  });
});

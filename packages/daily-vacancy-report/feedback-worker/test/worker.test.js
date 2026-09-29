import { describe, expect, it } from "vitest";
import worker, { sign } from "../src/index.js";
import { today } from "../src/lib.js";
import { BASE, testEnv, valuesWith } from "./helpers.js";

// Same values as the KNOWN_* constants in packages/daily-vacancy-report/tests/test_vacancy_report.py.
const KNOWN_SIGNATURE = "bf5b2947e5f2b792d5a56680ef7d8ab8";
const KNOWN_SKILL_SIGNATURE = "1c160ba1b9a49c362a7107d21ce864bd";
const KNOWN_PROFILE_SIGNATURE = "981737ef0883273fc687a8aefaf92098";
const KNOWN_DAY = 20000;

async function link(action = "applied", key = "nijobs:123", title = "AI Engineer", profile = "", day = today()) {
  const t = await sign("test-secret", key, action, title, "", profile, day);
  return { j: key, a: action, n: title, ...(profile ? { u: profile } : {}), d: String(day), t };
}

async function skillLink(skills = "Kubernetes|Terraform|Go", profile = "") {
  const d = String(today());
  const t = await sign("test-secret", "nijobs:123", "add_skill", "AI Engineer", skills, profile, d);
  return { j: "nijobs:123", a: "add_skill", n: "AI Engineer", s: skills, ...(profile ? { u: profile } : {}), d, t };
}

function formRequest(fields) {
  return new Request(`${BASE}/f`, { method: "POST", body: new URLSearchParams(fields) });
}

describe("feedback worker", () => {
  it("signs links exactly like the Python scanner", async () => {
    expect(await sign("test-secret", "nijobs:123", "applied", "AI Engineer", "", "", KNOWN_DAY)).toBe(KNOWN_SIGNATURE);
  });

  it("does not let a profile's link be re-read as the owner's", async () => {
    // Under the old encoding "skills=u=sam-lee" with no profile signed the same bytes as profile "sam-lee".
    const env = testEnv();
    const sam = await skillLink("Go", "sam-lee");
    const shifted = { ...sam, s: "Go\nu=sam-lee" };
    delete shifted.u;
    expect((await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(shifted)}`), env)).status).toBe(403);
  });

  it("rejects links with control characters, no issue day or a day in the future", async () => {
    const env = testEnv();
    const nl = await link("applied", "nijobs:1", "AI\nEngineer");
    expect((await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(nl)}`), env)).status).toBe(403);
    const { d, ...noDay } = await link();
    expect(d).toBeTruthy();
    expect((await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(noDay)}`), env)).status).toBe(403);
    const future = await link("applied", "nijobs:123", "AI Engineer", "", today() + 5);
    expect((await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(future)}`), env)).status).toBe(403);
  });

  it("expires links after 90 days", async () => {
    const env = testEnv();
    const old = await link("applied", "nijobs:123", "AI Engineer", "", today() - 91);
    expect((await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(old)}`), env)).status).toBe(410);
    expect((await worker.fetch(formRequest({ ...old, r: "" }), env)).status).toBe(410);
    expect(env.FEEDBACK.store.size).toBe(0);
  });

  it("rejects links of profiles HermitShell no longer reports", async () => {
    const env = testEnv();
    await env.FEEDBACK.put("status:profiles", JSON.stringify({ profiles: [{ id: "alex-kim" }] }));
    const sam = await link("applied", "nijobs:9", "Analyst", "sam-lee");
    expect((await worker.fetch(formRequest({ ...sam, r: "" }), env)).status).toBe(410);
    const alex = await link("applied", "nijobs:9", "Analyst", "alex-kim");
    expect((await worker.fetch(formRequest({ ...alex, r: "" }), env)).status).toBe(200);
  });

  it("stores a replayed answer once", async () => {
    const env = testEnv();
    const params = { ...(await link("cover_letter")), r: "mention Azure" };
    await worker.fetch(formRequest(params), env);
    await worker.fetch(formRequest(params), env);
    expect(valuesWith(env, "event:")).toHaveLength(1);
    await worker.fetch(formRequest({ ...params, r: "mention AWS" }), env);
    expect(valuesWith(env, "event:")).toHaveLength(2);
  });

  it("refuses oversized answers", async () => {
    const env = testEnv();
    const res = await worker.fetch(formRequest({ ...(await link()), r: "x".repeat(20000) }), env);
    expect(res.status).toBe(413);
    expect(env.FEEDBACK.store.size).toBe(0);
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
    expect(event.id).toMatch(/^event:_:[0-9a-f]{32}:[0-9a-f]{12}$/);
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
    expect(await sign("test-secret", "nijobs:123", "add_skill", "AI Engineer", "Kubernetes|Terraform|Go", "", KNOWN_DAY))
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
    await worker.fetch(formRequest({ ...(await link("interested", "nijobs:abc", "ML Engineer")), r: "" }), env);
    const auth = { Authorization: "Bearer api-token" };
    const { events } = await (await worker.fetch(new Request(`${BASE}/events`, { headers: auth }), env)).json();
    expect(events.map((e) => e.a).sort()).toEqual(["applied", "interested"]);
    const ack = new Request(`${BASE}/ack`, {
      method: "POST", headers: auth, body: JSON.stringify({ ids: [events[0].id, "not-an-event"] }),
    });
    expect(await (await worker.fetch(ack, env)).json()).toEqual({ deleted: 1 });
    expect(valuesWith(env, "event:")).toHaveLength(1);
    expect(env.FEEDBACK.store.has("flag:events:_")).toBe(true);
  });

  it("answers polls from a flag without listing KV, and clears it once everything is acknowledged", async () => {
    const env = testEnv();
    let lists = 0;
    const list = env.FEEDBACK.list;
    env.FEEDBACK.list = (...args) => { lists += 1; return list(...args); };
    const auth = { headers: { Authorization: "Bearer api-token" } };
    await env.FEEDBACK.put("event:_:old", JSON.stringify({ id: "event:_:old", j: "nijobs:1", a: "applied" }));
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
    expect(await sign("test-secret", "nijobs:123", "applied", "AI Engineer", "", "sam-lee", KNOWN_DAY)).toBe(KNOWN_PROFILE_SIGNATURE);
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

  it("asks before unsubscribing, queues the removal for HermitShell and drops uncollected answers", async () => {
    const env = testEnv();
    await worker.fetch(formRequest({ ...(await link("interested", "nijobs:9", "Analyst", "sam-lee")), r: "commute" }), env);
    await worker.fetch(formRequest({ ...(await link("applied")), r: "" }), env);
    const params = await link("unsubscribe", "profile", "Sam Lee", "sam-lee");
    const confirm = await worker.fetch(new Request(`${BASE}/f?${new URLSearchParams(params)}`), env);
    const body = await confirm.text();
    expect(body).toContain("deletes this profile");
    expect(body).toContain('href="/privacy"');
    expect(body).toContain("Confirm: unsubscribe");
    const res = await worker.fetch(formRequest({ ...params, r: "found a job" }), env);
    expect(await res.text()).toContain("emails you when it is done");
    expect(valuesWith(env, "queue:")).toMatchObject([{ type: "unsubscribe", u: "sam-lee", reason: "found a job" }]);
    expect(valuesWith(env, "event:").map((e) => e.a)).toEqual(["applied"]);
    expect([...env.FEEDBACK.store.keys()].filter((k) => k.includes("sam-lee"))).toEqual([]);
  });

  it("publishes a privacy notice", async () => {
    const res = await worker.fetch(new Request(`${BASE}/privacy`), testEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const heading of ["What is kept", "How long", "How it is protected", "Deleting your data"]) {
      expect(body).toContain(heading);
    }
    expect(body).toContain("HermitShell server");
    expect(body).not.toContain("Hermes");
  });

  it("brands every page and the root endpoint as HermitShell", async () => {
    const env = testEnv({ ADMIN_PASSWORD: "correct horse battery" });
    for (const path of ["/privacy", "/admin", "/join?i=bad"]) {
      const body = await (await worker.fetch(new Request(`${BASE}${path}`), env)).text();
      expect(body, path).toContain('<div class="eyebrow">HermitShell</div>');
      expect(body, path).not.toContain("Daily Vacancy Report");
    }
    expect(await (await worker.fetch(new Request(`${BASE}/`), env)).text()).toBe("HermitShell feedback endpoint.");
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

import { describe, expect, it, vi } from "vitest";
import worker, { sign } from "../src/index.js";
import { queueItem } from "../src/join.js";
import { today } from "../src/lib.js";
import { REQUESTS_KEY, taskRows, tasksButton } from "../src/tasks.js";
import { BASE, keysWith, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const OWNER = { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, has_cv: true };
const SAM = { id: "sam-lee-456789", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true };
const REPORT = { id: "report:sam-lee-456789", kind: "report", u: "sam-lee-456789", state: "running", at: Date.now() - 240000,
  trigger: "schedule", stage: "Rating jobs", done: 12, total: 40, expected: 1200000 };
const LETTER = { id: "letter:owner:event:_:abc123:0a1b2c3d4e5f", kind: "cover_letter", u: "owner", state: "waiting",
  at: Date.now() - 60000, trigger: "email", title: "Data Engineer", employer: "Northwind Traders", retry: false };

async function setup(tasks = [], profiles = [OWNER, SAM]) {
  const env = testEnv(ADMIN);
  const report = (list, t = tasks) => worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API,
    body: JSON.stringify({ profiles: list, tasks: t, timezone: "Europe/London" }) }), env);
  await report(profiles);
  const res = await worker.fetch(new Request(`${BASE}/admin/login`, { method: "POST",
    body: new URLSearchParams({ username: "admin", password: ADMIN.ADMIN_PASSWORD }), headers: { "CF-Connecting-IP": "203.0.113.9" } }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = (path = "/admin") => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
  const csrf = (await (await get("/admin/tasks")).text()).match(/name="csrf" value="([^"]+)"/)?.[1]
    || (await (await get()).text()).match(/name="csrf" value="([^"]+)"/)[1];
  const cancel = (task, token = csrf) => worker.fetch(new Request(`${BASE}/admin/tasks`, { method: "POST", headers: { Cookie: cookie },
    body: new URLSearchParams({ csrf: token, task }) }), env);
  return { env, get, report, cancel, cookie };
}

async function press(env, action = "cover_letter", title = "AI Engineer", profile = "") {
  const d = String(today());
  const t = await sign("test-secret", "nijobs:123", action, title, "", profile, d);
  const fields = { j: "nijobs:123", a: action, n: title, ...(profile ? { u: profile } : {}), d, t, r: "" };
  await worker.fetch(new Request(`${BASE}/f`, { method: "POST", body: new URLSearchParams(fields) }), env);
  return JSON.parse(env.FEEDBACK.store.get(REQUESTS_KEY) || "[]");
}

describe("the Tasks button", () => {
  it("shows a spinning ring and the count only while there are tasks", () => {
    expect(tasksButton(0)).not.toContain("tcount");
    expect(tasksButton(0)).not.toContain("busy");
    expect(tasksButton(3)).toContain('class="tasksbtn busy"');
    expect(tasksButton(3)).toContain('<span class="tcount">3</span>');
    expect(tasksButton(250)).toContain('<span class="tcount">99+</span>');
  });

  it("counts HermitShell's tasks, the queue and uncollected requests on the dashboard, with the modal and its frame", async () => {
    const { env, get } = await setup([REPORT, LETTER]);
    await queueItem(env, { type: "admin", action: "pause", u: "sam-lee-456789" });
    await press(env, "tailored_cv", "BI Developer");
    const res = await get();
    const body = await res.text();
    expect(body).toContain('<span class="tcount">4</span>');
    expect(body).toContain('id="tasks"');
    expect(body).toContain('<iframe class="tasksframe" src="/admin/tasks" loading="lazy"');
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-src 'self'");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("is there with no tasks and no profiles yet", async () => {
    const { get } = await setup([], []);
    const body = await (await get()).text();
    expect(body).toContain('class="tasksbtn"');
    expect(body).not.toContain('<span class="tcount">');
  });
});

describe("the task list", () => {
  it("lists a running report with its stage and progress, then what waits, with who and what started it", async () => {
    const { env, get } = await setup([LETTER, REPORT]);
    await queueItem(env, { type: "signup", name: "Riley Chen", email: "riley@example.com", roles: "Analyst" });
    const res = await get("/admin/tasks");
    const body = await res.text();
    const rows = body.split('<li class="task').slice(1);
    expect(rows[0]).toContain("s-running");
    expect(rows[0]).toContain("<b>Daily report</b>");
    expect(rows[0]).toContain("Sam Lee");
    expect(rows[0]).toContain("scheduled");
    expect(rows[0]).toContain("Rating jobs &middot; 12 of 40");
    expect(rows[0]).toContain('style="width:30%"');
    expect(rows[0]).toContain(">Stop</button>");
    expect(body).toContain("Data Engineer at Northwind Traders");
    expect(body).toContain("email button");
    expect(body).toContain("<b>Sign-up</b>");
    expect(body).toContain("Riley Chen");
    expect(body).toContain("sign-up form");
    expect(body).toContain(">Cancel</button>");
    expect(body).toMatch(/<meta http-equiv="refresh" content="5;url=\/admin\/tasks\?n=1">/);
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
  });

  it("spins a round ring on the running task that carries on where it was after each refresh", async () => {
    const { get } = await setup([REPORT, LETTER]);
    const body = await (await get("/admin/tasks")).text();
    const [running, waiting] = body.split('<li class="task').slice(1);
    const phase = running.match(/^[^>]*s-running" style="--spin:(-\d\.\d\d)s">/);
    expect(phase).not.toBeNull();
    expect(Number(phase[1])).toBeGreaterThan(-1);
    expect(Number(phase[1])).toBeLessThanOrEqual(0);
    expect(waiting).not.toContain("--spin");
    expect(body).toContain(".s-running .ticon{margin:0 3px;border-radius:50%");
    expect(body).toContain("animation:tspin 1s linear infinite;animation-delay:var(--spin,0s)");
    expect(body).toMatch(/mask:radial-gradient\(farthest-side/);
  });

  it("starts the ring within its one-second turn even in the last milliseconds of a second", async () => {
    const { get } = await setup([REPORT]);
    const now = vi.spyOn(Date, "now").mockReturnValue(Math.floor(Date.now() / 1000) * 1000 + 999);
    try {
      expect(await (await get("/admin/tasks")).text()).toContain('style="--spin:-0.99s"');
    } finally {
      now.mockRestore();
    }
  });

  it("estimates progress from the last run when there is no count, and slows then stops refreshing", async () => {
    const t = { ...REPORT, done: 0, total: 0, at: Date.now() - 600000, expected: 1200000 };
    const { get } = await setup([t]);
    const body = await (await get("/admin/tasks?n=30")).text();
    expect(body).toContain('class="bar est"');
    expect(body).toContain('style="width:50%"');
    expect(body).toContain('content="15;url=/admin/tasks?n=31"');
    const stopped = await (await get("/admin/tasks?n=99")).text();
    expect(stopped).not.toContain("http-equiv");
    expect(stopped).toContain("Updates paused");
  });

  it("says when nothing is waiting or running", async () => {
    const { get } = await setup();
    const body = await (await get("/admin/tasks")).text();
    expect(body).toContain("Nothing waiting or running");
    expect(body).toContain('content="20;url=/admin/tasks?n=1"');
  });

  it("drops a request once HermitShell reports it, and when HermitShell collects it", async () => {
    const { env } = await setup();
    const held = await press(env, "cover_letter", "AI Engineer");
    expect(held).toHaveLength(1);
    const status = { profiles: [OWNER], tasks: [{ ...LETTER, id: `letter:owner:${held[0].id}` }] };
    expect(taskRows(status, [], held)).toHaveLength(1);
    await worker.fetch(new Request(`${BASE}/ack`, { method: "POST", headers: API, body: JSON.stringify({ ids: [held[0].id] }) }), env);
    expect(env.FEEDBACK.store.has(REQUESTS_KEY)).toBe(false);
  });

  it("names a job email from the list of jobs sent, with its own icon and stage while it is sent", async () => {
    const sending = { ...LETTER, id: "letter:sam-lee-456789:event:sam-lee-456789:dash-0a1b:mg1", kind: "send_job", u: "sam-lee-456789",
      state: "running", trigger: "dashboard" };
    const { get } = await setup([sending]);
    const body = await (await get("/admin/tasks")).text();
    expect(body).toContain("<b>Job email</b>");
    expect(body).toContain("Sending the email");
    expect(body).toContain("Data Engineer at Northwind Traders");
    expect(body).toContain('<path d="m4 7 8 6 8-6"/>');
    const held = [{ id: "event:_:dash-0a1b:mg1", a: "send_job", n: "Data Engineer", u: "", at: Date.now(), via: "dashboard" }];
    expect(taskRows({ profiles: [OWNER] }, [], held)[0]).toMatchObject({ kind: "send_job", trigger: "dashboard", where: "worker" });
  });

  it("only remembers cover letter and tailored CV presses", async () => {
    const { env } = await setup();
    expect(await press(env, "applied")).toEqual([]);
    expect((await press(env, "tailored_cv", "BI Developer"))[0]).toMatchObject({ a: "tailored_cv", n: "BI Developer", u: "" });
  });
});

describe("cancelling a task", () => {
  it("deletes a queued change and its CV file at once", async () => {
    const { env, cancel } = await setup();
    env.FEEDBACK.store.set(`cvfile:${"a".repeat(32)}`, "bytes");
    const id = await queueItem(env, { type: "admin", action: "cv", u: "sam-lee-456789", cv: { key: `cvfile:${"a".repeat(32)}` } });
    const res = await cancel(id);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/tasks?done=cancelled");
    expect(keysWith(env, "queue:")).toEqual([]);
    expect(keysWith(env, "cvfile:")).toEqual([]);
    expect(env.FEEDBACK.store.has("flag:queue")).toBe(false);
  });

  it("deletes a request HermitShell has not collected", async () => {
    const { env, cancel } = await setup();
    const [held] = await press(env, "cover_letter");
    expect(env.FEEDBACK.store.has(held.id)).toBe(true);
    expect((await cancel(held.id)).headers.get("Location")).toBe("/admin/tasks?done=cancelled");
    expect(env.FEEDBACK.store.has(held.id)).toBe(false);
    expect(env.FEEDBACK.store.has(REQUESTS_KEY)).toBe(false);
  });

  it("asks HermitShell to stop a running report, once, and shows it as stopping", async () => {
    const { env, cancel, get } = await setup([REPORT]);
    expect((await cancel(REPORT.id)).headers.get("Location")).toBe("/admin/tasks?done=stopping");
    await cancel(REPORT.id);
    const items = keysWith(env, "queue:").map((k) => JSON.parse(env.FEEDBACK.store.get(k)));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "admin", action: "cancel", u: "sam-lee-456789", task: REPORT.id });
    const body = await (await get("/admin/tasks?done=stopping")).text();
    expect(body).toContain("s-stopping");
    expect(body).toContain("Stopping&hellip;");
    expect(body).not.toContain(">Stop</button>");
    expect(body).toContain("Asked HermitShell to stop it");
    expect(body.split('<li class="task')).toHaveLength(2);
  });

  it("asks HermitShell to cancel a request it has collected, for the right profile", async () => {
    const { env, cancel } = await setup([LETTER]);
    await cancel(LETTER.id);
    const [item] = keysWith(env, "queue:").map((k) => JSON.parse(env.FEEDBACK.store.get(k)));
    expect(item).toMatchObject({ action: "cancel", u: "owner", task: LETTER.id });
  });

  it("says a task that has already finished is gone", async () => {
    const { env, cancel } = await setup();
    expect((await cancel("report:sam-lee-456789")).headers.get("Location")).toBe("/admin/tasks?done=gone");
    expect((await cancel("queue:1:0a0a0a0a")).headers.get("Location")).toBe("/admin/tasks?done=gone");
    expect(keysWith(env, "history:")).toEqual([]);
  });

  it("writes the cancellation, and who made it, in the recruit's history, and never in the admin's", async () => {
    const { env, cancel } = await setup([REPORT, LETTER]);
    const [held] = await press(env, "tailored_cv", "AI Engineer", "sam-lee-456789");
    const change = await queueItem(env, { type: "admin", action: "pause", u: "sam-lee-456789" });
    for (const id of [held.id, REPORT.id, REPORT.id, change, LETTER.id]) await cancel(id);
    const sam = valuesWith(env, "history:sam-lee-456789:").flat().filter((e) => e.k === "cancel");
    expect(sam.map((e) => [e.k, e.t, e.by])).toEqual([
      ["cancel", "Cancelled the tailored CV: AI Engineer", "Alex Morgan"],
      ["cancel", "Stopped the job report", "Alex Morgan"],
      ["cancel", "Cancelled: Pause reports", "Alex Morgan"],
    ]);
    expect(keysWith(env, "queue:").map((k) => JSON.parse(env.FEEDBACK.store.get(k)))).toContainEqual(
      expect.objectContaining({ action: "cancel", u: "owner", task: LETTER.id }));
    expect(keysWith(env, "history:owner:")).toEqual([]);
  });
});

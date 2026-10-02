// Off-server copies of HermitShell's backups (backups.js): uploaded part by part over the signed API into their own
// Durable Object instance, encrypted ones only, listed, read back, rotated and downloaded by admins alone.
import { describe, expect, it } from "vitest";
import { signature } from "../src/apiauth.js";
import { BACKUPS_URL, BACKUP_PART_BYTES, MAX_BACKUPS, vault } from "../src/backups.js";
import worker from "../src/index.js";
import { serverBox } from "../src/models.js";
import { BASE, memoryHub, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const PASSWORD = "a long enough passphrase";
const TOKEN = { Authorization: "Bearer api-token" };
const NAME = "hermitshell-20261001-031500.tar.gz.enc";
const hexOf = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const nonce = () => hexOf(crypto.getRandomValues(new Uint8Array(16)));
const sha256 = async (bytes) => hexOf(await crypto.subtle.digest("SHA-256", bytes));

// What hermes_common.seal writes: HSEAL1, then the nonce and ciphertext (random bytes stand in for them).
function sealed(size) {
  const out = new Uint8Array(size);
  for (let at = 0; at < size; at += 65536) crypto.getRandomValues(out.subarray(at, Math.min(size, at + 65536)));
  out.set(new TextEncoder().encode("HSEAL1"));
  return out;
}

// One HUB binding whose instances are kept apart by name, as Cloudflare keeps them.
function hubs() {
  const made = new Map();
  return { made, idFromName: (name) => name, get: (id) => (made.get(id) || made.set(id, memoryHub({ sql: "sqlite" })).get(id)).get() };
}

function setupEnv(extra = {}) {
  return testEnv({ ...ADMIN, HUB: hubs(), ...extra });
}

// A request as common/worker_link.py signs it; a string body is JSON, bytes go as they are.
async function api(env, method, target, body = null) {
  const bytes = body == null ? null : typeof body === "string" ? new TextEncoder().encode(body) : body;
  const stamp = Date.now();
  const id = nonce();
  const mac = await signature("test-secret", method, target, stamp, id, bytes);
  return worker.fetch(new Request(`${BASE}${target}`, { method, body: bytes, headers: { ...TOKEN, "X-HermitShell-Time": String(stamp),
    "X-HermitShell-Nonce": id, "X-HermitShell-Signature": `v1=${mac}` } }), env);
}

// maintenance.send_offsite: every part, then the list.
async function upload(env, name, data) {
  const n = Math.max(1, Math.ceil(data.length / BACKUP_PART_BYTES));
  const sha = await sha256(data);
  const answers = [];
  for (let i = 0; i < n; i++) {
    const res = await api(env, "POST", `/api/backup/part?${new URLSearchParams({ name, i: String(i), n: String(n), sha })}`,
      data.subarray(i * BACKUP_PART_BYTES, (i + 1) * BACKUP_PART_BYTES));
    answers.push([res.status, await res.json()]);
  }
  return { n, sha, answers };
}

const list = async (env) => (await (await api(env, "GET", "/api/backups")).json()).backups;

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

async function signIn(env, username, ip) {
  const password = username === "admin" ? ADMIN.ADMIN_PASSWORD : PASSWORD;
  const res = await worker.fetch(post("/admin/login", { username, password }, { "CF-Connecting-IP": ip }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = (path) => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
  get.post = (path, fields) => worker.fetch(post(path, fields, { Cookie: cookie }), env);
  return get;
}

describe("off-server backups over the API", () => {
  it("keeps a backup sent in parts, in its own Durable Object instance, and gives each part back", async () => {
    const env = setupEnv();
    const data = sealed(2 * BACKUP_PART_BYTES + 12345);
    const { n, sha, answers } = await upload(env, NAME, data);
    expect(n).toBe(3);
    expect(answers.map(([status, body]) => [status, body.done])).toEqual([[200, false], [200, false], [200, true]]);
    const [kept] = await list(env);
    expect(kept).toMatchObject({ name: NAME, parts: 3, sha, size: data.length });
    expect(kept.at).toBeGreaterThan(0);
    const back = [];
    for (let i = 0; i < n; i++) {
      const res = await api(env, "GET", `/api/backup/part?name=${NAME}&i=${i}`);
      expect(res.status).toBe(200);
      back.push(new Uint8Array(await res.arrayBuffer()));
    }
    const joined = new Uint8Array(back.reduce((sum, b) => sum + b.length, 0));
    back.reduce((at, b) => (joined.set(b, at), at + b.length), 0);
    expect(await sha256(joined)).toBe(sha);
    const tables = (id) => env.HUB.made.get(id).state.storage.sql.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    expect(tables("backups")).toEqual(expect.arrayContaining(["backups", "backup_parts"]));
    expect(tables("hub")).not.toContain("backup_parts");
  });

  it("doesn't list or hand out a backup until every part has arrived, and drops it after a day", async () => {
    const env = setupEnv();
    const data = sealed(BACKUP_PART_BYTES + 10);
    const sha = await sha256(data);
    await api(env, "POST", `/api/backup/part?name=${NAME}&i=0&n=2&sha=${sha}`, data.subarray(0, BACKUP_PART_BYTES));
    expect(await list(env)).toEqual([]);
    expect((await api(env, "GET", `/api/backup/part?name=${NAME}&i=0`)).status).toBe(404);
    const sql = env.HUB.made.get("backups").state.storage.sql;
    await vault(sql, new Request("https://hub/backup/list"), "/backup/list", Date.now() + 25 * 3600 * 1000);
    expect(sql.db.prepare("SELECT COUNT(*) AS n FROM backup_parts").get().n).toBe(0);
  });

  it("takes only encrypted backups with HermitShell's names, whole parts and a SHA-256", async () => {
    const env = setupEnv();
    const part = sealed(1000);
    const sha = await sha256(part);
    const send = async (query, body = part) => [(await api(env, "POST", `/api/backup/part?${query}`, body)).status];
    const plain = new TextEncoder().encode("plain tar.gz bytes");
    expect(await send(`name=${NAME}&i=0&n=1&sha=${sha}`, plain)).toEqual([400]);
    for (const name of ["../../hub", "hermitshell-20261001-031500.tar.gz", "hermes-20261001-031500.tar.gz.enc", `${NAME}x`, ""]) {
      expect(await send(`name=${encodeURIComponent(name)}&i=0&n=1&sha=${sha}`)).toEqual([400]);
    }
    expect(await send(`name=${NAME}&i=1&n=1&sha=${sha}`)).toEqual([400]);
    expect(await send(`name=${NAME}&i=0&n=65&sha=${sha}`)).toEqual([400]);
    expect(await send(`name=${NAME}&i=0&n=2&sha=${sha}`)).toEqual([400]);
    expect(await send(`name=${NAME}&i=0&n=1&sha=nothex`)).toEqual([400]);
    expect(await send(`name=${NAME}&i=0&n=1&sha=${sha}`, sealed(BACKUP_PART_BYTES + 1))).toEqual([400]);
    expect(await send(`name=${NAME}&i=0&n=1&sha=${sha}`, sealed(5 * BACKUP_PART_BYTES))).toEqual([413]);
    expect(await list(env)).toEqual([]);
  });

  it("keeps a finished backup as it is: the same one again is fine, a different one under its name is refused", async () => {
    const env = setupEnv();
    const data = sealed(5000);
    await upload(env, NAME, data);
    expect((await upload(env, NAME, data)).answers).toEqual([[200, { ok: true, done: true }]]);
    expect((await upload(env, NAME, sealed(5000))).answers[0][0]).toBe(409);
    expect((await list(env)).map((b) => b.size)).toEqual([5000]);
  });

  it("starts an upload afresh when it comes back with another file, and refuses more than it may keep", async () => {
    const env = setupEnv();
    const first = sealed(BACKUP_PART_BYTES + 1);
    await api(env, "POST", `/api/backup/part?name=${NAME}&i=0&n=2&sha=${await sha256(first)}`, first.subarray(0, BACKUP_PART_BYTES));
    const second = sealed(300);
    await upload(env, NAME, second);
    expect(await list(env)).toMatchObject([{ name: NAME, parts: 1, size: 300 }]);
    for (let k = 1; k < MAX_BACKUPS; k++) await upload(env, `hermitshell-202609${String(k).padStart(2, "0")}-030000.tar.gz.enc`, sealed(100));
    expect((await list(env)).length).toBe(MAX_BACKUPS);
    expect((await upload(env, "hermitshell-20261002-030000.tar.gz.enc", sealed(100))).answers[0]).toEqual([507, { error: "full" }]);
  });

  it("lists newest first and deletes the copies HermitShell rotates out", async () => {
    const env = setupEnv();
    const older = "hermitshell-20260901-031500.tar.gz.enc";
    await upload(env, older, sealed(100));
    await upload(env, NAME, sealed(200));
    expect((await list(env)).map((b) => b.name)).toEqual([NAME, older]);
    const gone = await api(env, "POST", "/api/backup/delete", JSON.stringify({ name: older }));
    expect(await gone.json()).toEqual({ deleted: true });
    expect(await (await api(env, "POST", "/api/backup/delete", JSON.stringify({ name: older }))).json()).toEqual({ deleted: false });
    expect((await list(env)).map((b) => b.name)).toEqual([NAME]);
    expect((await api(env, "POST", "/api/backup/delete", JSON.stringify({ name: "../hub" }))).status).toBe(400);
  });

  it("says so without the HUB binding", async () => {
    const env = testEnv();
    const res = await api(env, "GET", "/api/backups");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("HUB");
  });
});

describe("off-server backups are HermitShell's and the admins' alone", () => {
  it("refuses the API without the token, or with a forged or replayed signature", async () => {
    const env = setupEnv();
    await upload(env, NAME, sealed(100));
    for (const path of ["/api/backups", `/api/backup/part?name=${NAME}&i=0`]) {
      expect((await worker.fetch(new Request(`${BASE}${path}`), env)).status).toBe(401);
      expect((await worker.fetch(new Request(`${BASE}${path}`, { headers: { Authorization: "Bearer wrong" } }), env)).status).toBe(401);
      expect((await worker.fetch(new Request(`${BASE}${path}`, { headers: TOKEN }), env)).status).toBe(401);
    }
    const stamp = Date.now();
    const id = nonce();
    const forged = await signature("not-the-secret", "GET", "/api/backups", stamp, id, null);
    const headers = { ...TOKEN, "X-HermitShell-Time": String(stamp), "X-HermitShell-Nonce": id };
    expect((await worker.fetch(new Request(`${BASE}/api/backups`, { headers: { ...headers, "X-HermitShell-Signature": `v1=${forged}` } }), env)).status).toBe(401);
    const real = await signature("test-secret", "GET", "/api/backups", stamp, id, null);
    const once = () => worker.fetch(new Request(`${BASE}/api/backups`, { headers: { ...headers, "X-HermitShell-Signature": `v1=${real}` } }), env);
    expect((await once()).status).toBe(200);
    expect((await once()).status).toBe(401);
    const delStamp = Date.now();
    const delId = nonce();
    const body = JSON.stringify({ name: NAME });
    const signedOther = await signature("test-secret", "POST", "/api/backup/delete", delStamp, delId, new TextEncoder().encode(JSON.stringify({ name: "x" })));
    expect((await worker.fetch(new Request(`${BASE}/api/backup/delete`, { method: "POST", body, headers: { ...TOKEN, "X-HermitShell-Time": String(delStamp),
      "X-HermitShell-Nonce": delId, "X-HermitShell-Signature": `v1=${signedOther}` } }), env)).status).toBe(401);
    expect((await list(env)).map((b) => b.name)).toEqual([NAME]);
  });

  it("lists the copies for an admin and downloads one byte for byte, never cached", async () => {
    const env = setupEnv();
    await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: TOKEN, body: JSON.stringify({ timezone: "Europe/London", profiles: [] }) }), env);
    const data = sealed(BACKUP_PART_BYTES + 777);
    await upload(env, NAME, data);
    const get = await signIn(env, "admin", "203.0.113.60");
    const html = await (await get(BACKUPS_URL)).text();
    expect(html).toContain("Backups on Cloudflare");
    expect(html).toContain(NAME);
    expect(html).toContain(`${BACKUPS_URL}?name=${NAME}`);
    expect(html).toContain("HERMES_DATA_KEY");
    expect(html).toContain("1 kept");
    const res = await get(`${BACKUPS_URL}?name=${NAME}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="${NAME}"`);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Length")).toBe(String(data.length));
    expect(await sha256(await res.arrayBuffer())).toBe(await sha256(data));
    expect((await get(`${BACKUPS_URL}?name=hermitshell-20200101-000000.tar.gz.enc`)).status).toBe(404);
    expect((await get(`${BACKUPS_URL}?name=${encodeURIComponent("../hub")}`)).status).toBe(404);
  });

  it("says when there are none yet", async () => {
    const env = setupEnv();
    const get = await signIn(env, "admin", "203.0.113.61");
    expect(await (await get(BACKUPS_URL)).text()).toContain("No backups here yet");
  });

  it("is refused to managers, recruiters and anyone signed out", async () => {
    const env = setupEnv();
    await upload(env, NAME, sealed(100));
    const admin = await signIn(env, "admin", "203.0.113.62");
    const csrf = (await (await admin("/admin")).text()).match(/name="csrf" value="([0-9a-f]+)"/)[1];
    for (const [name, username, roles] of [["Morgan Ellis", "morgan", "manager"], ["Casey Quinn", "casey", "recruiter"]]) {
      const added = await admin.post("/admin/users", { csrf, op: "add", name, username, password: PASSWORD, roles });
      expect(added.headers.get("Location")).toBe("/admin/users?done=added");
    }
    for (const [username, ip] of [["morgan", "203.0.113.64"], ["casey", "203.0.113.65"]]) {
      const get = await signIn(env, username, ip);
      for (const path of [BACKUPS_URL, `${BACKUPS_URL}?name=${NAME}`]) {
        const res = await get(path);
        expect(res.status).toBe(403);
        expect(res.headers.get("Content-Type")).toContain("text/html");
      }
    }
    const out = await worker.fetch(new Request(`${BASE}${BACKUPS_URL}?name=${NAME}`), env);
    expect(out.headers.get("Content-Type")).toContain("text/html");
    expect(await out.text()).not.toContain("HSEAL1");
  });
});

describe("the server panel's off-server line", () => {
  const box = (offsite) => serverBox({ backup: { at: Date.now() - 3600000, size: 2048, kept: 3, encrypted: true, error: "", ...(offsite === undefined ? {} : { offsite }) } }, "c");

  it("says when the last copy went, how many are kept and links to them", () => {
    const html = box({ on: true, why: "", at: Date.now() - 2 * 3600000, kept: 7, error: "", failed_at: null });
    expect(html).toContain("On Cloudflare too: last sent 2 hours ago &middot; 7 kept");
    expect(html).toContain(`<a href="${BACKUPS_URL}">Download</a>`);
    expect(box({ on: true, why: "", at: null, kept: 0, error: "", failed_at: null })).toContain("On Cloudflare too, from the next backup");
  });

  it("shows a failure newer than the last copy, escaped, and not an older one", () => {
    const failed = box({ on: true, why: "", at: Date.now() - 86400000, kept: 7, error: "feedback Worker answered <b>HTTP 507</b>", failed_at: Date.now() - 60000 });
    expect(failed).toContain("Sending the last backup to Cloudflare failed");
    expect(failed).toContain("&lt;b&gt;HTTP 507&lt;/b&gt;");
    expect(failed).not.toContain("<b>HTTP 507</b>");
    expect(box({ on: true, why: "", at: Date.now(), kept: 7, error: "old", failed_at: Date.now() - 86400000 })).not.toContain("failed");
  });

  it("says why copies stay on the server, and nothing for an older HermitShell", () => {
    expect(box({ on: false, why: "off" })).toContain("HERMES_BACKUP_OFFSITE=off");
    expect(box({ on: false, why: "unencrypted" })).toContain("Not sent to Cloudflare until they are encrypted");
    expect(box({ on: false, why: "worker" })).toContain("Redeploy the Worker");
    expect(box({ on: false, why: "<script>" })).not.toContain("<script>");
    expect(box(undefined)).not.toContain("Cloudflare");
    expect(box("nonsense")).not.toContain("Cloudflare");
  });
});

import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { TAGS_KEY, notesKey, purgeProfileEvents } from "../src/lib.js";
import { MAX_NOTE, MAX_NOTES, cleanNote, cleanTags, readNotes, tagIndex } from "../src/notes.js";
import { getSealedJson, putSealedJson } from "../src/vault.js";
import { BASE, keysWith, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const CASEY_PASSWORD = "a long enough passphrase";
const PROFILES = [
  { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false, recruit: "" },
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true, recruiter: "casey" },
  { id: "jordan-patel", name: "Jordan Patel", email: "jordan@contoso.example", status: "active", has_cv: true },
];

function post(path, fields, headers = {}) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

async function signIn(env, username, password, ip) {
  const res = await worker.fetch(post("/admin/login", { username, password }, { "CF-Connecting-IP": ip }), env);
  return (res.headers.get("Set-Cookie") || "").split(";")[0];
}

function client(env, cookie) {
  const text = async (path) => (await worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env)).text();
  const csrf = async () => (await text("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  const send = async (fields, path = "/admin/notes") => worker.fetch(post(path, { csrf: await csrf(), ...fields }, { Cookie: cookie }), env);
  const where = async (fields, path) => (await send(fields, path)).headers.get("Location");
  return { text, csrf, send, where };
}

async function setup() {
  const env = testEnv(ADMIN);
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles: PROFILES }) }), env);
  const admin = client(env, await signIn(env, "admin", ADMIN.ADMIN_PASSWORD, "203.0.113.9"));
  await admin.send({ op: "add", name: "Casey Quinn", username: "casey", password: CASEY_PASSWORD, roles: "recruiter" }, "/admin/users");
  const casey = client(env, await signIn(env, "casey", CASEY_PASSWORD, "203.0.113.10"));
  return { env, admin, casey };
}

describe("notes", () => {
  it("adds a note, kept encrypted, shown escaped, and recorded in the history without its text", async () => {
    const { env, admin } = await setup();
    expect(await admin.where({ op: "add", u: "sam-lee", note: "Open to <b>contract</b> roles\nCall after 5" }))
      .toBe("/admin/profile?u=sam-lee&done=noted#notes");
    const raw = new TextDecoder().decode(new Uint8Array(await env.FEEDBACK.get(notesKey("sam-lee"), "arrayBuffer")));
    expect(raw).not.toContain("contract");
    const page = await admin.text("/admin/profile?u=sam-lee&done=noted");
    expect(page).toContain("Note added.");
    expect(page).toContain("Open to &lt;b&gt;contract&lt;/b&gt; roles\nCall after 5");
    expect(page).not.toContain("<b>contract</b>");
    const history = valuesWith(env, "history:sam-lee:").flat();
    expect(history.map((e) => [e.k, e.t])).toEqual([["note", "Added a note"]]);
    expect(JSON.stringify(history)).not.toContain("contract");
    expect(keysWith(env, "queue:")).toEqual([]);
  });

  it("refuses an empty note and keeps at most 100, each at most 1,000 characters", async () => {
    const { env, admin } = await setup();
    expect(await admin.where({ op: "add", u: "sam-lee", note: "  \u0001 " })).toBe("/admin/profile?u=sam-lee&done=emptynote#notes");
    expect((await readNotes(env, "sam-lee")).notes).toEqual([]);
    const notes = Array.from({ length: MAX_NOTES }, (_, i) => ({ id: i.toString(16).padStart(16, "0"), text: `n${i}`, by: "Alex", uid: "admin", at: i + 1 }));
    await putSealedJson(env, notesKey("sam-lee"), { tags: [], notes });
    await admin.send({ op: "add", u: "sam-lee", note: "x".repeat(MAX_NOTE + 50) });
    const kept = (await readNotes(env, "sam-lee")).notes;
    expect(kept).toHaveLength(MAX_NOTES);
    expect(kept[0].text).toBe("n1");
    expect(kept.at(-1).text).toHaveLength(MAX_NOTE);
    expect(cleanNote("a\u0000b\r\nc\td")).toBe("a b\nc d");
  });

  it("lets a recruiter note their own recruits only, and delete only their own notes", async () => {
    const { env, admin, casey } = await setup();
    expect(await casey.where({ op: "add", u: "sam-lee", note: "Casey's note" })).toBe("/admin/profile?u=sam-lee&done=noted#notes");
    expect((await casey.send({ op: "add", u: "jordan-patel", note: "Not mine" })).status).toBe(404);
    expect((await casey.send({ op: "add", u: "owner", note: "Staff" })).status).toBe(404);
    expect((await readNotes(env, "jordan-patel")).notes).toEqual([]);
    await admin.send({ op: "add", u: "sam-lee", note: "Admin's note" });
    const [mine, theirs] = (await readNotes(env, "sam-lee")).notes;
    const page = await casey.text("/admin/profile?u=sam-lee");
    expect(page.match(/aria-label="Delete this note"/g)).toHaveLength(1);
    await casey.send({ op: "delete", u: "sam-lee", id: theirs.id });
    expect((await readNotes(env, "sam-lee")).notes).toHaveLength(2);
    await admin.send({ op: "delete", u: "sam-lee", id: mine.id });
    expect((await readNotes(env, "sam-lee")).notes.map((n) => n.text)).toEqual(["Admin's note"]);
    expect(valuesWith(env, "history:sam-lee:").flat().map((e) => e.t)).toEqual(["Added a note", "Added a note", "Deleted a note"]);
  });

  it("refuses a form without the CSRF token", async () => {
    const { env } = await setup();
    const cookie = await signIn(env, "admin", ADMIN.ADMIN_PASSWORD, "203.0.113.11");
    const res = await worker.fetch(post("/admin/notes", { op: "add", u: "sam-lee", note: "x" }, { Cookie: cookie }), env);
    expect(res.status).toBe(403);
    expect(env.FEEDBACK.store.has(notesKey("sam-lee"))).toBe(false);
  });

  it("does not open a sealed value copied onto another recruit's key", async () => {
    const { env, admin } = await setup();
    await admin.send({ op: "add", u: "sam-lee", note: "Only for Sam" });
    env.FEEDBACK.store.set(notesKey("jordan-patel"), env.FEEDBACK.store.get(notesKey("sam-lee")));
    expect(await getSealedJson(env, notesKey("jordan-patel"))).toBeNull();
    expect(await getSealedJson({ ...env, JOB_FEEDBACK_SECRET: "another-secret" }, notesKey("sam-lee"))).toBeNull();
  });
});

describe("tags", () => {
  it("saves tags, shows them as pills on the list and filters by one", async () => {
    const { env, admin } = await setup();
    expect(await admin.where({ op: "tags", u: "sam-lee", tags: "Shortlist,  needs   visa, shortlist" }))
      .toBe("/admin/profile?u=sam-lee&done=tagged#notes");
    expect((await readNotes(env, "sam-lee")).tags).toEqual(["shortlist", "needs visa"]);
    expect(await tagIndex(env)).toEqual({ "sam-lee": ["shortlist", "needs visa"] });
    expect(new TextDecoder().decode(new Uint8Array(await env.FEEDBACK.get(TAGS_KEY, "arrayBuffer")))).not.toContain("visa");
    const list = await admin.text("/admin");
    expect(list).toContain('<a class="tagpill" href="/admin?tag=needs%20visa"');
    const filtered = await admin.text("/admin?tag=needs%20visa");
    expect(filtered).toContain("Sam Lee");
    expect(filtered).not.toContain("Jordan Patel");
    expect(filtered).toContain("1 tagged");
    expect(await admin.text("/admin?q=shortlist")).not.toContain("Jordan Patel");
    expect(valuesWith(env, "history:sam-lee:").flat().map((e) => e.t)).toEqual(["Changed their tags"]);
  });

  it("refuses bad tags and writes nothing; saving the same tags writes no history", async () => {
    const { env, admin } = await setup();
    for (const tags of ["a,b,c,d,e,f,g,h,i", "<script>", "-dash-first", "x".repeat(21)]) {
      expect(await admin.where({ op: "tags", u: "sam-lee", tags })).toBe("/admin/profile?u=sam-lee&done=badtags#notes");
    }
    expect(env.FEEDBACK.store.has(TAGS_KEY)).toBe(false);
    await admin.send({ op: "tags", u: "sam-lee", tags: "ready" });
    await admin.send({ op: "tags", u: "sam-lee", tags: "ready" });
    expect(valuesWith(env, "history:sam-lee:").flat()).toHaveLength(1);
    expect(cleanTags("")).toEqual([]);
  });

  it("puts a recruit's tags back into the index when the profile page opens", async () => {
    const { env, admin } = await setup();
    await admin.send({ op: "tags", u: "sam-lee", tags: "ready" });
    await putSealedJson(env, TAGS_KEY, { "jordan-patel": ["later"] });
    await admin.text("/admin/profile?u=sam-lee");
    expect(await tagIndex(env)).toEqual({ "jordan-patel": ["later"], "sam-lee": ["ready"] });
  });

  it("a recruiter sees no other pool's tags, even filtering by them", async () => {
    const { admin, casey } = await setup();
    await admin.send({ op: "tags", u: "jordan-patel", tags: "secret tag" });
    expect(await casey.text("/admin")).not.toContain("secret tag");
    const filtered = await casey.text("/admin?tag=secret%20tag");
    expect(filtered).not.toContain("Jordan Patel");
  });

  it("deleting a recruit drops their notes and their tags from the index", async () => {
    const { env, admin } = await setup();
    await admin.send({ op: "add", u: "sam-lee", note: "x" });
    await admin.send({ op: "tags", u: "sam-lee", tags: "ready" });
    await admin.send({ op: "tags", u: "jordan-patel", tags: "later" });
    expect(await admin.where({ action: "delete", u: "sam-lee", confirm: "yes" }, "/admin/action")).toBe("/admin?done=queued");
    expect(env.FEEDBACK.store.has(notesKey("sam-lee"))).toBe(false);
    expect(await tagIndex(env)).toEqual({ "jordan-patel": ["later"] });
    await purgeProfileEvents(env, "jordan-patel");
    expect(await tagIndex(env)).toEqual({});
  });
});

// Off-server copies of HermitShell's backups (maintenance.py), so losing the server doesn't lose them too. They live in
// their own instance ("backups") of the hub's Durable Object class, whose SQLite storage is on the free plan, as
// BACKUP_PART_BYTES rows (a row holds at most 2 MB). HermitShell uploads each backup part by part over the signed API
// (apiauth.js, so each part's bytes are covered by its signature), lists and deletes copies to rotate them, and reads
// parts back to restore. Admins can download a copy from BACKUPS_URL when the server itself is gone.
// Only encrypted backups are taken: the first part must start with hermes_common.SEALED (AES-256-GCM under
// HERMES_DATA_KEY, which never leaves the server), so Cloudflare holds nothing it can read. The whole file is checked
// on restore, by its SHA-256 and by AES-GCM itself.

import { SECURITY_HEADERS, esc, json, page, when } from "./lib.js";

export const BACKUPS_URL = "/admin/backups";
export const BACKUP_PART_BYTES = 1024 * 1024;
// 64 MB a backup, 40 backups and 1 GB in all, well inside the free plan's 5 GB of Durable Object storage.
export const MAX_BACKUP_PARTS = 64;
export const MAX_BACKUPS = 40;
export const MAX_VAULT_BYTES = 1024 ** 3;
// An upload that hasn't finished in a day is dropped.
const STALE_MS = 24 * 3600 * 1000;
export const BACKUP_NAME_RE = /^hermitshell-\d{8}-\d{6}\.tar\.gz\.enc$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const SEALED = new TextEncoder().encode("HSEAL1");
const VAULT = "backups";

// ------------------------------------------------------------------ inside the Durable Object

const answer = (body, status = 200) => Response.json(body, { status });
const first = (cursor) => cursor.toArray()[0] || {};
const whole = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : NaN;
};

function tables(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS backups (name TEXT PRIMARY KEY, parts INTEGER NOT NULL, sha TEXT NOT NULL, "
    + "size INTEGER NOT NULL DEFAULT 0, started INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0)");
  sql.exec("CREATE TABLE IF NOT EXISTS backup_parts (name TEXT NOT NULL, i INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (name, i))");
}

function drop(sql, name) {
  sql.exec("DELETE FROM backup_parts WHERE name = ?", name);
  return sql.exec("DELETE FROM backups WHERE name = ? RETURNING name", name).toArray().length > 0;
}

function sweep(sql, now) {
  for (const row of sql.exec("SELECT name FROM backups WHERE done = 0 AND started < ?", now - STALE_MS).toArray()) drop(sql, row.name);
}

const used = (sql) => Number(first(sql.exec("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM backup_parts")).n) || 0;

async function putPart(sql, request, url, name, now) {
  const [i, n, sha] = [whole(url.searchParams.get("i")), whole(url.searchParams.get("n")), url.searchParams.get("sha") || ""];
  if (!(n >= 1 && n <= MAX_BACKUP_PARTS && i >= 0 && i < n && SHA_RE.test(sha))) return answer({ error: "bad part" }, 400);
  const data = await request.arrayBuffer();
  if (!data.byteLength || data.byteLength > BACKUP_PART_BYTES || (i < n - 1 && data.byteLength !== BACKUP_PART_BYTES)) {
    return answer({ error: "bad part size" }, 400);
  }
  const head = new Uint8Array(data.slice(0, SEALED.length));
  if (i === 0 && (head.length < SEALED.length || !SEALED.every((b, k) => head[k] === b))) return answer({ error: "not encrypted" }, 400);
  sweep(sql, now);
  let row = first(sql.exec("SELECT parts, sha, done FROM backups WHERE name = ?", name));
  if (row.done) return row.sha === sha ? answer({ ok: true, done: true }) : answer({ error: "exists" }, 409);
  if (row.sha && (row.sha !== sha || Number(row.parts) !== n)) {
    drop(sql, name);
    row = {};
  }
  if (!row.sha) {
    const count = Number(first(sql.exec("SELECT COUNT(*) AS n FROM backups")).n) || 0;
    if (count >= MAX_BACKUPS || used(sql) + n * BACKUP_PART_BYTES > MAX_VAULT_BYTES) return answer({ error: "full" }, 507);
    sql.exec("INSERT INTO backups (name, parts, sha, started) VALUES (?, ?, ?, ?)", name, n, sha, now);
  }
  sql.exec("INSERT OR REPLACE INTO backup_parts (name, i, data) VALUES (?, ?, ?)", name, i, data);
  const have = first(sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS size FROM backup_parts WHERE name = ?", name));
  const done = Number(have.n) === n;
  if (done) sql.exec("UPDATE backups SET done = ?, size = ? WHERE name = ?", now, Number(have.size), name);
  return answer({ ok: true, done });
}

// The hub's /backup/* routes (hub.js); null storage (an older runtime) can't keep them.
export async function vault(sql, request, path, now = Date.now()) {
  if (!sql) return answer({ error: "unavailable" }, 503);
  tables(sql);
  const url = new URL(request.url);
  if (path === "/backup/list" && request.method === "GET") {
    sweep(sql, now);
    const rows = sql.exec("SELECT name, parts, sha, size, done FROM backups WHERE done > 0 ORDER BY name DESC").toArray();
    return answer({ backups: rows.map((r) => ({ name: r.name, parts: Number(r.parts), sha: r.sha, size: Number(r.size), at: Number(r.done) })),
      used: used(sql), limits: { part: BACKUP_PART_BYTES, parts: MAX_BACKUP_PARTS, backups: MAX_BACKUPS, bytes: MAX_VAULT_BYTES } });
  }
  const name = url.searchParams.get("name") || "";
  if (!BACKUP_NAME_RE.test(name)) return answer({ error: "bad name" }, 400);
  if (path === "/backup/put" && request.method === "POST") return putPart(sql, request, url, name, now);
  if (path === "/backup/get" && request.method === "GET") {
    const i = whole(url.searchParams.get("i"));
    const row = first(sql.exec("SELECT p.data AS data FROM backup_parts p JOIN backups b ON b.name = p.name WHERE p.name = ? AND p.i = ? AND b.done > 0", name, i));
    if (!row.data) return answer({ error: "not found" }, 404);
    return new Response(row.data, { headers: { "Content-Type": "application/octet-stream" } });
  }
  if (path === "/backup/delete" && request.method === "POST") return answer({ deleted: drop(sql, name) });
  return answer({ error: "not found" }, 404);
}

// ------------------------------------------------------------------ in the Worker

async function toVault(env, path, init) {
  if (!env.HUB) return json({ error: "backups need the HUB Durable Object binding" }, 503);
  try {
    return await env.HUB.get(env.HUB.idFromName(VAULT)).fetch(`https://hub${path}`, init);
  } catch (err) {
    console.error(`backups ${path.split("?")[0]}: ${err?.name || "Error"}`);
    return json({ error: "unavailable" }, 503);
  }
}

const query = (fields) => new URLSearchParams(fields).toString();

// HermitShell's backup calls, once apiauth.js has checked the token and signature:
//   GET  /api/backups                              the copies kept, newest first, and the space used
//   POST /api/backup/part?name=&i=&n=&sha=         one part (raw bytes; sha is the whole file's SHA-256)
//   GET  /api/backup/part?name=&i=                 one part back
//   POST /api/backup/delete  {"name": ...}         drops a copy
export async function backupApi(request, env, url) {
  const p = url.searchParams;
  if (url.pathname === "/api/backups" && request.method === "GET") return toVault(env, "/backup/list");
  if (url.pathname === "/api/backup/part" && request.method === "POST") {
    const body = await request.arrayBuffer();
    return toVault(env, `/backup/put?${query({ name: p.get("name") || "", i: p.get("i") || "", n: p.get("n") || "", sha: p.get("sha") || "" })}`,
      { method: "POST", body });
  }
  if (url.pathname === "/api/backup/part" && request.method === "GET") {
    return toVault(env, `/backup/get?${query({ name: p.get("name") || "", i: p.get("i") || "" })}`);
  }
  if (url.pathname === "/api/backup/delete" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    return toVault(env, `/backup/delete?${query({ name: typeof body?.name === "string" ? body.name : "" })}`, { method: "POST" });
  }
  return json({ error: "not found" }, 404);
}

// The copies kept, newest first; [] without the hub, or when it doesn't answer with a list (demo mode's stand-in).
export async function listBackups(env) {
  const res = await toVault(env, "/backup/list");
  const got = res.ok ? await res.json().catch(() => null) : null;
  const backups = Array.isArray(got?.backups) ? got.backups.filter((b) => BACKUP_NAME_RE.test(String(b?.name))
    && Number.isSafeInteger(b.parts) && b.parts > 0 && b.parts <= MAX_BACKUP_PARTS && Number.isSafeInteger(b.size)) : [];
  return { backups, used: Number.isSafeInteger(got?.used) ? got.used : 0 };
}

const size = (bytes) => (bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB`
  : bytes >= 2 ** 20 ? `${(bytes / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// One copy, streamed part by part so a large backup never sits whole in the Worker's memory.
function download(env, b) {
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (i >= b.parts) return controller.close();
      const res = await toVault(env, `/backup/get?${query({ name: b.name, i: String(i++) })}`);
      if (!res.ok) return controller.error(new Error("a part of this backup is missing"));
      controller.enqueue(new Uint8Array(await res.arrayBuffer()));
    },
  });
  return new Response(body, { headers: { ...SECURITY_HEADERS, "Content-Type": "application/octet-stream", "Content-Length": String(b.size),
    "Content-Disposition": `attachment; filename="${b.name}"`, "Cache-Control": "private, no-store" } });
}

// GET BACKUPS_URL: the copies on Cloudflare with a download for each; ?name= downloads one. Admins only (admin.js).
export async function backupsPage(request, env, timeZone) {
  const { backups, used: bytes } = await listBackups(env);
  const name = new URL(request.url).searchParams.get("name");
  if (name !== null) {
    const b = backups.find((x) => x.name === name);
    return b ? download(env, b) : page("Backup not found", `<p>That backup is no longer kept on Cloudflare. <a href="${BACKUPS_URL}">Back to backups</a></p>`, { status: 404 });
  }
  const rows = backups.map((b) => `<tr><td><b>${esc(when(b.at, timeZone))}</b><br><code class="small">${esc(b.name)}</code></td>
<td>${size(b.size).replace(" ", "&nbsp;")}</td><td><a class="small" href="${BACKUPS_URL}?name=${encodeURIComponent(b.name)}" download>Download</a></td></tr>`).join("");
  return page("Backups on Cloudflare", `<p>Each night&rsquo;s backup, and each <b>Back up now</b>, is also kept here, away from the server it
backs up. HermitShell encrypts it with <code>HERMES_DATA_KEY</code> before it leaves the server, so Cloudflare can&rsquo;t open it.</p>
${rows ? `<table class="list"><tr class="head"><th>Sent to Cloudflare</th><th>Size</th><th></th></tr>${rows}</table>
<p class="muted small">${backups.length} kept &middot; ${size(bytes)} of ${size(MAX_VAULT_BYTES)} used.</p>`
    : "<p class=\"muted\">No backups here yet. HermitShell sends each new backup once it and this Worker are both up to date; <b>Back up now</b> in the server panel sends one straight away.</p>"}
<h2>Restoring after losing the server</h2>
<p>Download a backup and copy it onto the new server. With the same <code>HERMES_DATA_KEY</code> in its <code>.env</code>, this unpacks
it into an empty folder (in Docker, run it with <code>docker exec hermitshell</code> in front):</p>
<pre><code>python3 maintenance.py --restore FILE --to DIR</code></pre>
<p>Without that key no one can open the backups, so keep a copy of it away from the server, in a password manager.
A server that still has its <code>.env</code> can fetch one itself with <code>python3 maintenance.py --fetch NAME</code>.</p>
<p><a href="/admin">Back to recruits</a></p>`);
}

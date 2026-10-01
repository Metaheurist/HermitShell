// Recruits' notes and tags: the profile page's Notes box, and tag pills on the recruits list with ?tag= to show
// only those tagged. Each recruit's are one value, "notes:<id>" = { tags, notes: [{ id, text, by, uid, at }] }, and
// every recruit's tags are one index, "tags" = { <id>: [tags] }, so the list costs a single read. Both are encrypted
// and bound to their KV key (vault.js), since notes and tag names can be personal ("visa"). Kept until the recruit
// unsubscribes or is deleted (purgeProfileEvents). Notes stay on the Worker: HermitShell never sees them.
//
// Two people changing tags at the same moment could each write the index without the other's change, so opening a
// profile page puts that recruit's tags back into the index when they differ. The index is only written when it
// changes.

import { TAGS_KEY, esc, notesKey, when } from "./lib.js";
import { getSealedJson, putSealedJson } from "./vault.js";

export const NOTES_URL = "/admin/notes";
export const MAX_TAGS = 8;
export const MAX_NOTES = 100;
export const MAX_NOTE = 1000;
export const TAG_RE = /^[a-z0-9][a-z0-9 -]{0,19}$/;
const ID_RE = /^[0-9a-f]{16}$/;
const MAX_BY = 80;

export const NOTES_DONE = {
  noted: "Note added.",
  unnoted: "Note deleted.",
  tagged: "Tags saved.",
  badtags: `Tags are up to 20 letters, numbers, spaces or dashes each, at most ${MAX_TAGS}, separated by commas.`,
  emptynote: "Write something in the note first.",
};

export const NOTES_STYLE = `
.tagpills{display:inline-flex;flex-wrap:wrap;gap:5px;margin-left:6px;vertical-align:middle}
.tagpill{display:inline-block;padding:2px 9px;border-radius:99px;background:var(--soft);color:var(--brand-ink);font-size:12px;
font-weight:650;text-decoration:none;line-height:18px}
a.tagpill:hover{filter:brightness(.96)}
.notelist{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:8px}
.notelist li{border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--field)}
.notelist .text{white-space:pre-wrap;overflow-wrap:anywhere}
.notelist .meta{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px}
.notelist form{margin:0}.notelist button{margin:0}
.tagfilter{display:flex;gap:8px;align-items:center;margin:6px 0 10px}
`;

export function cleanTags(raw) {
  const tags = String(raw ?? "").toLowerCase().split(",").map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  const unique = [...new Set(tags)];
  return unique.length <= MAX_TAGS && unique.every((t) => TAG_RE.test(t)) ? unique : null;
}

export function cleanNote(raw) {
  return String(raw ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").trim().slice(0, MAX_NOTE);
}

function validNote(n) {
  return n && typeof n === "object" && ID_RE.test(n.id) && typeof n.text === "string" && n.text && Number.isFinite(n.at);
}

// A recruit's notes and tags, dropping anything that doesn't look right.
export async function readNotes(env, u) {
  const got = await getSealedJson(env, notesKey(u));
  const tags = Array.isArray(got?.tags) ? got.tags.filter((t) => typeof t === "string" && TAG_RE.test(t)).slice(0, MAX_TAGS) : [];
  const notes = Array.isArray(got?.notes) ? got.notes.filter(validNote).slice(-MAX_NOTES) : [];
  return { tags, notes };
}

// Every recruit's tags, { <id>: [tags] }.
export async function tagIndex(env) {
  const got = await getSealedJson(env, TAGS_KEY);
  if (!got || typeof got !== "object" || Array.isArray(got)) return {};
  return Object.fromEntries(Object.entries(got).filter(([, tags]) => Array.isArray(tags))
    .map(([u, tags]) => [u, tags.filter((t) => typeof t === "string" && TAG_RE.test(t)).slice(0, MAX_TAGS)]));
}

// Puts a recruit's tags into the index, writing it only when they changed.
export async function indexTags(env, u, tags, index = null) {
  const all = index || await tagIndex(env);
  if (JSON.stringify(all[u] || []) === JSON.stringify(tags)) return false;
  if (tags.length) all[u] = tags;
  else delete all[u];
  await putSealedJson(env, TAGS_KEY, all);
  return true;
}

export function tagPills(tags, link = true) {
  if (!tags?.length) return "";
  return `<span class="tagpills">${tags.map((t) => link
    ? `<a class="tagpill" href="/admin?tag=${encodeURIComponent(t)}" title="Show recruits tagged ${esc(t)}">${esc(t)}</a>`
    : `<span class="tagpill">${esc(t)}</span>`).join("")}</span>`;
}

// The tag a list was filtered by, or "" when there is none (or it isn't a tag).
export function tagQuery(url) {
  const tag = String(url.searchParams.get("tag") || "").toLowerCase().trim();
  return TAG_RE.test(tag) ? tag : "";
}

export function tagFilter(tag, shown) {
  return tag ? `<div class="tagfilter"><span class="muted">${shown} tagged</span>${tagPills([tag], false)}<a class="small" href="/admin">Show everyone</a></div>` : "";
}

// The profile page's Notes box. Only admins and the note's writer see a Delete button.
export function notesSection(data, u, csrf, me, tz) {
  const fields = (extra) => `<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="u" value="${esc(u)}">${extra}`;
  const items = [...data.notes].reverse().map((n) => {
    const remove = me.admin || n.uid === me.id ? `<form method="post" action="${NOTES_URL}">${fields(`<input type="hidden" name="op" value="delete"><input type="hidden" name="id" value="${esc(n.id)}">`)}<button class="small quiet" aria-label="Delete this note">Delete</button></form>` : "";
    return `<li><div class="text">${esc(n.text)}</div><div class="meta"><span class="muted">${esc(n.by || "Someone")}, ${esc(when(n.at, tz))}</span>${remove}</div></li>`;
  }).join("");
  return `<h2 id="notes">Notes</h2>
<p class="muted">For you and the other recruiters: notes and tags are kept encrypted on the dashboard, never sent to HermitShell or the recruit.</p>
<form method="post" action="${NOTES_URL}">${fields('<input type="hidden" name="op" value="tags">')}
<label for="tags">Tags</label><input id="tags" name="tags" value="${esc(data.tags.join(", "))}" maxlength="200" placeholder="shortlist, needs visa" autocomplete="off">
<span class="hint">Separated by commas, up to ${MAX_TAGS}. They show on the recruits list, and pressing one lists everyone with it.</span>
<button class="small">Save tags</button></form>
<form method="post" action="${NOTES_URL}">${fields('<input type="hidden" name="op" value="add">')}
<label for="note">Add a note</label><textarea id="note" name="note" maxlength="${MAX_NOTE}" placeholder="Spoke on the phone: open to contract roles"></textarea>
<button class="small">Add note</button></form>
${items ? `<ul class="notelist">${items}</ul>` : '<p class="muted">No notes yet.</p>'}`;
}

function noteId() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// One change from the Notes box: { done, history } where history is what the recruit's history should say ("" for
// nothing). The caller has checked the form's CSRF token and that the user may see the recruit.
export async function changeNotes(env, u, form, me, by) {
  const op = String(form.get("op") || "");
  const data = await readNotes(env, u);
  if (op === "add") {
    const text = cleanNote(form.get("note"));
    if (!text) return { done: "emptynote", history: "" };
    data.notes = [...data.notes, { id: noteId(), text, by: String(by || "").slice(0, MAX_BY), uid: me.id, at: Date.now() }].slice(-MAX_NOTES);
    await putSealedJson(env, notesKey(u), data);
    return { done: "noted", history: "Added a note" };
  }
  if (op === "delete") {
    const id = String(form.get("id") || "");
    const found = data.notes.find((n) => n.id === id);
    if (!found || !(me.admin || found.uid === me.id)) return { done: "unnoted", history: "" };
    data.notes = data.notes.filter((n) => n.id !== id);
    await putSealedJson(env, notesKey(u), data);
    return { done: "unnoted", history: "Deleted a note" };
  }
  if (op === "tags") {
    const tags = cleanTags(form.get("tags"));
    if (!tags) return { done: "badtags", history: "" };
    const same = JSON.stringify(tags) === JSON.stringify(data.tags);
    if (!same) {
      data.tags = tags;
      await putSealedJson(env, notesKey(u), data);
    }
    await indexTags(env, u, tags);
    return { done: "tagged", history: same ? "" : "Changed their tags" };
  }
  return { done: "", history: "" };
}

// Dashboard users and their roles (/admin/users). The main admin signs in with ADMIN_USER and the ADMIN_PASSWORD
// secret; everyone else has an account made here: a name, a username, roles, and a password kept only as a salted
// PBKDF2-SHA256 hash of an HMAC of it under JOB_FEEDBACK_SECRET, so the KV value alone cannot be guessed against.
// The iteration count is stored with each hash (the free plan allows about 10 ms of CPU a request). Everything is
// in one KV key ("accounts"), so a signed-in request costs one read.
//
// Roles: an admin sees and changes everything; a recruiter sees only their own pool, the recruits they invited or
// were assigned (profiles.py keeps the assignment, as "recruiter" on the profile). The main admin can be a
// recruiter too. Changing a user's password or deleting them changes or drops the version their sessions are
// signed with, which signs them out at once. An admin resets anyone else's password from Users and roles; every
// user changes their own from the Recruits page with their current password (five wrong ones lock that for 15
// minutes). The main admin's password is the ADMIN_PASSWORD secret, so it is changed with wrangler.

import { CONFIRM_STYLE, binButton, deleteModal, iconButton } from "./confirm.js";
import { record } from "./history.js";
import { queueItem } from "./join.js";
import { esc, hmacHex, newId, note, page, redirect, when } from "./lib.js";
import { MODAL_STYLE } from "./keys.js";
import { USERS_URL, nav } from "./settings.js";

export const ADMIN_ID = "admin";
export const ROLES = {
  admin: {
    label: "Admin",
    about: "Everything: every recruit, assigning recruits to recruiters, users and roles, global settings and deleting recruits.",
  },
  recruiter: {
    label: "Recruiter",
    about: "Their own pool: the people they invite and the recruits assigned to them. They manage those recruits' details, CVs and daily reports, send jobs now and see their stats and jobs sent, but never see anyone else or the settings.",
  },
};
export const USER_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const ACCOUNTS_KEY = "accounts";
const MAX_USERS = 50;
const ITERATIONS = 30000;
const MIN_PASSWORD = 3;
const STRONG_PASSWORD = 12;
const MAX_PASSWORD = 200;
const MAX_WRONG_PASSWORDS = 5;
const WRONG_PASSWORD_SECONDS = 15 * 60;
export const PASSWORD_URL = "/admin/password";
const RESERVED = new Set([ADMIN_ID, "owner", "root", "system"]);
const encoder = new TextEncoder();

function roleList(value, admin = false) {
  const roles = Object.keys(ROLES).filter((r) => (Array.isArray(value) ? value : []).includes(r));
  return admin ? ["admin", ...roles.filter((r) => r !== "admin")] : roles;
}

function validUser(u) {
  return u && typeof u === "object" && USER_RE.test(u.id || "") && !RESERVED.has(u.id) && typeof u.hash === "string"
    && typeof u.salt === "string" && roleList(u.roles).length > 0;
}

export async function accounts(env) {
  const stored = await env.FEEDBACK.get(ACCOUNTS_KEY, "json");
  return {
    admin: { roles: roleList(stored?.admin?.roles, true) },
    users: (Array.isArray(stored?.users) ? stored.users : []).filter(validUser)
      .map((u) => ({ ...u, roles: roleList(u.roles) })).slice(0, MAX_USERS),
  };
}

async function saveAccounts(env, acc) {
  await env.FEEDBACK.put(ACCOUNTS_KEY, JSON.stringify({ admin: acc.admin, users: acc.users }));
}

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text) => new Uint8Array((String(text).match(/../g) || []).map((b) => parseInt(b, 16)));

export async function hashPassword(env, password, salt = hex(crypto.getRandomValues(new Uint8Array(16))), iter = ITERATIONS) {
  const peppered = await hmacHex(env.JOB_FEEDBACK_SECRET, `dashboard-password\n${password}`);
  const key = await crypto.subtle.importKey("raw", encoder.encode(peppered), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(salt), iterations: iter }, key, 256);
  return { salt, hash: hex(bits), iter };
}

// The user whose username and password these are, or null. A hash is worked out even for an unknown username,
// so the time taken does not say whether the account exists.
export async function checkUser(env, acc, username, password) {
  const user = acc.users.find((u) => u.id === String(username || "").trim().toLowerCase());
  const { hash } = await hashPassword(env, String(password ?? ""), user?.salt || "00".repeat(16), user?.iter || ITERATIONS);
  if (!user) return null;
  let diff = hash.length ^ user.hash.length;
  for (let i = 0; i < Math.min(hash.length, user.hash.length); i++) diff |= hash.charCodeAt(i) ^ user.hash.charCodeAt(i);
  return diff === 0 ? user : null;
}

// Who is signed in, as the rest of the dashboard sees them.
export function signedIn(id, acc) {
  if (id === ADMIN_ID) return { id, main: true, roles: acc.admin.roles, admin: true, recruiter: acc.admin.roles.includes("recruiter") };
  const user = acc.users.find((u) => u.id === id);
  return user ? { id, name: user.name, roles: user.roles, admin: user.roles.includes("admin"), recruiter: user.roles.includes("recruiter") } : null;
}

export function adminName(status) {
  return (status.profiles || []).find((p) => p.owner)?.name || "Admin";
}

export function displayName(me, status) {
  return me.main ? adminName(status) : me.name || me.id;
}

// Everyone who can have recruits: the main admin when they have the recruiter role, and recruiter accounts.
export function recruiters(acc, status, env) {
  return [
    ...(acc.admin.roles.includes("recruiter") ? [{ id: ADMIN_ID, name: adminName(status), username: env.ADMIN_USER || "admin" }] : []),
    ...acc.users.filter((u) => u.roles.includes("recruiter")).map((u) => ({ id: u.id, name: u.name, username: u.id })),
  ];
}

// A recruit's recruiter: an assignment still waiting for HermitShell wins over the one it last reported.
export function recruiterOf(p, queue = []) {
  const waiting = queue.filter((i) => i.type === "admin" && i.action === "assign" && i.u === p.id)
    .sort((a, b) => String(a.id).localeCompare(String(b.id))).at(-1);
  return String(waiting ? waiting.recruiter || "" : p.recruiter || "");
}

// Admins see every recruit; a recruiter sees only their own. The main admin's row is staff, not a recruit, so
// nobody sees it as one.
export function canSee(me, p, queue = []) {
  return Boolean(p && !p.owner && (me.admin || recruiterOf(p, queue) === me.id));
}

export function initials(name) {
  const words = String(name || "").replace(/<[^>]*>/g, " ").match(/\p{L}[\p{L}'-]*/gu) || [];
  return (words.length > 1 ? words[0][0] + words.at(-1)[0] : (words[0] || "?").slice(0, 2)).toUpperCase();
}

// ------------------------------------------------------------------------- the Users and roles page

const USER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.8 3.3-5.5 6.5-5.5s5.7 1.7 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.7.8 2.7 2.5 3 5.2"/></svg>';
const ROLE_ICONS = {
  admin: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  recruiter: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.8 3.3-5.5 6.5-5.5 1.3 0 2.5.3 3.5.8M19 14v6M16 17h6"/>',
};

const EDIT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.2 6.8a2.8 2.8 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8L2 21.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z"/><path d="m15 5 4 4"/></svg>';
export const KEY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M16.5 6.5l3 3M14 9l2.5 2.5"/></svg>';

function roleIcon(role) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ROLE_ICONS[role]}</svg>`;
}

function pills(roles) {
  return roles.map((r) => `<span class="role ${r}">${esc(ROLES[r].label)}</span>`).join(" ");
}

function hidden(fields) {
  return Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");
}

function roleBoxes(prefix, roles, { lockAdmin = false } = {}) {
  return `<div class="checks">${Object.entries(ROLES).map(([r, info]) => {
    const locked = lockAdmin && r === "admin";
    return `<label class="check"><input type="checkbox" name="roles" value="${r}"${roles.includes(r) ? " checked" : ""}${locked ? " disabled" : ""} id="${prefix}-${r}"> <span>${esc(info.label)}</span></label>`;
  }).join("")}</div>`;
}

function modal(id, title, intro, body, icon = USER_ICON) {
  return `<div class="modal" id="${id}" role="dialog" aria-modal="true" aria-labelledby="${id}-h">
<a class="scrim" href="#_" aria-label="Close" tabindex="-1"></a>
<div class="sheet"><a class="x" href="#_" aria-label="Close">&times;</a><div class="sheeticon">${icon}</div>
<h2 id="${id}-h">${esc(title)}</h2><p class="muted">${esc(intro)}</p>${body}</div></div>`;
}

// A new password typed twice. A hidden username lets password managers save the new one under the right account.
function newPasswordFields(prefix, username = "") {
  return `${username ? `<input type="text" name="username" value="${esc(username)}" autocomplete="username" hidden readonly>` : ""}
<label for="${prefix}-pass">New password</label><input id="${prefix}-pass" name="password" type="password" required minlength="${MIN_PASSWORD}" maxlength="${MAX_PASSWORD}" autocomplete="new-password">
<label for="${prefix}-again">New password again</label><input id="${prefix}-again" name="again" type="password" required minlength="${MIN_PASSWORD}" maxlength="${MAX_PASSWORD}" autocomplete="new-password">
<span class="hint">At least ${STRONG_PASSWORD} characters is best.</span>`;
}

// The Change password window on the Recruits page (the key button at the top right of every page opens it).
export function passwordModal(me, csrf, env) {
  if (me.main) {
    return modal("password", "Change password", "Your password is the Worker's ADMIN_PASSWORD secret, so it can't be changed here.",
      `<p>From the <code>feedback-worker</code> folder, run this and type the new password when it asks:</p>
<code class="link">npx wrangler secret put ADMIN_PASSWORD</code>
<p class="muted">That signs everyone out, you and every dashboard user. Your username, ${esc(env.ADMIN_USER || "admin")}, is the ADMIN_USER secret.</p>`, KEY_ICON);
  }
  return modal("password", "Change password", "You stay signed in here; everywhere else you are signed out.",
    `<form method="post" action="${PASSWORD_URL}">${hidden({ csrf })}
<label for="pw-now">Current password</label><input id="pw-now" name="current" type="password" required maxlength="${MAX_PASSWORD}" autocomplete="current-password">
${newPasswordFields("pw", me.id)}<button>Change password</button></form>`, KEY_ICON);
}

// Why a new password (typed twice) can't be used, or "".
function passwordProblem(password, again) {
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return "badpass";
  return password === again ? "" : "mismatch";
}

async function newPassword(env, password) {
  return { ...(await hashPassword(env, password)), v: newId().slice(0, 16), weak: password.length < STRONG_PASSWORD };
}

// POST /admin/password (CSRF already checked by the caller): the signed-in user changes their own password.
// Returns { done } for the Recruits page and, when it changed, the user's new session version.
export async function changeOwnPassword(env, form, me) {
  if (me.main) return { done: "mainpass" };
  const lockKey = `pwlock:${me.id}`;
  const wrong = Number(await env.FEEDBACK.get(lockKey)) || 0;
  if (wrong >= MAX_WRONG_PASSWORDS) return { done: "pwlocked" };
  const acc = await accounts(env);
  const user = await checkUser(env, acc, me.id, String(form.get("current") || "").slice(0, MAX_PASSWORD));
  if (!user) {
    try {
      await env.FEEDBACK.put(lockKey, String(wrong + 1), { expirationTtl: WRONG_PASSWORD_SECONDS });
    } catch {
      return { done: "pwlocked" };
    }
    return { done: "badcurrent" };
  }
  const password = String(form.get("password") || "");
  const problem = passwordProblem(password, String(form.get("again") || ""));
  if (problem) return { done: problem };
  Object.assign(user, await newPassword(env, password));
  await saveAccounts(env, acc);
  await env.FEEDBACK.delete(lockKey);
  return { done: "password", v: user.v };
}

function userModals(acc, csrf, adminLabel, me) {
  const add = modal("user-new", "Add a user", "They sign in at /admin with this username and password.",
    `<form method="post" action="${USERS_URL}">${hidden({ csrf, op: "add" })}
<label for="un-name">Name</label><input id="un-name" name="name" required maxlength="80" autocomplete="off" placeholder="Riley Chen">
<label for="un-user">Username</label><input id="un-user" name="username" required minlength="2" maxlength="32" pattern="[a-z0-9][a-z0-9_\\-]{1,31}" autocomplete="off" placeholder="riley">
<span class="hint">Lower-case letters, numbers, - and _.</span>
<label for="un-pass">Password</label><input id="un-pass" name="password" type="password" required minlength="${MIN_PASSWORD}" maxlength="200" autocomplete="new-password">
<span class="hint">At least ${STRONG_PASSWORD} characters is best; shorter ones are marked on the list.</span>
<label>Roles</label>${roleBoxes("un", ["recruiter"])}<button>Add user</button></form>`);
  const main = modal(`user-${ADMIN_ID}`, adminLabel, "The main admin signs in with the ADMIN_USER and ADMIN_PASSWORD secrets and always has the Admin role.",
    `<form method="post" action="${USERS_URL}">${hidden({ csrf, op: "admin_roles" })}
<label>Roles</label>${roleBoxes("ua", acc.admin.roles, { lockAdmin: true })}<button>Save roles</button></form>`);
  const edits = acc.users.map((u) => modal(`user-${u.id}`, u.name, `Username ${u.id}.`,
    `<form method="post" action="${USERS_URL}">${hidden({ csrf, op: "edit", id: u.id })}
<label for="ue-${u.id}-name">Name</label><input id="ue-${u.id}-name" name="name" required maxlength="80" value="${esc(u.name)}" autocomplete="off">
<label>Roles</label>${roleBoxes(`ue-${u.id}`, u.roles)}
<button>Save changes</button></form>`)).join("");
  const resets = acc.users.filter((u) => u.id !== me.id).map((u) => modal(`reset-${u.id}`, `Reset ${u.name}'s password`,
    "They are signed out everywhere at once and sign in with the new password. It isn't sent to them, so tell them yourself.",
    `<form method="post" action="${USERS_URL}">${hidden({ csrf, op: "reset", id: u.id })}
${newPasswordFields(`ur-${u.id}`)}<button>Reset password</button></form>`, KEY_ICON)).join("");
  return add + main + edits + resets;
}

function userRow(u, count, me, csrf, tz) {
  const self = u.id === me.id;
  const remove = self || u.main ? "" : binButton(`deluser-${u.id}`, `Delete ${u.name}`);
  const password = self ? iconButton("/admin#password", "Change your password", KEY_ICON, "key")
    : u.main ? "" : iconButton(`#reset-${u.id}`, `Reset ${u.name}'s password`, KEY_ICON, "key");
  const weak = u.weak ? ' <span class="role weak" title="Shorter than the recommended length">short password</span>' : "";
  return `<tr><td><div class="who"><span class="avatar${u.roles.includes("recruiter") ? " rec" : ""}" aria-hidden="true">${esc(initials(u.name))}</span><div>
<b>${esc(u.name)}</b>${self ? ' <span class="muted">(you)</span>' : ""}<div class="muted"><code>${esc(u.username)}</code></div>
<div class="muted">${u.main ? "main admin, from the Worker's secrets" : `since ${esc(when(u.created, tz))}`}</div></div></div></td>
<td>${pills(u.roles)}${weak}</td>
<td>${u.roles.includes("recruiter") ? `<b>${count}</b> <span class="muted">recruit${count === 1 ? "" : "s"}</span>` : '<span class="muted">not a recruiter</span>'}</td>
<td><div class="actions iconrow">${iconButton(`#user-${u.id}`, `Edit ${u.name}`, EDIT_ICON, "edit")}${password}${remove}</div></td></tr>`;
}

function deleteUserModal(u, csrf) {
  return deleteModal({ id: `deluser-${u.id}`, title: `Delete ${u.name}?`, action: USERS_URL,
    intro: "They are signed out at once, their unused invites are deleted and their recruits become unassigned.",
    fields: { csrf, op: "delete", id: u.id }, check: `Delete ${u.name}'s dashboard account` });
}

export const USERS_DONE = {
  added: "User added. They can sign in now.",
  updated: "Saved.",
  reset: "Password reset. They have been signed out everywhere; give them the new password.",
  deleted: "User deleted and signed out. Their recruits are now unassigned.",
  baduser: "Give the user a name and a username of 2 to 32 lower-case letters, numbers, - or _.",
  taken: "That username is already used.",
  badpass: `Passwords need at least ${MIN_PASSWORD} characters.`,
  mismatch: "The two new passwords were different, so nothing changed.",
  badroles: "Pick at least one role.",
  self: "You can't delete or demote the account you are signed in with.",
  ownpass: "Change your own password with the key button at the top right.",
  confirmuser: "Tick the box to delete the user.",
  full: `There can be at most ${MAX_USERS} users.`,
};

export function usersPage(acc, status, csrf, me, env, done = "") {
  const profiles = status.profiles || [];
  const count = (id) => profiles.filter((p) => !p.owner && String(p.recruiter || "") === id).length;
  const main = { id: ADMIN_ID, main: true, name: adminName(status), username: env.ADMIN_USER || "admin", roles: acc.admin.roles };
  const rows = [main, ...acc.users.map((u) => ({ ...u, username: u.id }))]
    .map((u) => userRow(u, count(u.id), me, csrf, status.timezone)).join("");
  const roles = Object.entries(ROLES).map(([r, info]) => `<div class="rolecard ${r}"><span class="roleicon">${roleIcon(r)}</span>
<div><b>${esc(info.label)}</b><p class="muted">${esc(info.about)}</p></div></div>`).join("");
  const deletes = acc.users.filter((u) => u.id !== me.id).map((u) => deleteUserModal(u, csrf)).join("");
  return page("Users and roles", `<style>${MODAL_STYLE}${CONFIRM_STYLE}${USERS_STYLE}</style>${nav("users")}${done ? note(done) : ""}
<h2>Roles</h2><div class="rolecards">${roles}</div>
<div class="tabletools"><h2 style="margin:0">Dashboard users</h2><a class="addkey" href="#user-new">${USER_ICON}Add user</a></div>
<table class="list stack"><tr class="head"><th>User</th><th>Roles</th><th>Recruits</th><th></th></tr>${rows}</table>`,
  { wide: "full", before: userModals(acc, csrf, `${main.name} (main admin)`, me) + deletes });
}

// POST /admin/users (admins only, CSRF already checked by the caller).
export async function userAction(env, form, me, status, queue) {
  const acc = await accounts(env);
  const op = String(form.get("op") || "");
  const back = (done) => redirect(`${USERS_URL}?done=${done}`);
  const roles = roleList(form.getAll("roles"));
  const name = String(form.get("name") || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const password = String(form.get("password") || "");
  if (op === "admin_roles") {
    acc.admin.roles = roleList(roles, true);
    await saveAccounts(env, acc);
    return back("updated");
  }
  if (op === "add") {
    const id = String(form.get("username") || "").trim().toLowerCase();
    if (!name || !USER_RE.test(id)) return back("baduser");
    if (RESERVED.has(id) || id === String(env.ADMIN_USER || "admin").toLowerCase() || acc.users.some((u) => u.id === id)) return back("taken");
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return back("badpass");
    if (!roles.length) return back("badroles");
    if (acc.users.length >= MAX_USERS) return back("full");
    acc.users.push({ id, name, roles, ...(await newPassword(env, password)), created: Date.now() });
    await saveAccounts(env, acc);
    return back("added");
  }
  const user = acc.users.find((u) => u.id === String(form.get("id") || ""));
  if (!user) return back("baduser");
  if (op === "edit") {
    if (!name) return back("baduser");
    if (!roles.length) return back("badroles");
    if (user.id === me.id && !roles.includes("admin")) return back("self");
    Object.assign(user, { name, roles });
    await saveAccounts(env, acc);
    return back("updated");
  }
  if (op === "reset") {
    if (user.id === me.id) return back("ownpass");
    const problem = passwordProblem(password, String(form.get("again") || ""));
    if (problem) return back(problem);
    Object.assign(user, await newPassword(env, password));
    await saveAccounts(env, acc);
    await env.FEEDBACK.delete(`pwlock:${user.id}`);
    return back("reset");
  }
  if (op === "delete") {
    if (user.id === me.id) return back("self");
    if (form.get("confirm") !== "yes") return back("confirmuser");
    acc.users = acc.users.filter((u) => u.id !== user.id);
    await saveAccounts(env, acc);
    for (const p of (status.profiles || []).filter((x) => !x.owner && recruiterOf(x, queue) === user.id)) {
      await queueItem(env, { type: "admin", action: "assign", u: p.id, recruiter: "" });
      await record(env, p.id, "assign", `Unassigned: their recruiter ${user.name}'s account was deleted`, { by: displayName(me, status) });
    }
    const invites = await env.FEEDBACK.list({ prefix: "invite:", limit: 100 });
    const theirs = (await Promise.all(invites.keys.map((k) => env.FEEDBACK.get(k.name, "json"))))
      .filter((i) => i?.recruiter === user.id);
    await Promise.all(theirs.map((i) => env.FEEDBACK.delete(`invite:${i.id}`)));
    return back("deleted");
  }
  return back("baduser");
}

// Signing out: the main admin's sessions share an epoch; a user's are signed with their own version.
export async function signOutUser(env, id) {
  const acc = await accounts(env);
  const user = acc.users.find((u) => u.id === id);
  if (!user) return;
  user.v = newId().slice(0, 16);
  await saveAccounts(env, acc);
}

export const USERS_STYLE = `
.rolecards{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0 6px}
.rolecard{display:flex;gap:12px;padding:16px;border:1px solid var(--line);border-radius:16px;background:#fff}
.rolecard p{margin:4px 0 0;font-size:13.5px;line-height:1.5}
.roleicon{flex:none;width:38px;height:38px;border-radius:12px;display:grid;place-items:center;color:#fff}
.roleicon svg{width:20px;height:20px}
.rolecard.admin .roleicon{background:linear-gradient(135deg,var(--brand),var(--brand2));box-shadow:0 6px 14px -8px rgba(99,102,241,.9)}
.rolecard.recruiter .roleicon{background:linear-gradient(135deg,#2dd4bf,#0891b2);box-shadow:0 6px 14px -8px rgba(8,145,178,.9)}
.role{display:inline-block;font-size:11.5px;font-weight:650;border-radius:99px;padding:2px 9px;margin:2px 0}
.role.admin{color:var(--brand-ink);background:var(--soft)}.role.recruiter{color:#0e7490;background:#ecfeff}
.role.weak{color:#b45309;background:#fffbeb}
.avatar.rec{background:linear-gradient(135deg,#2dd4bf,#0891b2);box-shadow:0 6px 14px -8px rgba(8,145,178,.9)}
.addkey svg{width:16px;height:16px}

@media (max-width:640px){.rolecards{grid-template-columns:1fr}}
`;

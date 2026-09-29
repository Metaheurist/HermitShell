// Invite-only sign-up: /join?i=<invite id> shows a form for a new profile with a CV upload.
// The answers and the CV wait in KV until Hermes collects them from /api/queue.

import { esc, newId, page } from "./lib.js";

export const INVITE_DAYS = 7;
export const QUEUE_TTL_SECONDS = 60 * 60 * 24 * 30;
export const MAX_CV_BYTES = 5 * 1024 * 1024;
const MAX_CV_TEXT = 20000;
const CV_TYPES = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain", md: "text/markdown" };
const EXPIRED = ["Invite not valid", "<p>This invite link has expired or has already been used. Ask for a new one.</p>", { status: 410 }];

export async function queueItem(env, item) {
  const id = `queue:${Date.now()}:${newId()}`;
  await env.FEEDBACK.put(id, JSON.stringify({ id, at: Date.now(), ...item }), { expirationTtl: QUEUE_TTL_SECONDS });
  await env.FEEDBACK.put("flag:queue", "1", { expirationTtl: QUEUE_TTL_SECONDS });
  return id;
}

export async function createInvite(env, note = "") {
  const id = newId();
  const invite = { id, note: String(note).slice(0, 80), created: Date.now(), expires: Date.now() + INVITE_DAYS * 86400000 };
  await env.FEEDBACK.put(`invite:${id}`, JSON.stringify(invite), { expirationTtl: INVITE_DAYS * 86400 });
  return invite;
}

async function openInvite(env, id) {
  if (!/^[0-9a-f]{32}$/.test(id || "")) return null;
  const invite = await env.FEEDBACK.get(`invite:${id}`, "json");
  return invite && invite.expires > Date.now() ? invite : null;
}

function field(form, name, max) {
  return String(form.get(name) ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

function cvKind(file, bytes) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!CV_TYPES[ext]) return null;
  const head = new Uint8Array(bytes.slice(0, 4));
  if (ext === "pdf" && String.fromCharCode(...head) !== "%PDF") return null;
  if (ext === "docx" && !(head[0] === 0x50 && head[1] === 0x4b)) return null;
  return ext;
}

function form(inviteId, values = {}, error = "") {
  const v = (k) => esc(values[k] || "");
  return page("Join the Daily Vacancy Report", `${error ? `<p style="color:#b91c1c">${esc(error)}</p>` : ""}
<p>Hermes checks job boards every day and emails you the roles that match your CV, with a fit score and the skills each one asks for.</p>
<form method="post" action="/join" enctype="multipart/form-data">
<input type="hidden" name="i" value="${esc(inviteId)}">
<label for="name">Full name</label><input id="name" name="name" required maxlength="80" value="${v("name")}" autocomplete="name">
<label for="email">Email for your reports</label><input id="email" name="email" type="email" required maxlength="120" value="${v("email")}" autocomplete="email">
<label for="phone">Phone (optional, shown on cover letters)</label><input id="phone" name="phone" maxlength="40" value="${v("phone")}" autocomplete="tel">
<label for="location">Where you live (optional)</label><input id="location" name="location" maxlength="80" value="${v("location")}" placeholder="For example: Belfast">
<label for="roles">Roles you are looking for</label><textarea id="roles" name="roles" required maxlength="300" placeholder="For example: data analyst or BI developer, hybrid or remote">${v("roles")}</textarea>
<label for="cv">Your CV (PDF, Word .docx or text, up to 5 MB)</label><input id="cv" name="cv" type="file" accept=".pdf,.docx,.txt,.md">
<label for="cv_text">Or paste your CV (used if the file cannot be read)</label><textarea id="cv_text" name="cv_text" maxlength="${MAX_CV_TEXT}">${v("cv_text")}</textarea>
<label class="check"><input type="checkbox" name="consent" value="yes" required> <span>I agree that Hermes keeps my CV and details on its server to match jobs for me. Every report has an unsubscribe link that deletes them.</span></label>
<button type="submit">Create my profile</button></form>`);
}

export async function handleJoin(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const invite = await openInvite(env, url.searchParams.get("i"));
    return invite ? form(invite.id) : page(...EXPIRED);
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });

  const data = await request.formData();
  const invite = await openInvite(env, String(data.get("i") || ""));
  if (!invite) return page(...EXPIRED);
  const values = Object.fromEntries(["name", "email", "phone", "location", "roles"].map((k) => [k, field(data, k, 300)]));
  values.name = values.name.slice(0, 80);
  values.email = values.email.slice(0, 120);
  values.cv_text = field(data, "cv_text", MAX_CV_TEXT);
  const retry = (message) => form(invite.id, values, message);
  if (!values.name || !values.roles) return retry("Please fill in your name and the roles you are looking for.");
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(values.email)) return retry("Please enter a valid email address.");
  if (data.get("consent") !== "yes") return retry("Please tick the box to agree to Hermes keeping your CV.");

  const file = data.get("cv");
  let cv = null;
  if (file && typeof file === "object" && file.size) {
    if (file.size > MAX_CV_BYTES) return retry("The CV file is larger than 5 MB.");
    const bytes = await file.arrayBuffer();
    const kind = cvKind(file, bytes);
    if (!kind) return retry("The CV must be a PDF, a Word .docx file or a text file.");
    cv = { key: `cvfile:${newId()}`, kind, name: file.name.slice(0, 120), size: file.size };
    await env.FEEDBACK.put(cv.key, bytes, { expirationTtl: QUEUE_TTL_SECONDS });
  }
  if (!cv && values.cv_text.length < 200) return retry("Please upload your CV or paste it (at least a few lines).");

  await queueItem(env, { type: "signup", invite: invite.id, note: invite.note, ...values, cv });
  await env.FEEDBACK.delete(`invite:${invite.id}`);
  return page("Thanks, you're in", `<p>Thanks ${esc(values.name)}. Hermes is setting up your profile from your CV and will email
${esc(values.email)} when it is ready. Your first report arrives with the next daily run.</p><p>You can close this tab.</p>`);
}

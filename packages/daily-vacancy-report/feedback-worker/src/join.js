// Invite-only sign-up: /join?i=<invite id> shows a form for a new profile with a CV upload.
// The answers and the CV wait in KV until HermitShell collects them from /api/queue.

import { esc, limitedForm, newId, page, setFlag, text } from "./lib.js";

export const INVITE_DAYS = 7;
export const QUEUE_TTL_SECONDS = 60 * 60 * 24 * 30;
// Queue items carrying passwords or API keys expire sooner if HermitShell never collects them.
export const SECRET_TTL_SECONDS = 60 * 60 * 24 * 2;
export const MAX_CV_BYTES = 5 * 1024 * 1024;
const MAX_FORM_BYTES = MAX_CV_BYTES + 256 * 1024;
const MAX_CV_TEXT = 20000;
const MAX_ZIP_ENTRIES = 500;
const CV_TYPES = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain", md: "text/markdown" };
const EXPIRED = ["Invite not valid", "<p>This invite link has expired or has already been used. Ask for a new one.</p>", { status: 410 }];

export async function queueItem(env, item, ttl = QUEUE_TTL_SECONDS) {
  const id = `queue:${Date.now()}:${newId()}`;
  await env.FEEDBACK.put(id, JSON.stringify({ id, at: Date.now(), ...item }), { expirationTtl: ttl });
  await setFlag(env, "flag:queue", QUEUE_TTL_SECONDS);
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

// A .docx is a zip: it must list word/document.xml in its central directory and not hold thousands of parts.
function plausibleDocx(data) {
  const tail = data.subarray(Math.max(0, data.length - 256 * 1024));
  const latin = new TextDecoder("latin1").decode(tail);
  const entries = latin.split("PK\u0001\u0002").length - 1;
  return entries > 0 && entries <= MAX_ZIP_ENTRIES && latin.includes("word/document.xml");
}

function plainText(data) {
  try {
    return !new TextDecoder("utf-8", { fatal: true }).decode(data).includes("\u0000");
  } catch {
    return false;
  }
}

export function cvKind(file, bytes) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!CV_TYPES[ext]) return null;
  const data = new Uint8Array(bytes);
  if (ext === "pdf" && String.fromCharCode(...data.subarray(0, 4)) !== "%PDF") return null;
  if (ext === "docx" && !(data[0] === 0x50 && data[1] === 0x4b && plausibleDocx(data))) return null;
  if ((ext === "txt" || ext === "md") && !plainText(data)) return null;
  return ext;
}

function form(inviteId, values = {}, error = "") {
  const v = (k) => esc(values[k] || "");
  return page("Join HermitShell", `${error ? `<p style="color:#b91c1c">${esc(error)}</p>` : ""}
<p>HermitShell checks job boards every day and emails you the roles that match your CV, with a fit score and the skills each one asks for.</p>
<form method="post" action="/join?i=${esc(inviteId)}" enctype="multipart/form-data">
<input type="hidden" name="i" value="${esc(inviteId)}">
<label for="name">Full name</label><input id="name" name="name" required maxlength="80" value="${v("name")}" autocomplete="name">
<label for="email">Email for your reports</label><input id="email" name="email" type="email" required maxlength="120" value="${v("email")}" autocomplete="email">
<label for="phone">Phone (optional, shown on cover letters)</label><input id="phone" name="phone" maxlength="40" value="${v("phone")}" autocomplete="tel">
<label for="location">Where you live (optional)</label><input id="location" name="location" maxlength="80" value="${v("location")}" placeholder="For example: Belfast">
<label for="roles">Roles you are looking for</label><textarea id="roles" name="roles" required maxlength="300" placeholder="For example: data analyst or BI developer, hybrid or remote">${v("roles")}</textarea>
<label for="cv">Your CV (PDF, Word .docx or text, up to 5 MB)</label><input id="cv" name="cv" type="file" accept=".pdf,.docx,.txt,.md">
<label for="cv_text">Or paste your CV (used if the file cannot be read)</label><textarea id="cv_text" name="cv_text" maxlength="${MAX_CV_TEXT}">${v("cv_text")}</textarea>
<label class="check"><input type="checkbox" name="consent" value="yes" required> <span>I agree that HermitShell keeps my CV and details on its server to match jobs for me, as described in <a href="/privacy" target="_blank" rel="noopener">how your data is handled</a>. Every report has an unsubscribe link that deletes them.</span></label>
<button type="submit">Create my profile</button></form>`);
}

export async function handleJoin(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const invite = await openInvite(env, url.searchParams.get("i"));
    return invite ? form(invite.id) : page(...EXPIRED);
  }
  if (request.method !== "POST") return text("Method not allowed", 405, { Allow: "GET, POST" });

  // The invite is checked before the (large) body is read.
  const invite = await openInvite(env, url.searchParams.get("i"));
  if (!invite) return page(...EXPIRED);
  const data = await limitedForm(request, MAX_FORM_BYTES);
  if (!data) return form(invite.id, {}, "The CV file is larger than 5 MB.");
  if (String(data.get("i") || "") !== invite.id) return page(...EXPIRED);
  const values = Object.fromEntries(["name", "email", "phone", "location", "roles"].map((k) => [k, field(data, k, 300)]));
  values.name = values.name.slice(0, 80);
  values.email = values.email.slice(0, 120);
  values.cv_text = field(data, "cv_text", MAX_CV_TEXT);
  const retry = (message) => form(invite.id, values, message);
  if (!values.name || !values.roles) return retry("Please fill in your name and the roles you are looking for.");
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(values.email)) return retry("Please enter a valid email address.");
  if (data.get("consent") !== "yes") return retry("Please tick the box to agree to HermitShell keeping your CV.");

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

  await env.FEEDBACK.delete(`invite:${invite.id}`);
  await queueItem(env, { type: "signup", invite: invite.id, note: invite.note, ...values, cv });
  return page("Thanks, you're in", `<p>Thanks ${esc(values.name)}. HermitShell is setting up your profile from your CV and will email
${esc(values.email)} when it is ready. Your first report arrives with the next daily run.</p><p>You can close this tab.</p>`);
}

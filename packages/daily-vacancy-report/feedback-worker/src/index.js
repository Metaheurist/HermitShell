// HermitShell feedback Worker.
//
// Email buttons link to GET /f with a signed token. The link only shows a confirmation page, so
// mail scanners that open every link cannot record answers; pressing Confirm POSTs the answer,
// which is kept in Workers KV (30 days) until HermitShell fetches it from GET /events and deletes it
// with POST /ack. Secrets: JOB_FEEDBACK_SECRET (link signing) and JOB_FEEDBACK_API_TOKEN (API).
// A confirmed "cover_letter" answer is a request: HermitShell's cover_letter.py polls every few minutes,
// writes the letter on the HermitShell server and emails it as a PDF. "add_skill" links carry the job's
// missing skills (signed, parameter s); the ones you tick, plus any you type, join your skills pool.
// Links for extra profiles carry the profile id (signed, parameter u); "unsubscribe" removes one.
// Every link also carries its issue day (signed, parameter d) and stops working after LINK_DAYS.
// Invite sign-ups (/join) and the admin gateway (/admin) are in join.js and admin.js.

import { handleAdmin, handleApi } from "./admin.js";
import { handleJoin, queueItem } from "./join.js";
import {
  CONTROL_RE, LINK_DAYS, authorised, deleteAndUnflag, esc, eventFlag, eventPrefix, json, limitedForm, limitedJson,
  listFlagged, page, purgeProfileEvents, safeEqual, setFlag, sha256Hex, sign, text, today,
} from "./lib.js";
import { privacyPage } from "./privacy.js";

export { sign } from "./lib.js";

export const ACTIONS = {
  interested: "Interested",
  not_for_me: "Not for me",
  applied: "I applied",
  heard_back: "Heard back",
  rejected: "Rejected",
  good_match: "Good match",
  cover_letter: "Generate cover letter",
  tailored_cv: "Tailored CV",
  add_skill: "Add to my skills",
  unsubscribe: "Unsubscribe",
};
const PLACEHOLDERS = {
  not_for_me: "Why not? For example: too senior, needs travel, wrong tech stack",
  rejected: "Anything they said (optional)",
  good_match: "What makes it a good match? For example: right stack, great location",
  cover_letter: "Anything to emphasise? For example: mention my Azure work, keep it under a page",
  tailored_cv: "Anything to lead with? For example: put my Power BI work first",
  unsubscribe: "Anything we could do better? (optional)",
};
const SAVED_MESSAGES = {
  cover_letter: "HermitShell is writing your cover letter. It arrives by email, as a PDF, within about 10 minutes.",
  tailored_cv: "HermitShell is tailoring your CV to this job. It arrives by email, as a PDF, within about 10 minutes.",
  add_skill: "HermitShell counts these as on your CV from its next run, for ratings and cover letters.",
};
const EVENT_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_TITLE = 120;
const MAX_REASON = 300;
const MAX_SKILL = 60;
const MAX_SKILLS = 12;
const MAX_FORM_BYTES = 16 * 1024;
const PROFILE_RE = /^[a-z0-9-]{1,40}$/;
const LINK_FIELDS = ["j", "a", "n", "s", "u", "d", "t"];

export function cleanSkill(text) {
  return String(text ?? "").replace(/[^\p{L}\p{N}_ .+#/&()-]/gu, "").split(/\s+/).filter(Boolean).join(" ")
    .slice(0, MAX_SKILL).trim();
}

function skillList(packed) {
  return [...new Set(String(packed || "").split("|").map(cleanSkill).filter(Boolean))].slice(0, MAX_SKILLS);
}

async function validLink(env, p) {
  const day = Number(p.d);
  if (!env.JOB_FEEDBACK_SECRET || !ACTIONS[p.a] || !p.j || p.j.length > 300 || (p.n || "").length > MAX_TITLE ||
      (p.s || "").length > (MAX_SKILL + 1) * MAX_SKILLS || (p.a === "add_skill") !== Boolean(p.s) ||
      (p.u && !PROFILE_RE.test(p.u)) || !/^\d{1,6}$/.test(p.d || "") || day > today() + 1 ||
      LINK_FIELDS.some((k) => CONTROL_RE.test(p[k] || ""))) {
    return false;
  }
  return safeEqual(p.t || "", await sign(env.JOB_FEEDBACK_SECRET, p.j, p.a, p.n || "", p.s || "", p.u || "", p.d));
}

function expired(p) {
  return today() - Number(p.d) > LINK_DAYS;
}

// Links of deleted profiles stop working once HermitShell has reported its profiles at least once.
async function profileGone(env, u) {
  if (!u) return false;
  const status = await env.FEEDBACK.get("status:profiles", "json");
  return Array.isArray(status?.profiles) && status.profiles.length > 0 && !status.profiles.some((p) => p.id === u);
}

function skillPage(p, hidden) {
  const picked = cleanSkill(p.p);
  const boxes = skillList(p.s).map((skill) => `<label class="skill"><input type="checkbox" name="k" value="${esc(skill)}"${
    skill === picked ? " checked" : ""}> ${esc(skill)}</label>`).join("");
  return page(ACTIONS.add_skill, `<p>Missing from your CV for ${esc(p.n || "this job")}. Tick the ones you have.</p>
<form method="post" action="/f">${hidden}${boxes}
<label for="o">Other skills you have (optional, comma separated)</label>
<input id="o" name="o" maxlength="${MAX_REASON}" placeholder="For example: Kubernetes, Terraform">
<button type="submit">Confirm: ${esc(ACTIONS.add_skill)}</button></form>
<p style="font-size:13px">Nothing is saved until you press Confirm.</p>`);
}

function unsubscribePage(p, hidden) {
  const effect = p.j === "profile-pause"
    ? "HermitShell stops sending these reports. Your profile is kept on the server and can be switched back on there."
    : "HermitShell stops sending these reports and deletes this profile, its CV and its history from the server, " +
      'removes your name and email from its logs, and emails you a confirmation. <a href="/privacy">How your data is handled</a>.';
  return page("Unsubscribe", `<p>Stop HermitShell's job reports for <b>${esc(p.n || "this profile")}</b>?</p><p>${effect}</p>
<form method="post" action="/f">${hidden}
<label for="r">Feedback (optional)</label>
<textarea id="r" name="r" maxlength="${MAX_REASON}" placeholder="${esc(PLACEHOLDERS.unsubscribe)}"></textarea>
<button type="submit" class="danger">Confirm: unsubscribe</button></form>
<p style="font-size:13px">Nothing changes until you press Confirm.</p>`);
}

function confirmPage(p) {
  const hidden = LINK_FIELDS.filter((k) => p[k])
    .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`).join("");
  if (p.a === "add_skill") return skillPage(p, hidden);
  if (p.a === "unsubscribe") return unsubscribePage(p, hidden);
  const placeholder = PLACEHOLDERS[p.a] || "Anything worth remembering (optional)";
  const label = p.a === "cover_letter" ? "Guidance for the letter (optional)"
    : p.a === "tailored_cv" ? "Guidance for the CV (optional)" : "Note for HermitShell (optional)";
  return page(ACTIONS[p.a], `<p>${esc(p.n || "This job")}</p>
<form method="post" action="/f">${hidden}
<label for="r">${label}</label>
<textarea id="r" name="r" maxlength="${MAX_REASON}" placeholder="${esc(placeholder)}"></textarea>
<button type="submit">Confirm: ${esc(ACTIONS[p.a])}</button></form>
<p style="font-size:13px">Nothing is saved until you press Confirm.</p>`);
}

const INVALID_LINK = ["Link not valid", "<p>This feedback link is incomplete or has been changed. Use the button in the email again.</p>", { status: 403 }];
const EXPIRED_LINK = ["Link expired", `<p>Buttons in reports work for ${LINK_DAYS} days. Use the buttons in a newer report.</p>`, { status: 410 }];
const GONE_PROFILE = ["Profile removed", "<p>This profile no longer exists, so its links do nothing.</p>", { status: 410 }];

async function checkLink(env, p) {
  if (!(await validLink(env, p))) return page(...INVALID_LINK);
  if (expired(p)) return page(...EXPIRED_LINK);
  if (await profileGone(env, p.u)) return page(...GONE_PROFILE);
  return null;
}

async function saveAnswer(form, env) {
  const p = Object.fromEntries([...LINK_FIELDS, "r", "o"].map((k) => [k, String(form.get(k) ?? "")]));
  const problem = await checkLink(env, p);
  if (problem) return problem;
  p.r = p.r.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").slice(0, MAX_REASON);
  if (p.a === "unsubscribe") {
    await queueItem(env, { type: "unsubscribe", u: p.u, reason: p.r });
    if (p.u) await purgeProfileEvents(env, p.u);
    const after = p.u
      ? "HermitShell deletes your profile, CV and history within about 5 minutes and emails you when it is done."
      : `${esc(p.n || "This profile")} gets no more reports once HermitShell applies it, within about 5 minutes.`;
    return page("Unsubscribed", `<p>Done. ${after}</p><p>You can close this tab.</p>`);
  }
  const at = Date.now();
  const event = { j: p.j, a: p.a, r: p.r, at, ...(p.u ? { u: p.u } : {}) };
  let saved = `${esc(ACTIONS[p.a])}: ${esc(p.n || "this job")}.`;
  if (p.a === "add_skill") {
    const offered = new Set(skillList(p.s));
    const ticked = form.getAll("k").map(cleanSkill).filter((s) => offered.has(s));
    const typed = p.o.slice(0, MAX_REASON).split(",").map(cleanSkill).filter(Boolean);
    event.skills = [...new Set([...ticked, ...typed])].slice(0, MAX_SKILLS);
    if (!event.skills.length) {
      return page("Nothing selected", "<p>Tick at least one skill or type one in. Use your browser's Back button to try again.</p>", { status: 400 });
    }
    saved = `Added to your skills: ${esc(event.skills.join(", "))}.`;
  }
  // Pressing Confirm again with the same answer overwrites the stored event instead of adding one.
  const answer = await sha256Hex(`${event.r}\n${(event.skills || []).join("|")}`);
  event.id = `${eventPrefix(p.u)}${p.t}:${answer.slice(0, 12)}`;
  await env.FEEDBACK.put(event.id, JSON.stringify(event), { expirationTtl: EVENT_TTL_SECONDS });
  await setFlag(env, eventFlag(p.u), EVENT_TTL_SECONDS);
  const next = SAVED_MESSAGES[p.a] || "HermitShell picks this up on its next run.";
  return page("Saved", `<p>${saved}</p>
<p>${esc(next)} You can close this tab.</p>`);
}

async function route(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname === "/f") {
    if (request.method === "GET") {
      const p = Object.fromEntries(url.searchParams);
      return (await checkLink(env, p)) || confirmPage(p);
    }
    if (request.method === "POST") {
      const form = await limitedForm(request, MAX_FORM_BYTES);
      return form ? saveAnswer(form, env) : text("Request too large", 413);
    }
    return text("Method not allowed", 405, { Allow: "GET, POST" });
  }

  if (url.pathname === "/events" && request.method === "GET") {
    if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
    const profile = url.searchParams.get("u") || "";
    if (profile && !PROFILE_RE.test(profile)) return json({ error: "bad profile" }, 400);
    return json({ events: await listFlagged(env, request, eventPrefix(profile), eventFlag(profile), 1000) });
  }

  if (url.pathname === "/ack" && request.method === "POST") {
    if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
    const body = (await limitedJson(request, 200000)) || {};
    const ids = (Array.isArray(body.ids) ? body.ids : [])
      .filter((id) => typeof id === "string" && /^event:[a-z0-9_-]{1,40}:/.test(id))
      .slice(0, 1000);
    const byProfile = {};
    for (const id of ids) (byProfile[id.split(":")[1]] ||= []).push(id);
    await Promise.all(Object.entries(byProfile).map(([u, group]) =>
      deleteAndUnflag(env, group, eventPrefix(u === "_" ? "" : u), eventFlag(u === "_" ? "" : u))));
    return json({ deleted: ids.length });
  }

  if (url.pathname === "/privacy") return privacyPage();
  if (url.pathname === "/join") return handleJoin(request, env);
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleAdmin(request, env, ctx);
  if (url.pathname.startsWith("/api/")) return handleApi(request, env);
  if (url.pathname === "/") return text("HermitShell feedback endpoint.");
  return text("Not found", 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error(`${new URL(request.url).pathname}: ${err?.name || "Error"}: ${String(err?.message || "").slice(0, 200)}`);
      return page("Something went wrong", "<p>Please try again in a minute.</p>", { status: 500 });
    }
  },
};

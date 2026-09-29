// Daily Vacancy Report feedback Worker.
//
// Email buttons link to GET /f with a signed token. The link only shows a confirmation page, so
// mail scanners that open every link cannot record answers; pressing Confirm POSTs the answer,
// which is kept in Workers KV (30 days) until Hermes fetches it from GET /events and deletes it
// with POST /ack. Secrets: JOB_FEEDBACK_SECRET (link signing) and JOB_FEEDBACK_API_TOKEN (API).
// A confirmed "cover_letter" answer is a request: Hermes' cover_letter.py polls every few minutes,
// writes the letter on the Hermes server and emails it as a PDF. "add_skill" links carry the job's
// missing skills (signed, parameter s); the ones you tick, plus any you type, join your skills pool.
// Links for extra profiles carry the profile id (signed, parameter u); "unsubscribe" removes one.
// Invite sign-ups (/join) and the admin gateway (/admin) are in join.js and admin.js.

import { handleAdmin, handleApi } from "./admin.js";
import { handleJoin, queueItem } from "./join.js";
import { SECURITY_HEADERS, authorised, deleteAndUnflag, esc, json, listFlagged, page, safeEqual, sign } from "./lib.js";

export { sign } from "./lib.js";

export const ACTIONS = {
  interested: "Interested",
  not_for_me: "Not for me",
  applied: "I applied",
  heard_back: "Heard back",
  rejected: "Rejected",
  good_match: "Good match",
  cover_letter: "Generate cover letter",
  add_skill: "Add to my skills",
  unsubscribe: "Unsubscribe",
};
const PLACEHOLDERS = {
  not_for_me: "Why not? For example: too senior, needs travel, wrong tech stack",
  rejected: "Anything they said (optional)",
  good_match: "What makes it a good match? For example: right stack, great location",
  cover_letter: "Anything to emphasise? For example: mention my Azure work, keep it under a page",
  unsubscribe: "Anything we could do better? (optional)",
};
const SAVED_MESSAGES = {
  cover_letter: "Hermes is writing your cover letter. It arrives by email, as a PDF, within about 10 minutes.",
  add_skill: "Hermes counts these as on your CV from its next run, for ratings and cover letters.",
};
const EVENT_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_TITLE = 120;
const MAX_REASON = 300;
const MAX_SKILL = 60;
const MAX_SKILLS = 12;
const PROFILE_RE = /^[a-z0-9-]{1,40}$/;

export function cleanSkill(text) {
  return String(text ?? "").replace(/[^\p{L}\p{N}_ .+#/&()-]/gu, "").split(/\s+/).filter(Boolean).join(" ")
    .slice(0, MAX_SKILL).trim();
}

function skillList(packed) {
  return [...new Set(String(packed || "").split("|").map(cleanSkill).filter(Boolean))].slice(0, MAX_SKILLS);
}

async function validLink(env, p) {
  if (!env.JOB_FEEDBACK_SECRET || !ACTIONS[p.a] || !p.j || p.j.length > 300 || (p.n || "").length > MAX_TITLE ||
      (p.s || "").length > (MAX_SKILL + 1) * MAX_SKILLS || (p.a === "add_skill") !== Boolean(p.s) ||
      (p.u && !PROFILE_RE.test(p.u))) {
    return false;
  }
  return safeEqual(p.t || "", await sign(env.JOB_FEEDBACK_SECRET, p.j, p.a, p.n || "", p.s || "", p.u || ""));
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
    ? "Hermes stops sending these reports. Your profile is kept on the server and can be switched back on there."
    : "Hermes stops sending these reports and deletes this profile, its CV and its history from the server.";
  return page("Unsubscribe", `<p>Stop the Daily Vacancy Report for <b>${esc(p.n || "this profile")}</b>?</p><p>${effect}</p>
<form method="post" action="/f">${hidden}
<label for="r">Feedback (optional)</label>
<textarea id="r" name="r" maxlength="${MAX_REASON}" placeholder="${esc(PLACEHOLDERS.unsubscribe)}"></textarea>
<button type="submit" class="danger">Confirm: unsubscribe</button></form>
<p style="font-size:13px">Nothing changes until you press Confirm.</p>`);
}

function confirmPage(p) {
  const hidden = ["j", "a", "n", "s", "u", "t"].filter((k) => p[k])
    .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`).join("");
  if (p.a === "add_skill") return skillPage(p, hidden);
  if (p.a === "unsubscribe") return unsubscribePage(p, hidden);
  const placeholder = PLACEHOLDERS[p.a] || "Anything worth remembering (optional)";
  const label = p.a === "cover_letter" ? "Guidance for the letter (optional)" : "Note for Hermes (optional)";
  return page(ACTIONS[p.a], `<p>${esc(p.n || "This job")}</p>
<form method="post" action="/f">${hidden}
<label for="r">${label}</label>
<textarea id="r" name="r" maxlength="${MAX_REASON}" placeholder="${esc(placeholder)}"></textarea>
<button type="submit">Confirm: ${esc(ACTIONS[p.a])}</button></form>
<p style="font-size:13px">Nothing is saved until you press Confirm.</p>`);
}

const INVALID_LINK = ["Link not valid", "<p>This feedback link is incomplete or has been changed. Use the button in the email again.</p>", { status: 403 }];

async function saveAnswer(form, env) {
  const p = Object.fromEntries(["j", "a", "n", "s", "u", "t", "r", "o"].map((k) => [k, String(form.get(k) ?? "")]));
  if (!(await validLink(env, p))) return page(...INVALID_LINK);
  if (p.a === "unsubscribe") {
    await queueItem(env, { type: "unsubscribe", u: p.u, reason: p.r.slice(0, MAX_REASON) });
    return page("Unsubscribed", `<p>Done: ${esc(p.n || "this profile")} gets no more reports once Hermes applies it,
within about 5 minutes.</p><p>You can close this tab.</p>`);
  }
  const at = Date.now();
  const id = `event:${at}:${crypto.randomUUID()}`;
  const event = { id, j: p.j, a: p.a, r: p.r.slice(0, MAX_REASON), at, ...(p.u ? { u: p.u } : {}) };
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
  await env.FEEDBACK.put(id, JSON.stringify(event), { expirationTtl: EVENT_TTL_SECONDS });
  await env.FEEDBACK.put("flag:events", "1", { expirationTtl: EVENT_TTL_SECONDS });
  const next = SAVED_MESSAGES[p.a] || "Hermes picks this up on its next run.";
  return page("Saved", `<p>${saved}</p>
<p>${esc(next)} You can close this tab.</p>`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/f") {
      if (request.method === "GET") {
        const p = Object.fromEntries(url.searchParams);
        return (await validLink(env, p)) ? confirmPage(p) : page(...INVALID_LINK);
      }
      if (request.method === "POST") return saveAnswer(await request.formData(), env);
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
    }

    if (url.pathname === "/events" && request.method === "GET") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      const profile = url.searchParams.get("u") || "";
      const events = (await listFlagged(env, request, "event:", "flag:events", 1000)).filter((e) => (e.u || "") === profile);
      return json({ events });
    }

    if (url.pathname === "/ack" && request.method === "POST") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      const body = await request.json().catch(() => ({}));
      const ids = (Array.isArray(body.ids) ? body.ids : [])
        .filter((id) => typeof id === "string" && id.startsWith("event:"))
        .slice(0, 1000);
      await deleteAndUnflag(env, ids, "event:", "flag:events");
      return json({ deleted: ids.length });
    }

    if (url.pathname === "/join") return handleJoin(request, env);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleAdmin(request, env);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);

    if (url.pathname === "/") {
      return new Response("Daily Vacancy Report feedback endpoint.", {
        headers: { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS },
      });
    }
    return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  },
};

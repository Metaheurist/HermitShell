// Daily Vacancy Report feedback Worker.
//
// Email buttons link to GET /f with a signed token. The link only shows a confirmation page, so
// mail scanners that open every link cannot record answers; pressing Confirm POSTs the answer,
// which is kept in Workers KV (30 days) until Hermes fetches it from GET /events and deletes it
// with POST /ack. Secrets: JOB_FEEDBACK_SECRET (link signing) and JOB_FEEDBACK_API_TOKEN (API).
// A confirmed "cover_letter" answer is a request: Hermes' cover_letter.py polls every few minutes,
// writes the letter on the Hermes server and emails it as a PDF.

export const ACTIONS = {
  interested: "Interested",
  not_for_me: "Not for me",
  applied: "I applied",
  heard_back: "Heard back",
  rejected: "Rejected",
  good_match: "Good match",
  cover_letter: "Generate cover letter",
};
const PLACEHOLDERS = {
  not_for_me: "Why not? For example: too senior, needs travel, wrong tech stack",
  rejected: "Anything they said (optional)",
  good_match: "What makes it a good match? For example: right stack, great location",
  cover_letter: "Anything to emphasise? For example: mention my Azure work, keep it under a page",
};
const SAVED_MESSAGES = {
  cover_letter: "Hermes is writing your cover letter. It arrives by email, as a PDF, within about 10 minutes.",
};
const EVENT_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_TITLE = 120;
const MAX_REASON = 300;
const encoder = new TextEncoder();

export async function sign(secret, key, action, title) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(`${key}\n${action}\n${title}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function validLink(env, p) {
  if (!env.JOB_FEEDBACK_SECRET || !ACTIONS[p.a] || !p.j || p.j.length > 300 || (p.n || "").length > MAX_TITLE) {
    return false;
  }
  return safeEqual(p.t || "", await sign(env.JOB_FEEDBACK_SECRET, p.j, p.a, p.n || ""));
}

function authorised(request, env) {
  const header = request.headers.get("Authorization") || "";
  return Boolean(env.JOB_FEEDBACK_API_TOKEN) && safeEqual(header, `Bearer ${env.JOB_FEEDBACK_API_TOKEN}`);
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function page(heading, body, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(heading)}</title>
<style>
body{margin:0;background:#eef1f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a}
main{max-width:460px;margin:48px auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px}
.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#4f46e5;font-weight:700}
h1{font-size:22px;margin:8px 0 6px}p{color:#475569;line-height:1.5}
textarea{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:10px;padding:10px;font:inherit;min-height:80px}
button{margin-top:14px;background:#4f46e5;color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:15px;font-weight:600;cursor:pointer}
</style></head><body><main><div class="eyebrow">Daily Vacancy Report</div><h1>${esc(heading)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      ...SECURITY_HEADERS,
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
  });
}

function confirmPage(p) {
  const hidden = ["j", "a", "n", "t"].map((k) => `<input type="hidden" name="${k}" value="${esc(p[k] || "")}">`).join("");
  const placeholder = PLACEHOLDERS[p.a] || "Anything worth remembering (optional)";
  const label = p.a === "cover_letter" ? "Guidance for the letter (optional)" : "Note for Hermes (optional)";
  return page(ACTIONS[p.a], `<p>${esc(p.n || "This job")}</p>
<form method="post" action="/f">${hidden}
<label for="r">${label}</label>
<textarea id="r" name="r" maxlength="${MAX_REASON}" placeholder="${esc(placeholder)}"></textarea>
<button type="submit">Confirm: ${esc(ACTIONS[p.a])}</button></form>
<p style="font-size:13px">Nothing is saved until you press Confirm.</p>`);
}

const INVALID_LINK = ["Link not valid", "<p>This feedback link is incomplete or has been changed. Use the button in the email again.</p>", 403];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/f") {
      if (request.method === "GET") {
        const p = Object.fromEntries(url.searchParams);
        return (await validLink(env, p)) ? confirmPage(p) : page(...INVALID_LINK);
      }
      if (request.method === "POST") {
        const form = await request.formData();
        const p = Object.fromEntries(["j", "a", "n", "t", "r"].map((k) => [k, String(form.get(k) ?? "")]));
        if (!(await validLink(env, p))) return page(...INVALID_LINK);
        const at = Date.now();
        const id = `event:${at}:${crypto.randomUUID()}`;
        const event = { id, j: p.j, a: p.a, r: p.r.slice(0, MAX_REASON), at };
        await env.FEEDBACK.put(id, JSON.stringify(event), { expirationTtl: EVENT_TTL_SECONDS });
        const next = SAVED_MESSAGES[p.a] || "Hermes picks this up on its next run.";
        return page("Saved", `<p>${esc(ACTIONS[p.a])}: ${esc(p.n || "this job")}.</p>
<p>${esc(next)} You can close this tab.</p>`);
      }
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
    }

    if (url.pathname === "/events" && request.method === "GET") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      const listed = await env.FEEDBACK.list({ prefix: "event:", limit: 1000 });
      const events = (await Promise.all(listed.keys.map((k) => env.FEEDBACK.get(k.name, "json")))).filter(Boolean);
      return json({ events });
    }

    if (url.pathname === "/ack" && request.method === "POST") {
      if (!authorised(request, env)) return json({ error: "unauthorised" }, 401);
      const body = await request.json().catch(() => ({}));
      const ids = (Array.isArray(body.ids) ? body.ids : [])
        .filter((id) => typeof id === "string" && id.startsWith("event:"))
        .slice(0, 1000);
      await Promise.all(ids.map((id) => env.FEEDBACK.delete(id)));
      return json({ deleted: ids.length });
    }

    if (url.pathname === "/") {
      return new Response("Daily Vacancy Report feedback endpoint.", {
        headers: { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS },
      });
    }
    return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  },
};

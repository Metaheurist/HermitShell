// A recruit's Pipeline (/admin/pipeline): where each application stands, in columns, from the board HermitShell
// sends with the jobs sent (profile_stats._board, kept in "sent:<id>"). Moving a job posts to /admin/stage, which
// stores the move as the matching email answer would be; HermitShell collects it within about 5 minutes and the
// board shows it after its next stats upload. Placement details (start date, fee) are for admins only: the fee is
// sealed for HermitShell before it is stored, and neither the board nor the stats bring it back.

import { CURRENCIES, currencyCode } from "./currency.js";
import { jobHash, validJobKey } from "./docs.js";
import { PIPELINE_URL, profileTabs } from "./history.js";
import { BACK_TO_RECRUITS, EVENT_TTL_SECONDS, esc, eventFlag, eventPrefix, page, setFlag, MONTHS_SHORT as MONTHS } from "./lib.js";
import { BOARD_STAGES } from "./stats.js";

export const STAGE_URL = "/admin/stage";
// The moves the board offers, in its order, and their labels.
export const STAGE_LABELS = { interested: "Interested", applied: "Applied", heard_back: "Heard back", interview: "Interview",
  offer: "Offer", placed: "Placed", rejected: "Rejected" };
// Stages that may carry placement details (job_tracker.META_STAGES), and their limits (MAX_FEE, META_DAYS).
export const META_STAGES = ["offer", "placed"];
export const MAX_FEE = 1_000_000;
const META_DAYS = 2 * 365;
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FEE_RE = /^\d{1,7}(\.\d{1,2})?$/;
const COLUMNS = [["interested", "Interested", ["interested", "good_match"]], ["applied", "Applied", ["applied", "heard_back"]],
  ["interview", "Interview", ["interview"]], ["offer", "Offer", ["offer"]], ["placed", "Placed", ["placed"]], ["rejected", "Rejected", ["rejected"]]];

// The start date, fee and currency typed for an offer or placement: {} when none, null when one is not valid.
export function stageMeta(form, now = Date.now()) {
  const out = {};
  const start = String(form.get("start") || "").trim();
  if (start) {
    const ms = Date.parse(`${start}T00:00:00Z`);
    if (!DATE_RE.test(start) || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== start ||
      Math.abs(ms - now) > META_DAYS * DAY_MS) return null;
    out.start = start;
  }
  const fee = String(form.get("fee") || "").trim().replace(/,/g, "");
  if (fee) {
    const currency = currencyCode(form.get("currency"));
    if (!FEE_RE.test(fee) || Number(fee) > MAX_FEE || !currency) return null;
    out.fee = Number(fee);
    out.currency = currency;
  }
  return out;
}

// A move made on the board, stored as the email's answer would be. The same move for the same job in the same minute
// is the same event, so a double press makes one.
export async function requestStage(env, { profile, j, stage, meta = null }) {
  const at = Date.now();
  const h = await jobHash(j);
  const event = { j, a: stage, r: "", at, via: "dashboard", u: profile, ...(meta && Object.keys(meta).length ? { meta } : {}) };
  event.id = `${eventPrefix(profile)}dash-st-${h.slice(0, 20)}:${stage}${Math.floor(at / 60000)}`;
  await Promise.all([
    env.FEEDBACK.put(event.id, JSON.stringify(event), { expirationTtl: EVENT_TTL_SECONDS }),
    setFlag(env, eventFlag(profile), EVENT_TTL_SECONDS),
  ]);
  return h;
}

const shortDay = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

function moveForm(pid, c, h, ctx) {
  const options = Object.entries(STAGE_LABELS).map(([k, label]) => `<option value="${k}"${k === c.stage ? " selected" : ""}>${label}</option>`).join("");
  const currency = currencyCode(ctx.currency) || "GBP";
  const placement = ctx.admin ? `<details class="pdet"><summary>Start date and fee (offer or placed)</summary>
<label>Start date<input type="date" name="start"></label><label>Fee<input name="fee" inputmode="decimal" maxlength="12" placeholder="0.00"></label>
<label>Currency<select name="currency">${CURRENCIES.map(([code]) => `<option${code === currency ? " selected" : ""}>${code}</option>`).join("")}</select></label>
<small>Only admins see these. The fee is sealed for HermitShell and not shown on the dashboard.</small></details>` : "";
  return `<form method="post" action="${STAGE_URL}" class="pmove"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
<input type="hidden" name="u" value="${esc(pid)}"><input type="hidden" name="j" value="${esc(c.key)}">
<label class="sr" for="st-${h}">Move to</label><select id="st-${h}" name="a">${options}</select><button>Move</button>${placement}</form>`;
}

function cardHtml(pid, c, h, ctx) {
  const tag = c.stage === "heard_back" ? '<span class="ptag">Heard back</span>' : c.stage === "good_match" ? '<span class="ptag">Good match</span>' : "";
  return `<li class="pcard" id="card-${h}"><b>${esc(String(c.title || "A job").slice(0, 90))}</b>
<span class="muted">${esc(String(c.employer || "").slice(0, 60))}${c.employer ? " &middot; " : ""}since ${esc(shortDay(c.day))}</span>${tag}
${ctx.csrf ? moveForm(pid, c, h, ctx) : ""}</li>`;
}

const NOTES = {
  stage: ["ok", "Moved. HermitShell collects it within about 5 minutes, and the board shows it after its next check-in."],
  stagebad: ["bad", "That move could not be made. Check the start date and fee, then try again."],
  feeseal: ["bad", "The fee was not saved: HermitShell has not sent the key it is sealed with yet. Try again after its next check-in."],
};

// `board`: the cards from "sent:<id>" (null before HermitShell has sent one); `opts`: csrf, admin, done.
export async function pipelinePage(status, board, pid, opts = {}) {
  const p = (status.profiles || []).find((x) => x.id === pid);
  const back = { wide: true, before: BACK_TO_RECRUITS };
  if (!p) return page("Recruit not found", '<p>HermitShell has not reported this recruit. <a href="/admin">Back to recruits</a></p>', { status: 404 });
  const cards = (Array.isArray(board) ? board : []).filter((c) => c && validJobKey(c.key) && BOARD_STAGES.includes(c.stage) &&
    DATE_RE.test(c.day || ""));
  const hashes = await Promise.all(cards.map((c) => jobHash(c.key)));
  const ctx = { csrf: opts.csrf || "", admin: Boolean(opts.admin), currency: p.job?.currency };
  const columns = COLUMNS.map(([id, label, stages]) => {
    const rows = cards.map((c, i) => [c, hashes[i].slice(0, 16)]).filter(([c]) => stages.includes(c.stage));
    return `<section class="pcol k-${id}" aria-label="${label}"><h3>${label}<span>${rows.length}</span></h3>
<ul>${rows.map(([c, h]) => cardHtml(pid, c, h, ctx)).join("") || '<li class="pnone">None</li>'}</ul></section>`;
  }).join("");
  const [tone, message] = NOTES[opts.done] || [];
  const intro = `<p class="muted">Where each application stands, from the email buttons and the moves made here. A move shows on the board
after HermitShell's next check-in, within about 5 minutes. Jobs marked Not for me are left off.</p>`;
  const body = Array.isArray(board) ? `<div class="pboard">${columns}</div>`
    : '<p class="note">No board yet. HermitShell sends it with the jobs sent, within a few minutes of its next check-in.</p>';
  return page(p.name, `<style>${PIPELINE_STYLE}</style>${profileTabs(pid, "pipeline")}${message ? `<p class="note ${tone}" role="status">${esc(message)}</p>` : ""}
${intro}${body}`, back);
}

export const pipelineBack = (u, done, h = "") => `${PIPELINE_URL}?u=${u}&done=${done}${h ? `#card-${h}` : ""}`;

const PIPELINE_STYLE = `
.pboard{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;padding:4px 2px 12px;align-items:start}
.pcol{background:var(--field);border:1px solid var(--line);border-radius:16px;padding:10px;min-width:0}
.pcol h3{display:flex;justify-content:space-between;align-items:center;margin:2px 4px 10px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:750}
.pcol h3 span{letter-spacing:0;font-size:11.5px;background:var(--soft);color:var(--brand-ink);border-radius:99px;padding:1px 8px}
.pcol ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.pcard{background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px 11px;display:grid;gap:4px;scroll-margin-top:80px}
.pcard b{font-size:13.5px;color:var(--ink);overflow-wrap:anywhere}.pcard .muted{font-size:12.5px}
.pcard:target{border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 20%,transparent)}
.ptag{justify-self:start;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;background:#e4f5fd;color:#0369a1}
.pnone{font-size:12.5px;color:var(--muted);padding:6px 4px}
.pmove{position:relative;display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0 0}
.pmove select{flex:1;min-width:0;margin:0;padding:5px 8px;font-size:12.5px}
.pmove button{margin:0;padding:5px 12px;font-size:12.5px}
.pdet{flex-basis:100%;font-size:12.5px}.pdet summary{cursor:pointer;color:var(--muted)}
.pdet label{display:grid;gap:2px;margin:6px 0 0;font-size:12px}.pdet input,.pdet select{margin:0;padding:5px 8px;font-size:12.5px}
.pdet small{display:block;margin-top:6px;color:var(--muted)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.k-interview h3 span{background:#f5f3ff;color:#6d28d9}.k-offer h3 span{background:#fdf2f8;color:#be185d}
.k-placed h3 span{background:#eef2ff;color:#4338ca}.k-rejected h3 span{background:#f1f5f9;color:#475569}
`;

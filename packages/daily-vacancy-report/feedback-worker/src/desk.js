// The desk (/admin/desk): what each recruiter's recruits have done in the last 7 days, 30 days, 90 days or 12
// months, and the salaries by job title across the desk. HermitShell sends every recruit's totals in one upload
// (profiles.py push_desk; POST /api/desk), at most every 30 minutes, and it is kept sealed as "stats:desk" because
// it holds placement fees. Admins see every recruiter's recruits and the fees, a manager their team's recruits and
// fees; a recruiter sees only their own recruits and never a fee: fees are taken out before the page is drawn.

import { currencyCode, currencySymbol } from "./currency.js";
import { PROFILE_RE, ago, esc, page } from "./lib.js";
import { nav } from "./settings.js";
import { DEFAULT_RANGE, RANGES, SALARY_MIN_N, SENT_URL, STATS_URL, salaryList } from "./stats.js";
import { canSee, navFor, oversees, recruiterOf } from "./users.js";
import { getSealedJson, putSealedJson } from "./vault.js";

export const DESK_URL = "/admin/desk";
export const DESK_KEY = "stats:desk";
export const MAX_DESK_BYTES = 300 * 1024;
export const COUNTS = ["sent", "applied", "interview", "offer", "placed"];
const LABELS = { sent: "Sent", applied: "Applied", interview: "Interviews", offer: "Offers", placed: "Placed" };
const MAX_RECRUITS = 2000;
const MAX_SALARIES = 12;
const CODE_RE = /^[A-Z]{3}$/;

// ------------------------------------------------------------------------- what HermitShell may store

const plainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const count = (n) => Number.isInteger(n) && n >= 0 && n < 1e7;

function validFees(f) {
  return plainObject(f) && Object.keys(f).length <= 10 &&
    Object.entries(f).every(([c, v]) => CODE_RE.test(c) && typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9);
}

function validLine(ranges) {
  return plainObject(ranges) && Object.entries(ranges).every(([r, l]) => RANGES[r] && plainObject(l) &&
    COUNTS.every((k) => count(l[k])) && validFees(l.fees));
}

function validSalary(s) {
  return plainObject(s) && typeof s.title === "string" && s.title.length <= 120 && Number.isInteger(s.n) && s.n > 0 &&
    typeof s.median === "number" && Number.isFinite(s.median) && s.median > 0 && CODE_RE.test(s.currency || "");
}

export function validDesk(d) {
  if (!plainObject(d) || !plainObject(d.recruits)) return false;
  const recruits = Object.entries(d.recruits);
  return recruits.length <= MAX_RECRUITS && recruits.every(([u, ranges]) => PROFILE_RE.test(u) && validLine(ranges)) &&
    (d.salaries == null || (Array.isArray(d.salaries) && d.salaries.length <= MAX_SALARIES && d.salaries.every(validSalary)));
}

export async function storeDesk(env, desk) {
  await putSealedJson(env, DESK_KEY, { recruits: desk.recruits, salaries: desk.salaries || [], updated: Date.now() });
}

export async function readDesk(env) {
  const desk = await getSealedJson(env, DESK_KEY);
  return validDesk(desk) ? desk : null;
}

// What `me` may see of the desk: only the recruits they can see, and no fees unless they are an admin or a manager.
export function forViewer(desk, me, profiles) {
  if (!desk) return null;
  const seen = new Set(profiles.filter((p) => canSee(me, p)).map((p) => p.id));
  const recruits = {};
  for (const [u, ranges] of Object.entries(desk.recruits)) {
    if (!seen.has(u)) continue;
    recruits[u] = Object.fromEntries(Object.entries(ranges).map(([r, l]) =>
      [r, oversees(me) ? l : Object.fromEntries(COUNTS.map((k) => [k, l[k]]))]));
  }
  return { recruits, salaries: desk.salaries || [], updated: desk.updated };
}

// ------------------------------------------------------------------------- the page

function addFees(into, fees) {
  for (const [c, v] of Object.entries(fees || {})) into[c] = (into[c] || 0) + v;
  return into;
}

function money(fees) {
  const parts = Object.entries(fees).filter(([, v]) => v > 0).sort(([a], [b]) => a.localeCompare(b))
    .map(([c, v]) => `${esc(currencySymbol(currencyCode(c)) || `${c} `)}${Math.round(v).toLocaleString("en-GB")}`);
  return parts.length ? parts.join(" &middot; ") : "&ndash;";
}

function total(lines) {
  const sum = Object.fromEntries(COUNTS.map((k) => [k, 0]));
  sum.fees = {};
  for (const l of lines) {
    if (!l) continue;
    for (const k of COUNTS) sum[k] += l[k];
    addFees(sum.fees, l.fees);
  }
  return sum;
}

function cells(l, admin) {
  return `${COUNTS.map((k) => `<td>${l ? l[k] : "&ndash;"}</td>`).join("")}${admin ? `<td class="fee">${l ? money(l.fees || {}) : "&ndash;"}</td>` : ""}`;
}

function rangeTabs(range) {
  return `<nav class="tabs" aria-label="Time range">${Object.entries(RANGES).map(([r, label]) =>
    `<a href="${DESK_URL}?r=${r}"${Number(r) === range ? ' class="on" aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

// `people`: everyone who can have recruits ([{id, name}], users.recruiters); `rangeParam` the ?r= asked for.
export function deskPage(status, desk, me, people, rangeParam) {
  const range = RANGES[rangeParam] ? Number(rangeParam) : DEFAULT_RANGE;
  const profiles = status.profiles || [];
  const view = forViewer(desk, me, profiles);
  const mine = profiles.filter((p) => canSee(me, p));
  const names = new Map(people.map((r) => [r.id, r.name]));
  const groups = new Map();
  for (const p of mine) {
    const id = recruiterOf(p);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(p);
  }
  const order = [...groups.keys()].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) ||
    String(names.get(a) || a).localeCompare(String(names.get(b) || b)));
  const line = (p) => view?.recruits[p.id]?.[String(range)] || null;
  const all = total(mine.map(line));
  const fees = oversees(me);
  const head = `<tr><th scope="col">Recruit</th>${COUNTS.map((k) => `<th scope="col">${LABELS[k]}</th>`).join("")}${fees ? '<th scope="col">Fees</th>' : ""}</tr>`;
  const sections = order.map((id) => {
    const group = groups.get(id).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    const label = id ? names.get(id) || "A removed recruiter" : "No recruiter";
    const rows = group.map((p) => `<tr><th scope="row"><a href="${STATS_URL}?u=${esc(p.id)}&amp;r=${range}">${esc(p.name || p.id)}</a>
<a class="small" href="${SENT_URL}?u=${esc(p.id)}">Jobs sent</a></th>${cells(line(p), fees)}</tr>`).join("");
    return `<section class="card deskgroup"><h3>${esc(label)}<span>${group.length} recruit${group.length === 1 ? "" : "s"}</span></h3>
<div class="tablewrap"><table class="desk"><thead>${head}</thead><tbody>${rows}</tbody>
<tfoot><tr><th scope="row">Total</th>${cells(total(group.map(line)), fees)}</tr></tfoot></table></div></section>`;
  }).join("");
  const tiles = [...COUNTS.map((k) => [LABELS[k], String(all[k])]), ...(fees ? [["Fees from placements", money(all.fees)]] : [])]
    .map(([label, value]) => `<div class="dtile"><b>${value}</b><span>${esc(label)}</span></div>`).join("");
  const updated = view?.updated ? `<span class="muted">Updated ${esc(ago(view.updated))}</span>` : "";
  const waiting = !view ? '<p class="note ok" role="status">HermitShell sends the desk within 30 minutes of its next check-in once it runs this version. Until then every number shows as a dash.</p>' : "";
  const empty = mine.length ? "" : `<p class="muted">${me.admin ? "No recruits yet." : me.manager ? "Your team has no recruits yet." : "You have no recruits yet."}</p>`;
  const scope = me.admin ? "Every recruiter's recruits, grouped by recruiter. Fees are the placements' fees, by currency."
    : me.manager ? "Your team's recruits, grouped by recruiter. Fees are the placements' fees, by currency." : "Your recruits only.";
  return page("Desk", `<style>${DESK_STYLE}</style>${nav("desk", navFor(me))}${waiting}
<div class="statbar">${rangeTabs(range)}${updated}</div>
<p class="muted small">${scope} Sent counts the jobs emailed; Applied to Placed count each job once, in the period it reached that stage.</p>
<div class="dtiles">${tiles}</div>${empty}${sections}
<section class="card"><h3>Salaries by job title across the desk<span>last 90 days</span></h3>${salaryList(view?.salaries)}
<p class="muted small">The median of each advert's lowest yearly figure, across every recruit's jobs rated, in each recruit's own currency.
A title shows only once ${SALARY_MIN_N} jobs give a salary.</p></section>`, { wide: true });
}

const DESK_STYLE = `
.statbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.dtiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:12px 0 16px}
.dtile{background:#fff;border:1px solid var(--line);border-radius:16px;padding:12px 14px;display:grid;gap:2px}
.dtile b{font-size:24px;font-weight:800;letter-spacing:-.02em;color:var(--ink)}
.dtile span{font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:16px 18px;margin:14px 0}
.card h3{display:flex;align-items:baseline;gap:10px;margin:0 0 12px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#475569}
.card h3 span{font-size:12px;letter-spacing:0;text-transform:none;color:var(--muted);font-weight:600}
.tablewrap{overflow-x:auto}
table.desk{width:100%;min-width:620px;border-collapse:collapse;font-size:13.5px;table-layout:fixed}
table.desk thead th:first-child{width:32%}
table.desk th,table.desk td{padding:8px 10px;text-align:right;border-top:1px solid #eef0f5;white-space:nowrap}
table.desk thead th{border-top:0;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
table.desk th[scope=row]{text-align:left;font-weight:650}table.desk th[scope=row] .small{margin-left:8px;font-weight:500}
table.desk thead th:first-child{text-align:left}
table.desk tfoot th,table.desk tfoot td{font-weight:800;color:var(--ink);border-top:2px solid var(--line)}
table.desk .fee{color:#047857;font-weight:700}
.toplist{list-style:none;padding:0;margin:0;display:grid;gap:9px}
.toplist li{display:grid;grid-template-columns:minmax(0,1.6fr) 1fr 56px;gap:10px;align-items:center;font-size:13px}
.toplist .name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);font-weight:600}.toplist b{text-align:right}
.track{display:block;height:12px;border-radius:99px;background:#f1f3f9;overflow:hidden}
.fillbar{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#059669,#6ee7b7)}
`;

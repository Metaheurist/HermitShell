// The desk (/admin/desk): what each recruiter's recruits have done in the last 7 days, 30 days, 90 days or 12
// months, and the salaries by job title across the desk. HermitShell sends every recruit's totals in one upload
// (profiles.py push_desk; POST /api/desk), at most every 30 minutes, and it is kept sealed as "stats:desk" because
// it holds placement fees. Admins see every recruiter's recruits and the fees, a manager their team's recruits and
// fees; a recruiter sees only their own recruits and never a fee: fees are taken out before the page is drawn. Admins
// and managers get the funnel, the recruiters ranked (and an admin the teams, each a filter), then each recruiter's
// recruits, furthest along first, in a group that folds away once there are many.

import { currencyCode, currencySymbol } from "./currency.js";
import { PROFILE_RE, ago, esc, page } from "./lib.js";
import { nav } from "./settings.js";
import { DEFAULT_RANGE, RANGES, SALARY_MIN_N, SENT_URL, STATS_URL, salaryList } from "./stats.js";
import { canSee, initials, navFor, oversees, ownsRecruiter, recruiterOf } from "./users.js";
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

const STAGES = [["placed", "Placed"], ["offer", "Offer"], ["interview", "Interviewing"], ["applied", "Applied"], ["sent", "Jobs sent"]];
const SORTS = { placed: "Placed", offer: "Offers", interview: "Interviews", applied: "Applied", sent: "Sent", recruits: "Recruits", name: "Name" };
const DEFAULT_SORT = "placed";
const NO_TEAM = "none";
// One colour per team, in the order of their managers' names; recruiters in no team are slate.
const TEAM_COLOURS = ["#6366f1", "#0891b2", "#d97706", "#db2777", "#059669", "#7c3aed", "#dc2626", "#0d9488"];
const LONE = "#64748b";
// Recruiters' groups start closed once there are more than this many, so a big desk stays a page you can scan.
const OPEN_UP_TO = 3;

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

const pct = (n, of) => {
  if (!of) return "&ndash;";
  const p = (n / of) * 100;
  return `${p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)}%`;
};

// How far a recruit has got: the furthest stage any of their jobs reached in the period.
function stageOf(l) {
  if (!l) return ["none", "No data yet"];
  return STAGES.find(([k]) => l[k] > 0) || ["idle", "No activity"];
}

// Furthest along first: more placed, then offers, interviews, applied and sent; no data last.
function byProgress(a, b) {
  if (!a || !b) return (a ? 0 : 1) - (b ? 0 : 1);
  for (const k of ["placed", "offer", "interview", "applied", "sent"]) if (a[k] !== b[k]) return b[k] - a[k];
  return 0;
}

function cells(l, fees, tops = null) {
  return `${COUNTS.map((k) => `<td${tops && l && tops[k] && l[k] === tops[k] ? ' class="top"' : ""}>${l ? l[k] : "&ndash;"}</td>`).join("")}${
    fees ? `<td class="fee">${l ? money(l.fees || {}) : "&ndash;"}</td>` : ""}`;
}

const avatar = (name, colour) => `<span class="davatar" style="--team:${colour}" aria-hidden="true">${esc(initials(name))}</span>`;
const teamChip = (name, colour) => `<span class="teamchip" style="--team:${colour}">${esc(name)}&rsquo;s team</span>`;

function funnel(all, fees) {
  const steps = [["sent", "Sent", "jobs emailed"], ["applied", "Applied", `${pct(all.applied, all.sent)} of sent`],
    ["interview", "Interviews", `${pct(all.interview, all.applied)} of applied`], ["offer", "Offers", `${pct(all.offer, all.interview)} of interviews`],
    ["placed", "Placed", `${pct(all.placed, all.offer)} of offers`]];
  return `<div class="funnel">${steps.map(([k, label, rate]) => `<div class="fstep st-${k}"><b>${all[k]}</b><span>${label}</span><em>${rate}</em></div>`).join("")}${
    fees ? `<div class="fstep st-money"><b>${money(all.fees)}</b><span>Fees from placements</span><em>by currency</em></div>` : ""}</div>`;
}

// `people`: everyone who can have recruits ([{id, name}], users.recruiters); `rangeParam` the ?r= asked for. `opts`:
// the ?team=, ?sort= and ?rec= asked for, and `org`, the teams (users.teams), so an admin sees the desk by team.
export function deskPage(status, desk, me, people, rangeParam, { team: teamParam = "", sort: sortParam = "", rec: recParam = "", org } = {}) {
  const range = RANGES[rangeParam] ? Number(rangeParam) : DEFAULT_RANGE;
  const sort = Object.hasOwn(SORTS, sortParam) ? sortParam : DEFAULT_SORT;
  const managers = org?.managers || new Map();
  const leads = org?.leads || new Map();
  const teamIds = [...managers.keys()].sort((a, b) => String(managers.get(a)).localeCompare(String(managers.get(b))));
  const colourOf = (lead) => (lead && managers.has(lead) ? TEAM_COLOURS[teamIds.indexOf(lead) % TEAM_COLOURS.length] : LONE);
  const leadOf = (recId) => leads.get(recId) || "";
  const byTeam = me.admin && teamIds.length > 0;
  const team = byTeam && (managers.has(teamParam) || (teamParam === NO_TEAM)) ? teamParam : "";
  const inTeam = (recId) => !team || (team === NO_TEAM ? !managers.has(leadOf(recId)) : leadOf(recId) === team);
  const fees = oversees(me);
  const profiles = status.profiles || [];
  const view = forViewer(desk, me, profiles);
  const visible = profiles.filter((p) => canSee(me, p));
  const mine = visible.filter((p) => inTeam(recruiterOf(p)));
  const names = new Map(people.map((r) => [r.id, r.name]));
  const line = (p) => view?.recruits[p.id]?.[String(range)] || null;
  const labelOf = (id) => (id ? names.get(id) || "A removed recruiter" : "No recruiter");
  const href = (o = {}) => esc(`${DESK_URL}?${new URLSearchParams(Object.entries({ r: String(range), team, sort: sort === DEFAULT_SORT ? "" : sort, ...o })
    .filter(([, v]) => v)).toString()}`);

  const groups = new Map();
  if (fees) for (const r of people) if (ownsRecruiter(me, r.id) && inTeam(r.id)) groups.set(r.id, []);
  for (const p of mine) {
    const id = recruiterOf(p);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(p);
  }
  const rows = [...groups].map(([id, list]) => ({ id, name: labelOf(id), lead: leadOf(id), list, sum: total(list.map(line)),
    idle: list.filter((p) => ["none", "idle"].includes(stageOf(line(p))[0])).length }));
  const ranked = rows.filter((r) => r.id && names.has(r.id));
  const rest = rows.filter((r) => !(r.id && names.has(r.id))).sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1));
  ranked.sort((a, b) => (sort === "name" ? 0 : sort === "recruits" ? b.list.length - a.list.length
    : b.sum[sort] - a.sum[sort] || byProgress(a.sum, b.sum)) || a.name.localeCompare(b.name));
  const all = total(mine.map(line));

  const teamCards = byTeam ? (() => {
    const cards = [...teamIds, NO_TEAM].map((id) => {
      const recs = visible.filter((p) => (id === NO_TEAM ? !managers.has(leadOf(recruiterOf(p))) : leadOf(recruiterOf(p)) === id));
      const crew = people.filter((r) => (id === NO_TEAM ? !managers.has(leadOf(r.id)) : leadOf(r.id) === id)).length;
      if (id === NO_TEAM && !recs.length && !crew) return "";
      const sum = total(recs.map(line));
      const title = id === NO_TEAM ? "No team" : `${managers.get(id)}&rsquo;s team`;
      const colour = id === NO_TEAM ? LONE : colourOf(id);
      return `<a class="teamcard${team === id ? " on" : ""}" href="${href({ team: team === id ? "" : id, rec: "" })}" style="--team:${colour}"${team === id ? ' aria-current="true"' : ""}>
<span class="thead">${avatar(id === NO_TEAM ? "No team" : managers.get(id), colour)}<span><b>${id === NO_TEAM ? title : `${esc(managers.get(id))}&rsquo;s team`}</b>
<small>${crew} recruiter${crew === 1 ? "" : "s"} &middot; ${recs.length} recruit${recs.length === 1 ? "" : "s"}</small></span></span>
<span class="tnums"><span><b>${sum.interview}</b>interviews</span><span><b>${sum.offer}</b>offers</span><span><b>${sum.placed}</b>placed</span></span>
${fees ? `<span class="tfee">${money(sum.fees)}</span>` : ""}</a>`;
    }).join("");
    return `<section class="card"><h3>Teams<span>${team ? `<a href="${href({ team: "", rec: "" })}">Show every team</a>` : "press a team to see only theirs"}</span></h3>
<div class="teamcards">${cards}</div></section>`;
  })() : "";

  const tops = Object.fromEntries(COUNTS.map((k) => [k, ranked.length > 1 ? Math.max(0, ...ranked.map((r) => r.sum[k])) : 0]));
  const sortHead = (key, label) => `<th scope="col"${sort === key ? ` aria-sort="${key === "name" ? "ascending" : "descending"}" class="sorted"` : ""}><a href="${href({ sort: key === DEFAULT_SORT ? "" : key, rec: "" })}">${label}</a></th>`;
  const board = fees && rows.length ? `<section class="card"><h3>Recruiters<span>${ranked.length} ranked by ${SORTS[sort].toLowerCase()}; press a column to rank by it</span></h3>
<div class="tablewrap"><table class="desk board"><thead><tr><th scope="col" class="rank">#</th>${sortHead("name", "Recruiter")}${sortHead("recruits", "Recruits")}${
  COUNTS.map((k) => sortHead(k, LABELS[k])).join("")}<th scope="col">Fees</th></tr></thead><tbody>${[...ranked, ...rest].map((r, i) => {
    const colour = colourOf(r.lead);
    const chip = byTeam && managers.has(r.lead) && !team ? ` ${teamChip(managers.get(r.lead), colour)}` : "";
    const rank = i < ranked.length ? `<span class="rk${i < 3 && r.sum.placed + r.sum.offer + r.sum.interview > 0 && sort !== "name" ? ` r${i + 1}` : ""}">${i + 1}</span>` : "";
    const who = r.list.length ? `<a href="${href({ rec: r.id || NO_TEAM })}#rec-${esc(r.id || NO_TEAM)}">${esc(r.name)}</a>` : esc(r.name);
    return `<tr${i < ranked.length ? "" : ' class="quiet"'}><td class="rank">${rank}</td><th scope="row"><span class="who">${avatar(r.name, colour)}<span>${who}${chip}</span></span></th>
<td>${r.list.length}</td>${cells(r.sum, true, i < ranked.length ? tops : null)}</tr>`;
  }).join("")}</tbody>
<tfoot><tr><td></td><th scope="row">Total</th><td>${mine.length}</td>${cells(all, true)}</tr></tfoot></table></div></section>` : "";

  const head = `<tr><th scope="col">Recruit</th><th scope="col" class="stagecol">Furthest stage</th>${COUNTS.map((k) => `<th scope="col">${LABELS[k]}</th>`).join("")}${fees ? '<th scope="col">Fees</th>' : ""}</tr>`;
  const withRecruits = [...ranked, ...rest].filter((r) => r.list.length);
  const sections = withRecruits.map((r) => {
    const key = r.id || NO_TEAM;
    const open = !fees || withRecruits.length <= OPEN_UP_TO || recParam === key;
    const colour = colourOf(r.lead);
    const list = r.list.slice().sort((a, b) => byProgress(line(a), line(b)) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
    const body = list.map((p) => {
      const l = line(p);
      const [stage, said] = stageOf(l);
      return `<tr${stage === "none" || stage === "idle" ? ' class="quiet"' : ""}><th scope="row"><a href="${STATS_URL}?u=${esc(p.id)}&amp;r=${range}">${esc(p.name || p.id)}</a>
<a class="small" href="${SENT_URL}?u=${esc(p.id)}">Jobs sent</a></th><td class="stagecol"><span class="stage st-${stage}">${said}</span></td>${cells(l, fees)}</tr>`;
    }).join("");
    const chip = byTeam && managers.has(r.lead) && !team ? teamChip(managers.get(r.lead), colour) : "";
    const idle = r.idle ? ` &middot; ${r.idle} with no activity` : "";
    return `<details class="deskgroup" id="rec-${esc(key)}"${open ? " open" : ""}><summary><span class="who">${avatar(r.name, colour)}<span><b>${esc(r.name)}</b>${chip}
<small>${r.list.length} recruit${r.list.length === 1 ? "" : "s"}${idle}</small></span></span>
<span class="sumnums"><span><b>${r.sum.interview}</b>interviews</span><span><b>${r.sum.offer}</b>offers</span><span><b>${r.sum.placed}</b>placed</span>${
  fees ? `<span class="fee">${money(r.sum.fees)}</span>` : ""}</span></summary>
<div class="tablewrap"><table class="desk"><thead>${head}</thead><tbody>${body}</tbody>
<tfoot><tr><th scope="row">Total</th><td class="stagecol"></td>${cells(r.sum, fees)}</tr></tfoot></table></div></details>`;
  }).join("");

  const updated = view?.updated ? `<span class="muted">Updated ${esc(ago(view.updated))}</span>` : "";
  const waiting = !view ? '<p class="note ok" role="status">The numbers appear within about 30 minutes. Until then they show as a dash.</p>' : "";
  const empty = mine.length ? "" : `<p class="muted">${team ? "This team has no recruits yet." : me.admin ? "No recruits yet." : me.manager ? "Your team has no recruits yet." : "You have no recruits yet."}</p>`;
  const scope = me.admin ? "Every recruiter's recruits, grouped by recruiter. Fees are the placements' fees, by currency."
    : me.manager ? "Your team's recruits, grouped by recruiter. Fees are the placements' fees, by currency." : "Your recruits only.";
  const showing = team ? `<p class="showing" style="--team:${team === NO_TEAM ? LONE : colourOf(team)}">Showing <b>${team === NO_TEAM ? "recruiters in no team" : `${esc(managers.get(team))}&rsquo;s team`}</b>
<a href="${href({ team: "", rec: "" })}">Show every team</a></p>` : "";
  return page("Desk", `<style>${DESK_STYLE}</style>${nav("desk", navFor(me))}${waiting}
<div class="statbar">${rangeTabs(range, href)}${updated}</div>
<p class="muted small">${scope} Sent counts the jobs emailed; Applied to Placed count each job once, in the period it reached that stage.</p>
${showing}${funnel(all, fees)}${teamCards}${board}${empty}${sections ? `${fees ? `<h2 class="dh">Recruits by recruiter<span>${withRecruits.length > OPEN_UP_TO ? "press a recruiter to open their recruits" : ""}</span></h2>` : ""}${sections}` : ""}
<section class="card"><h3>Salaries by job title across the desk<span>last 90 days</span></h3>${salaryList(view?.salaries)}
<p class="muted small">The median of each advert's lowest yearly figure, across every recruit's jobs rated, in each recruit's own currency.
A title shows only once ${SALARY_MIN_N} jobs give a salary.</p></section>`, { wide: fees ? "full" : true });
}

function rangeTabs(range, href) {
  return `<nav class="tabs" aria-label="Time range">${Object.entries(RANGES).map(([r, label]) =>
    `<a href="${href({ r, rec: "" })}"${Number(r) === range ? ' class="on" aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

const DESK_STYLE = `
.statbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.funnel{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px;margin:12px 0 16px}
.fstep{position:relative;background:#fff;border:1px solid var(--line);border-radius:16px;padding:12px 14px 11px;display:grid;gap:1px;overflow:hidden;
--st:#64748b}
.fstep::before{content:"";position:absolute;inset:0 0 auto;height:4px;background:var(--st)}
.fstep b{font-size:24px;font-weight:800;letter-spacing:-.02em;color:var(--ink);font-variant-numeric:tabular-nums}
.fstep span{font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.fstep em{font-style:normal;font-size:12px;font-weight:650;color:var(--st)}
.st-applied{--st:#2563eb}.st-interview{--st:#6366f1}.st-offer{--st:#d97706}.st-placed{--st:#059669}.st-money{--st:#047857}
.fstep.st-money b{color:#047857}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:16px 18px;margin:14px 0}
.card h3,h2.dh{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;margin:0 0 12px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#475569}
h2.dh{margin:22px 2px 8px}
.card h3 span,h2.dh span{font-size:12px;letter-spacing:0;text-transform:none;color:var(--muted);font-weight:600}
.davatar{flex:none;width:30px;height:30px;border-radius:10px;display:grid;place-items:center;color:#fff;font-size:11.5px;font-weight:800;
background:var(--team);box-shadow:0 5px 12px -7px var(--team)}
.who{display:flex;align-items:center;gap:10px;min-width:0}.who>span{min-width:0}
.who small{display:block;font-size:12px;font-weight:550;color:var(--muted)}
.teamchip{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:99px;font-size:11px;font-weight:700;white-space:nowrap;
color:var(--team);background:color-mix(in srgb,var(--team) 12%,#fff)}
.teamcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
a.teamcard{display:grid;gap:10px;padding:12px 14px;border:1px solid var(--line);border-left:4px solid var(--team);border-radius:14px;
color:var(--ink);text-decoration:none;background:#fff;transition:transform .2s var(--ease),box-shadow .2s,background .2s}
a.teamcard:hover{transform:translateY(-1px);box-shadow:0 10px 24px -16px rgba(15,23,42,.45)}
a.teamcard.on{background:color-mix(in srgb,var(--team) 7%,#fff);box-shadow:0 0 0 2px var(--team) inset}
.teamcard .thead{display:flex;align-items:center;gap:10px}.teamcard .thead b{font-size:14px}
.teamcard small{display:block;font-size:12px;color:var(--muted)}
.tnums,.sumnums{display:flex;gap:14px;font-size:12px;color:var(--muted);font-weight:600}
.tnums b,.sumnums b{display:block;font-size:17px;font-weight:800;color:var(--ink);font-variant-numeric:tabular-nums}
.tfee{font-size:13px;font-weight:750;color:#047857}
.showing{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0 0;padding:8px 12px;border-radius:12px;font-size:13px;
background:color-mix(in srgb,var(--team) 9%,#fff);border-left:4px solid var(--team)}
.tablewrap{overflow-x:auto}
table.desk{width:100%;min-width:640px;border-collapse:collapse;font-size:13.5px;table-layout:fixed;font-variant-numeric:tabular-nums}
table.desk thead th:first-child{width:30%}
table.desk.board{min-width:760px}table.desk.board thead th:nth-child(2){width:30%}table.desk.board .rank{width:38px;text-align:center}
table.desk th,table.desk td{padding:8px 10px;text-align:right;border-top:1px solid #eef0f5;white-space:nowrap}
table.desk thead th{border-top:0;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
table.desk thead th a{color:inherit;text-decoration:none}table.desk thead th a:hover{color:var(--brand-ink);text-decoration:underline}
table.desk thead th.sorted{color:var(--brand-ink)}table.desk thead th.sorted a::after{content:" \\2193"}
table.desk thead th.sorted[aria-sort=ascending] a::after{content:" \\2191"}
table.desk th[scope=row]{text-align:left;font-weight:650;overflow:hidden;text-overflow:ellipsis}
table.desk th[scope=row] .small{margin-left:8px;font-weight:500}
table.desk thead th:first-child,table.desk.board thead th:nth-child(2){text-align:left}
table.desk tfoot th,table.desk tfoot td{font-weight:800;color:var(--ink);border-top:2px solid var(--line)}
table.desk .fee{color:#047857;font-weight:700}
table.desk td.top{color:#047857;font-weight:800}
table.desk tbody tr:hover td,table.desk tbody tr:hover th{background:#f8f9fe}
table.desk tr.quiet td,table.desk tr.quiet th{color:#94a3b8}table.desk tr.quiet th a{color:#64748b}
table.desk .stagecol{width:118px;text-align:left}
.rk{display:inline-grid;place-items:center;min-width:24px;height:24px;border-radius:8px;font-size:12px;font-weight:800;color:var(--muted);background:#f1f3f9}
.rk.r1{color:#fff;background:linear-gradient(135deg,#f59e0b,#d97706)}.rk.r2{color:#fff;background:linear-gradient(135deg,#94a3b8,#64748b)}
.rk.r3{color:#fff;background:linear-gradient(135deg,#d6a77a,#b45309)}
.stage{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11.5px;font-weight:700;color:var(--st);
background:color-mix(in srgb,var(--st) 12%,#fff)}
.stage.st-sent{--st:#475569}.stage.st-idle,.stage.st-none{--st:#94a3b8;background:#f4f5f9}
details.deskgroup{background:#fff;border:1px solid var(--line);border-radius:16px;margin:8px 0;overflow:hidden}
details.deskgroup>summary{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:12px 16px;cursor:pointer;
list-style:none}
details.deskgroup>summary::-webkit-details-marker{display:none}
details.deskgroup>summary::after{content:"";flex:none;width:8px;height:8px;margin-left:4px;border:solid var(--muted);border-width:0 2px 2px 0;
transform:rotate(45deg);transition:transform .2s var(--ease)}
details.deskgroup[open]>summary::after{transform:rotate(225deg)}
details.deskgroup>summary:hover{background:#fafbff}
details.deskgroup>summary .who{flex:1 1 240px}
details.deskgroup>summary .sumnums{margin-left:auto;align-items:center}
details.deskgroup>summary .sumnums>span{min-width:62px}
details.deskgroup>summary .fee{min-width:84px;text-align:right;font-size:13px;font-weight:750;color:#047857}
details.deskgroup .tablewrap{padding:0 16px 10px;border-top:1px solid #eef0f5}
details.deskgroup:target{box-shadow:0 0 0 2px var(--brand) inset}
.toplist{list-style:none;padding:0;margin:0;display:grid;gap:9px}
.toplist li{display:grid;grid-template-columns:minmax(0,1.6fr) 1fr 56px;gap:10px;align-items:center;font-size:13px}
.toplist .name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);font-weight:600}.toplist b{text-align:right}
.track{display:block;height:12px;border-radius:99px;background:#f1f3f9;overflow:hidden}
.fillbar{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#059669,#6ee7b7)}
@media (max-width:640px){.sumnums{gap:10px}.tnums b,.sumnums b{font-size:15px}}
`;

// Recruit search on the dashboard. Pages run no JavaScript, so the search button is a label for the field: a
// click focuses it and :focus-within slides it open, with a status dropdown beside it. Enter sends ?q= (and ?s=,
// the status) and the Worker lists only the recruits whose name, email, id, place or tags, or their recruiter's
// name or username, contain every word and who have that status. A recruiter the words point at is listed first,
// as a row of its own, followed by their recruits: "sam job" lists the recruiter Sam Job and all of their
// recruits, "sam job riley" only Riley under Sam Job. Picking a status sends the form by itself where scripts run;
// without them a Show button appears once the pick differs from the one the page was sent with. Retired recruits
// are left out unless Retired is picked, so the list stays the people being worked with.

import { esc } from "./lib.js";

export const MAX_QUERY = 60;

export const STATUSES = {
  active: { label: "Active", match: (p) => !p.pending && p.status === "active" },
  paused: { label: "Paused", match: (p) => !p.pending && p.status === "paused" },
  scanning: { label: "Finding jobs now", match: (p) => !p.pending && Boolean(p.scanning) },
  nocv: { label: "No CV", match: (p) => !p.pending && p.has_cv === false },
  pending: { label: "Pending sign-up", match: (p) => Boolean(p.pending) },
  retired: { label: "Retired", match: (p) => !p.pending && p.status === "retired" },
};

export function searchQuery(url) {
  return String(url.searchParams.get("q") || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
    .slice(0, MAX_QUERY);
}

export function statusQuery(url) {
  const s = String(url.searchParams.get("s") || "");
  return Object.hasOwn(STATUSES, s) ? s : "";
}

export function matchesStatus(p, s) {
  return s === "retired" ? STATUSES.retired.match(p) : p.status !== "retired" && (!s || STATUSES[s].match(p));
}

const words = (q) => q.toLowerCase().split(" ").filter(Boolean);

// `recruiter` is the recruit's recruiter ({ name, username }), if they have one.
export function matchesProfile(p, q, recruiter = null) {
  if (!q) return true;
  const text = [p.name, p.email, p.id, p.details?.location, recruiter?.name, recruiter?.username, ...(p.tags || [])]
    .map((v) => String(v || "")).join(" ").toLowerCase();
  return words(q).every((word) => text.includes(word));
}

function recruiterText(r) {
  return [r.name, r.username, "recruiter"].map((v) => String(v || "")).join(" ").toLowerCase();
}

// The recruiters to list first: every word matches them, or some word does and a recruit of theirs is listed.
export function recruiterHits(recruiters, q, listedRecruiterIds) {
  if (!q) return [];
  return recruiters.filter((r) => {
    const text = recruiterText(r);
    const hits = words(q).filter((w) => text.includes(w));
    return hits.length && (hits.length === words(q).length || listedRecruiterIds.has(r.id));
  });
}

export function recruiterRow(r, total) {
  return `<tr class="recrow"><td colspan="4"><div class="who"><span class="avatar rec" aria-hidden="true">${esc(initialsOf(r.name))}</span><div>
<b>${esc(r.name)}</b> <span class="role recruiter">Recruiter</span><div class="muted"><code>${esc(r.username)}</code> &middot; ${total} recruit${total === 1 ? "" : "s"}</div></div></div></td></tr>`;
}

function initialsOf(name) {
  const parts = String(name || "").match(/\p{L}[\p{L}'-]*/gu) || [];
  return (parts.length > 1 ? parts[0][0] + parts.at(-1)[0] : (parts[0] || "?").slice(0, 2)).toUpperCase();
}

const LENS = `<svg class="lens" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
<circle class="glass" cx="10.5" cy="10.5" r="6.5"/><path class="shine" d="M7.4 9.2a3.4 3.4 0 0 1 2.4-2.3" pathLength="1"/><path d="m15.4 15.4 4.6 4.6"/></svg>`;

// `total` counts the recruits not retired, and `retired` the others, linked to when they are left out.
export function searchBar(q, shown, total, tools = "", status = "", retired = 0) {
  const narrowed = q || status;
  const [of, noun] = status === "retired" ? [retired, "retired"] : [total, `recruit${total === 1 ? "" : "s"}`];
  const count = (narrowed ? `${shown} of ${of} ${noun}` : `${of} ${noun}`)
    + (retired && status !== "retired" ? ` <a class="retiredlink" href="/admin?s=retired">${retired} retired</a>` : "");
  const options = [["", "Any status"], ...Object.entries(STATUSES).map(([k, v]) => [k, v.label])]
    .map(([k, label]) => `<option value="${k}"${k === status ? " selected" : ""}>${label}</option>`).join("");
  return `<div class="tabletools"><span class="count">${count}</span><div class="tools">${tools}
<form class="search${narrowed ? " open" : ""}" method="get" action="/admin" role="search">
<select id="status-filter" name="s" aria-label="Status">${options}</select><button class="sgo">Show</button>
<input id="profile-search" type="search" name="q" value="${esc(q)}" maxlength="${MAX_QUERY}" autocomplete="off"
placeholder="Name, email, place, recruiter or tag, then Enter" aria-label="Search recruits">
${narrowed ? '<a class="clear" href="/admin" aria-label="Clear the search">&times;</a>' : ""}
<label for="profile-search" class="searchbtn" title="Search recruits">${LENS}</label></form></div></div>`;
}

export function noMatch(q, status = "") {
  const what = [q && `&ldquo;${esc(q)}&rdquo;`, status && STATUSES[status] ? STATUSES[status].label.toLowerCase() : ""]
    .filter(Boolean).join(" and ");
  return `<tr><td colspan="4"><div class="nomatch">${LENS}<div><b>No recruit matches ${what}</b>
<div class="muted"><a href="/admin">Show everyone</a></div></div></div></td></tr>`;
}

export const SEARCH_STYLE = `
.tabletools{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:22px 0 10px}
.tabletools .count{font-size:12px;font-weight:650;color:var(--muted);background:#f0f2f8;border-radius:99px;padding:4px 12px}
.tabletools .retiredlink{margin-left:6px;color:#64748b;text-decoration:underline dotted;text-underline-offset:3px}
form.search{display:flex;align-items:center;gap:10px;margin:0;position:relative}
#profile-search{width:0;min-width:0;height:40px;box-sizing:border-box;padding:0;border-color:transparent;background:transparent;opacity:0;
border-radius:13px;transition:width .35s var(--ease),padding .35s var(--ease),opacity .25s,border-color .2s,background .2s}
form.search:focus-within #profile-search,form.search.open #profile-search,form.search:has(#profile-search:not(:placeholder-shown)) #profile-search{
width:360px;max-width:62vw;padding:0 18px;opacity:1;border-color:var(--line);background:var(--field)}
form.search.open #profile-search{padding-right:42px}
form.search:focus-within #profile-search{border-color:var(--brand);background:#fff;box-shadow:0 0 0 4px rgba(99,102,241,.15)}
#profile-search::-webkit-search-cancel-button{display:none}
#status-filter{width:0;min-width:0;max-width:none;height:40px;box-sizing:border-box;margin:0;padding:0;border-color:transparent;background:transparent;
opacity:0;border-radius:13px;font-size:13.5px;font-weight:600;cursor:pointer;
transition:width .35s var(--ease),padding .35s var(--ease),opacity .25s,border-color .2s,background .2s}
form.search:focus-within #status-filter,form.search.open #status-filter,form.search:has(#profile-search:not(:placeholder-shown)) #status-filter{
width:156px;padding:0 12px;opacity:1;border-color:var(--line);background:var(--field)}
#status-filter:focus{border-color:var(--brand);background:#fff;box-shadow:0 0 0 4px rgba(99,102,241,.15)}
form.search .sgo{display:none;flex:none;height:40px;margin:0;padding:0 14px;border-radius:13px;font-size:13.5px}
@supports selector(:has(a)){form.search:has(#status-filter option:checked:not([selected])) .sgo{display:inline-block}}
@supports not selector(:has(a)){form.search:focus-within .sgo,form.search.open .sgo{display:inline-block}}
@media (max-width:640px){.tabletools{flex-wrap:wrap}.tabletools .tools{flex:1;min-width:0;flex-wrap:wrap;justify-content:flex-end}
.tabletools:has(form.search:focus-within) .tools,.tabletools:has(form.search.open) .tools{flex-basis:100%}
form.search:focus-within,form.search.open{flex:1 1 100%;min-width:0}
form.search:focus-within #status-filter,form.search.open #status-filter{flex:none;width:118px}
form.search:focus-within #profile-search,form.search.open #profile-search{flex:1 1 0;width:0;max-width:none}}
.searchbtn{flex:none;margin:0;width:40px;height:40px;border-radius:13px;display:grid;place-items:center;cursor:pointer;
color:var(--brand-ink);background:var(--soft);transition:transform .2s var(--ease),background .2s,color .2s,box-shadow .2s}
.searchbtn:hover{transform:translateY(-1px) scale(1.06);background:#e2e5ff}
form.search:focus-within .searchbtn,form.search.open .searchbtn{color:#fff;background:linear-gradient(135deg,var(--brand),var(--brand2));
box-shadow:0 8px 18px -8px rgba(99,102,241,.9)}
.lens{width:20px;height:20px;animation:peek 3.2s var(--ease) infinite;transform-origin:45% 45%}
.lens .shine{stroke-dasharray:1;animation:glint 3.2s ease-in-out infinite}
.searchbtn:hover .lens{animation-duration:1.2s}
form.search .clear{position:absolute;right:58px;width:26px;height:26px;display:grid;place-items:center;border-radius:8px;
font-size:18px;line-height:1;color:var(--muted);text-decoration:none}.clear:hover{background:#eef0f6;color:var(--ink)}
.nomatch{display:flex;gap:14px;align-items:center;padding:10px 0;color:var(--brand-ink)}
tr.recrow td{background:linear-gradient(90deg,#ecfeff,rgba(236,254,255,0));border-top:1px solid #a5f3fc}
tr.recrow:hover td{background:linear-gradient(90deg,#cffafe,rgba(236,254,255,0))}
tr.recrow .avatar.rec,tr.recrow ~ tr .avatar.rec{background:linear-gradient(135deg,#2dd4bf,#0891b2);box-shadow:0 6px 14px -8px rgba(8,145,178,.9)}
.role{display:inline-block;font-size:11.5px;font-weight:650;border-radius:99px;padding:2px 9px}.role.recruiter{color:#0e7490;background:#ecfeff}
tr.inpool td:first-child{padding-left:30px;box-shadow:inset 3px 0 0 #67e8f9}
.nomatch .lens{width:34px;height:34px;padding:8px;box-sizing:content-box;border-radius:14px;background:var(--soft)}
@keyframes peek{0%,100%{transform:rotate(0) translate(0,0)}25%{transform:rotate(-10deg) translate(-1px,0)}
50%{transform:rotate(0) translate(0,-1px)}75%{transform:rotate(10deg) translate(1px,0)}}
@keyframes glint{0%,40%{stroke-dashoffset:1}60%,100%{stroke-dashoffset:0}}
`;

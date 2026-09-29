// Profile search on the dashboard. Pages run no JavaScript, so the search button is a label for the field: a
// click focuses it and :focus-within slides it open. Enter sends ?q= and the Worker lists only the profiles
// whose name, email, id, status, place or crawler contain the words.

import { esc } from "./lib.js";

export const MAX_QUERY = 60;

export function searchQuery(url) {
  return String(url.searchParams.get("q") || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
    .slice(0, MAX_QUERY);
}

export function matchesProfile(p, q) {
  if (!q) return true;
  const text = [p.name, p.email, p.id, p.status, p.owner ? "owner" : "", p.provider, p.details?.location,
    p.scanning ? "scanning" : "", p.has_cv === false ? "no cv" : ""].map((v) => String(v || "")).join(" ").toLowerCase();
  return q.toLowerCase().split(" ").every((word) => text.includes(word));
}

const LENS = `<svg class="lens" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
<circle class="glass" cx="10.5" cy="10.5" r="6.5"/><path class="shine" d="M7.4 9.2a3.4 3.4 0 0 1 2.4-2.3" pathLength="1"/><path d="m15.4 15.4 4.6 4.6"/></svg>`;

export function searchBar(q, shown, total) {
  const count = q ? `${shown} of ${total} profile${total === 1 ? "" : "s"}` : `${total} profile${total === 1 ? "" : "s"}`;
  return `<div class="tabletools"><span class="count">${count}</span>
<form class="search${q ? " open" : ""}" method="get" action="/admin" role="search">
<input id="profile-search" type="search" name="q" value="${esc(q)}" maxlength="${MAX_QUERY}" autocomplete="off"
placeholder="Name, email, place or status, then Enter" aria-label="Search profiles">
${q ? '<a class="clear" href="/admin" aria-label="Clear the search">&times;</a>' : ""}
<label for="profile-search" class="searchbtn" title="Search profiles">${LENS}</label></form></div>`;
}

export function noMatch(q) {
  return `<tr><td colspan="4"><div class="nomatch">${LENS}<div><b>No profile matches &ldquo;${esc(q)}&rdquo;</b>
<div class="muted"><a href="/admin">Show everyone</a></div></div></div></td></tr>`;
}

export const SEARCH_STYLE = `
.tabletools{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:18px 0 4px}
.tabletools .count{font-size:12px;font-weight:650;color:var(--muted);background:#f0f2f8;border-radius:99px;padding:3px 10px}
form.search{display:flex;align-items:center;gap:6px;margin:0;position:relative}
#profile-search{width:0;min-width:0;padding:9px 0;border-color:transparent;background:transparent;opacity:0;
border-radius:12px;transition:width .35s var(--ease),padding .35s var(--ease),opacity .25s,border-color .2s,background .2s}
form.search:focus-within #profile-search,form.search.open #profile-search,form.search:has(#profile-search:not(:placeholder-shown)) #profile-search{
width:300px;max-width:62vw;padding:9px 13px;opacity:1;border-color:var(--line);background:var(--field)}
form.search.open #profile-search{padding-right:36px}
form.search:focus-within #profile-search{border-color:var(--brand);background:#fff;box-shadow:0 0 0 4px rgba(99,102,241,.15)}
#profile-search::-webkit-search-cancel-button{display:none}
.searchbtn{flex:none;margin:0;width:40px;height:40px;border-radius:13px;display:grid;place-items:center;cursor:pointer;
color:var(--brand-ink);background:var(--soft);transition:transform .2s var(--ease),background .2s,color .2s,box-shadow .2s}
.searchbtn:hover{transform:translateY(-1px) scale(1.06);background:#e2e5ff}
form.search:focus-within .searchbtn,form.search.open .searchbtn{color:#fff;background:linear-gradient(135deg,var(--brand),var(--brand2));
box-shadow:0 8px 18px -8px rgba(99,102,241,.9)}
.lens{width:20px;height:20px;animation:peek 3.2s var(--ease) infinite;transform-origin:45% 45%}
.lens .shine{stroke-dasharray:1;animation:glint 3.2s ease-in-out infinite}
.searchbtn:hover .lens{animation-duration:1.2s}
form.search .clear{position:absolute;right:52px;width:26px;height:26px;display:grid;place-items:center;border-radius:8px;
font-size:18px;line-height:1;color:var(--muted);text-decoration:none}.clear:hover{background:#eef0f6;color:var(--ink)}
.nomatch{display:flex;gap:14px;align-items:center;padding:10px 0;color:var(--brand-ink)}
.nomatch .lens{width:34px;height:34px;padding:8px;box-sizing:content-box;border-radius:14px;background:var(--soft)}
@keyframes peek{0%,100%{transform:rotate(0) translate(0,0)}25%{transform:rotate(-10deg) translate(-1px,0)}
50%{transform:rotate(0) translate(0,-1px)}75%{transform:rotate(10deg) translate(1px,0)}}
@keyframes glint{0%,40%{stroke-dashoffset:1}60%,100%{stroke-dashoffset:0}}
`;

// The dashboard's task list: everything waiting for HermitShell or running on it, in a modal opened by the Tasks
// button (a spinning ring and a count while there is anything). Pages run no JavaScript, so the modal opens with
// :target (#tasks) and holds a small page, /admin/tasks, that refreshes itself while it is open; the frame has
// loading="lazy", so a closed modal does not load it. Every task can be cancelled there:
// - what the Worker still holds (queued dashboard changes, sign-ups, unsubscribes, and cover letter and tailored CV
//   requests HermitShell has not collected yet) is deleted at once;
// - what HermitShell has (a running report, a request it has collected) is stopped by a "cancel" queue item.

import { queueItem } from "./join.js";
import { SECURITY_HEADERS, ago, deleteAndUnflag, esc, eventFlag, eventPrefix, when } from "./lib.js";

export const TASKS_URL = "/admin/tasks";
// Cover letter and tailored CV requests not yet collected by HermitShell, kept in one key so the list costs a
// read rather than one of the free plan's 1,000 daily list operations. Two presses in the same instant can lose
// one entry here; the request itself is still made, it just does not show until HermitShell reports it.
export const REQUESTS_KEY = "tasks:requests";
export const REQUEST_ACTIONS = ["cover_letter", "tailored_cv"];
const MAX_REQUESTS = 50;
const QUEUE_ID = /^queue:\d{1,16}:[0-9a-f]{8,64}$/;
const EVENT_ID = /^event:[a-z0-9_-]{1,40}:[A-Za-z0-9:_-]{1,120}$/;
const SERVER_ID = /^report:([a-z0-9-]{1,40})$|^letter:([a-z0-9-]{1,40}):event:[a-z0-9_-]{1,40}:[A-Za-z0-9:_-]{1,120}$/;
const CV_KEY = /^cvfile:[0-9a-f]{32}$/;
// The open list refreshes every 5 seconds, then every 15, then stops: each refresh can list the KV queue.
const FAST = 24;
const SLOW = 60;
const IDLE = 30;

export async function rememberRequest(env, event, title, ttl) {
  if (!REQUEST_ACTIONS.includes(event.a)) return;
  const list = await env.FEEDBACK.get(REQUESTS_KEY, "json");
  const next = [...(Array.isArray(list) ? list : []).filter((r) => r.id !== event.id),
    { id: event.id, a: event.a, n: String(title || "").slice(0, 120), u: event.u || "", at: event.at }].slice(-MAX_REQUESTS);
  await env.FEEDBACK.put(REQUESTS_KEY, JSON.stringify(next), { expirationTtl: ttl });
}

export async function forgetRequests(env, ids) {
  const list = await env.FEEDBACK.get(REQUESTS_KEY, "json");
  if (!Array.isArray(list) || !list.length) return;
  const drop = new Set(ids);
  const next = list.filter((r) => !drop.has(r.id));
  if (next.length === list.length) return;
  if (next.length) await env.FEEDBACK.put(REQUESTS_KEY, JSON.stringify(next));
  else await env.FEEDBACK.delete(REQUESTS_KEY);
}

export async function requests(env) {
  const list = await env.FEEDBACK.get(REQUESTS_KEY, "json");
  return Array.isArray(list) ? list : [];
}

const ADMIN_LABELS = {
  send_now: "Send jobs now", pause: "Pause reports", resume: "Resume reports", delete: "Delete profile",
  set_key: "Crawler key", use_global: "Use the global key", profile: "Profile changes", cv: "New CV",
  api_keys: "Global API keys", email: "Email settings", test_email: "Test email",
};
const KIND_LABELS = { report: "Daily report", cover_letter: "Cover letter", tailored_cv: "Tailored CV", signup: "Sign-up", unsubscribe: "Unsubscribe" };
const TRIGGERS = { schedule: "scheduled", dashboard: "from the dashboard", email: "email button", signup: "sign-up form", link: "unsubscribe link" };

function queueKind(item) {
  if (item.type === "signup" || item.type === "unsubscribe") return item.type;
  return { send_now: "send", delete: "delete", set_key: "key", use_global: "key", api_keys: "key", cv: "cv" }[item.action] || "change";
}

// One list, running first, from HermitShell's reported tasks, the Worker's queue and the uncollected requests.
export function taskRows(status, queue, held) {
  const profiles = status.profiles || [];
  const owner = profiles.find((p) => p.owner);
  const names = new Map(profiles.map((p) => [p.id, p.name || p.id]));
  const who = (u) => names.get(u || owner?.id || "owner") || u || owner?.name || "Owner";
  const stopping = new Set(queue.filter((i) => i.type === "admin" && i.action === "cancel").map((i) => i.task));
  const server = (Array.isArray(status.tasks) ? status.tasks : []).filter((t) => t && SERVER_ID.test(String(t.id)));
  const rows = server.map((t) => ({
    id: t.id, kind: KIND_LABELS[t.kind] ? t.kind : "report", who: who(t.u), at: Number(t.at) || 0,
    state: stopping.has(t.id) || t.state === "stopping" ? "stopping" : t.state === "running" ? "running" : "waiting",
    trigger: TRIGGERS[t.trigger] ? t.trigger : "schedule", title: t.kind === "report" ? "" : [t.title, t.employer].filter(Boolean).join(" at "),
    stage: String(t.stage || ""), done: Number(t.done) || 0, total: Number(t.total) || 0, expected: Number(t.expected) || 0,
    retry: Boolean(t.retry), where: "server",
  }));
  for (const i of queue) {
    if (i.type === "admin" && i.action === "cancel") continue;
    const kind = queueKind(i);
    rows.push({
      id: i.id, kind, who: i.type === "signup" ? String(i.name || "New sign-up") : who(i.u), at: Number(i.at) || 0, state: "waiting",
      trigger: i.type === "signup" ? "signup" : i.type === "unsubscribe" ? "link" : "dashboard",
      title: i.type === "admin" ? ADMIN_LABELS[i.action] || String(i.action || "Change").replaceAll("_", " ") : "", where: "queue",
    });
  }
  const known = new Set(profiles.map((p) => p.id));
  for (const r of held) {
    if (server.some((t) => String(t.id).endsWith(`:${r.id}`))) continue;
    if (profiles.length && r.u && !known.has(r.u)) continue;
    rows.push({ id: r.id, kind: REQUEST_ACTIONS.includes(r.a) ? r.a : "cover_letter", who: who(r.u), at: Number(r.at) || 0,
      state: "waiting", trigger: "email", title: String(r.n || ""), where: "worker" });
  }
  const order = { running: 0, stopping: 1, waiting: 2 };
  return rows.sort((a, b) => order[a.state] - order[b.state] || a.at - b.at);
}

// Delete what the Worker holds; ask HermitShell to stop what it has. Returns the note to show.
export async function cancelTask(env, id, status, queue) {
  if (QUEUE_ID.test(id)) {
    const item = await env.FEEDBACK.get(id, "json");
    if (!item || (item.type === "admin" && item.action === "cancel")) return "gone";
    const cv = typeof item.cv === "string" ? item.cv : item.cv?.key;
    if (CV_KEY.test(cv || "")) await env.FEEDBACK.delete(cv);
    await deleteAndUnflag(env, [id], "queue:", "flag:queue");
    return "cancelled";
  }
  if (EVENT_ID.test(id)) {
    if (!(await requests(env)).some((r) => r.id === id)) return "gone";
    const u = id.split(":")[1] === "_" ? "" : id.split(":")[1];
    await deleteAndUnflag(env, [id], eventPrefix(u), eventFlag(u));
    await forgetRequests(env, [id]);
    return "cancelled";
  }
  const match = SERVER_ID.exec(id);
  if (!match || !(status.tasks || []).some((t) => t?.id === id)) return "gone";
  if (!queue.some((i) => i.type === "admin" && i.action === "cancel" && i.task === id)) {
    await queueItem(env, { type: "admin", action: "cancel", u: match[1] || match[2], task: id });
  }
  return "stopping";
}

const ICONS = {
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11"/><circle cx="5" cy="18" r="1.4"/>',
  report: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/><path d="M8.5 11.5 10.5 13.5 14 9.5"/>',
  cover_letter: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
  tailored_cv: '<rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9" cy="11" r="2"/><path d="M6.5 16c.6-1.6 4.4-1.6 5 0M14 10h3.5M14 13.5h3.5"/>',
  signup: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.8 3.3-5.5 6.5-5.5s5.7 1.7 6.5 5.5M19 8v6M16 11h6"/>',
  unsubscribe: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.8 3.3-5.5 6.5-5.5s5.7 1.7 6.5 5.5M16 11h6"/>',
  send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>',
  delete: '<path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  cv: '<path d="M7 3h7l4 4v14H7z"/><path d="M12 11v6M9.5 13.5 12 11l2.5 2.5"/>',
  change: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  done: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12.5 2.7 2.7L16.5 9.5"/>',
};

function icon(name, cls = "") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.change}</svg>`;
}

export function tasksButton(count) {
  const n = count > 99 ? "99+" : String(count);
  return `<a class="tasksbtn${count ? " busy" : ""}" href="#tasks" title="${count ? `${n} task${count === 1 ? "" : "s"} waiting or running` : "Tasks"}">
<span class="tring">${icon("tasks")}</span><span>Tasks</span>${count ? `<span class="tcount">${n}</span>` : ""}</a>`;
}

export function tasksModal() {
  return `<div class="modal" id="tasks" role="dialog" aria-modal="true" aria-labelledby="tasks-h">
<a class="scrim" href="#_" aria-label="Close" tabindex="-1"></a>
<div class="sheet tasksheet"><a class="x" href="#_" aria-label="Close">&times;</a>
<div class="sheeticon">${icon("tasks")}</div><h2 id="tasks-h">Tasks</h2>
<p class="muted">What HermitShell is doing or has waiting: from here, on a schedule, from a sign-up or from an email button. It updates by itself while open.</p>
<iframe class="tasksframe" src="${TASKS_URL}" loading="lazy" title="Tasks"></iframe></div></div>`;
}

function progress(t) {
  if (t.state !== "running") return "";
  if (t.total) {
    const pct = Math.min(100, Math.round((100 * t.done) / t.total));
    return `<div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>`;
  }
  if (t.expected && t.at) {
    const pct = Math.max(3, Math.min(95, Math.round((100 * (Date.now() - t.at)) / t.expected)));
    return `<div class="bar est" title="Estimated from how long the last one took"><i style="width:${pct}%"></i></div>`;
  }
  return '<div class="bar indet"><i></i></div>';
}

function detail(t) {
  const since = t.at ? ago(t.at) : "";
  if (t.state === "stopping") return "Stopping&hellip;";
  if (t.state === "running") {
    const stage = t.kind === "report" ? esc(t.stage || "Starting") : t.kind === "tailored_cv" ? "Tailoring the CV" : "Writing the letter";
    const count = t.total ? ` &middot; ${t.done} of ${t.total}` : "";
    return `${stage}${count}${since ? ` &middot; started ${esc(since)}` : ""}`;
  }
  const wait = t.where === "worker" ? "Waiting for HermitShell to collect it" : t.where === "queue" ? "Waiting for HermitShell"
    : t.retry ? "Failed once; tried again soon" : "Queued behind the one being made";
  return `${wait}${since ? ` &middot; ${esc(since)}` : ""}`;
}

function cancelForm(t, csrf) {
  if (t.state === "stopping" || !(QUEUE_ID.test(t.id) || EVENT_ID.test(t.id) || SERVER_ID.test(t.id))) return "";
  const label = t.state === "running" ? "Stop" : "Cancel";
  return `<form method="post" action="${TASKS_URL}"><input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="task" value="${esc(t.id)}"><button class="tcancel" title="${label} this task">${label}</button></form>`;
}

// The list reloads every few seconds; starting the ring where the clock says it is keeps the spin from jumping back.
function spinPhase(now = Date.now()) {
  return ` style="--spin:-${((now % 1000) / 1000).toFixed(2)}s"`;
}

function taskRow(t, csrf, tz) {
  const name = t.kind === "report" || t.kind === "cover_letter" || t.kind === "tailored_cv" || t.kind === "signup" || t.kind === "unsubscribe"
    ? KIND_LABELS[t.kind] : t.title;
  const sub = ["report", "signup", "unsubscribe", "send", "delete", "key", "cv", "change"].includes(t.kind) ? "" : t.title;
  return `<li class="task k-${esc(t.kind)} s-${t.state}"${t.state === "running" ? spinPhase() : ""}><span class="ticon">${icon(t.state === "waiting" ? "clock" : t.kind)}</span>
<div class="tbody"><div class="thead"><b>${esc(name)}</b><span class="twho">${esc(t.who)}</span><span class="chip">${esc(TRIGGERS[t.trigger])}</span></div>
${sub ? `<div class="ttitle">${esc(sub)}</div>` : ""}<div class="tsub" title="${esc(t.at ? when(t.at, tz) : "")}">${detail(t)}</div>${progress(t)}</div>
${cancelForm(t, csrf)}</li>`;
}

const NOTES = {
  cancelled: "Cancelled.",
  stopping: "Asked HermitShell to stop it. That takes a few seconds while it is connected.",
  gone: "That task had already finished.",
};

export function tasksPage(rows, csrf, tz, n, done = "") {
  const refresh = rows.length ? (n < FAST ? 5 : n < SLOW ? 15 : 0) : (n < IDLE ? 20 : 0);
  const next = refresh ? `<meta http-equiv="refresh" content="${refresh};url=${TASKS_URL}?n=${n + 1}">` : "";
  const note = NOTES[done] ? `<p class="tnote">${NOTES[done]}</p>` : "";
  const list = rows.length ? `<ul class="tasks">${rows.map((t) => taskRow(t, csrf, tz)).join("")}</ul>`
    : `<div class="tempty">${icon("done")}<b>Nothing waiting or running</b><span>New reports, requests and changes show here as they start.</span></div>`;
  const paused = refresh ? "" : `<p class="tpaused">Updates paused. <a href="${TASKS_URL}">Check again</a></p>`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">${next}<style>${FRAME_STYLE}</style></head>
<body>${note}${list}${paused}</body></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'",
      ...SECURITY_HEADERS,
    },
  });
}

export const TASKS_STYLE = `
.tabletools .tools{display:flex;align-items:center;gap:10px}
.tasksbtn{position:relative;display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 14px 0 6px;border-radius:13px;
font-size:13.5px;font-weight:650;text-decoration:none;color:var(--brand-ink);background:var(--soft);
transition:transform .2s var(--ease),background .2s,box-shadow .2s}
.tasksbtn:hover{transform:translateY(-1px);background:#e2e5ff}
.tring{position:relative;width:30px;height:30px;display:grid;place-items:center;border-radius:50%}
.tring svg{width:18px;height:18px}
.tasksbtn.busy .tring::before{content:"";position:absolute;inset:0;border-radius:50%;
background:conic-gradient(from 0deg,rgba(139,92,246,0) 0deg,rgba(139,92,246,.15) 90deg,var(--brand2) 250deg,var(--brand) 350deg,rgba(99,102,241,0) 360deg),#dfe2fb;
-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));
mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));animation:tspin 1s linear infinite}
.tcount{position:absolute;top:-7px;right:-7px;min-width:20px;height:20px;padding:0 6px;box-sizing:border-box;border-radius:99px;
display:grid;place-items:center;font-size:11.5px;font-weight:800;color:#fff;background:linear-gradient(135deg,#f97316,#ef4444);
border:2px solid #fff;box-shadow:0 4px 10px -4px rgba(239,68,68,.9);animation:tpop .35s var(--ease) both}
.sheet.tasksheet{max-width:600px}
iframe.tasksframe{display:block;width:100%;height:min(440px,60vh);border:0;margin-top:14px;border-radius:14px;background:#f8fafc}
@keyframes tspin{to{transform:rotate(360deg)}}
@keyframes tpop{from{transform:scale(.4);opacity:0}}
`;

const FRAME_STYLE = `
body{margin:0;padding:10px;font:14px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0f172a;background:#f8fafc;
-webkit-font-smoothing:antialiased}
ul.tasks{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.task{display:flex;gap:12px;align-items:center;padding:11px 12px;background:#fff;border:1px solid #e5e8f0;border-radius:14px;
animation:tin .3s cubic-bezier(.2,.8,.2,1) both}
.ticon{position:relative;flex:none;width:36px;height:36px;border-radius:12px;display:grid;place-items:center;color:#4f46e5;background:#eef0ff}
.ticon svg{width:19px;height:19px}
.s-running .ticon{margin:0 3px;border-radius:50%;color:#fff;background:linear-gradient(135deg,#6366f1,#8b5cf6)}
.s-running .ticon::before,.s-running .ticon::after{content:"";position:absolute;inset:-5px;border-radius:50%;
-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));
mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px))}
.s-running .ticon::before{background:#e6e8fb}
.s-running .ticon::after{background:conic-gradient(from 0deg,rgba(139,92,246,0) 0deg,rgba(139,92,246,.15) 90deg,#8b5cf6 250deg,#6366f1 350deg,rgba(99,102,241,0) 360deg);
animation:tspin 1s linear infinite;animation-delay:var(--spin,0s)}
.s-waiting .ticon{color:#64748b;background:#f1f5f9}.s-waiting .ticon svg{animation:ttick 2s steps(8) infinite}
.s-stopping .ticon{color:#b91c1c;background:#fee2e2}
.tbody{flex:1;min-width:0}
.thead{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center}
.thead b{font-size:14px}.twho{font-size:13px;color:#475569}
.chip{font-size:11px;font-weight:650;color:#4338ca;background:#eef0ff;border-radius:99px;padding:1px 8px}
.k-report .chip,.s-running .chip{color:#047857;background:#dcfce7}
.ttitle{font-size:13px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tsub{font-size:12.5px;color:#64748b;margin-top:1px}
.bar{height:6px;margin-top:7px;border-radius:99px;background:#e9ecf5;overflow:hidden}
.bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#6366f1,#8b5cf6,#6366f1) 0 0/200% 100%;
animation:tflow 1.6s linear infinite;transition:width .6s}
.bar.est i{opacity:.75}
.bar.indet i{width:35%;animation:tslide 1.3s ease-in-out infinite}
form{margin:0}
.tcancel{font:inherit;font-size:12.5px;font-weight:650;padding:6px 12px;border-radius:10px;border:1px solid #fecaca;color:#b91c1c;
background:#fff;cursor:pointer;transition:background .15s}
.tcancel:hover{background:#fef2f2}.tcancel:focus-visible{outline:3px solid rgba(239,68,68,.3);outline-offset:1px}
.tempty{display:grid;justify-items:center;gap:4px;padding:44px 12px;text-align:center;color:#64748b}
.tempty svg{width:40px;height:40px;color:#10b981;animation:tin .4s both}.tempty b{color:#0f172a}
.tnote{margin:0 0 8px;padding:8px 12px;border-radius:10px;background:#ecfdf5;color:#065f46;font-size:13px}
.tpaused{margin:10px 2px 0;font-size:12.5px;color:#64748b}.tpaused a{color:#4f46e5}
@keyframes tspin{to{transform:rotate(360deg)}}
@keyframes ttick{to{transform:rotate(360deg)}}
@keyframes tflow{to{background-position:-200% 0}}
@keyframes tslide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
@keyframes tin{from{opacity:0;transform:translateY(4px)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

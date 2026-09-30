// The web search keys on the Global settings page: one row per provider (its logo, where the key comes from and a
// masked hint, never the key) and an "Add key" or "Change" button that opens a modal. Every recruit's searches
// use these keys. Pages run no JavaScript, so a modal opens with :target (#gkey-<provider>) and closes by linking
// to an id that does not exist; modals are rendered outside <main>, whose entry animation would otherwise pin a
// fixed element to the card. MODAL_STYLE is shared with the Tasks window and the dashboard users' modals.
//
// A provider with a key opens, when pressed, to its keys in the order they are tried (Firecrawl's main key then its
// backups), each masked, with what is left of its allowance as HermitShell last checked it (key_usage.py).

import { ago, esc } from "./lib.js";

export const PROVIDERS = {
  firecrawl: { label: "Firecrawl", signup: "https://www.firecrawl.dev/app/api-keys" },
  tavily: { label: "Tavily", signup: "https://app.tavily.com/home" },
  scrapfly: { label: "Scrapfly", signup: "https://scrapfly.io/dashboard" },
};

const LOGOS = {
  firecrawl: '<path d="M12 3c.6 3.2 4.8 5.3 4.8 10a4.8 4.8 0 0 1-9.6 0c0-2 1-3.4 2.1-4.5.2 1.4.9 2.3 1.9 2.8C10.9 8.9 11.3 5.6 12 3Z"/>',
  tavily: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/><path d="M11 7.8v6.4M7.8 11h6.4"/>',
  scrapfly: '<ellipse cx="12" cy="13.5" rx="3.3" ry="5"/><path d="M12 8.5V5.5M9.5 4.5 12 5.5l2.5-1M8.7 11.5 4.5 9M15.3 11.5 19.5 9M8.7 15.5 4.5 18M15.3 15.5l4.2 2.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  openrouter: '<path d="M3 12h5.5l4-6.5H20M12.5 18.5H20M8.5 12l4 6.5"/><path d="m17 2.5 3 3-3 3M17 15.5l3 3-3 3"/>',
  bazaarlink: '<path d="M4 9.5h16L18.5 4.5h-13Z"/><path d="M5.5 9.5V19h13V9.5"/><path d="M10 19v-5h4v5"/>',
  featherless: '<path d="M12.7 19a2 2 0 0 0 1.4-.6l6.2-6.2a6 6 0 0 0-8.5-8.5L5.6 9.9A2 2 0 0 0 5 11.3V18a1 1 0 0 0 1 1Z"/><path d="M16 8 2 22M17.5 15H9"/>',
  huggingface: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14.5c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2M9 10h.01M15 10h.01"/>',
  ollama: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  model: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01M11 7.5h6M11 16.5h6"/>',
};

export function logo(name, cls = "") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LOGOS[name] || LOGOS.key}</svg>`;
}

const modalId = (name) => `gkey-${name}`;
const MAX_KEYS = 6;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const CHEVRON = '<svg class="kchev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
// What a key's allowance counts: credits (web search), requests (free models, per day), usd (dollars) or plan (only
// the plan's name is known).
const UNITS = ["credits", "requests", "usd", "plan"];
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const dollars = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null);
const number = (n) => n.toLocaleString("en-GB");
const day = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const shown = (v, unit) => (unit === "usd" ? `$${v.toFixed(2)}` : number(v));
const noun = (unit) => ({ credits: " credits", requests: " requests", usd: "" })[unit] || "";

// The keys HermitShell reported for a provider, checked field by field.
export function reported(k) {
  return (Array.isArray(k.keys) ? k.keys : []).filter((r) => r && typeof r === "object" && typeof r.hint === "string").slice(0, MAX_KEYS)
    .map((r) => {
      const u = r.usage && typeof r.usage === "object" && !Array.isArray(r.usage) ? r.usage : {};
      const unit = UNITS.includes(u.unit) ? u.unit : "credits";
      const num = unit === "usd" ? dollars : count;
      return { hint: r.hint.slice(0, 20), backup: r.role === "backup", at: Number.isFinite(r.at) && r.at > 0 ? r.at : 0,
        error: typeof r.error === "string" ? r.error.slice(0, 80) : "", used: num(u.used), limit: num(u.limit), left: num(u.left), unit,
        plan: typeof u.plan === "string" ? u.plan.slice(0, 40) : "", resets: DATE_RE.test(u.resets || "") && MONTHS[Number(u.resets.slice(5, 7)) - 1] ? u.resets : "" };
    });
}

function share(r) {
  return r.limit && r.left !== null ? Math.max(0, Math.min(100, Math.round((100 * r.left) / r.limit))) : null;
}

const tone = (pct) => (pct === null ? "" : pct < 15 ? " low" : pct < 40 ? " mid" : "");

function usageRow(r, label) {
  const pct = share(r);
  const planOnly = r.unit === "plan" && r.plan;
  const amount = planOnly ? `<b>${esc(r.plan)}</b> plan`
    : r.left !== null ? `<b>${shown(r.left, r.unit)}</b>${r.limit !== null ? ` of ${shown(r.limit, r.unit)}` : ""}${noun(r.unit)} left${r.unit === "requests" ? " today" : ""}`
      : r.used !== null ? `<b>${shown(r.used, r.unit)}</b>${noun(r.unit)} used` : "";
  const meta = [r.plan && !planOnly ? `${esc(r.plan)} plan` : "", r.resets ? `resets ${day(r.resets)}` : "", r.at ? `checked ${esc(ago(r.at))}` : ""]
    .filter(Boolean).join(" &middot; ");
  const body = r.error ? `<div class="kuse bad">Couldn&rsquo;t check it: ${esc(r.error)}</div>`
    : amount ? `${pct === null ? "" : `<div class="kbar${tone(pct)}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${pct}% left"><i style="width:${pct}%"></i></div>`}<div class="kuse">${amount}</div>`
      : '<div class="kuse muted">Not checked yet. HermitShell checks every hour unless WEB_KEY_USAGE_MINUTES is 0.</div>';
  return `<li><div class="khead"><span class="krole">${label}</span><code>${esc(r.hint)}</code>${pct === null ? "" : `<span class="kpct${tone(pct)}">${pct}% left</span>`}</div>
${body}${meta ? `<div class="kmeta">${meta}</div>` : ""}</li>`;
}

export function keyList(rows) {
  let backups = 0;
  return `<ul class="keylist">${rows.map((r) => usageRow(r, r.backup ? `Backup key ${(backups += 1)}` : "Main key")).join("")}</ul>`;
}

export function leftSummary(rows) {
  const unit = rows[0]?.unit;
  const known = rows.filter((r) => r.left !== null && r.unit === unit);
  if (!known.length) return "";
  const left = known.reduce((sum, r) => sum + r.left, 0);
  const low = known.every((r) => tone(share(r)) === " low");
  return `<span class="kleft${low ? " low" : ""}">${shown(left, unit)}${noun(unit)} left${unit === "requests" ? " today" : ""}${rows.length > 1 ? ` across ${rows.length} keys` : ""}</span> &middot; `;
}

function clearButton(csrf, provider) {
  return `<form method="post" action="/admin/action" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="action" value="api_keys_clear"><input type="hidden" name="provider" value="${esc(provider)}"><button class="small quiet">Use the .env key</button></form>`;
}

function keyRow(name, info, k, csrf) {
  const source = k.source === "dashboard" ? "set here" : k.source === "env" ? "from .env" : "";
  const rows = source ? reported(k) : [];
  const backups = Number.isInteger(k.backups) && k.backups > 0 ? k.backups : 0;
  const extra = leftSummary(rows) + (name === "firecrawl" && backups ? `plus ${backups} backup key${backups === 1 ? "" : "s"} &middot; ` : "");
  const hint = source ? `<code class="keyhint" title="Only the start and end of the key are shown">${esc(k.hint || "****")}</code>`
    : '<div class="muted">No key yet</div>';
  const open = source ? `<a class="small" href="#${modalId(name)}">Change</a>`
    : `<a class="addkey" href="#${modalId(name)}">${logo("key")}Add key</a>`;
  const inner = `<span class="crlogo">${logo(name)}</span><div class="keyinfo">
<b>${esc(info.label)}</b>${source ? ` <span class="crtag${k.source === "env" ? " env" : ""}">${source}</span>` : ""}${hint}
<div class="muted small">${extra}<a href="${esc(info.signup)}" target="_blank" rel="noopener noreferrer">get a key</a></div></div>
<div class="cractions">${open}${k.source === "dashboard" ? clearButton(csrf, name) : ""}</div>`;
  if (!rows.length) return `<div class="keyrow cr-${name}">${inner}</div>`;
  return `<details class="keycard cr-${name}"><summary class="keyrow" title="Show the keys and their usage">${inner}${CHEVRON}</summary>
${keyList(rows)}</details>`;
}

export function keysSection(status, csrf) {
  const keys = status.keys || {};
  return `<h2 id="keys">Web search API keys</h2>
<p class="muted">Every recruit's searches use these keys. Firecrawl is tried first, then Tavily, then Scrapfly.</p>
<div class="keyrows">${Object.entries(PROVIDERS).map(([name, info]) => keyRow(name, info, keys[name] || {}, csrf)).join("")}</div>
<p class="muted">Press a provider to see its keys and how much of each allowance is left. Keys are only shown as their start and end,
and are kept on the HermitShell server, not here.</p>`;
}

export function keyModals(csrf) {
  const links = Object.values(PROVIDERS).map((p) => `<a href="${esc(p.signup)}" target="_blank" rel="noopener noreferrer">${esc(p.label)}</a>`);
  return Object.keys(PROVIDERS).map((current) => {
    const id = modalId(current);
    const choices = Object.entries(PROVIDERS).map(([name, info]) => `<label class="crchoice cr-${name}"><input type="radio" name="provider" value="${name}"${name === current ? " checked" : ""}>
<span>${logo(name)}<b>${esc(info.label)}</b></span></label>`).join("");
    return `<div class="modal" id="${id}" role="dialog" aria-modal="true" aria-labelledby="${id}-h">
<a class="scrim" href="#_" aria-label="Close" tabindex="-1"></a>
<div class="sheet"><a class="x" href="#_" aria-label="Close">&times;</a>
<div class="sheeticon">${logo("key")}</div>
<h2 id="${id}-h">Web search key</h2><p class="muted">Used for every recruit's searches. Saving replaces the key set for that provider.</p>
<form method="post" action="/admin/action"><input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="action" value="api_key">
<div class="crchoices three">${choices}</div>
<label for="${id}-k">API key</label>
<input id="${id}-k" name="key" type="password" autocomplete="off" required minlength="8" maxlength="700" placeholder="Paste the key">
<span class="hint">Firecrawl takes several keys separated by commas, used in turn. All three have free plans: get a key from ${links.slice(0, -1).join(", ")} or ${links.at(-1)}.</span>
<button>Save key</button></form></div></div>`;
  }).join("");
}

export const MODAL_STYLE = `
.addkey{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:10px;font-size:13px;font-weight:650;
text-decoration:none;color:var(--brand-ink);background:var(--soft);border:1px dashed #c7d2fe;transition:transform .15s var(--ease),background .15s}
.addkey:hover{background:#e2e5ff;transform:translateY(-1px)}.addkey svg{width:16px;height:16px}
.modal{display:none;position:fixed;inset:0;z-index:50;place-items:center;padding:16px}
.modal:target{display:grid}
.scrim{position:absolute;inset:0;background:rgba(15,23,42,.45);backdrop-filter:blur(3px);animation:fade .2s ease both}
.sheet{position:relative;width:100%;max-width:420px;max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;background:#fff;
border-radius:20px;padding:26px;box-shadow:0 30px 80px -20px rgba(15,23,42,.45);animation:pop .28s var(--ease) both}
.sheet h2{margin:12px 0 2px}.sheet form{margin:0}
.x{position:absolute;top:12px;right:14px;width:32px;height:32px;display:grid;place-items:center;border-radius:10px;font-size:22px;
line-height:1;color:var(--muted);text-decoration:none}.x:hover{background:#f1f3f9;color:var(--ink)}
.sheeticon{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;color:#fff;
background:linear-gradient(135deg,var(--brand),var(--brand2));box-shadow:0 8px 18px -8px rgba(99,102,241,.9)}
.sheeticon svg{width:22px;height:22px;animation:turn 2.4s var(--ease) infinite alternate}
@keyframes fade{from{opacity:0}}
@keyframes pop{from{opacity:0;transform:translateY(12px) scale(.97)}}
@keyframes turn{from{transform:rotate(-12deg)}to{transform:rotate(12deg)}}
`;

export const KEY_STYLE = `
.keyrows{display:grid;gap:10px;margin:14px 0}
.keyrow{display:flex;align-items:center;gap:14px;padding:14px 16px;border:1px solid var(--line);border-radius:16px;background:#fff;
transition:border-color .15s,box-shadow .15s,transform .15s var(--ease)}
.keyrow:hover{border-color:#c9cfe0;box-shadow:0 10px 24px -18px rgba(15,23,42,.35);transform:translateY(-1px)}
.keyinfo{flex:1;min-width:0}.keyinfo b{font-size:15px}.keyinfo .small{font-size:12.5px;margin-top:3px}
.crlogo{flex:none;width:40px;height:40px;border-radius:13px;display:grid;place-items:center;color:#fff}
.crlogo svg{width:21px;height:21px}
.cr-firecrawl .crlogo{background:linear-gradient(135deg,#fb923c,#ef4444);box-shadow:0 6px 14px -8px rgba(239,68,68,.9)}
.cr-tavily .crlogo{background:linear-gradient(135deg,#38bdf8,#6366f1);box-shadow:0 6px 14px -8px rgba(99,102,241,.9)}
.cr-scrapfly .crlogo{background:linear-gradient(135deg,#34d399,#0ea5e9);box-shadow:0 6px 14px -8px rgba(14,165,233,.9)}
.crtag{font-size:11px;font-weight:650;color:#047857;background:var(--ok-bg);border-radius:99px;padding:1px 8px}
.crtag.env{color:var(--brand-ink);background:var(--soft)}
code.keyhint{display:block;margin-top:2px;font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted);
letter-spacing:.02em}
.cractions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.crchoices{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.crchoices.three{grid-template-columns:repeat(3,1fr)}
.crchoice{margin:0;cursor:pointer}.crchoice input{position:absolute;opacity:0;pointer-events:none}
.crchoice span{display:flex;align-items:center;gap:9px;padding:12px;border:1.5px solid var(--line);border-radius:14px;
transition:border-color .15s,background .15s,box-shadow .15s}
.three .crchoice span{flex-direction:column;gap:6px;padding:12px 6px;text-align:center;font-size:14px}
.crchoice svg{width:20px;height:20px}.cr-firecrawl.crchoice svg{color:#ef4444}.cr-tavily.crchoice svg{color:#6366f1}
.cr-scrapfly.crchoice svg{color:#0ea5e9}
.crchoice:hover span{border-color:#c9cfe0}
.crchoice input:checked+span{border-color:var(--brand);background:var(--soft);box-shadow:0 0 0 3px rgba(99,102,241,.14)}
.crchoice input:focus-visible+span{outline:3px solid rgba(99,102,241,.35);outline-offset:2px}
.keycard{border:1px solid var(--line);border-radius:16px;background:#fff;transition:border-color .15s,box-shadow .15s}
.keycard:hover,.keycard[open]{border-color:#c9cfe0;box-shadow:0 10px 24px -18px rgba(15,23,42,.35)}
.keycard>summary.keyrow{list-style:none;cursor:pointer;border:0;background:none}
.keycard>summary.keyrow:hover{box-shadow:none;transform:none}
.keycard>summary::-webkit-details-marker{display:none}
.keycard>summary:focus-visible{outline:3px solid rgba(99,102,241,.35);outline-offset:-3px;border-radius:16px}
.kchev{flex:none;width:18px;height:18px;color:var(--muted);transition:transform .2s var(--ease)}
.keycard[open] .kchev{transform:rotate(180deg)}
.kleft{font-weight:650;color:#047857}.kleft.low{color:#b91c1c}
.keylist{list-style:none;margin:0;padding:4px 16px 14px 70px;display:grid;gap:10px;animation:kopen .2s var(--ease) both}
.keylist li{padding:11px 13px;border:1px solid var(--line);border-radius:13px;background:#fafbff}
.khead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.krole{font-size:12.5px;font-weight:700;color:var(--ink)}
.khead code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted)}
.kpct{margin-left:auto;font-size:11.5px;font-weight:700;color:#047857;background:var(--ok-bg);border-radius:99px;padding:1px 8px}
.kpct.mid{color:#92400e;background:#fef3c7}.kpct.low{color:#b91c1c;background:#fee2e2}
.kbar{height:7px;margin:9px 0 6px;border-radius:99px;background:#e9ecf5;overflow:hidden}
.kbar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#10b981,#34d399)}
.kbar.mid i{background:linear-gradient(90deg,#f59e0b,#fbbf24)}.kbar.low i{background:linear-gradient(90deg,#ef4444,#f87171)}
.kuse{font-size:13px;margin-top:4px}.kuse b{font-size:14px}.kuse.bad{color:#b91c1c}
.kmeta{font-size:12px;color:var(--muted);margin-top:2px}
@keyframes kopen{from{opacity:0;transform:translateY(-4px)}}
@media (max-width:560px){.keyrow{flex-wrap:wrap}.cractions{width:100%;justify-content:flex-start}.keylist{padding-left:16px}
.keycard>summary .kchev{position:absolute;right:16px}.keycard{position:relative}}
`;

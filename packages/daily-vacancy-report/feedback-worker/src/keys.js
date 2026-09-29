// The web search keys on the Global settings page: one row per provider (its logo, where the key comes from and a
// masked hint, never the key) and an "Add key" or "Change" button that opens a modal. Every recruit's searches
// use these keys. Pages run no JavaScript, so a modal opens with :target (#gkey-<provider>) and closes by linking
// to an id that does not exist; modals are rendered outside <main>, whose entry animation would otherwise pin a
// fixed element to the card. MODAL_STYLE is shared with the Tasks window and the dashboard users' modals.

import { esc } from "./lib.js";

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
};

export function logo(name, cls = "") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LOGOS[name] || LOGOS.key}</svg>`;
}

const modalId = (name) => `gkey-${name}`;

function clearButton(csrf, provider) {
  return `<form method="post" action="/admin/action" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="action" value="api_keys_clear"><input type="hidden" name="provider" value="${esc(provider)}"><button class="small quiet">Use the .env key</button></form>`;
}

function keyRow(name, info, k, csrf) {
  const source = k.source === "dashboard" ? "set here" : k.source === "env" ? "from .env" : "";
  const extra = name === "firecrawl" && k.backups ? `plus ${k.backups} backup key${k.backups === 1 ? "" : "s"} &middot; ` : "";
  const hint = source ? `<code class="keyhint" title="Only the start and end of the key are shown">${esc(k.hint || "****")}</code>`
    : '<div class="muted">No key yet</div>';
  const open = source ? `<a class="small" href="#${modalId(name)}">Change</a>`
    : `<a class="addkey" href="#${modalId(name)}">${logo("key")}Add key</a>`;
  return `<div class="keyrow cr-${name}"><span class="crlogo">${logo(name)}</span><div class="keyinfo">
<b>${esc(info.label)}</b>${source ? ` <span class="crtag${k.source === "env" ? " env" : ""}">${source}</span>` : ""}${hint}
<div class="muted small">${extra}<a href="${esc(info.signup)}" target="_blank" rel="noopener noreferrer">get a key</a></div></div>
<div class="cractions">${open}${k.source === "dashboard" ? clearButton(csrf, name) : ""}</div></div>`;
}

export function keysSection(status, csrf) {
  const keys = status.keys || {};
  return `<h2 id="keys">Web search API keys</h2>
<p class="muted">Every recruit's searches use these keys. Firecrawl is tried first, then Tavily, then Scrapfly.</p>
<div class="keyrows">${Object.entries(PROVIDERS).map(([name, info]) => keyRow(name, info, keys[name] || {}, csrf)).join("")}</div>
<p class="muted">Keys are only shown as their start and end, and are kept on the HermitShell server, not here.</p>`;
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
@media (max-width:560px){.keyrow{flex-wrap:wrap}.cractions{width:100%;justify-content:flex-start}}
`;

// The Crawler column of the profiles table: a profile's own crawler key (its provider and a masked hint, never
// the key) or an "Add key" button that opens a modal. Pages run no JavaScript, so the modal opens with :target
// (#key-<id>) and closes by linking to an id that does not exist; it is rendered outside <main>, whose entry
// animation would otherwise pin a fixed element to the card.

import { esc } from "./lib.js";
import { PROVIDERS, SETTINGS_URL, button } from "./settings.js";

// Providers that can search as well as read pages, so a profile's own key can be for one of them.
export const CRAWLERS = ["firecrawl", "tavily"];

const LOGOS = {
  firecrawl: '<path d="M12 3c.6 3.2 4.8 5.3 4.8 10a4.8 4.8 0 0 1-9.6 0c0-2 1-3.4 2.1-4.5.2 1.4.9 2.3 1.9 2.8C10.9 8.9 11.3 5.6 12 3Z"/>',
  tavily: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/><path d="M11 7.8v6.4M7.8 11h6.4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
};

function logo(name, cls = "") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LOGOS[name] || LOGOS.key}</svg>`;
}

const modalId = (p) => `key-${p.id}`;

export function crawlerCell(p, csrf) {
  const provider = PROVIDERS[p.provider] ? p.provider : "";
  if (!provider) {
    return `<a class="addkey" href="#${esc(modalId(p))}">${logo("key")}Add key</a>`;
  }
  const change = p.owner
    ? `<a class="small" href="${SETTINGS_URL}#keys">Change</a>`
    : `<a class="small" href="#${esc(modalId(p))}">Change</a>${button(csrf, "use_global", "Remove", { u: p.id }, "small quiet")}`;
  return `<div class="crawler cr-${provider}"><span class="crlogo">${logo(provider)}</span><div>
<b>${esc(PROVIDERS[provider].label)}</b>${p.owner ? ' <span class="crtag">global</span>' : ""}
<code class="keyhint" title="Only the start and end of the key are shown">${esc(p.key_hint || "****")}</code></div></div>
<div class="cractions">${change}</div>`;
}

export function keyModal(p, csrf) {
  const id = esc(modalId(p));
  const current = CRAWLERS.includes(p.provider) ? p.provider : "firecrawl";
  const choices = CRAWLERS.map((name) => `<label class="crchoice cr-${name}"><input type="radio" name="provider" value="${name}"${name === current ? " checked" : ""}>
<span>${logo(name)}<b>${esc(PROVIDERS[name].label)}</b></span></label>`).join("");
  const links = CRAWLERS.map((name) => `<a href="${esc(PROVIDERS[name].signup)}" target="_blank" rel="noopener noreferrer">${esc(PROVIDERS[name].label)}</a>`).join(" or ");
  const who = p.owner
    ? "This becomes the global key, used by everyone without a key of their own."
    : `${esc(p.name || "This recruit")}'s searches will use only this key, never the global ones.`;
  return `<div class="modal" id="${id}" role="dialog" aria-modal="true" aria-labelledby="${id}-h">
<a class="scrim" href="#_" aria-label="Close" tabindex="-1"></a>
<div class="sheet"><a class="x" href="#_" aria-label="Close">&times;</a>
<div class="sheeticon">${logo("key")}</div>
<h2 id="${id}-h">Crawler key</h2><p class="muted">${who}</p>
<form method="post" action="/admin/action"><input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="action" value="set_key"><input type="hidden" name="u" value="${esc(p.id)}">
<div class="crchoices">${choices}</div>
<label for="${id}-k">API key</label>
<input id="${id}-k" name="key" type="password" autocomplete="off" required minlength="8" maxlength="120" pattern="[A-Za-z0-9_\\-]+" placeholder="Paste the key">
<span class="hint">Both have free plans: get a key from ${links}.</span>
<button>Save key</button></form></div></div>`;
}

export const KEY_STYLE = `
.addkey{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:10px;font-size:13px;font-weight:650;
text-decoration:none;color:var(--brand-ink);background:var(--soft);border:1px dashed #c7d2fe;transition:transform .15s var(--ease),background .15s}
.addkey:hover{background:#e2e5ff;transform:translateY(-1px)}.addkey svg{width:16px;height:16px}
.crawler{display:flex;gap:10px;align-items:center}.crawler b{font-size:14px}
.crlogo{flex:none;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;color:#fff}
.crlogo svg{width:19px;height:19px}
.cr-firecrawl .crlogo{background:linear-gradient(135deg,#fb923c,#ef4444);box-shadow:0 6px 14px -8px rgba(239,68,68,.9)}
.cr-tavily .crlogo{background:linear-gradient(135deg,#38bdf8,#6366f1);box-shadow:0 6px 14px -8px rgba(99,102,241,.9)}
.crtag{font-size:11px;font-weight:650;color:#047857;background:var(--ok-bg);border-radius:99px;padding:1px 8px}
code.keyhint{display:block;margin-top:2px;font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted);
letter-spacing:.02em}
.cractions{display:flex;gap:10px;align-items:center;margin-top:8px}
.modal{display:none;position:fixed;inset:0;z-index:50;place-items:center;padding:16px}
.modal:target{display:grid}
.scrim{position:absolute;inset:0;background:rgba(15,23,42,.45);backdrop-filter:blur(3px);animation:fade .2s ease both}
.sheet{position:relative;width:100%;max-width:420px;background:#fff;border-radius:20px;padding:26px;
box-shadow:0 30px 80px -20px rgba(15,23,42,.45);animation:pop .28s var(--ease) both}
.sheet h2{margin:12px 0 2px}.sheet form{margin:0}
.x{position:absolute;top:12px;right:14px;width:32px;height:32px;display:grid;place-items:center;border-radius:10px;font-size:22px;
line-height:1;color:var(--muted);text-decoration:none}.x:hover{background:#f1f3f9;color:var(--ink)}
.sheeticon{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;color:#fff;
background:linear-gradient(135deg,var(--brand),var(--brand2));box-shadow:0 8px 18px -8px rgba(99,102,241,.9)}
.sheeticon svg{width:22px;height:22px;animation:turn 2.4s var(--ease) infinite alternate}
.crchoices{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.crchoice{margin:0;cursor:pointer}.crchoice input{position:absolute;opacity:0;pointer-events:none}
.crchoice span{display:flex;align-items:center;gap:9px;padding:12px;border:1.5px solid var(--line);border-radius:14px;
transition:border-color .15s,background .15s,box-shadow .15s}
.crchoice svg{width:20px;height:20px}.cr-firecrawl.crchoice svg{color:#ef4444}.cr-tavily.crchoice svg{color:#6366f1}
.crchoice:hover span{border-color:#c9cfe0}
.crchoice input:checked+span{border-color:var(--brand);background:var(--soft);box-shadow:0 0 0 3px rgba(99,102,241,.14)}
.crchoice input:focus-visible+span{outline:3px solid rgba(99,102,241,.35);outline-offset:2px}
@keyframes fade{from{opacity:0}}
@keyframes pop{from{opacity:0;transform:translateY(12px) scale(.97)}}
@keyframes turn{from{transform:rotate(-12deg)}to{transform:rotate(12deg)}}
`;

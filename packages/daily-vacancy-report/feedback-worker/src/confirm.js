// Deleting from the dashboard: a red bin button opens a confirm window (CSS only, with :target like the other
// modals, rendered outside <main>). The window's tick box must be ticked before its Delete button sends the form,
// and the Worker checks it again (confirm=yes).

import { esc } from "./lib.js";

const BIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12.2A2 2 0 0 0 8.5 21h7a2 2 0 0 0 2-1.8L18.5 7M9 7V4.8A1.8 1.8 0 0 1 10.8 3h2.4A1.8 1.8 0 0 1 15 4.8V7"/></svg>';

export function binButton(id, label) {
  return `<a class="binbtn" href="#${esc(id)}" title="${esc(label)}" aria-label="${esc(label)}">${BIN}</a>`;
}

// A square icon link the size of the bin button, for a row of actions: `tone` "edit" (indigo) or "key" (amber).
export function iconButton(href, label, icon, tone) {
  return `<a class="iconbtn ${tone}" href="${esc(href)}" title="${esc(label)}" aria-label="${esc(label)}">${icon}</a>`;
}

// `fields` are the form's hidden inputs; `check` is the tick box's text.
export function deleteModal({ id, title, intro, action, fields, check }) {
  const hidden = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return `<div class="modal" id="${esc(id)}" role="dialog" aria-modal="true" aria-labelledby="${esc(id)}-h">
<a class="scrim" href="#_" aria-label="Close" tabindex="-1"></a>
<div class="sheet"><a class="x" href="#_" aria-label="Close">&times;</a><div class="sheeticon danger">${BIN}</div>
<h2 id="${esc(id)}-h">${esc(title)}</h2><p class="muted">${esc(intro)}</p>
<form method="post" action="${esc(action)}">${hidden}
<label class="check dangercheck"><input type="checkbox" name="confirm" value="yes" required> <span>${esc(check)}</span></label>
<div class="confirmrow"><a class="small quiet cancel" href="#_">Cancel</a><button class="danger">${BIN}Delete</button></div></form></div></div>`;
}

export const CONFIRM_STYLE = `
.binbtn{display:inline-grid;place-items:center;width:34px;height:34px;border-radius:10px;color:#fff;text-decoration:none;
background:linear-gradient(135deg,#ef4444,#dc2626);box-shadow:0 8px 18px -10px rgba(220,38,38,.8);transition:transform .15s var(--ease),filter .15s}
.binbtn:hover{transform:translateY(-1px);filter:brightness(1.06)}.binbtn svg{width:17px;height:17px}
.iconbtn{display:inline-grid;place-items:center;width:34px;height:34px;border-radius:10px;border:1px solid;text-decoration:none;
transition:transform .15s var(--ease),box-shadow .15s}
.iconbtn:hover{transform:translateY(-1px);box-shadow:0 8px 18px -12px rgba(30,27,75,.6)}.iconbtn svg{width:17px;height:17px}
.iconbtn.edit{color:#4338ca;background:#eef2ff;border-color:#c7d2fe}.iconbtn.key{color:#b45309;background:#fffbeb;border-color:#fde68a}
.actions.iconrow{flex-direction:row;align-items:center;gap:8px}
.sheeticon.danger{background:linear-gradient(135deg,#ef4444,#dc2626);box-shadow:0 8px 18px -8px rgba(220,38,38,.9)}
.sheeticon.danger svg{animation:none}
.dangercheck{margin:16px 0 4px;padding:12px 14px;border:1px solid #fecaca;border-radius:12px;background:#fef2f2}
.dangercheck:has(input:checked){border-color:#f87171}
.confirmrow{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:16px}
.confirmrow .cancel{text-decoration:none}
.confirmrow button{display:inline-flex;align-items:center;gap:8px;margin:0}.confirmrow button svg{width:16px;height:16px}
form:has(.dangercheck input:not(:checked)) .confirmrow button{opacity:.55}
`;

// The AI models: the cloud model keys on the Global settings page (OpenRouter, BazaarLink, Featherless and Hugging
// Face, for servers that can't run a model themselves), the server model's row (Ollama) with its Change window (the
// models HermitShell offers, downloaded first when needed, model_pull.py) and which is asked first, and the
// admin's server button beside Sign out, whose panel (shown on hover or focus, since pages run no JavaScript) has
// the machine's CPU, memory, GPUs and disk and the model that answers. Everything comes from HermitShell's status
// (llm_providers.py, key_usage.py, autofit.py) and is checked field by field before it is shown; keys only ever
// arrive masked.

import { BACKUPS_URL } from "./backups.js";
import { ago, esc, savingTag } from "./lib.js";
import { CHEVRON, keyList, leftSummary, logo, reported } from "./keys.js";

export const MODEL_PROVIDERS = {
  openrouter: { label: "OpenRouter", model: "openrouter/free", signup: "https://openrouter.ai/settings/keys",
    about: "Free models: 50 requests a day, 1,000 with $10 of credits" },
  bazaarlink: { label: "BazaarLink", model: "auto:free", signup: "https://bazaarlink.ai/", about: "Free models with a daily limit, or credits" },
  featherless: { label: "Featherless", model: "Qwen/Qwen2.5-7B-Instruct", signup: "https://featherless.ai/", about: "Paid plans; prompts are not logged" },
  huggingface: { label: "Hugging Face", model: "openai/gpt-oss-20b:cheapest", signup: "https://huggingface.co/settings/tokens",
    about: "$0.10 of free credit a month, $2 with PRO" },
};
export const MODEL_KEY_RE = /^[A-Za-z0-9_-]{8,200}$/;
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const modalId = (name) => `mkey-${name}`;
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const text = (v, max = 80) => (typeof v === "string" ? v.slice(0, max) : "");
const modelName = (v) => (typeof v === "string" && MODEL_RE.test(v) ? v : "");
const whole = (v, max = 1e9) => (Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null);
const label = (name) => (name === "ollama" ? "the server model" : MODEL_PROVIDERS[name]?.label || "");

// ------------------------------------------------------------------------- Global settings: model keys

function state(m) {
  if (Number.isFinite(m.resting_until) && m.resting_until > Date.now()) {
    return `<span class="mrest">resting: ${esc(text(m.why, 60) || "unavailable")}</span>`;
  }
  const today = whole(m.today);
  return today ? `${today} request${today === 1 ? "" : "s"} today` : "ready";
}

function clearButton(csrf, provider) {
  return `<form method="post" action="/admin/action" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="action" value="model_key_clear"><input type="hidden" name="provider" value="${esc(provider)}"><button class="small quiet">Use the .env key</button></form>`;
}

function modelRow(name, info, m, csrf, saving = false) {
  const source = m.source === "dashboard" ? "set here" : m.source === "env" ? "from .env" : "";
  const rows = source ? reported(m) : [];
  const model = modelName(m.model) || info.model;
  const hint = source ? `<code class="keyhint" title="Only the start and end of the key are shown">${esc(text(m.hint, 20) || "****")}</code>`
    : `<div class="muted">No key yet &middot; ${esc(info.about)}</div>`;
  const open = source ? `<a class="small" href="#${modalId(name)}">Change</a>`
    : `<a class="addkey" href="#${modalId(name)}">${logo("key")}Add key</a>`;
  const line = source ? `${leftSummary(rows)}<code class="mname">${esc(model)}</code> &middot; ${state(m)} &middot; ` : "";
  const inner = `<span class="crlogo">${logo(name)}</span><div class="keyinfo">
<b>${esc(info.label)}</b>${source ? ` <span class="crtag${m.source === "env" ? " env" : ""}">${source}</span>` : ""}${saving ? ` ${savingTag()}` : ""}${hint}
<div class="muted small">${line}<a href="${esc(info.signup)}" target="_blank" rel="noopener noreferrer">get a key</a></div></div>
<div class="cractions">${open}${m.source === "dashboard" ? clearButton(csrf, name) : ""}</div>`;
  if (!rows.length) return `<div class="keyrow cr-${name}">${inner}</div>`;
  return `<details class="keycard cr-${name}"><summary class="keyrow" title="Show the key and its usage">${inner}${CHEVRON}</summary>
${keyList(rows)}</details>`;
}

// ------------------------------------------------------------------------- the server model (Ollama)

// Ollama names as model_pull.py's NAME_RE takes them: name[/namespace[/repo]][:tag].
export const OLLAMA_RE = /^(?=.{1,120}$)[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,2}(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
export const LOCAL_MODAL = "mlocal";
const ollamaName = (v) => (typeof v === "string" && OLLAMA_RE.test(v) ? v : "");
const SPEEDS = { quick: "quick", steady: "steady", slow: "slow" };
const PULL_STATES = ["downloading", "ready", "failed", "cancelled"];

// The models HermitShell offers (autofit.choices), checked field by field; [] from an older HermitShell.
export function localChoices(local) {
  return (Array.isArray(local.choices) ? local.choices : []).slice(0, 24).map(obj).filter((c) => ollamaName(c.model)).map((c) => ({
    model: c.model, about: text(c.about, 120), mb: whole(c.mb, 1 << 22) ?? 0, gpu: whole(c.gpu, 100) ?? 0, fits: c.fits !== false,
    speed: SPEEDS[c.speed] || "", installed: c.installed === true, recommended: c.recommended === true,
  }));
}

// A download under way or finished in the last day (model_pull.info), or null.
export function localPull(status) {
  const p = obj(obj(obj(status).llm).local).pull;
  if (!p || typeof p !== "object" || !ollamaName(p.model) || !PULL_STATES.includes(p.status)) return null;
  return { model: p.model, status: p.status, done: whole(p.done_mb, 1 << 22) ?? 0, total: whole(p.total_mb, 1 << 22) ?? 0,
    started: whole(p.started, 1e14), finished: whole(p.finished, 1e14), error: text(p.error, 200),
    switch: p.switch !== false, stopping: p.stopping === true };
}

const gbOf = (mb) => `${(mb / 1024).toFixed(1)} GB`;

export function pullPct(p) {
  return p.total ? Math.min(100, Math.round((100 * p.done) / p.total)) : 0;
}

// One line on a download: how far it has got, or how it ended.
export function pullText(p) {
  const name = `<code class="mname">${esc(p.model)}</code>`;
  if (p.status === "downloading") {
    const amount = p.total ? `${pullPct(p)}% &middot; ${gbOf(p.done)} of ${gbOf(p.total)}` : "starting";
    return `${p.stopping ? "Stopping the download of" : "Downloading"} ${name}: ${amount}`;
  }
  if (p.status === "ready") return `${name} is downloaded${p.switch ? " and is now the server model" : ""}`;
  if (p.status === "failed") return `Could not download ${name}${p.error ? `: ${esc(p.error)}` : ""}`;
  return `The download of ${name} was stopped`;
}

function pullBar(p) {
  if (p.status !== "downloading") return "";
  const pct = pullPct(p);
  return `<div class="mpull${p.total ? "" : " indet"}" role="progressbar" aria-label="Download" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p.total ? pct : 35}%"></i></div>`;
}

// The admin dashboard's notice: a download under way (with its bar and where to follow it), or how the last one ended.
export function pullNotice(status) {
  const p = localPull(status);
  if (!p || p.status === "cancelled") return "";
  const tone = p.status === "failed" ? " bad" : p.status === "ready" ? " ok" : "";
  const follow = p.status === "downloading" ? ' <a href="#tasks">Follow it in Tasks</a>.'
    : p.status === "failed" ? ' <a href="/admin/settings#models">Model settings</a>.' : "";
  return `<div class="mnotice${tone}" role="status">${logo("ollama")}<div><b>Server model</b> ${pullText(p)}.${follow}${pullBar(p)}</div></div>`;
}

const SOURCES = { dashboard: "set here", env: "from .env", auto: "fits this machine" };

function localRow(llm, csrf, saving = "") {
  const local = obj(llm.local);
  const model = modelName(local.model);
  const suggested = modelName(local.suggested);
  const where = text(local.where);
  const choices = localChoices(local);
  const pull = localPull({ llm });
  const source = SOURCES[local.source] || "";
  const facts = [where ? `last ran at ${esc(where)}` : "not used yet",
    suggested && suggested !== model ? `this machine suits <code class="mname">${esc(suggested)}</code>` : "",
    local.override === "JOB_SCANNER_MODEL" ? "<code>JOB_SCANNER_MODEL</code> in .env picks the reports&rsquo; model" : ""].filter(Boolean).join(" &middot; ");
  const change = choices.length ? `<div class="cractions"><a class="small" href="#${LOCAL_MODAL}">Change</a></div>` : "";
  return `<div class="keyrow cr-ollama"><span class="crlogo">${logo("ollama")}</span><div class="keyinfo">
<b>Server model</b> <span class="crtag env">${llm.order === "local" ? "asked first" : "fallback"}</span>${source ? ` <span class="crtag${local.source === "dashboard" ? "" : " env"}">${source}</span>` : ""}${saving ? ` ${savingTag()}` : ""}
${model ? `<code class="keyhint">${esc(model)}</code>` : '<div class="muted">No model yet</div>'}
<div class="muted small">${facts}</div>${pull ? `<div class="mpullrow small">${pullText(pull)}${pullBar(pull)}</div>` : ""}</div>${change}</div>`;
}

function choiceRow(c, current, inUse, offline) {
  const tags = [c.recommended ? '<em class="crtag">recommended</em>' : "", c.installed ? '<em class="crtag env">downloaded</em>' : "",
    c.model === inUse ? '<em class="crtag env">in use</em>' : ""].filter(Boolean).join(" ");
  const where = !c.fits ? "needs more memory than this machine has"
    : [c.gpu >= 98 ? "fits the GPU" : c.gpu > 0 ? `${c.gpu}% on the GPU, the rest on the CPU` : "on the CPU", c.speed ? `${c.speed} here` : ""].filter(Boolean).join(", ");
  const size = c.mb ? `${c.installed ? "" : "download "}${gbOf(c.mb)}` : "";
  const off = !c.fits || (offline && !c.installed);
  return `<label class="crchoice mchoice${off ? " off" : ""}"><input type="radio" name="model" value="${esc(c.model)}"${c.model === current ? " checked" : ""}${off ? " disabled" : ""}>
<span><i class="mtext"><b><code class="mname">${esc(c.model)}</code></b> ${tags}<small>${esc(c.about)}</small><small>${[size, where].filter(Boolean).join(" &middot; ")}</small></i></span></label>`;
}

// The Change window: the default, every model HermitShell offers and any other Ollama name.
export function localModal(status, csrf) {
  const local = obj(obj(status.llm).local);
  const choices = localChoices(local);
  if (!choices.length) return "";
  const current = local.source === "dashboard" ? modelName(local.model) : "";
  const offline = local.online === false;
  const custom = current && !choices.some((c) => c.model === current) ? current : "";
  return `<div class="modal" id="${LOCAL_MODAL}" role="dialog" aria-modal="true" aria-labelledby="${LOCAL_MODAL}-h">
<a class="scrim" href="#_" aria-label="Close" tabindex="-1"></a>
<div class="sheet msheet"><a class="x" href="#_" aria-label="Close">&times;</a>
<div class="sheeticon">${logo("ollama")}</div>
<h2 id="${LOCAL_MODAL}-h">Server model</h2><p class="muted">The model Ollama runs on this server for ratings, letters and CVs. A model
that isn&rsquo;t downloaded yet is downloaded first, with its progress under Tasks; HermitShell switches to it once it is ready
and keeps the current one until then.${offline ? " <b>Ollama isn&rsquo;t answering</b>, so only downloaded models can be picked." : ""}</p>
<form method="post" action="/admin/action"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="model_local">
<div class="mchoices"><label class="crchoice mchoice"><input type="radio" name="model" value=""${current ? "" : " checked"}>
<span><i class="mtext"><b>Default</b><small>OLLAMA_MODEL from .env, else the recommended model</small></i></span></label>
${choices.map((c) => choiceRow(c, current, modelName(local.model), offline)).join("")}
<label class="crchoice mchoice"><input type="radio" name="model" value="custom"${custom ? " checked" : ""}${offline ? " disabled" : ""}>
<span><i class="mtext"><b>Another Ollama model</b><small>Any name from the Ollama library, such as <code>mistral:7b</code></small></i></span></label></div>
<label for="${LOCAL_MODAL}-c">Other model name <span class="muted">(for Another Ollama model)</span></label>
<input id="${LOCAL_MODAL}-c" name="custom" autocomplete="off" maxlength="120" value="${esc(custom)}" placeholder="name:tag">
<button>Use this model</button></form></div></div>`;
}

function orderForm(llm, csrf, pending = "") {
  const local = (pending || llm.order) === "local";
  const choice = (value, title, detail, checked) => `<label class="crchoice"><input type="radio" name="order" value="${value}"${checked ? " checked" : ""}>
<span>${logo(value === "local" ? "computer" : "cloud")}<i class="mtext"><b>${title}</b><small>${detail}</small></i></span></label>`;
  return `<form method="post" action="/admin/action" class="morder"><input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="action" value="model_order">
<div class="crchoices">${choice("cloud", "Cloud first", "The server model when no key or credits are left", !local)}${choice("local", "Server first", "The cloud only when the server model doesn&rsquo;t answer", local)}</div>
<button class="small">Save order</button>${pending ? ` ${savingTag()}` : ""}</form>`;
}

// `saving` is { providers, order, local }: the model keys, the order and the server model with a change waiting for HermitShell.
export function modelsSection(status, csrf, saving = { providers: new Set(), order: "", local: false }) {
  const models = obj(status.models);
  const llm = obj(status.llm);
  return `<h2 id="models">AI model API keys</h2>
<p class="muted">For servers that can&rsquo;t run a model themselves. HermitShell asks the providers with a key in this order, and the
server model when none has a key or credits left. They are sent each recruit&rsquo;s CV and the adverts it is compared with,
and free models may keep what they are sent.</p>
<div class="keyrows">${Object.entries(MODEL_PROVIDERS).map(([name, info]) => modelRow(name, info, obj(models[name]), csrf, saving.providers.has(name))).join("")}${localRow(llm, csrf, saving.local)}</div>
${orderForm(llm, csrf, saving.order)}`;
}

// ------------------------------------------------------------------------- Global settings: tokens used

export const TOKEN_TASKS = {
  triage: "Title screening", rating: "Job ratings", verify: "Second opinions", brief: "Rating briefs",
  summary: "Report summaries", profile: "Profiles from CVs", cv_read: "Reading CVs", evidence: "Evidence maps",
  letter: "Cover letters", cv_tailor: "Tailored CVs", interview_prep: "Interview prep packs", skills: "Skills added to CVs", other: "Other",
};

export function tokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

function counts(c) {
  const o = obj(c);
  const n = (k) => whole(o[k], 2 ** 40) ?? 0;
  return { calls: n("calls"), failed: n("failed"), in: n("in"), out: n("out"), avg: whole(o.avg_ms, 3_600_000) ?? 0, estimated: n("estimated") };
}

const seconds = (ms) => (ms >= 10000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

// What each task sent to the models and got back (llm_usage.py): today and over the last days HermitShell reports.
export function usageSection(status) {
  const usage = obj(status.usage);
  const days = whole(usage.days, 31) || 7;
  const rows = (Array.isArray(usage.tasks) ? usage.tasks : []).slice(0, 20).map(obj)
    .filter((r) => Object.hasOwn(TOKEN_TASKS, r.task))
    .map((r) => ({ task: r.task, today: counts(r.today), period: counts(r.period) }))
    .filter((r) => r.period.calls);
  const intro = `<h2 id="usage">Model tokens used</h2>
<p class="muted">What each task sent to the models and got back over the last ${days} days, for every recruit together. Fewer tokens a
request means quicker answers and more of a free allowance left. A <b>~</b> marks counts estimated from the text where a provider didn&rsquo;t say.</p>`;
  if (!rows.length) return `<div class="usage">${intro}<p class="muted small">No model requests counted yet.</p></div>`;
  const total = rows.reduce((sum, r) => sum + r.period.in + r.period.out, 0) || 1;
  const body = rows.map(({ task, today, period: p }) => {
    const all = p.in + p.out;
    const approx = p.estimated ? "~" : "";
    const failed = p.failed ? ` <span class="mrest">${p.failed} failed</span>` : "";
    return `<tr><th scope="row">${esc(TOKEN_TASKS[task])}<div class="ubar" aria-hidden="true"><i style="width:${Math.max(2, Math.round((100 * all) / total))}%"></i></div></th>
<td>${today.calls} <span class="muted">/ ${p.calls}</span>${failed}</td><td>${approx}${tokens(p.in)}</td><td>${approx}${tokens(p.out)}</td>
<td><b>${approx}${tokens(Math.round(all / p.calls))}</b></td><td>${seconds(p.avg)}</td></tr>`;
  }).join("");
  return `<div class="usage">${intro}<div class="utable"><table><thead><tr><th scope="col">Task</th><th scope="col">Requests <span class="muted">today / ${days} days</span></th>
<th scope="col">Tokens in</th><th scope="col">Tokens out</th><th scope="col">A request</th><th scope="col">Time</th></tr></thead>
<tbody>${body}</tbody></table></div></div>`;
}

export function modelModals(csrf) {
  const defaults = Object.values(MODEL_PROVIDERS).map((p) => `${esc(p.label)} <code>${esc(p.model)}</code>`).join(", ");
  return Object.keys(MODEL_PROVIDERS).map((current) => {
    const id = modalId(current);
    const choices = Object.entries(MODEL_PROVIDERS).map(([name, info]) => `<label class="crchoice cr-${name}"><input type="radio" name="provider" value="${name}"${name === current ? " checked" : ""}>
<span>${logo(name)}<b>${esc(info.label)}</b></span></label>`).join("");
    return `<div class="modal" id="${id}" role="dialog" aria-modal="true" aria-labelledby="${id}-h">
<a class="scrim" href="#_" aria-label="Close" tabindex="-1"></a>
<div class="sheet"><a class="x" href="#_" aria-label="Close">&times;</a>
<div class="sheeticon">${logo("model")}</div>
<h2 id="${id}-h">AI model key</h2><p class="muted">Used for every recruit&rsquo;s ratings, cover letters and CVs. Saving replaces that provider&rsquo;s key.</p>
<form method="post" action="/admin/action"><input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="action" value="model_key">
<div class="crchoices">${choices}</div>
<label for="${id}-k">API key</label>
<input id="${id}-k" name="key" type="password" autocomplete="off" minlength="8" maxlength="200" placeholder="Paste the key (blank keeps the current one)">
<label for="${id}-m">Model <span class="muted">(optional)</span></label>
<input id="${id}-m" name="model" autocomplete="off" maxlength="120" placeholder="Blank keeps the current model">
<span class="hint">Defaults: ${defaults}.</span>
<button>Save</button></form></div></div>`;
  }).join("");
}

export const MODEL_STYLE = `
.cr-openrouter .crlogo{background:linear-gradient(135deg,#64748B,#1E293B);box-shadow:0 6px 14px -8px rgb(30 41 59/.9)}
.cr-bazaarlink .crlogo{background:linear-gradient(135deg,#FBBF24,#EA580C);box-shadow:0 6px 14px -8px rgb(234 88 12/.9)}
.cr-featherless .crlogo{background:linear-gradient(135deg,#A78BFA,#7C3AED);box-shadow:0 6px 14px -8px rgb(124 58 237/.9)}
.cr-huggingface .crlogo{color:#78350F;background:linear-gradient(135deg,#FDE68A,#FBBF24);box-shadow:0 6px 14px -8px rgb(245 158 11/.9)}
.cr-ollama .crlogo{background:linear-gradient(135deg,#94A3B8,#475569);box-shadow:0 6px 14px -8px rgb(71 85 105/.9)}
.cr-openrouter.crchoice svg{color:#334155}.cr-bazaarlink.crchoice svg{color:#EA580C}.cr-featherless.crchoice svg{color:#7C3AED}
.cr-huggingface.crchoice svg{color:#D97706}
code.mname{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink);background:#f1f3f9;border-radius:6px;padding:1px 5px}
.mrest{color:#b45309;font-weight:650}
.morder{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin:6px 0 4px}.morder .crchoices{flex:1;min-width:260px;margin:0}
.morder .crchoice span{align-items:flex-start}.mtext{font-style:normal}
.morder .crchoice small{display:block;font-size:12px;color:var(--muted);font-weight:500}
.utable{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:#fff}
.utable table{width:100%;border-collapse:collapse;font-size:13px}
.utable th,.utable td{padding:9px 12px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--line)}
.utable tr:last-child th,.utable tr:last-child td{border-bottom:0}
.utable thead th{font-size:12px;color:var(--muted);font-weight:650;background:#fafbff}
.utable th:first-child{text-align:left;min-width:150px}.utable tbody th{font-weight:650}
.ubar{height:4px;margin-top:5px;border-radius:99px;background:#eef0f7;overflow:hidden;max-width:160px}
.ubar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#6366f1,#8b5cf6);transform-origin:left;animation:fill .6s var(--ease) both}
.mpullrow{margin-top:6px;color:var(--ink)}
.mpull{height:6px;margin-top:6px;border-radius:99px;background:#e9ecf5;overflow:hidden;max-width:360px}
.mpull i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#6366f1,#8b5cf6,#6366f1) 0 0/200% 100%;animation:mflow 1.6s linear infinite}
.mpull.indet i{animation:mslide 1.3s ease-in-out infinite}
.sheet.msheet{max-width:620px;overflow-x:hidden}
.mchoices{display:grid;gap:8px;margin:12px 0;max-height:min(52vh,460px);overflow:hidden auto;padding:3px}
.mchoice{position:relative;display:block}.mchoice span{align-items:flex-start;padding:10px 12px}
.mchoice b{display:inline-block;margin:0 4px 2px 0}.mchoice code.mname{word-break:break-all}
.mchoice small{display:block;font-size:12px;color:var(--muted);font-weight:500;margin-top:2px}
.mchoice em.crtag{font-style:normal;font-size:10.5px;display:inline-block;margin:0 2px 2px 0;vertical-align:1px}
.mchoice .crtag.env{color:var(--brand-ink);background:var(--soft)}
.mchoice.off{opacity:.55}.mchoice.off span{cursor:not-allowed}
@keyframes mflow{to{background-position:-200% 0}}@keyframes mslide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
`;

// The admin dashboard's server model notice.
export const NOTICE_STYLE = `
.mnotice{display:flex;gap:12px;align-items:flex-start;margin:10px 0 14px;padding:12px 14px;border:1px solid #c7d2fe;border-radius:14px;
background:linear-gradient(135deg,#eef2ff,#f5f3ff);font-size:13.5px}
.mnotice>svg{flex:none;width:20px;height:20px;margin-top:1px;color:var(--brand)}.mnotice>div{flex:1;min-width:0}
.mnotice.ok{border-color:#bbf7d0;background:#f0fdf4}.mnotice.ok>svg{color:#059669}
.mnotice.bad{border-color:#fecaca;background:#fef2f2}.mnotice.bad>svg{color:#dc2626}
.mnotice .mpull{height:6px;margin-top:8px;border-radius:99px;background:#e0e4f5;overflow:hidden}
.mnotice .mpull i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#6366f1,#8b5cf6,#6366f1) 0 0/200% 100%;animation:mflow 1.6s linear infinite}
.mnotice .mpull.indet i{animation:mslide 1.3s ease-in-out infinite}
.mnotice code.mname{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink);background:#fff;border-radius:6px;padding:1px 5px}
@keyframes mflow{to{background-position:-200% 0}}@keyframes mslide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
`;

// ------------------------------------------------------------------------- the admin's server panel

function bar(pct, cls = "") {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return `<div class="sbar${p >= 90 ? " low" : p >= 70 ? " mid" : ""}${cls}" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></div>`;
}

const gb = (mb) => `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;

function meter(title, used, total, detail) {
  if (!total || used === null) return "";
  return `<div class="smeter"><div class="shead"><b>${title}</b><span>${detail}</span></div>${bar((100 * used) / total)}</div>`;
}

function serverFacts(server) {
  const cpu = obj(server.cpu);
  const cores = whole(cpu.cores, 4096);
  const load = Number.isFinite(server.load) && server.load >= 0 ? Math.round(server.load * 100) / 100 : null;
  const ram = obj(server.ram_mb);
  const [total, free] = [whole(ram.total, 1 << 24), whole(ram.available, 1 << 24)];
  const disk = obj(server.disk_mb);
  const [dTotal, dFree] = [whole(disk.total, 2 ** 40), whole(disk.free, 2 ** 40)];
  const gpus = (Array.isArray(server.gpus) ? server.gpus : []).slice(0, 4).map(obj);
  const seen = Number.isFinite(server.gpus_at) ? ` since ${esc(ago(server.gpus_at))}` : "";
  return [
    cores ? meter("CPU", load, cores, `${esc(text(cpu.model, 60) || "CPU")} &middot; ${cores} threads${load !== null ? ` &middot; load ${load}` : ""}`) : "",
    total && free !== null ? meter("Memory", total - free, total, `${gb(total - free)} of ${gb(total)} used`) : "",
    ...gpus.map((g) => {
      const [vram, vfree] = [whole(g.vram_mb, 1 << 22), whole(g.free_mb, 1 << 22)];
      if (!vram) return "";
      const name = esc(text(g.name, 60) || "GPU");
      return vfree !== null ? meter("GPU", vram - vfree, vram, `${name} &middot; ${gb(vram - vfree)} of ${gb(vram)}`)
        : `<div class="smeter"><div class="shead"><b>GPU</b><span>${name} &middot; ${gb(vram)}</span></div><p class="snote">Use not reported${seen}: the host's hardware report (the Ollama watchdog) is late.</p></div>`;
    }),
    dTotal && dFree !== null ? meter("Disk", dTotal - dFree, dTotal, `${gb(dFree)} free of ${gb(dTotal)}`) : "",
  ].filter(Boolean).join("");
}

function modelFacts(status) {
  const llm = obj(status.llm);
  const models = obj(status.models);
  const local = obj(llm.local);
  const cloud = (Array.isArray(llm.cloud) ? llm.cloud : []).filter((n) => Object.hasOwn(MODEL_PROVIDERS, n));
  const order = llm.order === "local" ? ["ollama", ...cloud] : [...cloud, "ollama"];
  const last = obj(llm.last);
  const lastName = last.provider === "ollama" || Object.hasOwn(MODEL_PROVIDERS, last.provider) ? last.provider : "";
  const rows = order.map((name) => {
    if (name === "ollama") {
      const model = modelName(local.model);
      const where = text(local.where);
      const pull = localPull(status);
      return `<li>${logo("ollama")}<span><b>Server model</b> <code class="mname">${esc(model || "no model")}</code>${where ? `<small>${esc(where)}</small>` : ""}${pull?.status === "downloading" ? `<small>${pullText(pull)}</small>` : ""}</span></li>`;
    }
    const m = obj(models[name]);
    return `<li class="cr-${name}">${logo(name)}<span><b>${esc(MODEL_PROVIDERS[name].label)}</b> <code class="mname">${esc(modelName(m.model) || MODEL_PROVIDERS[name].model)}</code><small>${state(m)}</small></span></li>`;
  }).join("");
  const answered = lastName && Number.isFinite(last.at)
    ? `<p class="slast">Last answer from ${esc(label(lastName))}${modelName(last.model) ? ` (<code class="mname">${esc(last.model)}</code>)` : ""}, ${esc(ago(last.at))}.</p>` : "";
  return `<div class="ssec"><b>Models, in the order they are asked</b></div><ol class="smodels">${rows}</ol>${answered}`;
}

const size = (bytes) => (bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB`
  : bytes >= 2 ** 20 ? `${(bytes / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const OFFSITE_OFF = {
  off: "Kept on this server only (<code>HERMES_BACKUP_OFFSITE=off</code>).",
  unencrypted: "Not sent to Cloudflare until they are encrypted.",
  worker: "Redeploy the Worker to keep copies on Cloudflare too.",
};

// The copies on Cloudflare (backups.js): when the last went, how many are kept and where to download them. A
// HermitShell from before them sends no offsite field, so nothing is said.
function offsiteFacts(o) {
  if (!o || typeof o !== "object") return "";
  if (o.on !== true) return OFFSITE_OFF[o.why] ? `<p class="snote">${OFFSITE_OFF[o.why]}</p>` : "";
  const [at, failed, kept] = [whole(o.at, 1e14), whole(o.failed_at, 1e14), whole(o.kept, 10000)];
  const error = text(o.error, 200);
  const sent = at ? `On Cloudflare too: last sent ${esc(ago(at))}${kept ? ` &middot; ${kept} kept` : ""}` : "On Cloudflare too, from the next backup";
  return `${error && failed && failed >= (at || 0) ? `<p class="sbad">Sending the last backup to Cloudflare failed ${esc(ago(failed))}: ${esc(error)}</p>` : ""}<p class="sback">${sent} &middot; <a href="${BACKUPS_URL}">Download</a></p>`;
}

// The nightly backups (maintenance.py, state/backup.json): the last one or its failure, and Back up now. An older
// HermitShell sends no backup field, so the section is left out.
function backupFacts(status, csrf) {
  if (!status.backup || typeof status.backup !== "object") return "";
  const b = obj(status.backup);
  const [at, failed] = [whole(b.at, 1e14), whole(b.failed_at, 1e14)];
  const [bytes, kept] = [whole(b.size, 2 ** 50), whole(b.kept, 10000)];
  const error = text(b.error, 200);
  const last = at ? `Last backup ${esc(ago(at))}${bytes ? ` &middot; ${size(bytes)}` : ""}${kept ? ` &middot; ${kept} kept` : ""}` : "No backup yet.";
  return `<div class="ssec"><b>Backups</b></div>
${error && failed ? `<p class="sbad">The last backup failed ${esc(ago(failed))}: ${esc(error)}</p>` : ""}<p class="sback">${last}</p>
${offsiteFacts(b.offsite)}
${b.encrypted === true ? '<p class="snote">Backups open only with <code>HERMES_DATA_KEY</code>: keep a copy of it away from this server, in a password manager.</p>'
    : '<p class="sbad">Backups are not encrypted: set <code>HERMES_DATA_KEY</code> (<code>python3 maintenance.py --new-key</code>).</p>'}
<form method="post" action="/admin/action" class="sbackup"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="backup_now"><button class="small quiet">Back up now</button></form>`;
}

// The admin's server button and its panel; recruiters don't get one.
export function serverBox(status, csrf = "") {
  const server = obj(status.server);
  const facts = serverFacts(server);
  const reportedAt = Number.isFinite(status.updated) ? `reported ${esc(ago(status.updated))}` : "not reported yet";
  return `<div class="srv" tabindex="0" aria-label="Server and models" aria-describedby="srvpanel"><span class="mebtn srvbtn" title="Server">${logo("server")}</span>
<div class="srvpanel" id="srvpanel" role="tooltip"><div class="stitle">${logo("server")}<b>Server</b><span>${reportedAt}</span></div>
${facts || '<p class="muted small">HermitShell hasn&rsquo;t reported the machine yet.</p>'}
${modelFacts(status)}${backupFacts(status, csrf)}<a class="small" href="/admin/settings#models">Model settings</a></div></div>`;
}

export const SERVER_STYLE = `
.mebtns{position:relative}.srv{outline:none}.srvbtn{width:34px;padding:0;justify-content:center}
.srv:focus-visible .srvbtn{outline:3px solid rgba(99,102,241,.35);outline-offset:2px}
.srvpanel{display:none;position:absolute;top:42px;right:0;z-index:20;width:min(340px,calc(100vw - 32px));box-sizing:border-box;padding:16px;
background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 24px 60px -20px rgba(15,23,42,.45);text-align:left;
font-size:13px;color:var(--ink);animation:panelin .2s var(--ease) both}
@keyframes panelin{from{opacity:0;transform:translateY(-4px)}}
.srv:hover .srvpanel,.srv:focus-within .srvpanel{display:block}
.srvpanel:before{content:"";position:absolute;top:-10px;left:0;right:0;height:10px}
.stitle{display:flex;align-items:center;gap:8px;margin-bottom:10px}.stitle svg{width:18px;height:18px;color:var(--brand)}
.stitle span{margin-left:auto;font-size:11.5px;color:var(--muted)}
.smeter{margin:8px 0}.shead{display:flex;gap:8px;align-items:baseline;justify-content:space-between}.shead b{font-size:12.5px}
.shead span{font-size:11.5px;color:var(--muted);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbar{height:6px;margin-top:5px;border-radius:99px;background:#e9ecf5;overflow:hidden}
.sbar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#6366f1,#8b5cf6)}
.sbar.mid i{background:linear-gradient(90deg,#f59e0b,#fbbf24)}.sbar.low i{background:linear-gradient(90deg,#ef4444,#f87171)}
.ssec{margin:14px 0 6px;font-size:12.5px}
.smodels{list-style:none;margin:0;padding:0;display:grid;gap:6px;counter-reset:m}
.smodels li{display:flex;gap:9px;align-items:flex-start;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:#fafbff}
.smodels li>svg{flex:none;width:16px;height:16px;margin-top:2px;color:var(--brand)}
.smodels small{display:block;color:var(--muted);font-size:11.5px;margin-top:2px}
.slast{margin:8px 0;font-size:12px;color:var(--muted)}
.sback,.sbad,.snote{margin:4px 0;font-size:12px}.sbad{color:#b91c1c;font-weight:600}.snote{color:var(--muted);font-size:11.5px}
.sback+.snote,.sback+.sbad{margin-top:2px}.sbackup{margin:6px 0 10px}
`;

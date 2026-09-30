// The AI models: the cloud model keys on the Global settings page (OpenRouter, BazaarLink, Featherless and Hugging
// Face, for servers that can't run a model themselves), the local Ollama's row and which is asked first, and the
// admin's server button beside Sign out, whose panel (shown on hover or focus, since pages run no JavaScript) has
// the machine's CPU, memory, GPUs and disk and the model that answers. Everything comes from HermitShell's status
// (llm_providers.py, key_usage.py, autofit.py) and is checked field by field before it is shown; keys only ever
// arrive masked.

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
const label = (name) => (name === "ollama" ? "the local Ollama" : MODEL_PROVIDERS[name]?.label || "");

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

function localRow(llm) {
  const local = obj(llm.local);
  const model = modelName(local.model);
  const suggested = modelName(local.suggested);
  const where = text(local.where);
  const facts = [where ? `last ran at ${esc(where)}` : "not used yet",
    suggested && suggested !== model ? `this machine suits <code class="mname">${esc(suggested)}</code>` : ""].filter(Boolean).join(" &middot; ");
  return `<div class="keyrow cr-ollama"><span class="crlogo">${logo("ollama")}</span><div class="keyinfo">
<b>Local Ollama</b> <span class="crtag env">${llm.order === "local" ? "asked first" : "fallback"}</span>
${model ? `<code class="keyhint">${esc(model)}</code>` : '<div class="muted">No model yet</div>'}
<div class="muted small">${facts}</div></div></div>`;
}

function orderForm(llm, csrf, pending = "") {
  const local = (pending || llm.order) === "local";
  const choice = (value, title, detail, checked) => `<label class="crchoice"><input type="radio" name="order" value="${value}"${checked ? " checked" : ""}>
<span>${logo(value === "local" ? "computer" : "cloud")}<i class="mtext"><b>${title}</b><small>${detail}</small></i></span></label>`;
  return `<form method="post" action="/admin/action" class="morder"><input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="action" value="model_order">
<div class="crchoices">${choice("cloud", "Cloud first", "Ollama when no key or credits are left", !local)}${choice("local", "Local first", "The cloud only when Ollama doesn&rsquo;t answer", local)}</div>
<button class="small">Save order</button>${pending ? ` ${savingTag()}` : ""}</form>`;
}

// `saving` is { providers, order }: the model keys and the order with a change waiting for HermitShell.
export function modelsSection(status, csrf, saving = { providers: new Set(), order: "" }) {
  const models = obj(status.models);
  const llm = obj(status.llm);
  return `<h2 id="models">AI model API keys</h2>
<p class="muted">For servers that can&rsquo;t run a model themselves. HermitShell asks the providers with a key in this order, and the
local Ollama when none has a key or credits left. They are sent each recruit&rsquo;s CV and the adverts it is compared with,
and free models may keep what they are sent.</p>
<div class="keyrows">${Object.entries(MODEL_PROVIDERS).map(([name, info]) => modelRow(name, info, obj(models[name]), csrf, saving.providers.has(name))).join("")}${localRow(llm)}</div>
${orderForm(llm, csrf, saving.order)}`;
}

// ------------------------------------------------------------------------- Global settings: tokens used

export const TOKEN_TASKS = {
  triage: "Title screening", rating: "Job ratings", verify: "Second opinions", brief: "Rating briefs",
  summary: "Report summaries", profile: "Profiles from CVs", cv_read: "Reading CVs", evidence: "Evidence maps",
  letter: "Cover letters", cv_tailor: "Tailored CVs", skills: "Skills added to CVs", other: "Other",
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
.cr-openrouter .crlogo{background:linear-gradient(135deg,#64748b,#1e293b);box-shadow:0 6px 14px -8px rgba(30,41,59,.9)}
.cr-bazaarlink .crlogo{background:linear-gradient(135deg,#fbbf24,#ea580c);box-shadow:0 6px 14px -8px rgba(234,88,12,.9)}
.cr-featherless .crlogo{background:linear-gradient(135deg,#a78bfa,#7c3aed);box-shadow:0 6px 14px -8px rgba(124,58,237,.9)}
.cr-huggingface .crlogo{color:#78350f;background:linear-gradient(135deg,#fde68a,#fbbf24);box-shadow:0 6px 14px -8px rgba(245,158,11,.9)}
.cr-ollama .crlogo{background:linear-gradient(135deg,#94a3b8,#475569);box-shadow:0 6px 14px -8px rgba(71,85,105,.9)}
.cr-openrouter.crchoice svg{color:#334155}.cr-bazaarlink.crchoice svg{color:#ea580c}.cr-featherless.crchoice svg{color:#7c3aed}
.cr-huggingface.crchoice svg{color:#d97706}
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
.ubar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#6366f1,#8b5cf6);animation:fill .6s var(--ease) both}
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
  return [
    cores ? meter("CPU", load, cores, `${esc(text(cpu.model, 60) || "CPU")} &middot; ${cores} threads${load !== null ? ` &middot; load ${load}` : ""}`) : "",
    total && free !== null ? meter("Memory", total - free, total, `${gb(total - free)} of ${gb(total)} used`) : "",
    ...gpus.map((g) => {
      const [vram, vfree] = [whole(g.vram_mb, 1 << 22), whole(g.free_mb, 1 << 22)];
      return vram && vfree !== null ? meter("GPU", vram - vfree, vram, `${esc(text(g.name, 60) || "GPU")} &middot; ${gb(vram - vfree)} of ${gb(vram)}`) : "";
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
      return `<li>${logo("ollama")}<span><b>Local Ollama</b> <code class="mname">${esc(model || "no model")}</code>${where ? `<small>${esc(where)}</small>` : ""}</span></li>`;
    }
    const m = obj(models[name]);
    return `<li class="cr-${name}">${logo(name)}<span><b>${esc(MODEL_PROVIDERS[name].label)}</b> <code class="mname">${esc(modelName(m.model) || MODEL_PROVIDERS[name].model)}</code><small>${state(m)}</small></span></li>`;
  }).join("");
  const answered = lastName && Number.isFinite(last.at)
    ? `<p class="slast">Last answer from ${esc(label(lastName))}${modelName(last.model) ? ` (<code class="mname">${esc(last.model)}</code>)` : ""}, ${esc(ago(last.at))}.</p>` : "";
  return `<div class="ssec"><b>Models, in the order they are asked</b></div><ol class="smodels">${rows}</ol>${answered}`;
}

// The admin's server button and its panel; recruiters don't get one.
export function serverBox(status) {
  const server = obj(status.server);
  const facts = serverFacts(server);
  const reportedAt = Number.isFinite(status.updated) ? `reported ${esc(ago(status.updated))}` : "not reported yet";
  return `<div class="srv" tabindex="0" aria-label="Server and models" aria-describedby="srvpanel"><span class="mebtn srvbtn" title="Server">${logo("server")}</span>
<div class="srvpanel" id="srvpanel" role="tooltip"><div class="stitle">${logo("server")}<b>Server</b><span>${reportedAt}</span></div>
${facts || '<p class="muted small">HermitShell hasn&rsquo;t reported the machine yet.</p>'}
${modelFacts(status)}<a class="small" href="/admin/settings#models">Model settings</a></div></div>`;
}

export const SERVER_STYLE = `
.mebtns{position:relative}.srv{outline:none}.srvbtn{width:34px;padding:0;justify-content:center}
.srv:focus-visible .srvbtn{outline:3px solid rgba(99,102,241,.35);outline-offset:2px}
.srvpanel{display:none;position:absolute;top:42px;right:0;z-index:20;width:min(340px,calc(100vw - 32px));box-sizing:border-box;padding:16px;
background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 24px 60px -20px rgba(15,23,42,.45);text-align:left;
font-size:13px;color:var(--ink);animation:pop .2s var(--ease) both}
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
`;

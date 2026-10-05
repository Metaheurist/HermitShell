// The Mailpit test inbox: every email the backend sends lands here. Journeys wait for a message by recipient and
// subject, then follow its links, rewritten from the backend's Worker address to the one the browser uses.

import { BACKEND_WORKER, INBOX, TARGET } from "./config.js";
import { until } from "./stack.js";

async function api(path, init) {
  const res = await fetch(new URL(path, INBOX), init);
  if (!res.ok) throw new Error(`Mailpit ${path} answered ${res.status}`);
  return res.status === 204 ? {} : res.json();
}

export async function search(query) {
  const { messages = [] } = await api(`/api/v1/search?query=${encodeURIComponent(query)}&limit=50`);
  return messages;
}

export async function message(id) {
  return api(`/api/v1/message/${encodeURIComponent(id)}`);
}

// The newest message matching `to` and a subject pattern that arrived after `since` (ms).
export async function waitForEmail({ to, subject, since = 0, timeout = 600000 }) {
  return until(`an email to ${to} (${subject})`, async () => {
    const recent = to ? await search(`to:${to}`) : (await api("/api/v1/messages?limit=50")).messages || [];
    const found = recent
      .filter((m) => Date.parse(m.Created) >= since - 1000 && (!subject || new RegExp(subject, "i").test(m.Subject)));
    return found.length ? message(found[0].ID) : null;
  }, { timeout, every: 4000, log: false });
}

export function rewrite(url) {
  return url.startsWith(BACKEND_WORKER) ? TARGET + url.slice(BACKEND_WORKER.length) : url;
}

// The links in a message's HTML, rewritten for the browser, with their visible text.
export function links(msg) {
  const out = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m; (m = re.exec(msg.HTML || ""));) {
    const href = m[1].replace(/&amp;/g, "&");
    out.push({ href: rewrite(href), text: m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() });
  }
  return out;
}

export function link(msg, text) {
  const hit = links(msg).find((l) => (text instanceof RegExp ? text.test(l.text) : l.text.includes(text)));
  if (!hit) throw new Error(`no link "${text}" in "${msg.Subject}"`);
  return hit.href;
}

export async function clear() {
  await api("/api/v1/messages", { method: "DELETE" });
}

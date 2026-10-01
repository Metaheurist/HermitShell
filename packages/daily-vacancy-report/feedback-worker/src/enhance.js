// The dashboard's one script, served as a file (script-src 'self', nothing inline) to signed-in pages only. Every page
// works without it: it only makes two things smoother where scripts run.
// - A page waiting for HermitShell updates in place (its card is swapped for the fresh one) instead of reloading, and
//   only while nothing is being typed and no window or menu is open, so input, focus and scroll are kept. The swap is
//   immediate, skipped when nothing changed, and plays no entrance animation again. Without scripts the <noscript>
//   refresh reloads the page as before.
// - A form sends once: pressing again, or double clicking, while its page loads does nothing.
// - The theme page's preview follows the custom colours, the name and a logo as soon as it is picked (the rest it
//   follows by CSS). The picked file is shown from a blob: address, never uploaded until Save theme; one that is too
//   big or not a picture is cleared at once with the reason.
// - The Tasks button's count follows the task list each time that list reloads in its window.
import { fnv } from "./lib.js";

const SOURCE = `(() => {
  "use strict";
  const idle = (form) => { delete form.dataset.sent; form.removeAttribute("aria-busy");
    form.querySelectorAll(".pressing").forEach((b) => b.classList.remove("pressing")); };
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (e.defaultPrevented || !(form instanceof HTMLFormElement) || form.target === "_blank") return;
    if (form.dataset.sent) { e.preventDefault(); return; }
    form.dataset.sent = "1";
    form.setAttribute("aria-busy", "true");
    if (e.submitter) e.submitter.classList.add("pressing");
    setTimeout(() => idle(form), 8000);
  });
  addEventListener("pageshow", (e) => { if (e.persisted) document.querySelectorAll("form[aria-busy]").forEach(idle); });

  document.addEventListener("input", (e) => {
    const field = e.target;
    const form = field instanceof HTMLInputElement ? field.closest("form.theme") : null;
    if (!form) return;
    if (field.dataset.pv) {
      form.style.setProperty(field.dataset.pv, field.value);
      const custom = form.querySelector("#pal-custom");
      if (custom) custom.checked = true;
    }
    if (field.name === "name") form.querySelectorAll(".pvname").forEach((n) => { n.textContent = field.value.trim() || "HermitShell"; });
  });

  let markWas = null;
  let picked = "";
  document.addEventListener("change", (e) => {
    const field = e.target;
    const form = field instanceof HTMLInputElement ? field.closest("form.theme") : null;
    const mark = form && form.querySelector(".pvmark");
    if (!mark || !(field.name === "logo" || field.name === "nologo")) return;
    if (!markWas) markWas = [...mark.childNodes].map((n) => n.cloneNode(true));
    const input = form.querySelector('input[type="file"][name="logo"]');
    const say = form.querySelector(".tlogobad");
    const tell = (text) => { if (say) { say.textContent = text; say.hidden = !text; } };
    const restore = () => mark.replaceChildren(...markWas.map((n) => n.cloneNode(true)));
    const drop = form.querySelector("#nologo");
    if (field.name === "nologo") {
      if (picked) return;
      if (field.checked) mark.replaceChildren((form.querySelector(".pvname").textContent.trim() || "H").slice(0, 1).toUpperCase());
      else restore();
      return;
    }
    if (picked) { URL.revokeObjectURL(picked); picked = ""; }
    const file = input.files && input.files[0];
    const max = Number(input.dataset.max) || 0;
    let problem = "";
    if (file && file.type && !input.accept.split(",").includes(file.type)) problem = "That isn't a PNG, JPEG, GIF or WebP picture. SVG isn't accepted, as it can carry script.";
    else if (file && max && file.size > max) problem = "That picture is over " + Math.round(max / 1024) + " KB. Try a smaller one.";
    tell(problem);
    if (problem) input.value = "";
    if (!file || problem) { restore(); return; }
    const img = new Image();
    img.alt = "";
    img.addEventListener("error", () => {
      tell("That picture can't be shown. Try a PNG, JPEG, GIF or WebP file.");
      input.value = "";
      restore();
    });
    img.src = picked = URL.createObjectURL(file);
    mark.replaceChildren(img);
    if (drop) drop.checked = false;
  });

  document.addEventListener("load", (e) => {
    const frame = e.target;
    const btn = document.querySelector("a.tasksbtn");
    if (!(frame instanceof HTMLIFrameElement) || !frame.matches(".tasksframe") || !btn) return;
    let list;
    try { list = frame.contentDocument; } catch { return; }
    if (!list || !list.querySelector("ul.tasks, .tempty")) return;
    const count = list.querySelectorAll("li.task").length;
    const n = count > 99 ? "99+" : String(count);
    btn.classList.toggle("busy", count > 0);
    btn.title = count ? n + (count === 1 ? " task" : " tasks") + " waiting or running" : "Tasks";
    let badge = btn.querySelector(".tcount");
    if (!count) { if (badge) badge.remove(); return; }
    if (!badge) { badge = document.createElement("span"); badge.className = "tcount"; btn.append(badge); }
    badge.textContent = n;
  }, true);

  const meta = document.querySelector('meta[name="hs-refresh"]');
  if (!meta) return;
  let edited = false;
  document.addEventListener("input", () => { edited = true; }, true);
  const read = (m) => {
    const [s, u] = m.content.split(";url=");
    return { secs: Math.max(1, Number(s) || 4), url: new URL(u || location.href, location.href) };
  };
  let { secs, url } = read(meta);
  const busy = () => edited || document.hidden || document.querySelector(".modal:target, form[aria-busy]") ||
    (document.activeElement && document.activeElement.matches("input, textarea, select"));
  const later = (s) => setTimeout(tick, s * 1000);
  async function tick() {
    if (busy()) return later(2);
    let res;
    try {
      res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    } catch {
      return later(secs);
    }
    if (!res.ok || res.redirected) return location.replace(url);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const next = doc.querySelector("main");
    const now = document.querySelector("main");
    if (!next || !now) return location.replace(url);
    if (busy()) return later(2);
    const open = [...now.querySelectorAll("details")].map((d) => d.open);
    const fresh = next.querySelectorAll("details");
    if (fresh.length === open.length) fresh.forEach((d, i) => { d.open = open[i]; });
    if (!next.isEqualNode(now)) {
      now.replaceWith(next);
      document.title = doc.title;
      for (const a of next.getAnimations({ subtree: true })) if (a.effect && a.effect.getTiming().iterations !== Infinity) a.finish();
    }
    const more = doc.querySelector('meta[name="hs-refresh"]');
    if (more) { ({ secs, url } = read(more)); later(secs); }
  }
  later(secs);
})();
`;

// A short digest of the script in its address, so browsers can keep it for a year and still get a changed one.
export const ENHANCE_PATH = "/enhance.js";
export const ENHANCE_URL = `${ENHANCE_PATH}?v=${fnv(SOURCE)}`;
export const ENHANCE_CSP = "script-src 'self'; connect-src 'self'";

export function enhanceScript() {
  return new Response(SOURCE, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// A signed-in page with the script: its refresh moves into <noscript> for browsers without scripts, and a copy the
// script reads takes its place.
export function enhance(html) {
  return html
    .replace(/<meta http-equiv="refresh" content="([^"]*)">/, (tag, content) => `<noscript>${tag}</noscript><meta name="hs-refresh" content="${content}">`)
    .replace("</body>", `<script src="${ENHANCE_URL}" defer></script></body>`);
}

// blob: images are only the logo picked on the theme page, made by the script from a file the admin chose.
export function enhancedCsp(csp) {
  return csp ? csp.replace("default-src 'none';", `default-src 'none'; ${ENHANCE_CSP};`).replace("img-src 'self'", "img-src 'self' blob:") : csp;
}

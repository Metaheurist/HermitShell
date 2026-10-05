// What makes the walkthrough watchable: a caption banner at the top of each window ("Recruiter: Send jobs for Sam Lee")
// with a running timer while something slow is awaited, and a highlight on each element before it is used.

import { caption as tell } from "./screencast.js";

const BANNER = (actor, text, colour) => {
  const id = "explore-caption";
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = "position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;"
      + "font:600 14px/1.3 system-ui,sans-serif;color:#fff;padding:8px 14px;border-radius:10px;max-width:90vw;"
      + "box-shadow:0 6px 20px rgba(0,0,0,.25);white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    document.documentElement.appendChild(el);
  }
  el.style.background = colour;
  el.textContent = `${actor}: ${text}`;
};

const COLOURS = { Admin: "#4338ca", Manager: "#0f766e", Recruiter: "#b45309", Recruit: "#be185d", Inbox: "#334155" };

export function slow() {
  return Number(process.env.EXPLORE_SLOW || 0);
}

export async function caption(page, actor, text) {
  const colour = COLOURS[actor] || "#334155";
  tell(actor, text);
  await page.evaluate(BANNER, actor, text, colour).catch(() => {});
  // Captions survive navigations: re-drawn on every load.
  if (!page.__exploreCaption) {
    page.__exploreCaption = true;
    page.on("load", () => page.evaluate(BANNER, page.__actor || actor, page.__text || text, page.__colour || colour).catch(() => {}));
  }
  Object.assign(page, { __actor: actor, __text: text, __colour: colour });
}

// Waits for `check` while the banner counts the seconds, so a long AI step is visibly alive.
export async function waitShowing(page, actor, text, check, { timeout = 900000, every = 4000 } = {}) {
  const start = Date.now();
  for (;;) {
    const secs = Math.round((Date.now() - start) / 1000);
    await caption(page, actor, `${text} (${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s)`);
    const done = await check().catch(() => false);
    if (done) return done;
    if (Date.now() - start > timeout) throw new Error(`timed out: ${text}`);
    await page.waitForTimeout(every);
  }
}

// Outlines an element for a moment before it is clicked or typed into.
export async function highlight(locator) {
  if (!slow()) return;
  await locator.evaluate((el) => {
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const before = el.style.outline;
    el.style.outline = "3px solid #f59e0b";
    el.style.outlineOffset = "2px";
    setTimeout(() => { el.style.outline = before; }, 900);
  }).catch(() => {});
  await locator.page().waitForTimeout(Math.min(slow() * 2, 900));
}

export async function click(locator) {
  await highlight(locator);
  await locator.click();
}

export async function fill(locator, value) {
  await highlight(locator);
  await locator.fill(value);
}

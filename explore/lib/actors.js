// The people in the walkthrough, each in their own visible Chromium window, tiled across the screen and labelled by
// the caption banner. Sign-ins are kept per person (sessions folder, outside the repo) so journeys don't repeat them.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

import { SESSIONS_DIR, TARGET } from "./config.js";
import { screencast } from "./screencast.js";
import { caption, click, fill, slow } from "./show.js";

// Window slots: 2 x 2 on a 1920 x 1080 screen.
const SLOTS = { Admin: [0, 0], Recruiter: [960, 0], Recruit: [0, 540], Manager: [960, 540], Inbox: [480, 270] };
const open = new Map();

export async function actor(role, { key = role, size = [960, 540] } = {}) {
  if (open.has(key)) return open.get(key);
  const [x, y] = SLOTS[role] || [240, 120];
  const headless = process.env.EXPLORE_HEADLESS === "1";
  const browser = await chromium.launch({ headless, slowMo: slow(),
    args: headless ? [] : [`--window-position=${x},${y}`, `--window-size=${size[0]},${size[1]}`] });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const session = join(SESSIONS_DIR, `${key}.json`);
  const out = process.env.EXPLORE_OUT;
  const context = await browser.newContext({
    baseURL: TARGET, ignoreHTTPSErrors: true, viewport: null,
    ...(existsSync(session) ? { storageState: session } : {}),
    ...(out && process.env.EXPLORE_FAST !== "1" ? { recordVideo: { dir: join(out, "video", key) } } : {}),
  });
  const page = await context.newPage();
  const who = { role, key, browser, context, page, session,
    say: (text) => caption(page, role, text),
    click: (locator) => click(locator),
    fill: (locator, value) => fill(locator, value),
    save: () => context.storageState({ path: session }),
    close: async () => { open.delete(key); await context.close(); await browser.close(); } };
  await screencast(who);
  open.set(key, who);
  return who;
}

// Signs a staff member in (or reuses their saved session) and lands on the dashboard.
export async function signIn(who, username, password) {
  await who.page.goto("/admin");
  if (await who.page.getByLabel("Username").isVisible().catch(() => false)) {
    await who.say(`signing in as ${username}`);
    await who.fill(who.page.getByLabel("Username"), username);
    await who.fill(who.page.getByLabel("Password"), password);
    await who.click(who.page.getByRole("button", { name: "Sign in" }));
    await who.page.waitForLoadState();
    await who.save();
  }
  return who;
}

export async function closeAll() {
  for (const who of [...open.values()]) await who.close().catch(() => {});
}

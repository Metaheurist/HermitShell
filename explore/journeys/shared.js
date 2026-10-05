// What the journeys share: who is who, their passwords (chosen at random by the team journey and kept in the run
// state outside the repo), the recruits' ids once they have joined, and the slow waits on HermitShell.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "@playwright/test";

import { actor, signIn } from "../lib/actors.js";
import { EXPLORE_DIR, loadEnv, readState, writeState } from "../lib/config.js";
import { waitForEmail } from "../lib/mailpit.js";
import { waitShowing } from "../lib/show.js";

export const DATA = join(EXPLORE_DIR, "data");
export const RECRUITER = { name: "Riley Chen", username: "riley" };
export const MANAGER = { name: "Morgan Ellis", username: "morgan" };
export const RECRUITS = {
  sam: { name: "Sam Lee", email: "sam.lee@example.com", town: "York", roles: "Senior data analyst or analytics engineer, hybrid or remote",
    paste: "sam-lee.txt", region: "York", towns: "Leeds, Harrogate" },
  jordan: { name: "Jordan Patel", email: "jordan.patel@example.net", town: "Manchester", roles: "Senior backend or data engineer, Python",
    file: "jordan-patel.pdf", region: "Greater Manchester", towns: "Salford, Stockport" },
  taylor: { name: "Taylor Reid", email: "taylor.reid@example.org", town: "Leeds", roles: "Digital marketing executive or marketing analyst",
    file: "taylor-reid.docx", region: "Leeds", towns: "Bradford, Wakefield" },
};
// The demo image's extra people (the @extras journey): a second recruiter in Morgan's team and two more recruits.
export const EXTRA_RECRUITER = { name: "Casey Quinn", username: "casey" };
export const EXTRA_RECRUITS = {
  drew: { name: "Drew Harper", email: "drew.harper@example.com", town: "Sheffield", roles: "Senior backend or platform engineer",
    paste: "drew-harper.txt" },
  avery: { name: "Avery Lane", email: "avery.lane@example.org", town: "Bristol", roles: "Senior marketing manager or head of digital",
    paste: "avery-lane.txt" },
};

export function passwordFor(username) {
  const state = readState();
  const passwords = state.passwords || {};
  if (!passwords[username]) {
    passwords[username] = randomBytes(15).toString("base64url");
    writeState({ passwords });
  }
  return passwords[username];
}

export async function admin() {
  return signIn(await actor("Admin"), "admin", loadEnv().EXPLORE_ADMIN_PASSWORD);
}

export async function recruiter() {
  return signIn(await actor("Recruiter"), RECRUITER.username, passwordFor(RECRUITER.username));
}

export async function manager() {
  return signIn(await actor("Manager"), MANAGER.username, passwordFor(MANAGER.username));
}

// A recruit's profile id, read from the Recruits list (ids carry a random suffix, e.g. sam-lee-c593ef).
export async function recruitId(who, name, { status = "" } = {}) {
  const known = readState().ids?.[name];
  if (known) return known;
  await who.page.goto(`/admin${status ? `?s=${status}` : ""}`);
  const href = await who.page.locator("table.recruits tr", { hasText: name }).getByRole("link", { name: "Manage" }).first()
    .getAttribute("href");
  const id = new URL(href, "https://x").searchParams.get("u");
  writeState({ ids: { ...(readState().ids || {}), [name]: id } });
  return id;
}

export function forgetIds() {
  writeState({ ids: {} });
}

// Waits for an email while the watching window's banner counts the time.
export async function emailShowing(who, text, query, opts = {}) {
  let msg = null;
  await waitShowing(who.page, who.role, text, async () => {
    msg = await waitForEmail({ ...query, timeout: 1 }).catch(() => null);
    return msg;
  }, opts);
  return msg;
}

export async function addUser(a, person, { asManager = false } = {}) {
  const { page } = a;
  await page.goto("/admin/users");
  if (await page.getByRole("link", { name: `Edit ${person.name}` }).isVisible().catch(() => false)) return false;
  await a.say(`adding ${person.name} as a ${asManager ? "manager" : "recruiter"}`);
  await a.click(page.getByRole("link", { name: "Add user" }));
  const modal = page.locator("#user-new");
  await a.fill(modal.getByLabel("Name", { exact: true }), person.name);
  await a.fill(modal.getByLabel("Username", { exact: true }), person.username);
  await a.fill(modal.getByLabel("Password", { exact: true }), passwordFor(person.username));
  if (asManager) {
    await modal.getByRole("checkbox", { name: "Recruiter" }).uncheck();
    await modal.getByRole("checkbox", { name: "Manager" }).check();
  }
  await a.click(modal.getByRole("button", { name: "Add user" }));
  await expect(page.locator("table.list").getByText(person.name, { exact: true })).toBeVisible();
  return true;
}

export async function invite(a, person, pool) {
  const { page } = a;
  await page.goto("/admin");
  await a.say(`creating an invite link for ${person.name}`);
  await a.fill(page.getByPlaceholder("Who it is for (only you see this)"), `${person.name} (walkthrough)`);
  const pick = page.getByRole("combobox", { name: "Whose recruit they become" });
  if (await pick.isVisible().catch(() => false)) await pick.selectOption({ label: pool ? `${pool}'s recruit` : "Nobody's recruit" });
  await a.click(page.getByRole("button", { name: "Create invite link" }));
  await expect(page.getByRole("heading", { name: "Invite link" })).toBeVisible();
  return (await page.locator("code.link").textContent()).trim();
}

export async function join_(person, link) {
  const r = await actor("Recruit", { key: `recruit-${person.email}` });
  const { page } = r;
  await page.goto(link);
  await r.say(`${person.name} fills in the sign-up form`);
  await expect(page.getByRole("heading", { name: "Join HermitShell" })).toBeVisible();
  await r.fill(page.getByLabel("Full name"), person.name);
  await r.fill(page.getByLabel("Email for your reports"), person.email);
  await r.fill(page.getByLabel("Where you live (optional)"), person.town);
  await r.fill(page.getByLabel("Roles you are looking for"), person.roles);
  if (person.paste) await r.fill(page.getByLabel("Or paste the text of your CV instead"), readFileSync(join(DATA, person.paste), "utf8"));
  else await page.locator('input[type="file"]').setInputFiles(join(DATA, person.file));
  await page.getByRole("checkbox").check();
  await r.click(page.getByRole("button", { name: "Create my profile" }));
  await expect(page.getByRole("heading", { name: "Thanks, you're in" })).toBeVisible();
  await page.goto(link);
  await expect(page.getByRole("button", { name: "Create my profile" })).toHaveCount(0);
  return r;
}

// Turns a Global settings, Features switch on (the admin's window), if it isn't already.
export async function featureOn(a, label) {
  const { page } = a;
  await page.goto("/admin/settings");
  const box = page.getByRole("checkbox", { name: label });
  if (!(await box.isChecked())) {
    await a.say(`switching on ${label} under Features`);
    await a.click(box);
    await a.click(page.getByRole("button", { name: "Save features" }));
    await expect(page).toHaveURL(/done=/);
  }
  await expect(page.getByRole("checkbox", { name: label })).toBeChecked();
}

export async function status(page, pattern) {
  await expect(page.getByRole("status").first()).toContainText(pattern);
}

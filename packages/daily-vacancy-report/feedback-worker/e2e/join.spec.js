import { expect, test } from "@playwright/test";

import { signIn } from "./fixtures.js";

const CV = `Casey Quinn, data analyst in York.
Four years building Power BI and Tableau dashboards for a regional retailer, writing SQL against Snowflake and
automating weekly reports in Python. Led the move of finance reporting from spreadsheets to dbt models.
BSc Mathematics. Skills: SQL, Python, Power BI, Tableau, dbt, Excel, stakeholder workshops.`;

async function inviteLink(page, note) {
  await signIn(page);
  await page.getByPlaceholder("Who it is for (only you see this)").fill(note);
  await page.getByRole("button", { name: "Create invite link" }).click();
  await expect(page.getByRole("heading", { name: "Invite link" })).toBeVisible();
  return (await page.locator("code.link").textContent()).trim();
}

async function fillForm(page, cv) {
  await page.getByLabel("Full name").fill("Casey Quinn");
  await page.getByLabel("Email for your reports").fill("casey.quinn@example.com");
  await page.getByLabel("Roles you are looking for").fill("Data analyst or BI developer, hybrid");
  await page.getByLabel("Or paste your CV").fill(cv);
  await page.getByRole("checkbox").check();
}

test("an invite link signs someone up once, and they show as pending", async ({ page, browser }) => {
  const link = await inviteLink(page, "Casey from the course");
  const guest = await browser.newContext();
  const form = await guest.newPage();
  await form.goto(link);
  await expect(form.getByRole("heading", { name: "Join HermitShell" })).toBeVisible();
  await expect(form.getByRole("link", { name: "how your data is handled" })).toHaveAttribute("href", "/privacy");
  await fillForm(form, CV);
  await form.getByRole("button", { name: "Create my profile" }).click();
  await expect(form.getByRole("heading", { name: "Thanks, you're in" })).toBeVisible();

  await form.goto(link);
  await expect(form.getByRole("button", { name: "Create my profile" })).toHaveCount(0);
  await guest.close();

  await page.goto("/admin");
  const row = page.locator("table.recruits tr", { hasText: "Casey Quinn" });
  await expect(row.locator(".pill.pending")).toBeVisible();
});

test("the sign-up form keeps what was typed when the CV is missing", async ({ page, browser }) => {
  const link = await inviteLink(page, "Drew, no CV yet");
  const guest = await browser.newContext();
  const form = await guest.newPage();
  await form.goto(link);
  await fillForm(form, "Too short to be a CV.");
  await form.getByRole("button", { name: "Create my profile" }).click();
  await expect(form.getByText("Please upload your CV or paste it")).toBeVisible();
  await expect(form.getByLabel("Full name")).toHaveValue("Casey Quinn");
  await guest.close();
});

import { expect, test } from "@playwright/test";

import { reportStatus, signIn } from "./fixtures.js";

test("a note and tags are added on a profile, and a tag lists everyone with it", async ({ page, request }) => {
  await reportStatus(request);
  await signIn(page);
  await page.goto("/admin/profile?u=sam-lee");
  await page.getByLabel("Tags").fill("shortlist, e2e tag");
  await page.getByRole("button", { name: "Save tags" }).click();
  await expect(page).toHaveURL(/done=tagged#notes$/);
  await expect(page.getByText("Tags saved.")).toBeVisible();
  await page.getByLabel("Add a note").fill("Prefers hybrid roles near York");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page).toHaveURL(/done=noted#notes$/);
  await expect(page.locator(".notelist li").first()).toContainText("Prefers hybrid roles near York");

  await page.goto("/admin");
  const pill = page.locator("table.recruits").getByRole("link", { name: "e2e tag" });
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(page).toHaveURL(/\/admin\?tag=e2e%20tag$/);
  await expect(page.locator(".tagfilter")).toContainText("1 tagged");
  await expect(page.locator("table.recruits")).toContainText("Sam Lee");
  await expect(page.locator("table.recruits")).not.toContainText("Jordan Patel");

  await page.goto("/admin/history?u=sam-lee");
  await expect(page.getByText("Added a note")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Prefers hybrid roles");
});

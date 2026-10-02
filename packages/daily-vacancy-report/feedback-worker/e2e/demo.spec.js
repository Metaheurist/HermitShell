import { expect, test } from "@playwright/test";

import { hermitShellApi, sidewaysOverflow, signIn } from "./fixtures.js";

// Demo mode is one switch for the whole dashboard, so leave it off for the tests that follow.
test.afterEach(async ({ page }) => {
  await page.goto("/admin/settings");
  if (await page.getByRole("button", { name: "Sign in" }).count()) {
    await signIn(page);
    await page.goto("/admin/settings");
  }
  const toggle = page.getByRole("switch", { name: "Demo mode" });
  if (await toggle.count() && (await toggle.getAttribute("aria-checked")) === "true") {
    await toggle.press("Enter");
    await expect(page).toHaveURL(/done=demo_off#demo$/);
  }
});

test("a tailored CV being made keeps its circle turning while the page waits, and nothing slides in again", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/settings");
  await page.getByRole("switch", { name: "Demo mode" }).click();
  await expect(page).toHaveURL(/done=demo_on#demo$/);
  await page.goto("/admin/sent?u=avery-lane&r=30");
  await page.locator('form:has(input[name="k"][value="tailored_cv"]):has(button:text-is("Generate"))').first().evaluate((f) => f.requestSubmit());
  const spin = page.locator(".doc.busy .dspin").first();
  await expect(spin).toBeAttached();
  await expect(page.locator("body")).toHaveClass(/\bstill\b/);
  const motion = await page.evaluate(async () => {
    const [turn] = document.querySelector(".doc.busy .dspin").getAnimations();
    const from = turn?.currentTime;
    await new Promise((r) => setTimeout(r, 300));
    const entrances = document.getAnimations().filter((a) => a.playState === "running" && a.effect.getTiming().iterations !== Infinity);
    return { turning: !!turn && turn.playState === "running" && turn.currentTime > from, entrances: entrances.length };
  });
  expect(motion).toEqual({ turning: true, entrances: 0 });
});

test("a note rides on a tailored CV asked for from the dashboard, and the history only says there was one", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/settings");
  await page.getByRole("switch", { name: "Demo mode" }).click();
  await expect(page).toHaveURL(/done=demo_on#demo$/);
  await page.goto("/admin/sent?u=avery-lane&r=30");
  await page.locator('form:has(input[name="k"][value="tailored_cv"]):has(button:text-is("Generate"))').first().evaluate((f) => {
    f.querySelector("details.dopts").open = true;
    f.querySelector('label.lopt.lnote textarea[name="r"]').value = "Lead with the Airflow migration";
    f.requestSubmit();
  });
  await expect(page).toHaveURL(/done=doc/);
  await page.goto("/admin/history?u=avery-lane");
  await expect(page.getByText(/Asked for a tailored CV \(with a note\)/).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Airflow migration");
});

test("a recruit's own CV: Generate spins until it is made, then CV downloads it and stays beside Generate", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/settings");
  await page.getByRole("switch", { name: "Demo mode" }).press("Enter");
  await expect(page).toHaveURL(/done=demo_on#demo$/);
  await page.goto("/admin/profile?u=avery-lane");
  const corner = page.locator("main > .pcv");
  await expect(corner.getByRole("link", { name: "CV" })).toHaveCount(0);
  const heading = await page.locator("main > h1").boundingBox();
  const box = await corner.boundingBox();
  expect(box.y).toBeLessThan(heading.y + heading.height);
  await corner.getByRole("button", { name: "Generate" }).click();
  await expect(page).toHaveURL(/done=cvmaking/);
  await expect(corner.locator(".pcvbtn.busy .dspin")).toBeVisible();
  const cv = page.locator("main > .pcv").getByRole("link", { name: "CV" });
  await expect(cv).toBeVisible({ timeout: 30000 });
  await expect(page.locator("main > .pcv").getByRole("button", { name: "Generate" })).toBeVisible();
  const [file] = await Promise.all([page.waitForEvent("download"), cv.click()]);
  expect(file.suggestedFilename()).toBe("CV - Avery Lane.pdf");
  await page.reload();
  await expect(page.locator("main > .pcv").getByRole("link", { name: "CV" })).toBeVisible();
});

test("demo mode fills the dashboard with made-up recruits, plays presses out without queuing them and turns off again", async ({ page, request }) => {
  await signIn(page);
  await page.goto("/admin/settings");
  await expect(page.getByRole("heading", { name: "Demo mode" })).toBeVisible();
  const toggle = page.getByRole("switch", { name: "Demo mode" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(page).toHaveURL(/done=demo_on#demo$/);
  await expect(page.getByText("Demo mode is on: every dashboard page now shows made-up data")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Demo mode" })).toBeChecked();

  await page.goto("/admin");
  const ribbon = page.locator(".demoribbon");
  await expect(ribbon).toBeVisible();
  await expect(ribbon).toContainText("made-up data, and nothing you press reaches anyone");
  const recruits = page.locator("table.recruits");
  for (const name of ["Jamie Walsh", "Morgan Ellis", "Taylor Reid", "Riley Chen"]) await expect(recruits.getByText(name, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Pause reports for Jamie Walsh" }).click();
  await expect(page).toHaveURL(/done=queued/);
  const queue = await (await hermitShellApi(request, "GET", "/api/queue?full=1")).json();
  expect(queue.items.filter((i) => i.u === "jamie-walsh")).toEqual([]);
  await expect(page.getByRole("button", { name: "Resume reports for Jamie Walsh" })).toBeVisible({ timeout: 20000 });

  await page.goto("/admin/stats?u=jamie-walsh");
  await expect(page.locator("svg").first()).toBeVisible();
  // On the first of a month the reports so far are all in the month before, behind its pill.
  await page.goto("/admin/history?u=jamie-walsh");
  const months = await page.locator('a[href*="/admin/history?u=jamie-walsh&m="]').evaluateAll((links) => links.map((a) => a.href));
  for (const month of months) {
    if (await page.getByText("Job report ran").count()) break;
    await page.goto(month);
  }
  await expect(page.getByText("Job report ran").first()).toBeVisible();
  await page.goto("/admin/history?u=avery-lane");
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download the cover letter" }).click()]);
  expect(file.suggestedFilename()).toMatch(/^Cover letter - Avery Lane - .+\.pdf$/);

  await ribbon.getByRole("button", { name: "Turn off" }).click();
  await expect(page).toHaveURL(/\/admin\?done=demo_off$/);
  await expect(page.getByText("Demo mode is off: the dashboard shows your real recruits again.")).toBeVisible();
  await expect(page.locator(".demoribbon")).toHaveCount(0);
  await page.goto("/admin/settings");
  await expect(page.getByRole("switch", { name: "Demo mode" })).not.toBeChecked();
  await page.goto("/admin");
  await expect(page.locator("table.recruits").getByText("Jamie Walsh")).toHaveCount(0);
});

test("a waiting page updates in place, and holds off while something is being typed", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/settings");
  await page.getByRole("switch", { name: "Demo mode" }).press("Enter");
  await expect(page).toHaveURL(/done=demo_on#demo$/);
  await page.goto("/admin");
  await page.getByRole("button", { name: "Pause reports for Jamie Walsh" }).click();
  await expect(page).toHaveURL(/done=queued/);
  await expect(page.locator('meta[name="hs-refresh"]')).toHaveCount(1);
  await page.evaluate(() => { window.stayed = true; });
  await expect(page.getByRole("button", { name: "Resume reports for Jamie Walsh" })).toBeVisible({ timeout: 20000 });
  expect(await page.evaluate(() => window.stayed)).toBe(true);

  await page.getByRole("button", { name: "Pause reports for Morgan Ellis" }).click();
  await expect(page).toHaveURL(/done=queued/);
  await page.evaluate(() => { window.stayed = true; });
  const note = page.getByPlaceholder("Who it is for (only you see this)");
  await note.fill("Typed while waiting");
  await page.locator("h1").click();
  await page.waitForTimeout(10000);
  await expect(note).toHaveValue("Typed while waiting");
  expect(await page.evaluate(() => window.stayed)).toBe(true);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the demo pages and their ribbon fit the screen", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/settings");
    await page.getByRole("switch", { name: "Demo mode" }).press("Enter");
    await expect(page).toHaveURL(/done=demo_on#demo$/);
    for (const path of ["/admin", "/admin/profile?u=jamie-walsh", "/admin/stats?u=avery-lane", "/admin/sent?u=avery-lane&r=30", "/admin/history?u=sam-lee",
      "/admin/pipeline?u=avery-lane", "/admin/users", "/admin/backups", "/admin/desk"]) {
      await page.goto(path);
      expect(await sidewaysOverflow(page), path).toBeLessThanOrEqual(1);
      const box = await page.locator(".demoribbon").boundingBox();
      expect(box.x, path).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, path).toBeLessThanOrEqual(390);
    }
    await page.goto("/admin/tasks");
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
  });
});

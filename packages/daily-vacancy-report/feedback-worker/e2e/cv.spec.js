import { expect, test } from "@playwright/test";

import { hermitShellApi, reportStatus, signIn } from "./fixtures.js";

const CV_TEXT = "Sam Lee. Data analyst with SQL, Python and Power BI, building reports for Northwind and Contoso. ".repeat(4);

test.afterEach(async ({ request }) => {
  const { items } = await (await hermitShellApi(request, "GET", "/api/queue?full=1")).json();
  if (items.length) await hermitShellApi(request, "POST", "/api/queue/ack", { ids: items.map((i) => i.id) });
});

test("a pasted CV is saved with the Save CV button right under the paste box", async ({ page, request }) => {
  await reportStatus(request);
  await signIn(page);
  await page.goto("/admin/profile?u=sam-lee");
  const paste = page.getByLabel("Or paste the CV text");
  await paste.fill("Too short");
  await page.getByRole("button", { name: "Save CV" }).click();
  await expect(page).toHaveURL(/done=cvmissing$/);
  await expect(page.getByText("then press Save CV")).toBeVisible();

  await page.getByLabel("Or paste the CV text").fill(CV_TEXT);
  await page.getByRole("button", { name: "Save CV" }).click();
  await expect(page).toHaveURL(/done=cvqueued$/);
  await expect(page.getByText("CV saved.")).toBeVisible();
  const { items } = await (await hermitShellApi(request, "GET", "/api/queue?full=1")).json();
  expect(items.map((i) => [i.action, i.u])).toEqual([["cv", "sam-lee"]]);
  await page.goto("/admin/history?u=sam-lee");
  await expect(page.getByText("Pasted new CV text")).toBeVisible();
});

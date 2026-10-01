import { expect, test } from "@playwright/test";

import { jobHash } from "../src/docs.js";
import { WORD_PARTS, bundle, zipOf } from "../test/zip.js";
import { hermitShellApi, hermitShellUpload, reportStatus, signIn } from "./fixtures.js";

const JOB = "job-e2e-word-copy";
const NAME = "Cover letter - Sam Lee - Data Engineer";

test("a letter kept with its Word copy downloads as the PDF or the Word file from the jobs sent", async ({ page, request }) => {
  await reportStatus(request);
  const sent = [{ title: "Data Engineer", employer: "Northwind Traders", day: new Date().toISOString().slice(0, 10), fit: 8, key: JOB }];
  expect((await hermitShellApi(request, "POST", "/api/stats", { u: "sam-lee", stats: { days: {}, sent } })).ok()).toBe(true);
  const q = new URLSearchParams({ u: "sam-lee", j: JOB, k: "cover_letter", days: "7", name: `${NAME}.pdf` });
  const pdf = new TextEncoder().encode("%PDF-1.4\n%%EOF");
  expect((await hermitShellUpload(request, `/api/doc?${q}`, bundle(pdf, zipOf(WORD_PARTS)))).ok()).toBe(true);

  await signIn(page);
  await page.goto(`/admin/sent?u=sam-lee&r=7&open=${(await jobHash(JOB)).slice(0, 16)}`);
  const tile = page.locator(".doc.ready", { hasText: "Cover letter" });
  await tile.getByText("Download", { exact: true }).click();
  const [word] = await Promise.all([page.waitForEvent("download"), tile.getByRole("link", { name: "Word", exact: true }).click()]);
  expect(word.suggestedFilename()).toBe(`${NAME}.docx`);
  const [letter] = await Promise.all([page.waitForEvent("download"), tile.getByRole("link", { name: "PDF", exact: true }).click()]);
  expect(letter.suggestedFilename()).toBe(`${NAME}.pdf`);
});

// Word copies: HermitShell's PDF and .docx in one upload, kept as one sealed value, checked without unpacking the zip,
// and offered as PDF or Word on the jobs sent, the history and the email button's page.
import { describe, expect, it } from "vitest";
import worker, { sign } from "../src/index.js";
import { DOCX_MIME, MAX_DOC_BYTES, MAX_PDF_BYTES, isDocx, jobHash, splitDoc } from "../src/docs.js";
import { today } from "../src/lib.js";
import { BASE, WORD_PARTS, bundle, testEnv, zipOf } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const PDF = new TextEncoder().encode("%PDF-1.4\nA letter for Northwind\n%%EOF");
const WORD = zipOf(WORD_PARTS);
const JOB = "https://jobs.example.com/1";
const STATUS = { timezone: "Europe/London", profiles: [
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active" },
  { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false },
] };

function upload(env, body, { k = "cover_letter", j = JOB } = {}) {
  const q = new URLSearchParams({ u: "sam-lee", j, k, days: "7", name: "Cover letter - Sam Lee - Data Engineer.pdf" });
  return worker.fetch(new Request(`${BASE}/api/doc?${q}`, { method: "POST", headers: { ...API, "Content-Type": "application/octet-stream" }, body }), env);
}

async function setup() {
  const env = testEnv(ADMIN);
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify(STATUS) }), env);
  const login = await worker.fetch(new Request(`${BASE}/admin/login`, { method: "POST",
    body: new URLSearchParams({ username: "admin", password: ADMIN.ADMIN_PASSWORD }), headers: { "CF-Connecting-IP": "203.0.113.50" } }), env);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const get = (path) => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
  return { env, get };
}

async function link(action, key, title, profile) {
  const d = String(today());
  const t = await sign("test-secret", key, action, title, "", profile, d);
  return new URLSearchParams({ j: key, a: action, n: title, u: profile, d, t }).toString();
}

const bytes = async (res) => new Uint8Array(await res.arrayBuffer());

describe("a PDF and its Word copy", () => {
  it("are kept as one sealed value, marked in the index, and downloaded as either", async () => {
    const { env, get } = await setup();
    expect((await upload(env, bundle(PDF, WORD))).status).toBe(200);
    const h = await jobHash(JOB);
    const stored = new TextDecoder().decode(new Uint8Array(env.FEEDBACK.store.get(`doc:sam-lee:cover_letter:${h}`)));
    for (const plain of ["Northwind", "word/document.xml", "HSD1"]) expect(stored).not.toContain(plain);
    expect([...env.FEEDBACK.store.keys()].filter((k) => k.startsWith("doc:"))).toHaveLength(1);
    expect(JSON.parse(env.FEEDBACK.store.get("docs:sam-lee"))[0]).toMatchObject({ k: "cover_letter", h, w: 1 });

    const pdf = await get(`/admin/doc?u=sam-lee&k=cover_letter&h=${h}`);
    expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
    expect(await bytes(pdf)).toEqual(PDF);

    const word = await get(`/admin/doc?u=sam-lee&k=cover_letter&h=${h}&f=word`);
    expect(word.headers.get("Content-Type")).toBe(DOCX_MIME);
    expect(word.headers.get("Content-Disposition")).toContain('attachment; filename="Cover letter - Sam Lee - Data Engineer.docx"');
    expect(word.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(word.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await bytes(word)).toEqual(WORD);
  });

  it("offers PDF and Word under Download on the opened job, and a plain Download without a Word copy", async () => {
    const { env, get } = await setup();
    await upload(env, bundle(PDF, WORD));
    await upload(env, PDF, { k: "tailored_cv" });
    const h = await jobHash(JOB);
    const stats = { days: {}, sent: [{ title: "Data Engineer", employer: "Northwind", day: new Date().toISOString().slice(0, 10), fit: 8, key: JOB }] };
    await worker.fetch(new Request(`${BASE}/api/stats`, { method: "POST", headers: API, body: JSON.stringify({ u: "sam-lee", stats }) }), env);
    const sent = await (await get(`/admin/sent?u=sam-lee&r=7&open=${h.slice(0, 16)}`)).text();
    expect(sent).toContain('<details class="dopts dlm"><summary class="dl" aria-label="Download the cover letter">Download</summary>');
    expect(sent).toContain(`<a href="/admin/doc?u=sam-lee&amp;k=cover_letter&amp;h=${h}" download>PDF</a>`);
    expect(sent).toContain(`<a href="/admin/doc?u=sam-lee&amp;k=cover_letter&amp;h=${h}&amp;f=word" download>Word</a>`);
    expect(sent).toContain(`<a class="dl" href="/admin/doc?u=sam-lee&amp;k=tailored_cv&amp;h=${h}" download>Download</a>`);
    expect(sent).not.toContain("k=tailored_cv&amp;h=" + h + "&amp;f=word");
  });

  it("serves the email button's page a Word link and the Word file through the signed link", async () => {
    const { env } = await setup();
    await upload(env, bundle(PDF, WORD));
    const query = await link("cover_letter", JOB, "Data Engineer at Northwind", "sam-lee");
    const ready = await (await worker.fetch(new Request(`${BASE}/f?${query}`), env)).text();
    expect(ready).toContain("Download PDF</a>");
    expect(ready).toMatch(/<a class="dl" href="\/f\/doc\?[^"]*&amp;t=[0-9a-f]+&amp;f=word" download>Word<\/a>/);
    const word = await worker.fetch(new Request(`${BASE}/f/doc?${query}&f=word`), env);
    expect(word.headers.get("Content-Type")).toBe(DOCX_MIME);
    expect(await bytes(word)).toEqual(WORD);
  });

  it("falls back to the PDF when there is no Word copy, and the menu is a plain Download link", async () => {
    const { env, get } = await setup();
    await upload(env, PDF);
    const h = await jobHash(JOB);
    expect(JSON.parse(env.FEEDBACK.store.get("docs:sam-lee"))[0].w).toBeUndefined();
    const res = await get(`/admin/doc?u=sam-lee&k=cover_letter&h=${h}&f=word`);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(await bytes(res)).toEqual(PDF);
  });
});

describe("the upload is refused", () => {
  const badLength = bundle(PDF, WORD);
  new DataView(badLength.buffer).setUint32(4, badLength.length);
  it.each([
    ["a bundle whose PDF length runs past its end", badLength, 400],
    ["a PDF part that is not a PDF", bundle(new TextEncoder().encode("<html>not a pdf</html>"), WORD), 400],
    ["a Word part that is not a zip", bundle(PDF, new TextEncoder().encode("PK but not really a zip at all, padding padding")), 400],
    ["a zip without word/document.xml", bundle(PDF, zipOf(["[Content_Types].xml", "xl/workbook.xml"])), 400],
    ["a zip with macros", bundle(PDF, zipOf([...WORD_PARTS, "word/vbaProject.bin"])), 400],
    ["a zip with a path out of the package", bundle(PDF, zipOf([...WORD_PARTS, "../evil.xml"])), 400],
    ["a zip of too many parts", bundle(PDF, zipOf([...WORD_PARTS, ...Array.from({ length: 60 }, (_, i) => `word/p${i}.xml`)])), 400],
    ["an empty Word part", (() => { const b = bundle(PDF, new Uint8Array()); return b; })(), 400],
  ])("for %s", async (_, body, status) => {
    const { env } = await setup();
    const res = await upload(env, body);
    expect(res.status).toBe(status);
    expect([...env.FEEDBACK.store.keys()].filter((k) => k.startsWith("doc"))).toEqual([]);
  });

  it("when the bundle is over its size or the PDF part over a PDF's", async () => {
    const { env } = await setup();
    expect((await upload(env, new Uint8Array(MAX_DOC_BYTES + 1))).status).toBe(413);
    const big = new Uint8Array(MAX_PDF_BYTES + 1);
    big.set(PDF);
    expect((await upload(env, bundle(big, WORD))).status).toBe(400);
  });

  it("and the recruit's own CV is still held to a PDF's size", async () => {
    const { env } = await setup();
    const big = new Uint8Array(MAX_PDF_BYTES + 1);
    big.set(PDF);
    const res = await worker.fetch(new Request(`${BASE}/api/cv?u=sam-lee&name=CV`, { method: "POST", headers: API, body: big }), env);
    expect(res.status).toBe(413);
  });
});

describe("the checks", () => {
  it("split a bundle and pass a PDF alone through", () => {
    const parts = splitDoc(bundle(PDF, WORD));
    expect(parts.pdf).toEqual(PDF);
    expect(parts.word).toEqual(WORD);
    expect(splitDoc(PDF)).toEqual({ pdf: PDF, word: null });
  });

  it("read only the zip's directory, refusing one cut short", () => {
    expect(isDocx(WORD)).toBe(true);
    expect(isDocx(WORD.subarray(0, WORD.length - 30))).toBe(false);
    expect(isDocx(new Uint8Array(40))).toBe(false);
  });
});

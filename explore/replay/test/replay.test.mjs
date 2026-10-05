// Unit tests for the replay layer (node --test explore/replay/test): prompt keys that ignore the day, the fictional
// adverts' search and scrape answers, and the fallback for a request with no recording.

import assert from "node:assert/strict";
import test from "node:test";

import { ADVERTS, byUrl, closing, markdown, matching } from "../adverts.js";
import { NOTE, fallback, fromSchema } from "../fallback.js";
import { normalise, requestKey, taskOf } from "../normalise.js";

const DAY = 86400000;

function chatOn(day, id = "sam-lee-c593ef") {
  const d = new Date(Date.UTC(2026, 9, 5) + day * DAY);
  const iso = d.toISOString().slice(0, 10);
  return {
    model: "qwen3:4b-instruct-2507-q4_K_M",
    messages: [
      { role: "system", content: `You rate job adverts against a CV. Today is ${iso} (${d.toUTCString().slice(0, 3)}).` },
      { role: "user", content: `Candidate ${id}. ${markdown(ADVERTS[0], d.getTime())}\nAsked at ${iso}T07:15:00Z, 07:15 BST.` },
    ],
    format: { type: "object", properties: { fit_score: { type: "integer", minimum: 0, maximum: 10 } } },
  };
}

test("two runs on different days hit the same recording", () => {
  assert.equal(requestKey(chatOn(0)), requestKey(chatOn(1)));
  assert.equal(requestKey(chatOn(0)), requestKey(chatOn(40)));
});

test("a different profile id is the same request, a different advert is not", () => {
  assert.equal(requestKey(chatOn(0, "sam-lee-c593ef")), requestKey(chatOn(0, "sam-lee-0a1b2c")));
  const other = chatOn(0);
  other.messages[1].content = other.messages[1].content.replace("Senior Data Analyst", "Data Engineer");
  assert.notEqual(requestKey(chatOn(0)), requestKey(other));
});

test("the output format is part of the key, the model name is not", () => {
  const plain = { ...chatOn(0), format: undefined };
  assert.notEqual(requestKey(chatOn(0)), requestKey(plain));
  assert.equal(requestKey(chatOn(0)), requestKey({ ...chatOn(0), model: "qwen2.5:7b" }));
});

test("dates, times and hashes are tokenised; CV years are kept", () => {
  assert.equal(normalise("Due 26 October 2026, 14:05 on Monday"), "Due <DATE>, <TIME> on <DAY>");
  assert.equal(normalise("October 26, 2026 / 2026-10-26 / 26/10/2026"), "<DATE> / <DATE> / <DATE>");
  assert.equal(normalise("key 0123456789abcdef0123"), "key <HEX>");
  assert.equal(normalise("Analyst, Northwind (2020 to 2023)"), "Analyst, Northwind (2020 to 2023)");
});

test("the task is the start of the system prompt", () => {
  assert.equal(taskOf(chatOn(0)), "You rate job adverts against a CV. Today");
});

test("a search finds the adverts its quoted titles name, best first, and never a company website", () => {
  const found = matching('("Senior Data Analyst" OR "Analytics Engineer") "York" job', 8);
  assert.equal(found[0].title, "Senior Data Analyst");
  assert.ok(found.some((ad) => ad.title === "Analytics Engineer"));
  assert.ok(found.every((ad) => !/Marketing|Backend/.test(ad.title)));
  assert.deepEqual(matching("Northwind Traders York official website"), []);
  assert.deepEqual(matching('"Underwater Basket Weaver"'), []);
});

test("every advert is fictional, scrapeable and never closed", () => {
  const companies = new Set(["Northwind Traders", "Contoso Logistics", "Contoso College", "Fabrikam Payments", "Proseware", "Litware Retail"]);
  for (const ad of ADVERTS) {
    assert.ok(companies.has(ad.company), ad.company);
    assert.match(ad.url, /^https:\/\/careers\.[a-z]+\.example\/vacancies\/.+-\d{4}$/);
    assert.equal(byUrl(`${ad.url}?utm_source=x`), ad);
    assert.ok(markdown(ad).length > 800, ad.title);
  }
  assert.match(closing(Date.UTC(2026, 9, 5)), /^26 October 2026$/);
});

test("a request with no recording gets a reply shaped by its schema", () => {
  const schema = { type: "object", properties: {
    fit_score: { type: "integer", minimum: 0, maximum: 10 }, seniority: { type: "string", enum: ["mid", "senior"] },
    skills: { type: "array", items: { type: "string" }, minItems: 1 }, ok: { type: "boolean" }, note: { type: ["string", "null"] } } };
  assert.deepEqual(fromSchema(schema), { fit_score: 0, seniority: "mid", skills: [""], ok: false, note: "" });
  assert.deepEqual(JSON.parse(fallback({ format: schema })).seniority, "mid");
  assert.equal(fallback({ format: "json" }), "{}");
  assert.equal(fallback({}), NOTE);
});

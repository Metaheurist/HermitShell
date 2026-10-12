// Unit tests for the walkthrough's helpers (node --test explore/lib/test): link text from email HTML, the
// .env.explore and state files made in one step, and the findings file started once without losing earlier lines.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "explore-home-"));
const OUT = mkdtempSync(join(tmpdir(), "explore-out-"));
process.env.EXPLORE_HOME = HOME;
process.env.EXPLORE_OUT = OUT;

const { loadEnv, readState, writeState } = await import("../config.js");
const { links, textOf } = await import("../mailpit.js");
const { mask, step } = await import("../findings.js");

test("link text is what's outside the tags, with no tag characters left", () => {
  assert.equal(textOf("<b>Interested</b>"), "Interested");
  assert.equal(textOf("  <span><img src=x>I  applied</span> "), "I applied");
  for (const hostile of ["a <scr<script>ipt>b", "<<b>>x", "x <img src=1 onerror=alert(1)", "1 > 0 < 2"]) {
    assert.doesNotMatch(textOf(hostile), /[<>]/, hostile);
  }
});

test("links come back with their text and HTML entities decoded", () => {
  const msg = { HTML: '<p><a href="https://example.test/a?x=1&amp;y=2"><b>Confirm</b></a> <a class="c" href="/b">Not  for me</a></p>' };
  assert.deepEqual(links(msg), [
    { href: "https://example.test/a?x=1&y=2", text: "Confirm" },
    { href: "/b", text: "Not for me" },
  ]);
});

test(".env.explore is made once with random secrets, then reused as it is", () => {
  const first = loadEnv();
  assert.match(first.EXPLORE_LINK_SECRET, /^[0-9a-f]{64}$/);
  assert.match(first.EXPLORE_API_TOKEN, /^[0-9a-f]{64}$/);
  assert.ok(first.EXPLORE_ADMIN_PASSWORD.length >= 20);
  if (process.platform !== "win32") assert.equal(statSync(join(HOME, ".env.explore")).mode & 0o777, 0o600);
  assert.deepEqual(loadEnv(), first);
});

test("state starts empty and keeps what was written", () => {
  assert.deepEqual(readState(), {});
  writeState({ checkpoint: "seeded" });
  assert.deepEqual(writeState({ runs: 2 }), { checkpoint: "seeded", runs: 2 });
  assert.deepEqual(readState(), { checkpoint: "seeded", runs: 2 });
});

test("a findings file already there is kept, and each step adds a line", async () => {
  writeFileSync(join(OUT, "findings.md"), "# Earlier run\n");
  assert.equal(await step("setup", "first", null, async () => 1), 1);
  await step("setup", "second", null, async () => 2);
  assert.equal(readFileSync(join(OUT, "findings.md"), "utf8"), "# Earlier run\n- pass [setup] first\n- pass [setup] second\n");
});

test("keys and long secrets are masked before they reach the findings", () => {
  const out = mask("key fc-abcdefghijklmnop and token 0123456789abcdef0123456789abcdef");
  assert.doesNotMatch(out, /abcdefghijklmnop|0123456789abcdef0123456789abcdef/);
});

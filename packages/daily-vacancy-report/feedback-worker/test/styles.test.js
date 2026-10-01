import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { page, phaseStyle } from "../src/lib.js";
import { tasksPage } from "../src/tasks.js";
import { styled } from "./helpers.js";

const SRC = new URL("../src/", import.meta.url);
const sources = () => readdirSync(SRC).filter((f) => f.endsWith(".js")).map((f) => [f, readFileSync(new URL(f, SRC), "utf8")]);
const keyframes = function* () {
  for (const [file, source] of sources()) {
    for (const [, name, body] of source.matchAll(/@keyframes ([\w-]+)(\{(?:[^{}]|\{[^{}]*\})*\})/g)) yield { file, name, body };
  }
};

describe("page styles", () => {
  it("never define one animation name two ways, since pages combine the stylesheets and the last one wins", () => {
    const seen = new Map();
    for (const { file, name, body } of keyframes()) {
      const where = seen.get(name);
      if (where && where.body !== body) throw new Error(`@keyframes ${name}: ${where.file} and ${file} differ`);
      seen.set(name, { file, body });
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it("animate only what the compositor can move, not the layout or shadows", () => {
    for (const { file, name, body } of keyframes()) {
      expect(`${file} ${name} ${body}`).not.toMatch(/[{;](width|height|margin|padding|top|left|right|bottom|box-shadow)\s*:/);
    }
  });

  it("carry looping animations on from the clock, so a reload doesn't restart them", () => {
    const at = 1_800_000_123_456;
    const phase = (css) => Number(/--phase:-([\d.]+)s/.exec(css)[1]);
    expect(phase(phaseStyle(at + 1000)) - phase(phaseStyle(at))).toBeCloseTo(1, 2);
    expect(phase(phaseStyle(at))).toBeLessThan(792);
    expect(phaseStyle(at)).toMatch(/--drift:-\d+\.\d{2}s/);
  });

  it("show the next page at once, with no cross-fade holding up clicks, and keep the loops in phase", async () => {
    const html = styled(await page("Recruits", "<p>x</p>").text());
    expect(html).not.toContain("view-transition");
    expect(html).not.toMatch(/main\{[^}]*animation:rise/);
    expect(html).toMatch(/:root\{--phase:-[\d.]+s;--drift:-[\d.]+s\}/);
    expect(html).toContain("@media (prefers-reduced-motion:reduce)");
  });

  it("don't slide the task list in again each time it reloads", async () => {
    expect(await tasksPage([], "csrf", "UTC", 0).text()).toContain("<body>");
    expect(await tasksPage([], "csrf", "UTC", 3).text()).toContain('<body class="again">');
  });
});

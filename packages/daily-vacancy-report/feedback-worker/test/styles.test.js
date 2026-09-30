import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url);

describe("page styles", () => {
  it("never define one animation name two ways, since pages combine the stylesheets and the last one wins", () => {
    const seen = new Map();
    for (const file of readdirSync(SRC).filter((f) => f.endsWith(".js"))) {
      const source = readFileSync(new URL(file, SRC), "utf8");
      for (const [, name, body] of source.matchAll(/@keyframes ([\w-]+)(\{(?:[^{}]|\{[^{}]*\})*\})/g)) {
        const where = seen.get(name);
        if (where && where.body !== body) throw new Error(`@keyframes ${name}: ${where.file} and ${file} differ`);
        seen.set(name, { file, body });
      }
    }
    expect(seen.size).toBeGreaterThan(5);
  });
});

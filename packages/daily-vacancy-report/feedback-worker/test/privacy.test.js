import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { privacyPage } from "../src/privacy.js";

describe("privacy notice", () => {
  it("serves the same sections, word for word, as PRIVACY.md", async () => {
    const md = readFileSync(new URL("../../../../PRIVACY.md", import.meta.url), "utf8");
    const sections = md.replace(/\r\n/g, "\n").split(/^## /m).slice(1).map((s) => {
      const [heading, ...rest] = s.split("\n");
      return [heading.trim(), rest.join(" ").replace(/\s+/g, " ").trim()];
    });
    expect(sections.map(([h]) => h)).toContain("Where");
    const html = await privacyPage().text();
    for (const [heading, text] of sections) expect(html).toContain(`<h2>${heading}</h2><p>${text}</p>`);
    expect(html.match(/<h2>/g)).toHaveLength(sections.length);
  });
});

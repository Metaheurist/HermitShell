import { describe, expect, it } from "vitest";
import { SEALED_FIELDS, SEAL_ALG, needsSeal, sealBytes, sealInfo, sealItem, sealText } from "../src/seal.js";
import { sealingKeys } from "./helpers.js";

const KEYS = await sealingKeys();

describe("sealing for HermitShell", () => {
  it("only takes a well-formed public key HermitShell reported", () => {
    expect(sealInfo(KEYS.status)).toEqual({ spki: KEYS.seal.spki });
    for (const status of [null, {}, { seal: null }, { seal: { ...KEYS.seal, alg: "none" } }, { seal: { ...KEYS.seal, spki: "short" } },
      { seal: { ...KEYS.seal, spki: `${KEYS.seal.spki}"<script>` } }, { seal: { alg: SEAL_ALG, spki: 42 } }]) {
      expect(sealInfo(status)).toBeNull();
    }
  });

  it("seals every secret and CV text field, lists them, and leaves the rest alone", async () => {
    const item = { type: "admin", action: "api_keys", firecrawl: ["fc-one11111", "fc-two22222"], tavily: "tvly-cccc3333", scrapfly: "",
      cv: { key: "cvfile:abc" }, clear: ["scrapfly"] };
    const out = await sealItem(sealInfo(KEYS.status), item);
    expect(out.sealed).toEqual(["firecrawl", "tavily"]);
    expect(out).toMatchObject({ type: "admin", action: "api_keys", scrapfly: "", cv: { key: "cvfile:abc" }, clear: ["scrapfly"] });
    expect(JSON.stringify(out)).not.toMatch(/fc-one|fc-two|tvly-cccc/);
    expect(await Promise.all(out.firecrawl.map((v) => KEYS.open(v, "firecrawl")))).toEqual(item.firecrawl);
    expect(await KEYS.open(out.tavily, "tavily")).toBe("tvly-cccc3333");
    expect(item.tavily).toBe("tvly-cccc3333");
    expect(await sealItem(sealInfo(KEYS.status), { action: "pause", u: "sam-lee" })).toEqual({ action: "pause", u: "sam-lee" });
  });

  it("binds each value to its field, so a sealed key can't be passed off as another", async () => {
    const value = await sealText(sealInfo(KEYS.status), "abcd efgh ijkl mnop", "password");
    expect(await KEYS.open(value, "password")).toBe("abcd efgh ijkl mnop");
    await expect(KEYS.open(value, "key")).rejects.toThrow();
    const blob = await sealBytes(sealInfo(KEYS.status), new TextEncoder().encode("%PDF-1.4"), "cvfile:one");
    await expect(KEYS.openBytes(blob, "cvfile:two")).rejects.toThrow();
  });

  it("uses a fresh key each time and names the public key it used", async () => {
    const info = sealInfo(KEYS.status);
    const [a, b] = [await sealText(info, "same", "key"), await sealText(info, "same", "key")];
    expect(a).not.toBe(b);
    const blob = await sealBytes(info, new Uint8Array([1, 2, 3]), "x");
    const spki = Uint8Array.from(atob(KEYS.seal.spki), (c) => c.charCodeAt(0));
    const kid = new Uint8Array(await crypto.subtle.digest("SHA-256", spki)).slice(0, 8);
    expect([...blob.subarray(0, 3)]).toEqual([0x48, 0x53, 0x31]);
    expect([...blob.subarray(3, 11)]).toEqual([...kid]);
    expect((blob[11] << 8) | blob[12]).toBe(256);
  });

  it("knows which items carry a secret", () => {
    expect(SEALED_FIELDS).toEqual(["password", "key", "firecrawl", "tavily", "scrapfly", "cv_text"]);
    expect(needsSeal({ action: "email", password: "x" })).toBe(true);
    expect(needsSeal({ action: "api_keys", firecrawl: ["fc-1"] })).toBe(true);
    expect(needsSeal({ action: "email", password: "" })).toBe(false);
    expect(needsSeal({ action: "api_keys", firecrawl: [], clear: ["tavily"] })).toBe(false);
    expect(needsSeal({ action: "model_keys", provider: "openrouter", model: "a/b" })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { STYLE_URL } from "../src/lib.js";
import {
  CHOICES, DEFAULT_THEME, LOGO_KEY, MAX_LOGO_BYTES, PALETTES, THEME_KEY, cleanTheme, colours, isDefault, logoType, paintHtml, painter, themeCss,
  themeVersion,
} from "../src/theme.js";
import { BASE, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const lightness = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
};

async function signIn(env, username = "admin", password = ADMIN.ADMIN_PASSWORD, ip = "203.0.113.50") {
  const res = await worker.fetch(new Request(`${BASE}/admin/login`, { method: "POST", body: new URLSearchParams({ username, password }),
    headers: { "CF-Connecting-IP": ip } }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = (path) => worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env);
  const text = async (path) => (await get(path)).text();
  const csrf = async () => (await text("/admin/theme")).match(/name="csrf" value="([0-9a-f]+)"/)?.[1]
    || (await text("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const save = async (fields, logo = null) => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ csrf: await csrf(), showname: "1", tabicon: "1", ...fields })) form.set(k, v);
    if (logo) form.set("logo", new Blob([logo.bytes], { type: logo.type || "application/octet-stream" }), logo.name || "logo.png");
    return worker.fetch(new Request(`${BASE}/admin/theme`, { method: "POST", body: form, headers: { Cookie: cookie } }), env);
  };
  return { cookie, get, text, save };
}

async function setup() {
  const env = testEnv(ADMIN);
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles: [
    { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true }] }) }), env);
  return { env, admin: await signIn(env) };
}

const publicPage = async (env) => (await worker.fetch(new Request(`${BASE}/admin`), env)).text();

describe("the theme's colours", () => {
  it("leave HermitShell's own palette as it is", () => {
    expect(isDefault(DEFAULT_THEME)).toBe(true);
    expect(painter(DEFAULT_THEME)).toBeNull();
    expect(paintHtml("<style>a{color:#6366f1}</style>", null)).toBe("<style>a{color:#6366f1}</style>");
  });

  it("move the brand colours onto the palette, keeping tints pale and leaving other colours alone", () => {
    const paint = painter(cleanTheme({ palette: "ocean" }));
    expect(paint("#6366f1")).toBe(PALETTES.ocean[1]);
    expect(paint("#8b5cf6")).toBe(PALETTES.ocean[2]);
    expect(paint("rgba(99,102,241,.5)")).toBe("rgba(2,132,199,.5)");
    expect(lightness(paint("#eef2ff"))).toBeGreaterThan(0.9);
    expect(lightness(paint("#312e81"))).toBeLessThan(0.3);
    for (const other of ["#dc2626", "#059669", "#0f172a", "#eef1f7", "#fff", "#6366F1", "rgb(99 102 241)"]) expect(paint(other)).toBe(other);
  });

  it("repaint only CSS in a page, never its text", () => {
    const paint = painter(cleanTheme({ palette: "forest" }));
    const html = '<style>b{color:#6366f1}</style><p style="color:#6366f1">Note: #6366f1</p><svg><stop stop-color="#8b5cf6"/></svg><input value="#6366f1">';
    const out = paintHtml(html, paint);
    expect(out).toContain("Note: #6366f1");
    expect(out).toContain('<input value="#6366f1">');
    expect(out).not.toContain("color:#6366f1");
    expect(out).not.toContain('stop-color="#8b5cf6"');
  });

  it("darken custom colours too light for white button text", () => {
    const [c1, c2] = colours(cleanTheme({ palette: "custom", c1: "#FDE68A", c2: "#1d4ed8" }));
    expect(lightness(c1)).toBeLessThanOrEqual(0.61);
    expect(c2).toBe("#1d4ed8");
  });

  it("keep only known choices from a stored theme", () => {
    const t = cleanTheme({ name: " Northwind\u0000 Talent ".repeat(5), palette: "neon", c1: "red", font: "comic", corners: "sharp",
      logo: { type: "image/svg+xml", v: "0123456789ab" }, showName: "no" });
    expect(t.name).toHaveLength(40);
    expect(t.name.startsWith("Northwind Talent")).toBe(true);
    expect([t.palette, t.c1, t.font, t.corners, t.logo, t.showName]).toEqual(["hermitshell", DEFAULT_THEME.c1, "system", "sharp", null, true]);
    expect(cleanTheme(null)).toEqual(DEFAULT_THEME);
    expect(cleanTheme([1, 2])).toEqual(DEFAULT_THEME);
  });

  it("turn each look choice into CSS, and none for HermitShell's own", () => {
    expect(themeCss(DEFAULT_THEME)).toBe("");
    const css = themeCss(cleanTheme({ font: "serif", background: "plain", corners: "sharp", density: "compact", motion: "calm", logoSize: "large" }));
    for (const part of ["ui-serif", "body::before,body::after{display:none}", "main,.sheet{border-radius:6px}", "body{font-size:14px}",
      ".progress span{animation:none!important}", "width:36px"]) expect(css).toContain(part);
    for (const [key, [, options]] of Object.entries(CHOICES)) expect(Object.keys(options)[0]).toBe(DEFAULT_THEME[key]);
  });

  it("recognise pictures by their first bytes only", () => {
    expect(logoType(PNG)).toBe("image/png");
    expect(logoType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]))).toBe("image/jpeg");
    expect(logoType(new TextEncoder().encode("GIF89a......"))).toBe("image/gif");
    expect(logoType(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp");
    expect(logoType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBe("");
    expect(logoType(PNG.subarray(0, 8))).toBe("");
  });
});

describe("the theme page", () => {
  it("opens from a palette button beside the server button, for admins only", async () => {
    const { env, admin } = await setup();
    const dashboard = await admin.text("/admin");
    expect(dashboard).toMatch(/<a class="mebtn" href="\/admin\/theme" title="Theme and branding" aria-label="Theme and branding"><svg/);
    expect(dashboard.indexOf('class="srvbtn')).toBeLessThan(dashboard.indexOf('href="/admin/theme"'));
    const body = await admin.text("/admin/theme");
    expect(body).toContain("<h1>Theme and branding</h1>");
    expect(body).toMatch(/<a class="back" href="\/admin"><svg[^>]*>.*?<\/svg>Back to recruits<\/a>/);
    for (const id of [...Object.keys(PALETTES), "custom"]) expect(body).toContain(`id="pal-${id}"`);
    expect(body).toContain('id="pal-hermitshell" checked');
    expect(body).toContain('enctype="multipart/form-data"');
    expect(body).toContain('value="#6366F1" aria-label="Custom palette\'s main colour"');
    const add = new FormData();
    add.set("csrf", (await admin.text("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)[1]);
    for (const [k, v] of Object.entries({ op: "add", name: "Casey Quinn", username: "casey", password: "a long enough passphrase", roles: "recruiter" })) add.set(k, v);
    await worker.fetch(new Request(`${BASE}/admin/users`, { method: "POST", body: new URLSearchParams([...add]), headers: { Cookie: admin.cookie } }), env);
    const casey = await signIn(env, "casey", "a long enough passphrase", "203.0.113.51");
    expect(await casey.text("/admin")).not.toContain('href="/admin/theme"');
    expect((await casey.get("/admin/theme")).status).toBe(403);
  });

  it("applies a palette, name and look to every page, the sign-in page too", async () => {
    const { env, admin } = await setup();
    const res = await admin.save({ name: "Northwind Talent", palette: "ocean", font: "serif", corners: "soft" });
    expect(res.headers.get("Location")).toBe("/admin/theme?done=saved");
    const saved = JSON.parse(env.FEEDBACK.store.get(THEME_KEY));
    expect(saved).toMatchObject({ name: "Northwind Talent", palette: "ocean", font: "serif", corners: "soft" });
    const version = themeVersion(cleanTheme(saved));
    const login = await publicPage(env);
    expect(login).toContain('<div class="eyebrow"><svg class="mark"');
    expect(login).toContain("Northwind Talent</div>");
    expect(login).not.toContain("HermitShell</div>");
    expect(login).toContain(`<link rel="stylesheet" href="${STYLE_URL}&amp;t=${version}"><style>`);
    expect(login).toContain(`<link rel="icon" href="/favicon.svg?t=${version}"`);
    expect(login).toContain("ui-serif");
    expect(login).toContain(`stop-color="${PALETTES.ocean[1]}"`);
    expect(login).not.toContain('stop-color="#6366f1"');
    expect(await admin.text("/admin/theme?done=saved")).toContain("Saved. Every page now uses this theme.");

    const css = await worker.fetch(new Request(`${BASE}${STYLE_URL}&t=${version}`), env);
    const sheet = await css.text();
    expect(sheet).toContain(`--brand:${PALETTES.ocean[1]}`);
    expect(sheet).not.toContain("#6366f1");
    expect(css.headers.get("Cache-Control")).toContain("immutable");
    const stale = await worker.fetch(new Request(`${BASE}${STYLE_URL}&t=00000000`), env);
    expect(stale.headers.get("Cache-Control")).toBe("no-store");
    expect(await (await worker.fetch(new Request(`${BASE}${STYLE_URL}`), env)).text()).toContain("--brand:#6366f1");
    const icon = await (await worker.fetch(new Request(`${BASE}/favicon.svg?t=${version}`), env)).text();
    expect(icon).toContain(PALETTES.ocean[1]);
    expect(icon).not.toContain("#6366f1");
  });

  it("keeps a custom palette's colours, and refuses anything that isn't a colour", async () => {
    const { env, admin } = await setup();
    await admin.save({ palette: "custom", c1: "#0F766E", c2: "#BE185D" });
    expect(JSON.parse(env.FEEDBACK.store.get(THEME_KEY))).toMatchObject({ palette: "custom", c1: "#0f766e", c2: "#be185d" });
    expect(await admin.text("/admin/theme")).toContain('value="#0F766E"');
    const bad = await admin.save({ palette: "custom", c1: "#fff;}</style><script>alert(1)</script>" });
    expect(bad.headers.get("Location")).toBe("/admin/theme?done=badcolour");
    expect(JSON.parse(env.FEEDBACK.store.get(THEME_KEY)).c1).toBe("#0f766e");
  });

  it("shows an uploaded logo in place of the shell, as the tab icon unless turned off, and removes it", async () => {
    const { env, admin } = await setup();
    await admin.save({ name: "Contoso Careers" }, { bytes: PNG });
    const { logo } = JSON.parse(env.FEEDBACK.store.get(THEME_KEY));
    expect(logo).toEqual({ type: "image/png", v: expect.stringMatching(/^[0-9a-f]{12}$/) });
    const login = await publicPage(env);
    expect(login).toContain(`<div class="eyebrow"><img class="mark" src="/brand/logo?v=${logo.v}" alt="">Contoso Careers</div>`);
    expect(login).toContain(`<link rel="icon" href="/brand/logo?v=${logo.v}" type="image/png">`);
    const served = await worker.fetch(new Request(`${BASE}/brand/logo?v=${logo.v}`), env);
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    expect(served.headers.get("Cache-Control")).toContain("immutable");

    await admin.save({ name: "Contoso Careers", showname: "", tabicon: "" });
    const plain = await publicPage(env);
    expect(plain).toContain(`<img class="mark" src="/brand/logo?v=${logo.v}" alt="Contoso Careers"></div>`);
    expect(plain).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');

    await admin.save({ name: "Contoso Careers", nologo: "1" });
    expect(env.FEEDBACK.store.has(LOGO_KEY)).toBe(false);
    expect(JSON.parse(env.FEEDBACK.store.get(THEME_KEY)).logo).toBeNull();
    expect((await worker.fetch(new Request(`${BASE}/brand/logo?v=${logo.v}`), env)).status).toBe(404);
  });

  it("takes a WebP logo, serving it as WebP and as the tab icon", async () => {
    const { env, admin } = await setup();
    const webp = new TextEncoder().encode("RIFF\u001a\u0000\u0000\u0000WEBPVP8L\r\u0000\u0000\u0000/\u0000\u0000\u0000");
    const res = await admin.save({ name: "Proseware" }, { bytes: webp, type: "image/webp", name: "brandmark.webp" });
    expect(res.headers.get("Location")).toBe("/admin/theme?done=saved");
    const { logo } = JSON.parse(env.FEEDBACK.store.get(THEME_KEY));
    expect(logo.type).toBe("image/webp");
    expect(await publicPage(env)).toContain(`<link rel="icon" href="/brand/logo?v=${logo.v}" type="image/webp">`);
    const served = await worker.fetch(new Request(`${BASE}/brand/logo?v=${logo.v}`), env);
    expect(served.headers.get("Content-Type")).toBe("image/webp");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(webp);
  });

  it("lets the dashboard script preview a picked logo, with the limits it checks before saving", async () => {
    const { admin } = await setup();
    const res = await admin.get("/admin/theme");
    const body = await res.text();
    expect(body).toContain(`accept="image/png,image/jpeg,image/gif,image/webp" data-max="${MAX_LOGO_BYTES}"`);
    expect(body).toContain('<span class="tlogobad" role="alert" hidden></span>');
    expect(body).toContain("A preview of the logo, palette");
    expect(res.headers.get("Content-Security-Policy")).toContain("img-src 'self' blob:");
  });

  it("puts everything back with Reset, and pages are then HermitShell's own", async () => {
    const { env, admin } = await setup();
    await admin.save({ name: "Fabrikam", palette: "sunset", background: "plain" }, { bytes: PNG });
    const reset = await admin.save({ op: "reset" });
    expect(reset.headers.get("Location")).toBe("/admin/theme?done=reset");
    expect(env.FEEDBACK.store.has(THEME_KEY)).toBe(false);
    expect(env.FEEDBACK.store.has(LOGO_KEY)).toBe(false);
    const login = await publicPage(env);
    expect(login).toContain(`<link rel="stylesheet" href="${STYLE_URL}"></head>`);
    expect(login).toContain("HermitShell</div>");
  });

  it("stores nothing when saved as HermitShell's own look", async () => {
    const { env, admin } = await setup();
    await admin.save({ palette: "hermitshell" });
    expect(env.FEEDBACK.store.has(THEME_KEY)).toBe(false);
  });

  it("is the real theme in demo mode too", async () => {
    const { env, admin } = await setup();
    const csrf = (await admin.text("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)[1];
    await worker.fetch(new Request(`${BASE}/admin/demo`, { method: "POST", body: new URLSearchParams({ csrf, on: "1" }), headers: { Cookie: admin.cookie } }), env);
    expect(await admin.text("/admin/theme")).toContain('<div class="demoribbon"');
    await admin.save({ name: "Litware", palette: "berry" });
    expect(JSON.parse(env.FEEDBACK.store.get(THEME_KEY)).name).toBe("Litware");
    expect(await admin.text("/admin")).toContain("Litware</div>");
  });

  it("refuses a logo over the size limit", async () => {
    const { env, admin } = await setup();
    const big = new Uint8Array(MAX_LOGO_BYTES + 1);
    big.set(PNG);
    expect((await admin.save({}, { bytes: big })).headers.get("Location")).toBe("/admin/theme?done=toobig");
    expect(env.FEEDBACK.store.has(LOGO_KEY)).toBe(false);
    expect(await admin.text("/admin/theme?done=toobig")).toContain("That logo is over 200 KB.");
  });
});

describe("reading the theme", () => {
  it("happens for pages only, and a KV failure shows HermitShell's look rather than an error", async () => {
    const env = testEnv(ADMIN);
    const get = env.FEEDBACK.get.bind(env.FEEDBACK);
    const asked = [];
    env.FEEDBACK.get = async (key, type) => {
      asked.push(key);
      if (key === THEME_KEY) throw new Error("KV unavailable");
      return get(key, type);
    };
    await worker.fetch(new Request(`${BASE}/api/queue`, { headers: API }), env);
    expect(asked).not.toContain(THEME_KEY);
    const res = await worker.fetch(new Request(`${BASE}/admin`), env);
    expect(res.status).toBe(200);
    expect(asked).toContain(THEME_KEY);
    expect(await res.text()).toContain(`<link rel="stylesheet" href="${STYLE_URL}">`);
  });
});

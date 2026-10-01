// The pages' theme and branding, set by an admin at /admin/theme and applied to every page the Worker draws (the
// dashboard, sign-in, sign-up and email-button pages): a name and logo in place of HermitShell's, a palette, and the
// background, corners, font, spacing and motion. Emails are drawn by HermitShell on the server and keep its look.
// It is one KV value ("theme", with the logo in "theme:logo"), read once per page and kept in memory for
// THEME_TTL_MS, so other Worker instances follow a change within that.
//
// Colours: the pages' indigo-to-violet family (hue 225-272, saturation 45% and up: the brand colours, their tints and
// shadows) is repainted as a page is sent, each colour moved to the chosen palette with its lightness mapped around
// the palette colour's own, so tints stay pale and shadows dark. Only CSS is repainted (<style>, style="" and SVG
// colour attributes, and /app.css), never text. The theme page writes its swatches as "rgb(r g b)" and its colour
// fields in capitals, which the repaint doesn't match, so they show the colours themselves; the search and AI
// providers' logos are written the same way so they keep their own brand colours under any theme.
//
// A logo is a PNG, JPEG, GIF or WebP picture up to MAX_LOGO_BYTES, checked by its first bytes. SVG is refused, as it
// can carry script. It is served from /brand/logo with a sandbox CSP, and pages show it only as an <img>.

import { BACK_TO_RECRUITS, BRAND_MARK, STYLE_URL, SECURITY_HEADERS, esc, favicon, fnv, hex, limitedForm, note, page, redirect, safeEqual, stylesheet } from "./lib.js";

export const THEME_URL = "/admin/theme";
export const LOGO_PATH = "/brand/logo";
export const MAX_LOGO_BYTES = 200 * 1024;
export const THEME_KEY = "theme";
export const LOGO_KEY = "theme:logo";
const MAX_NAME = 40;
const THEME_TTL_MS = 30000;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// Each palette's name and its two colours (the buttons' gradient runs from the first to the second).
export const PALETTES = {
  hermitshell: ["HermitShell", "#6366f1", "#8b5cf6"],
  ocean: ["Ocean", "#0284c7", "#06b6d4"],
  forest: ["Forest", "#059669", "#0d9488"],
  royal: ["Royal", "#1d4ed8", "#7c3aed"],
  berry: ["Berry", "#db2777", "#9333ea"],
  sunset: ["Sunset", "#ea580c", "#e11d48"],
  ember: ["Ember", "#b45309", "#dc2626"],
  graphite: ["Graphite", "#475569", "#1e293b"],
};

// Each choice: its label and its options, the first being HermitShell's own.
export const CHOICES = {
  background: ["Background", { aurora: "Aurora", still: "Still", plain: "Plain" }],
  corners: ["Corners", { rounded: "Rounded", soft: "Soft", sharp: "Sharp" }],
  font: ["Font", { system: "System", rounded: "Rounded", serif: "Serif", mono: "Mono" }],
  density: ["Spacing", { comfortable: "Comfortable", compact: "Compact" }],
  motion: ["Motion", { full: "Full", calm: "Calm" }],
  logoSize: ["Logo size", { small: "Small", large: "Large" }],
};

const FONTS = {
  rounded: "ui-rounded,'SF Pro Rounded','Nunito','Varela Round','Segoe UI',system-ui,sans-serif",
  serif: "ui-serif,'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif",
  mono: "ui-monospace,'Cascadia Code','SF Mono',Menlo,Consolas,monospace",
};

const cleanName = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "");

// A stored theme with anything unknown or malformed replaced by HermitShell's own.
export function cleanTheme(raw) {
  const t = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const colour = (v, fallback) => (typeof v === "string" && HEX_RE.test(v) ? v.toLowerCase() : fallback);
  const logo = t.logo && typeof t.logo === "object" && LOGO_TYPES.includes(t.logo.type) && /^[0-9a-f]{12}$/.test(t.logo.v || "")
    ? { type: t.logo.type, v: t.logo.v } : null;
  return {
    name: cleanName(t.name),
    palette: Object.hasOwn(PALETTES, t.palette || "") || t.palette === "custom" ? t.palette : "hermitshell",
    c1: colour(t.c1, PALETTES.hermitshell[1]),
    c2: colour(t.c2, PALETTES.hermitshell[2]),
    ...Object.fromEntries(Object.entries(CHOICES).map(([k, [, options]]) =>
      [k, Object.hasOwn(options, t[k] || "") ? t[k] : Object.keys(options)[0]])),
    showName: t.showName !== false,
    tabIcon: t.tabIcon !== false,
    logo,
  };
}

export const DEFAULT_THEME = cleanTheme({});

export function isDefault(t) {
  const [c1, c2] = colours(t);
  return !t.name && !t.logo && c1 === DEFAULT_THEME.c1 && c2 === DEFAULT_THEME.c2
    && Object.keys(CHOICES).every((k) => t[k] === DEFAULT_THEME[k]) && t.showName && t.tabIcon;
}

export const themeVersion = (t) => fnv(JSON.stringify(t));

const cache = new WeakMap();

// The theme, from memory when it was read in the last THEME_TTL_MS (or from KV when `fresh`).
export async function readTheme(env, { fresh = false, now = Date.now() } = {}) {
  const kv = env.FEEDBACK?.raw || env.FEEDBACK;
  if (!kv) return DEFAULT_THEME;
  const hit = cache.get(kv);
  if (!fresh && hit && now - hit.at < THEME_TTL_MS) return hit.theme;
  const theme = cleanTheme(await env.FEEDBACK.get(THEME_KEY, "json"));
  cache.set(kv, { theme, at: now });
  return theme;
}

function forgetTheme(env) {
  cache.delete(env.FEEDBACK?.raw || env.FEEDBACK);
}

// ------------------------------------------------------------------------- colours

const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hexOf = (rgb) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
const rgbText = (h) => `rgb(${rgbOf(h).join(" ")})`;

function hsl([r, g, b]) {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function rgb([h, s, l]) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [f(0), f(8), f(4)];
}

// A custom colour dark enough for white button text to stay readable on it.
function readable(h) {
  const [hue, s, l] = hsl(rgbOf(h));
  return l > 0.6 ? hexOf(rgb([hue, s, 0.6])) : h;
}

export function colours(t) {
  return t.palette === "custom" ? [readable(t.c1), readable(t.c2)] : PALETTES[t.palette].slice(1);
}

const BASE = [hsl(rgbOf(PALETTES.hermitshell[1])), hsl(rgbOf(PALETTES.hermitshell[2]))];
const inFamily = ([h, s]) => h >= 225 && h <= 272 && s >= 0.45;

function moved(c, from, to) {
  const l = c[2] <= from[2] ? (c[2] * to[2]) / from[2] : to[2] + ((c[2] - from[2]) * (1 - to[2])) / (1 - from[2]);
  return [(to[0] + c[0] - from[0] + 360) % 360, Math.min(1, (c[1] * to[1]) / from[1]), l];
}

// A function repainting the family's colours in CSS for the theme's palette, or null for HermitShell's own.
export function painter(t) {
  const [c1, c2] = colours(t);
  if (c1 === DEFAULT_THEME.c1 && c2 === DEFAULT_THEME.c2) return null;
  const to = [hsl(rgbOf(c1)), hsl(rgbOf(c2))];
  const done = new Map();
  const repaint = (value) => {
    const c = hsl(value);
    if (!inFamily(c)) return null;
    const i = c[0] < 249 ? 0 : 1;
    return rgb(moved(c, BASE[i], to[i])).map((v) => Math.round(Math.min(255, Math.max(0, v))));
  };
  return (css) => css.replace(/#([0-9a-f]{6})(?![0-9A-Za-z])|(rgba?\()(\d{1,3}),(\d{1,3}),(\d{1,3})/g, (m, h6, fn, r, g, b) => {
    if (!done.has(m)) {
      const next = repaint(h6 ? rgbOf(`#${h6}`) : [Number(r), Number(g), Number(b)]);
      done.set(m, !next ? m : h6 ? hexOf(next) : `${fn}${next.join(",")}`);
    }
    return done.get(m);
  });
}

const CSS_PARTS = /<style[^>]*>[\s\S]*?<\/style>|\s(?:style|fill|stroke|stop-color|flood-color|color)="[^"]*"/g;

export function paintHtml(html, paint) {
  return paint ? html.replace(CSS_PARTS, (part) => paint(part)) : html;
}

// ------------------------------------------------------------------------- applying it

const RADII = { soft: [14, 8, 6], sharp: [6, 4, 3] };
const ROUNDED = "button,input,select,textarea,.mebtn,.mecard,a.back,nav.tabs,.doc,.keyrow,.keycard,.note,.warn,.waitbar,code.link,.addkey";

// The theme's choices other than colour, as CSS added after the shared stylesheet.
export function themeCss(t) {
  const css = [];
  if (FONTS[t.font]) css.push(`body,button,input,select,textarea{font-family:${FONTS[t.font]}}`);
  if (t.background === "still") css.push("body::before,body::after{animation:none}");
  if (t.background === "plain") css.push("body::before,body::after{display:none}html{background:#f3f5f9}");
  if (RADII[t.corners]) {
    const [card, box, tab] = RADII[t.corners];
    css.push(`main,.sheet{border-radius:${card}px}${ROUNDED}{border-radius:${box}px}nav.tabs a,.avatar{border-radius:${tab}px}`);
  }
  if (t.density === "compact") {
    css.push("body{font-size:14px}main{margin:36px auto;padding:24px}h1{font-size:24px;margin:10px 0 4px}h2{margin:24px 0 8px}"
      + "label{margin:12px 0 5px}button{padding:10px 18px}table.list td{padding:11px 10px}nav.tabs{margin:8px 0 18px}");
  }
  if (t.motion === "calm") {
    css.push("ul.steps li,.note,.warn,.progress span{animation:none!important}body::before,body::after{animation:none!important}");
  }
  if (t.logo) css.push(".eyebrow img.mark{flex:none;width:24px;height:24px;border-radius:6px;object-fit:contain}");
  if (t.logoSize === "large") css.push(".eyebrow .mark,.eyebrow svg.mark{width:36px;height:36px;border-radius:10px}");
  return css.join("\n");
}

export const logoUrl = (t) => `${LOGO_PATH}?v=${t.logo.v}`;
const brandName = (t) => t.name || "HermitShell";
const EYEBROW = `<div class="eyebrow">${BRAND_MARK}HermitShell</div>`;
const FAVICON_LINK = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';

function eyebrow(t) {
  const shown = t.showName || !t.logo;
  const mark = t.logo ? `<img class="mark" src="${logoUrl(t)}" alt="${shown ? "" : esc(brandName(t))}">` : BRAND_MARK;
  return `<div class="eyebrow">${mark}${shown ? esc(brandName(t)) : ""}</div>`;
}

function faviconLink(t, version, paint) {
  if (t.logo && t.tabIcon) return `<link rel="icon" href="${logoUrl(t)}" type="${t.logo.type}">`;
  return paint ? `<link rel="icon" href="/favicon.svg?t=${version}" type="image/svg+xml">` : FAVICON_LINK;
}

// A page with the theme applied; anything but HTML, and every page while the theme is HermitShell's own, as it is.
export async function themed(res, env, theme = null) {
  if (!(res.headers.get("Content-Type") || "").startsWith("text/html")) return res;
  const t = await (theme || readTheme(env));
  if (isDefault(t)) return res;
  const version = themeVersion(t);
  const paint = painter(t);
  const html = (await res.text())
    .replace(`<link rel="stylesheet" href="${STYLE_URL}">`,
      `<link rel="stylesheet" href="${STYLE_URL}${paint ? `&amp;t=${version}` : ""}"><style>${themeCss(t)}</style>`)
    .replace(FAVICON_LINK, faviconLink(t, version, paint))
    .replace(EYEBROW, eyebrow(t));
  return new Response(paintHtml(html, paint), { status: res.status, statusText: res.statusText, headers: res.headers });
}

// /app.css and /favicon.svg in the theme's colours when asked for with its version (?t=). An address for an older
// version gets the current colours, not to be kept, so it can't stand in for that version later.
async function repainted(url, env, draw) {
  if (!url.searchParams.has("t")) return draw(null);
  const t = await readTheme(env);
  const res = draw(painter(t));
  if (url.searchParams.get("t") !== themeVersion(t)) res.headers.set("Cache-Control", "no-store");
  return res;
}

export const themedStylesheet = (url, env) => repainted(url, env, (paint) => stylesheet(paint));
export const themedFavicon = (url, env) => repainted(url, env, (paint) => favicon(paint));

export async function logoResponse(url, env) {
  const t = await readTheme(env);
  const bytes = t.logo ? await env.FEEDBACK.get(LOGO_KEY, "arrayBuffer") : null;
  if (!bytes) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS } });
  return new Response(bytes, {
    headers: {
      "Content-Type": t.logo.type,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...SECURITY_HEADERS,
      "Cache-Control": url.searchParams.get("v") === t.logo.v ? "public, max-age=31536000, immutable" : "no-store",
    },
  });
}

// ------------------------------------------------------------------------- the admin page

export function logoType(b) {
  const text = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (b.length < 12) return "";
  if (b[0] === 0x89 && text(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (text(0, 4) === "GIF8") return "image/gif";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  return "";
}

const DONE = {
  saved: ["Saved. Every page now uses this theme.", "ok"],
  reset: ["Back to HermitShell's own look.", "ok"],
  badlogo: ["That logo isn't a PNG, JPEG, GIF or WebP picture. SVG isn't accepted, as it can carry script.", "bad"],
  toobig: [`That logo is over ${MAX_LOGO_BYTES / 1024} KB. Try a smaller picture.`, "bad"],
  badcolour: ["Pick the custom colours with the colour fields.", "bad"],
};

// POST /admin/theme: save the form, or put everything back to HermitShell's own.
export async function themeRequest(request, env, s) {
  const form = await limitedForm(request, MAX_LOGO_BYTES + 32768);
  if (!form) return redirect(`${THEME_URL}?done=toobig`);
  if (!safeEqual(String(form.get("csrf") || ""), s.csrf)) return page("Expired form", "<p>Reload the page and try again.</p>", { status: 403 });
  const f = (k) => String(form.get(k) ?? "");
  if (f("op") === "reset") {
    await Promise.all([env.FEEDBACK.delete(THEME_KEY), env.FEEDBACK.delete(LOGO_KEY)]);
    forgetTheme(env);
    return redirect(`${THEME_URL}?done=reset`);
  }
  if ([f("c1"), f("c2")].some((c) => c && !HEX_RE.test(c))) return redirect(`${THEME_URL}?done=badcolour`);
  const before = await readTheme(env, { fresh: true });
  let logo = before.logo;
  const file = form.get("logo");
  if (file && typeof file === "object" && file.size > 0) {
    if (file.size > MAX_LOGO_BYTES) return redirect(`${THEME_URL}?done=toobig`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = logoType(bytes);
    if (!type) return redirect(`${THEME_URL}?done=badlogo`);
    await env.FEEDBACK.put(LOGO_KEY, bytes);
    logo = { type, v: hex(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 12) };
  } else if (f("nologo") === "1" && logo) {
    await env.FEEDBACK.delete(LOGO_KEY);
    logo = null;
  }
  const theme = cleanTheme({
    name: f("name"), palette: f("palette"), c1: f("c1") || before.c1, c2: f("c2") || before.c2,
    ...Object.fromEntries(Object.keys(CHOICES).map((k) => [k, f(k)])),
    showName: f("showname") === "1", tabIcon: f("tabicon") === "1", logo,
  });
  if (isDefault(theme) && theme.palette !== "custom") await env.FEEDBACK.delete(THEME_KEY);
  else await env.FEEDBACK.put(THEME_KEY, JSON.stringify(theme));
  forgetTheme(env);
  return redirect(`${THEME_URL}?done=saved`);
}

export const PALETTE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"/>'
  + '<circle cx="7.5" cy="11.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7.5" r="1.2" fill="currentColor" stroke="none"/>'
  + '<circle cx="15" cy="7.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="17.5" cy="11" r="1.2" fill="currentColor" stroke="none"/></svg>';

// The preview follows the form with CSS alone (:has on the checked options); the dashboard's script also follows
// the custom colours and the name as they are typed, and a logo as soon as it is picked.
function previewRules() {
  const rules = Object.entries(PALETTES).map(([id, [, a, b]]) => `.theme:has(#pal-${id}:checked){--pv1:${rgbText(a)};--pv2:${rgbText(b)}}`);
  rules.push(".theme:has(#pal-custom:checked){--pv1:var(--c1);--pv2:var(--c2)}");
  for (const [id, stack] of Object.entries(FONTS)) rules.push(`.theme:has(#font-${id}:checked) .pvcard{font-family:${stack}}`);
  for (const [id, [card, box, tab]] of Object.entries(RADII)) {
    rules.push(`.theme:has(#corners-${id}:checked) .tprev{--pvr:${card}px;--pvr2:${box}px;--pvr3:${tab}px}`);
  }
  rules.push(".theme:has(#density-compact:checked) .pvcard{padding:16px 18px;font-size:12.5px;gap:8px}",
    ".theme:has(#background-plain:checked) .pvbg{background:#f3f5f9}.theme:has(#background-plain:checked) .pvbg::before{display:none}",
    ".theme:has(#background-still:checked) .pvbg::before,.theme:has(#motion-calm:checked) .pvbg::before{animation:none}",
    ".theme:has(#logoSize-large:checked) .pvmark{width:30px;height:30px;border-radius:9px}",
    ".theme:has(#showname:not(:checked)):has(.pvmark img) .pvname{display:none}");
  return rules.join("\n");
}

const THEME_STYLE = `
.theme{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:28px;align-items:start}
.theme section{padding:0 0 6px}.theme h2{margin:22px 0 10px}.theme section:first-child h2{margin-top:6px}
.tpals{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.tpal{position:relative;display:flex;align-items:center;gap:10px;margin:0;padding:10px 12px;border:1px solid var(--line);border-radius:14px;
background:var(--field);cursor:pointer;font-weight:650;font-size:13.5px;transition:border-color .15s,box-shadow .15s,transform .15s var(--ease)}
.tpal:hover{border-color:#c9cfe0;transform:translateY(-1px)}
.tpal input[type=radio]{position:absolute;opacity:0;pointer-events:none}
.tpal:has(input:checked){border-color:var(--brand);box-shadow:0 0 0 3px rgba(99,102,241,.18);background:#fff}
.tpal:has(input:focus-visible){outline:3px solid rgba(99,102,241,.35);outline-offset:2px}
.tsw{flex:none;width:30px;height:30px;border-radius:10px;background:linear-gradient(135deg,var(--a),var(--b));box-shadow:0 6px 14px -8px rgba(15,23,42,.6)}
.tcustom{flex-wrap:wrap}.tcustom>label{display:flex;align-items:center;gap:10px;margin:0;cursor:pointer;flex:1}
.tpick{display:flex;gap:6px}form.theme .tpick input[type=color][data-pv]{width:40px;height:32px;padding:3px;border:1px solid var(--line);border-radius:9px;background:#fff;cursor:pointer}
.tpick input::-webkit-color-swatch-wrapper{padding:0}.tpick input::-webkit-color-swatch{border:0;border-radius:6px}.tpick input::-moz-color-swatch{border:0;border-radius:6px}
.tseg{display:grid;grid-template-columns:120px minmax(0,1fr);align-items:center;gap:10px;margin:0 0 10px}
.tseg>span{font-size:13.5px;font-weight:650}
.tseg div{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;background:#f0f2f8;border:1px solid var(--line);border-radius:12px;justify-self:start}
.tseg label{margin:0;padding:6px 13px;border-radius:9px;font-size:13px;font-weight:650;color:var(--muted);cursor:pointer;transition:color .15s,background .15s}
.tseg label:hover{color:var(--ink)}.tseg input{position:absolute;opacity:0;pointer-events:none}
.tseg label:has(input:checked){color:var(--brand-ink);background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.1)}
.tseg label:has(input:focus-visible){outline:3px solid rgba(99,102,241,.35)}
.tlogo{display:flex;align-items:center;gap:14px;margin:4px 0 8px}.tlogo img{width:48px;height:48px;object-fit:contain;border-radius:12px;
border:1px solid var(--line);background:#fff;padding:4px}
.tlogobad{display:block;margin:6px 0 2px;color:#b91c1c;font-size:13px;font-weight:650}.tlogobad[hidden]{display:none}
.tbtns{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:18px}.tbtns button{margin:0}
.tprev{position:sticky;top:24px}
.pvbg{position:relative;overflow:hidden;padding:26px 18px;border-radius:18px;background:#eef1f7;border:1px solid var(--line)}
.pvbg::before{content:"";position:absolute;inset:-40%;background:radial-gradient(closest-side at 25% 20%,color-mix(in srgb,var(--pv1) 35%,transparent),transparent),
radial-gradient(closest-side at 80% 25%,color-mix(in srgb,var(--pv2) 30%,transparent),transparent);animation:pvdrift 14s ease-in-out infinite alternate}
@keyframes pvdrift{to{transform:translate(8%,6%) scale(1.08)}}
.pvcard{position:relative;display:grid;gap:11px;padding:20px 22px;background:rgba(255,255,255,.95);border-radius:var(--pvr,22px);font-size:13.5px;
box-shadow:0 18px 40px -20px rgba(15,23,42,.35);--pvink:color-mix(in srgb,var(--pv1) 72%,#0f172a);--pvsoft:color-mix(in srgb,var(--pv1) 11%,#fff)}
.pveye{display:flex;align-items:center;gap:8px;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;font-weight:750;color:var(--pvink)}
.pvmark{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:7px;color:#fff;font-size:12px;letter-spacing:0;
background:linear-gradient(135deg,var(--pv1),var(--pv2));overflow:hidden}.pvmark img{width:100%;height:100%;object-fit:contain;background:#fff}
.pvh{font-size:20px;font-weight:750;letter-spacing:-.02em;color:var(--ink)}
.pvtabs{display:inline-flex;gap:2px;padding:3px;background:#f0f2f8;border-radius:var(--pvr2,12px);justify-self:start}
.pvtabs span{padding:4px 11px;border-radius:var(--pvr3,9px);font-weight:650;color:var(--muted);font-size:12px}
.pvtabs span.on{background:#fff;color:var(--pvink);box-shadow:0 1px 3px rgba(15,23,42,.1)}
.pvp{margin:0;color:var(--text)}.pvp a{color:var(--pvink)}
.pvbar{height:7px;border-radius:99px;background:#eceef6;overflow:hidden}.pvbar span{display:block;width:64%;height:100%;border-radius:inherit;
background:linear-gradient(90deg,var(--pv1),var(--pv2))}
.pvrow{display:flex;gap:6px;flex-wrap:wrap}.pvpill{border-radius:99px;padding:2px 9px;font-size:11.5px;font-weight:650;background:var(--pvsoft);color:var(--pvink)}
.pvfield{border:1px solid var(--line);border-radius:var(--pvr2,12px);padding:8px 11px;color:var(--ink);background:var(--field)}
.pvbtns{display:flex;gap:8px;flex-wrap:wrap}.pvbtn{padding:8px 15px;border-radius:var(--pvr2,12px);font-weight:650;color:#fff;
background:linear-gradient(135deg,var(--pv1),var(--pv2));box-shadow:0 8px 18px -10px var(--pv1)}
.pvbtn.q{background:var(--pvsoft);color:var(--pvink);box-shadow:none}
.tprev .muted{margin:10px 2px 0}
@media (max-width:980px){.theme{grid-template-columns:minmax(0,1fr)}.tprev{position:static;order:-1}}
@media (max-width:560px){.tseg{grid-template-columns:1fr}}
`;

function segment(key, value) {
  const [label, options] = CHOICES[key];
  return `<div class="tseg" role="radiogroup" aria-label="${label}"><span>${label}</span><div>${Object.entries(options).map(([id, text]) =>
    `<label><input type="radio" name="${key}" value="${id}" id="${key}-${id}"${value === id ? " checked" : ""}>${text}</label>`).join("")}</div></div>`;
}

export function themePage(t, csrf, done = "") {
  const [message, kind] = DONE[done] || [];
  const check = (name, on, text) => `<label class="check"><input type="checkbox" name="${name}" id="${name}" value="1"${on ? " checked" : ""}><span>${text}</span></label>`;
  const upper = (h) => h.toUpperCase();
  const pals = Object.entries(PALETTES).map(([id, [label, a, b]]) => `<label class="tpal"><input type="radio" name="palette" value="${id}" id="pal-${id}"${
    t.palette === id ? " checked" : ""}><span class="tsw" style="--a:${rgbText(a)};--b:${rgbText(b)}"></span>${label}</label>`).join("");
  const custom = `<div class="tpal tcustom"><label><input type="radio" name="palette" value="custom" id="pal-custom"${t.palette === "custom" ? " checked" : ""}>
<span class="tsw" style="--a:var(--c1);--b:var(--c2)"></span>Custom</label><span class="tpick">
<input type="color" name="c1" value="${upper(t.c1)}" aria-label="Custom palette's main colour" data-pv="--c1">
<input type="color" name="c2" value="${upper(t.c2)}" aria-label="Custom palette's second colour" data-pv="--c2"></span></div>`;
  const logo = t.logo ? `<div class="tlogo"><img src="${logoUrl(t)}" alt="The current logo">${check("nologo", false, "Remove the logo")}</div>` : "";
  const mark = t.logo ? `<img src="${logoUrl(t)}" alt="">` : esc(brandName(t).slice(0, 1).toUpperCase());
  const body = `<style>${THEME_STYLE}${previewRules()}</style>${message ? note(message, kind) : ""}
<p class="muted">How every page the Worker draws looks: the dashboard, sign-in, the sign-up form and the pages behind email buttons. Emails keep
HermitShell&rsquo;s look. Changes show for everyone within a minute.</p>
<form class="theme" method="post" action="${THEME_URL}" enctype="multipart/form-data" style="--c1:${rgbText(readable(t.c1))};--c2:${rgbText(readable(t.c2))}">
<input type="hidden" name="csrf" value="${esc(csrf)}"><div>
<section><h2>Branding</h2>
<label for="tname">Name</label><input id="tname" name="name" maxlength="${MAX_NAME}" value="${esc(t.name)}" placeholder="HermitShell" autocomplete="off">
<span class="hint">Shown at the top of every page in place of HermitShell. Messages about the HermitShell server keep its name.</span>
<label for="tlogo">Logo</label>${logo}<input id="tlogo" type="file" name="logo" accept="${LOGO_TYPES.join(",")}" data-max="${MAX_LOGO_BYTES}">
<span class="tlogobad" role="alert" hidden></span>
<span class="hint">PNG, JPEG, GIF or WebP, up to ${MAX_LOGO_BYTES / 1024} KB; a square picture fits best. SVG isn&rsquo;t accepted, as it can carry script.</span>
${check("showname", t.showName, "Show the name next to the logo")}${check("tabicon", t.tabIcon, "Use the logo as the browser tab&rsquo;s icon")}
${segment("logoSize", t.logoSize)}</section>
<section><h2>Palette</h2><div class="tpals" role="radiogroup" aria-label="Palette">${pals}${custom}</div>
<span class="hint">Custom colours too light for white button text are darkened a little.</span></section>
<section><h2>Look</h2>${["background", "corners", "font", "density", "motion"].map((k) => segment(k, t[k])).join("")}
<span class="hint">Calm motion stops the background drifting and cards sliding in; people whose system asks for less motion get that anyway.</span></section>
<div class="tbtns"><button type="submit">Save theme</button><button type="submit" name="op" value="reset" class="quiet" formnovalidate>Reset to HermitShell&rsquo;s look</button></div>
</div>
<aside class="tprev" aria-label="Preview"><div class="pvbg"><div class="pvcard">
<div class="pveye"><span class="pvmark">${mark}</span><span class="pvname">${esc(brandName(t))}</span></div>
<div class="pvh">Sam Lee</div><div class="pvtabs"><span class="on">Manage</span><span>History</span></div>
<p class="pvp">3 new jobs today, 2 marked <a>interested</a>.</p><div class="pvbar"><span></span></div>
<div class="pvrow"><span class="pvpill">active</span><span class="pvpill">Data Analyst</span></div>
<div class="pvfield">BI Developer, Data Engineer</div>
<div class="pvbtns"><span class="pvbtn">Save changes</span><span class="pvbtn q">Send jobs now</span></div>
</div></div><p class="muted">A preview of the logo, palette, corners, font and spacing. Save to see them on every page.</p></aside>
</form>`;
  return page("Theme and branding", body, { wide: "full", before: BACK_TO_RECRUITS });
}

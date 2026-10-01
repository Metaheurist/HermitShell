// Passwords, API keys and CVs are sealed for HermitShell before they are stored in KV, so KV (and anyone who can
// read it in the Cloudflare account) only holds ciphertext until HermitShell collects them. HermitShell sends the
// public half of its key pair with its status; common/worker_seal.py opens what is sealed here.
//
// Each value gets a fresh AES-256-GCM key, wrapped with RSA-OAEP-SHA-256 and bound to what it is (the field name,
// or the CV's KV key) as associated data. Envelope: "HS1" | key id (first 8 bytes of SHA-256 of the public key) |
// wrapped key length (2 bytes, big-endian) | wrapped key | IV (12) | ciphertext. A sealed text field is "sealed:"
// and the envelope in base64url; the item lists its sealed fields in `sealed`, a CV file has `sealed: true`.

export const SEAL_ALG = "RSA-OAEP-256+A256GCM";
export const SEAL_PREFIX = "sealed:";
// Queue item fields that hold a secret or a CV (the same list as FIELDS in worker_seal.py).
export const SEALED_FIELDS = ["password", "key", "firecrawl", "tavily", "scrapfly", "cv_text", "token"];
const MAGIC = [0x48, 0x53, 0x31];
const SPKI_RE = /^[A-Za-z0-9+/]{300,1400}={0,2}$/;
const encoder = new TextEncoder();
const keys = new Map();

// The public key HermitShell reported, or null before it has sent one (or from an older HermitShell).
export function sealInfo(status) {
  const seal = status && typeof status === "object" ? status.seal : null;
  return seal && seal.alg === SEAL_ALG && typeof seal.spki === "string" && SPKI_RE.test(seal.spki) ? { spki: seal.spki } : null;
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function publicKey(info) {
  let got = keys.get(info.spki);
  if (!got) {
    const spki = fromBase64(info.spki);
    const key = await crypto.subtle.importKey("spki", spki, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    const kid = new Uint8Array(await crypto.subtle.digest("SHA-256", spki)).slice(0, 8);
    if (keys.size > 4) keys.clear();
    got = { key, kid };
    keys.set(info.spki, got);
  }
  return got;
}

export async function sealBytes(info, data, aad) {
  const { key, kid } = await publicKey(info);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, raw));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, aes,
    data instanceof Uint8Array ? data : new Uint8Array(data)));
  const out = new Uint8Array(3 + 8 + 2 + wrapped.length + 12 + body.length);
  out.set(MAGIC, 0);
  out.set(kid, 3);
  out.set([wrapped.length >> 8, wrapped.length & 255], 11);
  out.set(wrapped, 13);
  out.set(iv, 13 + wrapped.length);
  out.set(body, 25 + wrapped.length);
  return out;
}

export const fieldAad = (field) => `hermitshell:${field}`;

export async function sealText(info, text, field) {
  return SEAL_PREFIX + toBase64Url(await sealBytes(info, encoder.encode(String(text)), fieldAad(field)));
}

// Whether an item carries anything that must be sealed.
export function needsSeal(item) {
  return SEALED_FIELDS.some((f) => (typeof item[f] === "string" && item[f]) || (Array.isArray(item[f]) && item[f].length));
}

// The item with each secret or CV text field sealed and listed in `sealed`.
export async function sealItem(info, item) {
  const out = { ...item };
  const sealed = [];
  for (const field of SEALED_FIELDS) {
    const value = out[field];
    if (typeof value === "string" && value) out[field] = await sealText(info, value, field);
    else if (Array.isArray(value) && value.length) out[field] = await Promise.all(value.map((v) => sealText(info, v, field)));
    else continue;
    sealed.push(field);
  }
  return sealed.length ? { ...out, sealed } : out;
}

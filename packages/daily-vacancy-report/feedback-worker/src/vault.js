// Values the Worker keeps encrypted in KV: kept documents (docs.js), recruits' notes and the tags index (notes.js).
// AES-256-GCM with a key derived from JOB_FEEDBACK_SECRET, and the KV key as additional data, so a value only opens
// through this Worker and only under the key it was stored as: one copied onto another recruit's key doesn't open.

const IV_BYTES = 12;
const encoder = new TextEncoder();
const ciphers = new Map();

async function cipher(secret) {
  let key = ciphers.get(secret);
  if (!key) {
    const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
    key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: encoder.encode("hermitshell-docs"), info: encoder.encode("v1") },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    if (ciphers.size > 8) ciphers.clear();
    ciphers.set(secret, key);
  }
  return key;
}

// `bytes` encrypted for `key`: a random IV, then the ciphertext.
export async function seal(env, key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(key) },
    await cipher(env.JOB_FEEDBACK_SECRET), bytes));
  const stored = new Uint8Array(IV_BYTES + sealed.length);
  stored.set(iv);
  stored.set(sealed, IV_BYTES);
  return stored.buffer;
}

// What is stored under `key`, decrypted, or null when there is none or it doesn't open as that key's.
export async function open(env, key) {
  const stored = env.JOB_FEEDBACK_SECRET ? await env.FEEDBACK.get(key, "arrayBuffer") : null;
  if (!stored || stored.byteLength <= IV_BYTES) return null;
  const bytes = new Uint8Array(stored);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES),
      additionalData: encoder.encode(key) }, await cipher(env.JOB_FEEDBACK_SECRET), bytes.subarray(IV_BYTES)));
  } catch {
    return null;
  }
}

export async function putSealedJson(env, key, value, options) {
  await env.FEEDBACK.put(key, await seal(env, key, encoder.encode(JSON.stringify(value))), options);
}

export async function getSealedJson(env, key) {
  const bytes = await open(env, key);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

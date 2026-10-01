"""Passwords, API keys and CVs typed into the dashboard reach HermitShell sealed, so the Worker's KV (and anyone
who can read it in the Cloudflare account) only ever holds ciphertext.

HermitShell keeps an RSA-3072 key pair in state/worker_seal.json (0600, encrypted with HERMES_DATA_KEY when that is
set) and sends the public half with its status. The Worker (feedback-worker/src/seal.js) encrypts each secret with
a fresh AES-256-GCM key, wraps that key with RSA-OAEP-SHA-256 and binds the result to what it is (the field name,
or the CV's KV key) as associated data, so a sealed value can't be moved into another field. Only this server can
open it. The previous key is kept for KEEP_OLD_DAYS after `python3 worker_seal.py --rotate`, for anything sealed
before the Worker heard of the new one.

Envelope: b"HS1" | key id (8 bytes) | wrapped key length (2 bytes, big-endian) | wrapped key | IV (12) | ciphertext.
A sealed text field is "sealed:" followed by the envelope in base64url without padding.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import time

import hermes_common as hc

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:  # no key is published, so the Worker refuses secrets instead of storing them in plain text
    hashes = serialization = padding = rsa = AESGCM = None

KEYS_NAME = "worker_seal.json"
MAGIC = b"HS1"
PREFIX = "sealed:"
ALG = "RSA-OAEP-256+A256GCM"
KEY_BITS = 3072
KEEP_OLD_DAYS = 30
MAX_SEALED = 8 * 1024 * 1024
# Queue item fields the Worker may seal (SEALED_FIELDS in seal.js); each is opened with its own name as associated
# data, and only when the item lists it in "sealed".
FIELDS = ("password", "key", "firecrawl", "tavily", "scrapfly", "cv_text", "token")
_OAEP = padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None) if padding else None
MISSING = "the cryptography package is missing (python3 doctor.py --fix)"


class SealError(ValueError):
    """A sealed value that can't be opened: another key, altered, or not an envelope."""


def _path():
    return hc.STATE_DIR / KEYS_NAME


def _spki(private) -> bytes:
    return private.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


def _kid(spki: bytes) -> bytes:
    return hashlib.sha256(spki).digest()[:8]


def _load() -> list[dict]:
    try:
        keys = json.loads(hc.read_private_text(_path())).get("keys", [])
    except (OSError, ValueError, AttributeError):
        return []
    return [k for k in keys if isinstance(k, dict) and isinstance(k.get("pem"), str)]


def _save(keys: list[dict]) -> None:
    _path().parent.mkdir(parents=True, exist_ok=True)
    hc.write_private(_path(), json.dumps({"keys": keys}))


def _new() -> dict:
    private = rsa.generate_private_key(public_exponent=65537, key_size=KEY_BITS)
    pem = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption()).decode()
    return {"pem": pem, "created": int(time.time())}


def _private(entry: dict):
    return serialization.load_pem_private_key(entry["pem"].encode(), password=None)


def _keyring() -> list[dict]:
    """The key pairs, newest first, creating the first one; old ones past KEEP_OLD_DAYS are dropped."""
    keys = _load()
    if not keys:
        keys = [_new()]
        _save(keys)
    cutoff = time.time() - KEEP_OLD_DAYS * 86400
    kept = keys[:1] + [k for k in keys[1:] if k.get("retired", 0) > cutoff]
    if len(kept) != len(keys):
        _save(kept)
    return kept


_public: dict = {}


def public_key() -> dict:
    """What the Worker needs to seal for this server: {"alg", "kid", "spki"} (base64 DER). {} if it can't be made."""
    if rsa is None:
        return {}
    try:
        keys = _keyring()
        stamp = (str(_path()), _path().stat().st_mtime_ns)
        if _public.get("stamp") != stamp:
            spki = _spki(_private(keys[0]))
            _public.update(stamp=stamp, info={"alg": ALG, "kid": _kid(spki).hex(), "spki": base64.b64encode(spki).decode()})
    except (OSError, ValueError, TypeError):
        return {}
    return dict(_public["info"])


def rotate() -> str:
    if rsa is None:
        return ""
    keys = _keyring()
    keys[0]["retired"] = int(time.time())
    _save([_new(), *keys])
    return public_key().get("kid", "")


def seal(data: bytes, aad: str, spki_b64: str) -> bytes:
    """What seal.js does, for tests and tools: seal `data` for the holder of the private half of `spki_b64`."""
    spki = base64.b64decode(spki_b64)
    public = serialization.load_der_public_key(spki)
    key, iv = AESGCM.generate_key(bit_length=256), os.urandom(12)
    wrapped = public.encrypt(key, _OAEP)
    return MAGIC + _kid(spki) + len(wrapped).to_bytes(2, "big") + wrapped + iv + AESGCM(key).encrypt(iv, data, aad.encode())


def is_sealed(value) -> bool:
    if isinstance(value, str):
        return value.startswith(PREFIX)
    return isinstance(value, (bytes, bytearray)) and bytes(value[:3]) == MAGIC


def open_bytes(blob: bytes, aad: str) -> bytes:
    if not is_sealed(blob) or len(blob) > MAX_SEALED or len(blob) < 3 + 8 + 2:
        raise SealError("not a sealed value")
    if rsa is None:
        raise SealError(MISSING)
    kid, size = bytes(blob[3:11]), int.from_bytes(blob[11:13], "big")
    wrapped, rest = bytes(blob[13:13 + size]), bytes(blob[13 + size:])
    if len(wrapped) != size or len(rest) < 12 + 16:
        raise SealError("truncated sealed value")
    for entry in _keyring():
        private = _private(entry)
        if _kid(_spki(private)) != kid:
            continue
        try:
            key = private.decrypt(wrapped, _OAEP)
            return AESGCM(key).decrypt(rest[:12], rest[12:], aad.encode())
        except Exception:  # cryptography raises ValueError or InvalidTag; neither says anything useful to show
            raise SealError("sealed value could not be opened (altered, or sealed for another field)") from None
    raise SealError("sealed for a key this server doesn't have (redeploy the Worker, then enter it again)")


def open_text(value: str, aad: str) -> str:
    try:
        blob = base64.urlsafe_b64decode(value[len(PREFIX):] + "=" * (-len(value[len(PREFIX):]) % 4))
    except (ValueError, TypeError):
        raise SealError("not a sealed value") from None
    try:
        return open_bytes(blob, aad).decode("utf-8")
    except UnicodeDecodeError:
        raise SealError("sealed value is not text") from None


def field_aad(field: str) -> str:
    return f"hermitshell:{field}"


def _open_field(value, field: str):
    if isinstance(value, str) and is_sealed(value):
        return open_text(value, field_aad(field))
    if isinstance(value, list) and value and all(isinstance(v, str) and is_sealed(v) for v in value):
        return [open_text(v, field_aad(field)) for v in value]
    raise SealError(f"{field} was meant to be sealed but isn't")


def open_item(item: dict) -> dict:
    """A queue item with the fields it lists in "sealed" opened. An item from an older Worker lists none."""
    out = {k: v for k, v in item.items() if k != "sealed"}
    listed = item.get("sealed") or []
    if not isinstance(listed, list) or any(f not in FIELDS for f in listed):
        raise SealError("unknown sealed fields")
    for field in dict.fromkeys(listed):
        out[field] = _open_field(out.get(field), field)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="The key pair the Worker seals dashboard secrets and CVs with.")
    parser.add_argument("--rotate", action="store_true", help="make a new key pair (the old one is kept for 30 days)")
    args = parser.parse_args(argv)
    kid = rotate() if args.rotate else public_key().get("kid", "")
    print(f"Sealing key {kid or 'unavailable'}" + (" (new; the Worker gets it with the next status)" if args.rotate else ""))
    return 0 if kid else 1


if __name__ == "__main__":
    raise SystemExit(main())

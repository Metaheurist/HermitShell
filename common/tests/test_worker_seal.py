"""Unit tests for worker_seal.py: the key pair the Worker seals dashboard secrets and CVs with (no network).

Run from the repository root:  python -m pytest common/tests
"""

import base64
import hashlib
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hermes_common as hc  # noqa: E402
import worker_seal as ws  # noqa: E402


@pytest.fixture(autouse=True)
def state(tmp_path, monkeypatch):
    monkeypatch.setattr(hc, "STATE_DIR", tmp_path)
    monkeypatch.setattr(ws, "KEY_BITS", 2048)
    ws._public.clear()
    return tmp_path


def sealed_text(text, field):
    spki = ws.public_key()["spki"]
    return ws.PREFIX + base64.urlsafe_b64encode(ws.seal(text.encode(), ws.field_aad(field), spki)).decode().rstrip("=")


def test_makes_one_key_pair_and_publishes_only_its_public_half(state):
    info = ws.public_key()
    assert info["alg"] == "RSA-OAEP-256+A256GCM"
    spki = base64.b64decode(info["spki"])
    assert info["kid"] == hashlib.sha256(spki).hexdigest()[:16]
    assert ws.public_key() == info
    assert set(info) == {"alg", "kid", "spki"}
    assert len(ws._load()) == 1
    if sys.platform != "win32":
        assert (state / ws.KEYS_NAME).stat().st_mode & 0o777 == 0o600


def test_opens_what_was_sealed_for_it_and_only_for_that_field():
    blob = ws.seal(b"%PDF-1.4 cv", "cvfile:one", ws.public_key()["spki"])
    assert ws.is_sealed(blob) and b"%PDF" not in blob
    assert ws.open_bytes(blob, "cvfile:one") == b"%PDF-1.4 cv"
    with pytest.raises(ws.SealError, match="altered, or sealed for another field"):
        ws.open_bytes(blob, "cvfile:two")
    value = sealed_text("abcd efgh ijkl mnop", "password")
    assert ws.open_text(value, ws.field_aad("password")) == "abcd efgh ijkl mnop"
    with pytest.raises(ws.SealError):
        ws.open_text(value, ws.field_aad("key"))


def test_refuses_altered_truncated_or_foreign_envelopes():
    blob = bytearray(ws.seal(b"secret", "x", ws.public_key()["spki"]))
    blob[-1] ^= 1
    with pytest.raises(ws.SealError):
        ws.open_bytes(bytes(blob), "x")
    for bad in (b"", b"HS1", b"HS1" + bytes(10), b"PK\x03\x04" + bytes(40)):
        with pytest.raises(ws.SealError):
            ws.open_bytes(bad, "x")
    foreign = bytearray(ws.seal(b"secret", "x", ws.public_key()["spki"]))
    foreign[3:11] = bytes(8)
    with pytest.raises(ws.SealError, match="key this server doesn't have"):
        ws.open_bytes(bytes(foreign), "x")
    with pytest.raises(ws.SealError):
        ws.open_text("sealed:!!!", "x")


def test_rotation_keeps_the_old_key_for_a_while(monkeypatch):
    old_kid = ws.public_key()["kid"]
    before = sealed_text("tvly-old-key-000001", "tavily")
    new_kid = ws.rotate()
    assert new_kid and new_kid != old_kid and ws.public_key()["kid"] == new_kid
    assert ws.open_text(before, ws.field_aad("tavily")) == "tvly-old-key-000001"
    later = time.time() + (ws.KEEP_OLD_DAYS + 1) * 86400
    monkeypatch.setattr(ws.time, "time", lambda: later)
    with pytest.raises(ws.SealError, match="key this server doesn't have"):
        ws.open_text(before, ws.field_aad("tavily"))
    assert ws.public_key()["kid"] == new_kid


def test_opens_the_fields_an_item_lists_and_nothing_else():
    item = {"type": "admin", "action": "api_keys", "sealed": ["firecrawl", "tavily"],
            "firecrawl": [sealed_text("fc-one11111", "firecrawl"), sealed_text("fc-two22222", "firecrawl")],
            "tavily": sealed_text("tvly-cccc3333", "tavily"), "clear": ["scrapfly"]}
    assert ws.open_item(item) == {"type": "admin", "action": "api_keys", "firecrawl": ["fc-one11111", "fc-two22222"],
                                  "tavily": "tvly-cccc3333", "clear": ["scrapfly"]}
    assert ws.open_item({"action": "pause", "u": "sam-lee"}) == {"action": "pause", "u": "sam-lee"}


def test_an_item_from_an_older_worker_is_passed_on_as_it_is():
    assert ws.open_item({"action": "email", "password": "abcd efgh ijkl mnop"})["password"] == "abcd efgh ijkl mnop"


@pytest.mark.parametrize("item", [
    {"sealed": ["password"], "password": "plain text"},
    {"sealed": ["password"]},
    {"sealed": ["firecrawl"], "firecrawl": ["fc-plain"]},
    {"sealed": ["firecrawl"], "firecrawl": []},
    {"sealed": ["name"], "name": "Sam Lee"},
    {"sealed": "password", "password": "x"},
])
def test_refuses_a_listed_field_that_isnt_sealed_or_isnt_a_secret(item):
    with pytest.raises(ws.SealError):
        ws.open_item(item)


def test_a_value_sealed_as_one_field_cant_be_listed_as_another():
    item = {"sealed": ["password"], "password": sealed_text("tvly-cccc3333", "tavily")}
    with pytest.raises(ws.SealError):
        ws.open_item(item)


def test_fields_match_the_worker():
    source = (Path(__file__).resolve().parents[2] / "packages" / "daily-vacancy-report" / "feedback-worker" / "src"
              / "seal.js").read_text(encoding="utf-8")
    assert 'export const SEALED_FIELDS = ["' + '", "'.join(ws.FIELDS) + '"];' in source
    assert f'export const SEAL_ALG = "{ws.ALG}";' in source


def test_without_cryptography_no_key_is_published_and_sealed_values_are_refused(monkeypatch):
    blob = ws.seal(b"secret", "x", ws.public_key()["spki"])
    monkeypatch.setattr(ws, "rsa", None)
    assert ws.public_key() == {} and ws.rotate() == ""
    with pytest.raises(ws.SealError, match="cryptography package is missing"):
        ws.open_bytes(blob, "x")
    assert ws.open_item({"action": "pause", "u": "sam-lee"}) == {"action": "pause", "u": "sam-lee"}


def test_command_line_rotates(capsys):
    kid = ws.public_key()["kid"]
    assert ws.main(["--rotate"]) == 0
    assert "(new;" in capsys.readouterr().out and ws.public_key()["kid"] != kid

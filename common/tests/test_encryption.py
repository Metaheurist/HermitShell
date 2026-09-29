"""Unit tests for encryption at rest in hermes_common (HERMES_DATA_KEY, seal/unseal, private files).

Run from the repository root:  python -m pytest common/tests
"""

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hermes_common as hc  # noqa: E402

pytest.importorskip("cryptography")


@pytest.fixture
def key(monkeypatch):
    value = hc.new_data_key()
    monkeypatch.setenv(hc.DATA_KEY_ENV, value)
    return value


def test_seal_round_trip_hides_the_plaintext(key):
    sealed = hc.seal(b"Sam Lee, sam@example.com")
    assert sealed.startswith(hc.SEALED) and b"sam@example.com" not in sealed
    assert hc.unseal(sealed) == b"Sam Lee, sam@example.com"
    assert hc.seal(sealed) == sealed, "already encrypted data is not wrapped twice"
    assert hc.seal(b"same") != hc.seal(b"same"), "every write gets a fresh nonce"


def test_without_a_key_files_stay_plain_and_plain_files_still_open(monkeypatch):
    monkeypatch.delenv(hc.DATA_KEY_ENV, raising=False)
    assert hc.seal(b"plain") == b"plain"
    assert hc.unseal(b"plain") == b"plain"


def test_a_wrong_missing_or_malformed_key_is_a_clear_error(key, monkeypatch):
    sealed = hc.seal(b"secret")
    monkeypatch.setenv(hc.DATA_KEY_ENV, hc.new_data_key())
    with pytest.raises(hc.DataKeyError, match="wrong key"):
        hc.unseal(sealed)
    monkeypatch.delenv(hc.DATA_KEY_ENV)
    with pytest.raises(hc.DataKeyError, match="not set"):
        hc.unseal(sealed)
    monkeypatch.setenv(hc.DATA_KEY_ENV, "too-short")
    with pytest.raises(hc.DataKeyError, match="32 random bytes"):
        hc.seal(b"x")


def test_tampering_is_detected(key):
    sealed = bytearray(hc.seal(b"profile"))
    sealed[-1] ^= 1
    with pytest.raises(hc.DataKeyError):
        hc.unseal(bytes(sealed))


def test_private_files_are_encrypted_and_owner_only(key, tmp_path):
    path = tmp_path / "cv.txt"
    hc.write_private(path, "Sam Lee\nData analyst")
    assert hc.is_sealed(path) and b"Data analyst" not in path.read_bytes()
    assert hc.read_private_text(path) == "Sam Lee\nData analyst"
    if os.name == "posix":
        assert path.stat().st_mode & 0o777 == 0o600


def test_rewrite_keeps_a_plain_file_plain_and_a_sealed_one_sealed(key, tmp_path):
    plain, sealed = tmp_path / "job_profile.md", tmp_path / "sealed.md"
    plain.write_text("owner edits this by hand", encoding="utf-8")
    hc.write_private(sealed, "extra profile")
    hc.rewrite_text(plain, "owner edits this by hand\n- SQL")
    hc.rewrite_text(sealed, "extra profile\n- SQL")
    assert plain.read_text(encoding="utf-8").endswith("- SQL") and not hc.is_sealed(plain)
    assert hc.is_sealed(sealed) and hc.read_private_text(sealed).endswith("- SQL")

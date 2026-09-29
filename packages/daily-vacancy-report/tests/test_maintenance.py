"""Unit tests for maintenance.py and Tracker.prune: retention, encryption of older files, backups and restores."""

import os
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import maintenance  # noqa: E402
import profiles  # noqa: E402
from job_tracker import Tracker  # noqa: E402

hc = maintenance.hc
DAY = 86400


@pytest.fixture
def tree(tmp_path, monkeypatch):
    home, scripts = tmp_path / "home", tmp_path / "scripts"
    state = scripts / "state"
    for d in (home / "logs", home / "cron" / "output", state / "cover_letters", state / "profiles"):
        d.mkdir(parents=True)
    (home / ".env").write_text("OLLAMA_MODEL=qwen3:8b\n", encoding="utf-8")
    (home / "cron" / "jobs.json").write_text('{"jobs": []}', encoding="utf-8")
    (home / "notes.md").write_text("not ours\n", encoding="utf-8")
    (scripts / "job_scanner.py").write_text("print('scan')\n", encoding="utf-8")
    monkeypatch.setattr(hc, "APP_HOME", home)
    monkeypatch.setattr(maintenance, "SCRIPT_DIR", scripts)
    monkeypatch.setattr(maintenance, "STATE_DIR", state)
    monkeypatch.setattr(profiles, "STATE_DIR", state)
    monkeypatch.setattr(profiles, "PROFILES_DIR", state / "profiles")
    monkeypatch.setattr(maintenance.os, "environ", dict(maintenance.os.environ))
    for key in (hc.DATA_KEY_ENV, "HERMES_BACKUP_DIR", "HERMES_RETENTION_DAYS", "HERMES_LOG_RETENTION_DAYS"):
        monkeypatch.delenv(key, raising=False)
    return home, scripts, state


def aged(path: Path, days: float, text: str = "x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))
    stamp = time.time() - days * DAY
    os.utime(path, (stamp, stamp))
    return path


# --------------------------------------------------------------------------- tracker retention

def test_prune_drops_stale_jobs_but_keeps_live_ones_and_the_skills_pool(tmp_path):
    now = time.time()
    with Tracker(tmp_path / "tracker.db") as t:
        t.upsert_job("old", {"title": "Analyst", "company": "Northwind"}, True, now=now - 400 * DAY)
        t.add_event("e-old", "old", "not_for_me", at=now - 400 * DAY)
        t.add_event("e-skill", "old", "add_skill", at=now - 400 * DAY, skills=["dbt"])
        t.upsert_job("applied", {"title": "BI Developer", "company": "Contoso"}, True, now=now - 400 * DAY)
        t.add_event("e-app", "applied", "applied", at=now - 10 * DAY)
        t.upsert_job("new", {"title": "Data Engineer", "company": "Fabrikam"}, True, now=now - DAY)
        t.add_event("e-orphan", "gone", "interested", at=now - 500 * DAY)
        t.record_run(10, 2, {}, [], now=now - 400 * DAY)
        t.record_run(10, 2, {}, [], now=now - DAY)
        assert t.prune(now - 365 * DAY) == {"jobs": 1, "events": 3, "runs": 1}
        assert t.job("old") is None and t.job("applied") and t.job("new")
        assert t.skills() == ["dbt"]
        assert t.prune(now - 365 * DAY) == {"jobs": 0, "events": 0, "runs": 0}


# --------------------------------------------------------------------------- nightly steps

def test_retention_removes_old_letters_logs_and_tracker_rows(tree, monkeypatch):
    home, _, state = tree
    old_letter = aged(state / "cover_letters" / "old.pdf", 400)
    new_letter = aged(state / "cover_letters" / "new.pdf", 5)
    old_log, new_log = aged(home / "logs" / "agent.log", 100), aged(home / "cron" / "output" / "run.md", 3)
    extra = aged(state / "profiles" / "sam-lee-1" / "state" / "tailored_cvs" / "cv.pdf", 400)
    with Tracker(state / "job_tracker.db") as t:
        t.upsert_job("old", {"title": "Analyst"}, True, now=time.time() - 400 * DAY)
    summary = maintenance.retention(time.time())
    assert summary.startswith("retention: 1 jobs, 0 answers, 0 runs, 2 letters/CVs older than 365 days; 1 log")
    assert not old_letter.exists() and not extra.exists() and not old_log.exists()
    assert new_letter.exists() and new_log.exists()

    monkeypatch.setenv("HERMES_RETENTION_DAYS", "0")
    monkeypatch.setenv("HERMES_LOG_RETENTION_DAYS", "0")
    kept = aged(state / "cover_letters" / "ancient.pdf", 4000)
    assert "unlimited" in maintenance.retention(time.time()) and kept.exists()


def test_older_plain_files_are_encrypted_once_a_key_is_set(tree, monkeypatch):
    pytest.importorskip("cryptography")
    _, scripts, state = tree
    profile = aged(state / "profiles" / "sam-lee-1" / "cv.txt", 1, "Sam Lee\nAnalyst")
    letter = aged(state / "cover_letters" / "letter.pdf", 1, "%PDF letter")
    owner_notes = aged(scripts / "job_profile.md", 1, "owner edits this")
    assert maintenance.seal_existing() == 0, "nothing happens without a key"
    monkeypatch.setenv(hc.DATA_KEY_ENV, hc.new_data_key())
    assert maintenance.seal_existing() == 2
    assert hc.is_sealed(profile) and hc.is_sealed(letter) and not hc.is_sealed(owner_notes)
    assert hc.read_private_text(profile) == "Sam Lee\nAnalyst"
    assert maintenance.seal_existing() == 0


@pytest.mark.skipif(os.name != "posix", reason="file modes are POSIX only")
def test_tighten_makes_state_owner_only(tree):
    _, _, state = tree
    path = aged(state / "cover_letters" / "a.pdf", 1)
    os.chmod(path, 0o644)
    assert maintenance.tighten(state) >= 1
    assert path.stat().st_mode & 0o777 == 0o600 and state.stat().st_mode & 0o777 == 0o700


# --------------------------------------------------------------------------- backups

def test_encrypted_backup_restores_everything(tree, monkeypatch, tmp_path):
    pytest.importorskip("cryptography")
    home, _, state = tree
    monkeypatch.setenv(hc.DATA_KEY_ENV, hc.new_data_key())
    with Tracker(state / "job_tracker.db") as t:
        t.upsert_job("k1", {"title": "Analyst", "company": "Northwind"}, True)
    aged(state / "cover_letters" / "tmp.lock", 0)
    summary = maintenance.make_backup(datetime(2026, 5, 1, 3, 30))
    assert summary.startswith("backup: hermitshell-20260501-033000.tar.gz.enc (") and "encrypted" in summary
    archive = home / "backups" / "nightly" / "hermitshell-20260501-033000.tar.gz.enc"
    assert hc.is_sealed(archive) and b"Northwind" not in archive.read_bytes()

    out = tmp_path / "restored"
    assert maintenance.restore(archive, out) > 0
    assert (out / ".env").read_text(encoding="utf-8") == "OLLAMA_MODEL=qwen3:8b\n"
    assert (out / "cron" / "jobs.json").is_file() and not (out / "notes.md").exists()
    assert (out / "scripts" / "job_scanner.py").is_file()
    assert not (out / "scripts" / "state" / "cover_letters" / "tmp.lock").exists()
    with sqlite3.connect(str(out / "scripts" / "state" / "job_tracker.db")) as db:
        assert db.execute("SELECT company FROM jobs").fetchone() == ("Northwind",)
    with pytest.raises(SystemExit, match="not empty"):
        maintenance.restore(archive, out)
    monkeypatch.setenv(hc.DATA_KEY_ENV, hc.new_data_key())
    with pytest.raises(hc.DataKeyError):
        maintenance.restore(archive, tmp_path / "wrong-key")


def test_backups_rotate_to_daily_and_weekly(tmp_path):
    start = datetime(2026, 1, 1, 3, 30)
    for day in range(60):
        prefix = "hermes-" if day < 30 else "hermitshell-"
        (tmp_path / f"{prefix}{start + timedelta(days=day):%Y%m%d-%H%M%S}.tar.gz.enc").write_bytes(b"x")
    (tmp_path / "notes.txt").write_text("kept", encoding="utf-8")
    assert maintenance.rotate(tmp_path, keep_daily=5, keep_weekly=3) == 52
    names = [maintenance.stamp_of(p).strftime("%Y%m%d") for p in maintenance.list_backups(tmp_path)]
    assert names[:5] == ["20260301", "20260228", "20260227", "20260226", "20260225"]
    assert len(names) == 8 and (tmp_path / "notes.txt").exists()
    weeks = [datetime.strptime(n, "%Y%m%d").isocalendar()[:2] for n in names[5:]]
    assert len(set(weeks)) == 3


def test_nightly_run_and_decrypt_command(tree, monkeypatch, tmp_path, capsys):
    pytest.importorskip("cryptography")
    home, _, state = tree
    monkeypatch.setenv(hc.DATA_KEY_ENV, hc.new_data_key())
    cv = aged(state / "profiles" / "sam-lee-1" / "cv.txt", 1, "Sam Lee")
    assert maintenance.main([]) == 0
    assert hc.is_sealed(cv) and len(maintenance.list_backups()) == 1
    assert maintenance.main(["--decrypt", str(cv), "--out", str(tmp_path / "cv.txt")]) == 0
    assert (tmp_path / "cv.txt").read_text(encoding="utf-8") == "Sam Lee"
    assert maintenance.main(["--new-key"]) == 0
    assert len(capsys.readouterr().out.strip()) == 43

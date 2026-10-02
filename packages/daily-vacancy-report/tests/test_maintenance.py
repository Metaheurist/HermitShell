"""Unit tests for maintenance.py and Tracker.prune: retention, encryption of older files, backups and restores."""

import contextlib
import io
import json
import os
import sqlite3
import sys
import tarfile
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
    os.chmod(path, 0o700)
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


def test_backup_outcome_is_noted_for_the_dashboard(tree):
    home, _, state = tree
    maintenance.make_backup(datetime(2026, 5, 1, 3, 30))
    info = maintenance.backup_info()
    assert info["error"] == "" and info["kept"] == 1 and info["size"] > 0 and info["encrypted"] is False
    assert abs(info["at"] - time.time()) < 60
    assert json.loads((state / "backup.json").read_text(encoding="utf-8")) == info


def test_failed_backup_keeps_the_last_good_one_beside_the_error(tree, monkeypatch):
    maintenance.make_backup(datetime(2026, 5, 1, 3, 30))
    good = maintenance.backup_info()

    def broken():
        raise PermissionError("[Errno 13] Permission denied: '/backups'")

    monkeypatch.setattr(maintenance, "build_archive", broken)
    with pytest.raises(PermissionError):
        maintenance.make_backup(datetime(2026, 5, 2, 3, 30))
    info = maintenance.backup_info()
    assert info["error"].startswith("PermissionError: [Errno 13]") and info["failed_at"] >= good["at"]
    assert (info["at"], info["size"], info["kept"]) == (good["at"], good["size"], good["kept"])
    assert maintenance.main([]) == 1, "the nightly run reports the failed step"


def test_backup_info_ignores_a_damaged_file(tree):
    _, _, state = tree
    (state / "backup.json").write_text("[1, 2]", encoding="utf-8")
    assert maintenance.backup_info() == {}
    (state / "backup.json").write_text("{not json", encoding="utf-8")
    assert maintenance.backup_info() == {}


def test_backup_now_makes_one_and_is_refused_within_ten_minutes(tree, monkeypatch):
    assert maintenance.backup_refusal(time.time()) == ""
    assert maintenance.main(["--backup-now"]) == 0
    assert len(maintenance.list_backups()) == 1
    assert "10 minutes" in maintenance.backup_refusal(time.time())
    assert maintenance.backup_refusal(time.time() + maintenance.BACKUP_NOW_GAP + 1) == ""
    assert maintenance.main(["--backup-now"]) == 0
    assert len(maintenance.list_backups()) == 1, "the second press made no backup"


def test_backup_now_waits_for_the_nightly_run(tree, monkeypatch):
    @contextlib.contextmanager
    def held(_path):
        yield False

    monkeypatch.setattr(hc, "run_lock", held)
    assert maintenance.main(["--backup-now"]) == 0
    assert maintenance.list_backups() == [] and maintenance.backup_info() == {}


def test_backup_now_failure_is_noted(tree, monkeypatch):
    monkeypatch.setattr(maintenance, "build_archive", lambda: (_ for _ in ()).throw(OSError("disk full")))
    assert maintenance.main(["--backup-now"]) == 1
    assert maintenance.backup_info()["error"] == "OSError: disk full"


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


# --------------------------------------------------------------------------- off-server copies

class Answer:
    def __init__(self, content: bytes = b"{}"):
        self.content = content


class FakeWorker:
    """The feedback Worker's backup routes (feedback-worker/src/backups.js), in memory: a backup is listed once every
    part has arrived."""

    def __init__(self):
        self.files: dict[str, dict] = {}
        self.calls: list[tuple] = []

    def keep(self, name: str, data: bytes = hc.SEALED + b"x") -> None:
        self.files[name] = {"n": 1, "sha": maintenance.hashlib.sha256(data).hexdigest(), "parts": {0: data}}

    def request(self, method, path, *, params=None, json_body=None, data=None, content_type="", **_):
        self.calls.append((method, path, dict(params or {}), json_body, len(data or b""), content_type))
        if (method, path) == ("POST", "/api/backup/part"):
            f = self.files.setdefault(params["name"], {"n": params["n"], "sha": params["sha"], "parts": {}})
            f["parts"][params["i"]] = data
            return Answer()
        if (method, path) == ("GET", "/api/backup/part"):
            return Answer(self.files[params["name"]]["parts"][params["i"]])
        if (method, path) == ("POST", "/api/backup/delete"):
            self.files.pop(json_body["name"], None)
            return Answer()
        raise AssertionError(f"unexpected {method} {path}")

    def json(self, method, path, **_):
        assert (method, path) == ("GET", "/api/backups")
        done = {n: f for n, f in self.files.items() if len(f["parts"]) == f["n"]}
        return {"backups": [{"name": n, "parts": f["n"], "sha": f["sha"], "size": sum(map(len, f["parts"].values())), "at": 1}
                            for n, f in sorted(done.items(), reverse=True)]}

    def sent(self) -> list[tuple]:
        return [c for c in self.calls if c[:2] == ("POST", "/api/backup/part")]


def blob(size: int) -> bytes:
    return hc.SEALED + os.urandom(size - len(hc.SEALED))


@pytest.fixture
def worker(tree, monkeypatch):
    """A set-up feedback Worker that has backups (protocol 7), and a data key."""
    pytest.importorskip("cryptography")
    fake = FakeWorker()
    monkeypatch.setattr(maintenance.worker_link, "from_env", lambda timeout=30: fake)
    monkeypatch.setattr(maintenance.worker_link, "worker_protocol", lambda: {"protocol": maintenance.worker_link.BACKUP_PROTOCOL})
    monkeypatch.setenv(hc.DATA_KEY_ENV, hc.new_data_key())
    for key in ("HERMES_BACKUP_OFFSITE", "HERMES_BACKUP_OFFSITE_KEEP_DAILY", "HERMES_BACKUP_OFFSITE_KEEP_WEEKLY"):
        monkeypatch.delenv(key, raising=False)
    return fake


NAME = "hermitshell-20261001-031500.tar.gz.enc"


def test_a_backup_goes_up_in_whole_parts_with_the_files_sha256(worker):
    data = blob(2 * maintenance.OFFSITE_PART + 1234)
    assert maintenance.send_offsite(NAME, data) == (3, 1, 0)
    sha = maintenance.hashlib.sha256(data).hexdigest()
    assert [(c[2], c[4], c[5]) for c in worker.sent()] == [
        ({"name": NAME, "i": i, "n": 3, "sha": sha}, size, "application/octet-stream")
        for i, size in enumerate((maintenance.OFFSITE_PART, maintenance.OFFSITE_PART, 1234))]
    assert b"".join(worker.files[NAME]["parts"][i] for i in range(3)) == data


def test_the_copies_on_the_worker_rotate_to_seven_daily_and_four_weekly(worker, monkeypatch):
    start = datetime(2026, 7, 1, 3, 15)
    names = [f"hermitshell-{start + timedelta(days=d):%Y%m%d-%H%M%S}.tar.gz.enc" for d in range(60)]
    for name in names:
        worker.keep(name)
    newest = f"hermitshell-{start + timedelta(days=60):%Y%m%d-%H%M%S}.tar.gz.enc"
    parts, kept, removed = maintenance.send_offsite(newest, blob(100))
    assert (parts, kept, removed) == (1, 11, 50)
    assert set(worker.files) == maintenance.keeping(names + [newest], 7, 4)
    assert newest in worker.files and names[0] not in worker.files
    monkeypatch.setenv("HERMES_BACKUP_OFFSITE_KEEP_DAILY", "2")
    monkeypatch.setenv("HERMES_BACKUP_OFFSITE_KEEP_WEEKLY", "0")
    maintenance.send_offsite(f"hermitshell-{start + timedelta(days=61):%Y%m%d-%H%M%S}.tar.gz.enc", blob(100))
    assert len(worker.files) == 2


def test_rotation_keeps_the_same_backups_as_before(tmp_path):
    start = datetime(2026, 1, 1, 3, 30)
    names = [f"hermitshell-{start + timedelta(days=d):%Y%m%d-%H%M%S}.tar.gz.enc" for d in range(40)]
    kept = maintenance.keeping(names + ["notes.txt"], 5, 3)
    assert len(kept) == 8 and "notes.txt" not in kept and names[-1] in kept


def test_only_encrypted_backups_of_a_size_the_worker_takes_are_sent(worker, monkeypatch):
    for name, data in ((NAME, b"\x1f\x8b plain gzip"), ("hermitshell-20261001-031500.tar.gz", blob(100)),
                       ("../hub.tar.gz.enc", blob(100))):
        with pytest.raises(ValueError, match="only encrypted"):
            maintenance.send_offsite(name, data)
    monkeypatch.setattr(maintenance, "OFFSITE_MAX_PARTS", 2)
    with pytest.raises(ValueError, match="too large"):
        maintenance.send_offsite(NAME, blob(2 * maintenance.OFFSITE_PART + 1))
    assert worker.calls == []


def test_a_backup_the_worker_did_not_keep_is_a_failure(worker, monkeypatch):
    monkeypatch.setattr(worker, "json", lambda *a, **k: {"backups": []})
    with pytest.raises(maintenance.worker_link.WorkerError, match="did not keep"):
        maintenance.send_offsite(NAME, blob(100))


def test_the_list_from_the_worker_is_checked(worker, monkeypatch):
    good = {"name": NAME, "parts": 1, "sha": "a" * 64, "size": 10, "at": 1}
    junk = [None, "x", {**good, "name": "../etc/passwd"}, {**good, "parts": 0}, {**good, "parts": 65},
            {**good, "size": -1}, {**good, "sha": "nothex"}, {**good, "parts": True}, {**good, "size": "10"}]
    monkeypatch.setattr(worker, "json", lambda *a, **k: {"backups": junk + [good]})
    assert maintenance.offsite_list() == [good]
    monkeypatch.setattr(worker, "json", lambda *a, **k: {"backups": "nope"})
    assert maintenance.offsite_list() == []


def test_why_backups_stay_on_the_server(worker, monkeypatch):
    assert maintenance.offsite_why() == ""
    monkeypatch.setattr(maintenance.worker_link, "worker_protocol", lambda: {})
    assert maintenance.offsite_why() == "", "a Worker that hasn't answered yet is tried"
    monkeypatch.setattr(maintenance.worker_link, "worker_protocol", lambda: {"protocol": 6})
    assert maintenance.offsite_why() == "worker"
    monkeypatch.setattr(maintenance.worker_link, "from_env", lambda timeout=30: None)
    assert maintenance.offsite_why() == "noworker"
    monkeypatch.delenv(hc.DATA_KEY_ENV)
    assert maintenance.offsite_why() == "unencrypted"
    for value in ("off", "OFF", "0", "no", "false"):
        monkeypatch.setenv("HERMES_BACKUP_OFFSITE", value)
        assert maintenance.offsite_why() == "off"


def test_each_backup_is_also_sent_to_the_worker_as_saved_here(worker):
    summary = maintenance.make_backup(datetime(2026, 10, 1, 3, 15))
    assert "off-server copy: sent to the feedback Worker in 1 part, 1 kept there, 0 old removed" in summary
    local = maintenance.list_backups()[0]
    assert local.name == NAME and worker.files[NAME]["parts"][0] == local.read_bytes()
    info = maintenance.backup_info()
    assert info["error"] == "" and info["offsite"]["on"] is True and info["offsite"]["kept"] == 1
    assert info["offsite"]["error"] == "" and abs(info["offsite"]["at"] - time.time()) < 60


def test_a_failed_copy_keeps_the_local_backup_and_the_last_good_copys_numbers(worker, monkeypatch):
    maintenance.make_backup(datetime(2026, 10, 1, 3, 15))
    good = maintenance.backup_info()["offsite"]

    def refused(*_a, **_k):
        raise maintenance.worker_link.WorkerError("feedback Worker answered HTTP 507")

    monkeypatch.setattr(worker, "request", refused)
    summary = maintenance.make_backup(datetime(2026, 10, 2, 3, 15))
    assert "off-server copy failed: feedback Worker answered HTTP 507" in summary
    assert len(maintenance.list_backups()) == 2
    info = maintenance.backup_info()
    assert info["error"] == "" and info["offsite"]["error"] == "feedback Worker answered HTTP 507"
    assert (info["offsite"]["at"], info["offsite"]["kept"]) == (good["at"], good["kept"])
    assert info["offsite"]["failed_at"] >= good["at"]
    assert maintenance.main(["--backup-now"]) == 0, "the backup itself worked"


def test_a_failure_never_records_the_address_or_token(worker, monkeypatch):
    def unreachable(*_a, **_k):
        raise maintenance.worker_link.requests.ConnectionError("https://fb.example.workers.dev/api?token=hunter2")

    monkeypatch.setattr(worker, "request", unreachable)
    maintenance.make_backup(datetime(2026, 10, 1, 3, 15))
    noted = (maintenance.STATE_DIR / maintenance.BACKUP_FILE).read_text(encoding="utf-8")
    assert "example.workers.dev" not in noted and "hunter2" not in noted
    assert maintenance.backup_info()["offsite"]["error"] == "ConnectionError"


def test_an_unencrypted_backup_never_leaves_the_server(worker, monkeypatch):
    monkeypatch.delenv(hc.DATA_KEY_ENV)
    summary = maintenance.make_backup(datetime(2026, 10, 1, 3, 15))
    assert "off-server copy: not sent (HERMES_DATA_KEY is not set)" in summary
    assert worker.calls == [] and maintenance.backup_info()["offsite"] == {"on": False, "why": "unencrypted"}
    monkeypatch.setenv(hc.DATA_KEY_ENV, hc.new_data_key())
    monkeypatch.setenv("HERMES_BACKUP_OFFSITE", "off")
    maintenance.make_backup(datetime(2026, 10, 2, 3, 15))
    assert worker.calls == [] and maintenance.backup_info()["offsite"] == {"on": False, "why": "off"}


def test_a_copy_comes_back_checked_and_restores(worker, tmp_path, capsys):
    maintenance.make_backup(datetime(2026, 10, 1, 3, 15))
    original = maintenance.list_backups()[0].read_bytes()
    out = tmp_path / "fetched" / NAME
    assert maintenance.main(["--fetch", NAME, "--out", str(out)]) == 0
    assert out.read_bytes() == original and f"Saved {out}" in capsys.readouterr().out
    if os.name == "posix":
        assert out.stat().st_mode & 0o777 == 0o600
    assert maintenance.restore(out, tmp_path / "restored") > 0
    assert maintenance.main(["--list-offsite"]) == 0
    assert NAME in capsys.readouterr().out
    worker.files[NAME]["parts"][0] = original[:-1] + bytes([original[-1] ^ 1])
    with pytest.raises(SystemExit, match="damaged"):
        maintenance.fetch_offsite(NAME, tmp_path / "bad")
    assert not (tmp_path / "bad").exists()
    with pytest.raises(SystemExit, match="not kept"):
        maintenance.fetch_offsite("hermitshell-20200101-000000.tar.gz.enc")


def test_the_commands_say_when_the_worker_cant_be_reached(worker, monkeypatch):
    def down(*_a, **_k):
        raise maintenance.worker_link.WorkerError("feedback Worker unreachable (ConnectTimeout)")

    monkeypatch.setattr(worker, "json", down)
    with pytest.raises(SystemExit, match="unreachable"):
        maintenance.main(["--list-offsite"])
    monkeypatch.setattr(maintenance.worker_link, "from_env", lambda timeout=30: None)
    with pytest.raises(SystemExit, match="no feedback Worker is set up"):
        maintenance.main(["--fetch", NAME])


# --------------------------------------------------------------------------- removing deleted people from the backups

SAM = {"id": "sam-lee-1", "name": "Sam Lee", "email": "sam@example.com"}


def tar_of(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, text in files.items():
            raw = text.encode("utf-8")
            info = tarfile.TarInfo(name)
            info.size = len(raw)
            tar.addfile(info, io.BytesIO(raw))
    return buf.getvalue()


def files_of(data: bytes) -> dict[str, str]:
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        return {m.name: tar.extractfile(m).read().decode("utf-8") for m in tar.getmembers() if m.isfile()}


def with_sam(state: Path) -> None:
    aged(state / "profiles" / SAM["id"] / "cv.txt", 1, "Sam Lee, data analyst")
    aged(state / "profiles" / "riley-chen-2" / "cv.txt", 1, "Riley Chen")
    aged(state / "profiles.log", 1, "Profile sam-lee-1 retired\nSent to SAM@example.com for Sam  Lee\nRiley Chen ran\n")


def test_an_archive_loses_their_folders_and_their_name_in_its_logs(tmp_path):
    data = tar_of({"scripts/state/profiles/sam-lee-1/cv.txt": "Sam Lee", "state/profiles/sam-lee-1/profile.json": "{}",
                   "scripts/state/profiles/sam-lee-10/cv.txt": "Sam Leeson", "scripts/state/profiles.log": "Sam Lee left\nother\n",
                   "scripts/state/forget_backups.json": "[]", "scripts/state/notes.txt": "Sam Lee stays in non-log files"})
    rx = profiles.scrub_pattern([SAM["email"], SAM["name"], SAM["id"]])
    files = files_of(maintenance.forget_in_archive(data, {SAM["id"]}, rx))
    assert sorted(files) == ["scripts/state/notes.txt", "scripts/state/profiles.log", "scripts/state/profiles/sam-lee-10/cv.txt"]
    assert files["scripts/state/profiles.log"] == "[deleted] left\nother\n"
    assert maintenance.forget_in_archive(tar_of({"scripts/state/other.log": "Riley Chen"}), {SAM["id"]}, rx) is None


def test_the_list_of_people_to_remove_is_sealed_and_never_backed_up(tree, monkeypatch):
    pytest.importorskip("cryptography")
    _, _, state = tree
    monkeypatch.setenv(hc.DATA_KEY_ENV, hc.new_data_key())
    maintenance.queue_forget(SAM)
    path = state / maintenance.FORGET_FILE
    assert hc.is_sealed(path) and b"sam@example.com" not in path.read_bytes()
    assert maintenance._forgets()[0]["terms"] == ["sam@example.com", "Sam Lee", "sam-lee-1"]
    assert maintenance._skipped(path)
    hc.write_private(path, json.dumps([{"u": "../x", "terms": []}, "junk", {"u": "riley-chen-2"}]))
    assert [f["u"] for f in maintenance._forgets()] == ["riley-chen-2"]


def test_nobody_waiting_leaves_the_backups_alone(tree):
    assert maintenance.forget_backups() == "forget: nobody to remove from the backups"


def test_a_deleted_recruit_leaves_every_backup_here_and_on_the_worker(worker):
    state = maintenance.STATE_DIR
    with_sam(state)
    maintenance.make_backup(datetime(2026, 10, 1, 3, 15))
    first = maintenance.list_backups()[0]
    first.unlink()
    maintenance.make_backup(datetime(2026, 10, 2, 3, 15))
    before = {n: f["sha"] for n, f in worker.files.items()}
    assert len(before) == 2
    maintenance.queue_forget(SAM)
    summary = maintenance.forget_backups()
    assert summary == "forget: 1 deleted person removed from 1 backup(s) here and 2 on the feedback Worker"
    for data in [maintenance.list_backups()[0].read_bytes()] + [f["parts"][0] for f in worker.files.values()]:
        assert data.startswith(hc.SEALED)
        files = files_of(hc.unseal(data))
        assert not [n for n in files if "sam-lee-1" in n] and any("riley-chen-2" in n for n in files)
        log = next(v for n, v in files.items() if n.endswith("profiles.log"))
        assert "sam" not in log.lower() and "Riley Chen ran" in log
    assert all(worker.files[n]["sha"] != sha for n, sha in before.items())
    assert not (state / maintenance.FORGET_FILE).exists()
    assert maintenance.forget_backups() == "forget: nobody to remove from the backups"


def test_an_off_server_failure_keeps_them_waiting_for_the_next_run(worker, monkeypatch):
    with_sam(maintenance.STATE_DIR)
    maintenance.make_backup(datetime(2026, 10, 1, 3, 15))
    maintenance.queue_forget(SAM)

    def refused(*_a, **_k):
        raise maintenance.worker_link.WorkerError("feedback Worker answered HTTP 507")

    monkeypatch.setattr(worker, "request", refused)
    summary = maintenance.forget_backups()
    assert summary.startswith("forget: 1 deleted person removed from 1 backup(s) here and 0 on the feedback Worker; will retry: off-server")
    assert "https://" not in summary
    assert [f["u"] for f in maintenance._forgets()] == ["sam-lee-1"]


def test_without_off_server_copies_only_the_local_backups_are_cleaned(worker, monkeypatch):
    monkeypatch.setenv("HERMES_BACKUP_OFFSITE", "off")
    with_sam(maintenance.STATE_DIR)
    maintenance.make_backup(datetime(2026, 10, 1, 3, 15))
    maintenance.queue_forget(SAM)
    assert maintenance.forget_backups().startswith("forget: 1 deleted person removed from 1 backup(s) here (off-server copies: ")
    assert worker.calls == [] and maintenance._forgets() == []


def test_forget_backups_now_waits_for_the_nightly_run_and_logs_the_outcome(tree, monkeypatch):
    free = []

    @contextlib.contextmanager
    def lock(_path):
        yield bool(free)

    logged, naps = [], []
    monkeypatch.setattr(maintenance, "log", logged.append)
    monkeypatch.setattr(hc, "run_lock", lock)
    assert maintenance.forget_backups_now(wait=(3, 7), sleep=naps.append) == 0
    assert naps == [7, 7, 7] and "nightly run removes them" in logged[-1]
    free.append(True)
    assert maintenance.forget_backups_now(wait=(1, 0), sleep=naps.append) == 0
    assert logged[-1] == "forget: nobody to remove from the backups"
    monkeypatch.setattr(maintenance, "forget_backups", lambda: (_ for _ in ()).throw(OSError("disk full")))
    assert maintenance.forget_backups_now(wait=(1, 0), sleep=naps.append) == 1
    assert logged[-1] == "forget failed: OSError: disk full"

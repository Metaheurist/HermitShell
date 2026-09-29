"""Security tests across the Python side: hostile input, data at rest, backups and secret hygiene.

Run from the repository root:  python -m pytest tests/security
"""

import io
import os
import sqlite3
import subprocess
import sys
import tarfile
import time
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PACKAGE = REPO / "packages" / "daily-vacancy-report"
sys.path[:0] = [str(PACKAGE), str(REPO / "common")]

import cv_text  # noqa: E402
import hermes_common as hc  # noqa: E402
import maintenance  # noqa: E402
import profiles  # noqa: E402
from job_tracker import Tracker, sign  # noqa: E402

POSIX = pytest.mark.skipif(os.name != "posix", reason="file modes are POSIX only")
HOSTILE = "<script>alert(1)</script>\"'><img src=x onerror=alert(2)>"


# --------------------------------------------------------------------------- hostile input

def test_tracker_binds_hostile_keys_as_values(tmp_path):
    evil = "nijobs:1'); DROP TABLE jobs; --"
    with Tracker(tmp_path / "tracker.db") as t:
        t.upsert_job(evil, {"title": HOSTILE, "company": "Northwind"}, True, now=time.time() - 400 * 86400)
        t.add_event("e1' OR '1'='1", evil, "interested", reason="x' OR 1=1 --", at=time.time() - 400 * 86400)
        assert t.job(evil)["title"] == HOSTILE
        assert t.prune(time.time() - 365 * 86400)["jobs"] == 1
    with sqlite3.connect(str(tmp_path / "tracker.db")) as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"jobs", "events", "letters", "runs", "skills"} <= tables


@pytest.mark.parametrize("pid", ["../etc", "owner/../x", "..", "", "A" * 50, "sam lee", "sam\x00lee", "/abs"])
def test_profile_ids_cannot_leave_the_profiles_folder(pid):
    with pytest.raises(profiles.ProfileError):
        profiles.profile_dir(pid)


@pytest.mark.parametrize("key", ["PATH", "LD_PRELOAD", "PYTHONPATH", "HERMES_HOME", "HERMES_DATA_KEY",
                                 "JOB_PROFILE_FILE", "HERMES_STATE_DIR", "OLLAMA_HOST", "OLLAMA_HOSTS",
                                 "HERMES_AUTOFIT", "HERMES_AUTOFIT_THREADS", "HERMES_MODEL_CONCURRENCY"])
def test_the_dashboard_cannot_set_process_or_path_settings(key):
    assert not hc.dashboard_key_allowed(key)


def test_a_dashboard_profile_change_can_only_set_its_own_fields(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    written = {}
    monkeypatch.setattr(profiles, "update_dashboard_env", written.update)
    monkeypatch.setattr(profiles, "save", lambda profile: None)
    monkeypatch.setattr(profiles, "profile_getter", lambda profile: lambda key, default=None: default)
    monkeypatch.setattr(profiles, "owner_name", lambda: "Alex Morgan")
    monkeypatch.setenv("ALERT_EMAIL", "alex@example.com")
    profile = {"id": "owner", "owner": True}
    profiles.apply_profile_settings(profile, {
        "details": {"location": HOSTILE, "status": "paused", "owner": False, "id": "../x"},
        "job": {"PATH": "/tmp", "JOB_SCANNER_QUERIES": "evil", "level": "wizard", "country": HOSTILE,
                "titles": [HOSTILE] * 20}})
    assert profile["id"] == "owner" and profile["owner"] is True and "status" not in profile
    assert "PATH" not in written and not {k for k in written if k not in profiles.PROFILE_KEYS | {"COVER_LETTER_CONTACT"}}
    assert written["JOB_LEVEL"] == "any" and written["JOB_SEARCH_COUNTRY"] == ""
    assert "evil" not in written["JOB_SCANNER_QUERIES"]
    assert len(written["JOB_TARGET_TITLES"].split("||")) == 1


def test_email_text_is_escaped():
    header = hc.email_header(HOSTILE, HOSTILE, HOSTILE, HOSTILE, [(HOSTILE, HOSTILE)])
    assert "<script>" not in header and "<img" not in header and "&lt;script&gt;" in header


def test_goodbye_email_escapes_the_name(monkeypatch):
    sent = []
    monkeypatch.setattr(profiles, "send", lambda to, subject, html_body, text: sent.append(html_body))
    profiles.send_goodbye({"name": f"{HOSTILE} Lee", "email": "sam@example.com"})
    assert sent and "<script>" not in sent[0] and "<img" not in sent[0]


def test_job_card_buttons_escape_their_links():
    import job_weekly

    links = dict.fromkeys(("good_match", "not_for_me", "applied", "interested", "cover_letter", "tailored_cv"),
                          f"https://w.example/f?x={HOSTILE}")
    html = job_weekly.card_action_bar(f"https://jobs.example.com/{HOSTILE}", links) + job_weekly.rating_buttons(links)
    assert "<script>" not in html and "<img src=x" not in html and 'onerror=alert(2)>' not in html
    assert html.count("&lt;script&gt;") == 7
    mini = job_weekly.mini_buttons(links)
    assert "<script>" not in mini and "<img src=x" not in mini and mini.count("&lt;script&gt;") == 6


def test_the_live_link_keeps_tls_and_never_logs_the_api_token(capsys):
    token = "live-link-token-0123456789abcdef"
    api = profiles.Api("https://feedback.example.workers.dev/", token)
    assert api.live_url == "wss://feedback.example.workers.dev/api/live"
    assert profiles.Api("http://localhost:8787", token).live_url == "ws://localhost:8787/api/live"

    class Refused(Exception):
        response = type("Response", (), {"status_code": 401})()

    def connect(url, **options):
        assert options["additional_headers"] == {"Authorization": f"Bearer {token}"}
        raise Refused(f"server rejected WebSocket connection: HTTP 401 ({url})")
    assert profiles.listen(api, 60, connect=connect, sleep=lambda s: None, stamp=lambda: 1) == "unavailable"
    out = capsys.readouterr()
    assert token not in out.out + out.err


@pytest.mark.parametrize("when", ["08:00 * * * 1; rm -rf /", "08:00\n0 * * * *", "--script=x.py", "8:00 --paused",
                                  "24:00", "", HOSTILE])
def test_a_report_time_from_the_dashboard_only_becomes_a_plain_schedule(when):
    assert profiles.schedule_expr(when, "weekdays") == ""
    assert profiles.schedule_expr("07:05", "weekdays; rm") == "5 7 * * *"


@pytest.mark.parametrize("pid", ["--help", "../owner", "owner --script x.py", "a" * 41])
def test_send_now_and_hermes_jobs_take_only_real_profile_ids(tmp_path, monkeypatch, pid):
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    monkeypatch.setattr(profiles.subprocess, "Popen", lambda *a, **k: pytest.fail("started a process"))
    monkeypatch.setattr(profiles.subprocess, "run", lambda *a, **k: pytest.fail("ran hermes"))
    with pytest.raises(profiles.ProfileError):
        profiles.admin_action({"type": "admin", "action": "send_now", "u": pid})
    with pytest.raises(profiles.ProfileError):
        profiles.run_report(pid)


def test_a_report_job_only_runs_for_a_folder_inside_the_profiles_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    outside = tmp_path / "elsewhere" / "sam-lee"
    outside.mkdir(parents=True)
    monkeypatch.chdir(outside)
    assert profiles.profile_from_cwd() == ""
    inside = tmp_path / "profiles" / "Sam Lee"
    inside.mkdir(parents=True)
    monkeypatch.chdir(inside)
    assert profiles.profile_from_cwd() == ""


@pytest.mark.parametrize("provider", ["scrapfly", "PATH", "LD_PRELOAD", "../x", HOSTILE, "firecrawl_backup"])
def test_a_crawler_key_only_ever_sets_a_search_providers_key(tmp_path, monkeypatch, provider):
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    profiles.write_json(profiles.PROFILES_DIR / "sam-lee" / "profile.json", {"id": "sam-lee"})
    with pytest.raises(profiles.ProfileError):
        profiles.admin_action({"type": "admin", "action": "set_key", "u": "sam-lee", "key": "tvly-own-longer-key-01",
                               "provider": provider})
    assert not (profiles.PROFILES_DIR / "sam-lee" / "secrets.json").exists()
    profiles.write_json(profiles.PROFILES_DIR / "sam-lee" / "secrets.json", {"provider": provider, "key": "longer-key-0123"})
    environ = {"PATH": "/usr/bin", "FIRECRAWL_API_KEY": "fc-global-longer0001"}
    profiles.apply_keys(environ, "sam-lee")
    assert environ == {"PATH": "/usr/bin", "FIRECRAWL_API_KEY": "fc-global-longer0001"}


@POSIX
def test_a_profiles_own_crawler_key_is_owner_only(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    profiles.write_json(profiles.PROFILES_DIR / "sam-lee" / "profile.json", {"id": "sam-lee"})
    profiles.admin_action({"type": "admin", "action": "set_key", "u": "sam-lee", "key": "tvly-own-longer-key-01",
                           "provider": "tavily"})
    assert (profiles.PROFILES_DIR / "sam-lee" / "secrets.json").stat().st_mode & 0o777 == 0o600


def test_stats_sent_to_the_worker_hold_no_notes_or_contact_details(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    monkeypatch.setattr(profiles, "STATE_DIR", tmp_path / "state")
    profiles.write_json(profiles.PROFILES_DIR / "owner" / "profile.json", {"id": "owner", "owner": True})
    with Tracker(tmp_path / "state" / "job_tracker.db") as tracker:
        tracker.upsert_job("k1", {"title": "Engineer", "fit": 8, "employer": "Northwind", "url": "https://jobs.example.com/private",
                                  "reasoning": "Candidate Sam Lee, sam@example.com", "listing": "Call 07700 900123"}, True)
        tracker.add_event("e1", "k1", "not_for_me", "my manager is there, text me on 07700 900123")
    sent = []
    profiles.push_stats(type("Api", (), {"stats": lambda self, pid, data: sent.append((pid, data))})())
    text = str(sent)
    assert sent and sent[0][0] == "owner"
    for private in ("sam@example.com", "Sam Lee", "07700", "manager"):
        assert private not in text
    assert text.count("jobs.example.com") == 1 and sent[0][1]["sent"][0]["url"] == "https://jobs.example.com/private"


def test_log_scrubbing_treats_names_as_text_not_patterns(tmp_path, monkeypatch):
    monkeypatch.setattr(hc, "HERMES_HOME", tmp_path)
    monkeypatch.setattr(profiles, "STATE_DIR", tmp_path / "state")
    (tmp_path / "logs").mkdir()
    log = tmp_path / "logs" / "agent.log"
    log.write_text("abcz Lee applied\nJ.* Lee left\n", encoding="utf-8")
    assert profiles.scrub_logs(["J.* Lee", "(a+)+$x"]) == 1
    assert log.read_text(encoding="utf-8") == "abcz Lee applied\n[deleted] left\n"


def _docx(xml: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("word/document.xml", xml)
    return buf.getvalue()


@pytest.mark.parametrize("encoding", ["utf-8", "utf-16"])
def test_word_cvs_with_entity_declarations_are_not_expanded(encoding):
    bomb = ('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">'
            '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;">]><w:document xmlns:w="http://schemas.openxmlformats.org/'
            'wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&c;</w:t></w:r></w:p></w:body></w:document>')
    assert cv_text.extract_text(_docx(bomb.encode(encoding)), "docx") == ""


def test_zip_bombs_are_not_inflated():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("word/document.xml", b"<x>" + b" " * (cv_text.MAX_INFLATE + 10) + b"</x>")
    assert cv_text.extract_text(buf.getvalue(), "docx") == ""


def test_feedback_links_are_bound_to_profile_action_job_and_day():
    base = sign("secret", "nijobs:1", "applied", "Analyst", "", "sam-lee", "20000")
    for args in [("nijobs:1", "applied", "Analyst", "", "alex-kim", "20000"),
                 ("nijobs:1", "interested", "Analyst", "", "sam-lee", "20000"),
                 ("nijobs:2", "applied", "Analyst", "", "sam-lee", "20000"),
                 ("nijobs:1", "applied", "Analyst", "", "sam-lee", "20001"),
                 ("nijobs:1", "applied", "Analyst", "", "", "20000")]:
        assert sign("secret", *args) != base
    assert sign("other-secret", "nijobs:1", "applied", "Analyst", "", "sam-lee", "20000") != base


# --------------------------------------------------------------------------- data at rest and backups

def _tar(members: list[tarfile.TarInfo]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for info in members:
            tar.addfile(info, io.BytesIO(b"x") if info.isfile() else None)
    return buf.getvalue()


def _member(name: str, kind: bytes = tarfile.REGTYPE, link: str = "") -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type, info.linkname, info.size = kind, link, 1 if kind == tarfile.REGTYPE else 0
    return info


@pytest.mark.parametrize("member", [_member("../escape.txt"), _member("/abs/escape.txt"),
                                    _member("scripts/../../escape.txt"), _member("link", tarfile.SYMTYPE, "/etc"),
                                    _member("hard", tarfile.LNKTYPE, "../escape.txt")],
                         ids=["parent", "absolute", "nested-parent", "symlink", "hardlink"])
def test_restore_refuses_archives_that_write_outside_the_folder(tmp_path, member):
    archive = tmp_path / "hermes-20260101-000000.tar.gz"
    archive.write_bytes(_tar([_member("SOUL.md"), member]))
    with pytest.raises(SystemExit, match="refusing"):
        maintenance.restore(archive, tmp_path / "out")
    assert not (tmp_path / "escape.txt").exists() and not (tmp_path / "out" / "SOUL.md").exists()


def test_errors_about_the_key_never_contain_it(monkeypatch):
    pytest.importorskip("cryptography")
    key = hc.new_data_key()
    monkeypatch.setenv(hc.DATA_KEY_ENV, key)
    sealed = hc.seal(b"cv")
    monkeypatch.setenv(hc.DATA_KEY_ENV, hc.new_data_key())
    with pytest.raises(hc.DataKeyError) as err:
        hc.unseal(sealed)
    monkeypatch.setenv(hc.DATA_KEY_ENV, key[:20])
    with pytest.raises(hc.DataKeyError) as err2:
        hc.seal(b"cv")
    assert key not in str(err.value) and key[:20] not in str(err2.value)


@POSIX
def test_files_the_scripts_create_are_owner_only(tmp_path):
    script = f"import sys; sys.path.insert(0, {str(REPO / 'common')!r}); import hermes_common; " \
             f"open({str(tmp_path / 'plain.txt')!r}, 'w').write('x')"
    subprocess.run([sys.executable, "-c", script], check=True, env={**os.environ, "HERMES_HOME": str(tmp_path)})
    assert (tmp_path / "plain.txt").stat().st_mode & 0o777 == 0o600
    hc.write_private(tmp_path / "private.txt", "x")
    hc.write_atomic(tmp_path / "atomic.txt", "x", private=True)
    for name in ("private.txt", "atomic.txt"):
        assert (tmp_path / name).stat().st_mode & 0o777 == 0o600


@POSIX
def test_backups_are_owner_only_and_encrypted(tmp_path, monkeypatch):
    pytest.importorskip("cryptography")
    monkeypatch.setattr(hc, "HERMES_HOME", tmp_path / "home")
    monkeypatch.setattr(maintenance, "SCRIPT_DIR", tmp_path / "scripts")
    monkeypatch.setattr(maintenance, "STATE_DIR", tmp_path / "scripts" / "state")
    (tmp_path / "scripts" / "state").mkdir(parents=True)
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / ".env").write_text("SMTP_PASSWORD=app-password-value\n", encoding="utf-8")
    monkeypatch.setenv(hc.DATA_KEY_ENV, hc.new_data_key())
    monkeypatch.delenv("HERMES_BACKUP_DIR", raising=False)
    maintenance.make_backup()
    [archive] = maintenance.list_backups()
    assert archive.stat().st_mode & 0o777 == 0o600
    assert hc.is_sealed(archive) and b"app-password-value" not in archive.read_bytes()


# --------------------------------------------------------------------------- secret hygiene

def test_gitignore_keeps_personal_files_and_backups_out_of_the_repo():
    patterns = set((REPO / ".gitignore").read_text(encoding="utf-8").split())
    assert {".env", "job_profile.md", "cv_keywords.json", "state/", "backups/", "*.enc", ".deps/"} <= patterns


def test_secrets_are_only_shown_masked():
    for secret in ("fc-0123456789abcdef", "sk-live-abcdefghijklmnop", "short"):
        shown = hc.mask_secret(secret)
        assert secret not in shown and len(shown) < len(secret) + 4


def test_the_dashboard_can_never_signal_a_process_that_is_not_the_task(monkeypatch):
    signals = []
    monkeypatch.setattr(profiles.os, "kill", lambda pid, sig: signals.append(pid))
    monkeypatch.setattr(profiles.os, "killpg", lambda pid, sig: signals.append(pid), raising=False)
    assert not profiles._runs(os.getpid(), "job_scanner.py")
    for pid in (0, 1, -5, os.getpid()):
        assert not profiles._signal(pid, "job_scanner.py", group=True)
    monkeypatch.setattr(profiles, "_runs", lambda pid, script: script == "cover_letter.py")
    assert not profiles._signal(4242, "job_scanner.py")
    assert signals == []


def test_a_tampered_scan_marker_reaches_the_dashboard_only_as_plain_bounded_values(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    monkeypatch.setattr(profiles, "_alive", lambda pid: True)
    profiles.write_json(profiles.PROFILES_DIR / "sam-lee" / "profile.json", {"id": "sam-lee", "last_duration": "soon"})
    profiles.write_json(profiles.scan_marker("sam-lee"), {"pid": 77, "at": time.time(), "trigger": HOSTILE,
                                                         "stage": HOSTILE * 20, "done": "12; rm", "total": 10**12})
    task = profiles.report_task(profiles.load("sam-lee"))
    assert task["trigger"] == "schedule" and len(task["stage"]) == 80
    assert task["done"] == 0 and task["total"] == 10_000 and task["expected"] is None
    signals = []
    monkeypatch.setattr(profiles, "_runs", lambda pid, script: True)
    monkeypatch.setattr(profiles.os, "kill", lambda pid, sig: signals.append(pid))
    profiles.write_json(profiles.scan_marker("sam-lee"), {"pid": "77", "child": 1.5, "at": time.time()})
    assert profiles.cancel_task("report:sam-lee", "sam-lee") == "The report for sam-lee could not be stopped"
    assert signals == []


def test_the_jobs_sent_list_for_the_dashboard_has_no_notes_contacts_or_script_links(tmp_path):
    import profile_stats
    from zoneinfo import ZoneInfo
    with Tracker(tmp_path / "job_tracker.db") as t:
        for i, url in enumerate(["javascript:alert(1)", "data:text/html,<script>", "vbscript:x", "https://ok.example/j"]):
            t.upsert_job(f"k{i}", {"title": HOSTILE, "employer": HOSTILE, "url": url, "fit": 7, "location": "\x00York\x1b",
                                   "salary": "£1\n\r"}, True, time.time() - i)
            t.add_event(f"e{i}", f"k{i}", "applied", "call sam@example.com on 07700 900123", time.time())
    stats = profile_stats.collect(tmp_path / "job_tracker.db", ZoneInfo("UTC"))
    text = __import__("json").dumps(stats)
    assert "sam@example.com" not in text and "07700" not in text
    assert [j["url"] for j in stats["sent"]] == ["", "", "", "https://ok.example/j"]
    assert all(j["location"] == "York" and j["salary"] == "£1" and j["answer"] == "applied" for j in stats["sent"])


# --------------------------------------------------------------------------- autofit and the host watchdog

@pytest.fixture
def autofit_files(tmp_path, monkeypatch):
    import autofit
    monkeypatch.setenv("HERMES_AUTOFIT", "auto")
    monkeypatch.setattr(autofit, "HARDWARE_FILE", tmp_path / "hardware.json")
    monkeypatch.setattr(autofit, "STATE_FILE", tmp_path / "autofit.json")
    monkeypatch.setattr(autofit, "local_gpus", lambda: [])
    return autofit


def test_a_tampered_hardware_report_only_gives_plain_bounded_values(autofit_files):
    autofit = autofit_files
    autofit.HARDWARE_FILE.write_text(__import__("json").dumps({
        "at": time.time(), "cpu": {"model": HOSTILE, "logical": 10**9, "physical": "18; rm -rf /", "avx2": "yes"},
        "ram_mb": {"total": -5, "available": float("nan")}, "ollama_gpu": "<script>",
        "gpus": [{"index": 999, "name": HOSTILE * 5, "vram_mb": 10**12, "free_mb": "4000", "compute": "5.2$(id)"}] * 40,
    }), encoding="utf-8")
    hw = autofit.hardware()
    gpu = hw["gpus"][0]
    assert len(hw["gpus"]) == 16 and hw["ollama_gpu"] == ""
    assert not set(gpu["name"] + hw["cpu"]["model"]) & set("<>\"'&;$`\\") and len(gpu["name"]) <= 80
    assert gpu["index"] == 0 and gpu["vram_mb"] == 0 and gpu["free_mb"] == 4000 and "$" not in gpu["compute"]
    assert hw["cpu"]["logical"] == 1 and hw["cpu"]["physical"] == 1 and hw["cpu"]["avx2"] is False


def test_a_tampered_autofit_state_is_bounded_and_cannot_add_instances(autofit_files, monkeypatch):
    autofit = autofit_files
    autofit.STATE_FILE.write_text(__import__("json").dumps({
        "hosts": {"http://evil.example:1/x?y": {"level": 99}, "file:///etc/passwd": {},
                  "http://ollama:11434": {"level": -1, "cost": "fast", "budget_mb": 10**15, "down_until": 10**20,
                                          "threads": {"; rm": [1, 2, 3], "8": [1, "x", None]}}},
        "models": {"m": {"points": [[10**9, 5, 5], "junk", [8192, 3000, 2900]], "layers": -3}},
    }), encoding="utf-8")
    state = autofit._load()
    assert list(state["hosts"]) == ["http://ollama:11434"]
    host = state["hosts"]["http://ollama:11434"]
    assert host["level"] == 0 and host["cost"] == 0.0 and host["budget_mb"] == 0 and host["down_until"] == 0
    assert list(host["threads"]) == ["8"] and host["threads"]["8"][1] == 0
    assert state["models"]["m"]["points"] == [[8192, 3000, 2900]] and state["models"]["m"]["layers"] == 0
    monkeypatch.setenv("OLLAMA_HOSTS", "http://user:pass@evil.example,https://ok.example:8443/path,"
                                       "javascript:alert(1),ftp://x,http://good-box:11434")
    assert autofit.instances("http://ollama:11434") == ["http://ollama:11434", "http://good-box:11434"]


def test_the_root_watchdog_never_writes_into_folders_the_container_can_change():
    script = (REPO / "scripts" / "host" / "ollama-watchdog.sh").read_text(encoding="utf-8")
    code = "\n".join(line.split("#")[0] for line in script.splitlines())
    assert "$HERMES_STATE/" not in code and "> $HERMES_STATE" not in code
    assert 'exec -i -u "$HERMES_USER"' in code and 'chmod 700 "$RUN_DIR"' in code
    installer = (REPO / "scripts" / "host" / "install-watchdog.sh").read_text(encoding="utf-8")
    assert 'stat -c %u "$DEST"' in installer and "-o root -g root" in installer

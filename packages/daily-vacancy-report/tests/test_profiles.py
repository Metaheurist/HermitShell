"""Unit tests for profiles.py: sign-ups, unsubscribes, admin changes and per-profile runs (no network or model)."""

import json
import subprocess
import sys
from pathlib import Path

import pytest
import requests

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import letter_pdf  # noqa: E402
import profiles  # noqa: E402

CV = ("Sam Lee\nData analyst at Northwind Ltd since 2021. Builds Power BI dashboards and SQL reporting for the "
      "finance team, automates month-end packs in Python and trains colleagues in Excel.\n") * 3
MODEL_REPLY = {
    "summary": "Sam Lee is a data analyst with four years of reporting experience.",
    "titles": ["Data Analyst", "BI Analyst", "Reporting Analyst"],
    "title_keywords": ["analyst", "power bi"],
    "related_title_keywords": ["insight", "reporting"],
    "skills": [{"name": "SQL", "aliases": ["T-SQL"]}, {"name": "Power BI", "aliases": ["PowerBI"]},
               {"name": "Python", "aliases": []}, {"name": "Excel", "aliases": []}],
    "looking_for": ["Hybrid or remote", "Permanent"],
    "not_interested": ["Sales roles"],
    "gaps": ["No cloud data platform experience"],
    "level": "mid",
}


class FakeApi:
    def __init__(self, items=None, files=None):
        self.items, self.files = list(items or []), dict(files or {})
        self.acked, self.statuses, self.fulls = [], [], []

    def queue(self, full=False):
        self.fulls.append(full)
        return list(self.items)

    def ack(self, ids):
        self.acked += ids
        self.items = [i for i in self.items if i["id"] not in ids]

    def file(self, key):
        return self.files[key]

    def status(self, payload):
        self.statuses.append(payload)

    def flag(self):
        if getattr(self, "flags", None):
            value = self.flags.pop(0)
            if isinstance(value, Exception):
                raise value
            return value
        return ""


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    monkeypatch.setattr(profiles, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(profiles, "DASHBOARD_FILE", tmp_path / "state" / "dashboard.json")
    monkeypatch.setattr(profiles.os, "environ", dict(profiles.os.environ))
    keywords = tmp_path / "owner_keywords.json"
    keywords.write_text(json.dumps({"cv_keywords": {"Python": r"\bpython\b"},
                                    "other_tech": {"Terraform": r"\bterraform\b", "Excel": r"\bexcel\b"}}))
    for key, value in {"ALERT_EMAIL": "owner@example.com", "COVER_LETTER_NAME": "Alex Morgan",
                       "COVER_LETTER_CONTACT": "owner@example.com", "JOB_KEYWORDS_FILE": str(keywords),
                       "JOB_REGION_NAME": "Belfast", "JOB_FEEDBACK_URL": "https://fb.example.workers.dev",
                       "JOB_FEEDBACK_SECRET": "test-secret", "FIRECRAWL_API_KEY": "fc-envkey-longer0001",
                       "FIRECRAWL_BACKUP_KEYS": "fc-envkey-longer0002", "JOB_SCANNER_QUERIES": "owner query"}.items():
        monkeypatch.setenv(key, value)
    for key in ("JOB_PROFILE_ID", "JOB_SCANNER_NIJOBS_KEYWORDS", "JOB_SEARCH_LOCATION"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(profiles, "connect_model", lambda *_: ("http://ollama", "test-model", 8192))
    monkeypatch.setattr(profiles, "ollama_chat", lambda *a, **k: json.dumps(MODEL_REPLY))
    sent = []
    monkeypatch.setattr(profiles.hc, "send_email",
                        lambda subject, html_body, text, from_name, *a, **k: sent.append(
                            {"to": profiles.os.environ["ALERT_EMAIL"], "subject": subject, "html": html_body,
                             "text": text}))
    return tmp_path, sent


def signup(**extra):
    return {"id": "queue:1700000000000:abcdef0123456789", "type": "signup", "name": "Sam Lee",
            "email": "sam@example.com", "phone": "07700 900123", "location": "Lisburn",
            "roles": "Data analyst or BI developer, hybrid", "cv_text": CV, "cv": None, **extra}


def test_signup_builds_a_profile_from_the_cv(home):
    tmp, sent = home
    api = FakeApi([signup()])
    assert profiles.sync(api) == ["signup: done (Sam Lee)"]
    pid = "sam-lee-456789"
    d = tmp / "profiles" / pid
    profile = json.loads((d / "profile.json").read_text())
    assert profile["status"] == "active" and profile["titles"][0] == "Data Analyst"
    markdown = (d / "job_profile.md").read_text()
    assert "Name: Sam Lee" in markdown and "- Power BI" in markdown and "Sales roles" in markdown
    keywords = json.loads((d / "cv_keywords.json").read_text())
    assert set(keywords["cv_keywords"]) == {"SQL", "Power BI", "Python", "Excel"}
    assert keywords["other_tech"] == {"Terraform": r"\bterraform\b"}
    settings = json.loads((d / "settings.json").read_text())
    assert settings["JOB_SCANNER_QUERIES"] == '("Data Analyst" OR "BI Analyst") "Belfast" job||("Reporting Analyst") "Belfast" job'
    assert settings["JOB_TARGET_TITLES"] == "Data Analyst||BI Analyst||Reporting Analyst"
    assert "JOB_SCANNER_NIJOBS_KEYWORDS" not in settings
    strong = profiles.re.compile(settings["JOB_TITLE_STRONG"], profiles.re.I)
    assert strong.search("Senior Power BI Developer") and not strong.search("Warehouse operative")
    assert (d / "cv.txt").read_text().startswith("Sam Lee")
    assert api.acked == ["queue:1700000000000:abcdef0123456789"]
    welcome, owner_note = sent
    assert welcome["to"] == "sam@example.com" and "Data Analyst" in welcome["html"]
    assert "a=unsubscribe" in welcome["html"] and f"u={pid}" in welcome["html"]
    assert owner_note["to"] == "owner@example.com" and "New profile: Sam Lee" in owner_note["subject"]
    assert profiles.os.environ["ALERT_EMAIL"] == "owner@example.com"
    ids = [p["id"] for p in api.statuses[-1]["profiles"]]
    assert ids == ["owner", pid]


def test_nijobs_keywords_follow_the_owner(home, monkeypatch):
    monkeypatch.setenv("JOB_SCANNER_NIJOBS_KEYWORDS", "data-engineer")
    profiles.sync(FakeApi([signup()]))
    settings = json.loads((home[0] / "profiles" / "sam-lee-456789" / "settings.json").read_text())
    assert settings["JOB_SCANNER_NIJOBS_KEYWORDS"] == "data-analyst,bi-analyst,reporting-analyst"
    assert settings["JOB_SCANNER_QUERIES"].endswith("-site:nijobs.com")


def test_signup_reads_an_uploaded_pdf(home):
    pdf = letter_pdf.letter_pdf("Sam Lee", "sam@example.com", "1 May 2026", [], "Curriculum vitae", "Profile",
                                [CV.replace("\n", " ")])
    api = FakeApi([signup(cv_text="", cv={"key": "cvfile:1", "kind": "pdf", "name": "cv.pdf", "size": len(pdf)})],
                  {"cvfile:1": pdf})
    profiles.sync(api)
    d = home[0] / "profiles" / "sam-lee-456789"
    assert "Power BI dashboards" in " ".join((d / "cv.txt").read_text().split())
    assert not list(d.glob("cv.pdf")) and not list(d.glob(".upload.*")), "the uploaded file is not kept"


def test_unreadable_cv_is_rejected_and_the_owner_told(home):
    tmp, sent = home
    api = FakeApi([signup(cv_text="", cv={"key": "cvfile:1", "kind": "pdf", "name": "scan.pdf", "size": 9})],
                  {"cvfile:1": b"%PDF-1.4 image only"})
    assert profiles.sync(api)[0].startswith("signup: rejected (no readable text")
    assert api.acked and not (tmp / "profiles" / "sam-lee-456789").exists()
    assert [m["to"] for m in sent] == ["owner@example.com"] and "failed" in sent[0]["subject"]


def test_model_trouble_is_retried_then_given_up(home, monkeypatch):
    def down(*_):
        raise RuntimeError("No reachable Ollama host")
    monkeypatch.setattr(profiles, "connect_model", down)
    api = FakeApi([signup()])
    for _ in range(profiles.QUEUE_ATTEMPTS - 1):
        assert profiles.sync(api) == []
        assert api.acked == []
    assert profiles.sync(api) == ["signup: gave up (No reachable Ollama host)"]
    assert api.acked and not (home[0] / "profiles" / "sam-lee-456789").exists()


def test_a_signup_cannot_take_over_a_profile_by_its_email(home):
    tmp, sent = home
    profiles.sync(FakeApi([signup(invite="a" * 32)]))
    sent.clear()
    again = signup(id="queue:1800000000000:ffffff", invite="b" * 32, name="Someone Else", roles="BI developer")
    assert profiles.sync(FakeApi([again])) == ["signup: done (Someone Else)"]
    found = profiles.all_profiles()
    assert [p["id"] for p in found] == ["owner", "sam-lee-456789"]
    assert found[1]["roles"] == "Data analyst or BI developer, hybrid" and found[1]["name"] == "Sam Lee"
    assert [m["to"] for m in sent] == ["owner@example.com"] and "not applied" in sent[0]["subject"]


def test_a_repeated_invite_creates_one_profile(home):
    profiles.sync(FakeApi([signup(invite="a" * 32),
                           signup(id="queue:1700000000001:0b0b0b", invite="a" * 32, email="sam2@example.com")]))
    assert [p["id"] for p in profiles.all_profiles()] == ["owner", "sam-lee-456789"]


def test_admin_cv_upload_rebuilds_that_profile(home):
    profiles.sync(FakeApi([signup()]))
    item = {"id": "queue:2:0c0c0c", "type": "admin", "action": "cv", "u": "sam-lee-456789",
            "cv_text": CV.replace("Data analyst", "BI developer"), "cv": None}
    profiles.sync(FakeApi([item]))
    found = profiles.all_profiles()
    assert [p["id"] for p in found] == ["owner", "sam-lee-456789"]
    assert "BI developer" in (home[0] / "profiles" / "sam-lee-456789" / "cv.txt").read_text()


def test_unsubscribe_deletes_a_profile_but_only_pauses_the_owner(home):
    tmp, sent = home
    profiles.sync(FakeApi([signup()]))
    sent.clear()
    profiles.sync(FakeApi([{"id": "queue:2:a", "type": "unsubscribe", "u": "sam-lee-456789", "reason": "found a job"}]))
    assert not (tmp / "profiles" / "sam-lee-456789").exists()
    goodbye, note = sent
    assert goodbye["to"] == "sam@example.com" and "unsubscribed" in goodbye["subject"]
    assert "deleted your profile, your CV" in goodbye["text"]
    assert note["to"] == "owner@example.com" and "Their feedback: found a job" in note["text"]
    assert "sam@example.com" not in note["text"]
    assert not profiles.owner_paused()
    profiles.sync(FakeApi([{"id": "queue:3:b", "type": "unsubscribe", "u": ""}]))
    assert profiles.owner_paused()
    assert (tmp / "profiles" / "owner" / "profile.json").is_file()


def test_with_a_data_key_profile_files_are_encrypted_but_still_used(home, monkeypatch):
    pytest.importorskip("cryptography")
    monkeypatch.setenv(profiles.hc.DATA_KEY_ENV, profiles.hc.new_data_key())
    profiles.sync(FakeApi([signup()]))
    d = home[0] / "profiles" / "sam-lee-456789"
    for name in ("profile.json", "settings.json", "cv.txt", "job_profile.md", "cv_keywords.json"):
        assert profiles.hc.is_sealed(d / name), name
        assert b"Sam Lee" not in (d / name).read_bytes() and b"sam@example.com" not in (d / name).read_bytes()
    sam = profiles.load("sam-lee-456789")
    assert sam["email"] == "sam@example.com"
    assert profiles.child_env(sam)["JOB_SCANNER_QUERIES"].startswith('("Data Analyst"')
    assert "Name: Sam Lee" in profiles.hc.read_private_text(d / "job_profile.md")
    assert not profiles.hc.is_sealed(profiles.DASHBOARD_FILE), "read before .env, so it cannot need the key"


def test_deleting_a_profile_removes_the_person_from_the_logs(home, monkeypatch):
    tmp, _ = home
    logs = tmp / "hermes"
    monkeypatch.setattr(profiles.hc, "HERMES_HOME", logs)
    (logs / "logs").mkdir(parents=True)
    (logs / "cron" / "output" / "job").mkdir(parents=True)
    (tmp / "state").mkdir(exist_ok=True)
    profiles.sync(FakeApi([signup()]))
    lines = "Sent to SAM@example.com\nProfile sam-lee-456789 active for Sam  Lee\nOther person\n"
    for path in (logs / "logs" / "agent.log", logs / "cron" / "output" / "job" / "run.md",
                 tmp / "state" / "profiles.log"):
        path.write_text(lines, encoding="utf-8")
    profiles.sync(FakeApi([{"id": "queue:2:a", "type": "admin", "action": "delete", "u": "sam-lee-456789"}]))
    for path in (logs / "logs" / "agent.log", logs / "cron" / "output" / "job" / "run.md",
                 tmp / "state" / "profiles.log"):
        text = path.read_text(encoding="utf-8")
        assert text.startswith("Sent to [deleted]\nProfile [deleted] active for [deleted]"), text
        assert "Other person" in text and "sam" not in text.lower()


def test_admin_actions_set_keys_pause_and_delete(home, monkeypatch):
    profiles.sync(FakeApi([signup()]))
    pid = "sam-lee-456789"
    api = FakeApi([
        {"id": "queue:2:a", "type": "admin", "action": "set_key", "u": pid, "key": "fc-test-own-long-key"},
        {"id": "queue:3:b", "type": "admin", "action": "api_keys", "firecrawl": ["fc-global-longer0001", "fc-global-longer0002", "bad key"]},
        {"id": "queue:4:c", "type": "admin", "action": "pause", "u": pid},
        {"id": "queue:5:d", "type": "admin", "action": "delete", "u": "owner"},
    ])
    report = profiles.sync(api)
    assert report[-1] == "admin: rejected (the owner profile cannot be deleted)"
    sam = profiles.load(pid)
    assert sam["status"] == "paused"
    environ = profiles.child_env(sam)
    assert (environ["FIRECRAWL_API_KEY"], environ["FIRECRAWL_BACKUP_KEYS"]) == ("fc-test-own-long-key", "")
    payload = api.statuses[-1]
    row = next(p for p in payload["profiles"] if p["id"] == pid)
    assert row["crawler"] == "own" and row["key_hint"] == "fc-...-key"
    assert "fc-test-own-long-key" not in json.dumps(payload) and "fc-global-longer0001" not in json.dumps(payload)
    assert payload["keys"]["firecrawl"] == {"source": "dashboard", "hint": "fc-...0001", "backups": 1}
    assert profiles.dashboard_env()["FIRECRAWL_API_KEY"] == "fc-global-longer0001"
    assert profiles.os.environ["FIRECRAWL_API_KEY"] == "fc-global-longer0001"
    assert profiles.os.environ["FIRECRAWL_BACKUP_KEYS"] == "fc-global-longer0002"


def test_rejected_dashboard_changes_are_reported_for_a_day(home, monkeypatch):
    api = FakeApi([{"id": "queue:2:a", "type": "admin", "action": "email", "host": "bad host!", "user": "x"},
                   {"id": "queue:3:b", "type": "admin", "action": "pause", "u": "casey-quinn"}])
    profiles.sync(api)
    problems = api.statuses[-1]["problems"]
    assert [(p["what"], p["error"]) for p in problems] == [("email", "invalid email server settings"),
                                                          ("pause for casey-quinn", "no profile casey-quinn")]
    assert all(p["at"] > 1e12 for p in problems)
    later = profiles.time.time() + 2 * 86400
    monkeypatch.setattr(profiles.time, "time", lambda: later)
    assert profiles.status_payload()["problems"] == []


def test_dashboard_job_search_uses_the_region_for_searches(home, monkeypatch):
    monkeypatch.setenv("JOB_SEARCH_LOCATION", "Lisburn")
    job = {"titles": ["Data Engineer"], "region": "Belfast", "places": ["Holywood"], "country": "uk"}
    profiles.sync(FakeApi([{"id": "queue:2:a", "type": "admin", "action": "profile", "u": "owner", "job": job}]))
    saved = profiles.dashboard_env()
    assert saved["JOB_SEARCH_LOCATION"] == "" and saved["JOB_SEARCH_COUNTRY"] == "gb"
    assert saved["JOB_SCANNER_QUERIES"] == '("Data Engineer") "Belfast" job'


def test_a_dashboard_change_only_touches_the_fields_it_names(home, monkeypatch):
    monkeypatch.setenv("JOB_TARGET_TITLES", "Data Engineer")
    monkeypatch.setenv("JOB_EMPLOYMENT_TYPES", "Permanent")
    profiles.sync(FakeApi([{"id": "queue:2:a", "type": "admin", "action": "profile", "u": "owner",
                            "job": {"min_salary": "45000"}, "details": {"location": "Bangor"}}]))
    saved = profiles.dashboard_env()
    assert saved["JOB_MIN_SALARY"] == "45000"
    assert saved["JOB_REGION_NAME"] == "Belfast" and saved["JOB_TARGET_TITLES"] == "Data Engineer"
    assert saved["JOB_EMPLOYMENT_TYPES"] == "Permanent"
    assert saved["ALERT_EMAIL"] == "owner@example.com" and saved["COVER_LETTER_NAME"] == "Alex Morgan"
    assert saved["COVER_LETTER_CONTACT"] == "owner@example.com · Bangor"


def test_changes_from_two_people_to_one_profile_both_apply(home):
    profiles.sync(FakeApi([signup()]))
    pid = "sam-lee-456789"
    profiles.sync(FakeApi([
        {"id": "queue:2:a", "type": "admin", "action": "profile", "u": pid, "details": {"phone": "07700 900999"}},
        {"id": "queue:3:b", "type": "admin", "action": "profile", "u": pid, "job": {"region": "Newry"}},
        {"id": "queue:4:c", "type": "admin", "action": "profile", "u": pid, "job": {"titles": ["BI Developer"]}}]))
    sam = profiles.load(pid)
    assert (sam["name"], sam["email"], sam["phone"], sam["location"]) == ("Sam Lee", "sam@example.com", "07700 900999", "Lisburn")
    settings = json.loads((home[0] / "profiles" / pid / "settings.json").read_text())
    assert settings["JOB_REGION_NAME"] == "Newry" and settings["JOB_TARGET_TITLES"] == "BI Developer"
    assert settings["JOB_SCANNER_QUERIES"] == '("BI Developer") "Newry" job'


def test_a_change_to_an_invalid_email_is_rejected(home):
    profiles.sync(FakeApi([signup()]))
    report = profiles.sync(FakeApi([{"id": "queue:2:a", "type": "admin", "action": "profile", "u": "sam-lee-456789",
                                     "details": {"email": "nope"}}]))
    assert report == ["admin: rejected (invalid email address)"]
    assert profiles.load("sam-lee-456789")["email"] == "sam@example.com"


class Clock:
    def __init__(self):
        self.now, self.sleeps = 0.0, []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def test_watch_syncs_as_soon_as_the_queue_flag_changes(home, monkeypatch):
    clock, synced = Clock(), []
    monkeypatch.setattr(profiles, "sync", lambda api, full=False: synced.append(clock.now) or [f"synced at {clock.now:.0f}"])
    api = FakeApi()
    api.flags = ["", "", "queue:1:a", "queue:1:a", requests.ConnectionError(), "", "queue:2:b", "queue:3:c", ""]
    report = profiles.watch(api, 120, 15, sleep=clock.sleep, clock=clock)
    assert synced == [30.0, 90.0, 105.0]
    assert report == ["synced at 30", "synced at 90", "synced at 105"]
    assert clock.sleeps == [15] * 7 and clock.now < 120


def test_watch_leaves_an_unchanged_flag_to_the_next_run(home, monkeypatch):
    clock, synced = Clock(), []
    monkeypatch.setattr(profiles, "sync", lambda api, full=False: synced.append(clock.now) or [])
    api = FakeApi()
    api.flags = ["queue:1:stuck"] * 20
    profiles.watch(api, 270, 15, sleep=clock.sleep, clock=clock)
    assert synced == []
    assert profiles.watch(api, 0, 15, sleep=clock.sleep, clock=clock) == []


@pytest.mark.parametrize("value, default, minimum, expected", [("", 270, 0, 270), ("0", 270, 0, 0), ("abc", 15, 5, 15),
                                                                ("1", 15, 5, 5), ("60", 15, 5, 60), ("-1", 270, 0, -1)])
def test_watch_settings_come_from_the_env(home, monkeypatch, value, default, minimum, expected):
    monkeypatch.setenv("JOB_PROFILES_TEST_SECONDS", value)
    assert profiles._seconds("JOB_PROFILES_TEST_SECONDS", default, minimum) == expected


@pytest.mark.parametrize("argv, watched", [([], True), (["--once"], False), (["--full", "--once"], False)])
def test_main_watches_between_cron_runs_unless_once(home, monkeypatch, argv, watched):
    calls = []
    monkeypatch.setenv("JOB_FEEDBACK_API_TOKEN", "api-token")
    monkeypatch.setattr(profiles, "load_env_file", lambda *a, **k: None)
    monkeypatch.setattr(profiles, "sync", lambda api, full=False: calls.append(("sync", full)) or [])
    monkeypatch.setattr(profiles, "watch", lambda api, seconds, poll: calls.append(("watch", seconds, poll)) or [])
    assert profiles.main(argv) == 0
    assert calls[0] == ("sync", "--full" in argv)
    assert calls[1:] == ([("watch", profiles.WATCH_SECONDS, profiles.POLL_SECONDS)] if watched else [])
    assert profiles.WATCH_SECONDS + 2 * profiles.POLL_SECONDS <= 300, "a run must end before the next one starts"


def test_admin_can_go_back_to_the_env_keys_and_delete(home):
    profiles.sync(FakeApi([signup()]))
    pid = "sam-lee-456789"
    profiles.sync(FakeApi([{"id": "queue:2:a", "type": "admin", "action": "set_key", "u": pid, "key": "fc-test-own-long-key"},
                           {"id": "queue:3:b", "type": "admin", "action": "api_keys", "firecrawl": ["fc-global-longer0001"]}]))
    profiles.sync(FakeApi([{"id": "queue:6:e", "type": "admin", "action": "use_global", "u": pid},
                           {"id": "queue:7:f", "type": "admin", "action": "api_keys", "clear": ["firecrawl"]}]))
    environ = profiles.child_env(profiles.load(pid))
    assert "FIRECRAWL_API_KEY" not in profiles.dashboard_env()
    assert environ.get("FIRECRAWL_API_KEY") not in ("fc-global-longer0001", "fc-test-own-long-key")
    profiles.sync(FakeApi([{"id": "queue:8:g", "type": "admin", "action": "delete", "u": pid}]))
    assert profiles.load(pid) is None


def test_child_env_replaces_the_owners_personal_settings(home):
    profiles.sync(FakeApi([signup()]))
    environ = profiles.child_env(profiles.load("sam-lee-456789"))
    d = home[0] / "profiles" / "sam-lee-456789"
    assert environ["JOB_PROFILE_ID"] == "sam-lee-456789"
    assert environ["ALERT_EMAIL"] == "sam@example.com"
    assert environ["HERMES_STATE_DIR"] == str(d / "state")
    assert environ["JOB_PROFILE_FILE"] == str(d / "job_profile.md")
    assert environ["COVER_LETTER_CONTACT"] == "sam@example.com · 07700 900123 · Lisburn"
    assert environ["JOB_SCANNER_QUERIES"].startswith('("Data Analyst"')
    assert environ["JOB_MIN_SALARY"] == "" and environ["JOB_SCANNER_NIJOBS_KEYWORDS"] == ""
    assert environ["JOB_FEEDBACK_SECRET"] == "test-secret"


def test_status_is_only_pushed_when_it_changes(home, monkeypatch):
    api = FakeApi()
    profiles.ensure_owner()
    profiles.push_status(api)
    profiles.push_status(api)
    assert len(api.statuses) == 1
    profiles.set_status("owner", "paused")
    profiles.push_status(api)
    assert len(api.statuses) == 2 and api.statuses[-1]["profiles"][0]["status"] == "paused"
    later = profiles.time.time() + profiles.STATUS_EVERY + 1
    monkeypatch.setattr(profiles.time, "time", lambda: later)
    profiles.push_status(api)
    assert len(api.statuses) == 3 and profiles.STATUS_EVERY <= 900


@pytest.mark.parametrize("zone, shown", [("Europe/London", "Europe/London"), ("", "UTC"), ("Mars/Olympus", "UTC"),
                                         ("../../etc/passwd", "UTC")])
def test_status_reports_the_timezone_for_the_dashboard(home, monkeypatch, zone, shown):
    monkeypatch.setenv("HERMES_TIMEZONE", zone)
    assert profiles.status_payload()["timezone"] == shown


def test_worker_outage_leaves_the_queue_alone(home):
    class Down(FakeApi):
        def queue(self, full=False):
            raise requests.ConnectionError("down")
    assert profiles.sync(Down()) == []


def test_run_all_runs_each_active_profile_with_its_environment(home):
    profiles.sync(FakeApi([signup()]))
    profiles.sync(FakeApi([signup(id="queue:9:0a0a0a", name="Kim Park", email="kim@example.com")]))
    profiles.set_status("kim-park-0a0a0a", "paused")
    calls = []

    def runner(cmd, env, cwd, timeout):
        calls.append((cmd[1:], env["JOB_PROFILE_ID"]))
        return subprocess.CompletedProcess(cmd, 0)

    assert profiles.run_all("job_scanner.py", ["--limit", "5"], runner=runner) == {"sam-lee-456789": 0}
    assert calls == [([str(profiles.SCRIPT_DIR / "job_scanner.py"), "--limit", "5"], "sam-lee-456789")]
    assert profiles.load("sam-lee-456789")["last_run"]
    with pytest.raises(profiles.ProfileError):
        profiles.run_all("other_script.py", [], runner=runner)


def test_spawn_only_from_the_owner_with_extra_profiles(home, monkeypatch):
    started = []
    monkeypatch.setattr(profiles.subprocess, "Popen", lambda cmd, **k: started.append(cmd))
    assert profiles.spawn_others("job_scanner.py", []) is False
    profiles.sync(FakeApi([signup()]))
    monkeypatch.setenv("JOB_PROFILE_ID", "sam-lee-456789")
    assert profiles.spawn_others("job_scanner.py", []) is False
    monkeypatch.delenv("JOB_PROFILE_ID")
    assert profiles.spawn_others("job_scanner.py", ["--weekly"]) is True
    assert started[0][2:] == ["run", "--after", str(profiles.os.getpid()), "job_scanner.py", "--weekly"]


def test_term_regex_keeps_symbols():
    rx = profiles.re.compile(profiles.term_regex(["C#", "Power BI", ".NET"]), profiles.re.I)
    assert rx.search("C# developer") and rx.search("power bi analyst") and rx.search("ASP.NET Core")
    assert not rx.search("C developer")


def test_cli_list_and_delete(home, capsys):
    profiles.sync(FakeApi([signup()]))
    assert profiles.main(["--list"]) == 0
    out = capsys.readouterr().out
    assert "sam-lee-456789" in out and "owner" in out
    assert profiles.main(["--delete", "owner"]) == 1
    assert profiles.main(["--delete", "sam-lee-456789"]) == 0
    assert profiles.load("sam-lee-456789") is None


def test_email_settings_drop_the_password_when_the_server_or_account_changes(home):
    profiles.apply_email({"host": "smtp.gmail.com", "port": "587", "user": "me@example.com", "password": "app pass"})
    assert profiles.env("SMTP_PASSWORD") == "app pass"
    profiles.apply_email({"host": "smtp.gmail.com", "port": "465", "user": "me@example.com"})
    assert profiles.env("SMTP_PASSWORD") == "app pass"
    profiles.apply_email({"host": "smtp.evil.example", "port": "587", "user": "me@example.com"})
    assert profiles.env("SMTP_PASSWORD") is None and profiles.dashboard_env()["SMTP_PASSWORD"] == ""
    with pytest.raises(profiles.ProfileError):
        profiles.update_dashboard_env({"PATH": "/tmp"})

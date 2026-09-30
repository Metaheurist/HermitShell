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
        self.acked, self.statuses, self.fulls, self.pushed = [], [], [], []

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

    def stats(self, pid, data):
        self.pushed.append((pid, data))

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
    monkeypatch.setattr(profiles, "CRON_FILE", tmp_path / "cron" / "jobs.json")
    monkeypatch.setattr(profiles.os, "environ", dict(profiles.os.environ))
    keywords = tmp_path / "owner_keywords.json"
    keywords.write_text(json.dumps({"cv_keywords": {"Python": r"\bpython\b"},
                                    "other_tech": {"Terraform": r"\bterraform\b", "Excel": r"\bexcel\b"}}))
    for key, value in {"ALERT_EMAIL": "owner@example.com", "COVER_LETTER_NAME": "Alex Morgan",
                       "COVER_LETTER_CONTACT": "owner@example.com", "JOB_KEYWORDS_FILE": str(keywords),
                       "JOB_PROFILE_FILE": str(tmp_path / "owner_profile.md"), "JOB_FEEDBACK_API_TOKEN": "test-token",
                       "JOB_REGION_NAME": "Belfast", "JOB_FEEDBACK_URL": "https://fb.example.workers.dev",
                       "JOB_FEEDBACK_SECRET": "test-secret", "FIRECRAWL_API_KEY": "fc-envkey-longer0001",
                       "FIRECRAWL_BACKUP_KEYS": "fc-envkey-longer0002", "JOB_SCANNER_QUERIES": "owner query",
                       "WEB_KEY_USAGE_MINUTES": "0"}.items():
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
    # Where they live, from the sign-up, not the admin's region.
    assert settings["JOB_SCANNER_QUERIES"] == '("Data Analyst" OR "BI Analyst") "Lisburn" job||("Reporting Analyst") "Lisburn" job'
    assert settings["JOB_TARGET_TITLES"] == "Data Analyst||BI Analyst||Reporting Analyst"
    assert "JOB_SCANNER_NIJOBS_KEYWORDS" not in settings
    strong = profiles.re.compile(settings["JOB_TITLE_STRONG"], profiles.re.I)
    assert strong.search("Senior Power BI Developer") and not strong.search("Warehouse operative")
    assert (d / "cv.txt").read_text().startswith("Sam Lee")
    assert api.acked == ["queue:1700000000000:abcdef0123456789"]
    welcome, owner_note = sent
    assert welcome["to"] == "sam@example.com" and "Data Analyst" in welcome["html"]
    assert "a=unsubscribe" in welcome["html"] and f"u={pid}" in welcome["html"]
    assert "Unsubscribe</a> (deletes your profile and CV)" in welcome["html"] and ">Your data</a>" in welcome["html"]
    assert owner_note["to"] == "owner@example.com" and "New recruit: Sam Lee" in owner_note["subject"]
    assert "Recruits" in owner_note["html"] and "Profiles" not in owner_note["html"]
    assert '/admin" style="color:#4f46e5">Manage recruits</a>' in owner_note["html"]
    assert f'/admin/profile?u={pid}"' in owner_note["html"] and "Open Sam&#x27;s profile" in owner_note["html"]
    assert ">Looking for</td>" in owner_note["html"] and ">Data analyst or BI developer, hybrid</td>" in owner_note["html"]
    assert ">Location</td>" in owner_note["html"] and ">Lisburn</td>" in owner_note["html"]
    assert "Skills read from the CV <span" in owner_note["html"] and "border-radius:99px" in owner_note["html"]
    assert "Sam Lee <sam@example.com>" not in owner_note["text"] and "Email: sam@example.com" in owner_note["text"]
    assert profiles.os.environ["ALERT_EMAIL"] == "owner@example.com"
    ids = [p["id"] for p in api.statuses[-1]["profiles"]]
    assert ids == ["owner", pid]


def test_the_new_recruit_email_is_sections_not_one_paragraph(home):
    _, sent = home
    built = {"titles": ["Data Analyst", "<b>BI</b>"], "skills": [{"name": "SQL"}, {"name": "Power BI"}, {"name": "Excel"}]}
    profiles.send_new_recruit({"id": "sam-lee", "name": "Sam <i>Lee</i>", "email": "sam@example.com",
                               "location": "", "roles": "Analyst <script>"}, built, True)
    note = sent[-1]
    assert "Recruit updated: Sam <i>Lee</i>" in note["subject"]
    body = note["html"]
    assert "<i>" not in body and "<script>" not in body and "<b>BI</b>" not in body
    assert "Sam &lt;i&gt;Lee&lt;/i&gt; sent a new CV." in body and "&lt;b&gt;BI&lt;/b&gt;" in body
    assert ">Location</td>" not in body
    assert body.count("border-radius:99px") == 5
    assert "Searching for <span" in body and ">2</span>" in body and ">3</span>" in body
    assert note["text"].splitlines()[:5] == ["Sam <i>Lee</i> sent a new CV.", "Email: sam@example.com",
                                            "Looking for: Analyst <script>", "Searching for: Data Analyst, <b>BI</b>",
                                            "Skills read from the CV: SQL, Power BI, Excel"]


def test_a_new_profile_reaches_the_worker_before_its_signup_leaves_the_queue(home):
    order = []

    class Ordered(FakeApi):
        def status(self, payload):
            order.append(("status", [p["id"] for p in payload["profiles"]]))
            super().status(payload)

        def ack(self, ids):
            order.append(("ack", ids))
            super().ack(ids)

    profiles.sync(Ordered([signup()]))
    assert order == [("status", ["owner", "sam-lee-456789"]), ("ack", ["queue:1700000000000:abcdef0123456789"])]


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


def test_unsubscribe_deletes_a_profile_and_never_the_admin(home):
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
    sent.clear()
    profiles.sync(FakeApi([{"id": "queue:3:b", "type": "unsubscribe", "u": ""}]))
    assert sent == [] and profiles.load("owner")["status"] == "active"
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
    monkeypatch.setattr(profiles.hc, "APP_HOME", logs)
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


def test_admin_actions_set_global_keys_pause_and_delete(home, monkeypatch):
    profiles.sync(FakeApi([signup()]))
    pid = "sam-lee-456789"
    api = FakeApi([
        {"id": "queue:2:a", "type": "admin", "action": "set_key", "u": pid, "key": "fc-test-own-long-key"},
        {"id": "queue:3:b", "type": "admin", "action": "api_keys", "firecrawl": ["fc-global-longer0001", "fc-global-longer0002", "bad key"]},
        {"id": "queue:4:c", "type": "admin", "action": "pause", "u": pid},
        {"id": "queue:5:d", "type": "admin", "action": "delete", "u": "owner"},
    ])
    report = profiles.sync(api)
    assert report[0] == "admin: rejected (recruits no longer have their own crawler keys; set web search keys under Global settings)"
    assert report[-1] == f"admin: rejected ({profiles.STAFF})"
    assert not (profiles.profile_dir(pid) / "secrets.json").exists()
    sam = profiles.load(pid)
    assert sam["status"] == "paused"
    environ = profiles.child_env(sam)
    assert (environ["FIRECRAWL_API_KEY"], environ["FIRECRAWL_BACKUP_KEYS"]) == ("fc-global-longer0001", "fc-global-longer0002")
    payload = api.statuses[-1]
    for row in payload["profiles"]:
        assert not {"crawler", "provider", "key_hint"} & set(row)
    assert "fc-test-own-long-key" not in json.dumps(payload) and "fc-global-longer0001" not in json.dumps(payload)
    assert payload["keys"]["firecrawl"] == {"source": "dashboard", "hint": "fc-...0001", "backups": 1, "keys": [
        {"hint": "fc-...0001", "role": "main"}, {"hint": "fc-...0002", "role": "backup"}]}
    assert profiles.dashboard_env()["FIRECRAWL_API_KEY"] == "fc-global-longer0001"
    assert profiles.os.environ["FIRECRAWL_API_KEY"] == "fc-global-longer0001"
    assert profiles.os.environ["FIRECRAWL_BACKUP_KEYS"] == "fc-global-longer0002"


def test_a_global_key_from_the_dashboard_reaches_the_owner_and_every_recruit(home, monkeypatch):
    profiles.sync(FakeApi([signup()]))
    api = FakeApi([{"id": "queue:2:a", "type": "admin", "action": "api_keys", "tavily": "tvly-global-longer-key9"}])
    profiles.sync(api)
    assert profiles.dashboard_env()["TAVILY_API_KEY"] == "tvly-global-longer-key9"
    assert profiles.os.environ["TAVILY_API_KEY"] == "tvly-global-longer-key9"
    assert profiles.child_env(profiles.load("sam-lee-456789"))["TAVILY_API_KEY"] == "tvly-global-longer-key9"
    assert api.statuses[-1]["keys"]["tavily"] == {"source": "dashboard", "hint": "tvl...key9",
                                                 "keys": [{"hint": "tvl...key9", "role": "main"}]}


def test_a_leftover_recruit_crawler_key_is_never_used_and_is_removed(home, monkeypatch):
    profiles.sync(FakeApi([signup()]))
    pid = "sam-lee-456789"
    profiles.write_json(profiles.profile_dir(pid) / "secrets.json", {"provider": "tavily", "key": "tvly-own-longer-key-01"},
                        private=True)
    environ = profiles.child_env(profiles.load(pid))
    assert "tvly-own-longer-key-01" not in environ.values()
    assert environ["FIRECRAWL_API_KEY"] == "fc-envkey-longer0001"
    assert profiles.retire_own_keys() == 1
    assert not (profiles.profile_dir(pid) / "secrets.json").exists()
    assert profiles.retire_own_keys() == 0
    assert profiles.load(pid)["name"] == "Sam Lee"


def test_a_recruit_joins_the_pool_of_the_recruiter_who_invited_them(home):
    api = FakeApi([signup(recruiter="casey")])
    profiles.sync(api)
    pid = "sam-lee-456789"
    assert profiles.load(pid)["recruiter"] == "casey"
    rows = {p["id"]: p for p in api.statuses[-1]["profiles"]}
    assert rows[pid]["recruiter"] == "casey" and rows["owner"]["recruiter"] == ""
    profiles.sync(FakeApi([{"id": "queue:2:a", "type": "admin", "action": "cv", "u": pid, "cv_text": CV}]))
    assert profiles.load(pid)["recruiter"] == "casey"


@pytest.mark.parametrize("recruiter", ["../x", "Casey Quinn", "a", "x" * 40, "<b>", 7])
def test_a_sign_up_with_an_odd_recruiter_joins_nobodys_pool(home, recruiter):
    profiles.sync(FakeApi([signup(recruiter=recruiter)]))
    assert "recruiter" not in profiles.load("sam-lee-456789")


def test_the_dashboard_assigns_and_unassigns_recruits_but_never_the_owner(home):
    profiles.sync(FakeApi([signup()]))
    pid = "sam-lee-456789"
    api = FakeApi([{"id": "queue:2:a", "type": "admin", "action": "assign", "u": pid, "recruiter": "riley"},
                   {"id": "queue:3:b", "type": "admin", "action": "assign", "u": "owner", "recruiter": "riley"},
                   {"id": "queue:4:c", "type": "admin", "action": "assign", "u": pid, "recruiter": "../etc"}])
    report = profiles.sync(api)
    assert report[-2:] == [f"admin: rejected ({profiles.STAFF})", "admin: rejected (invalid recruiter)"]
    assert profiles.load(pid)["recruiter"] == "riley"
    assert "recruiter" not in profiles.load("owner")
    assert next(p for p in api.statuses[-1]["profiles"] if p["id"] == pid)["recruiter"] == "riley"
    profiles.sync(FakeApi([{"id": "queue:5:d", "type": "admin", "action": "assign", "u": pid, "recruiter": ""}]))
    assert "recruiter" not in profiles.load(pid)

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
    profiles.sync(FakeApi([signup()]))
    pid = "sam-lee-456789"
    job = {"titles": ["Data Engineer"], "region": "Belfast", "places": ["Holywood"], "country": "uk"}
    profiles.sync(FakeApi([{"id": "queue:2:a", "type": "admin", "action": "profile", "u": pid, "job": job}]))
    saved = json.loads((home[0] / "profiles" / pid / "settings.json").read_text())
    assert saved["JOB_SEARCH_LOCATION"] == "" and saved["JOB_SEARCH_COUNTRY"] == "gb"
    assert saved["JOB_SCANNER_QUERIES"] == '("Data Engineer") "Belfast" job'
    assert profiles.dashboard_env() == {}, "a recruit's search never changes the server's settings"


def test_a_dashboard_change_only_touches_the_fields_it_names(home, monkeypatch):
    profiles.sync(FakeApi([signup()]))
    pid = "sam-lee-456789"
    path = home[0] / "profiles" / pid / "settings.json"
    path.write_text(json.dumps({**json.loads(path.read_text()), "JOB_REGION_NAME": "Newry",
                                "JOB_EMPLOYMENT_TYPES": "Permanent"}))
    profiles.sync(FakeApi([{"id": "queue:2:a", "type": "admin", "action": "profile", "u": pid,
                            "job": {"min_salary": "45000"}, "details": {"location": "Bangor"}}]))
    saved = json.loads(path.read_text())
    assert saved["JOB_MIN_SALARY"] == "45000"
    assert saved["JOB_REGION_NAME"] == "Newry" and saved["JOB_TARGET_TITLES"] == "Data Analyst||BI Analyst||Reporting Analyst"
    assert saved["JOB_EMPLOYMENT_TYPES"] == "Permanent"
    sam = profiles.load(pid)
    assert (sam["location"], sam["phone"], sam["email"]) == ("Bangor", "07700 900123", "sam@example.com")


def test_recruits_have_their_own_search_not_the_admins(home, monkeypatch):
    monkeypatch.setenv("JOB_EMPLOYMENT_TYPES", "Contract")
    monkeypatch.setenv("JOB_SALARY_CURRENCY", "EUR")
    profiles.sync(FakeApi([signup()]))
    environ = profiles.child_env(profiles.load("sam-lee-456789"))
    for key in ("JOB_REGION_NAME", "JOB_EMPLOYMENT_TYPES", "JOB_SALARY_CURRENCY"):
        assert environ[key] == "", key
    assert profiles.os.environ["JOB_REGION_NAME"] == "Belfast"


def test_existing_recruits_keep_the_search_they_were_sharing_once(home, monkeypatch):
    monkeypatch.setenv("JOB_EMPLOYMENT_TYPES", "Contract")
    d = home[0] / "profiles" / "casey-quinn-0a0a0a"
    d.mkdir(parents=True)
    profiles.save({"id": "casey-quinn-0a0a0a", "name": "Casey Quinn", "email": "casey@example.com", "status": "active"})
    profiles.write_json(d / "settings.json", {"JOB_REGION_NAME": "Derry", "JOB_TARGET_TITLES": "Nurse"})
    assert profiles.give_recruits_own_search() == 1
    saved = json.loads((d / "settings.json").read_text())
    assert saved["JOB_REGION_NAME"] == "Derry", "a recruit's own value is kept"
    assert saved["JOB_EMPLOYMENT_TYPES"] == "Contract" and "JOB_SCANNER_QUERIES" not in saved
    assert "ALERT_EMAIL" not in saved and "COVER_LETTER_NAME" not in saved
    monkeypatch.setenv("JOB_EMPLOYMENT_TYPES", "Permanent")
    assert profiles.give_recruits_own_search() == 0, "only once"
    assert profiles.child_env(profiles.load("casey-quinn-0a0a0a"))["JOB_EMPLOYMENT_TYPES"] == "Contract"


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


@pytest.mark.parametrize("argv, live, calls_after_sync", [
    ([], False, [("live",), ("watch", profiles.WATCH_SECONDS, profiles.POLL_SECONDS)]),
    ([], True, [("live",)]),
    (["--once"], True, []),
    (["--full", "--once"], False, []),
])
def test_main_keeps_the_live_link_up_or_polls_unless_once(home, monkeypatch, argv, live, calls_after_sync):
    calls = []
    monkeypatch.setenv("JOB_FEEDBACK_API_TOKEN", "api-token")
    monkeypatch.setattr(profiles, "load_env_file", lambda *a, **k: None)
    monkeypatch.setattr(profiles, "sync", lambda api, full=False: calls.append(("sync", full)) or [])
    monkeypatch.setattr(profiles, "ensure_listener", lambda: calls.append(("live",)) or live)
    monkeypatch.setattr(profiles, "watch", lambda api, seconds, poll: calls.append(("watch", seconds, poll)) or [])
    assert profiles.main(argv) == 0
    assert calls[0] == ("sync", "--full" in argv)
    assert calls[1:] == calls_after_sync
    assert profiles.WATCH_SECONDS + 2 * profiles.POLL_SECONDS <= 300, "a run must end before the next one starts"


def test_a_slow_sync_shortens_the_watch_so_the_next_run_is_not_skipped(home, monkeypatch):
    clock, calls = Clock(), []
    monkeypatch.setenv("JOB_FEEDBACK_API_TOKEN", "api-token")
    monkeypatch.setattr(profiles, "load_env_file", lambda *a, **k: None)
    monkeypatch.setattr(profiles, "ensure_listener", lambda: False)
    monkeypatch.setattr(profiles.time, "monotonic", clock)
    monkeypatch.setattr(profiles, "sync", lambda api, full=False: clock.sleep(200) or [])
    monkeypatch.setattr(profiles, "watch", lambda api, seconds, poll: calls.append(seconds) or [])
    profiles.main([])
    assert calls == [profiles.WATCH_SECONDS - 200]


class FakeSocket:
    """A live link replaying (time, message) events on a Clock; an exception as the message is raised instead."""

    def __init__(self, clock, events):
        self.clock, self.events, self.sent = clock, list(events), []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def recv(self, timeout=None):
        if self.events and self.events[0][0] <= self.clock.now + timeout:
            at, message = self.events.pop(0)
            self.clock.now = max(self.clock.now, at)
            if isinstance(message, Exception):
                raise message
            return message
        self.clock.now += timeout
        raise TimeoutError

    def send(self, message):
        self.sent.append((self.clock.now, message))


class Refused(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.response = type("Response", (), {"status_code": status})()


def listen(api, seconds, clock, links, **kw):
    calls = []

    def connect(url, **options):
        calls.append((url, options))
        link = links.pop(0) if links else OSError("unreachable")
        if isinstance(link, Exception):
            raise link
        return link
    return profiles.listen(api, seconds, connect=connect, clock=clock, sleep=clock.sleep, stamp=kw.pop("stamp", lambda: 1)), calls


def test_the_live_link_syncs_on_connect_and_the_moment_something_is_queued(home, monkeypatch):
    clock, synced = Clock(), []
    monkeypatch.setattr(profiles, "sync", lambda api, full=False: synced.append(clock.now) or [f"synced at {clock.now:.0f}"])
    link = FakeSocket(clock, [(0, '{"flag": ""}'), (40, "pong"), (50, '{"flag": "queue:1:a"}'),
                              (51, '{"flag": "queue:1:a"}'), (70, '{"flag": "queue:2:b"}')])
    result, calls = listen(profiles.Api("https://fb.example.workers.dev", "api-token"), 100, clock, [link])
    assert result == "done"
    assert synced == [0, 50, 70]
    assert calls[0][0] == "wss://fb.example.workers.dev/api/live"
    assert calls[0][1]["additional_headers"]["Authorization"] == "Bearer api-token"
    assert calls[0][1]["additional_headers"]["X-HermitShell-Protocol"] == str(profiles.worker_link.PROTOCOL)
    assert link.sent == [(30, "ping"), (60, "ping"), (90, "ping")]


def test_a_push_that_finds_nothing_yet_is_retried(home, monkeypatch):
    clock, synced, replies = Clock(), [], [[], [], ["admin: done (pause)"]]
    monkeypatch.setattr(profiles, "sync", lambda api, full=False: synced.append(clock.now) or replies.pop(0))
    result, _ = listen(profiles.Api("https://fb.example", "t"), 100, clock,
                       [FakeSocket(clock, [(0, '{"flag": "queue:1:a"}')])])
    assert result == "done"
    assert synced == [0, 5, 20]


def test_the_live_link_reconnects_after_a_drop_and_catches_up(home, monkeypatch):
    clock, synced = Clock(), []
    monkeypatch.setattr(profiles, "sync", lambda api, full=False: synced.append(clock.now) or ["ok"])
    first = FakeSocket(clock, [(0, '{"flag": "queue:1:a"}'), (10, ConnectionResetError())])
    second = FakeSocket(clock, [(15, '{"flag": "queue:1:a"}'), (20, '{"flag": "queue:2:b"}')])
    result, calls = listen(profiles.Api("https://fb.example", "t"), 60, clock, [first, second])
    assert result == "done" and len(calls) == 2
    assert synced == [0, 20]
    assert clock.sleeps == [5]


def test_a_worker_without_the_live_link_is_left_to_polling(home, monkeypatch):
    monkeypatch.setattr(profiles, "sync", lambda api, full=False: [])
    for status in (401, 403):
        result, calls = listen(profiles.Api("https://fb.example", "t"), 600, Clock(), [Refused(status)])
        assert result == "unavailable" and len(calls) == 1
    clock = Clock()
    result, calls = listen(profiles.Api("https://fb.example", "t"), 3600, clock, [Refused(404)] * 10)
    assert result == "unavailable" and len(calls) == profiles.LIVE_FAILURES
    assert clock.sleeps == [5, 10, 20, 40, 60]


def test_a_worker_deployed_seconds_ago_is_waited_for(home, monkeypatch):
    clock, synced = Clock(), []
    monkeypatch.setattr(profiles, "sync", lambda api, full=False: synced.append(clock.now) or ["ok"])
    link = FakeSocket(clock, [(15, '{"flag": ""}')])
    result, calls = listen(profiles.Api("https://fb.example", "t"), 60, clock, [Refused(404), Refused(404), link])
    assert result == "done" and len(calls) == 3
    assert clock.sleeps == [5, 10] and synced == [15]


def test_a_listener_hands_over_when_its_code_changes(home):
    stamps = iter([1, 2])
    result, calls = listen(profiles.Api("https://fb.example", "t"), 600, Clock(), [], stamp=lambda: next(stamps))
    assert result == "updated" and calls == []


def test_the_cron_run_keeps_one_listener_going_and_polls_without_one(home, monkeypatch):
    spawned = []

    def spawn(cmd, **kw):
        spawned.append(cmd)
    monkeypatch.setattr(profiles, "listener_running", lambda: False)
    assert profiles.ensure_listener(spawn) is True
    assert spawned[0][1:] == [str(Path(profiles.__file__).resolve()), "listen"]
    assert (profiles.STATE_DIR / "profiles-live.log").is_file()
    monkeypatch.setattr(profiles, "listener_running", lambda: True)
    assert profiles.ensure_listener(spawn) is True and len(spawned) == 1
    monkeypatch.setenv("JOB_PROFILES_LIVE", "off")
    assert profiles.ensure_listener(spawn) is False


@pytest.mark.parametrize("result, handed_over", [("unavailable", False), ("updated", True), ("done", True)])
def test_a_finished_listener_hands_over_or_leaves_it_to_polling(home, monkeypatch, result, handed_over):
    spawned = []
    monkeypatch.setattr(profiles, "listen", lambda api, seconds: result)
    monkeypatch.setattr(profiles, "listener_running", lambda: False)
    assert profiles.run_listener(profiles.Api("https://fb.example", "t"), spawn=lambda cmd, **kw: spawned.append(cmd)) == 0
    assert bool(spawned) is handed_over
    assert profiles.ensure_listener(lambda cmd, **kw: spawned.append(cmd)) is handed_over


def test_the_live_link_log_and_rotated_logs_are_scrubbed_too(home, monkeypatch):
    monkeypatch.setattr(profiles.hc, "APP_HOME", home[0])
    (home[0] / "state").mkdir(parents=True, exist_ok=True)
    (home[0] / "profiles").mkdir(parents=True, exist_ok=True)
    files = [home[0] / "state" / "profiles-live.log", home[0] / "state" / "profiles-live.log.1",
             home[0] / "profiles" / "runs.log", home[0] / "profiles" / "runs.log.1"]
    for f in files:
        f.write_text("signup: done (Sam Lee)\n", encoding="utf-8")
    assert set(files) <= set(profiles.log_files())
    assert profiles.scrub_logs(["Sam Lee"]) == len(files)
    assert all(f.read_text(encoding="utf-8") == "signup: done ([deleted])\n" for f in files)


def test_admin_can_go_back_to_the_env_keys_and_delete(home):
    profiles.sync(FakeApi([signup()]))
    pid = "sam-lee-456789"
    profiles.sync(FakeApi([{"id": "queue:3:b", "type": "admin", "action": "api_keys", "firecrawl": ["fc-global-longer0001"]}]))
    assert profiles.child_env(profiles.load(pid))["FIRECRAWL_API_KEY"] == "fc-global-longer0001"
    profiles.sync(FakeApi([{"id": "queue:7:f", "type": "admin", "action": "api_keys", "clear": ["firecrawl"]}]))
    environ = profiles.child_env(profiles.load(pid))
    assert "FIRECRAWL_API_KEY" not in profiles.dashboard_env()
    assert environ.get("FIRECRAWL_API_KEY") != "fc-global-longer0001"
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


def test_a_cloud_model_key_from_the_dashboard_is_used_and_shown_masked(home):
    api = FakeApi([{"id": "queue:4:c", "type": "admin", "action": "model_keys", "provider": "openrouter",
                    "key": "sk-or-v1-test-000000001", "model": "meta-llama/llama-3.3-70b-instruct:free"}])
    profiles.sync(api)
    assert profiles.os.environ["OPENROUTER_API_KEY"] == "sk-or-v1-test-000000001"
    assert profiles.dashboard_env()["OPENROUTER_MODEL"] == "meta-llama/llama-3.3-70b-instruct:free"
    status = api.statuses[-1]
    assert status["models"]["openrouter"]["source"] == "dashboard"
    assert status["models"]["openrouter"]["model"] == "meta-llama/llama-3.3-70b-instruct:free"
    assert status["models"]["openrouter"]["keys"] == [{"hint": "sk-...0001", "role": "main"}]
    assert status["llm"]["cloud"] == ["openrouter"] and status["llm"]["order"] == "cloud"
    assert "sk-or-v1-test-000000001" not in json.dumps(status)
    profiles.sync(FakeApi([{"id": "queue:5:d", "type": "admin", "action": "model_keys", "order": "local"}]))
    assert profiles.os.environ["LLM_ORDER"] == "local"
    profiles.sync(FakeApi([{"id": "queue:6:e", "type": "admin", "action": "model_keys", "provider": "openrouter", "clear": True}]))
    assert "OPENROUTER_API_KEY" not in profiles.dashboard_env() and "OPENROUTER_MODEL" not in profiles.dashboard_env()


@pytest.mark.parametrize("item", [
    {"provider": "openrouter", "key": "has spaces in it 0001"},
    {"provider": "openai", "key": "sk-test-000000000001"},
    {"provider": "featherless", "model": "../../etc/passwd"},
    {"order": "sideways"},
    {"provider": "openrouter", "clear": "yes"},
])
def test_a_bad_model_setting_changes_nothing(home, item):
    with pytest.raises(profiles.ProfileError):
        profiles.apply_model_keys(item)
    assert not any(k.startswith(("OPENROUTER_", "OPENAI_", "FEATHERLESS_", "LLM_")) for k in profiles.dashboard_env())


def test_the_status_shows_the_local_model_and_the_server(home, monkeypatch):
    monkeypatch.setattr(profiles.hc, "suggested_model", lambda: "qwen2.5:1.5b-instruct")
    monkeypatch.delenv("OLLAMA_MODEL", raising=False)
    monkeypatch.delenv("JOB_SCANNER_MODEL", raising=False)
    status = profiles.status_payload()
    assert status["llm"]["local"]["suggested"] == "qwen2.5:1.5b-instruct"
    assert status["llm"]["cloud"] == [] and set(status["models"]) == set(profiles.llm_providers.PROVIDERS)
    server = status["server"]
    assert server["cpu"]["cores"] >= 1 and "total" in server["ram_mb"] and isinstance(server["gpus"], list)


@pytest.fixture
def sealing(home, monkeypatch):
    """The server's sealing key pair in this test's state folder, and seal() as the Worker's seal.js does it."""
    import base64

    import worker_seal
    monkeypatch.setattr(profiles.hc, "STATE_DIR", home[0] / "state")
    monkeypatch.setattr(worker_seal, "KEY_BITS", 2048)
    worker_seal._public.clear()

    def seal_text(text, field):
        blob = worker_seal.seal(text.encode(), worker_seal.field_aad(field), worker_seal.public_key()["spki"])
        return worker_seal.PREFIX + base64.urlsafe_b64encode(blob).decode().rstrip("=")

    def seal_file(data, key):
        return worker_seal.seal(data, key, worker_seal.public_key()["spki"])
    return seal_text, seal_file


def test_the_status_carries_the_protocol_and_the_key_the_worker_seals_with(sealing):
    import worker_seal
    status = profiles.status_payload()
    assert status["protocol"] == profiles.worker_link.PROTOCOL
    assert status["seal"] == worker_seal.public_key() and set(status["seal"]) == {"alg", "kid", "spki"}
    assert status["worker_protocol"] is None
    assert "PRIVATE" not in json.dumps(status)


def test_sealed_dashboard_secrets_are_opened_before_they_apply(sealing):
    seal_text, _ = sealing
    api = FakeApi([
        {"id": "queue:2:a", "type": "admin", "action": "api_keys", "sealed": ["firecrawl", "tavily"],
         "firecrawl": [seal_text("fc-sealed-longer001", "firecrawl")], "tavily": seal_text("tvly-sealed-longer-01", "tavily")},
        {"id": "queue:3:b", "type": "admin", "action": "email", "host": "smtp.example.com", "port": "587",
         "user": "alex@example.com", "sealed": ["password"], "password": seal_text("abcd efgh ijkl mnop", "password")},
    ])
    assert profiles.sync(api) == ["admin: done (api_keys)", "admin: done (email)"]
    saved = profiles.dashboard_env()
    assert (saved["FIRECRAWL_API_KEY"], saved["TAVILY_API_KEY"]) == ("fc-sealed-longer001", "tvly-sealed-longer-01")
    assert saved["SMTP_PASSWORD"] == "abcd efgh ijkl mnop"
    assert "sealed:" not in json.dumps(saved)


def test_a_sealed_value_that_cant_be_opened_is_rejected_and_nothing_applies(sealing):
    seal_text, _ = sealing
    swapped = {"id": "queue:2:a", "type": "admin", "action": "api_keys", "sealed": ["tavily"],
               "tavily": seal_text("tvly-sealed-longer-01", "firecrawl")}
    plain = {"id": "queue:3:b", "type": "admin", "action": "api_keys", "sealed": ["tavily"], "tavily": "tvly-plain-longer-01"}
    api = FakeApi([swapped, plain])
    report = profiles.sync(api)
    assert report[0].startswith("admin: rejected (sealed value could not be opened")
    assert report[1] == "admin: rejected (tavily was meant to be sealed but isn't)"
    assert "TAVILY_API_KEY" not in profiles.dashboard_env()
    assert api.acked == ["queue:2:a", "queue:3:b"]


def test_a_sealed_cv_file_and_cv_text_build_the_profile(home, sealing):
    seal_text, seal_file = sealing
    pdf = letter_pdf.letter_pdf("Sam Lee", "sam@example.com", "1 May 2026", [], "Curriculum vitae", "Profile",
                                [CV.replace("\n", " ")])
    cv = {"key": "cvfile:1", "kind": "pdf", "name": "cv.pdf", "size": len(pdf), "sealed": True}
    profiles.sync(FakeApi([signup(cv_text="", cv=cv)], {"cvfile:1": seal_file(pdf, "cvfile:1")}))
    d = home[0] / "profiles" / "sam-lee-456789"
    assert "Power BI dashboards" in " ".join((d / "cv.txt").read_text().split())
    item = {"id": "queue:2:0c", "type": "admin", "action": "cv", "u": "sam-lee-456789", "cv": None,
            "sealed": ["cv_text"], "cv_text": seal_text(CV.replace("Data analyst", "BI developer"), "cv_text")}
    profiles.sync(FakeApi([item]))
    assert "BI developer" in (d / "cv.txt").read_text()


def test_a_cv_file_sealed_for_another_upload_is_refused(home, sealing):
    _, seal_file = sealing
    cv = {"key": "cvfile:1", "kind": "pdf", "name": "cv.pdf", "size": 9, "sealed": True}
    api = FakeApi([signup(cv_text="", cv=cv)], {"cvfile:1": seal_file(b"%PDF-1.4 other", "cvfile:2")})
    assert profiles.sync(api)[0].startswith("signup: rejected (the CV file could not be opened: sealed value could not be opened")
    assert not (home[0] / "profiles" / "sam-lee-456789").exists()


def test_the_server_load_and_request_counts_alone_do_not_resend_the_status(home, monkeypatch):
    api = FakeApi()
    profiles.ensure_owner()
    profiles.push_status(api)
    real = profiles.status_payload

    def busier():
        payload = real()
        payload["server"]["load"] = 99.0
        payload["llm"]["last"] = {"provider": "ollama", "model": "m", "at": 1}
        payload["models"]["openrouter"]["today"] = 42
        payload["usage"] = {"days": 7, "tasks": [{"task": "rating", "period": {"calls": 9}}]}
        return payload

    monkeypatch.setattr(profiles, "status_payload", busier)
    profiles.push_status(api)
    assert len(api.statuses) == 1


def test_status_carries_the_tokens_each_task_used(home, monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_USAGE_FILE", str(tmp_path / "usage.json"))
    profiles.ensure_owner()
    assert profiles.status_payload()["usage"]["tasks"] == []
    profiles.llm_usage.record("letter", 5200, 640, 15000)
    usage = profiles.status_payload()["usage"]
    assert usage["days"] == 7 and usage["tasks"][0]["task"] == "letter"
    assert usage["tasks"][0]["today"]["in"] == 5200 and usage["tasks"][0]["period"]["out"] == 640


def test_status_is_only_pushed_when_it_changes(home, monkeypatch):
    api = FakeApi()
    profiles.sync(FakeApi([signup()]))
    (profiles.PROFILES_DIR / ".status").unlink()
    profiles.push_status(api)
    profiles.push_status(api)
    assert len(api.statuses) == 1
    profiles.set_status("sam-lee-456789", "paused")
    profiles.push_status(api)
    assert len(api.statuses) == 2 and api.statuses[-1]["profiles"][1]["status"] == "paused"
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


class FakeScheduler:
    """`scheduler.py` changing a jobs.json in the test's home the way it does."""

    def __init__(self, path, owner_schedule="0 8 * * *"):
        self.path, self.calls = path, []
        path.parent.mkdir(parents=True, exist_ok=True)
        self.save([{"id": "setup1", "name": "job-scanner", "script": "job_scanner.py", "workdir": None,
                    "schedule": {"kind": "cron", "expr": owner_schedule}, "enabled": True, "state": "scheduled"}])

    def jobs(self):
        return json.loads(self.path.read_text())["jobs"]

    def save(self, jobs):
        self.path.write_text(json.dumps({"jobs": jobs}))

    def job(self, name):
        return next((j for j in self.jobs() if j["name"] == name), None)

    def __call__(self, cmd, **kwargs):
        assert cmd[:2] == [sys.executable, str(profiles.SCRIPT_DIR / "scheduler.py")] and kwargs["timeout"] == 60
        verb, rest = cmd[2], cmd[3:]
        self.calls.append([verb, *rest])
        jobs = self.jobs()
        opt = lambda flag: rest[rest.index(flag) + 1]  # noqa: E731
        if verb == "create":
            jobs.append({"id": f"job{len(self.calls)}", "name": opt("--name"), "script": opt("--script"),
                         "workdir": opt("--workdir"), "schedule": {"kind": "cron", "expr": rest[0]},
                         "enabled": "--paused" not in rest, "state": "paused" if "--paused" in rest else "scheduled"})
        else:
            job = next(j for j in jobs if j["id"] == rest[0])
            if verb == "edit":
                job["schedule"]["expr"] = opt("--schedule")
            elif verb in ("pause", "resume"):
                job["enabled"], job["state"] = verb == "resume", "scheduled" if verb == "resume" else "paused"
            elif verb == "remove":
                jobs.remove(job)
        self.save(jobs)
        return subprocess.CompletedProcess(cmd, 0, "", "")


@pytest.fixture
def cron(home, monkeypatch):
    fake = FakeScheduler(home[0] / "cron" / "jobs.json")
    monkeypatch.setattr(profiles.subprocess, "run", fake)
    return fake


def admin(action, u, n=2, **extra):
    return {"id": f"queue:{n}:a{n}", "type": "admin", "action": action, "u": u, **extra}


def test_every_profile_gets_its_own_daily_job(home, cron):
    profiles.sync(FakeApi([signup()]))
    sam = cron.job("vacancy-report-sam-lee-456789")
    assert sam["script"] == "profile_report.py" and sam["enabled"]
    assert sam["workdir"] == str((profiles.PROFILES_DIR / "sam-lee-456789").resolve())
    assert sam["schedule"]["expr"] == "15 8 * * *"
    profiles.sync(FakeApi([signup(id="queue:9:0a0a0a", name="Kim Park", email="kim@example.com")]))
    assert cron.job("vacancy-report-kim-park-0a0a0a")["schedule"]["expr"] == "30 8 * * *"
    calls = len(cron.calls)
    profiles.schedule_reports()
    assert len(cron.calls) == calls

    profiles.sync(FakeApi([admin("pause", "kim-park-0a0a0a")]))
    assert cron.job("vacancy-report-kim-park-0a0a0a")["state"] == "paused"
    profiles.sync(FakeApi([admin("resume", "kim-park-0a0a0a", 3)]))
    assert cron.job("vacancy-report-kim-park-0a0a0a")["enabled"] is True
    profiles.sync(FakeApi([admin("delete", "sam-lee-456789", 4)]))
    assert cron.job("vacancy-report-sam-lee-456789") is None
    assert [j["name"] for j in cron.jobs()] == ["job-scanner", "vacancy-report-kim-park-0a0a0a"]


def test_the_scheduler_runs_beside_the_scripts_and_its_failures_are_logged(home, capsys):
    seen = []

    def runner(cmd, **kwargs):
        seen.append(cmd)
        return subprocess.CompletedProcess(cmd, len(seen) - 1, "", "no job 'abc'")
    assert profiles.scheduler_cmd(["list"], runner) is True
    assert profiles.scheduler_cmd(["pause", "abc"], runner) is False
    script = str(profiles.SCRIPT_DIR / "scheduler.py")
    assert seen == [[sys.executable, script, "list"], [sys.executable, script, "pause", "abc"]]
    assert "scheduler pause failed: no job 'abc'" in capsys.readouterr().err
    assert profiles.scheduler_cmd(["list"], lambda cmd, **k: (_ for _ in ()).throw(FileNotFoundError())) is False


def test_the_real_scheduler_takes_every_command_profiles_sends(home, monkeypatch):
    """profiles.py against scheduler.py itself, in-process: create, edit, pause, resume and remove."""
    import scheduler
    cron_dir = home[0] / "cron"
    for name, value in {"CRON_DIR": cron_dir, "JOBS_FILE": cron_dir / "jobs.json", "LOCK_DIR": cron_dir / "locks",
                        "OUTPUT_DIR": cron_dir / "output", "HEARTBEAT": cron_dir / "heartbeat.json"}.items():
        monkeypatch.setattr(scheduler, name, value)
    monkeypatch.setattr(scheduler.hc, "APP_HOME", home[0])
    monkeypatch.setattr(profiles, "CRON_FILE", cron_dir / "jobs.json")
    scheduler.create("0 8 * * *", "Daily", "job-scanner", "job_scanner.py")

    def run(cmd, **kwargs):
        code = scheduler.main(cmd[2:])
        return subprocess.CompletedProcess(cmd, code, "", "")
    monkeypatch.setattr(profiles.subprocess, "run", run)
    profiles.sync(FakeApi([signup()]))
    jobs = {j["name"]: j for j in scheduler.load_jobs()}
    sam = jobs["vacancy-report-sam-lee-456789"]
    assert sam["workdir"] == str((profiles.PROFILES_DIR / "sam-lee-456789").resolve()) and sam["enabled"]
    assert scheduler.expression(sam) == "15 8 * * *"
    profiles.sync(FakeApi([admin("profile", "sam-lee-456789", report={"time": "06:45", "days": "weekdays"}),
                           admin("pause", "sam-lee-456789", 3)]))
    sam = {j["name"]: j for j in scheduler.load_jobs()}["vacancy-report-sam-lee-456789"]
    assert scheduler.expression(sam) == "45 6 * * 1-5" and not scheduler.enabled(sam)
    profiles.sync(FakeApi([admin("delete", "sam-lee-456789", 4)]))
    assert [j["name"] for j in scheduler.load_jobs()] == ["job-scanner"]


def test_the_owners_report_runs_the_others_only_without_their_own_jobs(home, monkeypatch):
    profiles.sync(FakeApi([signup()]))
    assert [p["id"] for p in profiles.others("job_scanner.py", [])] == ["sam-lee-456789"]
    fake = FakeScheduler(profiles.CRON_FILE)
    monkeypatch.setattr(profiles.subprocess, "run", fake)
    profiles.schedule_reports()
    assert profiles.others("job_scanner.py", []) == []
    assert [p["id"] for p in profiles.others("job_scanner.py", ["--weekly"])] == ["sam-lee-456789"]
    assert [p["id"] for p in profiles.others("cover_letter.py", [])] == ["sam-lee-456789"]
    monkeypatch.setenv("JOB_PROFILE_ID", "sam-lee-456789")
    assert profiles.spawn_others("job_scanner.py", ["--weekly"]) is False


def test_the_dashboard_sets_each_recruits_report_time_and_never_the_admins(home, cron):
    profiles.sync(FakeApi([signup()]))
    api = FakeApi([admin("profile", "sam-lee-456789", report={"time": "06:45", "days": "weekdays"}),
                   admin("profile", "owner", 3, report={"time": "07:30"})])
    profiles.sync(api)
    assert cron.job("vacancy-report-sam-lee-456789")["schedule"]["expr"] == "45 6 * * 1-5"
    assert cron.job("job-scanner")["schedule"]["expr"] == "0 8 * * *"
    assert "schedule" not in profiles.load("sam-lee-456789") and "schedule" not in profiles.load("owner")
    rows = {p["id"]: p for p in api.statuses[-1]["profiles"]}
    assert rows["sam-lee-456789"]["report"] == {"time": "06:45", "days": "weekdays", "schedule": "45 6 * * 1-5",
                                                "job": True, "pending": False}
    assert "report" not in rows["owner"] and "job" not in rows["owner"]
    assert api.statuses[-1]["problems"][-1]["error"] == profiles.STAFF
    profiles.sync(FakeApi([admin("profile", "sam-lee-456789", 4, report={"days": "daily"})]))
    assert cron.job("vacancy-report-sam-lee-456789")["schedule"]["expr"] == "45 6 * * *"


@pytest.mark.parametrize("report", [{"time": "25:00"}, {"time": "8am"}, {"time": "08:00", "days": "sundays"},
                                    {"time": "08:00 * * * 1; rm -rf /"}])
def test_a_bad_report_time_is_rejected(home, cron, report):
    profiles.sync(FakeApi([signup()]))
    api = FakeApi([admin("profile", "sam-lee-456789", report=report)])
    profiles.sync(api)
    assert api.statuses[-1]["problems"][-1]["error"] == "invalid daily report time"
    assert cron.job("vacancy-report-sam-lee-456789")["schedule"]["expr"] == "15 8 * * *"


def test_without_the_scheduler_the_report_time_waits_and_nothing_is_scheduled(home, monkeypatch):
    monkeypatch.setattr(profiles.subprocess, "run", lambda *a, **k: pytest.fail("scheduler called"))
    api = FakeApi([signup(), admin("profile", "sam-lee-456789", 3, report={"time": "09:00"})])
    profiles.sync(api)
    payload = api.statuses[-1]
    sam = next(p for p in payload["profiles"] if p["id"] == "sam-lee-456789")
    assert payload["scheduler"] is False
    assert sam["report"] == {"time": "09:00", "days": "daily", "schedule": "0 9 * * *", "job": False, "pending": True}


def test_send_now_starts_that_profiles_report_in_the_background(home, monkeypatch):
    started = []
    monkeypatch.setattr(profiles.subprocess, "Popen", lambda cmd, **k: started.append((cmd, k)))
    profiles.sync(FakeApi([signup()]))
    api = FakeApi([admin("send_now", "sam-lee-456789"), admin("send_now", "owner", 3)])
    report = profiles.sync(api)
    cmd, kwargs = started[0]
    assert cmd[1:] == [str(Path(profiles.__file__).resolve()), "report", "--now", "sam-lee-456789"]
    assert kwargs["start_new_session"] and kwargs["stdin"] == subprocess.DEVNULL
    assert len(started) == 1 and report[-1] == f"admin: rejected ({profiles.STAFF})"
    profiles.write_json(profiles.scan_marker("sam-lee-456789"), {"pid": profiles.os.getpid(), "at": profiles.time.time()})
    profiles.sync(FakeApi([admin("send_now", "sam-lee-456789", 4)]))
    assert len(started) == 1


def test_a_report_tells_the_dashboard_it_is_scanning_then_when_it_ran(home, monkeypatch):
    api = FakeApi()
    monkeypatch.setattr(profiles, "api_from_env", lambda: api)
    monkeypatch.setattr(profiles, "_alive", lambda pid: pid == profiles.os.getpid())
    profiles.sync(FakeApi([signup()]))
    profiles.set_status("sam-lee-456789", "paused")
    seen = []

    def runner(cmd, env, cwd, timeout):
        row = next(p for p in api.statuses[-1]["profiles"] if p["id"] == "sam-lee-456789")
        seen.append((cmd[1:], env["JOB_PROFILE_ID"], env.get("JOB_SCANNER_EMAIL_WHEN_EMPTY"), row["scanning"]))
        return subprocess.CompletedProcess(cmd, 0)

    assert profiles.run_report("sam-lee-456789", runner=runner) == 0 and seen == []
    assert profiles.run_report("sam-lee-456789", now=True, runner=runner) == 0
    assert seen[0][:3] == ([str(profiles.SCRIPT_DIR / "job_scanner.py")], "sam-lee-456789", "1") and seen[0][3] > 1e12
    row = next(p for p in api.statuses[-1]["profiles"] if p["id"] == "sam-lee-456789")
    assert row["scanning"] is None and row["last_run"] > 1e12
    assert not profiles.scan_marker("sam-lee-456789").exists()


def _owner_search(home, monkeypatch):
    tmp = home[0]
    (tmp / "owner_profile.md").write_text("# Candidate profile\n\nName: Alex Morgan\n")
    (tmp / "owner_cv.txt").write_text("Alex Morgan, data engineer at Contoso")
    monkeypatch.setenv("COVER_LETTER_CV_FILE", str(tmp / "owner_cv.txt"))
    monkeypatch.setenv("JOB_TARGET_TITLES", "Data Engineer||Analytics Engineer")
    monkeypatch.setenv("JOB_EMPLOYMENT_TYPES", "Permanent")
    state = tmp / "state"
    (state / "cover_letters").mkdir(parents=True)
    (state / "cover_letters" / "letter.pdf").write_bytes(b"%PDF")
    (state / "job_scanner_seen.json").write_text('{"job-1": 1}')
    _rate_a_job("owner", 1_790_000_000.0)
    monkeypatch.setattr(profiles.secrets, "token_hex", lambda n: "0d0d0d")
    return "alex-morgan-0d0d0d"


def test_the_admins_own_job_search_moves_once_to_a_recruit(home, monkeypatch):
    pid = _owner_search(home, monkeypatch)
    api = FakeApi()
    profiles.sync(api)
    moved = profiles.load(pid)
    assert (moved["name"], moved["email"], moved["status"]) == ("Alex Morgan", "owner@example.com", "active")
    assert moved["titles"] == ["Data Engineer", "Analytics Engineer"] and moved["from_owner"] is True
    d = profiles.profile_dir(pid)
    assert "Name: Alex Morgan" in (d / "job_profile.md").read_text()
    assert "Contoso" in (d / "cv.txt").read_text()
    settings = json.loads((d / "settings.json").read_text())
    assert settings["JOB_EMPLOYMENT_TYPES"] == "Permanent" and settings["JOB_REGION_NAME"] == "Belfast"
    assert not {"ALERT_EMAIL", "COVER_LETTER_NAME", "COVER_LETTER_CV_FILE", "JOB_PROFILE_FILE"} & set(settings)
    assert (d / "state" / "cover_letters" / "letter.pdf").is_file()
    assert json.loads((d / "state" / "job_scanner_seen.json").read_text()) == {"job-1": 1}
    from job_tracker import Tracker
    with Tracker(profiles.tracker_file(pid)) as tracker:
        assert tracker.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    assert profiles.load("owner")["recruit"] == pid and profiles.owner_recruit() == pid
    assert (home[0] / "owner_profile.md").is_file(), "the admin's files are left where they were"
    rows = {p["id"]: p for p in api.statuses[-1]["profiles"]}
    assert rows["owner"]["recruit"] == pid and rows["owner"]["has_cv"] is False and "job" not in rows["owner"]
    assert rows[pid]["has_cv"] and rows[pid]["job"]["types"] == ["Permanent"]
    profiles.sync(FakeApi())
    assert [p["id"] for p in profiles.all_profiles()] == ["owner", pid], "moved only once"


def test_the_admins_search_is_not_moved_without_an_address_or_while_it_runs(home, monkeypatch):
    _owner_search(home, monkeypatch)
    monkeypatch.setenv("ALERT_EMAIL", "")
    monkeypatch.setenv("SMTP_USER", "")
    profiles.write_json(profiles.profile_dir("owner") / "profile.json",
                        {"id": "owner", "owner": True, "name": "Alex Morgan", "email": "", "status": "active"})
    assert profiles.move_owner_search() == ""
    monkeypatch.setenv("ALERT_EMAIL", "owner@example.com")
    profiles.write_json(profiles.scan_marker("owner"), {"pid": profiles.os.getpid(), "at": profiles.time.time()})
    monkeypatch.setattr(profiles, "_alive", lambda pid: True)
    assert profiles.move_owner_search() == ""
    assert [p["id"] for p in profiles.all_profiles()] == ["owner"]


def test_the_example_profile_is_not_a_job_search_to_move(home, monkeypatch):
    example = profiles.SCRIPT_DIR / "job_profile.example.md"
    if not example.is_file():
        pytest.skip("no example profile")
    (home[0] / "owner_profile.md").write_bytes(example.read_bytes())
    assert profiles.move_owner_search() == ""


def test_an_old_unsubscribe_link_pauses_the_admins_moved_search(home, monkeypatch):
    tmp, sent = home
    pid = _owner_search(home, monkeypatch)
    profiles.sync(FakeApi())
    sent.clear()
    profiles.sync(FakeApi([{"id": "queue:3:b", "type": "unsubscribe", "u": ""}]))
    assert profiles.load(pid)["status"] == "paused" and profiles.load("owner")["status"] == "active"
    assert [m["to"] for m in sent] == ["owner@example.com"] and f"--resume {pid}" in sent[0]["text"]


def test_the_setups_run_only_starts_the_recruits_when_the_admin_is_staff(home, monkeypatch):
    pid = _owner_search(home, monkeypatch)
    profiles.sync(FakeApi())
    calls = []
    monkeypatch.setattr(profiles, "sync_feedback", lambda tracker, url, token, **k: calls.append(
        (tracker.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], url, token, k)) or (2, None))
    assert profiles.staff_run("job_scanner.py", full=True) is True
    # Into the moved search's tracker (the one holding the admin's jobs), as answers filed under the admin.
    assert calls == [(1, "https://fb.example.workers.dev", "test-token", {"full": True})]
    monkeypatch.setenv("JOB_PROFILE_ID", pid)
    assert profiles.staff_run("job_scanner.py") is False, "a recruit's own run carries on"
    monkeypatch.delenv("JOB_PROFILE_ID")
    monkeypatch.setenv("JOB_FEEDBACK_API_TOKEN", "")
    assert profiles.staff_run("job_scanner.py") is False, "without the dashboard it is the owner's own search"


def test_the_admin_has_no_report_of_their_own(home, monkeypatch):
    monkeypatch.setattr(profiles, "api_from_env", lambda: None)
    profiles.ensure_owner()
    with pytest.raises(profiles.ProfileError, match="staff"):
        profiles.run_report("owner", runner=lambda *a, **k: pytest.fail("the admin's report ran"))


def test_a_scheduled_job_runs_the_report_of_the_folder_it_starts_in(home, monkeypatch):
    profiles.sync(FakeApi([signup()]))
    ran = []
    monkeypatch.setattr(profiles, "run_report", lambda pid, now=False: ran.append((pid, now)) or 0)
    monkeypatch.chdir(profiles.PROFILES_DIR / "sam-lee-456789")
    assert profiles.main(["report"]) == 0 and ran == [("sam-lee-456789", False)]
    assert profiles.main(["report", "--now", "owner"]) == 0 and ran[-1] == ("owner", True)
    monkeypatch.chdir(home[0])
    assert profiles.main(["report"]) == 2 and len(ran) == 2


def _rate_a_job(pid, at):
    from job_tracker import Tracker
    with Tracker(profiles.tracker_file(pid)) as tracker:
        tracker.upsert_job(f"job-{at}", {"title": "Data Analyst", "fit": 8, "employer": "Contoso"}, True, at)


def test_stats_go_to_the_worker_when_they_change_and_go_with_the_profile(home, monkeypatch):
    clock = [1_790_000_000.0]
    monkeypatch.setattr(profiles.time, "time", lambda: clock[0])
    api = FakeApi([signup()])
    profiles.sync(api)
    pid = "sam-lee-456789"
    assert sorted(p for p, _ in api.pushed) == [pid], "the admin is staff and has no stats page"
    assert all(data["days"] == {} and data["v"] == 1 for _, data in api.pushed)

    api.pushed.clear()
    _rate_a_job(pid, clock[0])
    profiles.push_stats(api)
    assert api.pushed == []
    profiles.push_stats(api, now_for=pid)
    assert [p for p, _ in api.pushed] == [pid]
    assert sum(row[profiles.profile_stats.FIELDS.index("sent")] for row in api.pushed[0][1]["days"].values()) == 1

    api.pushed.clear()
    clock[0] += profiles.STATS_EVERY + 1
    profiles.push_stats(api)
    assert api.pushed == []
    _rate_a_job(pid, clock[0])
    profiles.push_stats(api)
    assert [p for p, _ in api.pushed] == [pid]

    deleting = FakeApi([{"id": "queue:2:a", "type": "admin", "action": "delete", "u": pid}])
    profiles.sync(deleting)
    assert deleting.pushed == [(pid, None)]
    assert pid not in json.loads((profiles.PROFILES_DIR / ".stats.json").read_text())


def test_a_finished_report_sends_its_stats_at_once(home, monkeypatch):
    api = FakeApi()
    monkeypatch.setattr(profiles, "api_from_env", lambda: api)
    profiles.sync(FakeApi([signup()]))
    pid = "sam-lee-456789"
    profiles.push_stats(api)
    api.pushed.clear()

    def runner(cmd, env, cwd, timeout):
        _rate_a_job(pid, profiles.time.time())
        return subprocess.CompletedProcess(cmd, 0)

    assert profiles.run_report(pid, now=True, runner=runner) == 0
    assert [p for p, _ in api.pushed] == [pid]


def test_stats_that_cannot_be_read_or_sent_are_retried_later(home, monkeypatch, capsys):
    class Down(FakeApi):
        def stats(self, pid, data):
            raise requests.ConnectionError("down")

    profiles.sync(FakeApi([signup()]), full=True)
    (profiles.PROFILES_DIR / ".stats.json").unlink()
    pid = "sam-lee-456789"
    profiles.tracker_file(pid).parent.mkdir(parents=True, exist_ok=True)
    profiles.tracker_file(pid).write_bytes(b"not a database")
    profiles.push_stats(FakeApi())
    assert f"Could not read the stats of {pid}" in capsys.readouterr().err
    profiles.tracker_file(pid).unlink()
    profiles.push_stats(Down())
    assert f"Could not send the stats of {pid}" in capsys.readouterr().err
    assert json.loads((profiles.PROFILES_DIR / ".stats.json").read_text()) == {}


def test_term_regex_keeps_symbols():
    rx = profiles.re.compile(profiles.term_regex(["C#", "Power BI", ".NET"]), profiles.re.I)
    assert rx.search("C# developer") and rx.search("power bi analyst") and rx.search("ASP.NET Core")
    assert not rx.search("C developer")


def test_cli_list_and_delete(home, capsys):
    profiles.sync(FakeApi([signup()]))
    assert profiles.main(["--list"]) == 0
    out = capsys.readouterr().out
    assert "sam-lee-456789" in out and "owner" in out
    assert profiles.main(["--assign", "sam-lee-456789", " Admin "]) == 0
    assert capsys.readouterr().out == "sam-lee-456789: recruit of admin.\n"
    assert profiles.load("sam-lee-456789")["recruiter"] == "admin"
    assert profiles.main(["--list"]) == 0
    assert next(line for line in capsys.readouterr().out.splitlines() if line.startswith("sam-lee-456789")).split()[2] == "admin"
    assert profiles.main(["--assign", "owner", "admin"]) == 1
    assert profiles.main(["--assign", "nobody", "admin"]) == 1
    assert profiles.main(["--assign", "sam-lee-456789", ""]) == 0
    assert "recruiter" not in profiles.load("sam-lee-456789")
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


# --------------------------------------------------------------------------- the dashboard's task list

def _request(pid, event_id, action="cover_letter", at=1_790_000_000.0):
    from job_tracker import Tracker
    with Tracker(profiles.tracker_file(pid)) as tracker:
        tracker.upsert_job("k1", {"title": "Data Analyst", "employer": "Contoso", "fit": 8}, True, at)
        tracker.add_event(event_id, "k1", action, reason="mention my SQL work, call 07700 900123", at=at)


def test_the_status_lists_running_reports_and_waiting_requests(home, monkeypatch):
    monkeypatch.setattr(profiles, "_alive", lambda pid: pid == profiles.os.getpid())
    profiles.sync(FakeApi([signup()]))
    pid = "sam-lee-456789"
    sam = profiles.load(pid)
    profiles.save({**sam, "last_duration": 900})
    profiles.write_json(profiles.scan_marker(pid), {"pid": profiles.os.getpid(), "at": profiles.time.time(), "trigger": "dashboard"})
    monkeypatch.setenv("JOB_PROFILE_ID", pid)
    profiles.scan_progress("Rating jobs", 3, 12)
    first, second = "event:sam-lee-456789:aa:0a1b2c3d4e5f", "event:sam-lee-456789:bb:0a1b2c3d4e60"
    _request(pid, first, at=100)
    _request(pid, second, "tailored_cv", at=200)
    profiles.write_json(profiles.writing_marker(pid), {"event_id": second, "pid": profiles.os.getpid()})
    tasks = profiles.status_payload()["tasks"]
    report, writing, waiting = tasks
    assert report == {"id": f"report:{pid}", "kind": "report", "u": pid, "state": "running", "at": report["at"],
                      "trigger": "dashboard", "stage": "Rating jobs", "done": 3, "total": 12, "expected": 900_000}
    assert (writing["id"], writing["kind"], writing["state"]) == (f"letter:{pid}:{second}", "tailored_cv", "running")
    assert (waiting["id"], waiting["state"], waiting["title"], waiting["employer"]) == (f"letter:{pid}:{first}", "waiting",
                                                                                         "Data Analyst", "Contoso")
    assert all(profiles.TASK_RE.match(t["id"]) for t in tasks)
    assert "07700" not in json.dumps(tasks) and "SQL work" not in json.dumps(tasks)
    profiles.scan_marker(pid).unlink()
    assert [t["kind"] for t in profiles.tasks()] == ["tailored_cv", "cover_letter"]


def test_progress_is_only_recorded_during_a_tracked_report(home, monkeypatch):
    profiles.sync(FakeApi([signup()]))
    monkeypatch.setenv("JOB_PROFILE_ID", "sam-lee-456789")
    profiles.scan_progress("Rating jobs", 1, 2)
    assert not profiles.scan_marker("sam-lee-456789").exists()
    monkeypatch.setenv("JOB_PROFILE_ID", "../escape")
    profiles.scan_progress("Rating jobs", 1, 2)


def test_stopping_a_report_signals_only_its_scan_and_it_is_not_counted_as_run(home, monkeypatch):
    monkeypatch.setattr(profiles, "api_from_env", lambda: None)
    profiles.sync(FakeApi([signup()]))
    pid = "sam-lee-456789"
    signals = []
    monkeypatch.setattr(profiles, "_runs", lambda p, script: p == 4242 and script == "job_scanner.py")
    monkeypatch.setattr(profiles.os, "getpgid", lambda p: p, raising=False)
    monkeypatch.setattr(profiles.os, "killpg", lambda p, sig: signals.append(("group", p)), raising=False)
    monkeypatch.setattr(profiles.os, "kill", lambda p, sig: signals.append(("one", p)))
    monkeypatch.setattr(profiles, "_alive", lambda p: True)

    def runner(cmd, env, cwd, timeout):
        marker = Path(env["JOB_SCAN_MARKER"])
        profiles.write_json(marker, {**profiles.read_json(marker, {}), "child": 4242})
        assert profiles.status_payload()["tasks"][0]["trigger"] == "schedule"
        assert profiles.cancel_task(f"report:{pid}", pid) == f"Stopping the report for {pid}"
        assert profiles.status_payload()["tasks"][0]["state"] == "stopping"
        return subprocess.CompletedProcess(cmd, -15)

    assert profiles.run_report(pid, runner=runner) == -15
    assert signals == [("group", 4242)]
    assert "last_run" not in profiles.load(pid) and not profiles.scan_marker(pid).exists()
    assert profiles.cancel_task(f"report:{pid}", pid) == f"The report for {pid} had already finished"


def test_request_tasks_say_where_they_were_asked_for_and_for_which_job(home):
    from job_tracker import Tracker
    profiles.sync(FakeApi([signup()]))
    pid = "sam-lee-456789"
    _request(pid, "event:e1")
    with Tracker(profiles.tracker_file(pid)) as tracker:
        tracker.add_event("event:e2", "k1", "tailored_cv", at=1_790_000_100.0, flags="quiet,fresh")
        tracker.add_event("event:e3", "k1", "send_job", at=1_790_000_200.0, flags="quiet")
        tracker.add_event("event:e4", "k1", "cover_letter", at=1_790_000_300.0, flags="send")
    tasks = profiles.letter_tasks(pid)
    assert [(t["kind"], t["trigger"], t["j"], t.get("send")) for t in tasks] == [
        ("cover_letter", "email", "k1", None), ("tailored_cv", "dashboard", "k1", None), ("send_job", "dashboard", "k1", None),
        ("cover_letter", "dashboard", "k1", True)]
    assert "07700" not in str(tasks)


def test_a_cancelled_request_is_never_made_and_its_writer_is_stopped(home, monkeypatch):
    profiles.sync(FakeApi([signup()]))
    pid, event_id = "sam-lee-456789", "event:sam-lee-456789:aa:0a1b2c3d4e5f"
    _request(pid, event_id)
    signals = []
    monkeypatch.setattr(profiles, "_runs", lambda p, script: p == 5151 and script == "cover_letter.py")
    monkeypatch.setattr(profiles.os, "kill", lambda p, sig: signals.append(p))
    profiles.write_json(profiles.writing_marker(pid), {"event_id": event_id, "pid": 5151})
    api = FakeApi([admin("cancel", pid, task=f"letter:{pid}:{event_id}")])
    assert profiles.sync(api) == [f"admin: done ({pid})"]
    assert signals == [5151] and not profiles.writing_marker(pid).exists()
    assert profiles.letter_tasks(pid) == [] and api.statuses[-1]["tasks"] == []
    assert profiles.cancel_task(f"letter:{pid}:{event_id}", pid) == f"Cancelled a request for {pid}"
    assert profiles.cancel_task(f"letter:{pid}:event:{pid}:zz:ffffff", pid) == f"No such request for {pid}"


@pytest.mark.parametrize("task", ["report:owner", "letter:owner:event:_:aa:bb", "report:sam-lee-456789 x", "rm -rf /",
                                  "letter:sam-lee-456789:../../x", "report:../sam", ""])
def test_a_cancel_only_takes_a_well_formed_task_of_its_own_profile(home, task):
    profiles.sync(FakeApi([signup()]))
    with pytest.raises(profiles.ProfileError):
        profiles.cancel_task(task, "sam-lee-456789")
    api = FakeApi([admin("cancel", "sam-lee-456789", task=task)])
    assert profiles.sync(api)[0].startswith("admin: rejected (invalid task")


def test_run_child_notes_the_scan_process_in_the_marker(home):
    marker = home[0] / "marker.json"
    profiles.write_json(marker, {"pid": 1, "at": 2})
    done = profiles.run_child([sys.executable, "-c", "raise SystemExit(3)"], {**profiles.os.environ, "JOB_SCAN_MARKER": str(marker)},
                              home[0], 60)
    assert done.returncode == 3 and profiles.read_json(marker, {})["child"] > 1

"""Unit tests for HermitShell's scheduler (common/scheduler.py).

Run from the repository root:  python -m pytest common/tests
"""

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import scheduler  # noqa: E402

POSIX = pytest.mark.skipif(os.name != "posix", reason="flock and process groups are POSIX only")
UTC = timezone.utc


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A HermitShell home with an empty scripts folder; returns (home, scripts)."""
    home, scripts = tmp_path / "home", tmp_path / "home" / "scripts"
    scripts.mkdir(parents=True)
    cron = home / "cron"
    monkeypatch.setattr(scheduler.hc, "APP_HOME", home)
    monkeypatch.setattr(scheduler, "SCRIPT_DIR", scripts)
    for name, value in {"CRON_DIR": cron, "JOBS_FILE": cron / "jobs.json", "OUTPUT_DIR": cron / "output",
                        "LOCK_DIR": cron / "locks", "HEARTBEAT": cron / "heartbeat.json"}.items():
        monkeypatch.setattr(scheduler, name, value)
    monkeypatch.setattr(scheduler, "BASE_ENV", dict(os.environ))
    for key in ("HERMES_TIMEZONE", "HERMITSHELL_JOB_TIMEOUT", "HERMITSHELL_CATCHUP_MINUTES"):
        monkeypatch.delenv(key, raising=False)
    return home, scripts


def script(scripts: Path, name: str, body: str = "") -> Path:
    path = scripts / name
    path.write_text(body, encoding="utf-8")
    return path


def at(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


# --------------------------------------------------------------------------- cron expressions

@pytest.mark.parametrize("expr, when, due", [
    ("*/15 9-17 * * mon-fri", "2026-06-01 09:45", True),
    ("*/15 9-17 * * mon-fri", "2026-06-01 09:50", False),
    ("*/15 9-17 * * mon-fri", "2026-06-06 09:45", False),
    ("0 18 * * 7", "2026-06-07 18:00", True),
    ("0 18 * * SUN", "2026-06-07 18:00", True),
    ("30 3 * * *", "2026-06-07 03:30", True),
    ("0 0 1 * 1", "2026-06-01 00:00", True),
    ("0 0 1 * 1", "2026-06-08 00:00", True),
    ("0 0 1 * 1", "2026-06-02 00:00", False),
    ("0 0 1 jan-mar *", "2026-02-01 00:00", True),
    ("0 0 1 jan-mar *", "2026-06-01 00:00", False),
    ("@daily", "2026-06-01 00:00", True),
    ("@hourly", "2026-06-01 13:00", True),
    ("5,35 * * * *", "2026-06-01 13:35", True),
])
def test_cron_expressions_match_like_cron(expr, when, due):
    assert scheduler.matches(scheduler.parse(expr), at(when)) is due


@pytest.mark.parametrize("expr", ["", "* * * *", "* * * * * *", "61 * * * *", "* 24 * * *", "*/0 * * * *",
                                  "5-1 * * * *", "a * * * *", "0 0 32 * *", "0 0 * 13 *", "0 0 * * 8",
                                  "0 7 * * *; rm -rf /", "0 7 * * * --paused", "0 " * 50])
def test_bad_cron_expressions_are_refused(expr):
    assert not scheduler.valid(expr)
    with pytest.raises(scheduler.ScheduleError):
        scheduler.new_job(expr, "t", "n", "x.py")


def test_schedules_follow_the_configured_time_zone_through_daylight_saving(home, monkeypatch):
    job = {"id": "abc123", "schedule": {"expr": "0 7 * * *"}, "last_due": "2026-01-01T00:00:00+00:00"}
    monkeypatch.setenv("HERMES_TIMEZONE", "Europe/London")
    assert scheduler.due_at({**job, "last_due": "2026-07-01T06:59:00+00:00"}, at("2026-07-01 07:00"), 0) is None
    assert scheduler.due_at({**job, "last_due": "2026-07-01T05:59:00+00:00"}, at("2026-07-01 06:00"), 0) \
        == at("2026-07-01 06:00")
    assert scheduler.due_at({**job, "last_due": "2026-12-01T06:59:00+00:00"}, at("2026-12-01 07:00"), 0) \
        == at("2026-12-01 07:00")
    monkeypatch.setenv("HERMES_TIMEZONE", "Not/AZone")
    assert scheduler.zone().key == "UTC"


# --------------------------------------------------------------------------- when a job is due

def test_a_new_job_only_runs_from_the_minute_it_was_added():
    job = {"id": "abc123", "schedule": {"expr": "* * * * *"}}
    assert scheduler.due_at(job, at("2026-06-01 10:00") + timedelta(seconds=42), 30) == at("2026-06-01 10:00")
    assert scheduler.due_at({"id": "a", "schedule": "0 9 * * *"}, at("2026-06-01 10:00"), 120) is None


def test_a_missed_run_is_caught_up_only_within_the_window():
    job = {"id": "abc123", "schedule": {"expr": "0 7 * * *"}, "last_due": "2026-06-01T06:00:00+00:00"}
    assert scheduler.due_at(job, at("2026-06-01 07:20"), 30) == at("2026-06-01 07:00")
    assert scheduler.due_at(job, at("2026-06-01 07:45"), 30) is None
    assert scheduler.due_at({**job, "last_due": "2026-06-01T07:00:00+00:00"}, at("2026-06-01 07:20"), 30) is None
    assert scheduler.due_at({**job, "enabled": False}, at("2026-06-01 07:00"), 30) is None
    assert scheduler.due_at({**job, "state": "paused"}, at("2026-06-01 07:00"), 30) is None
    assert scheduler.due_at({**job, "schedule": {"expr": "bad"}}, at("2026-06-01 07:00"), 30) is None


# --------------------------------------------------------------------------- the jobs file

def test_create_checks_names_scripts_and_folders(home):
    base, scripts = home
    job = scheduler.create("0 7 * * *", "  Daily\n report ", "job-scanner", "job_scanner.py",
                           workdir=str(base / "scripts" / "state"))
    assert job["title"] == "Daily report" and job["enabled"] and job["state"] == "scheduled"
    assert job["workdir"] == str((base / "scripts" / "state").resolve())
    assert scheduler.load_jobs() == [job]
    with pytest.raises(scheduler.ScheduleError, match="already exists"):
        scheduler.create("0 8 * * *", "again", "job-scanner", "job_scanner.py")
    for name, file in (("bad name", "x.py"), ("-x", "x.py"), ("ok\n", "x.py"), ("ok", "../x.py"), ("ok", "x.sh"),
                       ("ok", "a/b.py"), ("ok", ".py"), ("ok", ""), ("ok", "x.py\n")):
        with pytest.raises(scheduler.ScheduleError):
            scheduler.create("0 7 * * *", "t", name, file)
    with pytest.raises(scheduler.ScheduleError, match="outside"):
        scheduler.create("0 7 * * *", "t", "escape", "x.py", workdir=str(base.parent))
    assert len(scheduler.load_jobs()) == 1


def test_the_jobs_file_is_read_leniently(home):
    scheduler.CRON_DIR.mkdir(parents=True)
    assert scheduler.load_jobs() is None
    scheduler.JOBS_FILE.write_text("not json", encoding="utf-8")
    assert scheduler.load_jobs() is None
    scheduler.JOBS_FILE.write_text(json.dumps([{"id": "a1"}, {"name": "no id"}, "x"]), encoding="utf-8")
    assert scheduler.load_jobs() == [{"id": "a1"}]


def test_a_changed_or_resumed_job_waits_for_its_next_time(home):
    job = scheduler.create("0 7 * * *", "t", "daily", "x.py")
    now = datetime.now(UTC)
    just_gone = (now - timedelta(minutes=1)).replace(second=0, microsecond=0)
    scheduler.change(job["id"], expr=f"{just_gone.minute} {just_gone.hour} * * *")
    stored = scheduler.find(scheduler.load_jobs(), "daily")
    assert scheduler.expression(stored) == f"{just_gone.minute} {just_gone.hour} * * *"
    assert scheduler.due_at(stored, now, 30) is None
    scheduler.change("daily", enabled=False, state="paused")
    scheduler.change("daily", enabled=True, state="scheduled")
    assert scheduler.due_at(scheduler.find(scheduler.load_jobs(), "daily"), now, 30) is None
    with pytest.raises(scheduler.ScheduleError):
        scheduler.change("daily", expr="61 * * * *")
    assert scheduler.remove("daily")["id"] == job["id"] and scheduler.load_jobs() == []
    with pytest.raises(scheduler.ScheduleError, match="no job"):
        scheduler.remove("daily")


def test_standard_jobs_are_added_once_and_only_for_installed_scripts(home):
    _, scripts = home
    script(scripts, "job_scanner.py")
    (scripts / "demo.jobs.json").write_text(json.dumps({"jobs": [
        {"name": "daily", "title": "Daily", "script": "job_scanner.py", "schedule": "0 7 * * *"},
        {"name": "weekly", "script": "not_installed.py", "schedule": "0 18 * * 0"}]}), encoding="utf-8")
    (scripts / "broken.jobs.json").write_text("{", encoding="utf-8")
    assert scheduler.add_defaults(only_if_new=True) == ["daily"]
    assert scheduler.add_defaults(only_if_new=True) == []
    assert scheduler.add_defaults() == []
    scheduler.remove("daily")
    assert scheduler.add_defaults(only_if_new=True) == [] and scheduler.add_defaults() == ["daily"]


def test_hermes_jobs_are_imported_with_their_folders_moved(home, tmp_path):
    base, scripts = home
    for name in ("job_scanner.py", "profile_report.py", "profiles.py"):
        script(scripts, name)
    old = tmp_path / "hermes-jobs.json"
    old.write_text(json.dumps({"jobs": [
        {"id": "1", "name": "job-scanner", "script": "job_scanner.py", "prompt": "Daily vacancy report",
         "schedule": {"kind": "cron", "expr": "0 8 * * *"}, "enabled": True, "no_agent": True},
        {"id": "2", "name": "vacancy-report-sam-lee-1", "script": "/opt/data/scripts/profile_report.py",
         "schedule": {"expr": "15 8 * * *"}, "workdir": "/opt/data/scripts/state/profiles/sam-lee-1"},
        {"id": "3", "name": "vacancy-profiles", "script": "profiles.py", "schedule": "*/5 * * * *",
         "enabled": False, "prompt": "x" * 500},
        {"id": "4", "name": "noon-tech-digest", "script": "tech_digest.py", "schedule": {"expr": "0 12 * * *"}},
        {"id": "5", "name": "agent-task", "prompt": "Summarise my inbox", "schedule": {"expr": "0 9 * * *"}},
        {"id": "6", "name": "bad", "script": "profiles.py", "schedule": {"expr": "61 * * * *"}},
        {"id": "7", "name": "escape", "script": "../../bin/evil.py", "schedule": {"expr": "0 1 * * *"}},
        "junk"]}), encoding="utf-8")
    assert scheduler.import_jobs(old, [("/opt/data", str(base))]) == \
        ["job-scanner", "vacancy-report-sam-lee-1", "vacancy-profiles"]
    jobs = {j["name"]: j for j in scheduler.load_jobs()}
    assert jobs["job-scanner"]["title"] == "Daily vacancy report" and scheduler.enabled(jobs["job-scanner"])
    assert jobs["vacancy-report-sam-lee-1"]["script"] == "profile_report.py"
    assert jobs["vacancy-report-sam-lee-1"]["workdir"] == \
        str((base / "scripts" / "state" / "profiles" / "sam-lee-1").resolve())
    assert not scheduler.enabled(jobs["vacancy-profiles"]) and jobs["vacancy-profiles"]["title"] == "vacancy-profiles"
    assert scheduler.import_jobs(old, [("/opt/data", str(base))]) == []


def test_an_imported_folder_outside_the_home_is_refused(home, tmp_path):
    _, scripts = home
    script(scripts, "profile_report.py")
    old = tmp_path / "jobs.json"
    old.write_text(json.dumps([{"name": "r", "script": "profile_report.py", "schedule": "0 8 * * *",
                                "workdir": "/opt/data/scripts/state/profiles/x"}]), encoding="utf-8")
    with pytest.raises(scheduler.ScheduleError, match="outside"):
        scheduler.import_jobs(old, [])


# --------------------------------------------------------------------------- running jobs

def test_a_run_keeps_its_output_and_result(home):
    base, scripts = home
    script(scripts, "hello.py", "import os\nprint('hello from', os.path.basename(os.getcwd()))\n")
    (base / "scripts" / "state").mkdir()
    job = scheduler.create("0 7 * * *", "t", "hello", "hello.py", workdir=str(base / "scripts" / "state"))
    assert scheduler.execute("hello") == 0
    logs = list((scheduler.OUTPUT_DIR / job["id"]).glob("*.log"))
    assert len(logs) == 1 and logs[0].read_text(encoding="utf-8").strip() == "hello from state"
    stored = scheduler.find(scheduler.load_jobs(), job["id"])
    assert stored["last_status"] == "ok" and stored["last_exit"] == 0 and stored["last_error"] == ""
    assert stored["last_run_at"] and stored["last_duration"] >= 0


def test_a_silent_run_leaves_no_file_and_a_failure_is_recorded(home):
    _, scripts = home
    script(scripts, "quiet.py", "")
    script(scripts, "fails.py", "import sys\nsys.exit(3)\n")
    quiet = scheduler.create("0 7 * * *", "t", "quiet", "quiet.py")
    scheduler.create("0 7 * * *", "t", "fails", "fails.py")
    assert scheduler.execute("quiet") == 0 and not (scheduler.OUTPUT_DIR / quiet["id"]).exists()
    assert scheduler.execute("fails") == 3
    stored = scheduler.find(scheduler.load_jobs(), "fails")
    assert stored["last_status"] == "error" and stored["last_exit"] == 3 and stored["last_error"] == "exit 3"


def test_a_run_past_its_time_limit_is_stopped(home, monkeypatch):
    _, scripts = home
    script(scripts, "slow.py", "import time\nprint('started', flush=True)\ntime.sleep(60)\n")
    scheduler.create("0 7 * * *", "t", "slow", "slow.py")
    monkeypatch.setattr(scheduler, "STOP_GRACE", 5)
    started = time.time()
    assert scheduler.execute("slow", timeout=2) == 124
    assert time.time() - started < 30
    assert scheduler.find(scheduler.load_jobs(), "slow")["last_exit"] == 124


def test_a_job_whose_script_is_gone_records_the_error(home):
    scheduler.create("0 7 * * *", "t", "gone", "gone.py")
    assert scheduler.execute("gone") == 2
    stored = scheduler.find(scheduler.load_jobs(), "gone")
    assert stored["last_status"] == "error" and "not installed" in stored["last_error"]


@POSIX
def test_a_job_still_running_is_not_started_twice(home):
    _, scripts = home
    script(scripts, "x.py", "print('ran')\n")
    job = scheduler.create("0 7 * * *", "t", "x", "x.py")
    with scheduler.hc.run_lock(scheduler.lock_file(job["id"])):
        assert scheduler.running(job["id"])
        assert scheduler.execute(job["id"]) == 0
    assert not (scheduler.OUTPUT_DIR / job["id"]).exists() and not scheduler.running(job["id"])


def test_due_jobs_are_started_and_a_running_one_is_skipped(home, monkeypatch):
    a = scheduler.create("* * * * *", "t", "a", "a.py")
    b = scheduler.create("* * * * *", "t", "b", "b.py")
    scheduler.create("0 0 1 1 *", "t", "c", "c.py")
    monkeypatch.setattr(scheduler, "running", lambda job_id: job_id == b["id"])
    spawned = []
    now = datetime.now(UTC) + timedelta(minutes=2)
    started = scheduler.start_due(now, lambda cmd, **kw: spawned.append((cmd, kw)) or "proc")
    assert started == [(a["id"], "proc")]
    cmd, kw = spawned[0]
    assert cmd[0] == sys.executable and cmd[-2:] == ["exec", a["id"]] and kw["stdin"] is not None
    jobs = {j["name"]: j for j in scheduler.load_jobs()}
    assert jobs["a"]["last_due"] == jobs["b"]["last_due"] == scheduler.minute_of(now).isoformat()
    assert scheduler.start_due(now, lambda *a, **k: pytest.fail("started twice")) == []


def test_the_service_checks_each_minute_and_reports_its_health(home):
    scheduler.create("* * * * *", "t", "a", "a.py")
    assert not scheduler.healthy()
    clock = [time.time() + 120]
    spawned, slept = [], []
    assert scheduler.serve(spawn=lambda cmd, **kw: spawned.append(cmd), clock=lambda: clock[0],
                           sleep=slept.append, rounds=1) == 0
    assert len(spawned) == 1 and len(slept) == 1 and 1 <= slept[0] <= 15
    assert scheduler.healthy(clock[0]) is True
    assert scheduler.healthy(time.time() + scheduler.HEALTHY_WITHIN + 200) is False
    scheduler.HEARTBEAT.write_text("[]", encoding="utf-8")
    assert scheduler.healthy() is False


def test_a_broken_jobs_file_does_not_stop_the_service(home, monkeypatch):
    monkeypatch.setattr(scheduler, "start_due", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    assert scheduler.serve(spawn=lambda *a, **k: None, sleep=lambda s: None, rounds=1) == 0
    assert scheduler.healthy()


@pytest.mark.parametrize("job_id", ["", "../x", "abc", "ABCDEF123", "a" * 33, "abc123/..", "abc123\n"])
def test_lock_files_only_take_real_job_ids(job_id):
    with pytest.raises(scheduler.ScheduleError):
        scheduler.lock_file(job_id)


# --------------------------------------------------------------------------- command line

def test_the_command_line_manages_jobs(home, capsys):
    _, scripts = home
    script(scripts, "hello.py", "print('hi')\n")
    assert scheduler.main(["create", "0 7 * * *", "Daily report", "--name", "daily", "--script", "hello.py"]) == 0
    assert "created" in capsys.readouterr().out
    assert scheduler.main(["edit", "daily", "--schedule", "30 6 * * 1-5"]) == 0
    assert scheduler.main(["pause", "daily"]) == 0 and "daily: paused" in capsys.readouterr().out.splitlines()[-1]
    assert scheduler.main(["resume", "daily"]) == 0
    assert scheduler.main(["list", "--json"]) == 0
    listed = json.loads(capsys.readouterr().out.split("daily: active\n", 1)[1])
    assert listed[0]["schedule"]["expr"] == "30 6 * * 1-5" and listed[0]["enabled"] is True
    assert scheduler.main(["list"]) == 0
    table = capsys.readouterr().out
    assert table.startswith("ID") and "30 6 * * 1-5" in table and "active" in table
    assert scheduler.main(["start", "daily"]) == 0
    assert scheduler.main(["create", "bad", "x", "--name", "x", "--script", "x.py"]) == 1
    assert "scheduler:" in capsys.readouterr().err
    assert scheduler.main(["remove", "daily"]) == 0 and scheduler.load_jobs() == []
    assert scheduler.main(["health"]) == 1
    assert scheduler.main(["defaults"]) == 0 and "no jobs to add" in capsys.readouterr().out

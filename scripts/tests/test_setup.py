"""Unit tests for the setup wizard's helpers (scripts/setup.py).

Run from the repository root:  python -m pytest scripts/tests
"""

import argparse
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
# Loaded under another name so it can't be mistaken for a setuptools setup.py.
_spec = importlib.util.spec_from_file_location("hermit_setup", REPO / "scripts" / "setup.py")
setup = sys.modules["hermit_setup"] = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(setup)

EXAMPLE_FILES = sorted([REPO / ".env.example", *REPO.glob("packages/*/.env.example")])


# --------------------------------------------------------------------------- schedules

@pytest.mark.parametrize("reply, cron", [
    ("7:30", "30 7 * * *"),
    ("daily 07:30", "30 7 * * *"),
    ("weekdays 06:05", "5 6 * * 1-5"),
    ("Sunday 18:00", "0 18 * * 0"),
    ("tues 10:00", "0 10 * * 2"),
    ("sat 09:00", "0 9 * * 6"),
    ("0 12 * * *", "0 12 * * *"),
    ("25:00", None),
    ("tomorrow", None),
])
def test_cron_expression(reply, cron):
    assert setup.cron_expression(reply) == cron


@pytest.mark.parametrize("cron, friendly", [
    ("0 7 * * *", "07:00"),
    ("30 6 * * 1-5", "weekdays 06:30"),
    ("0 18 * * 0", "sunday 18:00"),
    ("*/5 * * * *", "*/5 * * * *"),
])
def test_friendly_schedule(cron, friendly):
    assert setup.friendly_schedule(cron) == friendly


@pytest.mark.parametrize("reply", ["07:00", "weekdays 06:30", "sunday 18:00", "friday 23:59"])
def test_schedule_round_trip(reply):
    assert setup.friendly_schedule(setup.cron_expression(reply)) == reply


def test_scheduled_jobs_include_the_weekly_roll_up_cover_letters_profiles_and_maintenance():
    assert [job for job, _ in setup.scheduled_jobs("daily-vacancy-report")] == \
        ["daily-vacancy-report", "daily-vacancy-report-weekly", "daily-vacancy-report-letters",
         "daily-vacancy-report-profiles", "daily-vacancy-report-maintenance"]
    assert setup.cron_expression("*/5 * * * *") == "*/5 * * * *"
    assert list(setup.PACKAGES) == ["daily-vacancy-report"]


def test_every_package_script_exists():
    for pkg, info in setup.PACKAGES.items():
        for _, job in setup.scheduled_jobs(pkg):
            assert (REPO / "packages" / pkg / job["script"]).is_file(), job["script"]
            assert setup.CRON_RE.match(job.get("schedule", info["schedule"]))


# --------------------------------------------------------------------------- small helpers

@pytest.mark.parametrize("country, symbol", [("gb", "£"), ("ie", "€"), ("us", "$"), ("zz", "")])
def test_salary_symbol(country, symbol):
    assert setup.salary_symbol(country) == symbol


def test_mask_never_shows_a_whole_secret():
    assert setup.mask("") == ""
    assert setup.mask("short") == "****"
    assert setup.mask("abcdefghijklmno") == "****"
    assert setup.mask("abcdefghijklmnop") == "****mnop"


def test_quote_and_unquote():
    assert setup.quote("plain") == "plain"
    assert setup.quote(" padded") == "' padded'"
    assert setup.quote("a #b") == "'a #b'"
    assert setup.quote("it's #x") == "it's #x"
    assert setup.unquote("'x'") == "x"
    assert setup.unquote('"y"') == "y"
    assert setup.unquote(" z ") == "z"


def test_split_top_level():
    assert setup.split_top_level(r"a|(b|c)|d\|e") == ["a", "(b|c)", r"d\|e"]


def test_phrase_regex():
    pattern = re.compile(setup.phrase_regex("Machine learning / ML"), re.I)
    assert pattern.search("Senior Machine-Learning Engineer")
    assert pattern.search("ML Ops")
    assert not pattern.search("HTML developer")
    assert setup.phrase_regex("C++") == r"\bc\+\+"


def test_read_constant(tmp_path):
    script = tmp_path / "script.py"
    script.write_text('import os\nFOO = {"a": 1}\nBAR = os.getcwd()\n', encoding="utf-8")
    assert setup.read_constant(script, "FOO") == {"a": 1}
    assert setup.read_constant(script, "MISSING") is None


# --------------------------------------------------------------------------- settings

def test_setting_kinds():
    assert setup.Setting("SMTP_PASSWORD", "", [], "Email").secret
    assert setup.Setting("SMTP_HOST", "smtp.example.com", [], "Email").placeholder
    assert setup.Setting("JOB_DRY", "0", [], "Jobs").kind == "bool"
    assert setup.Setting("JOB_MIN_SCORE", "1", [], "Jobs").kind == "int"
    assert setup.Setting("JOB_LEVEL", "mid", [], "Jobs").kind == "str"


def test_parse_example_reads_sections_help_and_flags(tmp_path):
    example = tmp_path / ".env.example"
    example.write_text(
        "# ---------------------------------------------------------------- Email\n"
        "# Where to send the report.\n"
        "# @basic\n"
        "EMAIL_TO=you@example.com\n"
        "\n"
        "# @wizard\n"
        "JOB_FEEDBACK_SECRET=\n"
        "export PLAIN='quoted value'\n",
        encoding="utf-8")
    settings = setup.parse_example(example)
    assert [(s.key, s.default, s.section, s.basic, s.wizard) for s in settings] == [
        ("EMAIL_TO", "you@example.com", "Email", True, False),
        ("JOB_FEEDBACK_SECRET", "", "Email", False, True),
        ("PLAIN", "quoted value", "Email", False, False),
    ]
    assert settings[0].help == ["Where to send the report."]


@pytest.mark.parametrize("path", EXAMPLE_FILES, ids=lambda p: str(p.relative_to(REPO)))
def test_example_files_parse_and_ship_no_secrets(path):
    settings = setup.parse_example(path)
    assert settings, path
    keys = [s.key for s in settings]
    assert len(keys) == len(set(keys)), "duplicate keys"
    for s in settings:
        if s.secret:
            assert s.default == "" or s.placeholder, f"{s.key} ships a real-looking value"


def test_env_file_updates_in_place_and_appends_new_keys(tmp_path):
    path = tmp_path / ".env"
    path.write_text("A=1\n# comment\nB='x y'\n", encoding="utf-8")
    env = setup.EnvFile(path)
    assert env.values() == {"A": "1", "B": "x y"}
    rendered = env.render({"B": "new value", "C": " padded"}, "setup wizard")
    assert rendered.splitlines() == [
        "A=1", "# comment", "B=new value", "",
        "# ---------------------------------------------------------------- setup wizard",
        "C=' padded'",
    ]


def test_env_file_starts_empty_when_missing(tmp_path):
    env = setup.EnvFile(tmp_path / "missing.env")
    assert env.values() == {}
    assert env.render({"A": "1"}, "new").splitlines() == [
        "# ---------------------------------------------------------------- new", "A=1"]


# --------------------------------------------------------------------------- prerequisites (doctor, Ollama)

def make_args(tmp_path, answers="", dry_run=False, container="hermes-agent"):
    path = tmp_path / "answers.env"
    path.write_text(answers, encoding="utf-8")
    return argparse.Namespace(non_interactive=True, answers=str(path), advanced=False, dry_run=dry_run,
                              container=container, container_home="/opt/data", container_user="hermes",
                              python="python3", no_prereqs=False)


class FakeDocker:
    """Stands in for `docker` on the host: replies by subcommand and records every call."""

    def __init__(self, networks="hermes-net", state="", fail_run=False, network_exists=True):
        self.calls, self.networks, self.state = [], networks, state
        self.fail_run, self.network_exists = fail_run, network_exists

    def __call__(self, argv, timeout=120):
        self.calls.append(argv)
        out, code = "", 0
        if argv[0] == "inspect":
            out = self.networks + " "
        elif argv[:2] == ["network", "inspect"]:
            code = 0 if self.network_exists else 1
        elif argv[0] == "ps":
            out = self.state
        elif argv[0] == "run":
            code = 1 if self.fail_run else 0
        return subprocess.CompletedProcess(["docker", *argv], code, out, "no such image" if code else "")

    def ran(self, sub):
        return [c for c in self.calls if c[0] == sub or c[:2] == sub.split()]


@pytest.fixture
def prereq(tmp_path, monkeypatch):
    """A wizard in Docker mode with doctor.py installed; doctor calls are recorded, Ollama replies are queued."""
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "doctor.py").write_text("", encoding="utf-8")
    monkeypatch.setattr(setup.time, "sleep", lambda s: None)
    monkeypatch.setattr(setup.shutil, "which", lambda name: f"/usr/bin/{name}" if name == "docker" else None)

    def build(answers="", current=None, replies=(), dry_run=False, docker=None, container="hermes-agent"):
        args = make_args(tmp_path, answers, dry_run, container)
        w, runner = setup.Wizard(args), setup.Runner(args, scripts)
        w.current = dict(current or {})
        w.doctor_calls, queue = [], list(replies)
        w.doctor = lambda r, s, argv, capture=False, env=None: w.doctor_calls.append((argv, env))
        w.doctor_items = lambda r, s, only, env=None: [queue.pop(0)] if queue else []
        runner.docker = docker or FakeDocker()
        return w, runner, scripts
    return build


def test_runner_passes_extra_environment_into_the_container(tmp_path):
    runner = setup.Runner(make_args(tmp_path), tmp_path)
    assert runner.command(["python3", "doctor.py"], in_scripts=True, env={"OLLAMA_HOST": "http://ollama:11434"}) == [
        "docker", "exec", "-u", "hermes", "-w", "/opt/data/scripts", "-e", "OLLAMA_HOST=http://ollama:11434",
        "hermes-agent", "python3", "doctor.py"]


def test_prerequisites_dry_run_runs_nothing(prereq, capsys):
    w, runner, scripts = prereq(dry_run=True)
    w.prerequisites(runner, scripts)
    assert w.doctor_calls == [] and runner.docker.calls == []
    assert "would run: doctor.py --fix" in capsys.readouterr().out


def test_prerequisites_warn_when_doctor_is_not_installed(prereq, capsys):
    w, runner, scripts = prereq()
    (scripts / "doctor.py").unlink()
    w.prerequisites(runner, scripts)
    assert w.doctor_calls == [] and "doctor.py is missing" in capsys.readouterr().out


def test_prerequisites_install_packages_then_find_the_model(prereq, capsys):
    ok = {"status": "ok", "host": "http://ollama:11434", "model": "qwen3:8b", "wanted": "qwen3:8b"}
    w, runner, scripts = prereq(replies=[ok])
    w.prerequisites(runner, scripts)
    assert w.doctor_calls == [(["--fix", "--only", "python,packages"], None)]
    assert "has qwen3:8b" in capsys.readouterr().out
    assert w.changes == {} and runner.docker.calls == []


def test_missing_model_is_downloaded_without_changing_settings(prereq):
    missing = {"status": "fail", "host": "http://ollama:11434", "model": "", "wanted": "qwen3:4b"}
    w, runner, scripts = prereq(current={"OLLAMA_MODEL": ""}, replies=[missing])
    w.ollama(runner, scripts)
    assert w.doctor_calls == [(["--fix", "--only", "ollama", "--model", "qwen3:4b"], {})]
    assert w.changes == {}


@pytest.mark.parametrize("current, key", [({}, "OLLAMA_MODEL"), ({"JOB_SCANNER_MODEL": "qwen3:4b"}, "JOB_SCANNER_MODEL")])
def test_a_chosen_model_is_saved_where_the_job_finder_reads_it(prereq, current, key):
    missing = {"status": "fail", "host": "http://gpu:11434", "model": "", "wanted": "qwen3:4b"}
    w, runner, scripts = prereq(answers=f"{key}=llama3:8b\n", current=current, replies=[missing])
    w.ollama(runner, scripts)
    assert w.changes == {key: "llama3:8b"}
    assert w.doctor_calls[-1][0] == ["--fix", "--only", "ollama", "--model", "llama3:8b"]


def test_no_ollama_starts_a_container_and_downloads_the_model(prereq):
    down = {"status": "fail", "host": "", "model": "", "wanted": "qwen3:4b"}
    up = {"status": "fail", "host": "http://ollama:11434", "model": "", "wanted": "qwen3:4b"}
    w, runner, scripts = prereq(current={"OLLAMA_HOST": "http://localhost:11434"}, replies=[down, down, up])
    w.ollama(runner, scripts)
    run = runner.docker.ran("run")[0]
    assert run[run.index("--network") + 1] == "hermes-net" and "ollama:/root/.ollama" in run
    assert run[-1] == "ollama/ollama" and "--gpus" not in run
    assert w.changes == {"OLLAMA_HOST": "http://ollama:11434"}
    assert w.doctor_calls == [(["--fix", "--only", "ollama", "--model", "qwen3:4b"],
                               {"OLLAMA_HOST": "http://ollama:11434"})]


def test_ollama_container_uses_the_gpu_when_there_is_one(prereq, monkeypatch):
    w, runner, _ = prereq()
    monkeypatch.setattr(setup.shutil, "which", lambda name: f"/usr/bin/{name}")
    assert w.start_ollama(runner) == "http://ollama:11434"
    run = runner.docker.ran("run")[0]
    assert run[run.index("--gpus") + 1] == "all"


def test_hermes_on_the_default_bridge_gets_a_named_network(prereq):
    w, runner, _ = prereq(docker=FakeDocker(networks="bridge", network_exists=False))
    assert w.start_ollama(runner) == "http://ollama:11434"
    assert runner.docker.ran("network create") == [["network", "create", "hermes-net"]]
    assert ["network", "connect", "hermes-net", "hermes-agent"] in runner.docker.calls


def test_a_stopped_ollama_container_is_reused(prereq):
    w, runner, _ = prereq(docker=FakeDocker(state="exited"))
    assert w.start_ollama(runner) == "http://ollama:11434"
    assert ["start", "ollama"] in runner.docker.calls
    assert ["network", "connect", "hermes-net", "ollama"] in runner.docker.calls
    assert runner.docker.ran("run") == []


def test_hermes_on_the_host_network_reaches_ollama_on_localhost(prereq):
    w, runner, _ = prereq(docker=FakeDocker(networks="host"))
    assert w.start_ollama(runner) == "http://localhost:11434"
    run = runner.docker.ran("run")[0]
    assert run[run.index("--network") + 1] == "host"


def test_a_failed_container_start_falls_back_to_instructions(prereq, capsys):
    down = {"status": "fail", "host": "", "model": "", "wanted": "qwen3:4b"}
    w, runner, scripts = prereq(docker=FakeDocker(fail_run=True), replies=[down])
    w.ollama(runner, scripts)
    out = capsys.readouterr().out
    assert "could not start Ollama: no such image" in out and "https://ollama.com/download" in out
    assert w.changes == {} and w.doctor_calls == []


def test_no_container_is_started_without_docker_mode(prereq):
    w, runner, _ = prereq(container=None)
    runner.mode = "local"
    assert w.start_ollama(runner) is None
    assert runner.docker.calls == []


def test_doctor_items_read_the_json_report(tmp_path, monkeypatch):
    w = setup.Wizard(make_args(tmp_path))
    runner = setup.Runner(make_args(tmp_path), tmp_path)
    replies = iter(['downloading...\n[{"check": "ollama", "status": "ok", "host": "h"}]\n', "Traceback: boom\n"])
    monkeypatch.setattr(w, "doctor", lambda *a, **k: subprocess.CompletedProcess([], 0, next(replies), ""))
    assert w.doctor_items(runner, tmp_path, "ollama") == [{"check": "ollama", "status": "ok", "host": "h"}]
    assert w.doctor_items(runner, tmp_path, "ollama") == []

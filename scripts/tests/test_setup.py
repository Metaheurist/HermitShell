"""Unit tests for the setup wizard's helpers (scripts/setup.py).

Run from the repository root:  python -m pytest scripts/tests
"""

import importlib.util
import re
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


def test_scheduled_jobs_include_the_weekly_roll_up_cover_letters_and_profiles():
    assert [job for job, _ in setup.scheduled_jobs("daily-vacancy-report")] == \
        ["daily-vacancy-report", "daily-vacancy-report-weekly", "daily-vacancy-report-letters",
         "daily-vacancy-report-profiles"]
    assert setup.cron_expression("*/5 * * * *") == "*/5 * * * *"
    assert [job for job, _ in setup.scheduled_jobs("news-digest")] == ["news-digest"]


def test_every_package_script_exists():
    for pkg, info in setup.PACKAGES.items():
        for _, job in setup.scheduled_jobs(pkg):
            assert (REPO / "packages" / pkg / job["script"]).is_file(), job["script"]
            assert setup.CRON_RE.match(job.get("schedule", info["schedule"]))


# --------------------------------------------------------------------------- small helpers

@pytest.mark.parametrize("country, domain", [("gb", "uk.indeed.com"), ("US", "www.indeed.com"),
                                             ("de", "de.indeed.com"), ("", "www.indeed.com")])
def test_indeed_domain(country, domain):
    assert setup.indeed_domain(country) == domain


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

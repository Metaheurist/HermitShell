#!/usr/bin/env python3
"""HermitShell setup wizard: install the job finder, then configure every setting, API key, job search,
candidate profile, the feedback Worker and cron schedule interactively.

    python3 scripts/setup.py                          # guided setup (essential settings)
    python3 scripts/setup.py --advanced               # ask for every setting
    sudo python3 scripts/setup.py --hermes-home /path/to/hermes/data   # from a Docker host
    python3 scripts/setup.py --non-interactive --answers answers.env   # unattended
    python3 scripts/setup.py --dry-run                # show what would change, write nothing

Settings are read from the .env.example files (repository root and each package), so new
settings appear in the wizard automatically. Values go to $HERMES_HOME/.env, which is backed up
first and kept at mode 600. Secrets are typed without echo and only ever shown masked.
Re-run the wizard at any time: current values are offered as the defaults.
"""

from __future__ import annotations

import argparse
import ast
import base64
import getpass
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PACKAGES_DIR = REPO / "packages"
sys.path.insert(0, str(REPO / "scripts"))
import cloudflare_worker  # noqa: E402

SECRET_RE = re.compile(r"PASSWORD|API_KEY|_KEYS$|TOKEN|SECRET")
PLACEHOLDER_RE = re.compile(r"example\.(com|org)|change-me", re.I)
SECTION_RE = re.compile(r"^#\s*-{4,}\s*(.+?)\s*$")
KEY_RE = re.compile(r"^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$")
TIME_RE = re.compile(r"^(?:(weekdays|daily|sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|"
                     r"thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)\s+)?([01]?\d|2[0-3]):([0-5]\d)$", re.I)
CRON_RE = re.compile(r"^\S+(\s+\S+){4}$")
DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
SALARY_SYMBOLS = {"gb": "£", "us": "$", "ca": "$", "au": "$", "nz": "$", "in": "₹", "jp": "¥", "ch": "CHF"}
EURO_COUNTRIES = {"at", "be", "cy", "de", "ee", "es", "fi", "fr", "gr", "hr", "ie", "it", "lt", "lu", "lv", "mt",
                  "nl", "pt", "si", "sk"}

PACKAGES = {
    "daily-vacancy-report": {
        "title": "Daily Vacancy Report", "script": "job_scanner.py", "cron": "daily-vacancy-report",
        "schedule": "0 7 * * *", "dry_run": ["--dry-run", "--limit", "3"],
        "extra_jobs": [{"id": "weekly", "title": "Weekly vacancy roll-up", "script": "job_weekly.py",
                        "cron": "weekly-vacancy-report", "schedule": "0 18 * * 0",
                        "intro": "A Sunday summary of the week: best jobs, applications, common gaps."},
                       {"id": "letters", "title": "Cover letter requests", "script": "cover_letter.py",
                        "cron": "vacancy-cover-letters", "schedule": "*/5 * * * *",
                        "intro": "Checks the feedback Worker for Cover letter button presses and emails each "
                                 "letter as a PDF. Needs the feedback Worker; runs silently when idle."},
                       {"id": "profiles", "title": "Extra profiles", "script": "profiles.py",
                        "cron": "vacancy-profiles", "schedule": "*/5 * * * *",
                        "intro": "Adds people you invite from the feedback Worker's /admin page (their CV becomes "
                                 "their own daily report), applies unsubscribes and admin changes. Needs the "
                                 "feedback Worker; runs silently when idle."},
                       {"id": "maintenance", "title": "Nightly maintenance", "script": "maintenance.py",
                        "cron": "vacancy-maintenance", "schedule": "30 3 * * *",
                        "intro": "Deletes data past its retention period, encrypts older personal files, tightens "
                                 "file permissions and writes an encrypted backup (14 daily and 8 weekly kept)."}],
    },
}
JOB_LEVELS = [("junior", "Junior / graduate / entry level"), ("mid", "Mid level"), ("senior", "Senior"),
              ("lead", "Lead / principal / head of"), ("any", "Any level (no seniority adjustment)")]
EMPLOYMENT_TYPES = [("Permanent", "Permanent / full-time"), ("Contract", "Contract / fixed-term"),
                    ("Temporary", "Temporary"), ("Part-time", "Part-time"),
                    ("Internship", "Internship / placement / apprenticeship")]
WORK_MODES = [("On-site", "On-site"), ("Hybrid", "Hybrid"), ("Remote", "Remote")]
# Title-exclude patterns that contradict a chosen employment type.
TYPE_EXCLUDES = {"Internship": ("internship", "intern", "placement", "apprentice"), "Part-time": ("part-time",)}


def friendly_schedule(cron: str) -> str:
    """'0 7 * * *' -> '07:00', '30 6 * * 1-5' -> 'weekdays 06:30', '0 18 * * 0' -> 'sunday 18:00'."""
    parts = cron.split()
    if len(parts) == 5 and parts[0].isdigit() and parts[1].isdigit() and parts[2:4] == ["*", "*"] \
            and (parts[4] in ("*", "1-5") or parts[4] in "0123456" and len(parts[4]) == 1):
        time = f"{int(parts[1]):02d}:{int(parts[0]):02d}"
        if parts[4] == "*":
            return time
        return f"weekdays {time}" if parts[4] == "1-5" else f"{DAYS[int(parts[4])]} {time}"
    return cron


def cron_expression(reply: str) -> str | None:
    """HH:MM, 'daily HH:MM', 'weekdays HH:MM', '<day> HH:MM' or a 5-field cron expression; None if unrecognised."""
    if m := TIME_RE.match(reply.strip()):
        word = (m.group(1) or "daily").lower()
        days = "*" if word == "daily" else "1-5" if word == "weekdays" else \
            str(next(i for i, d in enumerate(DAYS) if d.startswith(word[:3])))
        return f"{int(m.group(3))} {int(m.group(2))} * * {days}"
    return reply.strip() if CRON_RE.match(reply.strip()) else None


def scheduled_jobs(pkg: str) -> list[tuple[str, dict]]:
    """(job id, info) for the package's main cron job and any extra ones (e.g. a weekly roll-up)."""
    info = PACKAGES[pkg]
    return [(pkg, info)] + [(f"{pkg}-{extra['id']}", extra) for extra in info.get("extra_jobs", [])]


def salary_symbol(country: str) -> str:
    cc = country.strip().lower()
    return "€" if cc in EURO_COUNTRIES else SALARY_SYMBOLS.get(cc, "")

BOLD, DIM, GREEN, YELLOW, RESET = ("\033[1m", "\033[2m", "\033[32m", "\033[33m", "\033[0m") \
    if sys.stdout.isatty() and os.name != "nt" else ("",) * 5


def mask(value: str) -> str:
    """Enough to recognise a stored secret (its last 4 characters, and only for long ones), never more."""
    return "" if not value else f"****{value[-4:]}" if len(value) >= 16 else "****"


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def quote(value: str) -> str:
    """Single quotes are literal for both hermes_common and python-dotenv (regex backslashes survive)."""
    if value and (value != value.strip() or " #" in value or value[0] in "\"'") and "'" not in value:
        return f"'{value}'"
    return value


def read_constant(path: Path, name: str):
    """A literal module-level constant from a package script, without importing it."""
    for node in ast.parse(path.read_text(encoding="utf-8")).body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == name for t in node.targets):
            return ast.literal_eval(node.value)
    return None


def split_top_level(pattern: str) -> list[str]:
    parts, depth, cur = [], 0, ""
    for i, ch in enumerate(pattern):
        escaped = i > 0 and pattern[i - 1] == "\\"
        if ch == "(" and not escaped:
            depth += 1
        elif ch == ")" and not escaped:
            depth -= 1
        if ch == "|" and depth == 0 and not escaped:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    return parts + [cur]


def phrase_regex(text: str) -> str:
    """'Machine learning / ML' -> regex matching either phrase, flexible about spaces and hyphens."""
    alts = []
    for alt in (a.strip() for a in text.split("/")):
        if not alt:
            continue
        body = r"[ -]?".join(re.escape(w) for w in alt.lower().split())
        alts.append((r"\b" if alt[0].isalnum() else "") + body + (r"\b" if alt[-1].isalnum() else ""))
    return "|".join(alts)


# --------------------------------------------------------------------------- settings model

@dataclass
class Setting:
    key: str
    default: str
    help: list[str]
    section: str
    basic: bool = False
    wizard: bool = False

    @property
    def secret(self) -> bool:
        return bool(SECRET_RE.search(self.key))

    @property
    def placeholder(self) -> bool:
        return bool(PLACEHOLDER_RE.search(self.default))

    @property
    def kind(self) -> str:
        if self.default in ("0", "1") and not re.search(r"PENALTY|SCORE|IMPORTANCE", self.key):
            return "bool"
        if re.fullmatch(r"\d+", self.default):
            return "int"
        return "str"


def parse_example(path: Path) -> list[Setting]:
    settings, comments, section = [], [], ""
    basic = wizard = False
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if m := SECTION_RE.match(line):
            section, comments, basic, wizard = m.group(1), [], False, False
        elif line == "# @basic":
            basic = True
        elif line == "# @wizard":
            wizard = True
        elif line.startswith("#"):
            comments.append(line.lstrip("# ").rstrip())
        elif m := KEY_RE.match(line):
            settings.append(Setting(m.group(1), unquote(m.group(2)), comments, section, basic, wizard))
            comments, basic, wizard = [], False, False
        elif not line:
            comments, basic, wizard = [], False, False
    return settings


class EnvFile:
    """$HERMES_HOME/.env: update keys in place, append new ones in a labelled block."""

    def __init__(self, path: Path):
        self.path = path
        self.lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []

    def values(self) -> dict[str, str]:
        out = {}
        for line in self.lines:
            if m := KEY_RE.match(line.strip()):
                out[m.group(1)] = unquote(m.group(2))
        return out

    def render(self, changes: dict[str, str], label: str) -> str:
        lines, done = list(self.lines), set()
        for i, line in enumerate(lines):
            m = KEY_RE.match(line.strip())
            if m and m.group(1) in changes:
                lines[i] = f"{m.group(1)}={quote(changes[m.group(1)])}"
                done.add(m.group(1))
        new = [k for k in changes if k not in done]
        if new:
            lines += ([""] if lines else []) + [f"# ---------------------------------------------------------------- {label}"]
            lines += [f"{k}={quote(changes[k])}" for k in new]
        return "\n".join(lines).rstrip("\n") + "\n"


# --------------------------------------------------------------------------- running Hermes commands

class Runner:
    """Runs `hermes` and package scripts locally or inside the Hermes Docker container."""

    def __init__(self, args, scripts_dir: Path):
        self.args, self.scripts_dir, self.mode = args, scripts_dir, None
        if args.container:
            self.mode = "docker"
        elif shutil.which("hermes"):
            self.mode = "local"
        elif shutil.which("docker") and self._container_running("hermes-agent"):
            args.container, self.mode = "hermes-agent", "docker"

    @staticmethod
    def _container_running(name: str) -> bool:
        try:
            out = subprocess.run(["docker", "ps", "--format", "{{.Names}}"], capture_output=True, text=True,
                                 timeout=20).stdout.split()
        except (OSError, subprocess.SubprocessError):
            return False
        return name in out

    def describe(self) -> str:
        if self.mode == "docker":
            return f"inside the '{self.args.container}' container as user '{self.args.container_user}'"
        return "with the local `hermes` command" if self.mode == "local" else "not available"

    def command(self, argv: list[str], tty: bool = False, in_scripts: bool = False) -> list[str]:
        if self.mode == "docker":
            workdir = f"{self.args.container_home.rstrip('/')}/scripts" if in_scripts else self.args.container_home
            return (["docker", "exec"] + (["-it"] if tty else []) +
                    ["-u", self.args.container_user, "-w", workdir, self.args.container] + argv)
        return argv

    def run(self, argv: list[str], tty: bool = False, capture: bool = False, in_scripts: bool = False,
            timeout: int | None = None) -> subprocess.CompletedProcess | None:
        if not self.mode:
            return None
        cmd = self.command(argv, tty and sys.stdin.isatty(), in_scripts)
        cwd = self.scripts_dir if self.mode == "local" and in_scripts else None
        try:
            return subprocess.run(cmd, cwd=cwd, text=True, capture_output=capture, timeout=timeout)
        except (OSError, subprocess.SubprocessError) as exc:
            print(f"{YELLOW}  command failed: {exc}{RESET}")
            return None

    def cron_jobs(self) -> list[dict]:
        res = self.run(["hermes", "cron", "list"], capture=True, timeout=60)
        if not res or res.returncode:
            return []
        jobs, cur = [], None
        for line in res.stdout.splitlines():
            if m := re.match(r"^\s{2}([0-9a-f]{6,})\s+\[", line):
                cur = {"id": m.group(1)}
                jobs.append(cur)
            elif cur is not None and (m := re.match(r"^\s+(Name|Schedule|Script):\s+(.*)$", line)):
                cur[m.group(1).lower()] = m.group(2).strip()
        return jobs


# --------------------------------------------------------------------------- the wizard

class Wizard:
    def __init__(self, args):
        self.args = args
        self.interactive = not args.non_interactive
        self.answers = self._load_answers(args.answers)
        self.changes: dict[str, str] = {}
        self.files: dict[Path, str] = {}
        self.current: dict[str, str] = {}
        self.schedule_plan: dict[str, tuple[dict, str | None]] = {}
        self._cron_jobs: list[dict] | None = None
        self.cloudflare_factory = cloudflare_worker.Cloudflare
        self.cf_plan: dict | None = None

    # ------------------------------------------------------------------ prompting

    @staticmethod
    def _load_answers(path: str | None) -> dict[str, str]:
        if not path:
            return {}
        out = {}
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            if m := KEY_RE.match(line.strip()):
                out[m.group(1)] = unquote(m.group(2))
        return out

    def heading(self, text: str) -> None:
        print(f"\n{BOLD}== {text}{RESET}")

    def say(self, text: str = "") -> None:
        print(text)

    def _input(self, prompt: str, secret: bool = False) -> str:
        try:
            if secret and sys.stdin.isatty():
                return getpass.getpass(prompt)
            return input(prompt)
        except EOFError:
            return ""

    def confirm(self, question: str, default: bool = True) -> bool:
        if not self.interactive:
            return default
        hint = "Y/n" if default else "y/N"
        while True:
            reply = self._input(f"{question} [{hint}] ").strip().lower()
            if not reply:
                return default
            if reply in ("y", "yes", "n", "no"):
                return reply.startswith("y")

    def text(self, question: str, default: str = "", allow_empty: bool = True) -> str:
        if not self.interactive:
            return default
        while True:
            shown = f" [{default}]" if default else ""
            reply = self._input(f"{question}{shown}: ").strip()
            value = default if not reply else "" if reply == "-" else reply
            if value or allow_empty:
                return value

    def multiline(self, question: str) -> str:
        if not self.interactive:
            return ""
        self.say(f"{question} (finish with a line containing only a dot '.')")
        lines = []
        while True:
            line = self._input("")
            if line.strip() == "." or (not line and lines and not lines[-1]):
                break
            lines.append(line)
        return "\n".join(lines).strip()

    def listing(self, question: str, default: list[str]) -> list[str]:
        reply = self.text(question, ", ".join(default))
        return [p.strip() for p in reply.split(",") if p.strip()]

    def preset(self, key: str, default: str = "") -> str:
        """Default for a guided question: --answers / environment (non-interactive), then current value."""
        if not self.interactive:
            if key in self.answers:
                return self.answers[key]
            if key in os.environ:
                return os.environ[key]
        return self.value(key, default)

    def _pick(self, reply: str, options: list[tuple[str, str]]) -> list[str] | None:
        ids = {o.lower(): o for o, _ in options}
        picked = []
        for token in (t.strip() for t in reply.split(",") if t.strip()):
            if token.isdigit() and 1 <= int(token) <= len(options):
                picked.append(options[int(token) - 1][0])
            elif token.lower() in ids:
                picked.append(ids[token.lower()])
            else:
                self.say(f"  {YELLOW}unknown choice '{token}'{RESET}")
                return None
        return list(dict.fromkeys(picked))

    def choose(self, question: str, options: list[tuple[str, str]], current: list[str],
               many: bool = True) -> list[str]:
        """Numbered menu; the reply is numbers or ids, comma-separated when many is true."""
        if not self.interactive:
            return current
        for i, (oid, label) in enumerate(options, 1):
            mark = "*" if oid in current else " "
            self.say(f"  {mark} {i:>2}) {label}" + (f" {DIM}[{oid}]{RESET}" if oid.lower() != label.lower() else ""))
        default = ",".join(str(i) for i, (oid, _) in enumerate(options, 1) if oid in current)
        hint = " (numbers, comma-separated)" if many else ""
        while True:
            picked = self._pick(self.text(question + hint, default), options)
            if picked and (many or len(picked) == 1):
                return picked
            if picked is not None:
                self.say(f"  {YELLOW}choose {'at least one' if many else 'exactly one'}{RESET}")

    def ask_setting(self, s: Setting) -> str:
        current = self.changes.get(s.key, self.current.get(s.key))
        if not self.interactive:
            if s.key in self.answers:
                return self.answers[s.key]
            if s.key in os.environ and s.key not in ("HERMES_HOME",):
                return os.environ[s.key]
            return current if current is not None else ("" if s.placeholder else s.default)

        self.say(f"\n{BOLD}{s.key}{RESET}" + (f"  {DIM}({s.section}){RESET}" if s.section else ""))
        for line in s.help:
            self.say(f"  {DIM}{line}{RESET}")
        if s.placeholder:
            self.say(f"  {DIM}e.g. {s.default}{RESET}")
        base = current if current is not None else ("" if s.placeholder else s.default)

        if s.secret:
            state = f"current {mask(base)}" if base else "not set"
            while True:
                reply = self._input(f"  value ({state}; Enter keeps it, '-' clears): ", secret=True).strip()
                if not reply:
                    return base
                if reply == "-":
                    return ""
                return reply
        if s.kind == "bool":
            return "1" if self.confirm("  enable?", base == "1") else "0"
        clear_hint = " ('-' clears)" if base else ""
        while True:
            reply = self._input(f"  value [{base}]{clear_hint}: ").strip()
            value = base if not reply else "" if reply == "-" else reply
            if s.kind == "int" and value and not value.isdigit():
                self.say(f"  {YELLOW}please enter a whole number{RESET}")
                continue
            return value

    # ------------------------------------------------------------------ values

    def value(self, key: str, default: str = "") -> str:
        return self.changes.get(key, self.current.get(key, default))

    def set(self, key: str, value: str, example_default: str = "") -> None:
        stored = self.current.get(key)
        if stored is None and value in ("", example_default):
            self.changes.pop(key, None)
        elif value != stored:
            self.changes[key] = value
        else:
            self.changes.pop(key, None)

    def run_settings(self, settings: list[Setting]) -> None:
        for s in settings:
            if s.wizard or not (s.basic or self.args.advanced):
                continue
            self.set(s.key, self.ask_setting(s), s.default)

    # ------------------------------------------------------------------ steps

    def choose_home(self) -> Path:
        candidates = [self.args.hermes_home, os.environ.get("HERMES_HOME"),
                      "/opt/data" if Path("/opt/data/config.yaml").is_file() else None, str(Path.home() / ".hermes")]
        default = next(c for c in candidates if c)
        home = Path(self.text("Hermes home directory (holds config.yaml and .env)", default, allow_empty=False))
        if not (home / "config.yaml").is_file():
            self.say(f"{YELLOW}  {home}/config.yaml not found. Packages read the model from it; continuing anyway.{RESET}")
        return home

    def choose_packages(self) -> list[str]:
        available = sorted(p.name for p in PACKAGES_DIR.iterdir() if (p / ".env.example").is_file())
        if self.args.packages:
            unknown = set(self.args.packages) - set(available)
            if unknown:
                sys.exit(f"unknown package(s): {', '.join(sorted(unknown))}; available: {', '.join(available)}")
            return self.args.packages
        if not self.interactive:
            return available
        chosen = [p for p in available if self.confirm(
            f"Set up {PACKAGES.get(p, {}).get('title', p)} ({p})?", True)]
        if not chosen:
            sys.exit("Nothing selected.")
        return chosen

    def owner(self, home: Path) -> str | None:
        if self.args.owner:
            return self.args.owner
        if hasattr(os, "geteuid") and os.geteuid() == 0 and home.exists():
            st = home.stat()
            if st.st_uid != 0:
                return f"{st.st_uid}:{st.st_gid}"
        return None

    def install(self, home: Path, packages: list[str], owner: str | None) -> None:
        self.heading("Installing files")
        cmd = ["sh", str(REPO / "scripts" / "install.sh"), *packages]
        if self.args.dry_run:
            self.say(f"  would run: HERMES_HOME={home} {shlex.join(cmd)}")
            return
        env = {**os.environ, "HERMES_HOME": str(home), "HERMITSHELL_SETUP": "1",
               **({"HERMES_OWNER": owner} if owner else {})}
        if subprocess.run(cmd, env=env).returncode:
            sys.exit("install.sh failed; fix the error above and re-run the wizard.")

    def shared(self) -> None:
        self.heading("Shared settings: email, web search API keys, timezone")
        self.say("Enter keeps the value in [brackets]. API keys you don't have can be left empty.")
        self.run_settings(parse_example(REPO / ".env.example"))
        keys = ("FIRECRAWL_API_KEY", "TAVILY_API_KEY", "SCRAPFLY_API_KEY")
        if not any(self.value(k) for k in keys):
            self.say(f"{YELLOW}  No web search key set. The vacancy report needs at least one of "
                     f"Firecrawl, Tavily or Scrapfly (all have free tiers).{RESET}")
        if not self.value("SMTP_USER") or not self.value("SMTP_PASSWORD"):
            self.say(f"{YELLOW}  SMTP login incomplete: reports can't be emailed until it is set.{RESET}")
        self.data_key()

    def data_key(self) -> None:
        """HERMES_DATA_KEY encrypts CVs, profiles, letters and backups: made once and never replaced, since files
        encrypted with it can't be read without it."""
        if value := self.preset("HERMES_DATA_KEY"):
            self.set("HERMES_DATA_KEY", value)
            return
        self.set("HERMES_DATA_KEY", base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("="))
        self.say(f"  {DIM}generated HERMES_DATA_KEY: it encrypts CVs, profiles, letters and the nightly backups. "
                 f"Copy it from .env into a password manager; without it those can't be read.{RESET}")

    # ------------------------------------------------------------------ package: daily-vacancy-report

    def job_search(self) -> None:
        self.heading("Job search: where and what kind of job")
        region = self.text("Where are you job hunting? Region or city (empty = anywhere)",
                           self.preset("JOB_REGION_NAME"))
        self.set("JOB_REGION_NAME", region)
        if region:
            places = [p for p in self.preset("JOB_REGION_PLACES").split(",") if p.strip()] or [region]
            self.set("JOB_REGION_PLACES", ", ".join(self.listing(
                "Towns or areas that count as inside it (comma-separated)", [p.strip() for p in places])))
        else:
            self.set("JOB_REGION_PLACES", "")
        location = self.preset("JOB_SEARCH_LOCATION")
        if self.args.advanced or (location and location != region):
            location = self.text("Location text used in searches (empty = the region)", location)
        self.set("JOB_SEARCH_LOCATION", location if location != region else "")

        default = self.preset("JOB_SEARCH_COUNTRY").lower()
        while True:
            country = self.text("Country, as a two-letter code (gb, ie, us, de...; empty = none)", default).lower()
            if not country or re.fullmatch(r"[a-z]{2}", country):
                break
            if not self.interactive:
                sys.exit(f"JOB_SEARCH_COUNTRY: '{country}' is not a two-letter country code")
            self.say(f"  {YELLOW}use a two-letter code such as gb or us{RESET}")
        country = "gb" if country == "uk" else country
        self.set("JOB_SEARCH_COUNTRY", country)
        self.set("JOB_REMOTE_ANYWHERE", "1" if self.confirm(
            "Include fully remote jobs based outside that region?",
            self.preset("JOB_REMOTE_ANYWHERE", "0") == "1") else "0", "0")

        level = self.preset("JOB_LEVEL", "any").lower()
        self.say("\nWhat level are you targeting? Titles above or below it get a lower fit score.")
        self.set("JOB_LEVEL", self.choose("Level", JOB_LEVELS, [level if level in dict(JOB_LEVELS) else "any"],
                                          many=False)[0], "any")
        types = [t.strip() for t in self.preset("JOB_EMPLOYMENT_TYPES", "Permanent,Contract,Temporary").split(",")]
        types = ["Permanent" if t == "Full-time" else t for t in types if t]
        self.say("\nEmployment types to keep (jobs that don't say are always kept):")
        types = self.choose("Types", EMPLOYMENT_TYPES, types)
        self.set("JOB_EMPLOYMENT_TYPES", ",".join(types), "Permanent,Contract,Temporary")
        exclude = self.value("JOB_TITLE_EXCLUDE")
        if exclude:
            kept = self.strip_type_excludes(exclude, types)
            if kept != exclude:
                self.say(f"  {DIM}removed {', '.join(t for t in types if t in TYPE_EXCLUDES)} "
                         f"from your title exclusions{RESET}")
                self.set("JOB_TITLE_EXCLUDE", kept)
        modes = [m.strip() for m in self.preset("JOB_WORK_MODES", "On-site,Hybrid,Remote").split(",") if m.strip()]
        self.say("\nWork modes to keep:")
        self.set("JOB_WORK_MODES", ",".join(self.choose("Work modes", WORK_MODES, modes)), "On-site,Hybrid,Remote")
        self.job_salary_and_agencies()

    def job_salary_and_agencies(self) -> None:
        self.say("\nMinimum salary: jobs whose advertised pay is clearly below it are left out. Jobs that don't\n"
                 "list a salary are always kept; day and hourly rates are converted to a yearly figure.")
        while True:
            reply = self.text("Minimum yearly salary, e.g. 45000 or 45k (0 = no minimum)",
                              self.preset("JOB_MIN_SALARY", "0")).lower().replace(",", "")
            if m := re.fullmatch(r"(\d+(?:\.\d+)?)(k?)", reply or "0"):
                minimum = int(float(m.group(1)) * (1000 if m.group(2) else 1))
                break
            if not self.interactive:
                sys.exit(f"JOB_MIN_SALARY: '{reply}' is not a number")
            self.say(f"  {YELLOW}enter a number such as 45000 or 45k{RESET}")
        self.set("JOB_MIN_SALARY", str(minimum) if minimum else "0", "0")
        if minimum:
            symbol = self.preset("JOB_SALARY_CURRENCY") or salary_symbol(self.value("JOB_SEARCH_COUNTRY"))
            self.set("JOB_SALARY_CURRENCY", self.text(
                "Currency symbol in the adverts (salaries in another currency are kept; empty = any)", symbol))
        self.set("JOB_HIDE_UNNAMED_AGENCY", "1" if self.confirm(
            "Hide recruitment-agency adverts that don't name the employer? (repeats of the same job are "
            "always merged)", self.preset("JOB_HIDE_UNNAMED_AGENCY", "0") == "1") else "0", "0")

    def feedback_buttons(self) -> None:
        self.heading("Feedback buttons and admin page (Cloudflare, optional)")
        self.say("Buttons on each job (Interested, Not for me, I applied, Cover letter, Tailored CV), the /admin\n"
                 "page for extra profiles and the sign-up links run on a small free Cloudflare Worker. With a free\n"
                 "Cloudflare account's ID and an API token the wizard deploys it for you and fills in its address;\n"
                 "docs/cloudflare-setup.md shows how to create both.")
        account, token = self.preset("CLOUDFLARE_ACCOUNT_ID"), self.preset("CLOUDFLARE_API_TOKEN")
        if self.interactive:
            if not self.confirm("Set up the feedback Worker automatically with a Cloudflare API token?",
                                bool(account and token) or not self.preset("JOB_FEEDBACK_URL")):
                return self.feedback_manual()
            account = self.text("Cloudflare account ID (32 characters, dashboard -> Workers & Pages)", account)
            state = f"current {mask(token)}" if token else "not set"
            token = self._input(f"Cloudflare API token ({state}; Enter keeps it): ", secret=True).strip() or token
        elif not (account and token):
            return self.feedback_manual()
        try:
            cf = self.cloudflare_factory(account, token)
            cf.verify()
            subdomain = cf.subdomain()
        except cloudflare_worker.CloudflareError as exc:
            if not self.interactive:
                sys.exit(f"Cloudflare: {exc}")
            self.say(f"  {YELLOW}Cloudflare: {exc}{RESET}")
            return self.feedback_manual()
        self.say(f"  {GREEN}token works{RESET}")
        new_subdomain = ""
        if not subdomain:
            self.say("This account has no workers.dev subdomain yet. Pick one: Workers get addresses like\n"
                     "https://vacancy-feedback.<subdomain>.workers.dev (it can't easily be changed later).")
            while True:
                new_subdomain = self.text("workers.dev subdomain", self.preset(
                    "CLOUDFLARE_SUBDOMAIN", f"hermit-{secrets.token_hex(3)}")).lower()
                if cloudflare_worker.NAME_RE.match(new_subdomain):
                    break
                if not self.interactive:
                    sys.exit(f"CLOUDFLARE_SUBDOMAIN: '{new_subdomain}' is not valid")
                self.say(f"  {YELLOW}use lowercase letters, digits and hyphens{RESET}")
            subdomain = new_subdomain
        name = self.preset("CLOUDFLARE_WORKER_NAME", cloudflare_worker.DEFAULT_NAME)
        if self.args.advanced:
            name = self.text("Worker name", name).lower()
        if not cloudflare_worker.NAME_RE.match(name):
            sys.exit(f"CLOUDFLARE_WORKER_NAME: '{name}' is not valid (lowercase letters, digits and hyphens)")
        self.set("CLOUDFLARE_ACCOUNT_ID", cf.account)
        self.set("CLOUDFLARE_API_TOKEN", token)
        self.set("CLOUDFLARE_WORKER_NAME", name, cloudflare_worker.DEFAULT_NAME)
        url, current = cloudflare_worker.worker_url(name, subdomain), self.preset("JOB_FEEDBACK_URL").rstrip("/")
        if current and current != url and not current.endswith(".workers.dev"):
            self.say(f"  {DIM}keeping your custom address {current}{RESET}")
            url = current
        self.set("JOB_FEEDBACK_URL", url)
        self.feedback_secrets()
        worker_secrets = {k: self.value(k) for k in ("JOB_FEEDBACK_SECRET", "JOB_FEEDBACK_API_TOKEN")}

        self.say("\nThe /admin page (invite people, manage profiles and keys) stays off until it has a password.")
        password = self.admin_password()
        if password:
            worker_secrets["ADMIN_USER"] = self.text("Admin page username", self.preset("ADMIN_USER", "admin")) \
                or "admin"
            worker_secrets["ADMIN_PASSWORD"] = password
        emails: list[str] = []
        access = self.preset("CLOUDFLARE_ACCESS_EMAILS")
        if self.interactive:
            if self.confirm("Also protect /admin with Cloudflare Access (a code emailed to you before the "
                            "password page; needs Zero Trust, free)?", bool(access)):
                access = self.text("Emails allowed in (comma-separated)", access or self.value("ALERT_EMAIL"))
            else:
                access = ""
        emails = [e.strip() for e in access.split(",") if e.strip()]
        bad = [e for e in emails if not cloudflare_worker.EMAIL_RE.match(e)]
        if bad:
            sys.exit(f"CLOUDFLARE_ACCESS_EMAILS: not an email address: {', '.join(bad)}")
        self.set("CLOUDFLARE_ACCESS_EMAILS", ",".join(emails))
        self.cf_plan = {"cf": cf, "name": name, "subdomain": subdomain, "new_subdomain": new_subdomain,
                        "secrets": worker_secrets, "emails": emails}

    def admin_password(self) -> str:
        """A new /admin password (asked twice, 12+ characters), or "" to keep the Worker's current one."""
        if not self.interactive:
            password = self.answers.get("ADMIN_PASSWORD", "")
            if password and len(password) < 12:
                sys.exit("ADMIN_PASSWORD: use at least 12 characters")
            return password
        while True:
            first = self._input("New admin password (12+ characters; Enter keeps the current one): ",
                                secret=True).strip()
            if not first:
                return ""
            if len(first) < 12:
                self.say(f"  {YELLOW}use at least 12 characters{RESET}")
                continue
            if self._input("Repeat the password: ", secret=True).strip() == first:
                return first
            self.say(f"  {YELLOW}the two passwords differ; try again{RESET}")

    def feedback_secrets(self) -> None:
        for key in ("JOB_FEEDBACK_SECRET", "JOB_FEEDBACK_API_TOKEN"):
            value = self.preset(key)
            if not value:
                value = secrets.token_urlsafe(32)
                self.say(f"  {DIM}generated {key}{RESET}")
            self.set(key, value)

    def deploy_worker(self) -> None:
        """Create the subdomain if needed, upload the Worker, set its secrets and optionally the Access app."""
        plan = self.cf_plan
        self.heading("Feedback Worker (Cloudflare)")
        if self.args.dry_run:
            self.say(f"  would deploy {plan['name']} to {cloudflare_worker.worker_url(plan['name'], plan['subdomain'])}"
                     f" and set {', '.join(plan['secrets'])}")
            return
        cf = plan["cf"]
        try:
            if plan["new_subdomain"]:
                cf.create_subdomain(plan["new_subdomain"])
                self.say(f"  workers.dev subdomain {plan['new_subdomain']}: created")
            url = cloudflare_worker.deploy(cf, plan["name"], plan["subdomain"], plan["secrets"], log=self.say)
            if plan["emails"]:
                try:
                    cloudflare_worker.protect_admin(cf, plan["name"], plan["subdomain"], plan["emails"], log=self.say)
                except cloudflare_worker.CloudflareError as exc:
                    self.say(f"  {YELLOW}Access not set up: {exc}{RESET}\n  The Worker works without it; see "
                             "docs/cloudflare-setup.md#protect-admin-with-cloudflare-access.")
        except cloudflare_worker.CloudflareError as exc:
            self.say(f"  {YELLOW}Cloudflare: {exc}{RESET}\n  Fix it and re-run the wizard, or run "
                     "`python3 scripts/cloudflare_worker.py` (it reads the saved settings).")
            return
        self.say(f"  {GREEN}ready: {url}{RESET}" + ("  (sign in at /admin)" if "ADMIN_PASSWORD" in plan["secrets"]
                                                   else ""))

    def feedback_manual(self) -> None:
        self.say("Deploy the Worker by hand (docs/feedback-worker.md), then paste its URL here (empty = skip).")
        while True:
            url = self.text("Feedback Worker URL", self.preset("JOB_FEEDBACK_URL")).rstrip("/")
            if not url or re.fullmatch(r"https://[^\s/?#]+(/[^\s?#]*)?", url):
                break
            if not self.interactive:
                sys.exit(f"JOB_FEEDBACK_URL: '{url}' must start with https://")
            self.say(f"  {YELLOW}use the full https:// address of your Worker{RESET}")
        self.set("JOB_FEEDBACK_URL", url)
        if url:
            self.feedback_secrets()

    def upload_feedback_secrets(self, home: Path) -> None:
        """Copy newly set feedback secrets to the Worker by piping them to wrangler; they are never printed."""
        keys = [k for k in ("JOB_FEEDBACK_SECRET", "JOB_FEEDBACK_API_TOKEN") if self.changes.get(k)]
        if not keys:
            return
        worker = PACKAGES_DIR / "daily-vacancy-report" / "feedback-worker"
        self.heading("Feedback Worker secrets")
        npx = (os.name == "nt" and shutil.which("npx.cmd")) or shutil.which("npx")
        if npx and self.interactive and not self.args.dry_run and self.confirm(
                "Copy the new secrets to your Worker now with wrangler? (run `npx wrangler login` first)", True):
            failed = False
            for key in keys:
                res = subprocess.run([npx, "wrangler", "secret", "put", key], input=self.changes[key] + "\n",
                                     text=True, cwd=worker, capture_output=True)
                failed |= res.returncode != 0
                self.say(f"  {GREEN if not res.returncode else YELLOW}{key}: "
                         f"{'uploaded' if not res.returncode else 'failed'}{RESET}")
                if res.returncode:
                    self.say(re.sub(r"[A-Za-z0-9_-]{32,}", "****", (res.stdout + res.stderr).strip())[-400:])
            if not failed:
                return
        env_path = home / ".env"
        self.say(f"From {worker}, copy them to the Worker (the values are piped, not shown):")
        for key in keys:
            self.say(f"  sed -n 's/^{key}=//p' {shlex.quote(str(env_path))} | npx wrangler secret put {key}")

    @staticmethod
    def strip_type_excludes(exclude: str, types: list[str]) -> str:
        words = [w for t in types for w in TYPE_EXCLUDES.get(t, ())]
        parts = split_top_level(exclude)
        return "|".join(p for p in parts if not any(re.search(p, w, re.I) for w in words))

    def job_targets(self, scripts: Path) -> None:
        self.heading("Job titles")
        pkg = PACKAGES_DIR / "daily-vacancy-report"
        builtin_exclude = read_constant(pkg / "job_scanner.py", "DEFAULT_TITLE_EXCLUDE") or ""
        current = [t for t in self.value("JOB_TARGET_TITLES").split("||") if t.strip()]
        titles = self.listing("Job titles to search for (comma-separated)", current)
        location = self.value("JOB_SEARCH_LOCATION") or self.value("JOB_REGION_NAME")
        old_location = self.current.get("JOB_SEARCH_LOCATION") or self.current.get("JOB_REGION_NAME") or ""
        moved = location != old_location and bool(self.value("JOB_SCANNER_QUERIES"))
        if not titles or (titles == (current) and not moved):
            if self.args.advanced:
                self.advanced_job_filters()
            return
        nijobs = bool(self.value("JOB_SCANNER_NIJOBS_KEYWORDS"))
        self.set("JOB_TARGET_TITLES", "||".join(titles))
        queries = []
        for i in range(0, len(titles), 3):
            group = " OR ".join(f'"{t}"' for t in titles[i:i + 3])
            q = f"({group})" + (f' "{location}"' if location else "") + " job" + (" -site:nijobs.com" if nijobs else "")
            queries.append(q)
        self.set("JOB_SCANNER_QUERIES", "||".join(queries))
        self.say(f"  {DIM}web searches: {' || '.join(queries)}{RESET}")

        if self.confirm("Use these titles as the title filter too? (recommended unless you target AI / ML / data roles)",
                        True):
            self.set("JOB_TITLE_STRONG", "|".join(phrase_regex(t) for t in titles))
        exclude = self.value("JOB_TITLE_EXCLUDE") or self.strip_type_excludes(
            builtin_exclude, self.value("JOB_EMPLOYMENT_TYPES").split(","))
        kept = [p for p in split_top_level(exclude) if not any(re.search(p, t, re.I) for t in titles)]
        if len(kept) != len(split_top_level(exclude)):
            self.say(f"  {DIM}removed words matching your titles from the exclude filter{RESET}")
            self.set("JOB_TITLE_EXCLUDE", "|".join(kept))
        if self.args.advanced:
            self.advanced_job_filters()

    def advanced_job_filters(self) -> None:
        for key, label in (("JOB_SCANNER_QUERIES", "Web search queries ('||'-separated)"),
                           ("JOB_TARGET_TITLES", "Job titles ('||'-separated)"),
                           ("JOB_TITLE_STRONG", "Strong title regex"),
                           ("JOB_TITLE_EXCLUDE", "Exclude title regex")):
            self.set(key, self.text(label + " (empty = built-in default)", self.value(key)))

    def job_profile(self, scripts: Path) -> None:
        self.heading("Candidate profile")
        pkg = PACKAGES_DIR / "daily-vacancy-report"
        profile, keywords = scripts / "job_profile.md", scripts / "cv_keywords.json"
        self.say("job_profile.md is what the model compares every job against; cv_keywords.json lists the\n"
                 "skills to highlight and the technologies to flag as gaps.")
        if profile.is_file() and self.confirm(f"Keep your existing {profile.name}?", True):
            skills = None
        else:
            skills = self.write_profile(profile, pkg)
        if keywords.is_file() and self.confirm(f"Keep your existing {keywords.name}?", True):
            return
        if skills is None:
            skills = self.listing("Your skills, for CV keyword matching (comma-separated; empty = example list)", [])
        gaps = self.listing("Technologies you DON'T have, flagged as gaps when a job asks for them "
                            "(comma-separated)", []) if skills else []
        if skills:
            data = {"cv_keywords": {s: phrase_regex(s) for s in skills},
                    "other_tech": {g: phrase_regex(g) for g in gaps}}
            self.files[keywords] = json.dumps(data, indent=2) + "\n"
        elif not keywords.is_file():
            self.files[keywords] = (pkg / "cv_keywords.example.json").read_text(encoding="utf-8")
            self.say(f"  {DIM}using the example keywords; edit {keywords} later{RESET}")

    def write_profile(self, profile: Path, pkg: Path) -> list[str] | None:
        options = {"1": "answer a few questions (recommended)", "2": "import a text or markdown file (e.g. your CV)",
                   "3": "paste your profile text", "4": "start from the example and edit it later"}
        choice = "4"
        if self.interactive:
            for k, v in options.items():
                self.say(f"  {k}) {v}")
            choice = self.text("Choose", "1")
        if choice == "2":
            path = Path(self.text("Path to the file", allow_empty=False)).expanduser()
            try:
                self.files[profile] = path.read_text(encoding="utf-8", errors="replace")
                return None
            except OSError as exc:
                self.say(f"{YELLOW}  could not read {path}: {exc}; using the example instead{RESET}")
                choice = "4"
        if choice == "3":
            text = self.multiline("Paste your profile")
            if text:
                self.files[profile] = text + "\n"
                return None
            choice = "4"
        if choice != "1":
            self.files[profile] = (pkg / "job_profile.example.md").read_text(encoding="utf-8")
            self.say(f"  {DIM}copied the example; rewrite {profile} before the first real run{RESET}")
            return None

        name = self.value("JOB_CANDIDATE_NAME")
        name = self.text("Your first name", "" if name == "the candidate" else name)
        if name:
            self.set("JOB_CANDIDATE_NAME", name, "the candidate")
        summary = self.multiline("Short summary: current role, years of experience, what you've built")
        skills = self.listing("Core skills (comma-separated)", [])
        titles = self.listing("Job titles you want", [t for t in self.value("JOB_TARGET_TITLES").split("||") if t])
        level = dict(JOB_LEVELS).get(self.value("JOB_LEVEL", "any"), "")
        seniority = self.text("Seniority you're targeting (e.g. mid-level individual contributor)",
                              "" if self.value("JOB_LEVEL", "any") == "any" else level)
        types = self.text("Employment types", self.value("JOB_EMPLOYMENT_TYPES", "Permanent,Contract,Temporary")
                          .replace(",", ", "))
        mode = self.text("Work mode", self.value("JOB_WORK_MODES", "On-site,Hybrid,Remote").replace(",", ", "))
        avoid = self.text("Roles or conditions you're NOT interested in")
        gaps = self.listing("Honest gaps the model should know about (comma-separated)", [])
        looking = [line for line in (f"- Titles: {', '.join(titles)}" if titles else "",
                                     f"- Seniority: {seniority}" if seniority else "",
                                     f"- Employment: {types}" if types else "",
                                     f"- Work mode: {mode}" if mode else "",
                                     f"- Not interested in: {avoid}" if avoid else "") if line]
        parts = ["# Candidate profile", "## Summary", summary or f"{name or 'The candidate'} is looking for a new role."]
        if skills:
            parts += ["## Core skills", "\n".join(f"- {s}" for s in skills)]
        if looking:
            parts += ["## Looking for", "\n".join(looking)]
        if gaps:
            parts += ["## Gaps (be honest, the model uses this)", "\n".join(f"- {g}" for g in gaps)]
        self.files[profile] = "\n\n".join(parts) + "\n"
        return skills

    # ------------------------------------------------------------------ saving

    def review_and_write(self, home: Path, owner: str | None) -> bool:
        self.heading("Review")
        secret_keys = {k for k in self.changes if SECRET_RE.search(k)}
        if not self.changes and not self.files:
            self.say("No changes.")
            return True
        for key, value in self.changes.items():
            shown = mask(value) if key in secret_keys else value
            self.say(f"  {key}={shown if value else '(cleared)'}")
        for path in self.files:
            self.say(f"  write {path}")
        if self.args.dry_run:
            self.say(f"\n{YELLOW}Dry run: nothing written.{RESET}")
            return False
        if not self.confirm(f"Save {len(self.changes)} setting(s) to {home / '.env'}"
                            f"{' and ' + str(len(self.files)) + ' file(s)' if self.files else ''}?", True):
            self.say("Nothing saved.")
            return False

        env_path = home / ".env"
        env = EnvFile(env_path)
        if self.changes:
            if env_path.is_file():
                backup = env_path.with_name(f".env.bak-{datetime.now():%Y%m%d-%H%M%S}")
                shutil.copy2(env_path, backup)
                os.chmod(backup, 0o600)
                self.say(f"  backup: {backup}")
            env_path.parent.mkdir(parents=True, exist_ok=True)
            env_path.write_text(env.render(self.changes, f"HermitShell (setup.py, {datetime.now():%Y-%m-%d})"),
                                encoding="utf-8", newline="\n")
            os.chmod(env_path, 0o600)
            self._chown(env_path, owner)
        for path, content in self.files.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
            self._chown(path, owner)
        self.say(f"  {GREEN}saved{RESET}")
        return True

    @staticmethod
    def _chown(path: Path, owner: str | None) -> None:
        if owner and hasattr(os, "chown"):
            uid, _, gid = owner.partition(":")
            os.chown(path, int(uid), int(gid or uid))

    # ------------------------------------------------------------------ cron + tests

    def existing_job(self, runner: Runner, info: dict) -> dict | None:
        if self._cron_jobs is None:
            self._cron_jobs = runner.cron_jobs() if runner.mode else []
        return next((j for j in self._cron_jobs if j.get("script", "").rsplit("/", 1)[-1] == info["script"]), None)

    def ask_schedule(self, runner: Runner, job_id: str, info: dict) -> None:
        existing = self.existing_job(runner, info)
        default = friendly_schedule(existing.get("schedule", info["schedule"]) if existing else info["schedule"])
        key = "SCHEDULE_" + job_id.upper().replace("-", "_")
        if not self.interactive:
            default = self.answers.get(key, os.environ.get(key, default))
        self.say(f"\nWhen should {info['title']} run? " + (f"{info['intro']}\n" if info.get("intro") else "")
                 + "Times use Hermes' timezone (`timezone:` in config.yaml).\n"
                 f"  {DIM}HH:MM runs daily, 'weekdays HH:MM' Monday to Friday, 'sunday HH:MM' once a week; "
                 f"a cron expression also works; '-' skips scheduling{RESET}")
        while True:
            reply = self.text("Run time", default)
            if not reply or reply == "-":
                self.schedule_plan[job_id] = (info, None)
                return
            if cron := cron_expression(reply):
                self.schedule_plan[job_id] = (info, cron)
                return
            if not self.interactive:
                sys.exit(f"{key}: unrecognised schedule '{reply}'")
            self.say(f"  {YELLOW}enter a time like 07:30, 'weekdays 08:00', 'sunday 18:00' or a cron expression{RESET}")

    def schedules(self, runner: Runner) -> None:
        self.heading("Schedules")
        for info, cron in self.schedule_plan.values():
            if cron is None:
                continue
            existing = self.existing_job(runner, info)
            current_script = existing and existing.get("script", "").endswith(info["script"])
            if current_script and existing.get("schedule") == cron:
                self.say(f"  {DIM}{info['title']}: unchanged ({friendly_schedule(cron)}){RESET}")
                continue
            name = existing.get("name", info["cron"]) if current_script else info["cron"]
            create = ["hermes", "cron", "create", cron, info["title"], "--name", name,
                      "--script", info["script"], "--no-agent", "--deliver", "local"]
            if not runner.mode:
                self.say(f"  Hermes isn't reachable from here; inside Hermes run:\n    {shlex.join(create)}")
                continue
            if self.args.dry_run:
                self.say(f"  would run: {shlex.join(create)}" + (f" (replacing {existing['id']})" if existing else ""))
                continue
            if existing:
                runner.run(["hermes", "cron", "remove", existing["id"]], capture=True, timeout=60)
            res = runner.run(create, capture=True, timeout=60)
            ok = res is not None and res.returncode == 0
            self.say(f"  {GREEN if ok else YELLOW}{info['title']}: "
                     f"{'scheduled ' + friendly_schedule(cron) if ok else 'failed'}{RESET}")
            if not ok and res is not None:
                self.say((res.stdout + res.stderr).strip()[-400:])

    def tests(self, runner: Runner, packages: list[str]) -> None:
        if not self.interactive or self.args.dry_run or not runner.mode:
            return
        self.heading("Test")
        python = self.args.python
        for pkg in packages:
            info = PACKAGES[pkg]
            if self.confirm(f"Send a {info['title']} test email now?", True):
                runner.run([python, info["script"], "--test-email"], in_scripts=True)
            if self.confirm(f"Run a {info['title']} dry run now (no email; takes a few minutes)?", False):
                runner.run([python, info["script"], *info["dry_run"]], in_scripts=True)

    # ------------------------------------------------------------------ main flow

    def run(self) -> int:
        self.say(f"{BOLD}HermitShell setup{RESET}\nInstalls packages into Hermes and configures them. "
                 "Press Enter to accept a [default]; re-run any time to change settings.")
        home = self.choose_home()
        scripts = home / "scripts"
        packages = self.choose_packages()
        owner = self.owner(home)
        if not self.args.no_install:
            self.install(home, packages, owner)
        self.current = EnvFile(home / ".env").values()
        runner = Runner(self.args, scripts)
        self.say(f"\nHermes commands: {runner.describe()}")

        self.shared()
        for pkg in packages:
            info = PACKAGES.get(pkg, {"title": pkg})
            self.heading(f"{info['title']} settings")
            self.run_settings(parse_example(PACKAGES_DIR / pkg / ".env.example"))
            if pkg == "daily-vacancy-report":
                self.job_search()
                self.job_targets(scripts)
                self.job_profile(scripts)
                self.feedback_buttons()
            if pkg in PACKAGES and not self.args.no_cron:
                for job_id, info in scheduled_jobs(pkg):
                    self.ask_schedule(runner, job_id, info)

        saved = self.review_and_write(home, owner)
        if self.cf_plan and (saved or self.args.dry_run):
            self.deploy_worker()
        elif saved:
            self.upload_feedback_secrets(home)
        known = [p for p in packages if p in PACKAGES]
        if not self.args.no_cron and (saved or self.args.dry_run or not self.changes):
            self.schedules(runner)
        if saved:
            self.tests(runner, known)
        self.heading("Done")
        self.say(f"Settings: {home / '.env'}\nRe-run `python3 scripts/setup.py` to change anything, "
                 "or `--advanced` to see every option.")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Install and configure HermitShell packages for Hermes.")
    parser.add_argument("packages", nargs="*", help="packages to set up (default: ask)")
    parser.add_argument("--hermes-home", help="Hermes home (default: $HERMES_HOME, /opt/data or ~/.hermes)")
    parser.add_argument("--advanced", action="store_true", help="ask for every setting, not just the essentials")
    parser.add_argument("--non-interactive", action="store_true",
                        help="no prompts: take values from --answers, then the environment, then current/defaults")
    parser.add_argument("--answers", help="KEY=VALUE file of settings for --non-interactive; schedules go in "
                                          "SCHEDULE_<PACKAGE>=HH:MM (e.g. SCHEDULE_DAILY_VACANCY_REPORT=weekdays 07:30, "
                                          "SCHEDULE_DAILY_VACANCY_REPORT_WEEKLY=sunday 18:00)")
    parser.add_argument("--dry-run", action="store_true", help="show what would change; write and run nothing")
    parser.add_argument("--no-install", action="store_true", help="skip copying package files")
    parser.add_argument("--no-cron", action="store_true", help="skip the schedule step")
    parser.add_argument("--owner", help="uid:gid for written files (default: owner of the Hermes home when run as root)")
    parser.add_argument("--container", help="Hermes Docker container for hermes/python commands "
                                            "(auto-detects 'hermes-agent')")
    parser.add_argument("--container-home", default="/opt/data", help="HERMES_HOME inside the container")
    parser.add_argument("--container-user", default="hermes", help="user to run commands as in the container")
    parser.add_argument("--python", default="python3", help="Python used to run package scripts")
    args = parser.parse_args()
    try:
        return Wizard(args).run()
    except KeyboardInterrupt:
        print("\nCancelled; nothing further was changed.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())

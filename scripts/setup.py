#!/usr/bin/env python3
"""HermitShell setup wizard: install packages, then configure every setting, API key, profile and
cron schedule interactively.

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
import getpass
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PACKAGES_DIR = REPO / "packages"

SECRET_RE = re.compile(r"PASSWORD|API_KEY|_KEYS$|TOKEN|SECRET")
PLACEHOLDER_RE = re.compile(r"example\.(com|org)|change-me", re.I)
SECTION_RE = re.compile(r"^#\s*-{4,}\s*(.+?)\s*$")
KEY_RE = re.compile(r"^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$")
TIME_RE = re.compile(r"^(?:(weekdays|daily)\s+)?([01]?\d|2[0-3]):([0-5]\d)$", re.I)

PACKAGES = {
    "daily-vacancy-report": {
        "title": "Daily Vacancy Report", "script": "job_scanner.py", "cron": "daily-vacancy-report",
        "schedule": "0 7 * * *", "dry_run": ["--dry-run", "--limit", "3"],
    },
    "noon-tech-digest": {
        "title": "Noon Tech Digest", "script": "tech_digest.py", "cron": "noon-tech-digest",
        "schedule": "0 12 * * *", "dry_run": ["--dry-run"],
    },
}

BOLD, DIM, GREEN, YELLOW, RESET = ("\033[1m", "\033[2m", "\033[32m", "\033[33m", "\033[0m") \
    if sys.stdout.isatty() and os.name != "nt" else ("",) * 5


def mask(value: str) -> str:
    return "" if not value else f"{value[:4]}...{value[-4:]}" if len(value) > 12 else "****"


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

    def ask_setting(self, s: Setting) -> str:
        current = self.current.get(s.key)
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
            self.say(f"{YELLOW}  No web search key set. The vacancy report and digest need at least one of "
                     f"Firecrawl, Tavily or Scrapfly (all have free tiers).{RESET}")
        if not self.value("SMTP_USER") or not self.value("SMTP_PASSWORD"):
            self.say(f"{YELLOW}  SMTP login incomplete: reports can't be emailed until it is set.{RESET}")

    # ------------------------------------------------------------------ package: daily-vacancy-report

    def job_targets(self, scripts: Path) -> None:
        self.heading("Job targets")
        pkg = PACKAGES_DIR / "daily-vacancy-report"
        builtin_titles = read_constant(pkg / "job_scanner.py", "DEFAULT_INDEED_QUERIES") or []
        builtin_exclude = read_constant(pkg / "job_scanner.py", "DEFAULT_TITLE_EXCLUDE") or ""
        current = [t for t in self.value("JOB_INDEED_QUERIES").split("||") if t.strip()]
        titles = self.listing("Job titles to search for (comma-separated)", current or builtin_titles)
        if not titles or titles == (current or builtin_titles):
            if self.args.advanced:
                self.advanced_job_filters()
            return
        location = self.value("JOB_SEARCH_LOCATION") or self.value("JOB_REGION_NAME")
        nijobs = bool(self.value("JOB_SCANNER_NIJOBS_KEYWORDS"))
        self.set("JOB_INDEED_QUERIES", "||".join(titles))
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
        exclude = self.value("JOB_TITLE_EXCLUDE") or builtin_exclude
        kept = [p for p in split_top_level(exclude) if not any(re.search(p, t, re.I) for t in titles)]
        if len(kept) != len(split_top_level(exclude)):
            self.say(f"  {DIM}removed words matching your titles from the exclude filter{RESET}")
            self.set("JOB_TITLE_EXCLUDE", "|".join(kept))
        if self.args.advanced:
            self.advanced_job_filters()

    def advanced_job_filters(self) -> None:
        for key, label in (("JOB_SCANNER_QUERIES", "Web search queries ('||'-separated)"),
                           ("JOB_INDEED_QUERIES", "Indeed searches ('||'-separated job titles)"),
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
        titles = self.listing("Job titles you want", [t for t in self.value("JOB_INDEED_QUERIES").split("||") if t])
        seniority = self.text("Seniority you're targeting (e.g. mid-level individual contributor)")
        types = self.text("Employment types", "Full-time permanent or contract")
        mode = self.text("Work mode", "Hybrid or remote preferred")
        avoid = self.text("Roles or conditions you're NOT interested in")
        gaps = self.listing("Honest gaps the model should know about (comma-separated)", [])
        looking = [line for line in (f"- Titles: {', '.join(titles)}" if titles else "",
                                     f"- Seniority: {seniority}" if seniority else "",
                                     f"- {types}" if types else "", f"- {mode}" if mode else "",
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

    def indeed(self, runner: Runner) -> None:
        if self.value("JOB_INDEED", "1") != "1":
            return
        self.heading("Indeed (MCP)")
        server = self.value("JOB_INDEED_MCP_SERVER") or "indeed"
        if not runner.mode:
            self.say("Hermes commands aren't reachable from here. To enable Indeed later, run inside Hermes:\n"
                     f"  hermes mcp install {server}\n  hermes mcp login {server}")
            return
        listed = runner.run(["hermes", "mcp", "list"], capture=True, timeout=60)
        configured = bool(listed and re.search(rf"^\s*{re.escape(server)}\s", listed.stdout, re.M))
        if not configured:
            if not self.confirm(f"The '{server}' MCP server isn't in Hermes yet. Add it now (hermes mcp install {server})?"):
                return
            if self.args.dry_run:
                self.say(f"  would run: hermes mcp install {server}")
            else:
                runner.run(["hermes", "mcp", "install", server], tty=True)
        test = runner.run(["hermes", "mcp", "test", server], capture=True, timeout=120)
        if test and test.returncode == 0 and "no cached tokens" not in (test.stdout + test.stderr):
            self.say(f"  {GREEN}Indeed is authorised.{RESET}")
            return
        self.say("Indeed needs a one-time browser login. You can also do this from the Hermes dashboard's MCP page.")
        if self.interactive and self.confirm(f"Run `hermes mcp login {server}` now?", True):
            if self.args.dry_run:
                self.say(f"  would run: hermes mcp login {server}")
            else:
                runner.run(["hermes", "mcp", "login", server], tty=True)
                self.say("  Restart the Hermes session afterwards so the tools load.")

    # ------------------------------------------------------------------ package: noon-tech-digest

    def digest_sections(self, scripts: Path) -> None:
        self.heading("Digest sections")
        current = self.value("TECH_DIGEST_SECTIONS_FILE")
        if current:
            self.say(f"Using custom sections from {current}.")
            if self.confirm("Keep it?", True):
                return
        if self.confirm("Use the built-in sections (AI, ML research, Python, IoT & edge, new tech)?", not current):
            self.set("TECH_DIGEST_SECTIONS_FILE", "")
            return
        target = scripts / "sections.json"
        if not target.is_file():
            self.files[target] = (PACKAGES_DIR / "noon-tech-digest" / "sections.example.json").read_text(encoding="utf-8")
        self.set("TECH_DIGEST_SECTIONS_FILE", "sections.json")
        self.say(f"  {DIM}edit {target} to choose your own sections and search queries{RESET}")

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

    def schedules(self, runner: Runner, packages: list[str]) -> None:
        self.heading("Schedules")
        if not runner.mode:
            self.say("Hermes isn't reachable from here; register the jobs from the package READMEs.")
            return
        self.say("Times use Hermes' timezone (`timezone:` in config.yaml). Enter HH:MM for daily, "
                 "'weekdays HH:MM', a cron expression, or '-' to skip.")
        jobs = runner.cron_jobs()
        for pkg in packages:
            info = PACKAGES[pkg]
            existing = next((j for j in jobs if j.get("script", "").endswith(info["script"])), None)
            default = existing.get("schedule", info["schedule"]) if existing else info["schedule"]
            reply = self.text(f"{info['title']} schedule", default)
            if not reply or reply == "-":
                continue
            if m := TIME_RE.match(reply):
                days = "1-5" if (m.group(1) or "").lower() == "weekdays" else "*"
                reply = f"{int(m.group(3))} {int(m.group(2))} * * {days}"
            if existing and existing.get("schedule") == reply:
                self.say(f"  {DIM}{info['title']}: unchanged ({reply}){RESET}")
                continue
            create = ["hermes", "cron", "create", reply, info["title"], "--name", existing.get("name", info["cron"])
                      if existing else info["cron"], "--script", info["script"], "--no-agent", "--deliver", "local"]
            if self.args.dry_run:
                self.say(f"  would run: {shlex.join(create)}" + (f" (replacing {existing['id']})" if existing else ""))
                continue
            if existing:
                runner.run(["hermes", "cron", "remove", existing["id"]], capture=True, timeout=60)
            res = runner.run(create, capture=True, timeout=60)
            ok = res is not None and res.returncode == 0
            self.say(f"  {GREEN if ok else YELLOW}{info['title']}: {'scheduled ' + reply if ok else 'failed'}{RESET}")
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
                self.job_targets(scripts)
                self.job_profile(scripts)
            elif pkg == "noon-tech-digest":
                self.digest_sections(scripts)

        saved = self.review_and_write(home, owner)
        if "daily-vacancy-report" in packages:
            self.indeed(runner)
        known = [p for p in packages if p in PACKAGES]
        if not self.args.no_cron and (saved or self.args.dry_run or not self.changes):
            self.schedules(runner, known)
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
    parser.add_argument("--answers", help="KEY=VALUE file of settings for --non-interactive")
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

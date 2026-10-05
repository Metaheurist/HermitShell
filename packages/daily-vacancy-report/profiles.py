#!/usr/bin/env python3
"""Daily Vacancy Report profiles and dashboard settings, managed from the feedback Worker.

With the dashboard, whoever set up HermitShell (the owner, the main admin) and the recruiters are staff, not
recruits: they manage recruits and have no job search of their own. The owner's settings (.env, overlaid by
anything saved on the Worker's /admin dashboard in state/dashboard.json) are the server's; an owner who had a job
search of their own before this gets it moved once to an ordinary recruit profile (move_owner_search). Recruits join
through a single-use invite link made on the dashboard. Their details and CV wait in the Worker until this
script collects them, reads the CV, has the local model turn it into a profile and search terms, and emails them.
Each recruit lives in state/profiles/<id>/ with its own job search and gets the daily report, buttons, cover letters,
tailored CVs and weekly roll-up; the unsubscribe link in its reports deletes it. Its daily report is its own
scheduled job (vacancy-report-<id>, running profile_report.py), kept in step with the profile by this script;
the dashboard sets its time and can send any profile's report at once. Each profile's stats (profile_stats.py)
go to the Worker when they change, for the dashboard's stats page.
A retired recruit (from the dashboard) gets no reports and chooses by email how long their profile is kept for a
return, or has it deleted at once, backups included; see retire().
Dashboard changes (email server, API keys, job search settings, new CVs, pause, resume, retire, delete) arrive the
same way; passwords and keys stay in the Worker only until this script collects them. The Worker never
reaches this server: a background listener started by the cron run holds a WebSocket out to the Worker (the live
link), which tells it the moment anything is queued; without one the cron run polls the Worker instead.

    python3 profiles.py                        # sync, then keep the live link up (or poll until the next run); cron, every 5 min
    python3 profiles.py --once                 # sync once and exit
    python3 profiles.py listen                 # hold the live link (started in the background by the cron run)
    python3 profiles.py report [--now] ID...   # profiles' daily reports, in turn (--now: email even if nothing is new)
    python3 profiles.py --list
    python3 profiles.py --invite "Sam from the meetup"
    python3 profiles.py --pause ID | --resume ID | --delete ID
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import html
import json
import os
import re
import secrets
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

import cv_text
import autofit
import hermes_common as hc
import job_settings
import key_usage
import llm_providers
import llm_usage
import model_pull
import money
import profile_stats
import worker_link
import worker_seal
from hermes_common import EMAIL_HEAD, STATE_DIR, connect_model, email_header, env, load_env_file, log, ollama_chat
from job_settings import slug, term_regex
from job_tracker import Tracker, own_page_link, retire_link, sync_feedback, unsubscribe_link

SCRIPT_DIR = Path(__file__).resolve().parent
PROFILES_DIR = Path(env("JOB_PROFILES_DIR") or STATE_DIR / "profiles")
DASHBOARD_FILE = hc.DASHBOARD_FILE
OWNER = "owner"
RUNNABLE = ("job_scanner.py", "job_weekly.py", "cover_letter.py")
# Settings that describe one person; blanked for recruits so .env cannot fill them back in.
PERSONAL_KEYS = ("ALERT_EMAIL", "JOB_CANDIDATE_NAME", "JOB_PROFILE_FILE", "JOB_KEYWORDS_FILE", "JOB_SCANNER_QUERIES",
                 "JOB_SCANNER_NIJOBS_KEYWORDS", "JOB_TARGET_TITLES", "JOB_TITLE_STRONG", "JOB_TITLE_MEDIUM",
                 "JOB_LEVEL", "JOB_MIN_SALARY", "JOB_REPORT_TAGLINE", "COVER_LETTER_NAME", "COVER_LETTER_CONTACT",
                 "COVER_LETTER_CV_FILE", "COVER_LETTER_SIGN_OFF", "JOB_HOME_TOWN")
# The rest of a job search (region, places, country, employment types, work modes, currency...): each recruit has
# its own in settings.json, so these are blanked for recruits too rather than taken from .env.
SEARCH_KEYS = tuple(k for k in job_settings.KEYS if k not in PERSONAL_KEYS)
# What a recruit's settings.json may set.
PROFILE_KEYS = frozenset(PERSONAL_KEYS) | frozenset(job_settings.KEYS)
# Set for every recruit by child_env from its profile and folder, so never copied into its settings.json.
IDENTITY_KEYS = frozenset({"ALERT_EMAIL", "JOB_CANDIDATE_NAME", "JOB_PROFILE_FILE", "JOB_KEYWORDS_FILE", "COVER_LETTER_NAME",
                           "COVER_LETTER_CONTACT", "COVER_LETTER_CV_FILE", "JOB_HOME_TOWN"})
# What the owner's own job search kept in the state folder, moved with it to its recruit profile.
OWNER_STATE_FILES = ("job_scanner_seen.json", "job_scanner_retry.json", "job_scanner_last.json", "job_scanner_last.html",
                     "job_scanner_weekly.html", "cv.json", "cv_skills_merged.json")
OWNER_STATE_DIRS = ("cover_letters", "tailored_cvs", "interview_prep")
STAFF = "the admin is staff, not a recruit, and has no job search of their own"
SMTP_KEYS = ("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM")
# Global settings, Features: the dashboard's name for each switch, its .env key and its default.
# A switch is listed only once its feature exists, so the dashboard never offers one that does nothing.
FEATURES: dict[str, tuple[str, bool]] = {"alerts": ("HERMES_ALERTS", True), "prep_auto": ("INTERVIEW_PREP_AUTO", False),
                                         "word_copies": ("DOC_WORD_COPIES", False),
                                         "self_service": ("HERMES_SELF_SERVICE", False)}
# Recruits' own page (/me): the sign-in token's shape (32 random bytes, base64url) and how long it and the gap
# between two links for the same recruit last.
LOGIN_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
LOGIN_LINK_MINUTES = 15
LOGIN_LINK_GAP = 300
API_KEYS = {"firecrawl": "FIRECRAWL_API_KEY", "firecrawl_backup": "FIRECRAWL_BACKUP_KEYS",
            "tavily": "TAVILY_API_KEY", "scrapfly": "SCRAPFLY_API_KEY"}
ID_RE = re.compile(r"^[a-z0-9-]{1,40}$")
# A dashboard user's username (feedback-worker/src/users.js): whose pool a recruit is in.
RECRUITER_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")
# What the dashboard can do to several ticked recruits at once (feedback-worker/src/admin.js), and how many.
BULK_OPS = ("pause", "resume", "send_now", "assign", "retire")
MAX_BULK = 25
# A retired recruit gets no reports and is emailed a link (feedback-worker/src/index.js, action "retire") to keep their
# profile for one of RETIRE_KEEP_MONTHS, for an easy return, or to have it deleted now with every backup's copy. Without
# an answer it is kept for HERMES_RETIRE_KEEP_MONTHS (default 6), then deleted the same way by the nightly maintenance.
RETIRE_KEEP_MONTHS = (6, 12, 24)
RETIRE_DEFAULT_MONTHS = 6
MONTH = 365.25 / 12 * 86400
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,120}$")
EMAIL_RE = re.compile(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+")
HOST_RE = re.compile(r"^[A-Za-z0-9.-]{3,120}$")
QUEUE_ATTEMPTS = 5
FULL_LIST_EVERY = 3600
STATUS_EVERY = 900
# The GPUs last reported by the host (state/gpus_seen.json), shown for a day when a report is missed; rewritten at
# most hourly.
GPUS_REMEMBER = 86400
GPUS_SEEN_EVERY = 3600
# Each changed profile's stats are sent at most this often (the free plan allows 1,000 KV writes a day), and at
# once when its report finishes.
STATS_EVERY = 1800
# The desk's totals (stats:desk) go up when they change, at most this often: at most 48 KV writes a day.
DESK_EVERY = 1800
# "Also suits" looks at jobs first seen in the last OTHERS_DAYS days that met the recruit's own email threshold.
OTHERS_DAYS = 90
_fits: dict[str, tuple[float, int, dict[str, int]]] = {}
# The cron job runs every 5 minutes and the scheduler skips a run while the last one is still going, so each run
# watches for dashboard changes until comfortably before the next (counted from when the run started).
WATCH_SECONDS = 250
POLL_SECONDS = 15
# The live link: a WebSocket to the Worker's /api/live, told the moment anything is queued (feedback-worker/src/hub.js).
# The cron run keeps a listener process holding it and only polls as above when the Worker has no live link.
LIVE_PING = 30
# A pushed item can take a few seconds to show in the Worker's queue listing, so a push that found nothing is retried.
LIVE_RETRIES = (5, 20, 60)
LIVE_FAILURES = 6
LIVE_BACKOFF = 60
LIVE_RECHECK = 3600
LIVE_LIFETIME = 24 * 3600
RUN_TIMEOUT = 4 * 3600
# While a report runs, its status (and so its progress on the dashboard's task list) is sent this often, only when
# it has changed: each send is one of the free plan's 1,000 KV writes a day.
PROGRESS_EVERY = 60
# The cover letter or tailored CV being written right now, in the profile's state folder (cover_letter.py).
WRITING_NAME = "writing.json"
# Tasks the dashboard can stop: a running report, or a cover letter or tailored CV request (its Worker event id).
TASK_RE = re.compile(r"^report:([a-z0-9-]{1,40})$|^letter:([a-z0-9-]{1,40}):(event:[a-z0-9_-]{1,40}:[A-Za-z0-9:_-]{1,120})$")
TRIGGERS = ("schedule", "dashboard")
MAX_TASKS = 40
# Each extra profile's daily report is its own scheduled job, running REPORT_SCRIPT from the profile's folder.
REPORT_SCRIPT = "profile_report.py"
REPORT_JOB = "vacancy-report-"
# A new profile's report starts this many minutes after the owner's (and the last profile's), unless the
# dashboard sets its time, so the reports don't all wait for the model at once.
REPORT_GAP = 15
DEFAULT_SCHEDULE = "0 7 * * *"
SIMPLE_CRON = re.compile(r"^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$")
REPORT_TIME = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
CRON_FILE = hc.APP_HOME / "cron" / "jobs.json"
MAX_CV_CHARS = 12_000
MIN_CV_CHARS = 200
MAX_FILE_BYTES = 6 * 1024 * 1024
FROM_NAME = "Daily Vacancy Report"

PROFILE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "maxLength": 700},
        "titles": {"type": "array", "items": {"type": "string", "maxLength": 60}, "maxItems": 6},
        "title_keywords": {"type": "array", "items": {"type": "string", "maxLength": 40}, "maxItems": 10},
        "related_title_keywords": {"type": "array", "items": {"type": "string", "maxLength": 40}, "maxItems": 10},
        "skills": {"type": "array", "maxItems": 30, "items": {
            "type": "object",
            "properties": {"name": {"type": "string", "maxLength": 40},
                           "aliases": {"type": "array", "items": {"type": "string", "maxLength": 40}, "maxItems": 3}},
            "required": ["name", "aliases"]}},
        "looking_for": {"type": "array", "items": {"type": "string", "maxLength": 120}, "maxItems": 6},
        "not_interested": {"type": "array", "items": {"type": "string", "maxLength": 120}, "maxItems": 5},
        "gaps": {"type": "array", "items": {"type": "string", "maxLength": 120}, "maxItems": 5},
        "level": {"type": "string", "enum": ["junior", "mid", "senior", "lead", "any"]},
    },
    "required": ["summary", "titles", "title_keywords", "related_title_keywords", "skills", "looking_for",
                 "not_interested", "gaps", "level"],
}
BUILD_SYSTEM = (
    "You turn a CV into a job-search profile. Use only facts from the CV and from what the candidate wrote; "
    "never invent employers, job titles, qualifications or skills. UK English, third person, plain words.")
BUILD_TASK = """Fill in every field:
- summary: 2 to 4 sentences: most recent role, years of experience, main strengths.
- titles: 3 to 6 job titles to search job boards for; start from ROLES THEY WANT, then the CV.
- title_keywords: 3 to 10 short words or phrases found in the titles of relevant jobs (e.g. "analyst", "power bi").
- related_title_keywords: up to 10 words from titles of adjacent roles worth a look.
- skills: up to 30 concrete skills, tools, languages or certifications named in the CV, each with up to 3
  other spellings a job advert might use (aliases), e.g. {"name": "Power BI", "aliases": ["PowerBI"]}.
- looking_for: up to 6 short points on the work they want (contract, work mode, seniority, sector).
- not_interested: up to 5 things they do not want, only if they said so.
- gaps: up to 5 honest gaps for the titles above (skills or experience the CV does not show).
- level: the seniority of the roles they should get: junior, mid, senior, lead, or any."""


class ProfileError(ValueError):
    """A queue item that cannot be processed however often it is retried."""


# --------------------------------------------------------------------------- storage

def read_json(path: Path, default):
    try:
        return json.loads(hc.read_private_text(path))
    except (OSError, ValueError):
        return default


def write_json(path: Path, data, private: bool = False) -> None:
    """Private files (profiles, their settings and keys) are encrypted when HERMES_DATA_KEY is set."""
    text = json.dumps(data, indent=2, ensure_ascii=False)
    if private:
        hc.write_private(path, text)
    else:
        hc.write_atomic(path, text)


def profile_dir(pid: str) -> Path:
    if not ID_RE.match(pid or ""):
        raise ProfileError(f"invalid profile id {pid!r}")
    return PROFILES_DIR / pid


def load(pid: str) -> dict | None:
    return read_json(profile_dir(pid) / "profile.json", None)


def save(profile: dict) -> None:
    write_json(profile_dir(profile["id"]) / "profile.json", profile, private=True)


def all_profiles() -> list[dict]:
    found = [read_json(p, None) for p in sorted(PROFILES_DIR.glob("*/profile.json"))]
    return sorted((p for p in found if p), key=lambda p: (not p.get("owner"), p.get("created", 0)))


def active_extra() -> list[dict]:
    return [p for p in all_profiles() if not p.get("owner") and p.get("status") == "active"
            and (profile_dir(p["id"]) / "job_profile.md").is_file()]


def owner_name() -> str:
    return env("COVER_LETTER_NAME") or env("JOB_CANDIDATE_NAME") or "Owner"


def ensure_owner() -> dict:
    owner = load(OWNER)
    if not owner:
        owner = {"id": OWNER, "owner": True, "name": owner_name(), "email": env("ALERT_EMAIL") or env("SMTP_USER") or "",
                 "status": "active", "created": time.time()}
        save(owner)
        log(f"Registered the owner profile ({owner['name']})")
    return owner


def admin_is_staff() -> bool:
    """With the dashboard (the feedback Worker) the owner only manages recruits; without it HermitShell is one
    person's job search, run from .env."""
    return bool(env("JOB_FEEDBACK_URL") and env("JOB_FEEDBACK_API_TOKEN"))


def owner_recruit() -> str:
    """The recruit the owner's own job search was moved to, while it still exists."""
    pid = str((load(OWNER) or {}).get("recruit") or "")
    return pid if ID_RE.match(pid) and pid != OWNER and load(pid) else ""


def staff_run(script: str, full: bool = False) -> bool:
    """The setup's scheduled run of `script` when the admin is staff: it only starts the recruits' runs, and takes
    answers from buttons in reports sent before the admin's own job search moved (still filed under the admin) into
    that recruit's tracker. False when HermitShell is one person's job search, so the run carries on as the owner's."""
    if env("JOB_PROFILE_ID") or not admin_is_staff():
        return False
    moved = owner_recruit()
    if moved:
        path = tracker_file(moved)
        path.parent.mkdir(parents=True, exist_ok=True)
        with Tracker(path) as tracker:
            synced, error = sync_feedback(tracker, env("JOB_FEEDBACK_URL", "") or "",
                                          env("JOB_FEEDBACK_API_TOKEN", "") or "", full=full)
        if synced:
            log(f"Filed {synced} earlier answer(s) to the admin's reports under {moved}")
        if error:
            log(error)
    if full:
        log(f"{script}: {STAFF}, so this run only starts the recruits'")
    return True


def remove_dir(pid: str) -> None:
    if pid == OWNER:
        raise ProfileError("the owner profile cannot be deleted")
    shutil.rmtree(profile_dir(pid), ignore_errors=True)


# --------------------------------------------------------------------------- dashboard settings, keys, environment

mask = hc.mask_secret


def dashboard_env() -> dict[str, str]:
    values = read_json(DASHBOARD_FILE, {}).get("env", {})
    return {k: v for k, v in values.items() if isinstance(v, str)} if isinstance(values, dict) else {}


def update_dashboard_env(updates: dict[str, str | None]) -> None:
    """Save settings from the dashboard (None removes one, so .env's value applies again) and use them at once."""
    values = dashboard_env()
    for key, value in updates.items():
        if not hc.dashboard_key_allowed(key):
            raise ProfileError(f"{key} cannot be set from the dashboard")
        if value is None:
            values.pop(key, None)
            os.environ.pop(key, None)
        else:
            values[key] = value
            os.environ[key] = value
    # Read by hermes_common before .env (and so before HERMES_DATA_KEY) is loaded: 0600, not encrypted.
    hc.write_atomic(DASHBOARD_FILE, json.dumps({"env": values, "updated": time.time()}, indent=2))
    load_env_file()


def retire_own_keys() -> int:
    """Web search keys are global now (Global settings, else .env): removes the per-recruit key files earlier
    versions kept, so no key is left on disk that nothing uses. Returns how many were removed."""
    removed = 0
    for path in PROFILES_DIR.glob("*/secrets.json") if PROFILES_DIR.is_dir() else ():
        path.unlink(missing_ok=True)
        removed += 1
    if removed:
        log(f"Removed {removed} recruit crawler key file(s); every recruit now uses the global web search keys")
    return removed


def child_env(profile: dict) -> dict[str, str]:
    d = profile_dir(profile["id"])
    environ = dict(os.environ)
    environ.update({k: "" for k in (*PERSONAL_KEYS, *SEARCH_KEYS)})
    environ.update({k: str(v) for k, v in read_json(d / "settings.json", {}).items() if k in PROFILE_KEYS})
    contact = " · ".join(x for x in (profile.get("email"), profile.get("phone"), profile.get("location")) if x)
    environ.update({
        "JOB_PROFILE_ID": profile["id"],
        "JOB_PROFILES_DIR": str(PROFILES_DIR),
        "HERMES_STATE_DIR": str(d / "state"),
        "JOB_PROFILE_FILE": str(d / "job_profile.md"),
        "JOB_KEYWORDS_FILE": str(d / "cv_keywords.json"),
        "ALERT_EMAIL": profile.get("email", ""),
        "JOB_CANDIDATE_NAME": profile.get("name", ""),
        "COVER_LETTER_NAME": profile.get("name", ""),
        "COVER_LETTER_CONTACT": contact,
        "COVER_LETTER_CV_FILE": str(d / "cv.txt"),
        "JOB_HOME_TOWN": str(profile.get("location") or ""),
    })
    return environ


# --------------------------------------------------------------------------- building a profile from a CV

def _strings(value, limit: int, max_len: int = 120) -> list[str]:
    items = value if isinstance(value, list) else []
    return list(dict.fromkeys(" ".join(str(v).split())[:max_len] for v in items if str(v).strip()))[:limit]


def clean_build(data: dict, roles: str) -> dict:
    skills = []
    for s in data.get("skills") if isinstance(data.get("skills"), list) else []:
        name = " ".join(str((s or {}).get("name", "")).split())[:40] if isinstance(s, dict) else ""
        if name and name.lower() not in {x["name"].lower() for x in skills}:
            skills.append({"name": name, "aliases": _strings(s.get("aliases"), 3, 40)})
    titles = _strings(data.get("titles"), 6, 60) or \
        _strings(re.split(r",|;|/|\bor\b|\band\b", roles, flags=re.I), 4, 60)
    if not titles or len(skills) < 3:
        raise RuntimeError("the model returned too little to build a profile from")
    return {
        "summary": " ".join(str(data.get("summary", "")).split())[:700],
        "titles": titles,
        "title_keywords": _strings(data.get("title_keywords"), 10, 40),
        "related_title_keywords": _strings(data.get("related_title_keywords"), 10, 40),
        "skills": skills[:30],
        "looking_for": _strings(data.get("looking_for"), 6),
        "not_interested": _strings(data.get("not_interested"), 5),
        "gaps": _strings(data.get("gaps"), 5),
        "level": data.get("level") if data.get("level") in ("junior", "mid", "senior", "lead") else "",
    }


def ask_model(cv: str, item: dict, model_info) -> dict:
    host, model, num_ctx = model_info
    user = (f"CV:\n{cv[:MAX_CV_CHARS]}\n\nROLES THEY WANT: {item.get('roles', '')}\n"
            f"WHERE THEY LIVE: {item.get('location') or 'not given'}\n\n{BUILD_TASK}")
    raw = ollama_chat(host, model, BUILD_SYSTEM, user, hc.fit_ctx(num_ctx, BUILD_SYSTEM, user, num_predict=1800),
                      fmt=PROFILE_SCHEMA, num_predict=1800, task="profile")
    try:
        return clean_build(json.loads(raw), item.get("roles", ""))
    except ValueError as exc:
        raise RuntimeError(f"the model did not return valid JSON ({exc})") from exc


def profile_markdown(item: dict, built: dict) -> str:
    def bullets(items: list[str]) -> str:
        return "\n".join(f"- {x}" for x in items) or "- None stated"

    lines = [f"# Candidate profile\n\nName: {item['name']}"]
    if item.get("location"):
        lines.append(f"Location: {item['location']}")
    lines += ["", "## Summary", "", built["summary"] or "See the skills below.", "",
              "## Core skills", "", bullets([s["name"] for s in built["skills"]]), "",
              "## Looking for", "", f"- Titles: {', '.join(built['titles'])}",
              f"- In their own words: {item.get('roles', '').strip()}", bullets(built["looking_for"])]
    if built["not_interested"]:
        lines.append(f"- Not interested in: {'; '.join(built['not_interested'])}")
    lines += ["", "## Gaps (be honest, the model uses this)", "", bullets(built["gaps"])]
    return "\n".join(lines) + "\n"


def owner_keywords() -> dict[str, str]:
    path = SCRIPT_DIR / (env("JOB_KEYWORDS_FILE") or "cv_keywords.json")
    data = read_json(path, {})
    return {**data.get("cv_keywords", {}), **data.get("other_tech", {})}


def keywords_json(built: dict) -> dict:
    cv = {s["name"]: term_regex([s["name"], *s["aliases"]]) for s in built["skills"]}
    names = [n.lower() for s in built["skills"] for n in (s["name"], *s["aliases"])]
    other = {}
    for label, pattern in owner_keywords().items():
        try:
            rx = re.compile(pattern, re.I)
        except re.error:
            continue
        if label.lower() not in names and not any(rx.search(n) for n in names):
            other[label] = pattern
    return {"cv_keywords": cv, "other_tech": other}


def search_settings(built: dict, get, nijobs: bool) -> dict[str, str]:
    """A recruit's searches from its CV and its own location (`get` reads its settings); `nijobs` when the nijobs.com
    board is used on this server."""
    location = get("JOB_SEARCH_LOCATION") or get("JOB_REGION_NAME") or ""
    titles = built["titles"]
    strong = term_regex(built["title_keywords"] + titles)
    medium = term_regex(built["related_title_keywords"]) or term_regex([s["name"] for s in built["skills"][:10]])
    settings = {
        "JOB_SCANNER_QUERIES": "||".join(job_settings.search_queries(titles, location, nijobs)),
        "JOB_TARGET_TITLES": "||".join(titles),
        "JOB_TITLE_STRONG": strong,
        "JOB_TITLE_MEDIUM": medium,
        "JOB_LEVEL": built["level"],
        "JOB_REPORT_TAGLINE": "Roles matched to your CV",
    }
    if nijobs:
        settings["JOB_SCANNER_NIJOBS_KEYWORDS"] = ",".join(slug(t) for t in titles)
    return settings


def profile_id(item: dict) -> str:
    base = slug(item.get("name", ""))[:30].strip("-") or "profile"
    tail = re.sub(r"[^0-9a-f]", "", str(item.get("id", "")))[-6:] or hashlib.sha1(
        json.dumps(item, sort_keys=True).encode(), usedforsecurity=False).hexdigest()[:6]
    return f"{base}-{tail}"


def read_cv(d: Path, item: dict, api) -> str:
    """The CV text from the uploaded file, else the pasted text; saved as cv.txt (encrypted when HERMES_DATA_KEY
    is set). The uploaded file itself is deleted once its text has been read."""
    d.mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    text = ""
    cv = item.get("cv") or {}
    if cv.get("key"):
        kind = cv.get("kind") if cv.get("kind") in cv_text.KINDS else "txt"
        upload = d / f".upload.{kind}"
        data = api.file(cv["key"])
        if cv.get("sealed") is True:
            try:
                data = worker_seal.open_bytes(data, cv["key"])
            except worker_seal.SealError as exc:
                raise ProfileError(f"the CV file could not be opened: {exc}") from None
        hc.write_atomic(upload, data)
        try:
            text = cv_text.clean(cv_text.extract_file_isolated(upload))
        except Exception as exc:  # a malformed or hostile file must not block the pasted fallback
            log(f"Could not read the CV file in {d.name}: {exc.__class__.__name__}")
        finally:
            upload.unlink(missing_ok=True)
        for old in d.glob("cv.*"):
            if old.name != "cv.txt":
                old.unlink(missing_ok=True)
    pasted = cv_text.clean(str(item.get("cv_text") or ""))
    if len(text) < MIN_CV_CHARS and len(pasted) > len(text):
        text = pasted
    if len(text) < MIN_CV_CHARS:
        raise ProfileError("no readable text in the CV (a scanned image?) and nothing pasted")
    hc.write_private(d / "cv.txt", text)
    return text


def create_profile(item: dict, api, model_info_factory=lambda: connect_model("JOB_SCANNER_MODEL"),
                   existing: dict | None = None) -> dict:
    """A new profile from a sign-up, or `existing` rebuilt from a CV uploaded for it on the dashboard."""
    name = " ".join(str(item.get("name", "")).split())[:80]
    email = str(item.get("email", "")).strip()[:120]
    if not name or not EMAIL_RE.fullmatch(email):
        raise ProfileError("sign-up without a valid name and email")
    if existing is None:
        others = [p for p in all_profiles() if not p.get("owner")]
        invite = str(item.get("invite") or "")
        repeat = next((p for p in others if invite and p.get("invite") == invite), None)
        if repeat:
            log(f"Sign-up for an invite that already created profile {repeat['id']}; ignoring the repeat")
            return repeat
        # A sign-up never takes over someone else's profile by giving their email address.
        taken = next((p for p in others if p.get("email", "").lower() == email.lower()), None)
        if taken:
            log(f"Sign-up from {name} uses the email of profile {taken['id']}; left that profile unchanged")
            notify(lambda: send_owner(f"Sign-up from {name} not applied",
                                      [f"{name} signed up with {email}, which profile {taken['id']} already uses. "
                                       "That profile was left unchanged.",
                                       "If it is the same person with a new CV, upload it for them on /admin."]))
            return taken
    pid = existing["id"] if existing else profile_id(item)
    d = profile_dir(pid)
    text = read_cv(d, item, api)

    built = ask_model(text, {**item, "name": name}, model_info_factory())
    hc.write_private(d / "job_profile.md", profile_markdown({**item, "name": name}, built))
    write_json(d / "cv_keywords.json", keywords_json(built), private=True)
    kept = read_json(d / "settings.json", {})
    own = {"JOB_SEARCH_LOCATION": _text(item.get("location"), 80), **kept}
    nijobs = bool(kept["JOB_SCANNER_NIJOBS_KEYWORDS"] if "JOB_SCANNER_NIJOBS_KEYWORDS" in kept
                  else env("JOB_SCANNER_NIJOBS_KEYWORDS"))
    write_json(d / "settings.json", {**kept, **search_settings(built, lambda k: own.get(k) or "", nijobs)}, private=True)
    now = time.time()
    recruiter = str(item.get("recruiter") or "")
    profile = {**(existing or {}), "id": pid, "name": name, "email": email,
               **({} if existing else {"invite": str(item.get("invite") or "")[:40]}),
               **({"recruiter": recruiter} if not existing and RECRUITER_RE.match(recruiter) else {}),
               "phone": str(item.get("phone", ""))[:40], "location": str(item.get("location", ""))[:80],
               "roles": str(item.get("roles", ""))[:300], "titles": built["titles"],
               "title_keywords": built["title_keywords"],
               "skills": [s["name"] for s in built["skills"]], "status": (existing or {}).get("status", "active"),
               "created": (existing or {}).get("created", now), "updated": now, "cv_updated": now}
    save(profile)
    log(f"{'Rebuilt' if existing else 'Created'} profile {pid} ({len(built['skills'])} skills, "
        f"{len(built['titles'])} titles)")
    notify(lambda: send_welcome(profile, built, bool(existing)))
    notify(lambda: send_new_recruit(profile, built, bool(existing)))
    return profile


def owner_files() -> tuple[Path, Path]:
    return (SCRIPT_DIR / (env("JOB_PROFILE_FILE") or "job_profile.md"),
            SCRIPT_DIR / (env("JOB_KEYWORDS_FILE") or "cv_keywords.json"))


def backup(path: Path, keep: int = 5) -> None:
    if path.is_file():
        shutil.copy2(path, path.with_name(f"{path.name}.bak-{datetime.now():%Y%m%d-%H%M%S}"))
        for old in sorted(path.parent.glob(f"{path.name}.bak-*"))[:-keep]:
            old.unlink(missing_ok=True)


def _owner_cv() -> Path | None:
    for name in (env("COVER_LETTER_CV_FILE"), str(profile_dir(OWNER) / "cv.txt")):
        path = Path(name) if name and Path(name).is_absolute() else SCRIPT_DIR / name if name else None
        if path and path.is_file():
            return path
    return None


def _is_example(path: Path) -> bool:
    example = SCRIPT_DIR / "job_profile.example.md"
    try:
        return example.is_file() and hc.read_private(path).strip() == example.read_bytes().strip()
    except (OSError, hc.DataKeyError):
        return False


def move_owner_search() -> str:
    """Admins and recruiters are staff, not recruits. An owner who had a job search of their own (a CV in
    job_profile.md) gets it moved, once, to an ordinary recruit profile in their name: the CV, search settings, report
    time, tracker, the jobs already seen, letters and CVs, so their reports carry on as a recruit's. The owner's files
    are left where they were. Returns the recruit's id, or "" when there was nothing to move (or it is running)."""
    owner = ensure_owner()
    profile_file, keywords_file = owner_files()
    if owner.get("recruit") or not profile_file.is_file() or _is_example(profile_file) or scanning(OWNER):
        return ""
    name = owner_name() if owner_name() != "Owner" else str(owner.get("name") or "Owner")
    email = env("ALERT_EMAIL") or env("SMTP_USER") or str(owner.get("email") or "")
    if not EMAIL_RE.fullmatch(email):
        log("The owner's job search was not moved to a recruit: set ALERT_EMAIL to the address its reports go to")
        return ""
    pid = profile_id({"name": name, "id": secrets.token_hex(3)})
    try:
        _copy_owner_search(owner, pid, name, email, profile_file, keywords_file)
    except (OSError, sqlite3.Error, hc.DataKeyError) as exc:
        shutil.rmtree(profile_dir(pid), ignore_errors=True)
        log(f"Could not move the owner's job search to a recruit yet: {exc.__class__.__name__}")
        return ""
    for key in ("titles", "title_keywords", "skills", "roles", "phone", "location", "cv_updated", "schedule",
                "last_duration"):
        owner.pop(key, None)
    owner.update(recruit=pid, status="active", updated=time.time())
    save(owner)
    log(f"Moved the owner's own job search to recruit profile {pid}; the admin is staff only from now on")
    return pid


def _copy_owner_search(owner: dict, pid: str, name: str, email: str, profile_file: Path, keywords_file: Path) -> None:
    d, state = profile_dir(pid), profile_dir(pid) / "state"
    state.mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    hc.write_private(d / "job_profile.md", hc.read_private(profile_file))
    if keywords_file.is_file():
        hc.write_private(d / "cv_keywords.json", hc.read_private(keywords_file))
    if cv := _owner_cv():
        hc.write_private(d / "cv.txt", hc.read_private(cv))
    write_json(d / "settings.json", {k: env(k) for k in sorted(PROFILE_KEYS - IDENTITY_KEYS) if env(k)}, private=True)
    tracker = STATE_DIR / "job_tracker.db"
    if tracker.is_file():
        with contextlib.closing(sqlite3.connect(tracker, timeout=30)) as src, \
                contextlib.closing(sqlite3.connect(state / "job_tracker.db")) as dst:
            src.backup(dst)
    for item in OWNER_STATE_FILES:
        if (STATE_DIR / item).is_file():
            shutil.copy2(STATE_DIR / item, state / item)
    for item in OWNER_STATE_DIRS:
        if (STATE_DIR / item).is_dir():
            shutil.copytree(STATE_DIR / item, state / item, dirs_exist_ok=True)
    last, now = STATE_DIR / "job_scanner_last.json", time.time()
    titles = [t for t in (env("JOB_TARGET_TITLES") or "").split("||") if t.strip()]
    save({"id": pid, "name": name, "email": email, "phone": str(owner.get("phone") or ""),
          "location": str(owner.get("location") or ""), "roles": str(owner.get("roles") or ", ".join(titles))[:300],
          "titles": titles or owner.get("titles", []), "title_keywords": owner.get("title_keywords", []),
          "skills": owner.get("skills", []), "status": owner.get("status", "active"), "created": owner.get("created", now),
          "updated": now, "cv_updated": owner.get("cv_updated") or profile_file.stat().st_mtime,
          "last_run": last.stat().st_mtime if last.is_file() else None,
          "schedule": current_schedule(owner) or DEFAULT_SCHEDULE, "from_owner": True})


def give_recruits_own_search() -> int:
    """Recruits used to take the owner's region, places, country, work types and currency unless their settings.json
    set their own. Each has its own now: the values a recruit was using are written into its settings.json, once.
    Returns how many recruits were given values."""
    marker = PROFILES_DIR / ".own_search"
    if marker.is_file():
        return 0
    given = 0
    for p in all_profiles():
        if p.get("owner"):
            continue
        path = profile_dir(p["id"]) / "settings.json"
        kept = read_json(path, {})
        kept = kept if isinstance(kept, dict) else {}
        added = {k: env(k) for k in SEARCH_KEYS if k not in kept and env(k)}
        if added:
            write_json(path, {**kept, **added}, private=True)
            given += 1
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.touch()
    if given:
        log(f"Gave {given} recruit(s) their own copy of the job search settings they were sharing")
    return given


# --------------------------------------------------------------------------- email

@contextlib.contextmanager
def recipient(address: str):
    before = os.environ.get("ALERT_EMAIL")
    os.environ["ALERT_EMAIL"] = address
    try:
        yield
    finally:
        if before is None:
            os.environ.pop("ALERT_EMAIL", None)
        else:
            os.environ["ALERT_EMAIL"] = before


def send(to: str, subject: str, html_body: str, text: str) -> None:
    with recipient(to):
        hc.send_email(subject, html_body, text, FROM_NAME)


def notify(action) -> None:
    try:
        action()
    except Exception as exc:  # email trouble must not undo a finished profile change
        log(f"Email not sent: {exc.__class__.__name__}: {exc}")


def _email(header: str, blocks: list[str], footer: str = "") -> str:
    cards = "".join(f'<tr><td style="padding-top:14px"><div style="background:#ffffff;border:1px solid #e2e8f0;'
                    f'border-radius:14px;padding:18px 20px">{b}</div></td></tr>' for b in blocks)
    return (f'<!doctype html><html><head><meta charset="utf-8">{EMAIL_HEAD}</head>'
            f'<body class="body" style="margin:0;background:#eef1f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,'
            f'Arial,sans-serif;color:#0f172a"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" '
            f'class="m-wrap" style="padding:24px 12px"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px">'
            f'{header}{cards}<tr><td style="padding:14px 6px;font-size:11px;line-height:18px;color:#64748b;'
            f'text-align:center">{footer}'
            f'</td></tr></table></td></tr></table></body></html>')


def _chips(items: list[str], fg: str, bg: str) -> str:
    return "".join(f'<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 10px;border-radius:99px;'
                   f'background:{bg};color:{fg};font-size:13px;font-weight:600">{html.escape(i)}</span>' for i in items)


def _today() -> str:
    return datetime.now(ZoneInfo(env("HERMES_TIMEZONE", "UTC") or "UTC")).strftime("%A %d %B %Y")


def send_welcome(profile: dict, built: dict, updated: bool) -> None:
    first = profile["name"].split()[0]
    unsub = unsubscribe_link(env("JOB_FEEDBACK_URL", "") or "", env("JOB_FEEDBACK_SECRET", "") or "",
                             profile["name"], profile["id"])
    title = f"Welcome, {first}" if not updated else f"Profile updated, {first}"
    header = email_header(FROM_NAME, _today(), title, "HermitShell has read your CV and set up your job search",
                          [(len(built["skills"]), "Skills from your CV"), (len(built["titles"]), "Job titles"),
                           ("Daily", "Reports")], highlight=0)
    how = ("<ul style=\"margin:8px 0 0;padding-left:18px;font-size:14px;line-height:22px;color:#334155\">"
           "<li>Each morning's report lists new roles with a fit score from 0 to 10, the skills you match and "
           "the ones you are missing.</li>"
           "<li>Use the buttons on each job to say what you think (interested, not for me, applied), so future "
           "matches fit you better.</li>"
           "<li>Generate cover letter writes a letter from your CV and emails it as a PDF.</li>"
           "<li>Tap a yellow missing skill to add it if you do have it.</li>"
           "<li>On Sundays a weekly roll-up shows your applications and the skills that keep coming up.</li></ul>")
    blocks = [
        f'<div style="font-size:13px;font-weight:700;color:#4f46e5;text-transform:uppercase;letter-spacing:.06em">'
        f'HermitShell will search for</div><div style="margin-top:10px">{_chips(built["titles"], "#3730a3", "#eef2ff")}</div>',
        f'<div style="font-size:13px;font-weight:700;color:#047857;text-transform:uppercase;letter-spacing:.06em">'
        f'Skills it matches jobs against</div><div style="margin-top:10px">'
        f'{_chips([s["name"] for s in built["skills"]], "#065f46", "#ecfdf5")}</div>',
        f'<div style="font-size:15px;font-weight:700">How it works</div>{how}',
    ]
    privacy = f"{hc.env('JOB_FEEDBACK_URL', '').rstrip('/')}/privacy" if unsub else ""
    page = own_page_link(env("JOB_FEEDBACK_URL", "") or "", profile["id"], features()["self_service"])
    footer = ("Your first report comes with the next daily email. Something wrong above? Reply to this email."
              + (f'<br><a href="{html.escape(page)}" style="color:#64748b">Your page</a> (your jobs, documents and '
                 "job search; it emails you a sign-in link)" if page else "")
              + (f'<br><a href="{html.escape(unsub)}" style="color:#64748b">Unsubscribe</a> (deletes your profile and CV)'
                 f' &middot; <a href="{html.escape(privacy)}" style="color:#64748b">Your data</a>' if unsub else ""))
    text = (f"{title}\n\nHermitShell will search for: {', '.join(built['titles'])}\n"
            f"Skills: {', '.join(s['name'] for s in built['skills'])}\n\n"
            "Your first report comes with the next daily email."
            + (f"\n\nYour page (your jobs, documents and job search): {page}" if page else "")
            + (f"\n\nUnsubscribe: {unsub}\nHow your data is handled: {privacy}" if unsub else ""))
    send(profile["email"], f"{FROM_NAME}: {title.lower() if updated else 'your profile is ready'}",
         _email(header, blocks, footer), text)


def send_new_recruit(profile: dict, built: dict, updated: bool) -> None:
    name = profile["name"]
    send_owner(f"Recruit updated: {name}" if updated else f"New recruit: {name}",
               [f"{name} {'sent a new CV' if updated else 'joined'}."],
               facts=[("Email", profile.get("email")), ("Location", profile.get("location")),
                      ("Looking for", profile.get("roles"))],
               chips=[("Searching for", built["titles"], "indigo"),
                      ("Skills read from the CV", [s["name"] for s in built["skills"]], "green")],
               action=(f"/admin/profile?u={profile['id']}", f"Open {name.split()[0]}'s profile"))


_TONES = {"indigo": ("#4f46e5", "#3730a3", "#eef2ff"), "green": ("#047857", "#065f46", "#ecfdf5")}
_LABEL = "font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em"


def send_owner(subject: str, lines: list[str], facts: list[tuple[str, str]] = (),
               chips: list[tuple[str, list[str], str]] = (), action: tuple[str, str] | None = None) -> None:
    """`facts` are (label, value) rows under the lines, `chips` are (label, items, tone) groups that each get their
    own card, and `action` is a (Worker path, label) button next to Manage recruits."""
    owner = load(OWNER) or {}
    to = owner.get("email") or env("ALERT_EMAIL")
    if not to:
        return
    admin = (env("JOB_FEEDBACK_URL", "") or "").rstrip("/")
    facts = [(k, str(v)) for k, v in facts if v]
    chips = [(label, items, tone) for label, items, tone in chips if items]
    body = "".join(f'<p style="margin:0 0 8px;font-size:15px;line-height:22px;color:#0f172a">{html.escape(x)}</p>'
                   for x in lines)
    rows = "".join(f'<tr><td style="padding:9px 14px 9px 0;border-top:1px solid #eef1f6;vertical-align:top;width:104px;'
                   f'{_LABEL};color:#64748b">{html.escape(k)}</td><td style="padding:8px 0;border-top:1px solid #eef1f6;'
                   f'font-size:14px;line-height:21px;color:#1e293b">{html.escape(v)}</td></tr>' for k, v in facts)
    table = f'<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">{rows}</table>' if rows else ""
    button = (f'<a href="{html.escape(admin + action[0])}" style="display:inline-block;background:#4f46e5;color:#ffffff;'
              f'border-radius:10px;padding:10px 18px;margin:0 14px 6px 0;font-size:14px;font-weight:600;text-decoration:none;'
              f'vertical-align:middle">{hc.white_label(action[1])}</a>') if admin and action else ""
    link = (f'<p style="margin:16px 0 0;font-size:14px">{button}<a href="{html.escape(admin)}/admin" style="color:#4f46e5">'
            f'Manage recruits</a></p>') if admin else ""
    groups = [f'<div style="{_LABEL};color:{_TONES[tone][0]}">{html.escape(label)} <span style="color:#94a3b8">'
              f'{len(items)}</span></div><div style="margin-top:10px">{_chips(items, *_TONES[tone][1:])}</div>'
              for label, items, tone in chips]
    text = "\n".join([*lines, *(f"{k}: {v}" for k, v in facts), *(f"{label}: {', '.join(items)}" for label, items, _ in chips)])
    profiles = [p for p in all_profiles() if not p.get("owner")]
    header = email_header("Recruits", _today(), subject, "People getting reports from your HermitShell",
                          [(sum(p.get("status") == "active" for p in profiles), "Active"),
                           (sum(p.get("status") == "paused" for p in profiles), "Paused")], highlight=0)
    send(to, f"{FROM_NAME}: {subject}", _email(header, [body + table + link, *groups]),
         text + (f"\n\n{admin}/admin" if admin else ""))


# --------------------------------------------------------------------------- Worker API

class Api:
    """The Worker's /api, over worker_link (HTTPS only, signed, retried)."""

    def __init__(self, base: str, token: str, timeout: int = 30, secret: str | None = None):
        self.link = worker_link.Link(base, token, secret, timeout)
        self.base = self.link.base

    @property
    def live_url(self) -> str:
        return re.sub(r"^http", "ws", self.base, count=1) + "/api/live"

    def live_headers(self) -> dict:
        """Signed afresh for each connection, so a copied handshake can't be replayed."""
        return self.link.headers("GET", "/api/live")

    def call(self, method: str, path: str, params: dict | None = None, json: dict | None = None, retry: bool = True):
        return self.link.json(method, path, params=params, json_body=json, retry=retry)

    def queue(self, full: bool = False) -> list[dict]:
        return self.call("GET", "/api/queue", params={"full": "1"} if full else None).get("items", [])

    def flag(self) -> str:
        """Changes whenever something is queued and is empty once the queue is; one KV read, no list."""
        return str(self.call("GET", "/api/queue/flag").get("flag") or "")

    def ack(self, ids: list[str]) -> None:
        self.link.request("POST", "/api/queue/ack", json_body={"ids": ids})

    def file(self, key: str) -> bytes:
        resp = self.link.request("GET", "/api/file", params={"k": key}, stream=True)
        data = resp.raw.read(MAX_FILE_BYTES + 1, decode_content=True)
        if len(data) > MAX_FILE_BYTES:
            raise ProfileError("CV file too large")
        return data

    def status(self, payload: dict) -> None:
        self.link.request("POST", "/api/status", json_body=payload)

    def stats(self, pid: str, data: dict | None) -> None:
        """A profile's stats page numbers; None removes them."""
        self.link.request("POST", "/api/stats", json_body={"u": pid, "stats": data})

    def desk(self, data: dict) -> None:
        """Every recruit's totals for the desk page; the Worker seals them, since they hold fees."""
        self.link.request("POST", "/api/desk", json_body={"desk": data})

    def forget(self, pid: str) -> None:
        """Drops what the Worker keeps of a deleted profile (its history, notes, stats, documents and answers)."""
        self.link.request("POST", "/api/forget", json_body={"u": pid})

    def invite(self, note: str) -> dict:
        return self.call("POST", "/api/invite", json={"note": note}, retry=False)


def api_from_env() -> Api | None:
    base, token = env("JOB_FEEDBACK_URL", "") or "", env("JOB_FEEDBACK_API_TOKEN", "") or ""
    if base and token and not worker_link.secure_base(base):
        log("JOB_FEEDBACK_URL must start with https://, so the feedback Worker is not used")
        return None
    return Api(base, token) if base and token else None


# --------------------------------------------------------------------------- queue items

def set_status(pid: str, status: str) -> None:
    """Pause or resume a profile; resuming a retired one brings it back, with its retirement and keep date gone."""
    profile = load(pid)
    if not profile:
        raise ProfileError(f"no profile {pid}")
    if profile.get("status") == "retired" and status != "active":
        raise ProfileError("retired: reactivate them first")
    back = profile.get("status") == "retired"
    for key in ("retired_at", "keep_until", "keep_months"):
        profile.pop(key, None)
    profile["status"] = status
    save(profile)
    log(f"Profile {pid} {'reactivated' if back else status}")


def log_files() -> list[Path]:
    """Script output that may name a person: logs, scheduled-job output, run logs in state/ (the live link's
    too) and the per-profile runs log, with their rotated copies."""
    roots = [hc.APP_HOME / "logs", hc.APP_HOME / "cron" / "output"]
    found = [f for root in roots if root.is_dir() for f in root.rglob("*")]
    runs = sorted(STATE_DIR.glob("*.log")) + sorted(STATE_DIR.glob("*.log.1")) + sorted(PROFILES_DIR.glob("runs.log*"))
    return [f for f in found + runs if f.is_file() and not f.is_symlink()]


def scrub_pattern(terms: list[str]) -> re.Pattern | None:
    """What scrub_logs replaces: each term of 4 or more characters, any run of spaces in it matching any other."""
    words = sorted({" ".join(str(t).split()) for t in terms if len(" ".join(str(t).split())) >= 4}, key=len, reverse=True)
    return re.compile("|".join(r"\s+".join(map(re.escape, w.split())) for w in words), re.I) if words else None


def scrub_logs(terms: list[str], max_bytes: int = 50 * 1024 * 1024) -> int:
    """Replace a deleted person's email, name and profile id with [deleted] in log files; returns files changed.
    Files are rewritten in place so a process still appending to one keeps writing to the same file."""
    rx = scrub_pattern(terms)
    if rx is None:
        return 0
    changed = 0
    for path in log_files():
        try:
            if path.stat().st_size > max_bytes:
                continue
            text = path.read_bytes().decode("utf-8", errors="surrogateescape")
            new, n = rx.subn("[deleted]", text)
            if n:
                with open(path, "r+b") as fh:
                    fh.write(new.encode("utf-8", errors="surrogateescape"))
                    fh.truncate()
                changed += 1
        except OSError:
            continue
    return changed


def forget(profile: dict) -> None:
    """Delete an extra profile's folder (CV, profile, tracker, letters, keys) and its traces in the logs."""
    remove_dir(profile["id"])
    files = scrub_logs([profile.get("email", ""), profile.get("name", ""), profile["id"]])
    log(f"Profile deleted; removed from {files} log file(s)")


def send_goodbye(profile: dict) -> None:
    first = profile["name"].split()[0]
    header = email_header(FROM_NAME, _today(), f"Goodbye, {first}", "You are unsubscribed and your data is deleted",
                          [("0", "More reports"), ("Deleted", "Profile, CV and history")])
    body = ('<p style="margin:0 0 8px;font-size:14px;line-height:21px;color:#334155">HermitShell has deleted your '
            "profile, your CV, the jobs it found for you, your feedback, cover letters and tailored CVs, and has "
            "removed your name and email address from its logs.</p>"
            '<p style="margin:0;font-size:14px;line-height:21px;color:#334155">This is the last email you will get '
            "from it. Any copies in the nightly backups are deleted as old backups are cleared out.</p>")
    text = (f"Goodbye, {first}\n\nHermitShell has deleted your profile, your CV, the jobs it found for you, your feedback, "
            "cover letters and tailored CVs, and removed your name and email address from its logs. This is the "
            "last email you will get from it.")
    send(profile["email"], f"{FROM_NAME}: you are unsubscribed", _email(header, [body]), text)


def unsubscribe(pid: str, reason: str = "") -> None:
    profile = load(pid)
    if not profile:
        log(f"Unsubscribe for {pid}: already gone")
        return
    if pid == OWNER:
        # Links in reports sent before the admin's own job search became a recruit.
        if not (moved := owner_recruit()):
            log("Unsubscribe for the admin: they have no reports of their own")
            return
        set_status(moved, "paused")
        note = f"Your own reports are paused. Resume them from /admin or with profiles.py --resume {moved}."
    else:
        forget(profile)
        notify(lambda: send_goodbye(profile))
        note = "Their profile, CV and history have been deleted, their details removed from the logs, " \
               "and they were emailed a confirmation."
    notify(lambda: send_owner(f"{profile['name']} unsubscribed",
                              [f"{profile['name']} used the unsubscribe link.", note]
                              + ([f"Their feedback: {reason}"] if reason else [])))


# --------------------------------------------------------------------------- retiring

def retire_default_months() -> int:
    return max(1, min(36, hc.env_int("HERMES_RETIRE_KEEP_MONTHS", RETIRE_DEFAULT_MONTHS)))


def _date(ts: float) -> str:
    return datetime.fromtimestamp(ts, ZoneInfo(env("HERMES_TIMEZONE", "UTC") or "UTC")).strftime("%d %B %Y").lstrip("0")


def _button(href: str, label: str, colour: str = "#4f46e5") -> str:
    return (f'<a href="{html.escape(href)}" style="display:inline-block;background:{colour};color:#ffffff;border-radius:10px;'
            f'padding:11px 20px;margin:6px 0;font-size:14px;font-weight:600;text-decoration:none">{html.escape(label)}</a>')


def _para(text: str) -> str:
    return f'<p style="margin:0 0 10px;font-size:14px;line-height:21px;color:#334155">{html.escape(text)}</p>'


def retire(profile: dict, now: float | None = None) -> None:
    """Stops a recruit's reports and emails them the link to choose how long their profile is kept for a return, or
    to delete it now with every backup's copy. Until they choose it is kept for retire_default_months()."""
    if profile.get("status") == "retired":
        raise ProfileError("already retired")
    now = time.time() if now is None else now
    profile.update({"status": "retired", "retired_at": now, "keep_until": now + retire_default_months() * MONTH})
    profile.pop("keep_months", None)
    save(profile)
    log(f"Profile {profile['id']} retired")
    notify(lambda: send_retired(profile))


def send_retired(profile: dict) -> None:
    first = profile["name"].split()[0]
    link = retire_link(env("JOB_FEEDBACK_URL", "") or "", env("JOB_FEEDBACK_SECRET", "") or "", profile["name"], profile["id"])
    until = _date(profile["keep_until"])
    header = email_header(FROM_NAME, _today(), f"Your account is retired, {first}",
                          "No more job reports. What should happen to your data?",
                          [("0", "More reports"), (until, "Kept until, unless you choose")])
    lines = ["Your recruiter has retired your HermitShell account, so you won't get any more job reports.",
             "HermitShell can keep your profile, your CV, the jobs it found for you and your answers, so that if you look "
             "for work again your recruiter picks up where you left off, with your employability profile ready. Or it "
             "can delete all of it now, including the copies in its backups."]
    after = (f"If you don't choose, it is kept until {until} and then deleted, backups included. "
             + ("The link works for 90 days; after that, reply to this email." if link else "Reply to this email to choose."))
    body = "".join(map(_para, lines)) + (_button(link, "Keep or delete my data") if link else "") + _para(after)
    text = "\n\n".join([f"Your account is retired, {first}", *lines, *([f"Keep or delete your data: {link}"] if link else []), after])
    send(profile["email"], f"{FROM_NAME}: your account is retired", _email(header, [body]), text)


def send_retire_kept(profile: dict) -> None:
    first, until = profile["name"].split()[0], _date(profile["keep_until"])
    header = email_header(FROM_NAME, _today(), f"Your profile is kept, {first}", f"Until {until}, for when you come back",
                          [(f"{profile['keep_months']} months", "Kept for"), (until, "Then deleted")])
    lines = [f"HermitShell keeps your profile, your CV and your job history until {until}, so you can pick up where you "
             "left off if you look for work again. Then it deletes them, backups included.",
             "Changed your mind? Use the link in the earlier email, or reply to this one."]
    send(profile["email"], f"{FROM_NAME}: your profile is kept until {until}", _email(header, ["".join(map(_para, lines))]),
         "\n\n".join([f"Your profile is kept, {first}", *lines]))


def send_erased(profile: dict, expired: bool) -> None:
    first = profile["name"].split()[0]
    why = "The time you chose to keep your profile for is up, so" if expired else "As you asked,"
    lines = [f"{why} HermitShell has deleted your profile, your CV, the jobs it found for you, your answers, cover letters "
             "and tailored CVs, and removed your name and email address from its logs.",
             "It is also removing them from all of its backups within a day. "
             "This is the last email you will get from it."]
    header = email_header(FROM_NAME, _today(), f"Your data is deleted, {first}", "Profile, CV, history and backups",
                          [("0", "More emails"), ("Deleted", "Including backups")])
    send(profile["email"], f"{FROM_NAME}: your data is deleted", _email(header, ["".join(map(_para, lines))]),
         "\n\n".join([f"Your data is deleted, {first}", *lines]))


def retire_choice(item: dict, api=None, now: float | None = None) -> None:
    """A retired recruit's answer from their email's link: keep for one of RETIRE_KEEP_MONTHS months, or 0 to delete
    everything now. Only while they are still retired, and only from a link sent since they were."""
    pid, keep, day = str(item.get("u") or ""), item.get("keep"), item.get("d")
    profile = load(pid) if ID_RE.match(pid) and pid != OWNER else None
    if not profile or profile.get("owner"):
        raise ProfileError(f"no profile {_text(pid, 40)}")
    if profile.get("status") != "retired":
        raise ProfileError("not retired (reactivated since)")
    if type(day) is not int or day < int(float(profile.get("retired_at") or 0) // 86400):
        raise ProfileError("a link from before this retirement")
    if type(keep) is not int or (keep != 0 and keep not in RETIRE_KEEP_MONTHS):
        raise ProfileError("not a valid choice")
    if keep == 0:
        erase(profile, api)
        return
    now = time.time() if now is None else now
    profile.update({"keep_until": now + keep * MONTH, "keep_months": keep})
    save(profile)
    log(f"Profile {pid} kept for {keep} months, as they chose")
    notify(lambda: send_retire_kept(profile))


def erase(profile: dict, api=None, expired: bool = False, purge_now: bool = True) -> None:
    """Deletes a retired recruit completely: their folder and traces in the logs (forget), what the Worker keeps of them,
    and their copies in every backup, here and off the server (maintenance.py --forget-backups, in the background; the
    nightly run does it itself)."""
    import maintenance
    maintenance.queue_forget(profile)
    forget(profile)
    if api is not None:
        try:
            api.forget(profile["id"])
        except Exception as exc:  # the server's copy is gone either way; the Worker drops the rest with its status
            log(f"The Worker did not drop the deleted profile's data: {exc.__class__.__name__}")
    if purge_now:
        _background([sys.executable, str(SCRIPT_DIR / "maintenance.py"), "--forget-backups"])
    notify(lambda: send_erased(profile, expired))
    notify(lambda: send_owner(f"{profile['name']}'s data is deleted",
                              [f"{profile['name']} was retired and "
                               + ("the time they chose to keep their profile for is up." if expired else "asked for their data to be deleted."),
                               "Their profile, CV and history are deleted, their details removed from the logs, and every "
                               "backup is being cleaned of them. They were emailed a confirmation."]))


def expire_retired(now: float | None = None, api=None) -> int:
    """Deletes the retired recruits whose keep date has passed, backups included; returns how many (nightly)."""
    now = time.time() if now is None else now
    gone = 0
    for p in all_profiles():
        until = p.get("keep_until")
        if (not p.get("owner") and p.get("status") == "retired" and isinstance(until, (int, float))
                and not isinstance(until, bool) and until <= now):
            erase(p, api, expired=True, purge_now=False)
            gone += 1
    return gone


def send_login_link(item: dict) -> None:
    """Emails an active recruit the sign-in link to their own page (/me) that the Worker asked for. The link is built
    from JOB_FEEDBACK_URL, not from anything in the item, and goes only to the address on their profile; one every
    LOGIN_LINK_GAP seconds per recruit. Anything refused is logged (without the address) and dropped, not retried."""
    pid, token = str(item.get("u") or ""), str(item.get("token") or "")
    base = (env("JOB_FEEDBACK_URL", "") or "").rstrip("/")
    profile = load(pid) if ID_RE.match(pid) and pid != OWNER else None
    problem = ("recruits' own page is switched off" if not features()["self_service"]
               else "not a valid sign-in token" if not LOGIN_TOKEN_RE.match(token)
               else "JOB_FEEDBACK_URL must start with https://" if not base.startswith("https://")
               else "not an active recruit" if not profile or profile.get("owner") or profile.get("status") != "active"
               else "no valid email address" if not EMAIL_RE.fullmatch(profile.get("email") or "") else "")
    if problem:
        log(f"Sign-in link not sent: {problem}")
        return
    marker = profile_dir(pid) / ".login_link"
    try:
        if time.time() - marker.stat().st_mtime < LOGIN_LINK_GAP:
            log(f"Sign-in link for {pid} not sent: one went less than {LOGIN_LINK_GAP // 60} minutes ago")
            return
    except OSError:
        pass
    marker.touch()
    link = f"{base}/me/login?t={token}"
    first = _text(profile.get("name"), 80).split(" ")[0] or "there"
    header = email_header(FROM_NAME, _today(), "Your sign-in link", "Opens your own page: your jobs, documents and search",
                          [("Once", "Works"), (f"{LOGIN_LINK_MINUTES} min", "Expires in")])
    body = (f'<p style="margin:0 0 12px;font-size:14px;line-height:21px;color:#334155">Hi {html.escape(first)}, here is '
            "the link you asked for. Open it and press Sign in.</p>"
            f'<p style="margin:0 0 12px"><a href="{html.escape(link)}" style="display:inline-block;background:#4f46e5;'
            'color:#ffffff;border-radius:10px;padding:10px 18px;font-size:14px;font-weight:600;text-decoration:none">'
            "Sign in to your page</a></p>"
            f'<p style="margin:0;font-size:13px;line-height:20px;color:#64748b">It works once, within {LOGIN_LINK_MINUTES} '
            "minutes. Didn't ask for it? Ignore this email: nobody can sign in without it.</p>")
    text = (f"Hi {first}, here is the link you asked for. Open it and press Sign in:\n\n{link}\n\n"
            f"It works once, within {LOGIN_LINK_MINUTES} minutes. Didn't ask for it? Ignore this email.")
    send(profile["email"], f"{FROM_NAME}: your sign-in link", _email(header, [body]), text)
    log(f"Sign-in link sent to {pid}")


def _text(value, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def apply_api_keys(item: dict) -> None:
    updates: dict[str, str | None] = {}
    firecrawl = [k for k in item.get("firecrawl") or [] if isinstance(k, str) and KEY_RE.match(k)][:5]
    if firecrawl:
        updates |= {"FIRECRAWL_API_KEY": firecrawl[0], "FIRECRAWL_BACKUP_KEYS": ",".join(firecrawl[1:])}
    for name in ("tavily", "scrapfly"):
        if isinstance(item.get(name), str) and KEY_RE.match(item[name]):
            updates[API_KEYS[name]] = item[name]
    for name in item.get("clear") or []:
        if name == "firecrawl":
            updates |= {"FIRECRAWL_API_KEY": None, "FIRECRAWL_BACKUP_KEYS": None}
        elif name in ("tavily", "scrapfly"):
            updates[API_KEYS[name]] = None
    if not updates:
        raise ProfileError("no valid API keys")
    update_dashboard_env(updates)
    log(f"API keys updated from the dashboard: {', '.join(sorted(updates))}")


def apply_model_keys(item: dict) -> None:
    """A cloud model provider's key and model from the dashboard (llm_providers.py; a blank model is the
    provider's default), clearing one, or whether the cloud or the local Ollama is asked first."""
    updates: dict[str, str | None] = {}
    name = str(item.get("provider") or "")
    if name in llm_providers.PROVIDERS:
        var = name.upper()
        if item.get("clear") is True:
            updates |= {f"{var}_API_KEY": None, f"{var}_MODEL": None}
        else:
            key, model = item.get("key"), item.get("model")
            if isinstance(key, str) and llm_providers.KEY_RE.match(key):
                updates[f"{var}_API_KEY"] = key
            if model == "":
                updates[f"{var}_MODEL"] = None
            elif isinstance(model, str) and llm_providers.MODEL_RE.match(model):
                updates[f"{var}_MODEL"] = model
    if item.get("order") in ("cloud", "local"):
        updates["LLM_ORDER"] = "local" if item["order"] == "local" else None
    if not updates:
        raise ProfileError("no valid model keys")
    update_dashboard_env(updates)
    log(f"Model settings updated from the dashboard: {', '.join(sorted(updates))}")


def apply_local_model(item: dict, spawn=None) -> None:
    """The server model picked under Global settings: "" goes back to .env's OLLAMA_MODEL (else the one that fits
    the machine), a model Ollama has is used at once, and any other is downloaded first (model_pull.py), refused
    when it is too big for this machine."""
    model = item.get("model")
    if model == "":
        update_dashboard_env({"OLLAMA_MODEL": None})
        log("Server model back to the default from the dashboard")
        return
    if not isinstance(model, str) or not model_pull.NAME_RE.match(model):
        raise ProfileError("invalid model name")
    found = model_pull.ollama()
    if not found:
        raise ProfileError("no Ollama server answers, so the server model can't be changed")
    if any(model_pull.same(model, str(m.get("name", ""))) for m in found[1]):
        update_dashboard_env({"OLLAMA_MODEL": model})
        log(f"Server model set to {model} from the dashboard")
        return
    listed = next((c for c in autofit.choices(found[1]) if c["model"] == model), None)
    if listed and not listed["fits"]:
        raise ProfileError(f"{model} needs more memory than this machine has")
    model_pull.start(model, spawn=spawn)


def apply_email(item: dict) -> None:
    if item.get("clear"):
        update_dashboard_env(dict.fromkeys(SMTP_KEYS))
        log("Email server settings reset to .env")
        return
    host, port = _text(item.get("host"), 120), _text(item.get("port"), 5) or "587"
    user, sender = _text(item.get("user"), 120), _text(item.get("from"), 120)
    if not HOST_RE.match(host) or not port.isdigit() or not 0 < int(port) < 65536 or not user \
            or (sender and not EMAIL_RE.fullmatch(sender)):
        raise ProfileError("invalid email server settings")
    updates = {"SMTP_HOST": host, "SMTP_PORT": port, "SMTP_USER": user, "SMTP_FROM": sender}
    if password := str(item.get("password") or "").strip():
        updates["SMTP_PASSWORD"] = password[:200]
    elif (host.lower(), user.lower()) != ((env("SMTP_HOST") or "").lower(), (env("SMTP_USER") or "").lower()):
        # Never send the old account's password to a different server or account; "" also hides .env's.
        updates["SMTP_PASSWORD"] = ""
    update_dashboard_env(updates)
    log(f"Email server set from the dashboard: {user} via {host}:{port}")


def features() -> dict[str, bool]:
    return {name: hc.env_bool(key, default) for name, (key, default) in FEATURES.items()}


def apply_features(item: dict) -> None:
    """The Features switches under Global settings; anything that is not one of them is ignored."""
    updates = {key: "1" if item[name] else "0" for name, (key, _) in FEATURES.items() if type(item.get(name)) is bool}
    ignored = sorted(k for k in item if k not in FEATURES and k not in ("type", "action", "id", "at"))
    if ignored:
        log(f"Features: ignored {', '.join(_text(k, 40) for k in ignored[:10])}")
    if not updates:
        raise ProfileError("no valid feature switches")
    update_dashboard_env(updates)
    log(f"Features set from the dashboard: {', '.join(f'{k}={v}' for k, v in sorted(updates.items()))}")


def send_test_email(to: str = "") -> dict:
    to = to if EMAIL_RE.fullmatch(to or "") else ((load(OWNER) or {}).get("email") or env("ALERT_EMAIL") or "")
    result: dict = {"at": time.time(), "to": to}
    try:
        header = email_header(FROM_NAME, _today(), "Email works", "Sent from the dashboard's test button", [])
        send(to, f"{FROM_NAME}: test email", _email(header, [
            '<p style="margin:0;font-size:14px;line-height:21px;color:#334155">Your email server settings work. '
            "Daily reports, cover letters and tailored CVs will be sent this way.</p>"]),
            "Your email server settings work.")
        result["ok"] = True
    except Exception as exc:  # the dashboard shows the reason instead of the queue retrying it
        result |= {"ok": False, "error": f"{exc.__class__.__name__}: {exc}"[:240]}
        log(f"Test email failed: {result['error']}")
    write_json(PROFILES_DIR / ".email_test.json", result)
    return result


def profile_getter(profile: dict):
    environ = child_env(profile)
    return lambda key, default=None: (environ.get(key) or "").strip() or default


def current_details(profile: dict) -> dict:
    return {k: profile.get(k, "") for k in ("name", "email", "phone", "location")}


def apply_profile_settings(profile: dict, item: dict) -> None:
    """The dashboard sends only the fields someone changed, so each is laid over the current values; changes made
    meanwhile (by another admin, a CV rebuild or an email button) are kept. A change a recruit made on their own page
    ("self") may only touch their job search and report time, and only while that page is switched on."""
    details = item.get("details") if isinstance(item.get("details"), dict) else None
    if item.get("self"):
        if not features()["self_service"]:
            raise ProfileError("recruits' own page is switched off")
        if details or profile.get("status") != "active":
            raise ProfileError("a recruit's own page can only change an active recruit's job search and report time")
    if details:
        merged = {**current_details(profile), **details}
        new = {"name": _text(merged.get("name"), 80) or profile.get("name", ""),
               "email": _text(merged.get("email"), 120) or profile.get("email", ""),
               "phone": _text(merged.get("phone"), 40), "location": _text(merged.get("location"), 80)}
        if not EMAIL_RE.fullmatch(new["email"]):
            raise ProfileError("invalid email address")
        profile.update(new)
    job = item.get("job") if isinstance(item.get("job"), dict) else None
    if job:
        getter = profile_getter(profile)
        # The dashboard has no separate search location: its searches use the region.
        form = job_settings.clean_form({**job_settings.form_values(getter), "search_location": "", **job})
        updates = job_settings.env_updates(form, getter, profile.get("title_keywords") or [])
        path = profile_dir(profile["id"]) / "settings.json"
        write_json(path, {**read_json(path, {}), **updates}, private=True)
        profile["titles"] = form["titles"] or profile.get("titles", [])
    report = item.get("report") if isinstance(item.get("report"), dict) else None
    if report:
        now_time, now_days = schedule_parts(current_schedule(profile))
        days = str(report.get("days", now_days))
        expr = schedule_expr(str(report.get("time", now_time)), days)
        if not expr or days not in ("daily", "weekdays"):
            raise ProfileError("invalid daily report time")
        profile["schedule"] = expr
    profile["updated"] = time.time()
    save(profile)
    log(f"Profile {profile['id']} settings saved from the dashboard")


def assign(profile: dict, recruiter: str) -> None:
    """Puts a recruit in a dashboard recruiter's pool, or in nobody's for ""; the Worker checks who may see it."""
    if profile.get("owner") or profile["id"] == OWNER:
        raise ProfileError("the owner profile is not anyone's recruit")
    if recruiter and not RECRUITER_RE.match(recruiter):
        raise ProfileError("invalid recruiter")
    if recruiter:
        profile["recruiter"] = recruiter
    else:
        profile.pop("recruiter", None)
    profile["updated"] = time.time()
    save(profile)
    log(f"Profile {profile['id']} {'assigned to ' + recruiter if recruiter else 'unassigned'}")


def bulk_action(item: dict, api=None) -> None:
    """One queue item for up to MAX_BULK recruits ticked on the dashboard, each checked as its single action is.
    Send jobs now runs their reports one after another in one background process, not all at once."""
    op, us = item.get("op"), item.get("us")
    if op not in BULK_OPS or not isinstance(us, list) or not 0 < len(us) <= MAX_BULK:
        raise ProfileError("invalid bulk action")
    pids = list(dict.fromkeys(str(u) for u in us))
    skipped, starting = [], []
    for pid in pids:
        try:
            if op != "send_now":
                admin_action({"action": op, "u": pid, "recruiter": item.get("recruiter")}, api)
                continue
            profile = load(pid)
            if not profile:
                raise ProfileError(f"no profile {pid}")
            if profile.get("status") == "retired":
                raise ProfileError("retired")
            if not has_cv(profile):
                raise ProfileError("no CV yet")
            starting.append(profile)
        except ProfileError as exc:
            skipped.append(f"{_text(pid, 40)}: {exc}")
    if starting:
        start_reports(starting)
    log(f"Bulk {op} from the dashboard: {len(pids) - len(skipped)} done, {len(skipped)} skipped")
    if skipped:
        raise ProfileError(f"{len(skipped)} of {len(pids)} skipped ({skipped[0]})")


def admin_action(item: dict, api=None) -> None:
    action, pid = item.get("action"), str(item.get("u") or "")
    if action == "bulk":
        return bulk_action(item, api)
    if action == "api_keys":
        return apply_api_keys(item)
    if action == "model_keys":
        return apply_model_keys(item)
    if action == "local_model":
        return apply_local_model(item)
    if action == "cancel" and item.get("task") == model_pull.TASK_ID:
        log(model_pull.cancel())
        return None
    if action == "email":
        return apply_email(item)
    if action == "features":
        return apply_features(item)
    if action == "test_email":
        send_test_email(str(item.get("to") or ""))
        return None
    if action == "backup_now":
        return start_backup()
    profile = load(pid)
    if not profile:
        raise ProfileError(f"no profile {pid}")
    if (profile.get("owner") or pid == OWNER) and action != "cancel":
        raise ProfileError(STAFF)
    if action == "profile":
        apply_profile_settings(profile, item)
    elif action == "cv":
        create_profile({**item, **{k: profile.get(k, "") for k in ("name", "email", "phone", "location", "roles")}},
                       api, existing=profile)
    elif action == "assign":
        assign(profile, str(item.get("recruiter") or ""))
    elif action in ("set_key", "use_global"):
        raise ProfileError("recruits no longer have their own crawler keys; set web search keys under Global settings")
    elif action in ("pause", "resume"):
        set_status(pid, "paused" if action == "pause" else "active")
    elif action == "retire":
        retire(profile)
    elif action == "send_now":
        if profile.get("status") == "retired":
            raise ProfileError("retired: reactivate them first")
        start_report(profile)
    elif action == "cancel":
        log(cancel_task(str(item.get("task") or ""), pid))
    elif action == "delete":
        forget(profile)
        log("A profile was deleted from /admin")
    else:
        raise ProfileError(f"unknown admin action {action!r}")


def handle(item: dict, api: Api) -> None:
    try:
        item = worker_seal.open_item(item)
    except worker_seal.SealError as exc:
        raise ProfileError(str(exc)) from None
    kind = item.get("type")
    if kind == "signup":
        create_profile(item, api)
    elif kind == "unsubscribe":
        unsubscribe(str(item.get("u") or "") or OWNER, str(item.get("reason") or "")[:300])
    elif kind == "admin":
        admin_action(item, api)
    elif kind == "login_link":
        send_login_link(item)
    elif kind == "retire_choice":
        retire_choice(item, api)
    else:
        raise ProfileError(f"unknown queue item type {kind!r}")


def recent_problems(max_age: float = 86400) -> list[dict]:
    return [p for p in read_json(PROFILES_DIR / ".problems.json", []) if time.time() - p.get("at", 0) < max_age]


def record_problem(item: dict, error: Exception) -> None:
    """A dashboard change that could not be applied, shown on /admin for a day."""
    if item.get("action") == "bulk":
        count = len(item["us"]) if isinstance(item.get("us"), list) else 0
        what = f"{str(item.get('op') or 'change')[:20].replace('_', ' ')} for {count} recruits"
    else:
        what = str(item.get("action") or item.get("type") or "change").replace("_", " ") \
            + (f" for {item['u']}" if item.get("u") else "")
    write_json(PROFILES_DIR / ".problems.json",
               recent_problems()[-4:] + [{"at": time.time(), "what": what, "error": str(error)[:200]}])


def give_up(item: dict, error: Exception) -> None:
    log(f"Giving up on {item.get('type')} {item.get('id')}: {error}")
    if item.get("type") == "admin":
        record_problem(item, error)
    if item.get("type") == "signup":
        pid = profile_id(item)
        if (PROFILES_DIR / pid).is_dir() and not (PROFILES_DIR / pid / "profile.json").is_file():
            shutil.rmtree(PROFILES_DIR / pid, ignore_errors=True)
        notify(lambda: send_owner(f"Sign-up from {item.get('name', 'someone')} failed",
                                  [f"{item.get('name', '')} <{item.get('email', '')}> signed up, but HermitShell could not "
                                   f"build their profile: {error}.",
                                   "Send them a new invite from /admin; pasting the CV text on the form helps."]))


# --------------------------------------------------------------------------- sync and status

def _ms(seconds: float | None) -> int | None:
    return int(seconds * 1000) if seconds else None


def _key_info(key: str) -> dict:
    value = env(key) or ""
    return {"source": "dashboard" if dashboard_env().get(key) else "env" if value else "none", "hint": mask(value)}


def status_payload() -> dict:
    """What the dashboard shows and prefills its forms with; no passwords or full keys."""
    profiles = []
    jobs = cron_jobs()
    for p in all_profiles():
        if p.get("owner"):
            # Staff: the dashboard names the admin from this row and sends old report links to their moved search.
            profiles.append({"id": p["id"], "name": owner_name() if owner_name() != "Owner" else p.get("name", ""),
                             "email": env("ALERT_EMAIL") or p.get("email", ""), "status": "active", "owner": True,
                             "recruiter": "", "has_cv": False, "recruit": owner_recruit(),
                             "created": _ms(p.get("created"))})
            continue
        job = daily_job(p, jobs or [])
        schedule = p.get("schedule") or (_expr(job) if job else "")
        report_time, report_days = schedule_parts(schedule)
        profiles.append({
            "id": p["id"], "name": p.get("name", ""), "email": p.get("email", ""), "status": p.get("status", "active"),
            "owner": False, "recruiter": str(p.get("recruiter") or ""),
            "has_cv": (profile_dir(p["id"]) / "job_profile.md").is_file(),
            "created": _ms(p.get("created")), "last_run": _ms(p.get("last_run")), "cv_updated": _ms(p.get("cv_updated")),
            **({"retired": _ms(p.get("retired_at")), "keep_until": _ms(p.get("keep_until")),
                "keep_months": p.get("keep_months") or 0} if p.get("status") == "retired" else {}),
            "details": current_details(p),
            "job": job_settings.form_values(profile_getter(p)),
            "report": {"time": report_time, "days": report_days, "schedule": schedule, "job": bool(job),
                       "pending": bool(p.get("schedule"))},
            "scanning": _ms(scanning(p["id"]))})
    test = read_json(PROFILES_DIR / ".email_test.json", {})
    smtp_dash = any(dashboard_env().get(k) for k in SMTP_KEYS)
    email = {"host": env("SMTP_HOST", "smtp.gmail.com"), "port": env("SMTP_PORT", "587"), "user": env("SMTP_USER", ""),
             "from": env("SMTP_FROM", ""), "password_set": bool(env("SMTP_PASSWORD")),
             "source": "dashboard" if smtp_dash else "env" if env("SMTP_USER") else "none",
             "last_test": {"at": _ms(test.get("at")), "ok": test.get("ok"), "error": test.get("error", ""),
                           "to": test.get("to", "")} if test else None}
    keys = {name: _key_info(API_KEYS[name]) for name in ("firecrawl", "tavily", "scrapfly")}
    keys["firecrawl"]["backups"] = len([k for k in (env("FIRECRAWL_BACKUP_KEYS") or "").split(",") if k.strip()])
    every = key_usage.minutes(env("WEB_KEY_USAGE_MINUTES", str(key_usage.EVERY_MINUTES)))
    for name, rows in key_usage.report(key_usage.configured_keys(), STATE_DIR, every).items():
        keys[name]["keys"] = rows
    problems = [{"at": _ms(p["at"]), "what": p.get("what", ""), "error": p.get("error", "")} for p in recent_problems()]
    return {"profiles": profiles, "email": email, "keys": keys, "problems": problems, "timezone": timezone_name(),
            "scheduler": jobs is not None, "tasks": tasks(), "models": models_info(every), "llm": llm_info(),
            "usage": llm_usage.summary(), "features": features(),
            "server": server_info(), "backup": backup_status(), "protocol": worker_link.PROTOCOL,
            "worker_protocol": worker_link.worker_protocol().get("protocol"), "seal": worker_seal.public_key()}


def models_info(every: int) -> dict:
    """Each cloud model provider: where its key comes from (masked), its model, whether it is resting and why,
    requests today and, when set, what is left of its allowance."""
    summary = llm_providers.summary()["providers"]
    rows = key_usage.report(key_usage.model_keys(), STATE_DIR, every)
    out = {}
    for name in llm_providers.order():
        out[name] = _key_info(f"{name.upper()}_API_KEY") | summary[name]
        if name in rows:
            out[name]["keys"] = rows[name]
    return out


def llm_info() -> dict:
    """Which models answer, in order: the cloud providers with a key and the local Ollama (its model, the one
    that fits this machine, where it ran last, where the model was set, the models to choose from and a download
    under way), plus the model that answered last."""
    cfg = hc.model_config()
    suggested = hc.suggested_model()
    summary = llm_providers.summary()
    found = model_pull.ollama()
    source = "dashboard" if dashboard_env().get("OLLAMA_MODEL") else "env" if cfg["model"] else "auto"
    return {"order": summary["order"], "cloud": llm_providers.configured(),
            "local": {"model": env("JOB_SCANNER_MODEL") or cfg["model"] or suggested, "suggested": suggested,
                      **autofit.known(hc.ollama_hosts(cfg)), "source": source,
                      "override": "JOB_SCANNER_MODEL" if env("JOB_SCANNER_MODEL") else "",
                      "online": found is not None, "choices": autofit.choices(found[1] if found else []),
                      "pull": model_pull.info()},
            "last": summary["last"]}


def seen_gpus(gpus: list[dict], now: float | None = None) -> tuple[list[dict], int | None]:
    """The GPUs to show: those reported now, else for a day those last seen, with their use unknown and when they
    were seen, so a missed host report doesn't make a GPU vanish from the server panel."""
    now = time.time() if now is None else now
    path = STATE_DIR / "gpus_seen.json"
    seen = read_json(path, {})
    seen = seen if isinstance(seen, dict) else {}
    at = seen.get("at") if isinstance(seen.get("at"), (int, float)) else 0
    if gpus:
        kept = [{"name": g["name"], "vram_mb": g["vram_mb"]} for g in gpus]
        if seen.get("gpus") != kept or not 0 <= now - at <= GPUS_SEEN_EVERY:
            write_json(path, {"at": now, "gpus": kept})
        return gpus, None
    if not isinstance(seen.get("gpus"), list) or not 0 <= now - at <= GPUS_REMEMBER:
        return [], None
    return [{"name": autofit._text(g.get("name")), "vram_mb": autofit._num(g.get("vram_mb"), 0, 1 << 22), "free_mb": None}
            for g in seen["gpus"][:4] if isinstance(g, dict)], _ms(at)


def server_info() -> dict:
    """The machine HermitShell and its Ollama run on, for the admin's server panel."""
    hw = autofit.hardware()
    gpus, gpus_at = seen_gpus([{"name": g["name"], "vram_mb": g["vram_mb"], "free_mb": g["free_mb"]}
                               for g in hw["gpus"][:4] if g["vram_mb"]])
    try:
        load = round(os.getloadavg()[0], 2)
    except (AttributeError, OSError):
        load = None
    try:
        disk = shutil.disk_usage(STATE_DIR if STATE_DIR.is_dir() else hc.APP_HOME)
        disk_mb = {"total": disk.total >> 20, "free": disk.free >> 20}
    except OSError:
        disk_mb = None
    return {"cpu": {"model": hw["cpu"]["model"], "cores": hw["cpu"]["logical"]}, "load": load, "ram_mb": hw["ram_mb"],
            "gpus": gpus, **({"gpus_at": gpus_at} if gpus_at else {}), "disk_mb": disk_mb}


def _stable(payload: dict) -> dict:
    """The status without what changes by itself (the server's load, requests and tokens counted, the model that
    answered last), so those alone send it at most every STATUS_EVERY seconds. Which GPUs there are, and whether
    their use is known, still counts, so a GPU coming back shows at once."""
    stable = {k: v for k, v in payload.items() if k not in ("server", "usage")}
    if isinstance(payload.get("server"), dict):
        stable["gpus"] = [[g.get("name"), g.get("vram_mb"), g.get("free_mb") is None] for g in payload["server"].get("gpus") or []]
    if isinstance(payload.get("llm"), dict):
        llm = payload["llm"]
        local = llm["local"]
        pull = local.get("pull") or {}
        stable["llm"] = {k: v for k, v in llm.items() if k not in ("last", "local")} | {"local": [
            local.get("model"), local.get("source"), [c.get("installed") for c in local.get("choices") or []],
            pull.get("model"), pull.get("status")]}
    if isinstance(payload.get("models"), dict):
        stable["models"] = {n: {k: v for k, v in m.items() if k not in ("today", "failed", "last_ok")}
                            for n, m in payload["models"].items()}
    return stable


def timezone_name() -> str:
    """HERMES_TIMEZONE if it is a real IANA zone, else UTC; the dashboard shows its times in it."""
    name = (env("HERMES_TIMEZONE") or "").strip()
    try:
        ZoneInfo(name)
    except (ValueError, KeyError, OSError):
        return "UTC"
    return name or "UTC"


def tracker_file(pid: str) -> Path:
    return STATE_DIR / "job_tracker.db" if pid == OWNER else profile_dir(pid) / "state" / "job_tracker.db"


def shared_jobs(people: list[dict], now: float) -> dict[str, list[tuple[str, int]]]:
    """{job key: [(profile id, fit), ...]} for the jobs that suit more than one recruit: first seen in the last
    OTHERS_DAYS days with a fit at or above each one's own email threshold. Each tracker is read again only when
    its file has changed, so one run reads each at most once."""
    found: dict[str, list[tuple[str, int]]] = {}
    for person in people:
        pid, db = person["id"], tracker_file(person["id"])
        try:
            least = int(profile_getter(person)("JOB_SCANNER_MIN_SCORE", "5"))
        except ValueError:
            least = 5
        try:
            mtime = db.stat().st_mtime if db.is_file() else 0.0
            cached = _fits.get(pid)
            if not cached or cached[:2] != (mtime, least):
                _fits[pid] = cached = (mtime, least, profile_stats.fits_index(db, now - OTHERS_DAYS * 86400, least))
        except (sqlite3.Error, OSError) as exc:
            log(f"Could not read the jobs of {pid} for Also suits: {exc.__class__.__name__}")
            continue
        for key, fit in cached[2].items():
            found.setdefault(key, []).append((pid, fit))
    for pid in [p for p in _fits if p not in {x["id"] for x in people}]:
        _fits.pop(pid)
    return {k: sorted(v, key=lambda e: (-e[1], e[0])) for k, v in found.items() if len(v) > 1}


def others_for(pid: str, shared: dict[str, list[tuple[str, int]]]) -> dict[str, list[dict]]:
    """The "Also suits" list of each of `pid`'s shared jobs: the other recruits, best fit first. The Worker shows
    only those the person looking may see."""
    return {key: [{"u": o, "fit": f} for o, f in fits if o != pid][:profile_stats.OTHERS_MAX]
            for key, fits in shared.items() if any(o == pid for o, _ in fits)}


def push_stats(api: Api, now_for: str = "") -> None:
    """Send each profile's stats when they have changed, at most every STATS_EVERY seconds per profile (at once
    for `now_for`), and remove those of deleted profiles."""
    marker = PROFILES_DIR / ".stats.json"
    sent = read_json(marker, {})
    sent = sent if isinstance(sent, dict) else {}
    tz, now = ZoneInfo(timezone_name()), time.time()
    people = [p for p in all_profiles() if not p.get("owner")]
    fx = None
    shared = None
    ids = [p["id"] for p in people]
    for person in people:
        pid = person["id"]
        last = sent.get(pid) if isinstance(sent.get(pid), dict) else {}
        if pid != now_for and now - last.get("at", 0) < STATS_EVERY:
            continue
        private = (person.get("name", ""), person.get("email", ""))
        currency = job_settings.form_values(profile_getter(person))["currency"]
        if currency and fx is None:
            fx = money.rates(STATE_DIR, env("JOB_FX_URL", money.FX_URL))
        if shared is None:
            shared = shared_jobs(people, now)
        try:
            data = profile_stats.collect(tracker_file(pid), tz, now, private, currency, fx or {},
                                         board=worker_link.pipeline_ready(), others=others_for(pid, shared))
        except (sqlite3.Error, OSError, ValueError) as exc:
            log(f"Could not read the stats of {pid}: {exc.__class__.__name__}")
            continue
        digest = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
        if last.get("digest") == digest:
            continue
        try:
            api.stats(pid, data)
        except requests.RequestException as exc:
            log(f"Could not send the stats of {pid} to the Worker: {worker_link.reason(exc)}")
            break
        sent[pid] = {"digest": digest, "at": now}
    for pid in [p for p in sent if p not in ids]:
        try:
            api.stats(pid, None)
        except requests.RequestException:
            break
        sent.pop(pid)
    write_json(marker, sent)


def board_changed(pid: str) -> None:
    """New answers were collected for `pid`: send their stats at once, so the Pipeline shows the move within the
    minute rather than at the next STATS_EVERY upload (nothing without the Worker or for the owner's own run)."""
    api = api_from_env()
    if api and pid and ID_RE.match(pid):
        push_stats(api, now_for=pid)


def desk_payload(people: list[dict], now: float) -> dict:
    """Every recruit's desk line (profile_stats.desk) in their own currency, and the salaries by job title across
    the desk, per currency, each from at least profile_stats.SALARY_MIN_N jobs."""
    tz, fx = ZoneInfo(timezone_name()), None
    recruits, pairs = {}, {}
    for person in people:
        pid = person["id"]
        currency = job_settings.form_values(profile_getter(person))["currency"]
        if currency and fx is None:
            fx = money.rates(STATE_DIR, env("JOB_FX_URL", money.FX_URL))
        try:
            line = profile_stats.desk(tracker_file(pid), tz, now, currency, fx or {})
        except (sqlite3.Error, OSError, ValueError) as exc:
            log(f"Could not read the desk totals of {pid}: {exc.__class__.__name__}")
            continue
        recruits[pid] = line["ranges"]
        if currency:
            pairs.setdefault(currency, []).extend(line["salaries"])
    salaries = [{**row, "currency": code} for code, jobs in pairs.items() for row in profile_stats.salary_titles(jobs)]
    salaries.sort(key=lambda r: (-r["n"], r["title"], r["currency"]))
    return {"v": 1, "recruits": recruits, "salaries": salaries[:12]}


def push_desk(api: Api) -> None:
    """Send the desk's totals when they have changed, at most every DESK_EVERY seconds, once the Worker has the
    desk page."""
    if not worker_link.desk_ready():
        return
    marker = PROFILES_DIR / ".desk.json"
    last = read_json(marker, {})
    last = last if isinstance(last, dict) else {}
    now = time.time()
    if now - last.get("at", 0) < DESK_EVERY:
        return
    data = desk_payload([p for p in all_profiles() if not p.get("owner")], now)
    digest = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    if last.get("digest") == digest:
        write_json(marker, {"digest": digest, "at": now})
        return
    try:
        api.desk(data)
    except requests.RequestException as exc:
        log(f"Could not send the desk totals to the Worker: {worker_link.reason(exc)}")
        return
    write_json(marker, {"digest": digest, "at": now})


def push_status(api: Api, force: bool = False, stats_for: str = "") -> None:
    push_stats(api, stats_for)
    push_desk(api)
    payload = status_payload()
    digest = hashlib.sha256(json.dumps(_stable(payload), sort_keys=True).encode()).hexdigest()
    marker = PROFILES_DIR / ".status"
    last = read_json(marker, {})
    if not force and last.get("digest") == digest and time.time() - last.get("at", 0) < STATUS_EVERY:
        return
    try:
        api.status(payload)
        write_json(marker, {"digest": digest, "at": time.time()})
    except requests.RequestException as exc:
        log(f"Could not report profiles to the Worker: {worker_link.reason(exc)}")


def lock(name: str):
    return hc.run_lock(PROFILES_DIR / f".{name}.lock")


def slow_item(item: dict) -> bool:
    """Queue items that take a model or an email server a while: a sign-up, a new CV, a test email."""
    return item.get("type") == "signup" or (item.get("type") == "admin" and item.get("action") in ("cv", "test_email"))


def sync(api: Api, full: bool = False) -> list[str]:
    """Apply everything waiting in the Worker, in order; returns one line per item handled. What is done is
    reported and acknowledged before each slow item starts, so changes queued ahead of it show as applied on the
    dashboard at once instead of after it."""
    ensure_owner()
    with lock("sync") as got:
        if not got:
            log("Another sync is still running")
            return []
        give_recruits_own_search()
        move_owner_search()
        marker = PROFILES_DIR / ".last_full"
        full = full or not marker.is_file() or time.time() - marker.stat().st_mtime > FULL_LIST_EVERY
        try:
            items = api.queue(full)
        except requests.RequestException as exc:
            log(f"Worker unreachable: {worker_link.reason(exc)}")
            return []
        if full:
            marker.touch()
        attempts = read_json(PROFILES_DIR / ".attempts.json", {})
        done, report = [], []

        def flush(force: bool) -> None:
            write_json(PROFILES_DIR / ".attempts.json", attempts)
            schedule_reports()
            # The dashboard shows a sign-up as pending while it is queued, so the new profile must reach the Worker
            # before the sign-up leaves the queue, or it vanishes from the dashboard in between.
            push_status(api, force=force)
            if done:
                try:
                    api.ack(list(done))
                except requests.RequestException as exc:
                    log(f"Could not acknowledge queue items: {worker_link.reason(exc)}")
                done.clear()

        for item in sorted(items, key=lambda i: str(i.get("id", ""))):
            iid = str(item.get("id", ""))
            if done and slow_item(item):
                flush(True)
            try:
                handle(item, api)
                report.append(f"{item.get('type')}: done ({item.get('name') or item.get('u') or item.get('action')})")
            except (requests.RequestException, RuntimeError, OSError) as exc:
                attempts[iid] = attempts.get(iid, 0) + 1
                log(f"{item.get('type')} {iid}: attempt {attempts[iid]} failed: {exc}")
                if attempts[iid] < QUEUE_ATTEMPTS:
                    continue
                give_up(item, exc)
                report.append(f"{item.get('type')}: gave up ({exc})")
            except ProfileError as exc:
                give_up(item, exc)
                report.append(f"{item.get('type')}: rejected ({exc})")
            done.append(iid)
            attempts.pop(iid, None)
        flush(bool(done))
        return report


def _seconds(key: str, default: int, minimum: int) -> int:
    try:
        value = int(env(key) or default)
    except ValueError:
        value = default
    return value if value <= 0 else max(minimum, value)


def watch(api: Api, seconds: int, poll: int, sleep=time.sleep, clock=time.monotonic) -> list[str]:
    """Between cron runs: check the Worker's queue flag every `poll` seconds and sync as soon as it changes, so a
    dashboard save is applied in seconds rather than at the next run. A flag that stays the same (an item that keeps
    failing) is left to the next run, which keeps the Worker's daily KV list quota safe."""
    report: list[str] = []
    if seconds <= 0:
        return report
    deadline = clock() + seconds
    try:
        last = api.flag()
    except requests.RequestException:
        last = ""
    while clock() + poll < deadline:
        sleep(poll)
        try:
            flag = api.flag()
        except requests.RequestException:
            continue
        if flag and flag != last:
            report += sync(api)
        last = flag
    return report


def _code_stamp() -> tuple[int, ...]:
    return tuple(p.stat().st_mtime_ns if p.is_file() else 0 for p in (Path(__file__).resolve(), Path(hc.__file__)))


def _pushed_flag(message) -> str | None:
    """The queue flag in a message from the live link; None for anything else (such as "pong")."""
    try:
        data = json.loads(message)
    except (TypeError, ValueError):
        return None
    return str(data.get("flag") or "") if isinstance(data, dict) else None


def _print_report(report: list[str]) -> list[str]:
    for line in report:
        print(line, flush=True)
    return report


def _sync_on_link(api: Api) -> list[str]:
    """A sync for the live link. A sync that fails (a bad file, the Worker busy) is logged and retried like one that
    found nothing: it is not the link failing, so it neither drops the link nor counts towards giving it up."""
    try:
        return _print_report(sync(api))
    except Exception as exc:  # any bug in a sync step; the link itself is fine
        log(f"Sync failed ({exc.__class__.__name__}); the live link stays up and tries again")
        return []


def listen(api: Api, seconds: float, connect=None, clock=time.monotonic, sleep=time.sleep, stamp=_code_stamp) -> str:
    """Hold the Worker's live link and sync the moment it says something was queued, reconnecting when it drops
    (a Worker deploy closes it). Syncs on every (re)connect too, for anything queued while it was down.
    Returns "unavailable" when the Worker or this Python has no live link (the cron run then polls), "updated"
    when this script changed (a fresh listener takes over) and "done" after `seconds`."""
    if connect is None:
        try:
            from websockets.sync.client import connect
        except ImportError:
            log("The websockets package is missing, so there is no live link")
            return "unavailable"
    deadline, start = clock() + seconds, stamp()
    last, failures, retries = None, 0, []
    while clock() < deadline:
        if stamp() != start:
            return "updated"
        try:
            with connect(api.live_url, additional_headers=api.live_headers(), open_timeout=20, close_timeout=5,
                         max_size=65536) as ws:
                failures = 0
                log("Live link to the Worker connected")
                next_ping = clock() + LIVE_PING
                while clock() < deadline and stamp() == start:
                    try:
                        message = ws.recv(timeout=max(0.1, min([next_ping, deadline, *retries]) - clock()))
                    except TimeoutError:
                        message = None
                    now = clock()
                    if now >= next_ping:
                        ws.send("ping")
                        next_ping = now + LIVE_PING
                    if retries and retries[0] <= now:
                        retries.pop(0)
                        if _sync_on_link(api):
                            retries = []
                    flag = _pushed_flag(message) if message is not None else None
                    if flag is None or flag == last:
                        continue
                    last = flag
                    found = _sync_on_link(api)
                    retries = [] if found or not flag else [clock() + d for d in LIVE_RETRIES]
        except Exception as exc:  # websockets raises its own errors as well as OSError; a sync bug must not end the link
            status = getattr(getattr(exc, "response", None), "status_code", 0)
            if status in (401, 403):
                log(f"The Worker refused the live link (HTTP {status})")
                return "unavailable"
            # A 404 is retried too: a Worker deployed seconds ago is still reaching every Cloudflare location.
            failures += 1
            reason = f"HTTP {status}" if status else exc.__class__.__name__
            if failures >= LIVE_FAILURES:
                log(f"Live link failed {failures} times in a row ({reason})")
                return "unavailable"
            log(f"Live link dropped ({reason}); reconnecting")
            sleep(min(LIVE_BACKOFF, 5 * 2 ** (failures - 1)))
    return "done"


def listener_running() -> bool:
    with lock("listen") as got:
        return not got


def start_listener(spawn=subprocess.Popen) -> None:
    """Start `profiles.py listen` in the background, detached from the cron run that started it."""
    log_file = STATE_DIR / "profiles-live.log"
    log_file.parent.mkdir(parents=True, exist_ok=True)
    if log_file.is_file() and log_file.stat().st_size > 2_000_000:
        log_file.replace(log_file.with_suffix(".log.1"))
    with open(log_file, "ab") as out:
        spawn([sys.executable, str(Path(__file__).resolve()), "listen"], stdout=out, stderr=subprocess.STDOUT,
              stdin=subprocess.DEVNULL, cwd=SCRIPT_DIR, start_new_session=True)


def ensure_listener(spawn=subprocess.Popen) -> bool:
    """From the cron run: True when a listener holds (or is starting to hold) the live link, so the run can end;
    False when JOB_PROFILES_LIVE turns it off or the Worker had no live link within the hour, so the run polls."""
    if (env("JOB_PROFILES_LIVE") or "on").strip().lower() in ("0", "off", "false", "no"):
        return False
    if time.time() - read_json(PROFILES_DIR / ".live.json", {}).get("unavailable", 0) < LIVE_RECHECK:
        return False
    if not listener_running():
        start_listener(spawn)
    return True


def run_listener(api: Api, spawn=subprocess.Popen) -> int:
    with lock("listen") as got:
        if not got:
            log("A live-link listener is already running")
            return 0
        result = listen(api, LIVE_LIFETIME)
    if result == "unavailable":
        write_json(PROFILES_DIR / ".live.json", {"unavailable": time.time()})
        log("No live link; the vacancy-profiles job polls the Worker instead")
    else:
        write_json(PROFILES_DIR / ".live.json", {})
        start_listener(spawn)
    return 0


# --------------------------------------------------------------------------- one scheduled job per profile

def cron_jobs() -> list[dict] | None:
    """The scheduler's jobs, read-only (changes go through scheduler.py); None when it isn't set up here."""
    try:
        data = json.loads(CRON_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    jobs = data.get("jobs") if isinstance(data, dict) else data
    return [j for j in jobs if isinstance(j, dict) and j.get("id")] if isinstance(jobs, list) else None


def _expr(job: dict) -> str:
    schedule = job.get("schedule")
    return str(schedule.get("expr") or "") if isinstance(schedule, dict) else str(schedule or "")


def _enabled(job: dict) -> bool:
    return job.get("enabled", True) is not False and job.get("state") != "paused"


def report_jobs(jobs: list[dict]) -> dict[str, dict]:
    """Each extra profile's own daily job, by profile id."""
    return {str(j["name"])[len(REPORT_JOB):]: j for j in jobs if str(j.get("name") or "").startswith(REPORT_JOB)}


def daily_job(profile: dict, jobs: list[dict]) -> dict | None:
    """The profile's daily report job: the setup's job_scanner.py job for the owner, its own job for the others."""
    if profile.get("owner"):
        return next((j for j in jobs if str(j.get("script") or "").endswith("job_scanner.py") and not j.get("workdir")),
                    None)
    return report_jobs(jobs).get(profile["id"])


def current_schedule(profile: dict) -> str:
    job = daily_job(profile, cron_jobs() or [])
    return profile.get("schedule") or (_expr(job) if job else "")


def schedule_expr(when: str, days: str = "daily") -> str:
    """'08:30', 'weekdays' -> '30 8 * * 1-5'; '' for a time that isn't HH:MM."""
    m = REPORT_TIME.match((when or "").strip())
    return f"{int(m.group(2))} {int(m.group(1))} * * {'1-5' if days == 'weekdays' else '*'}" if m else ""


def schedule_parts(expr: str) -> tuple[str, str]:
    """'30 8 * * 1-5' -> ('08:30', 'weekdays'); ('', 'daily') for a schedule the dashboard can't show as a time."""
    m = SIMPLE_CRON.match(expr or "")
    if not m or int(m.group(1)) > 59 or int(m.group(2)) > 23:
        return "", "daily"
    return f"{int(m.group(2)):02d}:{int(m.group(1)):02d}", "weekdays" if m.group(3) == "1-5" else "daily"


def shifted(expr: str, minutes: int) -> str:
    m = SIMPLE_CRON.match(expr or "")
    if not m:
        return expr
    total = (int(m.group(2)) * 60 + int(m.group(1)) + minutes) % 1440
    return f"{total % 60} {total // 60} * * {m.group(3)}"


def scheduler_cmd(args: list[str], runner=None) -> bool:
    cli = [sys.executable, str(SCRIPT_DIR / "scheduler.py")]
    try:
        res = (runner or subprocess.run)([*cli, *args], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        log(f"scheduler {args[0]} failed: {exc.__class__.__name__}")
        return False
    if res.returncode:
        log(f"scheduler {args[0]} failed: {((res.stdout or '') + (res.stderr or '')).strip()[-200:]}")
    return res.returncode == 0


def _applied(pid: str) -> None:
    """The time set on the dashboard is in the scheduled job now, which from here on is what counts."""
    if (fresh := load(pid)) and fresh.pop("schedule", None):
        save(fresh)


def schedule_reports(runner=None) -> None:
    """Keep one scheduled job per recruit with a CV, running its daily report: created with the profile, paused
    while it is, removed with it. The admin keeps the setup's job, which runs the server's own work. A time set on
    the dashboard goes into the profile's job; otherwise a new job starts REPORT_GAP minutes after the last. Without
    the scheduler the setup's run runs everyone's reports instead (spawn_others)."""
    jobs = cron_jobs()
    if jobs is None or not (SCRIPT_DIR / REPORT_SCRIPT).is_file():
        return
    owner_job = daily_job({"owner": True}, jobs)
    own = report_jobs(jobs)
    wanted = {p["id"]: p for p in all_profiles() if not p.get("owner")
              and (profile_dir(p["id"]) / "job_profile.md").is_file()}
    for pid, job in own.items():
        if pid not in wanted and scheduler_cmd(["remove", job["id"]], runner):
            log(f"Removed the daily report job of {pid}")
    last = max([_expr(owner_job) if owner_job else DEFAULT_SCHEDULE] + [_expr(own[pid]) for pid in own if pid in wanted],
               key=lambda e: schedule_parts(e)[0] or "")
    for pid, p in wanted.items():
        active, job = p.get("status") == "active", own.get(pid)
        if job is None:
            expr = p.get("schedule") or (last := shifted(last, REPORT_GAP))
            if scheduler_cmd(["create", expr, f"Daily Vacancy Report ({pid})", "--name", REPORT_JOB + pid,
                              "--script", REPORT_SCRIPT, "--workdir", str(profile_dir(pid).resolve()),
                              *([] if active else ["--paused"])], runner):
                log(f"Scheduled the daily report of {pid} ({expr})")
                _applied(pid)
            continue
        if p.get("schedule"):
            if _expr(job) == p["schedule"] or scheduler_cmd(["edit", job["id"], "--schedule", p["schedule"]], runner):
                _applied(pid)
        if active != _enabled(job):
            scheduler_cmd(["resume" if active else "pause", job["id"]], runner)


# --------------------------------------------------------------------------- one profile's report, now or daily

def scan_marker(pid: str) -> Path:
    return profile_dir(pid) / ".scanning.json"


def _alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":  # signal 0 means CTRL_C_EVENT on Windows; HermitShell itself runs on Linux
        return True
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def scanning(pid: str) -> float | None:
    """When the profile's report started, while it is still running."""
    try:
        data = read_json(scan_marker(pid), {})
    except ProfileError:
        return None
    started = data.get("at") if isinstance(data, dict) else None
    if not isinstance(started, (int, float)) or time.time() - started > RUN_TIMEOUT:
        return None
    return started if _alive(int(data.get("pid") or 0)) else None


def scan_progress(stage: str, done: int = 0, total: int = 0) -> None:
    """Where the running report has got to, for the dashboard's task list. Does nothing outside a report started
    through reported(), whose marker it adds to."""
    try:
        marker = scan_marker(env("JOB_PROFILE_ID") or OWNER)
    except ProfileError:
        return
    data = read_json(marker, None)
    if isinstance(data, dict):
        write_json(marker, {**data, "stage": str(stage)[:80], "done": max(0, int(done)), "total": max(0, int(total))})


def tasks_changed() -> None:
    """Tell the dashboard at once that a task started, moved on or finished (nothing without the Worker)."""
    api = api_from_env()
    if api:
        push_status(api)


def _progress_pushes(api: Api, stop: threading.Event, every: float = PROGRESS_EVERY) -> None:
    while not stop.wait(every):
        push_status(api)


def reported(pid: str, run, trigger: str = "schedule") -> int:
    """Run a profile's report with the dashboard told it is scanning (and how far it has got), then when it last
    ran. `trigger` is what started it: its schedule, or Send jobs now on the dashboard."""
    api = api_from_env()
    marker = scan_marker(pid)
    write_json(marker, {"pid": os.getpid(), "at": time.time(), "trigger": trigger if trigger in TRIGGERS else "schedule"})
    stop, beat, started, cancelled = threading.Event(), None, time.time(), False
    try:
        if api:
            push_status(api)
            beat = threading.Thread(target=_progress_pushes, args=(api, stop), daemon=True)
            beat.start()
        code = run()
    finally:
        stop.set()
        if beat:
            beat.join(timeout=30)
        cancelled = bool(read_json(marker, {}).get("cancel"))
        marker.unlink(missing_ok=True)
    if cancelled:
        log(f"The report for {pid} was stopped from the dashboard")
    elif code == 0 and (fresh := load(pid)):
        fresh["last_run"] = time.time()
        fresh["last_duration"] = round(time.time() - started)
        save(fresh)
    if api:
        push_status(api, stats_for=pid)
    return code


def run_child(cmd: list[str], env: dict[str, str], cwd: Path, timeout: float) -> subprocess.CompletedProcess:
    """A report's scan in a process group of its own, noted in its scan marker so the dashboard can stop it (and
    everything it started) without touching the process that is waiting for it."""
    proc = subprocess.Popen(cmd, env=env, cwd=cwd, start_new_session=True)
    marker = Path(env.get("JOB_SCAN_MARKER") or "")
    if marker.name and isinstance(data := read_json(marker, None), dict):
        write_json(marker, {**data, "child": proc.pid})
    try:
        return subprocess.CompletedProcess(cmd, proc.wait(timeout=timeout))
    except subprocess.TimeoutExpired:
        _signal(proc.pid, "job_scanner.py", group=True)
        proc.wait()
        raise


def has_cv(profile: dict) -> bool:
    if profile.get("owner"):
        raise ProfileError(STAFF)
    return (profile_dir(profile["id"]) / "job_profile.md").is_file()


def run_report(pid: str, now: bool = False, runner=None, args: list[str] | tuple = ()) -> int:
    """One profile's report: the run of its scheduled job, or Send jobs now on the dashboard (`now`, which
    emails even when nothing new turned up and runs for a paused profile too)."""
    runner = runner or run_child
    profile = load(pid)
    if not profile:
        raise ProfileError(f"no profile {pid}")
    if not has_cv(profile):
        raise ProfileError("no CV yet: upload one on the dashboard first")
    if not now and profile.get("status") != "active":
        log(f"{pid} is paused, so no report")
        return 0
    with lock(f"report-{pid}") as got:
        if not got or scanning(pid):
            log(f"The report for {pid} is already running")
            return 0
        environ = child_env(profile)
        if now:
            environ["JOB_SCANNER_EMAIL_WHEN_EMPTY"] = "1"
        environ["JOB_SCAN_MARKER"] = str(scan_marker(pid))

        def scan() -> int:
            try:
                return runner([sys.executable, str(SCRIPT_DIR / "job_scanner.py"), *args], env=environ, cwd=SCRIPT_DIR,
                              timeout=RUN_TIMEOUT).returncode
            except subprocess.TimeoutExpired:
                log(f"The report for {pid} took over {RUN_TIMEOUT // 3600} hours and was stopped")
                return 1
        code = reported(pid, scan, "dashboard" if now else "schedule")
    log(f"Report for {pid}: exit {code}")
    return code


def start_report(profile: dict, spawn=None) -> None:
    """Send jobs now: the report runs in the background, so the live link keeps applying dashboard changes."""
    if not has_cv(profile):
        raise ProfileError("no CV yet: upload one on the dashboard first")
    start_reports([profile], spawn)


def start_reports(profiles: list[dict], spawn=None) -> None:
    """Send jobs now for one or more recruits: one background process runs their reports in turn."""
    pids = []
    for profile in profiles:
        if scanning(profile["id"]):
            log(f"The report for {profile['id']} is already running")
        else:
            pids.append(profile["id"])
    if not pids:
        return
    _background([sys.executable, str(Path(__file__).resolve()), "report", "--now", *pids], spawn)
    log(f"Started the report{'s' if len(pids) > 1 else ''} for {', '.join(pids)} from the dashboard")


def _background(cmd: list[str], spawn=None) -> None:
    """Run cmd detached, its output appended to the runs log."""
    log_file = PROFILES_DIR / "runs.log"
    if log_file.is_file() and log_file.stat().st_size > 2_000_000:
        log_file.replace(log_file.with_suffix(".log.1"))
    with open(log_file, "ab") as out:
        (spawn or subprocess.Popen)(cmd, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, cwd=SCRIPT_DIR,
                                    start_new_session=True)


def start_backup(spawn=None) -> None:
    """Back up now: maintenance.py --backup-now in the background, refused while the nightly run holds its lock
    or within 10 minutes of the last backup (it checks both again itself)."""
    import maintenance
    refusal = maintenance.backup_refusal(time.time())
    if refusal:
        raise ProfileError(refusal)
    with hc.run_lock(maintenance.STATE_DIR / maintenance.LOCK_FILE) as got:
        if not got:
            raise ProfileError("maintenance is running now, and its backup with it")
    _background([sys.executable, str(SCRIPT_DIR / "maintenance.py"), "--backup-now"], spawn)
    log("Started a backup from the dashboard")


def backup_status() -> dict:
    """The server panel's backup line."""
    import maintenance
    info = maintenance.backup_info()
    number = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0  # noqa: E731
    whole = lambda v: int(v) if number(v) else 0  # noqa: E731
    stamp = lambda v: _ms(v) if number(v) else None  # noqa: E731
    off = info.get("offsite") if isinstance(info.get("offsite"), dict) else {}
    why = maintenance.offsite_why()
    return {"at": stamp(info.get("at")), "size": whole(info.get("size")), "kept": whole(info.get("kept")),
            "error": str(info.get("error") or "")[:200], "failed_at": stamp(info.get("failed_at")),
            "encrypted": bool(env(hc.DATA_KEY_ENV)),
            "offsite": {"on": not why, "why": why, "at": stamp(off.get("at")), "kept": whole(off.get("kept")),
                        "error": str(off.get("error") or "")[:200], "failed_at": stamp(off.get("failed_at"))}}


# --------------------------------------------------------------------------- the dashboard's task list

def writing_marker(pid: str) -> Path:
    return tracker_file(pid).parent / WRITING_NAME


def _count(value) -> int:
    return max(0, min(int(value), 10_000)) if isinstance(value, (int, float)) else 0


def _pid(value) -> int:
    return value if isinstance(value, int) and value > 0 else 0


def report_task(profile: dict) -> dict | None:
    """A running report: what started it, the stage it has reached and how long the last one took."""
    started = scanning(profile["id"])
    if not started:
        return None
    mark = read_json(scan_marker(profile["id"]), {})
    mark = mark if isinstance(mark, dict) else {}
    last = profile.get("last_duration")
    return {"id": f"report:{profile['id']}", "kind": "report", "u": profile["id"],
            "state": "stopping" if mark.get("cancel") else "running", "at": _ms(started),
            "trigger": mark.get("trigger") if mark.get("trigger") in TRIGGERS else "schedule",
            "stage": str(mark.get("stage") or "Starting")[:80], "done": _count(mark.get("done")),
            "total": _count(mark.get("total")),
            "expected": int(last * 1000) if isinstance(last, (int, float)) and 0 < last < RUN_TIMEOUT else None}


def letter_tasks(pid: str) -> list[dict]:
    """A profile's cover letter, tailored CV and job email requests still to be carried out, the one being done
    first."""
    path = tracker_file(pid)
    if not path.is_file():
        return []
    try:
        with Tracker(path) as tracker:
            rows = tracker.open_requests()
    except (sqlite3.Error, OSError):
        return []
    writing = read_json(writing_marker(pid), {})
    busy = writing.get("event_id") if isinstance(writing, dict) and _alive(_pid(writing.get("pid"))) else ""
    found = []
    for r in rows:
        flags = (r["flags"] or "").split(",")
        found.append({"id": f"letter:{pid}:{r['event_id']}", "kind": r["action"], "u": pid,
                      "state": "running" if r["event_id"] == busy else "waiting", "at": _ms(r["at"]),
                      "trigger": "dashboard" if "quiet" in flags or "send" in flags else "email",
                      "title": str(r["title"] or "")[:120], "employer": str(r["employer"] or "")[:80],
                      "retry": r["attempts"] > 0, "j": str(r["key"] or "")[:300],
                      **({"send": True} if "send" in flags else {})})
    return sorted(found, key=lambda t: t["state"] != "running")


def tasks() -> list[dict]:
    """Everything HermitShell is doing or has waiting: running reports (scheduled or from Send jobs now) and cover
    letter and tailored CV requests, and a server model downloading. The Worker adds what it still holds itself (its
    queue and uncollected requests)."""
    found: list[dict] = [t] if (t := model_pull.task()) else []
    for profile in all_profiles():
        if profile.get("owner"):
            continue
        if task := report_task(profile):
            found.append(task)
        found += letter_tasks(profile["id"])
    return found[:MAX_TASKS]


def _runs(pid: int, script: str) -> bool:
    """Whether process `pid` is running `script` (Linux /proc). Any other process is never signalled, so a stale
    marker whose process id has been reused cannot stop something else."""
    try:
        return script in Path(f"/proc/{pid}/cmdline").read_bytes().decode("utf-8", "replace")
    except OSError:
        return False


def _signal(pid: int, script: str, group: bool = False) -> bool:
    if pid <= 1 or pid == os.getpid() or not _runs(pid, script):
        return False
    try:
        if group and os.getpgid(pid) == pid:
            os.killpg(pid, signal.SIGTERM)
        else:
            os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    return True


def cancel_task(task: str, pid: str) -> str:
    """Stop a running report, or cancel a cover letter or tailored CV request, from the dashboard's task list."""
    match = TASK_RE.match(task or "")
    if not match or (match.group(1) or match.group(2)) != pid:
        raise ProfileError("invalid task")
    if match.group(1):
        marker = scan_marker(pid)
        mark = read_json(marker, {})
        if not scanning(pid) or not isinstance(mark, dict):
            return f"The report for {pid} had already finished"
        write_json(marker, {**mark, "cancel": time.time()})
        child = _pid(mark.get("child"))
        stopped = (_signal(child, "job_scanner.py", group=True) if child
                   else _signal(_pid(mark.get("pid")), "job_scanner.py"))
        return f"Stopping the report for {pid}" if stopped else f"The report for {pid} could not be stopped"
    event_id, path = match.group(3), tracker_file(pid)
    if not path.is_file():
        return f"No such request for {pid}"
    with Tracker(path) as tracker:
        found = tracker.cancel_letter(event_id)
    writing = read_json(writing_marker(pid), {})
    if found and isinstance(writing, dict) and writing.get("event_id") == event_id:
        _signal(_pid(writing.get("pid")), "cover_letter.py")
        writing_marker(pid).unlink(missing_ok=True)
    return f"Cancelled a request for {pid}" if found else f"No such request for {pid}"


def profile_from_cwd() -> str:
    """The profile whose folder a scheduled job runs profile_report.py from."""
    cwd = Path.cwd().resolve()
    return cwd.name if cwd.parent == PROFILES_DIR.resolve() and ID_RE.match(cwd.name) else ""


# --------------------------------------------------------------------------- running scripts for other profiles

def _daily(script: str, args: list[str]) -> bool:
    return script == "job_scanner.py" and not {"--weekly", "--dry-run"} & set(args)


def others(script: str, args: list[str]) -> list[dict]:
    """The extra profiles the owner's run of `script` runs too: all the active ones, except for the daily report
    those with their own scheduled job."""
    extra = active_extra()
    if extra and _daily(script, args):
        own = report_jobs(cron_jobs() or [])
        extra = [p for p in extra if p["id"] not in own]
    return extra


def spawn_others(script: str, args: list[str]) -> bool:
    """From the owner's run: start a background runner that runs `script` for every active extra profile once the
    owner's process has finished. No-op inside a profile's own run or when there are no extra profiles."""
    if env("JOB_PROFILE_ID") or script not in RUNNABLE or not others(script, args):
        return False
    log_file = PROFILES_DIR / "runs.log"
    if log_file.is_file() and log_file.stat().st_size > 2_000_000:
        log_file.replace(log_file.with_suffix(".log.1"))
    with open(log_file, "ab") as out:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "run", "--after", str(os.getpid()), script,
                          *args], stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, cwd=SCRIPT_DIR,
                         start_new_session=True)
    return True


def _wait_for(pid: int) -> None:
    deadline = time.time() + RUN_TIMEOUT
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except OSError:
            return
        time.sleep(5)


def run_all(script: str, args: list[str], after: int | None = None, runner=subprocess.run) -> dict[str, object]:
    if script not in RUNNABLE:
        raise ProfileError(f"{script} cannot be run per profile")
    if after:
        _wait_for(after)
    results: dict[str, object] = {}
    with lock(f"run-{script}") as got:
        if not got:
            log(f"{script} is still running for the other profiles; skipping")
            return results
        daily = _daily(script, args)
        for profile in others(script, args):
            if daily:
                try:
                    code: object = run_report(profile["id"], runner=None if runner is subprocess.run else runner,
                                              args=args)
                except ProfileError as exc:
                    code = str(exc)
            else:
                try:
                    code = runner([sys.executable, str(SCRIPT_DIR / script), *args], env=child_env(profile),
                                  cwd=SCRIPT_DIR, timeout=RUN_TIMEOUT).returncode
                except subprocess.TimeoutExpired:
                    code = "timeout"
            results[profile["id"]] = code
            log(f"{script} for {profile['id']}: exit {code}")
    api = api_from_env()
    if api and script == "job_scanner.py":
        push_status(api)
    return results


# --------------------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    load_env_file()
    if argv[:1] == ["run"]:
        after = int(argv[2]) if argv[1:2] == ["--after"] else None
        rest = argv[3:] if after else argv[1:]
        if not rest:
            print("usage: profiles.py run [--after PID] SCRIPT [ARGS...]")
            return 2
        run_all(rest[0], rest[1:], after)
        return 0
    if argv[:1] == ["report"]:
        ids = [a for a in argv[1:] if a != "--now"] or [profile_from_cwd()]
        if not ids[0]:
            print("usage: profiles.py report [--now] ID [ID...] (or run it from the profile's folder)")
            return 2
        ensure_owner()
        code = 0
        for pid in dict.fromkeys(ids):
            try:
                code = max(code, run_report(pid, now="--now" in argv[1:]))
            except ProfileError as exc:
                log(f"No report for {pid}: {exc}")
                code = max(code, 1)
        return code
    hc.set_model_priority(waiting=True)
    if argv[:1] == ["listen"]:
        api = api_from_env()
        if not api:
            log("JOB_FEEDBACK_URL and JOB_FEEDBACK_API_TOKEN are not set; the live link needs the feedback Worker")
            return 1
        ensure_owner()
        return run_listener(api)
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--list", action="store_true", help="list profiles")
    parser.add_argument("--invite", metavar="NOTE", help="create a single-use sign-up link (note is only for you)")
    parser.add_argument("--pause", metavar="ID")
    parser.add_argument("--resume", metavar="ID")
    parser.add_argument("--delete", metavar="ID", help="delete a profile, its CV and its history")
    parser.add_argument("--assign", nargs=2, metavar=("ID", "RECRUITER"),
                        help="put a recruit in a dashboard recruiter's pool (their username, or \"\" for nobody's)")
    parser.add_argument("--full", action="store_true", help="make the Worker list its whole queue")
    parser.add_argument("--once", action="store_true", help="sync once and exit, without starting the live link or polling")
    args = parser.parse_args(argv)
    ensure_owner()
    try:
        if args.list:
            for p in all_profiles():
                recruiter = "staff" if p.get("owner") else p.get("recruiter") or "-"
                print(f"{p['id']:<24} {p.get('status', ''):<7} {recruiter:<16} {p.get('name', '')} <{p.get('email', '')}>")
            return 0
        if args.assign:
            pid, recruiter = args.assign[0], args.assign[1].strip().lower()
            profile = load(pid)
            if not profile:
                raise ProfileError(f"no profile {pid}")
            assign(profile, recruiter)
            print(f"{pid}: recruit of {recruiter}." if recruiter else f"{pid}: nobody's recruit.")
            return 0
        if args.pause or args.resume:
            set_status(args.pause or args.resume, "paused" if args.pause else "active")
            return 0
        if args.delete:
            profile = load(args.delete)
            if not profile:
                raise ProfileError(f"no profile {args.delete}")
            forget(profile)
            print(f"Deleted {args.delete}.")
            return 0
    except ProfileError as exc:
        print(exc)
        return 1
    started = time.monotonic()
    if args.invite is None:
        import alerts
        alerts.maybe_run()
    api = api_from_env()
    if not api:
        log("JOB_FEEDBACK_URL and JOB_FEEDBACK_API_TOKEN are not set; profiles need the feedback Worker")
        return 1
    if args.invite is not None:
        invite = api.invite(args.invite)
        print(f"Invite link (single use, expires {datetime.fromtimestamp(invite['expires'] / 1000):%d %b %Y}):\n"
              f"{invite['link']}")
        return 0
    retire_own_keys()
    for line in sync(api, args.full):
        print(line)
    if not args.once and not ensure_listener():
        left = _seconds("JOB_PROFILES_WATCH_SECONDS", WATCH_SECONDS, 0) - int(time.monotonic() - started)
        for line in watch(api, left, _seconds("JOB_PROFILES_POLL_SECONDS", POLL_SECONDS, 5)):
            print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Daily Vacancy Report profiles and dashboard settings, managed from the feedback Worker.

The owner (whoever set up Hermes) uses .env, job_profile.md and cv_keywords.json, overlaid by anything saved
on the Worker's /admin dashboard (state/dashboard.json, read by hermes_common before .env). Everyone else joins
through a single-use invite link made on the dashboard. Their details and CV wait in the Worker until this
script collects them, reads the CV, has Hermes' model turn it into a profile and search terms, and emails them.
Each extra profile lives in state/profiles/<id>/ and gets the same daily report, buttons, cover letters,
tailored CVs and weekly roll-up, run after the owner's; the unsubscribe link in its reports deletes it.
Dashboard changes (email server, API keys, job search settings, new CVs, pause, resume, delete) arrive the
same way; passwords and keys stay in the Worker only until this script collects them. The Worker never
reaches this server: this script polls it.

    python3 profiles.py                        # sync with the Worker (cron, every 5 minutes)
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
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

import cv_text
import hermes_common as hc
import job_settings
from hermes_common import EMAIL_HEAD, STATE_DIR, connect_model, email_header, env, load_env_file, log, ollama_chat
from job_settings import slug, term_regex
from job_tracker import unsubscribe_link

SCRIPT_DIR = Path(__file__).resolve().parent
PROFILES_DIR = Path(env("JOB_PROFILES_DIR") or STATE_DIR / "profiles")
DASHBOARD_FILE = hc.DASHBOARD_FILE
OWNER = "owner"
RUNNABLE = ("job_scanner.py", "job_weekly.py", "cover_letter.py")
# Settings that describe the owner; blanked for other profiles so .env cannot fill them back in.
PERSONAL_KEYS = ("ALERT_EMAIL", "JOB_CANDIDATE_NAME", "JOB_PROFILE_FILE", "JOB_KEYWORDS_FILE", "JOB_SCANNER_QUERIES",
                 "JOB_SCANNER_NIJOBS_KEYWORDS", "JOB_TARGET_TITLES", "JOB_TITLE_STRONG", "JOB_TITLE_MEDIUM",
                 "JOB_LEVEL", "JOB_MIN_SALARY", "JOB_REPORT_TAGLINE", "COVER_LETTER_NAME", "COVER_LETTER_CONTACT",
                 "COVER_LETTER_CV_FILE", "COVER_LETTER_SIGN_OFF")
# What a profile's settings.json may set: its personal settings plus the job search ones it would otherwise
# share with the owner (region, country, employment types...).
PROFILE_KEYS = frozenset(PERSONAL_KEYS) | frozenset(job_settings.KEYS)
SMTP_KEYS = ("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM")
API_KEYS = {"firecrawl": "FIRECRAWL_API_KEY", "firecrawl_backup": "FIRECRAWL_BACKUP_KEYS",
            "tavily": "TAVILY_API_KEY", "scrapfly": "SCRAPFLY_API_KEY"}
ID_RE = re.compile(r"^[a-z0-9-]{1,40}$")
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,120}$")
EMAIL_RE = re.compile(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+")
HOST_RE = re.compile(r"^[A-Za-z0-9.-]{3,120}$")
QUEUE_ATTEMPTS = 5
FULL_LIST_EVERY = 3600
STATUS_EVERY = 3600
RUN_TIMEOUT = 4 * 3600
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
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, data, private: bool = False) -> None:
    hc.write_atomic(path, json.dumps(data, indent=2, ensure_ascii=False), private)


def profile_dir(pid: str) -> Path:
    if not ID_RE.match(pid or ""):
        raise ProfileError(f"invalid profile id {pid!r}")
    return PROFILES_DIR / pid


def load(pid: str) -> dict | None:
    return read_json(profile_dir(pid) / "profile.json", None)


def save(profile: dict) -> None:
    write_json(profile_dir(profile["id"]) / "profile.json", profile)


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


def owner_paused() -> bool:
    return not env("JOB_PROFILE_ID") and (load(OWNER) or {}).get("status") == "paused"


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
    write_json(DASHBOARD_FILE, {"env": values, "updated": time.time()}, private=True)
    load_env_file()


def own_key(pid: str) -> str:
    key = read_json(profile_dir(pid) / "secrets.json", {}).get("firecrawl_key", "")
    return key if KEY_RE.match(key) else ""


def apply_keys(environ, pid: str) -> None:
    """A profile with its own Firecrawl key uses only that; the others keep the global keys (dashboard, else .env)."""
    if key := own_key(pid):
        environ["FIRECRAWL_API_KEY"] = key
        environ["FIRECRAWL_BACKUP_KEYS"] = ""


def child_env(profile: dict) -> dict[str, str]:
    d = profile_dir(profile["id"])
    environ = dict(os.environ)
    environ.update({k: "" for k in PERSONAL_KEYS})
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
    })
    apply_keys(environ, profile["id"])
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
                      fmt=PROFILE_SCHEMA, num_predict=1800)
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


def search_settings(built: dict, get=env) -> dict[str, str]:
    location = get("JOB_SEARCH_LOCATION") or get("JOB_REGION_NAME") or ""
    nijobs = bool(get("JOB_SCANNER_NIJOBS_KEYWORDS"))
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
        json.dumps(item, sort_keys=True).encode()).hexdigest()[:6]
    return f"{base}-{tail}"


def read_cv(d: Path, item: dict, api) -> str:
    """The CV text from the uploaded file (kept as cv.<kind>), else the pasted text; saved as cv.txt."""
    d.mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    text = ""
    cv = item.get("cv") or {}
    if cv.get("key"):
        kind = cv.get("kind") if cv.get("kind") in cv_text.KINDS else "txt"
        data = api.file(cv["key"])
        (d / f"cv.{kind}").write_bytes(data)
        try:
            text = cv_text.clean(cv_text.extract_file_isolated(d / f"cv.{kind}"))
        except Exception as exc:  # a malformed or hostile file must not block the pasted fallback
            log(f"Could not read the CV file in {d.name}: {exc.__class__.__name__}")
    pasted = cv_text.clean(str(item.get("cv_text") or ""))
    if len(text) < MIN_CV_CHARS and len(pasted) > len(text):
        text = pasted
    if len(text) < MIN_CV_CHARS:
        raise ProfileError("no readable text in the CV (a scanned image?) and nothing pasted")
    (d / "cv.txt").write_text(text, encoding="utf-8")
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
    (d / "job_profile.md").write_text(profile_markdown({**item, "name": name}, built), encoding="utf-8")
    write_json(d / "cv_keywords.json", keywords_json(built))
    kept = read_json(d / "settings.json", {})
    write_json(d / "settings.json", {**kept, **search_settings(built, lambda k: kept[k] if k in kept else env(k))})
    now = time.time()
    profile = {**(existing or {}), "id": pid, "name": name, "email": email,
               **({} if existing else {"invite": str(item.get("invite") or "")[:40]}),
               "phone": str(item.get("phone", ""))[:40], "location": str(item.get("location", ""))[:80],
               "roles": str(item.get("roles", ""))[:300], "titles": built["titles"],
               "title_keywords": built["title_keywords"],
               "skills": [s["name"] for s in built["skills"]], "status": (existing or {}).get("status", "active"),
               "created": (existing or {}).get("created", now), "updated": now, "cv_updated": now}
    save(profile)
    log(f"{'Rebuilt' if existing else 'Created'} profile {pid} ({len(built['skills'])} skills, "
        f"{len(built['titles'])} titles)")
    notify(lambda: send_welcome(profile, built, bool(existing)))
    notify(lambda: send_owner(f"New profile: {name}" if not existing else f"Profile updated: {name}",
                              [f"{name} <{email}> {'joined' if not existing else 'sent a new CV'}.",
                               f"Looking for: {profile['roles']}",
                               f"Searching for: {', '.join(built['titles'])}",
                               f"Skills read from the CV: {', '.join(profile['skills'])}"]))
    return profile


def owner_files() -> tuple[Path, Path]:
    return (SCRIPT_DIR / (env("JOB_PROFILE_FILE") or "job_profile.md"),
            SCRIPT_DIR / (env("JOB_KEYWORDS_FILE") or "cv_keywords.json"))


def backup(path: Path, keep: int = 5) -> None:
    if path.is_file():
        shutil.copy2(path, path.with_name(f"{path.name}.bak-{datetime.now():%Y%m%d-%H%M%S}"))
        for old in sorted(path.parent.glob(f"{path.name}.bak-*"))[:-keep]:
            old.unlink(missing_ok=True)


def rebuild_owner(item: dict, api, model_info_factory=lambda: connect_model("JOB_SCANNER_MODEL")) -> dict:
    """A CV uploaded for the owner on the dashboard: rebuild job_profile.md and cv_keywords.json (old copies kept
    as .bak-*) and point cover letters and tailored CVs at it. Search titles are only filled in when none are set."""
    owner = ensure_owner()
    d = profile_dir(OWNER)
    text = read_cv(d, item, api)
    details = {"name": owner_name(), "location": owner.get("location", ""),
               "roles": item.get("roles") or owner.get("roles") or (env("JOB_TARGET_TITLES") or "").replace("||", ", ")}
    built = ask_model(text, details, model_info_factory())
    keywords = keywords_json(built)
    profile_file, keywords_file = owner_files()
    for path in (profile_file, keywords_file):
        backup(path)
    profile_file.write_text(profile_markdown(details, built), encoding="utf-8")
    write_json(keywords_file, keywords)
    updates = {"COVER_LETTER_CV_FILE": str(d / "cv.txt")}
    if not env("JOB_TARGET_TITLES"):
        updates.update(search_settings(built))
    update_dashboard_env(updates)
    owner.update(titles=built["titles"], title_keywords=built["title_keywords"],
                 skills=[s["name"] for s in built["skills"]], updated=time.time(), cv_updated=time.time())
    save(owner)
    log(f"Rebuilt the owner profile from a new CV ({len(built['skills'])} skills)")
    notify(lambda: send_owner("Your CV was updated", [
        "Hermes read the CV you uploaded on the dashboard and rebuilt your profile. The previous "
        f"{profile_file.name} and {keywords_file.name} are kept as .bak copies.",
        f"Skills read from the CV: {', '.join(owner['skills'])}",
        f"Titles it suggests: {', '.join(built['titles'])}"]))
    return owner


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
            f'style="padding:24px 12px"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px">'
            f'{header}{cards}<tr><td style="padding:18px 6px;font-size:12px;line-height:18px;color:#64748b">{footer}'
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
    header = email_header(FROM_NAME, _today(), title, "Hermes has read your CV and set up your job search",
                          [(len(built["skills"]), "Skills from your CV"), (len(built["titles"]), "Job titles"),
                           ("Daily", "Reports")], highlight=0)
    how = ("<ul style=\"margin:8px 0 0;padding-left:18px;font-size:14px;line-height:22px;color:#334155\">"
           "<li>Each morning's report lists new roles with a fit score from 0 to 10, the skills you match and "
           "the ones you are missing.</li>"
           "<li>Buttons on every job record what you think (interested, not for me, applied) so later ratings "
           "fit you better.</li>"
           "<li>Generate cover letter writes a letter from your CV and emails it as a PDF.</li>"
           "<li>Tap a yellow missing skill to add it if you do have it.</li>"
           "<li>On Sundays a weekly roll-up shows your applications and the skills that keep coming up.</li></ul>")
    blocks = [
        f'<div style="font-size:13px;font-weight:700;color:#4f46e5;text-transform:uppercase;letter-spacing:.06em">'
        f'Hermes will search for</div><div style="margin-top:10px">{_chips(built["titles"], "#3730a3", "#eef2ff")}</div>',
        f'<div style="font-size:13px;font-weight:700;color:#047857;text-transform:uppercase;letter-spacing:.06em">'
        f'Skills it matches jobs against</div><div style="margin-top:10px">'
        f'{_chips([s["name"] for s in built["skills"]], "#065f46", "#ecfdf5")}</div>',
        f'<div style="font-size:15px;font-weight:700">How it works</div>{how}',
    ]
    footer = ("Your first report arrives with the next daily run. Something wrong in the lists above? "
              "Reply to this email." + (f' <a href="{html.escape(unsub)}" style="color:#64748b">Unsubscribe</a> '
                                        "deletes your profile and CV." if unsub else ""))
    text = (f"{title}\n\nHermes will search for: {', '.join(built['titles'])}\n"
            f"Skills: {', '.join(s['name'] for s in built['skills'])}\n\n"
            "Your first report arrives with the next daily run." + (f"\n\nUnsubscribe: {unsub}" if unsub else ""))
    send(profile["email"], f"{FROM_NAME}: {title.lower() if updated else 'your profile is ready'}",
         _email(header, blocks, footer), text)


def send_owner(subject: str, lines: list[str]) -> None:
    owner = load(OWNER) or {}
    to = owner.get("email") or env("ALERT_EMAIL")
    if not to:
        return
    admin = (env("JOB_FEEDBACK_URL", "") or "").rstrip("/")
    body = "".join(f'<p style="margin:0 0 8px;font-size:14px;line-height:21px;color:#334155">{html.escape(x)}</p>'
                   for x in lines)
    link = f'<p style="margin:10px 0 0"><a href="{html.escape(admin)}/admin" style="color:#4f46e5">Manage profiles</a></p>' \
        if admin else ""
    profiles = all_profiles()
    header = email_header("Profiles", _today(), subject, "People getting reports from your Hermes",
                          [(sum(p.get("status") == "active" for p in profiles), "Active"),
                           (sum(p.get("status") == "paused" for p in profiles), "Paused")], highlight=0)
    send(to, f"{FROM_NAME}: {subject}", _email(header, [body + link]), "\n".join(lines) + (f"\n\n{admin}/admin" if admin else ""))


# --------------------------------------------------------------------------- Worker API

class Api:
    def __init__(self, base: str, token: str, timeout: int = 30):
        self.base, self.timeout = base.rstrip("/"), timeout
        self.headers = {"Authorization": f"Bearer {token}"}

    def call(self, method: str, path: str, **kwargs):
        resp = requests.request(method, f"{self.base}{path}", headers=self.headers, timeout=self.timeout, **kwargs)
        resp.raise_for_status()
        return resp.json()

    def queue(self, full: bool = False) -> list[dict]:
        return self.call("GET", "/api/queue", params={"full": "1"} if full else None).get("items", [])

    def ack(self, ids: list[str]) -> None:
        self.call("POST", "/api/queue/ack", json={"ids": ids})

    def file(self, key: str) -> bytes:
        resp = requests.get(f"{self.base}/api/file", params={"k": key}, headers=self.headers, timeout=self.timeout,
                            stream=True)
        resp.raise_for_status()
        data = resp.raw.read(MAX_FILE_BYTES + 1, decode_content=True)
        if len(data) > MAX_FILE_BYTES:
            raise ProfileError("CV file too large")
        return data

    def status(self, payload: dict) -> None:
        self.call("POST", "/api/status", json=payload)

    def invite(self, note: str) -> dict:
        return self.call("POST", "/api/invite", json={"note": note})


def api_from_env() -> Api | None:
    base, token = env("JOB_FEEDBACK_URL", ""), env("JOB_FEEDBACK_API_TOKEN", "")
    return Api(base, token) if base and token else None


# --------------------------------------------------------------------------- queue items

def set_status(pid: str, status: str) -> None:
    profile = load(pid)
    if not profile:
        raise ProfileError(f"no profile {pid}")
    profile["status"] = status
    save(profile)
    log(f"Profile {pid} {status}")


def unsubscribe(pid: str, reason: str = "") -> None:
    profile = load(pid)
    if not profile:
        log(f"Unsubscribe for {pid}: already gone")
        return
    if pid == OWNER:
        set_status(OWNER, "paused")
        note = "Your own reports are paused. Resume them from /admin or with profiles.py --resume owner."
    else:
        remove_dir(pid)
        log(f"Profile {pid} deleted (unsubscribed)")
        note = "Their profile, CV and history have been deleted."
    notify(lambda: send_owner(f"{profile['name']} unsubscribed",
                              [f"{profile['name']} <{profile.get('email', '')}> used the unsubscribe link.", note]
                              + ([f"Their feedback: {reason}"] if reason else [])))


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
    if profile.get("owner"):
        return env
    environ = child_env(profile)
    return lambda key, default=None: (environ.get(key) or "").strip() or default


def apply_profile_settings(profile: dict, item: dict) -> None:
    owner = bool(profile.get("owner"))
    details = item.get("details") if isinstance(item.get("details"), dict) else None
    if details:
        new = {"name": _text(details.get("name"), 80) or profile.get("name", ""),
               "email": _text(details.get("email"), 120) or profile.get("email", ""),
               "phone": _text(details.get("phone"), 40), "location": _text(details.get("location"), 80)}
        if not EMAIL_RE.fullmatch(new["email"]):
            raise ProfileError("invalid email address")
        if owner:
            updates = {"ALERT_EMAIL": new["email"], "JOB_CANDIDATE_NAME": new["name"], "COVER_LETTER_NAME": new["name"]}
            if (new["phone"], new["location"]) != (profile.get("phone", ""), profile.get("location", "")):
                updates["COVER_LETTER_CONTACT"] = " · ".join(x for x in (new["email"], new["phone"], new["location"]) if x)
            update_dashboard_env(updates)
        profile.update(new)
    job = item.get("job") if isinstance(item.get("job"), dict) else None
    if job:
        form = job_settings.clean_form(job)
        updates = job_settings.env_updates(form, profile_getter(profile), profile.get("title_keywords") or [])
        if owner:
            update_dashboard_env(updates)
        else:
            path = profile_dir(profile["id"]) / "settings.json"
            write_json(path, {**read_json(path, {}), **updates})
        profile["titles"] = form["titles"] or profile.get("titles", [])
    profile["updated"] = time.time()
    save(profile)
    log(f"Profile {profile['id']} settings saved from the dashboard")


def admin_action(item: dict, api=None) -> None:
    action, pid = item.get("action"), str(item.get("u") or "")
    if action == "api_keys":
        return apply_api_keys(item)
    if action == "email":
        return apply_email(item)
    if action == "test_email":
        send_test_email(str(item.get("to") or ""))
        return None
    profile = load(pid)
    if not profile:
        raise ProfileError(f"no profile {pid}")
    if action == "profile":
        apply_profile_settings(profile, item)
    elif action == "cv":
        if pid == OWNER:
            rebuild_owner(item, api)
        else:
            create_profile({**item, **{k: profile.get(k, "") for k in ("name", "email", "phone", "location", "roles")}},
                           api, existing=profile)
    elif action == "set_key" and pid == OWNER:
        apply_api_keys({"firecrawl": [str(item.get("key") or "")]})
    elif action == "set_key":
        key = str(item.get("key") or "")
        if not KEY_RE.match(key):
            raise ProfileError("invalid crawler key")
        write_json(profile_dir(pid) / "secrets.json", {"firecrawl_key": key}, private=True)
        log(f"Profile {pid} now uses its own crawler key ({mask(key)})")
    elif action == "use_global":
        (profile_dir(pid) / "secrets.json").unlink(missing_ok=True)
        log(f"Profile {pid} now uses the global crawler key")
    elif action in ("pause", "resume"):
        set_status(pid, "paused" if action == "pause" else "active")
    elif action == "delete":
        remove_dir(pid)
        log(f"Profile {pid} deleted from /admin")
    else:
        raise ProfileError(f"unknown admin action {action!r}")


def handle(item: dict, api: Api) -> None:
    kind = item.get("type")
    if kind == "signup":
        create_profile(item, api)
    elif kind == "unsubscribe":
        unsubscribe(str(item.get("u") or "") or OWNER, str(item.get("reason") or "")[:300])
    elif kind == "admin":
        admin_action(item, api)
    else:
        raise ProfileError(f"unknown queue item type {kind!r}")


def give_up(item: dict, error: Exception) -> None:
    log(f"Giving up on {item.get('type')} {item.get('id')}: {error}")
    if item.get("type") == "signup":
        pid = profile_id(item)
        if (PROFILES_DIR / pid).is_dir() and not (PROFILES_DIR / pid / "profile.json").is_file():
            shutil.rmtree(PROFILES_DIR / pid, ignore_errors=True)
        notify(lambda: send_owner(f"Sign-up from {item.get('name', 'someone')} failed",
                                  [f"{item.get('name', '')} <{item.get('email', '')}> signed up, but Hermes could not "
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
    for p in all_profiles():
        owner = bool(p.get("owner"))
        last = p.get("last_run")
        if owner:
            last_file = STATE_DIR / "job_scanner_last.json"
            last = last_file.stat().st_mtime if last_file.is_file() else None
            has_cv = owner_files()[0].is_file()
            name, email = owner_name(), env("ALERT_EMAIL") or p.get("email", "")
        else:
            has_cv = (profile_dir(p["id"]) / "job_profile.md").is_file()
            name, email = p.get("name", ""), p.get("email", "")
        key = own_key(p["id"])
        profiles.append({
            "id": p["id"], "name": name, "email": email, "status": p.get("status", "active"), "owner": owner,
            "crawler": "own" if key else "global", "key_hint": mask(key), "has_cv": has_cv,
            "created": _ms(p.get("created")), "last_run": _ms(last), "cv_updated": _ms(p.get("cv_updated")),
            "details": {"name": name, "email": email, "phone": p.get("phone", ""), "location": p.get("location", "")},
            "job": job_settings.form_values(profile_getter(p))})
    test = read_json(PROFILES_DIR / ".email_test.json", {})
    smtp_dash = any(dashboard_env().get(k) for k in SMTP_KEYS)
    email = {"host": env("SMTP_HOST", "smtp.gmail.com"), "port": env("SMTP_PORT", "587"), "user": env("SMTP_USER", ""),
             "from": env("SMTP_FROM", ""), "password_set": bool(env("SMTP_PASSWORD")),
             "source": "dashboard" if smtp_dash else "env" if env("SMTP_USER") else "none",
             "last_test": {"at": _ms(test.get("at")), "ok": test.get("ok"), "error": test.get("error", ""),
                           "to": test.get("to", "")} if test else None}
    keys = {name: _key_info(API_KEYS[name]) for name in ("firecrawl", "tavily", "scrapfly")}
    keys["firecrawl"]["backups"] = len([k for k in (env("FIRECRAWL_BACKUP_KEYS") or "").split(",") if k.strip()])
    return {"profiles": profiles, "email": email, "keys": keys}


def push_status(api: Api, force: bool = False) -> None:
    payload = status_payload()
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    marker = PROFILES_DIR / ".status"
    last = read_json(marker, {})
    if not force and last.get("digest") == digest and time.time() - last.get("at", 0) < STATUS_EVERY:
        return
    try:
        api.status(payload)
        write_json(marker, {"digest": digest, "at": time.time()})
    except requests.RequestException as exc:
        log(f"Could not report profiles to the Worker: {exc.__class__.__name__}")


def lock(name: str):
    return hc.run_lock(PROFILES_DIR / f".{name}.lock")


def sync(api: Api, full: bool = False) -> list[str]:
    """Apply everything waiting in the Worker; returns one line per item handled."""
    ensure_owner()
    with lock("sync") as got:
        if not got:
            log("Another sync is still running")
            return []
        marker = PROFILES_DIR / ".last_full"
        full = full or not marker.is_file() or time.time() - marker.stat().st_mtime > FULL_LIST_EVERY
        try:
            items = api.queue(full)
        except requests.RequestException as exc:
            log(f"Worker unreachable: {exc.__class__.__name__}")
            return []
        if full:
            marker.touch()
        attempts = read_json(PROFILES_DIR / ".attempts.json", {})
        done, report = [], []
        for item in sorted(items, key=lambda i: str(i.get("id", ""))):
            iid = str(item.get("id", ""))
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
        if done:
            try:
                api.ack(done)
            except requests.RequestException as exc:
                log(f"Could not acknowledge queue items: {exc.__class__.__name__}")
        write_json(PROFILES_DIR / ".attempts.json", attempts)
        push_status(api, force=bool(done))
        return report


# --------------------------------------------------------------------------- running scripts for other profiles

def spawn_others(script: str, args: list[str]) -> bool:
    """From the owner's run: start a background runner that runs `script` for every active extra profile once the
    owner's process has finished. No-op inside a profile's own run or when there are no extra profiles."""
    if env("JOB_PROFILE_ID") or script not in RUNNABLE or not active_extra():
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
        daily = script == "job_scanner.py" and not {"--weekly", "--dry-run"} & set(args)
        for profile in active_extra():
            try:
                code = runner([sys.executable, str(SCRIPT_DIR / script), *args], env=child_env(profile),
                              cwd=SCRIPT_DIR, timeout=RUN_TIMEOUT).returncode
            except subprocess.TimeoutExpired:
                code = "timeout"
            results[profile["id"]] = code
            log(f"{script} for {profile['id']}: exit {code}")
            if daily and code == 0 and (fresh := load(profile["id"])):
                fresh["last_run"] = time.time()
                save(fresh)
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
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--list", action="store_true", help="list profiles")
    parser.add_argument("--invite", metavar="NOTE", help="create a single-use sign-up link (note is only for you)")
    parser.add_argument("--pause", metavar="ID")
    parser.add_argument("--resume", metavar="ID")
    parser.add_argument("--delete", metavar="ID", help="delete a profile, its CV and its history")
    parser.add_argument("--full", action="store_true", help="make the Worker list its whole queue")
    args = parser.parse_args(argv)
    ensure_owner()
    try:
        if args.list:
            for p in all_profiles():
                crawler = f"own key {mask(own_key(p['id']))}" if own_key(p["id"]) else "global key"
                print(f"{p['id']:<24} {p.get('status', ''):<7} {crawler:<18} {p.get('name', '')} <{p.get('email', '')}>")
            return 0
        if args.pause or args.resume:
            set_status(args.pause or args.resume, "paused" if args.pause else "active")
            return 0
        if args.delete:
            if not load(args.delete):
                raise ProfileError(f"no profile {args.delete}")
            remove_dir(args.delete)
            print(f"Deleted {args.delete}.")
            return 0
    except ProfileError as exc:
        print(exc)
        return 1
    api = api_from_env()
    if not api:
        log("JOB_FEEDBACK_URL and JOB_FEEDBACK_API_TOKEN are not set; profiles need the feedback Worker")
        return 1
    if args.invite is not None:
        invite = api.invite(args.invite)
        print(f"Invite link (single use, expires {datetime.fromtimestamp(invite['expires'] / 1000):%d %b %Y}):\n"
              f"{invite['link']}")
        return 0
    for line in sync(api, args.full):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())

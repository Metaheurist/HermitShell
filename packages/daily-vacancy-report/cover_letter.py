#!/usr/bin/env python3
"""Tailored cover letters and CVs for Daily Vacancy Report jobs, sent as PDF attachments.

The "Cover letter" and "Tailored CV" buttons on a job card are signed links to the feedback Worker.
Once you confirm (optionally adding a note such as "mention my Azure work"), the Worker queues the
request. This script, run every few minutes by HermitShell's scheduler, fetches the queue, writes the letter
(or tailors the CV, see tailored_cv.py) with the local model from your CV and the job listing, lays it
out as an A4 PDF and emails it to you with the job details. Your CV itself never leaves the HermitShell server.

The finished PDF is also sent to the Worker, which keeps it encrypted for COVER_LETTER_KEEP_DAYS (default 7) so
it can be downloaded from the dashboard's list of jobs sent or from the email button. Within that time a request
for the same job with no new guidance sends the one already made instead of writing another; "Regenerate" asks
for a new one. Requests from the dashboard are kept for download and not emailed. COVER_LETTER_KEEP_DAYS=0
keeps them on this server only, and every request writes a new one.

The dashboard's "Email" button on a job asks for that job's report card to be emailed to the profile (job_mail.py);
it is sent from here too, without the model, and the Worker is told so it can mark the job as emailed.

    python3 cover_letter.py                         # fetch requests from the Worker and send them
    python3 cover_letter.py --job KEY [--note ...]  # write a letter for a tracked job now
    python3 cover_letter.py --job KEY --cv          # tailor the CV for it instead
    python3 cover_letter.py --job KEY --dry-run     # save the PDF under state/, no email

Prints nothing when there is nothing to do, so the cron job stays silent.
"""

from __future__ import annotations

import argparse
import html
import json
import math
import os
import re
import smtplib
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

import hermes_common as hc
import job_mail
import profiles
import tailored_cv
from hermes_common import EMAIL_HEAD, STATE_DIR, connect_model, env, env_int, load_env_file, log, ollama_chat
from job_tracker import REQUEST_ACTIONS, Tracker, secure_base, skills_text, sync_feedback
from letter_pdf import cv_pdf, letter_pdf

hc.LOG_TAG = "cover_letter"
PACKAGE_DIR = Path(__file__).resolve().parent
TRACKER_FILE = STATE_DIR / "job_tracker.db"
LETTER_DIR = STATE_DIR / "cover_letters"
CV_DIR = STATE_DIR / "tailored_cvs"
KIND_LABELS = {"cover_letter": "Cover letter", "tailored_cv": "Tailored CV", "send_job": "Job email"}
SEND_JOB = "send_job"
LOCK_FILE = STATE_DIR / "cover_letter.lock"
# The request being written right now, so the dashboard can show it and stop it (profiles.cancel_task).
WRITING_FILE = STATE_DIR / profiles.WRITING_NAME
# Hourly the Worker lists KV for real, in case its "something is waiting" flag was lost (free plan: 1,000 lists a day).
FULL_SYNC_FILE = STATE_DIR / "feedback_full_sync"
FULL_SYNC_EVERY = 3600
MAX_LISTING_CHARS = 5000
MAX_KEEP_DAYS = 30
DAY = 86400
C_BG, C_CARD, C_INK, C_MUTED, C_ACCENT = "#eef1f7", "#ffffff", "#0f172a", "#64748b", "#4f46e5"

LETTER_SCHEMA = {
    "type": "object",
    "properties": {
        "paragraphs": {"type": "array", "items": {"type": "string"}, "minItems": 3, "maxItems": 5},
    },
    "required": ["paragraphs"],
}
SYSTEM_PROMPT = (
    "You write concise, specific cover letters in UK English for a job candidate. You only use facts that "
    "appear in the candidate's CV: never invent employers, job titles, dates, numbers, qualifications, "
    "certifications or achievements, and never claim a skill the CV does not show. Output JSON only."
)
PLACEHOLDER_RE = re.compile(r"\[[^\]]{2,40}\]|\{[^}]{2,40}\}|<[^>]{2,40}>|\b(?:Lorem|XXX|TBC)\b")
ROLE_RE = re.compile(r"\b[Aa]s (?:(?:an?|the|my) )?(?:(?:former|current) )?"
                     r"([A-Z][\w/&+-]*(?: (?:[A-Z][\w/&+-]*|of|and|&))*) at [A-Z]")


# --------------------------------------------------------------------------- inputs

def profile_text(tracker: Tracker | None = None) -> str:
    parts = []
    for name in (env("JOB_PROFILE_FILE") or "job_profile.md", env("COVER_LETTER_CV_FILE")):
        path = Path(name) if name and Path(name).is_absolute() else PACKAGE_DIR / (name or "")
        if name and path.is_file():
            parts.append(hc.read_private_text(path).strip())
    if parts and skills_text(tracker):
        parts.append(skills_text(tracker))
    return "\n\n".join(parts)


def candidate_name(profile: str) -> str:
    if env("COVER_LETTER_NAME"):
        return env("COVER_LETTER_NAME").strip()
    found = re.search(r"^(?:Candidate|Name)\s*:\s*([^,\n]{3,60})", profile, flags=re.I | re.M)
    return found.group(1).strip() if found else ""


def listing_text(job: dict) -> str:
    """The listing saved when the job was rated, or a fresh scrape for jobs rated before letters existed."""
    if job.get("listing"):
        return job["listing"][:MAX_LISTING_CHARS]
    if not job.get("url"):
        return ""
    try:
        return (hc.WebClient(env_int("JOB_SCANNER_MIN_CREDITS", 40)).scrape(job["url"]) or "")[:MAX_LISTING_CHARS]
    except (requests.RequestException, RuntimeError, ValueError) as exc:
        log(f"could not fetch the listing for {job.get('title', '')[:60]}: {exc.__class__.__name__}")
        return ""


def employer(job: dict) -> str:
    return job.get("employer") or job.get("company") or ""


def job_title(job: dict) -> str:
    """The title without a trailing "at <employer>" that some boards append."""
    title, company = job.get("title") or "the advertised role", employer(job)
    if company and title.lower().endswith(f" at {company.lower()}"):
        title = title[:-len(company) - 4].strip()
    return title


# --------------------------------------------------------------------------- writing

def letter_prompt(job: dict, profile: str, listing: str, note: str) -> str:
    facts = "\n".join(f"{label}: {value}" for label, value in (
        ("Job title", job_title(job)), ("Employer", employer(job)),
        ("Advertised by", job.get("company") if job.get("employer") and job.get("company") != job.get("employer")
         else ""),
        ("Location", job.get("location")), ("Type", job.get("employment_type")), ("Salary", job.get("salary")),
        ("About the employer", job.get("about") or job.get("company_profile")),
        ("CV skills the listing asks for", ", ".join(job.get("matched") or [])),
        ("Requirements the CV does not show", ", ".join(job.get("gaps") or [])),
        ("Why it was rated a fit", job.get("reasoning")),
    ) if value)
    return (
        f"CANDIDATE CV:\n{profile}\n\nJOB:\n{facts}\n\n"
        f"LISTING TEXT:\n{listing or '(not available: rely on the job details above)'}\n\n"
        + (f"CANDIDATE'S NOTE FOR THIS LETTER (follow it if it is consistent with the CV):\n{note}\n\n" if note else "")
        + "Write the body of a cover letter for this job as 4 paragraphs, 250 to 380 words in total:\n"
          "1. Why this role at this employer: name both, and show you read the listing.\n"
          "2. The most relevant current or recent experience from the CV, tied to the listing's main "
          "requirements, with concrete systems, tools and responsibilities from the CV.\n"
          "3. Further evidence: other roles, projects or qualifications from the CV that fit. If a requirement "
          "is missing from the CV, focus on transferable experience instead of claiming it.\n"
          "4. A short, confident close inviting a conversation.\n"
          "Rules: first person; plain professional tone; no salutation, no sign-off and no name (they are added "
          "separately); no placeholders or brackets; no em dashes; avoid cliches such as 'I am excited' or "
          "'passionate'; do not mention salary, and do not say the letter was written by AI.\n"
          "Accuracy: use job titles exactly as the CV writes them; only tie a skill or tool to an employer "
          "when the CV lists it in that role's own description (core competencies are general skills, and "
          "personal projects are described as projects, never as work at an employer); never add outcomes, "
          "reviews, approvals, awards, metrics or team sizes the CV does not state.\n"
          'Return {"paragraphs": ["...", "...", "...", "..."]}.'
    )


def invented_titles(paragraphs: list[str], profile: str) -> list[str]:
    """Job titles the letter claims ("as an X at Y") that the CV never uses."""
    cv = " ".join(profile.lower().split())
    titles = dict.fromkeys(m.group(1) for p in paragraphs for m in ROLE_RE.finditer(p))
    return [title for title in titles if title.lower() not in cv]


def write_letter(host: str, model: str, num_ctx: int | None, job: dict, profile: str, listing: str,
                 note: str = "", tries: int = 2) -> list[str]:
    prompt = letter_prompt(job, profile, listing, note)
    for attempt in range(1, tries + 1):
        reply = ollama_chat(host, model, SYSTEM_PROMPT, prompt, num_ctx, fmt=LETTER_SCHEMA, num_predict=1200)
        paragraphs = [" ".join(str(p).split()) for p in json.loads(reply).get("paragraphs", []) if str(p).strip()]
        words = sum(len(p.split()) for p in paragraphs)
        if len(paragraphs) < 3 or words < 150:
            problem = f"letter too short ({len(paragraphs)} paragraphs, {words} words)"
        elif any(PLACEHOLDER_RE.search(p) for p in paragraphs):
            problem = "letter contains a placeholder"
        elif titles := invented_titles(paragraphs, profile):
            problem = f"letter uses job titles the CV does not: {', '.join(titles)}"
        else:
            return paragraphs
        if attempt < tries:
            log(f"Rewriting: {problem}")
    raise ValueError(problem)


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "job"


def build_pdf(job: dict, name: str, paragraphs: list[str], when: datetime) -> bytes:
    recipient = [line for line in ("Hiring Manager", employer(job), job.get("location", "")) if line]
    return letter_pdf(name, env("COVER_LETTER_CONTACT", "") or "", f"{when.day} {when:%B %Y}", recipient,
                      f"Application for {job_title(job)}", "Dear Hiring Manager,",
                      paragraphs, env("COVER_LETTER_SIGN_OFF", "Kind regards,") or "Kind regards,",
                      title=f"Cover letter: {job_title(job)}" + (f" - {name}" if name else ""))


# --------------------------------------------------------------------------- email

def esc(text) -> str:
    return html.escape(str(text or ""), quote=True)


EMAIL_TEXT = {
    "cover_letter": ("Cover letter ready", "Your tailored letter is attached as <b>{file}</b>. Read it through and "
                     "adjust anything before you send it.", "Letter preview",
                     "Written by HermitShell&rsquo;s model from your CV and the listing. Check it before sending."),
    "tailored_cv": ("Tailored CV ready", "Your CV, tailored to this job, is attached as <b>{file}</b>. Job titles, "
                    "employers and dates are copied from your CV; read it through before you send it.",
                    "Profile and skills",
                    "Only reorders and rephrases your own CV. Check it before sending."),
}


def email_bodies(job: dict, paragraphs: list[str], filename: str, note: str,
                 kind: str = "cover_letter") -> tuple[str, str, str]:
    title, company = job_title(job), employer(job)
    eyebrow, intro, preview_label, footer = EMAIL_TEXT[kind]
    subject = f"{KIND_LABELS[kind]}: {title}" + (f" at {company}" if company else "")
    rows = [(label, value) for label, value in (
        ("Employer", company), ("Advertised by", job.get("company") if job.get("company") != company else ""),
        ("Location", job.get("location")), ("Type", job.get("employment_type")), ("Salary", job.get("salary")),
        ("Closing date", job.get("closing")), ("HermitShell fit", f"{job['fit']}/10" if job.get("fit") is not None else ""),
    ) if value]
    table = "".join(f'<tr><td style="padding:4px 12px 4px 0;font-size:13px;color:{C_MUTED};white-space:nowrap">'
                    f'{esc(label)}</td><td style="padding:4px 0;font-size:13px;color:{C_INK}">{esc(value)}</td></tr>'
                    for label, value in rows)
    preview = "".join(f'<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#334155">{esc(p)}</p>'
                      for p in paragraphs)
    note_block = (f'<div style="font-size:13px;color:{C_MUTED};margin-top:8px">Your note: {esc(note)}</div>'
                  if note else "")
    view = (f'<a href="{esc(job["url"])}" style="display:inline-block;background:{C_ACCENT};color:#ffffff;'
            f'border-radius:10px;padding:10px 18px;font-size:14px;font-weight:600;text-decoration:none">'
            f'View job</a>') if job.get("url") else ""
    body = f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">{EMAIL_HEAD}<title>{esc(subject)}</title></head>
<body class="body" style="margin:0;padding:0;background:{C_BG};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_BG}"><tr><td align="center" style="padding:24px 12px">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%">
<tr><td style="background:#1e1b4b;border-radius:20px;padding:26px 28px">
  <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c4b5fd;font-weight:700">{eyebrow}</div>
  <div style="font-size:24px;font-weight:800;color:#ffffff;margin:6px 0 4px">{esc(title)}</div>
  <div style="font-size:15px;color:#e0e7ff">{esc(company)}</div>
</td></tr>
<tr><td style="padding-top:18px">
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_CARD};border:1px solid #e2e8f0;border-radius:16px">
<tr><td style="padding:22px 24px">
  <div style="font-size:14px;color:#334155;line-height:1.5">{intro.format(file=esc(filename))}</div>{note_block}
  <table cellpadding="0" cellspacing="0" style="margin:16px 0">{table}</table>
  {view}
</td></tr></table>
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_CARD};border:1px solid #e2e8f0;border-radius:16px;margin-top:18px">
<tr><td style="padding:22px 24px">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:{C_ACCENT};font-weight:700;margin-bottom:10px">{preview_label}</div>
  {preview}
</td></tr></table>
<div style="font-size:11px;color:{C_MUTED};line-height:18px;padding:14px 6px;text-align:center">
  {footer}</div>
</td></tr></table></td></tr></table></body></html>"""
    text = "\n".join([f"{subject}", "", f"Attached: {filename}", *(f"{k}: {v}" for k, v in rows),
                      f"Job: {job.get('url', '')}", "", *[f"{p}\n" for p in paragraphs]])
    return subject, body, text


# --------------------------------------------------------------------------- run

def file_name(text: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "", text)[:120] + ".pdf"


def save_doc(folder: Path, job: dict, pdf: bytes, filename: str, preview: list[str]) -> Path:
    """The PDF, and beside it the name and preview its email uses, so it can be sent again without the model."""
    when = datetime.now(ZoneInfo(env("HERMES_TIMEZONE", "UTC") or "UTC"))
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{when:%Y-%m-%d}-{slug(employer(job))}-{slug(job_title(job))}.pdf"
    hc.write_private(path, pdf)
    hc.write_private(path.with_suffix(".json"), json.dumps({"filename": filename, "preview": preview}).encode())
    return path


def email_doc(kind: str, job: dict, pdf: bytes, filename: str, preview: list[str], note: str) -> None:
    subject, body, text = email_bodies(job, preview, filename, note, kind=kind)
    hc.send_email(subject, body, text, env("COVER_LETTER_FROM_NAME", "HermitShell cover letters") or "HermitShell",
                  attachments=[(filename, pdf, "application/pdf")])


def make_letter(tracker: Tracker, key: str, note: str, model_info: tuple[str, str, int | None],
                dry_run: bool, send: bool = True) -> Path:
    job = tracker.job(key)
    if not job:
        raise LookupError(f"job {key} is not in the tracker")
    profile = profile_text(tracker)
    if not profile:
        raise FileNotFoundError("no CV profile found (JOB_PROFILE_FILE / job_profile.md)")
    name = candidate_name(profile)
    paragraphs = write_letter(*model_info, job, profile, listing_text(job), note)
    when = datetime.now(ZoneInfo(env("HERMES_TIMEZONE", "UTC") or "UTC"))
    pdf = build_pdf(job, name, paragraphs, when)
    filename = file_name(f"Cover letter - {name or 'Candidate'} - {job_title(job)}")
    path = save_doc(LETTER_DIR, job, pdf, filename, paragraphs)
    if send and not dry_run:
        email_doc("cover_letter", job, pdf, filename, paragraphs, note)
    return path


def make_cv(tracker: Tracker, key: str, note: str, model_info: tuple[str, str, int | None],
            dry_run: bool, send: bool = True) -> Path:
    job = tracker.job(key)
    if not job:
        raise LookupError(f"job {key} is not in the tracker")
    master = tailored_cv.master_cv(lambda: model_info, tracker)
    name = candidate_name(profile_text(tracker)) or "Candidate"
    master |= {"name": name, "contact": env("COVER_LETTER_CONTACT", "") or ""}
    cv = tailored_cv.tailored_cv(master, job, listing_text(job), note, model_info)
    pdf = cv_pdf(cv, title=f"CV - {name} - {job_title(job)}")
    filename = file_name(f"CV - {name} - {job_title(job)}")
    preview = [p for p in (cv["headline"], cv["summary"], "Skills: " + ", ".join(cv["skills"])) if p]
    path = save_doc(CV_DIR, job, pdf, filename, preview)
    if send and not dry_run:
        email_doc("tailored_cv", job, pdf, filename, preview, note)
    return path


MAKERS = {"cover_letter": make_letter, "tailored_cv": make_cv}


# --------------------------------------------------------------------------- made before, kept for download

def keep_days() -> int:
    """How long a finished letter or CV is reused and kept on the Worker for download; 0 turns both off."""
    return max(0, min(env_int("COVER_LETTER_KEEP_DAYS", 7), MAX_KEEP_DAYS))


def doc_dir(kind: str) -> Path:
    return LETTER_DIR if kind == "cover_letter" else CV_DIR


def recent_doc(tracker: Tracker, kind: str, key: str, now: float | None = None) -> tuple[Path, float] | None:
    """The letter or CV made for this job within keep_days() and when it was made, if its file is still on disk."""
    days = keep_days()
    found = tracker.recent_doc(key, kind, (now or time.time()) - days * DAY) if days else None
    name = Path(str(found["file"])).name if found else ""
    path = doc_dir(kind) / name if name.endswith(".pdf") else None
    return (path, found["at"]) if path and path.is_file() else None


def days_left(made: float, now: float | None = None) -> int:
    """Whole days (at least 1) until a document made at `made` is past keep_days()."""
    return max(1, math.ceil((made + keep_days() * DAY - (now or time.time())) / DAY))


def doc_info(path: Path, kind: str, job: dict) -> tuple[str, list[str]]:
    try:
        info = json.loads(hc.read_private_text(path.with_suffix(".json")))
    except (OSError, ValueError):
        info = {}
    info = info if isinstance(info, dict) else {}
    preview = [str(p) for p in info.get("preview", []) if isinstance(p, str)] if isinstance(info.get("preview"), list) else []
    return str(info.get("filename") or file_name(f"{KIND_LABELS[kind]} - {job_title(job)}")), preview


def upload_doc(kind: str, key: str, path: Path, filename: str, days: int | None = None) -> str:
    """Send a finished PDF to the Worker to keep for download for `days` (default keep_days()); returns a problem
    to log, or ""."""
    base, token = secure_base(env("JOB_FEEDBACK_URL", "") or ""), env("JOB_FEEDBACK_API_TOKEN", "")
    if not (keep_days() and base and token):
        return ""
    days = min(days or keep_days(), keep_days())
    params = {"u": env("JOB_PROFILE_ID", "") or profiles.OWNER, "j": key, "k": kind, "days": str(days), "name": filename}
    try:
        requests.post(f"{base}/api/doc", params=params, data=hc.read_private(path), timeout=30,
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/pdf"}).raise_for_status()
    except (requests.RequestException, OSError, RuntimeError) as exc:
        return f"could not keep {path.name} on the Worker for download: {exc.__class__.__name__}"
    return ""


def record_emailed(key: str) -> str:
    """Tell the Worker a job was emailed, for its "Emailed" mark on the dashboard; returns a problem to log, or ""."""
    base, token = secure_base(env("JOB_FEEDBACK_URL", "") or ""), env("JOB_FEEDBACK_API_TOKEN", "")
    if not (base and token):
        return ""
    params = {"u": env("JOB_PROFILE_ID", "") or profiles.OWNER, "j": key}
    try:
        requests.post(f"{base}/api/emailed", params=params, timeout=30,
                      headers={"Authorization": f"Bearer {token}"}).raise_for_status()
    except requests.RequestException as exc:
        return f"could not mark the job as emailed on the Worker: {exc.__class__.__name__}"
    return ""


def send_again(tracker: Tracker, kind: str, key: str, path: Path, note: str, send: bool, dry_run: bool) -> None:
    """Email a letter or CV made before, as it was, instead of writing a new one."""
    job = tracker.job(key)
    if not job:
        raise LookupError(f"job {key} is not in the tracker")
    if send and not dry_run:
        filename, preview = doc_info(path, kind, job)
        email_doc(kind, job, hc.read_private(path), filename, preview, note)


def process_pending(tracker: Tracker, model_info_factory, dry_run: bool = False) -> list[str]:
    """Send every queued letter and CV; returns one line per request handled (printed for the cron log)."""
    pending = [(kind, req) for kind in REQUEST_ACTIONS for req in tracker.pending_letters(action=kind)]
    if not pending:
        return []
    profiles.tasks_changed()
    model: list = []
    lines = []
    for kind, req in pending:
        what = KIND_LABELS[kind]
        job = tracker.job(req["key"]) or {}
        label = (job_title(job) if job else req["key"]) + (f" at {employer(job)}" if employer(job) else "")
        if tracker.letter_cancelled(req["event_id"]):
            lines.append(f"{what} for {label} was cancelled from the dashboard")
            continue
        flags, note = set((req.get("flags") or "").split(",")), req.get("reason") or ""
        send = "quiet" not in flags
        profiles.write_json(WRITING_FILE, {"event_id": req["event_id"], "pid": os.getpid(), "at": time.time()})
        profiles.tasks_changed()
        path = earlier = None
        try:
            if kind != SEND_JOB and not note and "fresh" not in flags:
                earlier = recent_doc(tracker, kind, req["key"])
            if kind == SEND_JOB:
                job_mail.send_job(tracker, req["key"], dry_run)
            elif earlier:
                path = earlier[0]
                send_again(tracker, kind, req["key"], path, note, send, dry_run)
            else:
                model = model or [model_info_factory()]
                path = MAKERS[kind](tracker, req["key"], note, model[0], dry_run, send=send)
        except LookupError as exc:
            tracker.mark_letter(req["event_id"], req["key"], "error", str(exc), max_attempts=1)
            lines.append(f"{what} skipped for {label}: {exc}")
            continue
        except (requests.RequestException, smtplib.SMTPException, OSError, RuntimeError, ValueError) as exc:
            status = tracker.mark_letter(req["event_id"], req["key"], "error", f"{exc.__class__.__name__}: {exc}")
            lines.append(f"{what} {'failed' if status == 'failed' else 'will retry'} for {label}: "
                         f"{exc.__class__.__name__}: {str(exc)[:160]}")
            continue
        finally:
            WRITING_FILE.unlink(missing_ok=True)
        if kind == SEND_JOB:
            if not dry_run:
                tracker.mark_letter(req["event_id"], req["key"], "sent")
                if problem := record_emailed(req["key"]):
                    log(problem)
            lines.append(f"{what} {'not sent (dry run)' if dry_run else 'sent'} for {label}")
            continue
        if not dry_run:
            tracker.mark_letter(req["event_id"], req["key"], "sent", file=path.name)
            days = days_left(earlier[1]) if earlier else None
            if problem := upload_doc(kind, req["key"], path, doc_info(path, kind, job)[0], days):
                log(problem)
        done = "saved" if dry_run else "sent" if send else "made for download"
        lines.append(f"{what} {done} for {label}: {path.name}" + (" (the one made earlier)" if earlier else ""))
    profiles.tasks_changed()
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--job", help="tracker key of a job to write a letter for now")
    parser.add_argument("--note", default="", help="extra guidance for the letter (with --job)")
    parser.add_argument("--cv", action="store_true", help="tailor the CV instead of writing a letter (with --job)")
    parser.add_argument("--dry-run", action="store_true", help="save the PDF but send no email")
    args = parser.parse_args(argv)
    load_env_file()
    hc.set_model_priority(waiting=True)
    if not args.job:
        profiles.spawn_others("cover_letter.py", ["--dry-run"] if args.dry_run else [])

    def model_info():
        return connect_model("COVER_LETTER_MODEL" if env("COVER_LETTER_MODEL") else "JOB_SCANNER_MODEL")

    tracker = Tracker(TRACKER_FILE)
    try:
        if args.job:
            kind = "tailored_cv" if args.cv else "cover_letter"
            path = MAKERS[kind](tracker, args.job, args.note, model_info(), args.dry_run)
            print(f"{KIND_LABELS[kind]} {'saved' if args.dry_run else 'sent'}: {path}")
            return 0
        with hc.run_lock(LOCK_FILE) as held:  # overlapping cron runs must not send the same letter twice
            if not held:
                return 0
            full = not FULL_SYNC_FILE.is_file() or time.time() - FULL_SYNC_FILE.stat().st_mtime > FULL_SYNC_EVERY
            _, error = sync_feedback(tracker, env("JOB_FEEDBACK_URL", "") or "",
                                     env("JOB_FEEDBACK_API_TOKEN", "") or "", ack=not args.dry_run,
                                     profile=env("JOB_PROFILE_ID", "") or "", full=full)
            if error:
                log(error)
            elif full and not args.dry_run:
                FULL_SYNC_FILE.touch()
            lines = process_pending(tracker, model_info, args.dry_run)
        if lines:
            print("\n".join(lines))
        return 0
    finally:
        tracker.close()


if __name__ == "__main__":
    sys.exit(main())

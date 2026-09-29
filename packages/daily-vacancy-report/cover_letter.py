#!/usr/bin/env python3
"""Tailored cover letters for Daily Vacancy Report jobs, sent as a PDF attachment.

The "Cover letter" button on a job card is a signed link to the feedback Worker. Once you confirm
(optionally adding a note such as "mention my Azure work"), the Worker queues the request. This
script, run every few minutes by `hermes cron`, fetches the queue, writes the letter with Hermes'
model from your CV profile and the job listing, lays it out as an A4 PDF and emails it to you with
the job details. Your CV never leaves the Hermes server.

    python3 cover_letter.py                         # fetch requests from the Worker and send letters
    python3 cover_letter.py --job KEY [--note ...]  # write one for a tracked job now
    python3 cover_letter.py --job KEY --dry-run     # save the PDF under state/cover_letters, no email

Prints nothing when there is nothing to do, so the cron job stays silent.
Shared unchanged between the HermitShell package and the Hermes server copy.
"""

from __future__ import annotations

import argparse
import html
import json
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
from hermes_common import EMAIL_HEAD, STATE_DIR, connect_model, env, env_int, load_env_file, log, ollama_chat
from job_tracker import Tracker, skills_text, sync_feedback
from letter_pdf import letter_pdf

hc.LOG_TAG = "cover_letter"
PACKAGE_DIR = Path(__file__).resolve().parent
TRACKER_FILE = STATE_DIR / "job_tracker.db"
LETTER_DIR = STATE_DIR / "cover_letters"
LOCK_FILE = STATE_DIR / "cover_letter.lock"
LOCK_STALE_SECONDS = 45 * 60
MAX_LISTING_CHARS = 5000
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
            parts.append(path.read_text(encoding="utf-8").strip())
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


def email_bodies(job: dict, paragraphs: list[str], filename: str, note: str) -> tuple[str, str, str]:
    title, company = job_title(job), employer(job)
    subject = f"Cover letter: {title}" + (f" at {company}" if company else "")
    rows = [(label, value) for label, value in (
        ("Employer", company), ("Advertised by", job.get("company") if job.get("company") != company else ""),
        ("Location", job.get("location")), ("Type", job.get("employment_type")), ("Salary", job.get("salary")),
        ("Closing date", job.get("closing")), ("Hermes fit", f"{job['fit']}/10" if job.get("fit") is not None else ""),
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
            f'View job &rarr;</a>') if job.get("url") else ""
    body = f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">{EMAIL_HEAD}<title>{esc(subject)}</title></head>
<body class="body" style="margin:0;padding:0;background:{C_BG};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_BG}"><tr><td align="center" style="padding:24px 12px">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%">
<tr><td style="background:#1e1b4b;border-radius:20px;padding:26px 28px">
  <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c4b5fd;font-weight:700">Cover letter ready</div>
  <div style="font-size:24px;font-weight:800;color:#ffffff;margin:6px 0 4px">{esc(title)}</div>
  <div style="font-size:15px;color:#e0e7ff">{esc(company)}</div>
</td></tr>
<tr><td style="padding-top:18px">
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_CARD};border:1px solid #e2e8f0;border-radius:16px">
<tr><td style="padding:22px 24px">
  <div style="font-size:14px;color:#334155;line-height:1.5">Your tailored letter is attached as <b>{esc(filename)}</b>.
  Read it through and adjust anything before you send it.</div>{note_block}
  <table cellpadding="0" cellspacing="0" style="margin:16px 0">{table}</table>
  {view}
</td></tr></table>
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_CARD};border:1px solid #e2e8f0;border-radius:16px;margin-top:18px">
<tr><td style="padding:22px 24px">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:{C_ACCENT};font-weight:700;margin-bottom:10px">Letter preview</div>
  {preview}
</td></tr></table>
<div style="font-size:12px;color:{C_MUTED};line-height:1.6;padding:16px 6px;text-align:center">
  Written by Hermes&rsquo; model on your Hermes server from your CV profile and the job listing.
  Check every claim before sending.</div>
</td></tr></table></td></tr></table></body></html>"""
    text = "\n".join([f"{subject}", "", f"Attached: {filename}", *(f"{k}: {v}" for k, v in rows),
                      f"Job: {job.get('url', '')}", "", *[f"{p}\n" for p in paragraphs]])
    return subject, body, text


# --------------------------------------------------------------------------- run

class Lock:
    """Keeps overlapping cron runs from sending the same letter twice."""

    def __enter__(self):
        LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
        if LOCK_FILE.exists() and time.time() - LOCK_FILE.stat().st_mtime > LOCK_STALE_SECONDS:
            LOCK_FILE.unlink(missing_ok=True)
        try:
            os.close(os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            self.held = True
        except FileExistsError:
            self.held = False
        return self

    def __exit__(self, *exc):
        if self.held:
            LOCK_FILE.unlink(missing_ok=True)


def make_letter(tracker: Tracker, key: str, note: str, model_info: tuple[str, str, int | None],
                dry_run: bool) -> Path:
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
    LETTER_DIR.mkdir(parents=True, exist_ok=True)
    path = LETTER_DIR / f"{when:%Y-%m-%d}-{slug(employer(job))}-{slug(job_title(job))}.pdf"
    path.write_bytes(pdf)
    if not dry_run:
        filename = re.sub(r'[\\/:*?"<>|]+', "", f"Cover letter - {name or 'Candidate'} - {job_title(job)}")[:120] + ".pdf"
        subject, body, text = email_bodies(job, paragraphs, filename, note)
        hc.send_email(subject, body, text, env("COVER_LETTER_FROM_NAME", "Hermes cover letters") or "Hermes",
                      attachments=[(filename, pdf, "application/pdf")])
    return path


def process_pending(tracker: Tracker, model_info_factory, dry_run: bool = False) -> list[str]:
    """Send every queued letter; returns one line per request handled (printed for the cron log)."""
    pending = tracker.pending_letters()
    if not pending:
        return []
    model_info = model_info_factory()
    lines = []
    for req in pending:
        job = tracker.job(req["key"]) or {}
        label = (job_title(job) if job else req["key"]) + (f" at {employer(job)}" if employer(job) else "")
        try:
            path = make_letter(tracker, req["key"], req.get("reason") or "", model_info, dry_run)
        except LookupError as exc:
            tracker.mark_letter(req["event_id"], req["key"], "error", str(exc), max_attempts=1)
            lines.append(f"Cover letter skipped for {label}: {exc}")
            continue
        except (requests.RequestException, smtplib.SMTPException, OSError, RuntimeError, ValueError) as exc:
            status = tracker.mark_letter(req["event_id"], req["key"], "error", f"{exc.__class__.__name__}: {exc}")
            lines.append(f"Cover letter {'failed' if status == 'failed' else 'will retry'} for {label}: "
                         f"{exc.__class__.__name__}: {str(exc)[:160]}")
            continue
        if not dry_run:
            tracker.mark_letter(req["event_id"], req["key"], "sent", file=path.name)
        lines.append(f"Cover letter {'saved' if dry_run else 'sent'} for {label}: {path.name}")
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--job", help="tracker key of a job to write a letter for now")
    parser.add_argument("--note", default="", help="extra guidance for the letter (with --job)")
    parser.add_argument("--dry-run", action="store_true", help="save the PDF but send no email")
    args = parser.parse_args(argv)
    load_env_file()

    def model_info():
        return connect_model("COVER_LETTER_MODEL" if env("COVER_LETTER_MODEL") else "JOB_SCANNER_MODEL")

    tracker = Tracker(TRACKER_FILE)
    try:
        if args.job:
            path = make_letter(tracker, args.job, args.note, model_info(), args.dry_run)
            print(f"Cover letter {'saved' if args.dry_run else 'sent'}: {path}")
            return 0
        with Lock() as lock:
            if not lock.held:
                return 0
            _, error = sync_feedback(tracker, env("JOB_FEEDBACK_URL", "") or "",
                                     env("JOB_FEEDBACK_API_TOKEN", "") or "", ack=not args.dry_run)
            if error:
                log(error)
            lines = process_pending(tracker, model_info, args.dry_run)
        if lines:
            print("\n".join(lines))
        return 0
    finally:
        tracker.close()


if __name__ == "__main__":
    sys.exit(main())

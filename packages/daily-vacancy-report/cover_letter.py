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

The profile page's "Generate" asks for the profile's own CV, for no job: every role from the structured copy of the
uploaded CV (tailored_cv.py), laid out as the tailored ones are, saved as state/cv.pdf and sent to the Worker, which
keeps it for download until the next one replaces it or the profile is unsubscribed or deleted. It is not emailed.

An interview prep pack ("Interview prep" on the dashboard, or queued here when a job reaches Interview and
INTERVIEW_PREP_AUTO is on, once per job) is a PDF of facts about the employer taken only from the advert, the
questions they are likely to ask, answers in STAR form built only from the job's evidence map, and questions to ask
them. It is checked as letters are (figures, placeholders, stock phrases), rewritten once if it fails, and sent with
a "check before use" line if it still does. It is emailed and kept for download as letters are.

With DOC_WORD_COPIES=1 (Global settings, Features) each letter, tailored CV and prep pack also gets a Word copy
(letter_docx.py), saved beside the PDF and attached to the same email. A Worker that has them (protocol 5) gets the
PDF and the Word copy in one upload, kept as one value, so it costs no extra KV writes.

    python3 cover_letter.py                         # fetch requests from the Worker and send them
    python3 cover_letter.py --job KEY [--note ...]  # write a letter for a tracked job now
    python3 cover_letter.py --job KEY --length short --tone warm   # choose its length and tone
    python3 cover_letter.py --job KEY --cv          # tailor the CV for it instead
    python3 cover_letter.py --job KEY --prep        # make its interview prep pack instead
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

import evidence
import hermes_common as hc
import job_mail
import profiles
import tailored_cv
import worker_link
from hermes_common import (EMAIL_HEAD, STATE_DIR, connect_model, env, env_int, load_env_file, log, ollama_chat,
                           white_label)
from job_tracker import REQUEST_ACTIONS, Tracker, secure_base, skills_text, sync_feedback
from job_extras import compact_profile
import writing_checks
from letter_docx import DOCX_MIME, cv_docx, letter_docx, prep_docx
from letter_pdf import cv_pdf, letter_pdf, prep_pdf
from writing_checks import letter_problems

hc.LOG_TAG = "cover_letter"
PACKAGE_DIR = Path(__file__).resolve().parent
TRACKER_FILE = STATE_DIR / "job_tracker.db"
LETTER_DIR = STATE_DIR / "cover_letters"
CV_DIR = STATE_DIR / "tailored_cvs"
PREP_DIR = STATE_DIR / "interview_prep"
KIND_LABELS = {"cover_letter": "Cover letter", "tailored_cv": "Tailored CV", "send_job": "Job email", "profile_cv": "CV",
               "interview_prep": "Interview prep"}
SEND_JOB = "send_job"
INTERVIEW_PREP = "interview_prep"
PROFILE_CV = "profile_cv"
PROFILE_CV_FILE = STATE_DIR / "cv.pdf"
BUNDLE_MAGIC = b"HSD1"
LOCK_FILE = STATE_DIR / "cover_letter.lock"
# The request being written right now, so the dashboard can show it and stop it (profiles.cancel_task).
WRITING_FILE = STATE_DIR / profiles.WRITING_NAME
# Hourly the Worker lists KV for real, in case its "something is waiting" flag was lost (free plan: 1,000 lists a day).
FULL_SYNC_FILE = STATE_DIR / "feedback_full_sync"
FULL_SYNC_EVERY = 3600
MAX_LISTING_CHARS = 5000
# With an evidence map the requirements are already distilled, so the letter gets less of the advert.
LISTING_WITH_MAP = 2500
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
# Letter length and tone, chosen on the request (job_tracker.REQUEST_FLAGS): paragraphs, words, reply tokens.
LENGTHS = {"short": (3, (170, 260), 800), "standard": (4, (250, 380), 1100), "detailed": (5, (350, 480), 1400)}
TONES = {
    "professional": "plain and professional",
    "warm": "warm and personable, while staying professional",
    "direct": "direct and concise: short sentences that lead with evidence",
    "formal": "formal and measured",
}
STYLE_FLAGS = (set(LENGTHS) | set(TONES)) - {"standard", "professional"}
_WHY = "Why this role at this employer: name both, and show you read the listing."
_RECENT = ("The most relevant current or recent experience from the CV, tied to the listing's main requirements, with "
           "concrete systems, tools and responsibilities from the CV.")
_FURTHER = ("Further evidence: other roles, projects or qualifications from the CV that fit. If a requirement is missing "
            "from the CV, focus on transferable experience instead of claiming it.")
_CLOSE = "A short, confident close inviting a conversation."
PLANS = {
    3: [_WHY, "The strongest evidence from the CV for the listing's main requirements, with concrete systems, tools and "
              "responsibilities from the CV.", _CLOSE],
    4: [_WHY, _RECENT, _FURTHER, _CLOSE],
    5: [_WHY, _RECENT, _FURTHER, "How that experience would help with the role's main responsibilities in the listing, "
                                 "staying within what the CV shows.", _CLOSE],
}
# Hard problems fail the letter if a rewrite can't fix them; the rest are asked for but a letter can go without.
MIN_WORDS = 150
HARD = ("too short", "placeholder", "job titles", "figures")
SYSTEM_PROMPT = (
    "You write concise, specific cover letters in UK English for a job candidate. You only use facts that "
    "appear in the candidate's CV: never invent employers, job titles, dates, numbers, qualifications, "
    "certifications or achievements, and never claim a skill the CV does not show. Output JSON only."
)

PREP_QUESTIONS = 8
STAR = ("situation", "task", "action", "result")
PREP_SCHEMA = {
    "type": "object",
    "properties": {
        "company": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
        "questions": {"type": "array", "minItems": PREP_QUESTIONS, "maxItems": PREP_QUESTIONS, "items": {
            "type": "object", "properties": {"question": {"type": "string"}, "why": {"type": "string"}},
            "required": ["question", "why"]}},
        "answers": {"type": "array", "maxItems": 4, "items": {
            "type": "object", "properties": {k: {"type": "string"} for k in ("question", *STAR)},
            "required": ["question", *STAR]}},
        "ask": {"type": "array", "items": {"type": "string"}, "minItems": 3, "maxItems": 6},
    },
    "required": ["company", "questions", "answers", "ask"],
}
PREP_SYSTEM = (
    "You help a job candidate prepare for an interview, in UK English. You only use the facts you are given: facts "
    "about the employer only from the advert, and answers only from the evidence quoted from the candidate's CV. "
    "Never invent employers, job titles, dates, numbers, results or achievements. Output JSON only."
)
PREP_CHECK = "Check before use: HermitShell could not confirm every line against your CV and the advert."


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

def letter_style(flags) -> tuple[str, str]:
    """The (length, tone) a request asked for; unknown flags are ignored."""
    flags = set(flags or ())
    return (next((k for k in LENGTHS if k in flags), "standard"), next((k for k in TONES if k in flags), "professional"))


def job_facts(job: dict) -> str:
    return "\n".join(f"{label}: {value}" for label, value in (
        ("Job title", job_title(job)), ("Employer", employer(job)),
        ("Advertised by", job.get("company") if job.get("employer") and job.get("company") != job.get("employer")
         else ""),
        ("Location", job.get("location")), ("Type", job.get("employment_type")), ("Salary", job.get("salary")),
        ("About the employer", job.get("about") or job.get("company_profile")),
        ("CV skills the listing asks for", ", ".join(job.get("matched") or [])),
        ("Requirements the CV does not show", ", ".join(job.get("gaps") or [])),
        ("Why it was rated a fit", job.get("reasoning")),
    ) if value)


def letter_prompt(job: dict, profile: str, listing: str, note: str, length: str = "standard",
                  tone: str = "professional", found: list[dict] | None = None) -> str:
    count, (low, high), _ = LENGTHS[length]
    plan = "\n".join(f"{n}. {step}" for n, step in enumerate(PLANS[count], 1))
    listing = listing[:LISTING_WITH_MAP] if found else listing
    return (
        f"CANDIDATE CV:\n{compact_profile(profile)}\n\nJOB:\n{job_facts(job)}\n\n"
        + (f"EVIDENCE MAP (the listing's main requirements and where the CV shows them):\n{evidence.as_text(found)}\n\n"
           if found else "")
        + f"LISTING TEXT:\n{listing or '(not available: rely on the job details above)'}\n\n"
        + (f"CANDIDATE'S NOTE FOR THIS LETTER (follow it if it is consistent with the CV):\n{note}\n\n" if note else "")
        + f"Write the body of a cover letter for this job as {count} paragraphs, {low} to {high} words in total:\n"
          f"{plan}\n"
        + ("Build the evidence on the map: cover the requirements it shows, most important first, and never claim "
           "one it marks as not shown.\n" if found else "")
        + f"Tone: {TONES[tone]}.\n"
          "Rules: first person; no salutation, no sign-off and no name (they are added "
          "separately); no placeholders or brackets; no em dashes; avoid cliches such as 'I am excited' or "
          "'passionate'; do not mention salary, and do not say the letter was written by AI.\n"
          "Accuracy: use job titles exactly as the CV writes them; only tie a skill or tool to an employer "
          "when the CV lists it in that role's own description (core competencies are general skills, and "
          "personal projects are described as projects, never as work at an employer); never add outcomes, "
          "reviews, approvals, awards, metrics or team sizes the CV does not state.\n"
          'Return {"paragraphs": [' + ", ".join(['"..."'] * count) + ']}.'
    )


def rewrite_prompt(paragraphs: list[str], problems: list[str], facts: str, length: str, tone: str) -> str:
    """A short follow-up that sends only the draft, what is wrong with it and the facts it may use."""
    count, (low, high), _ = LENGTHS[length]
    return (f"FACTS FROM THE CANDIDATE'S CV (the only facts you may use):\n{facts}\n\n"
            f"DRAFT COVER LETTER:\n{json.dumps({'paragraphs': paragraphs}, ensure_ascii=False)}\n\n"
            "Revise the draft to fix these problems, keeping what is already right:\n"
            + "\n".join(f"- {p}" for p in problems)
            + f"\nKeep {count} paragraphs and {low} to {high} words in total, tone {TONES[tone]}; first person; no "
              "salutation, sign-off, name, placeholders or em dashes; job titles exactly as the CV writes them.\n"
              'Return {"paragraphs": [...]}.')


def _paragraphs(reply: str) -> list[str]:
    got = json.loads(reply).get("paragraphs", [])
    return [" ".join(str(p).split()) for p in (got if isinstance(got, list) else []) if str(p).strip()]


def _problems(paragraphs: list[str], profile: str, source: str, needs: list[str], length: str) -> tuple[list, list]:
    """(hard, soft) problems, each an instruction a rewrite can follow."""
    count, words, _ = LENGTHS[length]
    found = letter_problems(paragraphs, profile, source, needs, words=words, paragraph_range=(count, count))
    total = sum(len(p.split()) for p in paragraphs)
    short = len(paragraphs) < 3 or total < MIN_WORDS
    hard = [p for p in found if any(h in p for h in HARD) and (short or "too short" not in p)]
    if short and not any("too short" in p for p in hard):
        hard.insert(0, f"it is too short at {total} words in {len(paragraphs)} paragraphs: write {count} paragraphs "
                       f"of at least {words[0]} words in total")
    return hard, [p for p in found if p not in hard]


def write_letter(host: str, model: str, num_ctx: int | None, job: dict, profile: str, listing: str,
                 note: str = "", tries: int = 3, length: str = "standard", tone: str = "professional",
                 found: list[dict] | None = None) -> list[str]:
    """The letter's paragraphs. A draft with problems is sent back with exactly what failed: once for soft problems
    (stock phrases, requirements missed, off the length asked for), up to `tries - 1` times for hard ones (too
    short, placeholders, job titles or figures the CV doesn't have). A letter that keeps a hard problem is refused."""
    length, tone = (length if length in LENGTHS else "standard"), (tone if tone in TONES else "professional")
    budget = LENGTHS[length][2]
    source, needs = f"{job_facts(job)}\n{listing}", evidence.shown(found or [])
    facts = evidence.as_text(found) if found else compact_profile(profile)
    prompt, best = letter_prompt(job, profile, listing, note, length, tone, found), None
    for attempt in range(1, tries + 1):
        reply = ollama_chat(host, model, SYSTEM_PROMPT, prompt, num_ctx, fmt=LETTER_SCHEMA, num_predict=budget,
                            task="letter")
        paragraphs = _paragraphs(reply)
        hard, soft = _problems(paragraphs, profile, source, needs, length)
        if not hard and (best is None or len(soft) < best[1]):
            best = (paragraphs, len(soft))
        if not hard and (not soft or attempt > 1):
            return best[0]
        if attempt < tries:
            log(f"Rewriting the letter: {'; '.join(hard + soft)[:240]}")
            titles = any("job titles" in p for p in hard)
            prompt = rewrite_prompt(paragraphs, hard + soft, compact_profile(profile) if titles else facts, length, tone)
    if best:
        return best[0]
    raise ValueError("; ".join(hard))


def prep_prompt(job: dict, listing: str, found: list[dict], note: str = "") -> str:
    about = job.get("about") or job.get("company_profile") or '(none: return "company" as [])'
    shown = evidence.as_text(found) if found else '(none: return "answers" as [])'
    return (
        f"JOB:\n{job_facts(job)}\n\nABOUT THE EMPLOYER, FROM THE ADVERT:\n{about}\n\n"
        f"EVIDENCE FROM THE CANDIDATE'S CV (the job's main requirements and where the CV shows them):\n{shown}\n\n"
        f"LISTING TEXT:\n{listing[:LISTING_WITH_MAP] or '(not available: rely on the job details above)'}\n\n"
        + (f"CANDIDATE'S NOTE (follow it if it is consistent with the evidence):\n{note}\n\n" if note else "")
        + "Write an interview prep pack:\n"
          "- company: up to 5 short facts about the employer, only from the advert text above;\n"
          f"- questions: the {PREP_QUESTIONS} questions this interviewer is most likely to ask, each with one "
          "sentence on why they would ask it;\n"
          "- answers: up to 4 of those questions answered in first person in STAR form (situation, task, action, "
          "result), each built only from the evidence above; where the evidence states no result, say what the work "
          "delivered without numbers;\n"
          "- ask: 3 to 6 questions the candidate could ask the employer about the role and team.\n"
          "Rules: no placeholders or brackets; no figures the evidence or advert does not state; no em dashes; avoid "
          "cliches such as 'passionate' or 'team player'.\n"
          'Return {"company": [...], "questions": [{"question": "...", "why": "..."}], "answers": [{"question": '
          '"...", "situation": "...", "task": "...", "action": "...", "result": "..."}], "ask": [...]}.'
    )


def _line(value, most: int) -> str:
    return " ".join(str(value or "").split())[:most]


def clean_prep(data) -> dict:
    """The pack the model returned, trimmed to the schema's shape and sizes; anything else is dropped."""
    data = data if isinstance(data, dict) else {}

    def items(name: str, most: int, size: int) -> list[str]:
        got = data.get(name)
        return [t for t in (_line(x, size) for x in (got if isinstance(got, list) else [])) if t][:most]

    def rows(name: str, fields: tuple[str, ...], most: int) -> list[dict]:
        got = data.get(name)
        return [{f: _line(r.get(f), 400) for f in fields} for r in (got if isinstance(got, list) else [])
                if isinstance(r, dict) and _line(r.get("question"), 400)][:most]

    return {"company": items("company", 5, 300), "questions": rows("questions", ("question", "why"), PREP_QUESTIONS),
            "answers": rows("answers", ("question", *STAR), 4), "ask": items("ask", 6, 200)}


def prep_lines(prep: dict) -> list[str]:
    return [*prep["company"], *(v for q in prep["questions"] for v in q.values()),
            *(v for a in prep["answers"] for v in a.values()), *prep["ask"]]


def prep_problems(prep: dict, source: str) -> list[str]:
    """What is wrong with a pack, each as an instruction a rewrite can follow; [] when it passes. `source` is
    everything it may take facts from: the job's details, the advert, the evidence and the candidate's note."""
    text = "\n".join(prep_lines(prep))
    problems = []
    if len(prep["questions"]) < PREP_QUESTIONS:
        problems.append(f"write {PREP_QUESTIONS} likely questions (it has {len(prep['questions'])})")
    if not writing_checks.honest(text, source):
        if found := writing_checks.placeholders(text):
            problems.append(f"remove the placeholders {', '.join(found[:4])}")
        if found := writing_checks.invented_figures(text, source):
            problems.append(f"remove figures the CV and advert do not state: {', '.join(found[:5])}")
    if found := writing_checks.cliches(text):
        problems.append(f"replace the stock phrases {', '.join(repr(c) for c in found[:4])} with specifics")
    return problems


def write_prep(host: str, model: str, num_ctx: int | None, job: dict, listing: str, found: list[dict],
               note: str = "") -> tuple[dict, list[str]]:
    """The pack, and what still fails the checks after one rewrite ([] when it passes). With no evidence map it has
    no answers, so none can be made up."""
    source = "\n".join((job_facts(job), listing, evidence.as_text(found) if found else "", note))
    prompt = prep_prompt(job, listing, found, note)
    for attempt in (1, 2):
        prep = clean_prep(json.loads(ollama_chat(host, model, PREP_SYSTEM, prompt, num_ctx, fmt=PREP_SCHEMA,
                                                 num_predict=2400, task=INTERVIEW_PREP)))
        if not found:
            prep["answers"] = []
        problems = prep_problems(prep, source)
        if not problems:
            return prep, []
        if attempt == 1:
            log(f"Rewriting the interview prep: {'; '.join(problems)[:240]}")
            prompt = (f"{prep_prompt(job, listing, found, note)}\n\nYOUR DRAFT:\n{json.dumps(prep, ensure_ascii=False)}\n\n"
                      "Revise the draft to fix these problems, keeping what is already right:\n"
                      + "\n".join(f"- {p}" for p in problems))
    if not prep["questions"]:
        raise ValueError("the model wrote no interview questions")
    return prep, problems


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "job"


def _letter_parts(job: dict, name: str, paragraphs: list[str], when: datetime) -> tuple[tuple, dict]:
    recipient = [line for line in ("Hiring Manager", employer(job), job.get("location", "")) if line]
    return ((name, env("COVER_LETTER_CONTACT", "") or "", f"{when.day} {when:%B %Y}", recipient,
             f"Application for {job_title(job)}", "Dear Hiring Manager,",
             paragraphs, env("COVER_LETTER_SIGN_OFF", "Kind regards,") or "Kind regards,"),
            {"title": f"Cover letter: {job_title(job)}" + (f" - {name}" if name else "")})


def build_pdf(job: dict, name: str, paragraphs: list[str], when: datetime) -> bytes:
    args, kwargs = _letter_parts(job, name, paragraphs, when)
    return letter_pdf(*args, **kwargs)


def build_docx(job: dict, name: str, paragraphs: list[str], when: datetime) -> bytes:
    args, kwargs = _letter_parts(job, name, paragraphs, when)
    return letter_docx(*args, **kwargs)


def word_copies() -> bool:
    """Whether each letter, tailored CV and prep pack gets a Word copy beside its PDF (DOC_WORD_COPIES)."""
    return hc.env_bool("DOC_WORD_COPIES", False)


def word_name(filename: str) -> str:
    return re.sub(r"\.pdf$", "", filename, flags=re.IGNORECASE) + ".docx"


def word_copy(path: Path) -> bytes | None:
    """The Word copy saved beside a PDF, when Word copies are on and it is there."""
    docx = path.with_suffix(".docx")
    return hc.read_private(docx) if word_copies() and docx.is_file() else None


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
    "interview_prep": ("Interview prep ready", "Your prep pack for this interview is attached as <b>{file}</b>: likely "
                       "questions, answers drawn from your CV, and questions to ask them.", "Likely questions",
                       "Built only from your CV and the advert, with no web lookups. Check it before the interview."),
}


def email_bodies(job: dict, paragraphs: list[str], filename: str, note: str,
                 kind: str = "cover_letter", word: str = "") -> tuple[str, str, str]:
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
    word_block = f" A Word copy to edit, <b>{esc(word)}</b>, is attached too." if word else ""
    view = (f'<a href="{esc(job["url"])}" style="display:inline-block;background:{C_ACCENT};color:#ffffff;'
            f'border-radius:10px;padding:10px 18px;font-size:14px;font-weight:600;text-decoration:none">'
            f'{white_label("View job")}</a>') if job.get("url") else ""
    body = f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">{EMAIL_HEAD}<title>{esc(subject)}</title></head>
<body class="body" style="margin:0;padding:0;background:{C_BG};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_BG}"><tr><td align="center" class="m-wrap" style="padding:24px 12px">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%">
<tr><td style="background:#1e1b4b;border-radius:20px;padding:26px 28px">
  <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c4b5fd;font-weight:700">{eyebrow}</div>
  <div style="font-size:24px;font-weight:800;color:#ffffff;margin:6px 0 4px">{esc(title)}</div>
  <div style="font-size:15px;color:#e0e7ff">{esc(company)}</div>
</td></tr>
<tr><td style="padding-top:18px">
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_CARD};border:1px solid #e2e8f0;border-radius:16px">
<tr><td class="m-pad" style="padding:22px 24px">
  <div style="font-size:14px;color:#334155;line-height:1.5">{intro.format(file=esc(filename))}{word_block}</div>{note_block}
  <table cellpadding="0" cellspacing="0" style="margin:16px 0">{table}</table>
  {view}
</td></tr></table>
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_CARD};border:1px solid #e2e8f0;border-radius:16px;margin-top:18px">
<tr><td class="m-pad" style="padding:22px 24px">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:{C_ACCENT};font-weight:700;margin-bottom:10px">{preview_label}</div>
  {preview}
</td></tr></table>
<div style="font-size:11px;color:{C_MUTED};line-height:18px;padding:14px 6px;text-align:center">
  {footer}</div>
</td></tr></table></td></tr></table></body></html>"""
    text = "\n".join([f"{subject}", "", f"Attached: {filename}" + (f" and {word}" if word else ""),
                      *(f"{k}: {v}" for k, v in rows),
                      f"Job: {job.get('url', '')}", "", *[f"{p}\n" for p in paragraphs]])
    return subject, body, text


# --------------------------------------------------------------------------- run

def file_name(text: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "", text)[:120] + ".pdf"


def save_doc(folder: Path, job: dict, pdf: bytes, filename: str, preview: list[str], docx: bytes | None = None) -> Path:
    """The PDF, its Word copy if there is one, and beside them the name and preview its email uses, so it can be
    sent again without the model."""
    when = datetime.now(ZoneInfo(env("HERMES_TIMEZONE", "UTC") or "UTC"))
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{when:%Y-%m-%d}-{slug(employer(job))}-{slug(job_title(job))}.pdf"
    hc.write_private(path, pdf)
    if docx:
        hc.write_private(path.with_suffix(".docx"), docx)
    else:
        path.with_suffix(".docx").unlink(missing_ok=True)
    hc.write_private(path.with_suffix(".json"), json.dumps({"filename": filename, "preview": preview}).encode())
    return path


def email_doc(kind: str, job: dict, pdf: bytes, filename: str, preview: list[str], note: str,
              docx: bytes | None = None) -> None:
    word = word_name(filename) if docx else ""
    subject, body, text = email_bodies(job, preview, filename, note, kind=kind, word=word)
    hc.send_email(subject, body, text, env("COVER_LETTER_FROM_NAME", "HermitShell cover letters") or "HermitShell",
                  attachments=[(filename, pdf, "application/pdf"), *([(word, docx, DOCX_MIME)] if docx else [])])


def make_letter(tracker: Tracker, key: str, note: str, model_info: tuple[str, str, int | None],
                dry_run: bool, send: bool = True, flags=()) -> Path:
    job = tracker.job(key)
    if not job:
        raise LookupError(f"job {key} is not in the tracker")
    profile = profile_text(tracker)
    if not profile:
        raise FileNotFoundError("no CV profile found (JOB_PROFILE_FILE / job_profile.md)")
    name = candidate_name(profile)
    listing = listing_text(job)
    length, tone = letter_style(flags)
    found = evidence.for_job(model_info, key, job, profile, listing)
    paragraphs = write_letter(*model_info, job, profile, listing, note, length=length, tone=tone, found=found)
    when = datetime.now(ZoneInfo(env("HERMES_TIMEZONE", "UTC") or "UTC"))
    pdf = build_pdf(job, name, paragraphs, when)
    docx = build_docx(job, name, paragraphs, when) if word_copies() else None
    filename = file_name(f"Cover letter - {name or 'Candidate'} - {job_title(job)}")
    path = save_doc(LETTER_DIR, job, pdf, filename, paragraphs, docx)
    if send and not dry_run:
        email_doc("cover_letter", job, pdf, filename, paragraphs, note, docx)
    return path


def make_cv(tracker: Tracker, key: str, note: str, model_info: tuple[str, str, int | None],
            dry_run: bool, send: bool = True, flags=()) -> Path:
    job = tracker.job(key)
    if not job:
        raise LookupError(f"job {key} is not in the tracker")
    master = tailored_cv.master_cv(lambda: model_info, tracker)
    name = candidate_name(profile_text(tracker)) or "Candidate"
    master |= {"name": name, "contact": env("COVER_LETTER_CONTACT", "") or ""}
    listing, profile = listing_text(job), profile_text(tracker)
    found = evidence.for_job(model_info, key, job, profile, listing) if profile else []
    cv = tailored_cv.tailored_cv(master, job, listing, note, model_info, found=found)
    pdf = cv_pdf(cv, title=f"CV - {name} - {job_title(job)}")
    docx = cv_docx(cv, title=f"CV - {name} - {job_title(job)}") if word_copies() else None
    filename = file_name(f"CV - {name} - {job_title(job)}")
    preview = [p for p in (cv["headline"], cv["summary"], "Skills: " + ", ".join(cv["skills"]),
                           *tailored_cv.report_lines(cv.get("match")), *tailored_cv.source_lines(cv)) if p]
    path = save_doc(CV_DIR, job, pdf, filename, preview, docx)
    if send and not dry_run:
        email_doc("tailored_cv", job, pdf, filename, preview, note, docx)
    return path


def make_prep(tracker: Tracker, key: str, note: str, model_info: tuple[str, str, int | None],
              dry_run: bool, send: bool = True, flags=()) -> Path:
    job = tracker.job(key)
    if not job:
        raise LookupError(f"job {key} is not in the tracker")
    profile = profile_text(tracker)
    if not profile:
        raise FileNotFoundError("no CV profile found (JOB_PROFILE_FILE / job_profile.md)")
    name = candidate_name(profile)
    listing = listing_text(job)
    found = evidence.for_job(model_info, key, job, profile, listing)
    prep, problems = write_prep(*model_info, job, listing, found, note)
    warning = PREP_CHECK if problems else ""
    if problems:
        log(f"Interview prep sent with a check line: {'; '.join(problems)[:240]}")
    title = f"Interview prep: {job_title(job)}" + (f" - {name}" if name else "")
    pdf = prep_pdf(name, job_title(job), employer(job), prep, warning, title=title)
    docx = prep_docx(name, job_title(job), employer(job), prep, warning, title=title) if word_copies() else None
    filename = file_name(f"Interview prep - {name or 'Candidate'} - {job_title(job)}")
    preview = [*([warning] if warning else []), *(q["question"] for q in prep["questions"])]
    path = save_doc(PREP_DIR, job, pdf, filename, preview, docx)
    if send and not dry_run:
        email_doc(INTERVIEW_PREP, job, pdf, filename, preview, note, docx)
    return path


def profile_cv_name(tracker: Tracker) -> str:
    return file_name(f"CV - {candidate_name(profile_text(tracker)) or 'Candidate'}")


def make_profile_cv(tracker: Tracker, key: str, note: str, model_info: tuple[str, str, int | None],
                    dry_run: bool, send: bool = True, flags=()) -> Path:
    """The profile's own CV: every role, bullet, project and qualification in the structured copy, as written."""
    master = tailored_cv.master_cv(lambda: model_info, tracker)
    name = candidate_name(profile_text(tracker)) or "Candidate"
    cv = {k: v for k, v in master.items() if k != "source_text"} | {"name": name, "contact": env("COVER_LETTER_CONTACT", "") or ""}
    hc.write_private(PROFILE_CV_FILE, cv_pdf(cv, title=f"CV - {name}"))
    return PROFILE_CV_FILE


MAKERS = {"cover_letter": make_letter, "tailored_cv": make_cv, PROFILE_CV: make_profile_cv, INTERVIEW_PREP: make_prep}


# --------------------------------------------------------------------------- made before, kept for download

def keep_days() -> int:
    """How long a finished letter or CV is reused and kept on the Worker for download; 0 turns both off."""
    return max(0, min(env_int("COVER_LETTER_KEEP_DAYS", 7), MAX_KEEP_DAYS))


def doc_dir(kind: str) -> Path:
    return {"cover_letter": LETTER_DIR, INTERVIEW_PREP: PREP_DIR}.get(kind, CV_DIR)


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


def doc_bundle(pdf: bytes, docx: bytes) -> bytes:
    """A PDF and its Word copy as one upload: BUNDLE_MAGIC, the PDF's length (4 bytes, big-endian), the PDF, the
    Word copy. The Worker keeps it as one sealed value."""
    return BUNDLE_MAGIC + len(pdf).to_bytes(4, "big") + pdf + docx


def upload_doc(kind: str, key: str, path: Path, filename: str, days: int | None = None) -> str:
    """Send a finished PDF, with its Word copy when there is one and the Worker takes it, to the Worker to keep for
    download for `days` (default keep_days()); returns a problem to log, or ""."""
    base, token = secure_base(env("JOB_FEEDBACK_URL", "") or ""), env("JOB_FEEDBACK_API_TOKEN", "")
    if not (keep_days() and base and token):
        return ""
    days = min(days or keep_days(), keep_days())
    params = {"u": env("JOB_PROFILE_ID", "") or profiles.OWNER, "j": key, "k": kind, "days": str(days), "name": filename}
    try:
        pdf = hc.read_private(path)
        docx = word_copy(path) if worker_link.word_ready() else None
        worker_link.Link(base, token).request("POST", "/api/doc", params=params,
                                              data=doc_bundle(pdf, docx) if docx else pdf,
                                              content_type="application/octet-stream" if docx else "application/pdf")
    except (requests.RequestException, OSError, RuntimeError) as exc:
        return f"could not keep {path.name} on the Worker for download: {worker_link.reason(exc)}"
    return ""


def upload_profile_cv(path: Path, filename: str) -> str:
    """Send the profile's own CV to the Worker, replacing the one it keeps; returns a problem to log, or ""."""
    base, token = secure_base(env("JOB_FEEDBACK_URL", "") or ""), env("JOB_FEEDBACK_API_TOKEN", "")
    if not (base and token):
        return ""
    params = {"u": env("JOB_PROFILE_ID", "") or profiles.OWNER, "name": filename}
    try:
        worker_link.Link(base, token).request("POST", "/api/cv", params=params, data=hc.read_private(path),
                                              content_type="application/pdf")
    except (requests.RequestException, OSError, RuntimeError) as exc:
        return f"could not keep the CV on the Worker for download: {worker_link.reason(exc)}"
    return ""


def record_emailed(key: str) -> str:
    """Tell the Worker a job was emailed, for its "Emailed" mark on the dashboard; returns a problem to log, or ""."""
    base, token = secure_base(env("JOB_FEEDBACK_URL", "") or ""), env("JOB_FEEDBACK_API_TOKEN", "")
    if not (base and token):
        return ""
    params = {"u": env("JOB_PROFILE_ID", "") or profiles.OWNER, "j": key}
    try:
        worker_link.Link(base, token).request("POST", "/api/emailed", params=params)
    except requests.RequestException as exc:
        return f"could not mark the job as emailed on the Worker: {worker_link.reason(exc)}"
    return ""


def send_again(tracker: Tracker, kind: str, key: str, path: Path, note: str, send: bool, dry_run: bool) -> None:
    """Email a letter or CV made before, as it was, instead of writing a new one."""
    job = tracker.job(key)
    if not job:
        raise LookupError(f"job {key} is not in the tracker")
    if send and not dry_run:
        filename, preview = doc_info(path, kind, job)
        email_doc(kind, job, hc.read_private(path), filename, preview, note, word_copy(path))


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
        # These lines go to the plain-text log, so they name the role but not the employer or the file.
        label = "the profile" if kind == PROFILE_CV else job_title(job) if job else req["key"]
        if tracker.letter_cancelled(req["event_id"]):
            lines.append(f"{what} for {label} was cancelled from the dashboard")
            continue
        flags, note = set((req.get("flags") or "").split(",")), req.get("reason") or ""
        send = "quiet" not in flags
        profiles.write_json(WRITING_FILE, {"event_id": req["event_id"], "pid": os.getpid(), "at": time.time()})
        profiles.tasks_changed()
        path = earlier = None
        try:
            if kind not in (SEND_JOB, PROFILE_CV) and not note and "fresh" not in flags and not flags & STYLE_FLAGS:
                earlier = recent_doc(tracker, kind, req["key"])
            if kind == SEND_JOB:
                job_mail.send_job(tracker, req["key"], dry_run)
            elif earlier:
                path = earlier[0]
                send_again(tracker, kind, req["key"], path, note, send, dry_run)
            else:
                model = model or [model_info_factory()]
                path = MAKERS[kind](tracker, req["key"], note, model[0], dry_run, send=send, flags=flags)
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
        if kind == PROFILE_CV:
            problem = "" if dry_run else upload_profile_cv(path, profile_cv_name(tracker))
            if problem:
                status = tracker.mark_letter(req["event_id"], req["key"], "error", problem)
                lines.append(f"{what} {'failed' if status == 'failed' else 'will retry'} for {label}: {problem}")
                continue
            if not dry_run:
                tracker.mark_letter(req["event_id"], req["key"], "sent", file=path.name)
            lines.append(f"{what} {'saved' if dry_run else 'made for download'} for {label}")
            continue
        if not dry_run:
            tracker.mark_letter(req["event_id"], req["key"], "sent", file=path.name)
            days = days_left(earlier[1]) if earlier else None
            if problem := upload_doc(kind, req["key"], path, doc_info(path, kind, job)[0], days):
                log(problem)
        done = "saved" if dry_run else "sent" if send else "made for download"
        lines.append(f"{what} {done} for {label}" + (" (the one made earlier)" if earlier else ""))
    profiles.tasks_changed()
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--job", help="tracker key of a job to write a letter for now")
    parser.add_argument("--note", default="", help="extra guidance for the letter (with --job)")
    parser.add_argument("--cv", action="store_true", help="tailor the CV instead of writing a letter (with --job)")
    parser.add_argument("--prep", action="store_true", help="make an interview prep pack instead (with --job)")
    parser.add_argument("--length", choices=list(LENGTHS), default="standard", help="letter length (with --job)")
    parser.add_argument("--tone", choices=list(TONES), default="professional", help="letter tone (with --job)")
    parser.add_argument("--dry-run", action="store_true", help="save the PDF but send no email")
    args = parser.parse_args(argv)
    load_env_file()
    hc.set_model_priority(waiting=True)
    if not args.job:
        profiles.spawn_others("cover_letter.py", ["--dry-run"] if args.dry_run else [])
        if not args.dry_run and profiles.staff_run("cover_letter.py"):
            return 0

    def model_info():
        return connect_model("COVER_LETTER_MODEL" if env("COVER_LETTER_MODEL") else "JOB_SCANNER_MODEL")

    tracker = Tracker(TRACKER_FILE)
    try:
        if args.job:
            kind = "tailored_cv" if args.cv else INTERVIEW_PREP if args.prep else "cover_letter"
            path = MAKERS[kind](tracker, args.job, args.note, model_info(), args.dry_run, flags={args.length, args.tone})
            print(f"{KIND_LABELS[kind]} {'saved' if args.dry_run else 'sent'}: {path}")
            return 0
        with hc.run_lock(LOCK_FILE) as held:  # overlapping cron runs must not send the same letter twice
            if not held:
                return 0
            full = not FULL_SYNC_FILE.is_file() or time.time() - FULL_SYNC_FILE.stat().st_mtime > FULL_SYNC_EVERY
            synced, error = sync_feedback(tracker, env("JOB_FEEDBACK_URL", "") or "",
                                          env("JOB_FEEDBACK_API_TOKEN", "") or "", ack=not args.dry_run,
                                          profile=env("JOB_PROFILE_ID", "") or "", full=full)
            if error:
                log(error)
            elif full and not args.dry_run:
                FULL_SYNC_FILE.touch()
            if synced and not args.dry_run:
                profiles.board_changed(env("JOB_PROFILE_ID", "") or "")
            if (not args.dry_run and hc.env_bool("INTERVIEW_PREP_AUTO", False)
                    and (queued := tracker.queue_auto_prep(env("JOB_PROFILE_ID", "") or ""))):
                log(f"Queued {len(queued)} interview prep pack(s) for jobs that reached Interview")
            lines = process_pending(tracker, model_info, args.dry_run)
        if lines:
            print("\n".join(lines))
        return 0
    finally:
        tracker.close()


if __name__ == "__main__":
    sys.exit(main())

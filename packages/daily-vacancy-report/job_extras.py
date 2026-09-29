"""Daily Vacancy Report helpers: salary and closing-date parsing, seniority, title triage,
a second opinion on top picks, and grouping of recruitment-agency adverts.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime

import requests

from hermes_common import log, ollama_chat

# --------------------------------------------------------------------------- salary

DAYS_PER_YEAR = 220
HOURS_PER_YEAR = 1950
_AMOUNT = re.compile(r"(?P<cur>[£€$])?\s?(?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(?P<k>k\b)?", re.I)
_DAY = re.compile(r"per day|/\s?day|a day\b|\bdaily\b|day rate|\bp/?d\b", re.I)
_HOUR = re.compile(r"per hour|/\s?h(ou)?r|an hour\b|\bhourly\b|\bp/?h\b", re.I)


def parse_salary(text: str) -> dict | None:
    """'£45k-£55k', '£40,000 - £55,000 per annum', '£350 per day', 'up to 60,000' -> yearly range.

    Returns {"low", "high", "period", "currency", "year_low", "year_high"} or None when no figure is given.
    """
    if not text:
        return None
    amounts: list[tuple[float, str]] = []
    for m in _AMOUNT.finditer(text):
        value = float(m.group("num").replace(",", "")) * (1000 if m.group("k") else 1)
        if not m.group("cur") and not m.group("k") and value < 10000:
            continue
        amounts.append((value, m.group("cur") or ""))
        if len(amounts) == 2:
            break
    if not amounts:
        return None
    low, high = min(a for a, _ in amounts), max(a for a, _ in amounts)
    period = "day" if _DAY.search(text) else "hour" if _HOUR.search(text) else "year"
    if period == "year" and high < 2000:
        period = "day" if low >= 100 else "hour"
    mult = {"year": 1, "day": DAYS_PER_YEAR, "hour": HOURS_PER_YEAR}[period]
    if high * mult > 1_000_000 or high * mult < 5000:
        return None
    currency = next((c for _, c in amounts if c), "")
    return {"low": low, "high": high, "period": period, "currency": currency,
            "year_low": round(low * mult), "year_high": round(high * mult)}


def below_min_salary(salary: dict | None, minimum: int, currency: str = "") -> bool:
    """True only when the listing's best case is clearly under `minimum` (unknown salaries pass)."""
    if not salary or not minimum:
        return False
    if currency and salary["currency"] and salary["currency"] != currency:
        return False
    return salary["year_high"] < minimum


# --------------------------------------------------------------------------- closing dates

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
_CLOSING = re.compile(
    r"(closing date|closes|close date|closing|apply by|applications? (?:close|deadline)|deadline|"
    r"expir(?:y|es|ing)(?: date)?|end date for applications)\b[^0-9a-z]{0,12}(?:on|is|at)?\s*"
    r"(?P<d>[^\n]{4,40})", re.I)
_DMY = re.compile(r"(?P<d>\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(?P<m>[a-z]{3,9})\.?,?\s+(?P<y>\d{4})", re.I)
_MDY = re.compile(r"(?P<m>[a-z]{3,9})\.?\s+(?P<d>\d{1,2})(?:st|nd|rd|th)?,?\s+(?P<y>\d{4})", re.I)
_NUMERIC = re.compile(r"(?P<a>\d{1,4})[/.-](?P<b>\d{1,2})[/.-](?P<c>\d{2,4})")


def _to_date(text: str) -> date | None:
    for rx in (_DMY, _MDY):
        m = rx.search(text)
        if m and m.group("m")[:3].lower() in MONTHS:
            try:
                return date(int(m.group("y")), MONTHS[m.group("m")[:3].lower()], int(m.group("d")))
            except ValueError:
                pass
    m = _NUMERIC.search(text)
    if m:
        a, b, c = m.group("a"), int(m.group("b")), m.group("c")
        try:
            if len(a) == 4:
                return date(int(a), b, int(c))
            year = int(c) + (2000 if len(c) == 2 else 0)
            return date(year, b, int(a))
        except ValueError:
            return None
    return None


def closing_date(text: str, model_value: str = "") -> date | None:
    """Closing date from 'Closing date: 12 October 2026'-style phrases, else the model's YYYY-MM-DD."""
    for m in _CLOSING.finditer(text or ""):
        found = _to_date(m.group("d"))
        if found:
            return found
    if model_value:
        try:
            return datetime.strptime(model_value.strip()[:10], "%Y-%m-%d").date()
        except ValueError:
            return _to_date(model_value)
    return None


def days_left(closing: date | None, today: date) -> int | None:
    return (closing - today).days if closing else None


# --------------------------------------------------------------------------- seniority

MODEL_LEVELS = {"junior": "junior", "mid": "mid", "senior": "senior", "lead/principal": "lead"}


def combined_level(title_level: str | None, model_seniority: str) -> tuple[str | None, bool]:
    """Title wins; otherwise the model's reading of the listing. Returns (level, came_from_model)."""
    if title_level:
        return title_level, False
    level = MODEL_LEVELS.get((model_seniority or "").strip().lower())
    return level, bool(level)


# --------------------------------------------------------------------------- model helpers

TRIAGE_SCHEMA = {
    "type": "object",
    "properties": {"verdicts": {"type": "array", "items": {
        "type": "object",
        "properties": {"i": {"type": "integer"}, "v": {"type": "string", "enum": ["yes", "maybe", "no"]}},
        "required": ["i", "v"]}}},
    "required": ["verdicts"],
}


def triage_titles(host: str, model: str, num_ctx: int | None, profile: str, titles: list[str],
                  batch: int = 30) -> list[str]:
    """One quick model call per `batch` titles: 'yes', 'maybe' or 'no' for each. Failures count as 'maybe'."""
    verdicts = ["maybe"] * len(titles)
    for start in range(0, len(titles), batch):
        chunk = titles[start:start + batch]
        listing = "\n".join(f"{i}. {t}" for i, t in enumerate(chunk))
        user = (f"CANDIDATE CV SUMMARY:\n{profile[:1500]}\n\nJOB TITLES:\n{listing}\n\n"
                "For each numbered title, answer 'yes' if the role is clearly in the candidate's field, 'maybe' "
                "if it could be (adjacent or vague title), 'no' if it is clearly a different discipline. "
                "Return every index exactly once.")
        try:
            data = json.loads(ollama_chat(host, model, "You screen job titles for a candidate. JSON only.", user,
                                          num_ctx, TRIAGE_SCHEMA, num_predict=80 + 20 * len(chunk)))
            for item in data.get("verdicts", []):
                i = int(item.get("i", -1))
                if 0 <= i < len(chunk) and item.get("v") in ("yes", "maybe", "no"):
                    verdicts[start + i] = item["v"]
        except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
            log(f"title triage failed ({exc.__class__.__name__}); treating {len(chunk)} titles as maybe")
    return verdicts


VERIFY_SCHEMA = {
    "type": "object",
    "properties": {"fit_score": {"type": "integer", "minimum": 0, "maximum": 10},
                   "reason": {"type": "string", "maxLength": 200}},
    "required": ["fit_score", "reason"],
}


def second_opinion(host: str, model: str, num_ctx: int | None, profile: str, title: str, text: str,
                   first_score: int, first_reason: str) -> int | None:
    """A sceptical re-check of a high score; returns the second fit score or None on failure."""
    user = (f"CANDIDATE CV SUMMARY:\n{profile}\n\nJOB: {title}\n{text[:4000]}\n\n"
            f"A first reviewer scored this job {first_score}/10 for the candidate: \"{first_reason}\"\n"
            "Check that score critically. List to yourself the must-have requirements, then decide whether the "
            "candidate would realistically be shortlisted. Scores of 8+ need most must-haves on the CV and a "
            "matching seniority. Return your own fit_score (0-10) and a one-sentence reason.")
    try:
        data = json.loads(ollama_chat(host, model, "You are a sceptical hiring manager. JSON only.", user,
                                      num_ctx, VERIFY_SCHEMA, num_predict=200))
        return max(0, min(10, int(data["fit_score"])))
    except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
        log(f"second opinion failed for {title[:50]}: {exc.__class__.__name__}")
        return None


# --------------------------------------------------------------------------- seen-state rules

def repost_key(title: str, company: str) -> str | None:
    """Key for the same role at the same company, so a repost on another board or day is skipped."""
    t, c = _norm(title), _norm(company)
    return f"tc:{t}|{c}" if t and c else None


def rating_failed(retries: dict[str, int], key: str, max_attempts: int = 4) -> bool:
    """Count a failed rating. True means give up (mark the job seen); False means retry next run."""
    attempts = retries.get(key, 0) + 1
    if attempts >= max_attempts:
        retries.pop(key, None)
        return True
    retries[key] = attempts
    return False


# --------------------------------------------------------------------------- agencies

def _norm(text: str) -> str:
    return re.sub(r"\W+", "", (text or "").lower())


def group_agency_posts(jobs: list[dict], hide_unnamed: bool = False) -> tuple[list[dict], int]:
    """Merge adverts for the same role (agency reposts, or an agency plus the employer's own post).

    Keeps the best-scored advert and lists the other advertisers on it. With `hide_unnamed`,
    agency adverts that do not name their client are dropped. Returns (jobs, number removed).
    """
    kept: dict[tuple, dict] = {}
    removed = 0
    for job in sorted(jobs, key=lambda j: (j["fit"], j["confidence"]), reverse=True):
        employer = job.get("employer") or ("" if job.get("agency") else job.get("company", ""))
        if hide_unnamed and job.get("agency") and not job.get("employer"):
            removed += 1
            continue
        key = (_norm(job["title"]), _norm(employer) if employer else f"agency:{_norm(job.get('location', ''))}")
        if key in kept:
            other = kept[key]
            advertiser = job.get("company")
            if advertiser and advertiser not in other.setdefault("also_advertised_by", []) \
                    and advertiser != other.get("company"):
                other["also_advertised_by"].append(advertiser)
            removed += 1
            continue
        kept[key] = job
    return list(kept.values()), removed

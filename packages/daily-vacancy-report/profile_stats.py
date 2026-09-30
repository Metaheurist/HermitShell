#!/usr/bin/env python3
"""The numbers behind a profile's stats page on the dashboard, read from its tracker (job_tracker.db).

collect() returns one row of counts per day (in HERMES_TIMEZONE) for the last STATS_DAYS days, in the order of
FIELDS, and for each of the dashboard's time ranges the employers, sources, match scores, work modes and best
matches of the jobs sent. `sent` lists the jobs sent in the last SENT_DAYS days, newest first, with the advert's
link, the last button pressed on each and, under "more", the details its email card showed (why it was rated a
fit, the skills matched and missing, the company). profiles.py sends it to the feedback Worker, which draws the
charts and the dashboard's list of jobs sent. Notes typed on the buttons' confirmation pages and the listing text
are not included, and email addresses, phone numbers and the profile's name and email are removed from the rest.

    python3 profile_stats.py [DB]     # print the stats of a tracker (default: the owner's)
"""
from __future__ import annotations

import json
import re
import sqlite3
import statistics
import sys
import time
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import money
from job_extras import parse_salary

VERSION = 1
STATS_DAYS = 400
RANGES = (7, 30, 90, 365)
FIELDS = ("scanned", "rated", "sent", "fit_sum", "fit_n", "strong", "runs", "interested", "good_match", "not_for_me",
          "applied", "heard_back", "rejected", "cover_letter", "tailored_cv", "add_skill")
EVENTS = FIELDS[FIELDS.index("interested"):]
STATUSES = ("interested", "good_match", "not_for_me", "applied", "heard_back", "rejected")
STRONG_FIT = 8
TOP = 5
BEST = 3
MAX_NAME = 60
MAX_TITLE = 90
SENT_DAYS = 90
SENT_MAX = 150
MAX_URL = 500
MAX_KEY = 300
MAX_REASON = 600
MAX_ABOUT = 400
MAX_SKILLS = 12
MAX_GAPS = 6
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")
_URL = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
_EMAIL = re.compile(r"[^\s@<>()\[\],;:\"']+@[^\s@<>()\[\],;:\"']+\.[a-z]{2,}", re.IGNORECASE)
_PHONE = re.compile(r"\+?\d[\d\s().-]{7,}\d")
REMOVED = "[removed]"


def _clean(text, limit: int) -> str:
    return " ".join(_CONTROL.sub(" ", str(text or "")).split())[:limit]


def _found(value) -> int:
    """A run's count for one source: {"found": n, "error": ...} or, in older runs, the number itself."""
    found = value.get("found") if isinstance(value, dict) else value
    return found if isinstance(found, int) and found > 0 else 0


def _url(url) -> str:
    url = str(url or "").strip()
    return url if len(url) <= MAX_URL and _URL.fullmatch(url) else ""


def _empty(today: date) -> dict:
    return {"v": VERSION, "today": today.isoformat(), "since": None, "days": {},
            "ranges": {str(r): _range([], []) for r in RANGES}, "pipeline": {s: 0 for s in STATUSES}, "sent": []}


def _range(sent: list[dict], rated: list[dict]) -> dict:
    fit = [0] * 11
    for job in rated:
        if isinstance(job["fit"], int) and 0 <= job["fit"] <= 10:
            fit[job["fit"]] += 1
    salaries = [j["year_low"] for j in sent if isinstance(j["year_low"], (int, float)) and j["year_low"] > 0]
    best = sorted((j for j in sent if isinstance(j["fit"], int)), key=lambda j: (-j["fit"], -j["first_seen"]))[:BEST]
    return {
        "employers": Counter(j["employer"] for j in sent if j["employer"]).most_common(TOP),
        "sources": Counter(j["source"] for j in sent if j["source"]).most_common(TOP),
        "modes": Counter(j["mode"] for j in sent if j["mode"]).most_common(4),
        "fit": fit,
        "salary": int(statistics.median(salaries)) if salaries else None,
        "best": [{"title": j["title"], "employer": j["employer"], "fit": j["fit"], "day": j["day"]} for j in best],
    }


def _detail(details: str | None, name: str, limit: int) -> str:
    try:
        value = json.loads(details or "{}").get(name, "")
    except (ValueError, AttributeError):
        return ""
    value = _clean(value if isinstance(value, str) else "", limit)
    return "" if value.lower() in ("", "unknown", "not stated") else value


def _year_low(r: sqlite3.Row, currency: str, rates: dict[str, float]) -> float | None:
    """The job's lowest yearly salary in `currency`; None when unknown or its currency has no rate. Rows from
    before salary_code was kept are in the currency their salary text shows, else the profile's."""
    value = r["year_low"]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return None
    if not currency:
        return value
    code = money.currency_code(_detail(r["details"], "salary_code", 3))
    if not code:
        parsed = parse_salary(r["salary"] or "")
        code = money.advert_code(parsed["currency"] if parsed else "", currency)
    return money.convert(value, code, currency, rates)


def _mode(details: str | None) -> str:
    return _detail(details, "work_mode", 20)


def _number(details: str | None, name: str) -> int | None:
    try:
        value = json.loads(details or "{}").get(name)
    except (ValueError, AttributeError):
        return None
    return value if isinstance(value, int) and 0 <= value <= 100 else None


def _skills(packed: str | None, limit: int) -> list[str]:
    try:
        items = json.loads(packed or "[]")
    except ValueError:
        return []
    found = [_clean(s, MAX_NAME) for s in items if isinstance(s, str)] if isinstance(items, list) else []
    return [s for s in dict.fromkeys(found) if s][:limit]


def redact(text: str, private: tuple[str, ...] = ()) -> str:
    """`text` without email addresses, phone numbers (nine digits or more) or any of the `private` words."""
    text = _EMAIL.sub(REMOVED, text)
    text = _PHONE.sub(lambda m: REMOVED if sum(c.isdigit() for c in m.group()) >= 9 else m.group(), text)
    words = {" ".join(str(p or "").split()) for p in private}
    for word in sorted((w for w in words if len(w) >= 3), key=len, reverse=True):
        text = re.sub(re.escape(word), REMOVED, text, flags=re.IGNORECASE)
    return text


def _more(r: sqlite3.Row, private: tuple[str, ...] = ()) -> dict:
    """What the job's email card showed beyond its title line, with contact details and the profile's `private`
    words removed from the free text; empty values are left out."""
    details = r["details"]
    advertiser = _clean(r["company"], MAX_NAME)
    more = {
        "company": advertiser if r["employer"] and advertiser != _clean(r["employer"], MAX_NAME) else "",
        "type": _detail(details, "employment_type", 40), "seniority": _detail(details, "seniority", 40),
        "published": _detail(details, "published", 30),
        "closing": r["closing"] if re.fullmatch(r"\d{4}-\d{2}-\d{2}", r["closing"] or "") else "",
        "confidence": r["confidence"] if isinstance(r["confidence"], int) and 0 <= r["confidence"] <= 100 else None,
        "coverage": _number(details, "coverage"),
        "reasoning": redact(_detail(details, "reasoning", MAX_REASON), private),
        "about": redact(_detail(details, "about", MAX_ABOUT), private),
        "profile": redact(_detail(details, "company_profile", 120), private),
        "site": _url(_detail(details, "employer_site" if r["employer"] else "company_site", MAX_URL)),
        "matched": _skills(r["matched"], MAX_SKILLS), "gaps": _skills(r["gaps"], MAX_GAPS),
    }
    return {k: v for k, v in more.items() if v not in ("", None, [])}


def collect(db: Path, tz: ZoneInfo, now: float | None = None, private: tuple[str, ...] = (), currency: str = "",
            rates: dict[str, float] | None = None) -> dict:
    """A profile's stats; a missing tracker gives empty stats. Only reads the database. `private` words (the
    profile's name and email) are removed from the job details. Salaries are in `currency` at `rates` (those
    that can't be converted are left out of the median); empty `currency` takes them as they are."""
    now = now or time.time()
    today = datetime.fromtimestamp(now, tz).date()
    first = today - timedelta(days=STATS_DAYS - 1)
    stats = _empty(today)
    if not db.is_file():
        return stats
    start = datetime.combine(first, datetime.min.time(), tz).timestamp()

    def day(ts: float) -> date | None:
        d = datetime.fromtimestamp(ts, tz).date() if ts else None
        return d if d and first <= d <= today else None

    con = sqlite3.connect(str(db), timeout=30)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA query_only = ON")
        jobs = con.execute("SELECT key, first_seen, fit, emailed, company, employer, source, title, year_low, salary, "
                           "url, details, confidence, closing, matched, gaps FROM jobs WHERE first_seen >= ?",
                           (start,)).fetchall()
        events = con.execute("SELECT action, at FROM events WHERE at >= ?", (start,)).fetchall()
        runs = con.execute("SELECT at, sources FROM runs WHERE at >= ?", (start,)).fetchall()
        marks = ",".join("?" * len(STATUSES))
        answers = dict(con.execute(
            f"SELECT key, action FROM (SELECT key, action, max(at) FROM events WHERE action IN ({marks}) "
            "GROUP BY key)", STATUSES).fetchall())
        since = con.execute("SELECT min(t) FROM (SELECT min(first_seen) AS t FROM jobs UNION ALL "
                            "SELECT min(at) FROM runs UNION ALL SELECT min(at) FROM events)").fetchone()[0]
    finally:
        con.close()

    rows: dict[date, list[int]] = {}

    def add(d: date | None, field: str, n: int = 1) -> None:
        if d and n:
            rows.setdefault(d, [0] * len(FIELDS))[FIELDS.index(field)] += n

    rated, sent = [], []
    for r in jobs:
        d = day(r["first_seen"])
        if not d:
            continue
        job = {"fit": r["fit"], "first_seen": r["first_seen"], "day": d.isoformat(),
               "year_low": _year_low(r, currency, rates or {}),
               "employer": _clean(r["employer"] or r["company"], MAX_NAME), "source": _clean(r["source"], MAX_NAME),
               "title": _clean(r["title"], MAX_TITLE), "mode": _mode(r["details"]), "d": d, "row": r}
        rated.append(job)
        add(d, "rated")
        if r["emailed"]:
            sent.append(job)
            add(d, "sent")
            if isinstance(r["fit"], int):
                add(d, "fit_sum", r["fit"])
                add(d, "fit_n")
                add(d, "strong", int(r["fit"] >= STRONG_FIT))
    for r in events:
        if r["action"] in EVENTS:
            add(day(r["at"]), r["action"])
    for r in runs:
        d = day(r["at"])
        add(d, "runs")
        try:
            sources = json.loads(r["sources"] or "{}")
        except ValueError:
            sources = {}
        if isinstance(sources, dict):
            add(d, "scanned", sum(_found(v) for v in sources.values()))

    stats["days"] = {d.isoformat(): row for d, row in sorted(rows.items())}
    if since:
        stats["since"] = max(datetime.fromtimestamp(since, tz).date(), first).isoformat()
    for r in RANGES:
        cutoff = today - timedelta(days=r - 1)
        stats["ranges"][str(r)] = _range([j for j in sent if j["d"] >= cutoff], [j for j in rated if j["d"] >= cutoff])
    stats["pipeline"].update(Counter(answers.values()))
    stats["sent"] = _sent_list(sent, answers, today - timedelta(days=SENT_DAYS - 1), private)
    return stats


def _sent_list(sent: list[dict], answers: dict, cutoff: date, private: tuple[str, ...] = ()) -> list[dict]:
    recent = sorted((j for j in sent if j["d"] >= cutoff), key=lambda j: -j["first_seen"])[:SENT_MAX]
    out = []
    for j in recent:
        r = j["row"]
        out.append({"title": j["title"], "employer": j["employer"], "day": j["day"],
                    "fit": j["fit"] if isinstance(j["fit"], int) and 0 <= j["fit"] <= 10 else None,
                    "location": _detail(r["details"], "location", MAX_NAME), "mode": j["mode"],
                    "salary": _detail(r["details"], "salary_shown", 40) or _clean(r["salary"], 40)
                    or _detail(r["details"], "salary", 40),
                    "source": j["source"], "url": _url(r["url"]), "answer": answers.get(r["key"], ""),
                    "key": r["key"] if len(r["key"] or "") <= MAX_KEY and not _CONTROL.search(r["key"]) else "",
                    "more": _more(r, private)})
    return out


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import hermes_common as hc
    import profiles
    hc.load_env_file()
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else hc.STATE_DIR / "job_tracker.db"
    print(json.dumps(collect(path, ZoneInfo(profiles.timezone_name())), indent=1))

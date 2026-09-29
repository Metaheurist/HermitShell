#!/usr/bin/env python3
"""The numbers behind a profile's stats page on the dashboard, read from its tracker (job_tracker.db).

collect() returns one row of counts per day (in HERMES_TIMEZONE) for the last STATS_DAYS days, in the order of
FIELDS, and for each of the dashboard's time ranges the employers, sources, match scores, work modes and best
matches of the jobs sent. `sent` lists the jobs sent in the last SENT_DAYS days, newest first, with the advert's
link and the last button pressed on each. profiles.py sends it to the feedback Worker, which draws the charts and
the dashboard's list of jobs sent. Notes typed on the buttons' confirmation pages and contact details are not
included.

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
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")
_URL = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)


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


def _mode(details: str | None) -> str:
    return _detail(details, "work_mode", 20)


def collect(db: Path, tz: ZoneInfo, now: float | None = None) -> dict:
    """A profile's stats; a missing tracker gives empty stats. Only reads the database."""
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
                           "url, details FROM jobs WHERE first_seen >= ?", (start,)).fetchall()
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
        job = {"fit": r["fit"], "first_seen": r["first_seen"], "day": d.isoformat(), "year_low": r["year_low"],
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
    stats["sent"] = _sent_list(sent, answers, today - timedelta(days=SENT_DAYS - 1))
    return stats


def _sent_list(sent: list[dict], answers: dict, cutoff: date) -> list[dict]:
    recent = sorted((j for j in sent if j["d"] >= cutoff), key=lambda j: -j["first_seen"])[:SENT_MAX]
    out = []
    for j in recent:
        r = j["row"]
        out.append({"title": j["title"], "employer": j["employer"], "day": j["day"],
                    "fit": j["fit"] if isinstance(j["fit"], int) and 0 <= j["fit"] <= 10 else None,
                    "location": _detail(r["details"], "location", MAX_NAME), "mode": j["mode"],
                    "salary": _clean(r["salary"], 40) or _detail(r["details"], "salary", 40),
                    "source": j["source"], "url": _url(r["url"]), "answer": answers.get(r["key"], "")})
    return out


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import hermes_common as hc
    import profiles
    hc.load_env_file()
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else hc.STATE_DIR / "job_tracker.db"
    print(json.dumps(collect(path, ZoneInfo(profiles.timezone_name())), indent=1))

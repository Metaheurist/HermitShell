#!/usr/bin/env python3
"""The numbers behind a profile's stats page on the dashboard, read from its tracker (job_tracker.db).

collect() returns one row of counts per day (in HERMES_TIMEZONE) for the last STATS_DAYS days, in the order of
FIELDS, and for each of the dashboard's time ranges the employers, sources, match scores, work modes and best
matches of the jobs sent. `sent` lists the jobs sent in the last SENT_DAYS days, newest first, with the advert's
link, the last button pressed on each and, under "more", the details its email card showed (why it was rated a
fit, the skills matched and missing, the company). `skills` are those added from the email or the dashboard, which
HermitShell counts as on the CV. profiles.py sends it to the feedback Worker, which draws the
charts and the dashboard's list of jobs sent. Notes typed on the buttons' confirmation pages and the listing text
are not included, and email addresses, phone numbers and the profile's name and email are removed from the rest.

    python3 profile_stats.py [DB]     # print the counts of a tracker (default: the owner's), never job details
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
# New counts go at the end: a day's row is read by position, so an older, shorter row reads 0 for them.
FIELDS = ("scanned", "rated", "sent", "fit_sum", "fit_n", "strong", "runs", "interested", "good_match", "not_for_me",
          "applied", "heard_back", "rejected", "cover_letter", "tailored_cv", "add_skill", "interview", "offer",
          "placed")
EVENTS = FIELDS[FIELDS.index("interested"):]
STATUSES = ("interested", "good_match", "not_for_me", "applied", "heard_back", "rejected", "interview", "offer",
            "placed")
# The Pipeline board: jobs answered in the last BOARD_DAYS days with any status but Not for me, newest first.
BOARD_DAYS = 365
BOARD_MAX = 200
BOARD_STATUSES = tuple(s for s in STATUSES if s != "not_for_me")
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
MAX_POOL = 200
# Salaries by job title: the most common titles with a salary, each only once SALARY_MIN_N jobs have one, so a
# single advert's salary is never shown on its own.
SALARY_TITLES = 8
SALARY_MIN_N = 3
# "Also suits": other recruits a job sent here was rated a fit for, at most OTHERS_MAX per job.
OTHERS_MAX = 5
# The desk (stats:desk): per recruit, what happened in each range, and fees from placements.
DESK_COUNTS = ("sent", "applied", "interview", "offer", "placed")
DESK_SALARY_DAYS = 90
_TITLE_NOISE = re.compile(r"\([^)]*\)|\[[^\]]*\]|\s+[-\u2013\u2014|,:]\s.*$")
# The Worker refuses a stats upload over MAX_STATS_BYTES (stats.js); a little is kept back for the envelope.
MAX_BYTES = 600 * 1024 - 1024
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
            "ranges": {str(r): _range([], []) for r in RANGES}, "pipeline": {s: 0 for s in STATUSES}, "sent": [],
            "skills": []}


def title_key(title) -> str:
    """A job title as it is grouped for salaries: without bracketed parts or what follows " - " or " | ", in
    lower case. Seniority is kept, since it moves the salary."""
    text = _TITLE_NOISE.sub(" ", _clean(title, MAX_TITLE)).lower()
    return " ".join(re.sub(r"[^\w+#. ]", " ", text).split())


def salary_titles(jobs, limit: int = SALARY_TITLES, least: int = SALARY_MIN_N) -> list[dict]:
    """[{title, n, median}] for the `limit` titles with the most salaries among (title, yearly salary) pairs, each
    with at least `least` of them; the title shown is the commonest spelling of the group."""
    groups: dict[str, list] = {}
    for title, value in jobs:
        key = title_key(title)
        if key and isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            groups.setdefault(key, []).append((_TITLE_NOISE.sub(" ", _clean(title, MAX_TITLE)).strip(), value))
    ranked = sorted(((k, v) for k, v in groups.items() if len(v) >= least), key=lambda kv: (-len(kv[1]), kv[0]))
    return [{"title": Counter(t for t, _ in v).most_common(1)[0][0], "n": len(v),
             "median": int(statistics.median(x for _, x in v))} for _, v in ranked[:limit]]


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
        "salary_titles": salary_titles((j["title"], j["year_low"]) for j in rated),
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


def _board(con: sqlite3.Connection, since: float, tz: ZoneInfo) -> list[dict]:
    """Each job's latest status since `since` (not Not for me), with its title and employer only: no notes, no fees."""
    marks = ",".join("?" * len(STATUSES))
    rows = con.execute(
        f"""SELECT e.key, e.action, e.at, j.title, j.employer, j.company FROM events e JOIN jobs j ON j.key = e.key
            WHERE e.at >= ? AND e.action IN ({marks})
              AND e.at = (SELECT max(at) FROM events WHERE key = e.key AND action IN ({marks}))
            ORDER BY e.at DESC""", (since, *STATUSES, *STATUSES)).fetchall()
    out, seen = [], set()
    for r in rows:
        key = r["key"] or ""
        if r["action"] not in BOARD_STATUSES or not key or key in seen or len(key) > MAX_KEY or _CONTROL.search(key):
            continue
        seen.add(key)
        out.append({"key": key, "title": _clean(r["title"], MAX_TITLE),
                    "employer": _clean(r["employer"] or r["company"], MAX_NAME), "stage": r["action"],
                    "day": datetime.fromtimestamp(r["at"], tz).date().isoformat()})
        if len(out) >= BOARD_MAX:
            break
    return out


def collect(db: Path, tz: ZoneInfo, now: float | None = None, private: tuple[str, ...] = (), currency: str = "",
            rates: dict[str, float] | None = None, board: bool = False,
            others: dict[str, list[dict]] | None = None) -> dict:
    """A profile's stats; a missing tracker gives empty stats. Only reads the database. `private` words (the
    profile's name and email) are removed from the job details. Salaries are in `currency` at `rates` (those
    that can't be converted are left out of the median); empty `currency` takes them as they are. `board` adds
    the Pipeline board (a Worker older than worker_link.PIPELINE_PROTOCOL has nowhere to show it). `others`
    maps a job's key to the other recruits it suits ([{u, fit}], best first), shown as "Also suits"."""
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
        try:
            pool = [r[0] for r in con.execute("SELECT skill FROM skills ORDER BY at, skill LIMIT ?", (MAX_POOL,))]
        except sqlite3.OperationalError:
            pool = []
        if board:
            stats["board"] = _board(con, now - BOARD_DAYS * 86400, tz)
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
    stats["sent"] = _sent_list(sent, answers, today - timedelta(days=SENT_DAYS - 1), private, others or {})
    stats["skills"] = [k for k in dict.fromkeys(redact(_clean(k, MAX_NAME), private) for k in pool if isinstance(k, str))
                       if k and k != REMOVED]
    return fit(stats)


def body_size(stats: dict) -> int:
    """Bytes of the upload as worker_link sends it (compact, non-ASCII escaped), with the longest profile id."""
    return len(json.dumps({"u": "x" * 40, "stats": stats}, separators=(",", ":")))


def fit(stats: dict, limit: int = MAX_BYTES) -> dict:
    """`stats` with the oldest jobs sent (and on the board) dropped, a tenth of the longer list at a time, until
    the upload fits the Worker's limit: every field is capped, but 150 jobs at their caps (or in a script JSON
    escapes) can still pass it."""
    while (stats.get("sent") or stats.get("board")) and body_size(stats) > limit:
        name = "sent" if len(stats.get("sent") or []) >= len(stats.get("board") or []) else "board"
        stats[name] = stats[name][:-max(1, len(stats[name]) // 10)]
    return stats


def _sent_list(sent: list[dict], answers: dict, cutoff: date, private: tuple[str, ...] = (),
               others: dict[str, list[dict]] | None = None) -> list[dict]:
    recent = sorted((j for j in sent if j["d"] >= cutoff), key=lambda j: -j["first_seen"])[:SENT_MAX]
    out = []
    for j in recent:
        r = j["row"]
        also = (others or {}).get(r["key"]) or []
        out.append({"title": j["title"], "employer": j["employer"], "day": j["day"],
                    "fit": j["fit"] if isinstance(j["fit"], int) and 0 <= j["fit"] <= 10 else None,
                    "location": _detail(r["details"], "location", MAX_NAME), "mode": j["mode"],
                    "salary": _detail(r["details"], "salary_shown", 40) or _clean(r["salary"], 40)
                    or _detail(r["details"], "salary", 40),
                    "source": j["source"], "url": _url(r["url"]), "answer": answers.get(r["key"], ""),
                    "key": r["key"] if len(r["key"] or "") <= MAX_KEY and not _CONTROL.search(r["key"]) else "",
                    "more": _more(r, private), **({"others": also[:OTHERS_MAX]} if also else {})})
    return out


def fits_index(db: Path, since: float, least: int) -> dict[str, int]:
    """{job key: fit} for the tracker's jobs first seen since `since` with a fit of at least `least`, for the
    "Also suits" index; a missing tracker gives {}."""
    if not db.is_file():
        return {}
    con = sqlite3.connect(str(db), timeout=30)
    try:
        con.execute("PRAGMA query_only = ON")
        rows = con.execute("SELECT key, fit FROM jobs WHERE first_seen >= ? AND fit >= ?", (since, least)).fetchall()
    finally:
        con.close()
    return {k: f for k, f in rows if isinstance(k, str) and k and len(k) <= MAX_KEY and isinstance(f, int)
            and 0 <= f <= 10}


def desk(db: Path, tz: ZoneInfo, now: float | None = None, currency: str = "",
         rates: dict[str, float] | None = None) -> dict:
    """One recruit's line on the desk: for each range, the jobs sent and the jobs that reached Applied, Interview,
    Offer and Placed (each job once), and the fees of those placed, by currency; and (title, salary in `currency`)
    for the jobs rated in the last DESK_SALARY_DAYS days, for the desk's salaries. Only reads the database."""
    now = now or time.time()
    today = datetime.fromtimestamp(now, tz).date()
    empty = {str(r): {**{c: 0 for c in DESK_COUNTS}, "fees": {}} for r in RANGES}
    if not db.is_file():
        return {"ranges": empty, "salaries": []}
    start = datetime.combine(today - timedelta(days=max(RANGES) - 1), datetime.min.time(), tz).timestamp()
    con = sqlite3.connect(str(db), timeout=30)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA query_only = ON")
        jobs = con.execute("SELECT key, first_seen, emailed, title, year_low, salary, details FROM jobs "
                           "WHERE first_seen >= ?", (start,)).fetchall()
        marks = ",".join("?" * (len(DESK_COUNTS) - 1))
        columns = {r[1] for r in con.execute("PRAGMA table_info(events)")}
        events = con.execute(f"SELECT key, action, at, {'meta' if 'meta' in columns else 'NULL AS meta'} FROM events "
                             f"WHERE at >= ? AND action IN ({marks}) ORDER BY at", (start, *DESK_COUNTS[1:])).fetchall()
    finally:
        con.close()
    out = empty
    for r in RANGES:
        cutoff = datetime.combine(today - timedelta(days=r - 1), datetime.min.time(), tz).timestamp()
        line = out[str(r)]
        line["sent"] = sum(1 for j in jobs if j["emailed"] and j["first_seen"] >= cutoff)
        latest: dict[tuple[str, str], sqlite3.Row] = {}
        for e in events:
            if e["at"] >= cutoff:
                latest[(e["action"], e["key"])] = e
        for (action, _), e in latest.items():
            line[action] += 1
            if action == "placed" and e["meta"]:
                try:
                    meta = json.loads(e["meta"])
                except ValueError:
                    meta = {}
                fee, code = (meta.get("fee"), meta.get("currency")) if isinstance(meta, dict) else (None, None)
                code = money.currency_code(code)
                if isinstance(fee, (int, float)) and not isinstance(fee, bool) and fee >= 0 and code:
                    line["fees"][code] = round(line["fees"].get(code, 0) + fee, 2)
    recent = datetime.combine(today - timedelta(days=DESK_SALARY_DAYS - 1), datetime.min.time(), tz).timestamp()
    salaries = [(_clean(j["title"], MAX_TITLE), value) for j in jobs if j["first_seen"] >= recent
                and (value := _year_low(j, currency, rates or {}))]
    return {"ranges": out, "salaries": salaries}


def summary(stats: dict) -> str:
    """The counts in `stats` as a table for the terminal: each field today, over the last 7 days and over every
    day kept, then the Pipeline and how many jobs were sent. Titles, employers, links, salaries and skills are
    left out, so it is safe to paste into a log or an issue."""
    days = stats.get("days") or {}
    today = date.fromisoformat(stats["today"])
    week = {(today - timedelta(days=n)).isoformat() for n in range(7)}

    def total(i: int, keep) -> float:
        return sum(float(row[i]) for d, row in days.items() if keep(d) and i < len(row))

    lines = [f"{'':14}{'today':>8}{'7 days':>9}{'all':>9}"]
    for i, name in enumerate(FIELDS):
        counts = (total(i, lambda d: d == stats["today"]), total(i, week.__contains__), total(i, lambda d: True))
        lines.append(f"{name:14}" + "".join(f"{n:>{w}g}" for n, w in zip(counts, (8, 9, 9))))
    pipeline = stats.get("pipeline") or {}
    lines.append("pipeline: " + ", ".join(f"{s} {int(pipeline.get(s, 0))}" for s in STATUSES))
    lines.append(f"jobs sent (last {SENT_DAYS} days): {len(stats.get('sent') or [])}")
    return "\n".join(lines)


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import hermes_common as hc
    import profiles
    hc.load_env_file()
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else hc.STATE_DIR / "job_tracker.db"
    print(summary(collect(path, ZoneInfo(profiles.timezone_name()))))

"""Daily Vacancy Report tracker: every rated job, your feedback and applications, in SQLite.

Feedback arrives through the optional feedback Worker (see docs/feedback-worker.md in HermitShell):
email buttons are signed links to the Worker, which stores confirmed answers until
sync_feedback() fetches and acknowledges them. Nothing on the Hermes server is exposed.

Shared unchanged between the HermitShell package and the Hermes server copy.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import sqlite3
import time
from pathlib import Path
from urllib.parse import urlencode

import requests

ACTIONS = {
    "interested": "Interested",
    "not_for_me": "Not for me",
    "applied": "I applied",
    "heard_back": "Heard back",
    "rejected": "Rejected",
}
CARD_ACTIONS = ("interested", "not_for_me", "applied")
FOLLOWUP_ACTIONS = ("heard_back", "rejected")
FOLLOWUP_DAYS = (7, 14)
DAY = 86400


# --------------------------------------------------------------------------- signed links

def sign(secret: str, key: str, action: str, title: str) -> str:
    """HMAC-SHA256 over key, action and title (first 32 hex chars); the Worker checks the same value."""
    msg = f"{key}\n{action}\n{title}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()[:32]


def action_link(base_url: str, secret: str, key: str, action: str, title: str) -> str:
    title = title[:120]
    query = urlencode({"j": key, "a": action, "n": title, "t": sign(secret, key, action, title)})
    return f"{base_url.rstrip('/')}/f?{query}"


def card_links(base_url: str, secret: str, key: str, title: str,
               actions: tuple[str, ...] = CARD_ACTIONS) -> dict[str, str]:
    if not (base_url and secret):
        return {}
    return {a: action_link(base_url, secret, key, a, title) for a in actions}


# --------------------------------------------------------------------------- store

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    key TEXT PRIMARY KEY, title TEXT, company TEXT, employer TEXT, url TEXT, source TEXT,
    fit INTEGER, confidence INTEGER, salary TEXT, year_low INTEGER, year_high INTEGER,
    closing TEXT, matched TEXT, gaps TEXT, emailed INTEGER DEFAULT 0,
    first_seen REAL, last_seen REAL
);
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, key TEXT, action TEXT, reason TEXT, at REAL
);
CREATE INDEX IF NOT EXISTS events_key ON events(key, at);
CREATE TABLE IF NOT EXISTS reminders (key TEXT PRIMARY KEY, stage INTEGER);
CREATE TABLE IF NOT EXISTS runs (
    at REAL PRIMARY KEY, rated INTEGER, shown INTEGER, sources TEXT, problems TEXT
);
"""


class Tracker:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.commit()
        self.db.close()

    # ------------------------------------------------------------------ jobs

    def upsert_job(self, key: str, job: dict, emailed: bool, now: float | None = None) -> None:
        now = now or time.time()
        salary = job.get("salary_range") or {}
        self.db.execute(
            """INSERT INTO jobs (key, title, company, employer, url, source, fit, confidence, salary, year_low,
                                 year_high, closing, matched, gaps, emailed, first_seen, last_seen)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET fit=excluded.fit, confidence=excluded.confidence,
                   closing=excluded.closing, emailed=max(jobs.emailed, excluded.emailed), last_seen=excluded.last_seen""",
            (key, job.get("title", ""), job.get("company", ""), job.get("employer", ""), job.get("url", ""),
             job.get("source", ""), job.get("fit"), job.get("confidence"), job.get("salary", ""),
             salary.get("year_low"), salary.get("year_high"), job.get("closing", ""),
             json.dumps(job.get("matched", [])), json.dumps(job.get("gaps", [])), int(emailed), now, now))
        self.db.commit()

    def job(self, key: str) -> dict | None:
        row = self.db.execute("SELECT * FROM jobs WHERE key = ?", (key,)).fetchone()
        return dict(row) if row else None

    # ------------------------------------------------------------------ events

    def add_event(self, event_id: str, key: str, action: str, reason: str = "", at: float | None = None) -> bool:
        if action not in ACTIONS or not key:
            return False
        cur = self.db.execute("INSERT OR IGNORE INTO events (id, key, action, reason, at) VALUES (?, ?, ?, ?, ?)",
                              (event_id, key, action, (reason or "")[:300], at or time.time()))
        self.db.commit()
        return cur.rowcount == 1

    def latest_action(self, key: str) -> str | None:
        row = self.db.execute("SELECT action FROM events WHERE key = ? ORDER BY at DESC LIMIT 1", (key,)).fetchone()
        return row["action"] if row else None

    def examples(self, per_kind: int = 3) -> tuple[list[dict], list[dict]]:
        """Recent 'interested'/'applied' and 'not for me' jobs with the reason given, for the rating prompt."""
        def pick(actions: tuple[str, ...]) -> list[dict]:
            marks = ",".join("?" * len(actions))
            rows = self.db.execute(
                f"""SELECT e.key, e.reason, j.title, j.company, j.employer, max(e.at) AS last_at FROM events e
                    LEFT JOIN jobs j ON j.key = e.key
                    WHERE e.action IN ({marks}) AND j.title IS NOT NULL
                    GROUP BY e.key ORDER BY last_at DESC LIMIT ?""", (*actions, per_kind)).fetchall()
            return [dict(r) for r in rows]
        return pick(("interested", "applied")), pick(("not_for_me",))

    # ------------------------------------------------------------------ follow-ups

    def followups(self, now: float | None = None) -> list[dict]:
        """Applications with no update after 7 or 14 days that have not been reminded at that stage yet."""
        now = now or time.time()
        rows = self.db.execute(
            """SELECT e.key, e.at AS applied_at, j.title, j.company, j.employer, j.url, coalesce(r.stage, 0) AS stage
               FROM events e JOIN jobs j ON j.key = e.key LEFT JOIN reminders r ON r.key = e.key
               WHERE e.action = 'applied'
                 AND e.at = (SELECT max(at) FROM events WHERE key = e.key)""").fetchall()
        due = []
        for r in rows:
            days = int((now - r["applied_at"]) // DAY)
            stage = sum(days >= d for d in FOLLOWUP_DAYS)
            if stage > r["stage"]:
                due.append({**dict(r), "days": days, "due_stage": stage})
        return sorted(due, key=lambda d: d["applied_at"])

    def mark_reminded(self, items: list[dict]) -> None:
        for item in items:
            self.db.execute("INSERT INTO reminders (key, stage) VALUES (?, ?) "
                            "ON CONFLICT(key) DO UPDATE SET stage = excluded.stage", (item["key"], item["due_stage"]))
        self.db.commit()

    # ------------------------------------------------------------------ runs and weekly data

    def record_run(self, rated: int, shown: int, sources: dict, problems: list[str], now: float | None = None) -> None:
        self.db.execute("INSERT OR REPLACE INTO runs (at, rated, shown, sources, problems) VALUES (?, ?, ?, ?, ?)",
                        (now or time.time(), rated, shown, json.dumps(sources), json.dumps(problems)))
        self.db.commit()

    def week(self, since: float) -> dict:
        jobs = [dict(r) for r in self.db.execute("SELECT * FROM jobs WHERE first_seen >= ?", (since,))]
        events = [dict(r) for r in self.db.execute(
            "SELECT e.*, j.title, j.company, j.employer FROM events e LEFT JOIN jobs j ON j.key = e.key "
            "WHERE e.at >= ? ORDER BY e.at", (since,))]
        runs = [dict(r) for r in self.db.execute("SELECT * FROM runs WHERE at >= ? ORDER BY at", (since,))]
        applied = [dict(r) for r in self.db.execute(
            """SELECT e.key, min(e.at) AS applied_at, j.title, j.company, j.employer, j.url,
                      (SELECT action FROM events WHERE key = e.key ORDER BY at DESC LIMIT 1) AS status
               FROM events e LEFT JOIN jobs j ON j.key = e.key
               WHERE e.action = 'applied' AND e.at >= ? GROUP BY e.key ORDER BY applied_at DESC""",
            (since - 53 * DAY,))]
        return {"jobs": jobs, "events": events, "runs": runs, "applications": applied}


# --------------------------------------------------------------------------- feedback sync

def sync_feedback(tracker: Tracker, base_url: str, api_token: str, ack: bool = True,
                  timeout: int = 20) -> tuple[int, str | None]:
    """Fetch confirmed answers from the feedback Worker, store them, then acknowledge them.

    Returns (answers saved, error message or None). Safe to call every run.
    """
    if not (base_url and api_token):
        return 0, None
    headers = {"Authorization": f"Bearer {api_token}"}
    base = base_url.rstrip("/")
    try:
        resp = requests.get(f"{base}/events", headers=headers, timeout=timeout)
        resp.raise_for_status()
        events = resp.json().get("events", [])
    except (requests.RequestException, ValueError) as exc:
        detail = f"HTTP {exc.response.status_code}" if getattr(exc, "response", None) is not None \
            else exc.__class__.__name__
        return 0, f"feedback Worker unreachable ({detail})"
    saved, ids = 0, []
    for ev in events:
        event_id = str(ev.get("id") or "")
        if not event_id:
            continue
        saved += tracker.add_event(event_id, str(ev.get("j") or ""), str(ev.get("a") or ""),
                                   str(ev.get("r") or ""), float(ev.get("at") or 0) / 1000 or None)
        ids.append(event_id)
    if ack and ids:
        try:
            requests.post(f"{base}/ack", headers=headers, json={"ids": ids}, timeout=timeout).raise_for_status()
        except requests.RequestException as exc:
            return saved, f"feedback saved but not acknowledged ({exc.__class__.__name__})"
    return saved, None


def prompt_examples(tracker: Tracker | None, per_kind: int = 3) -> str:
    """Calibration block for the rating prompt built from your recent feedback."""
    if not tracker:
        return ""
    liked, disliked = tracker.examples(per_kind)
    if not (liked or disliked):
        return ""

    def fmt(items: list[dict]) -> str:
        return "\n".join(f"- {i['title']} at {i.get('employer') or i.get('company') or 'unknown company'}"
                         + (f" (reason: {i['reason']})" if i.get("reason") else "") for i in items)

    parts = ["CANDIDATE FEEDBACK ON RECENT JOBS (use it to calibrate fit_score):"]
    if liked:
        parts.append("Marked interested or applied:\n" + fmt(liked))
    if disliked:
        parts.append("Marked not for me:\n" + fmt(disliked))
    return "\n".join(parts)

"""Daily Vacancy Report tracker: every rated job, your feedback, applications, cover letter requests and
the skills you added from the email's missing-skill tags.

Feedback arrives through the optional feedback Worker (see docs/feedback-worker.md in HermitShell):
email buttons are signed links to the Worker, which stores confirmed answers until
sync_feedback() fetches and acknowledges them. Nothing on the Hermes server is exposed.

Shared unchanged between the HermitShell package and the Hermes server copy.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
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
    "good_match": "Good match",
    "cover_letter": "Generate cover letter",
    "add_skill": "Add to my skills",
}
CARD_ACTIONS = ("applied", "good_match", "not_for_me", "interested", "cover_letter")
FOLLOWUP_ACTIONS = ("heard_back", "rejected")
# Actions that describe where an application stands; the others (e.g. cover_letter) are requests.
STATUS_ACTIONS = ("interested", "not_for_me", "applied", "heard_back", "rejected", "good_match")
_STATUS_SQL = ", ".join(f"'{a}'" for a in STATUS_ACTIONS)
LETTER_ATTEMPTS = 3
FOLLOWUP_DAYS = (7, 14)
DAY = 86400
# Same limits as the feedback Worker.
MAX_SKILL = 60
MAX_SKILLS = 12
_SKILL_RE = re.compile(r"[^\w .+#/&()-]")


def clean_skill(text: str) -> str:
    return " ".join(_SKILL_RE.sub("", str(text)).split())[:MAX_SKILL].strip()


# --------------------------------------------------------------------------- signed links

def sign(secret: str, key: str, action: str, title: str, skills: str = "", profile: str = "") -> str:
    """HMAC-SHA256 over key, action, title, any skill list and any profile id (first 32 hex chars); the Worker
    checks the same."""
    msg = (f"{key}\n{action}\n{title}" + (f"\n{skills}" if skills else "")
           + (f"\nu={profile}" if profile else "")).encode("utf-8")
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()[:32]


def _link(base_url: str, params: dict[str, str], secret: str, profile: str) -> str:
    params = {**params, **({"u": profile} if profile else {})}
    params["t"] = sign(secret, params["j"], params["a"], params["n"], params.get("s", ""), profile)
    return f"{base_url.rstrip('/')}/f?{urlencode(params)}"


def action_link(base_url: str, secret: str, key: str, action: str, title: str, profile: str = "") -> str:
    return _link(base_url, {"j": key, "a": action, "n": title[:120]}, secret, profile)


def card_links(base_url: str, secret: str, key: str, title: str,
               actions: tuple[str, ...] = CARD_ACTIONS, profile: str = "") -> dict[str, str]:
    if not (base_url and secret):
        return {}
    return {a: action_link(base_url, secret, key, a, title, profile) for a in actions}


def skill_link(base_url: str, secret: str, key: str, title: str, skills: list[str], profile: str = "") -> str:
    """Signed link to the Worker page that adds a job's missing skills to your pool (append &p=<skill> to tick one)."""
    skills = [s for s in dict.fromkeys(clean_skill(s) for s in skills) if s][:MAX_SKILLS]
    if not (base_url and secret and skills):
        return ""
    return _link(base_url, {"j": key, "a": "add_skill", "n": title[:120], "s": "|".join(skills)}, secret, profile)


def unsubscribe_link(base_url: str, secret: str, name: str, profile: str = "") -> str:
    """Report footer link: deletes an extra profile, or only pauses the owner's reports (no profile id)."""
    if not (base_url and secret):
        return ""
    return _link(base_url, {"j": "profile" if profile else "profile-pause", "a": "unsubscribe", "n": name[:120]},
                 secret, profile)


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
CREATE TABLE IF NOT EXISTS letters (
    event_id TEXT PRIMARY KEY, key TEXT, status TEXT, attempts INTEGER DEFAULT 0, error TEXT,
    file TEXT, at REAL
);
CREATE TABLE IF NOT EXISTS skills (skill TEXT PRIMARY KEY COLLATE NOCASE, key TEXT, at REAL);
"""
# Listing details kept for cover letters (added after the first release, hence not in CREATE TABLE).
DETAIL_FIELDS = ("location", "employment_type", "work_mode", "seniority", "salary", "reasoning", "about",
                 "company_profile", "company_site", "listing")


class Tracker:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        if "details" not in {r["name"] for r in self.db.execute("PRAGMA table_info(jobs)")}:
            self.db.execute("ALTER TABLE jobs ADD COLUMN details TEXT")
            self.db.commit()

    def close(self) -> None:
        self.db.commit()
        self.db.close()

    # ------------------------------------------------------------------ jobs

    def upsert_job(self, key: str, job: dict, emailed: bool, now: float | None = None) -> None:
        now = now or time.time()
        salary = job.get("salary_range") or {}
        details = json.dumps({k: job[k] for k in DETAIL_FIELDS if job.get(k)}, default=str)
        self.db.execute(
            """INSERT INTO jobs (key, title, company, employer, url, source, fit, confidence, salary, year_low,
                                 year_high, closing, matched, gaps, emailed, first_seen, last_seen, details)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET fit=excluded.fit, confidence=excluded.confidence,
                   closing=excluded.closing, emailed=max(jobs.emailed, excluded.emailed), last_seen=excluded.last_seen,
                   details=coalesce(excluded.details, jobs.details)""",
            (key, job.get("title", ""), job.get("company", ""), job.get("employer", ""), job.get("url", ""),
             job.get("source", ""), job.get("fit"), job.get("confidence"), job.get("salary", ""),
             salary.get("year_low"), salary.get("year_high"), job.get("closing", ""),
             json.dumps(job.get("matched", [])), json.dumps(job.get("gaps", [])), int(emailed), now, now,
             details if details != "{}" else None))
        self.db.commit()

    def job(self, key: str) -> dict | None:
        row = self.db.execute("SELECT * FROM jobs WHERE key = ?", (key,)).fetchone()
        if not row:
            return None
        job = dict(row)
        for field in ("matched", "gaps"):
            try:
                job[field] = json.loads(job[field] or "[]")
            except ValueError:
                job[field] = []
        try:
            job.update(json.loads(job.pop("details") or "{}"))
        except ValueError:
            pass
        return job

    # ------------------------------------------------------------------ events

    def add_event(self, event_id: str, key: str, action: str, reason: str = "", at: float | None = None,
                  skills: list[str] | None = None) -> bool:
        if action not in ACTIONS or not key:
            return False
        if action == "add_skill":
            skills = [s for s in dict.fromkeys(clean_skill(s) for s in skills or []) if s][:MAX_SKILLS]
            if not skills:
                return False
            reason = ", ".join(skills)
        at = at or time.time()
        cur = self.db.execute("INSERT OR IGNORE INTO events (id, key, action, reason, at) VALUES (?, ?, ?, ?, ?)",
                              (event_id, key, action, (reason or "")[:300], at))
        if cur.rowcount == 1 and action == "add_skill":
            self.db.executemany("INSERT OR IGNORE INTO skills (skill, key, at) VALUES (?, ?, ?)",
                                [(s, key, at) for s in skills])
        self.db.commit()
        return cur.rowcount == 1

    # ------------------------------------------------------------------ skills pool

    def skills(self) -> list[str]:
        """Skills you confirmed from the email's missing-skill tags, oldest first."""
        return [r["skill"] for r in self.db.execute("SELECT skill FROM skills ORDER BY at, skill")]

    def remove_skill(self, skill: str) -> bool:
        cur = self.db.execute("DELETE FROM skills WHERE skill = ?", (clean_skill(skill),))
        self.db.commit()
        return cur.rowcount > 0

    def latest_action(self, key: str) -> str | None:
        row = self.db.execute(f"SELECT action FROM events WHERE key = ? AND action IN ({_STATUS_SQL}) "
                              "ORDER BY at DESC LIMIT 1", (key,)).fetchone()
        return row["action"] if row else None

    def examples(self, per_kind: int = 3) -> tuple[list[dict], list[dict]]:
        """Recent liked (good match, interested, applied) and 'not for me' jobs with the reason given."""
        def pick(actions: tuple[str, ...]) -> list[dict]:
            marks = ",".join("?" * len(actions))
            rows = self.db.execute(
                f"""SELECT e.key, e.reason, j.title, j.company, j.employer, max(e.at) AS last_at FROM events e
                    LEFT JOIN jobs j ON j.key = e.key
                    WHERE e.action IN ({marks}) AND j.title IS NOT NULL
                    GROUP BY e.key ORDER BY last_at DESC LIMIT ?""", (*actions, per_kind)).fetchall()
            return [dict(r) for r in rows]
        return pick(("good_match", "interested", "applied")), pick(("not_for_me",))

    # ------------------------------------------------------------------ follow-ups

    def followups(self, now: float | None = None) -> list[dict]:
        """Applications with no update after 7 or 14 days that have not been reminded at that stage yet."""
        now = now or time.time()
        rows = self.db.execute(
            f"""SELECT e.key, e.at AS applied_at, j.title, j.company, j.employer, j.url, coalesce(r.stage, 0) AS stage
               FROM events e JOIN jobs j ON j.key = e.key LEFT JOIN reminders r ON r.key = e.key
               WHERE e.action = 'applied'
                 AND e.at = (SELECT max(at) FROM events WHERE key = e.key AND action IN ({_STATUS_SQL}))""").fetchall()
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

    # ------------------------------------------------------------------ cover letter requests

    def pending_letters(self, max_attempts: int = LETTER_ATTEMPTS) -> list[dict]:
        """Cover letter requests not yet sent, oldest first, with the note given on the confirmation page."""
        rows = self.db.execute(
            """SELECT e.id AS event_id, e.key, e.reason, e.at, coalesce(l.attempts, 0) AS attempts
               FROM events e LEFT JOIN letters l ON l.event_id = e.id
               WHERE e.action = 'cover_letter' AND coalesce(l.status, '') NOT IN ('sent', 'failed')
               ORDER BY e.at""").fetchall()
        return [dict(r) for r in rows if r["attempts"] < max_attempts]

    def mark_letter(self, event_id: str, key: str, status: str, error: str = "", file: str = "",
                    max_attempts: int = LETTER_ATTEMPTS) -> str:
        """Record a send ('sent') or a failed attempt; the request is given up after max_attempts failures."""
        row = self.db.execute("SELECT attempts FROM letters WHERE event_id = ?", (event_id,)).fetchone()
        attempts = (row["attempts"] if row else 0) + (status != "sent")
        if status != "sent":
            status = "failed" if attempts >= max_attempts else "retry"
        self.db.execute(
            """INSERT INTO letters (event_id, key, status, attempts, error, file, at) VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(event_id) DO UPDATE SET status=excluded.status, attempts=excluded.attempts,
                   error=excluded.error, file=excluded.file, at=excluded.at""",
            (event_id, key, status, attempts, error[:300], file, time.time()))
        self.db.commit()
        return status

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
            f"""SELECT e.key, min(e.at) AS applied_at, j.title, j.company, j.employer, j.url,
                      (SELECT action FROM events WHERE key = e.key AND action IN ({_STATUS_SQL})
                       ORDER BY at DESC LIMIT 1) AS status
               FROM events e LEFT JOIN jobs j ON j.key = e.key
               WHERE e.action = 'applied' AND e.at >= ? GROUP BY e.key ORDER BY applied_at DESC""",
            (since - 53 * DAY,))]
        return {"jobs": jobs, "events": events, "runs": runs, "applications": applied}


# --------------------------------------------------------------------------- feedback sync

def sync_feedback(tracker: Tracker, base_url: str, api_token: str, ack: bool = True,
                  timeout: int = 20, profile: str = "", full: bool = False) -> tuple[int, str | None]:
    """Fetch confirmed answers (for one profile; "" is the owner) from the feedback Worker, store them, then
    acknowledge them. full=True makes the Worker list KV even when its "something is waiting" flag is unset.

    Returns (answers saved, error message or None). Safe to call every run.
    """
    if not (base_url and api_token):
        return 0, None
    headers = {"Authorization": f"Bearer {api_token}"}
    base = base_url.rstrip("/")
    params = {k: v for k, v in (("u", profile), ("full", "1" if full else "")) if v}
    try:
        resp = requests.get(f"{base}/events", headers=headers, params=params, timeout=timeout)
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
        skills = ev.get("skills") if isinstance(ev.get("skills"), list) else None
        saved += tracker.add_event(event_id, str(ev.get("j") or ""), str(ev.get("a") or ""),
                                   str(ev.get("r") or ""), float(ev.get("at") or 0) / 1000 or None, skills)
        ids.append(event_id)
    if ack and ids:
        try:
            requests.post(f"{base}/ack", headers=headers, json={"ids": ids}, timeout=timeout).raise_for_status()
        except requests.RequestException as exc:
            return saved, f"feedback saved but not acknowledged ({exc.__class__.__name__})"
    return saved, None


def skills_text(tracker: Tracker | None) -> str:
    """Line appended to the candidate profile for skills added from the email."""
    skills = tracker.skills() if tracker else []
    return ("Additional skills the candidate confirmed they have (not tied to a particular employer): "
            + ", ".join(skills) + ".") if skills else ""


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
        parts.append("Marked a good match, interested or applied:\n" + fmt(liked))
    if disliked:
        parts.append("Marked not for me:\n" + fmt(disliked))
    return "\n".join(parts)

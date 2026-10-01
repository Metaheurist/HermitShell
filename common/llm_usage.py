#!/usr/bin/env python3
"""Tokens the AI models use, per task and day, so prompts can be trimmed where it matters.

Every model request (llm_providers.py for the cloud, hermes_common for the local Ollama) adds its prompt and reply
tokens to llm_usage.json in the shared state folder (the one the dashboard settings and model queue use, so every
recruit's runs count together), under the task that asked: job ratings, cover letters, tailored CVs and so on. A
provider that doesn't say how many tokens it used is estimated from the text (about 4 characters a token). Only
counts are kept, never a prompt, a reply, a model's name or a key. The dashboard's Global settings shows the last
7 days; days older than KEEP_DAYS are dropped.

    python3 llm_usage.py      tokens per task today and over the last 7 days
"""
from __future__ import annotations

import contextlib
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hermes_common as hc  # noqa: E402

TASKS = {
    "triage": "Title screening", "rating": "Job ratings", "verify": "Second opinions", "brief": "Rating briefs",
    "summary": "Report summaries", "profile": "Profiles from CVs", "cv_read": "Reading CVs",
    "evidence": "Evidence maps", "letter": "Cover letters", "cv_tailor": "Tailored CVs",
    "interview_prep": "Interview prep packs", "skills": "Skills added to CVs", "other": "Other",
}
FILE = "llm_usage.json"
KEEP_DAYS = 31
SHOW_DAYS = 7
MAX_TOKENS = 10_000_000
_COUNTS = ("calls", "failed", "in", "out", "ms", "estimated")


def path() -> Path:
    return Path(os.environ.get("HERMES_USAGE_FILE") or hc.SCRIPT_DIR / "state" / FILE)


def estimate(*texts: str) -> int:
    return math.ceil(sum(len(t or "") for t in texts) / 4)


def _whole(value, cap: int = MAX_TOKENS) -> int:
    ok = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0
    return min(int(value), cap) if ok else 0


def _day(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")


def _clean(raw) -> dict:
    """Only well-formed days and known tasks survive, with whole, capped counts."""
    days = raw.get("days") if isinstance(raw, dict) and isinstance(raw.get("days"), dict) else {}
    out = {}
    for day, tasks in days.items():
        if not (isinstance(day, str) and len(day) == 10 and isinstance(tasks, dict)):
            continue
        out[day] = {t: {k: _whole(c.get(k), 1 << 40) for k in _COUNTS}
                    for t, c in tasks.items() if t in TASKS and isinstance(c, dict)}
    return {"days": out}


def load() -> dict:
    try:
        return _clean(json.loads(path().read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return {"days": {}}


@contextlib.contextmanager
def _locked():
    """One writer at a time, across threads and processes (flock where there is one)."""
    with hc.file_lock(path()):
        yield


def record(task: str, prompt_tokens, reply_tokens, ms, ok: bool = True, estimated: bool = False,
           now: float | None = None) -> None:
    """Add one request to today's counts for `task` (an unknown task counts as "other"). Never raises."""
    now = time.time() if now is None else now
    task = task if task in TASKS else "other"
    try:
        with _locked():
            data = load()
            today = data["days"].setdefault(_day(now), {})
            counts = today.setdefault(task, dict.fromkeys(_COUNTS, 0))
            counts["calls"] += 1
            counts["failed"] += 0 if ok else 1
            counts["in"] += _whole(prompt_tokens)
            counts["out"] += _whole(reply_tokens)
            counts["ms"] += _whole(ms, 3_600_000)
            counts["estimated"] += 1 if estimated else 0
            oldest = _day(now - KEEP_DAYS * 86400)
            data["days"] = {d: t for d, t in data["days"].items() if d > oldest}
            hc.write_atomic(path(), json.dumps(data, separators=(",", ":")))
    except OSError as exc:
        hc.log(f"Could not save {FILE}: {exc.__class__.__name__}")


def summary(days: int = SHOW_DAYS, now: float | None = None) -> dict:
    """What the dashboard shows: for each task with any requests in the last `days` days, today's and the period's
    requests, failures and tokens in and out, and the average milliseconds a request took."""
    now = time.time() if now is None else now
    wanted = [_day(now - i * 86400) for i in range(days)]
    stored = load()["days"]
    tasks = {}
    for i, day in enumerate(wanted):
        for task, c in stored.get(day, {}).items():
            row = tasks.setdefault(task, {"label": TASKS[task], "today": dict.fromkeys(_COUNTS, 0),
                                          "period": dict.fromkeys(_COUNTS, 0)})
            for k in _COUNTS:
                row["period"][k] += c[k]
                if i == 0:
                    row["today"][k] += c[k]
    order = list(TASKS)
    rows = [{"task": t, **tasks[t]} for t in sorted(tasks, key=order.index)]
    for row in rows:
        for part in ("today", "period"):
            c = row[part]
            c["avg_ms"] = c.pop("ms") // c["calls"] if c["calls"] else 0
    return {"days": days, "since": wanted[-1], "tasks": rows}


def main() -> int:
    info = summary()
    if not info["tasks"]:
        print("No model requests counted yet.")
        return 0
    print(f"{'Task':22} {'today':>16} {'last ' + str(info['days']) + ' days':>22}   tokens are in / out")
    for row in info["tasks"]:
        t, p = row["today"], row["period"]
        print(f"{row['label']:22} {t['calls']:>4} {t['in']:>6}/{t['out']:<5} {p['calls']:>5} {p['in']:>8}/{p['out']:<7}"
              + (f"  {p['failed']} failed" if p["failed"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())

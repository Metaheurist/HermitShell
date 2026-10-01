"""The stats upload always fits the Worker's limit (MAX_STATS_BYTES in stats.js), even at every field's cap."""

import re
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import profile_stats as ps  # noqa: E402

WORKER = PACKAGE / "feedback-worker" / "src" / "stats.js"


def worst_job(i: int, letter: str = "a") -> dict:
    """A job sent with every field as long as profile_stats lets it be."""
    def s(n):
        return (letter * n)[:n]
    return {"title": f"{i:03d}" + s(ps.MAX_TITLE - 3), "employer": s(ps.MAX_NAME), "day": "2026-01-05", "fit": 10,
            "location": s(ps.MAX_NAME), "mode": s(20), "salary": s(40), "source": s(ps.MAX_NAME),
            "url": "https://example.com/" + s(ps.MAX_URL - 20), "answer": "applied", "key": s(ps.MAX_KEY),
            "more": {"company": s(ps.MAX_NAME), "type": s(40), "seniority": s(40), "published": s(30),
                     "closing": "2026-02-01", "confidence": 100, "coverage": 100, "reasoning": s(ps.MAX_REASON),
                     "about": s(ps.MAX_ABOUT), "profile": s(120), "site": "https://example.com/" + s(ps.MAX_URL - 20),
                     "matched": [s(ps.MAX_NAME)] * ps.MAX_SKILLS, "gaps": [s(ps.MAX_NAME)] * ps.MAX_GAPS}}


def worst_stats(letter: str = "a") -> dict:
    stats = ps._empty(__import__("datetime").date(2026, 1, 5))
    stats["days"] = {f"2025-{m:02d}-{d:02d}": [99999] * len(ps.FIELDS) for m in range(1, 13) for d in range(1, 29)}
    stats["sent"] = [worst_job(i, letter) for i in range(ps.SENT_MAX)]
    stats["skills"] = ["s" * ps.MAX_NAME] * ps.MAX_POOL
    return stats


def test_the_limit_matches_the_workers():
    worker = int(re.search(r"MAX_STATS_BYTES = (\d+) \* 1024", WORKER.read_text(encoding="utf-8")).group(1)) * 1024
    assert ps.MAX_BYTES < worker


def test_jobs_at_their_caps_would_pass_the_limit_without_trimming():
    assert ps.body_size(worst_stats()) > ps.MAX_BYTES


def test_fit_drops_the_oldest_jobs_until_it_fits():
    stats = ps.fit(worst_stats())
    assert ps.body_size(stats) <= ps.MAX_BYTES
    assert 0 < len(stats["sent"]) < ps.SENT_MAX
    assert stats["sent"][0]["title"].startswith("000")


def test_text_json_escapes_still_fits():
    stats = ps.fit(worst_stats("\u4e2d"))
    assert ps.body_size(stats) <= ps.MAX_BYTES
    assert stats["sent"]


def worst_card(i: int, letter: str = "a") -> dict:
    s = (letter * ps.MAX_KEY)
    return {"key": f"{i:03d}" + s[:ps.MAX_KEY - 3], "title": s[:ps.MAX_TITLE], "employer": s[:ps.MAX_NAME],
            "stage": "interview", "day": "2026-01-05"}


def test_a_full_board_is_trimmed_alongside_the_jobs_sent():
    stats = worst_stats("\u4e2d")
    stats["board"] = [worst_card(i, "\u4e2d") for i in range(ps.BOARD_MAX)]
    stats = ps.fit(stats)
    assert ps.body_size(stats) <= ps.MAX_BYTES
    assert stats["sent"] and stats["board"] and stats["board"][0]["key"].startswith("000")


def test_ordinary_stats_are_left_alone():
    stats = worst_stats()
    stats["sent"] = stats["sent"][:20]
    assert len(ps.fit(stats)["sent"]) == 20

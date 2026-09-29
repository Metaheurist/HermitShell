"""Unit tests for profile_stats.py: the daily counts and top lists behind the dashboard's stats page."""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import profile_stats  # noqa: E402
from job_tracker import Tracker  # noqa: E402

LONDON = ZoneInfo("Europe/London")
NOW = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc).timestamp()
DAY = 86400


def col(stats, day, field):
    return stats["days"][day][profile_stats.FIELDS.index(field)]


def job(title, fit, employer="", company="", source="reed.co.uk", mode="", year_low=None):
    return {"title": title, "fit": fit, "employer": employer, "company": company, "source": source,
            "url": "https://jobs.example.com/secret-link", "work_mode": mode,
            "salary_range": {"year_low": year_low} if year_low else {}}


def tracker(tmp_path):
    return Tracker(tmp_path / "job_tracker.db")


def test_counts_each_day_in_the_owners_timezone(tmp_path):
    with tracker(tmp_path) as t:
        t.upsert_job("a", job("Data Engineer", 9, employer="Northwind", mode="Hybrid", year_low=50000), True, NOW)
        t.upsert_job("c", job("Analyst", 7, company="Contoso Ltd"), True, NOW - 60)
        t.upsert_job("b", job("Sales Lead", 4), False, NOW - DAY)
        t.add_event("e1", "a", "applied", "", NOW)
        t.add_event("e2", "a", "heard_back", "call me on 07700 900123", NOW + 60)
        t.add_event("e3", "b", "not_for_me", "too far", NOW - DAY)
        t.add_event("e4", "a", "cover_letter", "", NOW)
        t.record_run(3, 2, {"reed.co.uk": {"found": 40, "error": ""}, "web search": {"found": 5}, "old": 3}, [], NOW)
        # 23:30 UTC on the 28th is already the 29th in London (BST).
        t.add_event("e5", "c", "interested", "", datetime(2026, 9, 28, 23, 30, tzinfo=timezone.utc).timestamp())
    stats = profile_stats.collect(tmp_path / "job_tracker.db", LONDON, NOW)
    assert stats["today"] == "2026-09-29" and stats["since"] == "2026-09-28"
    today = "2026-09-29"
    assert [col(stats, today, f) for f in ("scanned", "rated", "sent", "fit_sum", "fit_n", "strong", "runs")] == \
        [48, 2, 2, 16, 2, 1, 1]
    assert [col(stats, today, f) for f in ("applied", "heard_back", "cover_letter", "interested")] == [1, 1, 1, 1]
    assert col(stats, "2026-09-28", "rated") == 1 and col(stats, "2026-09-28", "not_for_me") == 1
    assert col(stats, "2026-09-28", "sent") == 0
    week = stats["ranges"]["7"]
    assert week["employers"] == [("Northwind", 1), ("Contoso Ltd", 1)]
    assert week["sources"] == [("reed.co.uk", 2)] and week["modes"] == [("Hybrid", 1)]
    assert week["fit"][9] == 1 and week["fit"][7] == 1 and week["fit"][4] == 1 and sum(week["fit"]) == 3
    assert week["salary"] == 50000
    assert [b["title"] for b in week["best"]] == ["Data Engineer", "Analyst"]
    assert stats["pipeline"]["heard_back"] == 1 and stats["pipeline"]["not_for_me"] == 1
    assert stats["pipeline"]["applied"] == 0


def test_ranges_and_history_stop_at_their_cutoffs(tmp_path):
    with tracker(tmp_path) as t:
        t.upsert_job("new", job("Recent", 8, employer="Fabrikam"), True, NOW - 2 * DAY)
        t.upsert_job("mid", job("Last month", 6, employer="Contoso"), True, NOW - 20 * DAY)
        t.upsert_job("old", job("Ancient", 5, employer="Northwind"), True, NOW - 500 * DAY)
    stats = profile_stats.collect(tmp_path / "job_tracker.db", LONDON, NOW)
    assert [e for e, _ in stats["ranges"]["7"]["employers"]] == ["Fabrikam"]
    assert [e for e, _ in stats["ranges"]["30"]["employers"]] == ["Fabrikam", "Contoso"]
    assert len(stats["days"]) == 2
    first = (datetime.fromtimestamp(NOW, LONDON).date() - timedelta(days=profile_stats.STATS_DAYS - 1)).isoformat()
    assert stats["since"] == first


def test_a_profile_without_a_tracker_has_empty_stats(tmp_path):
    stats = profile_stats.collect(tmp_path / "missing.db", LONDON, NOW)
    assert stats["days"] == {} and stats["since"] is None
    assert set(stats["ranges"]) == {"7", "30", "90", "365"} and stats["ranges"]["30"]["fit"] == [0] * 11
    assert not (tmp_path / "missing.db").exists()


def test_stats_leave_out_notes_and_contact_details(tmp_path):
    with tracker(tmp_path) as t:
        t.upsert_job("a", job("Engineer\x00\n<b>", 8, employer="Northwind\tTraders " + "x" * 200), True, NOW)
        t.upsert_job("b", job("Unsent", 3), False, NOW)
        t.add_event("e1", "a", "not_for_me", "ring me: sam@example.com 07700 900123", NOW)
    stats = profile_stats.collect(tmp_path / "job_tracker.db", LONDON, NOW)
    text = json.dumps(stats)
    for secret in ("sam@example.com", "07700", "ring me", "\\u0000", "Unsent"):
        assert secret not in text
    assert text.count("secret-link") == 1 and stats["sent"][0]["url"] == "https://jobs.example.com/secret-link"
    best = stats["ranges"]["7"]["best"][0]
    assert best["title"] == "Engineer <b>" and len(best["employer"]) == profile_stats.MAX_NAME


def test_the_jobs_sent_are_listed_newest_first_with_their_answer(tmp_path):
    with tracker(tmp_path) as t:
        t.upsert_job("new", {**job("Data Engineer", 9, employer="Northwind", mode="Hybrid"), "location": "York",
                             "salary": "£55,000"}, True, NOW)
        t.upsert_job("old", job("Analyst", 6, company="Contoso"), True, NOW - 3 * DAY)
        t.upsert_job("gone", job("Too old", 7), True, NOW - (profile_stats.SENT_DAYS + 5) * DAY)
        t.upsert_job("skip", job("Not sent", 2), False, NOW)
        t.add_event("e1", "new", "interested", "", NOW)
        t.add_event("e2", "new", "applied", "", NOW + 60)
        t.add_event("e3", "new", "cover_letter", "", NOW + 120)
    sent = profile_stats.collect(tmp_path / "job_tracker.db", LONDON, NOW)["sent"]
    assert [j["title"] for j in sent] == ["Data Engineer", "Analyst"]
    assert sent[0] == {"title": "Data Engineer", "employer": "Northwind", "day": "2026-09-29", "fit": 9, "location": "York",
                       "mode": "Hybrid", "salary": "£55,000", "source": "reed.co.uk",
                       "url": "https://jobs.example.com/secret-link", "answer": "applied", "key": "new", "more": {}}
    assert sent[1]["answer"] == "" and sent[1]["employer"] == "Contoso" and sent[1]["day"] == "2026-09-26"


def test_each_job_sent_carries_the_details_its_email_card_showed(tmp_path):
    card = {**job("Data Engineer", 9, employer="Northwind", company="Contoso Recruitment"),
            "reasoning": "Strong Python and SQL overlap.", "about": "Build pipelines.", "company_profile": "Energy supplier",
            "employer_site": "https://northwind.example", "employment_type": "Permanent", "seniority": "Senior",
            "published": "2 days ago", "closing_date": "2026-10-15", "confidence": 85, "coverage": 70,
            "matched": ["Python", "SQL", "Python", "x" * 200], "gaps": ["Azure"], "listing": "Full advert text"}
    with tracker(tmp_path) as t:
        t.upsert_job("https://jobs.example.com/1", card, True, NOW)
        t.upsert_job("x" * 301, job("Long key", 5), True, NOW - 60)
    sent = profile_stats.collect(tmp_path / "job_tracker.db", LONDON, NOW)["sent"]
    more = sent[0]["more"]
    assert sent[0]["key"] == "https://jobs.example.com/1" and sent[1]["key"] == ""
    assert more["company"] == "Contoso Recruitment" and more["type"] == "Permanent" and more["seniority"] == "Senior"
    assert more["reasoning"] == "Strong Python and SQL overlap." and more["about"] == "Build pipelines."
    assert more["profile"] == "Energy supplier" and more["site"] == "https://northwind.example"
    assert more["matched"] == ["Python", "SQL", "x" * profile_stats.MAX_NAME] and more["gaps"] == ["Azure"]
    assert "Full advert text" not in json.dumps(sent)


def test_job_details_are_capped_and_drop_bad_values(tmp_path):
    card = {**job("Engineer", 7, employer="Northwind"), "reasoning": "r" * 2000, "about": "a" * 2000,
            "employer_site": "javascript:alert(1)", "confidence": 900, "coverage": -4, "closing_date": "soon",
            "matched": [f"skill {i}" for i in range(40)], "gaps": "not a list"}
    with tracker(tmp_path) as t:
        t.upsert_job("k", card, True, NOW)
    more = profile_stats.collect(tmp_path / "job_tracker.db", LONDON, NOW)["sent"][0]["more"]
    assert len(more["reasoning"]) == profile_stats.MAX_REASON and len(more["about"]) == profile_stats.MAX_ABOUT
    assert len(more["matched"]) == profile_stats.MAX_SKILLS
    for dropped in ("site", "confidence", "coverage", "closing", "gaps"):
        assert dropped not in more


def test_redact_removes_contact_details_and_private_words_but_keeps_dates_and_salaries():
    text = "Sam Lee (sam.lee@example.co.uk, +44 7700 900123) fits; closes 2026-10-15, pays 30,000 - 35,000"
    out = profile_stats.redact(text, ("sam lee", "", "ab"))
    assert "Sam Lee" not in out and "example.co.uk" not in out and "7700" not in out
    assert out.count(profile_stats.REMOVED) == 3 and "2026-10-15" in out and "30,000 - 35,000" in out


def test_the_jobs_sent_are_capped_and_only_keep_web_links(tmp_path, monkeypatch):
    monkeypatch.setattr(profile_stats, "SENT_MAX", 3)
    urls = ["javascript:alert(1)", "data:text/html,x", "https://ok.example/job?id=1", 'https://x.example/"><img', "ftp://x"]
    with tracker(tmp_path) as t:
        for i, url in enumerate(urls):
            t.upsert_job(f"k{i}", {**job(f"Job {i}", 7), "url": url}, True, NOW - i * 60)
    sent = profile_stats.collect(tmp_path / "job_tracker.db", LONDON, NOW)["sent"]
    assert [j["url"] for j in sent] == ["", "", "https://ok.example/job?id=1"]


def test_collect_only_reads_the_tracker(tmp_path):
    with tracker(tmp_path) as t:
        t.upsert_job("a", job("Engineer", 8), True, NOW)
    db = tmp_path / "job_tracker.db"
    before = db.read_bytes()
    profile_stats.collect(db, LONDON, NOW)
    assert db.read_bytes() == before

"""Unit tests for the recruiter desk numbers: salaries by job title, "Also suits" on the jobs sent, each recruit's
desk line (profile_stats.desk) and the salary line in the weekly roll-up."""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import job_weekly  # noqa: E402
import profile_stats as ps  # noqa: E402
from job_tracker import Tracker  # noqa: E402

LONDON = ZoneInfo("Europe/London")
NOW = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc).timestamp()
DAY = 86400


def job(title, fit=7, year_low=None):
    return {"title": title, "fit": fit, "employer": "Contoso", "url": "https://jobs.example.com/a",
            "salary_range": {"year_low": year_low} if year_low else {}}


def test_titles_are_grouped_without_brackets_or_what_follows_a_dash_but_keep_seniority():
    assert ps.title_key("Data Engineer (Python, Airflow)") == "data engineer"
    assert ps.title_key("Data Engineer - Leeds | Hybrid") == "data engineer"
    assert ps.title_key("Senior Data Engineer") == "senior data engineer"
    assert ps.title_key("C# / .NET Developer") == "c# .net developer"


def test_salaries_by_title_need_three_jobs_and_show_the_median_and_commonest_spelling():
    rows = ps.salary_titles([("Data Engineer", 50000), ("data engineer (dbt)", 60000), ("Data Engineer", 55000),
                             ("Analyst", 30000), ("Analyst", 31000), ("Tester", None), ("Tester", 0), ("Tester", True)])
    assert rows == [{"title": "Data Engineer", "n": 3, "median": 55000}], "two analysts are not enough"


def test_salaries_by_title_are_capped_and_ranked_by_how_many_jobs_have_one():
    pairs = [(f"Role {i}", 1000 * (i + 1)) for i in range(10) for _ in range(3 + i)]
    rows = ps.salary_titles(pairs)
    assert len(rows) == ps.SALARY_TITLES and rows[0]["title"] == "Role 9" and rows[0]["n"] == 12


def test_the_stats_ranges_carry_salaries_by_title_from_the_jobs_rated(tmp_path):
    with Tracker(tmp_path / "job_tracker.db") as t:
        for i, pay in enumerate((40000, 42000, 44000)):
            t.upsert_job(f"k{i}", job("Data Analyst", year_low=pay), i == 0, NOW - i * 60)
        t.upsert_job("lone", job("Data Engineer", year_low=70000), True, NOW)
    stats = ps.collect(tmp_path / "job_tracker.db", LONDON, NOW)
    assert stats["ranges"]["7"]["salary_titles"] == [{"title": "Data Analyst", "n": 3, "median": 42000}]


def test_also_suits_is_added_to_the_jobs_sent_capped_at_five(tmp_path):
    with Tracker(tmp_path / "job_tracker.db") as t:
        t.upsert_job("https://jobs.example.com/1", job("Data Analyst"), True, NOW)
        t.upsert_job("https://jobs.example.com/2", job("Data Engineer"), True, NOW - 60)
    others = {"https://jobs.example.com/1": [{"u": f"r{i}", "fit": 9 - i} for i in range(8)]}
    stats = ps.collect(tmp_path / "job_tracker.db", LONDON, NOW, others=others)
    sent = {j["key"]: j for j in stats["sent"]}
    assert [o["u"] for o in sent["https://jobs.example.com/1"]["others"]] == ["r0", "r1", "r2", "r3", "r4"]
    assert "others" not in sent["https://jobs.example.com/2"]


def test_the_fits_index_keeps_recent_jobs_at_or_above_the_threshold(tmp_path):
    with Tracker(tmp_path / "job_tracker.db") as t:
        t.upsert_job("good", job("A", 7), False, NOW)
        t.upsert_job("weak", job("B", 4), False, NOW)
        t.upsert_job("old", job("C", 9), True, NOW - 200 * DAY)
    assert ps.fits_index(tmp_path / "job_tracker.db", NOW - 90 * DAY, 5) == {"good": 7}
    assert ps.fits_index(tmp_path / "missing.db", 0, 5) == {}


def test_a_desk_line_counts_each_job_once_per_stage_and_sums_placement_fees_by_currency(tmp_path):
    with Tracker(tmp_path / "job_tracker.db") as t:
        t.upsert_job("a", job("Data Analyst"), True, NOW - 2 * DAY)
        t.upsert_job("b", job("Data Engineer"), True, NOW - 40 * DAY)
        t.upsert_job("c", job("Tester"), False, NOW - DAY)
        t.add_event("e1", "a", "applied", at=NOW - DAY)
        t.add_event("e2", "a", "applied", at=NOW - DAY + 60)
        t.add_event("e3", "a", "interview", at=NOW - 3600)
        t.add_event("e4", "a", "offer", at=NOW - 1800, meta={"fee": 9000, "currency": "GBP"})
        t.add_event("e5", "a", "placed", at=NOW - 600, meta={"fee": 8000, "currency": "GBP"})
        t.add_event("e6", "b", "placed", at=NOW - 35 * DAY, meta={"fee": 5000.5, "currency": "EUR"})
    line = ps.desk(tmp_path / "job_tracker.db", LONDON, NOW)
    week, quarter = line["ranges"]["7"], line["ranges"]["90"]
    assert {k: week[k] for k in ps.DESK_COUNTS} == {"sent": 1, "applied": 1, "interview": 1, "offer": 1, "placed": 1}
    assert week["fees"] == {"GBP": 8000.0}, "an offer's fee is not counted, only a placement's"
    assert quarter["sent"] == 2 and quarter["placed"] == 2 and quarter["fees"] == {"GBP": 8000.0, "EUR": 5000.5}


def test_a_missing_tracker_gives_an_empty_desk_line(tmp_path):
    line = ps.desk(tmp_path / "none.db", LONDON, NOW)
    assert line["salaries"] == [] and all(r["sent"] == 0 and r["fees"] == {} for r in line["ranges"].values())
    assert set(line["ranges"]) == {"7", "30", "90", "365"}


def test_the_desk_reads_only(tmp_path):
    db = tmp_path / "job_tracker.db"
    with Tracker(db) as t:
        t.upsert_job("a", job("Data Analyst", year_low=40000), True, NOW)
    before = db.read_bytes()
    line = ps.desk(db, LONDON, NOW)
    assert db.read_bytes() == before and line["salaries"] == [("Data Analyst", 40000)]


def _week(jobs):
    return {"jobs": jobs, "events": [], "runs": [], "applications": []}


def test_the_weekly_roll_up_has_a_salary_line_only_with_three_jobs_of_a_title():
    jobs = [{"title": "Data Analyst", "fit": 7, "emailed": 1, "year_low": pay, "url": "https://jobs.example.com/a",
             "details": json.dumps({"salary_code": "GBP"}), "gaps": "[]"} for pay in (40000, 41000, 42000)]
    _, html, text = job_weekly.build_weekly(_week(jobs), "this week", "Job radar", "Weekly", NOW)
    assert "Typical salaries this week" in html and "Data Analyst \u00a341,000 (3 jobs)" in text
    _, html, text = job_weekly.build_weekly(_week(jobs[:2]), "this week", "Job radar", "Weekly", NOW)
    assert "Typical salaries" not in html and "Typical salaries" not in text


def test_the_weekly_salary_line_never_mixes_currencies():
    jobs = [{"title": "Data Analyst", "year_low": 40000, "details": json.dumps({"salary_code": code})}
            for code in ("GBP", "GBP", "EUR", "EUR")]
    assert job_weekly.weekly_salaries(jobs) == []

"""Unit tests for the Daily Vacancy Report helpers.

Run from the repository root:  python -m pytest packages/daily-vacancy-report/tests
"""

import sys
import time
from datetime import date
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import job_tracker  # noqa: E402
from job_extras import (below_min_salary, closing_date, combined_level, days_left,  # noqa: E402
                        group_agency_posts, parse_salary, rating_failed, repost_key)
from job_tracker import Tracker, action_link, card_links, prompt_examples, sign, sync_feedback  # noqa: E402

# The feedback Worker's test suite checks the same value (feedback-worker/test/worker.test.js).
KNOWN_SIGNATURE = "7a1921b9bd33f759be1489d932b2a57f"


# --------------------------------------------------------------------------- salary

@pytest.mark.parametrize("text, expected", [
    ("£40,000 - £55,000 per annum", (40000, 55000, "year", "£")),
    ("£45k-£55k", (45000, 55000, "year", "£")),
    ("up to 60,000", (60000, 60000, "year", "")),
    ("£350 per day", (77000, 77000, "day", "£")),
    ("£450 - £500", (99000, 110000, "day", "£")),
    ("£25 per hour", (48750, 48750, "hour", "£")),
    ("€100,000", (100000, 100000, "year", "€")),
])
def test_parse_salary(text, expected):
    s = parse_salary(text)
    assert (s["year_low"], s["year_high"], s["period"], s["currency"]) == expected


@pytest.mark.parametrize("text", ["", "Competitive", "Not disclosed", "37.5 hours a week, 25 days holiday"])
def test_parse_salary_without_figures(text):
    assert parse_salary(text) is None


def test_below_min_salary():
    assert below_min_salary(parse_salary("£30,000 - £35,000"), 45000, "£")
    assert not below_min_salary(parse_salary("£40k - £50k"), 45000, "£")
    assert not below_min_salary(None, 45000, "£")
    assert not below_min_salary(parse_salary("€30,000"), 45000, "£")
    assert not below_min_salary(parse_salary("£30,000"), 0, "£")


# --------------------------------------------------------------------------- closing dates

@pytest.mark.parametrize("text, expected", [
    ("Closing date: 12 October 2026", date(2026, 10, 12)),
    ("Applications close on 3rd Nov 2026 at noon", date(2026, 11, 3)),
    ("Apply by 05/10/2026", date(2026, 10, 5)),
    ("Deadline: October 20, 2026", date(2026, 10, 20)),
    ("Closing date 2026-10-01", date(2026, 10, 1)),
])
def test_closing_date(text, expected):
    assert closing_date(f"Great role.\n{text}\nMore text.") == expected


def test_closing_date_falls_back_to_model():
    assert closing_date("No deadline mentioned.", "2026-10-09") == date(2026, 10, 9)
    assert closing_date("No deadline mentioned.", "") is None
    assert days_left(date(2026, 10, 9), date(2026, 10, 6)) == 3
    assert days_left(None, date(2026, 10, 6)) is None


def test_combined_level():
    assert combined_level("senior", "Junior") == ("senior", False)
    assert combined_level(None, "Lead/Principal") == ("lead", True)
    assert combined_level(None, "Unknown") == (None, False)


# --------------------------------------------------------------------------- seen-state rules

def test_repost_key_ignores_punctuation_and_case():
    assert repost_key("AI Engineer - Belfast", "Acme Ltd.") == repost_key("ai engineer belfast", "ACME LTD")
    assert repost_key("AI Engineer", "") is None


def test_rating_failed_retries_three_times_then_gives_up():
    retries = {}
    assert [rating_failed(retries, "k1") for _ in range(3)] == [False, False, False]
    assert retries == {"k1": 3}
    assert rating_failed(retries, "k1") is True
    assert retries == {}


# --------------------------------------------------------------------------- agencies

def job(title, company, fit, agency=False, employer="", location="Belfast"):
    return {"title": title, "company": company, "fit": fit, "confidence": 80, "agency": agency,
            "employer": employer, "location": location}


def test_group_agency_posts_merges_reposts_and_employer_posts():
    jobs = [job("Data Engineer", "Hays", 6, agency=True), job("Data Engineer", "Reed", 7, agency=True),
            job("ML Engineer", "Acme", 8), job("ML Engineer", "Hays", 7, agency=True, employer="Acme")]
    kept, removed = group_agency_posts(jobs)
    assert removed == 2
    by_title = {j["title"]: j for j in kept}
    assert by_title["Data Engineer"]["company"] == "Reed"
    assert by_title["Data Engineer"]["also_advertised_by"] == ["Hays"]
    assert by_title["ML Engineer"]["company"] == "Acme"
    assert by_title["ML Engineer"]["also_advertised_by"] == ["Hays"]


def test_group_agency_posts_can_hide_unnamed_clients():
    kept, removed = group_agency_posts([job("Data Engineer", "Hays", 6, agency=True), job("AI Lead", "Acme", 7)],
                                       hide_unnamed=True)
    assert [j["company"] for j in kept] == ["Acme"] and removed == 1


# --------------------------------------------------------------------------- signed links

def test_signature_matches_worker():
    assert sign("test-secret", "nijobs:123", "applied", "AI Engineer") == KNOWN_SIGNATURE


def test_action_link_is_signed_and_truncates_title():
    link = action_link("https://fb.example.workers.dev/", "s3cret", "indeed:abc", "interested", "x" * 200)
    assert link.startswith("https://fb.example.workers.dev/f?j=indeed%3Aabc&a=interested&n=")
    assert f"t={sign('s3cret', 'indeed:abc', 'interested', 'x' * 120)}" in link
    assert card_links("", "s3cret", "k", "t") == {} and card_links("https://x", "", "k", "t") == {}


# --------------------------------------------------------------------------- tracker

@pytest.fixture
def tracker(tmp_path):
    t = Tracker(tmp_path / "tracker.db")
    yield t
    t.close()


def test_followups_at_7_and_14_days(tracker):
    now = time.time()
    tracker.upsert_job("k1", {"title": "AI Engineer", "company": "Acme", "url": "https://x/1"}, emailed=True)
    tracker.add_event("e1", "k1", "applied", at=now - 8 * 86400)
    due = tracker.followups(now)
    assert [d["key"] for d in due] == ["k1"] and due[0]["due_stage"] == 1
    tracker.mark_reminded(due)
    assert tracker.followups(now) == []
    assert [d["due_stage"] for d in tracker.followups(now + 7 * 86400)] == [2]
    tracker.add_event("e2", "k1", "heard_back", at=now + 7 * 86400 + 1)
    assert tracker.followups(now + 8 * 86400) == []


def test_events_are_idempotent_and_validated(tracker):
    assert tracker.add_event("e1", "k1", "interested")
    assert not tracker.add_event("e1", "k1", "interested")
    assert not tracker.add_event("e2", "k1", "delete_everything")
    assert tracker.latest_action("k1") == "interested"


def test_prompt_examples(tracker):
    assert prompt_examples(tracker) == ""
    tracker.upsert_job("k1", {"title": "AI Engineer", "company": "Acme"}, emailed=True)
    tracker.upsert_job("k2", {"title": "Sales Engineer", "company": "Beta"}, emailed=True)
    tracker.add_event("e1", "k1", "interested")
    tracker.add_event("e2", "k2", "not_for_me", reason="too much travel")
    text = prompt_examples(tracker)
    assert "AI Engineer at Acme" in text and "Sales Engineer at Beta (reason: too much travel)" in text


class FakeResponse:
    def __init__(self, payload=None, status=200):
        self.payload, self.status_code = payload or {}, status

    def raise_for_status(self):
        if self.status_code >= 400:
            err = job_tracker.requests.HTTPError(f"HTTP {self.status_code}")
            err.response = self
            raise err

    def json(self):
        return self.payload


def test_sync_feedback_saves_then_acknowledges(tracker, monkeypatch):
    calls = {}
    events = [{"id": "event:1:a", "j": "k1", "a": "applied", "r": "", "at": 1_790_000_000_000},
              {"id": "event:2:b", "j": "k2", "a": "not_for_me", "r": "remote only", "at": 1_790_000_100_000}]
    monkeypatch.setattr(job_tracker.requests, "get",
                        lambda url, headers, timeout: calls.setdefault("get", (url, headers)) and
                        FakeResponse({"events": events}))
    monkeypatch.setattr(job_tracker.requests, "post",
                        lambda url, headers, json, timeout: calls.setdefault("ack", (url, json)) and FakeResponse())
    saved, error = sync_feedback(tracker, "https://fb.example.workers.dev/", "tok")
    assert (saved, error) == (2, None)
    assert calls["get"] == ("https://fb.example.workers.dev/events", {"Authorization": "Bearer tok"})
    assert calls["ack"] == ("https://fb.example.workers.dev/ack", {"ids": ["event:1:a", "event:2:b"]})
    assert tracker.latest_action("k2") == "not_for_me"
    assert sync_feedback(tracker, "https://fb.example.workers.dev", "tok")[0] == 0


def test_sync_feedback_reports_errors(tracker, monkeypatch):
    monkeypatch.setattr(job_tracker.requests, "get", lambda *a, **k: FakeResponse(status=401))
    assert sync_feedback(tracker, "https://fb.example.workers.dev", "bad") == \
        (0, "feedback Worker unreachable (HTTP 401)")
    assert sync_feedback(tracker, "", "") == (0, None)


# --------------------------------------------------------------------------- report rendering

def test_report_renders_new_card_parts():
    import job_scanner

    job = {"key": "k1", "title": "AI Engineer", "url": "https://example.com/job/1", "source": "example.com",
           "company": "Acme", "location": "Remote", "employment_type": "Contract", "work_mode": "Remote",
           "salary": "", "seniority": "Mid", "published": "", "days_left": 2, "fit": 8, "model_fit": 9,
           "confidence": 80, "coverage": 70, "matched": ["Python", "Azure", "LLMs", "Docker"],
           "gaps": ["Kubernetes", "Go"], "reasoning": "Strong overlap.", "snippet_only": False,
           "second_opinion": 8, "also_advertised_by": ["Agency Ltd"],
           "actions": card_links("https://fb.example.workers.dev", "s", "k1", "AI Engineer")}
    stats = {"when": "today", "shown": 1, "strong": 1, "avg_fit": "8.0", "scanned": 3, "min_score": 5,
             "excluded_location": 0, "excluded_type": 0, "below_min": 0, "model": "m", "sources": "web search 3",
             "web_usage": "n/a", "min_salary": 40000, "salary_currency": "£", "excluded_closed": 1,
             "verify_from": 8, "feedback": True}
    page = job_scanner.build_html([job], [], stats, "Summary.", ["Indeed failed: expired."], "")
    for text in ("Closes in 2 days", "Salary not listed", "Biggest gap:", "Also on your CV: Docker",
                 "Also advertised by Agency Ltd", "Checked twice", "Indeed failed: expired.",
                 "salary at least £40,000", "1 already closed", "/f?j=k1&amp;a=applied"):
        assert text in page, text
    plain = job_scanner.build_text([job], "Summary.")
    assert "closes in 2 days" in plain and "I applied: https://fb.example.workers.dev/f?" in plain

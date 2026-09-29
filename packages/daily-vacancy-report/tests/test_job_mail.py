"""Unit tests for job_mail.py: one tracked job emailed to its profile from the dashboard (no SMTP or network)."""

import sys
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import job_mail  # noqa: E402
from job_tracker import Tracker  # noqa: E402

JOB = {"title": "AI Engineer", "company": "Contoso", "employer": "Northwind", "location": "Belfast",
       "employment_type": "Permanent", "url": "https://example.com/job/1", "source": "example.com", "fit": 8,
       "confidence": 70, "coverage": 60, "matched": ["Python", "Azure"], "gaps": ["Kubernetes"],
       "reasoning": "Strong overlap.", "closing": "2026-10-09", "salary": "£50,000 - £60,000"}
NOW = datetime(2026, 9, 29, 9, 0, tzinfo=timezone.utc)


@pytest.fixture
def feedback(monkeypatch):
    monkeypatch.setenv("JOB_FEEDBACK_URL", "https://fb.example.org")
    monkeypatch.setenv("JOB_FEEDBACK_SECRET", "secret")
    monkeypatch.delenv("JOB_PROFILE_ID", raising=False)


def test_card_job_keeps_what_the_tracker_has_and_drops_the_rest():
    card = job_mail.card_job("k1", {**JOB, "location": "Unknown", "url": "javascript:alert(1)", "fit": "9",
                                    "matched": ["Python", 3, ""] + ["x"] * 40}, date(2026, 9, 29))
    assert card["title"] == "AI Engineer" and card["location"] == "" and card["url"] == ""
    assert card["fit"] == 0 and card["confidence"] == 70 and card["matched"][:2] == ["Python", "x"]
    assert len(card["matched"]) == job_mail.MAX_SKILLS
    assert card["days_left"] == 10 and not card["closed"] and card["salary_range"]


def test_card_job_marks_closed_adverts_and_fills_a_missing_title():
    card = job_mail.card_job("k1", {"closing": "2026-09-01"}, date(2026, 9, 29))
    assert card["closed"] and card["days_left"] is None and card["title"] == "Untitled job"
    assert job_mail.card_job("k1", {"closing": "soon"}, date(2026, 9, 29))["days_left"] is None


def test_job_email_is_the_report_card_with_signed_buttons(feedback):
    subject, body, text = job_mail.job_email("k1", JOB, NOW)
    assert subject.endswith(": AI Engineer at Northwind")
    assert "A job for you" in body and "AI Engineer" in body and "8/10" in body and "10 days" in body
    assert "#1 &middot;" not in body and "closing date has passed" not in body
    links = [line.split(": ", 1)[1] for line in text.splitlines() if "https://fb.example.org/f?" in line]
    actions = [parse_qs(urlparse(link).query)["a"][0] for link in links]
    assert {"applied", "cover_letter", "tailored_cv", "add_skill", "unsubscribe"} <= set(actions)
    assert all(parse_qs(urlparse(link).query)["t"][0] for link in links)
    assert text.startswith("AI Engineer - Northwind\nBelfast, Permanent, £50,000 - £60,000\n")
    assert "Missing from your CV: Kubernetes" in text and "#1" not in text


def test_job_email_says_when_the_advert_has_closed(feedback):
    _, body, text = job_mail.job_email("k1", {**JOB, "closing": "2026-09-01"}, NOW)
    assert "closing date has passed" in body and "closing: Closed" in text


def test_job_email_without_a_worker_has_no_buttons(monkeypatch):
    monkeypatch.delenv("JOB_FEEDBACK_URL", raising=False)
    monkeypatch.delenv("JOB_FEEDBACK_SECRET", raising=False)
    _, body, text = job_mail.job_email("k1", JOB, NOW)
    assert "/f?" not in body and "/f?" not in text and "https://example.com/job/1" in text


def test_links_are_signed_for_the_profile(feedback, monkeypatch):
    monkeypatch.setenv("JOB_PROFILE_ID", "sam-lee-456789")
    _, _, text = job_mail.job_email("k1", JOB, NOW)
    links = [line.split(": ", 1)[1] for line in text.splitlines() if "https://fb.example.org/f?" in line]
    assert links and all(parse_qs(urlparse(link).query).get("u") == ["sam-lee-456789"] for link in links)


def test_send_job_emails_the_tracked_job_once(tmp_path, feedback, monkeypatch):
    tracker = Tracker(tmp_path / "tracker.db")
    tracker.upsert_job("k1", JOB, emailed=True)
    sent = []
    monkeypatch.setattr(job_mail.hc, "send_email", lambda subject, body, text, sender, images=None:
                        sent.append((subject, body, text, sender, images)))
    assert job_mail.send_job(tracker, "k1", dry_run=True).endswith("AI Engineer at Northwind") and sent == []
    subject = job_mail.send_job(tracker, "k1")
    assert [s[0] for s in sent] == [subject] and isinstance(sent[0][4], dict)
    with pytest.raises(LookupError):
        job_mail.send_job(tracker, "gone")
    tracker.close()

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
from job_tracker import (Tracker, action_link, card_links, prompt_examples, sign, skill_link,  # noqa: E402
                         skills_text, sync_feedback, unsubscribe_link)

# The feedback Worker's test suite checks the same values (feedback-worker/test/worker.test.js).
KNOWN_SIGNATURE = "bf5b2947e5f2b792d5a56680ef7d8ab8"
KNOWN_SKILL_SIGNATURE = "1c160ba1b9a49c362a7107d21ce864bd"
KNOWN_PROFILE_SIGNATURE = "981737ef0883273fc687a8aefaf92098"
KNOWN_DAY = 20000


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

@pytest.fixture
def known_day(monkeypatch):
    monkeypatch.setattr(job_tracker.time, "time", lambda: KNOWN_DAY * 86400 + 3600)


def test_signature_matches_worker():
    assert sign("test-secret", "nijobs:123", "applied", "AI Engineer", "", "", KNOWN_DAY) == KNOWN_SIGNATURE


def test_signature_fields_cannot_be_shifted():
    # A profile's link must not verify as the owner's with the profile id folded into the skills.
    assert sign("s", "k", "add_skill", "t", "", "sam-lee", 1) != sign("s", "k", "add_skill", "t", "u=sam-lee", "", 1)
    assert sign("s", "k", "a", "t", "", "", 1) != sign("s", "k", "a", "t", "", "", 2)


def test_action_link_is_signed_and_truncates_title(known_day):
    link = action_link("https://fb.example.workers.dev/", "s3cret", "nijobs:abc", "interested", "x" * 200)
    assert link.startswith("https://fb.example.workers.dev/f?j=nijobs%3Aabc&a=interested&n=")
    assert f"&d={KNOWN_DAY}&t={sign('s3cret', 'nijobs:abc', 'interested', 'x' * 120, '', '', KNOWN_DAY)}" in link
    newline = action_link("https://x", "s3cret", "k", "applied", "AI\nEngineer\x00 ")
    assert "n=AI+Engineer&" in newline
    assert card_links("", "s3cret", "k", "t") == {} and card_links("https://x", "", "k", "t") == {}


def test_skill_link_signs_the_skill_list_like_the_worker(known_day):
    link = skill_link("https://fb.example.workers.dev", "test-secret", "nijobs:123", "AI Engineer",
                      ["Kubernetes", "Terraform", "Go", "Go", "<script>"])
    assert "a=add_skill" in link and "s=Kubernetes%7CTerraform%7CGo%7Cscript&" in link
    assert sign("test-secret", "nijobs:123", "add_skill", "AI Engineer", "Kubernetes|Terraform|Go", "", KNOWN_DAY) == \
        KNOWN_SKILL_SIGNATURE
    assert skill_link("https://x", "s", "k", "t", []) == "" and skill_link("", "s", "k", "t", ["Go"]) == ""


def test_profile_links_carry_the_signed_profile_id(known_day):
    assert sign("test-secret", "nijobs:123", "applied", "AI Engineer", "", "sam-lee", KNOWN_DAY) == KNOWN_PROFILE_SIGNATURE
    link = action_link("https://fb.example.workers.dev", "test-secret", "nijobs:123", "applied", "AI Engineer", "sam-lee")
    assert link.endswith(f"&u=sam-lee&d={KNOWN_DAY}&t={KNOWN_PROFILE_SIGNATURE}")
    owner = action_link("https://fb.example.workers.dev", "test-secret", "nijobs:123", "applied", "AI Engineer")
    assert "u=" not in owner and owner.endswith(f"t={KNOWN_SIGNATURE}")
    assert "&u=sam-lee&" in skill_link("https://x", "test-secret", "k", "t", ["Go"], "sam-lee")


def test_unsubscribe_links_delete_profiles_and_pause_the_owner(known_day):
    extra = unsubscribe_link("https://x", "test-secret", "Sam Lee", "sam-lee")
    assert f"j=profile&a=unsubscribe&n=Sam+Lee&u=sam-lee&d={KNOWN_DAY}&t=" in extra
    assert extra.endswith(sign("test-secret", "profile", "unsubscribe", "Sam Lee", "", "sam-lee", KNOWN_DAY))
    owner = unsubscribe_link("https://x", "test-secret", "Alex Morgan")
    assert "j=profile-pause" in owner and "u=" not in owner
    assert unsubscribe_link("", "test-secret", "Sam") == ""


def test_report_footers_offer_unsubscribe():
    from job_weekly import build_weekly, unsubscribe_footer

    assert "deletes your profile" in unsubscribe_footer("https://x/f?j=profile&amp")
    assert "pauses your reports" in unsubscribe_footer("https://x/f?j=profile-pause", paused_only=True)
    assert unsubscribe_footer("") == ""
    data = {"jobs": [], "events": [], "runs": [], "applications": []}
    _, page, plain = build_weekly(data, "this week", "Job radar", "Weekly", time.time(), "https://x/f?j=profile-pause&u=")
    assert "Unsubscribe</a> (pauses your reports" in page and plain.endswith("Unsubscribe: https://x/f?j=profile-pause&u=")


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
    assert tracker.add_event("e1", "k1", "interested", at=100)
    assert not tracker.add_event("e1", "k1", "interested", at=100)
    assert not tracker.add_event("e2", "k1", "delete_everything")
    assert tracker.latest_action("k1") == "interested"


def test_repeated_status_answer_becomes_latest_but_requests_do_not_repeat(tracker):
    tracker.add_event("e-int", "k1", "interested", at=100)
    tracker.add_event("e-no", "k1", "not_for_me", at=200)
    assert tracker.add_event("e-int", "k1", "interested", at=300)
    assert tracker.latest_action("k1") == "interested"
    assert tracker.add_event("e-cl", "k1", "cover_letter", at=100)
    assert not tracker.add_event("e-cl", "k1", "cover_letter", at=400)


def test_prompt_examples(tracker):
    assert prompt_examples(tracker) == ""
    tracker.upsert_job("k1", {"title": "AI Engineer", "company": "Acme"}, emailed=True)
    tracker.upsert_job("k2", {"title": "Sales Engineer", "company": "Beta"}, emailed=True)
    tracker.add_event("e1", "k1", "interested")
    tracker.add_event("e2", "k2", "not_for_me", reason="too much travel")
    text = prompt_examples(tracker)
    assert "AI Engineer at Acme" in text and "Sales Engineer at Beta (reason: too much travel)" in text
    tracker.upsert_job("k3", {"title": "ML Engineer", "company": "Gamma"}, emailed=True)
    tracker.add_event("e3", "k3", "good_match")
    assert "ML Engineer at Gamma" in prompt_examples(tracker)


def test_tracker_keeps_listing_details_for_cover_letters(tracker):
    tracker.upsert_job("k1", {"title": "AI Engineer", "company": "Acme", "matched": ["Python"], "gaps": ["Go"],
                              "location": "Belfast", "listing": "We need Python.", "reasoning": "Good fit."},
                       emailed=True)
    tracker.upsert_job("k1", {"title": "AI Engineer", "company": "Acme"}, emailed=False)
    job = tracker.job("k1")
    assert job["matched"] == ["Python"] and job["gaps"] == ["Go"]
    assert (job["location"], job["listing"], job["reasoning"]) == ("Belfast", "We need Python.", "Good fit.")
    assert tracker.job("missing") is None


def test_cover_letter_requests_do_not_change_application_status(tracker):
    now = time.time()
    tracker.upsert_job("k1", {"title": "AI Engineer", "company": "Acme", "url": "https://x/1"}, emailed=True)
    tracker.add_event("e1", "k1", "applied", at=now - 8 * 86400)
    tracker.add_event("e2", "k1", "cover_letter", reason="mention Azure", at=now - 86400)
    assert tracker.latest_action("k1") == "applied"
    assert [d["key"] for d in tracker.followups(now)] == ["k1"]
    assert tracker.week(now - 7 * 86400)["applications"][0]["status"] == "applied"


def test_added_skills_join_the_pool_once_and_can_be_removed(tracker):
    assert skills_text(tracker) == "" and skills_text(None) == ""
    assert tracker.add_event("e1", "k1", "add_skill", skills=["Kubernetes", " terraform ", "Kubernetes"], at=1)
    assert not tracker.add_event("e1", "k1", "add_skill", skills=["Go"])
    assert not tracker.add_event("e2", "k1", "add_skill", skills=["", "<>"])
    tracker.add_event("e3", "k2", "add_skill", skills=["kubernetes", "Go"], at=2)
    assert tracker.skills() == ["Kubernetes", "terraform", "Go"]
    assert "confirmed they have" in skills_text(tracker) and "Kubernetes, terraform, Go." in skills_text(tracker)
    assert tracker.latest_action("k1") is None
    assert tracker.remove_skill("KUBERNETES") and not tracker.remove_skill("Rust")
    assert tracker.skills() == ["terraform", "Go"]


def test_sync_feedback_stores_added_skills(tracker, monkeypatch):
    events = [{"id": "event:1:a", "j": "k1", "a": "add_skill", "r": "", "skills": ["Helm", "Go"], "at": 1}]
    monkeypatch.setattr(job_tracker.requests, "get", lambda *a, **k: FakeResponse({"events": events}))
    assert sync_feedback(tracker, "https://fb.example.workers.dev", "tok", ack=False) == (1, None)
    assert tracker.skills() == ["Go", "Helm"]


def test_added_skills_count_as_cv_keywords():
    import re

    import job_scanner

    cv = {"Python": re.compile("python", re.I)}
    other = {"Kubernetes": re.compile(r"\bk8s\b|kubernetes", re.I), "Go": re.compile(r"\bgolang\b", re.I)}
    cv2, other2 = job_scanner.with_added_skills(cv, other, ["kubernetes", "C++", "python"])
    assert list(cv2) == ["Python", "Kubernetes", "C++"] and list(other2) == ["Go"] and "Kubernetes" in other
    matched, gaps = job_scanner.keyword_match("Python, k8s and C++ wanted; golang a plus", cv2, other2)
    assert matched == ["Python", "Kubernetes", "C++"] and gaps == ["Go"]
    assert not cv2["C++"].search("C+++")


def test_pending_letters_retry_then_give_up(tracker):
    tracker.add_event("e1", "k1", "cover_letter", reason="short please")
    tracker.add_event("e2", "k2", "cover_letter")
    tracker.add_event("e3", "k3", "interested")
    assert [(p["event_id"], p["reason"]) for p in tracker.pending_letters()] == [("e1", "short please"), ("e2", "")]
    assert tracker.mark_letter("e1", "k1", "sent", file="letter.pdf") == "sent"
    assert tracker.mark_letter("e2", "k2", "error", "model timeout") == "retry"
    assert tracker.mark_letter("e2", "k2", "error", "model timeout") == "retry"
    assert [p["attempts"] for p in tracker.pending_letters()] == [2]
    assert tracker.mark_letter("e2", "k2", "error", "model timeout") == "failed"
    assert tracker.pending_letters() == []


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
                        lambda url, headers, params, timeout: calls.setdefault("get", []).append((url, headers, params))
                        or FakeResponse({"events": events}))
    monkeypatch.setattr(job_tracker.requests, "post",
                        lambda url, headers, json, timeout: calls.setdefault("ack", (url, json)) and FakeResponse())
    saved, error = sync_feedback(tracker, "https://fb.example.workers.dev/", "tok")
    assert (saved, error) == (2, None)
    assert calls["get"] == [("https://fb.example.workers.dev/events", {"Authorization": "Bearer tok"}, {})]
    assert calls["ack"] == ("https://fb.example.workers.dev/ack", {"ids": ["event:1:a", "event:2:b"]})
    assert tracker.latest_action("k2") == "not_for_me"
    assert sync_feedback(tracker, "https://fb.example.workers.dev", "tok", profile="sam-lee", full=True)[0] == 0
    assert calls["get"][-1][2] == {"u": "sam-lee", "full": "1"}


def test_sync_feedback_reports_errors(tracker, monkeypatch):
    monkeypatch.setattr(job_tracker.requests, "get", lambda *a, **k: FakeResponse(status=401))
    assert sync_feedback(tracker, "https://fb.example.workers.dev", "bad") == \
        (0, "feedback Worker unreachable (HTTP 401)")
    assert sync_feedback(tracker, "", "") == (0, None)


# --------------------------------------------------------------------------- report rendering

def report_job(key: str = "k1", title: str = "AI Engineer", fit: int = 8) -> dict:
    return {"key": key, "title": title, "url": f"https://example.com/job/{key}", "source": "example.com",
            "company": "Acme", "location": "Remote", "employment_type": "Contract", "work_mode": "Remote",
            "salary": "", "seniority": "Mid", "published": "", "days_left": 2, "fit": fit, "model_fit": 9,
            "confidence": 80, "coverage": 70, "matched": ["Python", "Azure", "LLMs", "Docker"],
            "gaps": ["Kubernetes", "Go"], "reasoning": "Strong overlap.", "snippet_only": False,
            "second_opinion": 8, "also_advertised_by": ["Agency Ltd"],
            "actions": card_links("https://fb.example.workers.dev", "s", key, title),
            "skill_link": skill_link("https://fb.example.workers.dev", "s", key, title, ["Kubernetes", "Go"])}


REPORT_STATS = {"when": "today", "shown": 1, "strong": 1, "avg_fit": "8.0", "scanned": 3, "min_score": 5,
                "excluded_location": 0, "excluded_type": 0, "below_min": 0, "model": "m", "sources": "web search 3",
                "web_usage": "n/a", "min_salary": 40000, "salary_currency": "£", "excluded_closed": 1,
                "verify_from": 8, "feedback": True}


def test_report_renders_new_card_parts():
    import job_scanner

    job = report_job()
    page = job_scanner.build_html([job], [], REPORT_STATS, "Summary.", ["nijobs.com failed: HTTP 503."], "")
    for text in ("Closes in 2 days", "Salary not listed", "Missing from your CV", "Also on your CV: Docker",
                 "Also advertised by Agency Ltd", "Checked twice", "nijobs.com failed: HTTP 503.",
                 "salary at least £40,000", "1 already closed", "/f?j=k1&amp;a=applied"):
        assert text in page, text
    plain = job_scanner.build_text([job], "Summary.")
    assert "closes in 2 days" in plain and "I applied: https://fb.example.workers.dev/f?" in plain
    assert "Generate cover letter: https://fb.example.workers.dev/f?" in plain


@pytest.mark.parametrize("text, expected", [
    ("£40,000 - £55,000 per annum", ("£40,000 - £55,000", "a year", "")),
    ("up to £60k", ("Up to £60,000", "a year", "")),
    ("£350 - £400 per day", ("£350 - £400", "a day", "about £77,000 - £88,000 a year")),
    ("£25 per hour", ("£25", "an hour", "about £48,750 a year")),
    ("£12.50 per hour", ("£12.50", "an hour", "about £24,375 a year")),
    ("Competitive plus  bonus", ("Competitive plus bonus", "", "")),
])
def test_salary_figure(text, expected):
    import job_scanner

    assert job_scanner.salary_figure(text, parse_salary(text)) == expected


def test_salary_is_a_headline_not_a_tag():
    import job_scanner

    job = {**report_job(), "salary": "£350 - £400 per day", "salary_range": parse_salary("£350 - £400 per day")}
    page = job_scanner.build_html([job], [], REPORT_STATS, "Summary.")
    assert 'src="cid:icon-salary"' in page and "£350 - £400" in page and "about £77,000 - £88,000 a year" in page
    assert page.index("£350 - £400") < page.index("Contract</span>")
    assert "Salary not listed" not in page and (job_scanner.ICON_DIR / "icon-salary.png").is_file()
    assert "Salary: £350 - £400 a day (about £77,000 - £88,000 a year)" in job_scanner.build_text([job], "")
    unlisted = job_scanner.build_html([report_job()], [], REPORT_STATS, "Summary.")
    assert "Salary not listed" in unlisted and "icon-salary" not in unlisted
    assert "Salary:" not in job_scanner.build_text([report_job()], "")


def test_missing_skill_tags_open_the_add_skill_page_with_that_skill_ticked():
    import job_scanner

    page = job_scanner.build_html([report_job()], [], REPORT_STATS, "Summary.")
    assert "tap one you already have to add it to your skills" in page
    assert "a=add_skill" in page and "s=Kubernetes%7CGo" in page
    assert "&amp;p=Kubernetes\"" in page and ">+ Kubernetes</a>" in page and "&amp;p=Go\"" in page
    plain = job_scanner.build_text([report_job()], "Summary.")
    assert "Missing from your CV: Kubernetes, Go" in plain and "Add to my skills: https://fb.example.workers.dev/f?" in plain
    offline = job_scanner.gap_tags(["Go"], "")
    assert ">Go</span>" in offline and "href" not in offline and "tap one" not in offline
    assert job_scanner.gap_tags([], "https://x") == ""


def test_card_buttons_sit_next_to_view_job_with_icons():
    import job_scanner

    page = job_scanner.build_html([report_job()], [], REPORT_STATS, "Summary.")
    order = [page.index(s) for s in ("View job &rarr;", "a=applied", "a=good_match", "a=not_for_me",
                                     "a=interested", "a=cover_letter", "a=tailored_cv")]
    assert order == sorted(order)
    for action in ("applied", "good_match", "not_for_me", "interested", "cover_letter", "tailored_cv"):
        assert f'src="cid:btn-{action}"' in page
        assert (job_scanner.ICON_DIR / f"btn-{action}.png").is_file()
    assert 'title="Good match"' in page and 'alt="Not for me"' in page and ">Cover letter</a>" in page
    preview = job_scanner.preview_html('<img src="cid:btn-applied"><img src="cid:logo-acme">')
    assert preview.endswith('/btn-applied.png"><img src="logos/logo-acme.png">')


def test_report_fits_gmail_by_listing_the_lowest_ranked_jobs_on_one_line(monkeypatch):
    import hermes_common
    import job_scanner

    top = [report_job(f"t{i}", f"Top role {i}", 8) for i in range(3)]
    maybe = [report_job(f"m{i}", f"Maybe role {i}", 5) for i in range(3)]
    full = job_scanner.fitted_html(top, maybe, REPORT_STATS, "Summary.")
    assert "More matches" not in full

    budget = hermes_common.html_size(hermes_common.compact_html(full, budget=0)) * 2 // 3
    monkeypatch.setattr(hermes_common, "EMAIL_HTML_BUDGET", budget)
    page = job_scanner.fitted_html(top, maybe, REPORT_STATS, "Summary.")
    assert hermes_common.html_size(hermes_common.compact_html(page)) <= budget
    assert "More matches" in page and "#6 Maybe role 2" in page
    assert page.count("View job &rarr;") < 6
    assert all(f"Top role {i}" in page and f"Maybe role {i}" in page for i in range(3))
    assert "/f?j=m2&amp;a=not_for_me" in page


def test_source_problems_lists_failures_empty_sources_and_feedback_errors():
    import job_scanner

    health = {"nijobs.com": {"found": 0, "error": "HTTP 503"}, "web search": {"found": 0}}
    problems = job_scanner.source_problems(health, "HTTP 500")
    assert problems == ["nijobs.com failed: HTTP 503.", "web search found no postings this run.",
                        "Feedback buttons: HTTP 500; answers wait in the Worker until the next run."]


def test_weekly_roll_up_shows_jobs_applications_and_source_health():
    from job_weekly import build_weekly

    now = time.time()
    data = {
        "jobs": [{"key": "k1", "title": "AI Engineer", "company": "Acme", "url": "https://example.com/1", "fit": 8,
                  "confidence": 80, "emailed": 1, "gaps": '["Kubernetes"]'}],
        "events": [{"action": "applied"}],
        "runs": [{"sources": '{"nijobs.com": {"found": 0, "error": "expired"}, "web search": {"found": 5}}'},
                 {"sources": '{"nijobs.com": {"found": 0}, "web search": {"found": 3}}'}],
        "applications": [{"key": "k1", "title": "AI Engineer", "company": "Acme", "status": "applied",
                          "applied_at": now - 3 * 86400}],
    }
    subject, page, plain = build_weekly(data, "this week", "Job radar", "Weekly", now)
    assert subject == "Job radar: your week (1 rated, 1 applied)"
    for text in ("AI Engineer", "applied 3 days ago", "Kubernetes", "0 found, 1 failed runs, 1 empty runs",
                 "8 found</td>", "2 daily runs recorded"):
        assert text in page, text
    assert "Sources: nijobs.com 0 found, web search 8 found" in plain


@pytest.mark.parametrize("raw, expected", [
    ("Citi hiring GenAI Full-Stack Engineer Lead Job in Belfast, Northern Ireland | LinkedIn",
     "GenAI Full-Stack Engineer Lead"),
    ("Ocho hiring Senior Machine Learning Engineer in Belfast ...", "Senior Machine Learning Engineer"),
    ("Data Engineer - Job September 2026", "Data Engineer"),
    ("Hiring Manager Assistant", "Hiring Manager Assistant"),
])
def test_clean_title(raw, expected):
    import job_scanner

    assert job_scanner.clean_title(raw) == expected


def test_feedback_links_and_sync_need_https(tracker):
    assert action_link("http://fb.example.workers.dev", "s", "k", "applied", "t") == ""
    assert card_links("http://fb.example.workers.dev", "s", "k", "t") == {}
    assert unsubscribe_link("http://x.example", "s", "Sam") == ""
    assert job_tracker.sync_feedback(tracker, "http://fb.example.workers.dev", "token") == \
        (0, "JOB_FEEDBACK_URL must start with https://")

"""The checks around a rating: the keyword prescreen before the model and the second opinion after it."""

import sys
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import job_extras  # noqa: E402
from job_extras import prescreened_out, second_look, settle_second, stray_script  # noqa: E402

LONG = "word " * 400
CV_SIZE = 20


@pytest.mark.parametrize("gap, listing, stray", [
    ("experience in manufacturing or supply\u94fe", "Supply chain experience in manufacturing", True),
    ("\ub370\uc774\ud130 \ubd84\uc11d", "Data analysis", True),
    ("supply chain", "Supply chain experience", False),
    ("Caf\u00e9 management", "Caf\u00e9 management", False),
    ("\u65e5\u672c\u8a9e", "Fluent \u65e5\u672c\u8a9e required", False),
])
def test_a_gap_in_a_script_the_listing_never_uses_is_dropped(gap, listing, stray):
    assert stray_script(gap, listing) is stray


def test_a_full_listing_with_none_of_the_cv_keywords_is_not_rated():
    assert prescreened_out(LONG, [], CV_SIZE, 1)
    assert not prescreened_out(LONG, ["Python"], CV_SIZE, 1)
    assert prescreened_out(LONG, ["Python"], CV_SIZE, 2)


@pytest.mark.parametrize("text, cv_size, min_hits, trusted", [
    ("Data Engineer\nA short snippet.", CV_SIZE, 1, False),
    (LONG, job_extras.PRESCREEN_MIN_CV_KEYWORDS - 1, 1, False),
    (LONG, CV_SIZE, 0, False),
    (LONG, CV_SIZE, 1, True),
])
def test_the_prescreen_leaves_thin_evidence_to_the_model(text, cv_size, min_hits, trusted):
    assert not prescreened_out(text, [], cv_size, min_hits, trusted=trusted)


def rated(fit=6, model_fit=None, confidence=80, snippet_only=False):
    return {"fit": fit, "model_fit": fit if model_fit is None else model_fit, "confidence": confidence,
            "snippet_only": snippet_only}


@pytest.mark.parametrize("job, expected", [
    (rated(fit=8), "high"),
    (rated(fit=6, confidence=45), "doubt"),
    (rated(fit=6, confidence=80), None),
    (rated(fit=6, confidence=45, snippet_only=True), None),
    (rated(fit=4, confidence=30), None),
])
def test_a_second_look_is_for_high_scores_and_shown_scores_the_model_was_unsure_of(job, expected):
    assert second_look(job, 8, 5, 60) == expected


def test_either_second_look_can_be_turned_off():
    assert second_look(rated(fit=9), 0, 5, 60) is None
    assert second_look(rated(fit=6, confidence=20), 8, 5, 0) is None


def test_a_high_score_only_comes_down():
    job = rated(fit=9)
    settle_second(job, 6, "high")
    assert job["fit"] == 7 and job["second_opinion"] == 6 and job["second_kind"] == "high"
    job = rated(fit=8)
    settle_second(job, 10, "high")
    assert job["fit"] == 8


def test_an_unsure_score_moves_halfway_either_way_and_agreement_makes_it_surer():
    up = rated(fit=5, confidence=40)
    settle_second(up, 8, "doubt")
    assert up["fit"] == 7 and up["confidence"] == 40
    down = rated(fit=6, confidence=40)
    settle_second(down, 3, "doubt")
    assert down["fit"] == 4
    close = rated(fit=6, confidence=40)
    settle_second(close, 7, "doubt")
    assert close["fit"] == 7 and close["confidence"] == 70


def test_a_penalised_score_keeps_its_penalty_when_moved():
    job = rated(fit=5, model_fit=7, confidence=40)
    settle_second(job, 9, "doubt")
    assert job["fit"] == 6


def test_the_card_says_why_the_score_was_checked():
    import job_scanner

    assert job_scanner.second_note(rated(fit=6)) == ""
    lowered = {**rated(fit=7, model_fit=9), "second_opinion": 6, "second_kind": "high"}
    assert "stricter second look scored it 6/10" in job_scanner.second_note(lowered)
    assert job_scanner.second_note({**rated(fit=8), "second_opinion": 10, "second_kind": "high"}) == ""
    unsure = {**rated(fit=7, model_fit=5), "second_opinion": 8, "second_kind": "doubt"}
    assert "first look was unsure" in job_scanner.second_note(unsure)
    assert job_scanner.second_note({**rated(fit=6), "second_opinion": 6, "second_kind": "doubt"}) == ""


def test_the_footer_counts_listings_the_prescreen_skipped():
    import job_scanner

    stats = {"min_score": 5, "excluded_location": 0, "excluded_type": 0, "below_min": 0, "prescreened": 3,
             "model": "m", "sources": "s", "web_usage": "n/a", "min_salary": 0}
    assert "3 no CV keywords" in job_scanner.report_footer(stats)

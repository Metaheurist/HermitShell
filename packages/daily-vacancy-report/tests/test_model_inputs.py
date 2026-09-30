"""What the rating prompts are sent: adverts without boilerplate, a compact profile, and a brief of a long one."""

import json
import sys
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "common"))

import job_extras  # noqa: E402
import job_scanner  # noqa: E402

ADVERT = """# Senior Platform Engineer

Skip to main content
Sign in
Apply now
- Belfast (hybrid)
- Permanent

Proseware builds scheduling software for 900 clinics.

You will own our Azure landing zone and the Terraform behind it.

| --- | --- |
Share this job
Apply now
We use cookies to improve your experience. Accept all
Proseware is an equal opportunities employer and welcomes applications from everyone.
https://jobs.example.test/proseware
Must have: Azure, Terraform, Kubernetes.
Must have: Azure, Terraform, Kubernetes.
© 2026 Proseware Ltd. All rights reserved.
Diversity and inclusion lead experience is a plus."""

PROFILE = """# Candidate profile

Name: Alex Morgan
Location: Belfast

## Summary

Cloud engineer with 6 years on Azure.

## Core skills

- Azure
- Terraform
- Kubernetes

## Gaps

- None stated
"""


def test_boilerplate_lines_and_repeats_are_dropped_and_the_job_kept():
    trimmed = job_extras.trim_listing(ADVERT)
    for gone in ("Skip to main", "Sign in", "Apply now", "Share this job", "cookies", "equal opportunities",
                 "https://", "\u00a9", "| --- |"):
        assert gone not in trimmed
    for kept in ("# Senior Platform Engineer", "- Belfast (hybrid)", "900 clinics", "Azure landing zone",
                 "Diversity and inclusion lead"):
        assert kept in trimmed
    assert trimmed.count("Must have: Azure") == 1 and "\n\n\n" not in trimmed
    assert len(trimmed) < len(ADVERT) * 0.7


def test_a_scraped_advert_is_trimmed_before_it_is_kept_or_rated():
    assert "Apply now" not in job_scanner.clean_listing(ADVERT + "\n\nSimilar jobs\n" + "x" * 600)


def test_the_profile_folds_bullets_onto_their_heading_and_drops_empty_entries():
    compact = job_extras.compact_profile(PROFILE)
    assert compact.splitlines() == ["Candidate profile", "Name: Alex Morgan", "Location: Belfast", "Summary",
                                    "Cloud engineer with 6 years on Azure.", "Core skills: Azure; Terraform; Kubernetes",
                                    "Gaps"]
    assert len(compact) < len(PROFILE) * 0.85


LONG = PROFILE + "\n## Experience\n\n" + "\n".join(
    f"- Delivered Azure and Terraform work for client {i} with Kubernetes and Python in production." for i in range(60))
BRIEF = ("Target titles: Cloud Engineer, Platform Engineer\nSeniority: 6 years\nCore skills: Azure; Terraform; "
         "Kubernetes; Python\nLocation: Belfast\n" + "Sectors: consultancy and client delivery for many clients. " * 3)


def asked(monkeypatch, reply):
    calls = []

    def chat(host, model, system, user, num_ctx, fmt=None, num_predict=500, task="other"):
        calls.append((task, user))
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(job_extras, "ollama_chat", chat)
    return calls


def test_a_short_profile_is_sent_compact_without_asking_the_model(monkeypatch, tmp_path):
    calls = asked(monkeypatch, BRIEF)
    assert job_extras.rating_profile(PROFILE, ["Azure"], ("", "m", None), tmp_path / "b.json") == job_extras.compact_profile(PROFILE)
    assert calls == [] and not (tmp_path / "b.json").exists()


def test_a_long_profile_gets_a_brief_once_until_it_changes(monkeypatch, tmp_path):
    cache = tmp_path / "brief.json"
    calls = asked(monkeypatch, BRIEF)
    keywords = ["Azure", "Terraform", "Kubernetes", "Python"]
    first = job_extras.rating_profile(LONG, keywords, ("", "m", None), cache)
    assert first.startswith("Target titles: Cloud Engineer") and len(first) < len(LONG) / 3
    assert job_extras.rating_profile(LONG, keywords, ("", "m", None), cache) == first
    assert [c[0] for c in calls] == ["brief"]
    job_extras.rating_profile(LONG + "\n- Added Grafana.", keywords, ("", "m", None), cache)
    assert len(calls) == 2
    assert "Alex" not in json.loads(cache.read_text())["profile"]


@pytest.mark.parametrize("brief, why", [
    ("Core skills: Azure\n" * 20, "drops most keywords"),
    (BRIEF + "Led a team of 450 engineers.", "adds a figure"),
    ("Too short.", "too short"),
])
def test_a_brief_that_drops_skills_adds_figures_or_is_too_short_is_not_used(monkeypatch, tmp_path, brief, why):
    asked(monkeypatch, brief)
    keywords = ["Azure", "Terraform", "Kubernetes", "Python"]
    cache = tmp_path / "brief.json"
    assert job_extras.rating_profile(LONG, keywords, ("", "m", None), cache) == job_extras.compact_profile(LONG), why
    calls = asked(monkeypatch, BRIEF)
    assert job_extras.rating_profile(LONG, keywords, ("", "m", None), cache) == job_extras.compact_profile(LONG)
    assert calls == [], "a refused brief is remembered until the profile changes"


def test_no_model_answer_sends_the_compact_profile(monkeypatch, tmp_path):
    asked(monkeypatch, requests.ConnectionError("down"))
    cache = tmp_path / "brief.json"
    assert job_extras.rating_profile(LONG, ["Azure"], ("", "m", None), cache) == job_extras.compact_profile(LONG)
    assert not cache.exists()


def test_the_rating_prompt_gets_the_trimmed_advert(monkeypatch):
    seen = []

    def chat(host, model, system, user, num_ctx, fmt=None, num_predict=500, task="other"):
        seen.append((task, user))
        return json.dumps({"fit_score": 8, "confidence": 80, "reasoning": "Fits."})

    monkeypatch.setattr(job_scanner, "ollama_chat", chat)
    job = {"title": "Senior Platform Engineer", "url": "https://jobs.example.test/1", "source": "bench", "text": ADVERT, "facts": {}}
    assert job_scanner.rate_job("", "m", None, "Core skills: Azure", ["Azure"], job)["fit_score"] == 8
    task, user = seen[0]
    assert task == "rating" and "Azure landing zone" in user and "Sign in" not in user and "cookies" not in user

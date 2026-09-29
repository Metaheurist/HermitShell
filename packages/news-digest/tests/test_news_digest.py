"""Unit tests for the News Digest helpers.

Run from the repository root:  python -m pytest packages/news-digest/tests
"""

import json
import sys
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import news_digest as nd  # noqa: E402


@pytest.fixture
def restore_sections():
    sections, by_id, custom = list(nd.SECTIONS), dict(nd.SEC_BY_ID), dict(nd.CUSTOM_SECTIONS)
    yield
    nd.SECTIONS[:] = sections
    nd.SEC_BY_ID.clear()
    nd.SEC_BY_ID.update(by_id)
    nd.CUSTOM_SECTIONS.update(custom)


# --------------------------------------------------------------------------- links

def test_domain_of_and_blocked_domains():
    assert nd.domain_of("https://www.BBC.co.uk/news/x") == "bbc.co.uk"
    assert nd.blocked("m.youtube.com")
    assert not nd.blocked("notyoutube.com")
    assert not nd.blocked("bbc.co.uk")


@pytest.mark.parametrize("url, title, expected", [
    ("https://www.theverge.com/2026/9/28/12345/nvidia-launches-new-gpu", "Nvidia launches a new GPU for data centres",
     True),
    ("https://example.com/blog/why-we-rewrote-it", "Why we rewrote our billing system in Rust", True),
    ("https://example.com/tag/ai", "Everything about AI in one place", False),
    ("https://example.com/ai", "AI news and analysis from our team", False),
    ("https://example.com/2026/report-2026.pdf", "The annual state of AI report for 2026", False),
    ("https://community.example.com/posts/some-thread-title", "Some thread title from the forum", False),
    ("https://example.com/blog/quantum-computing-breakthrough-announced-researchers",
     "Apple unveils the next iPhone lineup this autumn", False),
    ("https://example.com/news/short-one", "Too short", False),
    ("https://example.com/news/best-deals-this-week", "Best deals on laptops this week, 40% off", False),
])
def test_is_article(url, title, expected):
    assert nd.is_article(url, title) is expected


def test_clean_link_removes_tracking_parameters():
    assert nd.clean_link("https://ex.com/a?utm_source=x&id=1&fbclid=z#frag") == "https://ex.com/a?id=1"


# --------------------------------------------------------------------------- text

def test_whole_sentences_drops_cut_off_fragments():
    assert nd.whole_sentences("First one. Second one! Third is cut off mid", 3, 200) == "First one. Second one!"
    assert nd.whole_sentences("Short. Long sentence here.", 2, 10) == "Short."
    assert nd.whole_sentences("no punctuation at all", 2, 100) == "no punctuation at all"


def test_content_words():
    assert nd.content_words("The company's new GPUs, says Nvidia") == {"company", "gpus", "nvidia"}


def test_grounded():
    source = "Nvidia today launched a new GPU for data centres"
    assert nd.grounded("Nvidia launches GPU for data centres", source)
    assert not nd.grounded("Apple iPhone sales slump", source)
    assert not nd.grounded("", source)


def test_entities_and_title_ids():
    title = "Nvidia's Holo4 beats CVE-2026-1234 in the AI race"
    assert nd.entities(title) == {"nvidia", "holo4", "cve-2026-1234"}
    assert nd.title_ids(title) == {"holo4", "cve-2026-1234"}


def test_title_key_and_clean_title():
    assert nd.title_key("Hello, World! 2026") == "hello world 2026"
    assert nd.clean_title("OpenAI ships a new reasoning model for developers | The Verge") == \
        "OpenAI ships a new reasoning model for developers"
    assert nd.clean_title("Short title - Site") == "Short title - Site"


def test_clean_snippet():
    title = "Nvidia launches data centre GPU"
    assert nd.clean_snippet("3 hours ago \u00b7 Nvidia launched a new GPU for data centres today.", title) == \
        "Nvidia launched a new GPU for data centres today."
    assert nd.clean_snippet("Cookie settings and privacy policy for this website", title) == ""
    assert nd.clean_snippet("[Home](https://a.example) [News](https://b.example) Nvidia data centre GPU", title) == ""


def test_section_queries():
    sec = {"sites": ["a.com", "b.com"], "site_query": "AI", "broad_query": "AI news"}
    site_query, broad = nd.section_queries(sec)
    assert site_query == "AI (site:a.com OR site:b.com)"
    assert broad.startswith("AI news -site:youtube.com") and "-site:medium.com" in broad
    assert nd.section_queries({**sec, "sites": []})[0] == "AI news"


# --------------------------------------------------------------------------- topics

def test_custom_topics():
    topics = nd.custom_topics("Formula 1: F1, Grand Prix || Home Brewing || ")
    assert [t["id"] for t in topics] == ["custom-formula-1", "custom-home-brewing"]
    assert topics[0]["site_query"] == 'F1 OR "Grand Prix"'
    assert topics[1]["site_query"] == '"Home Brewing"'
    assert topics[0]["colour"] != topics[1]["colour"]
    assert set(topics[0]) == nd.SECTION_KEYS
    assert nd.custom_topics(" || ") == []


def test_select_topics_keeps_order_and_skips_unknown_ids(restore_sections):
    nd.select_topics("python, ai, python, bogus", "Chess")
    assert [s["id"] for s in nd.SECTIONS] == ["python", "ai", "custom-chess"]
    assert set(nd.SEC_BY_ID) == {"python", "ai", "custom-chess"}


def test_select_topics_defaults_and_errors(restore_sections):
    nd.select_topics("", "")
    assert [s["id"] for s in nd.SECTIONS] == nd.DEFAULT_TOPICS
    with pytest.raises(ValueError):
        nd.select_topics("bogus", "")


def test_default_tagline(restore_sections):
    nd.select_topics("ai,python", "")
    first, second = (s["title"] for s in nd.SECTIONS)
    assert nd.default_tagline() == f"{first} & {second} from the last 24 hours"


def test_example_sections_file_is_valid(restore_sections):
    nd.load_sections("sections.example.json")
    assert nd.CUSTOM_SECTIONS["on"]
    assert nd.SECTIONS and all(nd.SECTION_KEYS <= set(s) for s in nd.SECTIONS)
    assert nd.default_tagline() == "Curated news from the last 24 hours"


def test_load_sections_rejects_missing_keys(tmp_path, restore_sections):
    bad = tmp_path / "sections.json"
    bad.write_text(json.dumps([{"id": "x", "title": "X"}]), encoding="utf-8")
    with pytest.raises(ValueError, match="missing keys"):
        nd.load_sections(str(bad))


# --------------------------------------------------------------------------- email

def story(section, headline, importance, window="day"):
    return {"section": section, "url": f"https://example.com/news/{importance}", "headline": headline,
            "domain": "example.com", "importance": importance, "summary": f"Summary of {headline}.",
            "why": "It changes things.", "window": window, "key_points": ["Point one"]}


def test_digest_email_renders_top_story_sections_and_text(restore_sections, monkeypatch):
    monkeypatch.delenv("NEWS_DIGEST_TAGLINE", raising=False)
    monkeypatch.delenv("NEWS_DIGEST_TITLE", raising=False)
    nd.select_topics("ai", "")
    sec = nd.SECTIONS[0]
    top = story("ai", "Big <launch>", 9)
    other = story("ai", "Smaller update", 6, window="week")
    stats = {"widened": ["AI"], "edition": "Daily", "when": "Monday", "stories": 2, "sections": 1, "sources": 1,
             "scanned": 20, "model": "qwen3:4b", "blocked": 1, "not_article": 2, "seen": 3, "duplicate": 0,
             "web_usage": "n/a"}
    page = nd.build_html([(sec, [top, other])], top, "Today's briefing.", stats)
    for text in ("News Digest", "Big &lt;launch&gt;", "Top story", "Briefing", "Smaller update", "past week",
                 "Widened to the past week for: AI", "1 story"):
        assert text in page, text
    assert "<launch>" not in page
    plain = nd.build_text([(sec, [top, other])], top, "Today's briefing.")
    assert plain.startswith("Today's briefing.")
    assert "TOP STORY: Big <launch>" in plain and "* [6/10] Smaller update (example.com)" in plain
    assert "[9/10]" not in plain

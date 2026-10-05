"""Unit tests for FIRECRAWL_API_BASE and TAVILY_API_BASE: the search clients follow a valid https override and
ignore anything else (no network)."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hermes_common as hc  # noqa: E402


class Reply:
    status_code = 200
    text = "{}"

    def json(self):
        return {"data": [], "results": []}


@pytest.fixture
def posts(monkeypatch):
    seen = []

    class Session:
        def post(self, url, **kw):
            seen.append(url)
            return Reply()

    monkeypatch.setattr(hc, "http", lambda: Session())
    return seen


def test_without_an_override_the_providers_own_hosts_are_used(monkeypatch):
    monkeypatch.delenv("FIRECRAWL_API_BASE", raising=False)
    monkeypatch.delenv("TAVILY_API_BASE", raising=False)
    assert hc.firecrawl_api() == "https://api.firecrawl.dev/v1"
    assert hc.tavily_api() == "https://api.tavily.com"


@pytest.mark.parametrize("value, expected", [
    ("https://replay-search:8443", "https://replay-search:8443"),
    ("https://replay-search:8443/", "https://replay-search:8443"),
    ("https://search.example.com/firecrawl", "https://search.example.com/firecrawl"),
])
def test_an_https_override_is_followed(monkeypatch, value, expected):
    monkeypatch.setenv("FIRECRAWL_API_BASE", value)
    monkeypatch.setenv("TAVILY_API_BASE", value)
    assert hc.firecrawl_api() == f"{expected}/v1"
    assert hc.tavily_api() == expected


def test_searches_go_to_the_override(monkeypatch, posts):
    monkeypatch.setenv("FIRECRAWL_API_BASE", "https://replay-search:8443")
    monkeypatch.setenv("TAVILY_API_BASE", "https://replay-search:8443/tavily")
    monkeypatch.setattr(hc.time, "sleep", lambda s: None)
    hc.Tavily("tvly-test").search("data analyst", 5, None, "gb", "general")
    assert posts == ["https://replay-search:8443/tavily/search"]


def test_a_blank_override_means_the_default(monkeypatch):
    monkeypatch.setenv("TAVILY_API_BASE", "   ")
    assert hc.tavily_api() == hc.TAVILY

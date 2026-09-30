"""Waiting on rate limits and giving up on a web provider that stops answering."""

import sys
from email.utils import formatdate
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hermes_common as hc  # noqa: E402
import llm_providers  # noqa: E402

NOW = 1_800_000_000.0


@pytest.mark.parametrize("value, expected", [
    ("30", 30.0), (" 2.5 ", 2.5), ("-4", 0.0), ("", 7.0), (None, 7.0), ("soon", 7.0),
    (formatdate(NOW + 90, usegmt=True), 90.0), (formatdate(NOW - 90, usegmt=True), 0.0),
])
def test_retry_after_reads_seconds_or_a_date(value, expected):
    assert hc.retry_after(value, 7.0, NOW) == pytest.approx(expected, abs=1)


def test_a_provider_rate_limit_given_as_a_date_is_honoured():
    until, why = llm_providers.rest_for(429, "", formatdate(NOW + 120, usegmt=True), NOW)
    assert why == "rate limited" and until == pytest.approx(NOW + 120, abs=1)


class Reply:
    def __init__(self, status, headers=None):
        self.status_code, self.headers, self.text = status, headers or {}, ""

    def json(self):
        return {"success": True}


def firecrawl():
    fc = object.__new__(hc.Firecrawl)
    fc.keys, fc.idx, fc.calls, fc._last, fc.network_failures, fc.headers = ["not-a-real-key"], 0, 0, 0.0, 0, {}
    return fc


def test_a_rate_limit_with_a_date_does_not_crash_the_scan(monkeypatch):
    slept, replies = [], [Reply(429, {"Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"}), Reply(200)]
    monkeypatch.setattr(hc.time, "sleep", slept.append)
    monkeypatch.setattr(hc.requests, "post", lambda *a, **k: replies.pop(0))
    assert firecrawl()._post("search", {}) == {"success": True}
    assert 0 in slept


def test_firecrawl_is_left_alone_after_failing_to_answer_three_times(monkeypatch):
    posts, slept = [], []
    monkeypatch.setattr(hc.time, "sleep", slept.append)

    def post(*a, **k):
        posts.append(1)
        raise requests.ConnectionError("down")
    monkeypatch.setattr(hc.requests, "post", post)
    fc = firecrawl()
    assert fc._post("search", {}) is None
    assert fc._post("scrape", {}) is None
    assert len(posts) == hc.MAX_NETWORK_FAILURES


def test_an_answer_resets_the_count_of_failures(monkeypatch):
    replies = [requests.ConnectionError("blip"), Reply(200), requests.ConnectionError("blip"), Reply(200)]
    monkeypatch.setattr(hc.time, "sleep", lambda s: None)

    def post(*a, **k):
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply
    monkeypatch.setattr(hc.requests, "post", post)
    fc = firecrawl()
    assert fc._post("search", {}) == {"success": True}
    assert fc._post("search", {}) == {"success": True}
    assert fc.network_failures == 0

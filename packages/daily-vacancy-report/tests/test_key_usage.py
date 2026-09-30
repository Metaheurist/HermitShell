"""Unit tests for key_usage.py: each provider's usage reply, and the hourly cache (no network)."""

import json
import sys
from pathlib import Path

import pytest
import requests

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import key_usage  # noqa: E402

NOW = 1_790_000_000.0
FIRECRAWL = {"success": True, "data": {"remainingCredits": 1200, "planCredits": 3000,
                                       "billingPeriodStart": "2026-09-01T00:00:00Z", "billingPeriodEnd": "2026-10-01T00:00:00Z"}}
TAVILY = {"key": {"usage": 150, "limit": None, "search_usage": 150},
          "account": {"current_plan": "Researcher", "plan_usage": 400, "plan_limit": 1000}}
SCRAPFLY = {"account": {"account_id": "x"}, "subscription": {"plan_name": "FREE", "period": {"start": "2026-09-12", "end": "2026-10-12"},
            "usage": {"scrape": {"current": 180, "limit": 1000, "remaining": 820}}}}


class Reply:
    def __init__(self, data, status=200, size=None):
        self.data, self.status_code = data, status
        self.ok = 200 <= status < 300
        self.content = b"x" * (size if size is not None else 100)

    def json(self):
        if isinstance(self.data, Exception):
            raise self.data
        return self.data


class Seen(list):
    replies: dict


@pytest.fixture
def calls(monkeypatch):
    seen = Seen()
    replies = {key_usage.FIRECRAWL_USAGE: FIRECRAWL, key_usage.TAVILY_USAGE: TAVILY, key_usage.SCRAPFLY_ACCOUNT: SCRAPFLY}

    def get(url, **kw):
        seen.append((url, kw))
        found = replies[url]
        return found if isinstance(found, Reply) else Reply(found)

    monkeypatch.setattr(key_usage.requests, "get", get)
    seen.replies = replies
    return seen


def test_firecrawl_reports_what_is_left_of_the_plan(calls):
    assert key_usage.check("firecrawl", "fc-test-key-000000001") == {
        "used": 1800, "limit": 3000, "left": 1200, "plan": "", "resets": "2026-10-01"}
    url, kw = calls[0]
    assert url == "https://api.firecrawl.dev/v2/team/credit-usage"
    assert kw["headers"]["Authorization"] == "Bearer fc-test-key-000000001"
    assert kw["allow_redirects"] is False and kw["timeout"] <= 10


def test_tavily_uses_the_keys_own_limit_else_the_accounts_plan(calls):
    assert key_usage.check("tavily", "tvly-test-key-00000001") == {
        "used": 400, "limit": 1000, "left": 600, "plan": "Researcher", "resets": ""}
    calls.replies[key_usage.TAVILY_USAGE] = {**TAVILY, "key": {"usage": 30, "limit": 100}}
    assert key_usage.check("tavily", "tvly-test-key-00000001")["left"] == 70


def test_scrapfly_reports_its_scrape_credits_and_period(calls):
    assert key_usage.check("scrapfly", "scp-test-key-00000001") == {
        "used": 180, "limit": 1000, "left": 820, "plan": "FREE", "resets": "2026-10-12"}
    assert calls[0][1]["params"] == {"key": "scp-test-key-00000001"}


@pytest.mark.parametrize("reply,message", [
    (Reply({}, 401), "the key was rejected"),
    (Reply({}, 403), "the key was rejected"),
    (Reply({}, 429), "too many checks; tried again later"),
    (Reply({}, 500), "HTTP 500"),
    (Reply({}, 302), "HTTP 302"),
    (Reply(ValueError("bad json")), "the reply could not be read"),
    (Reply(["not", "a", "dict"]), "the reply could not be read"),
    (Reply({"success": True, "data": {}}), "no usage in the reply"),
    (Reply(FIRECRAWL, size=key_usage.MAX_BYTES + 1), "the reply was too large"),
])
def test_a_check_that_fails_says_why(calls, reply, message):
    calls.replies[key_usage.FIRECRAWL_USAGE] = reply
    with pytest.raises(key_usage.UsageError, match=message):
        key_usage.check("firecrawl", "fc-test-key-000000001")


def test_an_unreachable_provider_is_an_error_not_a_crash(monkeypatch):
    def down(url, **kw):
        raise requests.ConnectionError("no route to fc-test-key-000000001")
    monkeypatch.setattr(key_usage.requests, "get", down)
    with pytest.raises(key_usage.UsageError) as caught:
        key_usage.check("firecrawl", "fc-test-key-000000001")
    assert str(caught.value) == "could not reach it"


def test_report_lists_every_key_masked_in_order_and_caches_the_answers(calls, tmp_path):
    keys = {"firecrawl": ["fc-test-key-000000001", "fc-test-key-000000002"], "tavily": ["tvly-test-key-00000001"], "scrapfly": []}
    found = key_usage.report(keys, tmp_path, 60, NOW)
    assert [(r["hint"], r["role"]) for r in found["firecrawl"]] == [("fc-...0001", "main"), ("fc-...0002", "backup")]
    assert found["firecrawl"][0]["usage"]["left"] == 1200 and found["firecrawl"][0]["at"] == int(NOW * 1000)
    assert found["tavily"][0]["usage"]["plan"] == "Researcher" and found["scrapfly"] == []
    assert len(calls) == 3
    assert key_usage.report(keys, tmp_path, 60, NOW + 59 * 60) == found
    assert len(calls) == 3
    key_usage.report(keys, tmp_path, 60, NOW + 61 * 60)
    assert len(calls) == 6


def test_a_failed_check_is_shown_and_tried_again_sooner(calls, tmp_path):
    calls.replies[key_usage.FIRECRAWL_USAGE] = Reply({}, 401)
    keys = {"firecrawl": ["fc-test-key-000000001"]}
    assert key_usage.report(keys, tmp_path, 60, NOW)["firecrawl"][0]["error"] == "the key was rejected"
    key_usage.report(keys, tmp_path, 60, NOW + key_usage.RETRY - 1)
    assert len(calls) == 1
    calls.replies[key_usage.FIRECRAWL_USAGE] = FIRECRAWL
    assert key_usage.report(keys, tmp_path, 60, NOW + key_usage.RETRY)["firecrawl"][0]["usage"]["left"] == 1200


def test_zero_minutes_lists_the_keys_without_asking(calls, tmp_path):
    assert key_usage.report({"tavily": ["tvly-test-key-00000001"]}, tmp_path, 0, NOW) == {
        "tavily": [{"hint": "tvl...0001", "role": "main"}]}
    assert not calls and not (tmp_path / key_usage.USAGE_FILE).exists()


def test_a_removed_key_is_dropped_from_the_cache(calls, tmp_path):
    key_usage.report({"firecrawl": ["fc-test-key-000000001", "fc-test-key-000000002"]}, tmp_path, 60, NOW)
    key_usage.report({"firecrawl": ["fc-test-key-000000001"]}, tmp_path, 60, NOW + 1)
    assert len(json.loads((tmp_path / key_usage.USAGE_FILE).read_text())) == 1


@pytest.mark.parametrize("raw,expected", [("60", 60), (" 15 ", 15), ("0", 0), ("-5", 0), ("99999", 1440), ("soon", 60), ("", 60)])
def test_minutes_are_read_within_bounds(raw, expected):
    assert key_usage.minutes(raw) == expected

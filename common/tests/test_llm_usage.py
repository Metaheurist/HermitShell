"""Unit tests for llm_usage.py and the token counting in llm_providers and hermes_common (no network).

Run from the repository root:  python -m pytest common/tests
"""

import json
import sys
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hermes_common as hc  # noqa: E402
import llm_providers as lp  # noqa: E402
import llm_usage  # noqa: E402

NOW = 1_790_000_000.0
DAY = 86400


@pytest.fixture(autouse=True)
def ledger(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_USAGE_FILE", str(tmp_path / "usage" / llm_usage.FILE))
    monkeypatch.setattr(hc, "STATE_DIR", tmp_path)
    for name in lp.PROVIDERS:
        monkeypatch.delenv(f"{name.upper()}_API_KEY", raising=False)
    monkeypatch.delenv("LLM_ORDER", raising=False)
    return tmp_path / "usage" / llm_usage.FILE


class Reply:
    def __init__(self, data=None, status=200):
        self.data, self.status_code, self.headers = data or {}, status, {}
        self.ok = 200 <= status < 300
        self.text = json.dumps(self.data)
        self.content = self.text.encode()

    def json(self):
        return self.data

    def raise_for_status(self):
        if not self.ok:
            raise requests.HTTPError(str(self.status_code))


def task_row(task, now=None):
    return next(r for r in llm_usage.summary(now=now)["tasks"] if r["task"] == task)


# --------------------------------------------------------------------------- the ledger

def test_requests_add_up_per_task_and_day():
    llm_usage.record("rating", 1200, 300, 4000, now=NOW)
    llm_usage.record("rating", 1000, 200, 2000, now=NOW)
    llm_usage.record("letter", 5000, 700, 15000, ok=False, now=NOW)
    rating = task_row("rating", NOW)
    assert rating["label"] == "Job ratings"
    assert rating["today"] == {"calls": 2, "failed": 0, "in": 2200, "out": 500, "estimated": 0, "avg_ms": 3000}
    assert task_row("letter", NOW)["today"]["failed"] == 1


def test_today_and_the_period_are_kept_apart_and_old_days_dropped():
    llm_usage.record("rating", 100, 10, 1, now=NOW - 3 * DAY)
    llm_usage.record("rating", 200, 20, 1, now=NOW)
    row = task_row("rating", NOW)
    assert (row["today"]["in"], row["period"]["in"], row["period"]["calls"]) == (200, 300, 2)
    llm_usage.record("rating", 1, 1, 1, now=NOW + 40 * DAY)
    assert len(llm_usage.load()["days"]) == 1


def test_tasks_come_in_pipeline_order_and_unknown_ones_count_as_other():
    llm_usage.record("letter", 1, 1, 1, now=NOW)
    llm_usage.record("triage", 1, 1, 1, now=NOW)
    llm_usage.record("made-up task", 1, 1, 1, now=NOW)
    assert [r["task"] for r in llm_usage.summary(now=NOW)["tasks"]] == ["triage", "letter", "other"]


def test_nothing_counted_is_an_empty_summary():
    assert llm_usage.summary(now=NOW)["tasks"] == []


def test_a_tampered_file_is_cleaned(ledger):
    ledger.parent.mkdir(parents=True)
    ledger.write_text(json.dumps({"days": {"2026-09-30": {"rating": {"calls": "lots", "in": -5, "out": 1e30},
                                                          "<script>": {"calls": 1}}, "not a day": {}}}))
    days = llm_usage.load()["days"]
    assert list(days) == ["2026-09-30"] and list(days["2026-09-30"]) == ["rating"]
    assert days["2026-09-30"]["rating"]["calls"] == 0 and days["2026-09-30"]["rating"]["in"] == 0
    ledger.write_text("not json")
    assert llm_usage.load() == {"days": {}}


def test_a_ledger_that_cannot_be_written_never_breaks_a_request(monkeypatch, capsys):
    monkeypatch.setattr(hc, "write_atomic", lambda path, data: (_ for _ in ()).throw(OSError("read-only")))
    llm_usage.record("rating", 1, 1, 1)
    assert "Could not save" in capsys.readouterr().err


def test_the_status_command_prints_the_counts(capsys):
    assert llm_usage.main() == 0 and "No model requests" in capsys.readouterr().out
    llm_usage.record("rating", 1234, 56, 10)
    llm_usage.main()
    assert "Job ratings" in capsys.readouterr().out


# --------------------------------------------------------------------------- counted where the requests are made

def test_a_cloud_answer_counts_the_tokens_the_provider_reports(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-test-000000001")
    monkeypatch.setattr(lp.requests, "post", lambda *a, **k: Reply(
        {"model": "m", "choices": [{"message": {"content": "Fine"}}], "usage": {"prompt_tokens": 812, "completion_tokens": 64}}))
    assert hc.ollama_chat("", "m", "system", "user", None, task="summary") == "Fine"
    assert task_row("summary")["today"] | {"avg_ms": 0} == {"calls": 1, "failed": 0, "in": 812, "out": 64, "estimated": 0, "avg_ms": 0}


def test_a_provider_that_does_not_say_is_estimated_from_the_text(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-test-000000001")
    monkeypatch.setattr(lp.requests, "post", lambda *a, **k: Reply({"choices": [{"message": {"content": "x" * 40}}]}))
    hc.ollama_chat("", "m", "s" * 40, "u" * 360, None, task="letter")
    today = task_row("letter")["today"]
    assert (today["in"], today["out"], today["estimated"]) == (100, 10, 1)


def test_a_failed_cloud_request_counts_as_failed(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-test-000000001")
    monkeypatch.setattr(lp.requests, "post", lambda *a, **k: Reply({}, 402))
    with pytest.raises(requests.RequestException):
        hc.ollama_chat("", "m", "s", "u", None, task="rating")
    assert task_row("rating")["today"]["failed"] == 1


def test_an_ollama_answer_counts_its_prompt_and_reply_tokens(monkeypatch):
    monkeypatch.setattr(hc.requests, "post", lambda *a, **k: Reply(
        {"message": {"content": "ok"}, "prompt_eval_count": 950, "eval_count": 120}))
    assert hc.ollama_chat("http://ollama:11434", "m", "s", "u", None, task="triage") == "ok"
    today = task_row("triage")["today"]
    assert (today["in"], today["out"], today["estimated"]) == (950, 120, 0)


def test_an_ollama_request_that_fails_counts_as_failed(monkeypatch):
    monkeypatch.setattr(hc.requests, "post", lambda *a, **k: (_ for _ in ()).throw(requests.ConnectionError("down")))
    with pytest.raises(requests.RequestException):
        hc.ollama_chat("http://ollama:11434", "m", "s", "u", None, task="verify")
    assert task_row("verify")["today"]["failed"] == 1


def test_requests_without_a_task_count_as_other(monkeypatch):
    monkeypatch.setattr(hc.requests, "post", lambda *a, **k: Reply({"message": {"content": "ok"}, "eval_count": 3}))
    hc.ollama_chat("http://ollama:11434", "m", "s", "u", None)
    assert task_row("other")["today"]["calls"] == 1


def test_the_ledger_never_holds_a_prompt_a_reply_a_model_or_a_key(monkeypatch, ledger):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-test-000000001")
    monkeypatch.setattr(lp.requests, "post", lambda *a, **k: Reply(
        {"model": "secret/model-name", "choices": [{"message": {"content": "Alex Morgan should apply"}}]}))
    hc.ollama_chat("", "secret/model-name", "secret system prompt", "Alex Morgan's CV", None, task="letter")
    text = ledger.read_text()
    for private in ("secret", "Alex", "sk-or", "model-name"):
        assert private not in text

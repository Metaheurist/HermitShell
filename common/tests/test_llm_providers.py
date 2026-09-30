"""Unit tests for llm_providers.py and the cloud-then-Ollama routing in hermes_common (no network).

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

NOW = 1_790_000_000.0
KEYS = {"openrouter": "sk-or-v1-test-000000001", "bazaarlink": "sk-bl-test-0000000001",
        "featherless": "rc-test-000000000001", "huggingface": "hf_test000000000001"}


class Reply:
    def __init__(self, data=None, status=200, headers=None, text=""):
        self.data, self.status_code, self.headers = data, status, headers or {}
        self.ok = 200 <= status < 300
        self.text = text or json.dumps(data or {})
        self.content = self.text.encode()

    def json(self):
        return self.data

    def raise_for_status(self):
        if not self.ok:
            raise requests.HTTPError(str(self.status_code))


def answer(content, model="provider/model"):
    return Reply({"model": model, "choices": [{"message": {"role": "assistant", "content": content}}]})


@pytest.fixture(autouse=True)
def fresh_state(tmp_path, monkeypatch):
    monkeypatch.setattr(hc, "STATE_DIR", tmp_path)
    for name in KEYS:
        monkeypatch.delenv(f"{name.upper()}_API_KEY", raising=False)
        monkeypatch.delenv(f"{name.upper()}_MODEL", raising=False)
    monkeypatch.delenv("LLM_PROVIDERS", raising=False)
    monkeypatch.delenv("LLM_ORDER", raising=False)


class Posts(list):
    replies: dict


@pytest.fixture
def seen(monkeypatch):
    """Every POST, answered from `seen.replies` (a list per URL, used in turn; the last one repeats)."""
    seen = Posts()
    seen.replies = {}

    def post(url, json=None, headers=None, timeout=None, allow_redirects=None):
        seen.append({"url": url, "body": json, "headers": headers, "allow_redirects": allow_redirects})
        queue = seen.replies[url]
        reply = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(lp.requests, "post", post)
    return seen


def url(name):
    return f"{lp.PROVIDERS[name]['base']}/chat/completions"


def use(monkeypatch, *names):
    for name in names:
        monkeypatch.setenv(f"{name.upper()}_API_KEY", KEYS[name])


# --------------------------------------------------------------------------- which providers, in what order

def test_nothing_is_configured_without_a_key():
    assert lp.configured() == [] and lp.chat("s", "u") is None


def test_the_order_follows_llm_providers_then_the_rest(monkeypatch):
    use(monkeypatch, "openrouter", "huggingface", "featherless")
    assert lp.configured() == ["openrouter", "featherless", "huggingface"]
    monkeypatch.setenv("LLM_PROVIDERS", "huggingface, nonsense ,featherless")
    assert lp.configured() == ["huggingface", "featherless", "openrouter"]


def test_a_malformed_key_or_model_is_ignored(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "short")
    monkeypatch.setenv("BAZAARLINK_API_KEY", "sk-bl-has space-000000")
    monkeypatch.setenv("FEATHERLESS_MODEL", "../../etc/passwd\nx")
    assert lp.configured() == []
    assert lp.model("featherless") == lp.PROVIDERS["featherless"]["model"]
    monkeypatch.setenv("FEATHERLESS_MODEL", "meta-llama/Llama-3.1-8B-Instruct")
    assert lp.model("featherless") == "meta-llama/Llama-3.1-8B-Instruct"


def test_the_default_models_are_the_free_routers():
    assert lp.model("openrouter") == "openrouter/free" and lp.model("bazaarlink") == "auto:free"


def test_every_provider_is_https():
    assert all(p["base"].startswith("https://") for p in lp.PROVIDERS.values())


# --------------------------------------------------------------------------- asking

def test_the_first_provider_answers_with_the_key_and_no_redirects(monkeypatch, seen):
    use(monkeypatch, "openrouter", "bazaarlink")
    seen.replies[url("openrouter")] = [answer("Great fit", "meta/llama-free")]
    assert lp.chat("system", "user", num_predict=100) == ("Great fit", "openrouter", "meta/llama-free")
    sent = seen[0]
    assert sent["headers"]["Authorization"] == f"Bearer {KEYS['openrouter']}" and sent["allow_redirects"] is False
    assert sent["body"]["model"] == "openrouter/free" and sent["body"]["temperature"] == 0
    assert sent["body"]["max_tokens"] >= 100 + 2048
    assert [m["role"] for m in sent["body"]["messages"]] == ["system", "user"]
    assert len(seen) == 1


def test_thinking_is_dropped_from_the_reply(monkeypatch, seen):
    use(monkeypatch, "huggingface")
    seen.replies[url("huggingface")] = [answer("<think>hmm, let me see</think>\n Apply today")]
    assert lp.chat("s", "u")[0] == "Apply today"


def test_a_schema_is_asked_for_as_structured_output_and_the_json_is_extracted(monkeypatch, seen):
    use(monkeypatch, "openrouter")
    seen.replies[url("openrouter")] = [answer('```json\n{"score": 8, "reason": "fits"}\n```')]
    schema = {"type": "object", "properties": {"score": {"type": "integer"}}}
    text, _, _ = lp.chat("s", "u", fmt=schema)
    assert json.loads(text) == {"score": 8, "reason": "fits"}
    assert seen[0]["body"]["response_format"]["json_schema"]["schema"] == schema


def test_a_model_without_structured_output_is_asked_again_with_the_schema_in_the_prompt(monkeypatch, seen):
    use(monkeypatch, "featherless")
    seen.replies[url("featherless")] = [Reply({"error": "response_format unsupported"}, 400),
                                        answer('Sure! {"score": 3} hope that helps')]
    text, name, _ = lp.chat("s", "u", fmt={"type": "object"})
    assert json.loads(text) == {"score": 3} and name == "featherless"
    assert "response_format" not in seen[1]["body"] and "JSON schema" in seen[1]["body"]["messages"][0]["content"]
    assert not lp.load()["featherless"]["rest_until"]


def test_an_unusable_answer_tries_the_next_provider_without_resting(monkeypatch, seen):
    use(monkeypatch, "openrouter", "bazaarlink")
    seen.replies[url("openrouter")] = [answer("no json here")]
    seen.replies[url("bazaarlink")] = [answer('{"score": 5}')]
    assert lp.chat("s", "u", fmt={"type": "object"})[1] == "bazaarlink"
    state = lp.load()
    assert not state["openrouter"]["rest_until"] and state["openrouter"]["failed"] == 1
    assert state["bazaarlink"]["today"] == 1 and state["_last"]["provider"] == "bazaarlink"


@pytest.mark.parametrize("reply,why,until", [
    (Reply({"error": {"message": "Insufficient credits"}}, 402), "out of credits", "tomorrow"),
    (Reply({"error": {"message": "Rate limit exceeded: free-models-per-day"}}, 429), "daily limit reached", "tomorrow"),
    (Reply({"error": "slow down"}, 429, {"Retry-After": "30"}), "rate limited", NOW + 30),
    (Reply({"error": "slow down"}, 429), "rate limited", NOW + lp.RATE_REST),
    (Reply({"error": "bad key"}, 401), "key rejected", NOW + lp.REJECTED_REST),
    (Reply({}, 503), "HTTP 503", NOW + lp.DOWN_REST),
    (requests.ConnectionError("down"), "not answering", NOW + lp.DOWN_REST),
])
def test_a_provider_that_fails_rests_and_the_next_one_answers(monkeypatch, seen, reply, why, until):
    monkeypatch.setattr(lp.time, "time", lambda: NOW)
    use(monkeypatch, "openrouter", "huggingface")
    seen.replies[url("openrouter")] = [reply]
    seen.replies[url("huggingface")] = [answer("ok")]
    assert lp.chat("s", "u")[1] == "huggingface"
    rest = lp.load()["openrouter"]
    assert rest["why"] == why
    assert rest["rest_until"] == (lp.next_utc_day(NOW) if until == "tomorrow" else until)
    seen.clear()
    assert lp.chat("s", "u")[1] == "huggingface" and [s["url"] for s in seen] == [url("huggingface")]


def test_a_long_retry_after_is_capped():
    assert lp.rest_for(429, "", "999999", NOW)[0] == NOW + lp.MAX_RATE_REST


def test_the_next_utc_day_is_midnight():
    assert lp.next_utc_day(NOW) % 86400 == 0 and 0 < lp.next_utc_day(NOW) - NOW <= 86400


def test_none_answering_returns_none(monkeypatch, seen):
    use(monkeypatch, "openrouter")
    seen.replies[url("openrouter")] = [Reply({}, 402)]
    assert lp.chat("s", "u") is None
    assert lp.chat("s", "u") is None and len(seen) == 1


def test_the_state_never_holds_a_key_or_a_prompt(monkeypatch, seen, tmp_path):
    use(monkeypatch, *KEYS)
    for name in KEYS:
        seen.replies[url(name)] = [Reply({"error": f"bad {KEYS[name]}"}, 401)]
    lp.chat("secret system prompt", "Alex Morgan's CV")
    text = (tmp_path / lp.STATE_FILE).read_text()
    assert not any(k in text for k in KEYS.values()) and "Alex Morgan" not in text and "secret" not in text


def test_a_tampered_state_file_is_not_trusted(tmp_path):
    (tmp_path / lp.STATE_FILE).write_text(json.dumps({"openrouter": {"rest_until": "soon", "why": "<b>" * 50, "today": -1e999},
                                                      "_last": ["not", "a", "dict"]}))
    state = lp.load()
    assert state["openrouter"]["rest_until"] == 0 and len(state["openrouter"]["why"]) <= lp.MAX_WHY
    assert state["_last"] == {"provider": "", "model": "", "at": 0.0}


def test_summary_shows_rests_and_todays_requests(monkeypatch, seen):
    monkeypatch.setattr(lp.time, "time", lambda: NOW)
    use(monkeypatch, "openrouter", "bazaarlink")
    seen.replies[url("openrouter")] = [Reply({}, 402)]
    seen.replies[url("bazaarlink")] = [answer("ok", "auto-picked/model")]
    lp.chat("s", "u")
    info = lp.summary(NOW)
    assert info["order"] == "cloud"
    assert info["providers"]["openrouter"]["why"] == "out of credits" and info["providers"]["openrouter"]["resting_until"]
    assert info["providers"]["bazaarlink"]["today"] == 1
    assert info["last"] == {"provider": "bazaarlink", "model": "auto-picked/model", "at": int(NOW * 1000)}
    assert lp.summary(lp.next_utc_day(NOW) + 1)["providers"]["openrouter"]["resting_until"] is None


# --------------------------------------------------------------------------- routing in hermes_common

def ollama_reply(content="from ollama"):
    return Reply({"message": {"content": content}})


def test_ollama_chat_asks_the_cloud_first_and_skips_ollama(monkeypatch, seen):
    use(monkeypatch, "openrouter")
    seen.replies[url("openrouter")] = [answer("Strong \u2014 apply")]
    assert hc.ollama_chat("http://ollama:11434", "m", "s", "u", 8192) == "Strong, apply"
    assert all("ollama" not in s["url"] for s in seen)


def test_ollama_chat_falls_back_to_ollama_when_the_cloud_is_out_of_credits(monkeypatch, seen):
    use(monkeypatch, "openrouter")
    seen.replies[url("openrouter")] = [Reply({}, 402)]
    seen.replies["http://ollama:11434/api/chat"] = [ollama_reply()]
    assert hc.ollama_chat("http://ollama:11434", "qwen3:4b", "s", "u", 8192) == "from ollama"
    assert lp.load()["_last"]["provider"] == "ollama" and lp.load()["_last"]["model"] == "qwen3:4b"


def test_local_first_asks_ollama_then_the_cloud(monkeypatch, seen):
    use(monkeypatch, "huggingface")
    monkeypatch.setenv("LLM_ORDER", "local")
    seen.replies["http://ollama:11434/api/chat"] = [requests.ConnectionError("down")]
    seen.replies[url("huggingface")] = [answer("from the cloud")]
    assert hc.ollama_chat("http://ollama:11434", "m", "s", "u", None) == "from the cloud"
    assert [s["url"] for s in seen] == ["http://ollama:11434/api/chat", url("huggingface")]


def test_no_ollama_and_no_cloud_answer_is_a_request_error(monkeypatch, seen):
    use(monkeypatch, "openrouter")
    seen.replies[url("openrouter")] = [Reply({}, 402)]
    with pytest.raises(requests.RequestException):
        hc.ollama_chat("", "m", "s", "u", None)


def test_connect_model_runs_cloud_only_when_no_ollama_answers(monkeypatch):
    monkeypatch.setattr(hc, "pick_ollama_host", lambda hosts, models: (_ for _ in ()).throw(RuntimeError("none")))
    with pytest.raises(RuntimeError):
        hc.connect_model("JOB_SCANNER_MODEL")
    use(monkeypatch, "bazaarlink")
    host, model, num_ctx = hc.connect_model("JOB_SCANNER_MODEL")
    assert host == "" and model and num_ctx


def test_connect_model_prefers_the_model_that_fits_the_machine(monkeypatch):
    seen = []
    monkeypatch.setattr(hc, "suggested_model", lambda: "qwen2.5:1.5b-instruct")
    monkeypatch.setattr(hc, "pick_ollama_host", lambda hosts, models: seen.append(models) or (hosts[0], models[0]))
    monkeypatch.delenv("OLLAMA_MODEL", raising=False)
    hc.connect_model("JOB_SCANNER_MODEL")
    assert seen[0][0] == "qwen2.5:1.5b-instruct" and seen[0][-1] == hc.DEFAULT_MODEL
    monkeypatch.setenv("OLLAMA_MODEL", "llama3.2:3b")
    hc.connect_model("JOB_SCANNER_MODEL")
    assert seen[1][0] == "llama3.2:3b"


def test_the_status_command_prints_no_part_of_any_key(monkeypatch, capsys):
    monkeypatch.setattr(hc, "load_env_file", lambda *a, **k: None)
    for name, value in KEYS.items():
        monkeypatch.setenv(f"{name.upper()}_API_KEY", value)
    assert lp.main() == 0
    out = capsys.readouterr().out
    assert "OpenRouter" in out
    for value in KEYS.values():
        assert value[:3] not in out and value[-4:] not in out

"""Unit tests for worker_link.py, the one client for the feedback Worker (no network).

Run from the repository root:  python -m pytest common/tests
"""

import hashlib
import hmac
import json
import sys
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hermes_common as hc  # noqa: E402
import worker_link as wl  # noqa: E402

BASE = "https://feedback.example.workers.dev"
TOKEN = "test-api-token-0001"
SECRET = "test-secret"


class Reply:
    def __init__(self, status=200, data=None, headers=None):
        self.status_code, self.data = status, data if data is not None else {}
        self.headers = {"X-HermitShell-Protocol": str(wl.PROTOCOL), **(headers or {})}

    def json(self):
        if isinstance(self.data, str):
            raise ValueError("not JSON")
        return self.data


@pytest.fixture(autouse=True)
def state(tmp_path, monkeypatch):
    monkeypatch.setattr(hc, "STATE_DIR", tmp_path)
    return tmp_path


class Wire:
    """Stands in for requests.get/post and records what would have been sent."""

    def __init__(self, monkeypatch, *replies):
        self.replies, self.calls = list(replies), []
        monkeypatch.setattr(wl.requests, "get", lambda url, **kw: self._send("GET", url, kw))
        monkeypatch.setattr(wl.requests, "post", lambda url, **kw: self._send("POST", url, kw))

    def _send(self, method, url, kw):
        self.calls.append((method, url, kw))
        reply = self.replies.pop(0) if self.replies else Reply()
        if isinstance(reply, Exception):
            raise reply
        return reply


def link(**kw):
    waits = []
    made = wl.Link(BASE, TOKEN, secret=kw.pop("secret", SECRET), sleep=waits.append, clock=kw.pop("clock", lambda: 1_790_000_000.0), **kw)
    return made, waits


@pytest.mark.parametrize("url,ok", [
    ("https://feedback.example.workers.dev/", True), ("HTTPS://feedback.example.workers.dev", True),
    ("http://localhost:8787", True), ("http://127.0.0.1:8787", True), ("http://[::1]:8787", True),
    ("http://feedback.example.workers.dev", False), ("ftp://feedback.example.workers.dev", False),
    ("feedback.example.workers.dev", False), ("", False), ("https://", False), ("http://[::1", False)])
def test_only_https_or_this_machine(url, ok):
    assert bool(wl.secure_base(url)) is ok


def test_refuses_plain_http_so_the_token_is_never_sent_in_clear(monkeypatch):
    wire = Wire(monkeypatch)
    with pytest.raises(wl.WorkerError, match="https"):
        wl.Link("http://feedback.example.workers.dev", TOKEN)
    assert wire.calls == []


def test_signs_the_same_message_as_the_worker():
    key = wl.signing_key(SECRET)
    assert key == hmac.new(SECRET.encode(), b"hermitshell api v1", hashlib.sha256).digest()
    assert wl.signature(key, "post", "/ack?x=1", 1790000000000, "0123456789abcdef0123456789abcdef",
                        b'{"ids":["a"]}') == "ed9149b6ac2cff3537a05145cd562d56126dd4371e77a457118b64c35ddcd7c9"


def test_each_request_carries_the_token_protocol_and_a_fresh_signature(monkeypatch):
    wire = Wire(monkeypatch, Reply(data={"items": []}), Reply())
    made, _ = link()
    assert made.json("GET", "/api/queue", params={"limit": 50}) == {"items": []}
    made.request("POST", "/ack", json_body={"ids": ["event:_:1:abc"]})
    (m1, url1, kw1), (m2, _, kw2) = wire.calls
    assert (m1, url1, kw1["params"], kw1["allow_redirects"]) == ("GET", f"{BASE}/api/queue", {"limit": 50}, False)
    h1, h2 = kw1["headers"], kw2["headers"]
    assert h1["Authorization"] == f"Bearer {TOKEN}"
    assert h1["X-HermitShell-Protocol"] == str(wl.PROTOCOL) and h1["User-Agent"] == f"HermitShell/{wl.PROTOCOL}"
    assert h1["X-HermitShell-Time"] == "1790000000000"
    assert h1["X-HermitShell-Nonce"] != h2["X-HermitShell-Nonce"]
    key = wl.signing_key(SECRET)
    assert h1["X-HermitShell-Signature"] == "v1=" + wl.signature(key, "GET", "/api/queue?limit=50", 1790000000000,
                                                                h1["X-HermitShell-Nonce"], b"")
    assert kw2["data"] == b'{"ids":["event:_:1:abc"]}' and h2["Content-Type"] == "application/json"
    assert h2["X-HermitShell-Signature"] == "v1=" + wl.signature(key, "POST", "/ack", 1790000000000,
                                                                h2["X-HermitShell-Nonce"], kw2["data"])


def test_without_a_secret_it_sends_the_token_alone(monkeypatch):
    wire = Wire(monkeypatch)
    link(secret="")[0].request("GET", "/events")
    assert "X-HermitShell-Signature" not in wire.calls[0][2]["headers"]


def test_never_follows_a_redirect(monkeypatch):
    Wire(monkeypatch, Reply(302, headers={"Location": "https://elsewhere.example/"}))
    with pytest.raises(wl.WorkerError, match="redirected"):
        link()[0].request("GET", "/api/queue")


def test_retries_busy_answers_honouring_retry_after_up_to_a_limit(monkeypatch):
    wire = Wire(monkeypatch, Reply(503), Reply(429, headers={"Retry-After": "7"}), Reply(data={"ok": True}))
    made, waits = link()
    assert made.json("GET", "/api/queue") == {"ok": True}
    assert len(wire.calls) == 3 and waits == [1, 7]
    Wire(monkeypatch, Reply(429, headers={"Retry-After": "86400"}), Reply())
    made, waits = link()
    made.request("GET", "/api/queue")
    assert waits == [wl.MAX_WAIT]


def test_gives_up_after_three_attempts_with_a_safe_message(monkeypatch):
    wire = Wire(monkeypatch, Reply(502), Reply(502), Reply(502))
    with pytest.raises(wl.WorkerError) as err:
        link()[0].request("GET", "/api/queue")
    assert len(wire.calls) == wl.ATTEMPTS
    assert str(err.value) == "feedback Worker answered HTTP 502" and err.value.response.status_code == 502


def test_retries_a_dropped_connection_but_not_a_request_that_must_not_repeat(monkeypatch):
    wire = Wire(monkeypatch, requests.ConnectionError("reset"), Reply(data={"link": "x"}))
    made, waits = link()
    assert made.json("POST", "/api/invite", json_body={}) == {"link": "x"}
    assert waits == [1] and len(wire.calls) == 2
    wire = Wire(monkeypatch, requests.ConnectionError("reset"), Reply())
    with pytest.raises(wl.WorkerError, match=r"unreachable \(ConnectionError\)"):
        link()[0].request("POST", "/api/invite", json_body={}, retry=False)
    assert len(wire.calls) == 1
    wire = Wire(monkeypatch, Reply(503), Reply())
    with pytest.raises(wl.WorkerError, match="HTTP 503"):
        link()[0].request("POST", "/api/invite", json_body={}, retry=False)


def test_a_client_error_is_not_retried(monkeypatch):
    wire = Wire(monkeypatch, Reply(401), Reply())
    with pytest.raises(wl.WorkerError, match="HTTP 401"):
        link()[0].request("GET", "/api/queue")
    assert len(wire.calls) == 1


def test_errors_and_repr_never_show_the_token_or_secret(monkeypatch):
    Wire(monkeypatch, requests.ConnectionError(f"failed for {BASE}?token={TOKEN}"), requests.ConnectionError("again"),
         requests.ConnectionError("again"))
    made, _ = link()
    with pytest.raises(wl.WorkerError) as err:
        made.request("GET", "/api/queue")
    shown = f"{err.value} {made!r} {wl.reason(err.value)}"
    assert TOKEN not in shown and SECRET not in shown
    assert wl.reason(ValueError(TOKEN)) == "ValueError"


def test_non_json_is_a_worker_error(monkeypatch):
    Wire(monkeypatch, Reply(data="<html>"))
    with pytest.raises(wl.WorkerError, match="other than JSON"):
        link()[0].json("GET", "/api/queue")


def test_remembers_the_workers_protocol_and_logs_a_mismatch(monkeypatch, state):
    logged = []
    monkeypatch.setattr(hc, "log", logged.append)
    Wire(monkeypatch, Reply(), Reply(headers={"X-HermitShell-Protocol": "1"}), Reply(headers={"X-HermitShell-Protocol": "1"}))
    made, _ = link()
    made.request("GET", "/events")
    assert wl.worker_protocol()["protocol"] == wl.PROTOCOL and logged == []
    made.request("GET", "/events")
    made.request("GET", "/events")
    assert json.loads((state / wl.STATE_NAME).read_text())["protocol"] == 1
    assert len(logged) == 1 and "older than HermitShell: redeploy it" in logged[0]


def test_protocol_state_ignores_anything_odd(state):
    assert wl.worker_protocol() == {}
    (state / wl.STATE_NAME).write_text('{"protocol": "2"}')
    assert wl.worker_protocol() == {}
    (state / wl.STATE_NAME).write_text("not json")
    assert wl.worker_protocol() == {}


def test_from_env_needs_an_https_url_and_a_token(monkeypatch):
    settings = {"JOB_FEEDBACK_URL": BASE, "JOB_FEEDBACK_API_TOKEN": TOKEN}
    monkeypatch.setattr(hc, "env", lambda name, default=None: settings.get(name, default))
    assert wl.from_env().base == BASE
    settings["JOB_FEEDBACK_URL"] = "http://feedback.example.workers.dev"
    assert wl.from_env() is None
    settings.update(JOB_FEEDBACK_URL=BASE, JOB_FEEDBACK_API_TOKEN="")
    assert wl.from_env() is None

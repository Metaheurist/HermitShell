"""Unit tests for the shared hermes_common library.

Run from the repository root:  python -m pytest common/tests
"""

import contextlib
import json
import os
import re
import sys
import threading
import time
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hermes_common as hc  # noqa: E402


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


# --------------------------------------------------------------------------- config

def test_load_env_file_parses_quotes_and_keeps_existing_values(tmp_path, monkeypatch):
    keys = ("HC_TEST_EXPORTED", "HC_TEST_SINGLE", "HC_TEST_PLAIN", "HC_TEST_EMPTY", "HC_TEST_PRESET")
    for key in keys:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("HC_TEST_PRESET", "from process")
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# comment\n"
        'export HC_TEST_EXPORTED="quoted value"\n'
        "HC_TEST_SINGLE='single # not a comment'\n"
        "HC_TEST_PLAIN=plain\n"
        "HC_TEST_EMPTY=\n"
        "HC_TEST_PRESET=from file\n"
        "not a setting\n",
        encoding="utf-8",
    )
    try:
        hc.load_env_file(env_file)
        assert os.environ["HC_TEST_EXPORTED"] == "quoted value"
        assert os.environ["HC_TEST_SINGLE"] == "single # not a comment"
        assert os.environ["HC_TEST_PLAIN"] == "plain"
        assert "HC_TEST_EMPTY" not in os.environ
        assert os.environ["HC_TEST_PRESET"] == "from process"
    finally:
        for key in keys:
            os.environ.pop(key, None)


def test_load_env_file_ignores_a_missing_file(tmp_path):
    hc.load_env_file(tmp_path / "missing.env")


def test_env_helpers(monkeypatch):
    monkeypatch.setenv("HC_TEST_TEXT", "  value  ")
    monkeypatch.setenv("HC_TEST_BLANK", "   ")
    monkeypatch.setenv("HC_TEST_INT", "42")
    monkeypatch.setenv("HC_TEST_BAD_INT", "forty")
    monkeypatch.setenv("HC_TEST_YES", "Yes")
    monkeypatch.setenv("HC_TEST_OFF", "off")
    monkeypatch.delenv("HC_TEST_UNSET", raising=False)
    assert hc.env("HC_TEST_TEXT") == "value"
    assert hc.env("HC_TEST_BLANK", "fallback") == "fallback"
    assert hc.env_int("HC_TEST_INT", 1) == 42
    assert hc.env_int("HC_TEST_BAD_INT", 7) == 7
    assert hc.env_bool("HC_TEST_YES", False) is True
    assert hc.env_bool("HC_TEST_OFF", True) is False
    assert hc.env_bool("HC_TEST_UNSET", True) is True


def test_firecrawl_keys_combines_main_and_backup_keys(monkeypatch):
    monkeypatch.setenv("FIRECRAWL_API_KEY", "key-a")
    monkeypatch.setenv("FIRECRAWL_BACKUP_KEYS", " key-b, ,key-c ")
    assert hc.firecrawl_keys() == ["key-a", "key-b", "key-c"]


def test_model_config_reads_an_old_config_yaml(tmp_path, monkeypatch):
    (tmp_path / "config.yaml").write_text(
        "model:\n  default: qwen3:4b\n  base_url: http://ollama:11434/v1\n  ollama_num_ctx: 16384\n",
        encoding="utf-8")
    monkeypatch.setattr(hc, "APP_HOME", tmp_path)
    for key in ("OLLAMA_MODEL", "OLLAMA_HOST", "OLLAMA_NUM_CTX"):
        monkeypatch.delenv(key, raising=False)
    assert hc.model_config() == {"model": "qwen3:4b", "host": "http://ollama:11434", "num_ctx": 16384}
    monkeypatch.setenv("OLLAMA_MODEL", "llama3:8b")
    monkeypatch.setenv("OLLAMA_HOST", "http://gpu:11434/")
    monkeypatch.setenv("OLLAMA_NUM_CTX", "8192")
    assert hc.model_config() == {"model": "llama3:8b", "host": "http://gpu:11434", "num_ctx": 8192}


def test_model_config_without_a_config_file(tmp_path, monkeypatch):
    monkeypatch.setattr(hc, "APP_HOME", tmp_path)
    for key in ("OLLAMA_MODEL", "OLLAMA_HOST", "OLLAMA_NUM_CTX"):
        monkeypatch.delenv(key, raising=False)
    assert hc.model_config() == {"model": "", "host": "", "num_ctx": None}
    assert hc.ollama_hosts(hc.model_config()) == ["http://localhost:11434", "http://ollama:11434",
                                                   "http://host.docker.internal:11434"]


def test_connect_model_prefers_the_settings_and_keeps_their_context_size(tmp_path, monkeypatch):
    monkeypatch.setattr(hc, "APP_HOME", tmp_path)
    monkeypatch.setenv("OLLAMA_HOST", "http://gpu:11434")
    monkeypatch.setenv("OLLAMA_MODEL", "llama3:8b")
    monkeypatch.setenv("OLLAMA_NUM_CTX", "16384")
    monkeypatch.delenv("JOB_SCANNER_MODEL", raising=False)
    seen = []
    monkeypatch.setattr(hc, "pick_ollama_host", lambda hosts, models: seen.append((hosts, models)) or (hosts[0], models[0]))
    assert hc.connect_model("JOB_SCANNER_MODEL") == ("http://gpu:11434", "llama3:8b", 16384)
    assert seen[0][1] == ["llama3:8b", hc.DEFAULT_MODEL]
    monkeypatch.setenv("JOB_SCANNER_MODEL", "qwen3:8b")
    assert hc.connect_model("JOB_SCANNER_MODEL") == ("http://gpu:11434", "qwen3:8b", 8192)


def test_the_home_folder_is_hermitshells_own(tmp_path):
    import subprocess
    code = "import hermes_common as hc; print(hc.APP_HOME, hc.HERMES_HOME == hc.APP_HOME)"
    env = {k: v for k, v in hc.os.environ.items() if k not in ("HERMITSHELL_HOME", "HERMES_HOME")}
    run = lambda **extra: subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True,  # noqa: E731
                                         cwd=str(Path(__file__).resolve().parents[1]), env={**env, **extra}).stdout.split()
    assert run(HERMITSHELL_HOME=str(tmp_path / "new"), HERMES_HOME=str(tmp_path / "old")) == [str(tmp_path / "new"), "True"]
    assert run(HERMES_HOME=str(tmp_path / "old")) == [str(tmp_path / "old"), "True"]


# --------------------------------------------------------------------------- text and URLs

def test_normalize_url_drops_tracking_parameters_and_www():
    url = "HTTPS://WWW.Example.com/jobs/1/?utm_source=x&id=5&gclid=abc#top"
    assert hc.normalize_url(url) == "https://example.com/jobs/1?id=5"


def test_search_operators_are_split_out_of_the_query():
    text, include, exclude = hc._search_operators('("AI engineer" OR MLOps) Belfast site:nijobs.com -site:linkedin.com')
    assert text == '"AI engineer" MLOps Belfast'
    assert include == ["nijobs.com"]
    assert exclude == ["linkedin.com"]


@pytest.mark.parametrize("raw, expected", [
    ("Built 2020\u20132024 \u2014 fast \u2013 and cheap", "Built 2020-2024, fast, and cheap"),
    ("Salary 40\u201350k", "Salary 40-50k"),
    ("No dashes here.", "No dashes here."),
])
def test_plain_dashes(raw, expected):
    assert hc.plain_dashes(raw) == expected


def test_model_json_is_undashed_recursively():
    assert hc._undash({"a": ["x \u2014 y"], "b": 3}) == {"a": ["x, y"], "b": 3}


def test_first_sentences():
    assert hc.first_sentences("One.  Two!\nThree? Four.", 2) == "One. Two!"
    assert hc.first_sentences("A long sentence without an end", 1, max_chars=6) == "A long"


def test_html_to_text_keeps_structure_and_drops_scripts():
    page = ("<h2>Title</h2><p>Hello <b>world</b></p><script>track()</script>"
            "<ul><li>first</li><li>second</li></ul>")
    assert hc.html_to_text(page) == "## Title\n\nHello world\n\n- first\n- second"


def test_email_header_escapes_text_and_highlights_one_figure():
    header = hc.email_header("Belfast & NI", "Monday", "Daily <Report>", "Roles", [(8, "Matches"), ("6.2", "Fit")],
                             highlight=1)
    assert header.startswith("<tr><td") and header.endswith("</td></tr>") and 'class="gmail-screen"' in header
    assert "Belfast &amp; NI" in header and "Daily &lt;Report&gt;" in header and "gradient" not in header
    assert header.count('width="50%"') == 2 and header.count("#6ee7b7") == 1
    assert header.index("#6ee7b7") > header.index(">8<")


def test_email_head_narrows_the_email_on_phones_in_its_own_style_block():
    blocks = re.findall(r"<style>(.*?)</style>", hc.EMAIL_HEAD, flags=re.S)
    assert len(blocks) == 2 and "@media" not in blocks[0]
    phone = blocks[1]
    assert phone.strip().startswith("@media only screen and (max-width:540px)")
    for cls in ("m-wrap", "m-pad", "m-head", "m-stack", "m-sep", "m-num", "m-flush", "m-title", "m-score", "m-label"):
        assert f".{cls} {{" in phone, cls
    rules = re.findall(r"\.m-[a-z]+ \{([^}]*)\}", phone)
    assert rules and all(all(d.strip().endswith("!important") for d in r.split(";") if d.strip()) for r in rules)
    assert len(phone) <= hc.STYLE_BLOCK_MAX and not re.search(r"url\(|gradient|background-image", phone)
    assert sum(len(b) for b in blocks) + hc.STYLE_TOTAL_MAX <= 16_384


def test_email_header_stacks_its_top_line_on_phones():
    header = hc.email_header("Northern Ireland", "Tuesday 29 September", "Report", "Roles", [(1, "A"), (2, "B")])
    assert header.count('class="m-stack"') == 2 and 'class="m-head"' in header
    assert header.count('class="m-num"') == 2 and header.count('class="m-sep"') == 1


def test_gmail_dark_safe_wraps_content_in_blend_layers():
    wrapped = hc.gmail_dark_safe("<b>hi</b>")
    assert wrapped.startswith('<div class="gmail-screen"><div class="gmail-difference">')
    assert "<b>hi</b>" in wrapped


def test_inline_images_only_returns_referenced_files_that_exist(tmp_path):
    (tmp_path / "logo.png").write_bytes(b"png-bytes")
    (tmp_path / "unused.png").write_bytes(b"other")
    page = '<img src="cid:logo"><img src="cid:missing">'
    assert hc.inline_images(page, tmp_path) == {"logo": b"png-bytes"}


def _report(cards: int) -> str:
    card = ('<table style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;margin:0 0 18px">\n'
            '  <tr><td style="padding:22px 24px;font-size:14px;color:#334155;line-height:1.5">Job {n}</td></tr>\n'
            '  <tr><td style="background-image:linear-gradient(#000,#fff);padding:4px">Header {n}</td></tr>\n'
            '  <tr><td class="gmail-screen" style="padding:22px 24px;font-size:14px;color:#334155">Dark {n}</td></tr>\n'
            '</table>\n')
    return f"<html><head>{hc.EMAIL_HEAD}</head><body>{''.join(card.format(n=n) for n in range(cards))}</body></html>"


def test_compact_html_leaves_emails_under_budget_alone():
    page = _report(3)
    assert hc.compact_html(page) == page


def test_compact_html_moves_repeated_styles_into_gmail_safe_classes():
    page = _report(400)
    small = hc.compact_html(page, budget=0)
    assert hc.html_size(small) < hc.html_size(page) * 0.7
    assert hc.html_to_text(small) == hc.html_to_text(page)
    blocks = re.findall(r"<style>(.*?)</style>", small, flags=re.S)
    added = blocks[hc.EMAIL_HEAD.count("<style>"):]
    assert added and all(len(b) <= hc.STYLE_BLOCK_MAX for b in added)
    assert sum(len(b) for b in added) <= hc.STYLE_TOTAL_MAX
    assert not any(re.search(r"url\(|gradient|background-image", b) for b in added)
    assert small.count('style="background-image:linear-gradient(#000,#fff);padding:4px"') == 400
    assert small.count('class="gmail-screen" style="padding:22px 24px;font-size:14px;color:#334155"') == 400
    assert 'class="h0"' in small


# --------------------------------------------------------------------------- model

def test_pick_ollama_host_skips_unreachable_hosts(monkeypatch):
    def fake_get(url, timeout):
        if url.startswith("http://down"):
            raise requests.ConnectionError("refused")
        return FakeResponse({"models": [{"name": "llama3"}, {"name": "qwen3:4b"}]})

    monkeypatch.setattr(hc.requests, "get", fake_get)
    assert hc.pick_ollama_host(["http://down:11434", "http://up:11434/", ""], ["missing", "qwen3:4b"]) == \
        ("http://up:11434", "qwen3:4b")


def test_pick_ollama_host_raises_when_no_model_is_available(monkeypatch):
    monkeypatch.setattr(hc.requests, "get", lambda url, timeout: FakeResponse({"models": []}))
    with pytest.raises(RuntimeError):
        hc.pick_ollama_host(["http://up:11434"], ["qwen3:4b"])


def test_ollama_chat_sends_options_and_cleans_the_reply(monkeypatch):
    sent = {}

    def fake_post(url, json, timeout):
        sent.update(url=url, body=json)
        return FakeResponse({"message": {"content": "Great fit \u2014 apply today"}})

    monkeypatch.setattr(hc.requests, "post", fake_post)
    reply = hc.ollama_chat("http://ollama:11434", "qwen3:4b", "system", "user", 8192, num_predict=50)
    assert reply == "Great fit, apply today"
    assert sent["url"] == "http://ollama:11434/api/chat"
    assert sent["body"]["options"] == {"temperature": 0, "num_predict": 50, "num_ctx": 8192}
    assert [m["role"] for m in sent["body"]["messages"]] == ["system", "user"]


def test_ollama_chat_with_a_schema_returns_undashed_json(monkeypatch):
    content = json.dumps({"reason": "Strong \u2014 but junior"})
    monkeypatch.setattr(hc.requests, "post", lambda url, json, timeout: FakeResponse({"message": {"content": content}}))
    reply = hc.ollama_chat("http://ollama:11434", "m", "s", "u", None, fmt={"type": "object"})
    assert json.loads(reply) == {"reason": "Strong, but junior"}


def test_ollama_chat_waits_for_its_turn_in_the_shared_queue(monkeypatch):
    events = []

    @contextlib.contextmanager
    def turn(**_):
        events.append("queued")
        yield 0
        events.append("done")

    def fake_post(url, json, timeout):
        events.append("request")
        return FakeResponse({"message": {"content": "ok"}})

    monkeypatch.setattr(hc, "model_turn", turn)
    monkeypatch.setattr(hc.requests, "post", fake_post)
    hc.ollama_chat("http://ollama:11434", "m", "s", "u", None)
    assert events == ["queued", "request", "done"]


def _tickets(folder):
    return [p for p in folder.iterdir() if re.fullmatch(r"[01]-\d{20}-[0-9a-f]{6}", p.name)]


def _wait_until(condition, seconds=5.0):
    deadline = time.monotonic() + seconds
    while not condition():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.02)


def test_model_requests_take_turns_waiting_ones_first_then_by_arrival(tmp_path, monkeypatch):
    pytest.importorskip("fcntl")
    monkeypatch.setattr(hc, "MODEL_QUEUE_DIR", tmp_path)
    order, release = [], threading.Event()

    def run(name, priority, hold=False):
        with hc.model_turn(priority):
            order.append(name)
            if hold:
                release.wait(5)

    threads = [threading.Thread(target=run, args=("running", 1, True))]
    threads[0].start()
    _wait_until(lambda: order == ["running"])
    for n, (name, priority) in enumerate([("background", 1), ("background 2", 1), ("cover letter", 0)], start=2):
        threads.append(threading.Thread(target=run, args=(name, priority)))
        threads[-1].start()
        _wait_until(lambda n=n: len(_tickets(tmp_path)) == n)
    release.set()
    for t in threads:
        t.join(10)
    assert order == ["running", "cover letter", "background", "background 2"]
    assert _tickets(tmp_path) == []


def test_a_crashed_process_ticket_does_not_block_the_queue(tmp_path, monkeypatch):
    pytest.importorskip("fcntl")
    monkeypatch.setattr(hc, "MODEL_QUEUE_DIR", tmp_path)
    abandoned = tmp_path / f"0-{1:020d}-abcdef"
    abandoned.write_text("")
    with hc.model_turn(1):
        assert not abandoned.exists()


def test_model_concurrency_lets_that_many_requests_run_at_once(tmp_path, monkeypatch):
    pytest.importorskip("fcntl")
    monkeypatch.setattr(hc, "MODEL_QUEUE_DIR", tmp_path)
    monkeypatch.setenv("HERMES_MODEL_CONCURRENCY", "2")
    together = threading.Barrier(2, timeout=5)
    errors = []

    def run():
        with hc.model_turn(1):
            try:
                together.wait()
            except threading.BrokenBarrierError as exc:
                errors.append(exc)

    threads = [threading.Thread(target=run) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert errors == []


def test_fit_ctx_keeps_the_configured_size_unless_the_prompt_needs_more():
    assert hc.fit_ctx(8192, "x" * 3000, num_predict=500) == 8192
    assert hc.fit_ctx(None, "x" * 3000, num_predict=500) is None
    assert hc.fit_ctx(4096, "x" * 30000, num_predict=2000) == 12288
    assert hc.fit_ctx(4096, "x" * 1_000_000) == 32768


def test_safe_url_only_allows_http_links_to_a_host():
    assert hc.safe_url(" https://jobs.example.com/job/1 ") == "https://jobs.example.com/job/1"
    for bad in ("javascript:alert(1)", "data:text/html,x", "https://", "//evil.example", "https://a b.example/"):
        assert hc.safe_url(bad) == ""


def test_mask_secret_shows_little_of_short_keys():
    assert hc.mask_secret("fc-" + "a" * 28 + "1234") == "fc-...1234"
    assert hc.mask_secret("short-key-1") == "****" and hc.mask_secret("") == ""


def test_write_atomic_creates_private_files_private(tmp_path):
    path = tmp_path / "state" / "secrets.json"
    hc.write_atomic(path, "{}")
    hc.write_atomic(path, '{"a": 1}')
    assert path.read_text() == '{"a": 1}' and [p.name for p in path.parent.iterdir()] == ["secrets.json"]
    if os.name == "posix":
        assert path.stat().st_mode & 0o777 == 0o600


def test_white_label_keeps_button_text_white_and_escaped():
    assert hc.white_label("View job") == '<span style="color:#ffffff">View job</span>'
    assert hc.white_label("<b>x</b>") == '<span style="color:#ffffff">&lt;b&gt;x&lt;/b&gt;</span>'


def test_run_lock_is_exclusive(tmp_path):
    with hc.run_lock(tmp_path / "x.lock") as first:
        assert first
        if os.name == "posix":
            with hc.run_lock(tmp_path / "x.lock") as second:
                assert not second


def test_dashboard_settings_cannot_set_paths_or_worker_secrets(tmp_path, monkeypatch):
    monkeypatch.setattr(hc.os, "environ", {})
    path = tmp_path / "dashboard.json"
    path.write_text(json.dumps({"env": {"JOB_MIN_SALARY": "30000", "SMTP_HOST": "smtp.example.com",
                                        "PATH": "/tmp/evil", "PYTHONPATH": "/tmp", "JOB_FEEDBACK_SECRET": "x",
                                        "JOB_PROFILE_FILE": "/etc/passwd", "HERMES_STATE_DIR": "/tmp"}}))
    hc.load_dashboard_settings(path)
    assert {k: v for k, v in hc.os.environ.items() if k != "HERMES_DASHBOARD_APPLIED"} == \
        {"JOB_MIN_SALARY": "30000", "SMTP_HOST": "smtp.example.com"}


class FakeSMTP:
    attempts = 0
    sent: list = []

    def __init__(self, host, port, timeout=None, context=None):
        FakeSMTP.attempts += 1
        if FakeSMTP.attempts == 1:
            raise hc.smtplib.SMTPServerDisconnected("dropped")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def ehlo(self):
        pass

    def starttls(self, context=None):
        pass

    def login(self, user, password):
        if password == "wrong":
            raise hc.smtplib.SMTPAuthenticationError(535, b"bad credentials")

    def send_message(self, msg):
        FakeSMTP.sent.append(msg)


@pytest.fixture
def smtp(monkeypatch):
    FakeSMTP.attempts, FakeSMTP.sent = 0, []
    monkeypatch.setattr(hc.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(hc, "SMTP_RETRY_PAUSES", (0, 0))
    for key, value in {"SMTP_USER": "me@example.com", "SMTP_PASSWORD": "app pass", "ALERT_EMAIL": "me@example.com",
                       "SMTP_PORT": "587", "SMTP_HOST": "smtp.example.com", "SMTP_FROM": ""}.items():
        monkeypatch.setenv(key, value)
    return FakeSMTP


def test_send_email_retries_a_dropped_connection_and_keeps_headers_on_one_line(smtp):
    hc.send_email("3 new jobs\nBcc: victim@example.com", "<p>hi</p>", "hi", "Job radar\r\nX-Evil: 1")
    assert smtp.attempts == 2
    msg = smtp.sent[0]
    assert msg["Subject"] == "3 new jobs Bcc: victim@example.com" and msg["Bcc"] is None
    assert msg["From"].startswith("Job radar X-Evil: 1 <") and msg["X-Evil"] is None


def test_send_email_does_not_retry_a_wrong_password(smtp, monkeypatch):
    smtp.attempts = 1
    monkeypatch.setenv("SMTP_PASSWORD", "wrong")
    with pytest.raises(hc.smtplib.SMTPAuthenticationError):
        hc.send_email("s", "<p>x</p>", "x", "n")
    assert smtp.attempts == 2

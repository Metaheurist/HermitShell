"""Unit tests for the shared hermes_common library.

Run from the repository root:  python -m pytest common/tests
"""

import json
import os
import re
import sys
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


def test_hermes_model_config_reads_config_yaml(tmp_path, monkeypatch):
    (tmp_path / "config.yaml").write_text(
        "model:\n  default: qwen3:4b\n  base_url: http://ollama:11434/v1\n  ollama_num_ctx: 16384\n",
        encoding="utf-8")
    monkeypatch.setattr(hc, "HERMES_HOME", tmp_path)
    assert hc.hermes_model_config() == {"model": "qwen3:4b", "host": "http://ollama:11434", "num_ctx": 16384}


def test_hermes_model_config_without_a_config_file(tmp_path, monkeypatch):
    monkeypatch.setattr(hc, "HERMES_HOME", tmp_path)
    assert hc.hermes_model_config() == {"model": "", "host": "", "num_ctx": None}


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
    added = blocks[1:]
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

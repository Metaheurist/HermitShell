"""Unit tests for companies: fetches stay on public hosts and within size limits."""

import sys
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import companies  # noqa: E402


class FakeResponse:
    def __init__(self, status=200, headers=None, body=b""):
        self.status_code, self.headers, self.body = status, headers or {}, body
        self.is_redirect = status in (301, 302, 303, 307, 308)

    def iter_content(self, size):
        for i in range(0, len(self.body), size):
            yield self.body[i:i + size]

    def close(self):
        pass


class FakeSession:
    def __init__(self, responses):
        self.responses, self.urls = responses, []

    def get(self, url, **kwargs):
        assert kwargs["allow_redirects"] is False and kwargs["stream"] is True
        self.urls.append(url)
        return self.responses[url]


@pytest.fixture
def public(monkeypatch):
    monkeypatch.setattr(companies, "public_host", lambda host: not host.endswith(".internal"))


@pytest.mark.parametrize("host", ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.0.10", "::1", "localhost"])
def test_private_and_local_hosts_are_refused(host):
    assert not companies.public_host(host)


def test_only_http_urls_on_public_hosts(public):
    session = FakeSession({})
    for url in ("file:///etc/passwd", "ftp://example.com/x", "https://db.internal/", "https:///nohost"):
        assert companies.safe_get(session, url, 1000) is None
    assert session.urls == []


def test_redirects_are_checked_too(public):
    session = FakeSession({
        "https://example.com/logo": FakeResponse(302, {"location": "http://metadata.internal/latest"}),
    })
    assert companies.safe_get(session, "https://example.com/logo", 1000) is None
    assert session.urls == ["https://example.com/logo"]
    hops = {f"https://example.com/{i}": FakeResponse(302, {"location": f"/{i + 1}"}) for i in range(5)}
    assert companies.safe_get(FakeSession(hops), "https://example.com/0", 1000) is None


def test_bodies_are_capped(public):
    big = FakeSession({"https://example.com/": FakeResponse(body=b"x" * 5000)})
    assert companies.safe_get(big, "https://example.com/", 1000) is None
    declared = FakeSession({"https://example.com/": FakeResponse(headers={"content-length": "999999"})})
    assert companies.safe_get(declared, "https://example.com/", 1000) is None
    ok = FakeSession({"https://example.com/a": FakeResponse(302, {"location": "/b"}),
                      "https://example.com/b": FakeResponse(body=b"hello")})
    assert companies.safe_get(ok, "https://example.com/a", 1000)._content == b"hello"


def test_visible_text_skips_scripts_and_styles():
    page = "<html><style>p{}</style><script>var a='<p>Contoso</p>';</script><p>Northwind &amp; Co</p>" + "<script>" * 5000
    assert companies.visible_text(page).strip() == "Northwind & Co"

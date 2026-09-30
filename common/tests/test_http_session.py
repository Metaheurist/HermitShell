"""hermes_common.http(): one keep-alive session per thread, keeping no cookies."""
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hermes_common as hc  # noqa: E402


@pytest.fixture
def server():
    ports = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):  # noqa: N802
            ports.append(self.client_address[1])
            body = self.headers.get("Cookie", "").encode()
            self.send_response(200)
            self.send_header("Set-Cookie", "sid=not-a-real-session; Path=/")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}/", ports
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture
def real_http(monkeypatch):
    """The root conftest points http() at the plain requests module for mocking; these tests need the real one."""
    monkeypatch.undo()
    hc._HTTP.__dict__.pop("session", None)
    yield hc.http
    hc._HTTP.__dict__.pop("session", None)


def test_repeat_calls_reuse_one_connection(server, real_http):
    url, ports = server
    for _ in range(3):
        assert real_http().get(url, timeout=5).status_code == 200
    assert len(ports) == 3
    assert len(set(ports)) == 1


def test_each_thread_gets_its_own_session(real_http):
    mine = real_http()
    assert real_http() is mine
    theirs = []
    worker = threading.Thread(target=lambda: theirs.append(real_http()))
    worker.start()
    worker.join()
    assert theirs[0] is not mine


def test_no_cookie_is_kept_or_sent_back(server, real_http):
    url, _ = server
    session = real_http()
    session.get(url, timeout=5)
    assert len(session.cookies) == 0
    assert session.get(url, timeout=5).text == ""

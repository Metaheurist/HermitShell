"""The one way HermitShell talks to its feedback Worker (feedback-worker/src/apiauth.js is the other end).

Every request goes over HTTPS (plain http only to this machine, for local testing), never follows a redirect, and
is retried with backoff when Cloudflare answers 429 or 5xx or the connection drops (Retry-After is honoured, up to
MAX_WAIT seconds). Besides the API token it carries an HMAC-SHA256 signature, under a key derived from
JOB_FEEDBACK_SECRET, over the method, path and query, a timestamp, a one-time nonce and the SHA-256 of the body.
The Worker refuses a signature older than five minutes, a nonce it has seen and, once it has seen one signed
request, any request without a signature, so a request copied from a log or the network can't be replayed or
altered even by someone who has the token.

Both sides state PROTOCOL. The Worker's is kept in state/worker_link.json, so doctor.py and the dashboard can say
when one side is older than the other instead of requests failing quietly.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from urllib.parse import urlsplit

import requests

import hermes_common as hc

PROTOCOL = 3
# The Worker version that has the Pipeline (interview, offer and placed, and the stats' board).
PIPELINE_PROTOCOL = 3
SIGN_CONTEXT = b"hermitshell api v1"
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})
ATTEMPTS = 3
MAX_WAIT = 30
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
STATE_NAME = "worker_link.json"
USER_AGENT = f"HermitShell/{PROTOCOL}"


_sleep = time.sleep


class WorkerError(requests.RequestException):
    """The Worker refused a request or could not be reached. Messages never include the token or the URL."""


def reason(exc: BaseException) -> str:
    """What went wrong, safe to log: WorkerError's own message, else just the exception's class."""
    return str(exc) if isinstance(exc, WorkerError) else exc.__class__.__name__


def secure_base(url: str) -> str:
    """The Worker's address without a trailing slash, or "" unless it is https:// (http:// only for this machine)."""
    base = (url or "").strip().rstrip("/")
    try:
        parts = urlsplit(base)
        host = parts.hostname or ""
    except ValueError:
        return ""
    if parts.scheme.lower() == "https" and host:
        return base
    return base if parts.scheme.lower() == "http" and host in LOCAL_HOSTS else ""


def signing_key(secret: str) -> bytes:
    return hmac.new(secret.encode(), SIGN_CONTEXT, hashlib.sha256).digest()


def signature(key: bytes, method: str, target: str, stamp: int, nonce: str, body: bytes) -> str:
    """Same message as signature() in apiauth.js: no field can contain a newline, so each has one reading."""
    message = "\n".join(("v1", method.upper(), target, str(stamp), nonce, hashlib.sha256(body).hexdigest()))
    return hmac.new(key, message.encode(), hashlib.sha256).hexdigest()


def worker_protocol() -> dict:
    """{"protocol": n, "at": seconds} from the Worker's last answer; {} before it has answered."""
    try:
        data = json.loads((hc.STATE_DIR / STATE_NAME).read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) and type(data.get("protocol")) is int else {}


def pipeline_ready() -> bool:
    """Whether the Worker has the Pipeline, so interview buttons and the board can be sent to it."""
    return worker_protocol().get("protocol", 0) >= PIPELINE_PROTOCOL


def _remember_protocol(value: int) -> None:
    if worker_protocol().get("protocol") == value:
        return
    path = hc.STATE_DIR / STATE_NAME
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"protocol": value, "at": int(time.time())}))
    except OSError:
        pass
    if value != PROTOCOL:
        older = "this Worker is older than HermitShell: redeploy it" if value < PROTOCOL \
            else "HermitShell is older than its Worker: update it"
        hc.log(f"Feedback Worker protocol {value}, HermitShell {PROTOCOL}: {older}")


class Link:
    def __init__(self, base: str, token: str, secret: str | None = None, timeout: int = 30,
                 sleep=None, clock=time.time):
        self.base = secure_base(base)
        if not self.base:
            raise WorkerError("JOB_FEEDBACK_URL must start with https://")
        self._token = token
        secret = hc.env("JOB_FEEDBACK_SECRET", "") if secret is None else secret
        self._key = signing_key(secret) if secret else b""
        self.timeout, self.sleep, self.clock = timeout, sleep or (lambda seconds: _sleep(seconds)), clock

    def __repr__(self) -> str:
        return f"Link({self.base!r})"

    def headers(self, method: str, target: str, body: bytes = b"") -> dict:
        """The token, protocol and (with JOB_FEEDBACK_SECRET) a fresh signature for one request."""
        out = {"Authorization": f"Bearer {self._token}", "User-Agent": USER_AGENT,
               "X-HermitShell-Protocol": str(PROTOCOL)}
        if self._key:
            stamp, nonce = int(self.clock() * 1000), secrets.token_hex(16)
            out.update({"X-HermitShell-Time": str(stamp), "X-HermitShell-Nonce": nonce,
                        "X-HermitShell-Signature": "v1=" + signature(self._key, method, target, stamp, nonce, body)})
        return out

    def _wait(self, resp, attempt: int) -> float:
        headers = getattr(resp, "headers", None) or {}
        asked = hc.retry_after(headers.get("Retry-After"), 0)
        return min(MAX_WAIT, max(asked, 2 ** (attempt - 1)))

    def request(self, method: str, path: str, *, params: dict | None = None, json_body=None, data: bytes | None = None,
                content_type: str = "", stream: bool = False, retry: bool = True, timeout: int | None = None):
        """One call to the Worker; raises WorkerError (a requests.RequestException) unless it answers 2xx.
        retry=False for requests that must not happen twice (creating an invite)."""
        method = method.upper()
        url = f"{self.base}{path}"
        body = json.dumps(json_body, separators=(",", ":")).encode() if json_body is not None else (data or b"")
        target = requests.Request(method, url, params=params).prepare().path_url
        send = requests.get if method == "GET" else requests.post if method == "POST" else None
        if send is None:
            raise WorkerError(f"unsupported method {method}")
        for attempt in range(1, ATTEMPTS + 1):
            headers = self.headers(method, target, body)
            if json_body is not None:
                headers["Content-Type"] = "application/json"
            elif content_type:
                headers["Content-Type"] = content_type
            kwargs = {"params": params, "headers": headers, "timeout": timeout or self.timeout,
                      "allow_redirects": False, "stream": stream}
            if method == "POST":
                kwargs["data"] = body
            try:
                resp = send(url, **kwargs)
            except (requests.ConnectionError, requests.Timeout) as exc:
                if not retry or attempt == ATTEMPTS:
                    raise WorkerError(f"feedback Worker unreachable ({exc.__class__.__name__})") from None
                self.sleep(2 ** (attempt - 1))
                continue
            code = int(getattr(resp, "status_code", 200) or 200)
            got = (getattr(resp, "headers", None) or {}).get("X-HermitShell-Protocol", "")
            if str(got).isdigit():
                _remember_protocol(int(got))
            if code in RETRY_STATUS and retry and attempt < ATTEMPTS:
                self.sleep(self._wait(resp, attempt))
                continue
            if 300 <= code < 400:
                raise WorkerError(f"feedback Worker redirected (HTTP {code}); check JOB_FEEDBACK_URL", response=resp)
            if code >= 400:
                raise WorkerError(f"feedback Worker answered HTTP {code}", response=resp)
            return resp
        raise WorkerError("feedback Worker unreachable")

    def json(self, method: str, path: str, **kwargs) -> dict:
        try:
            data = self.request(method, path, **kwargs).json()
        except ValueError:
            raise WorkerError("feedback Worker sent something other than JSON") from None
        return data if isinstance(data, dict) else {}


def from_env(timeout: int = 30) -> Link | None:
    """A Link from JOB_FEEDBACK_URL and JOB_FEEDBACK_API_TOKEN; None when either is missing or the URL isn't https."""
    base, token = hc.env("JOB_FEEDBACK_URL", "") or "", hc.env("JOB_FEEDBACK_API_TOKEN", "") or ""
    if not (secure_base(base) and token):
        return None
    return Link(base, token, timeout=timeout)

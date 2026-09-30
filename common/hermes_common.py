"""Shared plumbing for HermitShell packages (the scripts scheduler.py runs).

.env loading, model discovery, web data providers (Firecrawl with
backup-key failover, then Tavily and Scrapfly as backups), Ollama chat helper
and SMTP sending with inline images. Every setting comes from environment
variables or $HERMITSHELL_HOME/.env; see docs/configuration.md.
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import html
import json
import os
import re
import secrets
import smtplib
import ssl
import sys
import time
from collections import Counter
from email.message import EmailMessage
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Packages doctor.py installed because the system Python lacked them. They live next to the scripts, on the data
# volume, so they survive updates; one folder per Python version, since compiled wheels are tied to it.
DEPS_DIR = Path(__file__).resolve().parent / ".deps" / f"py{sys.version_info[0]}.{sys.version_info[1]}"
if DEPS_DIR.is_dir() and str(DEPS_DIR) not in sys.path:
    sys.path.insert(0, str(DEPS_DIR))

import requests  # noqa: E402

SCRIPT_DIR = Path(__file__).resolve().parent
# HermitShell's home: .env, cron/ (the scheduler's jobs), backups/ and scripts/ with its state. HERMES_HOME is the
# name older installs, made when HermitShell ran inside Hermes, still set.
APP_HOME = Path(os.environ.get("HERMITSHELL_HOME") or os.environ.get("HERMES_HOME") or SCRIPT_DIR.parent)
HERMES_HOME = APP_HOME
# Reports, trackers, CVs and letters hold personal data: files the scripts create are readable by their owner only.
os.umask(0o077)

FIRECRAWL = "https://api.firecrawl.dev/v1"
TAVILY = "https://api.tavily.com"
SCRAPFLY = "https://api.scrapfly.io"
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/128.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
}
DEFAULT_MODEL = "qwen3:4b-instruct-2507-q4_K_M"

LOG_TAG = "hermitshell"
TRACKING_PARAMS = {"cid", "source", "ref", "trk", "gh_src", "fbclid", "gclid", "mc_cid", "mc_eid"}


def log(msg: str) -> None:
    print(f"[{LOG_TAG}] {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- config

def load_env_file(path: Path = APP_HOME / ".env") -> None:
    """Minimal .env loader; values already present in the process env win."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:]
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and value and key not in os.environ:
            os.environ[key] = value


DASHBOARD_FILE = Path(os.environ.get("HERMES_DASHBOARD_FILE") or SCRIPT_DIR / "state" / "dashboard.json")
_ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
# The dashboard may only change report, search, email and crawler settings, never paths, the Worker secrets or
# the exchange-rate address the server fetches from.
_DASHBOARD_PREFIXES = ("ALERT_", "BAZAARLINK_", "COVER_LETTER_", "FEATHERLESS_", "FIRECRAWL_", "HUGGINGFACE_", "JOB_",
                       "LLM_", "OPENROUTER_", "SCRAPFLY_", "SMTP_", "TAVILY_")
_DASHBOARD_DENIED = re.compile(r"^JOB_FEEDBACK_|_(FILE|DIR|PATH)$|^JOB_PROFILE_ID$|^JOB_FX_")


def dashboard_key_allowed(key: str) -> bool:
    return bool(_ENV_KEY_RE.match(key)) and key.startswith(_DASHBOARD_PREFIXES) and not _DASHBOARD_DENIED.search(key)


def load_dashboard_settings(path: Path = DASHBOARD_FILE) -> None:
    """Settings saved from the feedback Worker's dashboard beat .env and the inherited environment. A process
    whose parent already applied them (HERMES_DASHBOARD_APPLIED) keeps the environment its parent chose."""
    if os.environ.get("HERMES_DASHBOARD_APPLIED"):
        return
    try:
        values = json.loads(path.read_text(encoding="utf-8")).get("env", {})
    except (OSError, ValueError, AttributeError):
        values = {}
    for key, value in values.items() if isinstance(values, dict) else ():
        if dashboard_key_allowed(str(key)) and isinstance(value, str) and "\x00" not in value:
            os.environ[key] = value
    os.environ["HERMES_DASHBOARD_APPLIED"] = "1"


load_dashboard_settings()
load_env_file()
STATE_DIR = Path(os.environ.get("HERMES_STATE_DIR") or SCRIPT_DIR / "state")


def env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or default


def env_int(name: str, default: int) -> int:
    try:
        return int(env(name, str(default)))
    except ValueError:
        return default


def env_bool(name: str, default: bool) -> bool:
    return env(name, "1" if default else "0").lower() in {"1", "true", "yes", "on"}


def safe_url(url: str) -> str:
    """The URL when it is an http(s) link to a host, else "" (search results must not put javascript: or data:
    links into an email)."""
    url = (url or "").strip()
    parts = urlsplit(url)
    return url if parts.scheme.lower() in ("http", "https") and parts.netloc and not CONTROL_CHARS.search(url) else ""


CONTROL_CHARS = re.compile(r"[\x00-\x20\x7f]")


def mask_secret(value: str) -> str:
    """Enough to recognise a stored key (its prefix and last 4 characters, and only for long ones), never more."""
    return "" if not value else f"{value[:3]}...{value[-4:]}" if len(value) >= 20 else "****"


def write_atomic(path: Path, data: str | bytes) -> None:
    """Write through a unique temp file and a rename, so readers never see half a file and concurrent writers
    never share a temp file; files are created 0600 (owner only) from the start."""
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = data.encode("utf-8") if isinstance(data, str) else data
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


# --------------------------------------------------------------------------- encryption at rest

DATA_KEY_ENV = "HERMES_DATA_KEY"
SEALED = b"HSEAL1"
_NONCE = 12


class DataKeyError(RuntimeError):
    """An encrypted file that cannot be opened, or a HERMES_DATA_KEY that cannot be used."""


def new_data_key() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")


def _cipher(required: bool = False):
    raw = env(DATA_KEY_ENV) or ""
    if not raw:
        if required:
            raise DataKeyError(f"this file is encrypted but {DATA_KEY_ENV} is not set")
        return None
    try:
        key = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    except (ValueError, binascii.Error):
        key = b""
    if len(key) != 32:
        raise DataKeyError(f"{DATA_KEY_ENV} must be 32 random bytes in base64 (maintenance.py --new-key makes one)")
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:
        raise DataKeyError(f"{DATA_KEY_ENV} is set but the Python 'cryptography' package is missing") from exc
    return AESGCM(key)


def is_sealed(path: Path) -> bool:
    try:
        with open(path, "rb") as fh:
            return fh.read(len(SEALED)) == SEALED
    except OSError:
        return False


def seal(data: bytes) -> bytes:
    """AES-256-GCM with HERMES_DATA_KEY; data is returned unchanged when no key is set."""
    cipher = _cipher()
    if cipher is None or data.startswith(SEALED):
        return data
    nonce = os.urandom(_NONCE)
    return SEALED + nonce + cipher.encrypt(nonce, data, SEALED)


def unseal(data: bytes) -> bytes:
    """The plaintext of seal()'s output; files written before encryption was turned on pass through."""
    if not data.startswith(SEALED):
        return data
    cipher = _cipher(required=True)
    from cryptography.exceptions import InvalidTag
    start = len(SEALED) + _NONCE
    try:
        return cipher.decrypt(data[len(SEALED):start], data[start:], SEALED)
    except InvalidTag as exc:
        raise DataKeyError(f"an encrypted file does not open with this {DATA_KEY_ENV} (wrong key?)") from exc


def read_private(path: Path) -> bytes:
    return unseal(path.read_bytes())


def read_private_text(path: Path, errors: str = "strict") -> str:
    return read_private(path).decode("utf-8", errors)


def write_private(path: Path, data: str | bytes) -> None:
    """A 0600 file, encrypted when HERMES_DATA_KEY is set (CVs, profiles, keys, letters)."""
    write_atomic(path, seal(data.encode("utf-8") if isinstance(data, str) else data))


def rewrite_text(path: Path, text: str) -> None:
    """Replace a text file, keeping it encrypted if it was (the owner's hand-edited files stay plain)."""
    if is_sealed(path):
        write_private(path, text)
    else:
        write_atomic(path, text)


@contextlib.contextmanager
def run_lock(path: Path):
    """Exclusive, non-blocking lock on `path`; yields False when another process holds it. The kernel releases
    it when the process ends, so a crashed run never leaves a stale lock."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a")  # noqa: SIM115 - held open for the life of the lock
    try:
        try:
            import fcntl
        except ImportError:  # Windows development machines have no flock
            yield True
            return
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
            return
        yield True
    finally:
        handle.close()


def normalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in TRACKING_PARAMS]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower().removeprefix("www."),
                       parts.path.rstrip("/"), urlencode(query), ""))


def model_config() -> dict:
    """The model, Ollama host and context size: OLLAMA_MODEL, OLLAMA_HOST and OLLAMA_NUM_CTX, each falling back to
    a config.yaml in the home folder (left by installs that ran inside Hermes)."""
    legacy = legacy_model_config()
    return {"model": env("OLLAMA_MODEL") or legacy["model"], "host": (env("OLLAMA_HOST") or legacy["host"]).rstrip("/"),
            "num_ctx": env_int("OLLAMA_NUM_CTX", 0) or legacy["num_ctx"]}


def legacy_model_config() -> dict:
    """Model, Ollama host and context size from the home folder's config.yaml (Hermes' format), if there is one."""
    path = APP_HOME / "config.yaml"
    cfg: dict = {}
    try:
        import yaml
        cfg = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}).get("model") or {}
    except Exception:
        try:
            text = path.read_text(encoding="utf-8")
            for key in ("default", "base_url", "ollama_num_ctx"):
                m = re.search(rf"^\s+{key}:\s*(\S+)", text, re.M)
                if m:
                    cfg[key] = m.group(1)
        except OSError:
            pass
    base = str(cfg.get("base_url") or "")
    return {
        "model": str(cfg.get("default") or ""),
        "host": re.sub(r"/v1/?$", "", base) if base else "",
        "num_ctx": int(cfg.get("ollama_num_ctx") or 0) or None,
    }


# --------------------------------------------------------------------------- firecrawl

def firecrawl_keys() -> list[str]:
    return [k for k in [env("FIRECRAWL_API_KEY")] +
            [k.strip() for k in (env("FIRECRAWL_BACKUP_KEYS") or "").split(",")] if k]


class Firecrawl:
    """Firecrawl client that fails over to backup API keys when credits run out."""

    def __init__(self, api_keys: list[str], min_credits: int):
        self.keys = list(dict.fromkeys(k for k in api_keys if k))
        self.idx = -1
        self.calls = 0
        self._last = 0.0
        self.start_credits: dict[int, int | None] = {}
        self._activate_next(min_credits)

    mask = staticmethod(mask_secret)

    def _set_key(self, idx: int) -> None:
        self.headers = {"Authorization": f"Bearer {self.keys[idx]}", "Content-Type": "application/json"}

    def _activate_next(self, min_credits: int = 1) -> None:
        while self.idx + 1 < len(self.keys):
            self.idx += 1
            self._set_key(self.idx)
            remaining = self.credits_remaining()
            if remaining is not None and remaining < min_credits and self.idx + 1 < len(self.keys):
                log(f"Firecrawl key {self.idx + 1} ({self.mask(self.keys[self.idx])}) has {remaining} credits; skipping")
                continue
            self.start_credits[self.idx] = remaining
            log(f"Using Firecrawl key {self.idx + 1}/{len(self.keys)} ({self.mask(self.keys[self.idx])}), "
                f"{remaining if remaining is not None else '?'} credits")
            return
        raise RuntimeError("All Firecrawl API keys are exhausted or invalid")

    @property
    def key_label(self) -> str:
        return f"key {self.idx + 1} of {len(self.keys)}"

    def credits_used(self) -> int | None:
        used = 0
        for idx, start in self.start_credits.items():
            self._set_key(idx)
            end = self.credits_remaining()
            if start is None or end is None:
                self._set_key(self.idx)
                return None
            used += max(0, start - end)
        self._set_key(self.idx)
        return used

    def _post(self, path: str, payload: dict, timeout: int = 120) -> dict | None:
        attempt = 0
        while attempt < 4:
            attempt += 1
            wait = 2.0 - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            self.calls += 1
            try:
                resp = requests.post(f"{FIRECRAWL}/{path}", json=payload, headers=self.headers, timeout=timeout)
            except requests.RequestException as exc:
                log(f"Firecrawl {path} error (attempt {attempt}): {exc.__class__.__name__}")
                time.sleep(5 * attempt)
                continue
            if resp.status_code == 200:
                try:
                    body = resp.json()
                except ValueError:
                    log(f"Firecrawl {path} returned a response that is not JSON")
                    return None
                return body if isinstance(body, dict) else None
            # A 403 from /scrape means "site not supported", not a bad key.
            out_of_credits = resp.status_code in (401, 402) or \
                (resp.status_code == 403 and path != "scrape") or \
                (resp.status_code == 429 and re.search(r"credit|insufficient|payment|upgrade", resp.text, re.I))
            if out_of_credits:
                log(f"Firecrawl key {self.idx + 1} rejected ({resp.status_code}: {resp.text[:120]}); failing over")
                self._activate_next()
                attempt -= 1
                continue
            if resp.status_code == 429:
                delay = int(resp.headers.get("Retry-After") or 15 * attempt)
                log(f"Firecrawl rate limited; sleeping {delay}s")
                time.sleep(min(delay, 90))
                continue
            if resp.status_code >= 500 and attempt < 3:
                time.sleep(5 * attempt)
                continue
            log(f"Firecrawl {path} HTTP {resp.status_code}: {resp.text[:160]}")
            return None
        return None

    def search(self, query: str, limit: int, tbs: str | None = None, country: str | None = None) -> list[dict]:
        payload: dict = {"query": query, "limit": limit}
        if tbs:
            payload["tbs"] = tbs
        if country:
            payload["country"] = country
        body = self._post("search", payload) or {}
        return body.get("data") or []

    def scrape(self, url: str) -> str | None:
        body = self._post("scrape", {"url": url, "formats": ["markdown"], "onlyMainContent": True,
                                     "timeout": 45000}) or {}
        return (body.get("data") or {}).get("markdown")

    def credits_remaining(self) -> int | None:
        try:
            resp = requests.get(f"{FIRECRAWL}/team/credit-usage", headers=self.headers, timeout=20)
            return int(resp.json()["data"]["remaining_credits"])
        except Exception:
            return None


# --------------------------------------------------------------------------- backup providers

class ProviderExhausted(Exception):
    """The provider's key is invalid or out of credits; stop using it for this run."""


def _search_operators(query: str) -> tuple[str, list[str], list[str]]:
    """Split Google-style site:/-site: operators out of a query for APIs that take domain lists."""
    include = re.findall(r"(?<![-\w])site:([\w.-]+)", query)
    exclude = re.findall(r"-site:([\w.-]+)", query)
    text = re.sub(r"-?site:[\w.-]+|\bOR\b|[()]", " ", query)
    return " ".join(text.split()), include, exclude


class Tavily:
    TIME_RANGE = {"qdr:d": "day", "qdr:w": "week", "qdr:m": "month", "qdr:y": "year"}
    COUNTRY = {"gb": "united kingdom", "uk": "united kingdom", "ie": "ireland", "us": "united states"}

    def __init__(self, api_key: str):
        self.headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        self.credits = 0

    def _post(self, path: str, payload: dict) -> dict:
        try:
            resp = requests.post(f"{TAVILY}/{path}", json=payload, headers=self.headers, timeout=90)
        except requests.RequestException as exc:
            raise RuntimeError(f"Tavily {path} error: {exc.__class__.__name__}") from exc
        if resp.status_code in (401, 403, 432, 433) or \
                (resp.status_code == 429 and re.search(r"limit|credit|plan|quota", resp.text, re.I)):
            raise ProviderExhausted(f"Tavily {resp.status_code}: {resp.text[:120]}")
        if resp.status_code != 200:
            raise RuntimeError(f"Tavily {path} HTTP {resp.status_code}: {resp.text[:120]}")
        try:
            body = resp.json()
        except ValueError:
            raise RuntimeError(f"Tavily {path} returned a response that is not JSON") from None
        return body if isinstance(body, dict) else {}

    def search(self, query: str, limit: int, tbs: str | None, country: str | None, topic: str) -> list[dict]:
        text, include, exclude = _search_operators(query)
        payload: dict = {"query": text, "max_results": min(limit, 20), "topic": topic}
        if tbs in self.TIME_RANGE:
            payload["time_range"] = self.TIME_RANGE[tbs]
        if include:
            payload["include_domains"] = include
        if exclude:
            payload["exclude_domains"] = exclude
        # Tavily wants full lowercase country names; accept ISO codes too.
        name = (self.COUNTRY.get(country.lower()) or (country.lower() if len(country) > 3 else None)) if country else None
        if name and topic == "general":
            payload["country"] = name
        body = self._post("search", payload)
        self.credits += 1
        return [{"title": r.get("title") or "", "url": r.get("url") or "", "description": r.get("content") or ""}
                for r in body.get("results") or []]

    def scrape(self, url: str) -> str | None:
        body = self._post("extract", {"urls": [url], "format": "markdown", "extract_depth": "basic"})
        self.credits += 1
        results = body.get("results") or []
        return (results[0].get("raw_content") or None) if results else None


class Scrapfly:
    def __init__(self, api_key: str):
        self.key = api_key
        self.credits = 0

    def scrape(self, url: str) -> str | None:
        try:
            params = {"key": self.key, "url": url, "format": "markdown"}
            if env("SCRAPFLY_COUNTRY"):
                params["country"] = env("SCRAPFLY_COUNTRY")
            resp = requests.get(f"{SCRAPFLY}/scrape", params=params, timeout=120)
        except requests.RequestException as exc:
            raise RuntimeError(f"Scrapfly error: {exc.__class__.__name__}") from exc
        if resp.status_code in (401, 402) or (resp.status_code in (403, 429) and
                                              re.search(r"QUOTA|BUDGET|SUBSCRIPTION|ACCOUNT|API_KEY", resp.text)):
            raise ProviderExhausted(f"Scrapfly {resp.status_code}: {resp.text[:120]}")
        try:
            body = resp.json()
        except ValueError:
            raise RuntimeError(f"Scrapfly HTTP {resp.status_code}") from None
        self.credits += int((body.get("context") or {}).get("cost", {}).get("total") or 1) if resp.ok else 0
        result = body.get("result") or {}
        if not resp.ok or not result.get("success", True) or int(result.get("status_code") or 200) >= 400:
            log(f"Scrapfly could not fetch {url[:80]} ({result.get('status_code') or resp.status_code})")
            return None
        return result.get("content") or None


class WebClient:
    """Search and page scraping across Firecrawl (primary) with Tavily and Scrapfly as backups.

    Provider order is configurable with WEB_SEARCH_ORDER / WEB_SCRAPE_ORDER (comma-separated
    names); a provider whose credits run out is skipped for the rest of the run.
    """

    def __init__(self, min_firecrawl_credits: int):
        self.firecrawl: Firecrawl | None = None
        keys = firecrawl_keys()
        if keys:
            try:
                self.firecrawl = Firecrawl(keys, min_firecrawl_credits)
            except RuntimeError as exc:
                log(f"Firecrawl unavailable ({exc}); using backup providers")
        self.tavily = Tavily(env("TAVILY_API_KEY")) if env("TAVILY_API_KEY") else None
        self.scrapfly = Scrapfly(env("SCRAPFLY_API_KEY")) if env("SCRAPFLY_API_KEY") else None
        self.search_order = self._order("WEB_SEARCH_ORDER", "firecrawl,tavily")
        self.scrape_order = self._order("WEB_SCRAPE_ORDER", "firecrawl,scrapfly,tavily")
        self.direct_pages = 0
        if not self.search_order:
            raise RuntimeError("No web search provider is configured (FIRECRAWL_API_KEY / TAVILY_API_KEY)")

    def _order(self, name: str, default: str) -> list[str]:
        return [p for p in (s.strip().lower() for s in (env(name) or default).split(",")) if getattr(self, p, None)]

    def _drop(self, name: str, reason: str) -> None:
        log(f"{name} exhausted ({reason}); switching to the next provider")
        setattr(self, name, None)
        self.search_order = [p for p in self.search_order if p != name]
        self.scrape_order = [p for p in self.scrape_order if p != name]

    def search(self, query: str, limit: int, tbs: str | None = None, country: str | None = None,
               topic: str = "general") -> list[dict]:
        for name in list(self.search_order):
            try:
                if name == "firecrawl":
                    results = self.firecrawl.search(query, limit, tbs, country)
                else:
                    results = self.tavily.search(query, limit, tbs, country, topic)
            except (ProviderExhausted, RuntimeError) as exc:
                if isinstance(exc, ProviderExhausted) or "exhausted" in str(exc):
                    self._drop(name, str(exc))
                else:
                    log(str(exc))
                continue
            if results:
                return results
        return []

    def scrape(self, url: str) -> str | None:
        for name in list(self.scrape_order):
            try:
                text = getattr(self, name).scrape(url)
            except (ProviderExhausted, RuntimeError) as exc:
                if isinstance(exc, ProviderExhausted) or "exhausted" in str(exc):
                    self._drop(name, str(exc))
                else:
                    log(str(exc))
                continue
            if text:
                return text
        return None

    def usage(self) -> str:
        parts = []
        if self.firecrawl:
            used, left = self.firecrawl.credits_used(), self.firecrawl.credits_remaining()
            parts.append(f"Firecrawl {used if used is not None else '?'} credits"
                         + (f" ({left} left, {self.firecrawl.key_label})" if left is not None else ""))
        if self.direct_pages:
            parts.append(f"{self.direct_pages} pages fetched directly (free)")
        if self.tavily and self.tavily.credits:
            parts.append(f"Tavily {self.tavily.credits} credits")
        if self.scrapfly and self.scrapfly.credits:
            parts.append(f"Scrapfly {self.scrapfly.credits} credits")
        return " &middot; ".join(parts) or "no paid web calls"


# --------------------------------------------------------------------------- HTML

# Gmail's dark mode (iOS/Android) inverts text colours but not background images, so light
# text on a gradient header turns dark-on-dark. Blend-mode wrappers, matched only inside
# Gmail via "u + .body", undo the inversion; other clients are told to stay in light mode.
# The second block narrows the m-* classed parts on phones. Gmail drops a whole <style> block it
# can't parse, so it is kept apart, and !important is needed to win over the inline styles.
EMAIL_HEAD = """<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">
<style>
:root { color-scheme: light only; supported-color-schemes: light only; }
u + .body .gmail-screen { background:#000000; mix-blend-mode:screen; }
u + .body .gmail-difference { background:#000000; mix-blend-mode:difference; }
</style>
<style>
@media only screen and (max-width:540px) {
.m-wrap { padding:10px 4px !important; }
.m-pad { padding:16px 14px !important; }
.m-head { padding:20px 18px 18px !important; }
.m-stack { display:block !important; width:100% !important; text-align:left !important; }
.m-sep { padding-left:10px !important; }
.m-num { font-size:22px !important; line-height:28px !important; }
.m-flush { padding-left:0 !important; }
.m-below { padding:4px 0 0 !important; }
.m-inline { display:inline-block !important; }
.m-title { font-size:17px !important; }
.m-score { width:52px !important; height:52px !important; line-height:52px !important; font-size:20px !important; border-radius:26px !important; }
.m-label { font-size:10px !important; letter-spacing:.02em !important; }
}
</style>"""


def white_label(text: str) -> str:
    """A button's text on a dark background. Gmail paints some links in its own blue (#1155cc) whatever their
    style, but leaves a coloured span inside the link alone."""
    return f'<span style="color:#ffffff">{html.escape(text)}</span>'


def gmail_dark_safe(inner_html: str) -> str:
    """Wrap light-on-dark content (e.g. a gradient header) so it stays readable in Gmail dark mode."""
    return f'<div class="gmail-screen"><div class="gmail-difference">{inner_html}</div></div>'


def email_header(eyebrow: str, meta: str, title: str, subtitle: str, stats: list[tuple[object, str]],
                 highlight: int | None = None) -> str:
    """Report header row: eyebrow and date, title, subtitle, then figures split by hairlines (plain text in)."""
    def esc(text: object) -> str:
        return html.escape(str(text), quote=True)

    sep = ' class="m-sep" style="border-left:1px solid #334155;padding-left:18px"'
    cells = "".join(
        f'<td valign="top" width="{100 // len(stats)}%" style="padding-top:18px">'
        f'<div{sep if i else ""}>'
        f'<div class="m-num" style="font-size:26px;line-height:32px;font-weight:700;letter-spacing:-.01em;'
        f'color:{"#6ee7b7" if i == highlight else "#f8fafc"}">{esc(value)}</div>'
        f'<div style="font-size:12px;line-height:18px;color:#94a3b8;margin-top:2px">{esc(label)}</div></div></td>'
        for i, (value, label) in enumerate(stats))
    inner = (
        f'<table width="100%" cellpadding="0" cellspacing="0"><tr>'
        f'<td class="m-stack" style="font-size:13px;line-height:20px;font-weight:600;color:#a5b4fc">{esc(eyebrow)}</td>'
        f'<td class="m-stack" align="right" style="font-size:13px;line-height:20px;color:#94a3b8">{esc(meta)}</td></tr>'
        f'</table>'
        f'<div style="font-size:28px;line-height:34px;font-weight:700;letter-spacing:-.02em;color:#f8fafc;'
        f'margin-top:14px">{esc(title)}</div>'
        f'<div style="font-size:15px;line-height:22px;color:#cbd5e1;margin-top:4px">{esc(subtitle)}</div>'
        f'<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;border-top:1px solid #334155">'
        f'<tr>{cells}</tr></table>')
    return (f'<tr><td class="m-head" style="background:#0f172a;border:1px solid #1e293b;border-radius:16px;'
            f'padding:26px 28px 24px">'
            f'{gmail_dark_safe(inner)}</td></tr>')


# Gmail clips HTML over 102 KB ("[Message clipped]"), drops a whole <style> block over 8,192
# characters or one containing background images, and ignores styles past 16 KB in total.
EMAIL_HTML_BUDGET = 95_000
STYLE_BLOCK_MAX = 7_000
STYLE_TOTAL_MAX = 15_000
_TAG_RE = re.compile(r"<[a-zA-Z][^<>]*>")
_STYLE_ATTR_RE = re.compile(r'\sstyle="([^"]*)"')
_UNSAFE_STYLE_RE = re.compile(r"url\(|background-image|gradient|expression|[&{}@\\<>]", re.I)


def html_size(html_body: str) -> int:
    return len(html_body.encode("utf-8"))


def compact_html(html_body: str, budget: int | None = None) -> str:
    """Shrink an email under `budget` bytes (default EMAIL_HTML_BUDGET) without changing how it renders.

    Inline styles stay inline while the email fits, since some clients ignore <style>. Beyond
    that, whitespace between tags is collapsed, then inline styles repeated on class-less tags
    become short classes in <style> blocks sized to Gmail's limits.
    """
    budget = EMAIL_HTML_BUDGET if budget is None else budget
    if html_size(html_body) <= budget:
        return html_body
    html_body = re.sub(r">\s*\n\s*<", "> <", html_body)
    head_end = html_body.find("</head>")
    if html_size(html_body) <= budget or head_end < 0:
        return html_body

    def movable(tag: str) -> str | None:
        found = _STYLE_ATTR_RE.search(tag)
        if not found or " class=" in tag:
            return None
        value = found.group(1).strip().rstrip(";")
        return value if len(value) >= 24 and not _UNSAFE_STYLE_RE.search(value) else None

    counts = Counter(v for tag in _TAG_RE.findall(html_body) if (v := movable(tag)))
    classes: dict[str, str] = {}
    rules: list[str] = []
    total = 0
    for value, uses in sorted(counts.items(), key=lambda kv: -kv[1] * len(kv[0])):
        name = f"h{len(classes)}"
        rule = f".{name}{{{value}}}"
        if uses < 2 or total + len(rule) > STYLE_TOTAL_MAX:
            continue
        classes[value] = name
        rules.append(rule)
        total += len(rule)
    if not classes:
        return html_body

    def swap(match: re.Match) -> str:
        tag = match.group(0)
        name = classes.get(movable(tag) or "")
        return _STYLE_ATTR_RE.sub(f' class="{name}"', tag, count=1) if name else tag

    html_body = _TAG_RE.sub(swap, html_body)
    blocks = [""]
    for rule in rules:
        if len(blocks[-1]) + len(rule) > STYLE_BLOCK_MAX:
            blocks.append("")
        blocks[-1] += rule
    return html_body.replace("</head>", "".join(f"<style>{b}</style>" for b in blocks) + "</head>", 1)


class _TextExtractor(HTMLParser):
    BLOCK = {"p", "div", "br", "ul", "ol", "tr", "table", "section", "article", "header", "footer", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg"):
            self.skip += 1
        elif tag == "li":
            self.parts.append("\n- ")
        elif re.fullmatch(r"h[1-6]", tag):
            self.parts.append("\n\n## ")
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg"):
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK or re.fullmatch(r"h[1-6]", tag):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_to_text(html_text: str) -> str:
    parser = _TextExtractor()
    parser.feed(html_text)
    lines = (" ".join(line.split()) for line in "".join(parser.parts).splitlines())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


# --------------------------------------------------------------------------- model

def pick_ollama_host(hosts: list[str], models: list[str]) -> tuple[str, str]:
    for host in dict.fromkeys(h.rstrip("/") for h in hosts if h):
        try:
            resp = requests.get(f"{host}/api/tags", timeout=5)
            resp.raise_for_status()
        except requests.RequestException as exc:
            log(f"Ollama not reachable at {host}: {exc.__class__.__name__}")
            continue
        names = {m.get("name") for m in resp.json().get("models", [])}
        for model in models:
            if model and model in names:
                log(f"Using {model} via {host}")
                return host, model
        log(f"Ollama at {host} has none of {models}")
    raise RuntimeError(f"No reachable Ollama host with any of {models}")


OLLAMA_DEFAULT_HOSTS = ("http://ollama:11434", "http://host.docker.internal:11434")


def ollama_hosts(cfg: dict) -> list[str]:
    """Where to look for Ollama: OLLAMA_HOST, OLLAMA_FALLBACK_HOST (default localhost), then the usual container
    addresses (an `ollama` container on the same network, or Ollama published on the Docker host)."""
    hosts = [cfg["host"], env("OLLAMA_FALLBACK_HOST", "http://localhost:11434"), *OLLAMA_DEFAULT_HOSTS]
    return [h.rstrip("/") for h in dict.fromkeys(hosts) if h]


def suggested_model() -> str:
    """The model that fits this machine (autofit.suggested_model), or the default when autofit can't tell."""
    try:
        import autofit
        return autofit.suggested_model()
    except Exception:
        return DEFAULT_MODEL


def connect_model(override_env: str) -> tuple[str, str, int | None]:
    """Resolve (host, model, num_ctx): `override_env`'s model, else OLLAMA_MODEL, else the one that fits the machine,
    else the default. With no Ollama reachable but a cloud model key set, host is "" and every request goes to the
    cloud (llm_providers.py)."""
    cfg = model_config()
    models = [m for m in dict.fromkeys([env(override_env), cfg["model"], suggested_model(), DEFAULT_MODEL]) if m]
    try:
        host, model = pick_ollama_host(ollama_hosts(cfg), models)
    except RuntimeError:
        import llm_providers
        if not llm_providers.configured():
            raise
        log("No local Ollama with a model; using the cloud models only")
        return "", models[0], cfg["num_ctx"] or 8192
    # The configured num_ctx matches the model instance other programs keep loaded, instead of forcing a reload.
    num_ctx = cfg["num_ctx"] if model == cfg["model"] else 8192
    return host, model, num_ctx


def fit_ctx(num_ctx: int | None, *texts: str, num_predict: int = 500) -> int | None:
    """The configured context size, raised (in 2k steps, at most 32k) only when the prompt would not fit, since
    every change of num_ctx makes Ollama reload the model."""
    needed = sum(len(t) for t in texts) // 3 + num_predict + 256
    if needed <= (num_ctx or 4096):
        return num_ctx
    return min(32768, -(-needed // 2048) * 2048)


# Every script and profile shares one queue for the model, so extra profiles, cover letters and sign-ups never
# stack requests on Ollama. Tickets are files named "<priority>-<time ns>-<random>", each flock-ed by its process,
# so a crashed process's ticket is recognised (lockable) and removed. Priority 0 (someone is waiting: cover letters,
# tailored CVs, new profiles) goes ahead of 1 (background ratings); a running request is never interrupted.
MODEL_QUEUE_DIR = Path(os.environ.get("HERMES_MODEL_QUEUE_DIR") or SCRIPT_DIR / "state" / "model-queue")
MODEL_QUEUE_MAX_WAIT = 3600
_TICKET_RE = re.compile(r"^[01]-\d{20}-[0-9a-f]{6}$")
_model_priority = 1


def set_model_priority(waiting: bool) -> None:
    """Mark this process's model requests as ones a person is waiting for, served before background ratings."""
    global _model_priority
    _model_priority = 0 if waiting else 1


def _ticket_gone(path: Path, fcntl) -> bool:
    """True (and the ticket removed) when no live process holds the ticket's lock."""
    try:
        fd = os.open(path, os.O_RDWR)
    except OSError:
        return True
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    else:
        path.unlink(missing_ok=True)
        return True
    finally:
        os.close(fd)


@contextlib.contextmanager
def model_turn(priority: int | None = None, slots: int | None = None):
    """Wait for this request's turn at the model: at most `slots` (else HERMES_MODEL_CONCURRENCY, default 1)
    requests run at once across all processes, in priority then arrival order. Yields the slot number, which
    picks the Ollama instance. A no-op where flock is missing (Windows)."""
    try:
        import fcntl
    except ImportError:
        yield 0
        return
    slots = max(1, slots or env_int("HERMES_MODEL_CONCURRENCY", 1))
    MODEL_QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = MODEL_QUEUE_DIR / f".new-{os.getpid()}-{secrets.token_hex(4)}"
    fd = os.open(tmp, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    # Renamed only once locked, so no other process can mistake a new ticket for an abandoned one.
    prio = _model_priority if priority is None else priority
    ticket = MODEL_QUEUE_DIR / f"{1 if prio else 0}-{time.time_ns():020d}-{secrets.token_hex(3)}"
    os.replace(tmp, ticket)
    slot, started, ahead = None, time.monotonic(), 0
    try:
        while True:
            ahead = sum(1 for p in MODEL_QUEUE_DIR.iterdir()
                        if _TICKET_RE.match(p.name) and p.name < ticket.name and not _ticket_gone(p, fcntl))
            if ahead < slots:
                slot = _free_model_slot(fcntl, slots)
                if slot is not None:
                    break
            if time.monotonic() - started > MODEL_QUEUE_MAX_WAIT:
                log("Waited over an hour for the model queue; going ahead anyway")
                break
            time.sleep(0.5)
        if (waited := time.monotonic() - started) >= 5:
            log(f"Waited {waited:.0f}s for the model (shared queue)")
        yield slot[1] if slot else 0
    finally:
        if slot is not None:
            os.close(slot[0])
        ticket.unlink(missing_ok=True)
        os.close(fd)


def _free_model_slot(fcntl, slots: int) -> tuple[int, int] | None:
    for i in range(slots):
        fd = os.open(MODEL_QUEUE_DIR / f"slot-{i}", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd, i
        except OSError:
            os.close(fd)
    return None


def ollama_chat(host: str, model: str, system: str, user: str, num_ctx: int | None,
                fmt: dict | None = None, num_predict: int = 500) -> str:
    """One chat request: to the cloud models when a key is set (llm_providers.py), else or when none of them
    answers to the local Ollama (host "" means there is none). LLM_ORDER=local asks Ollama first."""
    import llm_providers
    cloud = bool(llm_providers.configured())
    if cloud and (not host or not llm_providers.local_first()):
        if (found := llm_providers.chat(system, user, fmt, num_predict)) is not None:
            return _tidy(found[0], fmt)
    if not host:
        raise requests.ConnectionError("no cloud model answered and there is no local Ollama")
    try:
        content = _ollama_request(host, model, system, user, num_ctx, fmt, num_predict)
    except requests.RequestException:
        if cloud and llm_providers.local_first() and (found := llm_providers.chat(system, user, fmt, num_predict)):
            return _tidy(found[0], fmt)
        raise
    llm_providers.used_local(model)
    return _tidy(content, fmt)


def _tidy(content: str, fmt: dict | None) -> str:
    if fmt:
        try:
            return json.dumps(_undash(json.loads(content)), ensure_ascii=False)
        except ValueError:
            return content
    return plain_dashes(content)


def _ollama_request(host: str, model: str, system: str, user: str, num_ctx: int | None,
                    fmt: dict | None, num_predict: int) -> str:
    """One chat request to Ollama, on the instance, context size and GPU/CPU split autofit picks (see autofit.py)."""
    import autofit
    body = {"model": model, "stream": False, "keep_alive": "30m",
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    if fmt:
        body["format"] = fmt
    chars = len(system) + len(user)
    with model_turn(slots=autofit.slots(host)) as slot:
        target, extra = autofit.choose(host, model, num_ctx, chars, num_predict, slot)
        body["options"] = {"temperature": 0, "num_predict": num_predict, **extra}
        try:
            resp = requests.post(f"{target}/api/chat", json=body, timeout=600)
            resp.raise_for_status()
        except requests.RequestException as exc:
            autofit.failed(target, model, extra, exc)
            if target == host.rstrip("/") or isinstance(exc, requests.Timeout):
                raise
            log(f"{target} failed ({exc.__class__.__name__}); trying {host}")
            target, extra = autofit.choose(host, model, num_ctx, chars, num_predict, 0)
            body["options"] = {"temperature": 0, "num_predict": num_predict, **extra}
            resp = requests.post(f"{target}/api/chat", json=body, timeout=600)
            resp.raise_for_status()
        reply = resp.json()
        autofit.record(target, model, extra, reply)
    return reply["message"]["content"]


def plain_dashes(text: str) -> str:
    """Replace the em/en dashes models like to write with plain punctuation."""
    text = re.sub(r"(?<=\d)\s*[–—]\s*(?=[\d£$€])", "-", text)
    text = re.sub(r"\s*[—―]\s*|\s+–\s+", ", ", text)
    return re.sub(r",\s*([,.;:!?])", r"\1", text).strip(" ,")


def _undash(value):
    if isinstance(value, str):
        return plain_dashes(value)
    if isinstance(value, list):
        return [_undash(v) for v in value]
    if isinstance(value, dict):
        return {k: _undash(v) for k, v in value.items()}
    return value


def first_sentences(text: str, n: int, max_chars: int = 400) -> str:
    text = " ".join(text.split())
    return " ".join(re.split(r"(?<=[.!?])\s+", text)[:n])[:max_chars]


# --------------------------------------------------------------------------- email

def inline_images(html_body: str, directory: Path) -> dict[str, bytes]:
    """PNGs from `directory` referenced in the HTML as src="cid:<name>", keyed by name."""
    names = sorted(set(re.findall(r'src="cid:([\w-]+)"', html_body)))
    return {n: (directory / f"{n}.png").read_bytes() for n in names if (directory / f"{n}.png").is_file()}


def send_email(subject: str, html_body: str, text_body: str, from_name: str,
               images: dict[str, bytes] | None = None,
               attachments: list[tuple[str, bytes, str]] | None = None) -> None:
    """HTML email with a plain-text alternative, inline CID images and optional (filename, data, MIME type)
    attachments."""
    host = env("SMTP_HOST", "smtp.gmail.com")
    port = env_int("SMTP_PORT", 587)
    user, password = env("SMTP_USER"), env("SMTP_PASSWORD")
    to_addr = env("ALERT_EMAIL", user)
    if not (user and password and to_addr):
        raise RuntimeError("SMTP_USER, SMTP_PASSWORD and ALERT_EMAIL must be set")
    msg = EmailMessage()
    msg["Subject"] = _header(subject)
    msg["From"] = f"{_header(from_name).replace('<', '').replace('>', '')} <{_header(env('SMTP_FROM', user))}>"
    msg["To"] = _header(to_addr)
    original = html_size(html_body)
    html_body = compact_html(html_body)
    if html_size(html_body) != original:
        log(f"Email HTML compacted from {original // 1024} KB to {html_size(html_body) // 1024} KB")
    if html_size(html_body) > 102 * 1024:
        log(f"Email HTML is {html_size(html_body) // 1024} KB; Gmail clips messages over 102 KB")
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")
    html_part = msg.get_payload()[1]
    for name, data in (images or {}).items():
        html_part.add_related(data, "image", "png", cid=f"<{name}>", disposition="inline")
    for filename, data, mime in attachments or []:
        maintype, subtype = mime.split("/", 1)
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)
    for attempt, pause in enumerate(SMTP_RETRY_PAUSES + (None,), 1):
        try:
            _smtp_send(host, port, user, password, msg)
            break
        except (smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError, TimeoutError, ConnectionError) as exc:
            error = exc
        except smtplib.SMTPResponseException as exc:
            if not 400 <= exc.smtp_code < 500:  # 5xx (wrong password, rejected address) will not fix itself
                raise
            error = exc
        if pause is None:
            raise error
        log(f"Email attempt {attempt} failed ({error.__class__.__name__}); retrying in {pause}s")
        time.sleep(pause)
    log(f"Email sent to {to_addr}")


SMTP_RETRY_PAUSES = (10, 60)


def _header(value: str | None) -> str:
    """A header value on one line: a newline in a job title or name must neither break nor inject headers."""
    return " ".join(str(value or "").split())


def _smtp_send(host: str, port: int, user: str, password: str, msg: EmailMessage) -> None:
    context = ssl.create_default_context()
    if port == 465:
        smtp_conn = smtplib.SMTP_SSL(host, port, timeout=30, context=context)
    else:
        smtp_conn = smtplib.SMTP(host, port, timeout=30)
    with smtp_conn as smtp:
        if port != 465:
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
        smtp.login(user, password.replace(" ", ""))
        smtp.send_message(msg)

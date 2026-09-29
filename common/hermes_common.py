"""Shared plumbing for HermitShell packages (Hermes scheduled scripts).

.env loading, Hermes model discovery, web data providers (Firecrawl with
backup-key failover, then Tavily and Scrapfly as backups), Ollama chat helper
and SMTP sending with inline images. Every setting comes from environment
variables or $HERMES_HOME/.env; see docs/configuration.md.
"""

from __future__ import annotations

import json
import os
import re
import smtplib
import ssl
import sys
import time
from collections import Counter
from email.message import EmailMessage
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
HERMES_HOME = Path(os.environ.get("HERMES_HOME", SCRIPT_DIR.parent))

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

LOG_TAG = "hermes"
TRACKING_PARAMS = {"cid", "source", "ref", "trk", "gh_src", "fbclid", "gclid", "mc_cid", "mc_eid"}


def log(msg: str) -> None:
    print(f"[{LOG_TAG}] {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- config

def load_env_file(path: Path = HERMES_HOME / ".env") -> None:
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


def normalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in TRACKING_PARAMS]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower().removeprefix("www."),
                       parts.path.rstrip("/"), urlencode(query), ""))


def hermes_model_config() -> dict:
    """Model, Ollama host and context size from Hermes' own config.yaml."""
    path = HERMES_HOME / "config.yaml"
    cfg: dict = {}
    try:
        import yaml  # available in the Hermes venv
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

    @staticmethod
    def mask(key: str) -> str:
        return f"{key[:7]}...{key[-4:]}"

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
                return resp.json()
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
        return resp.json()

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
EMAIL_HEAD = """<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">
<style>
:root { color-scheme: light only; supported-color-schemes: light only; }
u + .body .gmail-screen { background:#000000; mix-blend-mode:screen; }
u + .body .gmail-difference { background:#000000; mix-blend-mode:difference; }
</style>"""


def gmail_dark_safe(inner_html: str) -> str:
    """Wrap light-on-dark content (e.g. a gradient header) so it stays readable in Gmail dark mode."""
    return f'<div class="gmail-screen"><div class="gmail-difference">{inner_html}</div></div>'


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


def connect_model(override_env: str) -> tuple[str, str, int | None]:
    """Resolve (host, model, num_ctx), preferring the model Hermes itself is configured with."""
    hcfg = hermes_model_config()
    models = [env(override_env), hcfg["model"], env("OLLAMA_MODEL"), DEFAULT_MODEL]
    hosts = [hcfg["host"], env("OLLAMA_HOST", "http://ollama:11434"),
             env("OLLAMA_FALLBACK_HOST", "http://localhost:11434")]
    host, model = pick_ollama_host(hosts, [m for m in dict.fromkeys(models) if m])
    # Reusing Hermes' num_ctx keeps the already-loaded model instance instead of forcing a reload.
    num_ctx = hcfg["num_ctx"] if model == hcfg["model"] else 8192
    return host, model, num_ctx


def ollama_chat(host: str, model: str, system: str, user: str, num_ctx: int | None,
                fmt: dict | None = None, num_predict: int = 500) -> str:
    options = {"temperature": 0, "num_predict": num_predict}
    if num_ctx:
        options["num_ctx"] = num_ctx
    body = {"model": model, "stream": False, "keep_alive": "30m", "options": options,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    if fmt:
        body["format"] = fmt
    resp = requests.post(f"{host}/api/chat", json=body, timeout=600)
    resp.raise_for_status()
    content = resp.json()["message"]["content"]
    if fmt:
        try:
            return json.dumps(_undash(json.loads(content)), ensure_ascii=False)
        except ValueError:
            return content
    return plain_dashes(content)


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
               images: dict[str, bytes] | None = None) -> None:
    host = env("SMTP_HOST", "smtp.gmail.com")
    port = env_int("SMTP_PORT", 587)
    user, password = env("SMTP_USER"), env("SMTP_PASSWORD")
    to_addr = env("ALERT_EMAIL", user)
    if not (user and password and to_addr):
        raise RuntimeError("SMTP_USER, SMTP_PASSWORD and ALERT_EMAIL must be set")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{env('SMTP_FROM', user)}>"
    msg["To"] = to_addr
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
    with smtplib.SMTP(host, port, timeout=30) as smtp:
        smtp.ehlo()
        smtp.starttls(context=ssl.create_default_context())
        smtp.ehlo()
        smtp.login(user, password.replace(" ", ""))
        smtp.send_message(msg)
    log(f"Email sent to {to_addr}")

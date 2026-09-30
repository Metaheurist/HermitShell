"""Company enrichment for the Daily Vacancy Report: official website and a round logo per company.

Lookups are free (direct fetches plus Clearbit's public autocomplete) and cached for 30 days in
state/companies.json, with processed logos in state/logos/<slug>.png ready to embed as CID images.
"""
from __future__ import annotations

import hashlib
import io
import ipaddress
import json
import re
import socket
import time
from html.parser import HTMLParser
from urllib.parse import quote, urljoin, urlsplit

import requests

from hermes_common import BROWSER_HEADERS, STATE_DIR, log

CACHE_FILE = STATE_DIR / "companies.json"
LOGO_DIR = STATE_DIR / "logos"
CACHE_SECONDS = 30 * 86400
LOGO_PX = 144  # shown as a 48px circle, rendered at 3x
MAX_PAGE_BYTES = 1_000_000
MAX_IMAGE_BYTES = 2_000_000
MAX_IMAGE_PIXELS = 16_000_000
MAX_REDIRECTS = 3
IMAGE_FORMATS = ["PNG", "JPEG", "GIF", "ICO", "WEBP", "BMP"]

NAME_NOISE = re.compile(r"\b(ltd|limited|plc|llp|llc|inc|group|holdings|uk|ni|ireland|northern|the|and|co)\b")
NOT_COMPANY_SITES = re.compile(
    r"(nijobs|linkedin|indeed|glassdoor|jobijoba|totaljobs|reed\.co|monster|cv-library|google|facebook|"
    r"twitter|x\.com|instagram|youtube|tiktok|gov\.uk|nidirect|w3\.org|schema\.org|microsoft\.com|"
    r"amazon\.com|apple\.com|wikipedia)", re.I)
DOMAIN_RE = re.compile(r"\b(?:https?://)?(?:www\.)?((?:[a-z0-9-]+\.)+(?:co\.uk|com|io|ai|ie|org|net|tech|uk|eu|jobs))\b", re.I)

def norm(name: str) -> str:
    n = re.sub(r"[^a-z0-9 ]+", " ", name.lower().replace("&", " and "))
    return " ".join(NAME_NOISE.sub(" ", n).split())


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or hashlib.sha256(name.encode()).hexdigest()[:10]


def domain_matches(domain: str, name: str) -> bool:
    root = re.sub(r"[^a-z0-9]", "", domain.lower().removeprefix("www.").split(".")[0])
    key = norm(name).replace(" ", "")
    return len(key) >= 3 and len(root) >= 3 and (key in root or root in key)


def listing_domains(text: str) -> list[str]:
    return list(dict.fromkeys(d.lower() for d in DOMAIN_RE.findall(text or "") if not NOT_COMPANY_SITES.search(d)))


def public_host(host: str) -> bool:
    """True when every address the host resolves to is a public one (no LAN, loopback or cloud metadata)."""
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except (OSError, UnicodeError):
        return False
    return bool(infos) and all(ipaddress.ip_address(info[4][0].split("%")[0]).is_global for info in infos)


def safe_get(session: requests.Session, url: str, max_bytes: int, timeout: int = 10) -> requests.Response | None:
    """GET a public http(s) URL, following at most MAX_REDIRECTS redirects that are checked the same way and
    reading at most max_bytes; None when the URL, an address or the size is not allowed."""
    for _ in range(MAX_REDIRECTS + 1):
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname or not public_host(parts.hostname):
            return None
        try:
            resp = session.get(url, timeout=timeout, stream=True, allow_redirects=False)
        except requests.RequestException:
            return None
        if resp.is_redirect and resp.headers.get("location"):
            url = urljoin(url, resp.headers["location"])
            resp.close()
            continue
        try:
            if int(resp.headers.get("content-length") or 0) > max_bytes:
                return None
            body = b""
            for chunk in resp.iter_content(65536):
                body += chunk
                if len(body) > max_bytes:
                    return None
        except (requests.RequestException, ValueError):
            return None
        finally:
            resp.close()
        resp._content = body  # noqa: SLF001 - lets .text/.content work on the capped body
        return resp
    return None


class _Visible(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        self.skip += tag in ("script", "style")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def visible_text(page: str, limit: int = 200_000) -> str:
    parser = _Visible()
    try:
        parser.feed(page[:MAX_PAGE_BYTES])
        parser.close()
    except Exception:  # noqa: BLE001 - broken markup only loses text
        pass
    return " ".join(parser.parts)[:limit]


def circle_logo(data: bytes) -> bytes | None:
    """Fit a logo inside a white circle with a thin grey ring; full-bleed icons fill the circle."""
    try:
        from PIL import Image, ImageChops, ImageDraw
    except ImportError:
        return None
    try:
        im = Image.open(io.BytesIO(data), formats=IMAGE_FORMATS)
        if im.width * im.height > MAX_IMAGE_PIXELS:
            return None
        im.load()
    except Exception:  # noqa: BLE001 - any undecodable image just means "no logo"
        return None
    if min(im.size) < 32:
        return None
    im = im.convert("RGBA")
    size = LOGO_PX
    corners = [im.getpixel(p) for p in ((0, 0), (im.width - 1, 0), (0, im.height - 1), (im.width - 1, im.height - 1))]
    solid_bg = (all(c[3] > 250 for c in corners)
                and max(abs(a - b) for c in corners for a, b in zip(c[:3], corners[0][:3])) < 24
                and not all(v > 235 for v in corners[0][:3]))
    if solid_bg:
        canvas = Image.new("RGBA", (size, size), corners[0])
        ratio = size / min(im.size)
        logo = im.resize((max(1, round(im.width * ratio)), max(1, round(im.height * ratio))), Image.LANCZOS)
    else:
        canvas = Image.new("RGBA", (size, size), (255, 255, 255, 255))
        flat = Image.new("RGBA", im.size, (255, 255, 255, 255))
        flat.alpha_composite(im)
        diff = ImageChops.difference(flat.convert("RGB"), Image.new("RGB", im.size, (255, 255, 255)))
        bbox = diff.convert("L").point(lambda v: 255 if v > 14 else 0).getbbox()
        if not bbox:
            return None
        flat = flat.crop(bbox)
        aspect = flat.width / flat.height
        height = 0.88 * size / (aspect ** 2 + 1) ** 0.5  # the logo's box fits inside the circle
        logo = flat.resize((max(1, round(height * aspect)), max(1, round(height))), Image.LANCZOS)
    canvas.alpha_composite(logo, ((size - logo.width) // 2, (size - logo.height) // 2))

    big = size * 4
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big - 1, big - 1), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(canvas, (0, 0), mask.resize((size, size), Image.LANCZOS))
    ring = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse((3, 3, big - 4, big - 4), outline=(203, 213, 225, 255), width=7)
    out.alpha_composite(ring.resize((size, size), Image.LANCZOS))
    buf = io.BytesIO()
    out.save(buf, "PNG", optimize=True)
    return buf.getvalue()


COUNTRY_CODES = {"uk": "gb", "united kingdom": "gb", "ireland": "ie", "united states": "us", "usa": "us"}
COUNTRY_SIGNALS = {
    "gb": r"United Kingdom|\bUK\b|\bBritain\b|\bEngland\b|\bScotland\b|\bWales\b|Northern Ireland",
    "ie": r"\bIreland\b|\bDublin\b",
    "us": r"United States|\bUSA?\b",
}


class Companies:
    """`web` (a hermes_common.WebClient) enables a 1-credit Tavily search when free lookups find no site.

    `region_re` / `region` / `country` (optional) help confirm a candidate homepage belongs to a local company.
    """

    def __init__(self, web=None, region_re: re.Pattern | None = None, region: str = "", country: str = ""):
        self.tavily = getattr(web, "tavily", None)
        self.region = region
        self.country = COUNTRY_CODES.get(country.lower(), country.lower()) if country else None
        parts = [region_re.pattern] if region_re else []
        if country:
            parts.append(COUNTRY_SIGNALS.get(self.country, rf"\b{re.escape(country)}\b"))
        self.region_re = re.compile("|".join(f"(?:{p})" for p in parts), re.I) if parts else None
        try:
            self.cache: dict[str, dict] = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.cache = {}
        self.session = requests.Session()
        self.session.headers.update(BROWSER_HEADERS)
        self.pages: dict[str, tuple[str, str]] = {}

    def save(self) -> None:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        CACHE_FILE.write_text(json.dumps(self.cache, indent=1), encoding="utf-8")

    def _homepage(self, domain: str) -> tuple[str, str]:
        """(final URL, HTML) of a domain's homepage, or ("", "")."""
        if domain not in self.pages:
            self.pages[domain] = ("", "")
            for url in (f"https://{domain}", f"https://www.{domain}"):
                resp = safe_get(self.session, url, MAX_PAGE_BYTES, timeout=12)
                if resp is not None and resp.status_code == 200 and "html" in resp.headers.get("content-type", ""):
                    self.pages[domain] = (resp.url, resp.text[:400_000])
                    break
        return self.pages[domain]

    def _clearbit(self, name: str) -> list[str]:
        resp = safe_get(self.session, f"https://autocomplete.clearbit.com/v1/companies/suggest?query={quote(name)}",
                        200_000)
        try:
            items = resp.json() if resp is not None and resp.status_code == 200 else []
        except ValueError:
            return []
        if not isinstance(items, list):
            return []
        key = norm(name)
        return [i["domain"] for i in items if isinstance(i, dict) and i.get("domain") and norm(i.get("name", "")) == key]

    def _resolve_site(self, name: str, text: str) -> str:
        for domain in listing_domains(text):
            if domain_matches(domain, name):
                url, _ = self._homepage(domain)
                return url or f"https://{domain}"
        key = norm(name)
        exact = self._clearbit(name)[:4]
        best, best_score = "", 0
        for domain in exact:
            url, page = self._homepage(domain)
            if not page:
                # Bot-protected homepage: trust a unique exact match for a distinctive name.
                if len(exact) == 1 and len(key.replace(" ", "")) >= 6 and domain_matches(domain, name):
                    best, best_score = f"https://{domain}", 3
                continue
            visible = visible_text(page)
            named = key in norm(visible)
            score = (2 if named else 0) + (1 if self.region_re and self.region_re.search(visible) else 0) \
                + (1 if named and domain_matches(domain, name) else 0) \
                + (1 if named and len(key.replace(" ", "")) >= 6 and domain_matches(domain, name) else 0)
            if score > best_score:
                best, best_score = url, score
        if best_score >= 3:
            return best
        return self._search_site(name)

    def _search_site(self, name: str) -> str:
        if not self.tavily:
            return ""
        try:
            results = self.tavily.search(f"{name} {self.region} official website".replace("  ", " "), 5, None,
                                         self.country, "general")
        except Exception as exc:  # noqa: BLE001 - provider errors only cost us the website link
            log(f"company site search failed for {name}: {exc.__class__.__name__}")
            return ""
        for r in results:
            parts = urlsplit(r.get("url", ""))
            domain = parts.netloc.lower().removeprefix("www.")
            if domain and not NOT_COMPANY_SITES.search(domain) and domain_matches(domain, name):
                return f"{parts.scheme or 'https'}://{parts.netloc}/"
        return ""

    def _site_icon(self, site: str) -> bytes | None:
        domain = urlsplit(site).netloc
        url, page = self._homepage(domain.removeprefix("www."))
        candidates = []
        for tag in re.findall(r"<link\b[^>]+>", page, re.I):
            rel = re.search(r'rel=["\']([^"\']+)', tag, re.I)
            href = re.search(r'href=["\']([^"\']+)', tag, re.I)
            if rel and href and "icon" in rel.group(1).lower() and not href.group(1).lower().endswith(".svg"):
                sizes = re.search(r'sizes=["\'](\d+)', tag)
                weight = int(sizes.group(1)) if sizes else (180 if "apple" in rel.group(1).lower() else 16)
                candidates.append((weight, urljoin(url or site, href.group(1))))
        candidates.sort(reverse=True)
        urls = [u for w, u in candidates if w >= 64][:2]
        urls.append(f"https://www.google.com/s2/favicons?domain={domain}&sz=128")
        for icon_url in urls:
            png = self._image(icon_url)
            if png:
                return png
        return None

    def _image(self, url: str) -> bytes | None:
        resp = safe_get(self.session, url, MAX_IMAGE_BYTES)
        if resp is None or resp.status_code != 200 or not resp.content:
            return None
        kind = resp.headers.get("content-type", "").split(";")[0].strip().lower()
        if kind and not (kind.startswith("image/") or kind in ("application/octet-stream", "binary/octet-stream")):
            return None
        return circle_logo(resp.content)

    def lookup(self, name: str, logo_url: str = "", text: str = "") -> dict:
        """{"website": url or "", "logo": cid name or ""} for a company, cached."""
        name = " ".join((name or "").split())
        if not norm(name):
            return {"website": "", "logo": ""}
        key = norm(name)
        hit = self.cache.get(key)
        if hit and time.time() - hit.get("checked", 0) < CACHE_SECONDS and \
                (not hit.get("logo") or (LOGO_DIR / f"{hit['logo']}.png").is_file()):
            if hit.get("logo") or not logo_url:
                return hit
        website = (hit or {}).get("website") or self._resolve_site(name, text)
        png = None
        if logo_url:
            png = self._image(logo_url)
        if not png and website:
            png = self._site_icon(website)
        cid = ""
        if png:
            cid = f"logo-{slug(name)}"
            LOGO_DIR.mkdir(parents=True, exist_ok=True)
            (LOGO_DIR / f"{cid}.png").write_bytes(png)
        self.cache[key] = {"name": name, "website": website, "logo": cid, "checked": time.time()}
        log(f"company lookup: website {'found' if website else 'not found'}, logo {'yes' if cid else 'no'}")
        return self.cache[key]

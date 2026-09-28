#!/usr/bin/env python3
"""Daily Vacancy Report (HermitShell package): CV-matched job scanner rated by Hermes' model.

Finds roles that match a candidate profile (job_profile.md + cv_keywords.json),
optionally restricted to one region, rates each one with the model Hermes is
configured to use (config.yaml) and emails a scored HTML report.

Pipeline:
  1. Discover: Indeed job search through the Indeed MCP server connected to Hermes,
     web searches for single job postings (Firecrawl, Tavily backup), plus
     nijobs.com keyword listings when JOB_SCANNER_NIJOBS_KEYWORDS is set.
  2. Pre-filter on title relevance, drop already-seen jobs, fetch the rest
     (Indeed descriptions come from the MCP job-detail tool, not scraping).
  3. Hard filters: inside JOB_REGION_* when configured; full-time / permanent
     or contract only (no part-time, internships).
  4. Hermes' model returns fit score, confidence, matched CV keywords, gaps,
     and the real employer behind agency adverts.
  5. Company logo + website lookup, CV keyword coverage, HTML email.

Runs from $HERMES_HOME/scripts (see the package README for cron setup):
    python3 job_scanner.py              # full run + email
    python3 job_scanner.py --dry-run    # no email / state update
    python3 job_scanner.py --test-email # SMTP check only
"""

from __future__ import annotations

import argparse
import html
import json
import re
import smtplib
import time
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import requests

import hermes_common as hc
from companies import LOGO_DIR, Companies
from companies import norm as company_key
from hermes_common import (BROWSER_HEADERS, EMAIL_HEAD, STATE_DIR, WebClient, connect_model, env,
                           env_bool, env_int, first_sentences, gmail_dark_safe, html_to_text, inline_images,
                           load_env_file, log, ollama_chat)
from indeed_mcp import IndeedMCP

hc.LOG_TAG = "job_radar"
SEEN_FILE = STATE_DIR / "job_scanner_seen.json"
LAST_REPORT = STATE_DIR / "job_scanner_last.html"
LAST_RESULTS = STATE_DIR / "job_scanner_last.json"
PACKAGE_DIR = Path(__file__).resolve().parent
SEEN_RETENTION_DAYS = 90
MAX_LISTING_CHARS = 5000

DEFAULT_QUERY_TEMPLATES = [
    '("AI engineer" OR "machine learning engineer" OR "MLOps") {location} job',
    '("AI solutions engineer" OR "LLM engineer" OR "GenAI engineer") {location} job',
    '("automation engineer" OR "AI automation" OR "integration engineer") {location} job',
    '"data engineer" {location} job',
]
DEFAULT_INDEED_QUERIES = ["AI engineer", "machine learning engineer", "LLM engineer", "automation engineer",
                          "data engineer"]
DEFAULT_TITLE_STRONG = (r"\bai\b|artificial intelligence|machine learning|\bml\b|mlops|\bllm|gen ?ai|generative|\bnlp\b|"
                        r"data scien|automation|agentic|data engineer|solutions engineer|integration|intelligent|"
                        r"applied scien")
DEFAULT_TITLE_MEDIUM = (r"python|cloud|devops|platform engineer|software engineer|developer|\.net|c#|analytics|"
                        r"data analyst|data platform|rpa|innovation|digital transformation|full ?stack|backend|back-end")
TITLE_EXCLUDE = re.compile(
    r"\bintern(ship)?\b|part[- ]time|placement|apprentice|volunteer|\bsales\b|recruit(er|ment consultant)|"
    r"nurse|teacher|lecturer|driver|warehouse operative|cleaner", re.I)
# Country names in structured data ("United Kingdom of Great Britain and Northern Ireland") are not locations.
COUNTRY_FULL_NAMES = re.compile(r"united kingdom of great britain and northern ireland", re.I)


def load_settings() -> SimpleNamespace:
    """Everything personal or regional comes from the environment ($HERMES_HOME/.env)."""
    region = env("JOB_REGION_NAME", "")
    places = [p.strip() for p in (env("JOB_REGION_PLACES") or "").split(",") if p.strip()]
    pattern = env("JOB_REGION_REGEX") or "|".join(
        rf"\b{re.escape(p)}\b" for p in dict.fromkeys(places + ([region] if region else [])))
    location = env("JOB_SEARCH_LOCATION", region)
    nijobs = [k.strip() for k in (env("JOB_SCANNER_NIJOBS_KEYWORDS") or "").split(",") if k.strip()]
    queries = [q.strip() for q in (env("JOB_SCANNER_QUERIES") or "").split("||") if q.strip()] or [
        (t.format(location=f'"{location}"' if location else "") + (" -site:nijobs.com" if nijobs else "")).replace("  ", " ")
        for t in DEFAULT_QUERY_TEMPLATES]
    return SimpleNamespace(
        title=env("JOB_REPORT_TITLE", "Daily Vacancy Report"),
        tagline=env("JOB_REPORT_TAGLINE", "Roles matched to your CV"),
        candidate=env("JOB_CANDIDATE_NAME", "the candidate"),
        region=region,
        region_re=re.compile(pattern, re.I) if pattern else None,
        location=location,
        country=env("JOB_SEARCH_COUNTRY"),
        nijobs_keywords=nijobs,
        queries=queries,
        indeed=env_bool("JOB_INDEED", True),
        indeed_queries=[q.strip() for q in (env("JOB_INDEED_QUERIES") or "").split("||") if q.strip()]
        or DEFAULT_INDEED_QUERIES,
        indeed_location=env("JOB_INDEED_LOCATION", location),
        indeed_country=env("JOB_INDEED_COUNTRY", env("JOB_SEARCH_COUNTRY", "")),
        indeed_limit=env_int("JOB_INDEED_LIMIT", 15),
        indeed_days=env_int("JOB_INDEED_DAYS", 14),
        title_strong=re.compile(env("JOB_TITLE_STRONG", DEFAULT_TITLE_STRONG), re.I),
        title_medium=re.compile(env("JOB_TITLE_MEDIUM", DEFAULT_TITLE_MEDIUM), re.I),
        senior_penalty=env_int("JOB_SENIOR_PENALTY", 0),
        lead_penalty=env_int("JOB_LEAD_PENALTY", 0),
        profile_file=Path(env("JOB_PROFILE_FILE") or PACKAGE_DIR / "job_profile.md"),
        keywords_file=Path(env("JOB_KEYWORDS_FILE") or PACKAGE_DIR / "cv_keywords.json"),
        timezone=env("HERMES_TIMEZONE", "UTC"),
    )


CFG = load_settings()

SINGLE_POSTING = re.compile(
    r"nijobs\.com/job/|/jobs/view/|viewjob|jobs\.ac\.uk/job/|efinancialcareers\.[a-z.]+/jobs-.*\.id\d+|"
    r"boards\.greenhouse\.io/|jobs\.lever\.co/|jobs\.ashbyhq\.com/|apply\.workable\.com/|"
    r"builtinbelfast\.uk/job/|totaljobs\.com/job/|reed\.co\.uk/jobs/.+/\d+|cwjobs\.co\.uk/job/|"
    r"glassdoor\.[a-z.]+/job-listing/|jobijoba\.[a-z.]+/detail/|/vacanc(y|ies)/.+|/careers?/.+/\d+|"
    r"/job/[^/]+/\d+|/jobs/\d+|/job-details?/", re.I)
AGGREGATE_TITLE = re.compile(r"^\s*\d[\d,]*\+?\s.*\bjobs?\b|\bjobs in\b|job vacancies|updated daily", re.I)

ALLOWED_TYPES = {"Permanent", "Full-time", "Contract", "Temporary", "Unknown"}

SCORE_SCHEMA = {
    "type": "object",
    "properties": {
        "fit_score": {"type": "integer", "minimum": 0, "maximum": 10},
        "confidence": {"type": "integer", "minimum": 0, "maximum": 100},
        "reasoning": {"type": "string", "maxLength": 320},
        "matched_skills": {"type": "array", "items": {"type": "string", "maxLength": 40}, "maxItems": 12},
        "missing_skills": {"type": "array", "items": {"type": "string", "maxLength": 40}, "maxItems": 5},
        "employment_type": {"type": "string",
                            "enum": ["Permanent", "Full-time", "Contract", "Temporary",
                                     "Part-time", "Internship", "Unknown"]},
        "work_mode": {"type": "string", "enum": ["On-site", "Hybrid", "Remote", "Unknown"]},
        "location": {"type": "string", "maxLength": 80},
        "in_target_region": {"type": "boolean"},
        "company": {"type": "string", "maxLength": 80},
        "salary": {"type": "string", "maxLength": 60},
        "seniority": {"type": "string", "enum": ["Junior", "Mid", "Senior", "Lead/Principal", "Unknown"]},
        "recruitment_agency": {"type": "boolean"},
        "employer": {"type": "string", "maxLength": 80},
        "employer_about": {"type": "string", "maxLength": 260},
    },
    "required": ["fit_score", "confidence", "reasoning", "matched_skills", "missing_skills",
                 "employment_type", "work_mode", "location", "in_target_region", "company", "salary",
                 "seniority", "recruitment_agency", "employer", "employer_about"],
}


# --------------------------------------------------------------------------- config

def load_keywords() -> tuple[dict[str, re.Pattern], dict[str, re.Pattern]]:
    data = json.loads(CFG.keywords_file.read_text(encoding="utf-8"))
    cv = {k: re.compile(v, re.I) for k, v in data["cv_keywords"].items()}
    other = {k: re.compile(v, re.I) for k, v in data.get("other_tech", {}).items()}
    return cv, other


# --------------------------------------------------------------------------- state

def job_key(url: str) -> str:
    m = re.search(r"nijobs\.com/job/.*?(\d{6,})", url)
    if m:
        return f"nijobs:{m.group(1)}"
    m = re.search(r"indeed\.[a-z.]+/.*[?&](?:jk|vjk)=([0-9a-f]{8,})", url, re.I)
    if m:
        return f"indeed:{m.group(1).lower()}"
    parts = urlsplit(url.strip())
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in {"cid", "source", "ref", "trk", "gh_src"}]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"), urlencode(query), ""))


def load_seen() -> dict[str, float]:
    try:
        return {k: float(v) for k, v in json.loads(SEEN_FILE.read_text(encoding="utf-8")).items()}
    except (FileNotFoundError, ValueError, AttributeError):
        return {}


def save_seen(seen: dict[str, float]) -> None:
    cutoff = time.time() - SEEN_RETENTION_DAYS * 86400
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SEEN_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({k: v for k, v in seen.items() if v >= cutoff}, indent=1), encoding="utf-8")
    tmp.replace(SEEN_FILE)


# --------------------------------------------------------------------------- firecrawl

def clean_title(title: str) -> str:
    title = title.replace("\\|", "|").replace("\\", "")
    title = re.sub(r"\s+[-|–]\s+(LinkedIn|Jobijoba UK|Indeed|Glassdoor|Totaljobs|Reed|CWJobs|Jobs\.ac\.uk|"
                   r"eFinancialCareers|Built In Belfast|The Sun Jobs|Ni Jobs)\b.*$", "", title, flags=re.I)
    if CFG.location:
        title = re.sub(rf"\s+-\s+{re.escape(CFG.location)}\s*$", "", title, flags=re.I)
    return re.sub(r"\s+", " ", title).strip()


LEAD_TITLE = re.compile(r"\b(lead|principal|staff|head|director|vp|chief)\b", re.I)
SENIOR_TITLE = re.compile(r"\bsenior\b|\bsnr\b|\bsr\.?\b", re.I)


def seniority_penalty(title: str) -> int:
    if LEAD_TITLE.search(title):
        return CFG.lead_penalty
    if SENIOR_TITLE.search(title):
        return CFG.senior_penalty
    return 0


def title_relevance(title: str) -> int:
    if TITLE_EXCLUDE.search(title):
        return -1
    return 3 * len(CFG.title_strong.findall(title)) + len(CFG.title_medium.findall(title))


class _DataAtText(HTMLParser):
    """Text content of the first element carrying each wanted data-at attribute."""
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}

    def __init__(self, wanted: set[str]):
        super().__init__(convert_charrefs=True)
        self.wanted, self.stack, self.out, self.skip = wanted, [], {}, 0

    def handle_starttag(self, tag, attrs):
        if tag in ("style", "script"):
            self.skip += 1
            return
        if tag in self.VOID:
            return
        at = dict(attrs).get("data-at")
        self.stack.append(at if at in self.wanted and at not in self.out else None)
        if self.stack[-1]:
            self.out[at] = []

    def handle_endtag(self, tag):
        if tag in ("style", "script"):
            self.skip = max(0, self.skip - 1)
        elif tag not in self.VOID and self.stack:
            self.stack.pop()

    def handle_data(self, data):
        if not self.skip:
            for at in self.stack:
                if at:
                    self.out[at].append(data)

    def text(self) -> dict[str, str]:
        return {k: " ".join(" ".join(v).split()) for k, v in self.out.items()}


class Nijobs:
    """Direct (free) access to nijobs.com listing and job pages.

    The site's bot manager stalls requests without its cookies, so the session is warmed
    up on a listing page first and re-warmed if a request times out.
    """
    BASE = "https://www.nijobs.com"
    FIELDS = {"header-job-title", "metadata-company-name", "metadata-location", "metadata-salary",
              "metadata-contract-type", "metadata-online-date", "job-ad-company-card"}

    def __init__(self, web: WebClient):
        self.web = web
        self.session: requests.Session | None = None

    def _get(self, url: str) -> str | None:
        for attempt in (1, 2):
            if self.session is None:
                self.session = requests.Session()
                self.session.headers.update(BROWSER_HEADERS)
                if not url.startswith(f"{self.BASE}/jobs/"):
                    try:
                        self.session.get(f"{self.BASE}/jobs/machine-learning", timeout=20)
                    except requests.RequestException:
                        pass
            time.sleep(1)
            try:
                resp = self.session.get(url, timeout=20)
            except requests.RequestException as exc:
                log(f"nijobs direct fetch failed (attempt {attempt}): {exc.__class__.__name__}")
                self.session = None
                continue
            if resp.status_code == 200 and len(resp.text) > 5000:
                self.web.direct_pages += 1
                return resp.text
            log(f"nijobs direct fetch HTTP {resp.status_code} for {url[-60:]}")
            self.session = None
        return None

    def listing(self, keyword: str) -> list[tuple[str, str]]:
        url = f"{self.BASE}/jobs/{keyword}"
        page = self._get(url)
        if page:
            links = []
            for m in re.finditer(r'<a\b([^>]*data-at="job-item-title"[^>]*)>(.*?)</a>', page, re.S):
                href = re.search(r'href="(/job/[^"?#]+)', m.group(1))
                title = html_to_text(re.sub(r"<style[^>]*>.*?</style>", "", m.group(2), flags=re.S))
                if href and title:
                    links.append((" ".join(title.split()), self.BASE + href.group(1)))
            if links:
                return links
        md = self.web.scrape(url) or ""
        return re.findall(r"\[([^\]\n]{3,160})\]\((https://www\.nijobs\.com/job/[^)\s]+)\)", md)

    def job(self, url: str) -> tuple[dict, str] | None:
        page = self._get(url)
        if not page:
            return None
        parser = _DataAtText(self.FIELDS)
        parser.feed(page)
        fields = parser.text()
        description, logo_url, links = "", "", ""
        for block in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', page, re.S):
            try:
                data = json.loads(block)
            except ValueError:
                continue
            if isinstance(data, dict) and data.get("@type") == "JobPosting":
                org = data.get("hiringOrganization") or {}
                description = html_to_text(data.get("description") or "")
                links = " ".join(re.findall(r'href="([^"]+)"', data.get("description") or ""))
                logo_url = org.get("logo") or ""
                fields.setdefault("metadata-company-name", org.get("name", ""))
                break
        if len(description) < 200:
            return None
        salary = fields.get("metadata-salary", "")
        company = fields.get("metadata-company-name", "")
        card = re.sub(r"\s*(\d[\d,]*\s+Jobs?\b.*|Company Profile.*)$", "", fields.get("job-ad-company-card", ""))
        facts = {
            "company": company,
            "company_profile": card[len(company):].strip(" •") if company and card.startswith(company) else "",
            "logo_url": logo_url,
            "links": links,
            "location": fields.get("metadata-location", ""),
            "type_line": fields.get("metadata-contract-type", ""),
            "salary": "" if re.search(r"not disclosed|competitive$", salary, re.I) else salary,
            "published": ("Posted " + fields["metadata-online-date"].split(":", 1)[-1].strip())
            if fields.get("metadata-online-date") else "",
        }
        title = fields.get("header-job-title", "")
        return {k: v for k, v in facts.items() if v}, f"# {title}\n\n{description}"[:MAX_LISTING_CHARS]


def discover(web: WebClient, nijobs: Nijobs, nijobs_keywords: list[str], queries: list[str], tbs: str,
             use_search: bool, indeed: IndeedMCP | None = None) -> list[dict]:
    found: dict[str, dict] = {}

    if indeed:
        for item in indeed.search(CFG.indeed_queries, CFG.indeed_location, CFG.indeed_limit,
                                  CFG.indeed_country, CFG.indeed_days):
            key = f"indeed:{item['job_id'].lower()}" if item["job_id"] else job_key(item["url"])
            found.setdefault(key, {"key": key, "url": item["url"], "title": clean_title(item["title"]),
                                   "description": item["snippet"], "source": "indeed.com", "indeed": item})

    for kw in nijobs_keywords:
        links = nijobs.listing(kw)
        log(f"nijobs '{kw}': {len(links)} postings")
        for title, link in links:
            title = clean_title(title)
            if title.lower().startswith("!["):
                continue
            key = job_key(link)
            found.setdefault(key, {"key": key, "url": link.split("?")[0], "title": title,
                                   "description": "", "source": "nijobs.com"})

    if use_search:
        for query in queries:
            results = web.search(query, 8, tbs, country=CFG.country)
            kept = 0
            for item in results:
                link = item.get("url") or ""
                title = clean_title(item.get("title") or "")
                if not SINGLE_POSTING.search(link) or AGGREGATE_TITLE.search(title):
                    continue
                key = job_key(link)
                if key not in found:
                    found[key] = {"key": key, "url": link, "title": title,
                                  "description": (item.get("description") or "").strip(),
                                  "source": urlsplit(link).netloc.replace("www.", "")}
                    kept += 1
            log(f"search '{query[:60]}...': {len(results)} results, {kept} new postings")
    return list(found.values())


# --------------------------------------------------------------------------- parsing

def clean_listing(md: str) -> str:
    start = re.search(r"^# .+", md, re.M)
    if start:
        md = md[start.start():]
    for marker in ("Similar jobs", "Recommended jobs", "Jobs you might", "More jobs", "Related jobs"):
        idx = md.find(marker)
        if idx > 500:
            md = md[:idx]
    md = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", md)
    md = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", md)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip()


def header_facts(md: str) -> dict:
    """nijobs-style header bullets: location, contract type, salary, published."""
    facts: dict = {}
    m = re.search(r"^# .+\n+((?:- .*\n?)+)", md, re.M)
    if not m:
        return facts
    for line in m.group(1).splitlines():
        item = line[2:].strip()
        if item.endswith("View Profile"):
            facts["company"] = item[:-len("View Profile")].strip()
        elif "#location" in item or (not facts.get("location") and CFG.region_re and CFG.region_re.search(item)):
            facts["location"] = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", item)
        elif re.search(r"permanent|contract|temporary|part[- ]time|full[- ]time", item, re.I):
            facts["type_line"] = item
        elif "£" in item or re.search(r"per (annum|day|hour)|salary", item, re.I):
            facts["salary"] = item
        elif item.lower().startswith("published"):
            facts["published"] = "Posted " + item.split(":", 1)[-1].strip()
    return facts


def detect_type(text: str, check_internship: bool = True) -> str | None:
    t = text.lower()
    if check_internship and re.search(r"\bintern(ship)?\b|placement year", t):
        return "Internship"
    if re.search(r"part[- ]time", t) and not re.search(r"full[- ]time", t):
        return "Part-time"
    if "permanent" in t:
        return "Permanent"
    if re.search(r"\bcontract(or)?\b|day rate|per day|\bir35\b|fixed[- ]term|\bftc\b", t):
        return "Contract"
    if re.search(r"\btemporary\b|\btemp\b", t):
        return "Temporary"
    if re.search(r"full[- ]time", t):
        return "Full-time"
    return None


def detect_mode(text: str) -> str | None:
    t = text.lower()
    for mode, pat in (("Hybrid", r"\bhybrid\b"), ("Remote", r"\bremote\b|work from home|\bwfh\b"),
                      ("On-site", r"on[- ]site|office[- ]based")):
        if re.search(pat, t):
            return mode
    return None


def in_region(text: str) -> bool:
    return CFG.region_re is None or bool(CFG.region_re.search(COUNTRY_FULL_NAMES.sub(" ", text)))


def keyword_match(text: str, cv: dict[str, re.Pattern], other: dict[str, re.Pattern]) -> tuple[list[str], list[str]]:
    matched = [k for k, rx in cv.items() if rx.search(text)]
    gaps = [k for k, rx in other.items() if rx.search(text)]
    return matched, gaps


# --------------------------------------------------------------------------- model

SYSTEM_PROMPT = (
    "You are Hermes, a precise career-matching assistant. You compare a job listing with a candidate's CV "
    "and answer with strict JSON only. Be honest and critical: do not inflate scores."
)


def rate_job(host: str, model: str, num_ctx: int | None, profile: str, cv_keywords: list[str],
             job: dict) -> dict | None:
    facts = job.get("facts") or {}
    fact_lines = "\n".join(f"{k}: {v}" for k, v in facts.items() if k not in ("logo_url", "links")) or "none"
    user = (
        f"CANDIDATE CV SUMMARY:\n{profile}\n\n"
        f"CV KEYWORDS (matched_skills must only use these exact strings):\n{', '.join(cv_keywords)}\n\n"
        "JOB LISTING\n"
        f"Title: {job['title']}\nURL: {job['url']}\nSource: {job['source']}\n"
        f"Structured facts from the page:\n{fact_lines}\n"
        f"Listing text:\n{job['text'][:MAX_LISTING_CHARS]}\n\n"
        "TASK: Rate how well this job fits the candidate.\n"
        "fit_score rubric: 9-10 core AI/ML/automation role where most key requirements are on the CV and "
        "seniority matches; 7-8 strong overlap with one or two notable gaps; 5-6 partial or adjacent fit; "
        "0-4 weak fit, wrong discipline, or seniority far above/below the candidate. Be discriminating: a "
        "typical relevant listing scores 5-7; reserve 9-10 for exceptional matches. Deduct for required "
        "technologies or domains (e.g. C++, computer vision, robotics, GCP) the CV does not show.\n"
        "confidence (0-100): how certain you are about fit_score given how detailed the listing is.\n"
        "matched_skills: CV keywords the job explicitly asks for or clearly involves.\n"
        "missing_skills: up to 5 important requirements from the listing the CV does not show.\n"
        f"in_target_region: true only if the job is based in {CFG.region or 'a location the CV says is acceptable'} "
        "(on-site, hybrid, or remote but explicitly tied to it).\n"
        "reasoning: at most two short sentences (under 50 words) speaking to the candidate as 'you'.\n"
        "recruitment_agency: true if the advertiser is a recruitment agency or consultancy hiring for a client.\n"
        "employer: the company the successful candidate would actually work for, exactly as named in the "
        "listing; empty string if an agency does not name its client.\n"
        "employer_about: one short sentence (under 30 words) describing the employer (sector, size, what it "
        "does, where it is based) using only what the listing text says about it. When an agency advertises, "
        "describe the agency's client, never the agency itself (company_profile describes the advertiser, so "
        "do not use it here); empty string if the listing does not describe the employer.\n"
        "Use empty string or 'Unknown' when the listing does not say. Keep every field brief."
    )
    for num_predict in (900, 1600):
        try:
            data = json.loads(ollama_chat(host, model, SYSTEM_PROMPT, user, num_ctx, SCORE_SCHEMA,
                                          num_predict=num_predict))
            data["fit_score"] = max(0, min(10, int(data.get("fit_score", 0))))
            data["confidence"] = max(0, min(100, int(data.get("confidence", 0))))
            data["reasoning"] = first_sentences(str(data.get("reasoning", "")), 2)
            return data
        except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
            log(f"rating failed for {job['title'][:50]}: {exc.__class__.__name__}: {str(exc)[:120]}")
    return None


def hermes_summary(host: str, model: str, num_ctx: int | None, jobs: list[dict]) -> str:
    if not jobs:
        return ""
    lines = "\n".join(f"- {j['title']} at {j['company'] or 'unknown company'} ({j['location']}): "
                      f"fit {j['fit']}/10, {j['reasoning']}" for j in jobs[:6])
    region = f"{CFG.region} " if CFG.region else ""
    user = (f"Today's best {region}job matches for {CFG.candidate}:\n{lines}\n\n"
            "The list is ranked best first, so the first job is the strongest match.\n"
            "Write 2-3 short sentences addressed to the candidate as 'you': highlight the first (strongest) "
            "opportunity and why, mention any pattern across the list, and suggest one concrete next step. "
            "Plain text, no lists, no greeting.")
    try:
        return ollama_chat(host, model, "You are Hermes, a concise career assistant.", user,
                           num_ctx, num_predict=180).strip()
    except requests.RequestException as exc:
        log(f"summary failed: {exc.__class__.__name__}")
        return ""


STOPWORDS = set("about after also based being from have into more only other over such than that their them "
                "then there these they this very what when which while with within would your".split())


def grounded(sentence: str, source: str) -> bool:
    words = [w for w in re.findall(r"[a-z0-9]{4,}", sentence.lower()) if w not in STOPWORDS]
    src = source.lower()
    return bool(words) and sum(w in src for w in words) / len(words) >= 0.6


def enrich_company(companies: Companies, entry: dict, job: dict, rating: dict) -> None:
    facts = job["facts"]
    text = f"{job['text']}\n{facts.get('links', '')}"
    advertiser = entry["company"]
    profile = facts.get("company_profile", "")
    employer = " ".join(str(rating.get("employer") or "").split())
    if (not re.match(r"[A-Z0-9]", employer) or re.match(r"(?i)(a|an|our|the|confidential|client|unknown)\b", employer)
            or employer.lower() not in text.lower()
            or {w for w in company_key(employer).split() if len(w) >= 4} & set(company_key(advertiser).split())
            or company_key(employer) == company_key(advertiser)):
        employer = ""
    about = " ".join(str(rating.get("employer_about") or "").split())
    agency = bool(rating.get("recruitment_agency")) or bool(re.search(r"recruit|staffing", profile, re.I))
    if (re.search(r"(?i)not (stated|specified|described|mentioned|provided)|^unknown", about)
            or (agency and re.search(r"(?i)recruit|staffing", about)) or not grounded(about, text)):
        about = ""
    adv = companies.lookup(advertiser, facts.get("logo_url", ""), text) if advertiser else {}
    emp = companies.lookup(employer, "", text) if employer else {}
    entry.update({
        "agency": agency,
        "company_profile": profile.replace("•", "·"), "company_site": adv.get("website", ""),
        "company_logo": adv.get("logo", ""), "employer": employer, "employer_site": emp.get("website", ""),
        "employer_logo": emp.get("logo", ""), "about": about,
    })


# --------------------------------------------------------------------------- email

C_BG, C_CARD, C_INK, C_MUTED, C_ACCENT = "#eef1f7", "#ffffff", "#0f172a", "#64748b", "#4f46e5"


def fit_colour(score: int) -> str:
    return "#059669" if score >= 8 else "#0d9488" if score >= 7 else "#d97706" if score >= 5 else "#dc2626"


def esc(text) -> str:
    return html.escape(str(text or ""), quote=True)


def meter(label: str, value_text: str, pct: int, colour: str) -> str:
    pct = max(2, min(100, pct))
    return (
        f'<td width="33%" valign="top" style="padding:0 8px 0 0">'
        f'<div style="font-size:11px;color:{C_MUTED};text-transform:uppercase;letter-spacing:.06em">{label}</div>'
        f'<div style="font-size:16px;font-weight:700;color:{C_INK};margin:2px 0 6px">{value_text}</div>'
        f'<table width="100%" cellpadding="0" cellspacing="0" style="background:#e2e8f0;border-radius:99px">'
        f'<tr><td width="{pct}%" style="background:{colour};height:6px;border-radius:99px;font-size:0;line-height:0">&nbsp;</td>'
        f'<td style="font-size:0;line-height:0">&nbsp;</td></tr></table></td>'
    )


def chips(items: list[str], fg: str, bg: str, border: str) -> str:
    return "".join(
        f'<span style="display:inline-block;background:{bg};color:{fg};border:1px solid {border};'
        f'border-radius:999px;padding:3px 10px;font-size:12px;margin:0 6px 6px 0">{esc(i)}</span>'
        for i in items)


def pill(text: str) -> str:
    return (f'<span style="display:inline-block;background:#eef2ff;color:#3730a3;border-radius:6px;'
            f'padding:3px 8px;font-size:12px;font-weight:600;margin:0 6px 6px 0">{esc(text)}</span>')


AVATAR_COLOURS = ("#4f46e5", "#0d9488", "#db2777", "#d97706", "#2563eb", "#7c3aed", "#059669", "#dc2626")


def company_avatar(name: str, cid: str) -> str:
    if cid:
        return (f'<img src="cid:{cid}" width="48" height="48" alt="{esc(name)}" '
                f'style="display:block;width:48px;height:48px;border:0;border-radius:24px">')
    initials = "".join(w[0] for w in re.findall(r"[A-Za-z0-9]+", name)[:2]).upper() or "?"
    colour = AVATAR_COLOURS[sum(map(ord, name)) % len(AVATAR_COLOURS)]
    return (f'<table cellpadding="0" cellspacing="0"><tr><td width="48" height="48" align="center" valign="middle" '
            f'style="width:48px;height:48px;border-radius:24px;background:{colour};color:#ffffff;font-size:17px;'
            f'font-weight:800;text-align:center">{esc(initials)}</td></tr></table>')


def site_link(url: str) -> str:
    if not url:
        return ""
    domain = urlsplit(url).netloc.removeprefix("www.")
    return (f'<a href="{esc(url)}" style="color:{C_ACCENT};text-decoration:none;font-weight:600;'
            f'white-space:nowrap">{esc(domain)} &#8599;</a>')


def about_block(job: dict) -> str:
    advertiser, employer = job["company"], job.get("employer", "")
    profile, about = job.get("company_profile", ""), job.get("about", "")
    about_line = f'<div style="margin-top:4px">{esc(about)}</div>' if about else ""
    if employer:
        main = " &middot; ".join(x for x in (f"<b>{esc(employer)}</b>", site_link(job.get("employer_site", ""))) if x)
        via = " &middot; ".join(x for x in (f"Advertised by <b>{esc(advertiser)}</b>" if advertiser else "",
                                           esc(profile), site_link(job.get("company_site", ""))) if x)
        body = f'{main}{about_line}<div style="margin-top:6px;color:{C_MUTED}">{via}</div>' if via else f"{main}{about_line}"
    elif job.get("agency") and advertiser:
        via = " &middot; ".join(x for x in (f"<b>{esc(advertiser)}</b>", esc(profile),
                                           site_link(job.get("company_site", ""))) if x)
        body = (f'{via}<div style="margin-top:4px;color:{C_MUTED}">Recruiting for a client who is not named in the '
                f'listing.</div>{about_line}')
    elif advertiser and (profile or about or job.get("company_site")):
        main = " &middot; ".join(x for x in (f"<b>{esc(advertiser)}</b>", esc(profile),
                                            site_link(job.get("company_site", ""))) if x)
        body = f"{main}{about_line}"
    else:
        return ""
    return (f'<div style="margin-top:12px;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;'
            f'font-size:13px;color:#334155;line-height:1.5">'
            f'<div style="font-size:11px;color:{C_MUTED};text-transform:uppercase;letter-spacing:.06em;'
            f'margin-bottom:4px">About the company</div>{body}</div>')


def job_card(job: dict, rank: int) -> str:
    colour = fit_colour(job["fit"])
    shown = job.get("employer") or job["company"]
    logo = (job.get("employer_logo") if job.get("employer") else "") or job.get("company_logo", "")
    company = (f'<a href="{esc(job["company_site"])}" style="color:#475569;text-decoration:underline">{esc(job["company"])}</a>'
               if job.get("company_site") and job["company"] else esc(job["company"]))
    meta = " &middot; ".join(x for x in (company, esc(job["location"])) if x)
    pills = "".join(pill(p) for p in (job["employment_type"], job["work_mode"], job["salary"],
                                        job["seniority"], job.get("published")) if p and p != "Unknown")
    matched = chips(job["matched"], "#047857", "#ecfdf5", "#a7f3d0") or \
        f'<span style="font-size:12px;color:{C_MUTED}">None detected</span>'
    gaps = chips(job["gaps"], "#b45309", "#fffbeb", "#fde68a")
    gaps_block = (f'<div style="font-size:11px;color:{C_MUTED};text-transform:uppercase;letter-spacing:.06em;'
                  f'margin:10px 0 6px">Gaps to address</div>{gaps}') if gaps else ""
    note = ('<div style="font-size:11px;color:#b45309;margin-top:6px">Rated from the search snippet only '
            '(page could not be scraped), so confidence is capped.</div>') if job["snippet_only"] else ""
    return f"""
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_CARD};border:1px solid #e2e8f0;border-radius:16px;margin:0 0 18px">
<tr><td style="padding:22px 24px">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="62" valign="top" style="padding-top:2px">{company_avatar(shown, logo)}</td>
    <td valign="top">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:{C_ACCENT};font-weight:700">#{rank} &middot; {esc(job['source'])}</div>
      <a href="{esc(job['url'])}" style="display:block;font-size:19px;font-weight:700;color:{C_INK};text-decoration:none;line-height:1.3;margin:4px 0">{esc(job['title'])}</a>
      <div style="font-size:13px;color:#475569;margin-bottom:10px">{meta}</div>
      <div>{pills}</div>
    </td>
    <td width="84" valign="top" align="right">
      <table cellpadding="0" cellspacing="0"><tr><td align="center" valign="middle" width="68" height="68"
        style="width:68px;height:68px;border-radius:34px;background:{colour};color:#ffffff;font-size:24px;font-weight:800;text-align:center">
        {job['fit']}<span style="font-size:12px;font-weight:600;opacity:.85">/10</span></td></tr></table>
    </td>
  </tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 16px"><tr>
    {meter("Hermes fit", f"{job['fit']}/10", job['fit'] * 10, colour)}
    {meter("Confidence", f"{job['confidence']}%", job['confidence'], "#6366f1")}
    {meter("CV keyword match", f"{job['coverage']}%", job['coverage'], "#0ea5e9")}
  </tr></table>
  <div style="background:#f8fafc;border-left:3px solid {C_ACCENT};border-radius:8px;padding:12px 14px;font-size:14px;color:#334155;line-height:1.5">{esc(job['reasoning'])}</div>
  {about_block(job)}
  <div style="font-size:11px;color:{C_MUTED};text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px">Matches your CV ({len(job['matched'])})</div>
  {matched}
  {gaps_block}
  {note}
  <div style="margin-top:16px"><a href="{esc(job['url'])}" style="display:inline-block;background:{C_ACCENT};color:#ffffff;padding:11px 20px;border-radius:10px;font-size:14px;font-weight:600;text-decoration:none">View job &rarr;</a>
  <span style="font-size:11px;color:{C_MUTED};margin-left:10px;word-break:break-all">{esc(job['url'])}</span></div>
</td></tr></table>"""


def stat_tile(value, label: str) -> str:
    return (f'<td width="25%" align="center" style="padding:6px">'
            f'<div style="background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:12px 6px">'
            f'<div style="font-size:24px;font-weight:800;color:#ffffff">{value}</div>'
            f'<div style="font-size:11px;color:#c7d2fe;text-transform:uppercase;letter-spacing:.06em">{label}</div></div></td>')


def section(title: str, subtitle: str, jobs: list[dict], start: int) -> str:
    if not jobs:
        return ""
    cards = "".join(job_card(j, start + i) for i, j in enumerate(jobs))
    return (f'<div style="margin:26px 0 12px"><div style="font-size:18px;font-weight:800;color:{C_INK}">{title}</div>'
            f'<div style="font-size:13px;color:{C_MUTED}">{subtitle}</div></div>{cards}')


def build_html(top: list[dict], maybe: list[dict], stats: dict, summary: str) -> str:
    summary_block = (
        f'<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e0e7ff;border-radius:16px;margin:22px 0 4px">'
        f'<tr><td style="padding:18px 22px"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:{C_ACCENT};font-weight:700">Hermes&rsquo; take</div>'
        f'<div style="font-size:15px;color:#1e293b;line-height:1.6;margin-top:6px">{esc(summary)}</div></td></tr></table>'
    ) if summary else ""
    where = f" in {esc(CFG.region)}" if CFG.region else ""
    empty = "" if top or maybe else (
        f'<div style="background:#fff;border-radius:16px;padding:28px;text-align:center;color:{C_MUTED};margin-top:22px">'
        f'No new matching roles{where} this run. Hermes will keep looking.</div>')
    location_filter = f"located in {esc(CFG.region)} &middot; " if CFG.region_re else ""
    outside = f"{stats['excluded_location']} outside {esc(CFG.region or 'the region')}, " if CFG.region_re else ""
    penalty_note = (f"Hermes fit is reduced by {CFG.senior_penalty} for Senior and {CFG.lead_penalty} for "
                    f"Lead/Principal titles to reflect your experience level."
                    if CFG.senior_penalty or CFG.lead_penalty else "")
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">{EMAIL_HEAD}<title>{esc(CFG.title)}</title></head>
<body class="body" style="margin:0;padding:0;background:{C_BG};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_BG}"><tr><td align="center" style="padding:24px 12px">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%">
<tr><td style="background:#1e1b4b;background-image:linear-gradient(135deg,#0f172a 0%,#312e81 55%,#6d28d9 100%);border-radius:20px;padding:30px 28px">{gmail_dark_safe(f'''
  <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#a5b4fc;font-weight:700">Hermes &middot; {esc(CFG.region or 'Job radar')}</div>
  <div style="font-size:30px;font-weight:800;color:#ffffff;margin:6px 0 4px">{esc(CFG.title)}</div>
  <div style="font-size:15px;color:#e0e7ff;font-weight:600">{esc(CFG.tagline)}</div>
  <div style="font-size:13px;color:#c7d2fe;margin-top:4px">{esc(stats['when'])}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr>
    {stat_tile(stats['shown'], 'Matches')}{stat_tile(stats['strong'], 'Fit 7+')}{stat_tile(stats['avg_fit'], 'Avg fit')}{stat_tile(stats['scanned'], 'Scanned')}
  </tr></table>''')}
</td></tr>
<tr><td>
  {summary_block}
  {section("Top matches", "Fit score 7 or higher: apply to these first.", top, 1)}
  {section("Worth a look", "Partial fit: adjacent roles or a few gaps to cover.", maybe, len(top) + 1)}
  {empty}
  <div style="font-size:12px;color:{C_MUTED};line-height:1.6;padding:18px 6px 6px;text-align:center">
    Filters: {location_filter}full-time/permanent or contract &middot; fit &ge; {stats['min_score']}/10.<br>
    Excluded this run: {outside}{stats['excluded_type']} part-time/internship, {stats['below_min']} below threshold.<br>
    Rated by {esc(stats['model'])} (Hermes&rsquo; model) on your Hermes server &middot; sources: {esc(stats['sources'])} &middot;
    Web data: {stats['web_usage']}.<br>
    CV keyword match = share of the technologies named in the listing that appear on your CV.
    {penalty_note}
  </div>
</td></tr>
</table></td></tr></table></body></html>"""


def build_text(jobs: list[dict], summary: str) -> str:
    parts = [summary, ""] if summary else []
    for i, j in enumerate(jobs, 1):
        parts.append(f"#{i} [{j['fit']}/10, confidence {j['confidence']}%, CV match {j['coverage']}%] "
                     f"{j['title']} - {j['company']} ({j['location']}, {j['employment_type']})\n"
                     f"   {j['reasoning']}\n   Matches: {', '.join(j['matched']) or '-'}\n   {j['url']}"
                     + "".join(f"\n   {label}: {j[k]}" for label, k in (("Employer", "employer"), ("About", "about"),
                                                                        ("Company site", "company_site"))
                               if j.get(k)))
    where = f" in {CFG.region}" if CFG.region else ""
    return "\n\n".join(parts) or f"No new matching roles{where} this run."


# --------------------------------------------------------------------------- main

def main() -> int:
    global CFG
    parser = argparse.ArgumentParser(description="CV-matched job scanner rated by Hermes' model.")
    parser.add_argument("--dry-run", action="store_true", help="don't send email or update seen-state")
    parser.add_argument("--test-email", action="store_true", help="send a test email and exit")
    parser.add_argument("--limit", type=int, help="max job pages to scrape and rate this run")
    parser.add_argument("--include-seen", action="store_true", help="re-rate jobs from previous runs")
    parser.add_argument("--no-search", action="store_true", help="board listings only (nijobs.com), skip web searches")
    parser.add_argument("--no-indeed", action="store_true", help="skip the Indeed MCP source")
    args = parser.parse_args()

    load_env_file()
    CFG = load_settings()
    when = datetime.now(ZoneInfo(CFG.timezone)).strftime("%A %d %B %Y, %H:%M %Z")

    if args.test_email:
        stats = {"when": when, "shown": 0, "strong": 0, "avg_fit": "-", "scanned": 0, "min_score": 0,
                 "excluded_location": 0, "excluded_type": 0, "below_min": 0, "model": "n/a",
                 "sources": "n/a", "web_usage": "n/a"}
        hc.send_email(f"{CFG.title}: SMTP test", build_html([], [], stats, "SMTP test."),
                      "SMTP test.", CFG.title)
        print("Test email sent.")
        return 0

    try:
        host, model, num_ctx = connect_model("JOB_SCANNER_MODEL")
    except RuntimeError as exc:
        log(str(exc))
        return 3

    try:
        profile = CFG.profile_file.read_text(encoding="utf-8").strip()
        cv_kw, other_kw = load_keywords()
    except OSError as exc:
        log(f"Candidate profile missing ({exc}); copy job_profile.example.md and cv_keywords.example.json")
        return 4
    nijobs_kw, queries = CFG.nijobs_keywords, CFG.queries
    max_scrape = args.limit or env_int("JOB_SCANNER_MAX_SCRAPE", 15)
    min_score = env_int("JOB_SCANNER_MIN_SCORE", 5)
    tbs = env("JOB_SCANNER_TBS", "qdr:m")

    try:
        web = WebClient(env_int("JOB_SCANNER_MIN_CREDITS", 40))
    except RuntimeError as exc:
        log(str(exc))
        return 2
    nijobs = Nijobs(web)
    companies = Companies(web, CFG.region_re, CFG.region, CFG.country or "")
    seen = load_seen()

    indeed = IndeedMCP() if CFG.indeed and not args.no_indeed else None
    candidates = discover(web, nijobs, nijobs_kw, queries, tbs, use_search=not args.no_search, indeed=indeed)

    scored_titles = []
    for c in candidates:
        rel = title_relevance(c["title"])
        if rel > 0 and (args.include_seen or c["key"] not in seen):
            scored_titles.append((rel + (1 if c["source"] == "nijobs.com" else 0), c))
    scored_titles.sort(key=lambda x: x[0], reverse=True)
    queue = [c for _, c in scored_titles[:max_scrape]]
    log(f"{len(candidates)} postings discovered, {len(scored_titles)} relevant & unseen, rating {len(queue)}")
    indeed_details = indeed.details([j["indeed"] for j in queue if j["source"] == "indeed.com"]) if indeed else {}

    now = time.time()
    results, processed = [], []
    excluded_location = excluded_type = below_min = 0
    for i, job in enumerate(queue, 1):
        facts, text = {}, ""
        if job["source"] == "nijobs.com":
            facts, text = nijobs.job(job["url"]) or ({}, "")
        elif job["source"] == "indeed.com":
            item = job["indeed"]
            detail_facts, text = indeed_details.get(item["job_id"], ({}, ""))
            facts = {k: item[k] for k in ("company", "location", "salary", "type_line", "published") if item[k]}
            facts.update(detail_facts)
        if not text and "linkedin.com" not in job["url"] and job["source"] != "indeed.com":
            md = web.scrape(job["url"])
            if md:
                facts, text = header_facts(md), clean_listing(md)
        job["snippet_only"] = not text
        job["facts"] = facts
        job["text"] = text or f"{job['title']}\n{job['description']}"
        full_text = f"{job['title']}\n{job['description']}\n{job['text']}"
        processed.append(job["key"])

        det_type = detect_type(job["facts"].get("type_line", "")) or \
            detect_type(f"{job['title']}\n{job['text'][:1500]}", check_internship=False)
        if det_type in ("Part-time", "Internship"):
            excluded_type += 1
            log(f"[{i}/{len(queue)}] skip ({det_type}) {job['title'][:70]}")
            continue
        loc_text = job["facts"].get("location") or ""
        local = in_region(loc_text) if loc_text else in_region(full_text[:5000])
        if not local and (loc_text or job["source"] != "nijobs.com"):
            excluded_location += 1
            log(f"[{i}/{len(queue)}] skip (outside region: '{loc_text or 'no matching location found'}') "
                f"{job['title'][:60]}")
            continue

        started = time.monotonic()
        rating = rate_job(host, model, num_ctx, profile, list(cv_kw), job)
        if not rating:
            continue
        if (CFG.region_re and not loc_text and job["source"] != "nijobs.com"
                and not rating.get("in_target_region")):
            excluded_location += 1
            log(f"[{i}/{len(queue)}] skip (model: outside region) {job['title'][:60]}")
            continue
        emp_type = det_type or rating.get("employment_type") or "Unknown"
        if emp_type not in ALLOWED_TYPES:
            excluded_type += 1
            log(f"[{i}/{len(queue)}] skip ({emp_type}) {job['title'][:60]}")
            continue

        kw_matched, kw_other = keyword_match(full_text, cv_kw, other_kw)
        llm_matched = [s for s in rating.get("matched_skills", []) if s in cv_kw]
        matched = list(dict.fromkeys(kw_matched + llm_matched))
        gaps = list(dict.fromkeys(kw_other + [s for s in rating.get("missing_skills", [])
                                              if s and s not in cv_kw]))[:6]
        coverage = round(100 * len(matched) / max(1, len(matched) + len(kw_other)))
        confidence = rating["confidence"]
        if job["snippet_only"]:
            confidence = min(confidence, 50)
        elif len(job["text"]) < 800:
            confidence = min(confidence, 65)

        penalty = seniority_penalty(job["title"])
        fit = max(0, rating["fit_score"] - penalty)
        mode = detect_mode(job["facts"].get("type_line", "")) or rating.get("work_mode") or detect_mode(full_text[:4000])
        entry = {
            "title": job["title"], "url": job["url"], "source": job["source"],
            "company": job["facts"].get("company") or rating.get("company") or "",
            "location": loc_text or rating.get("location") or CFG.region or "Unknown",
            "employment_type": {"Permanent": "Full-time permanent"}.get(emp_type, emp_type),
            "work_mode": mode or "Unknown",
            "salary": job["facts"].get("salary") or rating.get("salary") or "",
            "seniority": (("Lead-level stretch" if LEAD_TITLE.search(job["title"]) else "Senior-level stretch")
                          if penalty else rating.get("seniority") or "Unknown"),
            "published": job["facts"].get("published", ""),
            "fit": fit, "model_fit": rating["fit_score"], "confidence": confidence, "coverage": coverage,
            "matched": matched, "gaps": gaps, "reasoning": rating.get("reasoning", "").strip(),
            "snippet_only": job["snippet_only"],
        }
        log(f"[{i}/{len(queue)}] fit {entry['fit']}/10 conf {confidence}% cv {coverage}% "
            f"in {time.monotonic() - started:.0f}s - {job['title'][:60]}")
        if entry["fit"] < min_score:
            below_min += 1
            continue
        enrich_company(companies, entry, job, rating)
        results.append(entry)
    companies.save()

    dedup: dict[tuple, dict] = {}
    for r in results:
        k = (re.sub(r"\W+", "", r["title"].lower()), re.sub(r"\W+", "", r["company"].lower()))
        if k not in dedup or r["fit"] > dedup[k]["fit"]:
            dedup[k] = r
    results = sorted(dedup.values(), key=lambda r: (r["fit"], r["confidence"], r["coverage"]), reverse=True)
    top = [r for r in results if r["fit"] >= 7]
    maybe = [r for r in results if r["fit"] < 7]

    summary = hermes_summary(host, model, num_ctx, results)
    stats = {
        "when": when, "shown": len(results), "strong": len(top),
        "avg_fit": f"{sum(r['fit'] for r in results) / len(results):.1f}" if results else "-",
        "scanned": len(queue), "min_score": min_score, "excluded_location": excluded_location,
        "excluded_type": excluded_type, "below_min": below_min, "model": model,
        "sources": ", ".join(sorted({r["source"] for r in results})) or "web search",
        "web_usage": web.usage() + (f", Indeed MCP {indeed.calls} calls" if indeed and indeed.calls else ""),
    }
    html_body = build_html(top, maybe, stats, summary)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    LAST_REPORT.write_text(re.sub(r'src="cid:([\w-]+)"', r'src="logos/\1.png"', html_body), encoding="utf-8")
    LAST_RESULTS.write_text(json.dumps({"generated": when, "model": model, "summary": summary,
                                        "jobs": results}, indent=1), encoding="utf-8")

    line = (f"Job radar: {len(results)} matches ({len(top)} with fit 7+) from {len(queue)} rated; "
            f"best: {results[0]['title']} ({results[0]['fit']}/10)" if results else
            f"Job radar: no new matches from {len(queue)} rated")
    if args.dry_run:
        print(f"{line} [dry run, report at {LAST_REPORT}]")
        print(build_text(results, summary))
        return 0

    if results or env_bool("JOB_SCANNER_EMAIL_WHEN_EMPTY", False):
        subject = f"{CFG.title}: {len(results)} new job{'' if len(results) == 1 else 's'}"
        try:
            hc.send_email(subject, html_body, build_text(results, summary), CFG.title,
                          inline_images(html_body, LOGO_DIR))
        except (smtplib.SMTPException, OSError, RuntimeError) as exc:
            log(f"Email failed: {exc}")
            return 5

    seen.update({k: now for k in processed})
    save_seen(seen)
    print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

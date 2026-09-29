#!/usr/bin/env python3
"""Daily Vacancy Report (HermitShell package): CV-matched job scanner rated by Hermes' model.

Finds roles that match a candidate profile (job_profile.md + cv_keywords.json),
optionally restricted to one region, rates each one with the model Hermes is
configured to use (config.yaml) and emails a scored HTML report.

Pipeline:
  1. Discover: web searches for single job postings (Firecrawl, Tavily backup),
     plus nijobs.com keyword listings when JOB_SCANNER_NIJOBS_KEYWORDS is set.
  2. Pre-filter on title relevance, drop already-seen jobs, fetch the rest.
  3. Hard filters: inside JOB_REGION_* when configured; full-time / permanent
     or contract only (no part-time, internships).
  4. Hermes' model returns fit score, confidence, matched CV keywords, gaps,
     and the real employer behind agency adverts.
  5. Company logo + website lookup, CV keyword coverage, HTML email.

Runs from $HERMES_HOME/scripts (see the package README for cron setup):
    python3 job_scanner.py              # full run + email
    python3 job_scanner.py --dry-run    # no email / state update
    python3 job_scanner.py --test-email # SMTP check only
    python3 job_scanner.py --weekly     # weekly roll-up from job_tracker.db
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import smtplib
import sys
import time
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import requests

import hermes_common as hc
import profiles
import tailored_cv
from companies import LOGO_DIR, Companies
from companies import norm as company_key
from hermes_common import (BROWSER_HEADERS, EMAIL_HEAD, STATE_DIR, WebClient, connect_model, env,
                           email_header, env_bool, env_int, first_sentences, html_to_text, inline_images,
                           load_env_file, log, ollama_chat)
from job_extras import (below_min_salary, closing_date, combined_level, days_left, group_agency_posts,
                        parse_salary, rating_failed, repost_key, second_opinion, triage_titles)
from job_tracker import (ACTIONS, FOLLOWUP_ACTIONS, Tracker, card_links, prompt_examples, skill_link, skills_text,
                         sync_feedback, unsubscribe_link)
from job_weekly import (ICON_DIR, card_action_bar, build_weekly, closing_pill, followup_section, followup_text,
                        mini_buttons, rating_buttons, source_banner, unsubscribe_footer, weekly_when)

hc.LOG_TAG = "job_radar"
SEEN_FILE = STATE_DIR / "job_scanner_seen.json"
RETRY_FILE = STATE_DIR / "job_scanner_retry.json"
TRACKER_FILE = STATE_DIR / "job_tracker.db"
MAX_RATING_ATTEMPTS = 4
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
DEFAULT_TITLE_STRONG = (r"\bai\b|artificial intelligence|machine learning|\bml\b|mlops|\bllm|gen ?ai|generative|\bnlp\b|"
                        r"data scien|automation|agentic|data engineer|solutions engineer|integration|intelligent|"
                        r"applied scien")
DEFAULT_TITLE_MEDIUM = (r"python|cloud|devops|platform engineer|software engineer|developer|\.net|c#|analytics|"
                        r"data analyst|data platform|rpa|innovation|digital transformation|full ?stack|backend|back-end")
DEFAULT_TITLE_EXCLUDE = (r"\bintern(ship)?\b|part[- ]time|placement|apprentice|volunteer|\bsales\b|"
                         r"recruit(er|ment consultant)|nurse|teacher|lecturer|driver|warehouse operative|cleaner")
EMPLOYMENT_TYPES = ["Permanent", "Full-time", "Contract", "Temporary", "Part-time", "Internship"]
WORK_MODES = ["On-site", "Hybrid", "Remote"]
# Fit-score penalties (junior, senior, lead titles) for each JOB_LEVEL; JOB_*_PENALTY overrides them.
LEVEL_PENALTIES = {"junior": (0, 2, 3), "mid": (1, 1, 2), "senior": (2, 0, 1), "lead": (3, 1, 0), "any": (0, 0, 0)}


def choice_list(name: str, default: list[str], options: list[str]) -> set[str]:
    canon = {o.lower().replace(" ", "").replace("-", ""): o for o in options}
    raw = [v.strip().lower().replace(" ", "").replace("-", "") for v in (env(name) or "").split(",") if v.strip()]
    picked = {canon[v] for v in raw if v in canon}
    return picked or set(default)
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
    level = (env("JOB_LEVEL") or "any").lower()
    level = level if level in LEVEL_PENALTIES else "any"
    junior_pen, senior_pen, lead_pen = LEVEL_PENALTIES[level]
    types = choice_list("JOB_EMPLOYMENT_TYPES", ["Permanent", "Contract", "Temporary"], EMPLOYMENT_TYPES)
    if types & {"Permanent", "Full-time"}:
        types |= {"Permanent", "Full-time"}
    title_exclude = DEFAULT_TITLE_EXCLUDE
    if "Internship" in types:
        title_exclude = re.sub(r"\\bintern\(ship\)\?\\b\||placement\||apprentice\|", "", title_exclude)
    if "Part-time" in types:
        title_exclude = title_exclude.replace(r"part[- ]time|", "")
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
        title_strong=re.compile(env("JOB_TITLE_STRONG", DEFAULT_TITLE_STRONG), re.I),
        title_medium=re.compile(env("JOB_TITLE_MEDIUM", DEFAULT_TITLE_MEDIUM), re.I),
        title_exclude=re.compile(env("JOB_TITLE_EXCLUDE", title_exclude), re.I),
        level=level,
        junior_penalty=env_int("JOB_JUNIOR_PENALTY", junior_pen),
        senior_penalty=env_int("JOB_SENIOR_PENALTY", senior_pen),
        lead_penalty=env_int("JOB_LEAD_PENALTY", lead_pen),
        employment_types=types,
        work_modes=choice_list("JOB_WORK_MODES", WORK_MODES, WORK_MODES),
        remote_anywhere=env_bool("JOB_REMOTE_ANYWHERE", False),
        profile_file=PACKAGE_DIR / (env("JOB_PROFILE_FILE") or "job_profile.md"),
        keywords_file=PACKAGE_DIR / (env("JOB_KEYWORDS_FILE") or "cv_keywords.json"),
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
        "closing_date": {"type": "string", "maxLength": 20},
    },
    "required": ["fit_score", "confidence", "reasoning", "matched_skills", "missing_skills",
                 "employment_type", "work_mode", "location", "in_target_region", "company", "salary",
                 "seniority", "recruitment_agency", "employer", "employer_about", "closing_date"],
}


# --------------------------------------------------------------------------- config

def load_keywords() -> tuple[dict[str, re.Pattern], dict[str, re.Pattern]]:
    data = json.loads(hc.read_private_text(CFG.keywords_file))
    cv = {k: re.compile(v, re.I) for k, v in data["cv_keywords"].items()}
    other = {k: re.compile(v, re.I) for k, v in data.get("other_tech", {}).items()}
    return cv, other


def with_added_skills(cv: dict[str, re.Pattern], other: dict[str, re.Pattern],
                      added: list[str]) -> tuple[dict[str, re.Pattern], dict[str, re.Pattern]]:
    """Treat skills added from the email's missing-skill tags as CV keywords."""
    cv, other = dict(cv), dict(other)
    known = {k.lower() for k in cv}
    for skill in added:
        if skill.lower() in known:
            continue
        found = next((k for k in other if k.lower() == skill.lower()), None)
        cv[found or skill] = other.pop(found) if found else \
            re.compile(rf"(?<![\w+#]){re.escape(skill)}(?![\w+#])", re.I)
        known.add(skill.lower())
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


def load_retries() -> dict[str, int]:
    try:
        return {k: int(v) for k, v in json.loads(RETRY_FILE.read_text(encoding="utf-8")).items()}
    except (FileNotFoundError, ValueError, AttributeError):
        return {}


def save_retries(retries: dict[str, int]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    RETRY_FILE.write_text(json.dumps(retries, indent=1), encoding="utf-8")


# --------------------------------------------------------------------------- firecrawl

def clean_title(title: str) -> str:
    title = title.replace("\\|", "|").replace("\\", "")
    title = re.sub(r"\s+[-|–]\s+(LinkedIn|Jobijoba UK|Indeed|Glassdoor|Totaljobs|Reed|CWJobs|Jobs\.ac\.uk|"
                   r"eFinancialCareers|Built In Belfast|The Sun Jobs|Ni Jobs)\b.*$", "", title, flags=re.I)
    title = re.sub(r"\s+-\s+Job\s+(January|February|March|April|May|June|July|August|September|October|"
                   r"November|December)\s+\d{4}\b.*$", "", title, flags=re.I)
    linkedin = re.match(r"^.{1,80}?\s+hiring\s+(.+)\s+in\s+.*$", title, flags=re.I)
    if linkedin:
        title = re.sub(r"\s+Job$", "", linkedin.group(1), flags=re.I)
    if CFG.location:
        title = re.sub(rf"\s+-\s+{re.escape(CFG.location)}\s*$", "", title, flags=re.I)
    return re.sub(r"\s+", " ", title).strip()


LEAD_TITLE = re.compile(r"\b(lead|principal|staff|head|director|vp|chief)\b", re.I)
SENIOR_TITLE = re.compile(r"\bsenior\b|\bsnr\b|\bsr\.?\b", re.I)
JUNIOR_TITLE = re.compile(r"\bjunior\b|\bjnr\b|\bjr\.?\b|\bgraduate\b|\bentry[- ]level\b|\btrainee\b", re.I)


def title_level(title: str) -> str | None:
    if LEAD_TITLE.search(title):
        return "lead"
    if SENIOR_TITLE.search(title):
        return "senior"
    if JUNIOR_TITLE.search(title):
        return "junior"
    return None


def seniority_penalty(title: str) -> int:
    return getattr(CFG, f"{title_level(title)}_penalty", 0)


def title_relevance(title: str) -> int:
    if CFG.title_exclude.search(title):
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
             use_search: bool, health: dict | None = None) -> list[dict]:
    """All candidate postings; `health` gets {source: {"found": n, "error": text}} for the report."""
    found: dict[str, dict] = {}
    health = {} if health is None else health

    if nijobs_keywords:
        total = 0
        for kw in nijobs_keywords:
            links = nijobs.listing(kw)
            log(f"nijobs '{kw}': {len(links)} postings")
            total += len(links)
            for title, link in links:
                title = clean_title(title)
                if title.lower().startswith("!["):
                    continue
                key = job_key(link)
                found.setdefault(key, {"key": key, "url": link.split("?")[0], "title": title,
                                       "description": "", "source": "nijobs.com"})
        health["nijobs.com"] = {"found": total, "error": ""}

    if use_search:
        search_total = 0
        for query in queries:
            results = web.search(query, 8, tbs, country=CFG.country)
            search_total += len(results)
            kept = 0
            for item in results:
                link = hc.safe_url(item.get("url") or "")
                title = clean_title(item.get("title") or "")
                if not link or not SINGLE_POSTING.search(link) or AGGREGATE_TITLE.search(title):
                    continue
                key = job_key(link)
                if key not in found:
                    found[key] = {"key": key, "url": link, "title": title,
                                  "description": (item.get("description") or "").strip(),
                                  "source": urlsplit(link).netloc.replace("www.", "")}
                    kept += 1
            log(f"search '{query[:60]}...': {len(results)} results, {kept} new postings")
        health["web search"] = {"found": search_total,
                                "error": "" if web.search_order else "no web search provider has credits left"}
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
    "You are HermitShell, a precise career-matching assistant. You compare a job listing with a candidate's CV "
    "and answer with strict JSON only. Be honest and critical: do not inflate scores."
)


def preferences() -> str:
    level = {"junior": "junior / entry level", "mid": "mid level", "senior": "senior level",
             "lead": "lead / principal level"}.get(CFG.level, "any seniority")
    types = ", ".join(t for t in EMPLOYMENT_TYPES if t in CFG.employment_types)
    modes = ", ".join(m for m in WORK_MODES if m in CFG.work_modes)
    where = CFG.region or "anywhere"
    if CFG.remote_anywhere:
        where += " (or fully remote from anywhere)"
    return f"target level {level}; employment types {types}; work modes {modes}; location {where}."


def rate_job(host: str, model: str, num_ctx: int | None, profile: str, cv_keywords: list[str],
             job: dict, feedback: str = "") -> dict | None:
    facts = job.get("facts") or {}
    fact_lines = "\n".join(f"{k}: {v}" for k, v in facts.items() if k not in ("logo_url", "links")) or "none"
    # Everything that is the same for every job comes first, so Ollama reuses its cached prompt prefix
    # and only processes the listing itself for each job.
    user = (
        f"CANDIDATE CV SUMMARY:\n{profile}\n\n"
        + (f"{feedback}\n\n" if feedback else "") +
        f"CV KEYWORDS (matched_skills must only use these exact strings):\n{', '.join(cv_keywords)}\n\n"
        f"CANDIDATE PREFERENCES: {preferences()}\n\n"
        "TASK: Rate how well the job listing at the end fits the candidate.\n"
        "fit_score rubric: 9-10 a role in the candidate's core field where most key requirements are on the CV "
        "and seniority matches their target level; 7-8 strong overlap with one or two notable gaps; 5-6 partial "
        "or adjacent fit; 0-4 weak fit, wrong discipline, or seniority far above/below the candidate. Be "
        "discriminating: a typical relevant listing scores 5-7; reserve 9-10 for exceptional matches. Deduct "
        "for required technologies, qualifications or domains the CV does not show.\n"
        "confidence (0-100): how certain you are about fit_score given how detailed the listing is.\n"
        "matched_skills: CV keywords the job explicitly asks for or clearly involves.\n"
        "missing_skills: up to 5 important requirements from the listing the CV does not show.\n"
        f"in_target_region: true only if the job is based in {CFG.region or 'a location the CV says is acceptable'} "
        "(on-site, hybrid, or remote but explicitly tied to it"
        + (", or fully remote and open to candidates there" if CFG.remote_anywhere else "") + ").\n"
        "reasoning: at most two short sentences (under 50 words) speaking to the candidate as 'you'.\n"
        "recruitment_agency: true if the advertiser is a recruitment agency or consultancy hiring for a client.\n"
        "employer: the company the successful candidate would actually work for, exactly as named in the "
        "listing; empty string if an agency does not name its client.\n"
        "employer_about: one short sentence (under 30 words) describing the employer (sector, size, what it "
        "does, where it is based) using only what the listing text says about it. When an agency advertises, "
        "describe the agency's client, never the agency itself (company_profile describes the advertiser, so "
        "do not use it here); empty string if the listing does not describe the employer.\n"
        "closing_date: the application deadline as YYYY-MM-DD if the listing states one, else empty string.\n"
        "Use empty string or 'Unknown' when the listing does not say. Keep every field brief.\n\n"
        "JOB LISTING\n"
        f"Title: {job['title']}\nURL: {job['url']}\nSource: {job['source']}\n"
        f"Structured facts from the page:\n{fact_lines}\n"
        f"Listing text:\n{job['text'][:MAX_LISTING_CHARS]}"
    )
    for num_predict in (900, 1600):
        try:
            data = json.loads(ollama_chat(host, model, SYSTEM_PROMPT, user, num_ctx, SCORE_SCHEMA,
                                          num_predict=num_predict))
            data["fit_score"] = max(0, min(10, int(data.get("fit_score", 0))))
            data["confidence"] = max(0, min(100, int(data.get("confidence", 0))))
            data["reasoning"] = first_sentences(str(data.get("reasoning", "")), 2)
            return data
        except requests.Timeout as exc:
            raise ModelTimeout(job["title"]) from exc
        except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
            log(f"rating failed for {job['title'][:50]}: {exc.__class__.__name__}: {str(exc)[:120]}")
    return None


class ModelTimeout(Exception):
    """The model did not answer in time; a second one in a row means Ollama is stuck, so the run stops rating."""


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
        return ollama_chat(host, model, "You are HermitShell, a concise career assistant.", user,
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


PERIOD_WORDS = {"year": "a year", "day": "a day", "hour": "an hour"}


def salary_figure(text: str, parsed: dict | None) -> tuple[str, str, str]:
    """(headline, period, yearly estimate), e.g. ('£350 - £400', 'a day', 'about £77,000 - £88,000 a year')."""
    if not parsed:
        return " ".join(text.split())[:60], "", ""

    def money(value: float) -> str:
        return f"{parsed['currency']}{value:,.2f}" if value % 1 else f"{parsed['currency']}{value:,.0f}"

    low, high = parsed["low"], parsed["high"]
    headline = money(low) if low == high else f"{money(low)} - {money(high)}"
    if low == high and re.search(r"\bup to\b", text, re.I):
        headline = f"Up to {headline}"
    yearly = ""
    if parsed["period"] != "year":
        y_low, y_high = parsed["year_low"], parsed["year_high"]
        span = f"{parsed['currency']}{y_low:,}" + (f" - {parsed['currency']}{y_high:,}" if y_high != y_low else "")
        yearly = f"about {span} a year"
    return headline, PERIOD_WORDS[parsed["period"]], yearly


def salary_line(job: dict) -> str:
    headline, period, yearly = salary_figure(job["salary"], job.get("salary_range"))
    return f"{headline} {period}".strip() + (f" ({yearly})" if yearly else "")


def salary_block(job: dict) -> str:
    """Salary as a headline under the company line; empty when the listing gives none."""
    if not job.get("salary"):
        return ""
    headline, period, yearly = salary_figure(job["salary"], job.get("salary_range"))
    period_html = f' <span style="font-size:12px;font-weight:600;color:#047857">{period}</span>' if period else ""
    yearly_html = (f'<td valign="middle" style="padding-left:10px;font-size:12px;color:{C_MUTED}">{yearly}</td>'
                   if yearly else "")
    return (f'<table cellpadding="0" cellspacing="0" style="margin:0 0 10px"><tr>'
            f'<td valign="middle" style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;'
            f'padding:6px 12px 6px 10px"><table cellpadding="0" cellspacing="0"><tr>'
            f'<td valign="middle" width="20" style="padding-right:8px"><img src="cid:icon-salary" width="20" '
            f'height="20" alt="Salary" style="display:block;width:20px;height:20px;border:0"></td>'
            f'<td valign="middle" style="font-size:17px;font-weight:800;color:#065f46;white-space:nowrap">'
            f'{esc(headline)}{period_html}</td></tr></table></td>{yearly_html}</tr></table>')


def gap_tags(gaps: list[str], link: str) -> str:
    """Missing skills as amber tags; with the feedback Worker each one opens the add-to-my-skills page."""
    if not gaps:
        return ""
    style = ("display:inline-block;background:#fffbeb;color:#92400e;border:1px solid #fcd34d;border-radius:999px;"
             "padding:3px 10px;font-size:12px;font-weight:600;margin:0 6px 6px 0;text-decoration:none")
    tags = "".join(
        f'<a href="{esc(link)}&amp;{urlencode({"p": g})}" style="{style}">+ {esc(g)}</a>' if link
        else f'<span style="{style}">{esc(g)}</span>' for g in gaps)
    hint = " &middot; tap one you already have to add it to your skills" if link else ""
    return (f'<div style="font-size:11px;color:#92400e;text-transform:uppercase;letter-spacing:.06em;'
            f'margin:12px 0 6px">Missing from your CV<span style="text-transform:none;letter-spacing:0;'
            f'color:{C_MUTED}">{hint}</span></div><div>{tags}</div>')


def job_card(job: dict, rank: int) -> str:
    colour = fit_colour(job["fit"])
    shown = job.get("employer") or job["company"]
    logo = (job.get("employer_logo") if job.get("employer") else "") or job.get("company_logo", "")
    company = (f'<a href="{esc(job["company_site"])}" style="color:#475569;text-decoration:underline">{esc(job["company"])}</a>'
               if job.get("company_site") and job["company"] else esc(job["company"]))
    meta = " &middot; ".join(x for x in (company, esc(job["location"])) if x)
    pills = closing_pill(job.get("days_left")) + "".join(
        pill(p) for p in (job["employment_type"], job["work_mode"], "" if job["salary"] else "Salary not listed",
                          job["seniority"], job.get("published")) if p and p != "Unknown")
    top_skills = chips(job["matched"][:3], "#047857", "#ecfdf5", "#34d399").replace(
        "font-size:12px;", "font-size:12px;font-weight:700;") or \
        f'<span style="font-size:12px;color:{C_MUTED}">None detected</span>'
    more_skills = (f'<div style="font-size:12px;color:{C_MUTED};margin-top:2px">Also on your CV: '
                   f'{esc(", ".join(job["matched"][3:]))}</div>') if len(job["matched"]) > 3 else ""
    gaps_block = gap_tags(job["gaps"], job.get("skill_link", ""))
    note = ""
    if job.get("also_advertised_by"):
        note += (f'<div style="font-size:12px;color:{C_MUTED};margin-top:6px">Also advertised by '
                 f'{esc(", ".join(job["also_advertised_by"]))}.</div>')
    if job.get("second_opinion") is not None:
        note += (f'<div style="font-size:11px;color:{C_MUTED};margin-top:6px">Checked twice: a stricter second look '
                 f'scored it {job["second_opinion"]}/10, so the score shown is the average of the two.</div>'
                 if job["second_opinion"] < job["model_fit"] else "")
    return f"""
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_CARD};border:1px solid #e2e8f0;border-radius:16px;margin:0 0 18px">
<tr><td style="padding:22px 24px">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="62" valign="top" style="padding-top:2px">{company_avatar(shown, logo)}</td>
    <td valign="top">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:{C_ACCENT};font-weight:700">#{rank} &middot; {esc(job['source'])}</div>
      <a href="{esc(job['url'])}" style="display:block;font-size:19px;font-weight:700;color:{C_INK};text-decoration:none;line-height:1.3;margin:4px 0">{esc(job['title'])}</a>
      <div style="font-size:13px;color:#475569;margin-bottom:10px">{meta}</div>
      {salary_block(job)}
      <div>{pills}</div>
    </td>
    <td width="84" valign="top" align="right">
      <table cellpadding="0" cellspacing="0"><tr><td align="center" valign="middle" width="68" height="68"
        style="width:68px;height:68px;border-radius:34px;background:{colour};color:#ffffff;font-size:24px;font-weight:800;text-align:center">
        {job['fit']}<span style="font-size:12px;font-weight:600;opacity:.85">/10</span></td></tr></table>
      {rating_buttons(job.get("actions") or {})}
    </td>
  </tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 16px"><tr>
    {meter("HermitShell fit", f"{job['fit']}/10", job['fit'] * 10, colour)}
    {meter("Confidence", f"{job['confidence']}%", job['confidence'], "#6366f1")}
    {meter("CV keyword match", f"{job['coverage']}%", job['coverage'], "#0ea5e9")}
  </tr></table>
  <div style="background:#f8fafc;border-left:3px solid {C_ACCENT};border-radius:8px;padding:12px 14px;font-size:14px;color:#334155;line-height:1.5">{esc(job['reasoning'])}</div>
  {about_block(job)}
  <div style="font-size:11px;color:{C_MUTED};text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px">Strongest matches with your CV ({len(job['matched'])} in total)</div>
  {top_skills}
  {more_skills}
  {gaps_block}
  {note}
  {card_action_bar(job['url'], job.get("actions") or {})}
  <div style="font-size:11px;color:{C_MUTED};word-break:break-all">{esc(job['url'])}</div>
</td></tr></table>"""


def section(title: str, subtitle: str, jobs: list[dict], start: int) -> str:
    if not jobs:
        return ""
    cards = "".join(job_card(j, start + i) for i, j in enumerate(jobs))
    return (f'<div style="margin:26px 0 12px"><div style="font-size:18px;font-weight:800;color:{C_INK}">{title}</div>'
            f'<div style="font-size:13px;color:{C_MUTED}">{subtitle}</div></div>{cards}')


def more_section(jobs: list[dict], start: int) -> str:
    """One line per job, for matches that would push the email past Gmail's clipping size."""
    if not jobs:
        return ""
    rows = []
    for i, job in enumerate(jobs):
        meta = " &middot; ".join(esc(x) for x in (job.get("employer") or job["company"], job["location"],
                                                   job["salary"]) if x)
        links = mini_buttons(job.get("actions") or {})
        rows.append(
            f'<tr><td width="52" valign="top" style="padding:10px 0;border-top:1px solid #e2e8f0;font-size:14px;'
            f'font-weight:800;color:{fit_colour(job["fit"])}">{job["fit"]}/10</td>'
            f'<td style="padding:10px 0;border-top:1px solid #e2e8f0">'
            f'<a href="{esc(job["url"])}" style="font-size:14px;font-weight:700;color:{C_INK};text-decoration:none">'
            f'#{start + i} {esc(job["title"])}</a>{closing_pill(job.get("days_left")).replace("margin:0 6px 6px 0", "margin-left:6px")}'
            f'<div style="font-size:12px;color:{C_MUTED};margin-top:2px">{meta}</div>'
            + (f'<div style="margin-top:6px">{links}</div>' if links else "") + '</td></tr>')
    return (f'<div style="margin:26px 0 12px"><div style="font-size:18px;font-weight:800;color:{C_INK}">More matches</div>'
            f'<div style="font-size:13px;color:{C_MUTED}">Shortened so the email is not clipped; the plain-text '
            f'version has full details.</div></div>'
            f'<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_CARD};border:1px solid #e2e8f0;'
            f'border-radius:16px;padding:6px 20px;margin:0 0 18px">{"".join(rows)}</table>')


def fitted_html(top: list[dict], maybe: list[dict], stats: dict, summary: str, problems: list[str] | None = None,
                followups: str = "") -> str:
    """The report with as many full cards as fit Gmail's size limit; the lowest-ranked rest become one-liners."""
    jobs = top + maybe
    for shown in range(len(jobs), -1, -1):
        html_body = build_html(top[:shown], maybe[:max(0, shown - len(top))], stats, summary, problems, followups,
                               jobs[shown:])
        if hc.html_size(hc.compact_html(html_body)) <= hc.EMAIL_HTML_BUDGET:
            break
    if shown < len(jobs):
        log(f"Email size: {len(jobs) - shown} lower-ranked matches shown as one-line entries")
    return html_body


def build_html(top: list[dict], maybe: list[dict], stats: dict, summary: str, problems: list[str] | None = None,
               followups: str = "", more: list[dict] | None = None) -> str:
    summary_block = (
        f'<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e0e7ff;border-radius:16px;margin:22px 0 4px">'
        f'<tr><td style="padding:18px 22px"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:{C_ACCENT};font-weight:700">HermitShell&rsquo;s take</div>'
        f'<div style="font-size:15px;color:#1e293b;line-height:1.6;margin-top:6px">{esc(summary)}</div></td></tr></table>'
    ) if summary else ""
    cv_block = (
        f'<table width="100%" cellpadding="0" cellspacing="0" style="background:#ecfeff;border:1px solid #a5f3fc;border-radius:16px;margin:22px 0 4px">'
        f'<tr><td style="padding:14px 22px;font-size:14px;color:#155e75;line-height:1.5"><b>Added to your CV:</b> '
        f'{esc(", ".join(stats["cv_added"]))}. The previous version is kept as a backup, and tailored CVs now '
        f'include them.</td></tr></table>'
    ) if stats.get("cv_added") else ""
    where = f" in {esc(CFG.region)}" if CFG.region else ""
    empty = "" if top or maybe else (
        f'<div style="background:#fff;border-radius:16px;padding:28px;text-align:center;color:{C_MUTED};margin-top:22px">'
        f'No new matching roles{where} this run. HermitShell will keep looking.</div>')
    location_filter = f"located in {esc(CFG.region)} &middot; " if CFG.region_re else ""
    outside = f"{stats['excluded_location']} outside {esc(CFG.region or 'the region')}, " if CFG.region_re else ""
    penalties = [f"{n} for {label}" for n, label in ((CFG.junior_penalty, "Junior/Graduate"),
                                                      (CFG.senior_penalty, "Senior"),
                                                      (CFG.lead_penalty, "Lead/Principal")) if n]
    penalty_note = (f"HermitShell fit is reduced by {', '.join(penalties)} titles to match your target level, "
                    "and by up to 1 when the listing reads at one of those levels even though the title does not say so."
                    if penalties else "")
    salary_filter = (f" &middot; salary at least {esc(stats.get('salary_currency', ''))}{stats['min_salary']:,}"
                     if stats.get("min_salary") else "")
    extra_excluded = "".join(f", {stats[k]} {label}" for k, label in (
        ("excluded_salary", "below your salary floor"), ("excluded_closed", "already closed"),
        ("reposts", "reposts of jobs seen before"), ("grouped", "duplicate or hidden agency adverts"))
        if stats.get(k))
    verify_note = (f"Scores of {stats['verify_from']} or more are checked a second time and the two scores are averaged."
                   if stats.get("verify_from") else "")
    feedback_note = ("<br>Buttons on each job record your answer after you confirm it. Thumbs up and down "
                     "teach HermitShell what a good match looks like, Interested shortlists a job, I applied starts "
                     "follow-up reminders, and Cover letter and Tailored CV email you a PDF made for that job "
                     "within minutes."
                     if stats.get("feedback") else "")
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">{EMAIL_HEAD}<title>{esc(CFG.title)}</title></head>
<body class="body" style="margin:0;padding:0;background:{C_BG};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_BG}"><tr><td align="center" style="padding:24px 12px">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%">
{email_header(CFG.region or "Job radar", stats['when'], CFG.title, CFG.tagline,
              [(stats['shown'], "Matches"), (stats['strong'], "Strong fits (7+)"),
               (stats['avg_fit'], "Average fit"), (stats['scanned'], "Jobs scanned")], highlight=1)}
<tr><td>
  {source_banner(problems or [])}
  {cv_block}
  {summary_block}
  {section("Top matches", "Fit score 7 or higher: apply to these first. Jobs closing soon come first.", top, 1)}
  {section("Worth a look", "Partial fit: adjacent roles or a few gaps to cover.", maybe, len(top) + 1)}
  {more_section(more or [], len(top) + len(maybe) + 1)}
  {empty}
  {followups}
  <div style="font-size:12px;color:{C_MUTED};line-height:1.6;padding:18px 6px 6px;text-align:center">
    Filters: {location_filter}full-time/permanent or contract &middot; fit &ge; {stats['min_score']}/10{salary_filter}.<br>
    Excluded this run: {outside}{stats['excluded_type']} unwanted job type or work mode, {stats['below_min']} below threshold{extra_excluded}.<br>
    Rated by {esc(stats['model'])} (HermitShell&rsquo;s model) on your HermitShell server &middot; sources: {esc(stats['sources'])} &middot;
    Web data: {stats['web_usage']}.<br>
    CV keyword match = share of the technologies named in the listing that appear on your CV.
    {penalty_note} {verify_note}{feedback_note}
  </div>
  {unsubscribe_footer(stats.get("unsubscribe", ""), not env("JOB_PROFILE_ID"))}
</td></tr>
</table></td></tr></table></body></html>"""


def preview_html(html_body: str) -> str:
    """The email with CID images pointed at their files, so the saved copy opens in a browser."""
    icons = Path(os.path.relpath(ICON_DIR, STATE_DIR)).as_posix()
    return re.sub(r'src="cid:([\w-]+)"',
                  lambda m: f'src="{icons if m.group(1).startswith(("btn-", "icon-")) else "logos"}/{m.group(1)}.png"',
                  html_body)


def build_text(jobs: list[dict], summary: str, followups: str = "") -> str:
    parts = [summary, ""] if summary else []
    for i, j in enumerate(jobs, 1):
        closing = f", closes in {j['days_left']} days" if j.get("days_left") is not None else ""
        parts.append(f"#{i} [{j['fit']}/10, confidence {j['confidence']}%, CV match {j['coverage']}%{closing}] "
                     f"{j['title']} - {j['company']} ({j['location']}, {j['employment_type']})\n"
                     + (f"   Salary: {salary_line(j)}\n" if j.get("salary") else "") +
                     f"   {j['reasoning']}\n   Matches: {', '.join(j['matched']) or '-'}\n   {j['url']}"
                     + "".join(f"\n   {label}: {j[k]}" for label, k in (("Employer", "employer"), ("About", "about"),
                                                                        ("Company site", "company_site"))
                               if j.get(k))
                     + (f"\n   Missing from your CV: {', '.join(j['gaps'])}" if j.get("gaps") else "")
                     + (f"\n   {ACTIONS['add_skill']}: {j['skill_link']}" if j.get("skill_link") else "")
                     + "".join(f"\n   {ACTIONS[a]}: {url}" for a, url in (j.get("actions") or {}).items()))
    if followups:
        parts.append(followups)
    where = f" in {CFG.region}" if CFG.region else ""
    return "\n\n".join(parts) or f"No new matching roles{where} this run."


# --------------------------------------------------------------------------- main

def report_unsubscribe_link() -> str:
    return unsubscribe_link(env("JOB_FEEDBACK_URL", "") or "", env("JOB_FEEDBACK_SECRET", "") or "",
                            CFG.candidate if CFG.candidate != "the candidate" else "you", env("JOB_PROFILE_ID", "") or "")


def send_weekly(tracker: Tracker, tz: ZoneInfo, dry_run: bool) -> int:
    now = time.time()
    subject, html_body, text = build_weekly(tracker.week(now - 7 * 86400), weekly_when(tz), CFG.title,
                                            CFG.region or "Job radar", now, report_unsubscribe_link())
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    (STATE_DIR / "job_scanner_weekly.html").write_text(html_body, encoding="utf-8")
    if dry_run:
        print(f"{subject} [dry run, report at {STATE_DIR / 'job_scanner_weekly.html'}]")
        print(text)
        return 0
    try:
        hc.send_email(subject, html_body, text, CFG.title)
    except (smtplib.SMTPException, OSError, RuntimeError) as exc:
        log(f"Email failed: {exc}")
        return 5
    print(f"Weekly roll-up sent: {subject}")
    return 0


def source_problems(health: dict, feedback_error: str | None) -> list[str]:
    problems = []
    for name, info in health.items():
        if info.get("error"):
            problems.append(f"{name} failed: {info['error']}.")
        elif not info.get("found"):
            problems.append(f"{name} found no postings this run.")
    if feedback_error:
        problems.append(f"Feedback buttons: {feedback_error}; answers wait in the Worker until the next run.")
    return problems


def model_stretch(title: str, model_seniority: str) -> tuple[str | None, int]:
    """Level the listing reads at when the title does not say, and its penalty (at most 1, the model can be wrong)."""
    if title_level(title):
        return None, 0
    level, from_model = combined_level(None, model_seniority)
    return level, min(1, getattr(CFG, f"{level}_penalty", 0)) if from_model else 0


def main() -> int:
    global CFG
    parser = argparse.ArgumentParser(description="CV-matched job scanner rated by Hermes' model.")
    parser.add_argument("--dry-run", action="store_true", help="don't send email or update seen-state")
    parser.add_argument("--test-email", action="store_true", help="send a test email and exit")
    parser.add_argument("--limit", type=int, help="max job pages to scrape and rate this run")
    parser.add_argument("--include-seen", action="store_true", help="re-rate jobs from previous runs")
    parser.add_argument("--no-search", action="store_true", help="board listings only (nijobs.com), skip web searches")
    parser.add_argument("--weekly", action="store_true", help="send the weekly roll-up from job_tracker.db and exit")
    parser.add_argument("--skills", action="store_true",
                        help="list the skills added from the email's missing-skill tags and exit")
    parser.add_argument("--remove-skill", metavar="SKILL", help="remove a skill added from the email and exit")
    args = parser.parse_args()

    load_env_file()
    CFG = load_settings()
    if args.test_email or args.skills or args.remove_skill or args.dry_run:
        return run(args)
    with hc.run_lock(STATE_DIR / "job_scanner.lock") as held:
        if not held:
            log("Another scan is still running; skipping this one")
            return 0
        if args.weekly or env("JOB_PROFILE_ID") or env("JOB_REPORT_ALONE"):
            return run(args)
        return profiles.reported(profiles.OWNER, lambda: run(args))


def run(args: argparse.Namespace) -> int:
    tz = ZoneInfo(CFG.timezone)
    when = datetime.now(tz).strftime("%A %d %B %Y, %H:%M %Z")
    profile_id = env("JOB_PROFILE_ID", "") or ""
    if not (args.test_email or args.skills or args.remove_skill):
        profiles.spawn_others("job_scanner.py", sys.argv[1:])

    if args.test_email:
        stats = {"when": when, "shown": 0, "strong": 0, "avg_fit": "-", "scanned": 0, "min_score": 0,
                 "excluded_location": 0, "excluded_type": 0, "below_min": 0, "model": "n/a",
                 "sources": "n/a", "web_usage": "n/a"}
        hc.send_email(f"{CFG.title}: SMTP test", build_html([], [], stats, "SMTP test."),
                      "SMTP test.", CFG.title)
        print("Test email sent.")
        return 0

    tracker = Tracker(TRACKER_FILE)
    if args.remove_skill:
        removed = tracker.remove_skill(args.remove_skill)
        print(f"Removed {args.remove_skill}." if removed else f"{args.remove_skill} is not in your added skills.")
        return 0 if removed else 1
    fb_url, fb_secret = env("JOB_FEEDBACK_URL", ""), env("JOB_FEEDBACK_SECRET", "")
    synced, fb_error = sync_feedback(tracker, fb_url, env("JOB_FEEDBACK_API_TOKEN", ""), ack=not args.dry_run,
                                     profile=profile_id, full=not args.skills)
    if synced:
        log(f"synced {synced} feedback answers from the feedback Worker")
    if fb_error:
        log(fb_error)
    if args.skills:
        print("\n".join(tracker.skills()) or "No skills added from the email yet.")
        return 0
    if profiles.owner_paused():
        print("Your reports are paused (unsubscribe link or /admin); other profiles still run. "
              "Resume with: python3 profiles.py --resume owner")
        return 0
    if args.weekly:
        return send_weekly(tracker, tz, args.dry_run)

    try:
        host, model, num_ctx = connect_model("JOB_SCANNER_MODEL")
    except RuntimeError as exc:
        log(str(exc))
        return 3

    if not CFG.profile_file.is_file():
        log(f"No CV yet ({CFG.profile_file.name} is missing): upload your CV on the dashboard's profile page")
        return 0
    cv_added = [] if args.dry_run else tailored_cv.merge_new_skills(tracker, CFG.profile_file, (host, model, num_ctx))
    try:
        profile = hc.read_private_text(CFG.profile_file).strip()
        cv_kw, other_kw = load_keywords()
    except (OSError, hc.DataKeyError) as exc:
        log(f"Candidate profile unreadable ({exc}); upload your CV again on the dashboard's profile page")
        return 4
    cv_kw, other_kw = with_added_skills(cv_kw, other_kw, tracker.skills())
    profile = "\n\n".join(x for x in (profile, skills_text(tracker)) if x)
    cv_lower = {k.lower() for k in cv_kw}
    nijobs_kw, queries = CFG.nijobs_keywords, CFG.queries
    max_scrape = args.limit or env_int("JOB_SCANNER_MAX_SCRAPE", 25)
    min_score = env_int("JOB_SCANNER_MIN_SCORE", 5)
    tbs = env("JOB_SCANNER_TBS", "qdr:m")
    min_salary = env_int("JOB_MIN_SALARY", 0)
    salary_currency = env("JOB_SALARY_CURRENCY", "")
    verify_from = env_int("JOB_VERIFY_MIN_FIT", 8)

    try:
        web = WebClient(env_int("JOB_SCANNER_MIN_CREDITS", 40))
    except RuntimeError as exc:
        log(str(exc))
        return 2
    nijobs = Nijobs(web)
    companies = Companies(web, CFG.region_re, CFG.region, CFG.country or "")
    seen = load_seen()
    retries = load_retries()

    health: dict[str, dict] = {}
    candidates = discover(web, nijobs, nijobs_kw, queries, tbs, use_search=not args.no_search, health=health)

    fresh = [c for c in candidates if args.include_seen or c["key"] not in seen]
    retry_jobs = [c for c in fresh if c["key"] in retries]
    pool, title_skips = [], []
    for c in fresh:
        if c["key"] in retries:
            continue
        rel = title_relevance(c["title"])
        if rel < 0:
            title_skips.append(c)
        else:
            pool.append((rel + (1 if c["source"] == "nijobs.com" else 0), c))
    pool.sort(key=lambda x: x[0], reverse=True)
    pool = pool[:env_int("JOB_TRIAGE_MAX", 60)]
    verdicts = triage_titles(host, model, num_ctx, profile, [c["title"] for _, c in pool]) if pool else []
    ranked, off_target = [], []
    for (rel, c), verdict in zip(pool, verdicts):
        if verdict == "no" and rel < 3:
            off_target.append(c)
        else:
            ranked.append((2 if verdict == "yes" else 1, rel, c))
    ranked.sort(key=lambda x: (x[0], x[1]), reverse=True)
    queue = (retry_jobs + [c for _, _, c in ranked])[:max_scrape]
    log(f"{len(candidates)} postings discovered, {len(fresh)} unseen ({len(retry_jobs)} retries), "
        f"{len(pool)} titles triaged ({len(off_target)} off-target), rating {len(queue)}")

    now = time.time()
    today = datetime.now(tz).date()
    feedback = prompt_examples(tracker)
    done = [c["key"] for c in title_skips + off_target]
    repost_keys: list[str] = []
    texts: dict[str, str] = {}
    results = []
    excluded_location = excluded_type = below_min = excluded_salary = excluded_closed = reposts = 0

    def rate_one(i: int, job: dict) -> str:
        """Filter, rate and score one queued job: "skipped" before the model, else "rated" or "failed"."""
        nonlocal excluded_location, excluded_type, below_min, excluded_salary, excluded_closed, reposts
        facts, text = {}, ""
        if job["source"] == "nijobs.com":
            facts, text = nijobs.job(job["url"]) or ({}, "")
        if not text and "linkedin.com" not in job["url"]:
            md = web.scrape(job["url"])
            if md:
                facts, text = header_facts(md), clean_listing(md)
        job["snippet_only"] = not text
        job["facts"] = facts
        job["text"] = text or f"{job['title']}\n{job['description']}"
        full_text = f"{job['title']}\n{job['description']}\n{job['text']}"

        repost = repost_key(job["title"], job["facts"].get("company") or "")
        if repost and repost in seen and not args.include_seen:
            reposts += 1
            done.append(job["key"])
            log(f"[{i}/{len(queue)}] skip (seen before on another board) {job['title'][:60]}")
            return "skipped"
        det_type = detect_type(job["facts"].get("type_line", "")) or \
            detect_type(f"{job['title']}\n{job['text'][:1500]}", check_internship=False)
        if det_type and det_type not in CFG.employment_types:
            excluded_type += 1
            done.append(job["key"])
            log(f"[{i}/{len(queue)}] skip ({det_type}) {job['title'][:70]}")
            return "skipped"
        loc_text = job["facts"].get("location") or ""
        mode = detect_mode(f"{job['facts'].get('type_line', '')} {loc_text}")
        if mode and mode not in CFG.work_modes:
            excluded_type += 1
            done.append(job["key"])
            log(f"[{i}/{len(queue)}] skip ({mode}) {job['title'][:70]}")
            return "skipped"
        remote_ok = CFG.remote_anywhere and (mode or detect_mode(full_text[:4000])) == "Remote"
        local = remote_ok or (in_region(loc_text) if loc_text else in_region(full_text[:5000]))
        if not local and (loc_text or job["source"] != "nijobs.com"):
            excluded_location += 1
            done.append(job["key"])
            log(f"[{i}/{len(queue)}] skip (outside region: '{loc_text or 'no matching location found'}') "
                f"{job['title'][:60]}")
            return "skipped"

        # Salary and closing date from the page itself are checked before spending model time on the job.
        page_salary = job["facts"].get("salary") or ""
        if page_salary and below_min_salary(parse_salary(page_salary), min_salary, salary_currency):
            excluded_salary += 1
            done.append(job["key"])
            log(f"[{i}/{len(queue)}] skip (salary {page_salary} below {min_salary}) {job['title'][:60]}")
            return "skipped"
        page_left = days_left(closing_date(job["text"], ""), today)
        if page_left is not None and page_left < 0:
            excluded_closed += 1
            done.append(job["key"])
            log(f"[{i}/{len(queue)}] skip (closed) {job['title'][:60]}")
            return "skipped"

        started = time.monotonic()
        rating = rate_job(host, model, num_ctx, profile, list(cv_kw), job, feedback)
        if not rating:
            if rating_failed(retries, job["key"], MAX_RATING_ATTEMPTS):
                done.append(job["key"])
                log(f"[{i}/{len(queue)}] giving up after {MAX_RATING_ATTEMPTS} failed ratings: {job['title'][:60]}")
            else:
                log(f"[{i}/{len(queue)}] rating failed ({retries[job['key']]}/{MAX_RATING_ATTEMPTS}), "
                    "will retry next run")
            return "failed"
        retries.pop(job["key"], None)
        done.append(job["key"])
        if (CFG.region_re and not loc_text and job["source"] != "nijobs.com" and not remote_ok
                and not rating.get("in_target_region") and not in_region(f"{job['title']}\n{job['description']}")):
            excluded_location += 1
            log(f"[{i}/{len(queue)}] skip (model: outside region) {job['title'][:60]}")
            return "rated"
        emp_type = det_type or rating.get("employment_type") or "Unknown"
        mode = mode or rating.get("work_mode") or detect_mode(full_text[:4000]) or "Unknown"
        if (emp_type != "Unknown" and emp_type not in CFG.employment_types) or \
                (mode != "Unknown" and mode not in CFG.work_modes):
            excluded_type += 1
            log(f"[{i}/{len(queue)}] skip ({emp_type}, {mode}) {job['title'][:60]}")
            return "rated"
        salary_text = job["facts"].get("salary") or rating.get("salary") or ""
        salary = parse_salary(salary_text)
        if below_min_salary(salary, min_salary, salary_currency):
            excluded_salary += 1
            log(f"[{i}/{len(queue)}] skip (salary {salary_text} below {min_salary}) {job['title'][:60]}")
            return "rated"
        closing = closing_date(job["text"], rating.get("closing_date", ""))
        left = days_left(closing, today)
        if left is not None and left < 0:
            excluded_closed += 1
            log(f"[{i}/{len(queue)}] skip (closed {closing}) {job['title'][:60]}")
            return "rated"
        if left is not None and left > 365:
            closing, left = None, None

        kw_matched, kw_other = keyword_match(full_text, cv_kw, other_kw)
        llm_matched = [s for s in rating.get("matched_skills", []) if s in cv_kw]
        matched = list(dict.fromkeys(llm_matched + kw_matched))
        gaps = list(dict.fromkeys([s for s in rating.get("missing_skills", []) if s and s.lower() not in cv_lower]
                                  + kw_other))[:6]
        coverage = round(100 * len(matched) / max(1, len(matched) + len(kw_other)))
        confidence = rating["confidence"]
        if job["snippet_only"]:
            confidence = min(confidence, 50)
        elif len(job["text"]) < 800:
            confidence = min(confidence, 65)

        penalty = seniority_penalty(job["title"])
        level = title_level(job["title"])
        model_level, stretch = model_stretch(job["title"], rating.get("seniority", ""))
        fit = max(0, rating["fit_score"] - penalty - stretch)
        entry = {
            "key": job["key"], "title": job["title"], "url": job["url"], "source": job["source"],
            "company": job["facts"].get("company") or rating.get("company") or "",
            "location": loc_text or rating.get("location") or CFG.region or "Unknown",
            "employment_type": {"Permanent": "Full-time permanent"}.get(emp_type, emp_type),
            "work_mode": mode,
            "salary": salary_text, "salary_range": salary,
            "seniority": ({"lead": "Lead-level stretch", "senior": "Senior-level stretch",
                           "junior": "Junior-level role"}[level] if penalty and level else
                          f"{rating.get('seniority')}-level stretch" if stretch and model_level != "junior" else
                          rating.get("seniority") or "Unknown"),
            "published": job["facts"].get("published", ""),
            "closing": closing.isoformat() if closing else "", "days_left": left,
            "fit": fit, "model_fit": rating["fit_score"], "confidence": confidence, "coverage": coverage,
            "matched": matched, "gaps": gaps, "reasoning": rating.get("reasoning", "").strip(),
            "snippet_only": job["snippet_only"], "listing": job["text"][:MAX_LISTING_CHARS],
        }
        repost = repost_key(entry["title"], entry["company"])
        if repost:
            repost_keys.append(repost)
        texts[job["key"]] = job["text"]
        log(f"[{i}/{len(queue)}] fit {entry['fit']}/10 conf {confidence}% cv {coverage}% "
            f"in {time.monotonic() - started:.0f}s - {job['title'][:60]}")
        if not args.dry_run:
            tracker.upsert_job(job["key"], entry, emailed=False, now=now)
        if entry["fit"] < min_score:
            below_min += 1
            return "rated"
        enrich_company(companies, entry, job, rating)
        results.append(entry)
        return "rated"

    timeouts = 0
    for i, job in enumerate(queue, 1):
        if i % 5 == 0 and not args.dry_run:
            save_retries(retries)
        try:
            outcome = rate_one(i, job)
        except ModelTimeout:
            timeouts += 1
            if rating_failed(retries, job["key"], MAX_RATING_ATTEMPTS):
                done.append(job["key"])
            log(f"[{i}/{len(queue)}] the model timed out on {job['title'][:60]}")
            if timeouts >= 2:
                log("The model timed out twice in a row; stopping the ratings for this run")
                break
            continue
        except Exception as exc:  # noqa: BLE001 - one odd listing must not cost the whole report
            log(f"[{i}/{len(queue)}] skipped after an error ({exc.__class__.__name__}: {str(exc)[:120]}): "
                f"{job['title'][:60]}")
            if rating_failed(retries, job["key"], MAX_RATING_ATTEMPTS):
                done.append(job["key"])
            continue
        timeouts = 0 if outcome != "skipped" else timeouts
    companies.save()

    dedup: dict[tuple, dict] = {}
    for r in results:
        k = (re.sub(r"\W+", "", r["title"].lower()), re.sub(r"\W+", "", r["company"].lower()))
        if k not in dedup or r["fit"] > dedup[k]["fit"]:
            dedup[k] = r
    duplicates = len(results) - len(dedup)
    results, grouped = group_agency_posts(list(dedup.values()), env_bool("JOB_HIDE_UNNAMED_AGENCY", False))
    grouped += duplicates

    for r in results:
        if verify_from and r["fit"] >= verify_from:
            second = second_opinion(host, model, num_ctx, profile, r["title"], texts.get(r["key"], ""),
                                    r["model_fit"], r["reasoning"])
            if second is not None:
                r["second_opinion"] = second
                if second < r["model_fit"]:
                    r["fit"] = max(0, r["fit"] - (r["model_fit"] - second + 1) // 2)
                    log(f"second opinion lowered {r['title'][:50]} to {r['fit']}/10")
    below_min += sum(r["fit"] < min_score for r in results)
    results = [r for r in results if r["fit"] >= min_score]
    results.sort(key=lambda r: (r["fit"], r["confidence"], r["coverage"]), reverse=True)

    def urgent_first(jobs: list[dict]) -> list[dict]:
        return sorted(jobs, key=lambda r: 0 if r.get("days_left") is not None and r["days_left"] <= 3 else 1)

    top = urgent_first([r for r in results if r["fit"] >= 7])
    maybe = urgent_first([r for r in results if r["fit"] < 7])
    results = top + maybe
    for r in results:
        r["actions"] = card_links(fb_url, fb_secret, r["key"], r["title"], profile=profile_id)
        r["skill_link"] = skill_link(fb_url, fb_secret, r["key"], r["title"], r["gaps"], profile_id)

    followups = tracker.followups(now)
    followups_html = followup_section(
        followups, lambda item: card_links(fb_url, fb_secret, item["key"], item["title"], FOLLOWUP_ACTIONS, profile_id))
    problems = source_problems(health, fb_error)

    summary = hermes_summary(host, model, num_ctx, results)
    stats = {
        "when": when, "shown": len(results), "strong": len(top),
        "avg_fit": f"{sum(r['fit'] for r in results) / len(results):.1f}" if results else "-",
        "scanned": len(queue), "min_score": min_score, "excluded_location": excluded_location,
        "excluded_type": excluded_type, "below_min": below_min, "model": model,
        "min_salary": min_salary, "salary_currency": salary_currency, "excluded_salary": excluded_salary,
        "excluded_closed": excluded_closed, "reposts": reposts, "grouped": grouped, "verify_from": verify_from,
        "feedback": bool(fb_url and fb_secret), "unsubscribe": report_unsubscribe_link(),
        "sources": ", ".join(f"{name} {info['found']}" for name, info in health.items()) or "none",
        "web_usage": web.usage(), "cv_added": cv_added,
    }
    html_body = fitted_html(top, maybe, stats, summary, problems, followups_html)
    text_body = (f"Added to your CV: {', '.join(cv_added)}\n\n" if cv_added else "") + \
        build_text(results, summary, followup_text(followups)) + \
        (f"\n\nUnsubscribe: {stats['unsubscribe']}" if stats["unsubscribe"] else "")
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    LAST_REPORT.write_text(preview_html(html_body), encoding="utf-8")
    LAST_RESULTS.write_text(json.dumps({"generated": when, "model": model, "summary": summary, "sources": health,
                                        "problems": problems, "jobs": results}, indent=1, default=str),
                            encoding="utf-8")

    line = (f"Job radar: {len(results)} matches ({len(top)} with fit 7+) from {len(queue)} rated; "
            f"best: {results[0]['title']} ({results[0]['fit']}/10)" if results else
            f"Job radar: no new matches from {len(queue)} rated")
    if problems:
        line += f" | {len(problems)} source warning{'s' if len(problems) > 1 else ''}"
    if args.dry_run:
        print(f"{line} [dry run, report at {LAST_REPORT}]")
        print(text_body)
        tracker.close()
        return 0

    if results or followups or env_bool("JOB_SCANNER_EMAIL_WHEN_EMPTY", False):
        subject = (f"{CFG.title}: {len(results)} new job{'' if len(results) == 1 else 's'}" if results
                   else f"{CFG.title}: follow up on {len(followups)} application"
                        f"{'' if len(followups) == 1 else 's'}" if followups
                   else f"{CFG.title}: 0 new jobs")
        try:
            hc.send_email(subject, html_body, text_body, CFG.title, {**inline_images(html_body, LOGO_DIR), **inline_images(html_body, ICON_DIR)})
        except (smtplib.SMTPException, OSError, RuntimeError) as exc:
            log(f"Email failed: {exc}")
            save_retries(retries)
            tracker.close()
            return 5
        tracker.mark_reminded(followups)
        for r in results:
            tracker.upsert_job(r["key"], r, emailed=True, now=now)

    seen.update({k: now for k in done + repost_keys})
    save_seen(seen)
    save_retries(retries)
    tracker.record_run(len(queue), len(results), health, problems, now)
    tracker.close()
    print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""News Digest: daily news on the topics you choose, curated by Hermes' model.

Topics come from the built-in catalog (TOPICS, picked with NEWS_DIGEST_TOPICS), free-form custom
topics (NEWS_DIGEST_CUSTOM_TOPICS) or a full sections file (NEWS_DIGEST_SECTIONS_FILE).
For each topic, runs a site-targeted and a broad news search (Firecrawl, with Tavily as backup) over the last
24 hours (widening to the last week when a section comes up short), drops social/video
junk, category pages and stories already sent, then asks Hermes' local Ollama model to
pick and summarise the best stories. The result is emailed as a sectioned HTML digest.

Runs from $HERMES_HOME/scripts as a Hermes cron job (see the package README):
    hermes cron create '0 12 * * *' --name news-digest --script news_digest.py --no-agent --deliver local

Manual runs:
    python3 news_digest.py --dry-run          # search + curate, write state/news_digest_last.html, no email
    python3 news_digest.py --test-email       # SMTP check only
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import smtplib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import requests

import hermes_common as hc
from hermes_common import (EMAIL_HEAD, STATE_DIR, WebClient, connect_model, env, env_bool, env_int,
                           first_sentences, gmail_dark_safe, inline_images, load_env_file, log, normalize_url,
                           ollama_chat)

hc.LOG_TAG = "news_digest"
ICON_DIR = Path(__file__).resolve().parent / "icons"  # PNGs built from icons/src by icons/build_icons.py
SEEN_FILE = STATE_DIR / "news_digest_seen.json"
LAST_REPORT = STATE_DIR / "news_digest_last.html"
LAST_RESULTS = STATE_DIR / "news_digest_last.json"
DEFAULT_READER = "a busy professional who wants the day's most important developments on these topics"


def digest_title() -> str:
    return env("NEWS_DIGEST_TITLE", "News Digest")


EXCLUDE_SITES = ("youtube.com", "facebook.com", "reddit.com", "instagram.com", "x.com", "tiktok.com",
                 "linkedin.com", "medium.com")
BLOCKED_DOMAINS = set(EXCLUDE_SITES) | {
    "youtu.be", "twitter.com", "threads.net", "threads.com", "pinterest.com", "quora.com", "wikipedia.org",
    "github.com", "stackoverflow.com", "amazon.com", "amazon.co.uk", "ebay.com", "ebay.co.uk", "t.me",
    "news.google.com", "msn.com", "yahoo.com", "flipboard.com", "substack.com", "bsky.app", "discord.com",
}
NON_ARTICLE_SEGMENTS = {"tag", "tags", "category", "categories", "topic", "topics", "author", "authors",
                        "section", "sections", "hub", "search", "page", "archive", "archives", "feed",
                        "events", "jobs", "careers", "about", "contact", "subscribe", "newsletter",
                        "podcast", "podcasts", "video", "videos", "shop", "deals", "coupons", "user", "users",
                        "profile", "profiles", "leaderboard", "pricing", "docs", "download", "downloads",
                        "ref", "glossary", "course", "courses", "t"}
FORUM_PREFIXES = ("discuss.", "forum.", "forums.", "community.")
ARTICLE_PARENTS = {"blog", "news", "article", "articles", "story", "stories", "post", "posts", "p", "papers"}
TRACKING_PREFIXES = ("utm_", "srsltid", "extended-comments", "fbclid", "gclid", "mc_")
GENERIC_ENTITIES = {
    "a", "an", "the", "and", "or", "of", "in", "on", "for", "with", "to", "is", "are", "at", "by", "as", "it", "its",
    "how", "why", "what", "when", "who", "this", "that", "from", "into", "new", "report", "introducing", "about",
    "ai", "llm", "llms", "ml", "iot", "api", "gpu", "cpu", "chip", "open", "source", "python", "agent", "agents",
    "model", "models", "edge", "tech", "news", "first", "says", "will", "can", "launches", "unveils", "releases",
    "announces", "2025", "2026", "2027", "preview", "guide", "update", "week", "today", "you", "your", "we",
    "our", "they", "their", "he", "she", "his", "her", "super", "soc", "startup", "students", "researchers"}
NON_ARTICLE_TITLE = re.compile(
    r"^(latest|home|news)\b|\b(latest|breaking) (news|stories|articles)\b|\bnews,? (and|&) (analysis|updates)\b"
    r"|\b(coupon|promo code|best deals?|% off)\b|\bjobs? (in|at)\b|\bpage \d+\b", re.I)

# Topic catalog. NEWS_DIGEST_TOPICS picks entries by id (in that order); each id needs icons built by
# icons/build_icons.py. Sites are searched with site: filters; the broad query catches everything else.
TOPICS = [
    {
        "id": "ai", "title": "Artificial Intelligence", "icon": "brain", "colour": "#7c3aed", "tint": "#f5f3ff",
        "scope": "AI industry news: model and product launches, major company moves, funding, policy and regulation, "
                 "AI agents and enterprise AI.",
        "sites": ["techcrunch.com", "theverge.com", "venturebeat.com", "arstechnica.com", "technologyreview.com",
                  "reuters.com", "theregister.com"],
        "site_query": "AI news",
        "broad_query": "artificial intelligence news OpenAI OR Anthropic OR Google Gemini OR Microsoft Copilot",
    },
    {
        "id": "ml", "title": "Machine Learning & Research", "icon": "microscope", "colour": "#db2777", "tint": "#fdf2f8",
        "scope": "Machine learning research and engineering: new open models, papers, benchmarks, training and "
                 "inference techniques, MLOps tooling and open-source releases.",
        "sites": ["huggingface.co", "marktechpost.com", "deepmind.google", "research.google", "ai.meta.com",
                  "technologyreview.com", "venturebeat.com"],
        "site_query": "machine learning research new model",
        "broad_query": "machine learning research new open source model released benchmark",
    },
    {
        "id": "python", "title": "Python", "icon": "python", "colour": "#3776ab", "tint": "#eff6ff",
        "scope": "The Python ecosystem: CPython releases and PEPs, major library/framework releases (pandas, NumPy, "
                 "FastAPI, Django, PyTorch, uv, etc.), PyPI security incidents and notable tooling. Every pick must "
                 "be specifically about Python or a Python package; never pick general AI or tech news that merely "
                 "could involve Python. A standout tutorial is acceptable only if there is little real news; "
                 "never pick course, university or marketing learning guides.",
        "sites": ["blog.python.org", "pyfound.blogspot.com", "realpython.com", "infoworld.com", "thenewstack.io",
                  "devclass.com", "lwn.net", "socket.dev", "astral.sh", "pytorch.org", "blog.jetbrains.com"],
        "site_query": "Python",
        # Python-focused sites publish weekly rather than daily; seen-state stops repeats.
        "site_tbs": "qdr:w",
        "broad_query": "Python release OR PEP OR PyPI OR library news",
    },
    {
        "id": "iot", "title": "IoT & Edge", "icon": "satellite-dish", "colour": "#059669", "tint": "#ecfdf5",
        "scope": "Internet of Things and edge computing: new boards and chips (Raspberry Pi, ESP32, Arduino, "
                 "Nordic), Matter/Thread and smart home, industrial IoT, edge AI, IoT security.",
        "sites": ["iottechnews.com", "cnx-software.com", "hackster.io", "embedded.com", "iot-analytics.com",
                  "electronicsweekly.com", "raspberrypi.com"],
        "site_query": "IoT OR edge",
        "broad_query": "IoT news edge AI OR Raspberry Pi OR ESP32 OR Matter smart home OR industrial IoT",
    },
    {
        "id": "newtech", "title": "New Tech & Gadgets", "icon": "rocket", "colour": "#ea580c", "tint": "#fff7ed",
        "scope": "New technology and hardware: phones, laptops, chips and GPUs, wearables, XR, EVs and robotics, "
                 "space tech and major platform launches.",
        "sites": ["theverge.com", "engadget.com", "arstechnica.com", "tomshardware.com", "techradar.com",
                  "wired.com", "9to5mac.com"],
        "site_query": "launch OR announced OR unveiled",
        "broad_query": "new technology launched OR unveiled OR announced gadget OR chip OR robot",
    },
    {
        "id": "security", "title": "Cybersecurity", "icon": "shield", "colour": "#dc2626", "tint": "#fef2f2",
        "scope": "Security news: actively exploited vulnerabilities, major breaches, ransomware, patches that "
                 "matter, threat-actor activity and security policy.",
        "sites": ["bleepingcomputer.com", "thehackernews.com", "krebsonsecurity.com", "therecord.media",
                  "securityweek.com", "darkreading.com"],
        "site_query": "vulnerability OR breach OR ransomware",
        "broad_query": "cybersecurity news exploited vulnerability OR data breach OR ransomware attack",
    },
    {
        "id": "cloud", "title": "Cloud & DevOps", "icon": "cloud", "colour": "#0ea5e9", "tint": "#f0f9ff",
        "scope": "Cloud platforms and DevOps: AWS, Azure and Google Cloud launches and outages, Kubernetes and "
                 "container tooling, CI/CD, infrastructure as code and platform engineering.",
        "sites": ["thenewstack.io", "devclass.com", "infoq.com", "aws.amazon.com", "cloud.google.com",
                  "azure.microsoft.com"],
        "site_query": "cloud OR Kubernetes OR DevOps",
        "broad_query": "cloud computing news AWS OR Azure OR Google Cloud OR Kubernetes release",
        "site_tbs": "qdr:w",
    },
    {
        "id": "programming", "title": "Programming & Dev Tools", "icon": "terminal", "colour": "#1e293b",
        "tint": "#f1f5f9",
        "scope": "Software development: programming language releases, compilers and runtimes, IDEs and "
                 "developer tools, package-registry incidents and notable open-source releases for developers.",
        "sites": ["github.blog", "infoq.com", "devclass.com", "thenewstack.io", "lwn.net", "blog.jetbrains.com"],
        "site_query": "release OR developer tools OR programming language",
        "broad_query": "programming language release OR developer tools news Rust OR Go OR TypeScript OR Java",
        "site_tbs": "qdr:w",
    },
    {
        "id": "webdev", "title": "Web Development", "icon": "code", "colour": "#4f46e5", "tint": "#eef2ff",
        "scope": "The web platform: browsers, JavaScript and TypeScript, frameworks (React, Vue, Svelte, Next.js), "
                 "CSS and web standards.",
        "sites": ["web.dev", "developer.chrome.com", "smashingmagazine.com", "blog.mozilla.org", "infoworld.com",
                  "thenewstack.io"],
        "site_query": "JavaScript OR TypeScript OR browser OR framework",
        "broad_query": "web development news JavaScript OR TypeScript OR React OR browser release",
        "site_tbs": "qdr:w",
    },
    {
        "id": "data", "title": "Data & Analytics", "icon": "database", "colour": "#0891b2", "tint": "#ecfeff",
        "scope": "Data engineering and analytics: databases, data warehouses and lakehouses, streaming, BI tools "
                 "and notable releases from Databricks, Snowflake, Postgres and similar.",
        "sites": ["datanami.com", "thenewstack.io", "infoworld.com", "databricks.com", "snowflake.com",
                  "postgresql.org"],
        "site_query": "data engineering OR analytics OR database",
        "broad_query": "data engineering analytics database news release",
        "site_tbs": "qdr:w",
    },
    {
        "id": "opensource", "title": "Open Source & Self-hosting", "icon": "box", "colour": "#0f766e",
        "tint": "#f0fdfa",
        "scope": "Open-source and self-hosted software: notable releases, Linux, homelab platforms, local AI "
                 "(Ollama, llama.cpp) and licence changes.",
        "sites": ["lwn.net", "selfh.st", "itsfoss.com", "opensource.com", "github.blog", "omgubuntu.co.uk"],
        "site_query": "open source release",
        "broad_query": "open source software release self-hosted Linux",
        "site_tbs": "qdr:w",
    },
    {
        "id": "smarthome", "title": "Smart Home", "icon": "house", "colour": "#d97706", "tint": "#fffbeb",
        "scope": "Smart-home and home-automation news: Home Assistant releases, Matter and Thread, Zigbee, "
                 "ESPHome and notable device launches. Skip shopping deals and generic gadget reviews.",
        "sites": ["home-assistant.io", "theverge.com", "arstechnica.com", "hackaday.com", "cnx-software.com"],
        "site_query": "Home Assistant OR Matter OR Zigbee OR smart home",
        "broad_query": "smart home news Home Assistant OR Matter OR Thread release",
        "site_tbs": "qdr:w",
    },
    {
        "id": "robotics", "title": "Robotics", "icon": "bot", "colour": "#57534e", "tint": "#fafaf9",
        "scope": "Robotics: humanoid and industrial robots, autonomous vehicles and drones, robotics research and "
                 "major funding or deployments.",
        "sites": ["therobotreport.com", "spectrum.ieee.org", "techcrunch.com", "robohub.org",
                  "roboticsandautomationnews.com"],
        "site_query": "robot OR robotics OR humanoid",
        "broad_query": "robotics news humanoid robot OR autonomous robot OR drone",
    },
    {
        "id": "space", "title": "Space", "icon": "orbit", "colour": "#1d4ed8", "tint": "#eff6ff",
        "scope": "Space exploration and industry: launches, missions, satellites, telescopes and discoveries from "
                 "NASA, ESA, SpaceX and others.",
        "sites": ["space.com", "spacenews.com", "nasaspaceflight.com", "esa.int", "arstechnica.com"],
        "site_query": "launch OR mission OR satellite",
        "broad_query": "space news launch mission NASA OR SpaceX OR ESA",
    },
    {
        "id": "science", "title": "Science", "icon": "flask-conical", "colour": "#16a34a", "tint": "#f0fdf4",
        "scope": "Science news: significant new studies and discoveries in physics, biology, chemistry, earth "
                 "science and more. Skip press-release hype without a published result.",
        "sites": ["nature.com", "science.org", "newscientist.com", "quantamagazine.org", "phys.org",
                  "sciencedaily.com"],
        "site_query": "study OR research OR discovery",
        "broad_query": "science news new study discovery researchers",
    },
    {
        "id": "climate", "title": "Climate & Energy", "icon": "leaf", "colour": "#65a30d", "tint": "#f7fee7",
        "scope": "Climate and energy: renewables, batteries and storage, EVs, grids, emissions data and climate "
                 "policy.",
        "sites": ["carbonbrief.org", "canarymedia.com", "electrek.co", "insideclimatenews.org", "theguardian.com"],
        "site_query": "climate OR renewable OR battery OR emissions",
        "broad_query": "climate energy news renewable OR solar OR battery OR emissions",
    },
    {
        "id": "health", "title": "Health & Medicine", "icon": "heart-pulse", "colour": "#e11d48", "tint": "#fff1f2",
        "scope": "Health and medicine: clinical trial results, drug and device approvals, public health and "
                 "health-tech. Skip wellness tips and supplement marketing.",
        "sites": ["statnews.com", "fiercebiotech.com", "medicalxpress.com", "medpagetoday.com", "bmj.com"],
        "site_query": "trial OR approval OR treatment OR health",
        "broad_query": "health medicine news clinical trial OR new treatment OR drug approval",
    },
    {
        "id": "business", "title": "Business & Startups", "icon": "briefcase", "colour": "#9333ea",
        "tint": "#faf5ff",
        "scope": "Business and startups: significant funding rounds, acquisitions, IPOs, layoffs and strategy "
                 "moves at notable companies.",
        "sites": ["techcrunch.com", "reuters.com", "cnbc.com", "sifted.eu", "fortune.com"],
        "site_query": "funding OR acquisition OR IPO",
        "broad_query": "startup funding round OR acquisition OR IPO business news",
    },
    {
        "id": "markets", "title": "Markets & Economy", "icon": "trending-up", "colour": "#047857", "tint": "#ecfdf5",
        "scope": "Markets and the economy: central banks and interest rates, inflation and jobs data, major "
                 "market moves and earnings that moved markets.",
        "sites": ["reuters.com", "cnbc.com", "apnews.com", "marketwatch.com", "economist.com"],
        "site_query": "markets OR economy OR inflation OR rates",
        "broad_query": "stock markets economy news inflation OR interest rates OR central bank",
    },
    {
        "id": "policy", "title": "Tech Policy & Regulation", "icon": "landmark", "colour": "#475569",
        "tint": "#f8fafc",
        "scope": "Technology policy: AI and privacy regulation, antitrust cases, online safety laws and major "
                 "court rulings affecting tech companies.",
        "sites": ["politico.eu", "techpolicy.press", "reuters.com", "theverge.com", "euractiv.com"],
        "site_query": "regulation OR law OR antitrust OR ruling",
        "broad_query": "technology regulation news AI Act OR antitrust OR privacy law OR online safety",
    },
    {
        "id": "world", "title": "World News", "icon": "globe", "colour": "#0369a1", "tint": "#f0f9ff",
        "scope": "The day's major world news: geopolitics, elections, conflicts, disasters and international "
                 "diplomacy. Prefer wire services and established outlets.",
        "sites": ["reuters.com", "apnews.com", "bbc.co.uk", "theguardian.com", "aljazeera.com"],
        "site_query": "world news",
        "broad_query": "world news today",
    },
    {
        "id": "gaming", "title": "Gaming", "icon": "gamepad-2", "colour": "#c026d3", "tint": "#fdf4ff",
        "scope": "Video games: major releases and announcements, consoles and hardware, studio and industry news. "
                 "Skip deals, guides and walkthroughs.",
        "sites": ["polygon.com", "eurogamer.net", "gamesindustry.biz", "rockpapershotgun.com", "ign.com"],
        "site_query": "game OR console OR studio",
        "broad_query": "video game news release OR console OR studio",
    },
    {
        "id": "sport", "title": "Sport", "icon": "trophy", "colour": "#ca8a04", "tint": "#fefce8",
        "scope": "Sport: major results, transfers and tournament news across the big sports. Skip betting tips "
                 "and fantasy advice.",
        "sites": ["bbc.co.uk", "espn.com", "skysports.com", "theathletic.com", "reuters.com"],
        "site_query": "result OR wins OR final OR transfer",
        "broad_query": "sports news results today",
    },
]
DEFAULT_TOPICS = ["ai", "ml", "python", "iot", "newtech"]
CUSTOM_PALETTE = [("#475569", "#f8fafc"), ("#0f766e", "#f0fdfa"), ("#9333ea", "#faf5ff"), ("#ea580c", "#fff7ed"),
                  ("#0369a1", "#f0f9ff"), ("#be123c", "#fff1f2")]
SECTIONS = [t for t in TOPICS if t["id"] in DEFAULT_TOPICS]

PICK_SCHEMA_ITEM = {
    "type": "object",
    "properties": {
        "index": {"type": "integer"},
        "headline": {"type": "string", "maxLength": 110},
        "summary": {"type": "string", "maxLength": 320},
        "why_it_matters": {"type": "string", "maxLength": 200},
        "importance": {"type": "integer", "minimum": 1, "maximum": 10},
    },
    "required": ["index", "headline", "summary", "why_it_matters", "importance"],
}

def editor_system() -> str:
    return EDITOR_SYSTEM.format(reader=env("NEWS_DIGEST_READER", DEFAULT_READER))


EDITOR_SYSTEM = (
    "You are a sharp news editor writing a daily digest for {reader}. "
    "Pick genuinely new, newsworthy stories. Use ONLY facts stated in each candidate's title and snippet: never "
    "invent numbers, names, dates or claims, and never add connections the snippet does not state. Skip "
    "listicles, generic how-tos, SEO roundups, deals, job posts, press-release fluff, opinion pieces without news "
    "and evergreen pages (leaderboards, model cards, product or pricing pages, course guides). If several "
    "candidates cover the same story, pick the best source once. Headlines are short and factual. Summaries are "
    "1-2 plain sentences. 'why_it_matters' is one sentence on the practical impact for the reader. "
    "Importance: most stories are 5-7; 8 is a clearly significant development; 9-10 is reserved for rare, "
    "major events such as a landmark launch, a huge acquisition, a major policy decision or a critical widely "
    "exploited vulnerability. Reply with JSON only."
)


def esc(text) -> str:
    return html.escape(str(text or ""), quote=True)


def domain_of(url: str) -> str:
    return urlsplit(url).netloc.lower().removeprefix("www.")


def blocked(domain: str) -> bool:
    return any(domain == d or domain.endswith("." + d) for d in BLOCKED_DOMAINS)


def is_article(url: str, title: str) -> bool:
    parts = urlsplit(url)
    segments = [s.lower() for s in parts.path.split("/") if s]
    if not segments or parts.path.lower().endswith((".pdf", ".xml", ".rss")):
        return False
    if any(s in NON_ARTICLE_SEGMENTS for s in segments):
        return False
    domain = domain_of(url)
    if domain.startswith(FORUM_PREFIXES):
        return False
    if domain == "huggingface.co" and segments[0] not in {"blog", "papers"}:
        return False
    # Articles have a slug or numeric id (/2026/09/foo-bar, /12345) or sit under /blog/, /news/ etc.;
    # bare paths like /ai or /ai/leaderboard are section fronts.
    sluggish = any("-" in s or "_" in s or re.search(r"\d{4,}", s) for s in segments)
    under_parent = any(s in ARTICLE_PARENTS for s in segments[:-1])
    if not (sluggish or under_parent):
        return False
    # Search engines occasionally pair a URL with another article's title; a descriptive slug that
    # shares no words with the title gives that away.
    slug = max(segments, key=lambda s: s.count("-"))
    slug_words = content_words(" ".join(w for w in slug.split("-") if not w.isdigit()))
    if len(slug_words) >= 4 and not slug_words & content_words(title):
        return False
    return len(title) >= 20 and not NON_ARTICLE_TITLE.search(title)


def clean_link(url: str) -> str:
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith(TRACKING_PREFIXES)]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))


def whole_sentences(text: str, n: int, max_chars: int) -> str:
    """Up to n complete sentences within max_chars, dropping a trailing fragment cut off by a length limit."""
    sentences = re.split(r"(?<=[.!?])\s+", " ".join((text or "").split()))
    out: list[str] = []
    for s in sentences[:n]:
        if not re.search(r"[.!?][\"')\u2019\u201d]?$", s) or len(" ".join(out + [s])) > max_chars:
            break
        out.append(s)
    return " ".join(out) or first_sentences(text or "", n, max_chars)


STOPWORDS = {"that", "this", "with", "from", "into", "their", "they", "have", "been", "will", "would", "could",
              "about", "after", "over", "more", "than", "which", "while", "also", "such", "what", "when", "where",
              "your", "says", "said", "report", "reports", "new", "news", "raising", "enabling", "highlighting"}


def content_words(text: str) -> set[str]:
    words = set()
    for w in re.findall(r"[a-z0-9][a-z0-9'\u2019.-]*[a-z0-9]", text.lower()):
        w = re.sub(r"['\u2019]s$", "", w)
        if len(w) >= 4 and w not in STOPWORDS:
            words.add(w[:-1] if w.endswith("s") and len(w) > 4 else w)
    return words


def clean_snippet(text: str, title: str) -> str:
    """Search snippet as plain text, or '' when it is page chrome or describes a different story."""
    links = len(re.findall(r"\]\(https?://", text))
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"#+\s*", "", text)
    text = " ".join(text.replace("\u200b", "").replace("\u2060", "").split())
    text = re.sub(r"^(\d+\s+(minutes?|hours?|days?)\s+ago|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4})\s*[\u00b7|\-\u2013]\s*",
                  "", text)
    title_words = content_words(title)
    if links >= 2 or (title_words and len(title_words & content_words(text)) / len(title_words) < 0.2):
        return ""
    return text[:320]


def grounded(text: str, source: str, min_ratio: float = 0.35) -> bool:
    """True when enough of a model-written line's words come from the candidate it claims to describe."""
    words = content_words(text)
    return bool(words) and len(words & content_words(source)) / len(words) >= min_ratio


def title_ids(title: str) -> set[str]:
    return {w for w in entities(title) if re.search(r"\d", w)}


def entities(text: str) -> set[str]:
    """Named subjects (Nvidia, Holo4, CVE-2026-1234, nRF54L15) used to find possible duplicate stories."""
    found = set()
    for w in re.findall(r"\b[A-Za-z][\w.-]*[A-Za-z0-9]", text):
        w = re.sub(r"['\u2019]s$", "", w)
        if (w[0].isupper() or re.search(r"\d", w)) and w.lower() not in GENERIC_ENTITIES:
            found.add(w.lower())
    return found


def title_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()[:70]


def clean_title(title: str) -> str:
    title = title.replace("\\|", "|").strip()
    parts = re.split(r"\s+[|\u2013\u2014-]\s+", title)
    # Drop a trailing " | Site Name" / " - Site Name" suffix when the rest is long enough.
    if len(parts) > 1 and len(" ".join(parts[:-1])) >= 25 and len(parts[-1]) <= 30:
        title = " - ".join(parts[:-1])
    return title[:160]


def section_queries(sec: dict) -> list[str]:
    sites = " OR ".join(f"site:{s}" for s in sec["sites"])
    excludes = " ".join(f"-site:{s}" for s in EXCLUDE_SITES)
    site_query = f"{sec['site_query']} ({sites})" if sites else f"{sec['site_query']} news"
    return [site_query, f"{sec['broad_query']} {excludes}"]


def load_seen(days: int) -> dict:
    try:
        seen = json.loads(SEEN_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    return {k: v for k, v in seen.items() if v >= cutoff}


def gather(web: WebClient, seen: dict, per_query: int, min_candidates: int, country: str | None,
           max_candidates: int) -> tuple[dict[str, list[dict]], dict]:
    taken: set[str] = set()
    by_section: dict[str, list[dict]] = {}
    stats = {"raw": 0, "blocked": 0, "not_article": 0, "seen": 0, "duplicate": 0, "widened": []}

    def add(sec_id: str, results: list[dict], window: str) -> None:
        bucket = by_section.setdefault(sec_id, [])
        for r in results:
            url, title = (r.get("url") or "").strip(), (r.get("title") or "").strip()
            if not url.startswith("http") or not title:
                continue
            stats["raw"] += 1
            domain = domain_of(url)
            if blocked(domain):
                stats["blocked"] += 1
                continue
            if not is_article(url, title):
                stats["not_article"] += 1
                continue
            title = clean_title(title)
            ukey, tkey = normalize_url(url), "t:" + title_key(title)
            if ukey in seen or tkey in seen:
                stats["seen"] += 1
                continue
            if ukey in taken or tkey in taken:
                stats["duplicate"] += 1
                continue
            taken.update((ukey, tkey))
            bucket.append({"url": clean_link(url), "title": title, "domain": domain, "window": window,
                           "description": clean_snippet(r.get("description") or "", title)})

    for sec in SECTIONS:
        site_q, broad_q = section_queries(sec)
        site_tbs = sec.get("site_tbs", "qdr:d")
        add(sec["id"], web.search(site_q, per_query, site_tbs, country, topic="news"),
            "24h" if site_tbs == "qdr:d" else "week")
        add(sec["id"], web.search(broad_q, per_query, "qdr:d", country, topic="news"), "24h")
        if len(by_section.get(sec["id"], [])) < min_candidates:
            stats["widened"].append(sec["title"])
            log(f"{sec['title']}: only {len(by_section.get(sec['id'], []))} fresh stories today; widening to the past week")
            add(sec["id"], web.search(broad_q, per_query, "qdr:w", country, topic="news"), "week")
        by_section[sec["id"]] = by_section.get(sec["id"], [])[:max_candidates]
        log(f"{sec['title']}: {len(by_section[sec['id']])} candidates")
    return by_section, stats


def curate_section(host: str, model: str, num_ctx: int | None, sec: dict, cands: list[dict], n: int,
                   covered: list[str], min_importance: int) -> list[dict]:
    if not cands:
        return []
    listing = "\n".join(
        f"[{i}] {c['title']} ({c['domain']}{', past week' if c['window'] == 'week' else ''})\n    {c['description'] or '(no snippet)'}"
        for i, c in enumerate(cands))
    already = ("\n\nAlready covered in earlier sections (do NOT pick these stories again, even from another source):\n"
               + "\n".join(f"- {h}" for h in covered)) if covered else ""
    user = (f"Section: {sec['title']}\nScope: {sec['scope']}\n\n"
            f"Pick up to {n} of the candidates below that best fit this section, most important first. "
            f"Use the candidate's [index]. Fewer picks are fine if few candidates fit.{already}\n\nCandidates:\n{listing}")
    schema = {"type": "object", "required": ["picks"],
              "properties": {"picks": {"type": "array", "maxItems": n, "items": PICK_SCHEMA_ITEM}}}
    picks: list[dict] = []
    for attempt, budget in enumerate((1200, 2000), 1):
        try:
            raw = ollama_chat(host, model, editor_system(), user, num_ctx, fmt=schema, num_predict=budget)
            picks = json.loads(raw).get("picks") or []
            break
        except (requests.RequestException, ValueError, KeyError) as exc:
            log(f"{sec['title']}: curation attempt {attempt} failed ({exc.__class__.__name__})")
    stories, used = [], set()
    for p in picks:
        idx = p.get("index")
        if not isinstance(idx, int) or not 0 <= idx < len(cands) or idx in used:
            continue
        used.add(idx)
        if int(p.get("importance") or 5) < min_importance:
            continue
        c = cands[idx]
        source = f"{c['title']} {c['description']}"
        headline = (p.get("headline") or "").strip()
        summary = whole_sentences(p.get("summary") or "", 2, 360)
        why = whole_sentences(p.get("why_it_matters") or "", 1, 220)
        # The small model sometimes attaches one candidate's text to another's index.
        if not grounded(summary, source):
            if summary:
                log(f"Ungrounded summary for '{c['title'][:60]}'; using the snippet")
            summary, why = whole_sentences(c["description"], 2, 360), ""
        headline = re.sub(r"(\s*\([a-z0-9.-]+\.[a-z]{2,}\))+$", "", headline)
        new_numbers = set(re.findall(r"\d+", headline)) - set(re.findall(r"\d+", source))
        if not grounded(headline, source, 0.5) or new_numbers:
            headline = c["title"]
        headline = re.sub(r"\s*(\.\.\.|\u2026)$", "", headline)
        stories.append({**c, "section": sec["id"], "headline": headline[:140], "summary": summary, "why": why,
                        "importance": max(1, min(10, int(p.get("importance") or 5))),
                        "curated": True})
        if len(stories) >= n:
            break
    if not stories and not picks:
        log(f"{sec['title']}: model gave no usable picks; falling back to search order")
        stories = [{**c, "section": sec["id"], "headline": c["title"], "summary": first_sentences(c["description"], 2, 360),
                    "why": "", "importance": 5, "curated": False} for c in cands[:n]]
    return stories


def dedupe_across(host: str, model: str, num_ctx: int | None, sections: list[tuple[dict, list[dict]]]) -> int:
    """Drop repeats of the same news event across sections, keeping the copy in the earliest section."""
    flat = [s for _, st in sections for s in st]
    if len(flat) < 2:
        return 0
    # Headlines are Title Case, so proper nouns come from the sentence-case summary and snippet.
    ids = [title_ids(s["title"]) for s in flat]
    names = [entities(f"{s['summary']} {s['description']}") | ids[k] for k, s in enumerate(flat)]
    # Headline words that are proper nouns anywhere in today's digest: each story's main subjects.
    vocabulary = set().union(*names)
    subjects = [vocabulary & {w.lower() for w in re.findall(r"[\w.-]+", s["title"])} for s in flat]
    schema = {"type": "object", "required": ["same"], "properties": {"same": {"type": "boolean"}}}
    drop: set[int] = set()
    # Only stories sharing a named subject are compared, one pair at a time: the small model is
    # unreliable at grouping a whole list but good at a single yes/no comparison.
    for j in range(1, len(flat)):
        for i in range(j):
            if i in drop or not names[i] & names[j]:
                continue
            # Both headlines naming the same versioned product or CVE id (Holo4, CVE-2026-1234), or the same
            # two subjects (Microsoft + Copilot), is decisive.
            if ids[i] & ids[j] or len(subjects[i] & subjects[j]) >= 2:
                drop.add(j)
                break
            user = (f"Story A: {flat[i]['title']}. {flat[i]['summary']}\n"
                    f"Story B: {flat[j]['title']}. {flat[j]['summary']}\n\n"
                    "Do A and B report the SAME specific news event (the same launch, release, deal, incident or "
                    "paper)? Different outlets covering the same announcement ARE the same event. Two different "
                    "stories about the same company, product line or topic are NOT the same.")
            try:
                same = json.loads(ollama_chat(host, model, editor_system(), user, num_ctx, fmt=schema,
                                              num_predict=20)).get("same") is True
            except (requests.RequestException, ValueError, KeyError) as exc:
                log(f"Duplicate check failed ({exc.__class__.__name__})")
                continue
            if same:
                drop.add(j)
                break
    if drop:
        log("Dropping cross-section duplicates: " + "; ".join(flat[i]["headline"] for i in sorted(drop)))
        dropped_ids = {id(flat[i]) for i in drop}
        for n, (sec, st) in enumerate(sections):
            sections[n] = (sec, [s for s in st if id(s) not in dropped_ids])
    return len(drop)


def deepen_top_story(web: WebClient, host: str, model: str, num_ctx: int | None, story: dict) -> None:
    text = web.scrape(story["url"])
    if not text or len(text) < 600:
        log("Top story could not be scraped; keeping the snippet summary")
        return
    schema = {"type": "object", "required": ["summary", "key_points"], "properties": {
        "summary": {"type": "string", "maxLength": 900},
        "key_points": {"type": "array", "maxItems": 3, "items": {"type": "string", "maxLength": 200}}}}
    user = (f"Headline: {story['headline']}\n\nArticle text:\n{text[:6000]}\n\n"
            "Write a factual summary of what this article reports in 2-3 short sentences (under 70 words) and up "
            "to 3 short key points (under 20 words each), using only facts stated in the article. Ignore page "
            "furniture such as author lists, publication dates, navigation and sign-up prompts.")
    try:
        data = json.loads(ollama_chat(host, model, editor_system(), user, num_ctx, fmt=schema, num_predict=900))
    except (requests.RequestException, ValueError, KeyError) as exc:
        log(f"Top story summary failed ({exc.__class__.__name__})")
        return
    summary = whole_sentences(data.get("summary") or "", 3, 600)
    if len(summary) > len(story["summary"]) and grounded(summary, text[:6000]):
        story["summary"] = summary
    story["key_points"] = [" ".join(k.split())[:200] for k in (data.get("key_points") or []) if k.strip()][:3]


def write_briefing(host: str, model: str, num_ctx: int | None, sections: list[tuple[dict, list[dict]]]) -> str:
    lines = []
    for sec, stories in sections:
        for s in stories[:3]:
            lines.append(f"- [{sec['title']}] {s['headline']}: {s['summary']}")
    if not lines:
        return ""
    schema = {"type": "object", "required": ["briefing"],
              "properties": {"briefing": {"type": "string", "maxLength": 1100}}}
    user = ("Today's selected stories:\n" + "\n".join(lines) +
            "\n\nWrite a briefing for the reader in 3-4 short sentences (under 90 words) that leads with the single most "
            "important development, then connects the other notable themes across sections. Plain text, no "
            "lists, no greeting, only facts from the stories above.")
    try:
        data = json.loads(ollama_chat(host, model, editor_system(), user, num_ctx, fmt=schema, num_predict=700))
        return whole_sentences(data.get("briefing") or "", 4, 800)
    except (requests.RequestException, ValueError, KeyError) as exc:
        log(f"Briefing failed ({exc.__class__.__name__})")
        return ""


# --------------------------------------------------------------------------- HTML

C_BG, C_INK, C_MUTED, C_CARD = "#f1f5f9", "#0f172a", "#64748b", "#ffffff"
SEC_BY_ID = {s["id"]: s for s in SECTIONS}
SECTION_KEYS = {"id", "title", "icon", "colour", "tint", "scope", "sites", "site_query", "broad_query"}
CUSTOM_SECTIONS = {"on": False}


def load_sections(path: str) -> None:
    """Replace the chosen topics with a JSON list of section objects (see sections.example.json).
    Relative paths are resolved against this script's directory."""
    file = Path(path)
    if not file.is_absolute():
        file = Path(__file__).resolve().parent / file
    data = json.loads(file.read_text(encoding="utf-8"))
    missing = [(s.get("id", "?"), sorted(SECTION_KEYS - set(s))) for s in data if SECTION_KEYS - set(s)]
    if not data or missing:
        raise ValueError(f"invalid sections file {path}: missing keys {missing}")
    SECTIONS[:] = data
    CUSTOM_SECTIONS["on"] = True
    SEC_BY_ID.clear()
    SEC_BY_ID.update({s["id"]: s for s in SECTIONS})


def custom_topics(spec: str) -> list[dict]:
    """Parse NEWS_DIGEST_CUSTOM_TOPICS, e.g. "Formula 1: F1, Grand Prix || Home Brewing: homebrew, craft beer"."""
    out = []
    for chunk in (c.strip() for c in spec.split("||")):
        title, _, words = chunk.partition(":")
        title = title.strip()
        if not title:
            continue
        keywords = [k.strip() for k in (words or title).split(",") if k.strip()]
        terms = " OR ".join(f'"{k}"' if " " in k else k for k in keywords)
        colour, tint = CUSTOM_PALETTE[len(out) % len(CUSTOM_PALETTE)]
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or str(len(out) + 1)
        out.append({
            "id": f"custom-{slug}", "title": title, "icon": "newspaper", "colour": colour, "tint": tint,
            "scope": f"News about {title} ({', '.join(keywords)}): genuinely new developments, announcements and "
                     "results. Skip evergreen explainers, listicles, deals and marketing.",
            "sites": [], "site_query": terms, "broad_query": f"{title} news {terms}",
        })
    return out


def select_topics(ids: str, custom: str) -> None:
    """Build SECTIONS from NEWS_DIGEST_TOPICS (catalog ids, in order) plus NEWS_DIGEST_CUSTOM_TOPICS."""
    catalog = {t["id"]: t for t in TOPICS}
    wanted = [i.strip().lower() for i in ids.split(",") if i.strip()] if ids.strip() else list(DEFAULT_TOPICS)
    unknown = [i for i in wanted if i not in catalog]
    if unknown:
        log(f"ignoring unknown topics: {', '.join(unknown)} (known: {', '.join(catalog)})")
    chosen = [catalog[i] for i in dict.fromkeys(wanted) if i in catalog] + custom_topics(custom)
    if not chosen:
        raise ValueError("no news topics selected; set NEWS_DIGEST_TOPICS or NEWS_DIGEST_CUSTOM_TOPICS")
    SECTIONS[:] = chosen
    SEC_BY_ID.clear()
    SEC_BY_ID.update({s["id"]: s for s in SECTIONS})


def default_tagline() -> str:
    titles = [s["title"] for s in SECTIONS]
    if CUSTOM_SECTIONS["on"] or len(titles) > 5 or len(" ".join(titles)) > 70:
        return "Curated news from the last 24 hours"
    joined = titles[0] if len(titles) == 1 else ", ".join(titles[:-1]) + " & " + titles[-1]
    return f"{joined} from the last 24 hours"


def icon_id(sec: dict) -> str:
    """Topics without built icons (custom topics, sections files) use the generic set."""
    return sec["id"] if (ICON_DIR / f"badge-{sec['id']}.png").is_file() else "custom"


def icon(name: str, size: int) -> str:
    if not (ICON_DIR / f"{name}.png").is_file():
        return ""
    return (f'<img src="cid:{name}" width="{size}" height="{size}" alt="" '
            f'style="display:inline-block;vertical-align:middle;border:0;outline:none">')


def importance_badge(value: int, colour: str) -> str:
    return (f'<span style="display:inline-block;background:{colour};color:#ffffff;border-radius:6px;'
            f'padding:2px 7px;font-size:11px;font-weight:700">{value}/10</span>')


def stat_tile(value, label: str) -> str:
    return (f'<td width="25%" align="center" style="padding:6px">'
            f'<div style="background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);border-radius:12px;padding:12px 6px">'
            f'<div style="font-size:24px;font-weight:800;color:#ffffff">{value}</div>'
            f'<div style="font-size:11px;color:#fde68a;text-transform:uppercase;letter-spacing:.06em">{label}</div></div></td>')


def hero_card(story: dict) -> str:
    sec = SEC_BY_ID[story["section"]]
    points = "".join(
        f'<tr><td valign="top" style="padding:3px 8px 3px 0;color:{sec["colour"]};font-weight:800">&#8226;</td>'
        f'<td style="padding:3px 0;font-size:14px;color:#334155;line-height:1.5">{esc(p)}</td></tr>'
        for p in story.get("key_points") or [])
    points_block = f'<table cellpadding="0" cellspacing="0" style="margin:12px 0 4px">{points}</table>' if points else ""
    why = (f'<div style="margin-top:12px;font-size:14px;color:#334155;line-height:1.5">'
           f'<b style="color:{sec["colour"]}">Why it matters:</b> {esc(story["why"])}</div>') if story["why"] else ""
    return f"""
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_CARD};border:1px solid #e2e8f0;border-top:5px solid {sec['colour']};border-radius:16px;margin:22px 0 4px">
<tr><td style="padding:22px 24px">
  <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:{sec['colour']};font-weight:800">{icon(f"star-{icon_id(sec)}", 14)} <span style="vertical-align:middle">Top story &middot;</span> {icon(f"glyph-{icon_id(sec)}", 14)} <span style="vertical-align:middle">{esc(sec['title'])}</span></div>
  <a href="{esc(story['url'])}" style="display:block;font-size:22px;font-weight:800;color:{C_INK};text-decoration:none;line-height:1.3;margin:8px 0 6px">{esc(story['headline'])}</a>
  <div style="font-size:12px;color:{C_MUTED};margin-bottom:10px">{esc(story['domain'])} &nbsp;{importance_badge(story['importance'], sec['colour'])}</div>
  <div style="font-size:15px;color:#1e293b;line-height:1.6">{esc(story['summary'])}</div>
  {points_block}
  {why}
  <div style="margin-top:16px"><a href="{esc(story['url'])}" style="display:inline-block;background:{sec['colour']};color:#ffffff;padding:10px 18px;border-radius:10px;font-size:14px;font-weight:600;text-decoration:none">Read the story &rarr;</a></div>
</td></tr></table>"""


def story_row(story: dict, sec: dict, last: bool) -> str:
    border = "" if last else "border-bottom:1px solid #e2e8f0;"
    why = (f'<div style="font-size:13px;color:#475569;line-height:1.5;margin-top:6px">'
           f'<b style="color:{sec["colour"]}">Why it matters:</b> {esc(story["why"])}</div>') if story["why"] else ""
    older = ' &middot; <span style="color:#b45309">past week</span>' if story["window"] == "week" else ""
    summary = (f'<div style="font-size:14px;color:#334155;line-height:1.55">{esc(story["summary"])}</div>'
               if story["summary"] else "")
    return f"""
<tr><td style="padding:16px 22px;{border}">
  <a href="{esc(story['url'])}" style="font-size:16px;font-weight:700;color:{C_INK};text-decoration:none;line-height:1.35">{esc(story['headline'])}</a>
  <div style="font-size:12px;color:{C_MUTED};margin:4px 0 8px">{esc(story['domain'])}{older} &nbsp;{importance_badge(story['importance'], sec['colour'])}</div>
  {summary}
  {why}
  <div style="margin-top:8px"><a href="{esc(story['url'])}" style="font-size:13px;font-weight:600;color:{sec['colour']};text-decoration:none">Read more &rarr;</a></div>
</td></tr>"""


def section_block(sec: dict, stories: list[dict]) -> str:
    if stories:
        rows = "".join(story_row(s, sec, i == len(stories) - 1) for i, s in enumerate(stories))
    else:
        rows = (f'<tr><td style="padding:16px 22px;font-size:14px;color:{C_MUTED}">'
                f'No fresh stories worth your time in this section today.</td></tr>')
    return f"""
<a name="{sec['id']}"></a>
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_CARD};border:1px solid #e2e8f0;border-radius:16px;margin:22px 0 0;overflow:hidden">
<tr><td style="background:{sec['tint']};border-left:5px solid {sec['colour']};border-radius:16px 16px 0 0;padding:14px 22px">
  {icon(f"badge-{icon_id(sec)}", 32)}
  <span style="font-size:17px;font-weight:800;color:{sec['colour']};vertical-align:middle;margin-left:10px">{esc(sec['title'])}</span>
  <span style="font-size:12px;color:{C_MUTED};vertical-align:middle;margin-left:6px">{len(stories)} {'story' if len(stories) == 1 else 'stories'}</span>
</td></tr>
{rows}
</table>"""


def nav_chips(sections: list[tuple[dict, list[dict]]]) -> str:
    return "".join(
        f'<a href="#{sec["id"]}" style="display:inline-block;background:rgba(255,255,255,.14);color:#ffffff;'
        f'border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:5px 12px;font-size:12px;'
        # No emoji here: the Gmail dark-mode blend wrapper around the header would invert their colours.
        f'font-weight:600;text-decoration:none;margin:0 6px 6px 0">{esc(sec["title"])} &middot; {len(st)}</a>'
        for sec, st in sections)


def build_html(sections: list[tuple[dict, list[dict]]], top: dict | None, briefing: str, stats: dict) -> str:
    briefing_block = (
        f'<table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:16px;margin:22px 0 0">'
        f'<tr><td style="padding:18px 22px"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#b45309;font-weight:800">Briefing</div>'
        f'<div style="font-size:15px;color:#1e293b;line-height:1.6;margin-top:6px">{esc(briefing)}</div></td></tr></table>'
    ) if briefing else ""
    sections = [(sec, [s for s in st if s is not top]) for sec, st in sections]
    body = "".join(section_block(sec, st) for sec, st in sections)
    widened = (f"Widened to the past week for: {esc(', '.join(stats['widened']))}.<br>" if stats["widened"] else "")
    title = esc(digest_title())
    tagline = esc(env("NEWS_DIGEST_TAGLINE") or default_tagline())
    edition = esc(stats.get("edition") or "Daily")
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">{EMAIL_HEAD}<title>{title}</title></head>
<body class="body" style="margin:0;padding:0;background:{C_BG};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_BG}"><tr><td align="center" style="padding:24px 12px">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%">
<tr><td style="background:#1e3a8a;background-image:linear-gradient(135deg,#0f172a 0%,#1e3a8a 50%,#d97706 100%);border-radius:20px;padding:30px 28px">
  <table cellpadding="0" cellspacing="0"><tr>
    <td style="padding-right:7px;line-height:0">{icon("sun", 15)}</td>
    <td>{gmail_dark_safe('<div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#fcd34d;font-weight:700">' + edition + ' edition</div>')}</td>
  </tr></table>{gmail_dark_safe(f'''
  <div style="font-size:30px;font-weight:800;color:#ffffff;margin:6px 0 4px">{title}</div>
  <div style="font-size:15px;color:#e0e7ff;font-weight:600">{tagline}</div>
  <div style="font-size:13px;color:#cbd5e1;margin-top:4px">{esc(stats['when'])}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr>
    {stat_tile(stats['stories'], 'Stories')}{stat_tile(stats['sections'], 'Sections')}{stat_tile(stats['sources'], 'Sources')}{stat_tile(stats['scanned'], 'Scanned')}
  </tr></table>
  <div style="margin-top:14px">{nav_chips(sections)}</div>''')}
</td></tr>
<tr><td>
  {briefing_block}
  {hero_card(top) if top else ''}
  {body}
  <div style="font-size:12px;color:{C_MUTED};line-height:1.6;padding:18px 6px 6px;text-align:center">
    Curated by {esc(stats['model'])} on your server from {stats['scanned']} search results.<br>
    Filtered out: {stats['blocked']} social/video links, {stats['not_article']} non-article pages, {stats['seen']} already sent, {stats['duplicate']} duplicates.<br>
    {widened}Web data: {stats['web_usage']}. Importance is the editor&rsquo;s 1-10 rating.
  </div>
</td></tr>
</table></td></tr></table></body></html>"""


def build_text(sections: list[tuple[dict, list[dict]]], top: dict | None, briefing: str) -> str:
    parts = [briefing, ""] if briefing else []
    if top:
        parts.append(f"TOP STORY: {top['headline']}\n{top['summary']}\n{top['url']}\n")
    for sec, stories in sections:
        parts.append(f"== {sec['title'].upper()} ==")
        for s in stories:
            if s is top:
                continue
            parts.append(f"* [{s['importance']}/10] {s['headline']} ({s['domain']})\n  {s['summary']}\n  {s['url']}")
        parts.append("")
    return "\n".join(parts)


# --------------------------------------------------------------------------- main

def main() -> int:
    parser = argparse.ArgumentParser(description="Daily sectioned news digest on your chosen topics, curated by "
                                                 "Hermes' model.")
    parser.add_argument("--dry-run", action="store_true", help="don't send email or update seen-state")
    parser.add_argument("--test-email", action="store_true", help="send a test email and exit")
    parser.add_argument("--include-seen", action="store_true", help="allow stories sent in previous digests")
    args = parser.parse_args()

    load_env_file()
    try:
        if env("NEWS_DIGEST_SECTIONS_FILE"):
            load_sections(env("NEWS_DIGEST_SECTIONS_FILE"))
        else:
            select_topics(env("NEWS_DIGEST_TOPICS"), env("NEWS_DIGEST_CUSTOM_TOPICS"))
    except (OSError, ValueError) as exc:
        log(str(exc))
        return 4
    tz = ZoneInfo(env("HERMES_TIMEZONE", "UTC"))
    now = datetime.now(tz)
    empty_stats = {"when": now.strftime("%A %d %B %Y"), "edition": now.strftime("%H:%M"), "stories": 0,
                   "sections": len(SECTIONS), "sources": 0, "scanned": 0, "model": "-", "blocked": 0,
                   "not_article": 0, "seen": 0, "duplicate": 0, "widened": [], "web_usage": "n/a"}

    if args.test_email:
        test_html = build_html([], None, "SMTP test.", empty_stats)
        hc.send_email(f"{digest_title()}: SMTP test", test_html, "SMTP test.", digest_title(),
                      inline_images(test_html, ICON_DIR))
        print("Test email sent.")
        return 0

    try:
        host, model, num_ctx = connect_model("NEWS_DIGEST_MODEL")
    except RuntimeError as exc:
        log(str(exc))
        return 3
    try:
        web = WebClient(env_int("NEWS_DIGEST_MIN_CREDITS", 30))
    except RuntimeError as exc:
        log(str(exc))
        return 2

    seen_days = env_int("NEWS_DIGEST_SEEN_DAYS", 7)
    seen = {} if args.include_seen else load_seen(seen_days)
    per_section = env_int("NEWS_DIGEST_PER_SECTION", 5)
    candidates, gstats = gather(web, seen, env_int("NEWS_DIGEST_RESULTS_PER_QUERY", 10),
                                env_int("NEWS_DIGEST_MIN_CANDIDATES", 4), env("NEWS_DIGEST_COUNTRY"),
                                env_int("NEWS_DIGEST_MAX_CANDIDATES", 18))

    sections: list[tuple[dict, list[dict]]] = []
    for sec in SECTIONS:
        covered = [s["headline"] for _, st in sections for s in st]
        stories = curate_section(host, model, num_ctx, sec, candidates.get(sec["id"], []), per_section, covered,
                                 env_int("NEWS_DIGEST_MIN_IMPORTANCE", 5))
        log(f"{sec['title']}: {len(stories)} stories selected")
        sections.append((sec, stories))
    gstats["duplicate"] += dedupe_across(host, model, num_ctx, sections)

    all_stories = [s for _, st in sections for s in st]
    top = max(all_stories, key=lambda s: (s["importance"], s["curated"]), default=None)
    if top and env_bool("NEWS_DIGEST_SCRAPE_TOP", True):
        deepen_top_story(web, host, model, num_ctx, top)
    briefing = write_briefing(host, model, num_ctx, sections)

    stats = {**empty_stats, **gstats, "model": model, "stories": len(all_stories),
             "sections": sum(1 for _, st in sections if st),
             "sources": len({s["domain"] for s in all_stories}), "scanned": gstats["raw"],
             "web_usage": web.usage()}

    html_body = build_html(sections, top, briefing, stats)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    icons_rel = Path(os.path.relpath(ICON_DIR, STATE_DIR)).as_posix()
    LAST_REPORT.write_text(re.sub(r'src="cid:([\w-]+)"', rf'src="{icons_rel}/\1.png"', html_body), encoding="utf-8")
    LAST_RESULTS.write_text(json.dumps({"generated": now.isoformat(), "briefing": briefing,
                                        "top": top["url"] if top else None, "stats": stats,
                                        "sections": {sec["id"]: st for sec, st in sections}},
                                       indent=2, ensure_ascii=False), encoding="utf-8")

    if not all_stories and not env_bool("NEWS_DIGEST_EMAIL_WHEN_EMPTY", False):
        print(f"{digest_title()}: no stories found today; no email sent.")
        return 0
    subject = f"{digest_title()}: {len(all_stories)} stor{'y' if len(all_stories) == 1 else 'ies'}"

    if args.dry_run:
        print(f"[dry-run] {subject}\n[dry-run] {len(all_stories)} stories; HTML written to {LAST_REPORT}")
        print(build_text(sections, top, briefing))
        return 0

    try:
        hc.send_email(subject, html_body, build_text(sections, top, briefing), digest_title(),
                      inline_images(html_body, ICON_DIR))
    except (smtplib.SMTPException, OSError, RuntimeError) as exc:
        log(f"Email failed: {exc}")
        return 5

    stamp = datetime.now(timezone.utc).isoformat()
    seen = load_seen(seen_days)
    for s in all_stories:
        seen[normalize_url(s["url"])] = stamp
        seen["t:" + title_key(s["title"])] = stamp
    SEEN_FILE.write_text(json.dumps(seen, indent=1), encoding="utf-8")
    print(f"{digest_title()} sent: {len(all_stories)} stories across {stats['sections']} sections. {subject}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

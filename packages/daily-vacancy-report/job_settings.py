"""Job search settings edited on the feedback Worker's dashboard: the form fields, the .env keys behind them and
the searches derived from them.

profiles.py applies what the dashboard sends and reports the current values back, so the forms open prefilled.
The Worker checks the same limits before it queues anything.
"""
from __future__ import annotations

import re

from money import currency_code

LEVELS = ("junior", "mid", "senior", "lead", "any")
EMPLOYMENT_TYPES = ("Permanent", "Contract", "Temporary", "Part-time", "Internship")
WORK_MODES = ("On-site", "Hybrid", "Remote")
DEFAULT_TYPES = "Permanent,Contract,Temporary"
MAX_TITLES = 8
MAX_PLACES = 30

# Dashboard field -> setting.
FIELDS = {
    "region": "JOB_REGION_NAME",
    "places": "JOB_REGION_PLACES",
    "search_location": "JOB_SEARCH_LOCATION",
    "country": "JOB_SEARCH_COUNTRY",
    "remote_anywhere": "JOB_REMOTE_ANYWHERE",
    "level": "JOB_LEVEL",
    "types": "JOB_EMPLOYMENT_TYPES",
    "modes": "JOB_WORK_MODES",
    "min_salary": "JOB_MIN_SALARY",
    "currency": "JOB_SALARY_CURRENCY",
    "hide_agency": "JOB_HIDE_UNNAMED_AGENCY",
    "titles": "JOB_TARGET_TITLES",
}
# Worked out from the fields above whenever they change.
DERIVED = ("JOB_SCANNER_QUERIES", "JOB_TITLE_STRONG", "JOB_REGION_REGEX", "JOB_SCANNER_NIJOBS_KEYWORDS")
KEYS = tuple(FIELDS.values()) + DERIVED


def slug(text: str, sep: str = "-") -> str:
    return re.sub(r"[^a-z0-9]+", sep, text.lower()).strip(sep)


def term_regex(terms: list[str]) -> str:
    """Whole-term pattern (compile with re.I); C#, C++ and .NET keep their symbols."""
    terms = [t for t in dict.fromkeys(t.strip().lower() for t in terms) if t]
    return "|".join(("(?<![\\w+#])" if t[0].isalnum() else "") + re.escape(t) + "(?![\\w+#])" for t in terms)


def search_queries(titles: list[str], location: str, nijobs: bool, per_query: int = 2) -> list[str]:
    queries = []
    for i in range(0, min(len(titles), MAX_TITLES), per_query):
        group = " OR ".join(f'"{t}"' for t in titles[i:i + per_query])
        queries.append(f"({group})" + (f' "{location}"' if location else "") + " job"
                       + (" -site:nijobs.com" if nijobs else ""))
    return queries


def _split(value: str, sep: str) -> list[str]:
    return [p.strip() for p in (value or "").split(sep) if p.strip()]


def form_values(get) -> dict:
    """The dashboard form as it should open, from a getter over the current settings (get(key) -> str or None)."""
    def val(key: str, default: str = "") -> str:
        return (get(key) or "").strip() or default

    return {
        "region": val("JOB_REGION_NAME"),
        "places": _split(val("JOB_REGION_PLACES"), ","),
        "search_location": val("JOB_SEARCH_LOCATION"),
        "country": val("JOB_SEARCH_COUNTRY").lower(),
        "remote_anywhere": val("JOB_REMOTE_ANYWHERE", "0") == "1",
        "level": val("JOB_LEVEL", "any").lower(),
        "types": _split(val("JOB_EMPLOYMENT_TYPES", DEFAULT_TYPES), ","),
        "modes": _split(val("JOB_WORK_MODES", ",".join(WORK_MODES)), ","),
        "min_salary": val("JOB_MIN_SALARY", "0"),
        "currency": currency_code(val("JOB_SALARY_CURRENCY")),
        "hide_agency": val("JOB_HIDE_UNNAMED_AGENCY", "0") == "1",
        "titles": _split(val("JOB_TARGET_TITLES"), "||"),
    }


def _text(value, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _items(value, limit: int, max_len: int) -> list[str]:
    items = value if isinstance(value, list) else re.split(r"[\n,]", str(value or ""))
    return list(dict.fromkeys(t for t in (_text(v, max_len) for v in items) if t))[:limit]


def _salary(value) -> str:
    text = str(value or "0").lower().replace(",", "").replace(" ", "")
    m = re.fullmatch(r"(\d+(?:\.\d+)?)(k?)", text or "0")
    return str(int(float(m.group(1)) * (1000 if m.group(2) else 1))) if m else "0"


def clean_form(raw: dict) -> dict:
    """Validated form values; anything unknown is dropped."""
    country = _text(raw.get("country"), 2).lower()
    country = "gb" if country == "uk" else country if re.fullmatch(r"[a-z]{2}", country) else ""
    level = str(raw.get("level") or "any").lower()
    types = [t for t in EMPLOYMENT_TYPES if t in _items(raw.get("types"), 10, 20)]
    modes = [m for m in WORK_MODES if m in _items(raw.get("modes"), 5, 20)]
    return {
        "region": _text(raw.get("region"), 80),
        "places": _items(raw.get("places"), MAX_PLACES, 40),
        "search_location": _text(raw.get("search_location"), 80),
        "country": country,
        "remote_anywhere": raw.get("remote_anywhere") in (True, "1", "yes", "on"),
        "level": level if level in LEVELS else "any",
        "types": types or _split(DEFAULT_TYPES, ","),
        "modes": modes or list(WORK_MODES),
        "min_salary": _salary(raw.get("min_salary")),
        "currency": currency_code(_text(raw.get("currency"), 4)),
        "hide_agency": raw.get("hide_agency") in (True, "1", "yes", "on"),
        "titles": _items(raw.get("titles"), MAX_TITLES, 60),
    }


def env_updates(form: dict, get, title_keywords: list[str] = ()) -> dict[str, str]:
    """Settings to store for a cleaned form ("" clears a setting). Searches and the title filter are rebuilt only
    when the titles or the location change, so hand-tuned values survive other edits."""
    before = form_values(get)
    updates = {
        "JOB_REGION_NAME": form["region"],
        "JOB_REGION_PLACES": ", ".join(form["places"]),
        "JOB_SEARCH_LOCATION": form["search_location"],
        "JOB_SEARCH_COUNTRY": form["country"],
        "JOB_REMOTE_ANYWHERE": "1" if form["remote_anywhere"] else "0",
        "JOB_LEVEL": form["level"],
        "JOB_EMPLOYMENT_TYPES": ",".join(form["types"]),
        "JOB_WORK_MODES": ",".join(form["modes"]),
        "JOB_MIN_SALARY": form["min_salary"],
        "JOB_SALARY_CURRENCY": form["currency"],
        "JOB_HIDE_UNNAMED_AGENCY": "1" if form["hide_agency"] else "0",
        "JOB_TARGET_TITLES": "||".join(form["titles"]),
    }
    if (form["region"], form["places"]) != (before["region"], before["places"]):
        updates["JOB_REGION_REGEX"] = ""
    location = form["search_location"] or form["region"]
    if (form["titles"], location) != (before["titles"], before["search_location"] or before["region"]):
        nijobs = bool((get("JOB_SCANNER_NIJOBS_KEYWORDS") or "").strip())
        updates["JOB_SCANNER_QUERIES"] = "||".join(search_queries(form["titles"], location, nijobs))
        updates["JOB_TITLE_STRONG"] = term_regex([*title_keywords, *form["titles"]]) if form["titles"] else ""
        if nijobs and form["titles"]:
            updates["JOB_SCANNER_NIJOBS_KEYWORDS"] = ",".join(slug(t) for t in form["titles"])
    return updates

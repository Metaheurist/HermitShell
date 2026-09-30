"""Salary currencies: the ones a profile can pick, the symbols adverts use for them, and conversion between them
at the day's exchange rates.

Rates come from JOB_FX_URL (default: Frankfurter, the European Central Bank's daily reference rates, no key
needed) and are kept in the state folder for a day. Without rates nothing is converted: salaries show as
advertised and the minimum salary only applies to jobs in the profile's own currency.
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import requests

# Code -> (symbol, name). Only currencies whose yearly salaries are tens of thousands, which parse_salary reads.
CURRENCIES = {
    "GBP": ("£", "Pound sterling"),
    "EUR": ("€", "Euro"),
    "USD": ("$", "US dollar"),
    "CAD": ("C$", "Canadian dollar"),
    "AUD": ("A$", "Australian dollar"),
    "NZD": ("NZ$", "New Zealand dollar"),
}
# What adverts write -> code. A bare "$" depends on the profile (advert_code).
SYMBOLS = {"£": "GBP", "€": "EUR", "US$": "USD", "C$": "CAD", "CA$": "CAD", "A$": "AUD", "AU$": "AUD", "NZ$": "NZD"}
EURO_COUNTRIES = {"at", "be", "cy", "de", "ee", "es", "fi", "fr", "gr", "hr", "ie", "it", "lt", "lu", "lv", "mt",
                  "nl", "pt", "si", "sk"}
COUNTRY_CURRENCY = {"gb": "GBP", "uk": "GBP", "us": "USD", "ca": "CAD", "au": "AUD", "nz": "NZD",
                    **{c: "EUR" for c in EURO_COUNTRIES}}
DOLLARS = {"USD", "CAD", "AUD", "NZD"}
# Salary icons (icons/<name>.png): the currency's symbol in a badge, else a banknote.
ICONS = {"GBP": "icon-salary-gbp", "EUR": "icon-salary-eur", **{c: "icon-salary-usd" for c in DOLLARS}}
PLAIN_ICON = "icon-salary"

FX_URL = "https://api.frankfurter.dev/v1/latest"
FX_FILE = "fx_rates.json"
FX_MAX_AGE = 24 * 3600
FX_STALE = 30 * 24 * 3600  # older rates are still used when a refresh fails, up to this age
FX_RETRY = 3600  # after a failed refresh
FX_MAX_BYTES = 64 * 1024
OFF = ("", "off", "0", "none", "no")


def currency_code(value) -> str:
    """'GBP', 'gbp' or '£' -> 'GBP'; '$' -> 'USD'; anything else -> '' (salaries as advertised)."""
    text = str(value or "").strip().upper()
    if text in CURRENCIES:
        return text
    return "USD" if text == "$" else SYMBOLS.get(text, "")


def symbol(code: str) -> str:
    return CURRENCIES.get(code, ("",))[0]


def icon(code: str) -> str:
    return ICONS.get(code, PLAIN_ICON)


def advert_code(found: str, own: str = "", country: str = "") -> str:
    """The currency of an advert that wrote `found` ('£', '$', 'C$' or nothing). A bare '$' is the profile's
    dollar, else the search country's, else US dollars; no symbol means the search country's currency."""
    if found in SYMBOLS:
        return SYMBOLS[found]
    local = COUNTRY_CURRENCY.get((country or "").strip().lower(), "")
    if found == "$":
        return own if own in DOLLARS else local if local in DOLLARS else "USD"
    return local or own


def amount(value: float, sign: str) -> str:
    return f"{sign}{value:,.2f}" if value % 1 else f"{sign}{value:,.0f}"


def convert(value: float, src: str, dst: str, rates: dict[str, float]) -> float | None:
    if src == dst:
        return value
    if src not in rates or dst not in rates:
        return None
    return value * rates[dst] / rates[src]


def _round(value: float, period: str) -> float:
    if period == "year":
        return round(value / 100) * 100
    return round(value) if period == "day" else round(value, 2)


def shown_salary(parsed: dict | None, own: str, rates: dict[str, float], country: str = "") -> dict | None:
    """parse_salary's result in the profile's currency `own`, with the advertised figures under "original";
    as advertised (with its "code") when `own` is empty, already matches or has no rate."""
    if not parsed:
        return parsed
    code = advert_code(parsed.get("currency", ""), own, country)
    out = {**parsed, "code": code, "currency": parsed.get("currency") or symbol(code)}
    if not own or not code or code == own:
        return out
    low, high = convert(parsed["low"], code, own, rates), convert(parsed["high"], code, own, rates)
    if low is None or high is None:
        return out
    period = parsed["period"]
    low, high = _round(low, period), _round(high, period)
    scale = convert(1.0, code, own, rates)
    was = symbol(code) if out["currency"] == "$" else out["currency"]
    return {"low": low, "high": high, "period": period, "currency": symbol(own), "code": own,
            "year_low": _round(parsed["year_low"] * scale, "year"), "year_high": _round(parsed["year_high"] * scale, "year"),
            "original": {"low": parsed["low"], "high": parsed["high"], "period": period, "currency": was}}


# --------------------------------------------------------------------------- exchange rates

def clean_rates(data) -> dict[str, float]:
    """{code: units per base unit} for the currencies above, from a Frankfurter-style reply ({"base", "rates"});
    empty unless at least two are usable."""
    if not isinstance(data, dict) or not isinstance(data.get("rates"), dict):
        return {}
    found = {str(data.get("base") or "").upper(): 1.0, **data["rates"]}
    out = {}
    for code in CURRENCIES:
        value = found.get(code)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) \
                and 1e-4 < value < 1e4:
            out[code] = float(value)
    return out if len(out) >= 2 else {}


def fetch_rates(url: str) -> dict[str, float]:
    if not url.lower().startswith("https://"):
        return {}
    try:
        reply = requests.get(url, timeout=10, headers={"Accept": "application/json"}, allow_redirects=False)
        reply.raise_for_status()
        if len(reply.content) > FX_MAX_BYTES:
            return {}
        return clean_rates(reply.json())
    except (requests.RequestException, ValueError):
        return {}


def _read_cache(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    number = lambda v: float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else 0.0  # noqa: E731
    return {"at": number(data.get("at")), "failed": number(data.get("failed")), "rates": clean_rates(
        {"base": "", "rates": data.get("rates")})}


def rates(state_dir: Path, url: str | None = FX_URL, now: float | None = None) -> dict[str, float]:
    """Today's rates: from the cache in `state_dir` when under a day old, else fetched from `url` (and cached);
    older cached rates when that fails; {} when conversion is off (url empty or "off") or nothing is known."""
    url = (url or "").strip()
    if url.lower() in OFF:
        return {}
    now = now or time.time()
    path = Path(state_dir) / FX_FILE
    cached = _read_cache(path)
    known = cached.get("rates") or {}
    if known and now - cached["at"] < FX_MAX_AGE:
        return known
    if now - cached.get("failed", 0) < FX_RETRY:
        return known if now - cached["at"] < FX_STALE else {}
    fresh = fetch_rates(url)
    record = {"at": now, "rates": fresh} if fresh else {**cached, "failed": now}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(record), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass
    if fresh:
        return fresh
    return known if known and now - cached["at"] < FX_STALE else {}

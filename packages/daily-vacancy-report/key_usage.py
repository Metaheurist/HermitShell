#!/usr/bin/env python3
"""How much of each web search and cloud model key's allowance is left, for the dashboard's Global settings.

check() asks the provider's own account endpoint, which spends no credits: Firecrawl's credit usage, Tavily's
usage and Scrapfly's account, and for the models OpenRouter's key, BazaarLink's credits, Featherless' plan and
Hugging Face's account. report() does it for every key at most every WEB_KEY_USAGE_MINUTES (60 by
default; 0 turns it off), and keeps the answers in state/key_usage.json under a hash of each key, never the key.
A failed check is tried again after RETRY seconds. Only HTTPS is used, redirects are not followed and replies over
MAX_BYTES are ignored.

    python3 key_usage.py      # print the usage of the configured keys (masked)
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

import hermes_common as hc
import llm_providers

FIRECRAWL_USAGE = "https://api.firecrawl.dev/v2/team/credit-usage"
TAVILY_USAGE = "https://api.tavily.com/usage"
SCRAPFLY_ACCOUNT = "https://api.scrapfly.io/account"
OPENROUTER_KEY = "https://openrouter.ai/api/v1/key"
BAZAARLINK_CREDITS = "https://api.bazaarlink.ai/v1/credits"
FEATHERLESS_PLAN = "https://api.featherless.ai/v1/plan"
HUGGINGFACE_WHOAMI = "https://huggingface.co/api/whoami-v2"
UNITS = ("credits", "requests", "usd", "plan")
USAGE_FILE = "key_usage.json"
EVERY_MINUTES = 60
MAX_MINUTES = 1440
RETRY = 900
TIMEOUT = 8
MAX_BYTES = 64 * 1024
MAX_PLAN = 40
MAX_ERROR = 80
MAX_ENTRIES = 50
PROVIDERS = ("firecrawl", "tavily", "scrapfly")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


class UsageError(Exception):
    """The provider did not say how much is left; the message is shown on the dashboard."""


def _count(value, unit: str = "credits") -> int | float | None:
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return round(float(value), 2) if unit == "usd" else int(value)


def _day(value) -> str:
    text = str(value or "")[:10]
    return text if _DAY.fullmatch(text) else ""


def _plan(value) -> str:
    return " ".join(re.sub(r"[^\w .+()-]", "", str(value or "")).split())[:MAX_PLAN]


def usage(used=None, limit=None, left=None, plan="", resets="", unit="credits") -> dict:
    """Credits used, the allowance and what is left (each worked out from the other two when missing), the plan's
    name, when the allowance resets and what is counted: credits, requests, usd (dollars, to the cent) or plan
    (only the plan's name is known)."""
    unit = unit if unit in UNITS else "credits"
    used, limit, left = _count(used, unit), _count(limit, unit), _count(left, unit)
    if left is None and used is not None and limit is not None:
        left = max(round(limit - used, 2), 0)
    if used is None and left is not None and limit is not None:
        used = max(round(limit - left, 2), 0)
    if left is None and used is None and not (unit == "plan" and _plan(plan)):
        raise UsageError("no usage in the reply")
    return {"used": used, "limit": limit, "left": left, "plan": _plan(plan), "resets": _day(resets), "unit": unit}


def _get(url: str, headers: dict | None = None, params: dict | None = None) -> dict:
    try:
        reply = requests.get(url, headers={"Accept": "application/json", **(headers or {})}, params=params,
                             timeout=TIMEOUT, allow_redirects=False)
    except requests.RequestException as exc:
        raise UsageError("could not reach it") from exc
    if reply.status_code in (401, 403):
        raise UsageError("the key was rejected")
    if reply.status_code == 429:
        raise UsageError("too many checks; tried again later")
    if not reply.ok:
        raise UsageError(f"HTTP {reply.status_code}")
    if len(reply.content) > MAX_BYTES:
        raise UsageError("the reply was too large")
    try:
        body = reply.json()
    except ValueError as exc:
        raise UsageError("the reply could not be read") from exc
    if not isinstance(body, dict):
        raise UsageError("the reply could not be read")
    return body


def _part(data, name: str) -> dict:
    value = data.get(name) if isinstance(data, dict) else None
    return value if isinstance(value, dict) else {}


def check(provider: str, key: str) -> dict:
    """The key's usage now, from the provider; UsageError when it can't be had."""
    if provider == "firecrawl":
        data = _part(_get(FIRECRAWL_USAGE, {"Authorization": f"Bearer {key}"}), "data")
        return usage(limit=data.get("planCredits"), left=data.get("remainingCredits"), resets=data.get("billingPeriodEnd"))
    if provider == "tavily":
        body = _get(TAVILY_USAGE, {"Authorization": f"Bearer {key}"})
        own, account = _part(body, "key"), _part(body, "account")
        if _count(own.get("limit")):
            return usage(own.get("usage"), own.get("limit"), plan=account.get("current_plan"))
        return usage(account.get("plan_usage"), account.get("plan_limit"), plan=account.get("current_plan"))
    if provider == "scrapfly":
        sub = _part(_get(SCRAPFLY_ACCOUNT, params={"key": key}), "subscription")
        scrape = _part(_part(sub, "usage"), "scrape")
        return usage(scrape.get("current"), scrape.get("limit"), scrape.get("remaining"), sub.get("plan_name"),
                     _part(sub, "period").get("end"))
    return check_model(provider, key)


def _tomorrow() -> str:
    return datetime.fromtimestamp(time.time() + 86400, timezone.utc).strftime("%Y-%m-%d")


def check_model(provider: str, key: str) -> dict:
    """A cloud model key's usage: free requests left today (OpenRouter's free models), dollars left (OpenRouter,
    BazaarLink) or only the plan (Featherless, Hugging Face)."""
    auth = {"Authorization": f"Bearer {key}"}
    if provider == "openrouter":
        data = _part(_get(OPENROUTER_KEY, auth), "data")
        free, model = _part(data, "free_model_daily_requests"), llm_providers.model("openrouter")
        if (model.endswith(":free") or model == "openrouter/free") and _count(free.get("limit")):
            return usage(free.get("used"), free.get("limit"), free.get("remaining"), "Free models", _tomorrow(), "requests")
        plan = "Free tier" if data.get("is_free_tier") is True else "Credits"
        return usage(data.get("usage"), data.get("limit"), data.get("limit_remaining"), plan, unit="usd")
    if provider == "bazaarlink":
        data = _part(_get(BAZAARLINK_CREDITS, auth), "data")
        return usage(data.get("total_usage"), data.get("total_credits"), plan="Credits", unit="usd")
    if provider == "featherless":
        body = _get(FEATHERLESS_PLAN, auth)
        return usage(plan=body.get("name") or body.get("id"), unit="plan")
    if provider == "huggingface":
        body = _get(HUGGINGFACE_WHOAMI, auth)
        return usage(plan="PRO" if body.get("isPro") is True else "Free", unit="plan")
    raise UsageError("unknown provider")


def _tag(provider: str, key: str) -> str:
    return f"{provider}:{hashlib.sha256(f'key-usage{chr(10)}{key}'.encode()).hexdigest()[:24]}"


def _clean_entry(entry) -> dict | None:
    if not isinstance(entry, dict):
        return None
    at = entry.get("at")
    if isinstance(at, bool) or not isinstance(at, (int, float)) or not math.isfinite(at) or at <= 0:
        return None
    if isinstance(entry.get("error"), str):
        return {"at": float(at), "error": entry["error"][:MAX_ERROR]}
    found = entry.get("usage")
    if not isinstance(found, dict):
        return None
    try:
        return {"at": float(at), "usage": usage(found.get("used"), found.get("limit"), found.get("left"),
                                                 found.get("plan"), found.get("resets"), found.get("unit") or "credits")}
    except UsageError:
        return None


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: e for k, e in ((k, _clean_entry(v)) for k, v in data.items() if isinstance(k, str)) if e}


def minutes(value) -> int:
    """WEB_KEY_USAGE_MINUTES as a number of minutes (0 to 1440); anything else is the default."""
    try:
        return max(0, min(int(str(value).strip()), MAX_MINUTES))
    except ValueError:
        return EVERY_MINUTES


def report(keys: dict[str, list[str]], state_dir: Path, every: int = EVERY_MINUTES, now: float | None = None,
           ) -> dict[str, list[dict]]:
    """Each provider's keys in order, as {hint, role ("main" or "backup")} with, unless `every` is 0, the usage or
    error and when it was checked (ms). Keys checked in the last `every` minutes come from the cache."""
    now = now or time.time()
    path = state_dir / USAGE_FILE
    cache = _read(path) if every else {}
    kept, changed, out = {}, False, {}
    for provider, values in keys.items():
        rows = []
        for i, key in enumerate(values):
            row = {"hint": hc.mask_secret(key), "role": "main" if i == 0 else "backup"}
            if every:
                tag = _tag(provider, key)
                entry = cache.get(tag)
                age = now - entry["at"] if entry else -1
                if entry is None or age < 0 or age >= (RETRY if "error" in entry else every * 60):
                    try:
                        entry = {"at": now, "usage": check(provider, key)}
                    except UsageError as exc:
                        entry = {"at": now, "error": str(exc)[:MAX_ERROR]}
                    changed = True
                kept[tag] = entry
                row |= {k: entry[k] for k in ("usage", "error") if k in entry} | {"at": int(entry["at"] * 1000)}
            rows.append(row)
        out[provider] = rows
    if every and (changed or kept.keys() != cache.keys()):
        hc.write_atomic(path, json.dumps(dict(list(kept.items())[:MAX_ENTRIES])), private=True)
    return out


def configured_keys() -> dict[str, list[str]]:
    """The web search keys in use, in the order they are tried: Firecrawl's main key then its backups."""
    return {"firecrawl": hc.firecrawl_keys(), "tavily": [k for k in [hc.env("TAVILY_API_KEY")] if k],
            "scrapfly": [k for k in [hc.env("SCRAPFLY_API_KEY")] if k]}


def model_keys() -> dict[str, list[str]]:
    """The cloud model keys, one per provider, in the order they are tried."""
    return {n: [llm_providers.key(n)] for n in llm_providers.configured()}


def main() -> int:
    hc.load_env_file()
    every = minutes(hc.env("WEB_KEY_USAGE_MINUTES", str(EVERY_MINUTES))) or 1
    for provider, rows in (report(configured_keys(), hc.STATE_DIR, every) | report(model_keys(), hc.STATE_DIR, every)).items():
        for row in rows:
            u = row.get("usage") or {}
            left = (u.get("plan") if u.get("unit") == "plan" else f"{u.get('left')} of {u.get('limit')} {u.get('unit')} left") \
                if u else row.get("error", "not checked")
            print(f"{provider:11} {row['role']:6} {row['hint']:12} {left}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

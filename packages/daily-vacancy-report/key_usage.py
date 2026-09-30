#!/usr/bin/env python3
"""How much of each web search key's allowance is left, for the dashboard's Global settings.

check() asks the provider's own account endpoint, which spends no search credits: Firecrawl's credit usage,
Tavily's usage and Scrapfly's account. report() does it for every key at most every WEB_KEY_USAGE_MINUTES (60 by
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
from pathlib import Path

import requests

import hermes_common as hc

FIRECRAWL_USAGE = "https://api.firecrawl.dev/v2/team/credit-usage"
TAVILY_USAGE = "https://api.tavily.com/usage"
SCRAPFLY_ACCOUNT = "https://api.scrapfly.io/account"
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


def _count(value) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return int(value)


def _day(value) -> str:
    text = str(value or "")[:10]
    return text if _DAY.fullmatch(text) else ""


def _plan(value) -> str:
    return " ".join(re.sub(r"[^\w .+()-]", "", str(value or "")).split())[:MAX_PLAN]


def usage(used=None, limit=None, left=None, plan="", resets="") -> dict:
    """Credits used, the allowance and what is left (each worked out from the other two when missing), the plan's
    name and when the allowance resets."""
    used, limit, left = _count(used), _count(limit), _count(left)
    if left is None and used is not None and limit is not None:
        left = max(limit - used, 0)
    if used is None and left is not None and limit is not None:
        used = max(limit - left, 0)
    if left is None and used is None:
        raise UsageError("no usage in the reply")
    return {"used": used, "limit": limit, "left": left, "plan": _plan(plan), "resets": _day(resets)}


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
                                                 found.get("plan"), found.get("resets"))}
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


def main() -> int:
    hc.load_env_file()
    found = report(configured_keys(), hc.STATE_DIR, minutes(hc.env("WEB_KEY_USAGE_MINUTES", str(EVERY_MINUTES))) or 1)
    for provider, rows in found.items():
        for row in rows:
            u = row.get("usage") or {}
            left = f"{u.get('left')} of {u.get('limit')} left" if u else row.get("error", "not checked")
            print(f"{provider:9} {row['role']:6} {row['hint']:12} {left}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

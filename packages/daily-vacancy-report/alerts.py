#!/usr/bin/env python3
"""Admin alerts by email: credits running low, a cloud model out of credits or with its key rejected, Ollama not
answering, backups failing or stopping, the disk filling up and a feedback Worker that doesn't match HermitShell.

The profiles job (profiles.py, every 5 minutes) runs the checks at most every EVERY seconds. Each alert is emailed
when it starts and again at most once a day while it lasts, and one "all clear" follows when it ends; everything
found in one run goes into one email to the admin (send_owner). Emails name providers and percentages, never a
key. What is open is kept in state/alerts.json.

Settings: HERMES_ALERTS (on), ALERT_CREDITS_BELOW_PCT (10) and ALERT_DISK_BELOW_PCT (10).

    python3 alerts.py           check now and email what changed
    python3 alerts.py --test    email a test alert to the admin
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time

import hermes_common as hc
import key_usage
import llm_providers
import profiles
import worker_link
from hermes_common import env, env_int, log

STATE_DIR = hc.STATE_DIR
STATE_FILE = "alerts.json"
BACKUP_FILE = "backup.json"
EVERY = 15 * 60
AGAIN = 86400
OLLAMA_AFTER = 30 * 60
PROTOCOL_AFTER = 30 * 60
BACKUP_STALE = 36 * 3600
PROBE_TIMEOUT = 3
MAX_TEXT = 160
WEB_LABELS = {"firecrawl": "Firecrawl", "tavily": "Tavily", "scrapfly": "Scrapfly"}
UNIT_WORDS = {"credits": "credits", "requests": "free requests today", "usd": "credit"}
RESTING = ("out of credits", "key rejected")


def _pct(name: str) -> int:
    return max(0, min(env_int(name, 10), 100))


def _label(provider: str) -> str:
    return WEB_LABELS.get(provider) or llm_providers.PROVIDERS.get(provider, {}).get("label") or provider


def credits(state_dir) -> dict[str, str]:
    """Each key with less than ALERT_CREDITS_BELOW_PCT of its allowance left, from the usage checks Global settings
    shows (none when WEB_KEY_USAGE_MINUTES is 0). A percentage, since providers count in different units."""
    every = key_usage.minutes(env("WEB_KEY_USAGE_MINUTES", str(key_usage.EVERY_MINUTES)))
    if not every:
        return {}
    below = _pct("ALERT_CREDITS_BELOW_PCT")
    found = {}
    reports = key_usage.report(key_usage.configured_keys(), state_dir, every) | \
        key_usage.report(key_usage.model_keys(), state_dir, every)
    for provider, rows in reports.items():
        for i, row in enumerate(rows):
            u = row.get("usage") or {}
            if u.get("unit") not in UNIT_WORDS or not u.get("limit") or u.get("left") is None:
                continue
            left = 100 * u["left"] / u["limit"]
            if left < below:
                which = "" if len(rows) == 1 else " main key" if i == 0 else f" backup key {i}"
                found[f"credits:{provider}:{i}"] = f"{_label(provider)}{which}: {left:.0f}% of its {UNIT_WORDS[u['unit']]} left"
    return found


def resting() -> dict[str, str]:
    """Cloud model providers resting because they are out of credits or their key was rejected."""
    found = {}
    for name, p in llm_providers.summary()["providers"].items():
        if p.get("resting_until") and p.get("why") in RESTING:
            found[f"resting:{name}"] = f"{_label(name)} is not being used: {p['why']}"
    return found


def _answers(host: str) -> bool:
    try:
        return hc.requests.get(f"{host}/api/tags", timeout=PROBE_TIMEOUT).ok
    except hc.requests.RequestException:
        return False


def ollama(state: dict, now: float) -> dict[str, str]:
    """Ollama not answering for OLLAMA_AFTER, once it has answered before or when there is no cloud model to
    fall back on (so a server that never used Ollama isn't told about it every day)."""
    seen = state.setdefault("ollama", {"down_since": 0, "seen": False})
    if any(_answers(h) for h in hc.ollama_hosts(hc.model_config())):
        seen.update(down_since=0, seen=True)
        return {}
    seen["down_since"] = seen.get("down_since") or now
    if (seen.get("seen") or not llm_providers.configured()) and now - seen["down_since"] >= OLLAMA_AFTER:
        return {"ollama": "Ollama has not answered for over 30 minutes"}
    return {}


def backup(state_dir, now: float) -> dict[str, str]:
    """The last backup failed, or none has been made for BACKUP_STALE."""
    import maintenance
    try:
        info = json.loads((state_dir / BACKUP_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        info = {}
    info = info if isinstance(info, dict) else {}
    if isinstance(info.get("error"), str) and info["error"]:
        return {"backup": f"The last backup failed: {info['error'][:80]}"}
    newest = maintenance.list_backups()
    if newest:
        hours = int((now - maintenance.stamp_of(newest[0]).timestamp()) // 3600)
        return {"backup": f"No backup for {hours} hours"} if hours * 3600 >= BACKUP_STALE else {}
    return {"backup": "No backup has been made yet"} if info else {}


def disk(state_dir) -> dict[str, str]:
    try:
        usage = shutil.disk_usage(state_dir if state_dir.is_dir() else hc.APP_HOME)
    except OSError:
        return {}
    free = 100 * usage.free / usage.total if usage.total else 100
    if free < _pct("ALERT_DISK_BELOW_PCT"):
        return {"disk": f"Only {free:.0f}% of the disk is free ({usage.free / 2**30:.1f} GB)"}
    return {}


def protocol(now: float) -> dict[str, str]:
    """A Worker answering with another protocol than HermitShell's for PROTOCOL_AFTER."""
    seen = worker_link.worker_protocol()
    value = seen.get("protocol")
    if value is None or value == worker_link.PROTOCOL or now - (seen.get("at") or now) < PROTOCOL_AFTER:
        return {}
    return {"protocol": "The feedback Worker is older than HermitShell: redeploy it" if value < worker_link.PROTOCOL
            else "HermitShell is older than its feedback Worker: update it"}


def checks(state: dict, now: float) -> dict[str, str]:
    """Every alert that is open now, by key; one failing check doesn't stop the others."""
    found: dict[str, str] = {}
    for name, check in (("credits", lambda: credits(STATE_DIR)), ("resting", resting),
                        ("ollama", lambda: ollama(state, now)), ("backup", lambda: backup(STATE_DIR, now)),
                        ("disk", lambda: disk(STATE_DIR)), ("protocol", lambda: protocol(now))):
        try:
            found |= check()
        except Exception as exc:  # an alert check must never stop the profiles job
            log(f"Alerts: the {name} check failed ({exc.__class__.__name__})")
    return {k: v[:MAX_TEXT] for k, v in found.items()}


def _load(path) -> dict:
    try:
        data = json.loads(hc.read_private_text(path))
    except (OSError, ValueError, hc.DataKeyError):
        data = {}
    data = data if isinstance(data, dict) else {}
    opened = data.get("open") if isinstance(data.get("open"), dict) else {}
    return {"at": float(data.get("at") or 0), "ollama": data.get("ollama") if isinstance(data.get("ollama"), dict) else {},
            "open": {str(k): v for k, v in opened.items() if isinstance(v, dict)}}


def email(new: list[str], again: list[str], cleared: list[str]) -> None:
    lines = []
    if new or again:
        lines += ["This needs a look:" if len(new) + len(again) == 1 else "These need a look:",
                  *new, *(f"{t} (still)" for t in again)]
    if cleared:
        lines += ["All clear now:", *cleared]
    count = len(new) + len(again)
    subject = (new or again)[0] if count == 1 else f"{count} alerts" if count else "All clear"
    profiles.send_owner(subject, lines, action=("/admin/settings", "Open Global settings"))


def run(now: float | None = None, force: bool = False) -> list[str]:
    """Check, email what started, is still open after a day or has cleared, and return those lines."""
    now = now or time.time()
    path = STATE_DIR / STATE_FILE
    with hc.file_lock(path):
        state = _load(path)
        if not force and 0 <= now - state["at"] < EVERY:
            return []
        found = checks(state, now)
        opened = {k: dict(v) for k, v in state["open"].items()}
        new, again = [], []
        for key, text in found.items():
            entry = opened.get(key)
            if entry is None:
                new.append(text)
                opened[key] = {"since": now, "sent": now, "text": text}
            else:
                if now - float(entry.get("sent") or 0) >= AGAIN:
                    again.append(text)
                    entry["sent"] = now
                entry["text"] = text
        cleared = [str(opened.pop(k).get("text") or k)[:MAX_TEXT] for k in list(opened) if k not in found]
        state["at"] = now
        if new or again or cleared:
            try:
                email(new, again, cleared)
            except Exception as exc:  # unsent: try again next run, with the alerts still counted as new
                log(f"Alerts: email not sent ({exc.__class__.__name__})")
                hc.write_private(path, json.dumps(state))
                return []
        state["open"] = opened
        hc.write_private(path, json.dumps(state))
    if new or again or cleared:
        log(f"Alerts: {len(new)} new, {len(again)} still open, {len(cleared)} cleared")
    return [*new, *(f"{t} (still)" for t in again), *(f"cleared: {t}" for t in cleared)]


def maybe_run() -> None:
    """From the profiles job: the checks when HERMES_ALERTS is on, never raising."""
    if not hc.env_bool("HERMES_ALERTS", True):
        return
    try:
        run()
    except Exception as exc:  # alerts must never stop the profiles job
        log(f"Alerts failed: {exc.__class__.__name__}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--test", action="store_true", help="email a test alert to the admin")
    args = parser.parse_args(argv)
    hc.load_env_file()
    if args.test:
        profiles.send_owner("Test alert", ["This is a test of HermitShell's admin alerts. Nothing needs a look."],
                            action=("/admin/settings", "Open Global settings"))
        print("Test alert sent.")
        return 0
    for line in run(force=True):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())

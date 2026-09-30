#!/usr/bin/env python3
"""Cloud AI models, for servers that can't run Ollama: OpenRouter, BazaarLink, Featherless and Hugging Face.

Each speaks the OpenAI chat completions API. With a key set (OPENROUTER_API_KEY, BAZAARLINK_API_KEY,
FEATHERLESS_API_KEY or HUGGINGFACE_API_KEY, in .env or on the dashboard's Global settings),
hermes_common.ollama_chat tries them in LLM_PROVIDERS order before the local Ollama; LLM_ORDER=local tries Ollama
first and the cloud only when it doesn't answer. A provider that is out of credits, over its limit or rejects its
key rests (until the next UTC day for a daily limit) and the next one is tried; with none left the request goes to
Ollama. Each provider's model is <NAME>_MODEL, else its default: OpenRouter's and BazaarLink's free routers,
a small open model on Featherless and the cheapest provider of an open model on Hugging Face.

What happened is kept in state/llm_providers.json (when each provider rests until and why, requests today and the
last model that answered), never a key or a prompt. Only HTTPS is used and redirects are not followed.

    python3 llm_providers.py          which providers are set, their models and whether they are resting
"""
from __future__ import annotations

import json
import math
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hermes_common as hc  # noqa: E402

requests = hc.requests

PROVIDERS = {
    "openrouter": {"label": "OpenRouter", "base": "https://openrouter.ai/api/v1", "model": "openrouter/free"},
    "bazaarlink": {"label": "BazaarLink", "base": "https://api.bazaarlink.ai/v1", "model": "auto:free"},
    "featherless": {"label": "Featherless", "base": "https://api.featherless.ai/v1", "model": "Qwen/Qwen2.5-7B-Instruct"},
    "huggingface": {"label": "Hugging Face", "base": "https://router.huggingface.co/v1",
                    "model": "openai/gpt-oss-20b:cheapest"},
}
STATE_FILE = "llm_providers.json"
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$")
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,200}$")
TIMEOUT = (10, 300)
MAX_BYTES = 2 * 1024 * 1024
MAX_WHY = 60
REJECTED_REST = 6 * 3600
DOWN_REST = 300
RATE_REST = 120
MAX_RATE_REST = 3600
LAST_EVERY = 60
_DAILY = re.compile(r"per[- ]?day|daily|free-models-per-day|quota", re.I)
_THINK = re.compile(r"<think>.*?</think>", re.S | re.I)
_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.I)


def key(name: str) -> str:
    value = (hc.env(f"{name.upper()}_API_KEY") or "").strip()
    return value if KEY_RE.match(value) else ""


def model(name: str) -> str:
    chosen = (hc.env(f"{name.upper()}_MODEL") or "").strip()
    return chosen if MODEL_RE.match(chosen) else PROVIDERS[name]["model"]


def order() -> list[str]:
    """Every provider in the order they are tried: LLM_PROVIDERS (comma-separated names), then the rest."""
    wanted = [n.strip().lower() for n in (hc.env("LLM_PROVIDERS") or "").split(",")]
    return list(dict.fromkeys([n for n in wanted if n in PROVIDERS] + list(PROVIDERS)))


def configured() -> list[str]:
    """The providers with a key, in the order they are tried."""
    return [n for n in order() if key(n)]


def local_first() -> bool:
    return (hc.env("LLM_ORDER") or "").strip().lower() == "local"


def _path() -> Path:
    return hc.STATE_DIR / STATE_FILE


def _finite(value, default: float = 0.0) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else default


def _entry(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    return {"rest_until": _finite(raw.get("rest_until")), "why": str(raw.get("why") or "")[:MAX_WHY],
            "day": str(raw.get("day") or "")[:10], "today": int(_finite(raw.get("today"))),
            "failed": int(_finite(raw.get("failed"))), "last_ok": _finite(raw.get("last_ok")),
            "last_model": str(raw.get("last_model") or "")[:120]}


def load() -> dict:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    data = data if isinstance(data, dict) else {}
    last = data.get("_last") if isinstance(data.get("_last"), dict) else {}
    out = {n: _entry(data.get(n)) for n in PROVIDERS}
    out["_last"] = {"provider": str(last.get("provider") or "")[:20], "model": str(last.get("model") or "")[:120],
                    "at": _finite(last.get("at"))}
    return out


def _save(state: dict) -> None:
    try:
        hc.write_atomic(_path(), json.dumps(state), private=True)
    except OSError as exc:
        hc.log(f"Could not save {STATE_FILE}: {exc.__class__.__name__}")


def _utc_day(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")


def next_utc_day(now: float) -> float:
    today = datetime.fromtimestamp(now, timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return (today + timedelta(days=1)).timestamp()


def resting(name: str, state: dict, now: float) -> bool:
    return state[name]["rest_until"] > now


def rest_for(status: int, text: str, retry_after: str, now: float) -> tuple[float, str]:
    """How long a provider rests after a failed request, and why (shown on the dashboard)."""
    if status == 402:
        return next_utc_day(now), "out of credits"
    if status in (401, 403):
        return now + REJECTED_REST, "key rejected"
    if status == 429:
        if _DAILY.search(text or ""):
            return next_utc_day(now), "daily limit reached"
        seconds = int(retry_after) if str(retry_after or "").isdigit() else RATE_REST
        return now + max(1, min(seconds, MAX_RATE_REST)), "rate limited"
    return now + DOWN_REST, "not answering" if status == 0 else f"HTTP {status}"


def _count(state: dict, name: str, now: float, ok: bool) -> None:
    e = state[name]
    if e["day"] != _utc_day(now):
        e.update(day=_utc_day(now), today=0, failed=0)
    e["today" if ok else "failed"] += 1


def extract_json(text: str) -> str:
    """The JSON object in a model's reply (fences and stray words around it dropped), re-serialised; "" if none."""
    text = _FENCE.sub("", text.strip())
    for candidate in (text, text[text.find("{"):text.rfind("}") + 1] if "{" in text else ""):
        try:
            value = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(value, dict):
            return json.dumps(value, ensure_ascii=False)
    return ""


def _body(name: str, system: str, user: str, fmt: dict | None, num_predict: int, schema_in_prompt: bool) -> dict:
    if fmt and schema_in_prompt:
        system = f"{system}\n\nReply with only a JSON object matching this JSON schema:\n{json.dumps(fmt)}"
    body = {"model": model(name), "temperature": 0,
            # Reasoning models spend part of the budget thinking before they answer.
            "max_tokens": max(num_predict * 3, num_predict + 2048),
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    if fmt and not schema_in_prompt:
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "reply", "strict": False, "schema": fmt}}
    return body


def _post(name: str, body: dict):
    headers = {"Authorization": f"Bearer {key(name)}", "Content-Type": "application/json", "Accept": "application/json"}
    if name == "openrouter":
        headers["X-Title"] = "HermitShell"
    return requests.post(f"{PROVIDERS[name]['base']}/chat/completions", json=body, headers=headers, timeout=TIMEOUT,
                         allow_redirects=False)


def _content(resp) -> str:
    if len(resp.content) > MAX_BYTES:
        return ""
    try:
        choice = (resp.json().get("choices") or [{}])[0]
        text = choice.get("message", {}).get("content")
    except (ValueError, AttributeError, IndexError, TypeError):
        return ""
    return _THINK.sub("", text).strip() if isinstance(text, str) else ""


def ask(name: str, system: str, user: str, fmt: dict | None, num_predict: int, state: dict, now: float) -> str:
    """One provider's answer, "" when it gave none (and it rests when the failure was the provider's)."""
    try:
        resp = _post(name, _body(name, system, user, fmt, num_predict, False))
        # Not every model behind a router supports structured output: ask again with the schema in the prompt.
        if fmt and resp.status_code in (400, 422):
            resp = _post(name, _body(name, system, user, fmt, num_predict, True))
    except requests.RequestException as exc:
        state[name]["rest_until"], state[name]["why"] = rest_for(0, "", "", now)
        _count(state, name, now, False)
        hc.log(f"{PROVIDERS[name]['label']} failed ({exc.__class__.__name__}); resting it for a few minutes")
        return ""
    if not resp.ok:
        until, why = rest_for(resp.status_code, resp.text[:2000], resp.headers.get("Retry-After", ""), now)
        if resp.status_code not in (400, 404, 422):
            state[name]["rest_until"], state[name]["why"] = until, why
        _count(state, name, now, False)
        hc.log(f"{PROVIDERS[name]['label']} answered HTTP {resp.status_code}"
               + (f"; resting it ({why})" if resp.status_code not in (400, 404, 422) else ""))
        return ""
    text = _content(resp)
    if fmt:
        text = extract_json(text)
    if not text:
        _count(state, name, now, False)
        hc.log(f"{PROVIDERS[name]['label']} gave no usable answer; trying the next model")
        return ""
    _count(state, name, now, True)
    state[name].update(last_ok=now, last_model=str((resp.json() or {}).get("model") or model(name))[:120])
    state["_last"] = {"provider": name, "model": state[name]["last_model"], "at": now}
    return text


def chat(system: str, user: str, fmt: dict | None = None, num_predict: int = 500) -> tuple[str, str, str] | None:
    """(reply, provider, model) from the first cloud provider that answers, or None when none did."""
    names = configured()
    if not names:
        return None
    now = time.time()
    state = load()
    try:
        for name in names:
            if resting(name, state, now):
                continue
            text = ask(name, system, user, fmt, num_predict, state, now)
            if text:
                return text, name, state[name]["last_model"]
        return None
    finally:
        _save(state)


def used_local(model_name: str) -> None:
    """Note that the local Ollama answered (for the dashboard), at most once a minute."""
    state = load()
    last, now = state["_last"], time.time()
    if last["provider"] == "ollama" and last["model"] == model_name and now - last["at"] < LAST_EVERY:
        return
    state["_last"] = {"provider": "ollama", "model": str(model_name)[:120], "at": now}
    _save(state)


def summary(now: float | None = None) -> dict:
    """What the dashboard shows: each provider's model, whether it is resting and why, and requests today."""
    now = time.time() if now is None else now
    state = load()
    today = _utc_day(now)
    out = {}
    for name in PROVIDERS:
        e = state[name]
        fresh = e["day"] == today
        out[name] = {"model": model(name), "resting_until": int(e["rest_until"] * 1000) if e["rest_until"] > now else None,
                     "why": e["why"] if e["rest_until"] > now else "", "today": e["today"] if fresh else 0,
                     "failed": e["failed"] if fresh else 0, "last_ok": int(e["last_ok"] * 1000) or None}
    last = state["_last"]
    return {"order": "local" if local_first() else "cloud", "providers": out,
            "last": {"provider": last["provider"], "model": last["model"], "at": int(last["at"] * 1000)} if last["at"] else None}


def main() -> int:
    hc.load_env_file()
    names = configured()
    if not names:
        print("No cloud model keys set; every request goes to the local Ollama.")
        return 0
    info = summary()
    print(f"Order: {'local Ollama first, then ' if local_first() else ''}{', '.join(PROVIDERS[n]['label'] for n in names)}"
          f"{'' if local_first() else ', then the local Ollama'}")
    for name in names:
        p = info["providers"][name]
        rest = f"resting ({p['why']})" if p["resting_until"] else "ready"
        print(f"{PROVIDERS[name]['label']:13} {p['model']:32} {rest}, {p['today']} today")
    return 0


if __name__ == "__main__":
    sys.exit(main())

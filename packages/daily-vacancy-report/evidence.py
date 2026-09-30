"""What a job asks for and where the CV shows it: the evidence map cover letters and tailored CVs are written from.

One model request per job lists the advert's main requirements, each with the fact from the CV that best shows it
and where in the CV it is, or nothing when the CV doesn't show it. The map is kept in state/evidence/ (encrypted
with a data key) until the CV or the advert changes, so a regenerated letter and the tailored CV for the same job
reuse it instead of reading the whole CV and advert again. Evidence with a figure the CV doesn't have is dropped.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import requests

import hermes_common as hc
from hermes_common import STATE_DIR, log, ollama_chat
from job_extras import compact_profile, trim_listing
from writing_checks import honest

EVIDENCE_DIR = STATE_DIR / "evidence"
MAX_ITEMS = 8
MAX_LISTING = 5000
KEEP_DAYS = 30
FIELDS = ("need", "evidence", "where")
LIMITS = {"need": 120, "evidence": 300, "where": 80}
SCHEMA = {
    "type": "object",
    "properties": {"requirements": {"type": "array", "maxItems": MAX_ITEMS, "items": {
        "type": "object", "properties": {k: {"type": "string"} for k in FIELDS}, "required": list(FIELDS)}}},
    "required": ["requirements"],
}
SYSTEM = ("You match a job's requirements to evidence in a candidate's CV. You only quote or closely paraphrase what "
          "the CV says: never invent employers, job titles, numbers, qualifications or skills. Output JSON only.")


def prompt(job: dict, cv: str, listing: str) -> str:
    where = " at ".join(p for p in (job.get("title"), job.get("employer") or job.get("company")) if p)
    return (f"CV:\n{cv}\n\nJOB: {where or 'see the advert'}\n\nADVERT:\n{listing or '(not available)'}\n\n"
            f"List the advert's main requirements, at most {MAX_ITEMS}, most important first, each as a short phrase. "
            "For each, give the strongest evidence from the CV in the CV's own words (a responsibility, project, tool "
            "or qualification, at most 30 words) and where it is (the role and employer, or Projects, Skills or "
            "Education). When the CV does not show a requirement, leave evidence and where empty.\n"
            'Return {"requirements": [{"need": "...", "evidence": "...", "where": "..."}]}.')


def _clean_item(item) -> dict | None:
    if not isinstance(item, dict):
        return None
    got = {k: " ".join(str(item.get(k) or "").split())[:LIMITS[k]] for k in FIELDS}
    return got if got["need"] else None


def clean(items, cv: str) -> list[dict]:
    """The model's list, trimmed, de-duplicated and with dishonest evidence emptied."""
    found, seen = [], set()
    for item in items if isinstance(items, list) else []:
        got = _clean_item(item)
        if not got or got["need"].lower() in seen:
            continue
        seen.add(got["need"].lower())
        if not got["evidence"] or not honest(f"{got['evidence']} {got['where']}", cv):
            got["evidence"] = got["where"] = ""
        found.append(got)
    return found[:MAX_ITEMS]


def shown(found: list[dict]) -> list[str]:
    """The requirements the CV has evidence for, which a letter should cover."""
    return [i["need"] for i in found if i["evidence"]]


def as_text(found: list[dict]) -> str:
    return "\n".join(f"- {i['need']}: " + (f"{i['evidence']} ({i['where']})" if i["where"] else i["evidence"])
                     if i["evidence"] else f"- {i['need']}: not shown in the CV" for i in found)


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _prune(folder: Path, now: float) -> None:
    for old in folder.glob("*.json"):
        try:
            if now - old.stat().st_mtime > KEEP_DAYS * 86400:
                old.unlink()
        except OSError:
            pass


def for_job(model_info, key: str, job: dict, cv: str, listing: str, folder: Path | None = None) -> list[dict]:
    """The job's evidence map, from the cache when the CV and advert are unchanged; [] when no model answers."""
    folder = folder or EVIDENCE_DIR
    cv, listing = compact_profile(cv), trim_listing(listing or "")[:MAX_LISTING]
    of = _digest(f"{cv}\n\0\n{listing}")
    path = folder / f"{_digest(key)[:32]}.json"
    try:
        cached = json.loads(hc.read_private_text(path))
    except (OSError, ValueError, hc.DataKeyError):
        cached = {}
    if isinstance(cached, dict) and cached.get("of") == of and isinstance(cached.get("map"), list):
        return [i for i in map(_clean_item, cached["map"]) if i]
    host, model, num_ctx = model_info
    try:
        reply = ollama_chat(host, model, SYSTEM, prompt(job, cv, listing), num_ctx, fmt=SCHEMA, num_predict=900,
                            task="evidence")
        found = clean(json.loads(reply).get("requirements"), cv)
    except (requests.RequestException, ValueError, AttributeError) as exc:
        log(f"could not map the job's requirements to the CV ({exc.__class__.__name__}); writing without it")
        return []
    try:
        folder.mkdir(parents=True, exist_ok=True)
        _prune(folder, time.time())
        hc.write_private(path, json.dumps({"of": of, "map": found}))
    except OSError as exc:
        log(f"could not keep the evidence map: {exc.__class__.__name__}")
    return found

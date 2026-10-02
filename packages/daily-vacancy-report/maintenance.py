#!/usr/bin/env python3
"""Daily Vacancy Report maintenance: data retention, encryption at rest, file permissions and encrypted backups.

Runs nightly (the setup wizard schedules it as vacancy-maintenance), for the owner and every extra profile:
1. Retention: tracker jobs with no sighting, answer or letter for HERMES_RETENTION_DAYS (default 365), older
   cover letters and tailored CVs, and logs and scheduled-job output older than HERMES_LOG_RETENTION_DAYS
   (default 90) are deleted. 0 turns either off.
2. Encryption: with HERMES_DATA_KEY set, profile files, CVs and letters saved before it was set are encrypted.
3. Permissions: everything under state/ becomes readable by HermitShell's account only (files 0600, folders 0700).
4. Backup: .env, the scheduler's jobs (cron/) and this scripts folder with its state go into
   one archive, encrypted with HERMES_DATA_KEY (AES-256-GCM), in HERMES_BACKUP_DIR (default
   <HermitShell home>/backups/nightly). The newest HERMES_BACKUP_KEEP_DAILY (14) are kept, plus the newest of each week
   for HERMES_BACKUP_KEEP_WEEKLY (8) more weeks. The outcome goes to state/backup.json, which the dashboard's
   server panel and the admin alerts read.
5. Off-server copy: each encrypted backup is also sent to the feedback Worker (feedback-worker/src/backups.js), in
   1 MB parts over the signed API, so losing this server doesn't lose its backups. There the newest
   HERMES_BACKUP_OFFSITE_KEEP_DAILY (7) are kept, plus the newest of each week for HERMES_BACKUP_OFFSITE_KEEP_WEEKLY
   (4) more. HERMES_BACKUP_OFFSITE=off keeps them on this server only; an unencrypted backup is never sent.
6. Retired recruits (profiles.py retire()) whose keep date has passed are deleted first, and anyone deleted that way
   or at their own request is then removed from every backup, here and on the feedback Worker: each archive is
   rewritten without their profile folder and with their name, email and id scrubbed from the logs in it.
   profiles.py also starts --forget-backups as soon as someone asks for deletion.

    python3 maintenance.py                          # all of the above (cron)
    python3 maintenance.py --no-backup
    python3 maintenance.py --backup-now             # just the backup (the dashboard's Back up now)
    python3 maintenance.py --new-key                # print a new HERMES_DATA_KEY
    python3 maintenance.py --list-backups
    python3 maintenance.py --list-offsite           # the copies on the feedback Worker
    python3 maintenance.py --fetch NAME [--out PATH]  # download one of them (default: into the backups folder)
    python3 maintenance.py --restore FILE --to DIR  # decrypt and unpack a backup into an empty folder
    python3 maintenance.py --forget-backups         # remove the people waiting for it from every backup
    python3 maintenance.py --decrypt FILE [--out PATH]  # open one encrypted file (a CV, letter or profile)
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
import sqlite3
import sys
import tarfile
import tempfile
import time
from datetime import datetime
from pathlib import Path

import hermes_common as hc
import profiles
import worker_link
from hermes_common import STATE_DIR, env, env_int, log
from job_tracker import Tracker

SCRIPT_DIR = Path(__file__).resolve().parent
DAY = 86400
# Backups made while HermitShell ran inside Hermes are named hermes-..., and are listed and rotated too.
BACKUP_PREFIX = "hermitshell-"
OLD_PREFIXES = ("hermes-",)
HOME_ITEMS = (".env", "cron")
SKIP_DIRS = {"__pycache__", ".ruff_cache", ".pytest_cache", "model-queue", "output", "locks", "tests",
             "node_modules"}
SKIP_SUFFIXES = (".lock", ".tmp", "-wal", "-shm", "-journal", ".pyc")
LETTER_DIRS = ("cover_letters", "tailored_cvs", "interview_prep")
STATE_PRIVATE = ("cv.json", "cv_skills_merged.json")
BACKUP_FILE = "backup.json"
LOCK_FILE = "maintenance.lock"
# The people still to be removed from the backups (encrypted, and never itself backed up), and how long
# --forget-backups waits for a running maintenance or Back up now before leaving it to the nightly run.
FORGET_FILE = "forget_backups.json"
FORGET_WAIT = (60, 30)
# Back up now is refused this soon after a backup finished.
BACKUP_NOW_GAP = 10 * 60
# backups.js: BACKUP_PART_BYTES, MAX_BACKUP_PARTS and the names it takes.
OFFSITE_PART = 1024 * 1024
OFFSITE_MAX_PARTS = 64
OFFSITE_NAME = re.compile(r"^hermitshell-\d{8}-\d{6}\.tar\.gz\.enc\Z")
OFFSITE_TIMEOUT = 120
OFFSITE_WHY = {"off": "HERMES_BACKUP_OFFSITE=off", "unencrypted": "HERMES_DATA_KEY is not set",
               "noworker": "no feedback Worker is set up", "worker": "the feedback Worker is too old: redeploy it"}


def backup_dir() -> Path:
    return Path(env("HERMES_BACKUP_DIR") or hc.APP_HOME / "backups" / "nightly")


def state_dirs() -> list[Path]:
    """The owner's state folder and each extra profile's."""
    found = [STATE_DIR] + sorted(p / "state" for p in profiles.PROFILES_DIR.glob("*") if (p / "state").is_dir())
    return [d for d in found if d.is_dir()]


# --------------------------------------------------------------------------- retention

def prune_state(state: Path, before: float) -> dict[str, int]:
    counts = {"jobs": 0, "events": 0, "runs": 0, "files": 0}
    db = state / "job_tracker.db"
    if db.is_file():
        with Tracker(db) as tracker:
            counts.update(tracker.prune(before))
    for sub in LETTER_DIRS:
        for path in (state / sub).glob("*"):
            if path.is_file() and path.stat().st_mtime < before:
                path.unlink(missing_ok=True)
                counts["files"] += 1
    return counts


def prune_logs(before: float) -> int:
    removed = 0
    for path in profiles.log_files():
        try:
            if path.stat().st_mtime < before:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def retention(now: float) -> str:
    days, log_days = env_int("HERMES_RETENTION_DAYS", 365), env_int("HERMES_LOG_RETENTION_DAYS", 90)
    total = {"jobs": 0, "events": 0, "runs": 0, "files": 0}
    if days > 0:
        for state in state_dirs():
            for key, value in prune_state(state, now - days * DAY).items():
                total[key] += value
    logs = prune_logs(now - log_days * DAY) if log_days > 0 else 0
    return (f"retention: {total['jobs']} jobs, {total['events']} answers, {total['runs']} runs, "
            f"{total['files']} letters/CVs older than {days or 'unlimited'} days; {logs} log files older than "
            f"{log_days or 'unlimited'} days")


# --------------------------------------------------------------------------- encryption and permissions

def private_files() -> list[Path]:
    """Files holding a person's CV, profile, keys or letters (the owner's hand-edited files in the scripts
    folder stay plain)."""
    found: list[Path] = []
    for d in sorted(profiles.PROFILES_DIR.glob("*")):
        if d.is_dir():
            found += [f for f in d.iterdir() if f.is_file() and not f.name.startswith(".")]
    for state in state_dirs():
        found += [state / n for n in STATE_PRIVATE]
        found += [f for sub in LETTER_DIRS for f in (state / sub).glob("*")]
    return [f for f in found if f.is_file() and not f.is_symlink()]


def seal_existing() -> int:
    if not env(hc.DATA_KEY_ENV):
        return 0
    sealed = 0
    for path in private_files():
        if not hc.is_sealed(path):
            hc.write_private(path, path.read_bytes())
            sealed += 1
    return sealed


def private_roots() -> list[Path]:
    roots = [STATE_DIR, profiles.PROFILES_DIR, backup_dir()]
    return [r for i, r in enumerate(roots) if not any(o == r or o in r.parents for o in roots[:i])]


def tighten(root: Path) -> int:
    if os.name != "posix" or not root.is_dir():
        return 0
    changed = 0
    for dirpath, _dirs, files in os.walk(root):
        for path, mode in [(Path(dirpath), 0o700)] + [(Path(dirpath) / f, 0o600) for f in files]:
            try:
                if not path.is_symlink() and path.stat().st_mode & 0o777 != mode:
                    os.chmod(path, mode)
                    changed += 1
            except OSError:
                continue
    return changed


# --------------------------------------------------------------------------- backups

def backup_sources() -> list[tuple[Path, str]]:
    home = hc.APP_HOME
    items = [(home / name, name) for name in HOME_ITEMS if (home / name).exists()]
    items.append((SCRIPT_DIR, "scripts"))
    if SCRIPT_DIR not in STATE_DIR.resolve().parents and STATE_DIR.is_dir():
        items.append((STATE_DIR, "state"))
    return items


def _skipped(path: Path) -> bool:
    return (path.name.endswith(SKIP_SUFFIXES) or path.name == FORGET_FILE
            or (".bak-" in path.name and path.parent == hc.APP_HOME))


def _add(tar: tarfile.TarFile, src: Path, arc: str, tmp: Path) -> None:
    if src.is_symlink() or _skipped(src):
        return
    if src.is_dir():
        if src.name in SKIP_DIRS or src.resolve() == backup_dir().resolve():
            return
        for child in sorted(src.iterdir()):
            _add(tar, child, f"{arc}/{child.name}", tmp)
    elif src.suffix == ".db":
        # A consistent copy of a live SQLite database (it may be mid-write in WAL mode).
        copy = tmp / f"{len(os.listdir(tmp))}.db"
        live, snap = sqlite3.connect(str(src)), sqlite3.connect(str(copy))
        try:
            live.backup(snap)
        finally:
            snap.close()
            live.close()
        tar.add(copy, arcname=arc)
    elif src.is_file():
        tar.add(src, arcname=arc)


def build_archive() -> bytes:
    buf = io.BytesIO()
    with tempfile.TemporaryDirectory() as tmp, tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for src, arc in backup_sources():
            _add(tar, src, arc, Path(tmp))
    return buf.getvalue()


def stamp_of(path: Path) -> datetime | None:
    for prefix in (BACKUP_PREFIX, *OLD_PREFIXES):
        if path.name.startswith(prefix):
            try:
                return datetime.strptime(path.name[len(prefix):len(prefix) + 15], "%Y%m%d-%H%M%S")
            except ValueError:
                return None
    return None


def list_backups(folder: Path | None = None) -> list[Path]:
    folder = folder or backup_dir()
    found = [p for p in folder.glob("*.tar.gz*") if p.is_file() and stamp_of(p)]
    return sorted(found, key=stamp_of, reverse=True)


def keeping(names: list[str], keep_daily: int, keep_weekly: int) -> set[str]:
    """The backup names a rotation keeps: the newest keep_daily, then the newest of each older week for keep_weekly
    weeks. Names without a time stamp are never kept."""
    dated = sorted((n for n in names if stamp_of(Path(n))), key=lambda n: stamp_of(Path(n)), reverse=True)
    keep = set(dated[:keep_daily])
    weeks: dict[tuple[int, int], str] = {}
    for name in dated[keep_daily:]:
        week = tuple(stamp_of(Path(name)).isocalendar()[:2])
        if week not in weeks and len(weeks) < keep_weekly:
            weeks[week] = name
    return keep | set(weeks.values())


def rotate(folder: Path, keep_daily: int, keep_weekly: int) -> int:
    backups = list_backups(folder)
    keep = keeping([p.name for p in backups], keep_daily, keep_weekly)
    removed = 0
    for path in backups:
        if path.name not in keep:
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def backup_info() -> dict:
    """The last backup's outcome: at, size, kept and encrypted, or error and failed_at after a failure."""
    try:
        info = json.loads((STATE_DIR / BACKUP_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return info if isinstance(info, dict) else {}


def _note_backup(info: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    hc.write_atomic(STATE_DIR / BACKUP_FILE, json.dumps(info).encode())


# --------------------------------------------------------------------------- off-server copies

def offsite_why() -> str:
    """Why backups aren't sent to the feedback Worker (a key of OFFSITE_WHY), or "" when they are."""
    if (env("HERMES_BACKUP_OFFSITE") or "auto").strip().lower() in ("off", "0", "no", "false"):
        return "off"
    if not env(hc.DATA_KEY_ENV):
        return "unencrypted"
    if worker_link.from_env() is None:
        return "noworker"
    known = worker_link.worker_protocol().get("protocol", 0)
    return "worker" if known and known < worker_link.BACKUP_PROTOCOL else ""


def _link(link=None):
    link = link or worker_link.from_env(timeout=OFFSITE_TIMEOUT)
    if link is None:
        raise worker_link.WorkerError("no feedback Worker is set up (JOB_FEEDBACK_URL and JOB_FEEDBACK_API_TOKEN)")
    return link


def offsite_list(link=None) -> list[dict]:
    """The copies on the feedback Worker, newest first: name, parts, sha (of the whole file), size and at (ms)."""
    got = _link(link).json("GET", "/api/backups").get("backups")
    whole = lambda v: type(v) is int and v >= 0  # noqa: E731
    return [b for b in (got if isinstance(got, list) else []) if isinstance(b, dict)
            and OFFSITE_NAME.match(str(b.get("name"))) and whole(b.get("parts")) and 0 < b["parts"] <= OFFSITE_MAX_PARTS
            and whole(b.get("size")) and re.fullmatch(r"[0-9a-f]{64}", str(b.get("sha")))]


def _upload(link, name: str, data: bytes) -> int:
    """One encrypted backup to the feedback Worker, part by part; returns the number of parts."""
    parts = max(1, math.ceil(len(data) / OFFSITE_PART))
    if parts > OFFSITE_MAX_PARTS:
        raise ValueError(f"too large for the feedback Worker ({len(data) // 2**20} MB; it takes {OFFSITE_MAX_PARTS} MB)")
    sha = hashlib.sha256(data).hexdigest()
    for i in range(parts):
        link.request("POST", "/api/backup/part", params={"name": name, "i": i, "n": parts, "sha": sha},
                     data=data[i * OFFSITE_PART:(i + 1) * OFFSITE_PART], content_type="application/octet-stream")
    return parts


def send_offsite(name: str, data: bytes, link=None) -> tuple[int, int, int]:
    """Sends one encrypted backup to the feedback Worker part by part, then drops the copies there the off-server
    rotation no longer keeps. Returns (parts, kept, removed); raises WorkerError or ValueError."""
    if not OFFSITE_NAME.match(name) or not data.startswith(hc.SEALED):
        raise ValueError("only encrypted backups are sent")
    link, sha = _link(link), hashlib.sha256(data).hexdigest()
    parts = _upload(link, name, data)
    listed = offsite_list(link)
    if not any(b["name"] == name and b["sha"] == sha for b in listed):
        raise worker_link.WorkerError("the feedback Worker did not keep the backup")
    keep = keeping([b["name"] for b in listed], env_int("HERMES_BACKUP_OFFSITE_KEEP_DAILY", 7),
                   env_int("HERMES_BACKUP_OFFSITE_KEEP_WEEKLY", 4)) | {name}
    removed = 0
    for b in listed:
        if b["name"] not in keep:
            link.request("POST", "/api/backup/delete", json_body={"name": b["name"]})
            removed += 1
    return parts, len(listed) - removed, removed


def _download(link, found: dict) -> bytes:
    data = b"".join(link.request("GET", "/api/backup/part", params={"name": found["name"], "i": i}).content
                    for i in range(found["parts"]))
    if hashlib.sha256(data).hexdigest() != found["sha"]:
        raise worker_link.WorkerError("the download is damaged (its SHA-256 doesn't match); try again")
    return data


def fetch_offsite(name: str, out: Path | None = None, link=None) -> Path:
    """Downloads one copy from the feedback Worker, checks its SHA-256 and saves it (still encrypted)."""
    link = _link(link)
    found = next((b for b in offsite_list(link) if b["name"] == name), None)
    if found is None:
        raise SystemExit(f"{name} is not kept on the feedback Worker (--list-offsite lists them)")
    try:
        data = _download(link, found)
    except worker_link.WorkerError as exc:
        raise SystemExit(str(exc)) from None
    out = out or backup_dir() / name
    out.parent.mkdir(parents=True, exist_ok=True)
    hc.write_atomic(out, data)
    if os.name == "posix":
        os.chmod(out, 0o600)
    return out


def offsite_step(name: str, data: bytes) -> str:
    """Sends a backup just made off the server and notes how it went in state/backup.json; never raises, since the
    backup itself is already safe on this server."""
    why = offsite_why()
    info = backup_info()
    before = info.get("offsite") if isinstance(info.get("offsite"), dict) else {}
    if why:
        _note_backup({**info, "offsite": {"on": False, "why": why}})
        return f"off-server copy: not sent ({OFFSITE_WHY[why]})"
    try:
        parts, kept, removed = send_offsite(name, data)
    except Exception as exc:  # the local backup stands; the dashboard and admin alerts say what went wrong
        error = str(exc) if isinstance(exc, ValueError) else worker_link.reason(exc)
        _note_backup({**info, "offsite": {**before, "on": True, "why": "", "error": error[:200], "failed_at": time.time()}})
        return f"off-server copy failed: {error}"
    _note_backup({**info, "offsite": {"on": True, "why": "", "at": time.time(), "kept": kept, "error": ""}})
    return f"off-server copy: sent to the feedback Worker in {parts} part{'s' * (parts != 1)}, {kept} kept there, {removed} old removed"


def make_backup(now: datetime | None = None) -> str:
    try:
        folder = backup_dir()
        folder.mkdir(parents=True, exist_ok=True)
        data = build_archive()
        encrypted = bool(env(hc.DATA_KEY_ENV))
        name = f"{BACKUP_PREFIX}{(now or datetime.now()):%Y%m%d-%H%M%S}.tar.gz" + (".enc" if encrypted else "")
        data = hc.seal(data)
        hc.write_private(folder / name, data)
        removed = rotate(folder, env_int("HERMES_BACKUP_KEEP_DAILY", 14), env_int("HERMES_BACKUP_KEEP_WEEKLY", 8))
    except Exception as exc:
        # The last good backup's numbers stay, beside the error.
        _note_backup({**backup_info(), "error": f"{exc.__class__.__name__}: {exc}"[:200], "failed_at": time.time()})
        raise
    offsite = backup_info().get("offsite")
    _note_backup({"at": time.time(), "size": len(data), "kept": len(list_backups(folder)), "encrypted": encrypted,
                  "error": "", **({"offsite": offsite} if isinstance(offsite, dict) else {})})
    if not encrypted:
        log("Warning: HERMES_DATA_KEY is not set, so this backup is NOT encrypted (python3 maintenance.py --new-key)")
    return (f"backup: {name} ({len(data) // 1024} KB{', encrypted' if encrypted else ''}), {removed} old removed; "
            + offsite_step(name, data))


def backup_refusal(now: float) -> str:
    """Why Back up now shouldn't run, or ""."""
    at = backup_info().get("at")
    if isinstance(at, (int, float)) and 0 <= now - at < BACKUP_NOW_GAP:
        return "a backup finished less than 10 minutes ago"
    return ""


def backup_now() -> int:
    """One backup, under the nightly run's lock so the two never overlap."""
    with hc.run_lock(STATE_DIR / LOCK_FILE) as got:
        if not got:
            log("Maintenance is running, and its backup with it; Back up now skipped")
            return 0
        refusal = backup_refusal(time.time())
        if refusal:
            log(f"Back up now skipped: {refusal}")
            return 0
        try:
            log(make_backup())
        except Exception as exc:
            log(f"backup failed: {exc.__class__.__name__}: {exc}")
            return 1
        return 0


def restore(archive: Path, target: Path) -> int:
    if target.exists() and any(target.iterdir()):
        raise SystemExit(f"{target} is not empty; restore into a new folder and copy back what you need")
    data = hc.unseal(archive.read_bytes())
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        members = tar.getmembers()
        for m in members:
            parts = Path(m.name).parts
            if m.name.startswith(("/", "\\")) or ".." in parts or not (m.isfile() or m.isdir()):
                raise SystemExit(f"refusing to unpack {m.name!r}")
        target.mkdir(parents=True, exist_ok=True)
        extra = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}
        tar.extractall(target, members=members, **extra)  # nosec B202
    return len(members)


# --------------------------------------------------------------------------- removing deleted people from the backups

def _forgets() -> list[dict]:
    try:
        found = json.loads(hc.read_private_text(STATE_DIR / FORGET_FILE))
    except (OSError, ValueError):
        return []
    return [f for f in found if isinstance(f, dict) and profiles.ID_RE.match(str(f.get("u") or ""))] \
        if isinstance(found, list) else []


def queue_forget(profile: dict) -> None:
    """Notes a profile being deleted for good, so forget_backups removes it from every backup."""
    terms = [str(profile.get(k) or "") for k in ("email", "name")] + [profile["id"]]
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    hc.write_private(STATE_DIR / FORGET_FILE, json.dumps(_forgets() + [{"u": profile["id"], "terms": terms, "at": time.time()}]))


def _theirs(name: str, pids: set[str]) -> bool:
    parts = name.split("/")
    return any(a == "profiles" and b in pids for a, b in zip(parts, parts[1:]))


def forget_in_archive(data: bytes, pids: set[str], rx, max_log: int = 50 * 1024 * 1024) -> bytes | None:
    """A backup archive (gzipped tar) without these profiles' folders and with the pattern scrubbed from its logs, or
    None when nothing in it changes."""
    buf, changed = io.BytesIO(), False
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as src, tarfile.open(fileobj=buf, mode="w:gz") as out:
        for m in src.getmembers():
            if _theirs(m.name, pids) or m.name.split("/")[-1] == FORGET_FILE:
                changed = True
                continue
            body = src.extractfile(m) if m.isfile() else None
            if body is not None and rx is not None and ".log" in m.name.split("/")[-1] and m.size <= max_log:
                text, n = rx.subn("[deleted]", body.read().decode("utf-8", errors="surrogateescape"))
                raw = text.encode("utf-8", errors="surrogateescape")
                changed = changed or n > 0
                m.size, body = len(raw), io.BytesIO(raw)
            out.addfile(m, body)
    return buf.getvalue() if changed else None


def _clean(data: bytes, pids: set[str], rx) -> bytes | None:
    new = forget_in_archive(hc.unseal(data), pids, rx)
    return None if new is None else hc.seal(new)


def forget_backups(link=None) -> str:
    """Removes everyone waiting in FORGET_FILE from each backup on this server, then from each copy on the feedback
    Worker: a copy there is replaced by the cleaned one with the same name (fetched first when this server no longer
    has it). Those done leave the list; an off-server failure keeps them on it for the next nightly run."""
    pending = _forgets()
    if not pending:
        return "forget: nobody to remove from the backups"
    pids = {f["u"] for f in pending}
    rx = profiles.scrub_pattern([str(t) for f in pending for t in (f.get("terms") or []) if isinstance(t, str)])
    local, failed = 0, []
    for path in list_backups():
        try:
            new = _clean(path.read_bytes(), pids, rx)
        except (OSError, tarfile.TarError, hc.DataKeyError) as exc:
            failed.append(f"{path.name}: {exc.__class__.__name__}")
            continue
        if new is not None:
            hc.write_private(path, new)
            local += 1
    remote, why = 0, offsite_why()
    if not why:
        try:
            link = _link(link)
            for b in offsite_list(link):
                here = backup_dir() / b["name"]
                data = here.read_bytes() if here.is_file() else _clean(_download(link, b), pids, rx)
                if data is None or hashlib.sha256(data).hexdigest() == b["sha"]:
                    continue
                link.request("POST", "/api/backup/delete", json_body={"name": b["name"]})
                _upload(link, b["name"], data)
                remote += 1
        except (worker_link.WorkerError, ValueError, tarfile.TarError, hc.DataKeyError) as exc:
            failed.append(f"off-server: {worker_link.reason(exc) if isinstance(exc, worker_link.WorkerError) else exc.__class__.__name__}")
    if not failed:
        done = {(f["u"], f.get("at")) for f in pending}
        left = [f for f in _forgets() if (f["u"], f.get("at")) not in done]
        if left:
            hc.write_private(STATE_DIR / FORGET_FILE, json.dumps(left))
        else:
            (STATE_DIR / FORGET_FILE).unlink(missing_ok=True)
    return (f"forget: {len(pids)} deleted {'person' if len(pids) == 1 else 'people'} removed from {local} backup(s) here"
            + (f" and {remote} on the feedback Worker" if not why else f" (off-server copies: {OFFSITE_WHY[why]})")
            + (f"; will retry: {'; '.join(failed)[:200]}" if failed else ""))


def forget_backups_now(wait=FORGET_WAIT, sleep=time.sleep) -> int:
    """--forget-backups: under the nightly run's lock, waiting a while for a running one (which does it too)."""
    tries, gap = wait
    for _ in range(tries):
        with hc.run_lock(STATE_DIR / LOCK_FILE) as got:
            if got:
                try:
                    log(forget_backups())
                except Exception as exc:
                    log(f"forget failed: {exc.__class__.__name__}: {exc}")
                    return 1
                return 0
        sleep(gap)
    log("Maintenance is still running; the nightly run removes them from the backups instead")
    return 0


# --------------------------------------------------------------------------- command line

def main(argv: list[str] | None = None) -> int:
    # Set here, not on import: profiles.py and alerts.py import this module and keep their own tag.
    hc.LOG_TAG = "maintenance"
    parser = argparse.ArgumentParser(description="Retention, encryption at rest and encrypted backups.")
    parser.add_argument("--no-backup", action="store_true", help="skip the backup")
    parser.add_argument("--backup-now", action="store_true", help="only the backup (refused within 10 minutes of one)")
    parser.add_argument("--new-key", action="store_true", help="print a new random HERMES_DATA_KEY")
    parser.add_argument("--list-backups", action="store_true")
    parser.add_argument("--list-offsite", action="store_true", help="list the copies on the feedback Worker")
    parser.add_argument("--fetch", metavar="NAME", help="download a copy from the feedback Worker (--out PATH)")
    parser.add_argument("--restore", metavar="FILE", help="decrypt and unpack a backup (needs --to)")
    parser.add_argument("--to", metavar="DIR", help="empty folder to restore into")
    parser.add_argument("--decrypt", metavar="FILE", help="print (or --out) the plaintext of one encrypted file")
    parser.add_argument("--out", metavar="PATH")
    parser.add_argument("--forget-backups", action="store_true", help="remove deleted people from every backup")
    args = parser.parse_args(argv)

    if args.new_key:
        print(hc.new_data_key())
        return 0
    if args.list_backups:
        for path in list_backups():
            print(f"{path.name}  {path.stat().st_size // 1024} KB")
        return 0
    if args.list_offsite or args.fetch:
        try:
            if args.fetch:
                print(f"Saved {fetch_offsite(args.fetch, Path(args.out) if args.out else None)}")
            for b in offsite_list() if args.list_offsite else []:
                print(f"{b['name']}  {b['size'] // 1024} KB")
        except worker_link.WorkerError as exc:
            raise SystemExit(f"The feedback Worker: {worker_link.reason(exc)}") from None
        return 0
    if args.restore:
        if not args.to:
            parser.error("--restore needs --to DIR")
        print(f"Unpacked {restore(Path(args.restore), Path(args.to))} entries into {args.to}")
        return 0
    if args.decrypt:
        data = hc.read_private(Path(args.decrypt))
        if args.out:
            hc.write_atomic(Path(args.out), data)
        else:
            sys.stdout.buffer.write(data)
        return 0
    if args.backup_now:
        return backup_now()
    if args.forget_backups:
        return forget_backups_now()

    with hc.run_lock(STATE_DIR / LOCK_FILE) as got:
        if not got:
            log("Maintenance is already running; skipping")
            return 0
        failed = False
        steps = [("retired", lambda: f"retired: {profiles.expire_retired(time.time(), profiles.api_from_env())} "
                  "kept past their date deleted"),
                 ("retention", lambda: retention(time.time())),
                 ("encryption", lambda: f"encryption: {seal_existing()} older files encrypted"
                  if env(hc.DATA_KEY_ENV) else "encryption: off (HERMES_DATA_KEY not set)"),
                 ("permissions", lambda: f"permissions: {sum(map(tighten, private_roots()))} tightened")]
        if not args.no_backup:
            steps.append(("backup", make_backup))
        steps.append(("forget", forget_backups))
        for name, step in steps:
            try:
                log(step())
            except Exception as exc:  # one failing step must not stop the others
                failed = True
                log(f"{name} failed: {exc.__class__.__name__}: {exc}")
        return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

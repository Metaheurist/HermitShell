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
   for HERMES_BACKUP_KEEP_WEEKLY (8) more weeks.

    python3 maintenance.py                          # all of the above (cron)
    python3 maintenance.py --no-backup
    python3 maintenance.py --new-key                # print a new HERMES_DATA_KEY
    python3 maintenance.py --list-backups
    python3 maintenance.py --restore FILE --to DIR  # decrypt and unpack a backup into an empty folder
    python3 maintenance.py --decrypt FILE [--out PATH]  # open one encrypted file (a CV, letter or profile)
"""
from __future__ import annotations

import argparse
import io
import os
import sqlite3
import sys
import tarfile
import tempfile
import time
from datetime import datetime
from pathlib import Path

import hermes_common as hc
import profiles
from hermes_common import STATE_DIR, env, env_int, log
from job_tracker import Tracker

hc.LOG_TAG = "maintenance"
SCRIPT_DIR = Path(__file__).resolve().parent
DAY = 86400
# Backups made while HermitShell ran inside Hermes are named hermes-..., and are listed and rotated too.
BACKUP_PREFIX = "hermitshell-"
OLD_PREFIXES = ("hermes-",)
HOME_ITEMS = (".env", "cron")
SKIP_DIRS = {"__pycache__", ".ruff_cache", ".pytest_cache", "model-queue", "output", "locks", "tests",
             "node_modules"}
SKIP_SUFFIXES = (".lock", ".tmp", "-wal", "-shm", "-journal", ".pyc")
LETTER_DIRS = ("cover_letters", "tailored_cvs")
STATE_PRIVATE = ("cv.json", "cv_skills_merged.json")


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
    return path.name.endswith(SKIP_SUFFIXES) or (".bak-" in path.name and path.parent == hc.APP_HOME)


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


def rotate(folder: Path, keep_daily: int, keep_weekly: int) -> int:
    backups = list_backups(folder)
    keep = set(backups[:keep_daily])
    weeks: dict[tuple[int, int], Path] = {}
    for path in backups[keep_daily:]:
        week = tuple(stamp_of(path).isocalendar()[:2])
        if week not in weeks and len(weeks) < keep_weekly:
            weeks[week] = path
    keep |= set(weeks.values())
    removed = 0
    for path in backups:
        if path not in keep:
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def make_backup(now: datetime | None = None) -> str:
    folder = backup_dir()
    folder.mkdir(parents=True, exist_ok=True)
    data = build_archive()
    encrypted = bool(env(hc.DATA_KEY_ENV))
    name = f"{BACKUP_PREFIX}{(now or datetime.now()):%Y%m%d-%H%M%S}.tar.gz" + (".enc" if encrypted else "")
    hc.write_private(folder / name, data)
    removed = rotate(folder, env_int("HERMES_BACKUP_KEEP_DAILY", 14), env_int("HERMES_BACKUP_KEEP_WEEKLY", 8))
    if not encrypted:
        log("Warning: HERMES_DATA_KEY is not set, so this backup is NOT encrypted (python3 maintenance.py --new-key)")
    return f"backup: {name} ({len(data) // 1024} KB{', encrypted' if encrypted else ''}), {removed} old removed"


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


# --------------------------------------------------------------------------- command line

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Retention, encryption at rest and encrypted backups.")
    parser.add_argument("--no-backup", action="store_true", help="skip the backup")
    parser.add_argument("--new-key", action="store_true", help="print a new random HERMES_DATA_KEY")
    parser.add_argument("--list-backups", action="store_true")
    parser.add_argument("--restore", metavar="FILE", help="decrypt and unpack a backup (needs --to)")
    parser.add_argument("--to", metavar="DIR", help="empty folder to restore into")
    parser.add_argument("--decrypt", metavar="FILE", help="print (or --out) the plaintext of one encrypted file")
    parser.add_argument("--out", metavar="PATH")
    args = parser.parse_args(argv)

    if args.new_key:
        print(hc.new_data_key())
        return 0
    if args.list_backups:
        for path in list_backups():
            print(f"{path.name}  {path.stat().st_size // 1024} KB")
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

    with hc.run_lock(STATE_DIR / "maintenance.lock") as got:
        if not got:
            log("Maintenance is already running; skipping")
            return 0
        failed = False
        steps = [("retention", lambda: retention(time.time())),
                 ("encryption", lambda: f"encryption: {seal_existing()} older files encrypted"
                  if env(hc.DATA_KEY_ENV) else "encryption: off (HERMES_DATA_KEY not set)"),
                 ("permissions", lambda: f"permissions: {sum(map(tighten, private_roots()))} tightened")]
        if not args.no_backup:
            steps.append(("backup", make_backup))
        for name, step in steps:
            try:
                log(step())
            except Exception as exc:  # one failing step must not stop the others
                failed = True
                log(f"{name} failed: {exc.__class__.__name__}: {exc}")
        return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

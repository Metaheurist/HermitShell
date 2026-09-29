#!/usr/bin/env python3
"""HermitShell's scheduler: starts each script on its cron schedule, so HermitShell needs no other scheduler.

    python3 scheduler.py run                   # keep running and start every job on time (the service)
    python3 scheduler.py tick                  # start the jobs due now and exit (for a system crontab, every minute)
    python3 scheduler.py list [--json]
    python3 scheduler.py create "0 7 * * *" "Daily Vacancy Report" --name job-scanner --script job_scanner.py
                                [--workdir DIR] [--paused]
    python3 scheduler.py edit ID --schedule "30 7 * * 1-5"
    python3 scheduler.py pause ID | resume ID | remove ID
    python3 scheduler.py start ID              # run a job now, in the foreground, as its schedule would
    python3 scheduler.py defaults [--if-new]   # add the packages' standard jobs that are missing
    python3 scheduler.py import FILE [--map OLD=NEW]   # take over HermitShell's jobs from another jobs.json
    python3 scheduler.py health                # exit 0 while the service is running (the container's health check)

Jobs live in <home>/cron/jobs.json and each run's output in <home>/cron/output/<job id>/ (runs that print nothing
leave no file). A job still running when it is next due is skipped; a run the service missed while it was down is
started late if it was due within HERMITSHELL_CATCHUP_MINUTES (default 30). A run is stopped after
HERMITSHELL_JOB_TIMEOUT seconds (default 6 hours). Schedules are in HERMES_TIMEZONE (default UTC).
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

# Jobs get the environment the scheduler was started with, not the one hermes_common builds from .env and the
# dashboard, so each run reads the settings as they are when it starts.
BASE_ENV = dict(os.environ)

import hermes_common as hc  # noqa: E402

hc.LOG_TAG = "scheduler"
SCRIPT_DIR = Path(__file__).resolve().parent
CRON_DIR = hc.APP_HOME / "cron"
JOBS_FILE = CRON_DIR / "jobs.json"
OUTPUT_DIR = CRON_DIR / "output"
LOCK_DIR = CRON_DIR / "locks"
HEARTBEAT = CRON_DIR / "heartbeat.json"
HEALTHY_WITHIN = 180
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
SCRIPT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.py\Z")
ID_RE = re.compile(r"^[0-9a-f]{6,32}\Z")
STOP_GRACE = 30
MAX_TITLE = 120

FIELDS = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
MONTHS = {m: i for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov",
                                      "dec"), 1)}
DAYS = {d: i for i, d in enumerate(("sun", "mon", "tue", "wed", "thu", "fri", "sat"))}
ALIASES = {"@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0",
           "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *"}


class ScheduleError(ValueError):
    """A cron expression, job name, script or folder the scheduler will not accept."""


# --------------------------------------------------------------------------- cron expressions

def _field(text: str, index: int) -> set[int]:
    low, high = FIELDS[index]
    names = MONTHS if index == 3 else DAYS if index == 4 else {}
    values: set[int] = set()

    def number(token: str) -> int:
        token = token.lower()
        if token in names:
            return names[token]
        if not token.isdigit():
            raise ScheduleError(f"'{token}' is not a number")
        return int(token)

    for item in text.split(","):
        base, _, step_text = item.partition("/")
        step = number(step_text) if step_text else 1
        if step < 1:
            raise ScheduleError("a step must be at least 1")
        if base == "*":
            start, end = low, high
        elif "-" in base:
            first, _, last = base.partition("-")
            start, end = number(first), number(last)
        else:
            start = number(base)
            end = high if step_text else start
        if not (low <= start <= high and low <= end <= high) or start > end:
            raise ScheduleError(f"'{item}' is outside {low}-{high}")
        values.update(range(start, end + 1, step))
    if index == 4 and 7 in values:
        values = (values - {7}) | {0}
    return values


def parse(expr: str) -> tuple[list[set[int]], bool, bool]:
    """Minutes, hours, days of the month, months and days of the week a five-field cron expression matches, and
    whether the day-of-month and day-of-week fields are restricted (when both are, either may match)."""
    text = ALIASES.get((expr or "").strip().lower(), (expr or "").strip())
    parts = text.split()
    if len(parts) != 5 or len(text) > 100:
        raise ScheduleError(f"'{expr}' is not a five-field cron expression")
    return [_field(p, i) for i, p in enumerate(parts)], parts[2] != "*", parts[4] != "*"


def valid(expr: str) -> bool:
    try:
        parse(expr)
    except ScheduleError:
        return False
    return True


def matches(spec: tuple[list[set[int]], bool, bool], when: datetime) -> bool:
    (minutes, hours, doms, months, dows), dom_set, dow_set = spec
    if when.minute not in minutes or when.hour not in hours or when.month not in months:
        return False
    dom, dow = when.day in doms, (when.weekday() + 1) % 7 in dows
    return (dom or dow) if dom_set and dow_set else (dom and dow)


def zone() -> ZoneInfo:
    try:
        return ZoneInfo((hc.env("HERMES_TIMEZONE") or "UTC").strip())
    except (ValueError, KeyError, OSError):
        return ZoneInfo("UTC")


def minute_of(moment: datetime) -> datetime:
    return moment.astimezone(timezone.utc).replace(second=0, microsecond=0)


def due_at(job: dict, now: datetime, catchup: int) -> datetime | None:
    """The latest minute (UTC) at or before `now` the job is due and hasn't been started for; a new job is never
    started for times before it was added."""
    if not enabled(job):
        return None
    try:
        spec = parse(expression(job))
    except ScheduleError:
        return None
    now = minute_of(now)
    start = now - timedelta(minutes=max(0, catchup))
    last = _stamp(job.get("last_due"))
    start = max(start, last + timedelta(minutes=1)) if last else now
    tz, moment = zone(), now
    while moment >= start:
        if matches(spec, moment.astimezone(tz)):
            return moment
        moment -= timedelta(minutes=1)
    return None


def _stamp(value) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value)).astimezone(timezone.utc) if value else None
    except ValueError:
        return None


# --------------------------------------------------------------------------- the jobs file

def expression(job: dict) -> str:
    schedule = job.get("schedule")
    return str(schedule.get("expr") or "") if isinstance(schedule, dict) else str(schedule or "")


def enabled(job: dict) -> bool:
    return job.get("enabled", True) is not False and job.get("state") != "paused"


def load_jobs() -> list[dict] | None:
    """The jobs, or None when the scheduler has never been set up here."""
    try:
        data = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    jobs = data.get("jobs") if isinstance(data, dict) else data
    return [j for j in jobs if isinstance(j, dict) and j.get("id")] if isinstance(jobs, list) else None


@contextlib.contextmanager
def editing():
    """The job list, saved on leaving; one change at a time across processes."""
    CRON_DIR.mkdir(parents=True, exist_ok=True)
    with open(CRON_DIR / ".jobs.lock", "a") as handle:
        try:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX)
        except ImportError:  # Windows development machines have no flock
            pass
        jobs = load_jobs() or []
        yield jobs
        hc.write_atomic(JOBS_FILE, json.dumps({"jobs": jobs, "updated_at": _now_iso()}, indent=2) + "\n")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def find(jobs: list[dict], ref: str) -> dict:
    job = next((j for j in jobs if j.get("id") == ref), None) or next((j for j in jobs if j.get("name") == ref), None)
    if job is None:
        raise ScheduleError(f"no job {ref!r}")
    return job


def checked_workdir(workdir: str | None) -> str | None:
    """A job's folder must be inside HermitShell's home, so a job can only run the installed scripts on its data."""
    if not workdir:
        return None
    path, home = Path(workdir).resolve(), hc.APP_HOME.resolve()
    if path != home and home not in path.parents:
        raise ScheduleError(f"{workdir} is outside {home}")
    return str(path)


def new_job(expr: str, title: str, name: str, script: str, workdir: str | None = None, paused: bool = False) -> dict:
    parse(expr)
    if not NAME_RE.match(name or ""):
        raise ScheduleError(f"invalid job name {name!r}")
    if not SCRIPT_RE.match(script or ""):
        raise ScheduleError(f"invalid script {script!r} (a .py file in {SCRIPT_DIR})")
    return {"id": secrets.token_hex(6), "name": name, "title": " ".join(str(title or name).split())[:MAX_TITLE],
            "script": script, "workdir": checked_workdir(workdir),
            "schedule": {"kind": "cron", "expr": " ".join(expr.split()), "display": " ".join(expr.split())},
            "enabled": not paused, "state": "paused" if paused else "scheduled", "created_at": _now_iso(),
            "last_due": minute_of(datetime.now(timezone.utc)).isoformat()}


def create(expr: str, title: str, name: str, script: str, workdir: str | None = None, paused: bool = False) -> dict:
    job = new_job(expr, title, name, script, workdir, paused)
    with editing() as jobs:
        if any(j.get("name") == name for j in jobs):
            raise ScheduleError(f"a job named {name!r} already exists")
        jobs.append(job)
    return job


def change(ref: str, **fields) -> dict:
    """A new schedule or a resumed job counts from now: a time that has just gone by waits for its next turn."""
    with editing() as jobs:
        job = find(jobs, ref)
        if "expr" in fields:
            expr = " ".join(fields.pop("expr").split())
            parse(expr)
            job["schedule"] = {"kind": "cron", "expr": expr, "display": expr}
            fields["last_due"] = minute_of(datetime.now(timezone.utc)).isoformat()
        if fields.get("enabled") and not enabled(job):
            fields["last_due"] = minute_of(datetime.now(timezone.utc)).isoformat()
        job.update(fields)
    return job


def remove(ref: str) -> dict:
    with editing() as jobs:
        job = find(jobs, ref)
        jobs.remove(job)
    return job


def default_jobs() -> list[dict]:
    """The standard jobs each installed package lists in <package>.jobs.json."""
    found = []
    for path in sorted(SCRIPT_DIR.glob("*.jobs.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        found += [j for j in data.get("jobs", []) if isinstance(j, dict)] if isinstance(data, dict) else []
    return found


def add_defaults(only_if_new: bool = False) -> list[str]:
    if only_if_new and JOBS_FILE.exists():
        return []
    added = []
    with editing() as jobs:
        names, scripts = {j.get("name") for j in jobs}, {j.get("script") for j in jobs if not j.get("workdir")}
        for spec in default_jobs():
            if spec.get("name") in names or spec.get("script") in scripts or \
                    not (SCRIPT_DIR / str(spec.get("script"))).is_file():
                continue
            jobs.append(new_job(spec["schedule"], spec.get("title", spec["name"]), spec["name"], spec["script"]))
            added.append(spec["name"])
    return added


def import_jobs(path: Path, mapping: list[tuple[str, str]]) -> list[str]:
    """Copy the jobs of another jobs.json (such as Hermes') whose script is installed here, keeping their names,
    schedules, folders (moved by `mapping`) and paused state. Jobs already here by name are left alone."""
    data = json.loads(path.read_text(encoding="utf-8"))
    source = data.get("jobs") if isinstance(data, dict) else data
    taken = []
    with editing() as jobs:
        names = {j.get("name") for j in jobs}
        for old in source if isinstance(source, list) else []:
            script = Path(str(old.get("script") or "")).name if isinstance(old, dict) else ""
            if not SCRIPT_RE.match(script) or not (SCRIPT_DIR / script).is_file():
                continue
            name = str(old.get("name") or script[:-3])
            if name in names or not valid(expression(old)):
                continue
            workdir = old.get("workdir") or None
            for before, after in mapping:
                if workdir and (workdir == before or workdir.startswith(before.rstrip("/") + "/")):
                    workdir = after + workdir[len(before):]
                    break
            title = old.get("title") or (old.get("prompt") if len(str(old.get("prompt") or "")) <= MAX_TITLE else "")
            jobs.append(new_job(expression(old), title or name, name, script, workdir, not enabled(old)))
            names.add(name)
            taken.append(name)
    return taken


# --------------------------------------------------------------------------- running a job

def lock_file(job_id: str) -> Path:
    if not ID_RE.match(job_id or ""):
        raise ScheduleError(f"invalid job id {job_id!r}")
    return LOCK_DIR / f"{job_id}.lock"


def running(job_id: str) -> bool:
    with hc.run_lock(lock_file(job_id)) as got:
        return not got


def script_path(job: dict) -> Path:
    script = str(job.get("script") or "")
    path = SCRIPT_DIR / script
    if not SCRIPT_RE.match(script) or not path.is_file():
        raise ScheduleError(f"script {script!r} is not installed in {SCRIPT_DIR}")
    return path


def record(job_id: str, **fields) -> None:
    with editing() as jobs, contextlib.suppress(ScheduleError):
        find(jobs, job_id).update(fields)


def execute(job_id: str, timeout: int | None = None) -> int:
    """Run one job in the foreground, its output kept in cron/output/<id>/; 0 when it was already running."""
    jobs = load_jobs() or []
    job = find(jobs, job_id)
    job_id = job["id"]
    with hc.run_lock(lock_file(job_id)) as got:
        if not got:
            hc.log(f"{job['name']} is still running; not starting it again")
            return 0
        try:
            script = script_path(job)
            workdir = checked_workdir(job.get("workdir")) or str(SCRIPT_DIR)
        except ScheduleError as exc:
            record(job_id, last_run_at=_now_iso(), last_status="error", last_error=str(exc)[:300])
            hc.log(f"{job['name']}: {exc}")
            return 2
        timeout = timeout or hc.env_int("HERMITSHELL_JOB_TIMEOUT", 6 * 3600)
        out = OUTPUT_DIR / job_id / f"{datetime.now(zone()):%Y-%m-%d_%H-%M-%S}.log"
        out.parent.mkdir(parents=True, exist_ok=True)
        started = time.time()
        hc.log(f"Starting {job['name']} ({script.name})")
        with open(out, "wb") as fh:
            proc = subprocess.Popen([sys.executable, str(script)], cwd=workdir, stdout=fh, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, env=BASE_ENV, start_new_session=os.name == "posix")
            stop = _stopper(proc)
            try:
                code = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                hc.log(f"{job['name']} ran for over {timeout} s; stopping it")
                stop()
                code = 124
            finally:
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
        if out.stat().st_size == 0:
            out.unlink(missing_ok=True)
            with contextlib.suppress(OSError):
                out.parent.rmdir()
        took = time.time() - started
        record(job_id, last_run_at=datetime.fromtimestamp(started, timezone.utc).isoformat(timespec="seconds"),
               last_status="ok" if code == 0 else "error", last_exit=code, last_duration=round(took, 1),
               last_error="" if code == 0 else f"exit {code}")
        hc.log(f"Finished {job['name']}: exit {code} after {took:.0f} s")
        return code


def _stopper(proc: subprocess.Popen):
    """Stops the job's process group, politely first; also used when the scheduler itself is told to stop."""
    def stop(*_args) -> None:
        with contextlib.suppress(OSError):
            if os.name == "posix":
                os.killpg(proc.pid, signal.SIGTERM)
            else:
                proc.terminate()
        try:
            proc.wait(timeout=STOP_GRACE)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(OSError):
                os.killpg(proc.pid, signal.SIGKILL) if os.name == "posix" else proc.kill()
            proc.wait()

    if os.name == "posix":
        signal.signal(signal.SIGTERM, lambda *_a: (stop(), sys.exit(143)))
    return stop


# --------------------------------------------------------------------------- the service

def start_due(now: datetime, spawn, detach: bool = False) -> list[tuple[str, object]]:
    """Mark and start every job due at `now`; a job still running is skipped (and not started late). Returns
    (job id, what `spawn` returned) for each job started."""
    catchup = hc.env_int("HERMITSHELL_CATCHUP_MINUTES", 30)
    starting = []
    with editing() as jobs:
        for job in jobs:
            moment = due_at(job, now, catchup)
            if moment is None:
                continue
            job["last_due"] = moment.isoformat()
            if running(job["id"]):
                hc.log(f"{job['name']} is due but still running; skipping this run")
                continue
            if moment < minute_of(now):
                hc.log(f"{job['name']} was due at {moment.astimezone(zone()):%H:%M}; starting it late")
            starting.append(job["id"])
    return [(job_id, spawn([sys.executable, str(Path(__file__).resolve()), "exec", job_id], env=BASE_ENV,
                           stdin=subprocess.DEVNULL, cwd=SCRIPT_DIR, start_new_session=detach and os.name == "posix"))
            for job_id in starting]


def beat(extra: dict | None = None) -> None:
    hc.write_atomic(HEARTBEAT, json.dumps({"pid": os.getpid(), "at": time.time(), **(extra or {})}))


def healthy(now: float | None = None) -> bool:
    try:
        at = float(json.loads(HEARTBEAT.read_text(encoding="utf-8")).get("at") or 0)
    except (OSError, ValueError, TypeError, AttributeError):
        return False
    return 0 <= (now or time.time()) - at <= HEALTHY_WITHIN


def serve(spawn=subprocess.Popen, clock=time.time, sleep=time.sleep, rounds: int | None = None) -> int:
    """The service: once a minute start what is due; reap finished runs; stop cleanly on SIGTERM."""
    with hc.run_lock(CRON_DIR / ".scheduler.lock") as got:
        if not got:
            hc.log("The scheduler is already running here")
            return 1
        children: list[subprocess.Popen] = []
        stopping = []

        def on_stop(*_args) -> None:
            stopping.append(True)

        if os.name == "posix":
            signal.signal(signal.SIGTERM, on_stop)
            signal.signal(signal.SIGINT, on_stop)
        jobs = load_jobs()
        hc.log(f"Scheduler started: {len(jobs or [])} jobs, times in {zone().key}")
        last_minute = None
        while not stopping and (rounds is None or rounds > 0):
            now = datetime.fromtimestamp(clock(), timezone.utc)
            if minute_of(now) != last_minute:
                last_minute = minute_of(now)
                try:
                    children += [c for _, c in start_due(now, spawn) if isinstance(c, subprocess.Popen)]
                except Exception as exc:  # a broken jobs.json must not stop the service
                    hc.log(f"Could not check the schedule: {exc.__class__.__name__}: {exc}")
                if rounds is not None:
                    rounds -= 1
            children = [c for c in children if c.poll() is None]
            beat({"running": len(children)})
            sleep(max(1.0, min(15.0, 60 - datetime.fromtimestamp(clock(), timezone.utc).second)))
        for child in children:
            with contextlib.suppress(OSError):
                child.terminate()
        for child in children:
            with contextlib.suppress(subprocess.TimeoutExpired):
                child.wait(timeout=STOP_GRACE + 5)
        hc.log("Scheduler stopped")
        return 0


# --------------------------------------------------------------------------- command line

def show(jobs: list[dict]) -> str:
    rows = [("ID", "NAME", "SCHEDULE", "STATE", "LAST RUN", "RESULT")]
    for j in jobs:
        rows.append((j["id"], str(j.get("name", "")), expression(j), "active" if enabled(j) else "paused",
                     str(j.get("last_run_at") or "-")[:16].replace("T", " "), str(j.get("last_status") or "-")))
    widths = [max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
    return "\n".join("  ".join(c.ljust(w) for c, w in zip(r, widths)).rstrip() for r in rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="HermitShell's scheduler.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run", help="keep running and start every job on time")
    sub.add_parser("tick", help="start the jobs due now, then exit (from a system crontab)")
    listing = sub.add_parser("list", help="show the jobs")
    listing.add_argument("--json", action="store_true")
    new = sub.add_parser("create", help="add a job")
    new.add_argument("schedule")
    new.add_argument("title")
    new.add_argument("--name", required=True)
    new.add_argument("--script", required=True)
    new.add_argument("--workdir")
    new.add_argument("--paused", action="store_true")
    edit = sub.add_parser("edit", help="change a job's schedule")
    edit.add_argument("job")
    edit.add_argument("--schedule", required=True)
    for verb in ("pause", "resume", "remove", "start", "exec"):
        sub.add_parser(verb).add_argument("job")
    defaults = sub.add_parser("defaults", help="add the packages' standard jobs that are missing")
    defaults.add_argument("--if-new", action="store_true", help="only when there is no jobs file yet")
    imp = sub.add_parser("import", help="take over the jobs of another jobs.json whose scripts are installed here")
    imp.add_argument("file")
    imp.add_argument("--map", action="append", default=[], metavar="OLD=NEW", help="move job folders")
    sub.add_parser("health", help="exit 0 while the service is running")
    args = parser.parse_args(argv)

    try:
        if args.cmd == "run":
            return serve()
        if args.cmd == "tick":
            start_due(datetime.now(timezone.utc), subprocess.Popen, detach=True)
            beat({"mode": "tick"})
            return 0
        if args.cmd == "health":
            return 0 if healthy() else 1
        if args.cmd == "list":
            jobs = load_jobs() or []
            print(json.dumps(jobs, indent=2) if args.json else show(jobs))
            return 0
        if args.cmd == "create":
            job = create(args.schedule, args.title, args.name, args.script, args.workdir, args.paused)
            print(f"created {job['id']} {job['name']} ({expression(job)})")
        elif args.cmd == "edit":
            job = change(args.job, expr=args.schedule)
            print(f"{job['name']}: {expression(job)}")
        elif args.cmd in ("pause", "resume"):
            job = change(args.job, enabled=args.cmd == "resume", state="scheduled" if args.cmd == "resume" else "paused")
            print(f"{job['name']}: {'active' if enabled(job) else 'paused'}")
        elif args.cmd == "remove":
            print(f"removed {remove(args.job)['name']}")
        elif args.cmd in ("start", "exec"):
            return execute(args.job)
        elif args.cmd == "defaults":
            added = add_defaults(args.if_new)
            print(f"added {', '.join(added)}" if added else "no jobs to add")
        elif args.cmd == "import":
            mapping = [tuple(m.split("=", 1)) for m in args.map if "=" in m]
            taken = import_jobs(Path(args.file), mapping)
            print(f"imported {', '.join(taken)}" if taken else "no jobs to import")
    except ScheduleError as exc:
        print(f"scheduler: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""The server model picked under Global settings: downloading it through Ollama and switching to it.

Picking a model Ollama already has switches to it at once (OLLAMA_MODEL in the dashboard's settings, which beat
.env). Any other model is downloaded first by this script, run in the background by profiles.py:

- it streams Ollama's /api/pull, keeping state/model_pull.json up to date (the model, MB done of the total and when
  it started), which the dashboard shows as a task with a progress bar and the admin's dashboard as a notice;
- it refuses to start when the disk the server's state lives on has too little room for the download;
- once the download is complete it switches to the model, unless it was stopped from the dashboard's task list.

    python3 model_pull.py MODEL          download MODEL and switch to it (what the dashboard starts)
    python3 model_pull.py MODEL --keep   download it without switching
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

import hermes_common as hc
from hermes_common import log

SCRIPT_DIR = Path(__file__).resolve().parent
STATE_FILE = hc.STATE_DIR / "model_pull.json"
LOCK_FILE = hc.STATE_DIR / "model_pull.lock"
# Ollama names: name[/namespace[/repo]][:tag], as `ollama pull` takes them (hf.co/owner/repo:quant included).
NAME_RE = re.compile(r"^(?=.{1,120}\Z)[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*){0,2}(?::[A-Za-z0-9][A-Za-z0-9._-]*)?\Z")
TASK_ID = "model:pull"
STATES = ("downloading", "ready", "failed", "cancelled")
# A download refused when less than this would be left on the disk afterwards.
DISK_SPARE_MB = 2048
PULL_TIMEOUT = 600
WRITE_EVERY = 2.0
PUSH_EVERY = 15.0
# A finished download is shown on the dashboard this long.
SHOW_FOR = 86400
# How long a download just started may go without its process id before it counts as stopped.
STARTING = 60


def _num(value, high: float = 1 << 50) -> float:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= high else 0


def same(a: str, b: str) -> bool:
    """Whether two Ollama names are the same model (a name without a tag means :latest)."""
    tagged = lambda n: n if ":" in n.rsplit("/", 1)[-1] else f"{n}:latest"  # noqa: E731
    return bool(a and b) and tagged(a) == tagged(b)


def ollama() -> tuple[str, list[dict]] | None:
    """The first Ollama that answers and the models it has (/api/tags), or None."""
    for host in hc.ollama_hosts(hc.model_config()):
        try:
            resp = hc.requests.get(f"{host}/api/tags", timeout=2)
            resp.raise_for_status()
            models = resp.json().get("models", [])
        except (hc.requests.RequestException, ValueError, AttributeError):
            continue
        return host, [m for m in models if isinstance(m, dict)] if isinstance(models, list) else []
    return None


def read() -> dict:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write(data: dict) -> None:
    hc.write_atomic(STATE_FILE, json.dumps(data))


def _alive(pid: int) -> bool:
    if pid <= 1:
        return False
    try:
        return "model_pull.py" in Path(f"/proc/{pid}/cmdline").read_bytes().decode("utf-8", "replace")
    except OSError:
        return False


def info(now: float | None = None) -> dict | None:
    """The download for the dashboard, checked field by field: None when there is none to show. A download whose
    process has gone without saying how it ended is reported as stopped."""
    now = time.time() if now is None else now
    data = read()
    model, status = str(data.get("model") or ""), data.get("status")
    if not NAME_RE.match(model) or status not in STATES:
        return None
    pid = int(_num(data.get("pid"), 1 << 22))
    starting = not pid and now - _num(data.get("started"), 1e11) < STARTING
    if status == "downloading" and not starting and not _alive(pid):
        status = "cancelled" if data.get("cancel") else "failed"
        data["error"] = data.get("error") or "the download stopped before it finished"
        data["finished"] = data.get("finished") or data.get("updated") or now
    finished = _num(data.get("finished"), 1e11)
    if status != "downloading" and (not finished or now - finished > SHOW_FOR):
        return None
    return {"model": model, "status": status, "done_mb": int(_num(data.get("done"))) >> 20,
            "total_mb": int(_num(data.get("total"))) >> 20, "started": int(_num(data.get("started"), 1e11) * 1000),
            "finished": int(finished * 1000) or None, "error": str(data.get("error") or "")[:200] if status == "failed" else "",
            "switch": data.get("switch") is not False, "stopping": bool(data.get("cancel")) and status == "downloading"}


def task(now: float | None = None) -> dict | None:
    """The running download as one of the dashboard's tasks (profiles.tasks)."""
    d = info(now)
    if not d or d["status"] != "downloading":
        return None
    return {"id": TASK_ID, "kind": "model", "u": "", "state": "stopping" if d["stopping"] else "running",
            "at": d["started"], "trigger": "dashboard", "title": d["model"], "stage": "Downloading",
            "done": d["done_mb"], "total": d["total_mb"]}


def running() -> bool:
    d = info()
    return bool(d and d["status"] == "downloading")


def start(model: str, switch: bool = True, spawn=None) -> None:
    """Download `model` in the background (profiles._background), refused while another download runs."""
    import profiles
    if not NAME_RE.match(model):
        raise profiles.ProfileError("invalid model name")
    if running():
        raise profiles.ProfileError(f"{read().get('model')} is still downloading; stop it in Tasks first")
    write({"model": model, "status": "downloading", "pid": 0, "started": time.time(), "updated": time.time(),
           "switch": switch, "done": 0, "total": 0})
    cmd = [sys.executable, str(SCRIPT_DIR / "model_pull.py"), model, *([] if switch else ["--keep"])]
    profiles._background(cmd, spawn)
    log(f"Started downloading the server model {model} from the dashboard")


def cancel() -> str:
    """Stop the download from the dashboard's task list; Ollama keeps what it has, so a new start resumes it."""
    import profiles
    data = read()
    if data.get("status") != "downloading":
        return "No server model download to stop"
    write({**data, "cancel": time.time()})
    pid = int(_num(data.get("pid"), 1 << 22))
    if profiles._signal(pid, "model_pull.py"):
        return f"Stopping the download of {data.get('model')}"
    write({**data, "cancel": time.time(), "status": "cancelled", "finished": time.time()})
    return f"The download of {data.get('model')} had already stopped"


def disk_free_mb() -> int | None:
    try:
        return shutil.disk_usage(hc.STATE_DIR if hc.STATE_DIR.is_dir() else hc.APP_HOME).free >> 20
    except OSError:
        return None


def pull(host: str, model: str, update, timeout: float = PULL_TIMEOUT) -> str:
    """Stream Ollama's download of `model`, calling update(done, total) as it goes. Returns "" or what went wrong."""
    layers: dict[str, tuple[int, int]] = {}
    checked = False
    try:
        with hc.requests.post(f"{host}/api/pull", json={"model": model, "stream": True}, stream=True,
                              timeout=(10, timeout)) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                event = json.loads(line)
                if not isinstance(event, dict):
                    continue
                if event.get("error"):
                    return f"Ollama: {str(event['error'])[:160]}"
                digest, total = str(event.get("digest") or ""), int(_num(event.get("total")))
                if digest and total:
                    layers[digest] = (int(_num(event.get("completed"), total)), total)
                    done, size = sum(d for d, _ in layers.values()), sum(t for _, t in layers.values())
                    if not checked and size > 50 << 20:
                        checked = True
                        free = disk_free_mb()
                        if free is not None and free - ((size - done) >> 20) < DISK_SPARE_MB:
                            return f"not enough disk space: {(size - done) >> 20} MB needed, {free} MB free"
                    update(done, size)
                if event.get("status") == "success":
                    return ""
    except (hc.requests.RequestException, ValueError) as exc:
        return f"the download failed ({exc.__class__.__name__})"
    return "Ollama stopped before the download finished"


def run(model: str, switch: bool = True, clock=time.monotonic) -> int:
    import profiles
    with hc.run_lock(LOCK_FILE) as got:
        if not got:
            log("Another server model download is running")
            return 1
        state = {**read(), "model": model, "status": "downloading", "pid": os.getpid(), "switch": switch,
                 "updated": time.time()}
        state.setdefault("started", time.time())
        state.pop("cancel", None)
        write(state)
        profiles.tasks_changed()
        found = ollama()
        marks = {"write": 0.0, "push": clock()}

        def update(done: int, total: int) -> None:
            state.update(done=done, total=total, updated=time.time())
            if clock() - marks["write"] >= WRITE_EVERY:
                marks["write"] = clock()
                write({**read(), **{k: state[k] for k in ("done", "total", "updated")}})
            if clock() - marks["push"] >= PUSH_EVERY:
                marks["push"] = clock()
                profiles.tasks_changed()

        error = pull(found[0], model, update) if found else "no Ollama server answers"
        if not error and found and not any(same(model, str(m.get("name", ""))) for m in (ollama() or ("", []))[1]):
            error = "Ollama finished but does not list the model"
        if read().get("cancel"):
            write({**state, "status": "cancelled", "cancel": True, "finished": time.time()})
            log(f"The download of {model} was stopped from the dashboard")
        elif error:
            write({**state, "status": "failed", "error": error[:200], "finished": time.time()})
            log(f"Could not download the server model {model}: {error}")
        else:
            if switch:
                profiles.update_dashboard_env({"OLLAMA_MODEL": model})
            write({**state, "status": "ready", "done": state.get("total", 0), "finished": time.time()})
            log(f"Downloaded the server model {model}{' and switched to it' if switch else ''}")
        profiles.tasks_changed()
        return 0 if not error else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("model")
    parser.add_argument("--keep", action="store_true", help="download without switching to it")
    args = parser.parse_args(argv)
    if not NAME_RE.match(args.model):
        parser.error("not an Ollama model name")
    return run(args.model, switch=not args.keep)


if __name__ == "__main__":
    sys.exit(main())

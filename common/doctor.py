#!/usr/bin/env python3
"""HermitShell doctor: checks everything the scripts need and, with --fix, sets up what it can.

Runs in the Python that runs the scripts (the setup wizard runs it after installing, and again at the end):

    python3 doctor.py              # report: ok / warn / FAIL for each check
    python3 doctor.py --fix        # also install missing packages, download the model, generate the data key
    python3 doctor.py --fix --only packages,ollama
    python3 doctor.py --json       # machine-readable, for the wizard

Checks: Python version; the Python packages (installed with --fix into scripts/.deps/pyX.Y, on the data volume,
using pip or uv, so they survive updates); the scheduler's jobs and whether it is running; Ollama
reachable with the model the scripts will use (downloaded with --fix); the .env file's permissions, the data
key, email and web search settings; the feedback Worker; free disk space. Exit code 1 when a check fails.
Uses only the standard library until `requests` is available, so it can repair a bare Python.
"""
from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEPS_DIR = SCRIPT_DIR / ".deps" / f"py{sys.version_info[0]}.{sys.version_info[1]}"
MIN_PYTHON = (3, 10)
# (module to import, pip name, minimum version, required). Keep in step with requirements.txt.
REQUIREMENTS = [
    ("requests", "requests", "2.32", True),
    ("cryptography", "cryptography", "44", True),
    ("PIL", "pillow", "10.4", False),
    ("yaml", "pyyaml", "6.0", False),
    ("websockets", "websockets", "13.0", False),
]
CHECKS = ("python", "packages", "scheduler", "ollama", "settings", "worker", "disk")
MIN_FREE_GB = 1.0
PULL_TIMEOUT = 3600


class Report:
    def __init__(self, as_json: bool = False):
        self.items: list[dict] = []
        self.as_json = as_json

    def add(self, check: str, status: str, message: str, fix: str = "", **data) -> None:
        self.items.append({"check": check, "status": status, "message": message, "fix": fix, **data})
        if not self.as_json:
            label = {"ok": "ok   ", "warn": "warn ", "fail": "FAIL ", "fixed": "fixed"}[status]
            print(f"  {label} {message}" + (f"\n         -> {fix}" if fix else ""), flush=True)

    def progress(self, message: str) -> None:
        if not self.as_json:
            print(f"        {message}", flush=True)

    @property
    def failed(self) -> bool:
        return any(i["status"] == "fail" for i in self.items)


def version_tuple(text: str) -> tuple[int, ...]:
    return tuple(int(p) for p in re.findall(r"\d+", text)[:3])


# --------------------------------------------------------------------------- python and packages

def check_python(report: Report, _fix: bool) -> None:
    current = ".".join(map(str, sys.version_info[:3]))
    if sys.version_info[:2] >= MIN_PYTHON:
        report.add("python", "ok", f"Python {current} ({sys.executable})")
    else:
        report.add("python", "fail", f"Python {current} is too old", f"use Python {'.'.join(map(str, MIN_PYTHON))}+")


def installed_version(module: str, dist: str) -> str | None:
    """The installed version of a package, or None when it can't be imported."""
    try:
        importlib.import_module(module)
    except Exception:
        return None
    try:
        return importlib.metadata.version(dist)
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def missing_packages() -> list[tuple[str, str, str, bool, str | None]]:
    found = []
    for module, dist, minimum, required in REQUIREMENTS:
        version = installed_version(module, dist)
        if version is None or (version != "unknown" and version_tuple(version) < version_tuple(minimum)):
            found.append((module, dist, minimum, required, version))
    return found


def installer(target: Path, specs: list[str]) -> list[str] | None:
    """A command installing `specs` into `target` with pip, or with uv when this Python has no pip."""
    if importlib.util.find_spec("pip"):
        return [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--upgrade",
                "--target", str(target), *specs]
    if uv := shutil.which("uv"):
        return [uv, "pip", "install", "--python", sys.executable, "--target", str(target), *specs]
    return None


def use_deps_dir() -> None:
    if DEPS_DIR.is_dir() and str(DEPS_DIR) not in sys.path:
        sys.path.insert(0, str(DEPS_DIR))
    importlib.invalidate_caches()


def check_packages(report: Report, fix: bool) -> None:
    use_deps_dir()
    missing = missing_packages()
    if missing and fix:
        cmd = installer(DEPS_DIR, [f"{dist}>={minimum}" for _, dist, minimum, _, _ in missing])
        if cmd is None:
            report.add("packages", "fail", "can't install packages: this Python has neither pip nor uv",
                       f"install them yourself: {' '.join(d for _, d, _, _, _ in missing)}")
            return
        DEPS_DIR.mkdir(parents=True, exist_ok=True)
        report.progress(f"installing {', '.join(d for _, d, _, _, _ in missing)} into {DEPS_DIR}")
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if res.returncode:
            report.progress((res.stdout + res.stderr).strip()[-600:])
        use_deps_dir()
        still = {d for _, d, _, _, _ in missing_packages()}
        for _, dist, _, _, _ in missing:
            if dist not in still:
                report.add("packages", "fixed", f"{dist} {installed_version_of(dist)} installed")
        missing = [m for m in missing if m[1] in still]
    for _, dist, minimum, required, version in missing:
        problem = f"{dist} {version} is older than {minimum}" if version else f"{dist} is not installed"
        what = "needed" if required else "optional"
        report.add("packages", "fail" if required else "warn", f"{problem} ({what})",
                   "" if fix else "run: python3 doctor.py --fix")
    if not missing:
        names = ", ".join(f"{d} {installed_version_of(d)}" for _, d, _, _ in REQUIREMENTS)
        report.add("packages", "ok", f"packages: {names}")


def installed_version_of(dist: str) -> str:
    try:
        return importlib.metadata.version(dist)
    except importlib.metadata.PackageNotFoundError:
        return "?"


# --------------------------------------------------------------------------- the rest needs hermes_common

def common():
    """hermes_common, importable once `requests` is (it loads .env and the dashboard settings)."""
    use_deps_dir()
    if str(SCRIPT_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPT_DIR))
    import hermes_common
    return hermes_common


def check_scheduler(report: Report, fix: bool) -> None:
    common()
    import scheduler
    jobs = scheduler.load_jobs()
    if jobs is None and fix:
        added = scheduler.add_defaults()
        report.add("scheduler", "fixed", f"added the standard jobs: {', '.join(added) or 'none'}")
        jobs = scheduler.load_jobs()
    if jobs is None:
        report.add("scheduler", "fail", f"no scheduled jobs ({scheduler.JOBS_FILE})",
                   "run: python3 doctor.py --fix --only scheduler (or the setup wizard)")
        return
    failing = [j["name"] for j in jobs if j.get("last_status") == "error"]
    report.add("scheduler", "warn" if failing else "ok",
               f"{len(jobs)} scheduled jobs ({sum(scheduler.enabled(j) for j in jobs)} active)"
               + (f"; last run failed: {', '.join(failing)}" if failing else ""),
               "see cron/output/<job id>/ for what they printed" if failing else "")
    if scheduler.healthy():
        report.add("scheduler", "ok", "the scheduler is running")
    else:
        report.add("scheduler", "fail", "the scheduler is not running, so nothing runs on time",
                   "start it: docker compose up -d (container), systemctl start hermitshell (service), "
                   "or sudo sh scripts/install-service.sh")


def ollama_plan(hc) -> tuple[list[str], list[str], str]:
    """(hosts to try, models the scripts accept in order, the model to download when none is there)."""
    cfg = hc.model_config()
    # A config.yaml model with no Ollama host (a cloud provider's name) is not one Ollama can have.
    if not cfg["host"] and not hc.env("OLLAMA_MODEL"):
        cfg["model"] = ""
    suggested = hc.suggested_model()
    models = [m for m in dict.fromkeys([hc.env("JOB_SCANNER_MODEL"), cfg["model"], suggested, hc.DEFAULT_MODEL]) if m]
    wanted = hc.env("JOB_SCANNER_MODEL") or hc.env("OLLAMA_MODEL") or suggested
    return hc.ollama_hosts(cfg), models, wanted


def autofit_download_mb(model: str) -> int:
    try:
        import autofit
    except ImportError:
        return 0
    return autofit.download_mb(model)


def cloud_models() -> list[str]:
    """The cloud model providers with a key (llm_providers.py), by name."""
    try:
        import llm_providers
    except ImportError:
        return []
    return [llm_providers.PROVIDERS[n]["label"] for n in llm_providers.configured()]


def ollama_models(hc, host: str) -> list[str] | None:
    try:
        resp = hc.requests.get(f"{host}/api/tags", timeout=5)
        resp.raise_for_status()
        return [m.get("name", "") for m in resp.json().get("models", [])]
    except (hc.requests.RequestException, ValueError):
        return None


def pull_model(hc, host: str, model: str, report: Report) -> bool:
    """Download a model through Ollama's API, reporting progress every 10%."""
    shown = -10
    try:
        with hc.requests.post(f"{host}/api/pull", json={"model": model, "stream": True}, stream=True,
                              timeout=(10, PULL_TIMEOUT)) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                event = json.loads(line)
                if event.get("error"):
                    report.progress(f"Ollama: {event['error']}")
                    return False
                total, done = event.get("total") or 0, event.get("completed") or 0
                if total and (pct := int(done * 100 / total)) >= shown + 10:
                    shown = pct - pct % 10
                    report.progress(f"downloading {model}: {shown}%")
                if event.get("status") == "success":
                    return True
    except (hc.requests.RequestException, ValueError) as exc:
        report.progress(f"download failed: {exc.__class__.__name__}")
    return False


def check_ollama(report: Report, fix: bool, model: str | None = None, pull: bool = True) -> None:
    hc = common()
    hosts, models, wanted = ollama_plan(hc)
    if model:
        models, wanted = [model], model
    reachable = {h: names for h in hosts if (names := ollama_models(hc, h)) is not None}
    cloud = cloud_models()
    if not reachable and cloud:
        report.add("ollama", "warn", f"no Ollama server answers, so every request goes to {', '.join(cloud)}",
                   "start Ollama too, so reports still run when the cloud models are out of credits",
                   host="", model="", wanted=wanted)
        return
    if not reachable:
        report.add("ollama", "fail", f"no Ollama server answers at {', '.join(hosts)}",
                   "start Ollama (the wizard can start a container for it) or set OLLAMA_HOST in .env",
                   host="", model="", wanted=wanted)
        return
    for host, names in reachable.items():
        if found := next((m for m in models if m in names), None):
            report.add("ollama", "ok", f"Ollama at {host} has {found}", host=host, model=found, wanted=wanted)
            check_placement(report, host, found)
            return
    host = next(iter(reachable))
    if not (fix and pull):
        mb = autofit_download_mb(wanted)
        size = f"about {mb / 1000:.1f} GB" if mb else "a few GB"
        report.add("ollama", "warn" if cloud else "fail", f"Ollama at {host} has none of {', '.join(models)}",
                   f"run: python3 doctor.py --fix --only ollama   (downloads {wanted}, {size}, picked for this machine)",
                   host=host, model="", wanted=wanted)
        return
    report.progress(f"downloading {wanted} to Ollama at {host} (a few GB; this can take a while)")
    if pull_model(hc, host, wanted, report):
        report.add("ollama", "fixed", f"downloaded {wanted} to Ollama at {host}", host=host, model=wanted, wanted=wanted)
    else:
        report.add("ollama", "fail", f"could not download {wanted}", f"on the Ollama machine run: ollama pull {wanted}",
                   host=host, model="", wanted=wanted)


def check_placement(report: Report, host: str, model: str) -> None:
    """Where the model runs, and a warning when the machine has a GPU that Ollama isn't using."""
    try:
        import autofit
    except ImportError:
        return
    if not autofit.enabled():
        return
    hw = autofit.hardware()
    placed = autofit.placement(host, model)
    loaded = {"ctx": placed[0], "size_mb": placed[1], "gpu_mb": placed[2]} if placed else None
    gpus = ", ".join(f"{g['name'] or 'GPU'} ({g['vram_mb']} MB)" for g in hw["gpus"])
    cpu = hw["cpu"]
    fix = "restart Ollama (docker restart ollama), then keep it on the GPU: docs/installation.md#use-the-gpu"
    if hw["ollama_gpu"] == "lost" or (gpus and loaded and loaded["size_mb"] and not loaded["gpu_mb"]):
        report.add("ollama", "warn", f"this machine has {gpus}, but Ollama is running {model} on the CPU", fix)
    elif hw["ollama_gpu"] == "none":
        report.add("ollama", "warn", f"this machine has {gpus}, but the Ollama container has no GPU access",
                   "recreate it with the GPU: docs/installation.md#use-the-gpu")
    else:
        report.add("ollama", "ok", f"{model}: {autofit.where(loaded)}; "
                   + (f"GPU: {gpus}" if gpus else f"no GPU found, CPU: {cpu['physical']} cores / {cpu['logical']} threads"))


# --------------------------------------------------------------------------- settings, worker, disk

def sealed_files_exist(hc) -> bool:
    roots = [hc.STATE_DIR]
    return any(hc.is_sealed(p) for root in roots if root.is_dir() for p in root.rglob("*")
               if p.is_file() and not p.is_symlink() and p.stat().st_size >= len(hc.SEALED))


def add_env_line(path: Path, key: str, value: str) -> None:
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    with open(path, "a", encoding="utf-8", newline="\n") as fh:
        fh.write(("" if not text or text.endswith("\n") else "\n") + f"{key}={value}\n")
    if os.name == "posix":
        os.chmod(path, 0o600)


def check_settings(report: Report, fix: bool) -> None:
    hc = common()
    env_path = hc.APP_HOME / ".env"
    if not env_path.is_file():
        report.add("settings", "warn", f"no {env_path}", "run the setup wizard: python3 scripts/setup.py")
    elif os.name == "posix" and env_path.stat().st_mode & 0o077:
        if fix:
            os.chmod(env_path, 0o600)
            report.add("settings", "fixed", f"{env_path} is now readable by its owner only")
        else:
            report.add("settings", "warn", f"{env_path} is readable by other accounts", f"chmod 600 {env_path}")
    if hc.env(hc.DATA_KEY_ENV):
        try:
            hc.unseal(hc.seal(b"check"))
            report.add("settings", "ok", "data key set: CVs, profiles, letters and backups are encrypted")
        except hc.DataKeyError as exc:
            report.add("settings", "fail", str(exc))
    elif sealed_files_exist(hc):
        report.add("settings", "fail", f"encrypted files exist but {hc.DATA_KEY_ENV} is not set",
                   "put the key back in .env from your password manager (a new key can't open them)")
    elif fix and env_path.parent.is_dir():
        key = hc.new_data_key()
        add_env_line(env_path, hc.DATA_KEY_ENV, key)
        os.environ[hc.DATA_KEY_ENV] = key
        report.add("settings", "fixed", f"generated {hc.DATA_KEY_ENV} in {env_path}",
                   "copy it into a password manager: without it the encrypted files and backups can't be read")
    else:
        report.add("settings", "warn", f"{hc.DATA_KEY_ENV} not set: personal files and backups are not encrypted",
                   "run: python3 doctor.py --fix --only settings")
    if hc.env("SMTP_USER") and hc.env("SMTP_PASSWORD"):
        report.add("settings", "ok", f"email: {hc.env('SMTP_HOST', 'smtp.gmail.com')} as {hc.env('SMTP_USER')}")
    else:
        report.add("settings", "warn", "SMTP_USER / SMTP_PASSWORD not set: reports can't be emailed",
                   "set them in the wizard or on the Worker's dashboard")
    keys = [k for k in ("FIRECRAWL_API_KEY", "TAVILY_API_KEY", "SCRAPFLY_API_KEY") if hc.env(k)]
    if keys:
        report.add("settings", "ok", f"web search keys: {', '.join(k.split('_')[0].title() for k in keys)}")
    else:
        report.add("settings", "warn", "no web search key (Firecrawl, Tavily or Scrapfly)",
                   "all three have free plans; see docs/web-providers.md")


def check_worker(report: Report, _fix: bool) -> None:
    hc = common()
    base = hc.env("JOB_FEEDBACK_URL", "")
    if not base:
        report.add("worker", "warn", "no feedback Worker (JOB_FEEDBACK_URL): no buttons, cover letters or /admin",
                   "the wizard deploys one from a Cloudflare API token")
        return
    try:
        status = hc.requests.get(base.rstrip("/") + "/", timeout=10).status_code
    except hc.requests.RequestException as exc:
        report.add("worker", "warn", f"feedback Worker unreachable ({exc.__class__.__name__})")
        return
    report.add("worker", "ok" if status == 200 else "warn", f"feedback Worker answers (HTTP {status})")


def check_disk(report: Report, _fix: bool) -> None:
    hc = common()
    folder = hc.APP_HOME if hc.APP_HOME.is_dir() else SCRIPT_DIR
    free = shutil.disk_usage(folder).free / 1e9
    report.add("disk", "ok" if free >= MIN_FREE_GB else "warn", f"{free:.1f} GB free in {folder}",
               "" if free >= MIN_FREE_GB else "backups and the model need space")


# --------------------------------------------------------------------------- command line

def run(only: list[str], fix: bool, report: Report, model: str | None = None, pull: bool = True) -> None:
    steps = {"python": check_python, "packages": check_packages, "scheduler": check_scheduler,
             "ollama": lambda r, f: check_ollama(r, f, model, pull), "settings": check_settings,
             "worker": check_worker, "disk": check_disk}
    for name in only:
        if name not in ("python", "packages") and installed_version("requests", "requests") is None:
            report.add(name, "fail", "skipped: the requests package is missing", "run: python3 doctor.py --fix")
            continue
        try:
            steps[name](report, fix)
        except Exception as exc:  # one broken check must not hide the others
            report.add(name, "fail", f"check failed: {exc.__class__.__name__}: {exc}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check (and with --fix, set up) what HermitShell needs.")
    parser.add_argument("--fix", action="store_true", help="install packages, download the model, make the data key")
    parser.add_argument("--only", help=f"comma-separated checks: {','.join(CHECKS)}")
    parser.add_argument("--model", help="the Ollama model to check (and download with --fix)")
    parser.add_argument("--no-pull", action="store_true", help="never download a model")
    parser.add_argument("--json", action="store_true", help="print the results as JSON")
    args = parser.parse_args(argv)
    only = [c.strip() for c in (args.only or ",".join(CHECKS)).split(",") if c.strip()]
    if unknown := set(only) - set(CHECKS):
        parser.error(f"unknown check(s): {', '.join(sorted(unknown))}")
    report = Report(args.json)
    if not args.json:
        print("HermitShell doctor" + (" (fixing what it can)" if args.fix else ""))
    run(only, args.fix, report, args.model, not args.no_pull)
    if args.json:
        print(json.dumps(report.items))
    elif report.failed:
        print("\nSome checks failed; see the -> hints above.")
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())

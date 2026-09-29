#!/usr/bin/env python3
"""Autofit: runs each model request where it is fastest, and keeps adjusting.

For every request it picks the Ollama instance, the context size, and when needed the GPU layers and CPU threads,
from what it knows about the machine and what Ollama reported after earlier loads:

- The machine: state/hardware.json, written every few minutes on the host by scripts/host/ollama-watchdog.sh
  (CPU, memory, GPUs and whether Ollama can still see them), or nvidia-smi and /proc when the scripts run on the
  Ollama machine itself.
- Ollama: after a load, /api/ps says how much of the model sits on the GPU at that context size, so autofit learns
  how much fits and picks the smallest standard context (8k, 16k, 32k, 64k) that holds the prompt and keeps the
  model on the GPU. Without a GPU it keeps the configured context size (OLLAMA_NUM_CTX), so the loaded model is shared, not reloaded.
- Threads: when most of the model runs on the CPU it tries Ollama's default (one per core) against every logical
  CPU and keeps whichever answers faster.
- Instances: OLLAMA_HOSTS adds more Ollama servers (one per GPU, or another machine). Requests are spread over
  them, an instance that fails rests for a while, and one that is much slower than the fastest is left out.

The watchdog steps down after out-of-memory errors or when RAM runs low (a leaner context, then fewer GPU layers,
then the CPU only) and back up one step at a time once requests have gone well for half an hour. What it learns is
kept in state/autofit.json. HERMES_AUTOFIT=off sends requests exactly as the scripts ask.

    python3 autofit.py               what it knows about this machine and what it would do now
    python3 autofit.py --json
    python3 autofit.py --calibrate   loads the model at a few context sizes to learn what fits on the GPU
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hermes_common as hc  # noqa: E402

BUCKETS = (8192, 16384, 32768, 65536)
LEVELS = ("normal", "lean context", "fewer GPU layers", "CPU only")
HARDWARE_FILE = hc.STATE_DIR / "hardware.json"
STATE_FILE = hc.STATE_DIR / "autofit.json"
HARDWARE_MAX_AGE = 3600
GPU_RESERVE_MB = 1152
RAISE_AFTER = 1800
RAISE_OK = 5
SLOW_RATIO = 4.0
PROBE_BENCHED = 3600
THREAD_SAMPLES = 3
THREAD_RETRY = 7 * 86400
GPU_UNUSED_HOLD = 600
TYPICAL = (2500, 300)
MAX_POINTS = 12
MEMORY_ERROR = re.compile(r"out of memory|cudaMalloc|CUDA error|more system memory|unable to allocate|"
                          r"insufficient memory|failed to allocate|runner process has terminated", re.I)
_HOST_RE = re.compile(r"^https?://[A-Za-z0-9.-]{1,253}(:\d{1,5})?$")
_lock = threading.Lock()


# --------------------------------------------------------------------------- small helpers

def _num(value, low: float, high: float, default=0):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    if n != n or not low <= n <= high:
        return default
    return int(n) if isinstance(default, int) else n


def _text(value, limit: int = 80) -> str:
    return re.sub(r"[^A-Za-z0-9 ._()/+-]", "", str(value or ""))[:limit].strip()


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def enabled() -> bool:
    return (hc.env("HERMES_AUTOFIT", "auto") or "auto").lower() not in {"off", "0", "no", "false"}


def bucket(needed: int) -> int:
    return next((b for b in BUCKETS if b >= needed), BUCKETS[-1])


def needed_tokens(chars: int, num_predict: int) -> int:
    return chars // 3 + num_predict + 256


# --------------------------------------------------------------------------- the machine

def local_cpu() -> dict:
    logical, cores, avx2, name = 0, set(), False, ""
    phys = core = ""
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="replace").splitlines():
            key, _, value = line.partition(":")
            key, value = key.strip(), value.strip()
            if key == "processor":
                logical += 1
            elif key == "physical id":
                phys = value
            elif key == "core id":
                core = value
                cores.add((phys, core))
            elif key == "model name" and not name:
                name = value
            elif key == "flags" and " avx2" in f" {value}":
                avx2 = True
    except OSError:
        pass
    logical = logical or os.cpu_count() or 1
    return {"model": _text(name), "logical": logical, "physical": len(cores) or logical, "avx2": avx2}


def local_memory() -> dict:
    info = {}
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition(":")
            if key in ("MemTotal", "MemAvailable"):
                info[key] = int(value.split()[0]) // 1024
    except (OSError, ValueError, IndexError):
        pass
    return {"total": info.get("MemTotal", 0), "available": info.get("MemAvailable", 0)}


_local_gpus: list | None = None


def local_gpus() -> list[dict]:
    """NVIDIA GPUs on this machine, read once per process (nvidia-smi is missing inside most containers)."""
    global _local_gpus
    if _local_gpus is None:
        _local_gpus = []
        if smi := shutil.which("nvidia-smi"):
            try:
                out = subprocess.run([smi, "--query-gpu=index,name,memory.total,memory.free,compute_cap",
                                      "--format=csv,noheader,nounits"], capture_output=True, text=True,
                                     timeout=10, check=False).stdout
            except (OSError, subprocess.SubprocessError):
                out = ""
            for line in out.splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 4:
                    _local_gpus.append(_gpu({"index": parts[0], "name": parts[1], "vram_mb": parts[2],
                                             "free_mb": parts[3], "compute": parts[4] if len(parts) > 4 else ""}))
    return _local_gpus


def _gpu(raw: dict) -> dict:
    return {"index": _num(raw.get("index"), 0, 64), "name": _text(raw.get("name")),
            "vram_mb": _num(raw.get("vram_mb"), 0, 1 << 22), "free_mb": _num(raw.get("free_mb"), 0, 1 << 22),
            "compute": _text(raw.get("compute"), 8)}


def hardware(now: float | None = None) -> dict:
    """CPU, memory and GPUs of the machine Ollama runs on: the host's report when it is fresh, else this machine."""
    now = time.time() if now is None else now
    report = _read_json(HARDWARE_FILE)
    age = now - _num(report.get("at"), 0, 1 << 40)
    fresh = bool(report) and -300 <= age <= HARDWARE_MAX_AGE
    memory = local_memory()
    if fresh:
        cpu = report.get("cpu") if isinstance(report.get("cpu"), dict) else {}
        cpu = {"model": _text(cpu.get("model")), "logical": _num(cpu.get("logical"), 1, 4096, 1),
               "physical": _num(cpu.get("physical"), 1, 4096, 1), "avx2": cpu.get("avx2") is True}
        gpus = [_gpu(g) for g in report.get("gpus", [])[:16] if isinstance(g, dict)]
        seen = str(report.get("ollama_gpu", ""))
        ram = report.get("ram_mb") if isinstance(report.get("ram_mb"), dict) else {}
        memory = {"total": _num(ram.get("total"), 0, 1 << 24) or memory["total"],
                  "available": _num(ram.get("available"), 0, 1 << 24) or memory["available"]}
        return {"source": "host report", "age": int(max(age, 0)), "cpu": cpu, "gpus": gpus, "ram_mb": memory,
                "ollama_gpu": seen if seen in ("ok", "lost", "none") else ""}
    return {"source": "this machine", "age": 0, "cpu": local_cpu(), "gpus": local_gpus(), "ram_mb": memory,
            "ollama_gpu": ""}


def memory_low(hw: dict) -> bool:
    total, available = hw["ram_mb"]["total"], hw["ram_mb"]["available"]
    return bool(total) and (available < 1024 or available < total * 0.05)


# --------------------------------------------------------------------------- state

def _load() -> dict:
    data = _read_json(STATE_FILE)
    hosts = data.get("hosts") if isinstance(data.get("hosts"), dict) else {}
    models = data.get("models") if isinstance(data.get("models"), dict) else {}
    return {"hosts": {h: _host(v) for h, v in list(hosts.items())[:16] if _HOST_RE.match(str(h))},
            "models": {str(m)[:120]: _model(v) for m, v in list(models.items())[:16]}}


def _host(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    threads = raw.get("threads") if isinstance(raw.get("threads"), dict) else {}
    return {
        "level": _num(raw.get("level"), 0, len(LEVELS) - 1),
        "changed": _num(raw.get("changed"), 0, 1 << 40),
        "ok": _num(raw.get("ok"), 0, 1 << 30),
        "fails": _num(raw.get("fails"), 0, 64),
        "down_until": _num(raw.get("down_until"), 0, 1 << 40),
        "cost": _num(raw.get("cost"), 0, 1e6, 0.0),
        "samples": _num(raw.get("samples"), 0, 1 << 30),
        "used": _num(raw.get("used"), 0, 1 << 40),
        "budget_mb": _num(raw.get("budget_mb"), 0, 1 << 22),
        "fits_mb": _num(raw.get("fits_mb"), 0, 1 << 22),
        "gpu_unused": _num(raw.get("gpu_unused"), 0, 1 << 40),
        "share": _num(raw.get("share"), 0, 1, 0.0),
        "ctx": _num(raw.get("ctx"), 0, 1 << 20),
        "why": _text(raw.get("why"), 160),
        "threads": {k: [_num(v[0], 0, 1e6, 0.0), _num(v[1], 0, 1 << 20), _num(v[2], 0, 1 << 40)]
                    for k, v in list(threads.items())[:4]
                    if re.fullmatch(r"auto|\d{1,4}", str(k)) and isinstance(v, list) and len(v) == 3},
    }


def _model(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    points = [[_num(p[0], 256, 1 << 20), _num(p[1], 1, 1 << 22), _num(p[2], 0, 1 << 22)]
              for p in raw.get("points", [])[:MAX_POINTS] if isinstance(p, list) and len(p) == 3]
    return {"layers": _num(raw.get("layers"), 0, 1024), "file_mb": _num(raw.get("file_mb"), 0, 1 << 22),
            "kv_kb": _num(raw.get("kv_kb"), 0, 1 << 20, 0.0), "points": [p for p in points if p[0] and p[1]]}


def _save(state: dict) -> None:
    try:
        hc.write_atomic(STATE_FILE, json.dumps(state, separators=(",", ":")))
    except OSError as exc:
        hc.log(f"autofit: could not save {STATE_FILE.name}: {exc.__class__.__name__}")


@contextlib.contextmanager
def _state():
    """The state, locked against other threads and processes, saved on the way out."""
    with _lock:
        fd = None
        try:
            import fcntl
            STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(STATE_FILE.with_suffix(".lock"), os.O_RDWR | os.O_CREAT, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
        except (ImportError, OSError):
            pass
        try:
            state = _load()
            yield state
            _save(state)
        finally:
            if fd is not None:
                os.close(fd)


def _host_state(state: dict, host: str) -> dict:
    return state["hosts"].setdefault(host, _host({}))


# --------------------------------------------------------------------------- what fits where

def model_info(host: str, model: str, state: dict) -> dict:
    """Layers, KV cache per token and file size, asked of Ollama once and remembered."""
    info = state["models"].setdefault(model[:120], _model({}))
    if info["layers"] and info["file_mb"]:
        return info
    try:
        show = hc.requests.post(f"{host}/api/show", json={"model": model}, timeout=10).json()
        tags = hc.requests.get(f"{host}/api/tags", timeout=5).json()
    except (hc.requests.RequestException, ValueError):
        return info
    meta = show.get("model_info") if isinstance(show.get("model_info"), dict) else {}
    arch = str(meta.get("general.architecture", ""))

    def field(name):
        return _num(meta.get(f"{arch}.{name}"), 0, 1 << 20)
    layers, kv_heads = field("block_count"), field("attention.head_count_kv") or field("attention.head_count")
    head_dim = field("attention.key_length") or (field("embedding_length") // max(1, field("attention.head_count")))
    info["layers"] = layers
    info["kv_kb"] = round(2 * layers * kv_heads * head_dim * 1.1 / 1024, 1)
    for m in tags.get("models", []) if isinstance(tags, dict) else []:
        if isinstance(m, dict) and m.get("name") == model:
            info["file_mb"] = _num(m.get("size"), 0, 1 << 50) >> 20
    return info


def size_mb(info: dict, ctx: int) -> float:
    """The model's footprint at a context size: a straight line through what Ollama reported, else an estimate."""
    points = sorted({p[0]: p for p in info["points"]}.values())
    if len(points) >= 2:
        n = len(points)
        mx, my = sum(p[0] for p in points) / n, sum(p[1] for p in points) / n
        var = sum((p[0] - mx) ** 2 for p in points)
        slope = sum((p[0] - mx) * (p[1] - my) for p in points) / var if var else info["kv_kb"] / 1024
        return my + slope * (ctx - mx)
    slope = (info["kv_kb"] or 80) / 1024
    if points:
        return points[0][1] + slope * (ctx - points[0][0])
    return (info["file_mb"] or 0) + 300 + slope * ctx


def gpu_budget(hw: dict, h: dict, now: float) -> int:
    """MB of the model Ollama can keep on the GPUs, or 0 when there is no usable GPU."""
    if hw["ollama_gpu"] in ("lost", "none") or (h["gpu_unused"] and now - h["gpu_unused"] < GPU_UNUSED_HOLD):
        return 0
    if h["budget_mb"]:
        return h["budget_mb"]
    total = sum(max(0, g["vram_mb"] - GPU_RESERVE_MB) for g in hw["gpus"])
    return max(total, h["fits_mb"])


def gpu_context(default: int | None, needed: int, fits) -> int:
    """The configured context when it fits on the GPU (the loaded model is shared), else the smallest standard size that
    fits, else the smallest that holds the prompt (the most of the model on the GPU)."""
    options = ([default] if default and default >= needed else []) + [b for b in BUCKETS if b >= needed]
    for ctx in dict.fromkeys(options):
        if fits(ctx):
            return ctx
    return bucket(needed) if needed <= BUCKETS[-1] else max(default or 0, needed)


def instances(primary: str) -> list[str]:
    extra = [h.strip().rstrip("/") for h in (hc.env("OLLAMA_HOSTS") or "").split(",")]
    return list(dict.fromkeys([primary.rstrip("/")] + [h for h in extra if _HOST_RE.match(h)]))[:8]


def active(state: dict, primary: str, now: float) -> list[str]:
    """The instances to use now: not resting after failures, and not far slower than the fastest (a slow one is
    tried again every hour, so it can come back)."""
    primary = primary.rstrip("/")
    pool = [h for h in instances(primary) if h == primary or _host_state(state, h)["down_until"] <= now]
    costs = {h: state["hosts"][h]["cost"] for h in pool
             if h in state["hosts"] and state["hosts"][h]["samples"] >= 3 and state["hosts"][h]["cost"]}
    best = min(costs.values(), default=0)
    keep = [h for h in pool if not best or h not in costs or costs[h] <= best * SLOW_RATIO
            or now - state["hosts"][h]["used"] >= PROBE_BENCHED]
    return keep or [primary]


def slots(primary: str) -> int:
    """How many requests may run at once: HERMES_MODEL_CONCURRENCY, or one per active instance."""
    fixed = hc.env("HERMES_MODEL_CONCURRENCY", "auto") or "auto"
    if fixed.isdigit():
        return max(1, min(16, int(fixed)))
    if not enabled() or len(instances(primary)) == 1:
        return 1
    with _lock:
        return len(active(_load(), primary, time.time()))


def pick_threads(h: dict, hw: dict, share: float, now: float) -> int | None:
    """None for Ollama's default, else a thread count that measured faster (only when the CPU does most work)."""
    if (fixed := hc.env("HERMES_AUTOFIT_THREADS")) and fixed.isdigit():
        return max(1, min(1024, int(fixed)))
    logical, physical = hw["cpu"]["logical"], hw["cpu"]["physical"]
    if share >= 0.5 or logical <= physical:
        return None
    stats = {k: v for k, v in h["threads"].items() if now - v[2] < THREAD_RETRY}
    for key in ("auto", str(logical)):
        if stats.get(key, [0, 0, 0])[1] < THREAD_SAMPLES:
            return None if key == "auto" else logical
    best = min(stats, key=lambda k: stats[k][0])
    return None if best == "auto" else int(best)


# --------------------------------------------------------------------------- per request

def choose(host: str, model: str, num_ctx: int | None, chars: int, num_predict: int,
           slot: int | None = None) -> tuple[str, dict]:
    """(the instance, the options to add) for one request."""
    host = host.rstrip("/")
    if not enabled():
        return host, ({"num_ctx": num_ctx} if num_ctx else {})
    now = time.time()
    hw = hardware(now)
    needed = needed_tokens(chars, num_predict)
    with _state() as state:
        pool = active(state, host, now)
        target = pool[(slot or 0) % len(pool)]
        h = _host_state(state, target)
        h["used"] = now
        level = max(h["level"], 1 if memory_low(hw) else 0)
        budget = gpu_budget(hw, h, now)
        info = model_info(target, model, state) if budget else _model({})
        ctx = num_ctx
        if level >= 1:
            lean = bucket(needed)
            ctx = min(lean, num_ctx) if num_ctx and num_ctx >= needed else lean
        elif budget:
            ctx = gpu_context(num_ctx, needed, lambda c: size_mb(info, c) <= budget)
        options: dict = {"num_ctx": ctx} if ctx else {}
        footprint = size_mb(info, ctx or BUCKETS[0]) if budget else 0
        share = min(1.0, budget / footprint) if footprint > 0 else 0.0
        if level >= 3:
            options["num_gpu"], share = 0, 0.0
        elif level == 2 and info["layers"]:
            options["num_gpu"] = int(info["layers"] * share * 0.75)
            share *= 0.75
        if (threads := pick_threads(h, hw, share, now)) is not None:
            options["num_thread"] = threads
    return target, options


def placement(host: str, model: str) -> tuple[int, int, int] | None:
    try:
        loaded = hc.requests.get(f"{host}/api/ps", timeout=3).json().get("models", [])
    except (hc.requests.RequestException, ValueError, AttributeError):
        return None
    for m in loaded if isinstance(loaded, list) else []:
        if isinstance(m, dict) and m.get("name") == model:
            return (_num(m.get("context_length"), 0, 1 << 20), _num(m.get("size"), 0, 1 << 50) >> 20,
                    _num(m.get("size_vram"), 0, 1 << 50) >> 20)
    return None


def _learn(state: dict, h: dict, model: str, options: dict, placed: tuple[int, int, int], hw: dict, now: float):
    ctx, size, vram = placed
    if not size:
        return
    info = state["models"].setdefault(model[:120], _model({}))
    if ctx and "num_gpu" not in options:
        info["points"] = ([p for p in info["points"] if p[0] != ctx] + [[ctx, size, vram]])[-MAX_POINTS:]
        if vram >= size:
            h["fits_mb"] = max(h["fits_mb"], size)
        elif vram:
            h["budget_mb"] = max(h["budget_mb"], vram)
    h["share"], h["ctx"] = round(vram / size, 3), ctx
    if hw["gpus"] and not vram and options.get("num_gpu") != 0 and hw["ollama_gpu"] != "none":
        if not h["gpu_unused"] or now - h["gpu_unused"] >= GPU_UNUSED_HOLD:
            hc.log("autofit: Ollama is not using the GPU this machine has; running on the CPU until it can "
                   "(the host watchdog restarts Ollama when it loses the GPU)")
        h["gpu_unused"] = now
    elif vram:
        h["gpu_unused"] = 0


def record(host: str, model: str, options: dict, reply: dict) -> None:
    """Learn from a finished request: its speed, and after a load, how much of the model went on the GPU."""
    if not enabled() or not isinstance(reply, dict):
        return
    prompt_n, gen_n = _num(reply.get("prompt_eval_count"), 0, 1 << 30), _num(reply.get("eval_count"), 0, 1 << 30)
    if not prompt_n and not gen_n:
        return
    prompt_s = _num(reply.get("prompt_eval_duration"), 0, 1 << 60) / 1e9
    gen_s = _num(reply.get("eval_duration"), 0, 1 << 60) / 1e9
    loaded = _num(reply.get("load_duration"), 0, 1 << 60) / 1e9 > 1
    host, now = host.rstrip("/"), time.time()
    hw = hardware(now)
    with _state() as state:
        h = _host_state(state, host)
        h["ok"] += 1
        h["fails"], h["down_until"] = 0, 0
        if prompt_n >= 50 and gen_n >= 10 and prompt_s > 0 and gen_s > 0:
            cost = TYPICAL[0] * prompt_s / prompt_n + TYPICAL[1] * gen_s / gen_n
            h["cost"] = round(cost if not h["samples"] else 0.7 * h["cost"] + 0.3 * cost, 2)
            h["samples"] += 1
            key = str(options["num_thread"]) if "num_thread" in options else "auto"
            old = h["threads"].get(key, [0.0, 0, now])
            if now - old[2] >= THREAD_RETRY:
                old = [0.0, 0, now]
            h["threads"][key] = [round(cost if not old[1] else 0.7 * old[0] + 0.3 * cost, 2), old[1] + 1, old[2]]
        if loaded or not h["ctx"]:
            if placed := placement(host, model):
                _learn(state, h, model, options, placed, hw, now)
        if h["level"] and now - h["changed"] >= RAISE_AFTER and h["ok"] >= RAISE_OK:
            h["level"] -= 1
            h["changed"], h["ok"] = now, 0
            h["why"] = f"stepped back up after {RAISE_OK}+ good requests"
            hc.log(f"autofit: {host}: requests have gone well, stepping back up to {LEVELS[h['level']]}")


def failed(host: str, model: str, options: dict, exc: BaseException) -> None:
    """A request failed: step down after a memory error, rest an instance that is down or broken."""
    if not enabled():
        return
    text = str(exc)
    response = getattr(exc, "response", None)
    with contextlib.suppress(Exception):
        text += " " + str(response.text)[:500]
    host, now = host.rstrip("/"), time.time()
    with _state() as state:
        h = _host_state(state, host)
        h["ok"] = 0
        if MEMORY_ERROR.search(text):
            if h["level"] < len(LEVELS) - 1:
                h["level"] += 1
                h["why"] = "out of memory"
                hc.log(f"autofit: {host} ran out of memory; stepping down to {LEVELS[h['level']]}")
            h["changed"] = now
        elif not isinstance(exc, hc.requests.Timeout):
            h["fails"] = min(h["fails"] + 1, 64)
            h["down_until"] = now + min(3600, 30 * 2 ** min(h["fails"], 7))


# --------------------------------------------------------------------------- report and calibration

def describe(host: str, model: str, num_ctx: int | None = None) -> dict:
    """What autofit knows and would do for a typical job rating."""
    now = time.time()
    hw = hardware(now)
    target, options = choose(host, model, num_ctx, 9000, 900)
    with _lock:
        state = _load()
    h = state["hosts"].get(target, _host({}))
    placed = placement(target, model)
    return {"hardware": hw, "instances": instances(host), "active": active(state, host, now), "slots": slots(host),
            "plan": {"instance": target, **options}, "level": LEVELS[h["level"]], "why": h["why"],
            "typical_seconds": h["cost"] or None, "budget_mb": gpu_budget(hw, h, now),
            "loaded": {"ctx": placed[0], "size_mb": placed[1], "gpu_mb": placed[2]} if placed else None}


def where(loaded: dict | None) -> str:
    if not loaded or not loaded["size_mb"]:
        return "not loaded right now"
    pct = round(100 * loaded["gpu_mb"] / loaded["size_mb"])
    place = "on the GPU" if pct >= 100 else "on the CPU" if pct == 0 else f"{pct}% on the GPU, the rest on the CPU"
    return f"loaded at {loaded['ctx']} context, {place}"


def calibrate(host: str, model: str, num_ctx: int | None) -> list[str]:
    """Load the model at each standard size (and the configured one) to learn what fits on the GPU and how fast it is."""
    lines = []
    prompt = "Summarise in one sentence: " + "a data engineer building pipelines for analytics teams. " * 60

    def ask(ctx: int, text: str, predict: int):
        body = {"model": model, "stream": False, "keep_alive": "5m",
                "options": {"temperature": 0, "num_predict": predict, "num_ctx": ctx},
                "messages": [{"role": "user", "content": text}]}
        return hc.requests.post(f"{host}/api/chat", json=body, timeout=600)

    # The first request after Ollama starts also sets up the GPU, which would make the first size look slow.
    try:
        ask(BUCKETS[0], "Hi", 4)
    except hc.requests.RequestException:
        pass
    for ctx in dict.fromkeys([c for c in (*BUCKETS, num_ctx) if c]):
        try:
            reply = ask(ctx, prompt, 40)
            reply.raise_for_status()
            data = reply.json()
        except (hc.requests.RequestException, ValueError) as exc:
            failed(host, model, {"num_ctx": ctx}, exc)
            lines.append(f"{ctx:>6} context: failed ({exc.__class__.__name__})")
            continue
        data["load_duration"] = max(_num(data.get("load_duration"), 0, 1 << 60), int(2e9))
        record(host, model, {"num_ctx": ctx}, data)
        placed = placement(host, model)
        loaded = {"ctx": ctx, "size_mb": placed[1], "gpu_mb": placed[2]} if placed else None
        speed = _num(data.get("eval_count"), 0, 1 << 30) / max(_num(data.get("eval_duration"), 0, 1 << 60) / 1e9, 1e-3)
        lines.append(f"{ctx:>6} context: {where(loaded)}, {speed:.1f} tokens/s")
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    parser.add_argument("--calibrate", action="store_true", help="load the model at a few sizes to learn what fits")
    args = parser.parse_args(argv)
    try:
        host, model, num_ctx = hc.connect_model("JOB_SCANNER_MODEL")
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 3
    if args.calibrate:
        for line in calibrate(host, model, num_ctx):
            print(line)
    info = describe(host, model, num_ctx)
    if args.json:
        print(json.dumps(info, indent=2))
        return 0
    hw, cpu = info["hardware"], info["hardware"]["cpu"]
    print(f"Machine ({hw['source']}): {cpu['model'] or 'CPU'}, {cpu['physical']} cores / {cpu['logical']} threads"
          f"{', AVX2' if cpu['avx2'] else ''}; RAM {hw['ram_mb']['available'] / 1024:.1f} of "
          f"{hw['ram_mb']['total'] / 1024:.1f} GB free")
    for g in hw["gpus"]:
        print(f"GPU {g['index']}: {g['name']}, {g['vram_mb']} MB" + (f", compute {g['compute']}" if g["compute"] else ""))
    if not hw["gpus"]:
        print("GPU: none found")
    if hw["ollama_gpu"] == "lost":
        print("  Ollama has lost access to the GPU; the host watchdog restarts it")
    plan = info["plan"]
    print(f"Model {model} on {plan['instance']}: {where(info['loaded'])}")
    print(f"For a job rating: {plan.get('num_ctx') or 'default'} context"
          + (", CPU only" if plan.get("num_gpu") == 0 else f", {plan['num_gpu']} GPU layers" if "num_gpu" in plan else "")
          + (f", {plan['num_thread']} threads" if "num_thread" in plan else ", Ollama's default threads")
          + (f"; about {info['typical_seconds']:.0f}s each" if info["typical_seconds"] else ""))
    print(f"Watchdog: {info['level']}" + (f" ({info['why']})" if info["why"] else ""))
    print(f"Instances: {len(info['active'])} of {len(info['instances'])} in use, {info['slots']} request(s) at once")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

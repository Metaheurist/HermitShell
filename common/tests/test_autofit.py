"""Unit tests for autofit: where each model request runs, and the watchdog that steps settings down and up.

The fake Ollama reports placements like a 4 GB GPU with a 4B model: about 2.4 GB of weights plus 84 KB per token.
"""

import json
import sys
import time
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import autofit  # noqa: E402
import hermes_common as hc  # noqa: E402

HOST, MODEL = "http://ollama:11434", "qwen3:4b"
GTX = {"index": 0, "name": "NVIDIA GeForce GTX 970", "vram_mb": 4096, "free_mb": 4000, "compute": "5.2"}


class Reply:
    def __init__(self, payload, status=200, text=""):
        self.payload, self.status_code, self.text = payload, status, text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} error", response=self)

    def json(self):
        return self.payload


class FakeOllama:
    """/api/show, /api/tags, /api/ps and /api/chat for one or more instances."""

    def __init__(self, budget_mb=2939, gpu=True):
        self.budget, self.gpu, self.loaded, self.chats, self.fail = budget_mb, gpu, {}, [], {}

    @staticmethod
    def size(ctx):
        return int(2416 + 0.0837 * ctx)

    def get(self, url, timeout):
        host, path = url.rsplit("/api/", 1)
        if path == "tags":
            return Reply({"models": [{"name": MODEL, "size": 2497 << 20}]})
        if path == "ps":
            ctx = self.loaded.get(host)
            if not ctx:
                return Reply({"models": []})
            size = self.size(ctx)
            vram = min(size, self.budget) if self.gpu else 0
            return Reply({"models": [{"name": MODEL, "context_length": ctx, "size": size << 20,
                                      "size_vram": vram << 20}]})
        raise AssertionError(url)

    def post(self, url, json, timeout):
        host, path = url.rsplit("/api/", 1)
        if path == "show":
            return Reply({"model_info": {"general.architecture": "qwen3", "qwen3.block_count": 36,
                                         "qwen3.attention.head_count_kv": 8, "qwen3.attention.key_length": 128}})
        assert path == "chat"
        if host in self.fail:
            raise self.fail[host]
        self.chats.append((host, json["options"]))
        load = 3e9 if self.loaded.get(host) != json["options"].get("num_ctx") else 0
        self.loaded[host] = json["options"].get("num_ctx") or 65536
        return Reply({"message": {"content": "ok"}, "prompt_eval_count": 2500, "prompt_eval_duration": int(9e9),
                      "eval_count": 300, "eval_duration": int(12e9), "load_duration": int(load)})


@pytest.fixture
def fit(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_AUTOFIT", "auto")
    for key in ("OLLAMA_HOSTS", "HERMES_MODEL_CONCURRENCY", "HERMES_AUTOFIT_THREADS"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(autofit, "HARDWARE_FILE", tmp_path / "hardware.json")
    monkeypatch.setattr(autofit, "STATE_FILE", tmp_path / "autofit.json")
    monkeypatch.setattr(autofit, "local_gpus", lambda: [])
    monkeypatch.setattr(autofit, "local_cpu", lambda: {"model": "Test CPU", "logical": 8, "physical": 4, "avx2": True})
    monkeypatch.setattr(autofit, "local_memory", lambda: {"total": 24000, "available": 14000})
    ollama = FakeOllama()
    monkeypatch.setattr(hc.requests, "get", ollama.get)
    monkeypatch.setattr(hc.requests, "post", ollama.post)

    def report(gpus=(GTX,), seen="ok", **extra):
        data = {"at": int(time.time()), "cpu": {"model": "Xeon", "logical": 36, "physical": 18, "avx2": True},
                "ram_mb": {"total": 24000, "available": 14000}, "gpus": list(gpus), "ollama_gpu": seen, **extra}
        (tmp_path / "hardware.json").write_text(json.dumps(data), encoding="utf-8")
    ollama.report = report
    ollama.state = lambda: json.loads((tmp_path / "autofit.json").read_text(encoding="utf-8"))
    return ollama


def chat(ollama, num_ctx=65536, chars=9000, predict=900, host=HOST, slot=0):
    target, options = autofit.choose(host, MODEL, num_ctx, chars, predict, slot)
    reply = hc.requests.post(f"{target}/api/chat", json={"options": options}, timeout=600)
    autofit.record(target, MODEL, options, reply.json())
    return target, options


# --------------------------------------------------------------------------- basics

def test_buckets_hold_the_prompt_and_the_answer():
    assert autofit.needed_tokens(9000, 900) == 4156
    assert [autofit.bucket(n) for n in (100, 8192, 8193, 40000, 10 ** 6)] == [8192, 8192, 16384, 65536, 65536]


def test_off_sends_requests_as_asked(fit, monkeypatch):
    fit.report()
    monkeypatch.setenv("HERMES_AUTOFIT", "off")
    assert autofit.choose(HOST, MODEL, 65536, 9000, 900) == (HOST, {"num_ctx": 65536})
    assert autofit.choose(HOST, MODEL, None, 9000, 900) == (HOST, {})
    autofit.record(HOST, MODEL, {}, {"eval_count": 10, "prompt_eval_count": 100})
    assert not autofit.STATE_FILE.exists()


def test_without_a_gpu_hermes_context_is_kept_so_the_loaded_model_is_shared(fit):
    assert autofit.choose(HOST, MODEL, 65536, 9000, 900) == (HOST, {"num_ctx": 65536})
    assert autofit.choose(HOST, MODEL, None, 9000, 900) == (HOST, {})


# --------------------------------------------------------------------------- the GPU

def test_with_a_gpu_the_smallest_context_that_holds_the_prompt_is_used(fit):
    fit.report()
    target, options = autofit.choose(HOST, MODEL, 65536, 9000, 900)
    assert (target, options) == (HOST, {"num_ctx": 8192})


def test_hermes_context_is_kept_when_it_fits_on_the_gpu(fit):
    fit.report(gpus=[dict(GTX, vram_mb=24576)])
    assert autofit.choose(HOST, MODEL, 32768, 9000, 900)[1] == {"num_ctx": 32768}


def test_a_long_prompt_gets_a_bigger_context(fit):
    fit.report()
    assert autofit.choose(HOST, MODEL, 65536, 60000, 2000)[1] == {"num_ctx": 32768}


def test_what_fits_is_learned_from_ollama_after_each_load(fit):
    fit.report(gpus=[dict(GTX, vram_mb=24576)])
    chat(fit, num_ctx=65536)
    state = fit.state()["hosts"][HOST]
    assert state["ctx"] == 65536 and state["share"] == pytest.approx(0.37, abs=0.01)
    assert state["budget_mb"] == 2939
    assert autofit.choose(HOST, MODEL, 65536, 9000, 900)[1] == {"num_ctx": 8192}
    chat(fit, num_ctx=65536)
    assert fit.state()["hosts"][HOST]["share"] == pytest.approx(0.95, abs=0.01)
    points = fit.state()["models"][MODEL]["points"]
    assert sorted(p[0] for p in points) == [8192, 65536]
    info = autofit._model(fit.state()["models"][MODEL])
    assert autofit.size_mb(info, 16384) == pytest.approx(FakeOllama.size(16384), abs=5)


def test_a_lost_gpu_is_noticed_and_hermes_context_is_used_until_it_is_back(fit, capsys):
    fit.report()
    fit.gpu = False
    chat(fit)
    assert "not using the GPU" in capsys.readouterr().err
    assert fit.state()["hosts"][HOST]["gpu_unused"] > 0
    assert autofit.choose(HOST, MODEL, 65536, 9000, 900)[1] == {"num_ctx": 65536}


def test_the_host_report_saying_the_gpu_is_lost_stops_gpu_sizing(fit):
    fit.report(seen="lost")
    assert autofit.choose(HOST, MODEL, 65536, 9000, 900)[1] == {"num_ctx": 65536}


# --------------------------------------------------------------------------- the watchdog

def test_out_of_memory_steps_down_and_good_requests_step_back_up(fit, monkeypatch, capsys):
    fit.report()
    oom = requests.HTTPError("500", response=Reply({}, 500, '{"error":"CUDA error: out of memory"}'))
    autofit.failed(HOST, MODEL, {}, oom)
    assert fit.state()["hosts"][HOST]["level"] == 1
    assert autofit.choose(HOST, MODEL, 65536, 9000, 900)[1] == {"num_ctx": 8192}
    autofit.failed(HOST, MODEL, {}, oom)
    _, options = autofit.choose(HOST, MODEL, 65536, 9000, 900)
    assert options["num_ctx"] == 8192 and 0 < options["num_gpu"] < 36
    autofit.failed(HOST, MODEL, {}, oom)
    autofit.failed(HOST, MODEL, {}, oom)
    assert fit.state()["hosts"][HOST]["level"] == 3
    assert autofit.choose(HOST, MODEL, 65536, 9000, 900)[1]["num_gpu"] == 0
    assert "stepping down to CPU only" in capsys.readouterr().err

    for _ in range(autofit.RAISE_OK):
        chat(fit)
    assert fit.state()["hosts"][HOST]["level"] == 3, "not before half an hour"
    later = time.time() + autofit.RAISE_AFTER + 1
    monkeypatch.setattr(autofit.time, "time", lambda: later)
    chat(fit)
    assert fit.state()["hosts"][HOST]["level"] == 2
    assert "stepping back up to fewer GPU layers" in capsys.readouterr().err


def test_low_memory_uses_the_lean_context_without_changing_the_level(fit, monkeypatch):
    monkeypatch.setattr(autofit, "local_memory", lambda: {"total": 24000, "available": 600})
    assert autofit.choose(HOST, MODEL, 65536, 9000, 900)[1] == {"num_ctx": 8192}
    assert fit.state()["hosts"][HOST]["level"] == 0


def test_a_timeout_does_not_step_down_or_rest_the_instance(fit):
    autofit.failed(HOST, MODEL, {}, requests.Timeout())
    state = fit.state()["hosts"][HOST]
    assert state["level"] == 0 and state["down_until"] == 0


# --------------------------------------------------------------------------- threads

def test_a_gpu_is_learned_from_ollama_even_without_the_host_report(fit):
    chat(fit)
    assert fit.state()["hosts"][HOST]["budget_mb"] == 2939
    assert autofit.choose(HOST, MODEL, 65536, 9000, 900)[1] == {"num_ctx": 8192}


def test_threads_are_tried_both_ways_on_the_cpu_and_the_faster_is_kept(fit, monkeypatch):
    fit.gpu = False
    seen = []
    for _ in range(2 * autofit.THREAD_SAMPLES):
        seen.append(chat(fit)[1].get("num_thread"))
    assert seen == [None] * 3 + [8] * 3
    state = autofit._load()
    state["hosts"][HOST]["threads"]["8"][0] = 1.0
    autofit._save(state)
    assert autofit.choose(HOST, MODEL, 65536, 9000, 900)[1]["num_thread"] == 8
    state["hosts"][HOST]["threads"]["auto"][0] = 0.5
    autofit._save(state)
    assert "num_thread" not in autofit.choose(HOST, MODEL, 65536, 9000, 900)[1]


def test_threads_are_left_alone_when_the_gpu_does_most_of_the_work(fit):
    fit.report()
    for _ in range(4):
        assert "num_thread" not in chat(fit)[1]


def test_a_fixed_thread_count_wins(fit, monkeypatch):
    monkeypatch.setenv("HERMES_AUTOFIT_THREADS", "12")
    assert autofit.choose(HOST, MODEL, 65536, 9000, 900)[1]["num_thread"] == 12


# --------------------------------------------------------------------------- instances

def test_requests_are_spread_over_instances_and_a_failed_one_rests(fit, monkeypatch):
    monkeypatch.setenv("OLLAMA_HOSTS", "http://ollama-gpu1:11435, http://ollama-gpu1:11435/")
    assert autofit.instances(HOST) == [HOST, "http://ollama-gpu1:11435"]
    assert autofit.slots(HOST) == 2
    assert chat(fit, slot=0)[0] == HOST and chat(fit, slot=1)[0] == "http://ollama-gpu1:11435"
    autofit.failed("http://ollama-gpu1:11435", MODEL, {}, requests.ConnectionError("refused"))
    assert autofit.slots(HOST) == 1
    assert autofit.choose(HOST, MODEL, None, 9000, 900, slot=1)[0] == HOST
    later = time.time() + 61
    monkeypatch.setattr(autofit.time, "time", lambda: later)
    assert autofit.slots(HOST) == 2


def test_an_instance_far_slower_than_the_fastest_is_left_out_and_tried_hourly(fit, monkeypatch):
    slow = "http://cpu-box:11434"
    monkeypatch.setenv("OLLAMA_HOSTS", slow)
    state = autofit._load()
    now = time.time()
    state["hosts"][HOST] = autofit._host({"cost": 11, "samples": 5, "used": now})
    state["hosts"][slow] = autofit._host({"cost": 60, "samples": 5, "used": now})
    autofit._save(state)
    assert autofit.slots(HOST) == 1
    monkeypatch.setattr(autofit.time, "time", lambda: now + autofit.PROBE_BENCHED + 1)
    assert autofit.slots(HOST) == 2


def test_a_fixed_concurrency_wins(fit, monkeypatch):
    monkeypatch.setenv("HERMES_MODEL_CONCURRENCY", "3")
    assert autofit.slots(HOST) == 3


def test_ollama_chat_uses_the_slot_instance_and_falls_back_to_the_primary(fit, monkeypatch):
    extra = "http://ollama-gpu1:11435"
    monkeypatch.setenv("OLLAMA_HOSTS", extra)
    turns = []

    class Turn:
        def __init__(self, slot):
            self.slot = slot

        def __enter__(self):
            return self.slot

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(hc, "model_turn", lambda slots=None, **_: turns.append(slots) or Turn(1))
    assert hc.ollama_chat(HOST, MODEL, "system", "user " * 100, 65536) == "ok"
    assert fit.chats[-1][0] == extra and turns == [2]
    fit.fail[extra] = requests.ConnectionError("down")
    assert hc.ollama_chat(HOST, MODEL, "system", "user", 65536) == "ok"
    assert fit.chats[-1][0] == HOST
    assert fit.state()["hosts"][extra]["fails"] == 1


# --------------------------------------------------------------------------- report

def test_hardware_prefers_a_fresh_host_report(fit):
    fit.report()
    hw = autofit.hardware()
    assert hw["source"] == "host report" and hw["gpus"][0]["name"] == "NVIDIA GeForce GTX 970"
    assert hw["cpu"]["logical"] == 36 and hw["ollama_gpu"] == "ok"
    assert autofit.hardware(time.time() + autofit.HARDWARE_MAX_AGE + 60)["source"] == "this machine"


def test_describe_and_where_say_where_the_model_runs(fit):
    fit.report()
    chat(fit)
    info = autofit.describe(HOST, MODEL, 65536)
    assert info["plan"] == {"instance": HOST, "num_ctx": 8192} and info["level"] == "normal"
    assert autofit.where(info["loaded"]) == "loaded at 8192 context, 95% on the GPU, the rest on the CPU"
    assert autofit.where({"ctx": 4096, "size_mb": 10, "gpu_mb": 10}).endswith("on the GPU")
    assert autofit.where({"ctx": 4096, "size_mb": 10, "gpu_mb": 0}).endswith("on the CPU")
    assert autofit.where(None) == "not loaded right now"


def test_known_says_where_the_model_ran_last_without_asking_ollama(fit, monkeypatch):
    assert autofit.known([HOST]) == {}
    fit.report()
    chat(fit)
    monkeypatch.setattr(hc.requests, "get", lambda *a, **k: pytest.fail("known() must not ask Ollama"))
    info = autofit.known(["http://elsewhere:11434", HOST])
    assert info["where"] == "8192 context, 95% on the GPU, the rest on the CPU" and info["level"] == "normal"
    assert info["seconds"]


def _machine(ram, *vram):
    return {"gpus": [{**GTX, "vram_mb": v} for v in vram], "ram_mb": {"total": ram, "available": ram // 2}}


@pytest.mark.parametrize("hw,expected", [
    (_machine(4000), "qwen2.5:1.5b-instruct"),
    (_machine(4000, 2048), "qwen2.5:1.5b-instruct"),
    (_machine(4000, 4096), hc.DEFAULT_MODEL),
    (_machine(16000), hc.DEFAULT_MODEL),
    (_machine(32000, 12288), hc.DEFAULT_MODEL),
    (_machine(64000), "qwen3:30b-a3b-instruct-2507-q4_K_M"),
    (_machine(16000, 8192, 24576), "qwen3:30b-a3b-instruct-2507-q4_K_M"),
    (_machine(0), hc.DEFAULT_MODEL),
])
def test_the_suggested_model_fits_the_machine(fit, hw, expected):
    assert autofit.suggested_model(hw) == expected


def test_the_suggested_model_is_the_default_when_autofit_is_off(fit, monkeypatch):
    monkeypatch.setenv("HERMES_AUTOFIT", "off")
    assert autofit.suggested_model(_machine(4000)) == hc.DEFAULT_MODEL
    assert autofit.download_mb(hc.DEFAULT_MODEL) == 2500 and autofit.download_mb("other:1b") == 0


def test_calibrate_learns_each_standard_size(fit):
    fit.report()
    lines = autofit.calibrate(HOST, MODEL, 65536)
    assert [line.split()[0] for line in lines] == ["8192", "16384", "32768", "65536"]
    assert "95% on the GPU" in lines[0] and "tokens/s" in lines[0]
    assert len(fit.state()["models"][MODEL]["points"]) == 4
    assert fit.chats[0][1]["num_predict"] == 4 and len(fit.chats) == 5


def test_main_prints_the_machine_and_the_plan(fit, monkeypatch, capsys):
    fit.report()
    monkeypatch.setattr(hc, "connect_model", lambda _: (HOST, MODEL, 65536))
    assert autofit.main([]) == 0
    out = capsys.readouterr().out
    assert "18 cores / 36 threads" in out and "GTX 970" in out and "For a job rating: 8192 context" in out

"""Unit tests for the server model picked under Global settings: model_pull.py (downloading through Ollama and
switching) and profiles.py's local_model action, task and status (no network: Ollama is faked)."""

import json
import sys
import time
from pathlib import Path

import pytest
import requests

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import autofit  # noqa: E402
import hermes_common as hc  # noqa: E402
import model_pull  # noqa: E402
import profiles  # noqa: E402

REAL_OLLAMA = model_pull.ollama
SEVEN = "qwen2.5:7b-instruct-q4_K_M"


@pytest.fixture
def pull(tmp_path, monkeypatch):
    monkeypatch.setattr(model_pull, "STATE_FILE", tmp_path / "model_pull.json")
    monkeypatch.setattr(model_pull, "LOCK_FILE", tmp_path / "model_pull.lock")
    monkeypatch.setattr(profiles, "DASHBOARD_FILE", tmp_path / "dashboard.json")
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    (tmp_path / "profiles").mkdir()
    monkeypatch.setattr(profiles.os, "environ", dict(profiles.os.environ))
    monkeypatch.setattr(profiles, "load_env_file", lambda *a: None)
    monkeypatch.setattr(autofit, "hardware", lambda: {"gpus": [], "ram_mb": {"total": 24000, "available": 12000}})
    monkeypatch.setattr(model_pull, "disk_free_mb", lambda: 50_000)
    pushes = []
    monkeypatch.setattr(profiles, "tasks_changed", lambda: pushes.append(time.time()))
    have = {"names": [hc.DEFAULT_MODEL]}
    monkeypatch.setattr(model_pull, "ollama", lambda: ("http://ollama", [{"name": n, "size": 1 << 30} for n in have["names"]]))
    return {"tmp": tmp_path, "pushes": pushes, "have": have}


class Stream:
    def __init__(self, events, status=200):
        self.events, self.status_code = events, status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} error")

    def iter_lines(self):
        for e in self.events:
            yield e if isinstance(e, bytes) else json.dumps(e).encode()


def layer(done, total=4700 << 20, digest="sha256:aa"):
    return {"status": "pulling", "digest": digest, "completed": done, "total": total}


def test_names_are_ollama_names_and_nothing_else():
    for good in (SEVEN, "llama3", "qwen3:8b", "hf.co/Owner/Repo-GGUF:Q4_K_M", "library/mistral:7b"):
        assert model_pull.NAME_RE.match(good), good
    for bad in ("", "-x", "a b", "x;rm -rf /", "a/b/c/d", "x:", ":tag", "a" * 121, "../etc", "x\n", "http://x/y"):
        assert not model_pull.NAME_RE.match(bad), bad
    assert model_pull.same("llama3", "llama3:latest") and model_pull.same("hf.co/o/r", "hf.co/o/r:latest")
    assert not model_pull.same("qwen3:4b", "qwen3:8b") and not model_pull.same("", "")


def test_the_real_ollama_lookup_tries_each_host(monkeypatch):
    monkeypatch.setattr(hc, "ollama_hosts", lambda cfg: ["http://down:11434", "http://up:11434"])

    class Tags(Stream):
        def json(self):
            return {"models": [{"name": "a:1b"}, "junk"]}

    def get(url, timeout):
        if "down" in url:
            raise requests.ConnectionError("refused")
        return Tags([])
    monkeypatch.setattr(hc.requests, "get", get)
    assert REAL_OLLAMA() == ("http://up:11434", [{"name": "a:1b"}])
    monkeypatch.setattr(hc, "ollama_hosts", lambda cfg: ["http://down:11434"])
    assert REAL_OLLAMA() is None


def test_info_reports_a_download_and_hides_old_ones(pull, monkeypatch):
    now = time.time()
    model_pull.write({"model": SEVEN, "status": "downloading", "pid": 4242, "started": now - 30, "done": 1 << 30,
                      "total": 4 << 30, "switch": True})
    monkeypatch.setattr(model_pull, "_alive", lambda pid: pid == 4242)
    info = model_pull.info(now)
    assert info["status"] == "downloading" and info["done_mb"] == 1024 and info["total_mb"] == 4096 and info["switch"]
    assert model_pull.task(now) == {"id": "model:pull", "kind": "model", "u": "", "state": "running",
                                    "at": info["started"], "trigger": "dashboard", "title": SEVEN,
                                    "stage": "Downloading", "done": 1024, "total": 4096}
    # Its process gone without a word: stopped, and shown as failed (or cancelled, when it was stopped from Tasks).
    monkeypatch.setattr(model_pull, "_alive", lambda pid: False)
    assert model_pull.info(now)["status"] == "failed" and "stopped" in model_pull.info(now)["error"]
    model_pull.write({**model_pull.read(), "cancel": now})
    assert model_pull.info(now)["status"] == "cancelled" and model_pull.task(now) is None
    # Just started, before the process has written its id: still downloading.
    model_pull.write({"model": SEVEN, "status": "downloading", "pid": 0, "started": now - 5})
    assert model_pull.info(now)["status"] == "downloading"
    assert model_pull.info(now + 120)["status"] == "failed"
    # A finished download shows for a day, then not at all.
    model_pull.write({"model": SEVEN, "status": "ready", "finished": now - 60, "total": 4 << 30})
    assert model_pull.info(now)["status"] == "ready" and model_pull.task(now) is None
    assert model_pull.info(now + model_pull.SHOW_FOR) is None


@pytest.mark.parametrize("data", [{}, {"model": "x;y", "status": "ready", "finished": 1}, {"model": SEVEN, "status": "odd"},
                                  {"model": SEVEN, "status": "ready", "finished": "soon", "done": -5}])
def test_info_ignores_a_broken_state_file(pull, data):
    model_pull.write(data)
    assert model_pull.info() is None


def test_info_keeps_errors_short_and_only_for_failures(pull):
    model_pull.write({"model": SEVEN, "status": "failed", "finished": time.time(), "error": "x" * 500})
    assert len(model_pull.info()["error"]) == 200
    model_pull.write({"model": SEVEN, "status": "ready", "finished": time.time(), "error": "old"})
    assert model_pull.info()["error"] == ""


def test_pull_streams_progress_across_layers(pull, monkeypatch):
    seen = []
    events = [{"status": "pulling manifest"}, layer(0), layer(2 << 30), layer(10, 2048, "sha256:bb"), b"",
              layer(4700 << 20), layer(2048, 2048, "sha256:bb"), {"status": "verifying"}, {"status": "success"}]
    monkeypatch.setattr(hc.requests, "post", lambda url, json, stream, timeout: Stream(events))
    assert model_pull.pull("http://ollama", SEVEN, lambda d, t: seen.append((d, t))) == ""
    assert seen[0] == (0, 4700 << 20) and seen[-1] == ((4700 << 20) + 2048, (4700 << 20) + 2048)


@pytest.mark.parametrize("events,expected", [
    ([{"error": "pull model manifest: file does not exist"}], "Ollama: pull model manifest"),
    ([layer(0)], "Ollama stopped before"),
    ([b"not json"], "the download failed (JSONDecodeError)"),
])
def test_pull_reports_what_went_wrong(pull, monkeypatch, events, expected):
    monkeypatch.setattr(hc.requests, "post", lambda *a, **k: Stream(events))
    assert model_pull.pull("http://ollama", SEVEN, lambda d, t: None).startswith(expected)


def test_pull_refuses_to_fill_the_disk(pull, monkeypatch):
    monkeypatch.setattr(model_pull, "disk_free_mb", lambda: 5000)
    monkeypatch.setattr(hc.requests, "post", lambda *a, **k: Stream([layer(0), {"status": "success"}]))
    assert model_pull.pull("http://ollama", SEVEN, lambda d, t: None).startswith("not enough disk space: 4700 MB needed")


def test_pull_survives_a_dropped_connection(pull, monkeypatch):
    def post(*a, **k):
        raise requests.ConnectionError("reset")
    monkeypatch.setattr(hc.requests, "post", post)
    assert model_pull.pull("http://ollama", SEVEN, lambda d, t: None) == "the download failed (ConnectionError)"


def test_run_downloads_switches_and_tells_the_dashboard(pull, monkeypatch):
    def post(url, json, stream, timeout):
        assert url == "http://ollama/api/pull" and json == {"model": SEVEN, "stream": True}
        pull["have"]["names"].append(SEVEN)
        return Stream([layer(0), layer(4700 << 20), {"status": "success"}])
    monkeypatch.setattr(hc.requests, "post", post)
    ticks = iter(range(0, 1000, 20))
    assert model_pull.run(SEVEN, clock=lambda: next(ticks)) == 0
    state = model_pull.read()
    assert state["status"] == "ready" and state["done"] == state["total"] == 4700 << 20
    assert profiles.dashboard_env()["OLLAMA_MODEL"] == SEVEN and profiles.os.environ["OLLAMA_MODEL"] == SEVEN
    assert len(pull["pushes"]) >= 3
    assert model_pull.info()["status"] == "ready"


def test_run_with_keep_downloads_without_switching(pull, monkeypatch):
    def post(*a, **k):
        pull["have"]["names"].append(SEVEN)
        return Stream([{"status": "success"}])
    monkeypatch.setattr(hc.requests, "post", post)
    assert model_pull.main([SEVEN, "--keep"]) == 0
    assert model_pull.read()["status"] == "ready" and "OLLAMA_MODEL" not in profiles.dashboard_env()


def test_run_records_a_failure_and_keeps_the_old_model(pull, monkeypatch):
    profiles.update_dashboard_env({"OLLAMA_MODEL": hc.DEFAULT_MODEL})
    monkeypatch.setattr(hc.requests, "post", lambda *a, **k: Stream([{"error": "no space left on device"}]))
    assert model_pull.run(SEVEN) == 1
    state = model_pull.read()
    assert state["status"] == "failed" and "no space left" in state["error"]
    assert profiles.dashboard_env()["OLLAMA_MODEL"] == hc.DEFAULT_MODEL


def test_run_says_when_ollama_does_not_list_the_model(pull, monkeypatch):
    monkeypatch.setattr(hc.requests, "post", lambda *a, **k: Stream([{"status": "success"}]))
    assert model_pull.run(SEVEN) == 1 and "does not list" in model_pull.read()["error"]


def test_run_without_ollama_fails_cleanly(pull, monkeypatch):
    monkeypatch.setattr(model_pull, "ollama", lambda: None)
    assert model_pull.run(SEVEN) == 1 and model_pull.read()["error"] == "no Ollama server answers"


def test_main_refuses_a_bad_name(pull):
    with pytest.raises(SystemExit):
        model_pull.main(["x;rm"])


def test_start_runs_it_in_the_background_once(pull, monkeypatch):
    started = []
    model_pull.start(SEVEN, spawn=lambda cmd, **k: started.append(cmd))
    assert started[0][1:] == [str(PACKAGE / "model_pull.py"), SEVEN] and model_pull.read()["status"] == "downloading"
    with pytest.raises(profiles.ProfileError, match="still downloading"):
        model_pull.start("qwen3:8b", spawn=lambda cmd, **k: started.append(cmd))
    with pytest.raises(profiles.ProfileError, match="invalid model"):
        model_pull.start("bad name", spawn=lambda cmd, **k: started.append(cmd))
    assert len(started) == 1
    model_pull.write({"model": SEVEN, "status": "failed", "finished": time.time()})
    model_pull.start(SEVEN, switch=False, spawn=lambda cmd, **k: started.append(cmd))
    assert started[1][-1] == "--keep"


def test_cancel_stops_the_download(pull, monkeypatch):
    signalled = []
    monkeypatch.setattr(profiles, "_signal", lambda pid, script, group=False: signalled.append((pid, script)) or True)
    assert model_pull.cancel() == "No server model download to stop"
    model_pull.write({"model": SEVEN, "status": "downloading", "pid": 4242, "started": time.time()})
    assert model_pull.cancel() == f"Stopping the download of {SEVEN}"
    assert signalled == [(4242, "model_pull.py")] and model_pull.read()["cancel"]
    monkeypatch.setattr(profiles, "_signal", lambda *a, **k: False)
    model_pull.write({"model": SEVEN, "status": "downloading", "pid": 4243, "started": time.time()})
    assert "already stopped" in model_pull.cancel() and model_pull.read()["status"] == "cancelled"


# --------------------------------------------------------------------------- profiles.py: the dashboard's action

def test_picking_a_model_ollama_has_switches_at_once(pull):
    pull["have"]["names"].append("qwen3:8b")
    profiles.admin_action({"action": "local_model", "model": "qwen3:8b"})
    assert profiles.dashboard_env()["OLLAMA_MODEL"] == "qwen3:8b" and not model_pull.read()


def test_picking_the_default_clears_the_choice(pull):
    profiles.update_dashboard_env({"OLLAMA_MODEL": "qwen3:8b"})
    profiles.admin_action({"action": "local_model", "model": ""})
    assert "OLLAMA_MODEL" not in profiles.dashboard_env() and "OLLAMA_MODEL" not in profiles.os.environ


def test_picking_a_new_model_downloads_it_first(pull, monkeypatch):
    started = []
    monkeypatch.setattr(model_pull, "start", lambda model, switch=True, spawn=None: started.append(model))
    profiles.admin_action({"action": "local_model", "model": SEVEN})
    assert started == [SEVEN] and "OLLAMA_MODEL" not in profiles.dashboard_env()


@pytest.mark.parametrize("item,error", [
    ({"model": "bad name"}, "invalid model name"),
    ({"model": None}, "invalid model name"),
    ({"model": ["x"]}, "invalid model name"),
    ({"model": "qwen3:30b-a3b-instruct-2507-q4_K_M"}, "needs more memory"),
])
def test_bad_or_oversized_picks_are_refused(pull, item, error):
    with pytest.raises(profiles.ProfileError, match=error):
        profiles.admin_action({"action": "local_model", **item})
    assert "OLLAMA_MODEL" not in profiles.dashboard_env() and not model_pull.read()


def test_a_pick_needs_an_ollama(pull, monkeypatch):
    monkeypatch.setattr(model_pull, "ollama", lambda: None)
    with pytest.raises(profiles.ProfileError, match="no Ollama server answers"):
        profiles.admin_action({"action": "local_model", "model": SEVEN})


def test_stop_in_tasks_cancels_the_download(pull, monkeypatch):
    monkeypatch.setattr(model_pull, "cancel", lambda: "stopped")
    assert profiles.admin_action({"action": "cancel", "u": "", "task": "model:pull"}) is None


def test_the_status_offers_the_models_and_shows_the_download(pull, monkeypatch):
    monkeypatch.setattr(profiles, "STATE_DIR", pull["tmp"])
    pull["have"]["names"].append("qwen3:8b")
    profiles.update_dashboard_env({"OLLAMA_MODEL": "qwen3:8b"})
    model_pull.write({"model": SEVEN, "status": "downloading", "pid": 0, "started": time.time(), "done": 1 << 30,
                      "total": 4 << 30})
    local = profiles.llm_info()["local"]
    assert local["model"] == "qwen3:8b" and local["source"] == "dashboard" and local["online"] and local["override"] == ""
    by = {c["model"]: c for c in local["choices"]}
    assert by["qwen3:8b"]["installed"] and not by[SEVEN]["installed"] and by[hc.DEFAULT_MODEL]["recommended"]
    assert local["pull"]["model"] == SEVEN and local["pull"]["done_mb"] == 1024
    assert profiles.tasks()[0]["id"] == "model:pull"
    monkeypatch.setenv("JOB_SCANNER_MODEL", "llama3")
    assert profiles.llm_info()["local"]["override"] == "JOB_SCANNER_MODEL"


def test_the_status_is_pushed_again_when_the_download_moves_on(pull):
    payload = {"llm": {"order": "cloud", "local": {"model": "a", "source": "env", "choices": [], "pull": None}}}
    moved = {"llm": {"order": "cloud", "local": {"model": "a", "source": "env", "choices": [],
                                                 "pull": {"model": SEVEN, "status": "ready"}}}}
    assert profiles._stable(payload) != profiles._stable(moved)
    where = {"llm": {"order": "cloud", "local": {"model": "a", "source": "env", "choices": [], "pull": None, "where": "x"}}}
    assert profiles._stable(payload) == profiles._stable(where)


def test_only_the_server_model_can_be_set_from_the_dashboard():
    assert hc.dashboard_key_allowed("OLLAMA_MODEL")
    for key in ("OLLAMA_HOST", "OLLAMA_HOSTS", "OLLAMA_FALLBACK_HOST", "OLLAMA_NUM_CTX"):
        assert not hc.dashboard_key_allowed(key), key

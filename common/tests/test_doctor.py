"""Unit tests for doctor.py: package, Ollama and settings checks, and what --fix sets up.

Run from the repository root:  python -m pytest common/tests
"""

import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "common"))

import doctor  # noqa: E402
import hermes_common as hc  # noqa: E402


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(hc, "HERMES_HOME", tmp_path)
    monkeypatch.setattr(hc, "STATE_DIR", tmp_path / "scripts" / "state")
    monkeypatch.setattr(hc.os, "environ", dict(hc.os.environ))
    for key in ("OLLAMA_HOST", "OLLAMA_FALLBACK_HOST", "OLLAMA_MODEL", "JOB_SCANNER_MODEL", hc.DATA_KEY_ENV,
                "SMTP_USER", "SMTP_PASSWORD", "FIRECRAWL_API_KEY", "TAVILY_API_KEY", "SCRAPFLY_API_KEY",
                "JOB_FEEDBACK_URL"):
        monkeypatch.delenv(key, raising=False)
    return tmp_path


def statuses(report):
    return [(i["check"], i["status"]) for i in report.items]


# --------------------------------------------------------------------------- packages

def test_requirements_txt_matches_the_doctor():
    lines = [line.split("#")[0].strip() for line in (REPO / "requirements.txt").read_text().splitlines()]
    assert sorted(line for line in lines if line) == sorted(f"{d}>={m}" for _, d, m, _ in doctor.REQUIREMENTS)


def test_missing_required_and_optional_packages(monkeypatch):
    monkeypatch.setattr(doctor, "REQUIREMENTS", [("requests", "requests", "1.0", True),
                                                 ("no_such_module_xyz", "no-such-dist", "1.0", True),
                                                 ("no_such_optional_xyz", "no-such-optional", "1.0", False),
                                                 ("json", "requests", "999", True)])
    report = doctor.Report(as_json=True)
    doctor.check_packages(report, fix=False)
    messages = {i["message"]: i["status"] for i in report.items}
    assert messages["no-such-dist is not installed (needed)"] == "fail"
    assert messages["no-such-optional is not installed (optional)"] == "warn"
    assert any(m.startswith("requests ") and "older than 999" in m for m in messages)
    assert report.failed


def test_installer_uses_pip_then_uv(monkeypatch, tmp_path):
    monkeypatch.setattr(doctor.importlib.util, "find_spec", lambda name: object())
    cmd = doctor.installer(tmp_path, ["requests>=2.32"])
    assert cmd[:3] == [sys.executable, "-m", "pip"] and "--target" in cmd and cmd[-1] == "requests>=2.32"
    monkeypatch.setattr(doctor.importlib.util, "find_spec", lambda name: None)
    monkeypatch.setattr(doctor.shutil, "which", lambda name: "/usr/local/bin/uv" if name == "uv" else None)
    assert doctor.installer(tmp_path, ["x"])[:5] == ["/usr/local/bin/uv", "pip", "install", "--python", sys.executable]
    monkeypatch.setattr(doctor.shutil, "which", lambda name: None)
    assert doctor.installer(tmp_path, ["x"]) is None


def test_fix_installs_missing_packages_into_the_deps_folder(monkeypatch, tmp_path):
    deps = tmp_path / ".deps" / "py3.x"
    monkeypatch.setattr(doctor, "DEPS_DIR", deps)
    monkeypatch.setattr(doctor, "REQUIREMENTS", [("fakepkg_doctor", "fakepkg-doctor", "1.0", True)])
    monkeypatch.setattr(sys, "path", list(sys.path))
    install = ("import pathlib, sys; t = pathlib.Path(sys.argv[1]); (t / 'fakepkg_doctor').mkdir(parents=True); "
               "(t / 'fakepkg_doctor' / '__init__.py').write_text(''); d = t / 'fakepkg_doctor-1.2.dist-info'; "
               "d.mkdir(); (d / 'METADATA').write_text('Metadata-Version: 2.1\\nName: fakepkg-doctor\\nVersion: 1.2\\n')")
    calls = []
    monkeypatch.setattr(doctor, "installer", lambda target, specs: calls.append(specs) or
                        [sys.executable, "-c", install, str(target)])
    report = doctor.Report(as_json=True)
    doctor.check_packages(report, fix=True)
    assert calls == [["fakepkg-doctor>=1.0"]]
    assert [i["message"] for i in report.items] == ["fakepkg-doctor 1.2 installed",
                                                     "packages: fakepkg-doctor 1.2"]
    assert str(deps) in sys.path and not report.failed


def test_fix_without_pip_or_uv_says_what_to_install(monkeypatch):
    monkeypatch.setattr(doctor, "REQUIREMENTS", [("no_such_module_xyz", "no-such-dist", "1.0", True)])
    monkeypatch.setattr(doctor, "installer", lambda target, specs: None)
    report = doctor.Report(as_json=True)
    doctor.check_packages(report, fix=True)
    assert report.items[0]["status"] == "fail" and "no-such-dist" in report.items[0]["fix"]


# --------------------------------------------------------------------------- ollama

class FakeResponse:
    def __init__(self, payload=None, lines=(), status=200):
        self.payload, self.lines, self.status_code = payload, lines, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise hc.requests.HTTPError(response=self)

    def json(self):
        return self.payload

    def iter_lines(self):
        return iter(self.lines)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def fake_ollama(monkeypatch, models_by_host, pull_lines=()):
    pulled = []

    def get(url, timeout=None):
        host = url.rsplit("/api/", 1)[0]
        if host not in models_by_host:
            raise hc.requests.ConnectionError("down")
        return FakeResponse({"models": [{"name": m} for m in models_by_host[host]]})

    def post(url, json=None, stream=False, timeout=None):
        pulled.append((url, json["model"]))
        return FakeResponse(lines=[__import__("json").dumps(line).encode() for line in pull_lines])

    monkeypatch.setattr(hc.requests, "get", get)
    monkeypatch.setattr(hc.requests, "post", post)
    return pulled


def test_ollama_down_fails_with_a_hint(home, monkeypatch):
    fake_ollama(monkeypatch, {})
    report = doctor.Report(as_json=True)
    doctor.check_ollama(report, fix=True)
    assert statuses(report) == [("ollama", "fail")] and "OLLAMA_HOST" in report.items[0]["fix"]


def test_ollama_uses_hermes_model_when_hermes_talks_to_ollama(home, monkeypatch):
    (home / "config.yaml").write_text("model:\n  default: llama3:8b\n  base_url: http://gpu:11434/v1\n")
    fake_ollama(monkeypatch, {"http://gpu:11434": ["llama3:8b"]})
    report = doctor.Report(as_json=True)
    doctor.check_ollama(report, fix=False)
    assert report.items == [{"check": "ollama", "status": "ok", "message": "Ollama at http://gpu:11434 has llama3:8b",
                             "fix": "", "host": "http://gpu:11434", "model": "llama3:8b",
                             "wanted": hc.DEFAULT_MODEL}]


@pytest.fixture
def placed(monkeypatch):
    """autofit switched on, with a GTX 970 host and whatever placement Ollama reports."""
    import autofit
    monkeypatch.setenv("HERMES_AUTOFIT", "auto")
    gtx = {"index": 0, "name": "NVIDIA GeForce GTX 970", "vram_mb": 4096, "free_mb": 4000, "compute": "5.2"}

    def machine(placement, seen="ok", gpus=(gtx,)):
        monkeypatch.setattr(autofit, "hardware", lambda: {
            "source": "host report", "age": 0, "gpus": list(gpus), "ollama_gpu": seen,
            "cpu": {"model": "Xeon", "logical": 36, "physical": 18, "avx2": True},
            "ram_mb": {"total": 24000, "available": 14000}})
        monkeypatch.setattr(autofit, "placement", lambda host, model: placement)
    return machine


def test_doctor_says_where_the_model_runs(home, monkeypatch, placed):
    fake_ollama(monkeypatch, {"http://ollama:11434": [hc.DEFAULT_MODEL]})
    placed((8192, 3114, 2934))
    report = doctor.Report(as_json=True)
    doctor.check_ollama(report, fix=False)
    assert statuses(report) == [("ollama", "ok"), ("ollama", "ok")]
    assert report.items[1]["message"].endswith("loaded at 8192 context, 94% on the GPU, the rest on the CPU; "
                                               "GPU: NVIDIA GeForce GTX 970 (4096 MB)")


@pytest.mark.parametrize("placement, seen, words", [
    ((65536, 9098, 0), "ok", "running"), (None, "lost", "running"), (None, "none", "no GPU access")])
def test_doctor_warns_when_a_gpu_sits_unused(home, monkeypatch, placed, placement, seen, words):
    fake_ollama(monkeypatch, {"http://ollama:11434": [hc.DEFAULT_MODEL]})
    placed(placement, seen)
    report = doctor.Report(as_json=True)
    doctor.check_ollama(report, fix=False)
    assert statuses(report)[1] == ("ollama", "warn")
    assert words in report.items[1]["message"] and "use-the-gpu" in report.items[1]["fix"]


def test_doctor_on_a_cpu_only_machine_names_the_cores(home, monkeypatch, placed):
    fake_ollama(monkeypatch, {"http://ollama:11434": [hc.DEFAULT_MODEL]})
    placed(None, "", gpus=())
    report = doctor.Report(as_json=True)
    doctor.check_ollama(report, fix=False)
    assert report.items[1]["message"].endswith("not loaded right now; no GPU found, CPU: 18 cores / 36 threads")


def test_a_cloud_model_in_hermes_config_is_not_looked_for_on_ollama(home, monkeypatch):
    (home / "config.yaml").write_text("model:\n  default: anthropic/claude-sonnet\n  provider: openrouter\n")
    hosts, models, wanted = doctor.ollama_plan(hc)
    assert "anthropic/claude-sonnet" not in models and wanted == hc.DEFAULT_MODEL
    assert hosts == ["http://ollama:11434", "http://localhost:11434"]


def test_fix_downloads_the_missing_model(home, monkeypatch):
    monkeypatch.setenv("OLLAMA_MODEL", "qwen3:4b")
    lines = [{"status": "pulling", "total": 100, "completed": 0}, {"status": "pulling", "total": 100, "completed": 55},
             {"status": "success"}]
    pulled = fake_ollama(monkeypatch, {"http://ollama:11434": ["other:1b"]}, lines)
    report = doctor.Report(as_json=True)
    doctor.check_ollama(report, fix=False)
    assert statuses(report) == [("ollama", "fail")] and pulled == []
    report = doctor.Report(as_json=True)
    doctor.check_ollama(report, fix=True)
    assert pulled == [("http://ollama:11434/api/pull", "qwen3:4b")]
    assert statuses(report) == [("ollama", "fixed")]


def test_a_failed_download_is_reported(home, monkeypatch):
    fake_ollama(monkeypatch, {"http://ollama:11434": []}, [{"error": "pull model manifest: file does not exist"}])
    report = doctor.Report(as_json=True)
    doctor.check_ollama(report, fix=True, model="nope:1b")
    assert statuses(report) == [("ollama", "fail")] and "ollama pull nope:1b" in report.items[0]["fix"]


def test_no_pull_never_downloads(home, monkeypatch):
    pulled = fake_ollama(monkeypatch, {"http://ollama:11434": []}, [{"status": "success"}])
    doctor.check_ollama(doctor.Report(as_json=True), fix=True, pull=False)
    assert pulled == []


# --------------------------------------------------------------------------- settings

def test_fix_generates_the_data_key_once(home):
    pytest.importorskip("cryptography")
    env_file = home / ".env"
    env_file.write_text("SMTP_USER=me@example.com")
    report = doctor.Report(as_json=True)
    doctor.check_settings(report, fix=True)
    assert ("settings", "fixed") in statuses(report)
    lines = env_file.read_text().splitlines()
    assert lines[0] == "SMTP_USER=me@example.com" and lines[1].startswith(f"{hc.DATA_KEY_ENV}=")
    report = doctor.Report(as_json=True)
    doctor.check_settings(report, fix=True)
    assert env_file.read_text().count(hc.DATA_KEY_ENV) == 1
    assert report.items[0]["message"].startswith("data key set")


def test_a_lost_key_is_never_replaced(home):
    pytest.importorskip("cryptography")
    (home / ".env").write_text("")
    hc.os.environ[hc.DATA_KEY_ENV] = hc.new_data_key()
    hc.STATE_DIR.mkdir(parents=True)
    hc.write_private(hc.STATE_DIR / "cv.json", "{}")
    del hc.os.environ[hc.DATA_KEY_ENV]
    report = doctor.Report(as_json=True)
    doctor.check_settings(report, fix=True)
    assert ("settings", "fail") in statuses(report)
    assert hc.DATA_KEY_ENV not in (home / ".env").read_text()


def test_settings_warnings_and_worker(home, monkeypatch):
    report = doctor.Report(as_json=True)
    doctor.check_settings(report, fix=False)
    doctor.check_worker(report, False)
    assert [s for _, s in statuses(report)] == ["warn"] * 5
    monkeypatch.setenv("JOB_FEEDBACK_URL", "https://fb.example.workers.dev")
    monkeypatch.setattr(hc.requests, "get", lambda url, timeout=None: FakeResponse(status=200))
    report = doctor.Report(as_json=True)
    doctor.check_worker(report, False)
    assert statuses(report) == [("worker", "ok")]


# --------------------------------------------------------------------------- command line

def test_json_output_and_exit_code(home, monkeypatch, capsys):
    fake_ollama(monkeypatch, {})
    assert doctor.main(["--json", "--only", "python,ollama"]) == 1
    items = json.loads(capsys.readouterr().out)
    assert [(i["check"], i["status"]) for i in items] == [("python", "ok"), ("ollama", "fail")]
    assert doctor.main(["--only", "python"]) == 0
    with pytest.raises(SystemExit):
        doctor.main(["--only", "nonsense"])


def test_a_crashing_check_is_reported_not_raised(home, monkeypatch):
    monkeypatch.setattr(doctor, "check_disk", lambda r, f: 1 / 0)
    report = doctor.Report(as_json=True)
    doctor.run(["disk"], False, report)
    assert statuses(report) == [("disk", "fail")] and "ZeroDivisionError" in report.items[0]["message"]

"""The host's Ollama watchdog (scripts/host/ollama-watchdog.sh), run for real with a fake `docker` and `nvidia-smi`.

The fake Ollama container answers `nvidia-smi -L` with the NVML error until it is restarted, like a container whose
GPU was taken by a systemd reload. Linux only: the script reads /proc and runs under sh.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "host" / "ollama-watchdog.sh"
pytestmark = pytest.mark.skipif(sys.platform != "linux" or not shutil.which("sh"), reason="runs the host script")

FAKE_DOCKER = r"""#!/bin/sh
echo "$*" >> "$FAKE/calls"
case "$1" in
  ps)
    case "$*" in
      *Image*) printf 'ollama ollama/ollama:latest\nhermitshell ghcr.io/example/hermitshell:latest\nweb nginx:latest\n' ;;
      *) printf 'ollama\nhermitshell\nold-agent\nweb\n' ;;
    esac ;;
  inspect) echo '[{"Driver":"nvidia","Count":-1,"Capabilities":[["gpu"]]}] null' ;;
  restart) echo ok > "$FAKE/gpu"; echo "$2" ;;
  exec)
    if [ "$2" = "-i" ]; then cat > "$FAKE/report"; exit 0; fi
    if [ "$(cat "$FAKE/gpu")" = ok ]; then echo "GPU 0: NVIDIA GeForce GTX 970 (UUID: GPU-x)"; exit 0; fi
    echo "Failed to initialize NVML: Unknown Error"; exit 255 ;;
esac
"""
FAKE_SMI = "#!/bin/sh\necho '0, NVIDIA GeForce GTX 970, 4096, 4000, 5.2'\n"


@pytest.fixture
def host(tmp_path):
    fake, bin_dir = tmp_path / "fake", tmp_path / "bin"
    fake.mkdir()
    bin_dir.mkdir()
    for name, body in (("docker", FAKE_DOCKER), ("nvidia-smi", FAKE_SMI)):
        path = bin_dir / name
        path.write_text(body, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IEXEC)

    def run(gpu="lost", **env):
        (fake / "gpu").write_text(gpu, encoding="utf-8")
        (fake / "calls").write_text("", encoding="utf-8")
        environ = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE": str(fake),
                   "WATCHDOG_RUN_DIR": str(tmp_path / "run"), "RESTART_SETTLE": "0", **env}
        res = subprocess.run(["sh", str(SCRIPT)], env=environ, capture_output=True, text=True, timeout=60)
        report = (fake / "report").read_text(encoding="utf-8") if (fake / "report").exists() else ""
        return res, (fake / "calls").read_text(encoding="utf-8").splitlines(), json.loads(report) if report else None
    run.dir = tmp_path
    return run


def test_a_container_that_lost_the_gpu_is_restarted_and_reported(host):
    res, calls, report = host()
    assert "ollama has lost the GPU" in res.stdout and "can see the GPU again" in res.stdout
    assert "restart ollama" in calls and not any(c.startswith("restart web") for c in calls)
    assert report["ollama_gpu"] == "ok" and report["last_restart"] > 0
    assert report["gpus"] == [{"index": 0, "name": "NVIDIA GeForce GTX 970", "vram_mb": 4096, "free_mb": 4000,
                               "compute": "5.2"}]
    assert report["cpu"]["logical"] >= 1 and report["ram_mb"]["total"] > 0


def test_restarts_are_rate_limited(host):
    host()
    res, calls, report = host()
    assert "not restarting it again yet" in res.stdout and "restart ollama" not in calls
    assert report["ollama_gpu"] == "lost"


def test_a_healthy_container_is_left_alone(host):
    res, calls, report = host(gpu="ok")
    assert not any(c.startswith("restart") for c in calls) and report["ollama_gpu"] == "ok"


def test_the_report_is_written_inside_the_hermitshell_container_as_its_user(host):
    _, calls, _ = host(gpu="ok")
    write = next(c for c in calls if c.startswith("exec -i"))
    assert write.startswith("exec -i -u hermitshell hermitshell sh -c")
    assert write.endswith("sh /data/scripts/state")


def test_the_settings_of_an_install_inside_hermes_are_still_read(host):
    _, calls, _ = host(gpu="ok", HERMES_CONTAINER="old-agent", HERMES_USER="agent", HERMES_STATE="/opt/data/scripts/state")
    write = next(c for c in calls if c.startswith("exec -i"))
    assert write.startswith("exec -i -u agent old-agent sh -c") and write.endswith("sh /opt/data/scripts/state")
    _, calls, _ = host(gpu="ok", HERMES_CONTAINER="old-agent", HERMITSHELL_CONTAINER="hermitshell")
    assert next(c for c in calls if c.startswith("exec -i")).startswith("exec -i -u hermitshell hermitshell ")


@pytest.mark.parametrize("env", [{"HERMITSHELL_CONTAINER": "x;reboot"}, {"HERMITSHELL_STATE": "relative/path"},
                                 {"HERMITSHELL_STATE": "/data/$(reboot)"}, {"HERMITSHELL_USER": "a b"},
                                 {"HERMES_STATE": "/opt/data/$(reboot)"}])
def test_bad_settings_are_refused(host, env):
    res, calls, report = host(gpu="ok", **env)
    assert res.returncode == 1 and report is None


def test_only_named_containers_with_safe_names_are_touched(host):
    res, calls, _ = host(OLLAMA_CONTAINERS="bad;name ollama")
    assert not any("bad;name" in c for c in calls) and "restart ollama" in calls

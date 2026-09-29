"""The host's image updater (scripts/host/hermitshell-update.sh), run for real with a fake `docker`.

Linux only: the script runs under sh as the systemd timer would.
"""

import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

HOST = Path(__file__).resolve().parents[1] / "host"
SCRIPT = HOST / "hermitshell-update.sh"
pytestmark = pytest.mark.skipif(sys.platform != "linux" or not shutil.which("sh"), reason="runs the host script")

FAKE_DOCKER = r"""#!/bin/sh
echo "$*" >> "$FAKE/calls"
case "$*" in
  *" images -q") cat "$FAKE/image" ;;
  *" pull --quiet")
    [ -f "$FAKE/pull-fails" ] && { echo "denied: token secret-value"; exit 1; }
    [ -f "$FAKE/new" ] && cp "$FAKE/new" "$FAKE/image"; exit 0 ;;
  *" up -d --remove-orphans") exit 0 ;;
  "image prune"*) exit 0 ;;
esac
"""


@pytest.fixture
def host(tmp_path):
    fake = tmp_path / "fake"
    fake.mkdir()
    docker = tmp_path / "docker"
    docker.write_text(FAKE_DOCKER, encoding="utf-8")
    docker.chmod(docker.stat().st_mode | stat.S_IEXEC)
    compose = tmp_path / "docker-compose.yml"
    compose.write_text("services: {}\n", encoding="utf-8")
    (fake / "image").write_text("sha256:old\n", encoding="utf-8")

    def run(compose_path=str(compose)):
        (fake / "calls").write_text("", encoding="utf-8")
        env = {**os.environ, "FAKE": str(fake), "DOCKER": str(docker), "HERMITSHELL_COMPOSE": compose_path}
        res = subprocess.run(["sh", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=60)
        return res, (fake / "calls").read_text(encoding="utf-8").splitlines()
    run.fake = fake
    return run


def test_nothing_new_leaves_the_container_as_it_is(host):
    res, calls = host()
    assert res.returncode == 0 and res.stdout == ""
    assert any(c.endswith("pull --quiet") for c in calls) and not any(c.startswith("image prune") for c in calls)


def test_a_new_image_recreates_the_container_and_prunes_the_old_one(host):
    (host.fake / "new").write_text("sha256:new\n", encoding="utf-8")
    res, calls = host()
    assert res.returncode == 0 and "updated to image sha256:new" in res.stdout
    assert any(c.endswith("up -d --remove-orphans") for c in calls)
    assert "image prune -f --filter label=org.opencontainers.image.title=hermitshell" in calls


def test_a_failed_pull_is_reported_without_starting_anything(host):
    (host.fake / "pull-fails").write_text("", encoding="utf-8")
    res, calls = host()
    assert res.returncode == 1 and "could not pull" in res.stdout
    assert not any("up -d" in c for c in calls)


@pytest.mark.parametrize("path", ["relative/compose.yml", "/tmp/x.yml; rm -rf /", "/tmp/$(id).yml", "/no/such.yml"])
def test_a_bad_compose_setting_is_refused(host, path):
    res, calls = host(path)
    assert res.returncode == 1 and calls == []


def test_the_installers_and_units_keep_root_owned_copies():
    installer = (HOST / "install-updater.sh").read_text(encoding="utf-8")
    assert 'stat -c %u "$DEST"' in installer and "-o root -g root" in installer
    timer = (HOST / "hermitshell-update.timer").read_text(encoding="utf-8")
    assert "OnUnitActiveSec=10min" in timer and "OnBootSec=5min" in timer

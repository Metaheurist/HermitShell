#!/bin/sh
# Installs HermitShell's Ollama watchdog on this Docker host. Run as root:
#
#   sh scripts/host/install-watchdog.sh [folder]
#
# The script is copied to `folder` (default /opt/hermitshell-host), which must be root-owned and not mounted into
# any container, since systemd runs it as root. Then the service and its 2-minute timer are added and started, in
# place of the hermes-ollama-watchdog units an install inside Hermes had.
# Settings go in /etc/default/hermitshell-ollama-watchdog (see ollama-watchdog.sh).
set -eu
DEST=${1:-/opt/hermitshell-host}
HERE=$(cd "$(dirname "$0")" && pwd)
case "$DEST" in /*) ;; *) echo "give an absolute folder" >&2; exit 1 ;; esac
case "$DEST" in *[!A-Za-z0-9_./-]*) echo "use a folder name without spaces or quotes" >&2; exit 1 ;; esac
mkdir -p "$DEST"
if [ "$(stat -c %u "$DEST")" != 0 ]; then
    echo "$DEST must be owned by root" >&2
    exit 1
fi
install -m 755 -o root -g root "$HERE/ollama-watchdog.sh" "$DEST/ollama-watchdog.sh"
sed "s#@SCRIPT@#$DEST/ollama-watchdog.sh#" "$HERE/hermitshell-ollama-watchdog.service" \
    > /etc/systemd/system/hermitshell-ollama-watchdog.service
install -m 644 "$HERE/hermitshell-ollama-watchdog.timer" /etc/systemd/system/hermitshell-ollama-watchdog.timer
if [ -f /etc/systemd/system/hermes-ollama-watchdog.timer ]; then
    systemctl disable --now hermes-ollama-watchdog.timer >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/hermes-ollama-watchdog.timer /etc/systemd/system/hermes-ollama-watchdog.service
    echo "Removed the old hermes-ollama-watchdog units"
fi
systemctl daemon-reload
systemctl enable --now hermitshell-ollama-watchdog.timer
# A daemon-reload is what takes the GPU from running containers, so check straight away.
systemctl start hermitshell-ollama-watchdog.service
echo "Installed: $DEST/ollama-watchdog.sh, every 2 minutes (journalctl -u hermitshell-ollama-watchdog)"

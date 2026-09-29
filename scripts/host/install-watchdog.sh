#!/bin/sh
# Installs HermitShell's Ollama watchdog on this Docker host. Run as root:
#
#   sh scripts/host/install-watchdog.sh [folder]
#
# The script is copied to `folder` (default /opt/hermitshell), which must be root-owned and not mounted into any
# container, since systemd runs it as root. Then the service and its 2-minute timer are added and started.
# Settings go in /etc/default/hermes-ollama-watchdog (see ollama-watchdog.sh).
set -eu
DEST=${1:-/opt/hermitshell}
HERE=$(cd "$(dirname "$0")" && pwd)
case "$DEST" in /*) ;; *) echo "give an absolute folder" >&2; exit 1 ;; esac
case "$DEST" in *[!A-Za-z0-9_./-]*) echo "use a folder name without spaces or quotes" >&2; exit 1 ;; esac
mkdir -p "$DEST"
if [ "$(stat -c %u "$DEST")" != 0 ]; then
    echo "$DEST must be owned by root" >&2
    exit 1
fi
install -m 755 -o root -g root "$HERE/ollama-watchdog.sh" "$DEST/ollama-watchdog.sh"
sed "s#@SCRIPT@#$DEST/ollama-watchdog.sh#" "$HERE/hermes-ollama-watchdog.service" \
    > /etc/systemd/system/hermes-ollama-watchdog.service
install -m 644 "$HERE/hermes-ollama-watchdog.timer" /etc/systemd/system/hermes-ollama-watchdog.timer
systemctl daemon-reload
systemctl enable --now hermes-ollama-watchdog.timer
# A daemon-reload is what takes the GPU from running containers, so check straight away.
systemctl start hermes-ollama-watchdog.service
echo "Installed: $DEST/ollama-watchdog.sh, every 2 minutes (journalctl -u hermes-ollama-watchdog)"

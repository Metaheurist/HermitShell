#!/bin/sh
# Installs the timer that keeps the HermitShell container on the newest image. Run as root on the Docker host:
#
#   sh scripts/host/install-updater.sh /path/to/docker-compose.yml [folder]
#
# The update script is copied to `folder` (default /opt/hermitshell-host), which must be root-owned and not
# mounted into any container, since systemd runs it as root. The compose file's path goes in
# /etc/default/hermitshell-update.
set -eu
COMPOSE=${1:?give the path of the HermitShell docker-compose.yml}
DEST=${2:-/opt/hermitshell-host}
HERE=$(cd "$(dirname "$0")" && pwd)
for p in "$COMPOSE" "$DEST"; do
    case "$p" in /*) ;; *) echo "give absolute paths" >&2; exit 1 ;; esac
    case "$p" in *[!A-Za-z0-9_./-]*) echo "use paths without spaces or quotes" >&2; exit 1 ;; esac
done
[ -r "$COMPOSE" ] || { echo "no $COMPOSE" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "the docker compose plugin is needed" >&2; exit 1; }
mkdir -p "$DEST"
if [ "$(stat -c %u "$DEST")" != 0 ]; then
    echo "$DEST must be owned by root" >&2
    exit 1
fi
install -m 755 -o root -g root "$HERE/hermitshell-update.sh" "$DEST/hermitshell-update.sh"
printf 'HERMITSHELL_COMPOSE=%s\n' "$COMPOSE" > /etc/default/hermitshell-update
chmod 644 /etc/default/hermitshell-update
sed "s#@SCRIPT@#$DEST/hermitshell-update.sh#" "$HERE/hermitshell-update.service" \
    > /etc/systemd/system/hermitshell-update.service
install -m 644 "$HERE/hermitshell-update.timer" /etc/systemd/system/hermitshell-update.timer
systemctl daemon-reload
systemctl enable --now hermitshell-update.timer
echo "Installed: $DEST/hermitshell-update.sh, every 10 minutes (journalctl -u hermitshell-update)"

#!/bin/sh
# Keeps the HermitShell container on the newest image, run as root every 10 minutes by hermitshell-update.timer.
# Pulls the image named in the compose file; only when a new one arrived is the container recreated, with the same
# settings and data (docker compose up -d), and the old image removed. Nothing reaches in from outside: the server
# asks the registry, so no port, key or deploy access is needed.
#
# Settings, from the environment or /etc/default/hermitshell-update:
#   HERMITSHELL_COMPOSE   the compose file (default /opt/hermitshell/docker-compose.yml)
set -u
CONF=/etc/default/hermitshell-update
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"
COMPOSE=${HERMITSHELL_COMPOSE:-/opt/hermitshell/docker-compose.yml}
DOCKER=${DOCKER:-docker}

say() { echo "hermitshell-update: $*"; }
case "$COMPOSE" in /*) ;; *) say "HERMITSHELL_COMPOSE must be an absolute path"; exit 1 ;; esac
case "$COMPOSE" in *[!A-Za-z0-9_./-]*) say "bad HERMITSHELL_COMPOSE"; exit 1 ;; esac
[ -r "$COMPOSE" ] || { say "no $COMPOSE"; exit 1; }

image_of() { $DOCKER compose -f "$COMPOSE" images -q 2>/dev/null | sort | tr '\n' ' '; }
before=$(image_of)
if ! out=$($DOCKER compose -f "$COMPOSE" pull --quiet 2>&1); then
    say "could not pull: $(printf '%s' "$out" | tail -n 2 | tr -cd 'A-Za-z0-9 ._:/()-' | cut -c1-200)"
    exit 1
fi
$DOCKER compose -f "$COMPOSE" up -d --remove-orphans >/dev/null 2>&1 || { say "could not start the container"; exit 1; }
after=$(image_of)
if [ "$before" != "$after" ]; then
    say "updated to image $after"
    $DOCKER image prune -f --filter "label=org.opencontainers.image.title=hermitshell" >/dev/null 2>&1 || true
fi

#!/bin/sh
# The container's entry point. Each start installs the image's packages into /data/scripts (personal files there
# are never overwritten), so updating the image updates the scripts, then runs one of:
#
#   run                 the scheduler (the default): adds the standard jobs on first start, then runs them on time
#   setup [options]     the setup wizard, e.g. docker exec -it hermitshell /app/entrypoint.sh setup
#   doctor [options]    the health check, e.g. docker exec hermitshell /app/entrypoint.sh doctor
#   worker [options]    deploy or update the feedback Worker from the settings in /data/.env
#   anything else       run as a command, e.g. python3 scheduler.py list
set -eu
APP_HOME="${HERMITSHELL_HOME:-/data}"
PACKAGES="${HERMITSHELL_PACKAGES:-$(ls /app/packages)}"

if [ ! -w "$APP_HOME" ]; then
    echo "$APP_HOME is not writable by uid $(id -u); chown the data folder to $(id -u):$(id -g)" >&2
    exit 1
fi
# shellcheck disable=SC2086
HERMITSHELL_HOME="$APP_HOME" HERMITSHELL_SETUP=1 sh /app/scripts/install.sh $PACKAGES >/dev/null
cd "$APP_HOME/scripts"

cmd="${1:-run}"
[ "$#" -gt 0 ] && shift
case "$cmd" in
    run)
        python3 scheduler.py defaults --if-new
        exec python3 scheduler.py run ;;
    setup)
        exec python3 /app/scripts/setup.py --home "$APP_HOME" --no-install "$@" ;;
    doctor)
        exec python3 doctor.py "$@" ;;
    worker)
        exec python3 /app/scripts/cloudflare_worker.py --home "$APP_HOME" "$@" ;;
    *)
        exec "$cmd" "$@" ;;
esac

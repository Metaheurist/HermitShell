#!/usr/bin/env sh
# Install one or more HermitShell packages into HermitShell's home folder.
#
#   HERMITSHELL_HOME=/opt/hermitshell ./scripts/install.sh daily-vacancy-report
#
# Copies the shared hermes_common.py, autofit.py, doctor.py, llm_providers.py and scheduler.py plus each package's files flat into
# $HERMITSHELL_HOME/scripts, where the scheduler runs them from; each package's jobs.json becomes
# <package>.jobs.json, its standard schedule. Existing personal files (job_profile.md, cv_keywords.json, .env) are
# never overwritten. Set HERMITSHELL_OWNER=uid:gid to chown the result. HERMES_HOME and HERMES_OWNER, from installs
# inside Hermes, still work. For a service that keeps the scheduler running, see scripts/install-service.sh or
# the container (docs/installation.md).
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_HOME="${HERMITSHELL_HOME:-${HERMES_HOME:-$HOME/.hermitshell}}"
OWNER="${HERMITSHELL_OWNER:-${HERMES_OWNER:-}}"
DEST="$APP_HOME/scripts"

if [ "$#" -eq 0 ]; then
    echo "usage: $0 <package> [package...]" >&2
    echo "packages:" >&2
    ls "$REPO/packages" >&2
    exit 2
fi

mkdir -p "$DEST"
for f in hermes_common.py autofit.py doctor.py llm_providers.py scheduler.py; do
    cp "$REPO/common/$f" "$DEST/"
done
echo "installed common/hermes_common.py, autofit.py, doctor.py, llm_providers.py and scheduler.py -> $DEST"

for pkg in "$@"; do
    src="$REPO/packages/$pkg"
    if [ ! -d "$src" ]; then
        echo "unknown package: $pkg" >&2
        exit 2
    fi
    for f in "$src"/*.py "$src"/*.example.* "$src"/.env.example; do
        [ -f "$f" ] || continue
        name="$(basename "$f")"
        [ "$name" = ".env.example" ] && name="$pkg.env.example"
        cp "$f" "$DEST/$name"
    done
    [ -f "$src/jobs.json" ] && cp "$src/jobs.json" "$DEST/$pkg.jobs.json"
    [ -d "$src/examples" ] && mkdir -p "$DEST/examples" && cp "$src"/examples/* "$DEST/examples/"
    if [ -d "$src/icons" ]; then
        mkdir -p "$DEST/icons"
        cp "$src"/icons/*.png "$DEST/icons/"
    fi
    echo "installed $pkg -> $DEST"
done

# Strip Windows line endings in case the repo was checked out on Windows.
find "$DEST" -maxdepth 1 -name '*.py' -exec sed -i 's/\r$//' {} +

if [ -n "$OWNER" ]; then
    chown -R "$OWNER" "$DEST"
fi

if [ -z "${HERMITSHELL_SETUP:-}" ]; then
    echo
    echo "Check what is still missing (and install packages, the model and the data key):"
    echo "  cd $DEST && python3 doctor.py --fix"
    echo
    echo "Next: run the setup wizard to enter your settings, API keys, profile and schedules:"
    echo "  python3 $REPO/scripts/setup.py --home $APP_HOME --no-install"
    echo
    echo "Then keep the scheduler running: sudo sh $REPO/scripts/install-service.sh (a systemd service),"
    echo "or run HermitShell as a container instead (docs/installation.md)."
fi

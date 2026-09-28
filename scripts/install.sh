#!/usr/bin/env sh
# Install one or more HermitShell packages into a Hermes scripts directory.
#
#   HERMES_HOME=/opt/data ./scripts/install.sh daily-vacancy-report noon-tech-digest
#
# Copies the shared hermes_common.py plus each package's files flat into $HERMES_HOME/scripts,
# the directory Hermes cron jobs run scripts from. Existing personal files (job_profile.md,
# cv_keywords.json, .env) are never overwritten. Set HERMES_OWNER=uid:gid to chown the result
# (the official Hermes container runs as 10000:10000).
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
DEST="$HERMES_HOME/scripts"

if [ "$#" -eq 0 ]; then
    echo "usage: $0 <package> [package...]" >&2
    echo "packages:" >&2
    ls "$REPO/packages" >&2
    exit 2
fi

mkdir -p "$DEST"
cp "$REPO/common/hermes_common.py" "$DEST/"
echo "installed common/hermes_common.py -> $DEST"

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
    [ -d "$src/examples" ] && mkdir -p "$DEST/examples" && cp "$src"/examples/* "$DEST/examples/"
    if [ -d "$src/icons" ]; then
        mkdir -p "$DEST/icons"
        cp "$src"/icons/*.png "$DEST/icons/"
    fi
    echo "installed $pkg -> $DEST"
done

# Strip Windows line endings in case the repo was checked out on Windows.
find "$DEST" -maxdepth 1 -name '*.py' -exec sed -i 's/\r$//' {} +

if [ -n "${HERMES_OWNER:-}" ]; then
    chown -R "$HERMES_OWNER" "$DEST"
fi

if [ -z "${HERMITSHELL_SETUP:-}" ]; then
    echo
    echo "Next: run the setup wizard to enter your settings, API keys, profile and schedules:"
    echo "  python3 $REPO/scripts/setup.py --hermes-home $HERMES_HOME --no-install"
    echo "(or copy the *.example files, edit $HERMES_HOME/.env and register the cron jobs by hand;"
    echo "see each package README)."
fi

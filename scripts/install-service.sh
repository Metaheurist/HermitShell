#!/usr/bin/env sh
# Install HermitShell as a service on a Linux server, without a container. Run as root:
#
#   sudo sh scripts/install-service.sh [package...]      # default: every package
#
# Creates the hermitshell account, installs the packages into /opt/hermitshell (HERMITSHELL_HOME), their Python
# packages into scripts/.deps (doctor.py --fix, with pip or uv) and the standard schedule, then keeps the scheduler
# running with systemd, or starts it every minute from the account's crontab where there is no systemd. Re-run it
# after `git pull` to update: the scheduler restarts on the new code, and settings and data are kept.
#
# Settings: HERMITSHELL_HOME (default /opt/hermitshell), HERMITSHELL_USER (default hermitshell), PYTHON (python3).
set -eu

[ "$(id -u)" = 0 ] || { echo "run as root (sudo sh $0)" >&2; exit 1; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_HOME="${HERMITSHELL_HOME:-/opt/hermitshell}"
APP_USER="${HERMITSHELL_USER:-hermitshell}"
PY="${PYTHON:-$(command -v python3 || true)}"

case "$APP_HOME" in /*) ;; *) echo "HERMITSHELL_HOME must be an absolute path" >&2; exit 1 ;; esac
case "$APP_HOME$PY" in *[!A-Za-z0-9_./-]*) echo "use paths without spaces or quotes" >&2; exit 1 ;; esac
case "$APP_USER" in "" | *[!a-z0-9_-]*) echo "bad HERMITSHELL_USER" >&2; exit 1 ;; esac
[ -n "$PY" ] && [ -x "$PY" ] || { echo "python3 is needed (3.10 or newer)" >&2; exit 1; }
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { echo "Python 3.10 or newer is needed" >&2; exit 1; }

if ! id "$APP_USER" >/dev/null 2>&1; then
    if command -v useradd >/dev/null 2>&1; then
        useradd --system --home-dir "$APP_HOME" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
    else
        adduser -S -H -h "$APP_HOME" -s /sbin/nologin "$APP_USER"
    fi
    echo "created the $APP_USER account"
fi
GROUP="$(id -gn "$APP_USER")"
mkdir -p "$APP_HOME"
chmod 700 "$APP_HOME"

PACKAGES="$*"
[ -n "$PACKAGES" ] || PACKAGES="$(ls "$REPO/packages")"
# shellcheck disable=SC2086
HERMITSHELL_HOME="$APP_HOME" HERMITSHELL_SETUP=1 sh "$REPO/scripts/install.sh" $PACKAGES
chown -R "$APP_USER:$GROUP" "$APP_HOME"

as_app() { su -s /bin/sh "$APP_USER" -c "cd '$APP_HOME/scripts' && HERMITSHELL_HOME='$APP_HOME' $1"; }
as_app "'$PY' doctor.py --fix --only python,packages" || echo "some Python packages are missing; see above" >&2
as_app "'$PY' scheduler.py defaults --if-new"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    sed -e "s#@HOME@#$APP_HOME#g" -e "s#@USER@#$APP_USER#g" -e "s#@PYTHON@#$PY#g" \
        "$REPO/scripts/host/hermitshell.service" > /etc/systemd/system/hermitshell.service
    systemctl daemon-reload
    systemctl enable hermitshell.service >/dev/null 2>&1
    systemctl restart hermitshell.service
    echo "HermitShell's scheduler runs as the hermitshell service (journalctl -u hermitshell)"
else
    line="* * * * * HERMITSHELL_HOME=$APP_HOME $PY $APP_HOME/scripts/scheduler.py tick >/dev/null 2>&1"
    { crontab -u "$APP_USER" -l 2>/dev/null | grep -v 'scheduler.py tick' || true; echo "$line"; } | crontab -u "$APP_USER" -
    echo "No systemd here: the scheduler starts every minute from $APP_USER's crontab"
fi

echo
echo "Next, enter your settings, API keys, profile and schedules with the setup wizard:"
echo "  sudo -u $APP_USER HERMITSHELL_HOME=$APP_HOME $PY $REPO/scripts/setup.py --home $APP_HOME --no-install"
echo "Then check everything: sudo -u $APP_USER sh -c 'cd $APP_HOME/scripts && $PY doctor.py'"

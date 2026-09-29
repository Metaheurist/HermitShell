#!/bin/sh
# HermitShell's Ollama watchdog, run as root on the Docker host every 2 minutes by hermitshell-ollama-watchdog.timer.
#
# - Reports the machine to the scripts (CPU, memory, GPUs, whether Ollama can still see them) as
#   state/hardware.json, which autofit.py reads: the scripts run in a container that can't see the host's GPUs.
#   It is written from inside the HermitShell container, as its own user, never by root into a folder the
#   container can change.
# - Restarts an Ollama container that has lost its GPU ("Failed to initialize NVML", which happens to running
#   containers after a systemd reload), at most once every 20 minutes and 6 times a day per container, so a broken
#   driver can't cause a restart loop.
#
# Settings, from the environment or /etc/default/hermitshell-ollama-watchdog:
#   HERMITSHELL_CONTAINER  the HermitShell container (default hermitshell)
#   HERMITSHELL_USER       the user the scripts run as in it (default hermitshell)
#   HERMITSHELL_STATE      the scripts' state folder inside it (default /data/scripts/state)
# (HERMES_CONTAINER, HERMES_USER, HERMES_STATE and /etc/default/hermes-ollama-watchdog, from when HermitShell
# ran inside Hermes, are still read.)
#   OLLAMA_CONTAINERS   the Ollama containers to watch (default: every running container of an ollama/ollama image)
#   RESTART_MIN_GAP     seconds between restarts of one container (default 1200)
#   RESTART_MAX_PER_DAY restarts per container per day (default 6)
set -u
for CONF in /etc/default/hermes-ollama-watchdog /etc/default/hermitshell-ollama-watchdog; do
    # shellcheck disable=SC1090
    [ -r "$CONF" ] && . "$CONF"
done
CONTAINER=${HERMITSHELL_CONTAINER:-${HERMES_CONTAINER:-hermitshell}}
APP_USER=${HERMITSHELL_USER:-${HERMES_USER:-hermitshell}}
STATE=${HERMITSHELL_STATE:-${HERMES_STATE:-/data/scripts/state}}
MIN_GAP=${RESTART_MIN_GAP:-1200}
MAX_DAY=${RESTART_MAX_PER_DAY:-6}
RUN_DIR=${WATCHDOG_RUN_DIR:-/run/hermitshell-ollama-watchdog}
DOCKER=${DOCKER:-docker}

say() { echo "ollama-watchdog: $*"; }
clean() { tr -cd 'A-Za-z0-9 ._()/+-' | cut -c1-80 | sed 's/^ *//; s/ *$//'; }
digits() { v=$(printf '%s' "$1" | tr -cd '0-9'); echo "${v:-0}"; }
valid_name() { case "$1" in "" | *[!A-Za-z0-9_.-]*) return 1 ;; esac; return 0; }

umask 077
mkdir -p "$RUN_DIR" && chmod 700 "$RUN_DIR"

# ---------------------------------------------------------------- the machine
logical=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)
physical=$(awk -F: '/^physical id/ {p=$2} /^core id/ {print p ":" $2}' /proc/cpuinfo 2>/dev/null | sort -u | wc -l)
[ "$(digits "$physical")" -gt 0 ] || physical=$logical
cpu_model=$(awk -F: '/^model name/ {print $2; exit}' /proc/cpuinfo 2>/dev/null | clean)
avx2=false
grep -qw avx2 /proc/cpuinfo 2>/dev/null && avx2=true
mem_total=$(awk '/^MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
mem_avail=$(awk '/^MemAvailable/ {print int($2 / 1024)}' /proc/meminfo)

gpus=""
nvidia=false
if command -v nvidia-smi >/dev/null 2>&1; then
    list=$(nvidia-smi --query-gpu=index,name,memory.total,memory.free,compute_cap --format=csv,noheader,nounits 2>/dev/null)
    if [ -n "$list" ]; then
        nvidia=true
        gpus=$(printf '%s\n' "$list" | while IFS=, read -r idx name total free cc; do
            printf '{"index":%s,"name":"%s","vram_mb":%s,"free_mb":%s,"compute":"%s"},' \
                "$(digits "$idx")" "$(printf '%s' "$name" | clean)" "$(digits "$total")" "$(digits "$free")" \
                "$(printf '%s' "$cc" | tr -cd '0-9.' | cut -c1-8)"
        done)
    else
        say "nvidia-smi found no working GPU on the host (driver problem?); not restarting anything"
    fi
fi
n=0
for dev in /sys/class/drm/card[0-9]*/device; do
    [ -r "$dev/vendor" ] && [ "$(cat "$dev/vendor")" = "0x1002" ] && [ -r "$dev/mem_info_vram_total" ] || continue
    total=$(( $(digits "$(cat "$dev/mem_info_vram_total")") / 1048576 ))
    used=$(( $(digits "$(cat "$dev/mem_info_vram_used" 2>/dev/null)") / 1048576 ))
    gpus="$gpus{\"index\":$n,\"name\":\"AMD GPU (ROCm)\",\"vram_mb\":$total,\"free_mb\":$((total - used)),\"compute\":\"\"},"
    n=$((n + 1))
done
gpus=${gpus%,}

# ---------------------------------------------------------------- Ollama's access to the GPU
if [ -n "${OLLAMA_CONTAINERS:-}" ]; then
    containers=$OLLAMA_CONTAINERS
else
    containers=$($DOCKER ps --format '{{.Names}} {{.Image}}' 2>/dev/null | awk '$2 ~ /^(docker\.io\/)?ollama\/ollama/ {print $1}')
fi

seen=""
[ -n "$gpus" ] && $nvidia && seen=none
last_restart=0
for c in $containers; do
    valid_name "$c" || continue
    $nvidia || continue
    wants=$($DOCKER inspect -f '{{json .HostConfig.DeviceRequests}} {{json .HostConfig.Devices}}' "$c" 2>/dev/null)
    case "$wants" in *gpu* | *nvidia*) ;; *) continue ;; esac
    out=$($DOCKER exec "$c" nvidia-smi -L 2>&1)
    if [ $? -eq 0 ]; then
        seen=ok
        continue
    fi
    case "$out" in
        *"Failed to initialize NVML"* | *"No devices were found"* | *"Unable to determine the device handle"*) ;;
        *) continue ;;  # no nvidia-smi in the container: can't tell, so leave it alone
    esac
    [ "$seen" = ok ] || seen=lost
    now=$(date +%s)
    today=$(date +%Y%m%d)
    last=0 day="" count=0
    [ -r "$RUN_DIR/$c" ] && read -r last day count < "$RUN_DIR/$c"
    last=$(digits "$last") count=$(digits "$count")
    [ "$day" = "$today" ] || count=0
    if [ $((now - last)) -lt "$MIN_GAP" ] || [ "$count" -ge "$MAX_DAY" ]; then
        say "$c has lost the GPU; not restarting it again yet (last restart $((now - last))s ago, $count today)"
        continue
    fi
    say "$c has lost the GPU ($(printf '%s' "$out" | head -n 1 | clean)); restarting it"
    $DOCKER restart "$c" >/dev/null 2>&1 || say "could not restart $c"
    echo "$now $today $((count + 1))" > "$RUN_DIR/$c"
    last_restart=$now
    sleep "${RESTART_SETTLE:-5}"
    if $DOCKER exec "$c" nvidia-smi -L >/dev/null 2>&1; then
        say "$c can see the GPU again"
        seen=ok
    fi
done
for f in "$RUN_DIR"/*; do
    [ -r "$f" ] || continue
    read -r t _ _ < "$f"
    [ "$(digits "$t")" -gt "$last_restart" ] && last_restart=$(digits "$t")
done

# ---------------------------------------------------------------- the report, written as HermitShell's user
valid_name "$CONTAINER" || { say "bad HERMITSHELL_CONTAINER"; exit 1; }
valid_name "$APP_USER" || { say "bad HERMITSHELL_USER"; exit 1; }
case "$STATE" in /*) ;; *) say "HERMITSHELL_STATE must be an absolute path"; exit 1 ;; esac
case "$STATE" in *[!A-Za-z0-9_./-]*) say "bad HERMITSHELL_STATE"; exit 1 ;; esac
report=$(printf '{"at":%s,"cpu":{"model":"%s","logical":%s,"physical":%s,"avx2":%s},"ram_mb":{"total":%s,"available":%s},"gpus":[%s],"ollama_gpu":"%s","last_restart":%s}' \
    "$(date +%s)" "$cpu_model" "$(digits "$logical")" "$(digits "$physical")" "$avx2" "$(digits "$mem_total")" \
    "$(digits "$mem_avail")" "$gpus" "$seen" "$last_restart")
if $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
    printf '%s\n' "$report" | $DOCKER exec -i -u "$APP_USER" "$CONTAINER" sh -c \
        'umask 022; mkdir -p "$1" && cat > "$1/.hardware.json.tmp" && mv -f "$1/.hardware.json.tmp" "$1/hardware.json"' \
        sh "$STATE" || say "could not write the hardware report"
fi

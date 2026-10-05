#!/bin/sh
# Runs inside the production image after its entry point has installed the scripts into /data/scripts (the working
# folder). Trusts the test CA alongside the public CAs, proves every TLS path works, then runs the scheduler with the
# profile and cover-letter jobs every minute and the daily, weekly and nightly jobs paused.
set -eu
cat "$(python3 -m certifi)" /certs/ca.pem > /tmp/ca-bundle.pem
export REQUESTS_CA_BUNDLE=/tmp/ca-bundle.pem SSL_CERT_FILE=/tmp/ca-bundle.pem

until python3 /stack/probe.py; do
    echo "waiting for the Worker and Mailpit..."
    sleep 5
done

python3 scheduler.py defaults --if-new
for job in vacancy-profiles vacancy-cover-letters; do
    python3 scheduler.py edit "$job" --schedule "* * * * *" >/dev/null
done
for job in daily-vacancy-report weekly-vacancy-report vacancy-maintenance; do
    python3 scheduler.py pause "$job" >/dev/null 2>&1 || true
done
exec python3 scheduler.py run

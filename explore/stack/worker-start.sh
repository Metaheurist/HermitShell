#!/bin/sh
# The feedback Worker under wrangler dev, over https with the test certificate. The source is mounted read-only and
# copied in, so the Linux node_modules (in their own volume) never touch the Windows checkout.
set -eu
rm -rf /app/src
cp -r /src/src /src/package.json /src/package-lock.json /src/wrangler.jsonc /app/
cd /app
if [ ! -f node_modules/.lock-hash ] || [ "$(sha256sum package-lock.json | cut -c1-64)" != "$(cat node_modules/.lock-hash)" ]; then
    npm ci --no-audit --no-fund --loglevel=error
    sha256sum package-lock.json | cut -c1-64 > node_modules/.lock-hash
fi
umask 077
printf 'JOB_FEEDBACK_SECRET=%s\nJOB_FEEDBACK_API_TOKEN=%s\nADMIN_PASSWORD=%s\n' \
    "$JOB_FEEDBACK_SECRET" "$JOB_FEEDBACK_API_TOKEN" "$ADMIN_PASSWORD" > .dev.vars
unset JOB_FEEDBACK_SECRET JOB_FEEDBACK_API_TOKEN ADMIN_PASSWORD
exec npx wrangler dev --ip 0.0.0.0 --port 8787 --local-protocol https \
    --https-key-path /certs/worker-key.pem --https-cert-path /certs/worker.pem \
    --persist-to /state --show-interactive-dev-session=false

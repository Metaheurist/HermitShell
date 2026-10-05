# syntax=docker/dockerfile:1
# The HermitShell demo image (docs/demo-image.md): the real backend and feedback Worker with fictional people,
# fictional adverts and recorded AI answers, so it runs anywhere with no keys and no internet. Built from the repo
# root:
#
#   docker build -f demo/Dockerfile -t hermitshell-demo .
#   docker run --rm -p 127.0.0.1:8787:8787 -p 127.0.0.1:8025:8025 -p 127.0.0.1:8080:8080 hermitshell-demo demo
#
# Modes: app (default), demo, test, autorun. Every secret is made at random when the container first starts.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG MAILPIT_IMAGE=axllent/mailpit@sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48

FROM ${NODE_IMAGE} AS node

FROM ${MAILPIT_IMAGE} AS mailpit

FROM ${NODE_IMAGE} AS worker
WORKDIR /opt/worker
COPY packages/daily-vacancy-report/feedback-worker/package.json packages/daily-vacancy-report/feedback-worker/package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error && rm -rf node_modules/vitest node_modules/@vitest
COPY packages/daily-vacancy-report/feedback-worker/src ./src
COPY packages/daily-vacancy-report/feedback-worker/wrangler.jsonc ./

FROM ${NODE_IMAGE} AS explore
WORKDIR /opt/explore
COPY explore/package.json explore/package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY explore/run.mjs explore/playwright.explore.config.js ./
COPY explore/lib ./lib
COPY explore/journeys ./journeys
COPY explore/data ./data
COPY explore/replay ./replay
COPY explore/stack/probe.py ./stack/probe.py

FROM python:3.13-slim-bookworm

ARG UID=10000
ARG VERSION=dev
LABEL org.opencontainers.image.title="hermitshell-demo" \
      org.opencontainers.image.description="HermitShell demo: fictional people, adverts and recorded AI answers; app, demo, test and autorun modes" \
      org.opencontainers.image.source="https://github.com/Metaheurist/HermitShell" \
      org.opencontainers.image.version="${VERSION}"

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=mailpit /mailpit /usr/local/bin/mailpit

COPY requirements.txt /app/requirements.txt
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends tini tzdata openssl ca-certificates \
    && pip install --no-cache-dir --disable-pip-version-check -r /app/requirements.txt certifi \
    && groupadd --gid "${UID}" hermitshell \
    && useradd --uid "${UID}" --gid "${UID}" --home-dir /data --no-create-home --shell /usr/sbin/nologin hermitshell \
    && rm -rf /var/lib/apt/lists/*

COPY --from=worker /opt/worker /opt/worker
COPY --from=explore /opt/explore /opt/explore
# explore/lib/api.js signs requests with the Worker's own code, by its path in the repo.
COPY --from=worker /opt/worker/src /opt/packages/daily-vacancy-report/feedback-worker/src
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN cd /opt/explore && node node_modules/@playwright/test/cli.js install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /root/.cache /root/.npm

COPY common /app/common
COPY packages /app/packages
COPY scripts /app/scripts
COPY demo/start.mjs demo/certs.sh /opt/demo/
COPY demo/viewer /opt/demo/viewer
# wrangler keeps its cache in node_modules/.cache; everything else in /opt stays read-only for the app user.
RUN sed -i 's/\r$//' /opt/demo/certs.sh /opt/explore/stack/probe.py \
    && mkdir -p /data /out /opt/worker/node_modules/.cache \
    && chown "${UID}:${UID}" /data /out /opt/worker/node_modules/.cache

ENV HERMITSHELL_VERSION=${VERSION} \
    PYTHONUNBUFFERED=1 \
    PYTHONPYCACHEPREFIX=/tmp/hermitshell-pycache \
    NODE_ENV=production
VOLUME ["/data", "/out"]
WORKDIR /data
USER hermitshell
EXPOSE 8787 8025 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=3m --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8025/livez').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["tini", "--", "node", "/opt/demo/start.mjs"]
CMD ["app"]

# HermitShell as a container: the packages, their Python packages and the scheduler, with every setting and all
# data in the /data volume (docs/installation.md#run-it-as-a-container).
#
#   docker build -t hermitshell .
#   docker run -d --name hermitshell -v /srv/hermitshell:/data hermitshell
FROM python:3.13-slim

ARG UID=10000
ARG VERSION=dev
LABEL org.opencontainers.image.title="hermitshell" \
      org.opencontainers.image.description="HermitShell: CV-matched daily vacancy reports, cover letters and recruits, rated by a local model" \
      org.opencontainers.image.source="https://github.com/Metaheurist/HermitShell" \
      org.opencontainers.image.version="${VERSION}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "${UID}" hermitshell \
    && useradd --uid "${UID}" --gid "${UID}" --home-dir /data --no-create-home --shell /usr/sbin/nologin hermitshell

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --disable-pip-version-check -r /app/requirements.txt

COPY common /app/common
COPY packages /app/packages
COPY scripts /app/scripts
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod 755 /app/entrypoint.sh && mkdir -p /data && chown "${UID}:${UID}" /data

ENV HERMITSHELL_HOME=/data \
    HERMITSHELL_VERSION=${VERSION} \
    PYTHONUNBUFFERED=1 \
    PYTHONPYCACHEPREFIX=/tmp/hermitshell-pycache
VOLUME /data
WORKDIR /data
USER hermitshell

HEALTHCHECK --interval=1m --timeout=10s --start-period=2m --retries=3 \
    CMD ["python3", "/data/scripts/scheduler.py", "health"]
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
CMD ["run"]

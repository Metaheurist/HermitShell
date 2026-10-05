"""TLS probes for the explore stack: each way the backend opens a connection must trust the test CA (and, for
requests, still trust the public CAs). Prints one line per probe and exits 1 if any fails. Never prints secrets."""
import os
import smtplib
import socket
import ssl
import sys
from urllib.parse import urlsplit

import requests

worker = os.environ["JOB_FEEDBACK_URL"].rstrip("/")
host = urlsplit(worker).hostname or ""
port = urlsplit(worker).port or 443
results = []


def probe(name, check):
    try:
        check()
        results.append((name, "ok"))
    except Exception as exc:  # a probe reports any failure rather than stopping the others
        results.append((name, f"FAILED: {exc.__class__.__name__}: {str(exc)[:160]}"))


def worker_requests():
    requests.get(f"{worker}/privacy", timeout=10).raise_for_status()


def worker_default_context():
    with socket.create_connection((host, port), timeout=10) as raw:
        with ssl.create_default_context().wrap_socket(raw, server_hostname=host):
            pass


def mailpit_starttls():
    with smtplib.SMTP(os.environ["SMTP_HOST"], int(os.environ["SMTP_PORT"]), timeout=10) as smtp:
        smtp.ehlo()
        smtp.starttls(context=ssl.create_default_context())
        smtp.ehlo()
        smtp.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])


def replay_search():
    base = os.environ.get("FIRECRAWL_API_BASE")
    if base:
        requests.get(f"{base}/v1/team/credit-usage", timeout=10).raise_for_status()


def public_ca():
    if os.environ.get("EXPLORE_OFFLINE") == "1":
        return
    requests.head("https://api.firecrawl.dev", timeout=10)


probe("worker over requests", worker_requests)
probe("worker over ssl default context (smtplib, websockets)", worker_default_context)
probe("mailpit STARTTLS and login", mailpit_starttls)
probe("public CAs still trusted (requests)", public_ca)
if os.environ.get("FIRECRAWL_API_BASE"):
    probe("replay-search over requests", replay_search)
print(f"probes: {len(results)}", flush=True)
for name, outcome in results:
    print(f"probe: {name}: {outcome}", flush=True)
sys.exit(0 if all(outcome == "ok" for _, outcome in results) else 1)

#!/usr/bin/env python3
"""Deploy the feedback Worker with a Cloudflare API token: no Node.js or wrangler needed.

    python3 scripts/cloudflare_worker.py                   # deploy or update with $HERMES_HOME/.env
    python3 scripts/cloudflare_worker.py --hermes-home /path/to/hermes/data
    printf '%s' "$PASS" | python3 scripts/cloudflare_worker.py --admin-password-stdin
    python3 scripts/cloudflare_worker.py --access you@example.com

The setup wizard (setup.py) uses the same functions. From CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN it
finds (or creates) the account's workers.dev subdomain and the KV namespace, uploads the Worker's modules,
turns on its workers.dev address, stores the Worker secrets and can put /admin behind Cloudflare Access.
Secrets already on the Worker are kept; no secret value is ever printed.

Token permissions (account scope): Workers Scripts Edit and Workers KV Storage Edit; Access: Apps and
Policies Edit as well to protect /admin. See docs/cloudflare-setup.md.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.cloudflare.com/client/v4"
REPO = Path(__file__).resolve().parent.parent
WORKER_DIR = REPO / "packages" / "daily-vacancy-report" / "feedback-worker"
DEFAULT_NAME = "vacancy-feedback"
KV_BINDING = "FEEDBACK"
ACCOUNT_RE = re.compile(r"^[0-9a-f]{32}$")
NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
EMAIL_RE = re.compile(r"^[^@\s,]+@[^@\s,]+\.[^@\s,]+$")
USER_AGENT = "HermitShell-setup"


class CloudflareError(RuntimeError):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def worker_url(name: str, subdomain: str) -> str:
    return f"https://{name}.{subdomain}.workers.dev"


def worker_source(worker_dir: Path = WORKER_DIR) -> tuple[str, str, dict[str, bytes]]:
    """(main module, compatibility date, {module name: code}) from wrangler.jsonc and the modules beside main."""
    config = (worker_dir / "wrangler.jsonc").read_text(encoding="utf-8")
    main = re.search(r'"main"\s*:\s*"([^"]+)"', config)
    date = re.search(r'"compatibility_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"', config)
    if not (main and date):
        raise CloudflareError(f"{worker_dir / 'wrangler.jsonc'} has no main or compatibility_date")
    main_path = worker_dir / main.group(1)
    modules = {p.name: p.read_bytes() for p in sorted(main_path.parent.glob("*.js"))}
    if main_path.name not in modules:
        raise CloudflareError(f"Worker entry point {main_path} not found")
    return main_path.name, date.group(1), modules


def multipart(parts: list[tuple[str, str, str, bytes]]) -> tuple[bytes, str]:
    """multipart/form-data body from (field name, file name or "", content type, data) parts."""
    boundary = f"----hermitshell{secrets.token_hex(16)}"
    out = bytearray()
    for name, filename, ctype, data in parts:
        disposition = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else "")
        out += f"--{boundary}\r\nContent-Disposition: {disposition}\r\nContent-Type: {ctype}\r\n\r\n".encode()
        out += data + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


class Cloudflare:
    """The few Cloudflare API calls the feedback Worker needs. The token never appears in errors or repr."""

    def __init__(self, account_id: str, token: str, urlopen=None, timeout: int = 60):
        account_id, token = (account_id or "").strip().lower(), (token or "").strip()
        if not ACCOUNT_RE.match(account_id):
            raise CloudflareError("The Cloudflare account ID should be 32 hexadecimal characters")
        if not token or any(c.isspace() for c in token):
            raise CloudflareError("The Cloudflare API token is empty or malformed")
        self.account = account_id
        self._token = token
        self._urlopen = urlopen or urllib.request.urlopen
        self.timeout = timeout

    def __repr__(self) -> str:
        return f"Cloudflare(account={self.account[:6]}...)"

    def _path(self, path: str) -> str:
        return f"/accounts/{self.account}{path}"

    def call(self, method: str, path: str, body=None, *, data: bytes | None = None,
             content_type: str = "application/json", params: dict | None = None):
        url = API + path + (f"?{urllib.parse.urlencode(params)}" if params else "")
        if body is not None:
            data = json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Authorization": f"Bearer {self._token}", "User-Agent": USER_AGENT})
        if data is not None:
            req.add_header("Content-Type", content_type)
        status = 200
        try:
            with self._urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            status, raw = exc.code, exc.read()
        except (urllib.error.URLError, OSError) as exc:
            raise CloudflareError(f"Cloudflare API unreachable ({exc.__class__.__name__})") from None
        try:
            payload = json.loads(raw or b"{}")
        except ValueError:
            payload = {}
        if status >= 400 or not payload.get("success"):
            errors = "; ".join(f"{e.get('code')}: {e.get('message')}" for e in (payload.get("errors") or [])[:3])
            where = path.replace(self.account, "<account>")
            raise CloudflareError(f"{method} {where} failed ({errors or f'HTTP {status}'})", status)
        return payload.get("result")

    def verify(self) -> None:
        """Account-owned tokens verify under the account, user tokens under /user."""
        try:
            result = self.call("GET", self._path("/tokens/verify"))
        except CloudflareError:
            result = self.call("GET", "/user/tokens/verify")
        if (result or {}).get("status") != "active":
            raise CloudflareError("The Cloudflare API token is not active")

    def subdomain(self) -> str:
        """The account's workers.dev subdomain, or "" when it has none yet."""
        try:
            return (self.call("GET", self._path("/workers/subdomain")) or {}).get("subdomain") or ""
        except CloudflareError as exc:
            if exc.status == 404:
                return ""
            raise

    def create_subdomain(self, name: str) -> str:
        if not NAME_RE.match(name):
            raise CloudflareError(f"'{name}' is not a valid subdomain (lowercase letters, digits and hyphens)")
        return (self.call("PUT", self._path("/workers/subdomain"), {"subdomain": name}) or {}).get("subdomain", name)

    def kv_namespace(self, title: str) -> tuple[str, bool]:
        """(namespace id, created) for the namespace with this title, creating it when missing."""
        page = 1
        while True:
            found = self.call("GET", self._path("/storage/kv/namespaces"), params={"per_page": 100, "page": page})
            for ns in found or []:
                if ns.get("title") == title:
                    return ns["id"], False
            if len(found or []) < 100:
                break
            page += 1
        return self.call("POST", self._path("/storage/kv/namespaces"), {"title": title})["id"], True

    def upload_worker(self, name: str, main: str, compatibility_date: str, modules: dict[str, bytes],
                      kv_id: str) -> None:
        metadata = {
            "main_module": main,
            "compatibility_date": compatibility_date,
            "bindings": [{"type": "kv_namespace", "name": KV_BINDING, "namespace_id": kv_id}],
            "keep_bindings": ["secret_text", "secret_key"],
            "observability": {"enabled": True},
        }
        parts = [("metadata", "", "application/json", json.dumps(metadata).encode())]
        parts += [(n, n, "application/javascript+module", code) for n, code in modules.items()]
        data, ctype = multipart(parts)
        self.call("PUT", self._path(f"/workers/scripts/{name}"), data=data, content_type=ctype)

    def enable_workers_dev(self, name: str) -> None:
        self.call("POST", self._path(f"/workers/scripts/{name}/subdomain"), {"enabled": True, "previews_enabled": False})

    def put_secret(self, name: str, key: str, value: str) -> None:
        self.call("PUT", self._path(f"/workers/scripts/{name}/secrets"),
                  {"name": key, "text": value, "type": "secret_text"})

    def access_app(self, host: str, emails: list[str]) -> str:
        """AUD tag of the Access application guarding https://<host>/admin, created with an email allow policy."""
        domain = f"{host}/admin"
        for app in self.call("GET", self._path("/access/apps")) or []:
            if app.get("domain") == domain:
                return app["aud"]
        policy = self.call("POST", self._path("/access/policies"), {
            "name": f"{host} admins", "decision": "allow", "session_duration": "24h",
            "include": [{"email": {"email": e}} for e in emails]})
        app = self.call("POST", self._path("/access/apps"), {
            "name": f"{host.split('.')[0]} admin", "type": "self_hosted", "domain": domain,
            "session_duration": "24h", "app_launcher_visible": False,
            "policies": [{"id": policy["id"], "precedence": 1}]})
        return app["aud"]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def access_team_domain(url: str, opener=None, tries: int = 6, pause: float = 5.0) -> str:
    """<team>.cloudflareaccess.com, read from the sign-in redirect Access sends for a protected URL."""
    opener = opener or urllib.request.build_opener(_NoRedirect)
    for attempt in range(tries):
        location = ""
        try:
            with opener.open(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=20) as resp:
                location = resp.headers.get("Location", "")
        except urllib.error.HTTPError as exc:
            location = exc.headers.get("Location", "") if exc.headers else ""
        except (urllib.error.URLError, OSError):
            pass
        host = urllib.parse.urlsplit(location).hostname or ""
        if host.endswith(".cloudflareaccess.com"):
            return host
        if attempt < tries - 1:
            time.sleep(pause)
    return ""


def deploy(cf: Cloudflare, name: str, subdomain: str, worker_secrets: dict[str, str], log=print,
           worker_dir: Path = WORKER_DIR) -> str:
    """Upload the Worker with its KV binding, turn on workers.dev and set the given secrets; returns its URL."""
    if not NAME_RE.match(name):
        raise CloudflareError(f"'{name}' is not a valid Worker name (lowercase letters, digits and hyphens)")
    main, date, modules = worker_source(worker_dir)
    title = f"{name}-{KV_BINDING}"
    kv_id, created = cf.kv_namespace(title)
    log(f"  KV namespace {title}: {'created' if created else 'found'}")
    cf.upload_worker(name, main, date, modules, kv_id)
    log(f"  Worker {name}: uploaded ({len(modules)} modules)")
    cf.enable_workers_dev(name)
    for key, value in worker_secrets.items():
        if value:
            cf.put_secret(name, key, value)
            log(f"  secret {key}: set")
    return worker_url(name, subdomain)


def protect_admin(cf: Cloudflare, name: str, subdomain: str, emails: list[str], log=print, opener=None) -> None:
    """Put /admin behind Cloudflare Access (emailed one-time code) and give the Worker the AUD and team domain."""
    bad = [e for e in emails if not EMAIL_RE.match(e)]
    if not emails or bad:
        raise CloudflareError(f"Access needs valid email addresses (got {', '.join(bad) or 'none'})")
    host = f"{name}.{subdomain}.workers.dev"
    aud = cf.access_app(host, emails)
    log(f"  Access application for {name}'s /admin: ready")
    team = access_team_domain(f"https://{host}/admin", opener)
    if not team:
        raise CloudflareError("The Access application exists, but its team domain couldn't be read yet; re-run "
                              "in a minute or set ACCESS_TEAM_DOMAIN with wrangler (docs/cloudflare-setup.md)")
    cf.put_secret(name, "ACCESS_AUD", aud)
    cf.put_secret(name, "ACCESS_TEAM_DOMAIN", team)
    log("  secrets ACCESS_AUD, ACCESS_TEAM_DOMAIN: set")


# --------------------------------------------------------------------------- command line

def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if path.is_file():
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$", raw)
            if m:
                value = m.group(2).strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                values[m.group(1)] = value
    return values


def set_env_value(path: Path, key: str, value: str) -> None:
    """Replace or append KEY=value, keeping the file's other lines and its mode."""
    lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    pattern = re.compile(rf"^\s*(?:export\s+)?{re.escape(key)}=")
    out = [f"{key}={value}" if pattern.match(line) else line for line in lines]
    if not any(pattern.match(line) for line in lines):
        out.append(f"{key}={value}")
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    tmp = path.with_name(f".{path.name}.tmp-{secrets.token_hex(4)}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(out) + "\n")
    os.replace(tmp, path)


def default_home() -> Path:
    for candidate in (os.environ.get("HERMES_HOME"), "/opt/data" if Path("/opt/data/.env").is_file() else None):
        if candidate:
            return Path(candidate)
    return Path.home() / ".hermes"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Deploy or update the feedback Worker with a Cloudflare API token.")
    parser.add_argument("--hermes-home", help="Hermes home holding .env (default: $HERMES_HOME, /opt/data or ~/.hermes)")
    parser.add_argument("--admin-user", help="set the /admin username")
    parser.add_argument("--admin-password-stdin", action="store_true", help="read a new /admin password from stdin")
    parser.add_argument("--access", metavar="EMAILS", help="protect /admin with Cloudflare Access for these emails")
    args = parser.parse_args(argv)

    env_path = Path(args.hermes_home or default_home()) / ".env"
    env = read_env(env_path)
    missing = [k for k in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "JOB_FEEDBACK_SECRET",
                           "JOB_FEEDBACK_API_TOKEN") if not env.get(k)]
    if missing:
        print(f"{env_path} is missing {', '.join(missing)}; run scripts/setup.py first.", file=sys.stderr)
        return 2
    worker_secrets = {k: env[k] for k in ("JOB_FEEDBACK_SECRET", "JOB_FEEDBACK_API_TOKEN")}
    if args.admin_user:
        worker_secrets["ADMIN_USER"] = args.admin_user.strip()
    if args.admin_password_stdin:
        password = sys.stdin.readline().rstrip("\r\n")
        if len(password) < 12:
            print("The admin password must be at least 12 characters.", file=sys.stderr)
            return 2
        worker_secrets["ADMIN_PASSWORD"] = password
    name = env.get("CLOUDFLARE_WORKER_NAME") or DEFAULT_NAME
    try:
        cf = Cloudflare(env["CLOUDFLARE_ACCOUNT_ID"], env["CLOUDFLARE_API_TOKEN"])
        cf.verify()
        subdomain = cf.subdomain()
        if not subdomain:
            print("This account has no workers.dev subdomain yet; run scripts/setup.py to pick one.", file=sys.stderr)
            return 2
        url = deploy(cf, name, subdomain, worker_secrets)
        if args.access:
            protect_admin(cf, name, subdomain, [e.strip() for e in args.access.split(",") if e.strip()])
    except CloudflareError as exc:
        print(f"Cloudflare: {exc}", file=sys.stderr)
        return 1
    current = env.get("JOB_FEEDBACK_URL", "").rstrip("/")
    if not current:
        set_env_value(env_path, "JOB_FEEDBACK_URL", url)
        print(f"Saved JOB_FEEDBACK_URL in {env_path}")
    elif current != url:
        print(f"Note: JOB_FEEDBACK_URL in {env_path} is {current}, the Worker's own address is {url}")
    print(f"Feedback Worker ready: {url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Tests for scripts/cloudflare_worker.py and the wizard's automatic Worker step, against a fake Cloudflare API."""

import argparse
import importlib.util
import io
import json
import sys
import urllib.error
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import cloudflare_worker as cw  # noqa: E402

_spec = importlib.util.spec_from_file_location("hermit_setup", REPO / "scripts" / "setup.py")
setup = sys.modules["hermit_setup"] = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(setup)

ACCOUNT = "0123456789abcdef0123456789abcdef"
TOKEN = "test-token-not-a-real-one-0000"


class Resp:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(url, code, body=None, headers=None):
    return urllib.error.HTTPError(url, code, "error", headers or {}, io.BytesIO(json.dumps(body or {}).encode()))


class FakeAPI:
    """Routes keyed by (method, path with the account id replaced by A); unknown routes answer 404."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, req, timeout=None):
        path = req.full_url.split("/client/v4", 1)[1].split("?")[0].replace(ACCOUNT, "A")
        self.calls.append({"method": req.get_method(), "path": path, "data": req.data,
                           "headers": dict(req.header_items())})
        result = self.routes.get((req.get_method(), path))
        if result is None:
            raise http_error(req.full_url, 404, {"success": False, "errors": [{"code": 10007, "message": "not found"}]})
        return Resp({"success": True, "result": result})

    def sent(self, method, path):
        return [c for c in self.calls if c["method"] == method and c["path"] == path]


def client(routes):
    api = FakeAPI(routes)
    return cw.Cloudflare(ACCOUNT, TOKEN, urlopen=api), api


BASE_ROUTES = {
    ("GET", "/accounts/A/storage/kv/namespaces"): [{"title": "vacancy-feedback-FEEDBACK", "id": "kv1"}],
    ("PUT", "/accounts/A/workers/scripts/vacancy-feedback"): {},
    ("POST", "/accounts/A/workers/scripts/vacancy-feedback/subdomain"): {},
    ("PUT", "/accounts/A/workers/scripts/vacancy-feedback/secrets"): {},
}


@pytest.mark.parametrize("account, token", [("not-hex", TOKEN), (ACCOUNT, ""), (ACCOUNT, "two words")])
def test_rejects_malformed_account_or_token(account, token):
    with pytest.raises(cw.CloudflareError):
        cw.Cloudflare(account, token)


def test_errors_and_repr_never_show_the_token_or_account():
    cf, _ = client({})
    with pytest.raises(cw.CloudflareError) as err:
        cf.call("GET", f"/accounts/{ACCOUNT}/workers/subdomain")
    assert err.value.status == 404
    text = str(err.value) + repr(cf)
    assert TOKEN not in text and ACCOUNT not in text and "<account>" in str(err.value)


def test_requests_carry_the_bearer_token():
    cf, api = client({("GET", "/accounts/A/workers/subdomain"): {"subdomain": "demo"}})
    assert cf.subdomain() == "demo"
    assert api.calls[0]["headers"]["Authorization"] == f"Bearer {TOKEN}"


def test_verify_falls_back_to_user_tokens():
    cf, api = client({("GET", "/user/tokens/verify"): {"status": "active"}})
    cf.verify()
    assert [c["path"] for c in api.calls] == ["/accounts/A/tokens/verify", "/user/tokens/verify"]


def test_verify_refuses_inactive_tokens():
    cf, _ = client({("GET", "/accounts/A/tokens/verify"): {"status": "disabled"}})
    with pytest.raises(cw.CloudflareError, match="not active"):
        cf.verify()


def test_missing_subdomain_is_empty():
    cf, _ = client({})
    assert cf.subdomain() == ""


def test_worker_source_reads_every_module():
    main, date, modules = cw.worker_source()
    assert main == "index.js" and len(date) == 10
    assert {"index.js", "admin.js", "join.js", "lib.js"} <= set(modules)


def test_deploy_reuses_kv_uploads_modules_and_keeps_secrets():
    cf, api = client(dict(BASE_ROUTES))
    logs = []
    url = cw.deploy(cf, "vacancy-feedback", "demo", {"JOB_FEEDBACK_SECRET": "s1", "ADMIN_PASSWORD": ""},
                    log=logs.append)
    assert url == "https://vacancy-feedback.demo.workers.dev"
    assert not api.sent("POST", "/accounts/A/storage/kv/namespaces")
    upload = api.sent("PUT", "/accounts/A/workers/scripts/vacancy-feedback")[0]
    body = upload["data"].decode()
    assert upload["headers"]["Content-type"].startswith("multipart/form-data; boundary=")
    meta = json.loads(body.split('name="metadata"', 1)[1].split("\r\n\r\n", 1)[1].split("\r\n--", 1)[0])
    assert meta["main_module"] == "index.js"
    assert meta["bindings"] == [{"type": "kv_namespace", "name": "FEEDBACK", "namespace_id": "kv1"}]
    assert meta["keep_bindings"] == ["secret_text", "secret_key"]
    for module in ("index.js", "admin.js", "join.js", "lib.js"):
        assert f'filename="{module}"' in body
    assert body.count("application/javascript+module") >= 4
    assert api.sent("POST", "/accounts/A/workers/scripts/vacancy-feedback/subdomain")
    secrets_sent = [json.loads(c["data"]) for c in api.sent("PUT", "/accounts/A/workers/scripts/vacancy-feedback/secrets")]
    assert secrets_sent == [{"name": "JOB_FEEDBACK_SECRET", "text": "s1", "type": "secret_text"}]
    assert not any("s1" in line for line in logs)


def test_deploy_creates_a_missing_kv_namespace():
    routes = dict(BASE_ROUTES)
    routes[("GET", "/accounts/A/storage/kv/namespaces")] = []
    routes[("POST", "/accounts/A/storage/kv/namespaces")] = {"id": "kv2"}
    cf, api = client(routes)
    cw.deploy(cf, "vacancy-feedback", "demo", {}, log=lambda _: None)
    assert json.loads(api.sent("POST", "/accounts/A/storage/kv/namespaces")[0]["data"]) == \
        {"title": "vacancy-feedback-FEEDBACK"}
    assert b'"namespace_id": "kv2"' in api.sent("PUT", "/accounts/A/workers/scripts/vacancy-feedback")[0]["data"]


def test_deploy_rejects_bad_worker_names():
    cf, _ = client({})
    with pytest.raises(cw.CloudflareError):
        cw.deploy(cf, "Bad_Name", "demo", {}, log=lambda _: None)


class RedirectOpener:
    def __init__(self, location):
        self.location = location
        self.urls = []

    def open(self, req, timeout=None):
        self.urls.append(req.full_url)
        raise http_error(req.full_url, 302, headers={"Location": self.location} if self.location else {})


def test_protect_admin_creates_the_app_and_sets_the_access_secrets():
    routes = dict(BASE_ROUTES)
    routes[("GET", "/accounts/A/access/apps")] = []
    routes[("POST", "/accounts/A/access/policies")] = {"id": "pol1"}
    routes[("POST", "/accounts/A/access/apps")] = {"aud": "aud-tag"}
    cf, api = client(routes)
    opener = RedirectOpener("https://myteam.cloudflareaccess.com/cdn-cgi/access/login/x?kid=1")
    cw.protect_admin(cf, "vacancy-feedback", "demo", ["sam@example.com"], log=lambda _: None, opener=opener)
    policy = json.loads(api.sent("POST", "/accounts/A/access/policies")[0]["data"])
    assert policy["decision"] == "allow" and policy["include"] == [{"email": {"email": "sam@example.com"}}]
    app = json.loads(api.sent("POST", "/accounts/A/access/apps")[0]["data"])
    assert app["domain"] == "vacancy-feedback.demo.workers.dev/admin" and app["type"] == "self_hosted"
    assert app["policies"] == [{"id": "pol1", "precedence": 1}]
    assert opener.urls == ["https://vacancy-feedback.demo.workers.dev/admin"]
    secrets_sent = {json.loads(c["data"])["name"]: json.loads(c["data"])["text"]
                    for c in api.sent("PUT", "/accounts/A/workers/scripts/vacancy-feedback/secrets")}
    assert secrets_sent == {"ACCESS_AUD": "aud-tag", "ACCESS_TEAM_DOMAIN": "myteam.cloudflareaccess.com"}


def test_protect_admin_reuses_an_existing_app():
    routes = dict(BASE_ROUTES)
    routes[("GET", "/accounts/A/access/apps")] = [{"domain": "vacancy-feedback.demo.workers.dev/admin", "aud": "old"}]
    cf, api = client(routes)
    cw.protect_admin(cf, "vacancy-feedback", "demo", ["sam@example.com"], log=lambda _: None,
                     opener=RedirectOpener("https://myteam.cloudflareaccess.com/cdn-cgi/access/login/x"))
    assert not api.sent("POST", "/accounts/A/access/apps")


def test_protect_admin_needs_valid_emails():
    cf, _ = client({})
    with pytest.raises(cw.CloudflareError):
        cw.protect_admin(cf, "vacancy-feedback", "demo", ["not-an-email"], log=lambda _: None)


def test_team_domain_ignores_other_redirects():
    opener = RedirectOpener("https://evil.example.com/cloudflareaccess.com")
    assert cw.access_team_domain("https://w.demo.workers.dev/admin", opener, tries=2, pause=0) == ""
    assert len(opener.urls) == 2


def test_set_env_value_replaces_or_appends(tmp_path):
    env = tmp_path / ".env"
    env.write_text("# comment\nA=1\nJOB_FEEDBACK_URL=\n", encoding="utf-8")
    cw.set_env_value(env, "JOB_FEEDBACK_URL", "https://w.demo.workers.dev")
    cw.set_env_value(env, "NEW", "x")
    assert env.read_text(encoding="utf-8") == "# comment\nA=1\nJOB_FEEDBACK_URL=https://w.demo.workers.dev\nNEW=x\n"


def test_cli_needs_the_saved_settings(tmp_path, capsys):
    (tmp_path / ".env").write_text("CLOUDFLARE_ACCOUNT_ID=\n", encoding="utf-8")
    assert cw.main(["--hermes-home", str(tmp_path)]) == 2
    assert "CLOUDFLARE_API_TOKEN" in capsys.readouterr().err


# --------------------------------------------------------------------------- the wizard step

class FakeCF:
    def __init__(self, account, token, subdomain=""):
        self.account, self.token, self._subdomain = account, token, subdomain

    def verify(self):
        pass

    def subdomain(self):
        return self._subdomain


def wizard(tmp_path, answers: str, current=None, dry_run=False):
    path = tmp_path / "answers.env"
    path.write_text(answers, encoding="utf-8")
    args = argparse.Namespace(non_interactive=True, answers=str(path), advanced=False, dry_run=dry_run)
    w = setup.Wizard(args)
    w.current = dict(current or {})
    return w


ANSWERS = (f"CLOUDFLARE_ACCOUNT_ID={ACCOUNT}\nCLOUDFLARE_API_TOKEN={TOKEN}\nCLOUDFLARE_SUBDOMAIN=sam-demo\n"
           "ADMIN_PASSWORD=correct-horse-battery\nCLOUDFLARE_ACCESS_EMAILS=sam@example.com\n")


def test_wizard_plans_the_worker_from_the_token(tmp_path, capsys):
    w = wizard(tmp_path, ANSWERS)
    w.cloudflare_factory = FakeCF
    w.feedback_buttons()
    assert w.changes["JOB_FEEDBACK_URL"] == "https://vacancy-feedback.sam-demo.workers.dev"
    assert w.changes["CLOUDFLARE_API_TOKEN"] == TOKEN
    assert "CLOUDFLARE_WORKER_NAME" not in w.changes
    assert w.changes["CLOUDFLARE_ACCESS_EMAILS"] == "sam@example.com"
    assert len(w.changes["JOB_FEEDBACK_SECRET"]) >= 32 and len(w.changes["JOB_FEEDBACK_API_TOKEN"]) >= 32
    assert "ADMIN_PASSWORD" not in w.changes
    plan = w.cf_plan
    assert plan["new_subdomain"] == "sam-demo" and plan["emails"] == ["sam@example.com"]
    assert plan["secrets"]["ADMIN_PASSWORD"] == "correct-horse-battery" and plan["secrets"]["ADMIN_USER"] == "admin"
    assert "correct-horse-battery" not in capsys.readouterr().out


def test_wizard_keeps_a_custom_worker_address_and_existing_secrets(tmp_path):
    current = {"JOB_FEEDBACK_URL": "https://feedback.example.org", "JOB_FEEDBACK_SECRET": "keep-me"}
    w = wizard(tmp_path, f"CLOUDFLARE_ACCOUNT_ID={ACCOUNT}\nCLOUDFLARE_API_TOKEN={TOKEN}\n", current)
    w.cloudflare_factory = lambda a, t: FakeCF(a, t, subdomain="sam")
    w.feedback_buttons()
    assert "JOB_FEEDBACK_URL" not in w.changes
    assert "JOB_FEEDBACK_SECRET" not in w.changes
    assert w.cf_plan["secrets"]["JOB_FEEDBACK_SECRET"] == "keep-me"
    assert "ADMIN_PASSWORD" not in w.cf_plan["secrets"] and w.cf_plan["new_subdomain"] == ""


def test_wizard_refuses_a_short_admin_password(tmp_path):
    w = wizard(tmp_path, f"CLOUDFLARE_ACCOUNT_ID={ACCOUNT}\nCLOUDFLARE_API_TOKEN={TOKEN}\nADMIN_PASSWORD=short\n")
    w.cloudflare_factory = lambda a, t: FakeCF(a, t, subdomain="sam")
    with pytest.raises(SystemExit):
        w.feedback_buttons()


def test_wizard_without_a_token_falls_back_to_the_manual_url(tmp_path):
    w = wizard(tmp_path, "JOB_FEEDBACK_URL=https://feedback.example.org\n")
    w.feedback_buttons()
    assert w.cf_plan is None and w.changes["JOB_FEEDBACK_URL"] == "https://feedback.example.org"


def test_wizard_deploy_creates_subdomain_then_worker_then_access(tmp_path, monkeypatch):
    w = wizard(tmp_path, ANSWERS)
    w.cloudflare_factory = FakeCF
    w.feedback_buttons()
    order = []
    w.cf_plan["cf"].create_subdomain = lambda name: order.append(("subdomain", name))
    monkeypatch.setattr(setup.cloudflare_worker, "deploy", lambda cf, name, sub, secrets, log: order.append(
        ("deploy", name, sub, sorted(secrets))) or cw.worker_url(name, sub))
    monkeypatch.setattr(setup.cloudflare_worker, "protect_admin",
                        lambda cf, name, sub, emails, log: order.append(("access", emails)))
    w.deploy_worker()
    assert order == [("subdomain", "sam-demo"),
                     ("deploy", "vacancy-feedback", "sam-demo",
                      ["ADMIN_PASSWORD", "ADMIN_USER", "JOB_FEEDBACK_API_TOKEN", "JOB_FEEDBACK_SECRET"]),
                     ("access", ["sam@example.com"])]


def test_wizard_dry_run_deploys_nothing(tmp_path, monkeypatch, capsys):
    w = wizard(tmp_path, ANSWERS, dry_run=True)
    w.cloudflare_factory = FakeCF
    w.feedback_buttons()
    monkeypatch.setattr(setup.cloudflare_worker, "deploy", lambda *a, **k: pytest.fail("deployed in a dry run"))
    w.deploy_worker()
    assert "would deploy vacancy-feedback" in capsys.readouterr().out

"""Keeps every test away from a real HermitShell install: .env, dashboard settings, the schedule and state live in a
temporary folder, and settings inherited from the shell are dropped before any script module is imported."""
import os
import sys
import tempfile
from pathlib import Path

import pytest

_HOME = Path(tempfile.mkdtemp(prefix="hermitshell-tests-"))
os.environ.update({"HERMITSHELL_HOME": str(_HOME), "HERMES_HOME": str(_HOME), "HERMES_STATE_DIR": str(_HOME / "state"),
                   "HERMES_DASHBOARD_FILE": str(_HOME / "state" / "dashboard.json"),
                   "HERMES_MODEL_QUEUE_DIR": str(_HOME / "model-queue"), "HERMES_AUTOFIT": "off",
                   "HERMES_USAGE_FILE": str(_HOME / "llm_usage.json")})
for _key in [k for k in os.environ if k.startswith(("JOB_", "SMTP_", "FIRECRAWL_", "TAVILY_", "SCRAPFLY_", "ALERT_",
                                                    "COVER_LETTER_", "CLOUDFLARE_", "OLLAMA_", "HERMITSHELL_JOB_",
                                                    "HERMITSHELL_CATCHUP_", "HERMES_MODEL_CONCURRENCY",
                                                    "HERMES_AUTOFIT_", "OPENROUTER_", "BAZAARLINK_", "FEATHERLESS_",
                                                    "HUGGINGFACE_", "LLM_"))]:
    del os.environ[_key]
os.environ.pop("HERMES_DASHBOARD_APPLIED", None)


@pytest.fixture(autouse=True)
def _plain_requests(monkeypatch):
    """Scripts send through hermes_common.http(); tests mock requests.get and requests.post, so http() hands those out."""
    if "hermes_common" in sys.modules:
        monkeypatch.setattr(sys.modules["hermes_common"], "http", lambda: sys.modules["requests"])


@pytest.fixture(autouse=True)
def _no_ollama(monkeypatch):
    """The dashboard's status asks Ollama which models it has; tests that want an Ollama fake one themselves."""
    if "model_pull" in sys.modules:
        monkeypatch.setattr(sys.modules["model_pull"], "ollama", lambda: None)


@pytest.fixture(autouse=True)
def _no_retry_waits(monkeypatch):
    """worker_link retries a dropped connection after 1 and 2 seconds; tests don't wait for them."""
    if "worker_link" in sys.modules:
        monkeypatch.setattr(sys.modules["worker_link"], "_sleep", lambda seconds: None)

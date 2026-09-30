"""Keeps every test away from a real HermitShell install: .env, dashboard settings, the schedule and state live in a
temporary folder, and settings inherited from the shell are dropped before any script module is imported."""
import os
import tempfile
from pathlib import Path

_HOME = Path(tempfile.mkdtemp(prefix="hermitshell-tests-"))
os.environ.update({"HERMITSHELL_HOME": str(_HOME), "HERMES_HOME": str(_HOME), "HERMES_STATE_DIR": str(_HOME / "state"),
                   "HERMES_DASHBOARD_FILE": str(_HOME / "state" / "dashboard.json"),
                   "HERMES_MODEL_QUEUE_DIR": str(_HOME / "model-queue"), "HERMES_AUTOFIT": "off"})
for _key in [k for k in os.environ if k.startswith(("JOB_", "SMTP_", "FIRECRAWL_", "TAVILY_", "SCRAPFLY_", "ALERT_",
                                                    "COVER_LETTER_", "CLOUDFLARE_", "OLLAMA_", "HERMITSHELL_JOB_",
                                                    "HERMITSHELL_CATCHUP_", "HERMES_MODEL_CONCURRENCY",
                                                    "HERMES_AUTOFIT_", "OPENROUTER_", "BAZAARLINK_", "FEATHERLESS_",
                                                    "HUGGINGFACE_", "LLM_"))]:
    del os.environ[_key]
os.environ.pop("HERMES_DASHBOARD_APPLIED", None)

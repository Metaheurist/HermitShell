"""Keeps every test away from a real Hermes install: .env, dashboard settings and state live in a temporary folder,
and settings inherited from the shell are dropped before any script module is imported."""
import os
import tempfile
from pathlib import Path

_HOME = Path(tempfile.mkdtemp(prefix="hermes-tests-"))
os.environ.update({"HERMES_HOME": str(_HOME), "HERMES_STATE_DIR": str(_HOME / "state"),
                   "HERMES_DASHBOARD_FILE": str(_HOME / "state" / "dashboard.json")})
for _key in [k for k in os.environ if k.startswith(("JOB_", "SMTP_", "FIRECRAWL_", "TAVILY_", "SCRAPFLY_", "ALERT_",
                                                    "COVER_LETTER_", "NEWS_", "CLOUDFLARE_"))]:
    del os.environ[_key]
os.environ.pop("HERMES_DASHBOARD_APPLIED", None)

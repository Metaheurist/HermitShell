"""Admin alerts by email: what each check finds, once plus all clear, the daily reminder and the switch."""

import json
import sys
from collections import namedtuple
from datetime import datetime
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import alerts  # noqa: E402
import hermes_common as hc  # noqa: E402

NOW = 1_800_000_000.0
Disk = namedtuple("Disk", "total used free")


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(alerts, "STATE_DIR", tmp_path / "state")
    (tmp_path / "state").mkdir()
    monkeypatch.setattr(hc.os, "environ", dict(hc.os.environ))
    for key in ("HERMES_ALERTS", "ALERT_CREDITS_BELOW_PCT", "ALERT_DISK_BELOW_PCT", "WEB_KEY_USAGE_MINUTES", hc.DATA_KEY_ENV):
        hc.os.environ.pop(key, None)
    hc.os.environ["HERMES_BACKUP_DIR"] = str(tmp_path / "backups")
    sent = []
    monkeypatch.setattr(alerts.profiles, "send_owner", lambda subject, lines, **kw: sent.append((subject, lines)))
    return sent


def usage_row(left, limit, unit="credits", hint="fc-...0001"):
    return {"hint": hint, "role": "main", "usage": {"used": limit - left, "limit": limit, "left": left, "plan": "",
                                                    "resets": "", "unit": unit}}


def test_credits_are_a_percentage_left_and_never_show_a_key(home, monkeypatch, tmp_path):
    reports = {"web": {"firecrawl": [usage_row(5, 100), usage_row(80, 100, hint="fc-...0002")],
                       "tavily": [usage_row(500, 1000)]},
               "models": {"openrouter": [usage_row(0.5, 10, "usd", "sk-...9999")],
                          "featherless": [{"hint": "x", "role": "main", "usage": {"unit": "plan", "plan": "Basic",
                                                                                  "limit": None, "left": None}}]}}
    monkeypatch.setattr(alerts.key_usage, "configured_keys", lambda: "web")
    monkeypatch.setattr(alerts.key_usage, "model_keys", lambda: "models")
    monkeypatch.setattr(alerts.key_usage, "report", lambda keys, state_dir, every: reports[keys])
    found = alerts.credits(tmp_path)
    assert found == {"credits:firecrawl:0": "Firecrawl main key: 5% of its credits left",
                     "credits:openrouter:0": "OpenRouter: 5% of its credit left"}
    assert "..." not in json.dumps(found)
    hc.os.environ["ALERT_CREDITS_BELOW_PCT"] = "60"
    assert "credits:tavily:0" in alerts.credits(tmp_path)


def test_credits_are_not_checked_when_usage_checks_are_off(home, monkeypatch, tmp_path):
    hc.os.environ["WEB_KEY_USAGE_MINUTES"] = "0"
    monkeypatch.setattr(alerts.key_usage, "report", lambda *a, **k: pytest.fail("checked"))
    assert alerts.credits(tmp_path) == {}


def test_a_provider_resting_for_credits_or_a_rejected_key(home, monkeypatch):
    providers = {"openrouter": {"resting_until": 1, "why": "out of credits"},
                 "groq": {"resting_until": 1, "why": "key rejected"},
                 "gemini": {"resting_until": 1, "why": "rate limited"},
                 "mistral": {"resting_until": None, "why": ""}}
    monkeypatch.setattr(alerts.llm_providers, "summary", lambda: {"providers": providers})
    found = alerts.resting()
    assert sorted(found) == ["resting:groq", "resting:openrouter"]
    assert found["resting:openrouter"].endswith("not being used: out of credits")


def test_ollama_down_alerts_after_30_minutes_once_it_had_answered(home, monkeypatch):
    up = [True]
    monkeypatch.setattr(alerts.hc, "ollama_hosts", lambda cfg: ["http://ollama:11434"])
    monkeypatch.setattr(alerts, "_answers", lambda host: up[0])
    monkeypatch.setattr(alerts.llm_providers, "configured", lambda: ["openrouter"])
    state = {}
    assert alerts.ollama(state, NOW) == {} and state["ollama"]["seen"]
    up[0] = False
    assert alerts.ollama(state, NOW + 60) == {}
    assert alerts.ollama(state, NOW + 60 + 29 * 60) == {}
    assert "ollama" in alerts.ollama(state, NOW + 60 + 30 * 60)
    up[0] = True
    assert alerts.ollama(state, NOW + 7200) == {} and state["ollama"]["down_since"] == 0


def test_a_server_that_never_used_ollama_is_not_told_while_a_cloud_model_answers(home, monkeypatch):
    monkeypatch.setattr(alerts.hc, "ollama_hosts", lambda cfg: ["http://ollama:11434"])
    monkeypatch.setattr(alerts, "_answers", lambda host: False)
    monkeypatch.setattr(alerts.llm_providers, "configured", lambda: ["openrouter"])
    state = {}
    alerts.ollama(state, NOW)
    assert alerts.ollama(state, NOW + 86400) == {}
    monkeypatch.setattr(alerts.llm_providers, "configured", lambda: [])
    assert "ollama" in alerts.ollama(state, NOW + 86400)


def test_backups_failed_stale_or_fine(home, tmp_path):
    folder = tmp_path / "backups"
    folder.mkdir()
    state = tmp_path / "state"
    assert alerts.backup(state, NOW) == {}
    (state / "backup.json").write_text(json.dumps({"at": NOW, "error": "OSError: no space left"}))
    assert alerts.backup(state, NOW) == {"backup": "The last backup failed: OSError: no space left"}
    (state / "backup.json").write_text(json.dumps({"at": NOW, "error": ""}))
    assert alerts.backup(state, NOW) == {"backup": "No backup has been made yet"}
    made = datetime(2026, 9, 1, 3, 30)
    (folder / f"hermitshell-{made:%Y%m%d-%H%M%S}.tar.gz.enc").write_bytes(b"x")
    assert alerts.backup(state, made.timestamp() + 35 * 3600) == {}
    assert alerts.backup(state, made.timestamp() + 37 * 3600) == {"backup": "No backup for 37 hours"}


def test_a_failed_copy_to_the_worker_is_its_own_alert(home, tmp_path):
    folder = tmp_path / "backups"
    folder.mkdir()
    state = tmp_path / "state"
    made = datetime(2026, 9, 1, 3, 30)
    (folder / f"hermitshell-{made:%Y%m%d-%H%M%S}.tar.gz.enc").write_bytes(b"x")
    later = made.timestamp() + 3600

    def noted(offsite):
        (state / "backup.json").write_text(json.dumps({"at": made.timestamp(), "error": "", "offsite": offsite}))
        return alerts.backup(state, later)

    failed = {"on": True, "at": made.timestamp() - 86400, "error": "feedback Worker answered HTTP 507", "failed_at": made.timestamp()}
    assert noted(failed) == {"offsite": "Sending the last backup to Cloudflare failed: feedback Worker answered HTTP 507"}
    assert noted({**failed, "at": made.timestamp() + 60}) == {}, "a copy sent since clears it"
    assert noted({"on": False, "why": "off"}) == {}
    assert noted({**failed, "on": False}) == {}
    (state / "backup.json").write_text(json.dumps({"at": made.timestamp(), "error": "OSError: disk full", "offsite": failed}))
    assert set(alerts.backup(state, later)) == {"backup", "offsite"}


def test_disk_space_below_the_setting(home, monkeypatch, tmp_path):
    monkeypatch.setattr(alerts.shutil, "disk_usage", lambda path: Disk(100 * 2**30, 95 * 2**30, 5 * 2**30))
    assert alerts.disk(tmp_path) == {"disk": "Only 5% of the disk is free (5.0 GB)"}
    hc.os.environ["ALERT_DISK_BELOW_PCT"] = "4"
    assert alerts.disk(tmp_path) == {}


def test_a_worker_protocol_mismatch_after_30_minutes(home, monkeypatch):
    seen = {"protocol": alerts.worker_link.PROTOCOL - 1, "at": NOW}
    monkeypatch.setattr(alerts.worker_link, "worker_protocol", lambda: seen)
    assert alerts.protocol(NOW + 60) == {}
    assert "redeploy" in alerts.protocol(NOW + 1800)["protocol"]
    seen["protocol"] = alerts.worker_link.PROTOCOL + 1
    assert "update it" in alerts.protocol(NOW + 1800)["protocol"]
    seen["protocol"] = alerts.worker_link.PROTOCOL
    assert alerts.protocol(NOW + 1800) == {}


def test_one_failing_check_does_not_stop_the_others(home, monkeypatch):
    monkeypatch.setattr(alerts, "resting", lambda: 1 / 0)
    monkeypatch.setattr(alerts, "credits", lambda d: {"credits:tavily:0": "Tavily: 1% of its credits left"})
    for name in ("ollama", "backup", "protocol", "disk"):
        monkeypatch.setattr(alerts, name, lambda *a: {})
    assert alerts.checks({}, NOW) == {"credits:tavily:0": "Tavily: 1% of its credits left"}


def open_now(monkeypatch, found):
    monkeypatch.setattr(alerts, "checks", lambda state, now: dict(found))


def test_each_alert_is_emailed_once_then_all_clear(home, monkeypatch):
    found = {"disk": "Only 5% of the disk is free (5.0 GB)", "resting:groq": "Groq is not being used: key rejected"}
    open_now(monkeypatch, found)
    assert len(alerts.run(NOW)) == 2
    assert home[0][0] == "2 alerts" and home[0][1][0] == "These need a look:"
    assert alerts.run(NOW + alerts.EVERY) == [] and len(home) == 1
    del found["disk"]
    open_now(monkeypatch, found)
    assert alerts.run(NOW + 2 * alerts.EVERY) == ["cleared: Only 5% of the disk is free (5.0 GB)"]
    assert home[1] == ("All clear", ["All clear now:", "Only 5% of the disk is free (5.0 GB)"])


def test_an_open_alert_is_repeated_at_most_once_a_day(home, monkeypatch):
    open_now(monkeypatch, {"disk": "Only 5% of the disk is free (5.0 GB)"})
    alerts.run(NOW)
    alerts.run(NOW + 86400 - alerts.EVERY)
    assert len(home) == 1
    assert alerts.run(NOW + 86400) == ["Only 5% of the disk is free (5.0 GB) (still)"]
    assert home[1][0] == "Only 5% of the disk is free (5.0 GB)"


def test_checks_run_at_most_every_15_minutes(home, monkeypatch):
    calls = []
    monkeypatch.setattr(alerts, "checks", lambda state, now: calls.append(now) or {})
    alerts.run(NOW)
    alerts.run(NOW + alerts.EVERY - 1)
    alerts.run(NOW + alerts.EVERY)
    alerts.run(NOW + alerts.EVERY + 1, force=True)
    assert calls == [NOW, NOW + alerts.EVERY, NOW + alerts.EVERY + 1]


def test_an_unsent_email_is_tried_again_next_run(home, monkeypatch):
    open_now(monkeypatch, {"disk": "Only 5% of the disk is free (5.0 GB)"})
    monkeypatch.setattr(alerts.profiles, "send_owner", lambda *a, **k: 1 / 0)
    assert alerts.run(NOW) == []
    sent = []
    monkeypatch.setattr(alerts.profiles, "send_owner", lambda subject, lines, **kw: sent.append(subject))
    assert alerts.run(NOW + alerts.EVERY) == ["Only 5% of the disk is free (5.0 GB)"]
    assert sent == ["Only 5% of the disk is free (5.0 GB)"]


def test_the_state_is_encrypted_with_the_data_key(home, monkeypatch):
    hc.os.environ[hc.DATA_KEY_ENV] = hc.new_data_key()
    open_now(monkeypatch, {"disk": "Only 5% of the disk is free (5.0 GB)"})
    alerts.run(NOW)
    raw = (alerts.STATE_DIR / "alerts.json").read_bytes()
    assert raw.startswith(hc.SEALED) and b"disk" not in raw
    assert json.loads(hc.read_private_text(alerts.STATE_DIR / "alerts.json"))["open"]["disk"]["since"] == NOW


def test_a_damaged_state_file_starts_again(home, monkeypatch):
    (alerts.STATE_DIR / "alerts.json").write_text("[not json")
    open_now(monkeypatch, {"disk": "Only 5% of the disk is free (5.0 GB)"})
    assert alerts.run(NOW) == ["Only 5% of the disk is free (5.0 GB)"]


def test_the_switch_turns_them_off_and_a_failure_never_raises(home, monkeypatch):
    calls = []
    monkeypatch.setattr(alerts, "run", lambda: calls.append(1) or 1 / 0)
    alerts.maybe_run()
    hc.os.environ["HERMES_ALERTS"] = "0"
    alerts.maybe_run()
    assert calls == [1]


def test_test_alert(home, capsys, monkeypatch):
    monkeypatch.setattr(alerts.hc, "load_env_file", lambda *a, **k: None)
    assert alerts.main(["--test"]) == 0
    assert home == [("Test alert", ["This is a test of HermitShell's admin alerts. Nothing needs a look."])]


def test_the_alerts_switch_is_on_global_settings():
    import profiles
    assert profiles.FEATURES["alerts"] == ("HERMES_ALERTS", True)

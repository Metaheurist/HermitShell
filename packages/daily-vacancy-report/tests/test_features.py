"""Global settings, Features: the on/off switches the dashboard may set, and only those."""

import json
import sys
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import hermes_common as hc  # noqa: E402
import profiles  # noqa: E402

SWITCHES = {"alerts": ("HERMES_ALERTS", True), "prep_auto": ("INTERVIEW_PREP_AUTO", False),
            "word_copies": ("DOC_WORD_COPIES", False), "self_service": ("HERMES_SELF_SERVICE", False)}


def test_every_listed_switch_is_a_dashboard_key():
    assert {key for key, _ in profiles.FEATURES.values()} <= hc.DASHBOARD_SWITCHES


def test_only_switches_whose_feature_exists_are_listed():
    assert {name: SWITCHES[name] for name in profiles.FEATURES} == profiles.FEATURES
    assert set(profiles.FEATURES) == {"alerts", "prep_auto", "word_copies"}


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, "FEATURES", SWITCHES)
    monkeypatch.setattr(profiles, "PROFILES_DIR", tmp_path / "profiles")
    monkeypatch.setattr(profiles, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(profiles, "DASHBOARD_FILE", tmp_path / "state" / "dashboard.json")
    monkeypatch.setattr(profiles.os, "environ", dict(profiles.os.environ))
    for _, (key, _) in profiles.FEATURES.items():
        profiles.os.environ.pop(key, None)
    return tmp_path


def test_defaults_alerts_on_everything_else_off(home):
    assert profiles.features() == {"alerts": True, "prep_auto": False, "word_copies": False, "self_service": False}


def test_switches_are_saved_as_1_or_0_and_used_at_once(home):
    profiles.admin_action({"type": "admin", "action": "features", "alerts": False, "prep_auto": True,
                           "word_copies": True, "self_service": False})
    saved = json.loads((home / "state" / "dashboard.json").read_text())["env"]
    assert saved == {"HERMES_ALERTS": "0", "INTERVIEW_PREP_AUTO": "1", "DOC_WORD_COPIES": "1", "HERMES_SELF_SERVICE": "0"}
    assert profiles.features() == {"alerts": False, "prep_auto": True, "word_copies": True, "self_service": False}


def test_only_the_switches_are_written(home):
    profiles.apply_features({"type": "admin", "action": "features", "prep_auto": True,
                             "HERMES_DATA_KEY": "x", "JOB_FEEDBACK_SECRET": "y", "alerts": "yes"})
    saved = json.loads((home / "state" / "dashboard.json").read_text())["env"]
    assert saved == {"INTERVIEW_PREP_AUTO": "1"}


def test_an_item_with_no_switch_is_refused(home):
    with pytest.raises(profiles.ProfileError):
        profiles.apply_features({"type": "admin", "action": "features", "alerts": "on"})


def test_the_status_reports_the_switches(home):
    profiles.os.environ["HERMES_SELF_SERVICE"] = "1"
    assert profiles.features()["self_service"] is True


@pytest.mark.parametrize("key", sorted(hc.DASHBOARD_SWITCHES))
def test_switches_are_dashboard_keys(key):
    assert hc.dashboard_key_allowed(key)


@pytest.mark.parametrize("key", ["HERMES_DATA_KEY", "HERMES_STATE_DIR", "HERMES_BACKUP_DIR", "DOC_OTHER", "INTERVIEW_X"])
def test_their_prefixes_are_not(key):
    assert not hc.dashboard_key_allowed(key)

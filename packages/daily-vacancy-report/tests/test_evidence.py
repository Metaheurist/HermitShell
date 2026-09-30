"""The evidence map letters are written from: cleaning, caching per job, and falling back without a model."""

import json
import sys
from pathlib import Path

import pytest
import requests

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import evidence  # noqa: E402

CV = ("Candidate: Alex Morgan, data engineer\n"
      "Skills:\n- Python\n- SQL\n- Airflow\n"
      "Experience:\n- Data Engineer at Northwind (2019 to 2024): built Airflow pipelines loading 40 sources into SQL")
JOB = {"title": "Data Engineer", "company": "Contoso"}
LISTING = "Contoso is hiring a Data Engineer.\nAccept cookies\nYou will build pipelines in Python and Airflow."
MAP = [{"need": "Python", "evidence": "Python", "where": "Skills"},
       {"need": "Airflow pipelines", "evidence": "built Airflow pipelines loading 40 sources into SQL",
        "where": "Data Engineer at Northwind"},
       {"need": "Kubernetes", "evidence": "", "where": ""}]


def test_the_map_is_trimmed_deduplicated_and_loses_evidence_with_invented_figures():
    items = [{"need": " Python ", "evidence": "Python", "where": "Skills"},
             {"need": "python", "evidence": "again", "where": "Skills"},
             {"need": "Scale", "evidence": "loaded 400 sources", "where": "Northwind"},
             {"need": "SQL", "evidence": "x " * 400, "where": "Skills"},
             {"need": "", "evidence": "no need", "where": ""}, "not a dict", None]
    found = evidence.clean(items, CV)
    assert [i["need"] for i in found] == ["Python", "Scale", "SQL"]
    assert found[1] == {"need": "Scale", "evidence": "", "where": ""}
    assert len(found[2]["evidence"]) <= evidence.LIMITS["evidence"]
    assert evidence.clean([{"need": f"n{i}", "evidence": "", "where": ""} for i in range(20)], CV)[-1]["need"] == "n7"
    assert evidence.clean("nonsense", CV) == []


def test_the_map_reads_as_lines_and_lists_what_the_cv_shows():
    assert evidence.shown(MAP) == ["Python", "Airflow pipelines"]
    assert evidence.as_text(MAP).splitlines() == [
        "- Python: Python (Skills)",
        "- Airflow pipelines: built Airflow pipelines loading 40 sources into SQL (Data Engineer at Northwind)",
        "- Kubernetes: not shown in the CV"]


def test_the_map_is_asked_once_per_job_until_the_cv_or_advert_changes(tmp_path, monkeypatch):
    calls = []

    def model(host, model, system, user, num_ctx, **kw):
        calls.append((user, kw))
        return json.dumps({"requirements": MAP})
    monkeypatch.setattr(evidence, "ollama_chat", model)
    info = ("http://ollama:11434", "m", None)
    first = evidence.for_job(info, "k1", JOB, CV, LISTING, tmp_path)
    assert first == MAP and evidence.for_job(info, "k1", JOB, CV, LISTING, tmp_path) == MAP and len(calls) == 1
    user, kw = calls[0]
    assert kw["task"] == "evidence" and kw["fmt"] == evidence.SCHEMA
    assert "Accept cookies" not in user and "- Python" not in user and "Skills: Python; SQL; Airflow" in user
    evidence.for_job(info, "k1", JOB, CV + "\n- dbt", LISTING, tmp_path)
    evidence.for_job(info, "k1", JOB, CV, LISTING + " Also dbt.", tmp_path)
    evidence.for_job(info, "k2", JOB, CV, LISTING, tmp_path)
    assert len(calls) == 4


@pytest.mark.parametrize("fail", [requests.ConnectionError("down"), ValueError("bad json")])
def test_without_a_model_answer_the_letter_is_written_without_a_map(tmp_path, monkeypatch, fail):
    def model(*a, **k):
        raise fail
    monkeypatch.setattr(evidence, "ollama_chat", model)
    assert evidence.for_job(("h", "m", None), "k1", JOB, CV, LISTING, tmp_path) == []
    assert not list(tmp_path.glob("*.json"))
    monkeypatch.setattr(evidence, "ollama_chat", lambda *a, **k: "not json")
    assert evidence.for_job(("h", "m", None), "k1", JOB, CV, LISTING, tmp_path) == []


def test_a_damaged_cache_is_asked_again_and_old_maps_are_pruned(tmp_path, monkeypatch):
    import os
    monkeypatch.setattr(evidence, "ollama_chat", lambda *a, **k: json.dumps({"requirements": MAP}))
    old = tmp_path / "old.json"
    old.write_text("{}")
    os.utime(old, (1, 1))
    evidence.for_job(("h", "m", None), "k1", JOB, CV, LISTING, tmp_path)
    [kept] = tmp_path.glob("*.json")
    kept.write_text("{broken")
    assert evidence.for_job(("h", "m", None), "k1", JOB, CV, LISTING, tmp_path) == MAP
    assert not old.exists()

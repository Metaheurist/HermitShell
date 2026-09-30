"""Unit tests for scripts/llm_bench.py, with the model replaced by canned answers (no network)."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import llm_bench  # noqa: E402

LETTER = {"paragraphs": [
    "The Senior Platform Engineer role at Proseware appeals because it centres on Azure, Terraform and Kubernetes, "
    "the platform work I have done every day for the last few years, and because your product teams depend on it.",
    "As Cloud Engineer at Contoso Payments I built and maintain 40 Terraform modules on Azure, moved 18 services to "
    "Azure Kubernetes Service and run the GitHub Actions CI/CD pipelines for the platform.",
    "As Systems Administrator at Northwind Traders I looked after 150 Linux servers, and I lead on-call for the "
    "platform today, with the incident runbooks and Grafana dashboards I wrote so that anyone on the rota can "
    "find their way around the platform quickly.",
    "Outside work I run a small Kubernetes cluster at home with Flux and Prometheus, which keeps me close to how "
    "these tools change. I would welcome a conversation about the platform work ahead of your teams and how I could "
    "help them ship through it with confidence."]}
MASTER = {"headline": "Cloud Engineer", "summary": "Cloud engineer with 6 years in infrastructure.",
          "skills": ["Azure", "Terraform", "Kubernetes", "Linux"],
          "experience": [{"title": "Cloud Engineer", "employer": "Contoso Payments", "start": "March 2021", "end": "present",
                          "bullets": ["Built and maintain 40 Terraform modules used by 12 product teams on Azure."]}],
          "projects": [], "education": [{"qualification": "BSc Computing", "institution": "Ulster University"}],
          "certifications": []}
TAILORED = {"headline": "Cloud Engineer", "summary": "Cloud engineer with 6 years running Azure and Kubernetes platforms.",
            "skills": ["Azure", "Terraform", "Kubernetes"], "projects": [],
            "experience": [{"index": 0, "bullets": ["Built 40 Terraform modules on Azure for 12 teams, on Linux runners."]}]}


EVIDENCE = {"requirements": [{"need": "Terraform", "evidence": "Built and maintain 40 Terraform modules",
                                "where": "Cloud Engineer at Contoso Payments"},
                               {"need": "Go", "evidence": "", "where": ""}]}


@pytest.fixture
def canned(monkeypatch):
    def rating(host, model, num_ctx, profile, keywords, job, feedback=""):
        fit = 8 if ("Alex" in profile) == ("Platform" in job["title"]) else 2
        return {"fit_score": fit, "matched_skills": ["Azure", "Made Up"], "missing_skills": [], "reasoning": "r"}

    def chat(host, model, system, user, num_ctx, fmt=None, num_predict=500, task="other"):
        return json.dumps({"letter": LETTER, "cv_read": MASTER, "cv_tailor": TAILORED, "evidence": EVIDENCE}[task])

    monkeypatch.setattr(llm_bench.job_scanner, "rate_job", rating)
    for module in (llm_bench.cover_letter, llm_bench.tailored_cv, llm_bench.evidence):
        monkeypatch.setattr(module, "ollama_chat", chat)


def test_the_cases_file_is_consistent_and_fictional():
    data = llm_bench.load_cases()
    assert len(data["cases"]) >= 5
    assert {c["cv"] for c in data["cases"]} == set(data["cvs"]) == {"alex-morgan", "sam-lee"}
    assert all(listing["url"].startswith("https://jobs.example.test/") for listing in data["listings"].values())


def test_a_case_naming_something_missing_is_refused(tmp_path):
    bad = tmp_path / "cases.json"
    bad.write_text(json.dumps({"cvs": {}, "listings": {}, "cases": [{"cv": "x", "listing": "y", "fit": [0, 1]}]}))
    with pytest.raises(ValueError):
        llm_bench.load_cases(bad)


def test_a_run_scores_ratings_letters_and_cvs(canned):
    found = llm_bench.run(llm_bench.load_cases(), llm_bench.TASKS, ("", "bench-model", 8192))
    first = found["cases"][0]
    assert first["rating"]["in_range"] and first["rating"]["stray_skills"] == ["Made Up"]
    assert first["letter"]["problems"] == [] and first["letter"]["coverage"] >= 0.8
    assert first["letter"]["evidence"] == "1/2"
    assert first["tailored_cv"]["invented_figures"] == [] and "Azure" in first["tailored_cv"]["skills"]
    assert "letter" not in found["cases"][1] and "tailored_cv" not in found["cases"][1]
    summary = found["summary"]
    assert summary["ratings_in_range"].endswith("/5") and summary["cvs_honest"] == "1/2"


def test_only_the_tasks_asked_for_run(canned):
    found = llm_bench.run(llm_bench.load_cases(), ("rating",), ("", "bench-model", 8192))
    assert all("letter" not in c and "tailored_cv" not in c for c in found["cases"])
    assert found["summary"]["letters_passed"] is None


def test_the_report_names_each_problem(canned, monkeypatch):
    monkeypatch.setattr(llm_bench.cover_letter, "ollama_chat", lambda *a, **k: json.dumps({"paragraphs": ["I am excited."] * 3}))
    text = llm_bench.report(llm_bench.run(llm_bench.load_cases(), ("letter",), ("", "bench-model", 8192)))
    assert "letter:" in text and "too short" in text


def test_main_uses_a_throwaway_ledger_and_writes_json(canned, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(llm_bench.hc, "connect_model", lambda env_name: ("", "bench-model", 8192))
    out = tmp_path / "bench.json"
    seen = []
    monkeypatch.setattr(llm_bench, "run", lambda data, tasks, info: seen.append(llm_bench.os.environ["HERMES_USAGE_FILE"])
                        or {"model": info[1], "summary": {"ratings_in_range": "5/5"}, "tokens": [], "cases": []})
    before = llm_bench.os.environ.get("HERMES_USAGE_FILE")
    assert llm_bench.main(["--tasks", "rating", "--json", str(out)]) == 0
    assert "Model: bench-model" in capsys.readouterr().out
    assert json.loads(out.read_text())["summary"]["ratings_in_range"] == "5/5"
    assert seen[0] != before and "hermitshell-bench-" in seen[0]
    assert llm_bench.os.environ.get("HERMES_USAGE_FILE") == before


def test_unknown_tasks_are_refused():
    with pytest.raises(SystemExit):
        llm_bench.main(["--tasks", "poetry"])

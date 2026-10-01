"""Tailored CVs: reading the CV (in sections when long), honesty, bullet order, the page budget and the match
report. No model or network: replies are canned."""

import json
import sys
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import letter_pdf  # noqa: E402
import tailored_cv  # noqa: E402

SOURCE = """Alex Morgan
Data engineer

Experience
Data Engineer, Northwind Traders, March 2021 to present
- Built Airflow pipelines loading 40 sources into Snowflake
- Wrote dbt models for finance reporting
- Mentored two junior engineers

Analyst, Contoso, 2018 to 2021
- Built Power BI dashboards for sales
- Automated reports with Python

Education
BSc Computing, Ulster University, 2018

Skills: Python, SQL, Airflow, dbt, Snowflake, Power BI"""

READ = {"headline": "Data engineer", "summary": "Data engineer building pipelines.",
        "skills": ["Python", "SQL", "Airflow", "dbt", "Snowflake", "Power BI"],
        "experience": [{"title": "Data Engineer", "employer": "Northwind Traders", "start": "March 2021", "end": "present",
                        "bullets": ["Built Airflow pipelines loading 40 sources into Snowflake",
                                    "Wrote dbt models for finance reporting", "Mentored two junior engineers"]},
                       {"title": "Analyst", "employer": "Contoso", "start": "2018", "end": "2021",
                        "bullets": ["Built Power BI dashboards for sales", "Automated reports with Python"]}],
        "projects": [], "education": [{"qualification": "BSc Computing", "institution": "Ulster University", "dates": "2018"}],
        "certifications": []}
MAP = [{"need": "Airflow", "evidence": "Built Airflow pipelines", "where": "Data Engineer at Northwind Traders"},
       {"need": "Python", "evidence": "Automated reports with Python", "where": "Analyst at Contoso"},
       {"need": "Kubernetes", "evidence": "", "where": ""}]
JOB = {"title": "Senior Data Engineer", "employer": "Fabrikam"}


def master():
    return tailored_cv.clean_master(READ, SOURCE) | {"source_text": SOURCE}


def chat_returning(monkeypatch, *replies):
    calls, queue = [], list(replies)

    def chat(host, model, system, user, num_ctx, **kw):
        calls.append((user, kw))
        return json.dumps(queue.pop(0) if len(queue) > 1 else queue[0])
    monkeypatch.setattr(tailored_cv, "ollama_chat", chat)
    return calls


# --------------------------------------------------------------------------- reading the CV

def test_the_copy_keeps_only_roles_figures_and_dates_the_cv_has():
    made_up = {**READ, "experience": READ["experience"] + [
        {"title": "Head of Data", "employer": "Litware", "start": "2015", "end": "2018", "bullets": ["Led data"]}]}
    made_up["experience"][0] = {**made_up["experience"][0], "start": "March 2019",
                                "bullets": ["Built Airflow pipelines loading 400 sources into Snowflake", "Wrote dbt models"]}
    got = tailored_cv.clean_master(made_up, SOURCE)
    assert [r["employer"] for r in got["experience"]] == ["Northwind Traders", "Contoso"]
    assert got["experience"][0]["start"] == "" and got["experience"][0]["bullets"] == ["Wrote dbt models"]
    with pytest.raises(RuntimeError):
        tailored_cv.clean_master({"experience": [], "education": []}, SOURCE)


def test_a_long_cv_is_split_between_paragraphs_into_parts_within_the_limit():
    blocks = [f"Block {i}\n" + "word " * 40 for i in range(30)]
    text = "\n\n".join(blocks)
    parts = tailored_cv.sections(text, limit=1000)
    assert len(parts) > 1 and all(len(p) <= 1000 for p in parts)
    assert "\n\n".join(parts) == text
    assert tailored_cv.sections("short CV") == ["short CV"]


def test_a_role_split_across_sections_is_kept_once_with_all_its_bullets():
    first = {"headline": "Data engineer", "summary": "", "skills": ["Python"],
             "experience": [{"title": "Data Engineer", "employer": "Northwind Traders", "bullets": ["Built pipelines"]}]}
    more = {"headline": "Other", "summary": "Later summary", "skills": ["SQL"],
            "experience": [{"title": "data engineer", "employer": "Northwind  Traders", "bullets": ["Wrote dbt models"]},
                           {"title": "Analyst", "employer": "Contoso", "bullets": []}, "junk"]}
    merged = tailored_cv.merge_parts(first, more)
    assert merged["headline"] == "Data engineer" and merged["summary"] == "Later summary"
    assert merged["skills"] == ["Python", "SQL"]
    assert [(r["employer"], r["bullets"]) for r in merged["experience"]] == [
        ("Northwind Traders", ["Built pipelines", "Wrote dbt models"]), ("Contoso", [])]


def test_a_long_cv_is_read_in_parts_and_merged(monkeypatch):
    monkeypatch.setattr(tailored_cv, "MAX_SOURCE_CHARS", 300)
    part_one = {**READ, "experience": READ["experience"][:1]}
    part_two = {**READ, "headline": "", "experience": READ["experience"][1:], "education": []}
    calls = chat_returning(monkeypatch, part_one, part_two)
    got = tailored_cv.build_master(SOURCE, ("h", "m", 8192))
    assert len(calls) == len(tailored_cv.sections(SOURCE, 300)) >= 2
    assert "part 1 of" in calls[0][0] and all(kw["task"] == "cv_read" for _, kw in calls)
    assert [r["employer"] for r in got["experience"]] == ["Northwind Traders", "Contoso"]


def test_a_huge_cv_is_read_in_at_most_a_few_requests(monkeypatch):
    calls = chat_returning(monkeypatch, READ)
    huge = SOURCE + "\n\n" + "\n\n".join("Filler paragraph " * 400 for _ in range(40))
    tailored_cv.build_master(huge, ("h", "m", 8192))
    assert len(calls) == tailored_cv.MAX_PARTS


# --------------------------------------------------------------------------- tailoring

def test_bullets_naming_the_jobs_requirements_come_first_otherwise_in_cv_order():
    bullets = ["Mentored two junior engineers", "Automated reports with Python", "Wrote dbt models",
               "Built Airflow pipelines with Python"]
    assert tailored_cv.order_bullets(bullets, ["Airflow", "Python"]) == [
        "Built Airflow pipelines with Python", "Automated reports with Python", "Mentored two junior engineers",
        "Wrote dbt models"]
    assert tailored_cv.order_bullets(bullets, []) == bullets


def test_the_bullets_fit_about_two_pages():
    long = " ".join(["word"] * 60)
    roles = [{"title": f"Role {i}", "bullets": [f"{long} {i}.{b}" for b in range(8)]} for i in range(7)]
    fitted = tailored_cv.fit_pages(roles)
    assert [len(r["bullets"]) for r in fitted][:2] == [6, 4]
    assert all(len(r["bullets"]) >= 1 for r in fitted)
    assert sum(len(b.split()) for r in fitted for b in r["bullets"][1:]) <= tailored_cv.MAX_BULLET_WORDS
    short = [{"title": f"Role {i}", "bullets": [f"Did thing {b}" for b in range(8)]} for i in range(6)]
    assert [len(r["bullets"]) for r in tailored_cv.fit_pages(short)] == [6, 5, 4, 3, 2, 2]


def test_the_prompt_is_led_by_the_evidence_map_and_gets_less_of_the_advert():
    listing = "x" * 3000 + "LATE"
    mapped = tailored_cv.tailor_prompt(master(), JOB, listing, "", MAP)
    plain = tailored_cv.tailor_prompt(master(), JOB, listing, "")
    assert "WHAT THE JOB ASKS FOR" in mapped and "- Kubernetes: not shown in the CV" in mapped and "LATE" not in mapped
    assert "LATE" in plain and "WHAT THE JOB ASKS FOR" not in plain
    assert "action verb" in mapped


def test_the_tailored_cv_says_what_it_covers_and_what_the_cv_does_not_show(monkeypatch):
    chat_returning(monkeypatch, {"headline": "Data Engineer", "summary": "Data engineer who builds Airflow pipelines "
                                 "and dbt models for finance reporting teams.", "skills": ["Airflow", "dbt", "Kubernetes"],
                                 "experience": [{"index": 0, "bullets": ["Built Airflow pipelines loading 40 sources"]},
                                                {"index": 1, "bullets": ["Cut report time by 90 percent"]}],
                                 "projects": [7]})
    cv = tailored_cv.tailored_cv(master(), JOB, "Airflow, Python, Kubernetes", "", ("h", "m", 8192), found=MAP)
    assert "Kubernetes" not in cv["skills"] and cv["skills"][:2] == ["Airflow", "dbt"] and cv["projects"] == []
    assert cv["experience"][1]["bullets"][0] == "Automated reports with Python"
    assert cv["match"] == {"covered": ["Airflow", "Python"], "missing": [], "gaps": ["Kubernetes"]}
    assert tailored_cv.report_lines(cv["match"]) == [
        "Covers 2 of the 2 requirements your CV shows: Airflow, Python",
        "The advert also asks for, not shown in your CV: Kubernetes"]
    assert tailored_cv.report_lines(None) == []
    assert tailored_cv.report_lines({"covered": [], "missing": ["SQL"], "gaps": []}) == [
        "Covers 0 of the 1 requirements your CV shows (left out: SQL)"]


def test_a_cv_made_from_the_job_search_profile_says_so_and_asks_for_the_full_cv(tmp_path, monkeypatch):
    profile = tmp_path / "job_profile.md"
    profile.write_text(SOURCE)
    monkeypatch.setenv("COVER_LETTER_CV_FILE", str(tmp_path / "cv.txt"))
    monkeypatch.setenv("JOB_PROFILE_FILE", str(profile))
    text, path = tailored_cv.cv_source()
    assert path == profile and tailored_cv.from_profile(path)
    (tmp_path / "cv.txt").write_text(SOURCE)
    text, path = tailored_cv.cv_source()
    assert path == tmp_path / "cv.txt" and not tailored_cv.from_profile(path)
    assert not tailored_cv.from_profile(None)

    chat_returning(monkeypatch, {"headline": "", "summary": "", "skills": [], "experience": [], "projects": []})
    made = tailored_cv.tailored_cv(master() | {"from_profile": True}, JOB, "", "", ("h", "m", 8192))
    assert made["from_profile"] is True
    assert tailored_cv.source_lines(made) == [tailored_cv.FROM_PROFILE_NOTE]
    assert "Upload your full CV" in tailored_cv.FROM_PROFILE_NOTE
    assert tailored_cv.source_lines(tailored_cv.tailored_cv(master(), JOB, "", "", ("h", "m", 8192))) == []


def test_a_short_entry_fits_at_the_foot_of_a_page_but_a_title_never_sits_there_alone():
    def near_the_foot():
        w = letter_pdf._Writer()
        w.new_page()
        w.y = letter_pdf.MARGIN_BOTTOM + 20
        return w

    alone = near_the_foot()
    alone.split_line("MSc Data Analytics", "", 10.5)
    assert len(alone.pages) == 1
    with_more = near_the_foot()
    with_more.split_line("Data Engineer", "2021 - present", 10.5, keep=14 + letter_pdf._height("Built pipelines", 10, 14, 12))
    assert len(with_more.pages) == 2 and not with_more.pages[0] and with_more.pages[1]
    assert letter_pdf._height("", 10, 14) == 0
    assert letter_pdf._height("word " * 400, 10, 14) == 28


def test_without_a_map_there_is_no_match_report(monkeypatch):
    chat_returning(monkeypatch, {"headline": "", "summary": "", "skills": [], "experience": [], "projects": []})
    cv = tailored_cv.tailored_cv(master(), JOB, "", "", ("h", "m", 8192))
    assert "match" not in cv and cv["headline"] == "Data engineer"
    assert cv["experience"][0]["bullets"][0] == "Built Airflow pipelines loading 40 sources into Snowflake"

"""Unit tests for cover letters: the PDF writer and the request pipeline (no model, SMTP or network)."""

import json
import re
import sys
import zlib
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import cover_letter  # noqa: E402
import letter_pdf  # noqa: E402
from job_tracker import Tracker  # noqa: E402

PARAGRAPHS = [
    "I am applying for the AI Engineer role at Acme because your team builds retrieval systems in Python. " * 4,
    "At my current employer I lead automation projects with OCR pipelines, API workflows and Azure. " * 4,
    "Earlier I productionised NLP prototypes and monitored model drift across large datasets. " * 4,
    "I would welcome a conversation about how I could help your team.",
]


def page_text(pdf: bytes) -> str:
    streams = re.findall(rb"stream\n(.*?)\nendstream", pdf, flags=re.S)
    return b"\n".join(zlib.decompress(s) for s in streams).decode("cp1252")


# --------------------------------------------------------------------------- PDF

def test_text_width_uses_helvetica_metrics():
    assert letter_pdf.text_width("Hi", 10) == pytest.approx((722 + 222) / 100)
    assert letter_pdf.text_width("Hi", 10, "bold") > letter_pdf.text_width("Hi", 10)


def test_wrap_keeps_lines_within_the_width_and_every_word():
    text = "Automation and machine learning engineer with Azure experience " * 8
    lines = letter_pdf.wrap(text, 10.5, 200)
    assert len(lines) > 3 and all(letter_pdf.text_width(line, 10.5) <= 200 for line in lines)
    assert " ".join(lines).split() == text.split()


def test_letter_pdf_is_a_valid_document_with_real_text():
    pdf = letter_pdf.letter_pdf("Sam Taylor", "Belfast \u00b7 sam@example.com", "29 September 2026",
                                ["Hiring Manager", "Queen\u2019s University (Belfast)"], "Application for AI Engineer",
                                "Dear Hiring Manager,", PARAGRAPHS)
    assert pdf.startswith(b"%PDF-1.4") and pdf.rstrip().endswith(b"%%EOF")
    xref = int(re.search(rb"startxref\n(\d+)", pdf).group(1))
    assert pdf[xref:xref + 4] == b"xref"
    for num, offset in enumerate(re.findall(rb"(\d{10}) 00000 n", pdf), 1):
        assert pdf[int(offset):].startswith(b"%d 0 obj" % num)
    text = page_text(pdf)
    assert "(Sam Taylor) Tj" in text and "Queen\u2019s University \\(Belfast\\)" in text
    assert "/Helvetica-Bold" in pdf.decode("latin-1") and b"/Title (Application for AI Engineer)" in pdf


def test_long_letters_flow_onto_a_second_page():
    pdf = letter_pdf.letter_pdf("Sam", "", "today", ["Acme"], "Subject", "Dear Hiring Manager,", PARAGRAPHS * 4)
    assert b"/Count 2" in pdf


# --------------------------------------------------------------------------- writing

JOB = {"title": "AI Engineer", "company": "Acme", "location": "Belfast", "matched": ["Python"], "gaps": [],
       "reasoning": "Strong overlap.", "listing": "Python, LLMs and Azure.", "url": "https://example.com/job/1",
       "fit": 8}


def test_letter_prompt_includes_the_listing_facts_and_note():
    prompt = cover_letter.letter_prompt(JOB, "Candidate: Sam Taylor, engineer", "Python, LLMs and Azure.",
                                        "mention Azure")
    for text in ("Job title: AI Engineer", "Employer: Acme", "Python, LLMs and Azure.", "mention Azure",
                 "Candidate: Sam Taylor"):
        assert text in prompt


def test_write_letter_rejects_short_or_placeholder_letters(monkeypatch):
    replies = iter([json.dumps({"paragraphs": ["Too short."] * 3}),
                    json.dumps({"paragraphs": PARAGRAPHS[:3] + ["Regards, [Your Name]"]}),
                    json.dumps({"paragraphs": PARAGRAPHS})])
    monkeypatch.setattr(cover_letter, "ollama_chat", lambda *a, **k: next(replies))
    with pytest.raises(ValueError, match="too short"):
        cover_letter.write_letter("h", "m", None, JOB, "cv", "listing", tries=1)
    with pytest.raises(ValueError, match="placeholder"):
        cover_letter.write_letter("h", "m", None, JOB, "cv", "listing", tries=1)
    assert cover_letter.write_letter("h", "m", None, JOB, "cv", "listing", tries=1) == [
        " ".join(p.split()) for p in PARAGRAPHS]


def test_write_letter_rewrites_letters_that_invent_a_job_title(monkeypatch):
    cv = "Current role: Automation Project Lead at Northwind Ltd. Previous: Machine Learning Researcher at Contoso."
    invented = ["As an AI Solutions Engineer at Northwind Ltd, I built pipelines. " * 6] + PARAGRAPHS[1:]
    honest = ["As an Automation Project Lead at Northwind Ltd, and as a Machine Learning Researcher at Contoso, "
              "I built pipelines. " * 4] + PARAGRAPHS[1:]
    assert cover_letter.invented_titles(invented, cv) == ["AI Solutions Engineer"]
    assert cover_letter.invented_titles(honest, cv) == []
    replies = iter([json.dumps({"paragraphs": invented}), json.dumps({"paragraphs": honest})])
    monkeypatch.setattr(cover_letter, "ollama_chat", lambda *a, **k: next(replies))
    assert cover_letter.write_letter("h", "m", None, JOB, cv, "listing")[0].startswith("As an Automation Project Lead")
    monkeypatch.setattr(cover_letter, "ollama_chat", lambda *a, **k: json.dumps({"paragraphs": invented}))
    with pytest.raises(ValueError, match="AI Solutions Engineer"):
        cover_letter.write_letter("h", "m", None, JOB, cv, "listing")


def test_job_title_drops_a_repeated_employer():
    assert cover_letter.job_title({"title": "AI Engineer at Queen's University", "company": "Queen's University"}) \
        == "AI Engineer"
    assert cover_letter.job_title({"title": "Data Engineer", "company": "Acme"}) == "Data Engineer"
    assert cover_letter.job_title({}) == "the advertised role"


def test_candidate_name_prefers_the_setting(monkeypatch):
    monkeypatch.delenv("COVER_LETTER_NAME", raising=False)
    assert cover_letter.candidate_name("Candidate: Sam Taylor, AI engineer") == "Sam Taylor"
    monkeypatch.setenv("COVER_LETTER_NAME", "Samantha Taylor")
    assert cover_letter.candidate_name("Candidate: Sam Taylor") == "Samantha Taylor"


def test_email_lists_the_job_and_attachment():
    subject, body, text = cover_letter.email_bodies(JOB, PARAGRAPHS, "Cover letter - Sam - AI Engineer.pdf", "short")
    assert subject == "Cover letter: AI Engineer at Acme"
    for part in ("Cover letter - Sam - AI Engineer.pdf", "Belfast", "8/10", "Your note: short", "View job</a>"):
        assert part in body
    assert "&rarr;" not in body and "\u2192" not in body
    assert "https://example.com/job/1" in text and PARAGRAPHS[-1] in text
    assert "HermitShell fit" in body and "Hermes" not in body + text


# --------------------------------------------------------------------------- pipeline

@pytest.fixture
def setup(tmp_path, monkeypatch):
    tracker = Tracker(tmp_path / "tracker.db")
    profile = tmp_path / "profile.md"
    profile.write_text("Candidate: Sam Taylor, AI engineer", encoding="utf-8")
    monkeypatch.setenv("JOB_PROFILE_FILE", str(profile))
    monkeypatch.setenv("COVER_LETTER_CONTACT", "Belfast")
    monkeypatch.setattr(cover_letter, "LETTER_DIR", tmp_path / "letters")
    monkeypatch.setattr(cover_letter, "WRITING_FILE", tmp_path / "writing.json")
    sent = []
    monkeypatch.setattr(cover_letter.hc, "send_email",
                        lambda subject, body, text, sender, attachments=None: sent.append((subject, attachments)))
    yield tracker, sent
    tracker.close()


def test_process_pending_writes_and_emails_each_request_once(setup, monkeypatch):
    tracker, sent = setup
    tracker.upsert_job("k1", JOB, emailed=True)
    tracker.add_event("e1", "k1", "cover_letter", reason="mention Azure")
    notes = []
    monkeypatch.setattr(cover_letter, "write_letter",
                        lambda host, model, ctx, job, profile, listing, note: notes.append(note) or PARAGRAPHS)
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert lines[0].startswith("Cover letter sent for AI Engineer at Acme")
    assert notes == ["mention Azure"]
    (subject, [(filename, pdf, mime)]), = sent
    assert subject == "Cover letter: AI Engineer at Acme" and mime == "application/pdf"
    assert filename == "Cover letter - Sam Taylor - AI Engineer.pdf" and pdf.startswith(b"%PDF")
    assert list((cover_letter.LETTER_DIR).glob("*-acme-ai-engineer.pdf"))
    assert cover_letter.process_pending(tracker, lambda: pytest.fail("no model needed")) == []


def test_process_pending_marks_the_request_it_is_writing_and_skips_cancelled_ones(setup, monkeypatch):
    tracker, sent = setup
    tracker.upsert_job("k1", JOB, emailed=True)
    tracker.add_event("e1", "k1", "cover_letter")
    tracker.add_event("e2", "k1", "tailored_cv")
    tracker.add_event("e3", "k1", "cover_letter")
    marks, pushes = [], []
    monkeypatch.setattr(cover_letter.profiles, "tasks_changed", lambda: pushes.append(1))

    def write(host, model, ctx, job, profile, listing, note):
        marks.append(json.loads(cover_letter.WRITING_FILE.read_text())["event_id"])
        tracker.cancel_letter("e3")
        return PARAGRAPHS
    monkeypatch.setattr(cover_letter, "write_letter", write)
    assert tracker.cancel_letter("e2") and not tracker.cancel_letter("nope")
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert marks == ["e1"] and len(sent) == 1 and not cover_letter.WRITING_FILE.exists()
    assert lines[-1] == "Cover letter for AI Engineer at Acme was cancelled from the dashboard"
    assert tracker.open_requests() == [] and len(pushes) >= 2


def test_open_requests_list_both_kinds_with_the_job(setup):
    tracker, _ = setup
    tracker.upsert_job("k1", {**JOB, "employer": ""}, emailed=True)
    tracker.add_event("e1", "k1", "cover_letter", at=100)
    tracker.add_event("e2", "k1", "tailored_cv", at=200)
    tracker.add_event("e3", "k1", "applied", at=300)
    rows = tracker.open_requests()
    assert [(r["event_id"], r["action"], r["title"], r["employer"]) for r in rows] == [
        ("e1", "cover_letter", "AI Engineer", "Acme"), ("e2", "tailored_cv", "AI Engineer", "Acme")]
    tracker.mark_letter("e1", "k1", "sent")
    assert tracker.cancel_letter("e2") and tracker.letter_cancelled("e2") and not tracker.cancel_letter("e3")
    assert tracker.open_requests() == [] and tracker.pending_letters(action="tailored_cv") == []


def test_process_pending_retries_failures_and_skips_unknown_jobs(setup, monkeypatch):
    tracker, sent = setup
    tracker.upsert_job("k1", JOB, emailed=True)
    tracker.add_event("e1", "k1", "cover_letter")
    tracker.add_event("e2", "gone", "cover_letter")

    def broken(*args):
        raise ValueError("letter too short (1 paragraphs, 20 words)")

    monkeypatch.setattr(cover_letter, "write_letter", broken)
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert lines[0].startswith("Cover letter will retry for AI Engineer at Acme: ValueError")
    assert lines[1] == "Cover letter skipped for gone: job gone is not in the tracker"
    assert [p["event_id"] for p in tracker.pending_letters()] == ["e1"] and sent == []

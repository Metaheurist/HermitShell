"""Unit tests for cover letters: the PDF writer and the request pipeline (no model, SMTP or network)."""

import json
import re
import sys
import time
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


@pytest.fixture
def kept(setup, tmp_path, monkeypatch):
    """A letter already made for k1, and the Worker uploads recorded instead of sent."""
    tracker, sent = setup
    monkeypatch.setattr(cover_letter, "CV_DIR", tmp_path / "cvs")
    monkeypatch.setenv("JOB_FEEDBACK_URL", "https://fb.example.org")
    monkeypatch.setenv("JOB_FEEDBACK_API_TOKEN", "tok")
    monkeypatch.delenv("COVER_LETTER_KEEP_DAYS", raising=False)
    monkeypatch.delenv("JOB_PROFILE_ID", raising=False)
    uploads = []

    class Response:
        def raise_for_status(self):
            return None

    monkeypatch.setattr(cover_letter.requests, "post",
                        lambda url, params, data, timeout, headers: uploads.append((url, params, data, headers)) or Response())
    written = []
    monkeypatch.setattr(cover_letter, "write_letter",
                        lambda host, model, ctx, job, profile, listing, note: written.append(note) or PARAGRAPHS)
    tracker.upsert_job("k1", JOB, emailed=True)
    tracker.add_event("e0", "k1", "cover_letter")
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    sent.clear(), uploads.clear(), written.clear()
    yield tracker, sent, uploads, written


def test_a_letter_made_recently_is_sent_again_without_the_model(kept):
    tracker, sent, uploads, written = kept
    tracker.add_event("e1", "k1", "cover_letter")
    lines = cover_letter.process_pending(tracker, lambda: pytest.fail("no model needed"))
    assert lines == [lines[0]] and lines[0].endswith("(the one made earlier)") and "sent for AI Engineer" in lines[0]
    (subject, [(filename, pdf, _)]), = sent
    assert filename == "Cover letter - Sam Taylor - AI Engineer.pdf" and pdf.startswith(b"%PDF") and written == []
    assert len(list(cover_letter.LETTER_DIR.glob("*.pdf"))) == 1
    assert uploads[0][1]["days"] == "7" and tracker.pending_letters() == []


def test_fresh_requests_and_notes_write_a_new_letter(kept):
    tracker, sent, uploads, written = kept
    tracker.add_event("e1", "k1", "cover_letter", flags="fresh")
    tracker.add_event("e2", "k1", "cover_letter", reason="shorter please", at=time.time() + 1)
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert written == ["", "shorter please"] and len(sent) == 2
    assert not any("made earlier" in line for line in lines)


def test_dashboard_requests_are_kept_for_download_and_not_emailed(kept):
    tracker, sent, uploads, written = kept
    tracker.add_event("e1", "k1", "cover_letter", flags="quiet,fresh")
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert sent == [] and written == [""] and lines[0].startswith("Cover letter made for download for AI Engineer")
    url, params, data, headers = uploads[0]
    assert url == "https://fb.example.org/api/doc" and data.startswith(b"%PDF")
    assert params == {"u": "owner", "j": "k1", "k": "cover_letter", "days": "7",
                      "name": "Cover letter - Sam Taylor - AI Engineer.pdf"}
    assert headers == {"Authorization": "Bearer tok", "Content-Type": "application/pdf"}


def test_a_reused_letter_is_kept_only_for_the_rest_of_its_days(kept):
    tracker, sent, uploads, written = kept
    tracker.db.execute("UPDATE letters SET at = ?", (time.time() - 5.5 * cover_letter.DAY,))
    tracker.add_event("e1", "k1", "cover_letter", flags="quiet")
    cover_letter.process_pending(tracker, lambda: pytest.fail("no model needed"))
    assert uploads[0][1]["days"] == "2" and sent == []
    tracker.db.execute("UPDATE letters SET at = ?", (time.time() - 8 * cover_letter.DAY,))
    tracker.add_event("e2", "k1", "cover_letter", flags="quiet", at=time.time() + 1)
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert written == [""] and uploads[-1][1]["days"] == "7"


def test_keep_days_zero_turns_off_reuse_and_the_upload(kept, monkeypatch):
    tracker, sent, uploads, written = kept
    monkeypatch.setenv("COVER_LETTER_KEEP_DAYS", "0")
    tracker.add_event("e1", "k1", "cover_letter")
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert written == [""] and uploads == [] and len(sent) == 1
    monkeypatch.setenv("COVER_LETTER_KEEP_DAYS", "400")
    assert cover_letter.keep_days() == cover_letter.MAX_KEEP_DAYS


def test_uploads_send_the_plain_pdf_even_when_files_are_encrypted(kept, monkeypatch):
    tracker, sent, uploads, written = kept
    monkeypatch.setenv(cover_letter.hc.DATA_KEY_ENV, cover_letter.hc.new_data_key())
    monkeypatch.setenv("JOB_PROFILE_ID", "sam-lee-456789")
    tracker.add_event("e1", "k1", "cover_letter", flags="fresh")
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    newest = max(cover_letter.LETTER_DIR.glob("*.pdf"), key=lambda p: p.stat().st_mtime)
    assert not newest.read_bytes().startswith(b"%PDF") and uploads[0][2].startswith(b"%PDF")
    assert uploads[0][1]["u"] == "sam-lee-456789"
    assert cover_letter.doc_info(newest, "cover_letter", JOB) == ("Cover letter - Sam Taylor - AI Engineer.pdf", PARAGRAPHS)


def test_a_failed_upload_is_logged_and_the_letter_still_counts_as_sent(kept, monkeypatch):
    tracker, sent, uploads, written = kept
    logged = []
    monkeypatch.setattr(cover_letter, "log", logged.append)

    def down(*args, **kwargs):
        raise cover_letter.requests.ConnectionError("worker down")
    monkeypatch.setattr(cover_letter.requests, "post", down)
    tracker.add_event("e1", "k1", "cover_letter", flags="fresh")
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert tracker.pending_letters() == [] and len(sent) == 1
    assert logged == [logged[0]] and logged[0].endswith("for download: ConnectionError")


def test_a_job_asked_for_from_the_dashboard_is_emailed_without_the_model(kept, monkeypatch):
    tracker, sent, uploads, written = kept
    monkeypatch.setattr(cover_letter.requests, "post",
                        lambda url, params, timeout, headers: uploads.append((url, params, headers)) or type(
                            "R", (), {"raise_for_status": lambda self: None})())
    tracker.add_event("e1", "k1", "send_job", flags="quiet")
    lines = cover_letter.process_pending(tracker, lambda: pytest.fail("no model needed"))
    assert lines == ["Job email sent for AI Engineer at Acme"] and written == []
    (subject, images), = sent
    assert subject.endswith("AI Engineer at Acme") and isinstance(images, dict)
    assert uploads == [("https://fb.example.org/api/emailed", {"u": "owner", "j": "k1"},
                        {"Authorization": "Bearer tok"})]
    assert tracker.pending_letters(action="send_job") == [] and tracker.open_requests() == []
    assert cover_letter.process_pending(tracker, lambda: pytest.fail("nothing to do")) == []


def test_a_job_email_in_a_dry_run_sends_nothing_and_stays_queued(kept):
    tracker, sent, uploads, written = kept
    tracker.add_event("e1", "k1", "send_job")
    lines = cover_letter.process_pending(tracker, lambda: pytest.fail("no model needed"), dry_run=True)
    assert lines == ["Job email not sent (dry run) for AI Engineer at Acme"] and sent == [] and uploads == []
    assert [r["event_id"] for r in tracker.open_requests()] == ["e1"]


def test_record_emailed_reports_problems_and_needs_https_and_a_token(monkeypatch):
    calls = []
    monkeypatch.setattr(cover_letter.requests, "post", lambda *a, **k: calls.append(1))
    monkeypatch.setenv("JOB_FEEDBACK_API_TOKEN", "tok")
    monkeypatch.setenv("JOB_FEEDBACK_URL", "http://fb.example.org")
    assert cover_letter.record_emailed("k1") == "" and calls == []
    monkeypatch.setenv("JOB_FEEDBACK_URL", "https://fb.example.org")
    monkeypatch.setenv("JOB_FEEDBACK_API_TOKEN", "")
    assert cover_letter.record_emailed("k1") == "" and calls == []

    def down(*args, **kwargs):
        raise cover_letter.requests.ConnectionError("worker down")
    monkeypatch.setenv("JOB_FEEDBACK_API_TOKEN", "tok")
    monkeypatch.setattr(cover_letter.requests, "post", down)
    assert cover_letter.record_emailed("k1").endswith("as emailed on the Worker: ConnectionError")


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

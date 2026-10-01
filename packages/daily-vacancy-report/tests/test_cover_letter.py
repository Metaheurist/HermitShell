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
import cv_text  # noqa: E402
import letter_pdf  # noqa: E402
import writing_checks  # noqa: E402
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
    assert writing_checks.invented_titles(invented, cv) == ["AI Solutions Engineer"]
    assert writing_checks.invented_titles(honest, cv) == []
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
    for part in ("Cover letter - Sam - AI Engineer.pdf", "Belfast", "8/10", "Your note: short", '<span style="color:#ffffff">View job</span></a>'):
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
    monkeypatch.setattr(cover_letter.evidence, "for_job", lambda *a, **k: [])
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
                        lambda host, model, ctx, job, profile, listing, note, **style: notes.append(note) or PARAGRAPHS)
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert lines[0].startswith("Cover letter sent for AI Engineer") and "Acme" not in "\n".join(lines)
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

    def write(host, model, ctx, job, profile, listing, note, **style):
        marks.append(json.loads(cover_letter.WRITING_FILE.read_text())["event_id"])
        tracker.cancel_letter("e3")
        return PARAGRAPHS
    monkeypatch.setattr(cover_letter, "write_letter", write)
    assert tracker.cancel_letter("e2") and not tracker.cancel_letter("nope")
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert marks == ["e1"] and len(sent) == 1 and not cover_letter.WRITING_FILE.exists()
    assert lines[-1] == "Cover letter for AI Engineer was cancelled from the dashboard"
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
                        lambda url, params=None, data=None, headers=None, **kw: uploads.append((url, params, data, headers))
                        or Response())
    written = []
    monkeypatch.setattr(cover_letter, "write_letter",
                        lambda host, model, ctx, job, profile, listing, note, **style: written.append(note) or PARAGRAPHS)
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


def test_a_dashboard_request_with_a_note_writes_a_new_letter_kept_for_download(kept):
    tracker, sent, uploads, written = kept
    tracker.add_event("e1", "k1", "cover_letter", reason="mention Azure", flags="quiet")
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert written == ["mention Azure"] and sent == [] and len(uploads) == 1
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
    assert headers["Authorization"] == "Bearer tok" and headers["Content-Type"] == "application/pdf"


def test_the_dashboards_email_button_sends_the_kept_letter_without_the_model(kept):
    tracker, sent, uploads, written = kept
    tracker.add_event("e1", "k1", "cover_letter", flags="send")
    lines = cover_letter.process_pending(tracker, lambda: pytest.fail("no model needed"))
    assert lines == ["Cover letter sent for AI Engineer (the one made earlier)"] and written == []
    (subject, [(filename, pdf, _)]), = sent
    assert filename == "Cover letter - Sam Taylor - AI Engineer.pdf" and pdf.startswith(b"%PDF")
    assert len(list(cover_letter.LETTER_DIR.glob("*.pdf"))) == 1 and tracker.pending_letters() == []


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
    pdf = next(u for u in uploads if u[0].endswith("/api/doc"))
    assert not newest.read_bytes().startswith(b"%PDF") and pdf[2].startswith(b"%PDF")
    assert pdf[1]["u"] == "sam-lee-456789"
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
    assert logged == [logged[0]] and logged[0].endswith("for download: feedback Worker unreachable (ConnectionError)")


def test_a_job_asked_for_from_the_dashboard_is_emailed_without_the_model(kept, monkeypatch):
    tracker, sent, uploads, written = kept
    monkeypatch.setattr(cover_letter.requests, "post",
                        lambda url, params=None, headers=None, **kw: uploads.append(
                            (url, params, {"Authorization": headers["Authorization"]})) or type("R", (), {})())
    tracker.add_event("e1", "k1", "send_job", flags="quiet")
    lines = cover_letter.process_pending(tracker, lambda: pytest.fail("no model needed"))
    assert lines == ["Job email sent for AI Engineer"] and written == []
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
    assert lines == ["Job email not sent (dry run) for AI Engineer"] and sent == [] and uploads == []
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
    assert cover_letter.record_emailed("k1").endswith("as emailed on the Worker: feedback Worker unreachable (ConnectionError)")


def test_process_pending_retries_failures_and_skips_unknown_jobs(setup, monkeypatch):
    tracker, sent = setup
    tracker.upsert_job("k1", JOB, emailed=True)
    tracker.add_event("e1", "k1", "cover_letter")
    tracker.add_event("e2", "gone", "cover_letter")

    def broken(*args, **style):
        raise ValueError("letter too short (1 paragraphs, 20 words)")

    monkeypatch.setattr(cover_letter, "write_letter", broken)
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert lines[0].startswith("Cover letter will retry for AI Engineer: ValueError")
    assert lines[1] == "Cover letter skipped for gone: job gone is not in the tracker"
    assert [p["event_id"] for p in tracker.pending_letters()] == ["e1"] and sent == []


# --------------------------------------------------------------------------- length, tone, evidence and rewrites

MAP = [{"need": "Python", "evidence": "Python services", "where": "Skills"},
       {"need": "Airflow pipelines", "evidence": "built Airflow pipelines", "where": "Engineer at Northwind"},
       {"need": "Kubernetes", "evidence": "", "where": ""}]
CV = "Candidate: Sam Taylor, engineer\nExperience:\n- Engineer at Northwind: built Airflow pipelines and Python services"
GOOD = [("I would like to join Acme as an AI Engineer because the listing describes retrieval systems built in Python "
         "and pipelines that serve real users. ") * 4,
        "At Northwind I built Airflow pipelines and Python services, owning the code from design to support. " * 5,
        "Earlier projects gave me practice with data quality checks, testing and clear documentation for colleagues. " * 5,
        "I would welcome a conversation about the role and how my work could help your team."]
GENERIC = ["I would like to join Acme because the role suits my background and the team sounds good to me. " * 5,
           "In my work I have delivered projects on time and kept colleagues informed of progress throughout. " * 5,
           "I also enjoy learning new tools, sharing what I learn and helping others on the team do the same. " * 5,
           "I would welcome a conversation about the role and how my work could help your team."]


def replies_to(monkeypatch, *letters):
    prompts, replies = [], iter(letters)

    def chat(host, model, system, user, num_ctx, **kw):
        prompts.append((user, kw))
        return json.dumps({"paragraphs": next(replies)})
    monkeypatch.setattr(cover_letter, "ollama_chat", chat)
    return prompts


def test_the_sample_letters_fit_the_standard_length():
    assert all(250 <= sum(len(p.split()) for p in letter) <= 380 for letter in (GOOD, GENERIC))


def test_letter_style_reads_the_request_flags():
    assert cover_letter.letter_style({"short", "warm", "quiet"}) == ("short", "warm")
    assert cover_letter.letter_style({"detailed", "formal", "fresh"}) == ("detailed", "formal")
    assert cover_letter.letter_style(set()) == cover_letter.letter_style({"evil", "long"}) == ("standard", "professional")


@pytest.mark.parametrize("length, tone, count, words", [("short", "warm", 3, "170 to 260"),
                                                       ("standard", "professional", 4, "250 to 380"),
                                                       ("detailed", "direct", 5, "350 to 480")])
def test_the_prompt_follows_the_length_and_tone_asked_for(length, tone, count, words):
    prompt = cover_letter.letter_prompt(JOB, CV, "Python, LLMs and Azure.", "", length, tone)
    assert f"as {count} paragraphs, {words} words" in prompt and f"Tone: {cover_letter.TONES[tone]}." in prompt
    assert f"{count}. A short, confident close" in prompt and f"{count + 1}. " not in prompt
    assert prompt.endswith("[" + ", ".join(['"..."'] * count) + "]}.")


def test_with_an_evidence_map_the_prompt_uses_it_and_less_of_the_advert():
    listing = "A" * 3000 + "LATE"
    mapped = cover_letter.letter_prompt(JOB, CV, listing, "", found=MAP)
    plain = cover_letter.letter_prompt(JOB, CV, listing, "")
    assert "EVIDENCE MAP" in mapped and "- Kubernetes: not shown in the CV" in mapped and "never claim" in mapped
    assert "LATE" not in mapped and "LATE" in plain and "EVIDENCE MAP" not in plain
    assert "Experience: Engineer at Northwind" in mapped


def test_a_draft_with_stock_phrases_is_revised_once_with_a_short_prompt(monkeypatch):
    prompts = replies_to(monkeypatch, ["I am excited to apply. " + GOOD[0]] + GOOD[1:], GOOD)
    listing = "Acme builds retrieval systems. " * 60
    assert cover_letter.write_letter("h", "m", None, JOB, CV, listing, found=MAP) == [" ".join(p.split()) for p in GOOD]
    (first, kw), (second, _) = prompts
    assert kw["task"] == "letter" and kw["num_predict"] == cover_letter.LENGTHS["standard"][2]
    assert "DRAFT COVER LETTER" in second and "'i am excited'" in second and "built Airflow pipelines" in second
    assert "LISTING TEXT" not in second and "CANDIDATE CV" not in second and len(second) < len(first) * 0.7


def test_soft_problems_get_one_rewrite_and_the_better_draft_is_kept(monkeypatch):
    cliche = ["I am excited to apply. " + GOOD[0]] + GOOD[1:]
    worse = ["I am excited to apply. " + GENERIC[0]] + GENERIC[1:]
    prompts = replies_to(monkeypatch, worse, cliche, cliche)
    assert cover_letter.write_letter("h", "m", None, JOB, CV, "", found=MAP)[0].startswith("I am excited to apply. I would like to join Acme as")
    assert len(prompts) == 2
    replies_to(monkeypatch, cliche, worse)
    assert "Python" in cover_letter.write_letter("h", "m", None, JOB, CV, "", found=MAP)[0]


def test_invented_figures_are_rewritten_and_refused_if_they_stay(monkeypatch):
    listing = "You will join a team of 12 engineers."
    team = [GOOD[0] + "I would join your team of 12 gladly."] + GOOD[1:]
    replies_to(monkeypatch, team)
    assert cover_letter.write_letter("h", "m", None, JOB, CV, listing, tries=1)[0].endswith("team of 12 gladly.")
    invented = [GOOD[0] + "I cut costs by 30 percent."] + GOOD[1:]
    prompts = replies_to(monkeypatch, invented, invented, invented)
    with pytest.raises(ValueError, match="figures the CV does not state: 30"):
        cover_letter.write_letter("h", "m", None, JOB, CV, listing)
    assert len(prompts) == 3 and "remove figures the CV does not state: 30" in prompts[1][0]


def test_a_job_title_problem_sends_the_cv_with_the_rewrite(monkeypatch):
    titled = ["As a Lead Architect at Northwind, I built Airflow pipelines. " + GOOD[0]] + GOOD[1:]
    prompts = replies_to(monkeypatch, titled, GOOD)
    cover_letter.write_letter("h", "m", None, JOB, CV, "", found=MAP)
    assert "not Lead Architect" in prompts[1][0] and "Candidate: Sam Taylor, engineer" in prompts[1][0]


def test_a_letter_in_another_length_or_tone_is_written_rather_than_reused(kept, monkeypatch):
    tracker, sent, uploads, written = kept
    styles, looked = [], []
    monkeypatch.setattr(cover_letter, "write_letter",
                        lambda *a, **style: styles.append((style["length"], style["tone"], style["found"])) or PARAGRAPHS)
    monkeypatch.setattr(cover_letter.evidence, "for_job", lambda info, key, *a: looked.append(key) or MAP)
    tracker.add_event("e1", "k1", "cover_letter", flags="short,warm")
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert styles == [("short", "warm", MAP)] and looked == ["k1"] and "made earlier" not in lines[0]
    tracker.add_event("e2", "k1", "cover_letter")
    assert cover_letter.process_pending(tracker, lambda: ("h", "m", None))[0].endswith("(the one made earlier)")


def test_a_tailored_cv_uses_the_jobs_evidence_map_and_its_email_says_what_it_covers(setup, tmp_path, monkeypatch):
    tracker, sent = setup
    monkeypatch.setattr(cover_letter, "CV_DIR", tmp_path / "cvs")
    tracker.upsert_job("k1", JOB, emailed=True)
    tracker.add_event("e1", "k1", "tailored_cv")
    master = {"headline": "Engineer", "summary": "Engineer building Airflow pipelines and Python services for teams.",
              "skills": ["Python", "Airflow"], "projects": [], "education": [], "certifications": [],
              "experience": [{"title": "Engineer", "employer": "Northwind", "start": "", "end": "", "location": "",
                              "bullets": ["built Airflow pipelines and Python services"]}], "source_text": CV}
    looked = []
    monkeypatch.setattr(cover_letter.tailored_cv, "master_cv", lambda factory, tracker: dict(master))
    monkeypatch.setattr(cover_letter.evidence, "for_job", lambda info, key, job, cv, listing: looked.append((key, cv)) or MAP)
    monkeypatch.setattr(cover_letter.tailored_cv, "ollama_chat", lambda *a, **k: json.dumps(
        {"headline": "", "summary": "", "skills": ["Python", "Airflow"], "experience": [], "projects": []}))
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert lines == ["Tailored CV sent for AI Engineer"] and looked == [("k1", "Candidate: Sam Taylor, AI engineer")]
    [path] = (tmp_path / "cvs").glob("*.pdf")
    preview = cover_letter.doc_info(path, "tailored_cv", JOB)[1]
    assert "Covers 2 of the 2 requirements your CV shows: Python, Airflow pipelines" in preview
    assert "The advert also asks for, not shown in your CV: Kubernetes" in preview


# --------------------------------------------------------------------------- the profile's own CV

EMPLOYERS = ("Northwind", "Contoso", "Fabrikam", "Proseware", "Litware", "Tailspin", "Wingtip")


@pytest.fixture
def own_cv(kept, tmp_path, monkeypatch):
    """Seven roles with three bullets each, more than any tailored CV keeps, and the profile CV saved under tmp."""
    tracker, sent, uploads, written = kept
    monkeypatch.setattr(cover_letter, "PROFILE_CV_FILE", tmp_path / "cv.pdf")
    master = {"headline": "Data engineer", "summary": "Data engineer building pipelines.", "skills": ["Python", "SQL"],
              "projects": [{"name": "Route planner", "description": "A planner for delivery rounds."}],
              "education": [{"qualification": "MSc Data Analytics", "institution": "", "dates": "", "details": ""}],
              "certifications": [], "source_text": CV,
              "experience": [{"title": f"Engineer {n}", "employer": employer, "start": str(2010 + n), "end": str(2011 + n),
                              "location": "", "bullets": [f"Built pipeline {n}{b} for {employer}" for b in "abc"]}
                             for n, employer in enumerate(EMPLOYERS)]}
    read = []
    monkeypatch.setattr(cover_letter.tailored_cv, "master_cv", lambda factory, tracker: read.append(1) or dict(master))
    yield tracker, sent, uploads, read


def test_the_profiles_own_cv_lays_out_every_role_and_is_kept_on_the_worker_not_emailed(own_cv):
    tracker, sent, uploads, read = own_cv
    assert tracker.add_event("e1", "profile:cv", "profile_cv", flags="quiet,fresh")
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert lines == ["CV made for download for the profile"] and sent == []
    (url, params, data, headers), = uploads
    assert url == "https://fb.example.org/api/cv" and params == {"u": "owner", "name": "CV - Sam Taylor.pdf"}
    assert headers["Content-Type"] == "application/pdf" and data.startswith(b"%PDF")
    text = page_text(data)
    for n, employer in enumerate(EMPLOYERS):
        assert employer in text and all(f"Built pipeline {n}{b}" in text for b in "abc")
    assert "MSc Data Analytics" in text and "Route planner" in text and "Sam Taylor" in text
    assert cover_letter.PROFILE_CV_FILE.read_bytes() == data
    assert tracker.pending_letters(action="profile_cv") == [] and tracker.open_requests() == []


def test_each_generate_makes_a_new_profile_cv_that_replaces_the_last(own_cv, monkeypatch):
    tracker, sent, uploads, read = own_cv
    monkeypatch.setenv("JOB_PROFILE_ID", "sam-lee-456789")
    tracker.add_event("e1", "profile:cv", "profile_cv", flags="quiet,fresh")
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    tracker.add_event("e2", "profile:cv", "profile_cv", flags="quiet,fresh", at=time.time() + 1)
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert lines == ["CV made for download for the profile"] and len(read) == 2 and len(uploads) == 2
    assert uploads[-1][1]["u"] == "sam-lee-456789" and list(cover_letter.PROFILE_CV_FILE.parent.glob("cv*.pdf")) == [
        cover_letter.PROFILE_CV_FILE]


def test_a_profile_cv_the_worker_did_not_get_is_tried_again_then_given_up(own_cv, monkeypatch):
    tracker, sent, uploads, read = own_cv

    def down(*args, **kwargs):
        raise cover_letter.requests.ConnectionError("worker down")
    monkeypatch.setattr(cover_letter.requests, "post", down)
    tracker.add_event("e1", "profile:cv", "profile_cv", flags="quiet,fresh")
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert lines == ["CV will retry for the profile: could not keep the CV on the Worker for download: "
                     "feedback Worker unreachable (ConnectionError)"]
    assert [r["attempts"] for r in tracker.pending_letters(action="profile_cv")] == [1]
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert cover_letter.process_pending(tracker, lambda: ("h", "m", None))[0].startswith("CV failed for the profile")
    assert tracker.pending_letters(action="profile_cv") == [] and sent == []


def test_a_profile_cv_needs_a_cv_and_says_so(kept, tmp_path, monkeypatch):
    tracker, sent, uploads, written = kept
    monkeypatch.setattr(cover_letter, "PROFILE_CV_FILE", tmp_path / "cv.pdf")

    def none(factory, tracker):
        raise FileNotFoundError("no CV found (upload one on the dashboard, or set COVER_LETTER_CV_FILE)")
    monkeypatch.setattr(cover_letter.tailored_cv, "master_cv", none)
    tracker.add_event("e1", "profile:cv", "profile_cv", flags="quiet,fresh")
    lines = cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert lines[0].startswith("CV will retry for the profile: FileNotFoundError: no CV found")
    assert uploads == [] and not cover_letter.PROFILE_CV_FILE.exists()



# --------------------------------------------------------------------------- Word copies

@pytest.fixture
def word(kept, monkeypatch):
    """Word copies switched on, and a Worker that takes them."""
    monkeypatch.setenv("DOC_WORD_COPIES", "1")
    monkeypatch.setattr(cover_letter.worker_link, "word_ready", lambda: True)
    return kept


def test_word_copies_are_saved_beside_the_pdf_and_emailed_with_it(word):
    tracker, sent, uploads, written = word
    tracker.add_event("e1", "k1", "cover_letter", flags="fresh")
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    (subject, [(pdf_name, pdf, pdf_mime), (doc_name, docx, doc_mime)]), = sent
    assert pdf_name == "Cover letter - Sam Taylor - AI Engineer.pdf" and pdf.startswith(b"%PDF") and pdf_mime == "application/pdf"
    assert doc_name == "Cover letter - Sam Taylor - AI Engineer.docx" and doc_mime == cover_letter.DOCX_MIME
    assert "Dear Hiring Manager," in cv_text.docx_text(docx)
    assert len(list(cover_letter.LETTER_DIR.glob("*.docx"))) == 1


def test_the_upload_is_one_bundle_of_the_pdf_and_its_word_copy(word):
    tracker, sent, uploads, written = word
    tracker.add_event("e1", "k1", "cover_letter", flags="quiet,fresh")
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    (url, params, data, headers), = [u for u in uploads if u[0].endswith("/api/doc")]
    assert headers["Content-Type"] == "application/octet-stream" and data[:4] == cover_letter.BUNDLE_MAGIC
    size = int.from_bytes(data[4:8], "big")
    assert data[8:8 + size].startswith(b"%PDF") and data[8 + size:].startswith(b"PK\x03\x04")
    assert params["name"].endswith(".pdf")


def test_an_older_worker_gets_the_pdf_alone(word, monkeypatch):
    tracker, sent, uploads, written = word
    monkeypatch.setattr(cover_letter.worker_link, "word_ready", lambda: False)
    tracker.add_event("e1", "k1", "cover_letter", flags="quiet,fresh")
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    (url, params, data, headers), = [u for u in uploads if u[0].endswith("/api/doc")]
    assert data.startswith(b"%PDF") and headers["Content-Type"] == "application/pdf"


def test_with_word_copies_off_there_is_no_word_file(kept):
    tracker, sent, uploads, written = kept
    tracker.add_event("e1", "k1", "cover_letter", flags="fresh")
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    (subject, attachments), = sent
    assert [a[0][-4:] for a in attachments] == [".pdf"] and not list(cover_letter.LETTER_DIR.glob("*.docx"))


def test_a_letter_sent_again_carries_its_word_copy_and_a_new_one_without_drops_it(word, monkeypatch):
    tracker, sent, uploads, written = word
    tracker.add_event("e1", "k1", "cover_letter", flags="fresh")
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    sent.clear()
    tracker.add_event("e2", "k1", "cover_letter", at=time.time() + 1)
    cover_letter.process_pending(tracker, lambda: pytest.fail("no model needed"))
    assert [a[0][-5:] for a in sent[0][1]] == ["r.pdf", ".docx"]
    monkeypatch.setenv("DOC_WORD_COPIES", "0")
    tracker.add_event("e3", "k1", "cover_letter", flags="fresh", at=time.time() + 2)
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    assert not list(cover_letter.LETTER_DIR.glob("*.docx"))


def test_word_copies_of_tailored_cvs_and_prep_packs(word, tmp_path, monkeypatch):
    tracker, sent, uploads, written = word
    monkeypatch.setattr(cover_letter, "PREP_DIR", tmp_path / "prep")
    cv = {"name": "Sam Taylor", "headline": "AI Engineer", "summary": "Builds retrieval systems.", "skills": ["Python"],
          "experience": [], "projects": [], "education": [], "certifications": []}
    monkeypatch.setattr(cover_letter.tailored_cv, "master_cv", lambda *a, **k: dict(cv))
    monkeypatch.setattr(cover_letter.tailored_cv, "tailored_cv", lambda master, *a, **k: master)
    monkeypatch.setattr(cover_letter, "write_prep", lambda *a, **k: (
        {"company": ["Acme builds search"], "questions": [{"question": "Why Acme?", "why": ""}], "answers": [], "ask": []}, []))
    tracker.add_event("e1", "k1", "tailored_cv", flags="fresh")
    tracker.add_event("e2", "k1", "interview_prep", flags="fresh")
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    docs = {s[0].split(":")[0]: s[1][1] for s in sent}
    assert "Builds retrieval systems." in cv_text.docx_text(docs["Tailored CV"][1])
    assert "Why Acme?" in cv_text.docx_text(docs["Interview prep"][1])


def test_the_bundle_is_the_magic_the_pdf_length_the_pdf_and_the_word_copy():
    data = cover_letter.doc_bundle(b"%PDF-1.4 x", b"PK\x03\x04y")
    assert data == b"HSD1" + (10).to_bytes(4, "big") + b"%PDF-1.4 x" + b"PK\x03\x04y"
    assert cover_letter.word_name("CV - Sam.pdf") == "CV - Sam.docx" and cover_letter.word_name("x") == "x.docx"


def test_the_email_says_a_word_copy_is_attached():
    subject, body, text = cover_letter.email_bodies(JOB, PARAGRAPHS, "Letter.pdf", "", word="Letter.docx")
    assert "A Word copy to edit, <b>Letter.docx</b>, is attached too." in body and "Attached: Letter.pdf and Letter.docx" in text

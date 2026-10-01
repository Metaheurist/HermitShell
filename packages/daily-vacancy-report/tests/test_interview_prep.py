"""Interview prep packs: the model's answer cleaned and checked, the PDF, the request pipeline and the automatic
pack when a job reaches Interview (no model, SMTP or network)."""

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
from job_tracker import AUTO_PREP_DAYS, REQUEST_ACTIONS, Tracker  # noqa: E402

DAY = 86400
JOB = {"title": "AI Engineer", "company": "Acme", "location": "Belfast", "matched": ["Python"], "gaps": [],
       "about": "Acme builds route planning software for delivery firms.", "listing": "Python and Airflow.",
       "url": "https://example.com/job/1", "fit": 8}
MAP = [{"need": "Python", "evidence": "Python services", "where": "Skills"},
       {"need": "Airflow pipelines", "evidence": "built Airflow pipelines", "where": "Engineer at Northwind"}]
TOPICS = ("Python", "Airflow", "testing", "on-call", "data quality", "deadlines", "mentoring", "route planning")
QUESTIONS = [{"question": f"Tell us about your {t} work?", "why": "The advert asks for it."} for t in TOPICS]
ANSWER = {"question": "Tell us about your Python work?", "situation": "At Northwind the team needed reliable data.",
          "task": "I owned the pipelines.", "action": "I built Airflow pipelines and Python services.",
          "result": "Reports arrived on time each morning."}
GOOD = {"company": ["Acme builds route planning software."], "questions": QUESTIONS, "answers": [ANSWER],
        "ask": ["How is the team organised?", "What would success look like in six months?", "Who uses the software?"]}
WORKER_EVENT_ID = re.compile(r"^event:[a-z0-9_-]{1,40}:[A-Za-z0-9:_-]{1,120}$")


def page_text(pdf: bytes) -> str:
    streams = re.findall(rb"stream\n(.*?)\nendstream", pdf, flags=re.S)
    return b"\n".join(zlib.decompress(s) for s in streams).decode("cp1252")


def replies(monkeypatch, *packs):
    calls = []
    answers = iter(packs)
    monkeypatch.setattr(cover_letter, "ollama_chat",
                        lambda *a, **k: calls.append((a[3], k)) or json.dumps(next(answers)))
    return calls


# --------------------------------------------------------------------------- the model's answer

def test_clean_prep_keeps_the_schema_shape_and_sizes():
    messy = {"company": ["  Acme  builds\nsoftware ", "", 7, *["x" * 400] * 6], "questions": [*QUESTIONS, *QUESTIONS],
             "answers": ["not a dict", {"question": ""}, ANSWER | {"extra": "dropped"}], "ask": "not a list", "other": 1}
    clean = cover_letter.clean_prep(messy)
    assert set(clean) == {"company", "questions", "answers", "ask"}
    assert clean["company"][0] == "Acme builds software" and clean["company"][1] == "7" and len(clean["company"]) == 5
    assert all(len(c) <= 300 for c in clean["company"]) and len(clean["questions"]) == 8
    assert clean["answers"] == [ANSWER] and clean["ask"] == []
    assert cover_letter.clean_prep("nonsense") == {"company": [], "questions": [], "answers": [], "ask": []}


def test_prep_problems_catch_invented_figures_placeholders_cliches_and_too_few_questions():
    source = cover_letter.job_facts(JOB) + "\n" + "\n".join(m["evidence"] for m in MAP)
    assert cover_letter.prep_problems(cover_letter.clean_prep(GOOD), source) == []
    bad = cover_letter.clean_prep(GOOD | {"questions": QUESTIONS[:5],
                                          "answers": [ANSWER | {"result": "Cut costs by 40% for [Client]."}],
                                          "ask": ["I am a team player, what next?"]})
    problems = " | ".join(cover_letter.prep_problems(bad, source))
    for part in ("write 8 likely questions (it has 5)", "[Client]", "figures the CV and advert do not state: 40",
                 "'team player'"):
        assert part in problems


def test_the_prompt_takes_the_employer_only_from_the_advert_and_answers_only_from_the_evidence():
    prompt = cover_letter.prep_prompt(JOB, "Python and Airflow.", MAP, "they mentioned a test")
    for text in ("ABOUT THE EMPLOYER, FROM THE ADVERT:\nAcme builds route planning", "built Airflow pipelines",
                 "they mentioned a test", "the 8 questions"):
        assert text in prompt
    bare = cover_letter.prep_prompt(JOB | {"about": ""}, "", [], "")
    assert '(none: return "company" as [])' in bare and '(none: return "answers" as [])' in bare


def test_a_pack_that_fails_is_rewritten_once_with_what_failed(monkeypatch):
    calls = replies(monkeypatch, GOOD | {"ask": ["Is this my dream job?", "a", "b"]}, GOOD)
    prep, problems = cover_letter.write_prep("h", "m", None, JOB, "Python and Airflow.", MAP)
    assert problems == [] and prep["questions"] == QUESTIONS and len(calls) == 2
    assert "YOUR DRAFT" in calls[1][0] and "'dream job'" in calls[1][0]
    assert calls[0][1]["task"] == "interview_prep" and calls[0][1]["fmt"] is cover_letter.PREP_SCHEMA


def test_a_pack_that_still_fails_comes_back_with_its_problems_to_flag(monkeypatch):
    invented = GOOD | {"answers": [ANSWER | {"result": "Saved 12 hours a week."}]}
    replies(monkeypatch, invented, invented)
    prep, problems = cover_letter.write_prep("h", "m", None, JOB, "Python and Airflow.", MAP)
    assert prep["answers"][0]["result"] == "Saved 12 hours a week." and "12" in problems[0]


def test_with_no_evidence_map_no_answers_are_kept(monkeypatch):
    replies(monkeypatch, GOOD)
    prep, problems = cover_letter.write_prep("h", "m", None, JOB, "Python and Airflow.", [])
    assert prep["answers"] == [] and problems == []


def test_a_pack_with_no_questions_is_refused(monkeypatch):
    replies(monkeypatch, {"company": [], "questions": [], "answers": [], "ask": []},
            {"company": [], "questions": [], "answers": [], "ask": []})
    with pytest.raises(ValueError, match="no interview questions"):
        cover_letter.write_prep("h", "m", None, JOB, "", MAP)


# --------------------------------------------------------------------------- PDF

def test_prep_pdf_has_every_section_and_escapes_what_the_model_wrote():
    pack = cover_letter.clean_prep(GOOD | {"company": ["Acme (Belfast) builds software) BT /F1 9 Tf"]})
    pdf = letter_pdf.prep_pdf("Sam Taylor", "AI Engineer", "Acme", pack, cover_letter.PREP_CHECK)
    assert pdf.startswith(b"%PDF-1.4") and pdf.rstrip().endswith(b"%%EOF")
    text = page_text(pdf)
    for part in ("INTERVIEW PREP", "ABOUT THE EMPLOYER \\(FROM THE ADVERT\\)", "QUESTIONS THEY MAY ASK",
                 "QUESTIONS TO ASK THEM", "(1. Tell us about your Python work?) Tj", "Situation: At Northwind", "Check before use",
                 "Acme \\(Belfast\\) builds software\\) BT /F1 9 Tf"):
        assert part.upper() in text.upper()
    assert b"/Title (Interview prep - AI Engineer)" in pdf


def test_a_long_pack_flows_onto_more_pages():
    long = GOOD | {"answers": [ANSWER | {"action": "I built Airflow pipelines and Python services. " * 20}] * 4}
    assert b"/Count 1" not in letter_pdf.prep_pdf("Sam", "AI Engineer", "Acme", cover_letter.clean_prep(long))


# --------------------------------------------------------------------------- requests

@pytest.fixture
def setup(tmp_path, monkeypatch):
    tracker = Tracker(tmp_path / "tracker.db")
    profile = tmp_path / "profile.md"
    profile.write_text("Candidate: Sam Taylor, engineer", encoding="utf-8")
    monkeypatch.setenv("JOB_PROFILE_FILE", str(profile))
    monkeypatch.delenv("COVER_LETTER_NAME", raising=False)
    monkeypatch.setenv("JOB_FEEDBACK_URL", "https://fb.example.org")
    monkeypatch.setenv("JOB_FEEDBACK_API_TOKEN", "tok")
    monkeypatch.delenv("COVER_LETTER_KEEP_DAYS", raising=False)
    monkeypatch.delenv("JOB_PROFILE_ID", raising=False)
    monkeypatch.setattr(cover_letter, "PREP_DIR", tmp_path / "prep")
    monkeypatch.setattr(cover_letter, "WRITING_FILE", tmp_path / "writing.json")
    monkeypatch.setattr(cover_letter.evidence, "for_job", lambda *a, **k: MAP)
    sent, uploads = [], []
    monkeypatch.setattr(cover_letter.hc, "send_email",
                        lambda subject, body, text, sender, attachments=None: sent.append((subject, body, attachments)))

    class Response:
        def raise_for_status(self):
            return None

    monkeypatch.setattr(cover_letter.requests, "post",
                        lambda url, params=None, data=None, headers=None, **kw: uploads.append((url, params, data)) or Response())
    tracker.upsert_job("k1", JOB, emailed=True)
    yield tracker, sent, uploads


def test_interview_prep_is_a_request_the_pipeline_carries_out():
    assert "interview_prep" in REQUEST_ACTIONS and cover_letter.MAKERS["interview_prep"] is cover_letter.make_prep
    assert cover_letter.doc_dir("interview_prep") == cover_letter.PREP_DIR


def test_a_prep_pack_is_emailed_and_kept_on_the_worker(setup, monkeypatch):
    tracker, sent, uploads = setup
    replies(monkeypatch, GOOD)
    tracker.add_event("e1", "k1", "interview_prep", reason="they mentioned a test")
    assert cover_letter.process_pending(tracker, lambda: ("h", "m", None)) == ["Interview prep sent for AI Engineer"]
    (subject, body, [(filename, pdf, kind)]), = sent
    assert subject == "Interview prep: AI Engineer at Acme" and filename == "Interview prep - Sam Taylor - AI Engineer.pdf"
    assert kind == "application/pdf" and pdf.startswith(b"%PDF") and "route planning work?" in body
    assert "they mentioned a test" in body
    (params, data), = [(p, d) for url, p, d in uploads if url == "https://fb.example.org/api/doc"]
    assert params["k"] == "interview_prep" and params["j"] == "k1" and data == pdf
    assert tracker.pending_letters(action="interview_prep") == []


def test_a_pack_that_fails_its_checks_is_sent_with_a_line_to_check_it(setup, monkeypatch):
    tracker, sent, _ = setup
    invented = GOOD | {"answers": [ANSWER | {"result": "Saved 12 hours a week."}]}
    replies(monkeypatch, invented, invented)
    tracker.add_event("e1", "k1", "interview_prep")
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    (subject, body, [(_, pdf, _)]), = sent
    assert cover_letter.PREP_CHECK in body and "Check before use" in page_text(pdf)


def test_a_pack_made_recently_is_sent_again_without_the_model(setup, monkeypatch):
    tracker, sent, uploads = setup
    replies(monkeypatch, GOOD)
    tracker.add_event("e1", "k1", "interview_prep")
    cover_letter.process_pending(tracker, lambda: ("h", "m", None))
    tracker.add_event("e2", "k1", "interview_prep")
    lines = cover_letter.process_pending(tracker, lambda: pytest.fail("no model needed"))
    assert lines == ["Interview prep sent for AI Engineer (the one made earlier)"] and len(sent) == 2


# --------------------------------------------------------------------------- automatic on Interview

def test_reaching_interview_queues_one_pack_per_job_ever(setup):
    tracker, _, _ = setup
    now = time.time()
    tracker.add_event("a1", "k1", "applied", at=now - 9 * DAY)
    assert tracker.queue_auto_prep("sam-lee", now=now) == []
    tracker.add_event("i1", "k1", "interview", at=now - 60)
    assert tracker.queue_auto_prep("sam-lee", now=now) == ["k1"]
    [request] = tracker.pending_letters(action="interview_prep")
    assert WORKER_EVENT_ID.match(request["event_id"]) and request["event_id"].startswith("event:sam-lee:auto-prep-")
    assert request["flags"] == ""
    tracker.mark_letter(request["event_id"], "k1", "sent", file="x.pdf")
    tracker.add_event("i2", "k1", "interview", at=now)
    assert tracker.queue_auto_prep("sam-lee", now=now + 1) == []


def test_no_automatic_pack_after_one_was_asked_for_or_for_an_old_interview(setup):
    tracker, _, _ = setup
    now = time.time()
    tracker.upsert_job("k2", JOB, emailed=True)
    tracker.upsert_job("k3", JOB, emailed=True)
    tracker.add_event("i2", "k2", "interview", at=now - 60)
    tracker.add_event("p2", "k2", "interview_prep", at=now - 30)
    tracker.add_event("i3", "k3", "interview", at=now - (AUTO_PREP_DAYS + 1) * DAY)
    tracker.add_event("i1", "k1", "interview", at=now - 60)
    tracker.add_event("o1", "k1", "offer", at=now - 30)
    assert tracker.queue_auto_prep(now=now) == []


def test_the_owners_automatic_pack_uses_the_owners_event_prefix(setup):
    tracker, _, _ = setup
    tracker.add_event("i1", "k1", "interview")
    tracker.queue_auto_prep()
    assert tracker.pending_letters(action="interview_prep")[0]["event_id"].startswith("event:_:auto-prep-")


@pytest.mark.parametrize("switch, queued", [("0", 0), ("1", 1)])
def test_the_cron_run_queues_packs_only_with_the_switch_on(setup, tmp_path, monkeypatch, switch, queued):
    tracker, _, _ = setup
    tracker.add_event("i1", "k1", "interview")
    tracker.close()
    monkeypatch.setenv("INTERVIEW_PREP_AUTO", switch)
    monkeypatch.setattr(cover_letter, "TRACKER_FILE", tmp_path / "tracker.db")
    monkeypatch.setattr(cover_letter, "LOCK_FILE", tmp_path / "cover_letter.lock")
    monkeypatch.setattr(cover_letter, "FULL_SYNC_FILE", tmp_path / "full_sync")
    monkeypatch.setattr(cover_letter, "load_env_file", lambda: None)
    monkeypatch.setattr(cover_letter.hc, "set_model_priority", lambda **k: None)
    monkeypatch.setattr(cover_letter.profiles, "spawn_others", lambda *a: None)
    monkeypatch.setattr(cover_letter.profiles, "staff_run", lambda *a: False)
    monkeypatch.setattr(cover_letter, "sync_feedback", lambda *a, **k: (0, ""))
    seen = []
    monkeypatch.setattr(cover_letter, "process_pending",
                        lambda t, factory, dry_run: seen.append(len(t.pending_letters(action="interview_prep"))) or [])
    assert cover_letter.main([]) == 0 and seen == [queued]

"""The Word copies (letter_docx.py): valid, minimal packages whose text reads back as written, and that text from the
model or the recruit can't break or add to."""

import io
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import cv_text  # noqa: E402
import letter_docx  # noqa: E402

PARTS = ["[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "word/_rels/document.xml.rels",
         "word/styles.xml", "word/document.xml"]
CV = {"name": "Alex Morgan", "headline": "Data Engineer", "contact": "Leeds \u00b7 alex@example.com",
      "summary": "Builds batch pipelines in Python and SQL.", "skills": ["Python", "SQL", "Airflow"],
      "experience": [{"title": "Data Engineer", "employer": "Contoso", "location": "Leeds", "start": "2021", "end": "2024",
                      "bullets": ["Ran the Airflow estate", "Cut the nightly load from 4 hours to 1"]}],
      "projects": [{"name": "Warehouse migration", "description": "Moved reporting to the cloud."}],
      "education": [{"qualification": "BSc Computing", "institution": "Northwind University", "dates": "2017 - 2020",
                     "details": "First class"}],
      "certifications": ["Azure Data Engineer Associate"]}
PREP = {"company": ["Runs grocery delivery across the north"],
        "questions": [{"question": "Tell us about an Airflow outage", "why": "The advert stresses reliability"}],
        "answers": [{"question": "Tell us about an Airflow outage", "situation": "A scheduler crash", "task": "Restore runs",
                     "action": "Added alerting", "result": "No missed loads since"}],
        "ask": ["How is on-call shared?"]}


def letter(paragraphs, **kw):
    return letter_docx.letter_docx("Alex Morgan", "Leeds \u00b7 alex@example.com", "1 October 2026",
                                   ["Hiring Manager", "Northwind", "Leeds"], "Application for Data Engineer",
                                   "Dear Hiring Manager,", paragraphs, **kw)


def parts(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return {i.filename: zf.read(i) for i in zf.infolist()}


def test_a_letter_is_the_minimal_package_with_fixed_names():
    data = letter(["First paragraph.", "Second paragraph."])
    found = parts(data)
    assert list(found) == PARTS and data.startswith(b"PK\x03\x04")
    for xml in found.values():
        ElementTree.fromstring(xml)  # nosec B314 - our own output
    everything = b"".join(found.values())
    assert b"TargetMode" not in everything and b"External" not in everything
    assert b"instrText" not in everything and b"fldSimple" not in everything and b"macroEnabled" not in everything
    assert letter_docx.DOCX_MIME.endswith("wordprocessingml.document")


def test_a_letter_reads_back_with_the_cv_reader():
    text = cv_text.docx_text(letter(["I build pipelines.", "I would welcome a conversation."], closing="Best wishes,"))
    for line in ("Alex Morgan", "1 October 2026", "Northwind", "Application for Data Engineer", "Dear Hiring Manager,",
                 "I build pipelines.", "I would welcome a conversation.", "Best wishes,"):
        assert line in text


@pytest.mark.parametrize("hostile", ["<w:p>injected</w:p>", "Fish & chips", "bell\x01tab\x0bfeed\x0c", "]]><x/>",
                                     "lone \ud800 surrogate", '"quoted" \'single\''])
def test_hostile_text_comes_back_as_plain_text(hostile):
    data = letter([f"Before {hostile} after"])
    document = parts(data)["word/document.xml"]
    root = ElementTree.fromstring(document)  # nosec B314 - our own output
    w = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    assert {el.tag for el in root.iter()} <= {f"{w}{t}" for t in ("document", "body", "p", "pPr", "pStyle", "spacing", "r",
                                                                 "rPr", "b", "color", "sz", "szCs", "t", "br", "tab",
                                                                 "tabs", "ind", "keepNext", "sectPr", "pgSz", "pgMar")}
    text = cv_text.docx_text(data)
    assert f"Before {letter_docx.clean(hostile)} after" in text
    assert "\x01" not in text and "\ud800" not in text


def test_clean_removes_exactly_what_xml_forbids():
    forbidden = {*range(0x00, 0x09), 0x0B, 0x0C, *range(0x0E, 0x20), *range(0xD800, 0xE000), 0xFFFE, 0xFFFF}
    kept = [c for c in range(0x10000) if c not in forbidden]
    assert all(letter_docx.clean(chr(c)) == "" for c in forbidden)
    assert letter_docx.clean("".join(map(chr, kept))) == "".join(map(chr, kept))
    assert letter_docx.clean("\U0001f600 tab\tline\nreturn\r") == "\U0001f600 tab\tline\nreturn\r"


def test_line_breaks_in_a_paragraph_are_breaks_not_new_elements():
    root = ElementTree.fromstring(parts(letter(["one\ntwo"]))["word/document.xml"])  # nosec B314
    assert sum(1 for el in root.iter() if el.tag.endswith("}br")) == 1


def test_the_same_letter_makes_the_same_bytes():
    assert letter(["Same."]) == letter(["Same."])


def test_the_title_and_author_are_escaped_in_the_properties():
    core = parts(letter(["x"], title="Cover <letter> & co"))["docProps/core.xml"].decode()
    assert "Cover &lt;letter&gt; &amp; co" in core and "<dc:creator>Alex Morgan</dc:creator>" in core


def test_a_cv_has_every_section_and_leaves_empty_ones_out():
    text = cv_text.docx_text(letter_docx.cv_docx(CV, title="CV - Alex Morgan"))
    for line in ("Alex Morgan", "Data Engineer", "Profile", "Python  \u00b7  SQL  \u00b7  Airflow", "Contoso  \u00b7  Leeds",
                 "2021 - 2024", "Ran the Airflow estate", "Warehouse migration", "BSc Computing", "Northwind University",
                 "Azure Data Engineer Associate"):
        assert line in text
    bare = cv_text.docx_text(letter_docx.cv_docx({"name": "Sam Lee", "skills": ["SQL"]}))
    assert "Skills" in bare and "Experience" not in bare and "Projects" not in bare and "Education" not in bare


def test_a_prep_pack_has_its_warning_questions_answers_and_questions_to_ask():
    text = cv_text.docx_text(letter_docx.prep_docx("Alex Morgan", "Data Engineer", "Northwind", PREP, "Check before use"))
    for line in ("Interview prep", "Data Engineer at Northwind", "Check before use", "About the employer",
                 "1. Tell us about an Airflow outage", "The advert stresses reliability", "Situation: A scheduler crash",
                 "Result: No missed loads since", "How is on-call shared?"):
        assert line in text
    assert "Check before use" not in cv_text.docx_text(letter_docx.prep_docx("Alex", "Data Engineer", "", PREP))

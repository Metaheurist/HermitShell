"""Unit tests for cv_text: CV text from PDF, Word and plain text files."""

import base64
import io
import sys
import time
import zipfile
import zlib
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import cv_text  # noqa: E402
import letter_pdf  # noqa: E402

CMAP = b"""/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0001> <0053> <0002> <0051> endbfchar
2 beginbfrange <0003> <0004> <004C> <0005> <0006> [<00E9> <2013>] endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end"""


def build_pdf(objects: dict[int, bytes], stream_objects: dict[int, bytes] | None = None) -> bytes:
    """A minimal PDF; objects in stream_objects are packed into a compressed object stream."""
    out = [b"%PDF-1.5\n"]
    for num, body in objects.items():
        out.append(b"%d 0 obj\n%s\nendobj\n" % (num, body))
    if stream_objects:
        header, bodies = [], b""
        for num, body in stream_objects.items():
            header.append(b"%d %d" % (num, len(bodies)))
            bodies += body + b"\n"
        head = b" ".join(header) + b"\n"
        packed = zlib.compress(head + bodies)
        out.append(b"99 0 obj\n<< /Type /ObjStm /N %d /First %d /Filter /FlateDecode /Length %d >>\nstream\n%s\nendstream\nendobj\n"
                   % (len(stream_objects), len(head), len(packed), packed))
    out.append(b"trailer\n<< /Root 1 0 R >>\n%%EOF\n")
    return b"".join(out)


def stream(data: bytes, compress: bool = True) -> bytes:
    body = zlib.compress(data) if compress else data
    flt = b" /Filter /FlateDecode" if compress else b""
    return b"<< /Length %d%s >>\nstream\n%s\nendstream" % (len(body), flt, body)


def sample_pdf() -> bytes:
    page1 = b"BT /F1 12 Tf 72 720 Td (Sam Lee) Tj 0 -14 Td [(Py) 20 (thon) -300 (and SQL)] TJ ET"
    page2 = b"BT /F2 11 Tf 1 0 0 1 72 700 Tm <000100020003> Tj 1 0 0 1 72 686 Tm <0004000500060001> Tj ET"
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [4 0 R 3 0 R] /Count 2 /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
        3: b"<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>",
        4: b"<< /Type /Page /Parent 2 0 R /Contents [7 0 R] >>",
        7: stream(page1),
        8: stream(page2, compress=False),
        9: stream(CMAP),
    }
    packed = {
        5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        6: b"<< /Type /Font /Subtype /Type0 /BaseFont /Calibri /Encoding /Identity-H /ToUnicode 9 0 R >>",
    }
    return build_pdf(objects, packed)


def test_pdf_text_follows_page_order_and_fonts():
    text = cv_text.extract_text(sample_pdf(), "pdf")
    assert text.splitlines() == ["Sam Lee", "Python and SQL", "", "SQL", "Mé–S"]


def test_pdf_text_in_ascii85_streams_and_form_xobjects():
    form = b"BT /F1 10 Tf 0 0 Td (Inside a form) Tj ET"
    encoded = base64.a85encode(zlib.compress(b"BT /F1 12 Tf 72 720 Td (Page text) Tj ET q /Fm1 Do Q"), adobe=True)
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> /XObject << /Fm1 5 0 R >> >> >>",
        4: b"<< /Length %d /Filter [/ASCII85Decode /FlateDecode] >>\nstream\n%s\nendstream" % (len(encoded), encoded),
        5: b"<< /Type /XObject /Subtype /Form /Length %d >>\nstream\n%s\nendstream" % (len(form), form),
        6: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    assert cv_text.extract_text(build_pdf(objects), "pdf").splitlines() == ["Page text", "Inside a form"]


def test_cmap_ranges_and_arrays():
    mapping, width = cv_text.parse_cmap(CMAP)
    assert width == 2
    assert mapping == {1: "S", 2: "Q", 3: "L", 4: "M", 5: "é", 6: "–"}


def test_literal_strings_with_escapes():
    fonts = {b"F1": cv_text.Font()}
    text = cv_text.content_text(rb"BT /F1 9 Tf (A \(nested (ok)\) caf\351 \\ end) Tj ET", fonts)
    assert text.strip() == "A (nested (ok)) café \\ end"


def test_round_trips_a_letter_pdf():
    body = "I build data pipelines with Python, dbt and Airflow for Contoso, and I report to the café owner. " * 8
    pdf = letter_pdf.letter_pdf("Sam Lee", "sam@example.com", "1 May 2026", ["Northwind Ltd"], "Data Engineer",
                                "Dear Hiring Manager,", [body])
    text = cv_text.extract_text(pdf, "pdf")
    assert text.splitlines()[:2] == ["Sam Lee", "sam@example.com"]
    assert "Dear Hiring Manager," in text
    assert "Airflow" in text and "café owner" in text


def test_scanned_or_broken_pdf_gives_empty_text():
    assert cv_text.extract_text(b"%PDF-1.4\n1 0 obj\n<< /Type /XObject /Filter /DCTDecode >>\nstream\n\xff\xd8\nendstream\nendobj\n", "pdf") == ""
    assert cv_text.extract_text(b"not a pdf at all", "pdf") == ""


def test_hostile_pdfs_finish_quickly():
    started = time.monotonic()
    loop = build_pdf({1: b"<< /Type /Catalog /Pages 2 0 R >>",
                      2: b"<< /Type /Pages /Kids [2 0 R 2 0 R 2 0 R 3 0 R] >>",
                      3: b"<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>", 4: stream(b"BT (Once) Tj ET")})
    assert cv_text.extract_text(loop, "pdf") == "Once"
    fanout = b"q " + b"/Fm1 Do " * 200 + b"Q"
    forms = build_pdf({
        1: b"<< /Type /Catalog /Pages 2 0 R >>", 2: b"<< /Type /Pages /Kids [3 0 R] >>",
        3: b"<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /Fm1 4 0 R >> >> >>",
        4: b"<< /Type /XObject /Subtype /Form /Length %d >>\nstream\n%s\nendstream" % (len(fanout), fanout)})
    assert cv_text.extract_text(forms, "pdf") == ""
    assert cv_text.extract_text(b"%PDF-1.4\n" + b"1 0 obj " * 50_000, "pdf") == ""
    ranges = b"beginbfrange " + b"<0000> <FFFF> <0041> " * 200 + b"endbfrange"
    assert len(cv_text.parse_cmap(ranges)[0]) <= cv_text.MAX_CMAP
    assert time.monotonic() - started < 20


def test_inflating_stops_at_the_file_budget():
    budget = cv_text._Budget()
    bomb = zlib.compress(b"\0" * (cv_text.MAX_INFLATE + 1024))
    total = sum(len(cv_text._inflate(bomb, budget)) for _ in range(5))
    assert total == cv_text.MAX_TOTAL_INFLATE and cv_text._inflate(bomb, budget) == b""


def test_isolated_extraction_reads_a_file(tmp_path):
    path = tmp_path / "cv.pdf"
    path.write_bytes(sample_pdf())
    assert cv_text.extract_file_isolated(path).splitlines()[:2] == ["Sam Lee", "Python and SQL"]


def docx(paragraphs: list[str], header: str = "") -> bytes:
    w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = "".join(f'<w:p><w:r><w:t xml:space="preserve">{p}</w:t></w:r></w:p>' for p in paragraphs)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("word/document.xml", f'<w:document xmlns:w="{w}"><w:body>{body}'
                    f'<w:p><w:r><w:t>Skills:</w:t><w:tab/><w:t>SQL</w:t><w:br/><w:t>Power BI</w:t></w:r></w:p></w:body></w:document>')
        if header:
            zf.writestr("word/header1.xml", f'<w:hdr xmlns:w="{w}"><w:p><w:r><w:t>{header}</w:t></w:r></w:p></w:hdr>')
    return buf.getvalue()


def test_docx_text_with_header_first():
    text = cv_text.extract_text(docx(["Sam Lee", "Data analyst"], header="sam@example.com"), "docx")
    assert text.splitlines() == ["sam@example.com", "Sam Lee", "Data analyst", "Skills: SQL", "Power BI"]


def test_docx_with_entities_is_ignored():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("word/document.xml", '<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>')
    assert cv_text.extract_text(buf.getvalue(), "docx") == ""


def test_plain_text_encodings_and_whitespace():
    assert cv_text.extract_text("\ufeffSam  Lee\r\n\r\n\r\n\r\nCafé".encode("utf-8"), "txt") == "Sam Lee\n\nCafé"
    assert cv_text.extract_text("Café".encode("cp1252"), ".md") == "Café"
    with pytest.raises(ValueError):
        cv_text.extract_text(b"", "exe")

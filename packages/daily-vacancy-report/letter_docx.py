"""Word copies of the cover letters, tailored CVs and interview prep packs, with the standard library only.

A .docx is a zip of XML parts (Office Open XML). This writes the smallest package Word and LibreOffice open:
[Content_Types].xml, the package and document relationships, word/document.xml, word/styles.xml and
docProps/core.xml for the title. Part names are fixed, there are no external relationships, fields or macros,
and every piece of text is XML-escaped with the characters XML 1.0 forbids removed, so text from the model or
the recruit can only ever be text. The layout follows letter_pdf.py.
"""
from __future__ import annotations

import io
import re
import zipfile
from xml.sax.saxutils import escape

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
INK, MUTED, ACCENT, LINE = "0F172A", "475569", "4F46E5", "D9DDE8"
# A4 with letter_pdf.py's margins, in twentieths of a point.
PAGE_W, PAGE_H, MARGIN_X, MARGIN_TOP, MARGIN_BOTTOM = 11906, 16838, 1280, 1200, 1280
TEXT_W = PAGE_W - 2 * MARGIN_X
_STAMP = (1980, 1, 1, 0, 0, 0)
_NOT_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")
_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

CONTENT_TYPES = _HEAD + (
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '<Override PartName="/word/styles.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    '</Types>')
PACKAGE_RELS = _HEAD + (
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/>'
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" '
    'Target="docProps/core.xml"/>'
    '</Relationships>')
DOCUMENT_RELS = _HEAD + (
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
    'Target="styles.xml"/>'
    '</Relationships>')
STYLES = _HEAD + (
    f'<w:styles xmlns:w="{_W}">'
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>'
    f'<w:color w:val="{INK}"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault>'
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>'
    '<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/></w:pPr>'
    f'<w:rPr><w:b/><w:color w:val="{ACCENT}"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>'
    '<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="100"/>'
    f'<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="{LINE}"/></w:pBdr><w:outlineLvl w:val="0"/></w:pPr>'
    f'<w:rPr><w:b/><w:caps/><w:color w:val="{ACCENT}"/><w:spacing w:val="10"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr>'
    '</w:style>'
    '<w:style w:type="paragraph" w:styleId="Rule"><w:name w:val="Rule"/><w:basedOn w:val="Normal"/>'
    f'<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="1" w:color="{ACCENT}"/></w:pBdr>'
    '<w:spacing w:after="240" w:line="120" w:lineRule="exact"/></w:pPr><w:rPr><w:sz w:val="4"/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="Bullet"><w:name w:val="Bullet"/><w:basedOn w:val="Normal"/>'
    '<w:pPr><w:spacing w:after="40"/><w:ind w:left="284" w:hanging="284"/></w:pPr></w:style>'
    '</w:styles>')


def clean(text) -> str:
    """Text with the characters XML 1.0 can't hold removed."""
    return _NOT_XML.sub("", str(text or ""))


def _run(text, bold: bool = False, size: float = 0, colour: str = "") -> str:
    props = ("<w:b/>" if bold else "") + (f'<w:color w:val="{colour}"/>' if colour else "") + (
        f'<w:sz w:val="{round(size * 2)}"/><w:szCs w:val="{round(size * 2)}"/>' if size else "")
    lines = clean(text).split("\n")
    body = "<w:br/>".join(f'<w:t xml:space="preserve">{escape(line)}</w:t>' for line in lines)
    return f"<w:r>{f'<w:rPr>{props}</w:rPr>' if props else ''}{body}</w:r>"


def _para(runs: str, style: str = "", after: int | None = None, indent: int = 0, keep: bool = False,
          tab: bool = False) -> str:
    props = (f'<w:pStyle w:val="{style}"/>' if style else "") + ("<w:keepNext/>" if keep else "") + (
        f'<w:tabs><w:tab w:val="right" w:pos="{TEXT_W}"/></w:tabs>' if tab else "") + (
        f'<w:spacing w:after="{after}"/>' if after is not None else "") + (f'<w:ind w:left="{indent}"/>' if indent else "")
    return f"<w:p>{f'<w:pPr>{props}</w:pPr>' if props else ''}{runs}</w:p>"


def _text(text, after: int | None = None, **run) -> str:
    return _para(_run(text, **run), after=after)


def _bullet(text) -> str:
    return _para(_run("\u2022\t") + _run(text), style="Bullet")


def _split(left, right, size: float = 10.5) -> str:
    """A bold line with something muted (dates) against the right margin, kept with what follows."""
    runs = _run(left, bold=True, size=size) + (("<w:r><w:tab/></w:r>" + _run(right, size=size - 1, colour=MUTED)) if right else "")
    return _para(runs, after=20, keep=True, tab=True)


def _header(top, lines: list[tuple[str, float, str]]) -> list[str]:
    out = [_para(_run(top), style="Title")] if top else []
    out += [_text(text, after=20, size=size, colour=colour) for text, size, colour in lines if text]
    return out + [_para("", style="Rule")]


def _package(body: list[str], title: str, author: str) -> bytes:
    document = _HEAD + (f'<w:document xmlns:w="{_W}"><w:body>{"".join(body)}'
                        f'<w:sectPr><w:pgSz w:w="{PAGE_W}" w:h="{PAGE_H}"/><w:pgMar w:top="{MARGIN_TOP}" w:right="{MARGIN_X}" '
                        f'w:bottom="{MARGIN_BOTTOM}" w:left="{MARGIN_X}" w:header="567" w:footer="567" w:gutter="0"/>'
                        '</w:sectPr></w:body></w:document>')
    core = _HEAD + ('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
                    'xmlns:dc="http://purl.org/dc/elements/1.1/">'
                    f'<dc:title>{escape(clean(title))}</dc:title><dc:creator>{escape(clean(author))}</dc:creator>'
                    '</cp:coreProperties>')
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        for name, xml in (("[Content_Types].xml", CONTENT_TYPES), ("_rels/.rels", PACKAGE_RELS),
                          ("docProps/core.xml", core), ("word/_rels/document.xml.rels", DOCUMENT_RELS),
                          ("word/styles.xml", STYLES), ("word/document.xml", document)):
            info = zipfile.ZipInfo(name, _STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, xml.encode("utf-8"))
    return out.getvalue()


def letter_docx(name: str, contact: str, date_text: str, recipient: list[str], subject: str, salutation: str,
                paragraphs: list[str], closing: str = "Kind regards,", title: str = "") -> bytes:
    """The letter as .docx bytes, laid out as letter_pdf.letter_pdf: name and contact, accent rule, date,
    recipient, subject, body, sign-off."""
    body = _header(name, [(contact, 9.5, MUTED)])
    body.append(_text(date_text, after=240, colour=MUTED))
    body += [_text(line, after=240 if n == len(recipient) - 1 else 0) for n, line in enumerate(recipient)]
    body.append(_text(subject, after=240, bold=True, size=12))
    body.append(_text(salutation, after=120))
    body += [_text(p) for p in paragraphs]
    body.append(_text(closing, after=360))
    if name:
        body.append(_text(name, after=0, bold=True))
    return _package(body, title or subject, name)


def cv_docx(cv: dict, title: str = "") -> bytes:
    """A CV from the structure tailored_cv.py builds, with the sections letter_pdf.cv_pdf has (empty ones left out)."""
    name = cv.get("name", "")
    body = _header(name, [(cv.get("headline", ""), 11.5, INK), (cv.get("contact", ""), 9.5, MUTED)])
    if cv.get("summary"):
        body += [_para(_run("Profile"), style="Heading1"), _text(cv["summary"], size=10)]
    if cv.get("skills"):
        body += [_para(_run("Skills"), style="Heading1"), _text("  \xb7  ".join(cv["skills"]), size=10)]
    if cv.get("experience"):
        body.append(_para(_run("Experience"), style="Heading1"))
        for job in cv["experience"]:
            body.append(_split(job.get("title", ""), " - ".join(x for x in (job.get("start"), job.get("end")) if x)))
            place = "  \xb7  ".join(x for x in (job.get("employer"), job.get("location")) if x)
            if place:
                body.append(_text(place, after=60, size=9.5, colour=MUTED))
            body += [_bullet(item) for item in job.get("bullets", [])]
            body.append(_para("", after=60))
    if cv.get("projects"):
        body.append(_para(_run("Projects"), style="Heading1"))
        for project in cv["projects"]:
            body.append(_split(project.get("name", ""), ""))
            if project.get("description"):
                body.append(_text(project["description"], size=10))
    if cv.get("education"):
        body.append(_para(_run("Education"), style="Heading1"))
        for edu in cv["education"]:
            body.append(_split(edu.get("qualification", ""), edu.get("dates", "")))
            if edu.get("institution"):
                body.append(_text(edu["institution"], after=40, size=9.5, colour=MUTED))
            if edu.get("details"):
                body.append(_text(edu["details"], size=10))
    if cv.get("certifications"):
        body.append(_para(_run("Certifications"), style="Heading1"))
        body += [_bullet(cert) for cert in cv["certifications"]]
    return _package(body, title or f"CV - {name}", name)


def prep_docx(name: str, role: str, employer: str, prep: dict, warning: str = "", title: str = "") -> bytes:
    """An interview prep pack, laid out as letter_pdf.prep_pdf."""
    body = _header("Interview prep", [(" at ".join(x for x in (role, employer) if x), 11.5, INK), (name, 9.5, MUTED)])
    if warning:
        body.append(_text(warning, bold=True, size=10, colour=ACCENT))
    if prep.get("company"):
        body.append(_para(_run("About the employer (from the advert)"), style="Heading1"))
        body += [_bullet(item) for item in prep["company"]]
    if prep.get("questions"):
        body.append(_para(_run("Questions they may ask"), style="Heading1"))
        for n, q in enumerate(prep["questions"], 1):
            body.append(_para(_run(f"{n}. {q['question']}", bold=True, size=10.5), after=20, keep=bool(q.get("why"))))
            if q.get("why"):
                body.append(_para(_run(q["why"], size=9.5, colour=MUTED), after=100, indent=240))
    if prep.get("answers"):
        body.append(_para(_run("Answers from your CV (situation, task, action, result)"), style="Heading1"))
        for a in prep["answers"]:
            body.append(_split(a["question"], ""))
            for label in ("situation", "task", "action", "result"):
                if a.get(label):
                    body.append(_para(_run(f"{label.capitalize()}: ", bold=True, size=10) + _run(a[label], size=10),
                                      after=40, indent=240))
            body.append(_para("", after=60))
    if prep.get("ask"):
        body.append(_para(_run("Questions to ask them"), style="Heading1"))
        body += [_bullet(item) for item in prep["ask"]]
    return _package(body, title or f"Interview prep - {role}", name)

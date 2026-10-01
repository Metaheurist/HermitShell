"""A4 cover letter and CV PDFs with no third-party dependencies.

Uses the standard Helvetica fonts every PDF reader has, so the text stays real text (selectable
and readable by applicant tracking systems) and nothing needs installing on the HermitShell server.
Text is encoded as Windows-1252; characters outside it become "?".
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass, field

PAGE_W, PAGE_H = 595.28, 841.89
MARGIN_X, MARGIN_TOP, MARGIN_BOTTOM = 64.0, 60.0, 64.0
INK, MUTED, ACCENT = (0.059, 0.090, 0.165), (0.278, 0.333, 0.412), (0.310, 0.275, 0.898)

# Helvetica and Helvetica-Bold advance widths (1/1000 em) for Windows-1252 codes 32-255.
_REGULAR = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667,
    556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556,
    556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722,
    500, 500, 500, 334, 260, 334, 584, 750, 556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0,
    611, 0, 0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667, 278, 333, 556, 556, 556,
    556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 552, 400, 549, 333, 333, 333, 576, 537, 333, 333, 333, 365,
    556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722,
    722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889,
    500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 549, 611, 556, 556, 556, 556,
    500, 556, 500,
]
_BOLD = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722,
    611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556,
    611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778,
    556, 556, 500, 389, 280, 389, 584, 750, 556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0,
    611, 0, 0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667, 278, 333, 556, 556, 556,
    556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 552, 400, 549, 333, 333, 333, 576, 556, 333, 333, 333, 365,
    556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722,
    722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889,
    556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 549, 611, 611, 611, 611, 611,
    556, 611, 556,
]
FONTS = {"regular": ("F1", "Helvetica", _REGULAR), "bold": ("F2", "Helvetica-Bold", _BOLD)}


def encode(text: str) -> bytes:
    return " ".join(text.split()).encode("cp1252", errors="replace")


def text_width(text: str, size: float, font: str = "regular") -> float:
    widths = FONTS[font][2]
    return sum(widths[b - 32] if 32 <= b <= 255 else 556 for b in encode(text)) * size / 1000


def wrap(text: str, size: float, max_width: float, font: str = "regular") -> list[str]:
    lines, line = [], ""
    for word in text.split():
        candidate = f"{line} {word}" if line else word
        if line and text_width(candidate, size, font) > max_width:
            lines.append(line)
            line = word
        else:
            line = candidate
    return lines + [line] if line else lines


def _literal(text: str) -> bytes:
    return b"(" + encode(text).replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)") + b")"


@dataclass
class _Writer:
    pages: list[list[bytes]] = field(default_factory=list)
    y: float = 0.0

    def new_page(self) -> None:
        self.pages.append([])
        self.y = PAGE_H - MARGIN_TOP

    def ensure(self, height: float) -> None:
        if not self.pages or self.y - height < MARGIN_BOTTOM:
            self.new_page()

    def text(self, x: float, text: str, size: float, font: str = "regular", colour=INK) -> None:
        r, g, b = colour
        self.pages[-1].append(b"BT /%s %.1f Tf %.3f %.3f %.3f rg %.2f %.2f Td %s Tj ET" % (
            FONTS[font][0].encode(), size, r, g, b, x, self.y, _literal(text)))

    def rule(self, y: float, width: float, colour=ACCENT) -> None:
        r, g, b = colour
        self.pages[-1].append(b"%.3f %.3f %.3f RG %.2f w %.2f %.2f m %.2f %.2f l S" % (
            r, g, b, width, MARGIN_X, y, PAGE_W - MARGIN_X, y))

    def paragraph(self, text: str, size: float = 10.5, leading: float = 15.5, font: str = "regular",
                  colour=INK, after: float = 9.0, indent: float = 0.0) -> None:
        for line in wrap(text, size, PAGE_W - 2 * MARGIN_X - indent, font):
            self.ensure(leading)
            self.y -= leading
            self.text(MARGIN_X + indent, line, size, font, colour)
        self.y -= after

    def bullet(self, text: str, size: float = 10.0, leading: float = 14.0) -> None:
        lines = wrap(text, size, PAGE_W - 2 * MARGIN_X - 12)
        for i, line in enumerate(lines):
            self.ensure(leading)
            self.y -= leading
            if i == 0:
                self.text(MARGIN_X + 2, "\u2022", size, "regular", ACCENT)
            self.text(MARGIN_X + 12, line, size)
        self.y -= 2

    def split_line(self, left: str, right: str, size: float, left_font: str = "bold", leading: float = 15.0,
                   keep: float = 0.0) -> None:
        """Left-aligned text with right-aligned text (e.g. dates) on the same line, moved to the next page with
        the `keep` points of its entry that follow it when they don't fit under it."""
        self.ensure(leading + keep)
        self.y -= leading
        right_w = text_width(right, size - 1) if right else 0
        room = PAGE_W - 2 * MARGIN_X - right_w - 12
        self.text(MARGIN_X, (wrap(left, size, room, left_font) or [""])[0], size, left_font)
        if right:
            self.text(PAGE_W - MARGIN_X - right_w, right, size - 1, "regular", MUTED)

    def heading(self, text: str) -> None:
        self.ensure(60)
        self.y -= 20
        self.text(MARGIN_X, text.upper(), 9.5, "bold", ACCENT)
        self.y -= 5
        self.rule(self.y, 0.6, (0.851, 0.867, 0.910))
        self.y -= 2


def letter_pdf(name: str, contact: str, date_text: str, recipient: list[str], subject: str, salutation: str,
               paragraphs: list[str], closing: str = "Kind regards,", title: str = "") -> bytes:
    """The letter as PDF bytes: name and contact header, accent rule, date, recipient, subject, body."""
    w = _Writer()
    w.new_page()
    if name:
        w.y -= 24
        w.text(MARGIN_X, name, 24, "bold", ACCENT)
    if contact:
        w.y -= 17
        w.text(MARGIN_X, contact, 9.5, "regular", MUTED)
    w.y -= 14
    w.rule(w.y, 1.6)
    w.y -= 14
    w.paragraph(date_text, colour=MUTED, after=12)
    for line in recipient:
        w.paragraph(line, leading=14.5, after=0)
    w.y -= 14
    w.paragraph(subject, size=12, leading=17, font="bold", after=12)
    w.paragraph(salutation, after=6)
    for para in paragraphs:
        w.paragraph(para)
    w.y -= 4
    w.paragraph(closing, after=18)
    if name:
        w.paragraph(name, font="bold", after=0)
    return _assemble(w.pages, title or subject, name)


def _height(text: str, size: float, leading: float, indent: float = 0.0, most: int = 2) -> float:
    """The height of the first `most` lines of a wrapped paragraph or bullet."""
    return min(most, len(wrap(text, size, PAGE_W - 2 * MARGIN_X - indent))) * leading if text else 0.0


def cv_pdf(cv: dict, title: str = "") -> bytes:
    """A CV from the structure tailored_cv.py builds: name, headline, contact, summary, skills, experience,
    projects, education and certifications (sections without content are left out)."""
    w = _Writer()
    w.new_page()
    name = cv.get("name", "")
    if name:
        w.y -= 22
        w.text(MARGIN_X, name, 22, "bold", ACCENT)
    if cv.get("headline"):
        w.y -= 16
        w.text(MARGIN_X, cv["headline"], 11.5, "regular", INK)
    if cv.get("contact"):
        w.y -= 15
        w.text(MARGIN_X, cv["contact"], 9.5, "regular", MUTED)
    w.y -= 12
    w.rule(w.y, 1.6)
    if cv.get("summary"):
        w.heading("Profile")
        w.paragraph(cv["summary"], size=10, leading=14.5, after=2)
    if cv.get("skills"):
        w.heading("Skills")
        w.paragraph("  \xb7  ".join(cv["skills"]), size=10, leading=14.5, after=2)
    if cv.get("experience"):
        w.heading("Experience")
        for job in cv["experience"]:
            place = "  \xb7  ".join(x for x in (job.get("employer"), job.get("location")) if x)
            first = (job.get("bullets") or [""])[0]
            w.split_line(job.get("title", ""), " - ".join(x for x in (job.get("start"), job.get("end")) if x), 10.5,
                         keep=(14 if place else 0) + _height(first, 10.0, 14.0, indent=12))
            if place:
                w.paragraph(place, size=9.5, leading=13, colour=MUTED, after=1)
            for item in job.get("bullets", []):
                w.bullet(item)
            w.y -= 4
    if cv.get("projects"):
        w.heading("Projects")
        for project in cv["projects"]:
            w.split_line(project.get("name", ""), "", 10.5, keep=_height(project.get("description", ""), 10, 14))
            if project.get("description"):
                w.paragraph(project["description"], size=10, leading=14, after=4)
    if cv.get("education"):
        w.heading("Education")
        for edu in cv["education"]:
            w.split_line(edu.get("qualification", ""), edu.get("dates", ""), 10.5,
                         keep=(14 if edu.get("institution") else 0) + _height(edu.get("details", ""), 10, 14))
            if edu.get("institution"):
                w.paragraph(edu["institution"], size=9.5, leading=13, colour=MUTED, after=1)
            if edu.get("details"):
                w.paragraph(edu["details"], size=10, leading=14, after=2)
            w.y -= 3
    if cv.get("certifications"):
        w.heading("Certifications")
        for cert in cv["certifications"]:
            w.bullet(cert)
    return _assemble(w.pages, title or f"CV - {name}", name)


def _assemble(pages: list[list[bytes]], title: str, author: str) -> bytes:
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    catalog = add(b"")
    pages_id = add(b"")
    fonts = {key: add(b"<< /Type /Font /Subtype /Type1 /BaseFont /%s /Encoding /WinAnsiEncoding >>" % base.encode())
             for key, (_, base, _) in FONTS.items()}
    font_res = b" ".join(b"/%s %d 0 R" % (FONTS[k][0].encode(), i) for k, i in fonts.items())
    kids = []
    for ops in pages:
        stream = zlib.compress(b"\n".join(ops))
        content = add(b"<< /Length %d /Filter /FlateDecode >>\nstream\n%s\nendstream" % (len(stream), stream))
        kids.append(add(b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] /Resources << /Font << %s >> >> "
                        b"/Contents %d 0 R >>" % (pages_id, PAGE_W, PAGE_H, font_res, content)))
    objects[catalog - 1] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id
    objects[pages_id - 1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % k for k in kids), len(kids))
    info = add(b"<< /Title %s /Author %s >>" % (_literal(title), _literal(author)))

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (i, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % off for off in offsets)
    out += b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1, catalog, info, xref)
    return bytes(out)

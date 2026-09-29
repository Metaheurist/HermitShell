#!/usr/bin/env python3
"""Plain text from a CV file (PDF, Word .docx, text) using only the standard library.

PDF support covers what CV exports (Word, Google Docs, LaTeX, Canva) produce: compressed and
object streams, simple fonts and Type0 fonts with ToUnicode maps. Scanned CVs (images) have no
text; callers fall back to the text pasted on the sign-up form.

    python3 cv_text.py path/to/cv.pdf
"""
from __future__ import annotations

import base64
import io
import re
import sys
import zipfile
import zlib
from pathlib import Path
from xml.etree import ElementTree

MAX_OUTPUT = 60_000
MAX_INFLATE = 20 * 1024 * 1024
KINDS = ("pdf", "docx", "txt", "md")

_OBJ_RE = re.compile(rb"(\d+)\s+(\d+)\s+obj\b(.*?)\bendobj", re.S)
_STREAM_RE = re.compile(rb"^(.*?)\bstream\r?\n(.*)\bendstream", re.S)
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def clean(text: str) -> str:
    lines = [re.sub(r"[ \t\u00a0]+", " ", line).strip() for line in text.replace("\r", "\n").split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()[:MAX_OUTPUT]


def extract_text(data: bytes, kind: str) -> str:
    """Text of a CV; empty when nothing readable was found."""
    kind = kind.lower().lstrip(".")
    if kind == "pdf":
        return clean(pdf_text(data))
    if kind == "docx":
        return clean(docx_text(data))
    if kind in ("txt", "md"):
        for encoding in ("utf-8-sig", "cp1252"):
            try:
                return clean(data.decode(encoding))
            except UnicodeDecodeError:
                continue
        return clean(data.decode("latin-1"))
    raise ValueError(f"unsupported CV type: {kind}")


# --- Word ---------------------------------------------------------------------------------------

def docx_text(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = [n for n in zf.namelist() if re.fullmatch(r"word/(header\d*|document)\.xml", n)]
        names.sort(key=lambda n: (not n.startswith("word/header"), n))
        parts = []
        for name in names:
            if zf.getinfo(name).file_size > MAX_INFLATE:
                continue
            xml = zf.read(name)
            if b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:
                continue
            root = ElementTree.fromstring(xml)
            for para in root.iter(f"{_W}p"):
                bits = []
                for node in para.iter():
                    if node.tag == f"{_W}t" and node.text:
                        bits.append(node.text)
                    elif node.tag == f"{_W}tab":
                        bits.append("\t")
                    elif node.tag in (f"{_W}br", f"{_W}cr"):
                        bits.append("\n")
                parts.append("".join(bits))
        return "\n".join(parts)


# --- PDF objects --------------------------------------------------------------------------------

def _inflate(data: bytes) -> bytes:
    try:
        return zlib.decompressobj().decompress(data, MAX_INFLATE)
    except zlib.error:
        return b""


def _a85(data: bytes) -> bytes:
    data = re.sub(rb"\s", b"", data)
    data = data[2:] if data.startswith(b"<~") else data
    data = data.split(b"~>")[0]
    try:
        return base64.a85decode(data)
    except ValueError:
        return b""


def _stream_data(head: bytes, raw: bytes) -> bytes | None:
    raw = raw.rstrip(b"\r\n")
    m = re.search(rb"/Filter\s*(\[[^\]]*\]|/\w+)", head)
    for name in re.findall(rb"/(\w+)", m.group(1)) if m else []:
        if name in (b"FlateDecode", b"Fl") and b"/Predictor" not in head:
            raw = _inflate(raw)
        elif name in (b"ASCII85Decode", b"A85"):
            raw = _a85(raw)
        elif name in (b"ASCIIHexDecode", b"AHx"):
            hexed = re.sub(rb"[^0-9A-Fa-f]", b"", raw.split(b">")[0])
            raw = bytes.fromhex((hexed + b"0" * (len(hexed) % 2)).decode())
        else:
            return None
    return raw


def _objects(data: bytes) -> dict[int, tuple[bytes, bytes | None]]:
    objects: dict[int, tuple[bytes, bytes | None]] = {}
    for m in _OBJ_RE.finditer(data):
        body = m.group(3)
        sm = _STREAM_RE.match(body)
        if sm:
            head = sm.group(1)
            objects[int(m.group(1))] = (head, _stream_data(head, sm.group(2)))
        else:
            objects[int(m.group(1))] = (body, None)
    for head, stream in list(objects.values()):
        if stream and re.search(rb"/Type\s*/ObjStm\b", head):
            first = re.search(rb"/First\s+(\d+)", head)
            if not first:
                continue
            offset = int(first.group(1))
            nums = [int(n) for n in stream[:offset].split()]
            pairs = list(zip(nums[::2], nums[1::2]))
            for i, (num, start) in enumerate(pairs):
                end = pairs[i + 1][1] if i + 1 < len(pairs) else len(stream) - offset
                objects.setdefault(num, (stream[offset + start:offset + end], None))
    return objects


def _ref(text: bytes, key: bytes) -> int | None:
    m = re.search(rb"/" + key + rb"\s+(\d+)\s+\d+\s+R", text)
    return int(m.group(1)) if m else None


def _refs(text: bytes, key: bytes) -> list[int]:
    m = re.search(rb"/" + key + rb"\s*\[([^\]]*)\]", text)
    if m:
        return [int(n) for n in re.findall(rb"(\d+)\s+\d+\s+R", m.group(1))]
    one = _ref(text, key)
    return [one] if one is not None else []


def _subdict(text: bytes, key: bytes, objects) -> bytes:
    m = re.search(rb"/" + key + rb"\s*<<", text)
    if m:
        depth, i = 1, m.end()
        while i < len(text) and depth:
            if text.startswith(b"<<", i):
                depth, i = depth + 1, i + 2
            elif text.startswith(b">>", i):
                depth, i = depth - 1, i + 2
            else:
                i += 1
        return text[m.end():i - 2]
    num = _ref(text, key)
    return objects.get(num, (b"", None))[0] if num is not None else b""


def _pages(objects) -> list[int]:
    catalog = next((h for h, _ in objects.values() if re.search(rb"/Type\s*/Catalog\b", h)), b"")
    pages_root = _ref(catalog, b"Pages")
    order: list[int] = []

    def walk(num: int, depth: int = 0) -> None:
        head = objects.get(num, (b"", None))[0]
        if depth > 50 or num in order:
            return
        if re.search(rb"/Type\s*/Pages\b", head):
            for kid in _refs(head, b"Kids"):
                walk(kid, depth + 1)
        elif re.search(rb"/Type\s*/Page\b", head):
            order.append(num)

    if pages_root is not None:
        walk(pages_root)
    return order or sorted(n for n, (h, _) in objects.items() if re.search(rb"/Type\s*/Page\b", h))


# --- Fonts --------------------------------------------------------------------------------------

def _utf16(hex_text: bytes) -> str:
    raw = bytes.fromhex(hex_text.decode())
    return raw.decode("utf-16-be", errors="ignore")


def parse_cmap(data: bytes) -> tuple[dict[int, str], int]:
    """ToUnicode map as {code: text} and the code width in bytes."""
    width = 1
    for block in re.findall(rb"begincodespacerange(.*?)endcodespacerange", data, re.S):
        lo = re.search(rb"<([0-9A-Fa-f]+)>", block)
        if lo:
            width = max(1, len(lo.group(1)) // 2)
    mapping: dict[int, str] = {}
    for block in re.findall(rb"beginbfchar(.*?)endbfchar", data, re.S):
        for src, dst in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>", block):
            mapping[int(src, 16)] = _utf16(dst)
    for block in re.findall(rb"beginbfrange(.*?)endbfrange", data, re.S):
        for lo, hi, rest in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]*>)", block):
            lo_i, hi_i = int(lo, 16), min(int(hi, 16), int(lo, 16) + 65535)
            if rest.startswith(b"["):
                for i, dst in enumerate(re.findall(rb"<([0-9A-Fa-f]*)>", rest)):
                    mapping[lo_i + i] = _utf16(dst)
            else:
                base = _utf16(rest[1:-1])
                if not base:
                    continue
                for i, code in enumerate(range(lo_i, hi_i + 1)):
                    mapping[code] = base[:-1] + chr(min(ord(base[-1]) + i, 0x10FFFF))
    return mapping, width


class Font:
    def __init__(self, cmap: dict[int, str] | None = None, width: int = 1):
        self.cmap, self.width = cmap, width

    def decode(self, raw: bytes) -> str:
        if not self.cmap:
            return raw.decode("cp1252", errors="ignore") if self.width == 1 else ""
        codes = (int.from_bytes(raw[i:i + self.width], "big") for i in range(0, len(raw), self.width))
        return "".join(self.cmap.get(c, "" if self.width > 1 else chr(c)) for c in codes)


_NAMED_REF = re.compile(rb"/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R")


def _page_resources(page_head: bytes, objects) -> bytes:
    head, resources, seen = page_head, b"", 0
    while not resources and head and seen < 20:
        resources = _subdict(head, b"Resources", objects)
        parent = _ref(head, b"Parent")
        head = objects.get(parent, (b"", None))[0] if parent is not None else b""
        seen += 1
    return resources


def _fonts(resources: bytes, objects) -> dict[bytes, Font]:
    fonts: dict[bytes, Font] = {}
    for name, num in _NAMED_REF.findall(_subdict(resources, b"Font", objects)):
        font_head = objects.get(int(num), (b"", None))[0]
        two_byte = b"/Type0" in font_head
        tu = _ref(font_head, b"ToUnicode")
        stream = objects.get(tu, (b"", None))[1] if tu is not None else None
        fonts[name] = Font(*parse_cmap(stream)) if stream else Font(None, 2 if two_byte else 1)
    return fonts


# --- Content streams ----------------------------------------------------------------------------

_ESCAPES = {ord("n"): b"\n", ord("r"): b"\r", ord("t"): b"\t", ord("b"): b"\b", ord("f"): b"\f"}
_DELIMS = b"()<>[]{}/%"


def _literal(data: bytes, i: int) -> tuple[bytes, int]:
    out, depth = bytearray(), 1
    while i < len(data):
        c = data[i]
        if c == 0x5C:  # backslash
            i += 1
            if i >= len(data):
                break
            e = data[i]
            if e in _ESCAPES:
                out += _ESCAPES[e]
            elif 0x30 <= e <= 0x37:
                j = i
                while j < min(i + 3, len(data)) and 0x30 <= data[j] <= 0x37:
                    j += 1
                out.append(int(data[i:j], 8) & 0xFF)
                i = j - 1
            elif e in (0x0A, 0x0D):
                if e == 0x0D and data[i + 1:i + 2] == b"\n":
                    i += 1
            else:
                out.append(e)
        elif c == 0x28:
            depth += 1
            out.append(c)
        elif c == 0x29:
            depth -= 1
            if not depth:
                return bytes(out), i + 1
            out.append(c)
        else:
            out.append(c)
        i += 1
    return bytes(out), i


def _tokens(data: bytes):
    i, n = 0, len(data)
    while i < n:
        c = data[i]
        if c in b" \t\r\n\f\x00":
            i += 1
        elif c == 0x25:  # comment
            while i < n and data[i] not in b"\r\n":
                i += 1
        elif c == 0x28:
            raw, i = _literal(data, i + 1)
            yield "str", raw
        elif data.startswith(b"<<", i) or data.startswith(b">>", i):
            i += 2
        elif c == 0x3C:
            end = data.find(b">", i)
            end = n if end < 0 else end
            hexed = re.sub(rb"[^0-9A-Fa-f]", b"", data[i + 1:end])
            yield "str", bytes.fromhex((hexed + b"0" * (len(hexed) % 2)).decode())
            i = end + 1
        elif c in b"[]":
            yield c.to_bytes(1, "big").decode(), None
            i += 1
        elif c == 0x2F:
            j = i + 1
            while j < n and data[j] not in b" \t\r\n\f\x00" and data[j] not in _DELIMS:
                j += 1
            yield "name", data[i + 1:j]
            i = j
        else:
            j = i
            while j < n and data[j] not in b" \t\r\n\f\x00" and data[j] not in _DELIMS:
                j += 1
            word = data[i:j] or data[i:i + 1]
            i = max(j, i + 1)
            try:
                yield "num", float(word)
            except ValueError:
                if word == b"ID":  # inline image data
                    end = data.find(b"EI", i)
                    i = n if end < 0 else end + 2
                    continue
                yield "op", word


def content_text(data: bytes, fonts: dict[bytes, Font], draw=None) -> str:
    """Text shown by a content stream; draw(name) returns the text of a form XObject."""
    out: list[str] = []
    stack: list = []
    array: list | None = None
    font = Font()
    last_y: float | None = None

    def newline():
        if out and not out[-1].endswith("\n"):
            out.append("\n")

    for kind, value in _tokens(data):
        if kind == "[":
            array = []
        elif kind == "]":
            stack.append(array or [])
            array = None
        elif array is not None:
            array.append((kind, value))
        elif kind != "op":
            stack.append((kind, value))
        else:
            op = value
            if op == b"Tf" and len(stack) >= 2 and stack[-2][0] == "name":
                font = fonts.get(stack[-2][1], Font())
            elif op in (b"Tj", b"'", b'"') and stack and stack[-1][0] == "str":
                if op != b"Tj":
                    newline()
                out.append(font.decode(stack[-1][1]))
            elif op == b"TJ" and stack and isinstance(stack[-1], list):
                for k, v in stack[-1]:
                    if k == "str":
                        out.append(font.decode(v))
                    elif k == "num" and v < -200:
                        out.append(" ")
            elif op in (b"Td", b"TD") and len(stack) >= 2 and stack[-1][0] == "num":
                if abs(stack[-1][1]) > 0.5:
                    newline()
                elif out and not out[-1].endswith((" ", "\n")):
                    out.append(" ")
            elif op == b"Tm" and len(stack) >= 6 and stack[-1][0] == "num":
                y = stack[-1][1]
                if last_y is not None and abs(y - last_y) > 0.5:
                    newline()
                elif out and not out[-1].endswith((" ", "\n")):
                    out.append(" ")
                last_y = y
            elif op == b"T*":
                newline()
            elif op == b"ET":
                out.append(" ")
            elif op == b"Do" and draw and stack and stack[-1][0] == "name":
                newline()
                out.append(draw(stack[-1][1]))
                newline()
            stack = []
    return "".join(out)


def _render(content: bytes, resources: bytes, objects, depth: int = 0) -> str:
    forms = dict(_NAMED_REF.findall(_subdict(resources, b"XObject", objects)))

    def draw(name: bytes) -> str:
        num = forms.get(name)
        head, stream = objects.get(int(num), (b"", None)) if num else (b"", None)
        if depth >= 6 or not stream or not re.search(rb"/Subtype\s*/Form\b", head):
            return ""
        return _render(stream, _subdict(head, b"Resources", objects) or resources, objects, depth + 1)

    if b"BT" not in content:
        return "\n".join(filter(None, (draw(n) for n in re.findall(rb"/([^\s/<>\[\]()]+)\s+Do\b", content))))
    return content_text(content, _fonts(resources, objects), draw)


def pdf_text(data: bytes) -> str:
    if b"/Encrypt" in data:
        return ""
    objects = _objects(data)
    pages = []
    for num in _pages(objects):
        head = objects[num][0]
        content = b"\n".join(objects.get(c, (b"", None))[1] or b"" for c in _refs(head, b"Contents"))
        pages.append(_render(content, _page_resources(head, objects), objects))
    return "\n\n".join(pages)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip().splitlines()[-1].strip())
        return 2
    path = Path(sys.argv[1])
    print(extract_text(path.read_bytes(), path.suffix))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Rasterise the Lucide SVGs in icons/src into the job card button icons (icons/btn-<action>.png).

Gmail strips inline <svg> and SVG images, so the emails carry PNGs rendered at 3x as CID attachments.
Needs PyMuPDF (pip install pymupdf); run locally after changing a button colour or icon in
job_weekly.CARD_BUTTONS:
    python icons/build_icons.py
Sources: Lucide (ISC).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pymupdf as fitz

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE.parents[2] / "common")]
from job_weekly import CARD_BUTTONS  # noqa: E402

SCALE = 3


def inner(name: str) -> str:
    svg = (HERE / "src" / f"{name}.svg").read_text(encoding="utf-8")
    svg = re.sub(r"<!--.*?-->|<title>.*?</title>", "", svg, flags=re.S)
    return re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)


def main() -> None:
    for action, (_, icon, colour, *_rest) in CARD_BUTTONS.items():
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
               f'<g fill="none" stroke="{colour}" stroke-width="2.25" stroke-linecap="round" '
               f'stroke-linejoin="round">{inner(icon)}</g></svg>')
        page = fitz.open(stream=svg.encode(), filetype="svg")[0]
        page.get_pixmap(matrix=fitz.Matrix(SCALE, SCALE), alpha=True).save(HERE / f"btn-{action}.png")
        print("wrote", f"btn-{action}.png")


if __name__ == "__main__":
    main()

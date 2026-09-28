#!/usr/bin/env python3
"""Rasterise the SVG sources in icons/src into the PNGs the digest emails embed.

Gmail strips inline <svg> and SVG images, so the emails carry PNGs rendered at 3x as CID attachments.
Needs PyMuPDF (pip install pymupdf); run locally after changing an icon or a section colour:
    python icons/build_icons.py                          # every topic in the catalog
    python icons/build_icons.py my_sections.json         # custom sections file
Each section's "icon" must name an SVG in icons/src (Lucide stroke icons work as-is).
Sources: Lucide (ISC) and Simple Icons (CC0, the Python logo).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pymupdf as fitz

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE.parents[2] / "common")]
from news_digest import SECTIONS, TOPICS, load_sections  # noqa: E402

SCALE = 3
FILLED = {"python"}  # Simple Icons are filled shapes; Lucide icons are 2px strokes


def inner(name: str) -> str:
    svg = (HERE / "src" / f"{name}.svg").read_text(encoding="utf-8")
    svg = re.sub(r"<!--.*?-->|<title>.*?</title>", "", svg, flags=re.S)
    return re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)


def glyph(name: str, colour: str, fill_shape: bool = False) -> str:
    if name in FILLED or fill_shape:
        return f'<g fill="{colour}" stroke="{colour}" stroke-width="{2 if fill_shape else 0}" stroke-linejoin="round">{inner(name)}</g>'
    return (f'<g fill="none" stroke="{colour}" stroke-width="2" stroke-linecap="round" '
            f'stroke-linejoin="round">{inner(name)}</g>')


def render(svg_body: str, box: int, out: str) -> None:
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{box}" height="{box}" '
           f'viewBox="0 0 {box} {box}">{svg_body}</svg>')
    page = fitz.open(stream=svg.encode(), filetype="svg")[0]
    page.get_pixmap(matrix=fitz.Matrix(SCALE, SCALE), alpha=True).save(HERE / out)
    print("wrote", out)


def main() -> None:
    sections = TOPICS
    if len(sys.argv) > 1:
        load_sections(sys.argv[1])
        sections = SECTIONS
    # Generic set used by custom topics and any section without its own icons.
    sections = [*sections, {"id": "custom", "icon": "newspaper", "colour": "#475569"}]
    for sec in sections:
        # 32px rounded badge in the section colour with a white 18px glyph, for the section headers.
        render(f'<rect width="32" height="32" rx="9" fill="{sec["colour"]}"/>'
               f'<g transform="translate(7 7) scale(0.75)">{glyph(sec["icon"], "#ffffff")}</g>',
               32, f'badge-{sec["id"]}.png')
        # 24px glyphs in the section colour, shown at ~14px in the top-story label.
        render(glyph(sec["icon"], sec["colour"]), 24, f'glyph-{sec["id"]}.png')
        render(glyph("star", sec["colour"], fill_shape=True), 24, f'star-{sec["id"]}.png')
    render(glyph("sun", "#fcd34d"), 24, "sun.png")


if __name__ == "__main__":
    main()

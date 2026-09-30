"""Checks on what the models write, with no model: figures and job titles the CV doesn't have, stock phrases,
placeholders, length, and which of a job's requirements the text covers.

cover_letter.py and tailored_cv.py refuse or rewrite what fails them (a rewrite is told exactly what failed), and
scripts/llm_bench.py scores models with them, so a smaller model or a shorter prompt can be tried against the same bar.
"""
from __future__ import annotations

import re

PLACEHOLDER_RE = re.compile(r"\[[^\]]{2,40}\]|\{[^}]{2,40}\}|<[^>]{2,40}>|\b(?:Lorem|XXX|TBC)\b")
NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)*")
ROLE_RE = re.compile(r"\b[Aa]s (?:(?:an?|the|my) )?(?:(?:former|current) )?"
                     r"([A-Z][\w/&+-]*(?: (?:[A-Z][\w/&+-]*|of|and|&))*) at [A-Z]")
# Phrases that make a letter read as a template; the letter prompt asks for none of them.
CLICHES = (
    "i am excited", "i'm excited", "i am thrilled", "passionate", "dream job", "perfect fit", "ideal candidate",
    "i am writing to apply", "i am writing to express", "hit the ground running", "think outside the box",
    "go-getter", "self-starter", "results-driven", "proven track record", "wealth of experience", "team player",
    "fast-paced environment", "strong work ethic", "synergy", "leverage my", "i believe i would be a great",
    "look no further", "second to none", "unique opportunity",
)
STOPWORDS = set("a an and the of for to in on with or at by from as is are be using use experience knowledge "
                "strong good excellent skills skill ability working work understanding proven".split())
_WORD = re.compile(r"[a-z0-9][a-z0-9+#.]*")


def numbers(text: str) -> set[str]:
    return {n.replace(",", "") for n in NUMBER_RE.findall(text or "")}


def invented_figures(text: str, source: str) -> list[str]:
    """Figures in the text that the source (the CV, and for a letter the job's own details) never uses."""
    return sorted(numbers(text) - numbers(source), key=lambda n: (len(n), n))


def honest(text: str, source: str) -> bool:
    """No placeholders, and every figure in the text also appears in the source."""
    return not PLACEHOLDER_RE.search(text or "") and not invented_figures(text, source)


def invented_titles(paragraphs: list[str], profile: str) -> list[str]:
    """Job titles the text claims ("as an X at Y") that the CV never uses."""
    cv = " ".join(profile.lower().split())
    titles = dict.fromkeys(m.group(1) for p in paragraphs for m in ROLE_RE.finditer(p))
    return [title for title in titles if title.lower() not in cv]


def placeholders(text: str) -> list[str]:
    return list(dict.fromkeys(PLACEHOLDER_RE.findall(text or "")))


def cliches(text: str) -> list[str]:
    low = " ".join((text or "").lower().replace("\u2019", "'").split())
    return [c for c in CLICHES if re.search(rf"(?<![a-z]){re.escape(c)}(?![a-z])", low)]


def word_count(texts: list[str]) -> int:
    return sum(len(t.split()) for t in texts)


def _words(text: str) -> set[str]:
    return {w.rstrip(".") for w in _WORD.findall((text or "").lower())}


def covers(requirement: str, text: str) -> bool:
    """The requirement is named in the text: the whole term, or (for a longer phrase) most of its key words."""
    req = " ".join(requirement.lower().split())
    if not req:
        return False
    if re.search(("(?<![\\w+#])" if req[0].isalnum() else "") + re.escape(req) + "(?![\\w+#])", (text or "").lower()):
        return True
    keys = [w for w in _words(req) if w not in STOPWORDS and len(w) > 1]
    if len(keys) < 2:
        return False
    found = _words(text)
    return sum(w in found for w in keys) * 3 >= len(keys) * 2


def coverage(requirements: list[str], text: str) -> tuple[list[str], list[str]]:
    """(covered, missing) of the requirements, each in the order given."""
    reqs = list({r.lower(): r for r in reversed([" ".join(str(r).split()) for r in requirements]) if r}.values())[::-1]
    got = [r for r in reqs if covers(r, text)]
    return got, [r for r in reqs if r not in got]


def letter_problems(paragraphs: list[str], cv: str, source: str = "", requirements: list[str] = (),
                    words: tuple[int, int] = (150, 450), paragraph_range: tuple[int, int] = (3, 5)) -> list[str]:
    """What is wrong with a letter, each as an instruction a rewrite can follow; [] when it passes. `source` is
    what else it may take figures from (the job's details and listing)."""
    text = "\n".join(paragraphs)
    count = word_count(paragraphs)
    problems = []
    if not paragraph_range[0] <= len(paragraphs) <= paragraph_range[1]:
        problems.append(f"write {paragraph_range[0]} to {paragraph_range[1]} paragraphs (it has {len(paragraphs)})")
    if count < words[0]:
        problems.append(f"it is too short at {count} words: write at least {words[0]}")
    elif count > words[1]:
        problems.append(f"it is too long at {count} words: keep it under {words[1]}")
    if found := placeholders(text):
        problems.append(f"remove the placeholders {', '.join(found[:4])}")
    if found := invented_titles(paragraphs, cv):
        problems.append(f"use job titles exactly as the CV writes them, not {', '.join(found[:3])}")
    if found := invented_figures(text, f"{cv}\n{source}"):
        problems.append(f"remove figures the CV does not state: {', '.join(found[:5])}")
    if found := cliches(text):
        problems.append(f"replace the stock phrases {', '.join(repr(c) for c in found[:4])} with specifics")
    _, missing = coverage(list(requirements), text)
    if requirements and len(missing) * 2 > len(requirements):
        problems.append(f"address more of the job's main requirements, such as {', '.join(missing[:3])}")
    return problems


def letter_score(paragraphs: list[str], cv: str, source: str = "", requirements: list[str] = ()) -> dict:
    """The numbers scripts/llm_bench.py compares models on."""
    text = "\n".join(paragraphs)
    got, missing = coverage(list(requirements), text)
    return {"words": word_count(paragraphs), "paragraphs": len(paragraphs),
            "invented_figures": invented_figures(text, f"{cv}\n{source}"), "invented_titles": invented_titles(paragraphs, cv),
            "cliches": cliches(text), "placeholders": placeholders(text), "covered": got, "missing": missing,
            "coverage": round(len(got) / len(got + missing), 2) if got or missing else None,
            "problems": letter_problems(paragraphs, cv, source, requirements)}

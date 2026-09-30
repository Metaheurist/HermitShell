"""Tailored CVs for Daily Vacancy Report jobs, and skills from the email worked into the CV.

The "Tailored CV" button queues a request the same way as "Cover letter"; cover_letter.py (the 5-minute cron
job) picks both up. The CV text (COVER_LETTER_CV_FILE, else the profile) is turned into a structured copy once
(state/cv.json, rebuilt when the CV changes; a long CV is read in sections). For each job the model only chooses
and rephrases, led by the job's evidence map (evidence.py, shared with the cover letter): job titles, employers,
dates and education always come from that copy, and any figure the CV does not contain is refused, so the
tailored CV cannot claim anything the real one does not. Bullets are ordered by what the job asks for and cut to
about two pages, and the email says which of the job's requirements the CV covers and what it doesn't show.

Skills added from an email's missing-skill tags are worked into the profile by the model (the previous version
is kept as a .bak copy) and join the skills section of every tailored CV.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import evidence
import hermes_common as hc
import profiles
from hermes_common import STATE_DIR, env, fit_ctx, log, ollama_chat
from job_settings import term_regex
from job_tracker import Tracker
from writing_checks import coverage, covers, honest
from writing_checks import numbers as _numbers

PACKAGE_DIR = Path(__file__).resolve().parent
MASTER_FILE = STATE_DIR / "cv.json"
MERGED_FILE = STATE_DIR / "cv_skills_merged.json"
# One model request reads up to MAX_SOURCE_CHARS of the CV; a longer one is read in sections, up to MAX_CV_CHARS.
MAX_SOURCE_CHARS = 14_000
MAX_CV_CHARS = 42_000
MAX_PARTS = 4
MAX_SKILLS = 16
LISTING_WITH_MAP = 2500
# About two A4 pages: bullets for each role, newest first, then OLDER_BULLETS, and MAX_BULLET_WORDS in all.
ROLE_BULLETS = (6, 5, 4, 3)
OLDER_BULLETS = 2
MAX_BULLET_WORDS = 650

_STR = {"type": "string"}
MASTER_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": _STR, "summary": _STR,
        "skills": {"type": "array", "items": _STR, "maxItems": 40},
        "experience": {"type": "array", "maxItems": 12, "items": {"type": "object", "properties": {
            "title": _STR, "employer": _STR, "location": _STR, "start": _STR, "end": _STR,
            "bullets": {"type": "array", "items": _STR, "maxItems": 8}},
            "required": ["title", "employer", "start", "end", "bullets"]}},
        "projects": {"type": "array", "maxItems": 6, "items": {"type": "object", "properties": {
            "name": _STR, "description": _STR}, "required": ["name", "description"]}},
        "education": {"type": "array", "maxItems": 6, "items": {"type": "object", "properties": {
            "qualification": _STR, "institution": _STR, "dates": _STR, "details": _STR},
            "required": ["qualification", "institution"]}},
        "certifications": {"type": "array", "items": _STR, "maxItems": 12},
    },
    "required": ["headline", "summary", "skills", "experience", "projects", "education", "certifications"],
}
MASTER_SYSTEM = ("You copy a CV into JSON. Copy facts exactly as written: job titles, employers, dates, "
                 "qualifications and figures. Never add anything that is not in the CV. UK English.")
TAILOR_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": _STR, "summary": _STR,
        "skills": {"type": "array", "items": _STR, "maxItems": MAX_SKILLS},
        "experience": {"type": "array", "items": {"type": "object", "properties": {
            "index": {"type": "integer"}, "bullets": {"type": "array", "items": _STR, "maxItems": 6}},
            "required": ["index", "bullets"]}},
        "projects": {"type": "array", "items": {"type": "integer"}},
    },
    "required": ["headline", "summary", "skills", "experience", "projects"],
}
TAILOR_SYSTEM = (
    "You tailor a CV to one job advert in UK English. You may only reorder, select and rephrase what the CV "
    "says. Never invent employers, job titles, dates, qualifications, figures, tools or achievements, and never "
    "claim a skill the CV does not list. Output JSON only.")


def _clean(text) -> str:
    return " ".join(str(text or "").split())


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


# --------------------------------------------------------------------------- the structured master copy

def cv_source() -> tuple[str, Path | None]:
    for name in (env("COVER_LETTER_CV_FILE"), env("JOB_PROFILE_FILE") or "job_profile.md"):
        path = Path(name) if name and Path(name).is_absolute() else PACKAGE_DIR / (name or "")
        if name and path.is_file():
            return hc.read_private_text(path, errors="replace")[:MAX_CV_CHARS], path
    return "", None


def clean_master(data: dict, source: str) -> dict:
    """Keep only entries whose title and employer (or qualification) the CV really contains."""
    src = _norm(source)

    def found(text: str) -> bool:
        return bool(_norm(text)) and _norm(text) in src

    def lines(items, limit: int) -> list[str]:
        items = items if isinstance(items, list) else []
        return [x for x in dict.fromkeys(_clean(i)[:300] for i in items) if x and honest(x, source)][:limit]

    experience = []
    for job in data.get("experience") if isinstance(data.get("experience"), list) else []:
        job = job if isinstance(job, dict) else {}
        title, employer = _clean(job.get("title"))[:80], _clean(job.get("employer"))[:80]
        if not (found(title) and found(employer)):
            continue
        dates = {k: _clean(job.get(k))[:30] for k in ("start", "end")}
        dates = {k: v if _numbers(v) <= _numbers(source) else "" for k, v in dates.items()}
        experience.append({"title": title, "employer": employer, "location": _clean(job.get("location"))[:60],
                           **dates, "bullets": lines(job.get("bullets"), 8)})
    education = []
    for edu in data.get("education") if isinstance(data.get("education"), list) else []:
        edu = edu if isinstance(edu, dict) else {}
        qualification = _clean(edu.get("qualification"))[:120]
        if found(qualification):
            education.append({"qualification": qualification, "institution": _clean(edu.get("institution"))[:100],
                              "dates": _clean(edu.get("dates"))[:30] if honest(_clean(edu.get("dates")), source) else "",
                              "details": _clean(edu.get("details"))[:200] if honest(_clean(edu.get("details")), source)
                              else ""})
    projects = [{"name": _clean(p.get("name"))[:80], "description": _clean(p.get("description"))[:300]}
                for p in data.get("projects") or [] if isinstance(p, dict) and found(_clean(p.get("name")))
                and honest(_clean(p.get("description")), source)][:6]
    if not experience and not education:
        raise RuntimeError("could not read any roles or education from the CV")
    summary = _clean(data.get("summary"))[:900]
    return {
        "headline": _clean(data.get("headline"))[:100] if honest(_clean(data.get("headline")), source) else "",
        "summary": summary if honest(summary, source) else "",
        "skills": [s for s in lines(data.get("skills"), 40) if len(s) <= 50],
        "experience": experience, "projects": projects, "education": education,
        "certifications": [c for c in lines(data.get("certifications"), 12) if found(c)],
    }


def sections(source: str, limit: int | None = None) -> list[str]:
    """The CV in parts of at most `limit` (MAX_SOURCE_CHARS) characters, split between paragraphs."""
    limit = limit or MAX_SOURCE_CHARS
    if len(source) <= limit:
        return [source]
    parts, current, size = [], [], 0
    for block in re.split(r"\n\s*\n", source):
        block = block[:limit]
        if current and size + len(block) + 2 > limit:
            parts.append("\n\n".join(current))
            current, size = [], 0
        current.append(block)
        size += len(block) + 2
    return parts + (["\n\n".join(current)] if current else [])


def merge_parts(first: dict, more: dict) -> dict:
    """Two sections' copies as one: the first headline and summary, lists joined, a role split across sections
    kept once with all its bullets."""
    merged = {k: first.get(k) or more.get(k) or "" for k in ("headline", "summary")}
    for key in ("skills", "projects", "education", "certifications"):
        merged[key] = [*(first.get(key) or []), *(more.get(key) or [])]
    roles: dict = {}
    for job in [*(first.get("experience") or []), *(more.get("experience") or [])]:
        if not isinstance(job, dict):
            continue
        key = (_norm(str(job.get("title", ""))), _norm(str(job.get("employer", ""))))
        if key in roles:
            roles[key]["bullets"] = [*(roles[key].get("bullets") or []), *(job.get("bullets") or [])]
        else:
            roles[key] = dict(job)
    merged["experience"] = list(roles.values())
    return merged


def build_master(source: str, model_info) -> dict:
    host, model, num_ctx = model_info
    parts, merged = sections(source)[:MAX_PARTS], {}
    for n, part in enumerate(parts, 1):
        which = f" (part {n} of {len(parts)}; copy only what this part contains)" if len(parts) > 1 else ""
        prompt = (f"CV{which}:\n{part}\n\nCopy this CV into the JSON fields. Bullets are the CV's own achievement and "
                  "responsibility lines for each role, most important first.")
        raw = ollama_chat(host, model, MASTER_SYSTEM, prompt, fit_ctx(num_ctx, MASTER_SYSTEM, prompt, num_predict=3000),
                          fmt=MASTER_SCHEMA, num_predict=3000, task="cv_read")
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise RuntimeError(f"the model did not return valid JSON ({exc})") from exc
        merged = merge_parts(merged, data if isinstance(data, dict) else {})
    return clean_master(merged, source)


def master_cv(model_info_factory, tracker: Tracker | None = None) -> dict:
    """The structured CV, rebuilt when the CV file changes, with the skills added from the email."""
    source, path = cv_source()
    if not source:
        raise FileNotFoundError("no CV found (upload one on the dashboard, or set COVER_LETTER_CV_FILE)")
    stamp = [str(path), path.stat().st_mtime, path.stat().st_size]
    cached = profiles.read_json(MASTER_FILE, {})
    if cached.get("source") == stamp and cached.get("cv"):
        master = cached["cv"]
    else:
        master = build_master(source, model_info_factory())
        profiles.write_json(MASTER_FILE, {"source": stamp, "cv": master}, private=True)
        log(f"Read the CV into {MASTER_FILE.name} ({len(master['experience'])} roles)")
    added = tracker.skills() if tracker else []
    master = {**master, "skills": list(dict.fromkeys([*master["skills"], *added]))}
    master["source_text"] = source
    return master


# --------------------------------------------------------------------------- tailoring for one job

def tailor_prompt(master: dict, job: dict, listing: str, note: str, found: list[dict] | None = None) -> str:
    listing = listing[:LISTING_WITH_MAP] if found else listing
    roles = "\n".join(f"[{i}] {j['title']} at {j['employer']} ({j['start']} - {j['end']})\n"
                      + "\n".join(f"  - {b}" for b in j["bullets"]) for i, j in enumerate(master["experience"]))
    projects = "\n".join(f"[{i}] {p['name']}: {p['description']}" for i, p in enumerate(master["projects"]))
    return (
        f"CV SUMMARY:\n{master['summary']}\n\nCV SKILLS: {', '.join(master['skills'])}\n\nROLES:\n{roles}\n\n"
        + (f"PROJECTS:\n{projects}\n\n" if projects else "")
        + f"JOB: {job.get('title', '')} at {job.get('employer') or job.get('company') or ''}\n"
        + (f"WHAT THE JOB ASKS FOR AND WHERE THE CV SHOWS IT:\n{evidence.as_text(found)}\n\n" if found else "")
        + f"LISTING:\n{listing or '(not available: use the job title)'}\n\n"
        + (f"CANDIDATE'S NOTE (follow it if it fits the CV):\n{note}\n\n" if note else "")
        + "Tailor the CV to this job:\n"
          "- headline: the candidate's own current or most relevant job title from ROLES, optionally with one "
          "or two of their strongest skills for this job.\n"
          "- summary: 3 or 4 sentences in the first person without 'I' (CV style), built from CV SUMMARY and "
          "ROLES, leading with what this job asks for.\n"
          f"- skills: up to {MAX_SKILLS} skills copied from CV SKILLS, most relevant to the listing first.\n"
          "- experience: for each role index, 2 to 6 bullets rephrased from that role's own bullets, most "
          "relevant to the job's requirements first. Start each with an action verb (past tense, or present for "
          "a current role), keep the CV's facts, and keep every figure exactly as the CV states it; add none.\n"
          "- projects: the indexes of the projects worth showing for this job (may be empty).\n"
          "No placeholders, no em dashes, no cliches."
    )


def order_bullets(bullets: list[str], needs: list[str]) -> list[str]:
    """The bullets naming more of the job's requirements first, otherwise in the CV's order."""
    return sorted(bullets, key=lambda b: -sum(covers(n, b) for n in needs))


def fit_pages(experience: list[dict]) -> list[dict]:
    """Cut the bullets to about two pages: ROLE_BULLETS for the newest roles, fewer for older ones, and
    MAX_BULLET_WORDS in all, always keeping each role's first bullet."""
    out, words = [], 0
    for i, role in enumerate(experience):
        cap = ROLE_BULLETS[i] if i < len(ROLE_BULLETS) else OLDER_BULLETS
        kept: list[str] = []
        for bullet in role["bullets"][:cap]:
            if kept and words + len(bullet.split()) > MAX_BULLET_WORDS:
                break
            kept.append(bullet)
            words += len(bullet.split())
        out.append({**role, "bullets": kept})
    return out


def cv_text(cv: dict) -> str:
    """Everything the tailored CV says, as plain text for the checks."""
    parts = [cv.get("headline", ""), cv.get("summary", ""), ", ".join(cv.get("skills", []))]
    parts += [b for role in cv.get("experience", []) for b in role.get("bullets", [])]
    parts += [p.get("description", "") for p in cv.get("projects", [])]
    return "\n".join(p for p in parts if p)


def match_report(cv: dict, found: list[dict]) -> dict:
    """Which of the requirements the CV shows the tailored CV names, which it leaves out, and what the advert
    asks for that the CV doesn't show at all."""
    covered, missing = coverage(evidence.shown(found), cv_text(cv))
    return {"covered": covered, "missing": missing, "gaps": [i["need"] for i in found if not i["evidence"]]}


def report_lines(report: dict | None) -> list[str]:
    """The match report as lines for the email."""
    if not report:
        return []
    lines = []
    if shown := report["covered"] + report["missing"]:
        lines.append(f"Covers {len(report['covered'])} of the {len(shown)} requirements your CV shows"
                     + (f": {', '.join(report['covered'])}" if report["covered"] else "")
                     + (f" (left out: {', '.join(report['missing'])})" if report["missing"] else ""))
    if report["gaps"]:
        lines.append(f"The advert also asks for, not shown in your CV: {', '.join(report['gaps'])}")
    return lines


def tailor(master: dict, tailored: dict, job: dict, needs: list[str] = ()) -> dict:
    """Assemble the final CV from the model's choices; anything unsupported falls back to the CV's own text."""
    source = master["source_text"]
    known = {s.lower(): s for s in master["skills"]}
    skills = [known[s.lower()] for s in (_clean(x) for x in tailored.get("skills") or []) if s.lower() in known]
    skills = list(dict.fromkeys(skills + master["skills"]))[:MAX_SKILLS] if len(skills) < 5 else \
        list(dict.fromkeys(skills))[:MAX_SKILLS]
    picked = {}
    for entry in tailored.get("experience") or []:
        if isinstance(entry, dict) and isinstance(entry.get("index"), int):
            bullets = [b for b in (_clean(x)[:300] for x in entry.get("bullets") or []) if b and honest(b, source)]
            if bullets:
                picked[entry["index"]] = bullets[:6]
    experience = fit_pages([{**j, "bullets": picked.get(i) or order_bullets(j["bullets"], list(needs))}
                            for i, j in enumerate(master["experience"])])
    projects = [master["projects"][i] for i in dict.fromkeys(tailored.get("projects") or [])
                if isinstance(i, int) and 0 <= i < len(master["projects"])]
    summary = _clean(tailored.get("summary"))[:900]
    headline = _clean(tailored.get("headline"))[:100]
    return {
        "name": master.get("name", ""), "contact": master.get("contact", ""),
        "headline": headline if headline and honest(headline, source) else master["headline"],
        "summary": summary if len(summary) > 60 and honest(summary, source) else master["summary"],
        "skills": skills, "experience": experience, "projects": projects,
        "education": master["education"], "certifications": master["certifications"],
        "job": {"title": job.get("title", ""), "employer": job.get("employer") or job.get("company") or ""},
    }


def tailored_cv(master: dict, job: dict, listing: str, note: str, model_info, found: list[dict] | None = None) -> dict:
    host, model, num_ctx = model_info
    prompt = tailor_prompt(master, job, listing, note, found)
    raw = ollama_chat(host, model, TAILOR_SYSTEM, prompt, fit_ctx(num_ctx, TAILOR_SYSTEM, prompt, num_predict=2200),
                      fmt=TAILOR_SCHEMA, num_predict=2200, task="cv_tailor")
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise ValueError(f"the model did not return valid JSON ({exc})") from exc
    cv = tailor(master, data if isinstance(data, dict) else {}, job, evidence.shown(found or []))
    return {**cv, "match": match_report(cv, found)} if found else cv


# --------------------------------------------------------------------------- skills from the email, into the CV

MERGE_SYSTEM = ("You edit the skills section of a candidate profile written in Markdown. You add the skills you are "
                "given and change nothing else. Output the whole section, heading included, and nothing else.")


def _has(text: str, skill: str) -> bool:
    return bool(re.search(term_regex([skill]), text, re.I))


def merged_ok(before: str, after: str, skills: list[str]) -> bool:
    """Every new skill is in, the headings and nearly all original lines survive, and it did not balloon."""
    old_lines = [line.strip() for line in before.splitlines() if line.strip()]
    kept = sum(line in after for line in old_lines)
    headings = [line for line in old_lines if line.startswith("#")]
    return (all(_has(after, s) for s in skills) and all(h in after for h in headings)
            and kept >= 0.9 * len(old_lines) and len(after) <= len(before) + 80 * len(skills) + 400)


def skills_span(lines: list[str]) -> tuple[int, int] | None:
    """Line range of the profile's skills section (heading to the last non-blank line before the next heading)."""
    for i, line in enumerate(lines):
        if re.match(r"#+\s.*skills", line, re.I):
            end = next((j for j in range(i + 1, len(lines)) if lines[j].startswith("#")), len(lines))
            while end > i + 1 and not lines[end - 1].strip():
                end -= 1
            return i, end
    return None


def append_skills(text: str, skills: list[str]) -> str:
    lines = text.rstrip("\n").splitlines()
    span = skills_span(lines)
    if span:
        return "\n".join(lines[:span[1]] + [f"- {s}" for s in skills] + lines[span[1]:]) + "\n"
    return "\n".join(lines + ["", "## Additional skills", "", *[f"- {s}" for s in skills]]) + "\n"


def merge_with_model(text: str, skills: list[str], model_info) -> str:
    """The profile with the model's edit of only its skills section spliced in; "" when that fails any check."""
    lines = text.rstrip("\n").splitlines()
    span = skills_span(lines)
    if not span:
        return ""
    section = "\n".join(lines[span[0]:span[1]])
    host, model, num_ctx = model_info
    prompt = (f"SKILLS SECTION:\n{section}\n\nSKILLS TO ADD: {', '.join(skills)}\n\nAdd each skill next to related "
              "skills, in the same style as the other entries.")
    budget = len(section) // 2 + 60 * len(skills) + 200
    edited = ollama_chat(host, model, MERGE_SYSTEM, prompt, fit_ctx(num_ctx, prompt, num_predict=budget),
                         num_predict=budget, task="skills").strip()
    edited = re.sub(r"^```(?:markdown|md)?\n|\n```$", "", edited).strip("\n")
    if not edited or edited.splitlines()[0].strip() != lines[span[0]].strip() or not merged_ok(section, edited, skills):
        return ""
    return "\n".join(lines[:span[0]] + edited.splitlines() + lines[span[1]:]) + "\n"


def merge_new_skills(tracker: Tracker, profile_file: Path, model_info) -> list[str]:
    """Work skills added from the email since the last run into the profile; returns the skills added."""
    done = {s.lower() for s in profiles.read_json(MERGED_FILE, [])}
    new = [s for s in tracker.skills() if s.lower() not in done]
    if not new or not profile_file.is_file():
        return []
    before = hc.read_private_text(profile_file)
    todo = [s for s in new if not _has(before, s)]
    if todo:
        after = ""
        try:
            after = merge_with_model(before, todo, model_info)
        except Exception as exc:  # a model hiccup falls back to a plain append
            log(f"Model could not merge the skills: {exc.__class__.__name__}")
        if not after or not merged_ok(before, after, todo):
            after = append_skills(before, todo)
        profiles.backup(profile_file)
        hc.rewrite_text(profile_file, after.rstrip("\n") + "\n")
        log(f"Added to {profile_file.name}: {', '.join(todo)}")
    profiles.write_json(MERGED_FILE, sorted(done | {s.lower() for s in new}), private=True)
    return todo

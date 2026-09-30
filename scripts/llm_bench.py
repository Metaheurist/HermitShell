#!/usr/bin/env python3
"""Score the configured AI models on HermitShell's own tasks, with made-up CVs and adverts (scripts/bench/cases.json).

Each case rates one CV against one advert with the real prompts and checks the fit lands in the expected range; the
good matches also get a cover letter (with its evidence map and rewrites, as in production) and a tailored CV, checked with writing_checks.py (figures and job titles the CV
doesn't have, stock phrases, length, and how many of the advert's requirements they cover). The tokens each task
used are counted in a throwaway llm_usage file, so a change to a prompt or a model can be judged on both quality and
tokens before it goes live. Nothing is emailed or saved, and the real usage counts are left alone.

    python3 scripts/llm_bench.py                     every case, every task
    python3 scripts/llm_bench.py --tasks rating      only the ratings
    python3 scripts/llm_bench.py --json out.json     also write the full results
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
for folder in (HERE.parent / "common", HERE.parent / "packages" / "daily-vacancy-report", HERE):
    if folder.is_dir():
        sys.path.insert(0, str(folder))

import cover_letter  # noqa: E402
import evidence  # noqa: E402
import hermes_common as hc  # noqa: E402
import job_scanner  # noqa: E402
import llm_usage  # noqa: E402
import tailored_cv  # noqa: E402
import writing_checks  # noqa: E402

CASES_FILE = HERE / "bench" / "cases.json"
TASKS = ("rating", "letter", "cv")
GOOD_FIT = 7


def load_cases(path: Path = CASES_FILE) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    for case in data["cases"]:
        if case["cv"] not in data["cvs"] or case["listing"] not in data["listings"]:
            raise ValueError(f"case {case} names a CV or advert that isn't in {path.name}")
    return data


def job_for(listing: dict, rating: dict | None = None) -> dict:
    rating = rating or {}
    return {"title": listing["title"], "employer": listing["employer"], "company": listing["employer"],
            "location": listing["location"], "url": listing["url"], "source": listing.get("source", "bench"),
            "text": listing["text"], "listing": listing["text"], "facts": {}, "matched": rating.get("matched_skills", []),
            "gaps": rating.get("missing_skills", []), "reasoning": rating.get("reasoning", "")}


def run_case(case: dict, data: dict, tasks: tuple[str, ...], model_info, masters: dict,
             evidence_dir: Path | None = None) -> dict:
    cv, listing = data["cvs"][case["cv"]], data["listings"][case["listing"]]
    host, model, num_ctx = model_info
    out = {"cv": case["cv"], "listing": case["listing"], "expected_fit": case["fit"]}
    rating = None
    if "rating" in tasks:
        started = time.monotonic()
        rating = job_scanner.rate_job(host, model, num_ctx, cv["text"], cv["keywords"], job_for(listing))
        fit = rating["fit_score"] if rating else None
        out["rating"] = {"fit": fit, "in_range": fit is not None and case["fit"][0] <= fit <= case["fit"][1],
                         "stray_skills": [s for s in (rating or {}).get("matched_skills", []) if s not in cv["keywords"]],
                         "seconds": round(time.monotonic() - started, 1)}
    if case["fit"][0] < GOOD_FIT:
        return out
    job = job_for(listing, rating)
    if "letter" in tasks:
        started = time.monotonic()
        found = evidence.for_job(model_info, f"{case['cv']}/{case['listing']}", job, cv["text"], listing["text"],
                                 evidence_dir) if evidence_dir else []
        try:
            paragraphs = cover_letter.write_letter(host, model, num_ctx, job, cv["text"], listing["text"], found=found)
        except ValueError as exc:
            out["letter"] = {"error": str(exc)}
        else:
            source = f"{listing['title']} {listing['employer']} {listing['location']}\n{listing['text']}"
            out["letter"] = writing_checks.letter_score(paragraphs, cv["text"], source, listing["requirements"]) | {
                "seconds": round(time.monotonic() - started, 1), "text": paragraphs,
                "evidence": f"{len(evidence.shown(found))}/{len(found)}"}
    if "cv" in tasks:
        started = time.monotonic()
        try:
            if case["cv"] not in masters:
                masters[case["cv"]] = tailored_cv.build_master(cv["text"], model_info) | {"source_text": cv["text"]}
            found = evidence.for_job(model_info, f"{case['cv']}/{case['listing']}", job, cv["text"], listing["text"],
                                     evidence_dir) if evidence_dir else []
            made = tailored_cv.tailored_cv(masters[case["cv"]], job, listing["text"], "", model_info, found=found)
        except (RuntimeError, ValueError) as exc:
            out["tailored_cv"] = {"error": str(exc)}
        else:
            text = tailored_cv.cv_text(made)
            got, missing = writing_checks.coverage(listing["requirements"], text)
            out["tailored_cv"] = {"invented_figures": writing_checks.invented_figures(text, cv["text"]),
                         "coverage": round(len(got) / max(1, len(got) + len(missing)), 2), "missing": missing,
                         "skills": made["skills"], "seconds": round(time.monotonic() - started, 1)}
    return out


def verdict(results: list[dict]) -> dict:
    """The headline numbers: ratings in range, letters and CVs that passed every check, average coverage."""
    rated = [r["rating"] for r in results if "rating" in r]
    letters = [r["letter"] for r in results if "letter" in r]
    cvs = [r["tailored_cv"] for r in results if "tailored_cv" in r]

    def mean(values):
        values = [v for v in values if v is not None]
        return round(sum(values) / len(values), 2) if values else None

    return {"ratings_in_range": f"{sum(r['in_range'] for r in rated)}/{len(rated)}" if rated else None,
            "letters_passed": f"{sum(not x.get('error') and not x['problems'] for x in letters)}/{len(letters)}" if letters else None,
            "letter_coverage": mean(x.get("coverage") for x in letters),
            "cvs_honest": f"{sum(not c.get('error') and not c['invented_figures'] for c in cvs)}/{len(cvs)}" if cvs else None,
            "cv_coverage": mean(c.get("coverage") for c in cvs)}


def run(data: dict, tasks: tuple[str, ...], model_info) -> dict:
    masters: dict = {}
    with tempfile.TemporaryDirectory(prefix="hermitshell-bench-evidence-") as tmp:
        results = [run_case(case, data, tasks, model_info, masters, Path(tmp)) for case in data["cases"]]
    return {"model": model_info[1], "summary": verdict(results), "tokens": llm_usage.summary(days=1)["tasks"],
            "cases": results}


def report(found: dict) -> str:
    lines = [f"Model: {found['model'] or 'cloud providers'}", ""]
    lines += [f"{k.replace('_', ' '):18} {v}" for k, v in found["summary"].items() if v is not None]
    lines += ["", f"{'Task':22} {'requests':>8} {'tokens in':>10} {'tokens out':>11} {'a request':>10}"]
    for row in found["tokens"]:
        p = row["period"]
        lines.append(f"{row['label']:22} {p['calls']:>8} {p['in']:>10} {p['out']:>11} {(p['in'] + p['out']) // max(1, p['calls']):>10}")
    for case in found["cases"]:
        for part in ("letter", "tailored_cv"):
            problems = (case.get(part) or {}).get("problems") or (case.get(part) or {}).get("error")
            if problems:
                lines.append(f"{case['cv']} / {case['listing']} {part}: {problems}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tasks", default=",".join(TASKS), help=f"comma-separated, from {', '.join(TASKS)}")
    parser.add_argument("--cases", type=Path, default=CASES_FILE, help="the cases file (default scripts/bench/cases.json)")
    parser.add_argument("--json", type=Path, help="also write the full results to this file")
    args = parser.parse_args(argv)
    tasks = tuple(t for t in args.tasks.split(",") if t in TASKS)
    if not tasks:
        parser.error(f"--tasks takes {', '.join(TASKS)}")
    hc.load_env_file()
    real = os.environ.get("HERMES_USAGE_FILE")
    with tempfile.TemporaryDirectory(prefix="hermitshell-bench-") as tmp:
        os.environ["HERMES_USAGE_FILE"] = str(Path(tmp) / llm_usage.FILE)
        try:
            found = run(load_cases(args.cases), tasks, hc.connect_model("COVER_LETTER_MODEL"))
        finally:
            if real is None:
                os.environ.pop("HERMES_USAGE_FILE", None)
            else:
                os.environ["HERMES_USAGE_FILE"] = real
    print(report(found))
    if args.json:
        args.json.write_text(json.dumps(found, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())

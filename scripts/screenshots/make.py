#!/usr/bin/env python3
"""Regenerate the documentation screenshots: every email, PDF and feedback Worker page.

Everything is rendered by the real code with fictional data (the recruit Avery Lane, the admin Alex Morgan, Northwind,
Contoso...), in a
temporary HermitShell home, so nothing from your own .env, profile or server is used. Emails and PDFs come
from the Python builders, Worker pages from worker_pages.mjs (Node 18+), and headless Chrome or
Chromium takes the pictures.

    python3 scripts/screenshots/make.py                 # writes docs/images/{emails,worker}/*.png and the README hero
    python3 scripts/screenshots/make.py --chrome /usr/bin/chromium --out /tmp/shots

Needs requests, Pillow and PyMuPDF: pip install requests pillow pymupdf
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

REPO = Path(__file__).resolve().parents[2]
PACKAGE = REPO / "packages" / "daily-vacancy-report"
FEEDBACK_URL = "https://vacancy-feedback.example.workers.dev"
SECRET = "docs-secret"
WHEN = "Tuesday 29 September 2026, 07:00 BST"
TODAY = "Tuesday 29 September 2026"
BG = (238, 241, 247)
CHROME_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

SETTINGS = {
    "JOB_REPORT_TITLE": "Daily Vacancy Report", "JOB_REPORT_TAGLINE": "Roles matched to your CV",
    "JOB_REGION_NAME": "Greater Manchester", "JOB_REGION_PLACES": "Manchester,Salford,Stockport,Trafford",
    "JOB_LEVEL": "mid", "JOB_MIN_SALARY": "40000", "JOB_SALARY_CURRENCY": "GBP", "JOB_CANDIDATE_NAME": "Avery Lane",
    "JOB_PROFILE_ID": "avery-lane", "JOB_FEEDBACK_URL": FEEDBACK_URL, "JOB_FEEDBACK_SECRET": SECRET, "HERMES_TIMEZONE": "Europe/London",
    "ALERT_EMAIL": "avery.lane@example.com",
    "COVER_LETTER_CONTACT": "avery.lane@example.com  ·  07700 900123  ·  Manchester",
}


def isolate(home: Path) -> None:
    """A clean environment: only the fictional settings above, state in a temporary folder."""
    for key in list(os.environ):
        if key.startswith(("JOB_", "SMTP_", "ALERT_", "COVER_LETTER_", "FIRECRAWL", "TAVILY", "SCRAPFLY", "HERMES_",
                           "OLLAMA_", "CLOUDFLARE_")):
            del os.environ[key]
    os.environ.update(SETTINGS, HERMITSHELL_HOME=str(home), HERMES_HOME=str(home),
                      HERMES_STATE_DIR=str(home / "state"))
    sys.path[:0] = [str(REPO / "common"), str(PACKAGE)]


# --------------------------------------------------------------------------- fictional data

# Fixed exchange rates (per euro), so the converted salary in the screenshots never changes.
FX_RATES = {"EUR": 1.0, "GBP": 0.857, "USD": 1.135}


def jobs(js) -> list[dict]:
    import money
    from job_extras import parse_salary

    def job(**kw) -> dict:
        base = {"source": "jobs.example.com", "employer": "", "employer_site": "", "employer_logo": "", "company_logo": "",
                "company_site": "", "company_profile": "", "about": "", "agency": False, "published": "",
                "snippet_only": False, "second_opinion": None, "closing": "", "days_left": None, "seniority": "Mid"}
        base.update(kw)
        base.setdefault("model_fit", base["fit"])
        base["salary_range"] = money.shown_salary(parse_salary(base["salary"]), "GBP", FX_RATES, "gb") \
            if base["salary"] else None
        base["url"] = f"https://jobs.example.com/{base['key']}"
        base["actions"] = js.card_links(FEEDBACK_URL, SECRET, base["key"], base["title"])
        base["skill_link"] = js.skill_link(FEEDBACK_URL, SECRET, base["key"], base["title"], base["gaps"])
        return base

    return [
        job(key="northwind-data-engineer", title="Data Engineer (Python, Airflow)", company="Northwind Traders",
            location="Manchester", employment_type="Full-time permanent", work_mode="Hybrid",
            salary="£50,000 - £60,000", fit=9, confidence=88, coverage=78, days_left=12, published="Posted 2 days ago",
            company_site="https://northwind.example", company_profile="Logistics software · 250 staff",
            about="Builds route-planning and warehouse software for UK retailers.",
            matched=["Python", "Airflow", "SQL", "dbt", "Docker", "PostgreSQL", "AWS"], gaps=["Snowflake", "Terraform"],
            reasoning="Strong match: the role centres on Python and Airflow pipelines feeding a dbt warehouse, which is "
                      "Avery's day-to-day work. Snowflake is new but close to the PostgreSQL and dbt experience."),
        job(key="contoso-ml-engineer", title="Machine Learning Engineer", company="Contoso Health",
            location="Dublin", employment_type="Full-time permanent", work_mode="Hybrid", salary="€65,000 - €75,000",
            fit=8, model_fit=9, second_opinion=7, confidence=80, coverage=64, days_left=2,
            company_site="https://contoso-health.example", company_profile="Health tech · 1,200 staff",
            matched=["Python", "PyTorch", "scikit-learn", "Docker", "LLM applications"],
            gaps=["Kubernetes", "MLflow", "Azure ML"],
            reasoning="Deploying and monitoring models for clinical triage fits Avery's LLM and deployment work. "
                      "Kubernetes and MLflow are listed as essential and are gaps worth mentioning honestly."),
        job(key="fabrikam-automation", title="Automation Engineer (Contract)", company="Proseware Recruitment",
            employer="Fabrikam", employer_site="https://fabrikam.example", agency=True,
            company_profile="Recruitment agency", about="Fabrikam makes smart-building sensors and controllers.",
            location="Trafford Park", employment_type="Contract", work_mode="On-site", salary="£400 - £450 per day",
            fit=7, confidence=74, coverage=70, days_left=None, also_advertised_by=["Litware Talent"],
            matched=["Python", "MQTT", "REST APIs", "GitHub Actions"], gaps=["PLC programming", "OPC UA"],
            reasoning="Six-month contract automating device provisioning with Python and MQTT, close to Avery's IoT "
                      "projects. On-site five days a week, which is less than ideal."),
        job(key="tailspin-solutions", title="Senior Solutions Engineer, AI Platform", company="Tailspin Toys",
            location="Remote (UK)", employment_type="Full-time permanent", work_mode="Remote", salary="",
            seniority="Senior-level stretch", fit=6, model_fit=7, confidence=50, coverage=55, snippet_only=True,
            matched=["Python", "LLM applications", "FastAPI"], gaps=["Pre-sales", "Kubernetes"],
            reasoning="Customer-facing AI platform role. The engineering overlaps well, but it is a senior title "
                      "with pre-sales duties Avery has not done."),
        job(key="adventureworks-platform", title="Data Platform Engineer", company="Adventure Works",
            location="Stockport", employment_type="Full-time permanent", work_mode="On-site", salary="£45,000",
            fit=5, model_fit=6, second_opinion=4, second_kind="doubt", confidence=55, coverage=45, days_left=20,
            matched=["SQL", "Python", "Docker"], gaps=["Spark", "Databricks", "Scala", "Kafka"],
            reasoning="Adjacent: a Spark and Databricks platform team. Avery covers the SQL and Python side but "
                      "would need to pick up the streaming stack."),
    ]


def followups() -> list[dict]:
    return [{"key": "litware-analytics", "title": "Analytics Engineer", "company": "Litware", "days": 8,
             "url": "https://jobs.example.com/litware-analytics"},
            {"key": "wwi-data", "title": "Data Engineer", "employer": "Wide World Importers", "company": "Proseware",
             "days": 15, "url": "https://jobs.example.com/wwi-data"}]


def stats(**kw) -> dict:
    base = {"when": WHEN, "shown": 5, "strong": 3, "avg_fit": "7.0", "scanned": 25, "min_score": 5,
            "excluded_location": 6, "excluded_type": 3, "below_min": 9, "model": "qwen3:4b-instruct-2507-q4_K_M",
            "min_salary": 40000, "salary_currency": "GBP", "excluded_salary": 2, "excluded_closed": 1, "reposts": 2,
            "grouped": 1, "prescreened": 4, "verify_from": 8, "feedback": True,
            "unsubscribe": "", "sources": "jobs.example.com 31, web search 42",
            "web_usage": "Firecrawl 36 credits (2,964 left this month)", "cv_added": []}
    base.update(kw)
    return base


WEEK_EXTRA_JOBS = [
    ("BI Developer", "Litware", 6, ["Power BI"]),
    ("Python Developer", "Northwind Traders", 7, ["Kubernetes"]),
    ("Data Analyst", "Fourth Coffee", 4, ["Tableau", "Kubernetes"]),
    ("Platform Engineer", "Contoso Health", 3, ["Kubernetes", "Terraform"]),
]
SUMMARY = ("Three strong fits today. Northwind's data engineer role is the closest match to your pipeline work "
           "and pays within your range; Contoso closes in two days, so apply there first. Kubernetes shows up "
           "again as a gap in two listings.")
LETTER = [
    "I am applying for the Data Engineer role at Northwind Traders. For the past five years I have built and run "
    "Python data pipelines, most recently owning the Airflow and dbt stack that ingests supplier data for a "
    "mid-sized logistics company.",
    "Your listing asks for someone who can keep pipelines reliable while the business grows. In my current role I "
    "moved twelve nightly batch jobs to Airflow with tests and alerting, cutting failed loads from weekly to rare, "
    "and I introduced dbt models that analysts now extend themselves.",
    "I have not used Snowflake in production, but I have designed PostgreSQL warehouses with dbt and would expect "
    "to be productive quickly. I would welcome the chance to talk about how I could help your data team.",
]
CV = {
    "name": "Avery Lane", "headline": "Data engineer: Python, Airflow and dbt pipelines",
    "contact": SETTINGS["COVER_LETTER_CONTACT"],
    "summary": "Software engineer with five years of experience building data pipelines, internal automation and "
               "LLM-powered tools. Owns Python services, Airflow orchestration and dbt models end to end.",
    "skills": ["Python", "Airflow", "dbt", "SQL (PostgreSQL)", "Docker", "AWS (Lambda, S3, ECS)", "GitHub Actions",
               "FastAPI", "pandas", "LLM applications"],
    "experience": [
        {"title": "Automation Engineer", "employer": "Example Logistics Ltd", "location": "Manchester",
         "start": "2023", "end": "Present",
         "bullets": ["Moved twelve nightly batch jobs to Airflow with tests and alerting.",
                     "Introduced dbt models for supplier data that analysts now extend themselves.",
                     "Built a document-classification service and an internal knowledge-base assistant."]},
        {"title": "Software Engineer", "employer": "Example Retail Group", "location": "Salford",
         "start": "2021", "end": "2023",
         "bullets": ["Wrote FastAPI services and REST integrations for stock and pricing data.",
                     "Set up GitHub Actions CI/CD for eight services."]},
    ],
    "projects": [{"name": "Home energy dashboard",
                  "description": "MQTT and Home Assistant pipeline feeding a PostgreSQL store and Grafana."}],
    "education": [{"qualification": "BSc Computer Science", "institution": "Example University", "dates": "2017 - 2020"}],
    "certifications": ["AWS Certified Developer - Associate"],
}


# --------------------------------------------------------------------------- emails and PDFs

def cid_to_file(html_body: str) -> str:
    """Inline (cid:) images point at the package's icon files so the saved page opens in a browser."""
    icons = (PACKAGE / "icons").as_uri()
    return re.sub(r'src="cid:([\w-]+)"', lambda m: f'src="{icons}/{m.group(1)}.png"', html_body)


def email_page(inner_rows: str) -> str:
    from hermes_common import EMAIL_HEAD
    return (f'<!doctype html><html><head><meta charset="utf-8">{EMAIL_HEAD}</head><body class="body" '
            f'style="margin:0;background:#eef1f7;font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,'
            f'sans-serif"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" '
            f'class="m-wrap" style="padding:24px 12px"><table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;'
            f'width:100%"><tr><td>{inner_rows}</td></tr></table></td></tr></table></body></html>')


def render_emails(out: Path) -> dict[str, str]:
    import cover_letter
    import job_mail
    import tailored_cv
    import job_scanner as js
    import job_weekly
    import profiles
    from letter_pdf import cv_pdf

    js.CFG = js.load_settings()
    pages: dict[str, str] = {}
    all_jobs = jobs(js)
    top, maybe = all_jobs[:3], all_jobs[3:]
    follow = followups()
    follow_html = js.followup_section(
        follow, lambda i: js.card_links(FEEDBACK_URL, SECRET, i["key"], i["title"], js.FOLLOWUP_ACTIONS))
    unsub = js.unsubscribe_link(FEEDBACK_URL, SECRET, "you")
    pages["daily-report"] = js.build_html(top, maybe, stats(unsubscribe=unsub), SUMMARY, [], follow_html)
    pages["daily-report-card"] = email_page(js.job_card(top[0], 1))
    pages["daily-report-notices"] = js.build_html(
        top[:1], [], stats(shown=3, strong=1, avg_fit="6.7", cv_added=["Terraform", "dbt Cloud"], unsubscribe=unsub),
        "", ["Web search found no postings this run.",
             "Feedback buttons: the Worker did not answer; answers wait in the Worker until the next run."],
        "", maybe)
    pages["daily-report-empty"] = js.build_html(
        [], [], stats(shown=0, strong=0, avg_fit="-", scanned=18, unsubscribe=unsub), "", [], follow_html)
    pages["smtp-test"] = js.build_html([], [], {"when": WHEN, "shown": 0, "strong": 0, "avg_fit": "-", "scanned": 0,
                                                "min_score": 0, "excluded_location": 0, "excluded_type": 0,
                                                "below_min": 0, "model": "n/a", "sources": "n/a", "web_usage": "n/a"},
                                       "SMTP test.")

    now = datetime(2026, 9, 27, 18).timestamp()
    day = 86400
    week = {
        "jobs": [{**j, "gaps": json.dumps(j["gaps"]), "emailed": j["fit"] >= 5} for j in all_jobs]
        + [{"title": t, "company": c, "fit": f, "gaps": json.dumps(g), "emailed": f >= 5,
            "url": "https://jobs.example.com/x", "confidence": 60} for t, c, f, g in WEEK_EXTRA_JOBS],
        "events": [{"action": a} for a in ["good_match", "good_match", "not_for_me", "interested", "applied",
                                            "applied", "cover_letter", "tailored_cv"]],
        "runs": [{"sources": '{"jobs.example.com": {"found": 30}, "web search": {"found": 40}}'}] * 6
        + [{"sources": '{"jobs.example.com": {"found": 28}, "web search": {"found": 0}}'}],
        "applications": [
            {"key": "northwind-data-engineer", "title": "Data Engineer (Python, Airflow)", "company": "Northwind Traders",
             "applied_at": now - 2 * day, "status": "applied"},
            {"key": "litware-analytics", "title": "Analytics Engineer", "company": "Litware",
             "applied_at": now - 8 * day, "status": "heard_back"},
            {"key": "wwi-data", "title": "Data Engineer", "employer": "Wide World Importers",
             "applied_at": now - 15 * day, "status": "rejected"}],
    }
    pages["weekly"] = job_weekly.build_weekly(week, "Week ending Sunday 27 September 2026", "Daily Vacancy Report",
                                              "Greater Manchester", now, unsub)[1]

    letter_job = {**top[0], "closing": "2026-10-11"}
    filename = "Cover letter - Avery Lane - Data Engineer (Python, Airflow).pdf"
    pages["cover-letter"] = cover_letter.email_bodies(letter_job, LETTER, filename, "Mention my Airflow migration")[1]
    preview = [CV["headline"], CV["summary"], "Skills: " + ", ".join(CV["skills"]), *tailored_cv.report_lines(
        {"covered": ["Python", "Airflow", "dbt", "Snowflake"], "missing": ["Stakeholder reporting"], "gaps": ["Kubernetes"]})]
    pages["tailored-cv"] = cover_letter.email_bodies(letter_job, preview, "CV - Avery Lane - Data Engineer.pdf", "",
                                                     kind="tailored_cv")[1]
    pages["job-email"] = job_mail.job_email(letter_job["key"], letter_job,
                                            datetime(2026, 9, 29, 14, 5, tzinfo=ZoneInfo("Europe/London")))[1]

    sent: list[str] = []
    profiles.send = lambda to, subject, html_body, text: sent.append(html_body)
    profiles._today = lambda: TODAY
    people = [{"id": "owner", "owner": True, "name": "Alex Morgan", "email": "alex.morgan@example.com",
               "status": "active", "recruit": "avery-lane"},
              {"id": "avery-lane", "name": "Avery Lane", "email": "avery.lane@example.com", "status": "active"},
              {"id": "sam-lee", "name": "Sam Lee", "email": "sam.lee@example.com", "status": "active"},
              {"id": "jordan-patel", "name": "Jordan Patel", "email": "jordan.patel@example.net", "status": "paused"}]
    profiles.all_profiles = lambda: people
    profiles.load = lambda pid: next((p for p in people if p["id"] == pid), None)
    built = {"titles": ["Data Analyst", "BI Developer", "Analytics Engineer"],
             "skills": [{"name": s} for s in ["SQL", "Power BI", "Python", "Excel", "DAX", "Tableau", "Statistics"]]}
    profiles.send_welcome({"id": "sam-lee", "name": "Sam Lee", "email": "sam.lee@example.com"}, built, False)
    pages["welcome"] = sent.pop()
    profiles.send_new_recruit({"id": "sam-lee", "name": "Sam Lee", "email": "sam.lee@example.com", "location": "Belfast",
                               "roles": "Data analyst or BI developer, hybrid"}, built, False)
    pages["owner-new-profile"] = sent.pop()
    profiles.remove_dir = lambda pid: None
    profiles.unsubscribe("jordan-patel", "Found a job, thanks!")
    pages["owner-unsubscribed"] = sent.pop()
    pages["goodbye"] = sent.pop()
    profiles.send_test_email("alex.morgan@example.com")
    pages["test-email"] = sent.pop()

    out.mkdir(parents=True, exist_ok=True)
    for name, body in pages.items():
        (out / f"{name}.html").write_text(cid_to_file(body), encoding="utf-8")

    pdfs = {"cover-letter-pdf": cover_letter.build_pdf(letter_job, "Avery Lane", LETTER, datetime(2026, 9, 29)),
            "tailored-cv-pdf": cv_pdf(CV, title="CV - Avery Lane - Data Engineer")}
    for name, data in pdfs.items():
        (out / f"{name}.pdf").write_bytes(data)
    return pages


def pdf_png(pdf: Path, png: Path) -> None:
    import pymupdf
    from PIL import Image, ImageDraw

    page = pymupdf.open(pdf)[0]
    pix = page.get_pixmap(dpi=144)
    sheet = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    pad = 48
    canvas = Image.new("RGB", (sheet.width + 2 * pad, sheet.height + 2 * pad), BG)
    ImageDraw.Draw(canvas).rectangle([pad - 1, pad - 1, pad + sheet.width, pad + sheet.height], outline=(203, 213, 225))
    canvas.paste(sheet, (pad, pad))
    save_png(canvas, png)


# --------------------------------------------------------------------------- capture

def find_chrome(given: str | None) -> str:
    for candidate in [given, os.environ.get("CHROME"), *CHROME_PATHS]:
        if candidate and Path(candidate).is_file():
            return candidate
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge"):
        if found := shutil.which(name):
            return found
    raise SystemExit("Chrome or Chromium not found; pass --chrome PATH")


def save_png(image, png: Path) -> None:
    from PIL import Image
    png.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(
        png, optimize=True)


def capture(chrome: str, profile: Path, html: Path, png: Path, width: int, height: int | None = None) -> None:
    """Screenshot at 2x; without a height the page is grown until it fits, then trimmed to its content."""
    from PIL import Image

    tall = height or 2000
    while True:
        shot = profile / "shot.png"
        shot.unlink(missing_ok=True)
        subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                        # Pages animate in; the reduced-motion setting shows them as they end up.
                        "--force-prefers-reduced-motion",
                        "--force-device-scale-factor=2", f"--user-data-dir={profile}", f"--window-size={width},{tall}",
                        "--virtual-time-budget=3000", f"--screenshot={shot}", html.as_uri()],
                       check=True, capture_output=True, timeout=120)
        image = Image.open(shot).convert("RGB")
        if height:
            break
        bottom = next((y for y in range(image.height - 1, -1, -1)
                       if any(abs(a - b) > 3 for px in _row(image, y) for a, b in zip(px, BG))), 0)
        if bottom < image.height - 80 or tall >= 8000:
            image = image.crop((0, 0, image.width, min(image.height, bottom + 48)))
            break
        tall *= 2
    save_png(image, png)


def capture_phone(chrome: str, profile: Path, html: Path, png: Path, width: int = 390, height: int = 1900) -> None:
    """The top of an email or page as a phone shows it. Headless Chrome's window is at least 500px wide, so the page
    is put in a frame as wide as a phone, where its media queries apply, and the shot is cut to the frame."""
    from PIL import Image
    frame = html.with_name(f"{html.stem}-phone-frame.html")
    frame.write_text(f'<html><body style="margin:0;background:#eef1f7"><iframe src="{html.name}" width="{width}" '
                     f'height="{height}" style="border:0;display:block"></iframe></body></html>', encoding="utf-8")
    capture(chrome, profile, frame, png, 500, height)
    save_png(Image.open(png).crop((0, 0, width * 2, height * 2)), png)


def _row(image, y: int):
    return (image.getpixel((x, y)) for x in range(0, image.width, 7))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", type=Path, default=REPO / "docs" / "images", help="where the PNGs go")
    parser.add_argument("--chrome", help="Chrome, Chromium or Edge executable")
    args = parser.parse_args()
    chrome = find_chrome(args.chrome)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        isolate(tmp_path / "home")
        html_dir = tmp_path / "html"
        render_emails(html_dir / "emails")
        subprocess.run(["node", str(Path(__file__).with_name("worker_pages.mjs")), str(html_dir / "worker")],
                       check=True)
        profile = tmp_path / "chrome"
        profile.mkdir()
        for html in sorted((html_dir / "emails").glob("*.html")):
            capture(chrome, profile, html, args.out / "emails" / f"{html.stem}.png", 760)
            print(f"emails/{html.stem}.png")
        for pdf in sorted((html_dir / "emails").glob("*.pdf")):
            pdf_png(pdf, args.out / "emails" / f"{pdf.stem}.png")
            print(f"emails/{pdf.stem}.png")
        capture(chrome, profile, html_dir / "emails" / "daily-report.html", args.out / "daily-vacancy-report.png",
                760, 1100)
        capture_phone(chrome, profile, html_dir / "emails" / "daily-report.html",
                      args.out / "emails" / "daily-report-phone.png")
        print("emails/daily-report-phone.png")
        for html in sorted((html_dir / "worker").glob("*.html")):
            capture(chrome, profile, html, args.out / "worker" / f"{html.stem}.png",
                    1900 if html.stem in ("admin-signed-in", "admin-server-panel") else
                    # Recruits and Users grow with the window and stack their rows below 900px.
                    1280 if html.stem.startswith(("admin-dashboard", "admin-tasks", "admin-user", "admin-recruiter",
                                                  "admin-delete", "admin-password", "admin-theme")) else
                    1000 if html.stem.startswith(("admin-profile", "admin-settings", "admin-stats", "admin-sent",
                                                  "admin-global-key", "admin-history", "admin-model-key")) else
                    760 if html.stem == "privacy" else 600,
                    # A modal covers the whole window, so the page cannot be trimmed to its content.
                    720 if html.stem in ("admin-global-key-modal", "admin-user-modal", "admin-delete-modal",
                                         "admin-user-reset-modal", "admin-password-modal", "admin-tasks") else
                    860 if html.stem == "admin-model-key-modal" else
                    # A wide window, where the signed-in box sits beside the card; only the top is kept.
                    240 if html.stem == "admin-signed-in" else
                    700 if html.stem == "admin-server-panel" else
                    430 if html.stem == "admin-settings-mismatch" else None)
            print(f"worker/{html.stem}.png")
        for stem in ("admin-dashboard", "admin-users"):
            capture_phone(chrome, profile, html_dir / "worker" / f"{stem}.html", args.out / "worker" / f"{stem}-phone.png",
                          height=1500)
            print(f"worker/{stem}-phone.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

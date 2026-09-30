#!/usr/bin/env python3
"""One job from the tracker, emailed as the card it had in the daily report: the "Email" button on the
dashboard's list of jobs sent.

cover_letter.py sends these with the letters and CVs it polls for. The email goes to the profile's own address
(ALERT_EMAIL, as its reports do) and has the report card's buttons, signed for that profile.
"""
from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

import hermes_common as hc
from hermes_common import EMAIL_HEAD, env
from job_extras import days_left, parse_salary
from job_tracker import ACTIONS, Tracker, card_links, skill_link

MAX_SKILLS = 30


def _number(value, top: int) -> int:
    return value if isinstance(value, int) and 0 <= value <= top else 0


def card_job(key: str, job: dict, today: date) -> dict:
    """A tracker row in the shape job_scanner.job_card draws; fields the tracker does not keep are left empty."""
    def text(name: str) -> str:
        value = job.get(name)
        return str(value) if isinstance(value, (str, int, float)) and value != "Unknown" else ""

    def skills(name: str) -> list[str]:
        items = job.get(name)
        return [str(s) for s in items if isinstance(s, str) and s][:MAX_SKILLS] if isinstance(items, list) else []

    try:
        closing = date.fromisoformat(text("closing"))
    except ValueError:
        closing = None
    left = days_left(closing, today)
    salary = text("salary")
    return {
        "key": key, "title": text("title") or "Untitled job", "company": text("company"), "employer": text("employer"),
        "url": text("url") if text("url").lower().startswith(("https://", "http://")) else "",
        "source": text("source"), "location": text("location"), "employment_type": text("employment_type"),
        "work_mode": text("work_mode"), "seniority": text("seniority"), "published": text("published"),
        "salary": salary, "salary_range": parse_salary(salary), "fit": _number(job.get("fit"), 10),
        "confidence": _number(job.get("confidence"), 100), "coverage": _number(job.get("coverage"), 100),
        "reasoning": text("reasoning"), "about": text("about"), "company_profile": text("company_profile"),
        "company_site": text("company_site"), "employer_site": text("employer_site"),
        "matched": skills("matched"), "gaps": skills("gaps"),
        "days_left": left if left is not None and left >= 0 else None, "closed": left is not None and left < 0,
    }


def job_text(card: dict, closing: str, unsubscribe: str) -> str:
    """The plain-text part: only the facts the tracker kept, then the card's links."""
    where = card["employer"] or card["company"]
    facts = [card["location"], card["employment_type"], card["work_mode"], card["salary"]]
    lines = [card["title"] + (f" - {where}" if where else ""), ", ".join(f for f in facts if f),
             f"HermitShell fit {card['fit']}/10, closing: {closing}", card["reasoning"],
             f"Matches: {', '.join(card['matched'])}" if card["matched"] else "",
             f"Missing from your CV: {', '.join(card['gaps'])}" if card["gaps"] else "", card["url"]]
    links = [f"{ACTIONS.get(a, a)}: {link}" for a, link in card.get("actions", {}).items()]
    if card.get("skill_link"):
        links.append(f"{ACTIONS['add_skill']}: {card['skill_link']}")
    if unsubscribe:
        links.append(f"Unsubscribe: {unsubscribe}")
    return "\n".join(line for line in lines if line) + ("\n\n" + "\n".join(links) if links else "")


def job_email(key: str, job: dict, now: datetime | None = None) -> tuple[str, str, str]:
    """(subject, html, text) of the email for one tracker job."""
    import job_scanner as js
    now = now or datetime.now(ZoneInfo(env("HERMES_TIMEZONE", "UTC") or "UTC"))
    card = card_job(key, job, now.date())
    base, secret = env("JOB_FEEDBACK_URL", "") or "", env("JOB_FEEDBACK_SECRET", "") or ""
    profile = env("JOB_PROFILE_ID", "") or ""
    card["actions"] = card_links(base, secret, key, card["title"], profile=profile)
    card["skill_link"] = skill_link(base, secret, key, card["title"], card["gaps"], profile)
    closing = ("Closed" if card["closed"] else "Today" if card["days_left"] == 0
               else f"{card['days_left']} days" if card["days_left"] is not None else "Not stated")
    header = hc.email_header(js.CFG.region or "Job radar", now.strftime("%A %d %B %Y, %H:%M %Z"), "A job for you",
                             "Sent from your HermitShell dashboard",
                             [(f"{card['fit']}/10", "HermitShell fit"), (closing, "Closing")], highlight=0)
    closed = ('<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:10px 14px;'
              'margin:18px 0 0;font-size:13px;color:#991b1b">The advert&rsquo;s closing date has passed; it may no '
              'longer take applications.</div>') if card["closed"] else ""
    unsubscribe = js.report_unsubscribe_link()
    body = f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">{EMAIL_HEAD}<title>{js.esc(card['title'])}</title></head>
<body class="body" style="margin:0;padding:0;background:{js.C_BG};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:{js.C_BG}"><tr><td align="center" class="m-wrap" style="padding:24px 12px">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%">
{header}
<tr><td>
  {closed}
  <div style="height:22px;line-height:22px">&nbsp;</div>
  {js.job_card(card, None)}
  {js.unsubscribe_footer(unsubscribe, not profile)}
</td></tr>
</table></td></tr></table></body></html>"""
    where = card["employer"] or card["company"]
    text = job_text(card, closing, unsubscribe)
    subject = f"{js.CFG.title}: {card['title']}" + (f" at {where}" if where else "")
    return " ".join(subject.split()), body, text


def send_job(tracker: Tracker, key: str, dry_run: bool = False) -> str:
    """Email the job to the profile; returns the subject. In a dry run nothing is sent."""
    import job_scanner as js
    job = tracker.job(key)
    if not job:
        raise LookupError(f"job {key} is not in the tracker")
    subject, body, text = job_email(key, job)
    if not dry_run:
        hc.send_email(subject, body, text, js.CFG.title,
                      {**hc.inline_images(body, js.LOGO_DIR), **hc.inline_images(body, js.ICON_DIR)})
    return subject

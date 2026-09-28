"""Daily Vacancy Report email blocks (source warnings, feedback buttons, follow-ups) and the
Sunday weekly roll-up built from job_tracker.db.

Run directly (`python3 job_weekly.py`, e.g. from a weekly cron job) to send the roll-up; it is the
same as `python3 job_scanner.py --weekly`, and extra arguments such as --dry-run are passed on.

Shared unchanged between the HermitShell package and the Hermes server copy.
"""

from __future__ import annotations

import html
import json
from collections import Counter
from datetime import datetime

from hermes_common import EMAIL_HEAD, gmail_dark_safe
from job_tracker import ACTIONS

C_BG, C_CARD, C_INK, C_MUTED, C_ACCENT = "#eef1f7", "#ffffff", "#0f172a", "#64748b", "#4f46e5"
BUTTON_STYLES = {
    "interested": ("#047857", "#ecfdf5", "#a7f3d0"),
    "applied": ("#ffffff", "#4f46e5", "#4f46e5"),
    "not_for_me": ("#475569", "#f8fafc", "#cbd5e1"),
    "heard_back": ("#047857", "#ecfdf5", "#a7f3d0"),
    "rejected": ("#475569", "#f8fafc", "#cbd5e1"),
}


def esc(text) -> str:
    return html.escape(str(text or ""), quote=True)


# --------------------------------------------------------------------------- daily email blocks

def source_banner(problems: list[str]) -> str:
    if not problems:
        return ""
    items = "".join(f"<li style=\"margin:2px 0\">{esc(p)}</li>" for p in problems)
    return (f'<table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;'
            f'border-radius:14px;margin:22px 0 4px"><tr><td style="padding:14px 20px;font-size:13px;color:#92400e;'
            f'line-height:1.5"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;'
            f'margin-bottom:4px">Check your sources</div><ul style="margin:0;padding-left:18px">{items}</ul>'
            f'</td></tr></table>')


def action_buttons(links: dict[str, str]) -> str:
    if not links:
        return ""
    out = []
    for action, url in links.items():
        fg, bg, border = BUTTON_STYLES.get(action, BUTTON_STYLES["not_for_me"])
        out.append(f'<a href="{esc(url)}" style="display:inline-block;background:{bg};color:{fg};border:1px solid {border};'
                   f'border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;text-decoration:none;'
                   f'margin:0 6px 6px 0">{esc(ACTIONS[action])}</a>')
    return f'<div style="margin-top:12px">{"".join(out)}</div>'


def closing_pill(days: int | None) -> str:
    if days is None:
        return ""
    text = "Closes today" if days == 0 else "Closes tomorrow" if days == 1 else f"Closes in {days} days"
    urgent = days <= 3
    return (f'<span style="display:inline-block;background:{"#fef2f2" if urgent else "#f1f5f9"};'
            f'color:{"#b91c1c" if urgent else "#334155"};border-radius:6px;padding:3px 8px;font-size:12px;'
            f'font-weight:700;margin:0 6px 6px 0">{text}</span>')


def followup_section(items: list[dict], links_for) -> str:
    """`links_for(item)` returns the heard back / rejected links for one application."""
    if not items:
        return ""
    rows = []
    for item in items:
        who = item.get("employer") or item.get("company") or ""
        title = (f'<a href="{esc(item["url"])}" style="color:{C_INK};font-weight:700;text-decoration:none">'
                 f'{esc(item["title"])}</a>' if item.get("url") else f"<b>{esc(item['title'])}</b>")
        rows.append(f'<tr><td style="padding:12px 0;border-top:1px solid #e2e8f0">{title}'
                    f'<div style="font-size:13px;color:#475569">{esc(who)} &middot; applied {item["days"]} days ago, '
                    f'no update yet. A short follow-up email often helps.</div>{action_buttons(links_for(item))}</td></tr>')
    return (f'<div style="margin:26px 0 12px"><div style="font-size:18px;font-weight:800;color:{C_INK}">Follow up</div>'
            f'<div style="font-size:13px;color:{C_MUTED}">Applications with no reply after 7 or 14 days.</div></div>'
            f'<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_CARD};border:1px solid #e2e8f0;'
            f'border-radius:16px"><tr><td style="padding:6px 24px 10px"><table width="100%" cellpadding="0" '
            f'cellspacing="0">{"".join(rows)}</table></td></tr></table>')


def followup_text(items: list[dict]) -> str:
    if not items:
        return ""
    lines = [f"- {i['title']} ({i.get('employer') or i.get('company') or 'unknown'}), applied {i['days']} days ago"
             for i in items]
    return "Follow up on these applications:\n" + "\n".join(lines)


# --------------------------------------------------------------------------- weekly roll-up

def _tile(value, label: str) -> str:
    return (f'<td width="25%" align="center" style="padding:6px">'
            f'<div style="background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:12px 6px">'
            f'<div style="font-size:24px;font-weight:800;color:#ffffff">{value}</div>'
            f'<div style="font-size:11px;color:#c7d2fe;text-transform:uppercase;letter-spacing:.06em">{label}</div></div></td>')


def _card(title: str, body: str) -> str:
    return (f'<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_CARD};border:1px solid #e2e8f0;'
            f'border-radius:16px;margin:18px 0 0"><tr><td style="padding:18px 22px">'
            f'<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:{C_ACCENT};font-weight:700;'
            f'margin-bottom:8px">{title}</div>{body}</td></tr></table>')


def _bar(label: str, count: int, total: int, colour: str) -> str:
    pct = max(2, round(100 * count / total)) if total and count else 0
    bar = (f'<table width="100%" cellpadding="0" cellspacing="0" style="background:#e2e8f0;border-radius:99px"><tr>'
           f'<td width="{pct}%" style="background:{colour};height:8px;border-radius:99px;font-size:0;line-height:0">&nbsp;</td>'
           f'<td style="font-size:0;line-height:0">&nbsp;</td></tr></table>') if pct else \
        '<div style="height:8px;background:#e2e8f0;border-radius:99px"></div>'
    return (f'<tr><td width="90" style="font-size:13px;color:#334155;padding:4px 8px 4px 0">{label}</td>'
            f'<td style="padding:4px 0">{bar}</td><td width="36" align="right" style="font-size:13px;color:#334155">'
            f'{count}</td></tr>')


def _chip(text: str, count: int) -> str:
    return (f'<span style="display:inline-block;background:#fffbeb;color:#b45309;border:1px solid #fde68a;'
            f'border-radius:999px;padding:3px 10px;font-size:12px;margin:0 6px 6px 0">{esc(text)} &middot; {count}</span>')


def weekly_summary(data: dict) -> dict:
    jobs, events, runs = data["jobs"], data["events"], data["runs"]
    fits = [j["fit"] for j in jobs if j.get("fit") is not None]
    companies = Counter((j.get("employer") or j.get("company") or "").strip() for j in jobs)
    companies.pop("", None)
    gaps = Counter(g for j in jobs for g in json.loads(j.get("gaps") or "[]"))
    spread = {"9-10": 0, "7-8": 0, "5-6": 0, "0-4": 0}
    for f in fits:
        spread["9-10" if f >= 9 else "7-8" if f >= 7 else "5-6" if f >= 5 else "0-4"] += 1
    activity = Counter(e["action"] for e in events)
    sources: dict[str, dict] = {}
    for run in runs:
        for name, info in json.loads(run.get("sources") or "{}").items():
            s = sources.setdefault(name, {"found": 0, "runs": 0, "empty": 0, "errors": 0})
            s["runs"] += 1
            s["found"] += info.get("found", 0)
            s["empty"] += not info.get("found") and not info.get("error")
            s["errors"] += bool(info.get("error"))
    return {
        "rated": len(jobs), "emailed": sum(1 for j in jobs if j.get("emailed")),
        "avg_fit": f"{sum(fits) / len(fits):.1f}" if fits else "-",
        "applied_week": activity.get("applied", 0), "companies": companies.most_common(8),
        "gaps": gaps.most_common(10), "spread": spread, "activity": activity, "sources": sources,
        "top": sorted((j for j in jobs if j.get("emailed")), key=lambda j: (j["fit"], j.get("confidence") or 0),
                      reverse=True)[:5],
        "applications": data["applications"], "runs": len(runs),
    }


STATUS_LABELS = {"applied": "Waiting", "heard_back": "Heard back", "rejected": "Rejected",
                 "interested": "Interested", "not_for_me": "Not for me"}


def build_weekly(data: dict, when: str, title: str, eyebrow: str, now: float) -> tuple[str, str, str]:
    """(subject, html, text) for the weekly roll-up."""
    s = weekly_summary(data)
    spread_rows = "".join(_bar(k, v, max(1, s["rated"]), c) for (k, v), c in
                          zip(s["spread"].items(), ("#059669", "#0d9488", "#d97706", "#dc2626")))
    companies = "".join(f'<tr><td style="font-size:13px;color:#334155;padding:3px 0">{esc(n)}</td>'
                        f'<td align="right" style="font-size:13px;color:{C_MUTED}">{c} role{"s" if c > 1 else ""}</td></tr>'
                        for n, c in s["companies"]) or f'<tr><td style="color:{C_MUTED};font-size:13px">No jobs rated this week.</td></tr>'
    gaps = "".join(_chip(g, c) for g, c in s["gaps"]) or \
        f'<span style="color:{C_MUTED};font-size:13px">No recurring gaps this week.</span>'
    top = "".join(
        f'<tr><td style="padding:6px 0;border-top:1px solid #f1f5f9"><a href="{esc(j["url"])}" style="color:{C_INK};'
        f'font-weight:700;text-decoration:none">{esc(j["title"])}</a><div style="font-size:12px;color:{C_MUTED}">'
        f'{esc(j.get("employer") or j.get("company"))}</div></td><td align="right" width="50" style="font-weight:800;'
        f'color:{C_ACCENT}">{j["fit"]}/10</td></tr>' for j in s["top"]) or \
        f'<tr><td style="color:{C_MUTED};font-size:13px">Nothing emailed this week.</td></tr>'
    apps = "".join(
        f'<tr><td style="padding:6px 0;border-top:1px solid #f1f5f9;font-size:13px"><b>{esc(a.get("title") or a["key"])}</b>'
        f'<div style="color:{C_MUTED}">{esc(a.get("employer") or a.get("company"))} &middot; applied '
        f'{int((now - a["applied_at"]) // 86400)} days ago</div></td><td align="right" style="font-size:12px;'
        f'font-weight:700;color:#334155">{STATUS_LABELS.get(a["status"], a["status"])}</td></tr>'
        for a in s["applications"]) or \
        f'<tr><td style="color:{C_MUTED};font-size:13px">No applications tracked yet. Use the I applied button in the daily email.</td></tr>'
    activity = " &middot; ".join(f"{ACTIONS[a]}: {n}" for a, n in s["activity"].items() if a in ACTIONS) or "No feedback this week."
    health = "".join(
        f'<tr><td style="font-size:13px;color:#334155;padding:3px 0">{esc(name)}</td><td align="right" '
        f'style="font-size:13px;color:{"#b45309" if info["errors"] or info["empty"] else C_MUTED}">{info["found"]} found'
        f'{f", {info["errors"]} failed runs" if info["errors"] else ""}{f", {info["empty"]} empty runs" if info["empty"] else ""}'
        f'</td></tr>' for name, info in s["sources"].items()) or \
        f'<tr><td style="color:{C_MUTED};font-size:13px">No runs recorded this week.</td></tr>'
    body = f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">{EMAIL_HEAD}<title>{esc(title)}: weekly roll-up</title></head>
<body class="body" style="margin:0;padding:0;background:{C_BG};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:{C_BG}"><tr><td align="center" style="padding:24px 12px">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%">
<tr><td style="background:#1e1b4b;background-image:linear-gradient(135deg,#0f172a 0%,#312e81 55%,#6d28d9 100%);border-radius:20px;padding:30px 28px">{gmail_dark_safe(f'''
  <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#a5b4fc;font-weight:700">{esc(eyebrow)}</div>
  <div style="font-size:30px;font-weight:800;color:#ffffff;margin:6px 0 4px">Your week in jobs</div>
  <div style="font-size:15px;color:#e0e7ff;font-weight:600">{esc(title)} weekly roll-up</div>
  <div style="font-size:13px;color:#c7d2fe;margin-top:4px">{esc(when)}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr>
    {_tile(s['rated'], 'Rated')}{_tile(s['emailed'], 'Emailed')}{_tile(s['avg_fit'], 'Avg fit')}{_tile(s['applied_week'], 'Applied')}
  </tr></table>''')}
</td></tr>
<tr><td>
  {_card("Best of the week", f'<table width="100%" cellpadding="0" cellspacing="0">{top}</table>')}
  {_card("Applications", f'<table width="100%" cellpadding="0" cellspacing="0">{apps}</table>'
         f'<div style="font-size:12px;color:{C_MUTED};margin-top:8px">Your feedback this week: {activity}</div>')}
  {_card("Skills that keep coming up as gaps", gaps + f'<div style="font-size:12px;color:{C_MUTED};margin-top:4px">Worth learning or adding to your CV if you already have them.</div>')}
  {_card("Who is hiring", f'<table width="100%" cellpadding="0" cellspacing="0">{companies}</table>')}
  {_card("Fit scores this week", f'<table width="100%" cellpadding="0" cellspacing="0">{spread_rows}</table>')}
  {_card("Source health", f'<table width="100%" cellpadding="0" cellspacing="0">{health}</table>'
         f'<div style="font-size:12px;color:{C_MUTED};margin-top:8px">{s["runs"]} daily runs recorded this week.</div>')}
</td></tr>
</table></td></tr></table></body></html>"""
    text = "\n".join([
        f"{title} weekly roll-up ({when})",
        f"Rated {s['rated']}, emailed {s['emailed']}, average fit {s['avg_fit']}, applied {s['applied_week']}.",
        "", "Best of the week:", *[f"- {j['fit']}/10 {j['title']} ({j.get('employer') or j.get('company')}) {j['url']}"
                                   for j in s["top"]],
        "", "Applications:", *[f"- {a.get('title') or a['key']}: {STATUS_LABELS.get(a['status'], a['status'])}"
                               for a in s["applications"]],
        "", "Common gaps: " + (", ".join(f"{g} ({c})" for g, c in s["gaps"]) or "none"),
        "", "Sources: " + (", ".join(f"{n} {i['found']} found" for n, i in s["sources"].items()) or "no runs"),
    ])
    subject = f"{title}: your week ({s['rated']} rated, {s['applied_week']} applied)"
    return subject, body, text


def weekly_when(tz) -> str:
    return datetime.now(tz).strftime("Week ending %A %d %B %Y")


if __name__ == "__main__":
    import sys

    import job_scanner

    sys.argv = [sys.argv[0], "--weekly", *sys.argv[1:]]
    raise SystemExit(job_scanner.main())

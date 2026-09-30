#!/usr/bin/env python3
"""The Daily Vacancy Report for one recruit: the script of that recruit's own scheduled job.

profiles.py creates a vacancy-report-<id> job for every recruit with a CV, running this script from the
recruit's folder (the job's workdir), so each report runs, shows and fails on its own in `scheduler.py list`.
The admin is staff and has no report of their own.

    python3 profile_report.py ID           # by hand
    python3 profile_report.py --now ID     # as Send jobs now does: emails even when nothing new turned up
"""
from __future__ import annotations

import sys

import profiles

if __name__ == "__main__":
    sys.exit(profiles.main(["report", *sys.argv[1:]]))

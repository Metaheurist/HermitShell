# Daily Vacancy Report

A Hermes cron package that searches for jobs matching your CV. The model Hermes already uses
rates each one, and you get a scored, logo-rich HTML email that renders properly in Gmail's
light and dark modes.

![Daily Vacancy Report email](../../docs/images/daily-vacancy-report.png)

*Dry run with the fictional example profile and the Northern Ireland example config.
[Full-length email](../../docs/images/daily-vacancy-report-full.png).*

## What it does

1. **Discover.** Runs web searches for single job postings through Firecrawl, with Tavily as the
   backup, built from the job titles and location in your profile settings. It can also read [nijobs.com](https://www.nijobs.com) keyword listings, which is useful
   for Northern Ireland.
2. **Pre-filter.** Keeps only relevant titles (configurable regexes), drops employment types you
   didn't choose (internships and part-time by default) and jobs already seen in the last 90
   days. The model then screens up to 60 remaining titles in one quick batch, so the rating
   budget goes to the most promising ones. Jobs whose rating failed last time go first. The
   same role reposted on another board or day (same title and company) is skipped. Where the
   page has structured `JobPosting` data, the scanner uses that.
3. **Hard filters.** Optionally restricts results to one region (towns, postcodes or any regex),
   optionally letting fully remote jobs through, and keeps only the employment types (permanent,
   contract, temporary, part-time, internship) and work modes (on-site, hybrid, remote) you chose.
   Jobs that don't state a type or mode are kept. Optionally drops jobs advertising clearly less
   than your minimum salary (day and hourly rates are converted) and jobs whose closing date has
   passed.
4. **Rate.** Hermes' model scores each job 0-10 against `job_profile.md`, with a confidence value,
   matched CV keywords, gaps, the closing date and a short reason. For agency adverts it also
   identifies the real employer. Seniority comes from the title, or from the model's reading of
   the listing when the title doesn't say. Scores of 8 or more get a second, stricter look and the
   two scores are averaged. If you use the feedback buttons, your recent likes and rejections are
   added to the prompt as examples.
5. **Enrich.** Adds the hiring company's website, a circular logo and an expandable "About the
   company" section. Lookups are cached for 30 days in `state/companies.json`. The same job
   advertised by several agencies becomes one card that lists the other advertisers.
6. **Email.** Sends a summary, then one card per job with the salary as a headline under the
   company (day and hourly rates also show a yearly estimate), the closing date (jobs closing within
   three days come first), your three strongest matching skills, the skills your CV is missing and a link to
   apply. A banner warns when a source failed (for example a search provider out of credits). With the
   optional [feedback buttons](../../docs/feedback-worker.md), each card also has **I applied**,
   thumbs up / thumbs down, **Interested** and **Cover letter** buttons next to **View job**,
   jobs you applied to come back in a follow-up section after 7 and 14 days, and tapping a
   missing-skill tag adds skills you have to your skills pool
   ([how it works](../../docs/feedback-worker.md#adding-missing-skills)).
7. **Cover letters.** Pressing **Cover letter** gets you a tailored A4 PDF letter by email within
   about 5 minutes, written by Hermes' model from your profile and the listing
   ([how it works](../../docs/feedback-worker.md#cover-letters)).
8. **Weekly roll-up.** `job_weekly.py` (or `job_scanner.py --weekly`) emails a Sunday summary from
   `state/job_tracker.db`: best jobs of the week, applications and replies, common gaps, who's
   hiring and source health.
9. **Extra profiles.** Invite other people from the feedback Worker's `/admin` page; they upload a
   CV and get their own daily report, buttons, cover letters and roll-up, run after yours. Every
   report has an **Unsubscribe** link that deletes their profile (or pauses yours)
   ([how it works](../../docs/feedback-worker.md#extra-profiles-and-the-admin-page)).

It only emails when there are new matches or follow-ups due, unless
`JOB_SCANNER_EMAIL_WHEN_EMPTY=1` is set. A job is only marked as seen once it has been rated or
definitely ruled out; ratings that fail are retried on the next runs, up to 4 attempts.

## Files

| File | Purpose |
| --- | --- |
| `job_scanner.py` | Entry point run by the daily cron job |
| `job_weekly.py` | Weekly roll-up email and shared email blocks; entry point for the weekly cron job |
| `job_extras.py` | Salary and closing-date parsing, title screening, second opinions, repost and agency grouping |
| `job_tracker.py` | `state/job_tracker.db` (jobs, feedback, reminders, runs, cover letter requests) and the feedback Worker sync |
| `cover_letter.py` | Cover letter requests: writes each letter with the model and emails it as a PDF; entry point for the 5-minute cron job |
| `letter_pdf.py` | Dependency-free A4 PDF writer for the letters |
| `profiles.py` | Extra profiles: sign-ups from the Worker become profiles built from the CV, unsubscribes, admin changes, per-profile runs; entry point for the 5-minute cron job |
| `cv_text.py` | Dependency-free text extraction from PDF, Word .docx and text CVs |
| `icons/` | Button icons: Lucide SVG sources in `icons/src`, PNGs built by `icons/build_icons.py` |
| `companies.py` | Employer website, logo and profile lookup with caching |
| `feedback-worker/` | Optional Cloudflare Worker for the feedback buttons ([guide](../../docs/feedback-worker.md)); not installed into Hermes |
| `tests/` | Unit tests (`python -m pytest packages/daily-vacancy-report/tests`) |
| `job_profile.example.md` | Template for your candidate profile (copy to `job_profile.md`) |
| `cv_keywords.example.json` | Template for skills to match and gaps to flag (copy to `cv_keywords.json`) |
| `.env.example` | Every package setting with its default |
| `examples/northern-ireland.env` | Complete regional example including nijobs.com and BT postcodes |

It also needs `hermes_common.py` from [`common/`](../../common) in the same directory, which the
installer handles.

## Install

The quickest way is the setup wizard, run from the repository root:

```sh
python3 scripts/setup.py daily-vacancy-report
```

It asks for your email and API keys, then:

- **Where** you're job hunting: region or city, the towns inside it, your country and whether fully remote jobs elsewhere count.
- **What kind of job:** your target level (junior, mid, senior, lead or any), the employment types
  and work modes to keep, a minimum salary, whether to hide agency adverts that don't name the
  employer, and the job titles to search for.
- Your **candidate profile** (guided questions, an imported CV, or the example).
- Optional **feedback buttons and admin page:** with a Cloudflare account ID and API token the
  wizard deploys the Worker, generates its secrets and sets the `/admin` password
  ([automatic setup](../../docs/cloudflare-setup.md)); or paste the URL of a Worker you deployed
  by hand ([the guide](../../docs/feedback-worker.md)).
- **When** the report should run, for example `07:00` or `weekdays 07:30`, when the weekly
  roll-up goes out (default `sunday 18:00`), and how often to check for cover letter requests
  (default every 5 minutes).

It then writes `job_profile.md` and `cv_keywords.json`, schedules the cron job
and sends a test email. See [the installation guide](../../docs/installation.md#setup-wizard).

To install by hand instead, on the machine (or inside the container) running Hermes:

```sh
HERMES_HOME=/opt/data ./scripts/install.sh daily-vacancy-report
cd /opt/data/scripts
cp job_profile.example.md job_profile.md        # then describe yourself
cp cv_keywords.example.json cv_keywords.json    # then list your skills
```

Add the shared settings from the root [`.env.example`](../../.env.example) (SMTP plus at least
one search provider key) to `$HERMES_HOME/.env`. Then add any settings from this package's
`.env.example` that you want to change.

### Try it

```sh
python3 job_scanner.py --test-email              # SMTP check only
python3 job_scanner.py --dry-run --limit 5       # full pipeline, no email, no state update
python3 job_weekly.py --dry-run                  # weekly roll-up, written to state/ only
```

A dry run writes the rendered email to `state/job_scanner_last.html` and the raw results to
`state/job_scanner_last.json`.

### Schedule it

The wizard does this for you. By hand:

```sh
hermes cron create "0 7 * * *" "Daily Vacancy Report" \
    --name daily-vacancy-report --script job_scanner.py --no-agent --deliver local
hermes cron create "0 18 * * 0" "Weekly vacancy roll-up" \
    --name weekly-vacancy-report --script job_weekly.py --no-agent --deliver local
hermes cron create "*/5 * * * *" "Cover letter requests" \
    --name vacancy-cover-letters --script cover_letter.py --no-agent --deliver local
hermes cron create "*/5 * * * *" "Vacancy profiles" \
    --name vacancy-profiles --script profiles.py --no-agent --deliver local
hermes cron list
```

Cron times use Hermes' timezone (`timezone:` in `config.yaml`); without one that is usually UTC.
Use `0 7 * * 1-5` for weekdays only. Cron jobs can't pass arguments to a script, which is why the
weekly roll-up has its own entry point, `job_weekly.py`.

## Command-line options

| Option | Effect |
| --- | --- |
| `--dry-run` | Do everything except send the email and update seen-state |
| `--test-email` | Send a short SMTP test email and exit |
| `--limit N` | Scrape and rate at most N job pages this run |
| `--include-seen` | Re-rate jobs reported in previous runs |
| `--no-search` | Board listings only (nijobs.com); skip web searches |
| `--weekly` | Send the weekly roll-up from `state/job_tracker.db` and exit (with `--dry-run`: write it to `state/job_scanner_weekly.html` only) |
| `--skills` | List the skills you added from the email's missing-skill tags and exit |
| `--remove-skill SKILL` | Remove a skill you added from the email and exit |

## Configuration

Every option is an environment variable (or a line in `$HERMES_HOME/.env`). See
[`.env.example`](.env.example) for the full list with defaults. The most important ones are:

- **`JOB_REGION_NAME`, `JOB_REGION_PLACES`, `JOB_REGION_REGEX`.** Restrict results to one region.
  With none of these set, jobs from any location are kept. `JOB_REMOTE_ANYWHERE=1` also keeps
  fully remote jobs based elsewhere.
- **`JOB_LEVEL`.** The seniority you're targeting: `junior`, `mid`, `senior`, `lead` or `any`
  (the default). Titles above or below it lose fit points, and the model is told your target.
- **`JOB_EMPLOYMENT_TYPES`, `JOB_WORK_MODES`.** Comma-separated lists of what to keep. Defaults:
  `Permanent,Contract,Temporary` and `On-site,Hybrid,Remote`. Add `Part-time` or `Internship` to
  include those; they are then also dropped from the default title exclusions.
- **`JOB_SEARCH_LOCATION`, `JOB_SCANNER_QUERIES`.** Control what gets searched. The default queries
  target AI / ML / automation / data roles, with your location inserted.
- **`JOB_TARGET_TITLES`.** The job titles you want (`||`-separated), set from the dashboard or the
  wizard. Changing them rebuilds `JOB_SCANNER_QUERIES` and `JOB_TITLE_STRONG`.
- **`JOB_TITLE_STRONG`, `JOB_TITLE_MEDIUM`, `JOB_TITLE_EXCLUDE`.** Title regexes deciding which
  results are worth fetching, and which are always skipped. The defaults suit AI / ML / data roles,
  and the exclude list drops internships, sales, recruiters and a few unrelated professions. The
  setup wizard rewrites all three from the job titles you enter.
- **`JOB_JUNIOR_PENALTY`, `JOB_SENIOR_PENALTY`, `JOB_LEAD_PENALTY`.** Fine-tune the points
  `JOB_LEVEL` subtracts for Junior/Graduate, Senior and Lead/Principal titles.
- **`JOB_SCANNER_MIN_SCORE`.** The cut-off (0-10) for a job to appear in the report.
- **`JOB_MIN_SALARY`, `JOB_SALARY_CURRENCY`.** Leave out jobs whose best advertised pay is clearly
  below the minimum (yearly; day rates count 220 days, hourly rates 1950 hours). Jobs without a
  salary, or in another currency, are kept.
- **`JOB_HIDE_UNNAMED_AGENCY`.** `1` drops agency adverts that don't name the employer. Repeats
  of the same job are always merged.
- **`JOB_VERIFY_MIN_FIT`.** Scores at or above this (default 8) get a second look; `0` turns it off.
- **`JOB_SCANNER_MAX_SCRAPE`, `JOB_TRIAGE_MAX`.** How many jobs are rated per run (default 25),
  and how many titles the model screens first (default 60).
- **`JOB_FEEDBACK_URL`, `JOB_FEEDBACK_SECRET`, `JOB_FEEDBACK_API_TOKEN`.** The optional
  feedback buttons. See [docs/feedback-worker.md](../../docs/feedback-worker.md).

### Writing a good profile

`job_profile.md` is sent verbatim to the model for every job. It works best when it states:

- Your current role and years of experience.
- Your concrete skills.
- The titles and seniority you want.
- Your deal-breakers.
- Your honest gaps.

The keys in `cv_keywords.json` are the only labels the model may use as "matched skills". The
regex values are also used to compute keyword coverage directly from the job text. Entries under
`other_tech` are shown as possible gaps.

## Cost and runtime

A typical run uses 4 searches plus up to `JOB_SCANNER_MAX_SCRAPE` page fetches, roughly 20-40
Firecrawl credits; the report footer shows what a run used. When Firecrawl credits drop below `JOB_SCANNER_MIN_CREDITS`, the scanner
switches to your backup keys, then Tavily and Scrapfly. Rating takes 10-40 seconds per job on a
4B model running on a CPU. The title screen adds about a minute per 40 titles, and each second
look on a high score takes about as long as a rating, so a full run of 25 jobs takes roughly
15-30 minutes.

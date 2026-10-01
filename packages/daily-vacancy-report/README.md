# Daily Vacancy Report

A HermitShell package that searches for jobs matching your CV. Your local model (Ollama)
rates each one, and you get a scored, logo-rich HTML email that renders properly in Gmail's
light and dark modes.

![Daily Vacancy Report email](../../docs/images/daily-vacancy-report.png)

*Rendered with the fictional example profile.
[Full-length email](../../docs/images/emails/daily-report.png) · [every email and page](../../docs/screenshots.md).*

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
   passed. A full listing that names none of your CV's keywords is skipped before the model rates it,
   unless the title screen called it a clear match.
4. **Rate.** The model scores each job 0-10 against `job_profile.md`, with a confidence value,
   matched CV keywords, gaps, the closing date and a short reason. For agency adverts it also
   identifies the real employer. Seniority comes from the title, or from the model's reading of
   the listing when the title doesn't say. Scores of 8 or more get a second, stricter look that can
   only lower them, and a score that would be shown but that the model was unsure of gets a second
   look that moves it halfway to the new one. If you use the feedback buttons, your recent likes and rejections are
   added to the prompt as examples.
5. **Enrich.** Adds the hiring company's website, a circular logo and an expandable "About the
   company" section. Lookups are cached for 30 days in `state/companies.json`. The same job
   advertised by several agencies becomes one card that lists the other advertisers.
6. **Email.** Sends a summary, then one card per job with the salary as a headline under the
   company (day and hourly rates also show a yearly estimate), the closing date (jobs closing within
   three days come first), your three strongest matching skills, the skills your CV is missing and a link to
   apply. A banner warns when a source failed (for example a search provider out of credits). With the
   optional [feedback buttons](../../docs/feedback-worker.md), each card also has thumbs up / thumbs
   down by the score, **I applied** and **Interested** next to **View job**, and **Cover letter** and
   **Tailored CV** buttons in a panel below,
   jobs you applied to come back in a follow-up section after 7 and 14 days, and tapping a
   missing-skill tag adds skills you have to your skills pool
   ([how it works](../../docs/feedback-worker.md#adding-missing-skills)).

   <img src="../../docs/images/emails/daily-report-card.png" alt="One job card" width="560">

   What each part of the card means: [docs/screenshots.md](../../docs/screenshots.md#a-job-card).
7. **Cover letters.** Pressing **Cover letter** gets you a tailored A4 PDF letter by email within
   about 5 minutes, written by the model from your profile and the listing
   ([how it works](../../docs/feedback-worker.md#cover-letters)). **Tailored CV** works the same
   way and sends your CV reordered and reworded for that job. Each one is kept for 7 days
   (`COVER_LETTER_KEEP_DAYS`): pressing the button again offers the same PDF to download instead of
   writing another, unless you ask for a new one.

   <img src="../../docs/images/emails/cover-letter.png" alt="Cover letter email" width="300"> <img src="../../docs/images/emails/cover-letter-pdf.png" alt="Cover letter PDF" width="250">
8. **Weekly roll-up.** `job_weekly.py` (or `job_scanner.py --weekly`) emails a Sunday summary from
   `state/job_tracker.db`: best jobs of the week, applications and replies, common gaps, who's
   hiring and source health ([screenshot](../../docs/images/emails/weekly.png)).
9. **Recruits.** Invite people looking for work from the feedback Worker's `/admin` page (you and
   your recruiters are staff who manage them, never recruits yourselves); they upload a
   CV and get their own job search and daily report (their own scheduled job, at a time you set on the
   dashboard), buttons, cover letters and roll-up. **Send jobs now** on the dashboard runs anyone's
   report at once. Each row's little chart opens that person's jobs, answers and applications as
   charts over 7 days to 12 months ([screenshot](../../docs/images/worker/admin-stats.png)), and its
   **sent** count lists the jobs they were sent ([screenshot](../../docs/images/worker/admin-sent.png)); each opens to its
   full card with a cover letter and tailored CV to generate or download, and a button that emails
   the job to them again ([screenshot](../../docs/images/worker/admin-sent-open.png)). Every report has an
   **Unsubscribe** link that deletes their profile (or pauses yours)
   ([how it works](../../docs/feedback-worker.md#recruits-and-the-admin-page)).

It only emails when there are new matches or follow-ups due, unless
`JOB_SCANNER_EMAIL_WHEN_EMPTY=1` is set. A job is only marked as seen once it has been rated or
definitely ruled out; ratings that fail are retried on the next runs, up to 4 attempts.

## Files

| File | Purpose |
| --- | --- |
| `job_scanner.py` | Entry point run by the daily scheduled job |
| `job_weekly.py` | Weekly roll-up email and shared email blocks; entry point for the weekly job |
| `job_extras.py` | Salary and closing-date parsing, title screening, second opinions, repost and agency grouping |
| `job_tracker.py` | `state/job_tracker.db` (jobs, feedback, reminders, runs, cover letter requests) and the feedback Worker sync |
| `cover_letter.py` | Cover letter requests: writes each letter with the model and emails it as a PDF; entry point for the 5-minute job |
| `letter_pdf.py` | Dependency-free A4 PDF writer for the letters |
| `letter_docx.py` | Dependency-free Word (`.docx`) copies of the letters, CVs and prep packs (`DOC_WORD_COPIES`) |
| `profiles.py` | Recruits: sign-ups from the Worker become profiles built from the CV, unsubscribes, admin changes, each profile's report job, Send jobs now; entry point for the 5-minute job |
| `profile_report.py` | One recruit's daily report: the script of its `vacancy-report-<id>` job |
| `key_usage.py` | The credits left on each web search and AI model key (OpenRouter, BazaarLink, Featherless, Hugging Face), from each provider's account endpoint, for the dashboard's Global settings (`python3 key_usage.py` prints them) |
| `alerts.py` | Admin alerts by email (low credits, providers resting, Ollama down, backups, disk, Worker version), run from the profiles job; `--test` sends a test ([admin alerts](../../docs/configuration.md#admin-alerts)) |
| `profile_stats.py` | A profile's daily counts, top lists and recent jobs sent from its tracker, for the dashboard's stats and jobs sent pages |
| `maintenance.py` | Nightly retention, encryption of older files, file permissions and encrypted backups; `--restore`, `--decrypt`, `--new-key` ([data protection](../../docs/configuration.md#data-protection)) |
| `cv_text.py` | Dependency-free text extraction from PDF, Word .docx and text CVs |
| `icons/` | Button icons: Lucide SVG sources in `icons/src`, PNGs built by `icons/build_icons.py` |
| `companies.py` | Employer website, logo and profile lookup with caching |
| `geo.py` | Place data (GeoNames, cached per country) and distances for the [distance from home](#distance-from-home) filter |
| `feedback-worker/` | Optional Cloudflare Worker for the feedback buttons ([guide](../../docs/feedback-worker.md)); deployed to Cloudflare, not installed on the server |
| `jobs.json` | The standard schedule, added when HermitShell first starts (`scheduler.py defaults`) |
| `tests/` | Unit tests (`python -m pytest packages/daily-vacancy-report/tests`) |
| `job_profile.example.md` | Template for your candidate profile (copy to `job_profile.md`) |
| `cv_keywords.example.json` | Template for skills to match and gaps to flag (copy to `cv_keywords.json`) |
| `.env.example` | Every package setting with its default |
| `examples/northern-ireland.env` | Complete regional example including nijobs.com and BT postcodes |

It also needs `hermes_common.py`, `autofit.py` and `scheduler.py` from [`common/`](../../common) in the same
directory, which the installer and the container handle.

## Install

The quickest way is the container ([installation](../../docs/installation.md#run-it-as-a-container)), which
installs this package and its schedule, then the setup wizard:

```sh
docker exec -it hermitshell /app/entrypoint.sh setup      # or, from the repository: python3 scripts/setup.py
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

It then writes `job_profile.md` and `cv_keywords.json`, schedules the jobs
and sends a test email. See [the installation guide](../../docs/installation.md#setup-wizard).

To install by hand instead, into a HermitShell home of your choice:

```sh
HERMITSHELL_HOME=/srv/hermitshell ./scripts/install.sh daily-vacancy-report
cd /srv/hermitshell/scripts
cp job_profile.example.md job_profile.md        # then describe yourself
cp cv_keywords.example.json cv_keywords.json    # then list your skills
```

Add the shared settings from the root [`.env.example`](../../.env.example) (SMTP plus at least
one search provider key) to `$HERMITSHELL_HOME/.env`. Then add any settings from this package's
`.env.example` that you want to change.

### Try it

```sh
python3 job_scanner.py --test-email              # SMTP check only
python3 job_scanner.py --dry-run --limit 5       # full pipeline, no email, no state update
python3 job_weekly.py --dry-run                  # weekly roll-up, written to state/ only
```

A dry run writes the rendered email to `state/job_scanner_last.html` and the raw results to
`state/job_scanner_last.json`. Like CVs and letters they are readable by their owner only and, with
`HERMES_DATA_KEY` set, encrypted; `python3 maintenance.py --decrypt state/job_scanner_last.html --out /tmp/report.html`
gives a copy to open.

### Schedule it

The container, the service installer and the wizard do this for you. By hand, `python3 scheduler.py defaults`
adds the standard schedule from [`jobs.json`](jobs.json), or choose the times:

```sh
python3 scheduler.py create "0 7 * * *" "Daily Vacancy Report" --name daily-vacancy-report --script job_scanner.py
python3 scheduler.py create "0 18 * * 0" "Weekly vacancy roll-up" --name weekly-vacancy-report --script job_weekly.py
python3 scheduler.py create "*/5 * * * *" "Cover letter requests" --name vacancy-cover-letters --script cover_letter.py
python3 scheduler.py create "*/5 * * * *" "Extra profiles" --name vacancy-profiles --script profiles.py
python3 scheduler.py create "30 3 * * *" "Nightly maintenance" --name vacancy-maintenance --script maintenance.py
python3 scheduler.py list
python3 scheduler.py run          # keep it running (the container and the service do this)
```

### Backups and restores

`maintenance.py` backs everything up each night into `$HERMITSHELL_HOME/backups/nightly` (or
`HERMES_BACKUP_DIR`), encrypted with `HERMES_DATA_KEY`:

```sh
python3 maintenance.py --list-backups
python3 maintenance.py --restore ../backups/nightly/hermitshell-20260501-033000.tar.gz.enc --to /tmp/restore
python3 maintenance.py --decrypt state/profiles/<id>/cv.txt     # print one encrypted file
```

A restore unpacks into an empty folder; copy back what you need. Without the key the backups
can't be opened, so keep a copy of it in a password manager. The dashboard's server panel shows the
last backup and has **Back up now** (`python3 maintenance.py --backup-now`).

Schedule times are in `HERMES_TIMEZONE` (default UTC). Use `0 7 * * 1-5` for weekdays only. Scheduled jobs
can't pass arguments to a script, which is why the weekly roll-up has its own entry point, `job_weekly.py`.

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

Every option is an environment variable (or a line in `$HERMITSHELL_HOME/.env`). See
[`.env.example`](.env.example) for the full list with defaults. The most important ones are:

- **`JOB_REGION_NAME`, `JOB_REGION_PLACES`, `JOB_REGION_REGEX`.** Restrict results to one region.
  With none of these set, jobs from any location are kept. `JOB_REMOTE_ANYWHERE=1` also keeps
  fully remote jobs based elsewhere.
- **`JOB_MAX_DISTANCE_KM`.** Keep jobs within this many km of the recruit's Home town instead; see
  [Distance from home](#distance-from-home).
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
  salary are kept.
- **`JOB_SALARY_CURRENCY`, `JOB_FX_URL`.** The currency salaries are shown in: `GBP`, `EUR`, `USD`,
  `CAD`, `AUD` or `NZD`. A job advertised in another of them shows the converted figure with the
  advertised one beside it ("$59,600 - $72,900 a year, converted from £45,000 - £55,000"), and the
  minimum applies to the converted figure. The salary icon shows the currency's symbol. Rates are
  the European Central Bank's, from [Frankfurter](https://frankfurter.dev), fetched once a day;
  without them, salaries in other currencies are shown as advertised and kept. A bare `$` is read as
  the profile's dollar, else the search country's, else US dollars.
- **`JOB_HIDE_UNNAMED_AGENCY`.** `1` drops agency adverts that don't name the employer. Repeats
  of the same job are always merged.
- **`JOB_VERIFY_MIN_FIT`.** Scores at or above this (default 8) get a second look; `0` turns it off.
- **`JOB_VERIFY_BELOW_CONFIDENCE`.** A shown score with a confidence under this (default 60) gets a
  second look too; `0` turns it off.
- **`JOB_PRESCREEN_MIN_KEYWORDS`.** A full listing naming fewer of your CV's keywords than this
  (default 1) is not rated; `0` turns it off.
- **`JOB_SCANNER_MAX_SCRAPE`, `JOB_TRIAGE_MAX`.** How many jobs are rated per run (default 25),
  and how many titles the model screens first (default 60).
- **`JOB_FEEDBACK_URL`, `JOB_FEEDBACK_SECRET`, `JOB_FEEDBACK_API_TOKEN`.** The optional
  feedback buttons. See [docs/feedback-worker.md](../../docs/feedback-worker.md).

### Distance from home

A recruit's job search can keep jobs within a set distance of their Home town, as the crow flies: the
**Within N km of home town** field on their profile page (`JOB_MAX_DISTANCE_KM`, a whole number up to
500; empty or `0` is off). It needs the profile's Country and Home town.

- **Place data.** The first scan that needs it downloads the country's list of places from
  [GeoNames](https://www.geonames.org/) (`https://download.geonames.org/export/dump/<CC>.zip`,
  Creative Commons Attribution 4.0). Only the country is named in the request. Towns and cities with
  at least 500 people, and every administrative seat, are kept in `state/geo/<cc>.json.gz`, shared by
  every recruit and refreshed every 180 days. GeoNames publishes no checksums, so a download over 50 MB,
  or over 300 MB once unpacked, is refused, and so is a file whose rows don't have GeoNames' 19 columns,
  valid positions and the right country. A failed refresh keeps the old copy, and a failed download is
  tried again after a day.
- **Matching.** The job's location line is matched to a place, the longest name first ("Newcastle upon
  Tyne" before "Newcastle"). A name several places share means the one in the Home town's region, else
  the most populous. The distance is the great-circle (haversine) distance to the Home town.
- **What decides.** Where the job's town is found, its distance decides instead of the region and towns.
  Remote and hybrid jobs, jobs with no location line and towns that aren't found still go by the region
  filter, so a place missing from the data never hides a job the region would keep.
- **Doctor.** `python3 doctor.py --only commute` warns for each recruit whose filter can't work (no
  Country, a Home town that isn't found, or no place data); their scans use the region filter until it's
  fixed.

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

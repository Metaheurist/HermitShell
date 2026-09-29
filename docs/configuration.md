# Configuration

Every HermitShell setting is an environment variable. Nothing personal is hard-coded.

The [setup wizard](installation.md#setup-wizard) (`python3 scripts/setup.py`) writes all of these
for you and can be re-run to change them. It reads the settings, their help text and their
defaults straight from the `.env.example` files. Settings tagged `# @basic` are asked by
default, settings tagged `# @wizard` are filled in by guided steps (job search, job titles, profile and
the Cloudflare Worker), and every remaining setting is asked with `--advanced`.

## Where settings come from

When they conflict, higher entries in this list win:

1. **Process environment.** For example, container `environment:` entries in
   `docker-compose.yml`. This is the recommended place for secrets.
2. **`$HERMES_HOME/.env`.** Loaded by `hermes_common` when a package starts. Lines are
   `KEY=value`; blank values are ignored, and values may be wrapped in single or double quotes.
3. **Built-in defaults.** These are neutral: no region, UTC, generic titles.

Regexes are read literally, so write `\b` rather than `\\b`.

The model, Ollama host and context size come from Hermes' own `$HERMES_HOME/config.yaml` (the
`model:` block), so the job finder automatically uses whatever model Hermes uses. Resolution order:

| Setting | Order |
| --- | --- |
| Model | `JOB_SCANNER_MODEL` (or `COVER_LETTER_MODEL`) → `config.yaml model.default` → `OLLAMA_MODEL` → `qwen3:4b-instruct-2507-q4_K_M` |
| Host | `config.yaml model.base_url` → `OLLAMA_HOST` (`http://ollama:11434`) → `OLLAMA_FALLBACK_HOST` (`http://localhost:11434`) |

The first host that responds and has one of the candidate models is used.

Every model request, from every script and every profile, joins one shared queue, so extra
profiles, cover letters and sign-ups never pile up on Ollama at the same time. Requests run one at
a time (`HERMES_MODEL_CONCURRENCY`) in arrival order, except that ones a person is waiting for
(cover letters, tailored CVs, new profiles) go ahead of background job ratings. A running request
is never interrupted, and a crashed script's place in the queue is freed automatically. Runs that
had to wait log `Waited 42s for the model (shared queue)`.

## Shared settings

Full template: [`.env.example`](../.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `SMTP_HOST` / `SMTP_PORT` | `smtp.gmail.com` / `587` | STARTTLS SMTP server |
| `SMTP_USER` / `SMTP_PASSWORD` | none | SMTP login. For Gmail, use an App Password |
| `SMTP_FROM` | `SMTP_USER` | Sender address |
| `ALERT_EMAIL` | `SMTP_USER` | Recipient |
| `FIRECRAWL_API_KEY` | none | Primary search and scrape provider |
| `FIRECRAWL_BACKUP_KEYS` | none | Comma-separated extra Firecrawl keys for when credits run low |
| `TAVILY_API_KEY` | none | Backup search and page extraction |
| `SCRAPFLY_API_KEY` | none | Backup scraping for bot-protected pages |
| `WEB_SEARCH_ORDER` | `firecrawl,tavily` | Search provider priority |
| `WEB_SCRAPE_ORDER` | `firecrawl,scrapfly,tavily` | Scrape provider priority |
| `SCRAPFLY_COUNTRY` | none | Scrapfly proxy country (two-letter code) for geo-blocked sites |
| `OLLAMA_HOST` / `OLLAMA_FALLBACK_HOST` / `OLLAMA_MODEL` | see above | Model fallbacks |
| `HERMES_MODEL_CONCURRENCY` | `1` | Model requests allowed at once across all scripts and profiles; the rest queue |
| `HERMES_TIMEZONE` | `UTC` | IANA timezone for dates shown in emails |
| `HERMES_STATE_DIR` | `<scripts>/state` | Seen-state, caches and last reports |
| `HERMES_HOME` | parent of the scripts directory | Where `.env` and `config.yaml` are read from. Environment only |
| `HERMES_DATA_KEY` | none (the wizard generates one) | Encrypts CVs, profiles, letters and backups. See [Data protection](#data-protection) |
| `HERMES_RETENTION_DAYS` | `365` | Jobs, answers, letters and tailored CVs untouched this long are deleted. `0` = keep forever |
| `HERMES_LOG_RETENTION_DAYS` | `90` | Logs and scheduled-job output older than this are deleted. `0` = keep forever |
| `HERMES_BACKUP_DIR` | `$HERMES_HOME/backups/nightly` | Where the nightly backups go. Point it at a second disk or a mounted share for an off-machine copy |
| `HERMES_BACKUP_KEEP_DAILY` / `HERMES_BACKUP_KEEP_WEEKLY` | `14` / `8` | Newest backups kept, plus the newest of each week for this many more weeks |

## Job finder settings

- Daily Vacancy Report: [`packages/daily-vacancy-report/.env.example`](../packages/daily-vacancy-report/.env.example),
  plus a regional example in
  [`examples/northern-ireland.env`](../packages/daily-vacancy-report/examples/northern-ireland.env).

### Job search (Daily Vacancy Report)

| Variable | Default | Purpose |
| --- | --- | --- |
| `JOB_REGION_NAME` | none | Region or city you're job hunting in. Empty = no location filter |
| `JOB_REGION_PLACES` | none | Comma-separated towns or areas that count as inside the region |
| `JOB_SEARCH_COUNTRY` | none | Two-letter country code for searches (`gb`, `ie`, `us`...) |
| `JOB_REMOTE_ANYWHERE` | `0` | `1` lets fully remote jobs through the region filter |
| `JOB_LEVEL` | `any` | `junior`, `mid`, `senior`, `lead` or `any`. Sets the seniority penalties below |
| `JOB_EMPLOYMENT_TYPES` | `Permanent,Contract,Temporary` | Types to keep: also `Full-time`, `Part-time`, `Internship`. Jobs that don't say are kept |
| `JOB_WORK_MODES` | `On-site,Hybrid,Remote` | Work modes to keep. Jobs that don't say are kept |
| `JOB_JUNIOR_PENALTY` / `JOB_SENIOR_PENALTY` / `JOB_LEAD_PENALTY` | from `JOB_LEVEL` | Fit points subtracted for Junior/Graduate, Senior and Lead/Principal titles |
| `JOB_MIN_SALARY` | `0` | Minimum yearly salary; jobs clearly paying less are left out. Unlisted salaries are kept |
| `JOB_SALARY_CURRENCY` | none | Currency symbol of the minimum (`£`, `€`, `$`...). Other currencies are kept |
| `JOB_HIDE_UNNAMED_AGENCY` | `0` | `1` drops agency adverts that don't name the employer |
| `JOB_VERIFY_MIN_FIT` | `8` | Scores at or above this get a second, stricter look (averaged). `0` = off |

`JOB_LEVEL` sets the three penalties (junior, senior, lead titles) like this: `junior` 0/2/3,
`mid` 1/1/2, `senior` 2/0/1, `lead` 3/1/0 and `any` 0/0/0. Setting one of the penalty variables
overrides just that value. When the title doesn't state a level, the model's reading of the
listing is used instead, with the penalty capped at 1. The target level, types, modes and region
are also given to the model when it scores each job.

Salaries are read from the listing (or the model's summary of it): ranges, `45k`, day rates
(×220) and hourly rates (×1950) are all converted to a yearly figure, and a job is only dropped
when its best case is below the minimum.

### Feedback buttons (Daily Vacancy Report)

| Variable | Default | Purpose |
| --- | --- | --- |
| `JOB_FEEDBACK_URL` | none | Your feedback Worker, e.g. `https://vacancy-feedback.<subdomain>.workers.dev`. Must start with `https://`. Empty = no buttons |
| `JOB_FEEDBACK_SECRET` | none | Signs the button links; the Worker holds the same value |
| `JOB_FEEDBACK_API_TOKEN` | none | Lets Hermes fetch and clear answers from the Worker |
| `CLOUDFLARE_ACCOUNT_ID` | none | Account the wizard and `scripts/cloudflare_worker.py` deploy the Worker to |
| `CLOUDFLARE_API_TOKEN` | none | API token for that deployment (Workers Scripts Edit, Workers KV Storage Edit; Access: Apps and Policies Edit for Access). Not changeable from the dashboard |
| `CLOUDFLARE_WORKER_NAME` | `vacancy-feedback` | Worker name, the first part of its `workers.dev` address |
| `CLOUDFLARE_ACCESS_EMAILS` | none | Emails Cloudflare Access lets through to `/admin`; empty = password only |

The wizard generates both secrets and, with a Cloudflare token, deploys the Worker itself
([cloudflare-setup.md](cloudflare-setup.md)). Deploying by hand (with the Cloudflare MCP in an AI
agent, or with wrangler) is covered in [feedback-worker.md](feedback-worker.md).

### Schedules

Run times aren't `.env` settings: they are `hermes cron` jobs. The wizard asks for the report's run
time (`07:30`, `weekdays 08:00`, `sunday 18:00` or a cron expression) and creates or updates
the job. There are four more jobs: the weekly roll-up (`job_weekly.py`, default Sunday
18:00), the cover letter and tailored CV requests check (`cover_letter.py`) and the profiles
check (`profiles.py`), both every 5 minutes and silent when idle, and nightly maintenance
(`maintenance.py`, 03:30). In an unattended `--answers` file, use `SCHEDULE_DAILY_VACANCY_REPORT`,
`SCHEDULE_DAILY_VACANCY_REPORT_WEEKLY`, `SCHEDULE_DAILY_VACANCY_REPORT_LETTERS`,
`SCHEDULE_DAILY_VACANCY_REPORT_PROFILES` and `SCHEDULE_DAILY_VACANCY_REPORT_MAINTENANCE`.

## Data protection

What the people you invite are told is in [PRIVACY.md](../PRIVACY.md) (the Worker serves the same
text at `/privacy`, linked from the sign-up form, the welcome email and the unsubscribe page).
This is how it is carried out:

- **Encryption at rest.** With `HERMES_DATA_KEY` set, each profile's `profile.json`,
  `settings.json`, `cv.txt`, `job_profile.md` and `cv_keywords.json`, the tailored-CV cache and
  every cover letter and tailored CV are written encrypted (AES-256-GCM, via the `cryptography`
  package that Hermes already bundles). Files written before the key was set are encrypted by the
  next maintenance run. Your own `job_profile.md` and `cv_keywords.json` in the scripts folder stay
  plain so you can edit them, as does the tracker database. The uploaded CV file is deleted once its
  text is read.
- **The key.** The wizard generates it (or run `python3 maintenance.py --new-key`) and writes it to
  `.env`. Keep a copy in a password manager: without it the encrypted files and backups can't be
  read. Don't change it once set; `maintenance.py --decrypt FILE` opens a single file.
- **Permissions.** The scripts create files readable by Hermes' account only, and maintenance
  resets everything under `state/`, the profiles folder and the backups to `0600`/`0700`.
- **Retention.** Maintenance deletes tracker jobs with no sighting, answer or letter for
  `HERMES_RETENTION_DAYS` (with their answers), older cover letters and tailored CVs, and logs and
  scheduled-job output older than `HERMES_LOG_RETENTION_DAYS`. Deleted database rows are
  overwritten and the file compacted. The skills you added are kept.
- **Backups.** Every night `.env`, `config.yaml`, `SOUL.md`, memories, cron jobs and the scripts
  folder with its state go into one encrypted archive in `HERMES_BACKUP_DIR`, rotated to 14 daily
  and 8 weekly copies. On a single disk, set `HERMES_BACKUP_DIR` to another disk or copy the folder
  elsewhere. Restore with `python3 maintenance.py --restore FILE --to EMPTY_DIR`, then copy back
  what you need.
- **Unsubscribe and deletion.** An extra profile's unsubscribe link, or Delete on `/admin`,
  removes its folder (profile, CV, tracker, letters, keys) within about 5 minutes, drops its
  answers still waiting on the Worker, replaces its name, email address and profile id with
  `[deleted]` in the logs, and emails the person a confirmation. Your own unsubscribe link only
  pauses your reports. `profiles.py --delete ID` does the same from the command line.

## Keeping secrets safe

- Prefer container environment variables for keys and passwords, and keep `$HERMES_HOME/.env`
  readable only by the Hermes user (`chmod 600`). The nightly backup includes `.env`, which is
  one more reason to keep `HERMES_DATA_KEY` set.
- Never commit a filled-in `.env`, `job_profile.md` or `cv_keywords.json`. The repo's
  `.gitignore` already excludes them.
- Logs show only the index and a masked prefix and suffix of the Firecrawl key in use, never the
  full key.
- The feedback secrets live only in `.env` and in the Worker's encrypted secrets. The wizard
  pipes them to `wrangler secret put` instead of printing them, and your KV namespace ID belongs
  in the untracked `feedback-worker/wrangler.local.jsonc`.
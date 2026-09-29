# Configuration

Every HermitShell setting is an environment variable. Nothing personal is hard-coded.

The [setup wizard](installation.md#setup-wizard) (`python3 scripts/setup.py`) writes all of these
for you and can be re-run to change them. It reads the settings, their help text and their
defaults straight from the `.env.example` files. Settings tagged `# @basic` are asked by
default, settings tagged `# @wizard` are filled in by guided steps (job search, job titles and
news topics), and every remaining setting is asked with `--advanced`.

## Where settings come from

When they conflict, higher entries in this list win:

1. **Process environment.** For example, container `environment:` entries in
   `docker-compose.yml`. This is the recommended place for secrets.
2. **`$HERMES_HOME/.env`.** Loaded by `hermes_common` when a package starts. Lines are
   `KEY=value`; blank values are ignored, and values may be wrapped in single or double quotes.
3. **Built-in defaults.** These are neutral: no region, UTC, generic titles.

Regexes are read literally, so write `\b` rather than `\\b`.

The model, Ollama host and context size come from Hermes' own `$HERMES_HOME/config.yaml` (the
`model:` block), so the packages automatically use whatever model Hermes uses. Resolution order:

| Setting | Order |
| --- | --- |
| Model | `<PACKAGE>_MODEL` → `config.yaml model.default` → `OLLAMA_MODEL` → `qwen3:4b-instruct-2507-q4_K_M` |
| Host | `config.yaml model.base_url` → `OLLAMA_HOST` (`http://ollama:11434`) → `OLLAMA_FALLBACK_HOST` (`http://localhost:11434`) |

The first host that responds and has one of the candidate models is used.

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
| `HERMES_TIMEZONE` | `UTC` | IANA timezone for dates shown in emails |
| `HERMES_STATE_DIR` | `<scripts>/state` | Seen-state, caches and last reports |
| `HERMES_HOME` | parent of the scripts directory | Where `.env` and `config.yaml` are read from. Environment only |

## Package settings

- Daily Vacancy Report: [`packages/daily-vacancy-report/.env.example`](../packages/daily-vacancy-report/.env.example),
  plus a regional example in
  [`examples/northern-ireland.env`](../packages/daily-vacancy-report/examples/northern-ireland.env).
- News Digest: [`packages/news-digest/.env.example`](../packages/news-digest/.env.example).

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

The wizard generates both secrets. Deploying the Worker (with the Cloudflare MCP in an AI agent,
or with wrangler by hand) is covered in [feedback-worker.md](feedback-worker.md).

### Topics (News Digest)

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEWS_DIGEST_TOPICS` | `ai,ml,python,iot,newtech` | Catalog topic ids, in email order |
| `NEWS_DIGEST_CUSTOM_TOPICS` | none | Your own topics: `Title: keyword, keyword \|\| Title 2: keyword` |
| `NEWS_DIGEST_SECTIONS_FILE` | none | JSON sections file that replaces both of the above |

Catalog ids: `ai`, `ml`, `python`, `iot`, `newtech`, `security`, `cloud`, `programming`,
`webdev`, `data`, `opensource`, `smarthome`, `robotics`, `space`, `science`, `climate`,
`health`, `business`, `markets`, `policy`, `world`, `gaming` and `sport`. See the
[package README](../packages/news-digest/README.md#topics) for what each covers.

### Schedules

Run times aren't `.env` settings: they are `hermes cron` jobs. The wizard asks for a time per
package (`07:30`, `weekdays 08:00`, `sunday 18:00` or a cron expression) and creates or updates
the job. The vacancy report has two more jobs: its weekly roll-up (`job_weekly.py`, default
Sunday 18:00) and the cover letter requests check (`cover_letter.py`, default every 5 minutes,
silent when idle). In an unattended `--answers` file, use `SCHEDULE_DAILY_VACANCY_REPORT`,
`SCHEDULE_DAILY_VACANCY_REPORT_WEEKLY`, `SCHEDULE_DAILY_VACANCY_REPORT_LETTERS` and
`SCHEDULE_NEWS_DIGEST`.

## Keeping secrets safe

- Prefer container environment variables for keys and passwords, and keep `$HERMES_HOME/.env`
  readable only by the Hermes user (`chmod 600`).
- Never commit a filled-in `.env`, `job_profile.md` or `cv_keywords.json`. The repo's
  `.gitignore` already excludes them.
- Logs show only the index and a masked prefix and suffix of the Firecrawl key in use, never the
  full key.
- The feedback secrets live only in `.env` and in the Worker's encrypted secrets. The wizard
  pipes them to `wrangler secret put` instead of printing them, and your KV namespace ID belongs
  in the untracked `feedback-worker/wrangler.local.jsonc`.
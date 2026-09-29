# Changelog

All notable changes to HermitShell are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and packages are versioned together
using [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Vacancy report feedback buttons** (optional):
  - Each job card gets **Interested**, **Not for me** and **I applied** buttons, and follow-up
    reminders get **Heard back** and **Rejected**.
  - The buttons are signed links to a small Cloudflare Worker
    (`packages/daily-vacancy-report/feedback-worker`, with Vitest tests). Opening a link only
    shows a confirmation page with an optional note, so mail scanners can't record answers.
  - Answers are kept in Workers KV until the next run fetches them (`/events`, then `/ack`,
    both behind a bearer token). Nothing on the Hermes server is exposed.
  - Set up with `JOB_FEEDBACK_URL`, `JOB_FEEDBACK_SECRET` and `JOB_FEEDBACK_API_TOKEN`. New guide,
    [docs/feedback-worker.md](docs/feedback-worker.md), covers deploying with the Cloudflare MCP
    in an AI agent or with wrangler by hand.
- **`state/job_tracker.db`** (`job_tracker.py`, SQLite) records rated and emailed jobs, feedback,
  reminders and run statistics:
  - Recent liked and rejected jobs, with your reasons, are added to the rating prompt as
    examples.
  - Jobs you applied to come back in a "Follow up" section after 7 and 14 days.
- **Weekly roll-up.** `job_weekly.py` (also `job_scanner.py --weekly`) emails the week's best
  jobs, applications and replies, common gaps, who's hiring, the score spread and source
  health. The wizard schedules it (default `sunday 18:00`).
- **Salary filter.** `JOB_MIN_SALARY` and `JOB_SALARY_CURRENCY` leave out jobs clearly paying
  less than your minimum. Ranges, `45k`, day rates and hourly rates are converted to a yearly
  figure, and unlisted salaries are kept.
- **Closing dates.** Read from the listing, shown as a pill on each card (red within three days),
  and used to put jobs closing soon first. Jobs that have already closed are skipped.
- **Title screening.** Before rating, the model screens up to `JOB_TRIAGE_MAX` (default 60)
  relevant titles in quick batches, so the rating budget goes to the most promising jobs.
- **Second opinion** on scores of `JOB_VERIFY_MIN_FIT` (default 8) or more: a stricter re-check,
  averaged with the first score.
- **Agency grouping.** The same job advertised by several agencies becomes one card listing the
  other advertisers. `JOB_HIDE_UNNAMED_AGENCY=1` drops agency adverts that don't name the
  employer.
- **Source health.** Jobs found and errors per source (Indeed, nijobs.com, web search) appear in
  the footer, and a warning banner explains failures, such as an expired Indeed login and how to
  fix it.
- **Setup wizard:** minimum salary, currency and unnamed-agency questions; a feedback-buttons
  step that generates both secrets and pipes them to `wrangler secret put` without showing them;
  a weekly roll-up schedule; and `<day> HH:MM` run times such as `sunday 18:00`
  (`SCHEDULE_DAILY_VACANCY_REPORT_WEEKLY` in answers files).
- **Tests** for the vacancy report helpers (`packages/daily-vacancy-report/tests`) and the
  feedback Worker (`npm test`).
- **CI** (`.github/workflows/ci.yml`), on every push and pull request, with one named job per
  check:
  - Ruff lint (`ruff.toml`) and a compile check on Python 3.10.
  - Unit tests for the shared library, vacancy report, news digest and setup wizard, each on
    Python 3.10 and 3.12, with a results table in the run summary.
  - The feedback Worker's Vitest tests, then a `wrangler deploy --dry-run` build check.
  - An "All CI checks passed" job to use as a single required check.
- **Security workflow** (`.github/workflows/security.yml`), on every push and pull request and
  every Monday: Gitleaks secret scan of the full history, `pip-audit` and `npm audit` CVE
  checks, dependency review on pull requests, and CodeQL scanning of Python, JavaScript and the
  workflows.
- **More tests:** the shared library (`common/tests`), the News Digest
  (`packages/news-digest/tests`) and the setup wizard (`scripts/tests`), which also checks that
  no `.env.example` ships a real-looking secret. `requirements-dev.txt` lists the test
  dependencies.
- **Setup wizard** (`scripts/setup.py`, standard library only):
  - Installs the chosen packages, then asks for SMTP details, web search API keys (typed
    without echo, shown masked), timezone and each package's settings.
  - Settings, help text and defaults come from the `.env.example` files: `# @basic` settings
    are asked by default, and `--advanced` asks for everything.
  - Vacancy report steps: turn your job titles into Indeed searches, web queries and title
    filters; build `job_profile.md` from guided questions, an imported CV or the example;
    generate `cv_keywords.json` from your skills and gaps; add and log in to the Indeed MCP
    server.
  - Guided job search step: region, towns, country (which also sets the Indeed site and
    country), remote-anywhere, target level, employment types and work modes.
  - News topics step: pick from the topic catalog by number, then add your own topics.
  - Asks what time each package should run (`07:30`, `weekdays 08:00` or a cron expression) and
    creates or updates the `hermes cron` jobs, then sends a test email and offers a dry run.
    Unattended runs take `SCHEDULE_<PACKAGE>` from the answers file.
  - Migrates `TECH_DIGEST_*` settings and the old digest cron job to the renamed News Digest.
  - Works locally or from a Docker host: runs `hermes` in the `hermes-agent` container and
    matches file ownership to the Hermes home.
  - Backs up `.env` before writing, updates it in place (other Hermes settings untouched) and
    keeps it at mode 600.
  - Safe to re-run: current values are the defaults.
  - `--dry-run`, `--non-interactive --answers FILE`, `--no-install` and `--no-cron` options.
- **`JOB_TITLE_EXCLUDE`** makes the vacancy report's always-skip title filter configurable. It
  used to be hard-coded, including professions like nurse and teacher.
- **Vacancy report job preferences:**
  - `JOB_LEVEL` (junior, mid, senior, lead or any) sets fit penalties for titles above or below
    your level. The new `JOB_JUNIOR_PENALTY` joins the senior and lead penalties, which now
    default to the level's values.
  - `JOB_EMPLOYMENT_TYPES` and `JOB_WORK_MODES` choose which types (now including part-time and
    internships) and modes to keep. They replace the hard-coded "full-time permanent, contract or
    temporary" rule.
  - `JOB_REMOTE_ANYWHERE` lets fully remote jobs through the region filter.
  - The model is told the target level, types, modes and region when scoring, and its rubric no
    longer assumes an AI / ML role.
- **News Digest topic catalog:** 23 topics to choose from with `NEWS_DIGEST_TOPICS`, adding
  cybersecurity, cloud, programming, web development, data, open source, smart home, robotics,
  space, science, climate, health, business, markets, tech policy, world news, gaming and sport
  to the original five, each with its own sites, queries, colour and icon. Also
  `NEWS_DIGEST_CUSTOM_TOPICS` for keyword-based topics of your own.

### Changed (breaking)

- **Noon Tech Digest is now News Digest.** The package is `packages/news-digest`, the script
  `news_digest.py`, the settings `NEWS_DIGEST_*` (previously `TECH_DIGEST_*`), the default cron
  job `news-digest` and the state files `state/news_digest_*`. Re-run `scripts/setup.py` to
  migrate settings and the cron job; see the [upgrade notes](packages/news-digest/README.md#upgrading-from-noon-tech-digest).
- The digest's default reader and editor prompt are no longer tech-specific, and the tagline is
  built from the chosen topic names.

- **Indeed MCP source for the Daily Vacancy Report** (`packages/daily-vacancy-report/indeed_mcp.py`):
  - Searches Indeed through the Indeed MCP server connected to Hermes, and fetches full job
    descriptions with the MCP job-detail tool instead of scraping, so it uses no web credits.
  - Reuses Hermes' OAuth provider and tokens (`hermes mcp login indeed`). The package holds no
    credentials, and token refreshes stay coordinated with the Hermes gateway.
  - Tool and argument names are discovered from the server's tool list, with
    `JOB_INDEED_SEARCH_TOOL` / `JOB_INDEED_DETAIL_TOOL` overrides.
  - Configured through `JOB_INDEED`, `JOB_INDEED_MCP_SERVER`, `JOB_INDEED_MCP_URL`,
    `JOB_INDEED_QUERIES`, `JOB_INDEED_LOCATION`, `JOB_INDEED_COUNTRY`, `JOB_INDEED_LIMIT`,
    `JOB_INDEED_DAYS`, `JOB_INDEED_DOMAIN` and `JOB_INDEED_TIMEOUT`.
  - New `--no-indeed` flag. The report footer counts Indeed MCP calls.
  - Indeed job keys (`jk`) are used for seen-state, so the same posting found by web search and
    by the MCP source is only rated once.
- **Documentation.** An "Indeed MCP source" setup section in the package README, an "MCP
  sources" section in the configuration guide, and an optional step in the installation guide.

### Changed

- Vacancy report cards show the three strongest matching skills in bold (the rest as one line),
  the biggest gap, "Salary not listed" when there's no salary, and the closing date.
- `JOB_SCANNER_MAX_SCRAPE` now defaults to 25 (was 15).
- When a title doesn't state a seniority, the model's reading of the listing counts too, with the
  `JOB_LEVEL` penalty capped at 1.
- The same role at the same company is skipped across boards and days, not just by URL.
- The model can no longer rule a job out of the region when its title or snippet names a place
  inside it.
- Web search titles lose trailing "- Job <Month> <Year>" suffixes.
- An unauthorised, unreachable or missing Indeed MCP server is logged and skipped, and the other
  sources still run.
- Relative `JOB_PROFILE_FILE`, `JOB_KEYWORDS_FILE` and `TECH_DIGEST_SECTIONS_FILE` paths are
  resolved against the scripts directory instead of the working directory, so they also work
  under cron.
- `install.sh` points to the setup wizard when it finishes. `.env.example` files mark the
  essential settings with `# @basic`, and the settings filled in by the job-targets step with
  `# @wizard`.

### Fixed

- Jobs whose rating failed (model timeout or bad JSON) were marked as seen and never shown. They
  are now retried on the following runs, up to 4 attempts (`state/job_scanner_retry.json`).
  Only jobs that were rated or definitely ruled out are marked as seen.
- A broken table row and a missing blank line in `docs/configuration.md`.
- The setup wizard showed the first and last four characters of a stored secret, half of a
  16-character app password. It now shows only the last four, and only for secrets of 16 or more
  characters (found by CodeQL).
- LinkedIn search results showed the page title ("Acme hiring Data Engineer Job in Belfast") instead
  of the job title.
- Gmail clipped long reports ("[Message clipped]") partway through, hiding the later jobs and
  their buttons and showing their logos as loose attachments. `send_email()` now compacts
  emails over 95 KB by moving repeated inline styles into Gmail-safe classes, so they render the
  same at about half the size. If the vacancy report is still too big, the lowest-ranked jobs
  become one-line "More matches" entries. See
  [docs/email-rendering.md](docs/email-rendering.md#size-staying-under-gmails-clipping-limit).
- The Indeed sign-in warning repeated "Run `hermes mcp login indeed`" when the error already
  said so.

## [0.1.0] - 2026-09-28

First public release. Two packages are ported from a private Hermes deployment and made fully
configurable, with no credentials, personal details or network addresses in the code.

### Added

- **Repository scaffolding.** README, this changelog, `.gitignore` (excludes `.env`, profiles and
  `state/`), `.gitattributes` (LF endings) and the `scripts/install.sh` installer.
- **Documentation.** [Installation](docs/installation.md), [configuration](docs/configuration.md),
  [web providers](docs/web-providers.md), [email rendering](docs/email-rendering.md) and
  screenshots from dry runs in `docs/images/`.
- **`common/hermes_common.py`**, the shared library:
  - Loads `$HERMES_HOME/.env` automatically on import, without overriding real environment
    variables.
  - Discovers the model from Hermes' `config.yaml`, with package, `OLLAMA_MODEL` and default
    fallbacks. Ollama hosts come from `config.yaml`, then `OLLAMA_HOST`, then
    `OLLAMA_FALLBACK_HOST`.
  - `WebClient` uses Firecrawl with backup keys, then Tavily and Scrapfly. Provider order is
    configurable, and a provider is dropped automatically when its credits run out.
  - `ollama_chat` supports JSON-schema output, and generated text is cleaned of em and en dashes.
  - SMTP sending uses inline (CID) images, with a configurable `SMTP_FROM` and `ALERT_EMAIL`.
  - The Gmail dark-mode header fix: `EMAIL_HEAD` and `gmail_dark_safe`.
  - `HERMES_STATE_DIR` relocates all runtime state.
- **Daily Vacancy Report** (`packages/daily-vacancy-report`):
  - Discovers jobs through web searches and optional nijobs.com keyword listings, with title
    pre-filtering and 90-day seen-state.
  - Hermes' model rates each job 0-10 against a candidate profile, with confidence, matched CV
    keywords, gaps and the real employer behind agency adverts.
  - Optional region filter, configured by place list or regex. With no region set, every
    location is kept.
  - Company enrichment: website, circular logo and an "About the company" section, cached for
    30 days.
  - Everything personal is configurable through `JOB_*` variables: report title, tagline,
    candidate name, region, search location and country, queries, title regexes, seniority
    penalties, score threshold and file paths.
  - Ships with `job_profile.example.md` (a fictional candidate), `cv_keywords.example.json`,
    `.env.example` and a complete `examples/northern-ireland.env`.
- **Noon Tech Digest** (`packages/noon-tech-digest`):
  - Sectioned news from the last 24 hours (AI, ML research, Python, IoT, new tech), widening to
    the past week when a section is quiet.
  - Hermes' model picks, rates and summarises stories and removes duplicates across sections.
    Top stories are read in full, and a short briefing leads the email.
  - PNG section icons built from Lucide and Simple Icons SVGs with `icons/build_icons.py`, which
    also accepts a custom sections file.
  - Configurable title, tagline, reader description (which steers the editor model), sections
    through `TECH_DIGEST_SECTIONS_FILE`, and selection limits.
  - Ships with `sections.example.json` and `.env.example`.

### Changed (compared with the private deployment)

- Removed the hard-coded candidate name, sender name, email addresses, LAN Ollama address and
  Northern Ireland defaults. Region-specific behaviour is now opt-in configuration.
- Seniority penalties default to 0. The default title filters no longer assume a particular
  vendor stack.
- Search country settings take ISO codes (`gb`, `us`), and the Tavily wrapper also accepts full
  names. The Scrapfly proxy country is configurable (`SCRAPFLY_COUNTRY`) instead of fixed.
- Pillow is optional: without it, company logos are skipped instead of the run failing.
- Package-relative paths for icons and default profile files, so packages also run straight
  from a clone.

[Unreleased]: https://github.com/Metaheurist/HermitShell/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Metaheurist/HermitShell/releases/tag/v0.1.0

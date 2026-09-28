# Changelog

All notable changes to HermitShell are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and packages are versioned together
using [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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

- An unauthorised, unreachable or missing Indeed MCP server is logged and skipped, and the other
  sources still run.

### Fixed

- A broken table row and a missing blank line in `docs/configuration.md`.

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

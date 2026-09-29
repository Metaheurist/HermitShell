# HermitShell

[![CI](https://github.com/Metaheurist/HermitShell/actions/workflows/ci.yml/badge.svg)](https://github.com/Metaheurist/HermitShell/actions/workflows/ci.yml)
[![Security](https://github.com/Metaheurist/HermitShell/actions/workflows/security.yml/badge.svg)](https://github.com/Metaheurist/HermitShell/actions/workflows/security.yml)

A self-hosted job-finder automation platform for [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Every morning it searches the web for jobs in your region, has the model Hermes is already
configured with (Ollama by default) score each one against your CV, and emails you the best
matches. Buttons in the email teach it what you like, write cover letters and tailored CVs on
request, and remind you to follow up. One server can run it for other people too, each with
their own CV, searches and reports.

Everything personal lives in your own `.env` file and profile files, never in the code. That
includes credentials, API keys, your CV and your region.

<a href="packages/daily-vacancy-report"><img src="docs/images/daily-vacancy-report.png" alt="Daily Vacancy Report email" width="480"></a>

All screenshots are rendered by the real code with fictional data (the example profile shipped in
this repo).

<table>
<tr>
<td><img src="docs/images/emails/weekly.png" alt="Weekly roll-up" width="250"></td>
<td><img src="docs/images/emails/cover-letter.png" alt="Cover letter email" width="250"></td>
<td><img src="docs/images/worker/admin-dashboard.png" alt="Admin page" width="300"></td>
</tr>
<tr><td align="center">Weekly roll-up</td><td align="center">Cover letter on request</td><td align="center">Profiles admin page</td></tr>
</table>

Every email, PDF and page, with what each part does: [docs/screenshots.md](docs/screenshots.md).

## What you get

- **Daily Vacancy Report** ([package](packages/daily-vacancy-report)): jobs from across the web in
  your region, level, job types, work modes and salary range, scored 0-10 against your CV, with
  the salary, closing date, company logo, website and profile. You choose the time (default 07:00).
- **Feedback buttons** on every job: I applied, Good match, Not for me, Interested, and missing
  skills you can add to your CV. Answers calibrate the scores and drive follow-up reminders
  ([how it works](docs/feedback-worker.md)).
- **Cover letters and tailored CVs** on request: press the button and an A4 PDF arrives by email
  within minutes, written only from facts in your real CV.
- **Weekly roll-up** every Sunday: best jobs, applications and common gaps.
- **Extra profiles**: invite people from the Worker's `/admin` page; their CV becomes their own
  daily report.
- **Automatic Cloudflare setup**: the wizard deploys the free Worker behind the buttons, `/admin`
  and sign-up links from a Cloudflare API token ([guide](docs/cloudflare-setup.md)).

## Quick start

On the machine or container running Hermes (for the official Docker image, `HERMES_HOME` is
`/opt/data`):

```sh
git clone https://github.com/Metaheurist/HermitShell.git
cd HermitShell
python3 scripts/setup.py
```

The setup wizard installs the job finder, sets up what it runs on (missing Python packages, an
Ollama container next to Hermes if there's no Ollama yet, and the model), and then walks you
through everything it needs:

1. Email (SMTP) details and any web search API keys you have (Firecrawl, Tavily, Scrapfly). Keys
   are typed without being shown and are only ever displayed masked.
2. Your job search: where you're looking (region, towns, country, remote), the level you're
   targeting, employment types (permanent, contract, part-time, internship...), work modes,
   minimum salary and the job titles to search for.
3. Your candidate profile. Answer a few questions, import your CV as text, or start from the
   example.
4. Optionally, a Cloudflare account ID and API token: the wizard then deploys the feedback Worker
   (buttons, `/admin` page, sign-up links) and sets its admin password for you (see
   [docs/cloudflare-setup.md](docs/cloudflare-setup.md)).
5. What time the report, the weekly roll-up and the request checks should run (for example
   `07:30`, `weekdays 08:00` or `sunday 18:00`).
6. Along the way, the other essential settings, such as email titles and score thresholds.
   `--advanced` asks for every setting.
7. The cron jobs, a test email, an optional dry run and a final health check.

Settings are saved to `$HERMES_HOME/.env`, which is backed up first. Re-run the wizard any time;
your current values are offered as the defaults. On a Docker host, point it at the bind-mounted
data directory (`sudo python3 scripts/setup.py --hermes-home /path/to/hermes/data`). It runs
`hermes` commands inside the `hermes-agent` container automatically.

Prefer to do it by hand? Run `./scripts/install.sh daily-vacancy-report`, copy settings from
[`.env.example`](.env.example) and the package's `.env.example` into `$HERMES_HOME/.env`, and
follow the [package README](packages/daily-vacancy-report).

Details are in [docs/installation.md](docs/installation.md) and
[docs/configuration.md](docs/configuration.md). The feedback Worker has its own guides:
[docs/cloudflare-setup.md](docs/cloudflare-setup.md) for the automatic setup (account, API token,
free limits) and [docs/feedback-worker.md](docs/feedback-worker.md) for how it works and deploying
it by hand with wrangler or the Cloudflare MCP.

## Repository layout

```
common/hermes_common.py    shared plumbing: .env loading, model discovery, web providers, SMTP, encryption
common/doctor.py           checks and sets up prerequisites: packages, Ollama and its model, data key
common/tests/              unit tests for the shared library and the doctor
packages/daily-vacancy-report/
                           the job finder: report, weekly roll-up, cover letters, tailored CVs, profiles
packages/daily-vacancy-report/feedback-worker/
                           Cloudflare Worker for the buttons, /admin and sign-ups (not copied into Hermes)
scripts/setup.py           interactive wizard: install, API keys, job search, profile, Worker, schedules
scripts/cloudflare_worker.py
                           deploys or updates the Worker with a Cloudflare API token
scripts/tests/             unit tests for the wizard, the Worker deploy and the .env.example files
scripts/install.sh         copies common + the package flat into $HERMES_HOME/scripts
scripts/screenshots/       regenerates the documentation screenshots from fictional data
tests/security/            security tests: hostile input, encryption, backups, file permissions
requirements.txt           run-time Python packages (requirements-dev.txt adds the test tools)
.github/workflows/         CI (lint, tests, Worker build) and Security (secrets, security tests,
                           Bandit, CVEs, CodeQL)
docs/                      installation, configuration, accounts and API keys, Cloudflare, feedback
                           Worker, email rendering, web providers, screenshots
```

The scripts are installed flat next to `hermes_common.py`, because Hermes cron jobs run a single
script from `$HERMES_HOME/scripts`.

## Under the hood

- **Uses Hermes' own model.** Reads `model.default`, `model.base_url` and `ollama_num_ctx` from
  `$HERMES_HOME/config.yaml`, with an override for the job finder.
- **One model queue for everyone.** Every profile's ratings, cover letters, tailored CVs and
  sign-ups share one queue, so the model gets one request at a time however many people you run
  it for, with requests someone is waiting on served first.
- **Web provider failover.** Firecrawl comes first (with extra backup keys when credits run
  low), then Tavily and Scrapfly. See [docs/web-providers.md](docs/web-providers.md).
- **Email that survives Gmail.** Table layout, inline CSS, PNG icons sent as inline attachments,
  and a dark-mode hack that keeps headers readable. See
  [docs/email-rendering.md](docs/email-rendering.md).
- **Stateful.** It remembers what it already sent, so you never get the same job twice.
- **Data protection.** CVs, profiles and letters are encrypted at rest (AES-256-GCM,
  `HERMES_DATA_KEY`) and readable by Hermes' account only; a nightly job deletes data past its
  retention period and writes rotated, encrypted backups; unsubscribing deletes a person's data,
  scrubs them from the logs and confirms by email. What invited people are told is in
  [PRIVACY.md](PRIVACY.md); how it works is in
  [docs/configuration.md](docs/configuration.md#data-protection).
- **Dry runs.** `--dry-run` runs the whole pipeline, writes the email HTML to `state/` and sends
  nothing.

## Requirements

- Hermes Agent with `hermes cron`, and Python 3.10+ (the official image has both).
- The `requests` and `cryptography` packages (both bundled with Hermes). `pillow` is optional and
  gives round company logos; `pyyaml` is optional. [`requirements.txt`](requirements.txt) lists
  them, and `doctor.py --fix` installs any that are missing
  ([prerequisites](docs/installation.md#3-check-the-prerequisites)).
- An Ollama model. A 4B instruct model such as `qwen3:4b-instruct-2507` works well on a CPU. The
  wizard can start an Ollama container next to Hermes and download the model for you.
- An SMTP account, such as a Gmail App Password.
- An API key for at least one of [Firecrawl](https://firecrawl.dev),
  [Tavily](https://tavily.com) or [Scrapfly](https://scrapfly.io). All three have free tiers.
- For the buttons, `/admin` and extra profiles: a free [Cloudflare](https://dash.cloudflare.com/sign-up)
  account.

[docs/api-keys.md](docs/api-keys.md) walks through creating each account and key, with the free
limits and how far they go.

## Tests and CI

Run everything locally from the repository root:

```bash
python -m pip install -r requirements-dev.txt ruff bandit
ruff check .
bandit -c .bandit.yml -r common packages scripts -ll
python -m pytest common/tests packages/*/tests scripts/tests tests/security
cd packages/daily-vacancy-report/feedback-worker && npm ci && npm test
```

Two GitHub Actions workflows run on every push and pull request:

| Workflow | Jobs |
| --- | --- |
| [CI](.github/workflows/ci.yml) | Ruff lint; a compile check on Python 3.10; unit tests for the shared library, the job finder and the setup wizard, each on Python 3.10 and 3.12; the feedback Worker's Vitest tests and a `wrangler deploy --dry-run` build check; and a final "All CI checks passed" job to use as a required check |
| [Security](.github/workflows/security.yml) | Gitleaks secret scan of the full history; the security test suites ([`tests/security`](tests/security) for hostile input, encryption, backups and file permissions; the Worker's `test/security.test.js` for headers, escaping, authentication, CSRF and size limits); Bandit static analysis of the Python code; CVE audits of the Python packages (`pip-audit`) and the Worker's npm packages (`npm audit`, high and critical fail); dependency review on pull requests; CodeQL code scanning of the Python, JavaScript and workflow files. It also runs every Monday, so newly published CVEs are reported even when nothing has changed |

## Security

Nothing in this repo contains credentials. `.gitignore` excludes `.env`, `job_profile.md`,
`cv_keywords.json` and `state/`, and the feedback Worker's own `.gitignore` excludes
`wrangler.local.jsonc` and `.dev.vars`. Keep your filled-in copies on the Hermes host only.

# HermitShell

[![Unit tests](https://github.com/Metaheurist/HermitShell/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/Metaheurist/HermitShell/actions/workflows/unit-tests.yml)
[![Playwright](https://github.com/Metaheurist/HermitShell/actions/workflows/playwright.yml/badge.svg)](https://github.com/Metaheurist/HermitShell/actions/workflows/playwright.yml)
[![Security](https://github.com/Metaheurist/HermitShell/actions/workflows/security.yml/badge.svg)](https://github.com/Metaheurist/HermitShell/actions/workflows/security.yml)
[![Image](https://github.com/Metaheurist/HermitShell/actions/workflows/image.yml/badge.svg)](https://github.com/Metaheurist/HermitShell/actions/workflows/image.yml)

A self-hosted job-finder automation platform that runs on any Linux server, as a container or a service.
Every morning it searches the web for jobs in your region, has a local model (Ollama) score each one against
your CV, and emails you the best matches. A server that can't run a model can use a cloud one instead
(OpenRouter, BazaarLink, Featherless or Hugging Face), with Ollama as the fallback. Buttons in the email teach it what you like, write cover letters and tailored CVs on
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
<td><img src="docs/images/worker/admin-stats.png" alt="A profile's stats page" width="200"></td>
</tr>
<tr><td align="center">Weekly roll-up</td><td align="center">Cover letter on request</td><td align="center">Profiles admin page</td><td align="center">Stats per profile</td></tr>
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
  daily report. Send anyone's jobs now, and open their stats: KPIs and charts over 7 days to 12
  months.
- **Automatic Cloudflare setup**: the wizard deploys the free Worker behind the buttons, `/admin`
  and sign-up links from a Cloudflare API token ([guide](docs/cloudflare-setup.md)).

## Quick start

As a container, on any Docker host (the image is built and published by
[GitHub Actions](.github/workflows/image.yml) on every push):

```sh
sudo mkdir -p /opt/hermitshell/data && sudo chown 10000:10000 /opt/hermitshell/data
cd /opt/hermitshell
sudo curl -fsSLO https://raw.githubusercontent.com/Metaheurist/HermitShell/main/docker-compose.yml
sudo docker compose up -d
sudo docker exec -it hermitshell /app/entrypoint.sh setup
```

Or as a service on any Linux server with Python 3.10+, without Docker:

```sh
git clone https://github.com/Metaheurist/HermitShell.git && cd HermitShell
sudo sh scripts/install-service.sh
```

Either way HermitShell runs its own scheduler, so nothing else is needed. The setup wizard sets up what it runs
on (missing Python packages, an Ollama container if there's no Ollama yet, and the model). Then:

- **With a free Cloudflare account** (recommended): paste its account ID and an API token
  ([how](docs/cloudflare-setup.md)). The wizard deploys the feedback Worker, then asks for:
  - the `/admin` username and password;
  - your timezone and, if you like, the email server;
  - the run times.

  Everything else is set on the Worker's `/admin` page: the email server, web search keys
  ([how to get them, free](docs/api-keys.md)), your CV and the job search. A checklist there
  shows what's left.
- **Without Cloudflare, or with `--advanced`**, the wizard asks everything itself:
  - email (SMTP) details and web search API keys (Firecrawl, Tavily, Scrapfly);
  - your job search: region, towns, country, remote, level, employment types, work modes,
    minimum salary and job titles;
  - your candidate profile (answer a few questions or import your CV as text);
  - the run times.

  `--advanced` also asks for every other setting.

Keys are typed without being shown and are only ever displayed masked. It finishes with the
schedules, a test email when the email server is set, and a health check.

Settings are saved to `.env` in HermitShell's home (`/data` in the container, `/opt/hermitshell` for the
service), which is backed up first. Re-run the wizard any time; your current values are offered as the
defaults. The container keeps itself up to date with
[`install-updater.sh`](docs/installation.md#keep-the-container-up-to-date), which pulls each new image.

Prefer to do it by hand? Run `HERMITSHELL_HOME=/srv/hermitshell ./scripts/install.sh daily-vacancy-report`,
copy settings from [`.env.example`](.env.example) and the package's `.env.example` into its `.env`, and
start `scheduler.py run` ([manual installation](docs/installation.md#manual-installation)). Moving an install
out of Hermes is covered in [docs/installation.md](docs/installation.md#moving-from-hermes).

Details are in [docs/installation.md](docs/installation.md) and
[docs/configuration.md](docs/configuration.md). The feedback Worker has its own guides:
[docs/cloudflare-setup.md](docs/cloudflare-setup.md) for the automatic setup (account, API token,
free limits) and [docs/feedback-worker.md](docs/feedback-worker.md) for how it works and deploying
it by hand with wrangler or the Cloudflare MCP.

## Repository layout

```
common/hermes_common.py    shared plumbing: .env loading, model discovery, web providers, SMTP, encryption
common/autofit.py          picks the model size for the machine, and GPU or CPU, context size, threads and Ollama
                           server per model request
common/llm_providers.py    cloud models (OpenRouter, BazaarLink, Featherless, Hugging Face) tried in turn before or
                           after Ollama, resting a provider that is out of credits
common/worker_link.py      the one client for the feedback Worker: https only, no redirects, retries, signed requests
common/worker_seal.py      the key pair the Worker seals dashboard passwords, API keys and CVs with
common/doctor.py           checks and sets up prerequisites: packages, scheduler, Ollama and its model, data key
common/scheduler.py        runs each script on its cron schedule (the service, or a tick from cron)
common/tests/              unit tests for the shared library, the scheduler and the doctor
packages/daily-vacancy-report/
                           the job finder: report, weekly roll-up, cover letters, tailored CVs, profiles
packages/daily-vacancy-report/feedback-worker/
                           Cloudflare Worker for the buttons, /admin and sign-ups (deployed to Cloudflare)
scripts/setup.py           interactive wizard: install, API keys, job search, profile, Worker, schedules
scripts/cloudflare_worker.py
                           deploys or updates the Worker with a Cloudflare API token
scripts/tests/             unit tests for the wizard, the Worker deploy and the .env.example files
scripts/install.sh         copies common + the package flat into $HERMITSHELL_HOME/scripts
scripts/install-service.sh installs it as a systemd service (or cron) on any Linux server
scripts/host/              host units: the image updater, and a watchdog that reports the GPUs and restarts
                           an Ollama that lost one
Dockerfile, docker/        the container image and its entry point
docker-compose.yml         runs the image with its data in ./data
scripts/screenshots/       regenerates the documentation screenshots from fictional data
tests/security/            security tests: hostile input, encryption, backups, file permissions, the signed and
                           sealed Worker link
requirements.txt           run-time Python packages (requirements-dev.txt adds the test tools)
.github/workflows/         Unit tests (lint, tests, Worker build), Playwright (browser tests), Security (secrets, security tests, Bandit,
                           CVEs, CodeQL) and Image (build, smoke test, scan, publish to GHCR)
docs/                      installation, configuration, accounts and API keys, Cloudflare, feedback
                           Worker, email rendering, web providers, screenshots
```

The scripts are installed flat next to `hermes_common.py` in `$HERMITSHELL_HOME/scripts`, and each scheduled
job runs one of them.

## Under the hood

- **Its own scheduler.** `scheduler.py` runs each script on its cron schedule in your timezone, skips a job
  that is still running, catches up a run missed while it was stopped, and stops runaway runs. The dashboard
  sets each person's report time through it.
- **Runs anywhere.** One image for amd64 and arm64, read-only and unprivileged, updated by the server itself;
  or a hardened systemd service on any Linux server.
- **Fits the model to the machine.** Without a model set, it picks the size the machine can run
  (a 30B model with 24 GB of GPU memory or 48 GB of RAM, 4B for most, 1.5B on small servers). Autofit gives each request the context it needs, keeps as
  much of the model on the GPU as fits, uses every CPU thread when that's faster, and spreads job
  ratings over every Ollama server. It steps down when memory runs out and back up when it's safe.
  See [docs/configuration.md](docs/configuration.md#autofit-gpu-cpu-and-context-chosen-for-you).
- **One model queue for everyone.** Every profile's ratings, cover letters, tailored CVs and
  sign-ups share one queue, so each Ollama server gets one request at a time however many people
  you run it for, with requests someone is waiting on served first.
- **Cloud models when there's no GPU.** Add an OpenRouter, BazaarLink, Featherless or Hugging Face key
  on the dashboard and it asks them in turn, resting one that runs out of credits until the next day
  and falling back to Ollama. See [docs/api-keys.md](docs/api-keys.md#cloud-models).
- **Web provider failover.** Firecrawl comes first (with extra backup keys when credits run
  low), then Tavily and Scrapfly. See [docs/web-providers.md](docs/web-providers.md).
- **Email that survives Gmail.** Table layout, inline CSS, PNG icons sent as inline attachments,
  and a dark-mode hack that keeps headers readable. See
  [docs/email-rendering.md](docs/email-rendering.md).
- **Stateful.** It remembers what it already sent, so you never get the same job twice.
- **Data protection.** CVs, profiles and letters are encrypted at rest (AES-256-GCM,
  `HERMES_DATA_KEY`) and readable by HermitShell's account only; a nightly job deletes data past its
  retention period and writes rotated, encrypted backups; unsubscribing deletes a person's data,
  scrubs them from the logs and confirms by email. What invited people are told is in
  [PRIVACY.md](PRIVACY.md); how it works is in
  [docs/configuration.md](docs/configuration.md#data-protection).
- **A locked-down link to the Worker.** Every request to the feedback Worker goes over HTTPS, is signed
  (HMAC over the method, path, body and time, with a one-time nonce) and is refused if it is older than five
  minutes or replayed, so a leaked token alone is no use. Passwords, API keys and CVs entered on the
  dashboard are encrypted for your server before they reach Cloudflare's storage, and the dashboard warns
  when HermitShell and the Worker are different versions. See
  [docs/feedback-worker.md](docs/feedback-worker.md#how-it-stays-safe).
- **Dry runs.** `--dry-run` runs the whole pipeline, writes the email HTML to `state/` and sends
  nothing.

## Requirements

- Docker, or Linux with Python 3.10+ (the container has everything else).
- Without the container: the `requests` and `cryptography` packages. `pillow` is optional and
  gives round company logos; `pyyaml` is optional; `websockets` is optional and gives the live
  link to the Worker (without it HermitShell polls every 5 minutes). [`requirements.txt`](requirements.txt) lists
  them, and `doctor.py --fix` installs any that are missing
  ([prerequisites](docs/installation.md#3-check-the-prerequisites)).
- An Ollama model. A 4B instruct model such as `qwen3:4b-instruct-2507` works well on a CPU. The
  wizard can start an Ollama container and download the model that suits the machine. Or, without
  one, a key for a cloud model: OpenRouter and BazaarLink have free models with daily limits.
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
npx playwright install chromium && npm run e2e   # browser tests against a local wrangler dev
```

Four GitHub Actions workflows run on every push and pull request:

| Workflow | Jobs |
| --- | --- |
| [Unit tests](.github/workflows/unit-tests.yml) | Ruff lint; a compile check on Python 3.10; unit tests for the shared library, the job finder and the setup wizard, each on Python 3.10 and 3.12; the feedback Worker's Vitest tests and a `wrangler deploy --dry-run` build check; and a final "All unit tests passed" job to use as a required check |
| [Playwright](.github/workflows/playwright.yml) | Browser tests of the feedback Worker's pages in Chromium ([`e2e/`](packages/daily-vacancy-report/feedback-worker/e2e)): the Worker runs locally under `wrangler dev` with fictional recruits and throwaway secrets, no Cloudflare account. They cover signing in and out, search, the dashboard tabs, a recruit's Manage and History tabs, saving changes, Send jobs now, pausing, email buttons (confirm, save once, changed and expired links), invite sign-up, adding a recruiter and what a recruiter can see, phone and wide layouts, and security (cookie flags, CSP, forged CSRF tokens, the API token, escaped input). On failure the HTML report and traces are uploaded |
| [Security](.github/workflows/security.yml) | Gitleaks secret scan of the full history; the security test suites ([`tests/security`](tests/security) for hostile input, encryption, backups, file permissions and the Worker link, running the Worker's own signing and sealing code under Node against HermitShell's; the Worker's `test/security.test.js`, `test/apiauth.test.js` and `test/seal.test.js` for headers, escaping, authentication, signed requests and replays, sealed secrets, CSRF and size limits); Bandit static analysis of the Python code; CVE audits of the Python packages (`pip-audit`) and the Worker's npm packages (`npm audit`, high and critical fail); dependency review on pull requests; CodeQL code scanning of the Python, JavaScript and workflow files. It also runs every Monday, so newly published CVEs are reported even when nothing has changed |
| [Image](.github/workflows/image.yml) | Builds the container image, starts it with an empty data folder and checks the scheduler comes up healthy with the standard jobs and every package imports, scans it with Trivy (fixable critical CVEs fail), then on `main` and version tags publishes it for amd64 and arm64 to `ghcr.io/metaheurist/hermitshell` and attaches it to a [release](https://github.com/Metaheurist/HermitShell/releases): its own for a version tag, the rolling `latest-build` pre-release for `main` |

## Security

Nothing in this repo contains credentials. `.gitignore` excludes `.env`, `job_profile.md`,
`cv_keywords.json` and `state/`, and the feedback Worker's own `.gitignore` excludes
`wrangler.local.jsonc` and `.dev.vars`. Keep your filled-in copies on the HermitShell host only.

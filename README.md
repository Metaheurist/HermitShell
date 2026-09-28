# HermitShell

[![CI](https://github.com/Metaheurist/HermitShell/actions/workflows/ci.yml/badge.svg)](https://github.com/Metaheurist/HermitShell/actions/workflows/ci.yml)

A collection of ready-to-install packages for [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Each package is a self-contained scheduled script that runs through `hermes cron`. The packages use
the model Hermes is already configured with (Ollama by default) and send you the results by email.

Everything personal lives in your own `.env` file and profile files, never in the code. That
includes credentials, API keys, your CV and your region.

## Packages

| Package | What you get | Schedule |
| --- | --- | --- |
| [Daily Vacancy Report](packages/daily-vacancy-report) | Jobs from Indeed (via Hermes' Indeed MCP connection) and the wider web in your region, level, job types, work modes and salary range, matched to your CV and scored 0-10 by the model, with closing dates, company logos, websites and profiles. Optional [feedback buttons](docs/feedback-worker.md) teach the model what you like and remind you to follow up on applications, and a weekly roll-up sums up your week | You choose (default 07:00, roll-up Sunday 18:00) |
| [News Digest](packages/news-digest) | Curated news on the topics you pick (AI, security, space, markets, sport... or your own keywords), in sections with a model-written briefing | You choose (default 12:00) |

<table>
<tr>
<td width="50%" valign="top"><a href="packages/daily-vacancy-report"><img src="docs/images/daily-vacancy-report.png" alt="Daily Vacancy Report email"></a></td>
<td width="50%" valign="top"><a href="packages/news-digest"><img src="docs/images/news-digest.png" alt="News Digest email"></a></td>
</tr>
<tr>
<td align="center"><b>Daily Vacancy Report</b></td>
<td align="center"><b>News Digest</b></td>
</tr>
</table>

The screenshots come from dry runs using the fictional example profile shipped in this repo.

## Quick start

On the machine or container running Hermes (for the official Docker image, `HERMES_HOME` is
`/opt/data`):

```sh
git clone https://github.com/Metaheurist/HermitShell.git
cd HermitShell
python3 scripts/setup.py
```

The setup wizard installs the packages you pick and then walks you through everything they need:

1. Email (SMTP) details and any web search API keys you have (Firecrawl, Tavily, Scrapfly). Keys
   are typed without being shown and are only ever displayed masked.
2. Your job search: where you're looking (region, towns, country, remote), the level you're
   targeting, employment types (permanent, contract, part-time, internship...), work modes,
   minimum salary and the job titles to search for.
3. Your candidate profile for the vacancy report. Answer a few questions, import your CV as text,
   or start from the example. Optionally, the URL of your feedback Worker; the wizard generates
   its secrets (see [docs/feedback-worker.md](docs/feedback-worker.md)).
4. The digest's news topics, picked from a catalog of 23 or added as your own keywords.
5. What time each package should run (for example `07:30`, `weekdays 08:00` or `sunday 18:00`).
6. Along the way, each package's other essential settings, such as email titles and score
   thresholds. `--advanced` asks for every setting.
7. Optional Indeed MCP connection and login, then the cron jobs, a test email and an optional dry
   run.

Settings are saved to `$HERMES_HOME/.env`, which is backed up first. Re-run the wizard any time;
your current values are offered as the defaults. On a Docker host, point it at the bind-mounted
data directory (`sudo python3 scripts/setup.py --hermes-home /path/to/hermes/data`). It runs
`hermes` commands inside the `hermes-agent` container automatically.

Prefer to do it by hand? Run `./scripts/install.sh <package>...`, copy settings from
[`.env.example`](.env.example) and each package's `.env.example` into `$HERMES_HOME/.env`, and
follow the package READMEs.

Details are in [docs/installation.md](docs/installation.md) and
[docs/configuration.md](docs/configuration.md). The optional feedback buttons have their own
guide, [docs/feedback-worker.md](docs/feedback-worker.md), covering setup with the Cloudflare MCP
in an AI agent or with wrangler by hand.

## Repository layout

```
common/hermes_common.py    shared plumbing: .env loading, model discovery, web providers, SMTP
packages/<name>/           one directory per package: entry script, README, examples, tests
packages/daily-vacancy-report/feedback-worker/
                           optional Cloudflare Worker for the report's feedback buttons (not copied into Hermes)
scripts/setup.py           interactive wizard: install, API keys, job search, topics, profile, schedules
scripts/install.sh         copies common + chosen packages flat into $HERMES_HOME/scripts
docs/                      installation, configuration, feedback Worker, email rendering, web providers
```

Packages are installed flat next to `hermes_common.py`, because Hermes cron jobs run a single
script from `$HERMES_HOME/scripts`.

## Shared features

- **Uses Hermes' own model.** Reads `model.default`, `model.base_url` and `ollama_num_ctx` from
  `$HERMES_HOME/config.yaml`, with overrides per package.
- **Web provider failover.** Firecrawl comes first (with extra backup keys when credits run
  low), then Tavily and Scrapfly. See [docs/web-providers.md](docs/web-providers.md).
- **Uses Hermes' MCP connections.** Packages can call MCP servers you have already authorised in
  Hermes, such as Indeed for job search, without holding any tokens themselves. See
  [MCP sources](docs/configuration.md#mcp-sources).
- **Email that survives Gmail.** Table layout, inline CSS, PNG icons sent as inline attachments,
  and a dark-mode hack that keeps headers readable. See
  [docs/email-rendering.md](docs/email-rendering.md).
- **Stateful.** Each package remembers what it already sent, so you never get the same job or
  story twice.
- **Dry runs.** `--dry-run` runs the whole pipeline, writes the email HTML to `state/` and sends
  nothing.

## Requirements

- Hermes Agent with `hermes cron`, and Python 3.10+ (the official image has both).
- The `requests` package (bundled with Hermes). `pillow` is optional and gives round company
  logos; `pyyaml` is optional.
- An Ollama model. A 4B instruct model such as `qwen3:4b-instruct-2507` works well on a CPU.
- An SMTP account, such as a Gmail App Password.
- An API key for at least one of [Firecrawl](https://firecrawl.dev),
  [Tavily](https://tavily.com) or [Scrapfly](https://scrapfly.io). All three have free tiers.
- Optional: the [Indeed MCP server](https://docs.indeed.com/mcp) added and authorised in Hermes,
  for the vacancy report's Indeed source.

## Adding a package

1. Create `packages/<name>/` with the entry script, a `README.md`, a `.env.example` and a
   screenshot in `docs/images/`.
2. Import helpers from `hermes_common` rather than copying them.
3. Read every personal or deployment-specific value from the environment and give it a neutral
   default. Document each one in `.env.example` with a comment above it; add `# @basic` to have
   the setup wizard ask for it by default (everything else appears with `--advanced`), or
   `# @wizard` when a guided step in `scripts/setup.py` fills it in. Add the package to
   `PACKAGES` in `scripts/setup.py` so the wizard can schedule it.
4. Support `--dry-run` and `--test-email`.
5. Put unit tests in `packages/<name>/tests/` and add a step for them to
   [`.github/workflows/ci.yml`](.github/workflows/ci.yml), which runs on every push and pull
   request.
6. Add an entry to [CHANGELOG.md](CHANGELOG.md).

## Security

Nothing in this repo contains credentials. `.gitignore` excludes `.env`, `job_profile.md`,
`cv_keywords.json` and `state/`, and the feedback Worker's own `.gitignore` excludes
`wrangler.local.jsonc` and `.dev.vars`. Keep your filled-in copies on the Hermes host only.

# HermitShell

A collection of ready-to-install packages for [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Each package is a self-contained scheduled script that runs through `hermes cron`. The packages use
the model Hermes is already configured with (Ollama by default) and send you the results by email.

Everything personal lives in your own `.env` file and profile files, never in the code. That
includes credentials, API keys, your CV and your region.

## Packages

| Package | What you get | Schedule |
| --- | --- | --- |
| [Daily Vacancy Report](packages/daily-vacancy-report) | Jobs from Indeed (via Hermes' Indeed MCP connection) and the wider web, matched to your CV and scored 0-10 by the model, with company logos, websites and profiles | Daily, morning |
| [Noon Tech Digest](packages/noon-tech-digest) | Curated AI / ML / Python / IoT / new-tech news in sections, with a model-written briefing | Daily, noon |

<table>
<tr>
<td width="50%" valign="top"><a href="packages/daily-vacancy-report"><img src="docs/images/daily-vacancy-report.png" alt="Daily Vacancy Report email"></a></td>
<td width="50%" valign="top"><a href="packages/noon-tech-digest"><img src="docs/images/noon-tech-digest.png" alt="Noon Tech Digest email"></a></td>
</tr>
<tr>
<td align="center"><b>Daily Vacancy Report</b></td>
<td align="center"><b>Noon Tech Digest</b></td>
</tr>
</table>

The screenshots come from dry runs using the fictional example profile shipped in this repo.

## Quick start

On the machine or container running Hermes (for the official Docker image, `HERMES_HOME` is
`/opt/data`):

```sh
git clone https://github.com/Metaheurist/HermitShell.git
cd HermitShell
HERMES_HOME=/opt/data ./scripts/install.sh daily-vacancy-report noon-tech-digest
```

Then do the following:

1. Copy the settings you need from [`.env.example`](.env.example) into `$HERMES_HOME/.env`. You
   need SMTP details and at least one web search key (Firecrawl, Tavily or Scrapfly).
2. Follow the package README for any package-specific files, such as the candidate profile for
   the vacancy report.
3. Test with `--test-email`, then `--dry-run`.
4. Register the cron job shown in the package README.

Details are in [docs/installation.md](docs/installation.md) and
[docs/configuration.md](docs/configuration.md).

## Repository layout

```
common/hermes_common.py    shared plumbing: .env loading, model discovery, web providers, SMTP
packages/<name>/           one directory per package: entry script, README, examples
scripts/install.sh         copies common + chosen packages flat into $HERMES_HOME/scripts
docs/                      installation, configuration, email rendering, web providers
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
   default.
4. Support `--dry-run` and `--test-email`.
5. Add an entry to [CHANGELOG.md](CHANGELOG.md).

## Security

Nothing in this repo contains credentials. `.gitignore` excludes `.env`, `job_profile.md`,
`cv_keywords.json` and `state/`. Keep your filled-in copies on the Hermes host only.

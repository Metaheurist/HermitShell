# Configuration

Every HermitShell setting is an environment variable. Nothing personal is hard-coded.

The [setup wizard](installation.md#setup-wizard) (`python3 scripts/setup.py`) writes all of these
for you and can be re-run to change them. It reads the settings, their help text and their
defaults straight from the `.env.example` files. Settings tagged `# @basic` are asked by
default, and every setting is asked with `--advanced`.

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
- Noon Tech Digest: [`packages/noon-tech-digest/.env.example`](../packages/noon-tech-digest/.env.example).

## MCP sources

Some packages can use MCP servers that are connected to Hermes. Currently this is the Indeed
source in the Daily Vacancy Report. HermitShell never holds MCP credentials. The server entry
lives under `mcp_servers:` in Hermes' `config.yaml`, and Hermes stores and refreshes the OAuth
tokens in `$HERMES_HOME/mcp-tokens/`. The package reuses Hermes' OAuth provider, so it needs to
run inside Hermes' Python environment (the `hermes-agent` container).

| Variable | Default | Purpose |
| --- | --- | --- |
| `JOB_INDEED` | `1` | Use the Indeed MCP source when it is configured and authorised |
| `JOB_INDEED_MCP_SERVER` | `indeed` | Server name under `mcp_servers` in `config.yaml` |
| `HERMES_AGENT_DIR` | `/opt/hermes` | Hermes source directory, for its MCP and OAuth modules. Environment only |

Authorise once with `hermes mcp login indeed` or from the dashboard's MCP page. An unauthorised
or unreachable server is logged and skipped, and the other sources still run. The remaining
`JOB_INDEED_*` settings are listed in the package's
[`.env.example`](../packages/daily-vacancy-report/.env.example).

## Keeping secrets safe

- Prefer container environment variables for keys and passwords, and keep `$HERMES_HOME/.env`
  readable only by the Hermes user (`chmod 600`).
- Never commit a filled-in `.env`, `job_profile.md` or `cv_keywords.json`. The repo's
  `.gitignore` already excludes them.
- Logs show only the index and a masked prefix and suffix of the Firecrawl key in use, never the
  full key.
- MCP OAuth tokens stay in Hermes' `mcp-tokens/` directory and are handled only by Hermes' own
  OAuth code. HermitShell never copies or logs them.
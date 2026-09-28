# Installation

HermitShell packages are plain Python scripts that Hermes runs on a schedule. Installing one
means three things:

1. Copying the script and the shared `hermes_common.py` into `$HERMES_HOME/scripts`.
2. Giving it settings.
3. Registering a cron job.

The setup wizard does all three. The manual steps below explain what it does, in case you want
to do it by hand.

## Setup wizard

```sh
git clone https://github.com/Metaheurist/HermitShell.git
cd HermitShell
python3 scripts/setup.py                  # local Hermes, or inside the container
sudo python3 scripts/setup.py --hermes-home /path/to/hermes/data   # from a Docker host
```

It asks, in order:

1. **Hermes home and packages.** Then it runs `install.sh` for the packages you choose. Run as
   root on a Docker host, it gives the files the same owner as the Hermes home directory (the
   official image uses `10000:10000`).
2. **Shared settings.** SMTP server, login and recipient, then Firecrawl (plus backup keys),
   Tavily and Scrapfly API keys, and your timezone. Leave empty any key you don't have. Secrets
   are read without echo and are only ever shown masked (`fc-2a...461a`).
3. **Package settings.** Every setting tagged `# @basic` in the package's `.env.example`. With
   `--advanced`, you get every setting, including provider order, Ollama fallbacks, title regexes
   and limits.
4. **Job targets** (vacancy report). Enter the job titles you want. The wizard turns them into
   Indeed searches, web search queries for your location and a title filter. It also removes
   any of your titles from the default exclude list, so a nurse or teacher isn't filtered out.
5. **Candidate profile** (vacancy report). Answer a few questions, import a text or markdown CV,
   paste text, or start from the example. Your skills and gaps become `cv_keywords.json`.
6. **Digest sections.** Keep the built-in sections, or copy `sections.example.json` to
   `sections.json` to edit.
7. **Review.** Every change is listed (secrets masked) before anything is written. `.env` is
   backed up to `.env.bak-<timestamp>`, updated in place (other Hermes settings are left
   alone) and kept at mode 600.
8. **Indeed MCP.** Adds the server to Hermes if it's missing and offers the one-time browser
   login.
9. **Schedules.** Creates or updates the `hermes cron` jobs. Enter `07:00`, `weekdays 07:30` or
   a cron expression.
10. **Test.** Sends a test email and offers a dry run.

The wizard finds Hermes by itself. It uses the `hermes` command when it's on your PATH;
otherwise it runs commands in the `hermes-agent` container with `docker exec` (change this with
`--container`, `--container-home` and `--container-user`).

Useful options:

| Option | Effect |
| --- | --- |
| `--advanced` | Ask for every setting, not just the essentials |
| `--dry-run` | Show what would change; write and run nothing |
| `--no-install` / `--no-cron` | Skip copying files / the schedule step |
| `--non-interactive --answers FILE` | Unattended: values from a `KEY=VALUE` file, then the environment, then current values |
| `daily-vacancy-report noon-tech-digest` | Set up only these packages without asking |

Re-running the wizard is safe: current values are the defaults, and pressing Enter everywhere
changes nothing.

## Manual installation

The same steps by hand.

### 1. Find your Hermes home

| Setup | `HERMES_HOME` | Scripts directory |
| --- | --- | --- |
| Official Docker image | `/opt/data` (inside the container) | `/opt/data/scripts` |
| Local install | `~/.hermes` | `~/.hermes/scripts` |

With Docker, `/opt/data` is normally a bind mount, so you can also install from the host into
the mounted directory.

### 2. Copy the files

```sh
git clone https://github.com/Metaheurist/HermitShell.git
cd HermitShell
HERMES_HOME=/opt/data ./scripts/install.sh daily-vacancy-report noon-tech-digest
```

The installer does the following:

- Copies `common/hermes_common.py` plus each package's scripts, example files and icons flat
  into `$HERMES_HOME/scripts`.
- Renames each package's `.env.example` to `<package>.env.example`, so templates don't collide.
- Strips Windows line endings.
- Never overwrites your real `job_profile.md`, `cv_keywords.json` or `.env`.

If you install from the Docker host, set the owner to the container user:

```sh
sudo HERMES_OWNER=10000:10000 HERMES_HOME=/path/to/hermes/data ./scripts/install.sh noon-tech-digest
```

#### Without the installer

Copy these files into the scripts directory yourself:

- `common/hermes_common.py`
- Everything in `packages/<name>/` except the README.
- For the digest, the `icons/` folder. Only the PNGs are needed at runtime.

### 3. Configure

Add settings to `$HERMES_HOME/.env`, the same file Hermes reads, or pass them as container
environment variables:

```sh
# shared: SMTP + at least one web search key
cat .env.example                                  # copy what you need
# per package, all optional
cat packages/daily-vacancy-report/.env.example
cat packages/noon-tech-digest/.env.example
```

See [configuration.md](configuration.md) for how settings are resolved.

The vacancy report also needs your profile:

```sh
cd $HERMES_HOME/scripts
cp job_profile.example.md job_profile.md
cp cv_keywords.example.json cv_keywords.json
```

Optionally, connect the Indeed MCP server in Hermes so the vacancy report also searches Indeed.
Add **indeed** from the dashboard's MCP catalog, then authorise it once:

```sh
docker exec -it -u hermes hermes-agent hermes mcp login indeed
docker exec -u hermes hermes-agent hermes mcp test indeed
```

Setup details are in the package README's
[Indeed MCP source](../packages/daily-vacancy-report/README.md#indeed-mcp-source) section.

### 4. Test

Run the scripts as the same user Hermes uses. In Docker, that means:

```sh
docker exec -u hermes -w /opt/data hermes-agent python3 scripts/job_scanner.py --test-email
docker exec -u hermes -w /opt/data hermes-agent python3 scripts/job_scanner.py --dry-run --limit 3
docker exec -u hermes -w /opt/data hermes-agent python3 scripts/tech_digest.py --dry-run
```

Dry runs write the email HTML to `scripts/state/*_last.html`. Copy that file along with the
`logos/` or `icons/` folder next to it to preview the email in a browser.

### 5. Schedule

```sh
docker exec -u hermes -w /opt/data hermes-agent hermes cron create "0 7 * * *" "Daily vacancy report" \
    --name daily-vacancy-report --script job_scanner.py --no-agent --deliver local
docker exec -u hermes -w /opt/data hermes-agent hermes cron create "0 12 * * *" "Noon tech digest" \
    --name noon-tech-digest --script tech_digest.py --no-agent --deliver local
docker exec -u hermes -w /opt/data hermes-agent hermes cron list
```

- `--no-agent` runs the script directly without an LLM turn.
- `--deliver local` keeps the script's one-line summary in Hermes' cron log. The email is the
  real delivery.
- Cron schedules use the container clock, usually UTC.

## Updating

Pull the repo and re-run the wizard (or just the installer). Your `.env`, profiles and `state/`
are left alone, and settings added in the new version appear as questions.

# Installation

HermitShell packages are plain Python scripts that Hermes runs on a schedule. Installing one
means three things:

1. Copying the script and the shared `hermes_common.py` into `$HERMES_HOME/scripts`.
2. Giving it settings.
3. Registering a cron job.

## 1. Find your Hermes home

| Setup | `HERMES_HOME` | Scripts directory |
| --- | --- | --- |
| Official Docker image | `/opt/data` (inside the container) | `/opt/data/scripts` |
| Local install | `~/.hermes` | `~/.hermes/scripts` |

With Docker, `/opt/data` is normally a bind mount, so you can also install from the host into
the mounted directory.

## 2. Copy the files

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

### Manual install

Copy these files into the scripts directory yourself:

- `common/hermes_common.py`
- Everything in `packages/<name>/` except the README.
- For the digest, the `icons/` folder. Only the PNGs are needed at runtime.

## 3. Configure

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

## 4. Test

Run the scripts as the same user Hermes uses. In Docker, that means:

```sh
docker exec -u hermes -w /opt/data hermes-agent python3 scripts/job_scanner.py --test-email
docker exec -u hermes -w /opt/data hermes-agent python3 scripts/job_scanner.py --dry-run --limit 3
docker exec -u hermes -w /opt/data hermes-agent python3 scripts/tech_digest.py --dry-run
```

Dry runs write the email HTML to `scripts/state/*_last.html`. Copy that file along with the
`logos/` or `icons/` folder next to it to preview the email in a browser.

## 5. Schedule

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

Pull the repo and re-run the installer. Your `.env`, profiles and `state/` are left alone.

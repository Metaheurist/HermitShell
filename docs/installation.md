# Installation

HermitShell is a set of plain Python scripts with its own scheduler (`scheduler.py`), which runs each script on
its cron schedule. It needs Python 3.10 or newer, an [Ollama](https://ollama.com) server with a model, and
somewhere to keep its settings and data: its **home** folder (`HERMITSHELL_HOME`). There are three ways to run
it:

| Way | Home | Kept running by | Updates |
| --- | --- | --- | --- |
| [Container](#run-it-as-a-container) (recommended) | `/data` in the container, a folder of your choice on the host | Docker (`restart: unless-stopped`) | Automatic: the server pulls each new image ([updater](#keep-the-container-up-to-date)) |
| [Service](#run-it-as-a-service-without-a-container) on any Linux server | `/opt/hermitshell` | systemd, or cron where there is no systemd | `git pull` and re-run the installer |
| [Files only](#manual-installation) | any folder | you: `scheduler.py run`, or `scheduler.py tick` from cron | re-run the installer |

Each way then uses the same [setup wizard](#setup-wizard) for settings, the profile and run times.

## Run it as a container

Every push to `main` builds the image, tests it and publishes it for amd64 and arm64 as
`ghcr.io/metaheurist/hermitshell` ([the workflow](../.github/workflows/image.yml)). On the Docker host:

```sh
sudo mkdir -p /opt/hermitshell/data
sudo chown 10000:10000 /opt/hermitshell/data         # the container's user
cd /opt/hermitshell
sudo curl -fsSLO https://raw.githubusercontent.com/Metaheurist/HermitShell/main/docker-compose.yml
sudo docker compose up -d
```

On its first start the container copies the scripts into `data/scripts`, adds the standard schedule (daily
report, weekly roll-up, cover letters, extra profiles, nightly maintenance) and starts the scheduler. Then enter
your settings with the wizard, inside the container:

```sh
sudo docker exec -it hermitshell /app/entrypoint.sh setup
```

[`docker-compose.yml`](../docker-compose.yml) runs the container read-only, with no Linux capabilities and as
uid 10000. Its settings, from the environment or a `.env` file next to it:

| Setting | Default | |
| --- | --- | --- |
| `HERMITSHELL_DATA` | `./data` | Host folder for settings and data, owned by 10000:10000 |
| `HERMITSHELL_IMAGE` | `ghcr.io/metaheurist/hermitshell:latest` | A version tag (`:1.2`) pins it |
| `TZ` | `UTC` | The container clock; schedules use `HERMES_TIMEZONE` from `data/.env` |

Ollama can run anywhere the container reaches: on the Docker host (`OLLAMA_HOST=http://host.docker.internal:11434`,
already mapped in the compose file), in a container named `ollama` on the same network (`http://ollama:11434`)
or on another machine. The wizard finds it, or starts one with the GPU ([details](#use-the-gpu)).

Everyday commands:

```sh
docker logs -f hermitshell                                              # the scheduler's log
docker exec hermitshell python3 scheduler.py list                       # jobs, last run and result
docker exec hermitshell python3 scheduler.py start daily-vacancy-report # run a job now
docker exec hermitshell /app/entrypoint.sh doctor                       # health check
docker exec hermitshell python3 job_scanner.py --dry-run --limit 3      # a test report, not emailed
```

Each run's output is in `data/cron/output/<job id>/`. The container's health check fails when the scheduler
stops checking in, so `docker ps` shows it as unhealthy.

### Keep the container up to date

The updater checks the registry every 10 minutes and, only when there's a new image, recreates the container
on it with the same settings and data. Nothing reaches in from outside: no open port, key or deploy access.

```sh
git clone https://github.com/Metaheurist/HermitShell.git && cd HermitShell
sudo sh scripts/host/install-updater.sh /opt/hermitshell/docker-compose.yml
journalctl -u hermitshell-update -n 20
```

It copies [`hermitshell-update.sh`](../scripts/host/hermitshell-update.sh) to `/opt/hermitshell-host` (a second
argument picks another folder; it must be root-owned and not mounted into any container, since systemd runs it
as root) and enables `hermitshell-update.timer`. To update by hand: `docker compose pull && docker compose up -d`.

### Without registry access

Each build is also attached to a [GitHub release](https://github.com/Metaheurist/HermitShell/releases): a
version tag (`v1.2.0`) gets its own release, and every push to `main` replaces the `latest-build` pre-release.
A release holds the image for amd64 and arm64 as files `docker load` reads, `docker-compose.yml` and
`SHA256SUMS`, and its notes give the `docker pull` command pinned to that build's digest:

```sh
sha256sum -c --ignore-missing SHA256SUMS
gunzip -c hermitshell-<version>-amd64.tar.gz | sudo docker load
sudo HERMITSHELL_IMAGE=ghcr.io/metaheurist/hermitshell:<version> docker compose up -d
```

The updater only follows the registry, so an image loaded this way is updated by loading the next one.

### Build it yourself

```sh
docker build -t hermitshell .
HERMITSHELL_IMAGE=hermitshell docker compose up -d
```

## Run it as a service (without a container)

On any Linux server with Python 3.10 or newer, as root:

```sh
git clone https://github.com/Metaheurist/HermitShell.git && cd HermitShell
sudo sh scripts/install-service.sh
```

[`install-service.sh`](../scripts/install-service.sh) creates a `hermitshell` system account, installs the scripts
into `/opt/hermitshell` (mode 700), installs the Python packages they need into `scripts/.deps`, adds the
standard schedule and keeps the scheduler running as the `hermitshell` systemd service (hardened: read-only
system, private `/tmp`, writes only to its home). Without systemd it starts `scheduler.py tick` every minute from
the account's crontab instead. `HERMITSHELL_HOME`, `HERMITSHELL_USER` and `PYTHON` change the defaults.

It prints the wizard command to run next. Afterwards:

```sh
journalctl -u hermitshell -f
sudo -u hermitshell sh -c 'cd /opt/hermitshell/scripts && python3 scheduler.py list'
```

To update, `git pull` and run `install-service.sh` again: settings and data are kept and the service restarts
on the new code.

## Setup wizard

```sh
docker exec -it hermitshell /app/entrypoint.sh setup     # the container
python3 scripts/setup.py                                 # anywhere else, from a clone of the repo
sudo python3 scripts/setup.py --home /opt/hermitshell/data   # on the Docker host, into the container's data
```

With a Cloudflare API token, setup is short. The wizard asks for:
1. the HermitShell home, and installs the prerequisites (steps 2 and 3 of the [manual installation](#manual-installation));
2. the Cloudflare account ID and token, and deploys the Worker;
3. the `/admin` username and password;
4. your timezone and, if you like, the email server;
5. the run times.

It then prints the Worker's `/admin` address. Everything else is done there, once HermitShell has connected
(a few minutes): the email server, web search keys ([how to get them](api-keys.md)), your CV and
the job search. The page's checklist shows what's left.

Without a token, or with `--advanced`, the wizard asks everything itself, in this order:

1. **HermitShell home.** Then it runs `install.sh` to copy the scripts in. Run as root, it gives the files the
   same owner as the home folder (the container uses `10000:10000`).
2. **Prerequisites.** Runs [`doctor.py --fix`](#3-check-the-prerequisites) to install any missing packages. If
   no Ollama server answers and Docker is there, it offers to start an `ollama/ollama` container on the
   HermitShell container's network (reusing an existing `ollama` container, and putting HermitShell on a
   `hermitshell-net` network if it's only on Docker's default bridge) and sets `OLLAMA_HOST`. It gives Ollama
   every GPU it finds ([details](#use-the-gpu)): NVIDIA with its device nodes, AMD with the ROCm image, and one
   Ollama per GPU when there are several. It warns when an existing `ollama` container can't see the GPU. Then it
   asks which model to use and downloads it, showing progress, and runs `autofit.py --calibrate`
   to measure how much of the model fits on the GPU. `--no-prereqs` skips this step.
3. **Shared settings.** SMTP server, login and recipient, then Firecrawl (plus backup keys),
   Tavily and Scrapfly API keys, and your timezone. Leave empty any key you don't have
   ([how to get each one, and the free limits](api-keys.md)). Secrets
   are read without echo and are only ever shown masked, as their last four characters
   (`****9z8y`).
4. **Package settings.** Every setting tagged `# @basic` in the package's `.env.example`. With
   `--advanced`, you get every setting, including provider order, Ollama fallbacks, title regexes
   and limits.
5. **Job search** (vacancy report). Where you're job hunting: region or city, the towns that
   count as inside it, and a two-letter country code. Then whether fully remote jobs elsewhere count, and what kind of
   job you want from numbered menus:
   - **Level:** junior, mid, senior, lead or any. Titles above or below it lose fit points.
   - **Employment types:** permanent, contract, temporary, part-time, internship. Choosing
     part-time or internship also takes them off the title exclude list.
   - **Work modes:** on-site, hybrid, remote.
   - **Minimum salary** (for example `45k`; `0` for none) and the salary currency, which salaries in other currencies are converted to,
     suggested from your country. Jobs that don't list a salary are always kept.
   - **Unnamed agency adverts:** whether to hide recruitment-agency adverts that don't name the
     employer.
6. **Job titles** (vacancy report). Enter the job titles you want. The wizard turns them into
   web search queries for your location and a title filter. It also removes
   any of your titles from the default exclude list, so a nurse or teacher isn't filtered out.
7. **Candidate profile** (vacancy report). Answer a few questions, import a text or markdown CV,
   paste text, or start from the example. Your skills and gaps become `cv_keywords.json`.
   Then the optional **feedback buttons and admin page** (without `--advanced` this is asked
   first, right after the prerequisites): paste your Cloudflare account ID and an
   API token ([how to create them](cloudflare-setup.md)) and the wizard deploys the
   [feedback Worker](feedback-worker.md) itself: KV namespace, Worker code, `JOB_FEEDBACK_URL`,
   generated `JOB_FEEDBACK_SECRET` / `JOB_FEEDBACK_API_TOKEN`, the `/admin` username and password
   you choose and, optionally, Cloudflare Access. Without a token you can paste the URL of a Worker
   you deployed by hand instead; the wizard then offers to pipe the secrets into
   `wrangler secret put` so they never appear on screen.
8. **Run times:** `07:00` runs daily,
   `weekdays 07:30` runs Monday to Friday, `sunday 18:00` once a week, and a cron expression or
   `-` (don't schedule) also work. The vacancy report also asks when to send its weekly roll-up
   (default `sunday 18:00`). Times are in `HERMES_TIMEZONE`.
9. **Review.** Every change is listed (secrets masked) before anything is written. `.env` is
   backed up to `.env.bak-<timestamp>`, updated in place (other settings are left alone) and kept at mode 600.
10. **Schedules.** Creates or updates the scheduler's jobs with the run times you chose. If
   HermitShell isn't installed where the wizard runs, it prints the `scheduler.py` commands to run instead.
11. **Test.** Sends a test email when the email server is set, and offers a dry run (not when the
   rest of the setup happens on `/admin`).
12. **Health check.** Runs `doctor.py` once more and lists anything still missing, with the fix.

The wizard runs the scripts in the `hermitshell` container with `docker exec` when that container is running on
this machine, and directly otherwise (change this with `--container`, `--container-home` and `--container-user`).

Useful options:

| Option | Effect |
| --- | --- |
| `--home DIR` | The HermitShell home (default: `HERMITSHELL_HOME`, `/data` in the container, else `~/.hermitshell`) |
| `--advanced` | Ask for every setting, not just the essentials |
| `--dry-run` | Show what would change; write and run nothing |
| `--no-install` / `--no-cron` | Skip copying files / the schedule step |
| `--no-prereqs` | Skip installing packages, starting Ollama, downloading the model and the final health check |
| `--non-interactive --answers FILE` | Unattended: values from a `KEY=VALUE` file, then the environment, then current values |
| `daily-vacancy-report` | Skip the "which packages" question |

Re-running the wizard is safe: current values are the defaults, and pressing Enter everywhere
changes nothing.

An answers file for an unattended setup uses the normal setting names, plus
`SCHEDULE_DAILY_VACANCY_REPORT` for the run time (and `SCHEDULE_DAILY_VACANCY_REPORT_WEEKLY` for
the roll-up). If you set `JOB_FEEDBACK_URL` without
the two secrets, they are generated:

```sh
JOB_REGION_NAME=Dublin
JOB_REGION_PLACES=Dublin, Dun Laoghaire, Swords
JOB_SEARCH_COUNTRY=ie
JOB_LEVEL=mid
JOB_EMPLOYMENT_TYPES=Permanent,Contract
JOB_WORK_MODES=Hybrid,Remote
JOB_MIN_SALARY=50000
JOB_SALARY_CURRENCY=EUR
SCHEDULE_DAILY_VACANCY_REPORT=weekdays 07:30
SCHEDULE_DAILY_VACANCY_REPORT_WEEKLY=sunday 18:00
```

## Manual installation

The same steps by hand, for a folder of your choice.

### 1. Choose a home

Everything lives under one folder, `HERMITSHELL_HOME`:

```
.env                       settings (mode 600)
cron/jobs.json             the schedule
cron/output/<job id>/      each run's output
scripts/                   the scripts, your profile, cv_keywords.json
scripts/state/             reports, the job tracker, profiles, cover letters
backups/nightly/           encrypted nightly backups
```

### 2. Copy the files

```sh
git clone https://github.com/Metaheurist/HermitShell.git
cd HermitShell
HERMITSHELL_HOME=/srv/hermitshell ./scripts/install.sh daily-vacancy-report
```

The installer does the following:

- Copies `common/hermes_common.py`, `common/autofit.py`, `common/doctor.py` and `common/scheduler.py` plus the
  job finder's scripts, example files and icons flat into `$HERMITSHELL_HOME/scripts`.
- Renames the package's `.env.example` to `daily-vacancy-report.env.example` and its `jobs.json` (the standard
  schedule) to `daily-vacancy-report.jobs.json`, so they don't collide with other packages'.
- Strips Windows line endings.
- Never overwrites your real `job_profile.md`, `cv_keywords.json` or `.env`.

`HERMITSHELL_OWNER=uid:gid` sets the owner of the copied files when you install as root for another user.

#### Without the installer

Copy these files into the scripts directory yourself:

- `common/hermes_common.py`, `common/autofit.py`, `common/doctor.py` and `common/scheduler.py`
- Everything in `packages/daily-vacancy-report/` except the README, `tests/` and `feedback-worker/`.
  From `icons/` only the PNGs are needed at runtime.

### 3. Check the prerequisites

`doctor.py` checks everything the scripts need and, with `--fix`, sets up what it can:

```sh
cd $HERMITSHELL_HOME/scripts && python3 doctor.py --fix
```

| Check | What `--fix` does |
| --- | --- |
| Python 3.10 or newer | Nothing (the container has 3.13) |
| Packages: `requests`, `cryptography`, optional `pillow`, `pyyaml` and `websockets` ([requirements.txt](../requirements.txt)) | Installs missing or too-old ones with pip, or with uv when Python has no pip, into `scripts/.deps/pyX.Y`, which `hermes_common.py` puts on the import path |
| The scheduler: its jobs, failed runs, and whether it is running | Adds the standard jobs when there are none |
| Ollama answers, with the model the scripts will use | Downloads the model through Ollama's API (`JOB_SCANNER_MODEL`, else `OLLAMA_MODEL`, else the size that fits the machine: `qwen3:4b-instruct-2507-q4_K_M`, about 2.5 GB, on most). `--no-pull` skips it, `--model NAME` picks another. With a [cloud model key](api-keys.md#cloud-models) set, a missing Ollama or model is only a warning |
| `.env` is owner-only, `HERMES_DATA_KEY` works, SMTP and a web search key are set | Makes `.env` owner-only and generates the data key when none is set, but never when encrypted files already exist (a new key can't open them) |
| The feedback Worker answers, free disk space | Nothing |

It exits with 1 when a check fails; `--only packages,ollama` runs some checks and `--json`
prints the results for other tools. The wizard runs it for you.

No Ollama yet? On a Docker host, start it next to HermitShell (the wizard offers to do this):

```sh
docker run -d --name ollama --restart unless-stopped -p 11434:11434 \
    -v ollama:/root/.ollama ollama/ollama
```

The container then finds it at `http://host.docker.internal:11434` and a service at `http://localhost:11434`
(`OLLAMA_HOST`).

#### Use the GPU

Ollama only uses a GPU that its container can see. The wizard sets this up for you. By hand:

- **NVIDIA** (needs the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)):
  add `--gpus all` and the device nodes, so a `systemctl daemon-reload` on the host can't silently
  take the GPU away from the running container (Ollama then falls back to the CPU without saying so):

  ```sh
  docker run -d --name ollama --restart unless-stopped -p 11434:11434 --gpus all \
      --device /dev/nvidia0 --device /dev/nvidiactl --device /dev/nvidia-uvm --device /dev/nvidia-uvm-tools \
      -e OLLAMA_FLASH_ATTENTION=1 -e OLLAMA_KV_CACHE_TYPE=q8_0 -v ollama:/root/.ollama ollama/ollama
  ```

  In Docker Compose, list the same paths under the service's `devices:`, next to
  `deploy.resources.reservations.devices` with `driver: nvidia`.
- **AMD**: use the `ollama/ollama:rocm` image with `--device /dev/kfd --device /dev/dri`.
- **More than one GPU**: the wizard offers one Ollama per GPU (`ollama-gpu1` on port 11435, and so
  on) and lists them in `OLLAMA_HOSTS`, so job ratings run on all of them at once.

Then install the host watchdog. It runs every 2 minutes as root, reports the CPU, memory and GPUs to
[autofit](configuration.md#autofit-gpu-cpu-and-context-chosen-for-you) in the `hermitshell` container, and
restarts an Ollama container that has lost its GPU. It restarts a container at most once every 20 minutes and
6 times a day:

```sh
sudo sh scripts/host/install-watchdog.sh /opt/hermitshell-host
journalctl -u hermitshell-ollama-watchdog -n 20
```

The folder must be owned by root and not mounted into any container. Settings (container names,
restart limits) go in `/etc/default/hermitshell-ollama-watchdog`; the list is at the top of
[`ollama-watchdog.sh`](../scripts/host/ollama-watchdog.sh).

Check where the model runs with `docker exec ollama nvidia-smi -L` and `python3 doctor.py`.

### 4. Configure

Add settings to `$HERMITSHELL_HOME/.env`, or pass them as environment variables:

```sh
# shared: SMTP, at least one web search key, Ollama
cat .env.example                                  # copy what you need
# the job finder, all optional
cat packages/daily-vacancy-report/.env.example
```

The settings the wizard asks about in its guided steps are, for the vacancy report,
`JOB_REGION_NAME`, `JOB_REGION_PLACES`, `JOB_SEARCH_COUNTRY`, `JOB_REMOTE_ANYWHERE`, `JOB_LEVEL`,
`JOB_EMPLOYMENT_TYPES`, `JOB_WORK_MODES`, `JOB_MIN_SALARY`, `JOB_SALARY_CURRENCY`,
`JOB_HIDE_UNNAMED_AGENCY`, `JOB_TARGET_TITLES`, the `CLOUDFLARE_*` and the `JOB_FEEDBACK_*`
values. The feedback buttons need a small Cloudflare Worker: `python3 scripts/cloudflare_worker.py`
(in the container, `/app/entrypoint.sh worker`) deploys it with a token ([cloudflare-setup.md](cloudflare-setup.md)),
and [feedback-worker.md](feedback-worker.md) covers deploying it by hand and setting the secrets.

See [configuration.md](configuration.md) for how settings are resolved.

The vacancy report also needs your profile:

```sh
cd $HERMITSHELL_HOME/scripts
cp job_profile.example.md job_profile.md
cp cv_keywords.example.json cv_keywords.json
```

### 5. Test

Run the scripts as the user that owns the home. In the container:

```sh
docker exec hermitshell python3 job_scanner.py --test-email
docker exec hermitshell python3 job_scanner.py --dry-run --limit 3
```

Dry runs write the email HTML to `scripts/state/*_last.html`. Copy that file along with the
`logos/` folder next to it to preview the email in a browser. The test email and a full report
should look like the ones in [screenshots.md](screenshots.md#test-emails).

### 6. Schedule

`python3 scheduler.py defaults` adds the standard schedule. To choose the times yourself:

```sh
cd $HERMITSHELL_HOME/scripts
python3 scheduler.py create "0 7 * * *" "Daily vacancy report" --name daily-vacancy-report --script job_scanner.py
python3 scheduler.py create "0 18 * * 0" "Weekly vacancy roll-up" --name weekly-vacancy-report --script job_weekly.py
python3 scheduler.py create "*/5 * * * *" "Cover letter requests" --name vacancy-cover-letters --script cover_letter.py
python3 scheduler.py create "*/5 * * * *" "Extra profiles" --name vacancy-profiles --script profiles.py
python3 scheduler.py create "30 3 * * *" "Nightly maintenance" --name vacancy-maintenance --script maintenance.py
python3 scheduler.py list
```

Then keep it running: `python3 scheduler.py run` (a service does this for you), or add
`* * * * * cd $HERMITSHELL_HOME/scripts && python3 scheduler.py tick` to the user's crontab.

- The first argument is a standard cron expression: `30 7 * * *` is 07:30 every day,
  `0 8 * * 1-5` is 08:00 on weekdays, `0 18 * * 0` is 18:00 on Sundays. Times are in `HERMES_TIMEZONE`
  (default UTC), daylight saving included.
- `--script` takes a script name in the scripts folder only, no arguments, so the weekly roll-up runs
  `job_weekly.py` (the same as `job_scanner.py --weekly`).
- `edit ID --schedule "..."`, `pause ID`, `resume ID`, `remove ID` and `start ID` (run now) change jobs; the
  dashboard changes the report times the same way.
- A job still running when it is next due is skipped. A run missed while HermitShell was stopped is started
  late if it was due in the last `HERMITSHELL_CATCHUP_MINUTES` (30); a run is stopped after
  `HERMITSHELL_JOB_TIMEOUT` seconds (6 hours).
- Nightly maintenance deletes old data, encrypts and backs up; set `HERMES_DATA_KEY` first
  (`python3 maintenance.py --new-key`) so the backups are encrypted. With the feedback Worker set up, each
  backup is also sent to [Cloudflare](feedback-worker.md#backups-on-cloudflare), so a lost server can be
  rebuilt from there; that only works with the same `HERMES_DATA_KEY`, so keep a copy of it in a password
  manager, not only on the server. See [data protection](configuration.md#data-protection).

## Moving from Hermes

Version 0.1.0 ran inside [Hermes](https://github.com/NousResearch/hermes-agent) and used its cron. To move
an install out of Hermes into the container, keeping every setting, profile and history:

1. Create the container's folder as above, with `docker-compose.yml` downloaded next to it (it isn't in
   the image), but don't start it yet. Copy in, from Hermes' data folder: `.env` (keep the HermitShell
   settings; Hermes-only keys can go), `scripts/` (your profile, `cv_keywords.json`, `state/`) and
   `backups/`. Scripts of your own that aren't HermitShell's can stay behind. Put the model and host from
   Hermes' `config.yaml` into `.env` as `OLLAMA_MODEL`, `OLLAMA_HOST` and, if it sets one, `OLLAMA_NUM_CTX`
   (`http://host.docker.internal:11434` reaches an Ollama whose port is published on the host). Keep
   `HERMES_DATA_KEY` exactly as it was: it opens the encrypted files. Then `chown -R 10000:10000 data`.
2. Take over the jobs **before the first start**, while they are still active in Hermes: the import copies
   each job's paused state, and a first start with no jobs file adds the standard schedule, so the daily report
   would run twice. Per-profile jobs have their folders moved:

   ```sh
   sudo cp /path/to/hermes/data/cron/jobs.json data/hermes-jobs.json
   sudo docker compose run --rm hermitshell python3 scheduler.py import /data/hermes-jobs.json --map /opt/data=/data
   ```

   Only jobs whose script is installed are taken, with their names and times.
3. Stop them in Hermes: `hermes cron pause <id>` for each (`hermes cron list` shows them). Stop Hermes'
   live-link listener too, so two don't answer the Worker: find the `profiles.py listen` process in Hermes'
   container (`ps` or `/proc/*/cmdline`) and end it with `kill`; with its jobs paused, nothing starts it
   again. Then `sudo docker compose up -d`.
4. Check with `docker exec hermitshell /app/entrypoint.sh doctor` and `python3 scheduler.py list`, then remove
   the old jobs from Hermes (`hermes cron remove <id>`), HermitShell's files from Hermes' scripts folder and
   `data/hermes-jobs.json`. Keep `hermes_common.py` and `autofit.py` in Hermes if scripts of your own there
   use them.
5. Install the updater and re-point the host watchdog, which replaces the old `hermes-ollama-watchdog` units.
   Without a clone of the repository on the host, take the scripts from the image:

   ```sh
   sudo docker cp hermitshell:/app/scripts/host /tmp/hermitshell-host-scripts
   sudo sh /tmp/hermitshell-host-scripts/install-updater.sh /opt/hermitshell/docker-compose.yml
   sudo sh /tmp/hermitshell-host-scripts/install-watchdog.sh
   ```

   A backup copy job that pointed at Hermes' `data/backups/nightly` should now point at the container's.

The settings keep their `HERMES_` names (`HERMES_DATA_KEY`, `HERMES_TIMEZONE` and so on), so nothing in `.env`
needs renaming. Backups made before the move (`hermes-*.tar.gz.enc`) are still listed, rotated and restorable.

## Updating

The container updates itself when the [updater](#keep-the-container-up-to-date) is installed; otherwise
`docker compose pull && docker compose up -d`. For the service, `git pull` and run `install-service.sh` again;
for files only, re-run the installer. Your `.env`, profiles and `state/` are left alone, and re-running the
wizard asks about settings added in the new version.

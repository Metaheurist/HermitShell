# Installation

HermitShell is a set of plain Python scripts that Hermes runs on a schedule. Installing it
means three things:

1. Copying the scripts and the shared `hermes_common.py` into `$HERMES_HOME/scripts`.
2. Making sure its prerequisites are there: Python packages, Ollama with a model, a data key.
3. Giving it settings.
4. Registering the cron jobs.

The setup wizard does all four. The manual steps below explain what it does, in case you want
to do it by hand.

## Setup wizard

```sh
git clone https://github.com/Metaheurist/HermitShell.git
cd HermitShell
python3 scripts/setup.py                  # local Hermes, or inside the container
sudo python3 scripts/setup.py --hermes-home /path/to/hermes/data   # from a Docker host
```

With a Cloudflare API token, setup is short. The wizard asks for:
1. the Hermes home, and installs the prerequisites (steps 1 and 2 below);
2. the Cloudflare account ID and token, and deploys the Worker;
3. the `/admin` username and password;
4. your timezone and, if you like, the email server;
5. the run times.

It then prints the Worker's `/admin` address. Everything else is done there, once HermitShell has connected
(a few minutes): the email server, web search keys ([how to get them](api-keys.md)), your CV and
the job search. The page's checklist shows what's left.

Without a token, or with `--advanced`, the wizard asks everything itself, in this order:

1. **Hermes home.** Then it runs `install.sh` to copy the job finder in. Run as
   root on a Docker host, it gives the files the same owner as the Hermes home directory (the
   official image uses `10000:10000`).
2. **Prerequisites.** Runs [`doctor.py --fix`](#3-check-the-prerequisites) in Hermes' own Python to
   install any missing packages. If no Ollama server answers and Hermes runs in Docker, it offers to
   start an `ollama/ollama` container on the Hermes container's network (reusing an existing
   `ollama` container, and putting Hermes on a `hermes-net` network if it's only on Docker's default
   bridge) and sets `OLLAMA_HOST`. It gives Ollama every GPU it finds ([details](#use-the-gpu)):
   NVIDIA with its device nodes, AMD with the ROCm image, and one Ollama per GPU when there are
   several. It warns when an existing `ollama` container can't see the GPU. Then it
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
   - **Minimum salary** (for example `45k`; `0` for none) and the currency symbol used in adverts,
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
   (default `sunday 18:00`). Times use Hermes' timezone (`timezone:` in `config.yaml`).
9. **Review.** Every change is listed (secrets masked) before anything is written. `.env` is
   backed up to `.env.bak-<timestamp>`, updated in place (other Hermes settings are left
   alone) and kept at mode 600.
10. **Schedules.** Creates or updates the `hermes cron` jobs with the run times you chose. If
   Hermes isn't reachable from where the wizard runs, it prints the commands to run instead.
11. **Test.** Sends a test email when the email server is set, and offers a dry run (not when the
   rest of the setup happens on `/admin`).
12. **Health check.** Runs `doctor.py` once more and lists anything still missing, with the fix.

The wizard finds Hermes by itself. It uses the `hermes` command when it's on your PATH;
otherwise it runs commands in the `hermes-agent` container with `docker exec` (change this with
`--container`, `--container-home` and `--container-user`).

Useful options:

| Option | Effect |
| --- | --- |
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
JOB_SALARY_CURRENCY=€
SCHEDULE_DAILY_VACANCY_REPORT=weekdays 07:30
SCHEDULE_DAILY_VACANCY_REPORT_WEEKLY=sunday 18:00
```

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
HERMES_HOME=/opt/data ./scripts/install.sh daily-vacancy-report
```

The installer does the following:

- Copies `common/hermes_common.py`, `common/autofit.py` and `common/doctor.py` plus the job finder's scripts, example
  files and icons flat into `$HERMES_HOME/scripts`.
- Renames the package's `.env.example` to `daily-vacancy-report.env.example`, so it doesn't
  collide with the shared one.
- Strips Windows line endings.
- Never overwrites your real `job_profile.md`, `cv_keywords.json` or `.env`.

If you install from the Docker host, set the owner to the container user:

```sh
sudo HERMES_OWNER=10000:10000 HERMES_HOME=/path/to/hermes/data ./scripts/install.sh daily-vacancy-report
```

#### Without the installer

Copy these files into the scripts directory yourself:

- `common/hermes_common.py`, `common/autofit.py` and `common/doctor.py`
- Everything in `packages/daily-vacancy-report/` except the README, `tests/` and `feedback-worker/`.
  From `icons/` only the PNGs are needed at runtime.

### 3. Check the prerequisites

`doctor.py` checks everything the scripts need and, with `--fix`, sets up what it can. Run it in
Hermes' own Python:

```sh
docker exec -u hermes -w /opt/data/scripts hermes-agent python3 doctor.py --fix
```

| Check | What `--fix` does |
| --- | --- |
| Python 3.10 or newer | Nothing (the official image has 3.13) |
| Packages: `requests`, `cryptography`, optional `pillow` and `pyyaml` ([requirements.txt](../requirements.txt)) | Installs missing or too-old ones with pip, or with uv when Hermes' Python has no pip (the official image), into `scripts/.deps/pyX.Y`. That folder is on the data volume, so it survives container updates, and `hermes_common.py` puts it on the import path |
| Hermes' `config.yaml` and the `hermes` command | Nothing; tells you what's missing |
| Ollama answers, with the model the scripts will use | Downloads the model through Ollama's API (`JOB_SCANNER_MODEL`, else `OLLAMA_MODEL`, else `qwen3:4b-instruct-2507-q4_K_M`, about 2.5 GB). `--no-pull` skips it, `--model NAME` picks another |
| `.env` is owner-only, `HERMES_DATA_KEY` works, SMTP and a web search key are set | Makes `.env` owner-only and generates the data key when none is set, but never when encrypted files already exist (a new key can't open them) |
| The feedback Worker answers, free disk space | Nothing |

It exits with 1 when a check fails; `--only packages,ollama` runs some checks and `--json`
prints the results for other tools. The wizard runs it for you.

No Ollama yet? On a Docker host, start it next to Hermes (the wizard offers to do this):

```sh
docker run -d --name ollama --restart unless-stopped --network <hermes network> \
    -v ollama:/root/.ollama ollama/ollama
```

`docker inspect hermes-agent --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'`
shows the network name. The scripts find it at `http://ollama:11434` (`OLLAMA_HOST`).

#### Use the GPU

Ollama only uses a GPU that its container can see. The wizard sets this up for you. By hand:

- **NVIDIA** (needs the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)):
  add `--gpus all` and the device nodes, so a `systemctl daemon-reload` on the host can't silently
  take the GPU away from the running container (Ollama then falls back to the CPU without saying so):

  ```sh
  docker run -d --name ollama --restart unless-stopped --network <hermes network> --gpus all \
      --device /dev/nvidia0 --device /dev/nvidiactl --device /dev/nvidia-uvm --device /dev/nvidia-uvm-tools \
      -e OLLAMA_FLASH_ATTENTION=1 -e OLLAMA_KV_CACHE_TYPE=q8_0 -v ollama:/root/.ollama ollama/ollama
  ```

  In Docker Compose, list the same paths under the service's `devices:`, next to
  `deploy.resources.reservations.devices` with `driver: nvidia`.
- **AMD**: use the `ollama/ollama:rocm` image with `--device /dev/kfd --device /dev/dri`.
- **More than one GPU**: the wizard offers one Ollama per GPU (`ollama-gpu1` on port 11435, and so
  on) and lists them in `OLLAMA_HOSTS`, so job ratings run on all of them at once.

Then install the host watchdog. It runs every 2 minutes as root, reports the CPU, memory and GPUs to
[autofit](configuration.md#autofit-gpu-cpu-and-context-chosen-for-you), and restarts an Ollama
container that has lost its GPU. It restarts a container at most once every 20 minutes and 6 times a day:

```sh
sudo sh scripts/host/install-watchdog.sh /opt/hermitshell
journalctl -u hermes-ollama-watchdog -n 20
```

The folder must be owned by root and not mounted into any container. Settings (container names,
restart limits) go in `/etc/default/hermes-ollama-watchdog`; the list is at the top of
[`ollama-watchdog.sh`](../scripts/host/ollama-watchdog.sh).

Check where the model runs with `docker exec ollama nvidia-smi -L` and `python3 doctor.py`.

### 4. Configure

Add settings to `$HERMES_HOME/.env`, the same file Hermes reads, or pass them as container
environment variables:

```sh
# shared: SMTP + at least one web search key
cat .env.example                                  # copy what you need
# the job finder, all optional
cat packages/daily-vacancy-report/.env.example
```

The settings the wizard asks about in its guided steps are, for the vacancy report,
`JOB_REGION_NAME`, `JOB_REGION_PLACES`, `JOB_SEARCH_COUNTRY`, `JOB_REMOTE_ANYWHERE`, `JOB_LEVEL`,
`JOB_EMPLOYMENT_TYPES`, `JOB_WORK_MODES`, `JOB_MIN_SALARY`, `JOB_SALARY_CURRENCY`,
`JOB_HIDE_UNNAMED_AGENCY`, `JOB_TARGET_TITLES`, the `CLOUDFLARE_*` and the `JOB_FEEDBACK_*`
values. The feedback buttons need a small Cloudflare Worker: `python3 scripts/cloudflare_worker.py`
deploys it with a token ([cloudflare-setup.md](cloudflare-setup.md)), and
[feedback-worker.md](feedback-worker.md) covers deploying it by hand and setting the secrets.

See [configuration.md](configuration.md) for how settings are resolved.

The vacancy report also needs your profile:

```sh
cd $HERMES_HOME/scripts
cp job_profile.example.md job_profile.md
cp cv_keywords.example.json cv_keywords.json
```

### 5. Test

Run the scripts as the same user Hermes uses. In Docker, that means:

```sh
docker exec -u hermes -w /opt/data hermes-agent python3 scripts/job_scanner.py --test-email
docker exec -u hermes -w /opt/data hermes-agent python3 scripts/job_scanner.py --dry-run --limit 3
```

Dry runs write the email HTML to `scripts/state/*_last.html`. Copy that file along with the
`logos/` folder next to it to preview the email in a browser. The test email and a full report
should look like the ones in [screenshots.md](screenshots.md#test-emails).

### 6. Schedule

```sh
docker exec -u hermes -w /opt/data hermes-agent hermes cron create "0 7 * * *" "Daily vacancy report" \
    --name daily-vacancy-report --script job_scanner.py --no-agent --deliver local
docker exec -u hermes -w /opt/data hermes-agent hermes cron create "0 18 * * 0" "Weekly vacancy roll-up" \
    --name weekly-vacancy-report --script job_weekly.py --no-agent --deliver local
docker exec -u hermes -w /opt/data hermes-agent hermes cron create "*/5 * * * *" "Cover letter requests" \
    --name vacancy-cover-letters --script cover_letter.py --no-agent --deliver local
docker exec -u hermes -w /opt/data hermes-agent hermes cron create "*/5 * * * *" "Vacancy profiles" \
    --name vacancy-profiles --script profiles.py --no-agent --deliver local
docker exec -u hermes -w /opt/data hermes-agent hermes cron create "30 3 * * *" "Nightly maintenance" \
    --name vacancy-maintenance --script maintenance.py --no-agent --deliver local
docker exec -u hermes -w /opt/data hermes-agent hermes cron list
```

- The first argument is a standard cron expression: `30 7 * * *` is 07:30 every day,
  `0 8 * * 1-5` is 08:00 on weekdays, `0 18 * * 0` is 18:00 on Sundays.
- `--script` takes a script name only, no arguments, so the weekly roll-up runs `job_weekly.py`
  (the same as `job_scanner.py --weekly`).
- `--no-agent` runs the script directly without an LLM turn.
- Nightly maintenance deletes old data, encrypts and backs up; set `HERMES_DATA_KEY` first
  (`python3 scripts/maintenance.py --new-key`) so the backups are encrypted. See
  [data protection](configuration.md#data-protection).
- `--deliver local` keeps the script's one-line summary in Hermes' cron log. The email is the
  real delivery.
- Schedules use Hermes' timezone (`timezone:` in `config.yaml`); without it, the container
  clock, usually UTC.

## Updating

Pull the repo and re-run the wizard (or just the installer). Your `.env`, profiles and `state/`
are left alone, and settings added in the new version appear as questions.

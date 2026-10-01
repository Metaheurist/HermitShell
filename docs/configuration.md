# Configuration

Every HermitShell setting is an environment variable. Nothing personal is hard-coded.

The [setup wizard](installation.md#setup-wizard) (`python3 scripts/setup.py`) writes all of these
for you and can be re-run to change them. It reads the settings, their help text and their
defaults straight from the `.env.example` files. Settings tagged `# @basic` are asked by
default, settings tagged `# @wizard` are filled in by guided steps (job search, job titles, profile and
the Cloudflare Worker), and every remaining setting is asked with `--advanced`.

## Where settings come from

When they conflict, higher entries in this list win:

1. **Process environment.** For example, container `environment:` entries in
   `docker-compose.yml`. This is the recommended place for secrets.
2. **`.env` in HermitShell's home** (`HERMITSHELL_HOME`: `/data` in the container, `/opt/hermitshell` for
   the service). Loaded by `hermes_common` each time a script starts, so a change applies from the next run. Lines are
   `KEY=value`; blank values are ignored, and values may be wrapped in single or double quotes.
3. **Built-in defaults.** These are neutral: no region, UTC, generic titles.

Regexes are read literally, so write `\b` rather than `\\b`.

The model, Ollama host and context size come from `OLLAMA_MODEL`, `OLLAMA_HOST` and `OLLAMA_NUM_CTX`. (An
install moved out of Hermes that still has Hermes' `config.yaml` in its home falls back to its `model:` block.)
Resolution order:

| Setting | Order |
| --- | --- |
| Model | `JOB_SCANNER_MODEL` (or `COVER_LETTER_MODEL`) → `OLLAMA_MODEL` → the model that fits the machine ([autofit](#autofit-gpu-cpu-and-context-chosen-for-you)) → `qwen3:4b-instruct-2507-q4_K_M` |
| Host | `OLLAMA_HOST` → `OLLAMA_FALLBACK_HOST` (`http://localhost:11434`) → `http://ollama:11434` (a container named `ollama`) → `http://host.docker.internal:11434` (Ollama on the Docker host) |
| Context | `OLLAMA_NUM_CTX` for `OLLAMA_MODEL`, else chosen by [autofit](#autofit-gpu-cpu-and-context-chosen-for-you) |

The first host that responds and has one of the candidate models is used.

Every model request, from every script and every profile, joins one shared queue, so extra
profiles, cover letters and sign-ups never pile up on Ollama at the same time. Requests run one at
a time per Ollama instance (`HERMES_MODEL_CONCURRENCY`) in arrival order, except that ones a person is waiting for
(cover letters, tailored CVs, new profiles) go ahead of background job ratings. A running request
is never interrupted, and a crashed script's place in the queue is freed automatically. Runs that
had to wait log `Waited 42s for the model (shared queue)`.

### Autofit: GPU, CPU and context chosen for you

`autofit.py` picks where and how each model request runs, and keeps adjusting as it learns.
It's on by default (`HERMES_AUTOFIT=off` turns it off and sends the model settings unchanged).

- **Hardware.** It knows the machine's CPU cores and threads, memory and GPUs (NVIDIA and AMD).
  In Docker the scripts can't see the host's GPUs, so the
  [host watchdog](installation.md#use-the-gpu) reports them in `state/hardware.json` every 2 minutes.
- **Context that fits the GPU.** A job rating needs a few thousand tokens, not a chat model's full
  context. Each request gets the smallest of 8k, 16k, 32k or 64k tokens that holds it. Autofit
  then learns from Ollama how much memory the model takes at each size and how much of it fits on
  the GPU. It keeps `OLLAMA_NUM_CTX` when that fits too, so Ollama doesn't reload the model.
  On a 4 GB card this moves a 4B model from mostly CPU to about 94% GPU, roughly twice as fast.
- **All cores.** Ollama uses one thread per physical core by default. When the model runs mostly
  on the CPU and the CPU has hyper-threading, autofit times both settings on real requests
  and keeps the faster one.
- **Several Ollama servers.** List extra ones in `OLLAMA_HOSTS` (the wizard does this for you when a
  machine has more than one GPU). Each gets its own queue slot, so job ratings run in parallel and
  are still listed in order. A server that fails rests for 30 seconds, then longer each time it
  fails again, up to an hour. A server more than 4 times slower than the fastest is benched (a CPU
  next to a GPU, for example), and tried again after an hour.
- **Watchdog.** When Ollama runs out of memory, autofit steps down one level: a smaller context,
  then fewer layers on the GPU, then CPU only. After 30 minutes and 5 good requests it steps back
  up one level. When memory is low it uses the smallest context. When the host watchdog sees that
  Ollama has lost the GPU, it restarts the container and autofit stops counting on the GPU until
  it's back.

See what it chose, and check it against real loads:

```sh
docker exec hermitshell python3 autofit.py              # what it knows
docker exec hermitshell python3 autofit.py --calibrate  # load each size once
```

`doctor.py` also says where the model runs, for example `qwen3:4b: loaded at 8192 context, 94% on
the GPU, the rest on the CPU`, and warns when a machine with a GPU runs the model on the CPU.

- **The model that fits.** With no `OLLAMA_MODEL`, autofit picks the model to download from the
  GPU's memory or the machine's RAM: `qwen2.5:1.5b-instruct` below 6 GB of RAM and 4 GB of VRAM, the
  default `qwen3:4b-instruct-2507-q4_K_M` up to 48 GB of RAM or 24 GB of VRAM, and
  `qwen3:30b-a3b-instruct-2507-q4_K_M` (a mixture of experts, quick on a CPU for its size) above.
  `doctor.py --fix` downloads it and the scripts prefer it; see [Ollama](api-keys.md#ollama).

### Cloud models

With a key for OpenRouter, BazaarLink, Featherless or Hugging Face (`llm_providers.py`), every model
request goes to those providers first, in `LLM_PROVIDERS` order, and to Ollama when none of them
answers; `LLM_ORDER=local` asks Ollama first. Cloud requests skip the shared queue (they don't load
Ollama). A provider that is out of credits (HTTP 402) or over its daily limit rests until midnight
UTC, one that rejects its key (401/403) for six hours, and one that is rate limited or down for a few
minutes (a `Retry-After` of up to an hour is honoured). Replies meant to be JSON are asked for as
structured output, and again with the schema in the prompt when a model doesn't support that; a reply
that still isn't valid JSON goes to the next provider. When no Ollama answers at all, the scripts
run on the cloud alone and `doctor.py` warns instead of failing.

`state/llm_providers.json` keeps each provider's rest and why, its requests today and the model that
answered last, never a key or a prompt. `python3 llm_providers.py` prints the same. The dashboard's
Global settings shows each key's usage (`key_usage.py`, every `WEB_KEY_USAGE_MINUTES`), and the admin's
server button the machine, the models in order and the last one that answered. Keys and setup:
[Cloud models](api-keys.md#cloud-models).

### Tokens used

Every model request adds its prompt and reply tokens to `llm_usage.json` (`llm_usage.py`) in the shared
state folder, beside the dashboard settings, so every recruit's runs count together. They are kept under
the task that asked: title screening, job ratings, second opinions, profile briefs, report summaries,
profiles from CVs, reading CVs, cover letters, tailored CVs and skills added to CVs. The counts are the provider's own: a
cloud provider's `usage`, and Ollama's `prompt_eval_count` (which leaves out a prompt start it had cached)
and `eval_count`. Where a provider doesn't say, they are estimated at about four characters a token and
marked as estimates. Only counts are kept, never a prompt, a reply, a model's name or a key, and days
older than 31 are dropped. `python3 llm_usage.py` prints today and the last 7 days, and Global settings
shows them ([Model tokens used](feedback-worker.md#model-tokens-used)).

### Smaller prompts for ratings

Ratings are most of the model requests, so their prompts are kept short without losing what matters:

- **Adverts are trimmed** (`trim_listing` in `job_extras.py`) before the first 5,000 characters are taken:
  menus, buttons, cookie and legal lines, share links, bare links and lines the page repeats are dropped,
  so more of the actual job fits.
- **The profile is compacted**: bullets are folded onto their heading (`Skills: Python; SQL`) and empty
  entries dropped.
- **A long profile is briefed once.** When the compacted profile is still over 3,500 characters, the model
  writes a brief of at most 1,800, kept in `state/rating_brief.json` until the profile changes, and used by
  title screening, ratings and second opinions. The brief is only used if it keeps at least 70% of the
  skills searched for and adds no figure or job title the profile doesn't have; otherwise, or when no
  model answers, the compacted profile is sent. The file holds a hash of the profile and the brief, and is
  encrypted with a data key like the other saved files.

Scoring and screening run at temperature 0, so the same advert gets the same score. Writing gets a little
variety: cover letters 0.4, tailored CVs 0.2 and report summaries 0.3. On OpenRouter, the many small tasks
(screening, ratings, second opinions, summaries and briefs) ask reasoning models to think briefly and
leave the reasoning out of the reply, which saves tokens on the tasks that need it least.

### Fewer and surer ratings

Two checks spend rating requests where they change the outcome:

- **A keyword prescreen.** Once a listing is fetched and has passed the region, type, salary and
  closing-date filters, the CV's keywords are looked for in it. A full listing (1,500 characters or more)
  naming fewer than `JOB_PRESCREEN_MIN_KEYWORDS` (default 1) is marked seen without a rating, and counted
  as "no CV keywords" under the report. It never applies to a job the title screen called a clear match, a
  job being retried, a short or snippet-only listing, or a CV with fewer than 8 keywords.
- **A second opinion by confidence.** Scores of `JOB_VERIFY_MIN_FIT` (default 8) or more get a sceptical
  re-check that can only lower them, by half the gap rounded up. A score that would be shown but has a
  confidence under `JOB_VERIFY_BELOW_CONFIDENCE` (default 60), on a full listing, gets the same re-check
  and moves halfway towards it either way; when the two are within a point, its confidence goes up to 70.
  The card says when a second look changed the score. Snippet-only listings are left alone, as a second
  look at the same few lines would not be surer.

### Cover letters from an evidence map

Before a letter is written, one request maps the job (`evidence.py`): the advert's main requirements, at
most 8, each with the strongest evidence from the CV in its own words and where it is (a role, projects,
skills or education), or marked as not shown. Evidence with a figure the CV doesn't have is dropped. The
map is kept in `state/evidence/` under a hash of the job, encrypted with a data key, until the CV or the
advert changes, and maps older than 30 days are deleted; a regenerated letter reuses it.

With a map, the letter prompt gets the compacted CV, the map and the first 2,500 characters of the
trimmed advert instead of 5,000. Each draft is checked without a model (`writing_checks.py`), and a rewrite
sends only the draft, what is wrong with it and the map (the CV instead when a job title needs fixing),
not the whole prompt again. Hard problems (too short, placeholders, job titles or figures the CV doesn't
have) get up to two rewrites and fail the letter if they stay; soft ones (stock phrases, missing most of
the requirements the CV shows, off the length asked for) get one. When no model answers the map, the letter
is written without it, as before.

Lengths and tones, from the request or `cover_letter.py --length/--tone`:

| Length | Paragraphs | Words | Reply tokens allowed |
| --- | --- | --- | --- |
| short | 3 | 170 to 260 | 800 |
| standard (default) | 4 | 250 to 380 | 1,100 |
| detailed | 5 | 350 to 480 | 1,400 |

Tones: professional (default), warm, direct and formal.

### Tailored CVs

The CV is read into a structured copy once (`state/cv.json`, `tailored_cv.py`) and rebuilt when it changes.
It is read from the uploaded CV (`cv.txt`, `COVER_LETTER_CV_FILE`). A profile without one, such as an
admin's own job search moved to a recruit, falls back to its job search profile (`job_profile.md`), a short
summary that may not mention every role; the email then says so and asks for the full CV, and uploading one
rebuilds the copy from it.
One request reads up to 14,000 characters; a longer CV is read in sections split between paragraphs (at
most 4, up to 42,000 characters) and the parts merged, a role split across two sections kept once with all
its bullets, instead of being cut off.

For each job the tailoring request gets the job's evidence map (the one the cover letter uses, from the
same cache) and the first 2,500 characters of the advert. The model picks and rephrases; the code then:

- keeps only skills the CV lists, and bullets with no figure the CV doesn't have (a role's own bullets
  replace any it refuses);
- orders a role's own bullets, where the model gave none, by how many of the job's requirements they name;
- cuts the bullets to about two A4 pages: 6, 5, 4 and 3 for the four newest roles, 2 for older ones, and
  650 words in all, always keeping each role's first bullet;
- reports which requirements the CV shows are covered, which were left out, and what the advert asks for
  that the CV doesn't show, at the end of the email.

In the PDF an entry's title moves to the next page only with the lines that follow it (a role's employer and
first bullet, a qualification's college), so a one-line entry still fits at the foot of a page.

### Testing prompts and models

`scripts/llm_bench.py` runs HermitShell's real prompts on the configured models with made-up CVs and
adverts (`scripts/bench/cases.json`). Each case rates a CV against an advert and checks the score lands
in the expected range; the good matches also get a cover letter and a tailored CV, checked without a
model (`writing_checks.py`) for figures and job titles the CV doesn't have, stock phrases, length and how
many of the advert's requirements they cover. Tokens are counted in a throwaway file, so a changed
prompt or a smaller model can be judged on quality and tokens before it goes live. Nothing is emailed or
saved.

```bash
python3 scripts/llm_bench.py                      # every case: ratings, letters and CVs
python3 scripts/llm_bench.py --tasks rating       # ratings only
python3 scripts/llm_bench.py --json bench.json    # also keep the full results
docker exec hermitshell python3 /app/scripts/llm_bench.py   # in the container
```

## Shared settings

Full template: [`.env.example`](../.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `SMTP_HOST` / `SMTP_PORT` | `smtp.gmail.com` / `587` | STARTTLS SMTP server |
| `SMTP_USER` / `SMTP_PASSWORD` | none | SMTP login. For Gmail, use an [app password](api-keys.md#gmail-app-password) |
| `SMTP_FROM` | `SMTP_USER` | Sender address |
| `ALERT_EMAIL` | `SMTP_USER` | Recipient |
| `HERMES_ALERTS` | `1` | [Admin alerts](#admin-alerts) by email. Also the **Admin alerts by email** switch under Features on Global settings |
| `ALERT_CREDITS_BELOW_PCT` / `ALERT_DISK_BELOW_PCT` | `10` / `10` | Alert when a key has less than this percentage of its allowance left, or the disk less than this percentage free |
| `FIRECRAWL_API_KEY` | none | Primary search and scrape provider |
| `FIRECRAWL_BACKUP_KEYS` | none | Comma-separated extra Firecrawl keys for when credits run low |
| `TAVILY_API_KEY` | none | Backup search and page extraction |
| `SCRAPFLY_API_KEY` | none | Backup scraping for bot-protected pages |
| `WEB_SEARCH_ORDER` | `firecrawl,tavily` | Search provider priority |
| `WEB_SCRAPE_ORDER` | `firecrawl,scrapfly,tavily` | Scrape provider priority |
| `SCRAPFLY_COUNTRY` | none | Scrapfly proxy country (two-letter code) for geo-blocked sites |
| `WEB_KEY_USAGE_MINUTES` | `60` | How often the dashboard's Global settings checks the credits left on each key, with the provider's free account endpoint (no search credits spent); `0` turns it off |
| `OLLAMA_HOST` / `OLLAMA_FALLBACK_HOST` / `OLLAMA_MODEL` | see above | The Ollama server and model |
| `OLLAMA_NUM_CTX` | autofit | Context size (tokens) for `OLLAMA_MODEL` |
| `HERMES_MODEL_CONCURRENCY` | `auto` | Model requests allowed at once across all scripts and profiles; the rest queue. `auto` = one per working Ollama instance |
| `OLLAMA_HOSTS` | none | Extra Ollama servers, comma-separated (`http://ollama-gpu1:11435`). Only `http(s)://host:port`, no logins or paths |
| `HERMES_AUTOFIT` | `auto` | `off` sends the model settings unchanged, with no context, GPU or thread tuning. See [Autofit](#autofit-gpu-cpu-and-context-chosen-for-you) |
| `HERMES_AUTOFIT_THREADS` | automatic | Fixed CPU threads per model request (`num_thread`), instead of timing both settings |
| `OPENROUTER_API_KEY` / `BAZAARLINK_API_KEY` / `FEATHERLESS_API_KEY` / `HUGGINGFACE_API_KEY` | none | Cloud model keys, for servers that can't run Ollama. See [Cloud models](#cloud-models) |
| `OPENROUTER_MODEL` / `BAZAARLINK_MODEL` / `FEATHERLESS_MODEL` / `HUGGINGFACE_MODEL` | `openrouter/free` / `auto:free` / `Qwen/Qwen2.5-7B-Instruct` / `openai/gpt-oss-20b:cheapest` | Each provider's model |
| `LLM_PROVIDERS` | `openrouter,bazaarlink,featherless,huggingface` | The order the cloud providers are asked in |
| `LLM_ORDER` | `cloud` | `cloud` asks the cloud providers first and Ollama when none answers; `local` asks Ollama first |
| `LLM_CLOUD_CONCURRENCY` | `2` | How many jobs a run rates at once when the cloud models answer first (1-8) |
| `HERMES_TIMEZONE` | `UTC` | IANA timezone for dates shown in emails and for the schedules |
| `HERMES_STATE_DIR` | `<scripts>/state` | Seen-state, caches and last reports |
| `HERMITSHELL_HOME` | parent of the scripts directory | HermitShell's home: `.env`, the schedule, backups. `/data` in the container. Environment only (`HERMES_HOME` is still read) |
| `HERMITSHELL_JOB_TIMEOUT` | `21600` | Seconds a scheduled run may take before it is stopped |
| `HERMITSHELL_CATCHUP_MINUTES` | `30` | A run missed while HermitShell was stopped is started late if it was due within this many minutes |
| `HERMES_DATA_KEY` | none (the wizard generates one) | Encrypts CVs, profiles, letters and backups. See [Data protection](#data-protection) |
| `HERMES_RETENTION_DAYS` | `365` | Jobs, answers, letters and tailored CVs untouched this long are deleted. `0` = keep forever |
| `HERMES_LOG_RETENTION_DAYS` | `90` | Logs and scheduled-job output older than this are deleted. `0` = keep forever |
| `HERMES_BACKUP_DIR` | `<home>/backups/nightly` | Where the nightly backups go. Point it at a second disk or a mounted share for an off-machine copy |
| `HERMES_BACKUP_KEEP_DAILY` / `HERMES_BACKUP_KEEP_WEEKLY` | `14` / `8` | Newest backups kept, plus the newest of each week for this many more weeks |

## Job finder settings

- Daily Vacancy Report: [`packages/daily-vacancy-report/.env.example`](../packages/daily-vacancy-report/.env.example),
  plus a regional example in
  [`examples/northern-ireland.env`](../packages/daily-vacancy-report/examples/northern-ireland.env).

### Job search (Daily Vacancy Report)

| Variable | Default | Purpose |
| --- | --- | --- |
| `JOB_REGION_NAME` | none | Region or city you're job hunting in. Empty = no location filter |
| `JOB_REGION_PLACES` | none | Comma-separated towns or areas that count as inside the region |
| `JOB_SEARCH_COUNTRY` | none | Two-letter country code for searches (`gb`, `ie`, `us`...). The dashboard picks it from a list of countries; a code that isn't in the list is shown as its own option and kept |
| `JOB_SEARCH_LOCATION` | `JOB_REGION_NAME` | Place name put into web searches, when it should differ from the region. `.env` only: saving the job search on the dashboard clears it, so searches use the region |
| `JOB_REMOTE_ANYWHERE` | `0` | `1` lets fully remote jobs through the region filter |
| `JOB_LEVEL` | `any` | `junior`, `mid`, `senior`, `lead` or `any`. Sets the seniority penalties below |
| `JOB_EMPLOYMENT_TYPES` | `Permanent,Contract,Temporary` | Types to keep: also `Full-time`, `Part-time`, `Internship`. Jobs that don't say are kept |
| `JOB_WORK_MODES` | `On-site,Hybrid,Remote` | Work modes to keep. Jobs that don't say are kept |
| `JOB_JUNIOR_PENALTY` / `JOB_SENIOR_PENALTY` / `JOB_LEAD_PENALTY` | from `JOB_LEVEL` | Fit points subtracted for Junior/Graduate, Senior and Lead/Principal titles |
| `JOB_MIN_SALARY` | `0` | Minimum yearly salary; jobs clearly paying less are left out. Unlisted salaries are kept |
| `JOB_SALARY_CURRENCY` | none | `GBP`, `EUR`, `USD`, `CAD`, `AUD` or `NZD` (`£`, `€`, `$` also work). Salaries in the others are converted to it at the day's rate and the minimum is in it. Empty = as advertised |
| `JOB_FX_URL` | Frankfurter | HTTPS address of the day's exchange rates (Frankfurter's JSON shape), fetched once a day and cached in `state/fx_rates.json`. `off` = never convert. The dashboard can't change it |
| `JOB_HIDE_UNNAMED_AGENCY` | `0` | `1` drops agency adverts that don't name the employer |
| `JOB_VERIFY_MIN_FIT` | `8` | Scores at or above this get a second, stricter look that can only lower them. `0` = off |
| `JOB_VERIFY_BELOW_CONFIDENCE` | `60` | A shown score with a confidence under this gets a second look and moves halfway to it. `0` = off. See [Fewer and surer ratings](#fewer-and-surer-ratings) |
| `JOB_PRESCREEN_MIN_KEYWORDS` | `1` | A full listing naming fewer of the CV's keywords than this is not rated. `0` = rate every listing |

`JOB_LEVEL` sets the three penalties (junior, senior, lead titles) like this: `junior` 0/2/3,
`mid` 1/1/2, `senior` 2/0/1, `lead` 3/1/0 and `any` 0/0/0. Setting one of the penalty variables
overrides just that value. When the title doesn't state a level, the model's reading of the
listing is used instead, with the penalty capped at 1. The target level, types, modes and region
are also given to the model when it scores each job.

Salaries are read from the listing (or the model's summary of it): ranges, `45k`, day rates
(×220) and hourly rates (×1950) are all converted to a yearly figure, and a job is only dropped
when its best case is below the minimum.

### Feedback buttons (Daily Vacancy Report)

| Variable | Default | Purpose |
| --- | --- | --- |
| `JOB_FEEDBACK_URL` | none | Your feedback Worker, e.g. `https://vacancy-feedback.<subdomain>.workers.dev`. Must start with `https://` (HermitShell never sends the token over plain http). Empty = no buttons |
| `JOB_FEEDBACK_SECRET` | none | Signs the button links and every request HermitShell makes to the Worker; the Worker holds the same value |
| `JOB_FEEDBACK_API_TOKEN` | none | Lets HermitShell fetch and clear answers from the Worker (signed requests only, once the Worker has seen one) |
| `INTERVIEW_PREP_AUTO` | `0` | `1` = make an interview prep pack by itself when a job reaches Interview (once per job, only for interviews in the last two days). Also the **Interview prep packs on Interview** switch under Features on Global settings. The **Interview prep** buttons on the dashboard work either way |
| `COVER_LETTER_KEEP_DAYS` | `7` | Days a finished cover letter, tailored CV or interview prep pack is reused (a request with no note sends it again instead of writing a new one) and kept, encrypted, on the Worker for download from the email buttons and the dashboard's Jobs sent list. At most `30`; `0` = neither |
| `CLOUDFLARE_ACCOUNT_ID` | none | Account the wizard and `scripts/cloudflare_worker.py` deploy the Worker to |
| `CLOUDFLARE_API_TOKEN` | none | API token for that deployment (Workers Scripts Edit, Workers KV Storage Edit; Access: Apps and Policies Edit for Access). Not changeable from the dashboard |
| `CLOUDFLARE_WORKER_NAME` | `vacancy-feedback` | Worker name, the first part of its `workers.dev` address |
| `CLOUDFLARE_ACCESS_EMAILS` | none | Emails Cloudflare Access lets through to `/admin`; empty = password only |
| `JOB_PROFILES_LIVE` | `on` | Keep the live link to the Worker up (a background `profiles.py listen` holding a WebSocket, told the moment anything is saved). `off` = poll instead, as below |
| `JOB_PROFILES_WATCH_SECONDS` | `250` | Without the live link: how long each 5-minute `profiles.py` run lasts (counted from its start), watching the Worker for dashboard changes and sign-ups after its sync; keep it under 300 so the next run isn't skipped. `0` = only sync at each run |
| `JOB_PROFILES_POLL_SECONDS` | `15` | Without the live link: how often it checks while watching (one KV read each time; at least 5) |

The wizard generates both secrets and, with a Cloudflare token, deploys the Worker itself
([cloudflare-setup.md](cloudflare-setup.md)). Deploying by hand (with the Cloudflare MCP in an AI
agent, or with wrangler) is covered in [feedback-worker.md](feedback-worker.md).

### Schedules

Run times aren't `.env` settings: they are jobs in HermitShell's scheduler (`cron/jobs.json`, managed with
`python3 scheduler.py`; see [schedule](installation.md#6-schedule)). The container and the service add the standard
jobs on first start. The wizard asks for the report's run time (`07:30`, `weekdays 08:00`, `sunday 18:00` or a
cron expression) and creates or updates the job. Times are in `HERMES_TIMEZONE`. There are four more jobs: the weekly roll-up (`job_weekly.py`, default Sunday
18:00), the cover letter and tailored CV requests check (`cover_letter.py`) and the profiles
check (`profiles.py`, which also watches for dashboard changes between runs), both every 5
minutes and silent when idle, and nightly maintenance
(`maintenance.py`, 03:30). In an unattended `--answers` file, use `SCHEDULE_DAILY_VACANCY_REPORT`,
`SCHEDULE_DAILY_VACANCY_REPORT_WEEKLY`, `SCHEDULE_DAILY_VACANCY_REPORT_LETTERS`,
`SCHEDULE_DAILY_VACANCY_REPORT_PROFILES` and `SCHEDULE_DAILY_VACANCY_REPORT_MAINTENANCE`.

Each person you invite gets one more job, `vacancy-report-<id>`, created, paused and removed with
their profile by `profiles.py`; it runs `profile_report.py` from their profile folder. The
dashboard's **Daily report** box sets each recruit's time (the admin, as staff, has no report of
their own), and **Send jobs now** runs a report at once
([feedback-worker.md](feedback-worker.md#send-jobs-now)).

### Admin alerts

The profiles check (`profiles.py`) also looks, at most every 15 minutes, for things you'd want to know
about before a recruit does, and emails the admin (the owner's address, else `ALERT_EMAIL`):

- a web search or cloud model key with less than `ALERT_CREDITS_BELOW_PCT` of its allowance left, as a
  percentage, since providers count credits, requests or dollars (from the usage checks Global settings
  shows, so none when `WEB_KEY_USAGE_MINUTES=0`);
- a cloud model resting because it is out of credits or its key was rejected;
- Ollama not answering for over 30 minutes, once it has answered before (or at once when there is no
  cloud model to fall back on);
- the last backup failed, or none has been made for 36 hours;
- less than `ALERT_DISK_BELOW_PCT` of the disk free;
- a feedback Worker on another protocol than HermitShell for over 30 minutes.

Each alert is emailed when it starts and at most once a day while it lasts, then one "all clear" when it
ends; everything found in one run goes into one email. Emails name providers and percentages, never a key.
What is open is kept, encrypted, in `state/alerts.json`. Turn them off with `HERMES_ALERTS=0` or the
switch under Features on Global settings, and send a test with `python3 alerts.py --test`.

## Data protection

What the people you invite are told is in [PRIVACY.md](../PRIVACY.md) (the Worker serves the same
text at `/privacy`, linked from the sign-up form, the welcome email and the unsubscribe page).
This is how it is carried out:

- **Encryption at rest.** With `HERMES_DATA_KEY` set, each profile's `profile.json`,
  `settings.json`, `cv.txt`, `job_profile.md` and `cv_keywords.json`, the tailored-CV cache and
  every cover letter and tailored CV, and the job finder's saved report, results and weekly roll-up
  (`state/job_scanner_last.html`, `job_scanner_last.json`, `job_scanner_weekly.html`) are written
  encrypted (AES-256-GCM, via the `cryptography` package, in the container image). Files written before the key was set are encrypted by the
  next maintenance run. Your own `job_profile.md` and `cv_keywords.json` in the scripts folder stay
  plain so you can edit them, as does the tracker database. The uploaded CV file is deleted once its
  text is read.
- **The key.** The wizard generates it (or run `python3 maintenance.py --new-key`) and writes it to
  `.env`. Keep a copy away from the server, in a password manager: without it the encrypted files and
  backups can't be read, and the backups can't help because the `.env` inside them is encrypted with
  the same key. `doctor.py` reminds you of this. Don't change it once set; `maintenance.py --decrypt FILE` opens a single file.
- **Permissions.** The scripts create files readable by HermitShell's account only (`0600`, whatever
  the umask), and maintenance resets everything under `state/`, the profiles folder and the backups
  to `0600`/`0700`.
- **Logs.** Logs aren't encrypted, so they name the role a line is about but never a key, a password,
  the employer or the salary.
- **Retention.** Maintenance deletes tracker jobs with no sighting, answer or letter for
  `HERMES_RETENTION_DAYS` (with their answers), older cover letters and tailored CVs, and logs and
  scheduled-job output older than `HERMES_LOG_RETENTION_DAYS`. Deleted database rows are
  overwritten and the file compacted. The skills you added are kept.
- **Backups.** Every night `.env`, the schedule (`cron/`) and the scripts folder with its state go into one
  encrypted archive (`hermitshell-<date>.tar.gz.enc`) in `HERMES_BACKUP_DIR`, rotated to 14 daily and 8 weekly
  copies (archives from an install inside Hermes, `hermes-*`, are rotated with them). Keep [a second copy](#a-second-copy-of-the-backups) on another disk.
  Restore with `python3 maintenance.py --restore FILE --to EMPTY_DIR`, then copy back
  what you need. The server panel on `/admin` (the server button beside Sign out) shows the last backup,
  its size and how many are kept, or why the last one failed, and has **Back up now**. That runs
  `maintenance.py --backup-now` in the background, never at the same time as the nightly run, and is refused within
  10 minutes of a backup. A failed backup also sends an [admin alert](#admin-alerts).
- **Unsubscribe and deletion.** A recruit's unsubscribe link, or Delete on `/admin`,
  removes its folder (profile, CV, tracker, letters, keys) within about a minute, drops its
  answers still waiting on the Worker, replaces its name, email address and profile id with
  `[deleted]` in the logs, and emails the person a confirmation. The link in a report you got
  before your own job search moved to a recruit only pauses that recruit. `profiles.py --delete ID` does the same from the command line.

### A second copy of the backups

Backups on the same disk as HermitShell don't survive that disk failing. Check with
`df -h /opt/hermitshell/data` and compare it with your other disks: on many NAS systems the apps
live on the small system SSD while the RAID or data disks are mounted elsewhere.

In Docker, `HERMES_BACKUP_DIR` is a path inside the container, so pointing it at another disk means
adding a volume to the container ([below](#backups-somewhere-else)). A host timer that copies the finished archives needs no
change to the container, and the container can't touch the copies. As root on the host (adjust the
two paths):

```sh
cat > /usr/local/sbin/hermitshell-backup-mirror <<'EOF'
#!/bin/sh
set -eu
SRC=/opt/hermitshell/data/backups/nightly
DST=/mnt/second-disk/hermitshell-backups
mkdir -p "$DST" && chmod 700 "$DST"
rsync -rt --ignore-existing --include='*.enc' --exclude='*' "$SRC/" "$DST/"
# Prune copies older than 120 days, but only while 14 newer ones exist.
if [ "$(find "$DST" -name '*.enc' -mtime -120 | wc -l)" -ge 14 ]; then find "$DST" -name '*.enc' -mtime +120 -delete; fi
EOF
chmod 700 /usr/local/sbin/hermitshell-backup-mirror
printf '[Service]\nType=oneshot\nExecStart=/usr/local/sbin/hermitshell-backup-mirror\n' \
  > /etc/systemd/system/hermitshell-backup-mirror.service
printf '[Timer]\nOnCalendar=*-*-* 04:15:00\nPersistent=true\n[Install]\nWantedBy=timers.target\n' \
  > /etc/systemd/system/hermitshell-backup-mirror.timer
systemctl daemon-reload && systemctl enable --now hermitshell-backup-mirror.timer
```

It runs after the 03:30 maintenance job, never deletes a copy because the source lost it, and
copies only the encrypted archives. On an immutable system where `/usr` is read-only, keep the
script next to the data folder instead (outside the folder mounted into the container). For a
copy off the machine, point `DST` at a mounted share or add an `rclone copy` to the script. Keep
the data key somewhere else, such as a password manager: a backup stored with its key protects
nothing.

If the host shares its disks over SMB (common on NAS systems), anyone with that login can read
`.env` and the backups, so give the share a strong password or leave HermitShell's folder out of it.

### Backups somewhere else

To have the container write the nightly backups straight to a NAS share or another disk, uncomment
the two backup lines in `docker-compose.yml` and set the folder next to it, in the `.env` that Compose reads
(beside `docker-compose.yml`, not `data/.env`):

```sh
HERMITSHELL_BACKUPS=/mnt/nas/hermitshell-backups
```

- **Mount it first.** The share must be mounted on the host before the container starts (an `fstab` entry
  or a systemd mount unit, with `x-systemd.automount` or `_netdev` for network shares). If it isn't,
  Docker creates an empty folder owned by root on the local disk, and the backups fail until it is.
- **Let uid 10000 write.** The container runs as uid 10000, so the folder must be writable by it:
  `sudo chown 10000:10000 /mnt/nas/hermitshell-backups` on a local disk or NFS export (where the NFS server
  squashes root, set the owner on the NAS itself), or `uid=10000,gid=10000,file_mode=0600,dir_mode=0700`
  in the CIFS mount options for an SMB share.
- **Check it.** Press **Back up now** in the server panel on `/admin`. Within a minute it shows the new backup,
  or the error (a permission error names the folder).

With `HERMES_DATA_KEY` set the archives there are encrypted; keep the key somewhere else.

## Keeping secrets safe

- Prefer container environment variables for keys and passwords, and keep `.env` in HermitShell's home
  readable only by its user (`chmod 600`; `doctor.py --fix` does this). The nightly backup includes `.env`, which is
  one more reason to keep `HERMES_DATA_KEY` set.
- Never commit a filled-in `.env`, `job_profile.md` or `cv_keywords.json`. The repo's
  `.gitignore` already excludes them.
- Logs show only the index and a masked prefix and suffix of the Firecrawl key in use, never the
  full key.
- The feedback secrets live only in `.env` and in the Worker's encrypted secrets. The wizard
  pipes them to `wrangler secret put` instead of printing them, and your KV namespace ID belongs
  in the untracked `feedback-worker/wrangler.local.jsonc`.
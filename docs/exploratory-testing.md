# Exploratory testing

A visible, rerunnable walkthrough of HermitShell from end to end: real Chromium windows for the admin, a
manager, a recruiter and each recruit, against a full local stack. It complements the automated suites
([Tests and CI](../README.md#tests-and-ci)) rather than replacing them, and it is **not part of CI**: it
needs Docker, and for its live mode a GPU and a web search key.

- [What it runs against](#what-it-runs-against)
- [First run](#first-run)
- [Commands](#commands)
- [The journeys](#the-journeys)
- [Replay and record](#replay-and-record)
- [Findings, screenshots and video](#findings-screenshots-and-video)
- [Walking through the demo image](#walking-through-the-demo-image)
- [Safety](#safety)

## What it runs against

`node explore/run.mjs up` starts the stack in [`explore/stack`](../explore/stack) with Docker Compose:

| Service | What it is |
| --- | --- |
| `worker` | The feedback Worker from this checkout under `wrangler dev`, over https with a private test CA |
| `backend` | The real HermitShell image built from this checkout's `Dockerfile`, read-only, all capabilities dropped |
| `ollama` | Ollama on the GPU (or the CPU with `EXPLORE_GPU=0`) with the model in `EXPLORE_MODEL` |
| `mailpit` | A test inbox: every email the backend sends lands here, over STARTTLS with login |
| `replay-search` | Only with `--replay` or `--record`: fictional adverts and recorded AI answers ([below](#replay-and-record)) |

Only `127.0.0.1` is published: the Worker on 8787 and the inbox on 8025. Before the scheduler starts, the
backend proves each way it connects trusts the test CA (requests, the plain SSL context smtplib and websockets
use, STARTTLS) and still trusts the public CAs; `node explore/run.mjs status` prints those probes.

## First run

```sh
cd explore && npm ci && cd ..
node explore/run.mjs up          # builds the backend, makes the CA, pulls the model; about 5 minutes the first time
node explore/run.mjs run         # every journey, in headed Chromium windows tiled across the screen
```

`up` creates the settings file outside the repo with fresh random secrets: on Windows
`%LOCALAPPDATA%\HermitShell\explore\.env.explore`, elsewhere `~/.local/share/HermitShell/explore/.env.explore`
(or `EXPLORE_HOME`). [`explore/stack/.env.explore.example`](../explore/stack/.env.explore.example) lists the
names it accepts; anything else, and any name that could reach production (`CLOUDFLARE_*`, `SMTP_*`,
`JOB_FEEDBACK_*` and so on), is refused. Add a `FIRECRAWL_API_KEY` there for live job scans; each scan is
capped by `JOB_SCANNER_MAX_SCRAPE` and `JOB_TRIAGE_MAX`. The admin password for `https://127.0.0.1:8787/admin`
is `EXPLORE_ADMIN_PASSWORD` in the same file.

## Commands

| Command | What it does |
| --- | --- |
| `up [--replay \| --record] [--no-build]` | Start the stack; `--replay` and `--record` use the replay servers |
| `down` | Stop it, keeping its data |
| `reset` | Stop it and delete its data, sign-ins and run state (the model stays downloaded) |
| `status` | Containers, the Worker, and the backend's TLS probes |
| `logs [service]` | The last 200 lines of one service or all |
| `checkpoint <name>` / `restore <name>` | Save or bring back the stack's data, e.g. after the slow sign-ups |
| `run` | Every journey (see below for the options) |

`run` takes:

| Option | Meaning |
| --- | --- |
| `--only signup,recruiter` | Just these journeys, in their usual order |
| `--from <checkpoint>` | Restore a checkpoint first |
| `--slow 300` / `--fast` | Pause (ms) before each action, highlighting it; `--fast` turns pauses, video and traces off |
| `--headless` | No windows |
| `--list` | List the journeys without running them |
| `--target URL` / `--inbox URL` | Walk through another HermitShell, such as the [demo image](#walking-through-the-demo-image) |

## The journeys

Each journey is one Playwright file in [`explore/journeys`](../explore/journeys), tagged so it can be run alone.
They build on each other in this order, and each one can be rerun.

| Tag | What happens |
| --- | --- |
| `@setup` | HermitShell reports in by itself; a test email arrives over STARTTLS; the setup list; Global settings (no key shown); **Recruits' own page** switched on |
| `@team` | The admin adds a manager (Morgan Ellis) and a recruiter (Riley Chen), puts Riley in Morgan's team; each sees only their own tabs |
| `@signup` | Sam Lee pastes a CV, Jordan Patel uploads a PDF, Taylor Reid a Word file, from invite links; the model builds each profile; the "profile is ready" and "New recruit" emails arrive |
| `@recruiter` | Riley sees only their pool, sets searches, tags and notes; **Send jobs now** brings Sam a report; the history |
| `@recruit` | Sam's report buttons (Interested, I applied, with Confirm); a tampered link is refused; Sam signs in to their own page with an emailed link |
| `@pipeline` | The applied job reaches the Pipeline; Riley moves it to Interview and asks for an interview prep pack, which is emailed |
| `@documents` | A cover letter and a tailored CV are written and emailed as PDFs |
| `@settings` | Theme name, palette and logo, recruiter and privacy branding; no key appears in the settings |
| `@retire` | Taylor is retired, keeps their data for 12 months from the email link, and is reactivated |
| `@multiuser` | What each role can see and do, a recruit moved between pools, notes seen by the manager, refusals |
| `@extras` | Only with `--only extras`: a second recruiter (Casey Quinn) and two more recruits (Drew Harper, Avery Lane), for the demo image |

The CVs are fictional, in [`explore/data`](../explore/data); `make.py` there remakes the PDF, the Word file
and the logo.

## Replay and record

`up --replay` swaps the live services for [`explore/replay`](../explore/replay), so a run needs no key, no
GPU and no internet:

- **Search**: twelve fictional adverts (data, engineering and marketing roles at `*.example` companies),
  served in Firecrawl's and Tavily's shapes. The backend is pointed at them with `FIRECRAWL_API_BASE` and
  `TAVILY_API_BASE` ([configuration](configuration.md)).
- **AI**: answers recorded from a real model, looked up by the request's messages with times, dates and ids
  normalised, so a rerun finds them. A request with no recording gets a minimal answer of the right shape, and
  `/replay/stats` on the replay server lists the misses by task.

`up --record` does the same but sends any request with no recording to the real Ollama and saves the answer to
`explore/replay/recordings.json`. After changing a prompt, run the journeys once with `--record` and commit the
new recordings.

## Findings, screenshots and video

Each run writes to a timestamped folder under `out/` in the settings folder (outside the repo):

- `findings.md`: every step as pass or **FAIL**, plus **BUG** and **note** lines, each with a screenshot;
- `report/`: Playwright's HTML report;
- `video/`: one video per window (not with `--fast`), and traces of failed steps.

Anything that looks like a key or a long token is masked before it is written.

## Walking through the demo image

The runner can drive the [demo image](demo-image.md) instead of the local stack. Copy the container's admin
password into a settings folder of its own, then point the runner at it:

```sh
docker cp hermitshell-demo:/data/explore/.env.explore "%LOCALAPPDATA%\HermitShell\explore\target\"
node explore/run.mjs run --target https://localhost:8787 --inbox http://localhost:8025
```

The local stack's secrets are never sent to the target. `EXPLORE_TARGET_HOME` picks another settings folder.

## Safety

- Every secret lives outside the repo and outside synced folders; `.gitignore` also excludes `.env.explore`,
  `explore/out/` and `explore/node_modules/` as a backstop.
- The settings file refuses names that could reach production, and the runner refuses to start when
  `JOB_FEEDBACK_URL`, `CLOUDFLARE_API_TOKEN` or `HERMES_DATA_KEY` is set in the shell.
- The runner reads the Worker's signed API but never posts `/api/status`, and a real search key is never typed
  into a page.
- The images are pinned by digest, and each service gets an explicit list of variables, never the whole file.

# Changelog

All notable changes to HermitShell are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and packages are versioned together
using [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`FIRECRAWL_API_BASE` and `TAVILY_API_BASE`.** Optional `.env` settings that send Firecrawl or Tavily
  requests, and the Global settings credit checks, to another host, such as the demo image's replay server.
  Only a plain `https://` address without a login, query or fragment is used; anything else is ignored with
  a log line, so a key never goes out unencrypted, and the dashboard can't set either one. Covered by
  `common/tests/test_api_base.py`, `test_key_usage.py` and `tests/security`.
- **Retire recruits, and let them choose what happens to their data.** A red **Retire** button on the bulk
  bar (for the ticked recruits) and a **Retire** section at the bottom of a recruit's page, each behind a
  confirm window with a tick box, stop the recruit's reports and email them a signed link (the `retire`
  action) to keep their profile for 6, 12 or 24 months for when they look for work again, or delete
  everything now. Without an answer it is kept for `HERMES_RETIRE_KEEP_MONTHS` (6 by default), then the
  nightly maintenance run deletes it. Deleting removes the profile, its traces in the logs and what the
  Worker keeps (the new `POST /api/forget`), and the new `maintenance.py --forget-backups` (also a nightly
  step) rewrites every backup on the server without them and replaces each copy on Cloudflare with the
  cleaned one; the people waiting to be removed are kept encrypted in `state/forget_backups.json`, which is
  never backed up, until every copy is clean. Retired recruits are left out of the Recruits list (**N
  retired** beside the count and **Retired** in the status dropdown show them), skipped by bulk changes and
  **Send jobs**, can't sign in to `/me`, and come back with **Reactivate** on their page. Links from before
  the latest retirement, or used after reactivating, change nothing. The privacy notice says how it works.
  Covered by `test/retire.test.js` (including who may retire, forged and expired links and `/api/forget`
  auth), `e2e/retire.spec.js`, `test_profiles.py` and `test_maintenance.py`.
- **Backups on Cloudflare, away from the server.** Each nightly backup and each **Back up now** is also sent
  to the feedback Worker, byte for byte the encrypted archive kept on the server (which stays), so a lost or
  broken server can be rebuilt from Cloudflare. `maintenance.py` now encrypts the archive before writing it,
  sends it in 1 MB parts over the signed API (`POST /api/backup/part`, with the archive's SHA-256), and keeps
  7 daily and 4 weekly copies there (`HERMES_BACKUP_OFFSITE_KEEP_DAILY` / `_KEEP_WEEKLY`; `HERMES_BACKUP_OFFSITE=0`
  turns it off). Only encrypted backups are sent; without `HERMES_DATA_KEY` nothing leaves the server. The
  Worker keeps them in the hub Durable Object's SQLite storage, in an instance of its own, refuses anything
  that isn't a HermitShell backup name or an encrypted archive, counts a backup only once every part has
  arrived, removes uploads left unfinished for a day and holds at most 40 backups and 1 GB. A failed send
  never stops the local backup: the server panel says so, an admin alert is emailed and the next backup
  tries again. The server panel shows when the last one was sent and how many are kept, with a **Download**
  link to the new **Backups on Cloudflare** page (`/admin/backups`, admins only), which lists them and says
  how to restore one after losing the server. `maintenance.py --list-offsite` and `--fetch NAME [--out PATH]`
  list and download them on the server, checking the SHA-256. Needs Worker and HermitShell protocol 7: redeploy
  the Worker. Covered by the Worker's `test/backups.test.js` (uploads, refusals, signatures and replays, roles)
  and `e2e/backups.spec.js`, `test_maintenance.py`, and a security test that only sealed backups leave the
  server and that failures never show the Worker's address or token.
- **Pick the server model, and watch it download.** **Change** on Global settings' **Server model** row
  opens a window listing Qwen3 30B-A3B, Qwen2.5 14B and 7B, Qwen2.5-Coder 7B, Llama 3.1 8B, the 4B default,
  Qwen2.5 1.5B and any other model the server's Ollama has, each with its size, whether it would run on the
  GPU or the CPU and how quick it would be there, and **recommended**, **downloaded** and **in use** tags; a
  model too big for the machine can't be picked, and **Another Ollama model** takes any `name:tag`. The row
  now says where the model comes from (**set here**, **from .env** or **fits this machine**) and when
  `JOB_SCANNER_MODEL` overrides it. The pick reaches HermitShell as a `local_model` admin item: a model Ollama
  has is saved at once as `OLLAMA_MODEL` in `state/dashboard.json` (the one Ollama setting the dashboard may
  set, and it wins over `.env`), and any other is downloaded first by the new `model_pull.py`, which checks
  the free disk space, streams Ollama's progress to `state/model_pull.json` and switches only once Ollama
  lists the model. The admin dashboard shows the download with a progress bar and a link to **Tasks**, where
  **Server model download** can be stopped, then a green notice for a day when it is ready (or why it failed,
  with the old model still running). Names are checked against Ollama's name format on both sides, and
  managers and recruiters can neither pick a model nor stop the download.
- **Manager role.** A dashboard user with the **Manager** role looks after a team: the recruiters an
  admin puts in it (the new **Manager** pick when adding or editing a recruiter) or that the manager
  adds, and those recruiters' recruits. Managers see the team's recruits, desk and fees, set fees, move
  recruits between their recruiters, invite people for them, and add, rename, reset the password of and
  delete their team's recruiters from the **Your team** tab (always with the Recruiter role only). They
  never see other teams, admins, the global settings, the server panel or tasks, and cannot export or
  delete notes or delete recruits. Demoting or deleting a manager empties their team; a manager who is
  also a recruiter takes over the recruits of a recruiter they delete.
- **Your page link in recruits' emails.** While `HERMES_SELF_SERVICE` is on, a recruit's daily report, weekly
  roll-up and welcome email end with a **Your page** link beside Unsubscribe (HTML and plain text). It is the
  plain `<JOB_FEEDBACK_URL>/me` address with no token, so a forwarded email signs nobody in; the main admin's
  reports, emails sent while the switch is off and non-https Worker addresses leave it out.
- **Recruits' own page (`/me`).** With `HERMES_SELF_SERVICE=1` (or the **Recruits' own page (/me)** switch
  under Features, off by default; Worker and HermitShell protocol 6) an active recruit can ask for a sign-in
  link at `/me` and see **My jobs**, **My job search** (their job search and report time, saved as their own
  change), **My documents** (letters, tailored CVs, prep packs, Word copies and their own CV with Make my CV),
  sign out (here or everywhere) and unsubscribe. Link requests are counted in the hub per address range (an
  IPv6 /64 as one), per hashed address and in total before anything touches KV, every address gets the same
  answer and the matching runs after it; without the hub nothing is sent. The token is 32 random bytes whose
  SHA-256 the hub keeps for 15 minutes and spends in one SQLite statement, so it works once even when two
  presses race; GET only shows a Sign in button. It reaches HermitShell sealed in a new `login_link` queue
  item, and `profiles.py` emails the link it builds from `JOB_FEEDBACK_URL` to the recruit's own address, one
  every 5 minutes at most, logging refusals without the address. The `__Host-hv_me` session is signed under its
  own label with a per-recruit epoch; it never opens `/admin`, an admin's session never opens `/me`, and a
  save carrying any field beyond the job search and report time is refused whole (HermitShell refuses a
  recruit's own change to their details too). Notes, tags, fees and other recruits are never shown. Admins
  get **Export these notes** on a recruit's page for subject access requests, and `PRIVACY.md` and `/privacy`
  gain a section on the page. Tests cover cookie swaps, forged ids, expired, replayed and raced tokens, the
  hub missing, uniform answers, the admin's and paused recruits' addresses and refused hidden fields.
- **Distance from home.** A recruit's job search can keep jobs within a set distance of their Home town, as
  the crow flies: **Within N km of home town** on their profile page (`JOB_MAX_DISTANCE_KM`, a whole number
  up to 500, off by default). The new `geo.py` downloads the country's places from GeoNames (CC BY 4.0;
  the request names only the country) once, keeps towns of 500 or more and every administrative seat in
  `state/geo/<cc>.json.gz` for all recruits, and refreshes it every 180 days, keeping the old copy if a
  refresh fails. With no checksums published, the download is held to 50 MB, the unpacked text to 300 MB
  read as a stream, and every row to GeoNames' 19 columns with valid positions and the right country; the
  cache is written to a temp file and renamed. Location lines are matched longest name first, a shared
  name prefers the Home town's region then the bigger town, and the haversine distance decides. Remote and
  hybrid jobs, and towns that aren't found, still go by the region filter. Each recruit's Home town reaches
  their scan as `JOB_HOME_TOWN`. `doctor.py` has a new `commute` check that warns when a recruit's filter
  can't work (no country, an unknown Home town or no place data). Tests cover the parsing caps (including a
  zip bomb and an endless line), the cache, matching, the dashboard field's limits and the security suite's
  hostile values.
- **Word copies of letters, CVs and prep packs.** With `DOC_WORD_COPIES=1` (or the **Word copies of letters
  and CVs** switch under Features, off by default) each cover letter, tailored CV and interview prep pack also
  gets a `.docx`, written by the new standard-library `letter_docx.py` in the PDF's layout, saved beside the
  PDF and attached to the same email. Text is XML-escaped with forbidden characters removed, part names are
  fixed and there are no fields, macros or external links; the tests read every copy back with the CV reader.
  The PDF and Word copy go to the Worker as one upload, kept as one sealed value (still two KV writes per
  document); the Worker checks the Word part's zip directory without unpacking it and offers **PDF** and
  **Word** under Download on the jobs sent, a **Word** button in the history and a **Word** link on the email
  button's page. Uploads may be 4 MB (the PDF still at most 2 MB). The Worker protocol goes to 5, and
  HermitShell sends Word copies only to a Worker that speaks it.

- **The desk, Also suits, and salaries by job title.** A new **Desk** tab (`/admin/desk`) shows the jobs
  sent, applied, interviews, offers and placed for 7 days to 12 months, as totals and as a card per
  recruiter with each recruit's line, plus (admins only) the fees from placements per currency and the
  desk's salaries by job title. Recruiters get it too, with only their own recruits and no fees.
  `profiles.py` adds up the trackers (`profile_stats.desk`) and posts them to the Worker's new `/api/desk`
  at most every 30 minutes and only when they changed; the Worker checks the shape and size and seals them
  before storing (`stats:desk`). An opened job on **Jobs sent** lists who else it suits: up to 5 other
  recruits it was a fit for in the last 90 days, with their scores, sent as profile ids only and shown only
  for recruits the viewer can see. The stats page has a **Salaries by job title** card (the median of each
  advert's lowest yearly figure for the commonest titles, once 3 give a salary), and the weekly summary's
  Who is hiring card adds **Typical salaries this week**. The Worker protocol goes to 4, and HermitShell
  sends the desk and Also suits only to a Worker that speaks it; `doctor.py` warns until the Worker is
  redeployed.

- **Interview prep packs.** A new `interview_prep` document: a PDF with facts about the employer from the
  advert only, the eight questions they are most likely to ask (each with why), answers in situation, task,
  action and result form built only from the job's CV evidence map (none when there is no map), and
  questions to ask them. No web lookups. It goes through the letters' honesty checks (figures the sources
  don't state, placeholders, stock phrases) with one rewrite, and is sent with a "Check before use" line if
  it still fails. Ask for one from the opened job on **Jobs sent** (once the recruit has applied) or the
  **Interview prep** button on Interview and Offer cards in the **Pipeline**, which then shows it being made
  and a **Prep pack** download; `cover_letter.py --prep <key>` makes one by hand. With
  `INTERVIEW_PREP_AUTO=1` (or the new **Interview prep packs on Interview** switch under Features, off by
  default) HermitShell makes one by itself for a job that reached Interview in the last two days, once per
  job and never after a manual one. Packs are kept in `state/interview_prep/` and on the Worker like letters,
  deleted with the recruit, and counted under their own **Interview prep packs** task in Tokens used.

- **Interview, offer and placed, and a Pipeline tab.** Applications now go on past **Heard back**: the
  follow-up email has a **Got an interview** button (which stops that job's reminders), and the tracker,
  weekly roll-up and stats know Interview, Offer and Placed (Interviews replaces Heard back in the tiles and
  the funnel, which ends with Placed). A recruit's new **Pipeline** tab (`/admin/pipeline?u=<id>`) shows
  each answered job in the column of its latest answer, from the board HermitShell already sends with the
  jobs sent (no extra KV writes, up to 200 cards over a year), and **Move** puts it in another column through
  the usual event queue (`POST /admin/stage`, CSRF-checked, the recruit's own recruiter or an admin). Admins
  can add a start date and fee to an offer or placement; the fee is sealed for HermitShell with the
  Worker's sealing key, kept in the tracker's new `events.meta` column and never shown on the board, in
  stats or to recruiters. The Worker protocol goes to 3, and HermitShell only sends the board to a Worker
  that speaks it; `doctor.py` warns until the Worker is redeployed.

- **Backups in the server panel, and Back up now.** The admin's server panel shows the last backup, its size
  and how many are kept, or why the last one failed (beside the last good one), with a reminder to keep
  `HERMES_DATA_KEY` away from the server, or a warning when backups aren't encrypted. **Back up now** queues
  one backup (admins only, once per 10 minutes); HermitShell runs `maintenance.py --backup-now` in the
  background under the nightly run's lock, and refuses it within 10 minutes of a backup or while maintenance
  runs. `maintenance.py` writes each outcome to `state/backup.json`, which the admin alerts already read.
  `docker-compose.yml` has commented lines for a second volume (`HERMITSHELL_BACKUPS`) that puts the backups
  on a NAS share or another disk; see `docs/configuration.md#backups-somewhere-else` for mounting it first
  and letting uid 10000 write.

- **A note with dashboard letters and CVs.** **Options** beside **Generate** and **Regenerate** on the list
  of jobs sent now asks "Anything to stress?" for the cover letter and the tailored CV (up to 300
  characters, control characters stripped), as the email button's page does. A note always gets a new one
  written, reaches the model only in its labelled note block, and is never written to the history ("with a
  note") or the task list. The email path and the dashboard share one note cleaner.

- **Several recruits at once.** A tick box on each row of the Recruits list brings up a bar with **Pause**,
  **Resume**, **Send jobs now** and, for admins, **Assign**, for up to 25 recruits. It works without
  scripts, checks each recruit as the single buttons do, skips the rest and says how many ("2 done, 1
  skipped"), and is one queue item with a history line per recruit. HermitShell runs a bulk **Send jobs
  now** as one background process that sends the reports in turn (`profiles.py report` now takes several
  ids), not all at once.

- **Notes and tags.** A recruit's page has a **Notes** box: notes for you and the other recruiters (up to
  1,000 characters, the newest 100 kept, deletable by their writer or an admin) and up to 8 tags. Tags show as
  pills on the Recruits list; pressing one lists only the recruits with it (`?tag=`), and the search finds
  them. Notes and the tags index are encrypted in KV and bound to their key, stay on the Worker (HermitShell
  never gets them), respect recruiters' pools, and are deleted when the recruit unsubscribes or is deleted.
  The history says a note was added, never what it said. Documents and notes now share one sealing module.

- **Admin alerts by email.** The profiles check (at most every 15 minutes) emails the admin when a web
  search or cloud model key has less than `ALERT_CREDITS_BELOW_PCT` (10%) of its allowance left, a cloud model
  is out of credits or its key was rejected, Ollama hasn't answered for over 30 minutes, the last backup failed
  or none was made for 36 hours, the disk is under `ALERT_DISK_BELOW_PCT` (10%) free, or the Worker has been on
  another protocol for over 30 minutes. Each alert is emailed once, again at most daily while it lasts, then
  "all clear"; one email per run, naming providers and percentages but never a key. State is kept encrypted
  in `state/alerts.json`. `HERMES_ALERTS=0`, or the new **Features** switch on Global settings, turns them off;
  `python3 alerts.py --test` sends a test.

- **A recruit's own CV.** A recruit's page has two buttons at the top right of the card. **Generate**
  (with the CV icon) asks HermitShell to lay out the CV they uploaded as a PDF, every role included and not
  tailored to a job, and spins until it is made. **CV** (with a download icon) only shows once one has been
  made and downloads it. HermitShell uploads the PDF to the Worker (`POST /api/cv`, API token, PDF of at
  most 2 MB) instead of emailing it; the Worker keeps it encrypted with no expiry until **Generate**
  replaces it or the recruit unsubscribes or is deleted. Generate is greyed out without an uploaded CV.
  The request shows on Tasks and History, can be cancelled, and works in demo mode.

- **Logo preview before saving.** On the theme page, picking a logo (WebP included) shows it in the preview
  straight away, from the browser's own copy, before **Save theme** uploads it. A file over 200 KB or not a
  PNG, JPEG, GIF or WebP picture is cleared at once with the reason. Signed-in pages allow `blob:` images for
  this; other pages don't.

- **Theme and branding.** Admins get a palette button at the top right, beside the server button, that
  opens `/admin/theme`. It sets a name and logo (PNG, JPEG, GIF or WebP up to 200 KB, checked by content;
  SVG refused) shown on every page and optionally as the tab icon, one of eight palettes or two custom
  colours, and the background, corners, font, spacing and motion, with a live preview. The Worker repaints
  its brand colours, stylesheet and favicon at render time, so HermitShell's look stays the default and
  **Reset** goes back to it. **Back to recruits** at the top left returns to the dashboard. Emails keep
  HermitShell's look.

- **Download from History.** A cover letter or tailored CV asked for or emailed, from the dashboard or an email
  button, has a **Download** button on the recruit's History tab while the document is still kept. The history
  entry keeps the job's hash for this; entries recorded before this change have no button. The demo's kept
  cover letter has one too.

- **Waiting pages update in place.** On the dashboard, a page waiting for HermitShell now fetches itself
  in the background and swaps in the new card instead of reloading, so what you are typing, an open
  window or menu, focus and the scroll are kept; it holds off while a field is in use or the tab is
  hidden. The swap is immediate, skipped when nothing has changed, and plays no entrance animation again.
  This is the dashboard's one script, `/enhance.js`, loaded from the Worker only by signed-in
  pages (`script-src 'self'`, no inline script); without scripts the page reloads as before. It also
  stops a form being sent twice by a double click, showing the pressed button as busy.
- **Smoother motion.** Pages switch at once, with no cross-fade or slide-in to wait for, and the account
  box, Back button and tabs stay where they are. Spinners, status dots and the background carry
  on across reloads instead of jumping back, the task list and save status don't slide in again on each
  update, and progress bars and pulsing dots move with transforms rather than widths and shadows. The
  stats icons and score-ring glows play a few times and then rest (hover to replay), long jobs-sent lists
  skip drawing the jobs off screen, small buttons get larger touch targets on phones, and jumping to a
  section no longer hides its heading under the fixed buttons.
- **Demo mode presses play out.** In demo mode a pretend HermitShell now does what a press asks for, a
  few seconds later, on the made-up data only: **Generate** on a cover letter or tailored CV shows
  **Being made&hellip;** and then a made-up PDF to download, **Send** turns into **Emailed**, a missing skill goes
  from **adding** to **added**, and pausing, resuming, assigning, deleting, **Send now** (a short pretend
  scan) and stopping tasks all land on the dashboard. What it did is kept for two hours in one
  `demo:state` entry, cleared whenever the switch is turned on or off. Nothing typed into settings, keys,
  CVs or users is kept, and nothing is queued for or sent to HermitShell.
- **A keyword prescreen before rating.** A full listing that names none of the CV's keywords is skipped
  without a model request (`JOB_PRESCREEN_MIN_KEYWORDS`, default 1), unless the title screen called it a
  clear match, and counted as "no CV keywords" under the report.
- **A second opinion for unsure scores.** A score that would be shown but that the model gave a confidence
  under `JOB_VERIFY_BELOW_CONFIDENCE` (default 60) is re-checked and moved halfway to the second score,
  up or down; close agreement raises its confidence. The card says why it was checked. See
  [Fewer and surer ratings](docs/configuration.md#fewer-and-surer-ratings).
- **A match report with each tailored CV.** The email lists how many of the requirements your CV shows
  the tailored CV covers, any it left out, and what the advert asks for that your CV doesn't show.
- **Tailored CVs led by the evidence map.** The CV uses the cover letter's evidence map (the same cache)
  and less of the advert; bullets that name the job's requirements come first and start with an action
  verb, and the bullets are cut to about two pages. See [Tailored CVs](docs/configuration.md#tailored-cvs).
- **Long CVs read in full.** A CV over 14,000 characters is read in up to 4 sections and merged, instead
  of being cut off.
- **Cover letter length and tone.** The cover letter's confirmation page, and a new **Options** pop-over
  beside **Generate** and **Regenerate** on the dashboard's jobs sent, choose a length (short, standard or
  detailed: 3, 4 or 5 paragraphs) and a tone (professional, warm, direct or formal). They reach HermitShell
  as request flags, show in the history, and a letter in another style is written rather than the kept one
  reused. `cover_letter.py --job KEY --length short --tone warm` does the same by hand.
- **Cover letters written from an evidence map.** One request per job pairs the advert's main requirements
  with the evidence in the CV (`evidence.py`), kept encrypted in `state/evidence/` until the CV or advert
  changes. The letter is planned on it and gets less of the advert. Drafts are checked for figures and job
  titles the CV doesn't have, placeholders, stock phrases, requirements missed and length, and a rewrite
  is sent only the draft and exactly what failed. See
  [Cover letters from an evidence map](docs/configuration.md#cover-letters-from-an-evidence-map).
- **Model tokens used, per task.** Every model request, cloud or local, now counts its prompt and reply
  tokens under the task that asked (job ratings, title screening, second opinions, summaries, profiles,
  reading CVs, cover letters, tailored CVs, skills), in `llm_usage.json` in the shared state folder
  (`common/llm_usage.py`). Global settings has a **Model tokens used** table with each task's requests,
  tokens in and out, tokens a request, time and share of the week, so it's clear where trimming prompts pays
  off. Counts come from the provider (Ollama's evaluated tokens, a cloud provider's `usage`) or are estimated
  and marked. Only counts are kept, never a prompt, reply, model name or key; `python3 llm_usage.py`
  prints them.
- **A bench for prompts and models.** `scripts/llm_bench.py` runs the real rating, cover letter and
  tailored CV prompts on the configured models with made-up CVs and adverts (`scripts/bench/cases.json`),
  checks ratings land in range and scores letters and CVs without a model (`writing_checks.py`: figures and
  job titles the CV doesn't have, stock phrases, length, requirements covered), with the tokens each task
  used. Nothing is emailed, saved or added to the real counts.

- **Demo mode.** The **Demo mode** switch on Global settings (admins only) fills every dashboard page
  with a made-up desk: fictional recruits in every state, recruiters, invites, a sign-up waiting, tasks,
  a cover letter PDF, and months of stats, jobs sent and history (`feedback-worker/src/demo.js`). Pages
  read and write a copy of that data made for each request, so presses work but save nothing, queue
  nothing and never reach HermitShell; changing your own password stays real. The API, email buttons,
  sign-ups and the privacy notice keep the real data, so reports carry on. A ribbon at the foot of each
  page says it is on, with a **Turn off** link for admins. Tests check that no press changes the real KV
  and that no real names show, and Playwright covers it on a phone.
- **Email a kept cover letter or tailored CV from Jobs sent.** Generating one from the dashboard keeps it
  for download only, so it never reached the recruit's inbox. A kept one now has **Email to Sam**
  beside **Download**: HermitShell emails that same PDF, without the model, and the tile
  says **Emailing to Sam…** until it has gone. The request carries `send: 1`, kept by the tracker as a
  new `send` flag instead of the download-only `quiet`. It is CSRF-checked, limited to a recruiter's own
  pool, written in the recruit's History and saves nothing in demo mode.
- **Cancels in History.** Stopping or cancelling a task from the Tasks window is written in that recruit's
  History with who did it (**Cancelled the tailored CV: …**, **Stopped the job report**); a cancelled global
  settings change belongs to no recruit and is not kept.
- **Cloud AI models for servers that can't run one.** OpenRouter, BazaarLink, Featherless and Hugging Face
  (all OpenAI-compatible) can rate jobs and write letters and CVs instead of, or before, the local Ollama
  (`common/llm_providers.py`). Keys and models are added on Global settings under **AI model API keys**,
  like the web search keys (a row and icon per provider, a window to paste the key and an optional model,
  **Use the .env key**), or in `.env` (`OPENROUTER_API_KEY`, `BAZAARLINK_API_KEY`, `FEATHERLESS_API_KEY`,
  `HUGGINGFACE_API_KEY` and their `_MODEL`s, `LLM_PROVIDERS` for the order). Defaults are free or cheap models
  (`openrouter/free`, `auto:free`, `Qwen/Qwen2.5-7B-Instruct`, `openai/gpt-oss-20b:cheapest`). Providers
  are asked in turn and Ollama is used when none has a key or credits left (**Cloud first**, with a cloud
  icon); **Local first** (`LLM_ORDER=local`, with a computer icon) turns that round. A provider that is out of credits or at its daily limit rests
  until the next UTC day, a rejected key for six hours and a rate limit for its Retry-After (at most an
  hour). Replies must be the JSON asked for (a JSON schema, or the schema in the prompt when a model
  refuses one), `<think>` blocks are dropped, and redirects are never followed. Each row shows what is
  left (OpenRouter's free requests today or credit, BazaarLink's credits, Featherless's plan, Hugging
  Face's account), the model and whether it is ready or resting. `doctor.py` only warns about a missing
  Ollama or model while a cloud key is set. The privacy notice says CVs and adverts go to the chosen
  service and that free models may keep them.
- **The local model fits the machine.** Without `OLLAMA_MODEL` or `JOB_SCANNER_MODEL`, autofit picks
  `qwen3:30b-a3b-instruct-2507-q4_K_M` with 24 GB of GPU memory or 48 GB of RAM, `qwen3:4b-instruct-2507`
  from 4 GB of GPU memory or 6 GB of RAM, and `qwen2.5:1.5b-instruct` below that. `doctor.py --fix`
  downloads that size and says how big it is.
- **Server panel for admins.** A server button beside the key button and **Sign out** opens, on hover
  or keyboard focus (no JavaScript), the machine HermitShell runs on (CPU and load, memory, GPUs, disk,
  with bars), the models in the order they are asked with their state, and which one gave the last
  answer. HermitShell adds the machine and models to its status; they don't count as a change, so the
  Worker's KV writes stay within the free plan.
- **Playwright browser tests and workflow.** A new **Playwright** workflow (`.github/workflows/playwright.yml`)
  runs 31 Chromium tests of the feedback Worker's pages on every push and pull request (`e2e/`, `npm run e2e`).
  The Worker runs locally under `wrangler dev` with fictional recruits and throwaway secrets, so no Cloudflare
  account is needed. They cover sign-in and sign-out, search, the dashboard tabs, a recruit's Manage and History
  tabs, saving, Send jobs now, pausing, email buttons, invite sign-up, recruiters and their access, phone and
  wide layouts, and security (cookie flags, CSP, forged CSRF tokens, the API token, escaped input). A failed run
  uploads the HTML report and traces. Vitest now only picks up `test/` (`vitest.config.js`).
- **History tab on each recruit's page.** A timeline of everything done on the account, newest first and
  grouped by day, saying who did it: profile saves (which fields), CV uploads, Send jobs now, pausing,
  resuming and assigning, cover letters, tailored CVs, emailed jobs and skills asked for, every email button
  the recruit pressed (once, never their notes), and from HermitShell's status reports each job report that
  ran and each new CV it read. Also linked from Stats and Jobs sent. Stored in the Worker's KV by month (one
  write per entry, at most 1,000 a month), shown only to admins and the recruit's recruiter, and deleted
  with the rest of the recruit's data when they unsubscribe or are deleted; the owner's is kept. Entries are
  cleaned of control characters, capped in length and escaped on the page, and a failed write never blocks
  the action. The privacy notice says so.
- **Salaries in your currency.** The profile page's Currency is now a list (pound, euro, US, Canadian,
  Australian and New Zealand dollar, or As advertised) instead of a text box. A job advertised in another of
  them shows the converted figure with the advertised one beside it ("£55,700 - £64,300 a year, converted from
  €65,000 - €75,000"), in the daily report, the job email and the dashboard's jobs sent; the median salary on
  the stats page is converted too, and the minimum salary now applies to converted figures instead of
  keeping every job in another currency. Rates are the European Central Bank's daily reference rates from
  Frankfurter (no key), fetched once a day and cached (`money.py`, `JOB_FX_URL`, `off` to turn it off).
  Adverts can write `US$`, `C$`, `A$`, `NZ$` or an ISO code (`50,000 EUR`); a bare `$` is the profile's
  dollar, else the search country's. Old `£`, `€` and `$` settings keep working as `GBP`, `EUR` and `USD`.
- **Web search key usage on Global settings.** Each provider with a key shows the credits left, and pressing
  it opens its keys in the order they are tried (Firecrawl's main key, then its backups), masked, each with a
  bar of what is left, the plan, when it resets and when it was checked, or why the check failed.
  HermitShell asks Firecrawl's credit usage, Tavily's usage and Scrapfly's account endpoints (no search credits
  spent) at most every `WEB_KEY_USAGE_MINUTES` (60; `0` turns it off) and caches the answers in
  `state/key_usage.json` (`key_usage.py`).
- **Add missing skills from the dashboard.** On the jobs sent list, each amber **Missing from the CV** skill
  of an opened job is now a button: an admin, or the recruiter whose pool it is, presses one the recruit has
  and it is stored as the email's **Add to my skills** answer, so HermitShell counts it as on the CV for
  ratings, cover letters and tailored CVs. It shows with a dashed tick until HermitShell's stats list it
  (`skills` in the stats, from the tracker's skills pool), then with a solid tick.
- **The salary icon shows the currency.** Emails and the dashboard draw the salary with a £, € or $ badge
  (Lucide) for the figure's currency, and a banknote when it has none.
- **Every image build is attached to a GitHub release.** The Image workflow's new release job gives a version
  tag its own release and replaces the rolling `latest-build` pre-release on each push to `main`. Each holds the
  digest-pinned `docker pull` command, the image for amd64 and arm64 as `docker load` files (for servers
  without registry access), `docker-compose.yml` and `SHA256SUMS`
  ([installation](docs/installation.md#without-registry-access)).

- **Who is signed in, at the top right of every dashboard page.** A badge with your initials, name and roles,
  and under it a key button (**Change password**) and **Sign out**, fixed in the corner like **Back to
  recruits**. On narrower windows they sit in a row above the page; the old "Signed in as" line at the foot of
  the Recruits page is gone.
- **Password changes and resets on the dashboard.** Every dashboard user, recruiters included, changes their
  own password with the key button at the top right, using their current password; they stay signed in
  there and are signed out everywhere else, and five wrong current passwords lock it for 15 minutes. Admins
  reset anyone else's password from **Reset password** on Users and roles, which signs that user out at once.
  The main admin's window shows how to change the `ADMIN_PASSWORD` secret with wrangler.

- **HermitShell runs on its own, on any Linux server.** It no longer needs Hermes: it has its own scheduler
  and reads its model from its own settings, and can be deployed three ways
  ([installation](docs/installation.md)):
  - **Container.** A new `Dockerfile` and [`docker-compose.yml`](docker-compose.yml) run it read-only, as uid
    10000 with no Linux capabilities, with every setting and all data in one volume (`/data`). On each start
    it installs the image's scripts into `/data/scripts` (personal files untouched), adds the standard
    schedule the first time and runs the scheduler; `docker exec hermitshell /app/entrypoint.sh setup`,
    `doctor` and `worker` run the wizard, the health check and the Worker deploy. Its health check fails
    when the scheduler stops checking in.
  - **Service.** `sudo sh scripts/install-service.sh` installs it into `/opt/hermitshell` for a new
    `hermitshell` account and keeps the scheduler running as a hardened systemd service (or from cron
    where there is no systemd).
  - **Files only.** `install.sh` into any folder (`HERMITSHELL_HOME`), then `scheduler.py run` or
    `scheduler.py tick` from cron.
- **Its own scheduler, `scheduler.py`.** Runs each script on a cron expression in `HERMES_TIMEZONE` (daylight
  saving included), from `cron/jobs.json`; each run's output goes to `cron/output/<job id>/`. A job still
  running when it's next due is skipped, a run missed while HermitShell was stopped is started late if it
  was due within `HERMITSHELL_CATCHUP_MINUTES` (30), and a run is stopped after `HERMITSHELL_JOB_TIMEOUT`
  seconds (6 hours). `list`, `create`, `edit`, `pause`, `resume`, `remove` and `start` manage jobs;
  `defaults` adds the packages' standard schedule (the new `packages/daily-vacancy-report/jobs.json`);
  `import FILE --map /opt/data=/data` takes over the jobs of a Hermes install, with their folders, times
  and paused state. Jobs only run `.py` scripts from the scripts folder, in folders inside the home.
  `profiles.py` creates, moves, pauses and removes each recruit's report job through it, and `doctor.py`
  checks it (jobs, failed runs, whether it's running; `--fix` adds the standard schedule).
- **The image is built and published by GitHub.** A new [Image workflow](.github/workflows/image.yml)
  builds it on every push and pull request, starts it with an empty data folder and checks the scheduler
  comes up healthy with the standard jobs, scans it with Trivy (fixable critical CVEs fail) and, on `main`
  and version tags, publishes it for amd64 and arm64 to `ghcr.io/metaheurist/hermitshell`.
- **Servers update themselves.** `scripts/host/install-updater.sh` installs `hermitshell-update.timer`, which
  every 10 minutes pulls the image and, only when there's a new one, recreates the container with the same
  settings and data. The server asks the registry, so no port, key or deploy access is needed.
- **Settings for the model:** `OLLAMA_NUM_CTX` sets the context size for `OLLAMA_MODEL`. Ollama is also
  looked for at `http://host.docker.internal:11434` (published on the Docker host), after `OLLAMA_HOST`,
  `OLLAMA_FALLBACK_HOST` and `http://ollama:11434`.

- **Dashboard users and roles.** A new **Users and roles** tab (`/admin/users`, admins only) adds
  people who can sign in to `/admin`, each with a name, username, password and the **Admin** or
  **Recruiter** role (or both). **Add user**, **Edit** and **Delete** use CSS-only windows; passwords
  under 12 characters are allowed but marked **short password**. The main admin still signs in with
  `ADMIN_USER` and `ADMIN_PASSWORD`, always has the Admin role and can take the Recruiter role too.
  Accounts live in one KV key, `accounts`. Each page footer says who is signed in, with their roles.
- **Recruiter pools.** A recruiter sees only their own recruits: the people they invite and the
  recruits an admin assigns to them. They can manage those recruits' details, CVs and daily
  reports, send jobs now, pause and resume them and see their stats and jobs sent, and nothing
  else: no other recruits, settings, users, deleting or other people's tasks. Invites record whose
  pool the person joins; admins pick it from a list (their own when they have the Recruiter role).
  A new **Recruiter** column with **Assign** moves a recruit between pools. HermitShell keeps the
  recruiter in `profile.json`, reports it to the dashboard and gains `profiles.py --assign ID
  RECRUITER`; `--list` shows it.
- **Searching a recruiter lists them first, followed by all of their recruits.** Recruit search also
  matches the recruiter's name and username, so a recruiter and a person together finds that person
  under their recruiter.

- **Email a job to its profile from the jobs sent list.** An opened card on `/admin/sent` has a third
  tile, **Email to Sam** (**Email to you** on your own list): **Send** asks HermitShell to email that
  job to the profile within 5 minutes, as the card it had in the daily report with its buttons signed
  for that profile, without using the model (new `job_mail.py`, carried out by `cover_letter.py`). A
  loading circle shows while it goes, then **Emailed to Sam** with when, and **Send again**. The
  request is a `send_job` event, asked for only from the signed-in dashboard (CSRF-checked), never
  from an email link, and shows in Tasks as **Job email**. HermitShell then calls the new
  `POST /api/emailed` (API token), and the Worker keeps only when each job was emailed, under a hash
  of its key (`emailed:<profile>`, the last 300 jobs, 90 days); removing a profile deletes it.
  [PRIVACY.md](PRIVACY.md) says so.
- **Full job cards, and letters and CVs to download, on the jobs sent list.** Pressing a job on
  `/admin/sent` opens everything its email card showed: tags, salary, the fit, confidence and CV
  keyword meters, why it was rated a fit, the company and role, the skills matched and missing, and
  links to the advert and the employer. Each card has a **Cover letter** and a **Tailored CV** with
  **Generate** (made within 5 minutes for download, not emailed, with a loading circle and a page
  that refreshes itself until it is ready), then **Download** and **Regenerate**. Contact details and
  the profile's name and email are removed from the text before it leaves the server.
- **Letters and CVs are made once and kept for 7 days.** A new `COVER_LETTER_KEEP_DAYS` (default
  `7`, at most `30`, `0` = off) sets how long a finished letter or CV is reused and kept, counted from
  when it was first made. Pressing the same button in another email offers the one already made for
  download (**Confirm: write a new cover letter** still writes a new one), and a request without a
  note sends the kept PDF again without using the model. The Worker keeps each PDF in KV encrypted
  with AES-GCM under a key derived from `JOB_FEEDBACK_SECRET`, bound to its profile, job and kind, and
  serves it only to a signed-in admin or a signed link for that job, as a download that can't run in
  the browser. New `POST /api/doc` (API token, PDF only, 2 MB), `GET`/`POST /admin/doc` and
  `GET /f/doc`. Removing a profile deletes its kept documents. [PRIVACY.md](PRIVACY.md) says so.

- **A HermitShell mark, as the tab icon and on every Worker page**: a white spiral shell on the
  brand's indigo-to-violet rounded tile, lit from the top left like the buttons. It replaces the plain
  gradient square next to "HermitShell" at the top of each page (drawn inline, so pages load nothing
  more) and is served by the Worker as the tab icon at `/favicon.svg` (and `/favicon.ico`). The
  pages' security policy now allows images from the Worker itself only, for this icon.

- **See the jobs sent to each person from the dashboard.** A row's sent button now has two halves:
  the little chart opens the stats page as before, and **24 sent** opens `/admin/sent`, the jobs in
  that profile's reports grouped by day. Each job shows its score, title (linking to the advert),
  employer, place, work mode, salary, source and the last button pressed. It covers 7, 30 or 90 days,
  with filters for **No answer yet** and each answer. The stats page links to it too. HermitShell sends
  the last 90 days (up to 150 jobs) with the stats. Only web links are kept, and notes typed on the
  buttons are never sent. [PRIVACY.md](PRIVACY.md) says so.

- **Autofit: the model runs where it's fastest.** A new `autofit.py` sizes each model request to
  the machine. It uses the smallest context that holds the request (8k to 64k tokens). It learns
  from Ollama how much of the model fits on the GPU at each size, so a 4 GB card runs a 4B model
  about 94% on the GPU instead of mostly on the CPU, roughly twice as fast. When the model runs on
  the CPU, it times one thread per core against every thread and keeps the faster setting. A
  watchdog steps down when Ollama runs out of memory (smaller context, then fewer GPU layers, then
  CPU only) and steps back up after 30 minutes of good requests. `python3 autofit.py` shows what it
  chose; `--calibrate` loads each size once to measure it. `HERMES_AUTOFIT=off` turns it off. See
  [configuration.md](docs/configuration.md#autofit-gpu-cpu-and-context-chosen-for-you).
- **Several Ollama servers at once.** Extra servers in `OLLAMA_HOSTS` each get a slot in the shared
  queue, and job ratings run in parallel across them, still listed in order.
  `HERMES_MODEL_CONCURRENCY=auto` (the new default) allows one request per working server. A failing
  server rests, for longer each time it fails again. A server more than 4 times slower than the fastest
  is benched and retried after an hour.
- **A host watchdog for the GPU.** `scripts/host/install-watchdog.sh` adds a systemd timer that runs
  every 2 minutes as root. It reports the CPU, memory and GPUs to autofit, since the scripts' container
  can't see them. It also restarts an Ollama container that has lost its GPU, which happens silently
  after a `systemctl daemon-reload`, at most once every 20 minutes and 6 times a day. See
  [installation.md](docs/installation.md#use-the-gpu).
- **The wizard uses every GPU.** It detects NVIDIA and AMD GPUs and adds the NVIDIA device nodes. AMD
  gets the ROCm image. With several GPUs it offers one Ollama per GPU. It turns on flash attention and
  a q8_0 KV cache, warns when an existing Ollama container can't see the GPU, and calibrates autofit
  after the model is downloaded.
- **`doctor.py` says where the model runs** ("loaded at 8192 context, 94% on the GPU, the rest on the
  CPU") and warns when a machine with a GPU runs the model on the CPU.

- **A task list on the dashboard, with Stop and Cancel.** A **Tasks** button next to the search has a
  spinning ring while something runs and the number of tasks in its corner. It opens a window, CSS
  only with no JavaScript, listing everything HermitShell is doing or has waiting: daily reports and
  reports sent now (with their stage and "14 of 25" while jobs are rated), cover letters and tailored
  CVs being written or queued, email-button requests not yet collected, and queued dashboard changes,
  sign-ups and resume requests, each tagged with where it came from. **Stop** ends a running report
  (its scan's process group, with no report recorded for that day) or the letter being written;
  **Cancel** drops a waiting task. HermitShell checks every cancel against the task id and profile,
  and only signals a process still running the expected script. The list refreshes itself while open.
  - `job_scanner.py` reports its stage and progress; `profiles.py` pushes it with the status about once
    a minute during a report, and sends the task list in its status.
  - Cancelled requests are kept in the tracker as `cancelled` and never retried.
- **Profile search on the dashboard.** An animated magnifying glass above the profiles table slides out a
  search box, with CSS only and no JavaScript. Enter lists the profiles whose name, email, id, place,
  status or crawler contain every word (`/admin?q=`, up to 60 characters). It shows how many profiles
  match, a message with a way back when none do, and **&times;** to clear the search.
- **A tidier Crawler column, with an Add key window.**
  - A profile's row shows its crawler key only when it has one: the provider (Firecrawl or Tavily) and
    the start and end of the key. The owner's row shows the global key, tagged **global**.
  - Without a key, **Add key** opens a window, CSS only with no JavaScript, to pick Firecrawl or Tavily
    and paste the key. **Change** and **Remove** replace the key or go back to the global keys.
  - A profile's own key can now be a Tavily key. It's saved with its provider in the profile's
    `secrets.json`; the older Firecrawl-only file still works.
  - The status HermitShell sends has a new `provider` field for each profile.
- **A stats page for every profile.**
  - A **Stats** button on each dashboard row, showing this week's jobs sent as a small line and a number,
    and on each profile's page, opens `/admin/stats`. It covers the last 7 days, 30 days, 90 days or 12
    months.
  - **Tiles** for postings scanned, jobs rated, jobs sent, average match, liked, applied, heard back, and
    letters and CVs. Each tile has a line of the period and its change against the period before.
  - **Chips** for strong matches, scans, the best day, week or month, and the median salary.
  - **Charts:** an activity chart, a funnel, a ring of the buttons pressed, match scores from 0 to 10, where
    applications stand (with the reply rate), top employers and sources, and the best matches sent.
  - It is all inline SVG and CSS with animated icons, and there's no JavaScript. The motion is off for
    people who ask for reduced motion.
  - The new `profile_stats.py` counts each day from the profile's tracker. `profiles.py` sends the result
    to the Worker's new `/api/stats` when it changes: at most every 30 minutes per profile, and straight
    after each report. Notes, job links and contact details stay on the server. A deleted or
    unsubscribed profile's stats are removed, and the privacy notice says what the stats page holds.
- **Send jobs now, and a Hermes job for every profile's daily report.**
  - **Send jobs now**, on the dashboard and on each profile's page, runs that profile's report
    straight away. HermitShell starts it within seconds over the live link, in the background
    (`profiles.py report --now <id>`), and the email arrives when the scan finishes, even if
    nothing new turned up. It works for a paused profile too, as a one-off.
  - Each person you invite now gets their own Hermes cron job, `vacancy-report-<id>`, running the
    new `profile_report.py` from their profile folder. Before, their reports ran one after the
    other in a background process started by your run. `profiles.py` keeps the jobs in step with
    the profiles: it creates a job with the profile, pauses it while the profile is paused and
    removes it with the profile. So `hermes cron list` shows every report, and one person's slow or
    failed run no longer holds up the others. New jobs start 15 minutes apart after yours. Without
    Hermes' scheduler, your run still runs everyone's reports.
  - A **Daily report** time (every day or weekdays) on each profile's page moves that profile's
    Hermes job, yours included. The dashboard shows every profile's report time.
  - While any report runs, the dashboard shows **scanning now**, and the profile page's status box
    says when it started, until it finishes.
- **A live link between HermitShell and the Worker, free.** The dashboard said "Last update: 8
  minutes ago" even though HermitShell was checking every 15 seconds, and a save could still take
  a while to arrive. Now:
  - The cron job keeps one background `profiles.py listen` process holding a WebSocket out to the
    Worker's new `/api/live`. The moment anything is saved, the Worker pushes it down the link,
    and HermitShell applies it within a second or two.
  - The link runs on a free SQLite-backed Durable Object (`Hub`), which `cloudflare_worker.py`
    creates with the Worker. The socket hibernates and its pings are answered without waking it,
    so holding it all day costs a few hundred requests and almost no time on the free plan. Your
    server still accepts no incoming connections.
  - The dashboard shows **HermitShell is connected** with a green dot while the link is up.
    Otherwise it says when HermitShell last checked in, where every poll counts, rather than when
    it last sent a full report.
  - It reconnects after a drop (every Worker deploy closes the link) and restarts itself when
    `profiles.py` changes. A push whose item isn't listed yet is retried.
  - Without the link (an older Worker, `JOB_PROFILES_LIVE=off`, or no `websockets` package), each
    run polls `/api/queue/flag` as before, and tries the link again hourly.
  - Deleting a profile now also scrubs the listener's log, rotated `.log.1` logs and the
    per-profile runs log.
- **A cleaner, more modern look for the Worker's pages.** The dashboard, sign-in, sign-up and button
  pages have a softer background with a slow-moving glow and a lighter card that eases in.
  - Tabs are now a segmented switch. Buttons use a gradient and lift on hover. Boxes glow when
    focused, and the checkboxes for employment type and work location are pill toggles. File
    pickers have a styled button.
  - The setup checklist has a progress bar and animated ticks, and the steps still to do pulse
    gently. Profiles show initials avatars, and status pills have a coloured dot.
  - Messages after a save or an error appear as banners. The save status box has a spinner while
    waiting and a tick once applied.
  - It is all CSS: the pages still load no scripts, fonts or images, and every animation stops if
    your system asks for reduced motion. The screenshots are taken with reduced motion, so they
    show pages as they end up.
- **Saves no longer vanish, and two people can't overwrite each other.** A profile's details and
  job search are now one form with one **Save changes** button, next to one **Upload CV**. Before,
  saving reloaded the page with the old values until HermitShell's next check, so the form looked
  as if it had been wiped. Now the page lays every change still waiting for HermitShell over what
  it last reported, so what you saved stays on screen. The email server form on Global settings does
  the same. A small status box at the top of the profile page says **Waiting for HermitShell**, then
  **Applied by HermitShell** (or why it couldn't be applied), checking again by itself. It is a
  framed page, not JavaScript, and it slows down and then stops so it doesn't use up the free
  plan's daily KV list quota. Each form remembers the values it opened with, and only the fields
  you changed are saved. If someone else changed *other* fields in the meantime (another admin, a
  CV rebuild), both changes are kept. If they changed the *same* field, nothing is saved: the page
  comes back showing both values, with your version still in the form. HermitShell applies each
  change field by field onto the current settings.
- **HermitShell picks up dashboard changes within seconds.** `profiles.py` no longer waits up to 5
  minutes for its next run. After each sync it keeps checking a new `/api/queue/flag` endpoint every
  15 seconds until just before the next run: one KV read each time, well inside the free plan. It
  syncs as soon as something new is queued. Sign-ups, deletions, CV uploads and settings all
  benefit. `profiles.py --once` syncs once and exits. `JOB_PROFILES_WATCH_SECONDS` (`0` turns
  watching off) and `JOB_PROFILES_POLL_SECONDS` tune it. Admin pages also skip listing the queue
  when it is empty. (The live link above now does this in about a second; polling is its fallback.)
- **Dashboard times in your timezone.** The admin pages showed every time in UTC, so during
  British Summer Time the last update looked an hour old. Times now use `HERMES_TIMEZONE` (sent by
  HermitShell with its status), and the status line says how long ago it was ("4 minutes ago").
  HermitShell now refreshes its status every 15 minutes instead of hourly, and a warning appears
  if it hasn't reported for 45 minutes.
- **Simpler profile page.** Country is now a dropdown of countries by name instead of a
  two-letter code box. The separate "Location used in web searches" box is gone: searches use
  Region or city (a dashboard save clears `JOB_SEARCH_LOCATION`). "Towns that count as inside it
  (comma separated)" is now just **Towns**. Labels are plain, with a short hint under each box
  instead of text in brackets. The minimum salary box is empty for no minimum and accepts `£45,000`.
  The "All profiles" link is replaced by a **Back to profiles** button that stays in the top-left
  corner while you scroll. The Global settings labels got the same treatment. In the profiles
  table, "Settings, job search and CV" is now just **Manage**.
- **Global settings tab.** The email server and web search API keys have moved off the profiles
  list to their own **Global settings** page (`/admin/settings`), because they apply to the whole
  tool. **Profiles** and **Global settings** tabs sit at the top of every admin page. The setup
  checklist links there, and saving either form returns to it. Each profile's own page still sets
  where that person's reports go.
- **Named HermitShell throughout.** Emails, the Worker's pages, the dashboard, the privacy notice
  and the docs now say HermitShell where they meant the job finder ("HermitShell fit", "Waiting for
  HermitShell", "HermitShell has deleted your profile"). Hermes still names the Hermes Agent platform
  it runs on: its home folder, `config.yaml`, model, container and `hermes cron`. Settings such as
  `HERMES_HOME` are unchanged. The default sender for letters is now "HermitShell cover letters".
  The Worker's pages (sign-in, dashboard, sign-up, buttons, privacy) are headed HermitShell rather
  than Daily Vacancy Report, and the sign-up page is titled "Join HermitShell".
- **Tidier job cards.** The buttons are no longer in one crowded row. Thumbs up and down sit under
  the fit score. **View job**, **I applied** and **Interested** follow a divider. **Cover letter**
  and **Tailored CV** share a "Made for this job" panel below them. The "Rated from the search
  snippet only" note is gone.
- **Settings on the dashboard.** The Worker's `/admin` page now has a setup checklist (Hermes
  connected, email server, test email, web search key, CV, job search), an **Email server** section
  (SMTP server, port, login, app password, sender, with a **Send a test email** button and the last
  result), and **Web search API keys** for Firecrawl (several allowed), Tavily and Scrapfly. Each
  profile has its own page, linked from the profiles table, for the person's details, the whole job
  search (titles, region and towns, country, remote, level, employment types, work modes, minimum
  salary, agency adverts) and uploading a new CV, which rebuilds their profile and keywords. Changes
  are applied by Hermes within about 5 minutes. A change Hermes rejects is shown at the top of the
  page for a day. Passwords and keys are never shown again, only their last four characters.
- **Shorter setup with Cloudflare.** The wizard now asks for the Cloudflare account and token right
  after the prerequisites. When the Worker can be deployed, it only asks for the `/admin` username
  and password (required for a new Worker), the timezone, optionally the email server, and the run
  times. It then points you to `/admin` for the rest. Without a token, or with `--advanced`, it asks
  everything as before. The test email is only offered once an email server is set.
- **Accounts and API keys guide.** [docs/api-keys.md](docs/api-keys.md) covers creating a Gmail app
  password and Firecrawl, Tavily and Scrapfly accounts, where each key goes, their free limits and
  how far one report's usage goes within them.
- **Prerequisite doctor.** `doctor.py` (installed next to the scripts) checks Python, the
  packages in the new [requirements.txt](requirements.txt), Hermes' config, Ollama with the model
  the scripts will use, `.env` permissions, the data key, email and web search settings, the
  feedback Worker and free disk space. `--fix` installs missing packages with pip, or uv when
  Hermes' Python has none (as in the official image), into `scripts/.deps/pyX.Y` on the data volume
  so they survive container updates; downloads the model through Ollama's API; makes `.env`
  owner-only; and generates the data key, never replacing a lost one. The CVE audit now covers
  `requirements.txt`.
- **Self-configuring setup.** The wizard now runs the doctor right after installing: it installs
  missing packages, offers to start an `ollama/ollama` container on the Hermes container's network
  when no Ollama answers (reusing an existing one, with the GPU when there is one), sets
  `OLLAMA_HOST`, asks for the model and downloads it. It ends with a health check. `--no-prereqs`
  skips all of this.
- **Second backup copy.** [docs/configuration.md](docs/configuration.md#a-second-copy-of-the-backups)
  shows how to check whether the backups share a disk with Hermes and sets up a host timer that
  copies the encrypted archives to another disk or share without changing the container.
- **Screenshots** of the privacy page and the goodbye email in
  [docs/screenshots.md](docs/screenshots.md), and refreshed pictures of the pages and emails that
  now link to the privacy page.

- **Security tests and static analysis.** A security test suite (`tests/security`) checks that
  hostile job keys, profile ids, names and CV files are handled as data (SQL, paths, HTML, log
  scrubbing, XML entity and zip bombs), that feedback links are bound to their profile, action,
  job and day, that restores refuse archives writing outside their folder, and that files and
  backups are owner-only and encrypted. The Worker's `test/security.test.js` checks security
  headers, escaping, API tokens, admin sessions and CSRF, and size limits. The Security workflow
  runs both suites and Bandit.

- **Data protection.** A new nightly job, `maintenance.py` (scheduled by the wizard as
  `vacancy-maintenance`, 03:30), carries out the new [PRIVACY.md](PRIVACY.md):
  - *Encryption at rest:* with `HERMES_DATA_KEY` (generated by the wizard) each profile's files,
    CV text, the tailored-CV cache and every cover letter and tailored CV are written encrypted
    (AES-256-GCM); older files are encrypted on the next run. Uploaded CV files are deleted once
    read.
  - *Retention:* tracker jobs untouched for `HERMES_RETENTION_DAYS` (365) with their answers,
    older letters and tailored CVs, and logs older than `HERMES_LOG_RETENTION_DAYS` (90) are
    deleted, with deleted database rows overwritten.
  - *Backups:* `.env`, Hermes' config, memories, cron jobs and the scripts with their state go
    into one encrypted archive a night in `HERMES_BACKUP_DIR`, rotated to 14 daily and 8 weekly
    copies; `--restore` and `--decrypt` open them.
  - *Permissions:* the scripts create owner-only files, and maintenance resets `state/`, the
    profiles and the backups to `0600`/`0700`.
- **Unsubscribing deletes everything.** The Worker drops an unsubscribed (or deleted) profile's
  answers still waiting in KV at once; Hermes then deletes the profile, replaces the person's name,
  email address and profile id with `[deleted]` in the logs and emails them a confirmation. The
  note to you no longer includes their address. `profiles.py --delete` does the same.
- **Privacy notice.** The Worker serves `/privacy` (what is kept, where, for how long, how it is
  protected and how to have it deleted), linked from the sign-up form, the welcome email and the
  unsubscribe page.

- **One model queue for all profiles.** Every model request, from the daily ratings, cover
  letters, tailored CVs and sign-ups of every profile, now waits its turn in one shared queue, so
  Ollama gets one request at a time (`HERMES_MODEL_CONCURRENCY` to allow more). Requests a person is
  waiting for go ahead of background ratings, and a crashed script never blocks the queue.
- **Screenshots of every view.** [docs/screenshots.md](docs/screenshots.md) shows every email
  (daily report and its variants, weekly roll-up, cover letter and tailored CV with their PDFs,
  profile and test emails) and every feedback Worker page (button confirmations, sign-up, admin
  sign-in and profiles), with what each part and control does. The READMEs and guides embed them
  where each feature is described. `scripts/screenshots/make.py` regenerates them from the real
  code with fictional data, in a temporary Hermes home.
- **Automatic Cloudflare setup.** The wizard's feedback step now takes a Cloudflare account ID and
  API token (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) and deploys the feedback Worker
  itself through the Cloudflare API, with no Node.js or wrangler: it finds or creates the
  `workers.dev` subdomain and the KV namespace, uploads the Worker, fills in `JOB_FEEDBACK_URL`,
  sets the generated secrets plus the `/admin` username and password you choose (never written to
  `.env`), and can put `/admin` behind Cloudflare Access for the emails in
  `CLOUDFLARE_ACCESS_EMAILS`. `scripts/cloudflare_worker.py` does the same from the saved settings
  after an update, and changes the admin password from stdin. New guide
  [docs/cloudflare-setup.md](docs/cloudflare-setup.md): account, token permissions, Access and the
  free plan limits.
- **Tailored CV button.** Next to **Cover letter**, each job card has **Tailored CV**. Like the
  letter, it queues a request (with optional guidance) that `cover_letter.py` picks up, and emails
  an A4 PDF CV fitted to that job (`tailored_cv.py`). The CV is turned into a structured copy once
  (`state/cv.json`, rebuilt when the CV changes); the model only chooses and rephrases, so job
  titles, employers, dates and education always come from your CV and figures it doesn't
  contain are refused.
- **Skills from the email go into the CV.** Skills added with the missing-skill tags are worked
  into the profile's skills section by the model (the previous version is kept as a `.bak`
  copy; if the model's edit fails the checks, the skills are appended instead), and appear in
  every tailored CV. The daily report says which skills were added.
- **Extra vacancy profiles.** One Hermes can now send reports to other people:
  - The feedback Worker has a password-protected `/admin` page (`ADMIN_PASSWORD` secret, optional
    `ADMIN_USER`; lockout after five wrong passwords, 12-hour HttpOnly session, CSRF tokens) that
    creates single-use invite links (7 days), lists profiles, and queues crawler-key changes (a
    profile's own Firecrawl key, or a global one replacing `.env`'s), pause, resume and delete.
  - `/join` is the invite's sign-up form: name, email, phone, town, wanted roles and a CV upload
    (PDF, .docx or text, up to 5 MB, type checked) or pasted CV.
  - `profiles.py` (new cron job `vacancy-profiles`, every 5 minutes, added by the wizard) collects
    sign-ups, reads the CV with the new dependency-free `cv_text.py`, has Hermes' model build the
    profile, keywords and searches under `state/profiles/<id>/`, and emails the person and you.
    You are the `owner` profile with your files unchanged.
  - Daily reports, weekly roll-ups and cover letters run for every active profile after yours,
    each with its own state, signed buttons (profile id in the link) and skills pool.
  - Every report ends with an **Unsubscribe** link: it deletes an extra profile with its CV and
    history, or pauses the owner's own reports.
  - Worker polling reads flag keys instead of listing KV, keeping within the free plan's 1,000
    list operations a day.

- **Vacancy report feedback buttons** (optional):
  - Next to **View job**, each card gets **I applied**, round thumbs up (**Good match**) and
    thumbs down (**Not for me**) buttons, **Interested** and **Cover letter**, all with
    [Lucide](https://lucide.dev) icons rendered to PNG (`icons/build_icons.py`) because Gmail
    strips SVG. Follow-up reminders get **Heard back** and **Rejected**.
  - The buttons are signed links to a small Cloudflare Worker
    (`packages/daily-vacancy-report/feedback-worker`, with Vitest tests). Opening a link only
    shows a confirmation page with an optional note, so mail scanners can't record answers.
  - Answers are kept in Workers KV until the next run fetches them (`/events`, then `/ack`,
    both behind a bearer token). Nothing on the Hermes server is exposed.
  - Set up with `JOB_FEEDBACK_URL`, `JOB_FEEDBACK_SECRET` and `JOB_FEEDBACK_API_TOKEN`. New guide,
    [docs/feedback-worker.md](docs/feedback-worker.md), covers deploying with the Cloudflare MCP
    in an AI agent or with wrangler by hand.
- **Cover letters.** The **Cover letter** button queues a request in the feedback Worker, with
  optional guidance from the confirmation page. `cover_letter.py`, a `hermes cron` job every 5
  minutes, writes the letter with Hermes' model from `job_profile.md` (plus
  `COVER_LETTER_CV_FILE`) and the listing saved at rating time, lays it out as an A4 PDF with
  real text (`letter_pdf.py`, no extra packages) and emails it with the job details. Letters
  that are too short, contain placeholders or claim a job title the CV does not use are
  rewritten, and failed requests are retried up to 3 times. Settings:
  `COVER_LETTER_NAME`, `COVER_LETTER_CONTACT`, `COVER_LETTER_CV_FILE`, `COVER_LETTER_SIGN_OFF`,
  `COVER_LETTER_FROM_NAME` and `COVER_LETTER_MODEL`. `send_email()` now takes attachments.
- **Cleaner report header.** The daily report and weekly roll-up share a new
  `hermes_common.email_header()`: a solid slate panel with the region and date on one line, the
  title and tagline, and the figures in a row split by hairlines (the key figure in green),
  replacing the purple gradient and frosted tiles.
- **Salary headline on job cards.** When a listing gives a salary it now appears under the
  company line in a green box with a banknote icon (`icons/icon-salary.png`), formatted from the
  parsed range, e.g. "£45,000 - £55,000 a year"; day and hourly rates add a yearly estimate. The
  salary tag is gone; "Salary not listed" stays as a tag. The plain-text email gets a Salary line.
- **Add missing skills from the email.** A card's missing skills are now amber tags. With the
  feedback Worker, tapping one opens a page with that skill ticked, the job's other missing
  skills beside it and a box for more. Confirmed skills join a pool in `state/job_tracker.db`:
  the scanner counts them as CV keywords and adds them to the rating profile, and cover letters
  may mention them as general skills. Review or undo with `job_scanner.py --skills` and
  `--remove-skill`.
- **`state/job_tracker.db`** (`job_tracker.py`, SQLite) records rated and emailed jobs (with the
  listing, for cover letters), feedback, reminders, cover letter requests and run statistics:
  - Recent liked and rejected jobs, with your reasons, are added to the rating prompt as
    examples.
  - Jobs you applied to come back in a "Follow up" section after 7 and 14 days.
- **Weekly roll-up.** `job_weekly.py` (also `job_scanner.py --weekly`) emails the week's best
  jobs, applications and replies, common gaps, who's hiring, the score spread and source
  health. The wizard schedules it (default `sunday 18:00`).
- **Salary filter.** `JOB_MIN_SALARY` and `JOB_SALARY_CURRENCY` leave out jobs clearly paying
  less than your minimum. Ranges, `45k`, day rates and hourly rates are converted to a yearly
  figure, and unlisted salaries are kept.
- **Closing dates.** Read from the listing, shown as a pill on each card (red within three days),
  and used to put jobs closing soon first. Jobs that have already closed are skipped.
- **Title screening.** Before rating, the model screens up to `JOB_TRIAGE_MAX` (default 60)
  relevant titles in quick batches, so the rating budget goes to the most promising jobs.
- **Second opinion** on scores of `JOB_VERIFY_MIN_FIT` (default 8) or more: a stricter re-check,
  averaged with the first score.
- **Agency grouping.** The same job advertised by several agencies becomes one card listing the
  other advertisers. `JOB_HIDE_UNNAMED_AGENCY=1` drops agency adverts that don't name the
  employer.
- **Source health.** Jobs found and errors per source (nijobs.com, web search) appear in the
  footer, and a warning banner explains failures.
- **Setup wizard:** minimum salary, currency and unnamed-agency questions; a feedback-buttons
  step that generates both secrets and pipes them to `wrangler secret put` without showing them;
  a weekly roll-up schedule; and `<day> HH:MM` run times such as `sunday 18:00`
  (`SCHEDULE_DAILY_VACANCY_REPORT_WEEKLY` in answers files).
- **Tests** for the vacancy report helpers (`packages/daily-vacancy-report/tests`) and the
  feedback Worker (`npm test`).
- **CI** (`.github/workflows/ci.yml`), on every push and pull request, with one named job per
  check:
  - Ruff lint (`ruff.toml`) and a compile check on Python 3.10.
  - Unit tests for the shared library, vacancy report and setup wizard, each on
    Python 3.10 and 3.12, with a results table in the run summary.
  - The feedback Worker's Vitest tests, then a `wrangler deploy --dry-run` build check.
  - An "All CI checks passed" job to use as a single required check.
- **Security workflow** (`.github/workflows/security.yml`), on every push and pull request and
  every Monday: Gitleaks secret scan of the full history, `pip-audit` and `npm audit` CVE
  checks, dependency review on pull requests, and CodeQL scanning of Python, JavaScript and the
  workflows.
- **More tests:** the shared library (`common/tests`) and the setup wizard (`scripts/tests`),
  which also checks that
  no `.env.example` ships a real-looking secret. `requirements-dev.txt` lists the test
  dependencies.
- **Setup wizard** (`scripts/setup.py`, standard library only):
  - Installs the chosen packages, then asks for SMTP details, web search API keys (typed
    without echo, shown masked), timezone and each package's settings.
  - Settings, help text and defaults come from the `.env.example` files: `# @basic` settings
    are asked by default, and `--advanced` asks for everything.
  - Vacancy report steps: turn your job titles into web queries and title filters; build
    `job_profile.md` from guided questions, an imported CV or the example; generate
    `cv_keywords.json` from your skills and gaps.
  - Guided job search step: region, towns, country, remote-anywhere, target level, employment types and work modes.
  - Asks what time each package should run (`07:30`, `weekdays 08:00` or a cron expression) and
    creates or updates the `hermes cron` jobs, then sends a test email and offers a dry run.
    Unattended runs take `SCHEDULE_<PACKAGE>` from the answers file.
  - Works locally or from a Docker host: runs `hermes` in the `hermes-agent` container and
    matches file ownership to the Hermes home.
  - Backs up `.env` before writing, updates it in place (other Hermes settings untouched) and
    keeps it at mode 600.
  - Safe to re-run: current values are the defaults.
  - `--dry-run`, `--non-interactive --answers FILE`, `--no-install` and `--no-cron` options.
- **`JOB_TITLE_EXCLUDE`** makes the vacancy report's always-skip title filter configurable. It
  used to be hard-coded, including professions like nurse and teacher.
- **Vacancy report job preferences:**
  - `JOB_LEVEL` (junior, mid, senior, lead or any) sets fit penalties for titles above or below
    your level. The new `JOB_JUNIOR_PENALTY` joins the senior and lead penalties, which now
    default to the level's values.
  - `JOB_EMPLOYMENT_TYPES` and `JOB_WORK_MODES` choose which types (now including part-time and
    internships) and modes to keep. They replace the hard-coded "full-time permanent, contract or
    temporary" rule.
  - `JOB_REMOTE_ANYWHERE` lets fully remote jobs through the region filter.
  - The model is told the target level, types, modes and region when scoring, and its rubric no
    longer assumes an AI / ML role.
- **`SECURITY.md`**: how to report a vulnerability privately (GitHub's private reporting), which
  versions get fixes, what is in scope, and a summary of how HermitShell protects data. The README's
  Security section links to it.
- **A "For recruitment teams" section in the README**: invite links, each recruiter's own pool, stats,
  jobs sent and history, how candidate data is kept, and how one server grows with the desk.
### Removed

- **Recruits' own crawler keys.** Web search keys are global: the dashboard's **Crawler** column and
  its key window are gone, and `set_key` and `use_global` are refused by both the Worker and
  `profiles.py`. The `secrets.json` files earlier versions kept in recruits' folders are deleted on
  the next run, and every recruit's report uses the global keys.
- **Noon Tech Digest.** HermitShell is now solely a job-finder platform: the digest package, its
  setup wizard steps, tests and CI job are gone. Existing installs keep their copy of
  `tech_digest.py`, its settings and its cron job; nothing is deleted from the server.

### Changed (breaking)

- **HermitShell no longer runs inside Hermes.** Its jobs move from `hermes cron` to its own scheduler, and the
  model comes from `OLLAMA_MODEL`, `OLLAMA_HOST` and `OLLAMA_NUM_CTX` instead of Hermes' `config.yaml` (which
  is still read as a fallback when it's in the home folder). [Moving from Hermes](docs/installation.md#moving-from-hermes)
  takes an install out, keeping every setting, profile and history; settings keep their `HERMES_` names, so
  `HERMES_DATA_KEY` and the rest need no change. `HERMITSHELL_HOME` names the home folder (`HERMES_HOME` is
  still read), the setup wizard's `--hermes-home` is now `--home` (the old name still works), and it runs
  commands in the `hermitshell` container (user `hermitshell`, home `/data`) instead of `hermes-agent`.
- **Nightly backups are named `hermitshell-<date>.tar.gz.enc`** and hold `.env`, the schedule (`cron/`) and the
  scripts folder with its state; Hermes' own files (`config.yaml`, `SOUL.md`, memories) are no longer backed
  up. Older `hermes-*` backups are still listed, rotated and restorable.
- **The host watchdog is `hermitshell-ollama-watchdog`.** `install-watchdog.sh` replaces the old
  `hermes-ollama-watchdog` units, installs into `/opt/hermitshell-host` by default and writes the hardware
  report into the `hermitshell` container. Settings go in `/etc/default/hermitshell-ollama-watchdog` as
  `HERMITSHELL_CONTAINER`, `HERMITSHELL_USER` and `HERMITSHELL_STATE`; the old file and `HERMES_*` names are
  still read.
- The dashboard status HermitShell sends says `scheduler` (was `hermes_jobs`) and each report's `job` (was
  `hermes_job`); the Worker reads both, so it works with servers not yet updated.

- **Job titles are one setting, `JOB_TARGET_TITLES`** (`||`-separated), set from the
  dashboard's profile page or the wizard; changing them rebuilds the web search queries and the
  strong title filter.
- **New feedback link format.** Button and unsubscribe links are now signed over every field
  (job, action, title, skills, profile, send day) with an unambiguous encoding, and expire 90
  days after the email. Links in emails sent before the update show "This link isn't valid";
  deploy the Worker and the scripts together, after Hermes has collected any waiting answers.
- **`JOB_FEEDBACK_URL` must be `https://`.** With an `http://` address no buttons are added and
  feedback isn't synced.
- The admin page's crawler-key forms queue an `api_keys` action (`clear` to go back to `.env`)
  instead of `global_keys`.
- Settings changed from the dashboard are limited to the `ALERT_`, `COVER_LETTER_`,
  `FIRECRAWL_`, `JOB_`, `SCRAPFLY_`, `SMTP_` and `TAVILY_` families; paths, file names,
  `JOB_FEEDBACK_*` and `JOB_PROFILE_ID` can only be set in `.env`.
- **The admin and recruiters are staff, never recruits.** With the Worker linked (`JOB_FEEDBACK_URL` and
  `JOB_FEEDBACK_API_TOKEN` set), the main admin's `owner` row has no CV, job search, report, stats or
  history of its own, and no dashboard page, action, count, search or pool shows it as a recruit
  (`profiles.admin_is_staff`, `users.canSee`, `admin.allowed`). A job search still set up in the
  server's `.env` moves once to a normal recruit with the same name and email, taking the CV, tracker,
  seen jobs, answers, letters and report time with it (`profiles.move_owner_search`); the Worker moves
  the history kept for the admin to it (`history.moveOwnerHistory`). Buttons in reports sent before the
  move store their answers, letters and CVs under that recruit, and their unsubscribe link pauses it.
  The setup's `job_scanner.py` job only starts the recruits' roll-ups and letters. Without the Worker,
  a single-person setup works as before.
- **Each recruit has their own job search.** Recruits no longer inherit the region, places, titles, salary
  or searches in the server's `.env`: new recruits' searches start from the town they signed up with,
  and recruits that were sharing the `.env` search each get their own copy of it once
  (`profiles.give_recruits_own_search`), so editing one recruit never changes another.
- The setup checklist's last item is **First recruit joined**, linking to **Create invite link**, in place of
  uploading your own CV and job search. **Jobs sent** addresses every list to the recruit by first name.

### Changed

- **One message per change.** Pressing Pause, Resume, Retire, Delete, Assign or **Send jobs**, a bulk
  change, or saving a global setting showed a **Saved** note, a **Waiting for HermitShell: 1 change**
  count and a **Saving** bar at once. Now only the bar shows (**Working on the change&hellip;** This page
  updates by itself), then a single **Done. The page shows the change.** A bulk change still says how many
  were skipped, a recruit's page leaves it to its status box, the status line counts only changes the
  bar doesn't cover, and **Send jobs** reads "Looking for jobs now. The email arrives in about 10 to 20
  minutes." Covered by `test/settings.test.js` ("says one thing per change").

- **Plain, short wording for people who aren't technical.** Labels, hints and messages across the
  dashboard, a recruit's page, `/me`, the sign-up form, the pages behind email buttons and the welcome,
  goodbye and deleted emails now say what happens in everyday words, without terms like scan, queue,
  `.env`, sealed or check-in. For example **Within N km of home town (as the crow flies)** is now
  **Maximum distance from home town (km)** with the hint "Leave empty for no limit. Measured in a straight
  line, up to 500 km. Remote and hybrid jobs aren't limited by distance."; **scanning now** is **finding
  jobs now**; **Employment types** is **Job types**; seniority shows **Mid-level** and **Any level**; the
  save messages say **Saved. It takes effect within seconds.** instead of "HermitShell applies it within
  seconds while it is connected"; the profile status box says **Done. Your changes are in effect.**; and
  the feature switches are **Automatic interview prep packs** and **Recruits' own page**. Server commands
  in the "last checked in" warning are now shown to admins only; everyone else is asked to tell their
  admin. Stored values and form fields are unchanged. Tests and docs follow the new wording.
- **Managers no longer get a Manager pick.** On Users and roles, the **Manager** list (the team a recruiter
  is in) hides whenever Manager or Admin is ticked, in **Edit** and **Add user**, and comes back when only
  Recruiter is left, with no scripts needed. Saving still keeps a team only for a recruiter-only account.
  Covered by `test/manager.test.js` and `e2e/users.spec.js`.
- **The Desk reads at a glance as the desk grows.** The totals are a funnel with how many of each stage got
  to the next. Admins get a card per manager's team (and **No team**) that filters the whole page to it
  (`?team=`). Admins and managers get the recruiters ranked by placements, with gold, silver and bronze for
  the top three, team tags in each team's colour, the best figure per column in green and every heading
  sortable (`?sort=`); recruiters with no recruits still show. Each recruiter's recruits sit in a group whose
  heading keeps their totals in view; past three recruiters the groups start folded and pressing a recruiter
  in the ranking opens theirs (`?rec=`). Recruits come furthest along first, each tagged with the furthest
  stage reached, and quiet ones are greyed. Recruiters keep a simple view of their own recruits with no fees.
  Unknown `team`, `sort` and `rec` values are ignored and never echoed. New `teams()` in `src/users.js`;
  covered by `test/desk.test.js` and `e2e/demo.spec.js`, with new `admin-desk-demo` and
  `admin-desk-demo-team` screenshots.
- **Status has its own dropdown in the recruit search.** When the search slides open, a dropdown beside it
  offers **Any status**, **Active**, **Paused**, **Scanning now**, **No CV** and **Pending sign-up**
  (`/admin?s=`), alone or with the words typed. Status words are no longer matched from the search box, which
  keeps names, emails, ids, places, tags and recruiters. Picking a status lists them at once where scripts run;
  without them a **Show** button appears once a different status is picked. An unknown `s` is ignored and
  never echoed. Covered by `test/search.test.js`, `test/pending.test.js` and `e2e/admin.spec.js` (with and
  without JavaScript).
- **Turn off on the demo ribbon turns demo mode off in one press.** It used to open Global settings, where the
  switch then had to be pressed; now it posts the switch itself (with the form's token, admins only) and goes
  back to the real recruits with "Demo mode is off". Covered in `test/demo.test.js` and `e2e/demo.spec.js`.
- **Demo mode shows a busy desk, with every newer feature.** It now has 35 made-up recruits (several
  scanning at once, some paused, some new without a CV), two managers with their teams (one also recruits),
  recruiters in and out of a team, three sign-ups, five invites and a full Tasks list. The newer features are
  shown too: the Features switches, the server model picker with a model downloading, and backups on Cloudflare
  (a week of nightly and a month of weekly copies on **Backups on Cloudflare**, downloading as made-up bytes).
  **Save features**, picking a server model (downloaded at once, or downloading in Tasks until ready, where
  **Stop** keeps the old model) and **Back up now** play out like the other presses. A real manager or recruiter
  now sees the desk as a made-up manager or recruiter like them, so they see a team or a pool rather than an
  empty list. The names are made up from the same short list of first names and surnames. The made-up desk is
  built in about half the time it took before, to stay within a Worker's CPU limit with five times the recruits.
  Covered by new tests in the Worker's `test/demo.test.js` and more pages in `e2e/demo.spec.js`'s phone check.
- **Theme and branding's reset button says Reset to default** instead of "Reset to HermitShell's look";
  it still puts back HermitShell's own palette, name, logo and look.
- **Autofit recommends 7B and 14B models on GPUs.** Between the 4B default and the 30B, a GPU with 8 GB
  of memory now gets `qwen2.5:7b-instruct-q4_K_M` and one with 12 GB `qwen2.5:14b-instruct-q4_K_M`. A
  machine without a GPU stays on the 4B until it has 48 GB of RAM, since the bigger dense models are much
  slower on a CPU alone.

- **Stats animations play once, when the page loads.** Hovering a job no longer redraws its fit-score ring, and
  hovering a stat card no longer sets its icon looping again.
- **Sign-in failures no longer use KV writes.** Wrong passwords are counted in the link's Durable Object
  (`Hub`) with the same limits (five per address, 30 overall, 15 minutes), leaving KV's 1,000 writes a day
  for recruits. A Worker without the `HUB` binding counts them in KV, and sign-in is refused if neither can
  record the count. The Hub also keeps one-time tokens, spent at most once.
- **Stats always fit.** The recruits' stats HermitShell uploads are trimmed, oldest sent jobs first, to stay
  under the Worker's 600 KB limit instead of being refused.
- **Key reminder.** `doctor.py` reminds you to keep a copy of `HERMES_DATA_KEY` away from the server, since
  the backups are encrypted with it.
- Global settings can show on/off **Features** switches; each appears once HermitShell has the feature and
  reports it, and only the listed switches can be set.
- The dashboard calls the server's own Ollama the **Server model** instead of **Local Ollama**, and the order
  choice **Server first** instead of **Local first** (`LLM_ORDER=local` is unchanged).
- Shared code in one place: the Worker's profile id pattern, hex and cache hashes, hidden form fields and
  short month names now live in `lib.js` instead of being copied into several files, and `autofit.py`
  and `llm_usage.py` lock their state files with `hermes_common.file_lock` like `llm_providers.py`.
- **Smaller rating prompts.** Adverts are trimmed of menus, buttons, cookie and legal lines, share links and
  repeated lines before the first 5,000 characters are taken, so more of the job fits. The profile sent to
  title screening, ratings and second opinions is compacted, and a long one (over 3,500 characters) is
  briefed once by the model and kept in `state/rating_brief.json` until it changes. A brief that drops
  searched skills or adds figures or job titles isn't used. See
  [Smaller prompts for ratings](docs/configuration.md#smaller-prompts-for-ratings).
- **Profiles and CVs with plain headings are compacted too.** A short line ending in a colon ("Skills:")
  now gathers the bullets under it, as a Markdown heading does.
- **The model bench writes letters as production does**, with the evidence map and rewrites, and reports
  how many requirements the map found evidence for.
- **Temperature per task.** Scoring stays at 0; cover letters use 0.4, tailored CVs 0.2 and summaries 0.3,
  on Ollama and cloud providers alike. On OpenRouter, the small bulk tasks ask reasoning models for low
  effort with the reasoning left out of the reply.
- **New recruit emails are laid out, not one paragraph.** The **New recruit** and **Recruit updated**
  emails to you list email, location and what they are looking for as labelled rows, with an **Open
  Sam's profile** button beside **Manage recruits**. The job titles searched and the skills read from the CV
  each get their own card of chips with a count, like the welcome email. The plain-text version keeps one
  line each. The email is built in one place (`profiles.send_new_recruit`), which the screenshots use too.
  Tests check the layout, the plain text and that every field and the profile link are escaped.
- **Demo mode is a switch.** Global settings shows an on/off switch with **Demo mode** and Off, or On and
  since when, instead of the Turn on and Turn off buttons. It is still a plain form (no scripts), read out
  as a switch (`role="switch"`, `aria-checked`), and the knob slides over on the page shown after it is
  pressed. Unit and Playwright tests updated; settings screenshots updated.
- **Livelier stats page, one colour scale for scores, bigger icons.** Match scores use the same colours
  everywhere (green from 8, amber from 6, orange at 5, grey below): the best-match rings, the match
  scores chart and the rings on Jobs sent. Rings sit on a tinted disc, sweep in when the page opens and
  again on hover, and scores of 8 and over glow gently. Best matches are tinted cards with an accent edge.
  Each card title has a coloured icon badge, chips have round icons, and the answer colours match the
  rest of the theme. Icons are larger across the page (tiles, chips, applications), and the header and
  row buttons on every dashboard page draw their icons at 18px. Motion stops for anyone who asks for
  reduced motion. Tests cover the scale, ring colours and badges; screenshots updated.
- **Job cards end with their buttons.** The job's full web address is no longer printed under each card
  in the daily report and job emails; **View job** opens it, and the plain-text version still lists it.
  Email screenshots updated.
- **The CI workflow is now called Unit tests** (`.github/workflows/unit-tests.yml`, badge and README
  updated); its final job is **All unit tests passed**.
- **A recruit's page has its own tabs.** **Manage** and **History** replace the dashboard's Recruits, Users
  and roles and Global settings tabs there; those stay on the dashboard, with **Back to recruits** to return.
- **Recruits and Users and roles fit the screen.** Both pages now grow with the window, up to 1320px wide,
  instead of stopping at 900px, so the Recruit, Status and Recruiter columns no longer squeeze together.
  Under 900px each row becomes a card (name on top, status and recruiter side by side, then the buttons),
  and on a phone everything is in one column with the tabs on one line. Pills such as **owner, active** no
  longer wrap. The signed-in badge sits compactly above these pages up to 1860px so the card never runs
  under it. Other pages keep their width. Screenshots of the table pages are now taken at 1280px, with new
  phone screenshots of both.
- **Icon buttons on Users and roles.** Each user's actions are now matching square icon buttons, named when
  pointed at and to screen readers: a pencil for **Edit**, a key for **Reset password** (or **Change password**
  on your own row) and the red bin for **Delete**, instead of text links.
- **Tasks are for admins only.** Recruiters no longer get the **Tasks** button, its window or the
  **Waiting for HermitShell** link, and `/admin/tasks` answers them with 403 (viewing and cancelling).
  Their status line still says how many of their changes are waiting.
- **Fewer hints.** The line under the Recruits table pointing to **Global settings** and **Users and roles**
  (both are tabs already) and the note under the dashboard users table are gone.
- **A tidier Recruits list.** Each row's buttons sit on one line: **Send jobs**, a pause or play button and
  the bin. The recruiter column is one list with the recruiter's initials, and **Assign** appears only once
  you pick someone else. Status says **Last report 3 hours ago** (the exact time on hover) and **Daily at
  08:00**, the recruit says **Joined** with the date, and **Manage** sits beside the stats button.
- **Edit on Users and roles no longer sets a password.** It changes only the name and roles; the new
  **Reset password** window, which asks for the new password twice, replaces its password field.
- **Deleting asks in a window.** On the Recruits list and on Users and roles, the tick box and
  **Delete** button are replaced by a red bin button. It opens a confirm window (CSS only) with the
  tick box inside (**Delete their CV and history** for a recruit), **Cancel** and a **Delete** button
  that stays faded until the box is ticked. The Worker still refuses a delete without it.
- **Global settings adds keys through a window.** Each web search provider has a row showing
  **set here** or **from .env** and the start and end of its key, with **Add key** or **Change**
  opening the same style of window the recruits' keys used, now offering Firecrawl, Tavily and
  Scrapfly (several Firecrawl keys, comma separated). It replaces the plain three-box form.
- **Admin sessions are per user.** The session cookie names who is signed in, and each user's
  sessions are signed with their own version, so a new password, deleting the user or their
  **Sign out** ends only their sessions. The main admin's **Sign out** still ends every main-admin
  session. Existing sessions end once, when the update is deployed.

- **Profiles are called recruits on the admin page.** The dashboard tab, page title, table column,
  search box and count, **Back to recruits**, **Manage recruit**, the not-found pages and the Tasks
  labels (**Delete recruit**, **Recruit changes**) now say recruit, and so do the notices HermitShell
  emails you (**New recruit**, **Recruit updated**, **Manage recruits**). Addresses (`/admin/profile`),
  settings (`JOB_PROFILE_ID`), KV keys, API errors, `profiles.py` and `state/profiles/` keep their
  names, and the sign-up, unsubscribe and privacy pages and the emails recruits get still speak of
  their profile.
- **Drawn arrows instead of arrow characters.** **Back to profiles** on the profile, settings,
  stats and jobs sent pages, and the links to an advert or employer's site on a job card, now show a
  line icon instead of the `←` and `↗` text characters, which looked out of place in the buttons.
- **A smooth loading circle for running tasks.** The icon of a running task in the Tasks window, and
  the busy Tasks button, now spin a round ring with a fading tail instead of an arc swinging round a
  square. The ring carries on where it was when the list refreshes rather than jumping back.
- **A roomier dashboard search box**: wider, with more padding, the same height as the buttons next to
  it, and more space around the profile table's toolbar.
- **Job ratings no longer use Hermes' full chat context.** A rating gets the context it needs, so
  Ollama keeps more of the model on the GPU. Hermes' own context is still used when it fits as well.
- **`HERMES_MODEL_CONCURRENCY` defaults to `auto`**: one request at a time per working Ollama
  server, which is still one at a time with a single server.
- **The dashboard's status line counts waiting changes** ("Waiting for HermitShell: 2 changes") and opens
  the task list, instead of listing each one.
- **Shorter email footers.**
  - The vacancy report footer is now three short lines. **Filters** shows the area, job types, minimum
    fit and salary floor. **Skipped** shows only the filters that removed jobs, with their counts.
    **Run** shows the model, the sources and the web credits used.
  - The explanations of keyword match, level penalties, second checks and the buttons are no longer in
    every report; the welcome email and the docs cover them.
  - The unsubscribe line is just **Unsubscribe** and what it does. The cover letter, tailored CV and
    welcome email footers are one or two short lines.
- The **View job** buttons on report cards and in the cover letter and tailored CV emails no longer end
  in an arrow.
- The one-line entries under **More matches** in the vacancy report use smaller versions of the card
  buttons, with the same icons, instead of underlined text links. Cover letter and Tailored CV sit on a
  line of their own, as on the full cards.
- A profile with its own crawler key now searches with only that key. Before, it could still fall back
  to the global Tavily and Scrapfly keys and spend their credits.
- Vacancy report cards show the three strongest matching skills in bold (the rest as one line),
  the biggest gap, "Salary not listed" when there's no salary, and the closing date.
- `JOB_SCANNER_MAX_SCRAPE` now defaults to 25 (was 15).
- When a title doesn't state a seniority, the model's reading of the listing counts too, with the
  `JOB_LEVEL` penalty capped at 1.
- The same role at the same company is skipped across boards and days, not just by URL.
- The model can no longer rule a job out of the region when its title or snippet names a place
  inside it.
- Web search titles lose trailing "- Job <Month> <Year>" suffixes.
- Relative `JOB_PROFILE_FILE` and `JOB_KEYWORDS_FILE` paths are
  resolved against the scripts directory instead of the working directory, so they also work
  under cron.
- `install.sh` points to the setup wizard when it finishes. `.env.example` files mark the
  essential settings with `# @basic`, and the settings filled in by the job-targets step with
  `# @wizard`.

### Fixed

- **A pasted CV is easy to save.** On a recruit's page the CV's button sat below **Roles they're after**
  and said **Upload CV**, so it didn't look like it saved pasted text. It now says **Save CV** and sits
  right under the paste box ("Paste the whole CV, at least a few lines."), **Roles they're after** comes
  first, and the messages say "CV saved." or how to fix a short paste. Covered by `e2e/cv.spec.js` and
  `test/settings.test.js`.

- **Pressing a button again no longer queues the same change twice.** Pressing Pause (or Resume, Retire,
  Delete or Assign) repeatedly, or several times at once, used to add one task per press, all waiting for
  HermitShell. Now a change already waiting for that recruit, or the same press in the last two minutes before
  HermitShell reports again, counts instead: nothing more is queued or written to the history, and a recruit
  who already is what was pressed gets **Nothing had changed**. The bulk bar skips them the same way. The
  hub keeps the last press per recruit and checks it in one statement (`POST /press`), so simultaneous presses
  queue one change; without the hub a short-lived KV key does. Covered by `test/presses.test.js` (including
  simultaneous presses, real changes of mind and the hub refusing malformed keys) and `e2e/bulk.spec.js`.
- **The server panel's GPU no longer vanishes now and then.** The GPU comes from the host's hardware report;
  when HermitShell sent its status without one (the report missed or too old to use), the GPU row disappeared,
  and since the machine's numbers alone don't count as a change, it could stay gone for up to 15 minutes.
  HermitShell now remembers the GPUs the host last reported (`state/gpus_seen.json`, names and memory only) and
  for a day keeps sending them with their use unknown, which the panel shows as "Use not reported since&hellip;"
  instead of dropping the row; a GPU going, coming back or its use becoming known again is sent at once. A GPU
  reported with no memory is left out rather than shown as empty. Covered by `test_profiles.py`, the Worker's
  `test/models.test.js`, and security tests that a tampered `gpus_seen.json` gives only plain, bounded values.
- **A hand-set country is kept on the profile page.** A `JOB_SEARCH_COUNTRY` set in `.env` to two letters
  that aren't in the country list showed as "Any country". It now shows as its own selected option (for
  example "ZZ (not in the list)"), and saving other fields leaves it alone. A form still can't queue a new
  code that isn't in the list; it becomes "Any country".

- **Calmer score rings on hover.** On the stats page, hovering a row with a score of 8 or more made its ring's
  glow pulse for as long as the pointer stayed. It now fades to a soft, steady glow instead; the two glows as
  the page opens are unchanged.

- **Provider logos keep their own colours under a theme.** On Global settings, the Tavily and Featherless
  logos (and Tavily's and Featherless's choice icons) were repainted with the theme's palette, as their indigo
  and violet fell in the brand colour family. Every search and AI provider's logo now keeps its brand colours
  under any palette.

- **Tailored CVs say when they are missing roles, and no longer strand an entry on a page of its own.** A
  profile with no uploaded CV (such as the admin's own job search moved to a recruit) made its tailored CV
  from the short job search profile, which left out roles it doesn't mention, without saying so. The CV's
  email now says it was made from the profile and asks for the full CV on the dashboard. In the PDF, an
  entry's title kept room for three lines even when it had one, so a last one-line qualification could end
  up alone on a second page; titles now keep only the lines that follow them.
- **The Tasks count clears when the work is done.** The number on the **Tasks** button was drawn with the
  dashboard and stayed (say at 1) after the task finished, even though the open Tasks window already said
  **Nothing waiting or running**, until the page was reloaded. The dashboard's script now updates the
  count, the circle and the button's tooltip from the task list each time it refreshes. The ring on a
  running task no longer starts a whole turn out in the last few milliseconds of a second.
- **Loading circles turn while a page waits.** On a page that updates itself, the circle on a cover letter
  or tailored CV being made (and its shimmer, the task list's spinners and the CV status page's spinner)
  stood still, as waiting pages stopped every animation that wasn't marked to keep going. Now only
  entrance animations are held (they count as already played) and every loop keeps turning, in step with
  the clock across updates.
- **The dashboard is quick again.** Each click waited for a quarter-second cross-fade between pages, during
  which the page ignored clicks, and a page waiting for HermitShell cross-faded the whole window every few
  seconds even when nothing had changed. Pages now switch as soon as they load (a tab took about 420 ms
  from click to usable in local tests, now about 110 ms), waiting pages swap only what changed with no
  dropped frames, and the theme is read alongside the page rather than after it. A theme that can't be
  read shows HermitShell's look instead of an error.
- **Demo history no longer runs ahead of the clock.** Near midnight the demo logged recruits' email answers
  for later that day, so on the first of a month its History showed a month with no reports. Demo answers
  are now always in the past.
- **Cloud model counts and rests are no longer lost.** Two model requests at once (from two scripts, or
  ratings running side by side) each saved the whole provider state when they finished, so the later one
  undid the other's request count or a provider's rest after a 429. Each request now saves only what it
  changed, under a lock.
- **Waiting pages keep the account box and the demo ribbon.** A page reloading itself while HermitShell
  applied a change lost the **Sign out** box (and the demo ribbon), and on phones the card jumped as it
  came and went.
- **A waiting flag can no longer stay on.** KV lists can still show deleted keys for about a minute, so
  the flag saying "something is waiting" often outlived its items, and every poll (cover letters every
  5 minutes, the queue, each dashboard load) then paid for a list from the free plan's 1,000 a day.
  Flags now hold when they were set and are taken down once a listing finds nothing under an older one.
- **No double presses.** Pressing **Send jobs** twice within a minute queues one scan, and a new invite
  opens on its own page, so reloading it no longer makes another invite. Deleting a recruiter with
  several recruits raises the queue flag once instead of once per recruit, which KV could refuse.
- **Rate limits given as a date.** A Firecrawl or model provider asking to wait until a date (not a
  number of seconds) crashed the scan or was ignored; both forms are read now. Firecrawl is left alone
  for the rest of a run after three network failures in a row instead of minutes of retries per call.
- **A failing sync keeps the live link.** An error while applying dashboard changes counted as the live
  link dropping, and enough of them sent HermitShell back to polling; it is now logged and
  retried over the same link.
- **Score rings pop in again.** Four stylesheets defined an animation called `pop` differently, so the
  jobs-sent rings slid instead of growing; each now has its own name, and a test keeps them apart.
- **A smooth shine on pending sign-ups.** The glow across a sign-up waiting to be set up (always one in
  demo mode) was drawn separately in each cell, so it moved at a different speed in every column and
  showed seams, which looked choppy. It is now one sweep across the whole row.
- **Saved changes show without a reload.** Adding a key, changing a model or the email server, or
  pausing, resuming, deleting, assigning or sending from the dashboard looked like it did nothing until
  the page was reloaded, because HermitShell applies them a few seconds later. Now the change shows at
  once: a **Saving** bar at the top, a **saving&hellip;** tag on the key or model (**pausing&hellip;**,
  **deleting&hellip;** on a recruit's row, with the pause or resume already flipped), and the new model
  order picked. The page reloads itself (still no JavaScript) every 4 seconds, then every 20, until
  HermitShell has applied it, then says **Applied by HermitShell**. It stops after 5 minutes and says
  HermitShell may be offline. Reloads keep your section and scroll, and entrance animations are off
  while it waits so nothing flickers. The same fix makes Jobs sent really reload while a letter or CV is
  being made: its address ended in `#job-…`, and a refresh to an address with a `#` only scrolled. Unit,
  security (hostile queue items, recruiters only see their own) and Playwright tests added.
- **Score rings drew short.** A ring's dash pattern repeated every 100 plus the score's share, so the
  part past its starting point fell in the gap and a 9 out of 10 filled about two thirds of the circle.
  Rings on the stats page and Jobs sent now fill exactly their share, and a test checks the pattern.
- **View job readable in Gmail.** Gmail painted the purple **View job** button's text in its own link blue
  (#1155cc), which barely showed. The label is now a white span inside the link (`hermes_common.white_label`),
  which Gmail leaves alone, in the daily report and the cover letter and tailored CV emails.
- **The daily report on a phone.** In Gmail's apps a card's columns were squeezed: initials shrank to a
  coloured strip over the title, the fit circle became a tall capsule, the salary wrapped and the three
  meters' bars were a one-pixel tick. The initials and the circle are now fixed-size blocks, the salary and
  tags have a row of their own beside the thumbs, and the meters are a grid of labels, values and div bars.
  Every email also gets a small phone stylesheet (under 540 pixels: tighter margins, a stacked header line,
  a smaller circle and title). `make.py` adds a phone-width screenshot, `emails/daily-report-phone.png`.
- **Moving from Hermes, in the order that works.** The guide now imports the jobs before the container's
  first start and while they are still active in Hermes (the import copies paused states, and a first start
  adds the standard schedule, which ran the daily report twice), stops Hermes' `profiles.py listen`, notes
  that `docker-compose.yml` must be downloaded, and shows installing the updater and watchdog from the
  scripts inside the image.

- **The container keeps the live link to the Worker.** The image lacked the `websockets` package, so a
  container fell back to polling the Worker every 5 minutes; it is now installed (and optional in
  `requirements.txt`), the doctor reports it, and the image's smoke test imports it.

- A new sign-up dropped off the dashboard until its profile was built. It now has a **pending** row
  from the moment the invite form is sent. HermitShell also reports the new profile before it takes the
  sign-up off the queue: before, it took it off first and reported the profile only after updating the
  Hermes jobs.
- Two dashboard changes saved in the same millisecond could reach HermitShell in the wrong order,
  because the queue sorted them by a random id. The Worker now gives each change a later time than the
  one before.
- Jobs whose rating failed (model timeout or bad JSON) were marked as seen and never shown. They
  are now retried on the following runs, up to 4 attempts (`state/job_scanner_retry.json`).
  Only jobs that were rated or definitely ruled out are marked as seen.
- A broken table row and a missing blank line in `docs/configuration.md`.
- The setup wizard showed the first and last four characters of a stored secret, half of a
  16-character app password. It now shows only the last four, and only for secrets of 16 or more
  characters (found by CodeQL).
- LinkedIn search results showed the page title ("Acme hiring Data Engineer Job in Belfast") instead
  of the job title.
- Gmail clipped long reports ("[Message clipped]") partway through, hiding the later jobs and
  their buttons and showing their logos as loose attachments. `send_email()` now compacts
  emails over 95 KB by moving repeated inline styles into Gmail-safe classes, so they render the
  same at about half the size. If the vacancy report is still too big, the lowest-ranked jobs
  become one-line "More matches" entries. See
  [docs/email-rendering.md](docs/email-rendering.md#size-staying-under-gmails-clipping-limit).
- One failing job (a provider error, bad JSON, an unexpected exception) no longer ends the daily
  run: it counts as a failed attempt and the run goes on. Two model timeouts in a row stop the
  ratings for that run, and the retry list is saved every few jobs.
- Emails are retried twice (after 10 s and 60 s) when the SMTP server drops the connection or
  answers with a temporary 4xx error.
- Overlapping runs of the vacancy report, cover letters and profiles are prevented with a lock
  file, and the job tracker uses SQLite's WAL mode with a busy timeout, so a cron run and a manual
  run can't corrupt state.
- Cover letter polling does a full KV check once an hour instead of on every run.
- Tests no longer read the real `.env` or `~/.hermes` (new root `conftest.py`).

### Performance

- **The dashboard no longer lags while Tasks (or any window) is open.** The dimmed backdrop behind a
  window blurred the whole page, and the browser redrew that blur on every frame while the dashboard kept
  animating underneath (the Tasks button's circle, scanning rows, a model download bar), which dropped it to
  about 26 frames a second with stalls of over 80 ms. The backdrop is now a plain darker tint, everything
  behind an open window stops animating until it closes (the window's own animations keep going), and the
  bars in the task list shimmer by moving a layer instead of repainting their gradient, so a window holds
  60 frames a second. Covered by `test/tasks.test.js` and a browser test in `e2e/models.spec.js` that the
  page behind pauses, isn't blurred and starts again on closing.
- Job rating prompts put the CV, feedback and rubric first and the listing last, so Ollama can
  reuse the cached prompt prefix between jobs.
- Jobs whose page shows a salary below the minimum or a closing date in the past are dropped
  before the model is asked.
- The model's context size is only raised above the default when the prompt needs it.
- Adding a skill to the CV asks the model to rewrite only the skills section, not the whole CV.
- The Worker reads each KV key at most once per request (pages that asked for the same status or
  profile several times now read it once), and saving an answer, asking for a letter or CV, or adding
  a skill writes its keys together instead of one after another.
- A signed poll of `/api/queue/flag` checks its nonce and records HermitShell's check-in in one call
  to the live link's Durable Object instead of two, halving that object's requests when HermitShell
  polls.
- Calls to Firecrawl, Tavily, Scrapfly, Ollama and the cloud models reuse one connection per thread
  instead of opening a new one (and a new TLS handshake) for every request.
- With the cloud models first, a run rates `LLM_CLOUD_CONCURRENCY` jobs at once (2 by default) instead of
  one at a time.
- Dashboard changes queued ahead of a sign-up, a new CV or a test email show as applied as soon as they
  are, instead of after the slow item finishes.
- The scheduler only rewrites `cron/jobs.json` when a job changed, not every minute, and the container
  keeps compiled Python in `/tmp` so each script run no longer recompiles every module.
- The recruits list reads every recruit's sparkline from one KV key and its invites from one list,
  instead of one read per recruit and per invite.
- Styles shared by every page moved from each page (about 15 KB) into `/app.css`, which the browser
  keeps until it changes, so pages and waiting-page updates are smaller.

### Security

- **Demo mode never gives a role.** A signed-in user stands in for a made-up account with their username only
  when it has the same roles and isn't an admin, so a recruiter whose username matched the made-up admin can't
  open admin pages in demo mode. A stored demo state's model names must be Ollama names, and a made-up backup
  part must be one of its parts. Tested in `test/demo.test.js`, with a hand-made state of markup and a recruiter
  sharing the made-up admin's username.
- **`profile_stats.py` prints counts only.** Run by hand, it printed a recruit's whole stats as JSON, including
  the jobs sent with their titles, employers, salaries, advert links and card details. It now prints a table of
  counts (today, 7 days and every day kept), the Pipeline and how many jobs were sent, so the output is safe to
  paste into a log (CodeQL `py/clear-text-logging-sensitive-data`). `letter_docx.py`'s pattern for the
  characters XML forbids is now a raw string, so its ranges read as written (`py/overly-large-range`); a test
  checks it removes exactly those characters.
- **Code scanning findings fixed.** The job finder's saved report, results and weekly roll-up
  (`state/job_scanner_last.html`, `.json`, `job_scanner_weekly.html`) are written like CVs and letters:
  owner only, and encrypted when `HERMES_DATA_KEY` is set (`maintenance.py --decrypt` opens them). Logs no
  longer name employers, salaries or letter files, and `llm_providers.py` no longer prints any part of a
  key. The setup wizard reads passwords and keys through their own prompt, apart from names and other
  answers, and `cloudflare_worker.py` sets and logs only a fixed list of Worker secrets (refusing any
  other). Every file written through `write_atomic` is created 0600, whatever the umask. New tests cover each.
- **Signed requests to the feedback Worker.** Every request HermitShell makes to `/events`, `/ack` and
  `/api/*` carries, besides the API token, an HMAC-SHA256 signature over the method, path and query, a
  timestamp, a one-time nonce and the SHA-256 of the body, under a key derived from `JOB_FEEDBACK_SECRET`
  (`common/worker_link.py`, `feedback-worker/src/apiauth.js`). The Worker refuses signatures more than five
  minutes from its clock, nonces it has seen (kept for ten minutes in the live link's Durable Object, in
  SQLite) and altered requests. After the first signed request it refuses the token alone for good (KV key
  `api:signed`), so an older HermitShell keeps working until it updates but a leaked token or a copied
  request is refused. Unknown `/api/` paths answer a JSON 404, and only after the caller is known.
- **Passwords, API keys and CVs sealed for your server.** HermitShell keeps an RSA-3072 key pair
  (`common/worker_seal.py`, `state/worker_seal.json`, encrypted with `HERMES_DATA_KEY` when set) and sends
  the public key in its status. The Worker (`src/seal.js`) encrypts SMTP passwords, web search and model API
  keys, pasted CV text and uploaded CV files before they reach KV (RSA-OAEP-SHA-256 wrapping a fresh
  AES-256-GCM key, bound to the field or CV key as associated data, so a value can't be moved to another
  field); HermitShell opens them when it collects them. The Worker refuses to save a password or key until
  HermitShell has sent its key (**Not saved: HermitShell hasn't sent the key...**), and still takes
  sign-ups. `python3 worker_seal.py --rotate` makes a new key; the old one opens older values for 30 days.
  Without the `cryptography` package no key is sent, so nothing is stored in plain text.
- **One hardened client for the Worker.** `profiles.py`, `job_tracker.py` and `cover_letter.py` now share
  `worker_link.Link`: HTTPS only (plain http only to `localhost`), never follows a redirect with the
  token, retries 429, 500, 502, 503 and 504 answers and dropped connections up to three times with backoff
  honouring `Retry-After` (at most 30 seconds; creating an invite is never repeated), sends
  `User-Agent: HermitShell/2`, and its errors never include the token or URL.
- **Protocol version handshake.** HermitShell and the Worker both state protocol 2
  (`X-HermitShell-Protocol` on every API answer, and `protocol` in HermitShell's status). When they differ,
  the dashboard and Global settings say which is older and how to update it, HermitShell logs it, and
  `doctor.py` warns.
- Tests: Python unit tests for the client and sealing, Vitest for signatures (vectors shared with Python,
  expiry, replay, latch, 413) and sealing, security tests that run the Worker's own `seal.js` and
  `apiauth.js` under Node against the Python side, and Playwright tests that a saved key reaches the queue
  sealed and a replayed request is refused by the real Durable Object. A new screenshot shows the version
  warning.

The rest come from a review of the whole app; none of these were known to be exploited.

- Key usage checks go only to the three providers' HTTPS endpoints, without following redirects, with an
  8-second timeout and replies capped at 64 KB. The cache and the dashboard get a masked hint and a hash of
  each key, never the key, even when a check fails; the cache file is private (0600) and a tampered one is
  ignored. Plan names, dates and counts are checked on the server and again in the Worker, and escaped.
- Adding a skill from the dashboard (`POST /admin/skill`) needs a signed-in session and the form's CSRF
  token, answers "not found" for a recruit outside a recruiter's pool, and keeps only the skill cleaned to
  the characters the email's form allows (60 at most); skills in the stats are checked before they are
  stored and escaped when shown.
- Exchange rates are only fetched over HTTPS, without following redirects, capped at 64 KB and checked
  (finite, positive, sane rates for known currencies only); a bad reply or tampered cache converts nothing.
  The dashboard can't change `JOB_FX_URL`, and a profile's currency must be one of the offered codes.
- Changing your own password needs the current one, and five wrong ones lock it for that account for 15
  minutes (a lock that can't be recorded refuses the change). The account is always the signed-in one,
  whatever the form sends; the change signs out every other session, and an old cookie can't be replayed
  to change it again. Only admins reset passwords, never their own or the main admin's.

- Dashboard passwords are kept only as salted PBKDF2-SHA256 hashes (30,000 iterations, stored with
  each hash) of an HMAC under `JOB_FEEDBACK_SECRET`, and checked in constant time; an unknown
  username takes as long as a wrong password. Sign-in keeps the existing lockout.
- Every recruit route checks the signed-in user's pool on the server, not just the links shown:
  others' pages, stats, jobs sent, documents, save status, CV uploads and actions answer "Recruit
  not found", and admin pages and actions answer "Admins only". Recruiters' invites always join
  their own pool, whatever the form says.
- Web search provider names from the dashboard are checked as own properties, so `__proto__` can't
  pass as a provider.
- The feedback Worker's build tools are updated to wrangler 4.144.0, which brings undici 7.29.1 and
  clears a new high-severity undici advisory in `npm audit`. These are development tools only; the
  deployed Worker does not include them.
- Word CVs saved as UTF-16 or UTF-32 are refused like ones declaring XML entities, since those
  encodings hid the declarations from the check.

- **Feedback Worker:**
  - Link signatures covered the fields joined with a separator that could appear in a title, so a
    signed link could be re-split into different fields. Now encoded unambiguously (see above);
    control characters are refused, answers are stored under replay-safe keys, and links for
    deleted profiles are refused.
  - `/admin` can require Cloudflare Access (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`; guide in
    [docs/feedback-worker.md](docs/feedback-worker.md#recommended-cloudflare-access-in-front-of-admin)).
  - The sign-in lockout counts an IPv6 /64 as one address, adds a global limit of 30 failures,
    and refuses sign-in when KV can't be read. **Sign out** ends every session; the cookie is
    `__Host-` prefixed.
  - Request bodies are size-limited while being read, uploaded .docx files are checked to be real
    Word files, invite links are checked before the upload is read, and keys queued from the admin
    page expire after 2 days.
  - Security headers on every page, and unexpected errors return a plain 500 without details.
- **CV reading** (`cv_text.py`): hostile PDFs could exhaust memory or CPU (compression bombs,
  page loops, huge fonts). Decompression, objects, pages and drawing operations are now capped,
  and CVs are read in a child process with a 60-second timeout (and memory and CPU limits on Linux).
- **Company logos** (`companies.py`): homepage and logo downloads refuse private and local
  addresses (also after redirects), follow at most 3 redirects, and cap page and image sizes.
- **Profiles:** a sign-up with an existing profile's email no longer replaces that profile, and
  the same invite can't create two profiles. Changing the SMTP host or user from the dashboard
  clears the stored password instead of sending it to the new server.
- **Files:** settings and profile files are written atomically with mode 600 from the start
  instead of being chmodded afterwards.
- **Email headers:** line breaks in subjects, names and addresses are removed. Short secrets are
  masked completely.
- **CI:** GitHub Actions are pinned to commit SHAs, ruff to a fixed version, and the gitleaks
  download is checked against its SHA-256.

## [0.1.0] - 2026-09-28

First public release. Two packages are ported from a private Hermes deployment and made fully
configurable, with no credentials, personal details or network addresses in the code.

### Added

- **Repository scaffolding.** README, this changelog, `.gitignore` (excludes `.env`, profiles and
  `state/`), `.gitattributes` (LF endings) and the `scripts/install.sh` installer.
- **Documentation.** [Installation](docs/installation.md), [configuration](docs/configuration.md),
  [web providers](docs/web-providers.md), [email rendering](docs/email-rendering.md) and
  screenshots from dry runs in `docs/images/`.
- **`common/hermes_common.py`**, the shared library:
  - Loads `$HERMES_HOME/.env` automatically on import, without overriding real environment
    variables.
  - Discovers the model from Hermes' `config.yaml`, with package, `OLLAMA_MODEL` and default
    fallbacks. Ollama hosts come from `config.yaml`, then `OLLAMA_HOST`, then
    `OLLAMA_FALLBACK_HOST`.
  - `WebClient` uses Firecrawl with backup keys, then Tavily and Scrapfly. Provider order is
    configurable, and a provider is dropped automatically when its credits run out.
  - `ollama_chat` supports JSON-schema output, and generated text is cleaned of em and en dashes.
  - SMTP sending uses inline (CID) images, with a configurable `SMTP_FROM` and `ALERT_EMAIL`.
  - The Gmail dark-mode header fix: `EMAIL_HEAD` and `gmail_dark_safe`.
  - `HERMES_STATE_DIR` relocates all runtime state.
- **Daily Vacancy Report** (`packages/daily-vacancy-report`):
  - Discovers jobs through web searches and optional nijobs.com keyword listings, with title
    pre-filtering and 90-day seen-state.
  - Hermes' model rates each job 0-10 against a candidate profile, with confidence, matched CV
    keywords, gaps and the real employer behind agency adverts.
  - Optional region filter, configured by place list or regex. With no region set, every
    location is kept.
  - Company enrichment: website, circular logo and an "About the company" section, cached for
    30 days.
  - Everything personal is configurable through `JOB_*` variables: report title, tagline,
    candidate name, region, search location and country, queries, title regexes, seniority
    penalties, score threshold and file paths.
  - Ships with `job_profile.example.md` (a fictional candidate), `cv_keywords.example.json`,
    `.env.example` and a complete `examples/northern-ireland.env`.
- **Noon Tech Digest** (`packages/noon-tech-digest`):
  - Sectioned news from the last 24 hours (AI, ML research, Python, IoT, new tech), widening to
    the past week when a section is quiet.
  - Hermes' model picks, rates and summarises stories and removes duplicates across sections.
    Top stories are read in full, and a short briefing leads the email.
  - PNG section icons built from Lucide and Simple Icons SVGs with `icons/build_icons.py`, which
    also accepts a custom sections file.
  - Configurable title, tagline, reader description (which steers the editor model), sections
    through `TECH_DIGEST_SECTIONS_FILE`, and selection limits.
  - Ships with `sections.example.json` and `.env.example`.

### Changed (compared with the private deployment)

- Removed the hard-coded candidate name, sender name, email addresses, LAN Ollama address and
  Northern Ireland defaults. Region-specific behaviour is now opt-in configuration.
- Seniority penalties default to 0. The default title filters no longer assume a particular
  vendor stack.
- Search country settings take ISO codes (`gb`, `us`), and the Tavily wrapper also accepts full
  names. The Scrapfly proxy country is configurable (`SCRAPFLY_COUNTRY`) instead of fixed.
- Pillow is optional: without it, company logos are skipped instead of the run failing.
- Package-relative paths for icons and default profile files, so packages also run straight
  from a clone.

[Unreleased]: https://github.com/Metaheurist/HermitShell/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Metaheurist/HermitShell/releases/tag/v0.1.0

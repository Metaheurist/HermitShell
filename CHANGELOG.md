# Changelog

All notable changes to HermitShell are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and packages are versioned together
using [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
### Removed

- **Noon Tech Digest.** HermitShell is now solely a job-finder platform: the digest package, its
  setup wizard steps, tests and CI job are gone. Existing installs keep their copy of
  `tech_digest.py`, its settings and its cron job; nothing is deleted from the server.

### Changed (breaking)

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

### Changed

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

- Job rating prompts put the CV, feedback and rubric first and the listing last, so Ollama can
  reuse the cached prompt prefix between jobs.
- Jobs whose page shows a salary below the minimum or a closing date in the past are dropped
  before the model is asked.
- The model's context size is only raised above the default when the prompt needs it.
- Adding a skill to the CV asks the model to rewrite only the skills section, not the whole CV.

### Security

A review of the whole app; none of these were known to be exploited.

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

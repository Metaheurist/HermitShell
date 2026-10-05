# Feedback buttons (Cloudflare Worker)

The Daily Vacancy Report can put buttons on every job: round thumbs up (**Good match**) and
thumbs down (**Not for me**) under the score, **I applied** and **Interested** next to **View job**,
and **Cover letter** and **Tailored CV** in their own panel below. Follow-up reminders get **Heard
back** and **Rejected**. Your answers:

- calibrate the model: recent jobs you liked (thumbs up, Interested, I applied) and turned down
  (thumbs down, with your reason) are added to the rating prompt as examples;
- drive reminders: jobs you applied to come back in a "Follow up" section after 7 and 14 days;
- feed the Sunday roll-up (applications, replies, rejections);
- request a tailored cover letter, emailed to you as a PDF (see [Cover letters](#cover-letters));
- add skills you have but your CV doesn't mention, by tapping the amber missing-skill tags (see
  [Adding missing skills](#adding-missing-skills)).

The button icons are [Lucide](https://lucide.dev) SVGs (`packages/daily-vacancy-report/icons/src`)
rendered to PNG by `icons/build_icons.py`, because Gmail strips SVG from emails.

Emails can't talk to a server on your home network, and opening a port for HermitShell isn't a good
idea. Instead, the buttons link to a tiny [Cloudflare Worker](https://developers.cloudflare.com/workers/)
that stores each answer in Workers KV. HermitShell collects the answers at the start of every run over
HTTPS. Nothing on your server is exposed, and the Workers free plan is more than enough.

```
email button ──> Worker /f (confirm page) ──> KV ──> HermitShell GET /events, POST /ack
```

<img src="images/worker/confirm-not-for-me.png" alt="Confirmation page for Not for me" width="300"> <img src="images/worker/saved.png" alt="Saved page" width="300">

*A button's confirmation page and what Confirm shows. Every page is in
[screenshots.md](screenshots.md#button-pages).*

## How it stays safe

- **Signed links.** Every button carries an HMAC signature of the job, action, title, skills,
  profile and the day the email was sent, made with `JOB_FEEDBACK_SECRET`. Changed or made-up
  links are refused, links stop working 90 days after the email, and links for a deleted profile
  are refused too. `JOB_FEEDBACK_URL` must start with `https://`; without it no buttons are added.
- **Nothing is saved on click.** Opening a link only shows a confirmation page (with an
  optional note). Mail scanners that open every link can't record answers; only pressing
  **Confirm** saves one.
- **Private, signed API.** `/events`, `/ack` and `/api/*` need `Authorization: Bearer <JOB_FEEDBACK_API_TOKEN>`
  and, from HermitShell, an HMAC-SHA256 signature over the method, path and query, a timestamp, a one-time
  nonce and a hash of the body, under a key derived from `JOB_FEEDBACK_SECRET` (`X-HermitShell-Time`,
  `-Nonce` and `-Signature` headers). The Worker refuses a signature more than five minutes old or ahead, a
  nonce it has seen in the last ten minutes (kept in the live link's Durable Object) and anything altered on
  the way. After the first signed request it refuses requests with the token alone (KV key `api:signed`), so
  an older HermitShell keeps working until it updates, and after that a leaked token or a copied request is
  no use on its own. HermitShell only talks to the Worker over `https://` (plain http only to
  `localhost`), never follows a redirect with the token, and retries 429 and 5xx answers and dropped
  connections with backoff, honouring `Retry-After` (`common/worker_link.py`).
- **Secrets sealed for your server.** Passwords, API keys and CVs typed or uploaded into the dashboard or the
  sign-up form are encrypted in the Worker before they reach KV, with a public key HermitShell sends in its
  status (RSA-OAEP-3072 wrapping a fresh AES-256-GCM key per value, bound to the field or CV it belongs to).
  Only your server holds the private key (`state/worker_seal.json`, encrypted with `HERMES_DATA_KEY` when that
  is set), so KV and anyone who can read it in your Cloudflare account only see ciphertext. Until HermitShell
  has sent its key the Worker refuses to save a password or API key (**Not saved: HermitShell hasn't sent the
  key...**); sign-ups and CVs are still taken and stored as before. To change the key, run
  `python3 worker_seal.py --rotate` in HermitShell's `scripts` folder (`docker exec hermitshell python3
  /data/scripts/worker_seal.py --rotate` in the container); the old key opens anything sealed before for 30
  more days.
- **Versions that match.** HermitShell and the Worker both state a protocol number
  (`X-HermitShell-Protocol`). When they differ, the dashboard and Global settings say which one is older and
  how to update it, and `doctor.py` warns too.

<img src="images/worker/admin-settings-mismatch.png" alt="Global settings with a warning that the Worker is older than HermitShell and the command to redeploy it" width="720">

*A Worker older than HermitShell, until it is redeployed.*

- **Protected admin page.** `/admin` is off until you set `ADMIN_PASSWORD`, and can sit behind
  Cloudflare Access (an emailed one-time code) as well; see
  [Recruits](#recruits-and-the-admin-page).
- **Size limits.** Request bodies are capped (answers and status reports at a few KB, sign-ups at
  the CV limit), and uploaded CVs are checked to really be a PDF, .docx or text file. Letters and
  CVs kept for download (`POST /api/doc`, and a recruit's own CV through `POST /api/cv`) must be a PDF
  of at most 2 MB.
- **Short-lived data.** Answers are deleted once HermitShell has saved them, and expire after 30 days
  in any case. Only the job key, action, optional note and time are stored. Letters and CVs kept for
  download are encrypted and deleted after `COVER_LETTER_KEEP_DAYS` (7 by default); a recruit's own CV
  made with **Generate** is kept encrypted until the next one replaces it or they unsubscribe or are
  deleted. Jobs emailed
  from the dashboard (`POST /api/emailed`) are kept as a hash of the job key and a time, for 90 days.
- **No outside content, and one script of its own.** Every page's Content-Security-Policy blocks
  anything loaded from elsewhere and all inline script. The HermitShell mark at the top of each page is
  drawn inline, and the tab icon, `/favicon.svg` (the same mark), comes from the Worker itself (a plain
  SVG with no scripts or links). Styles shared by every page come from the Worker's own `/app.css`
  (`style-src 'self'`, cached by the browser until they change). Public pages (email buttons, sign-up,
  privacy) run no JavaScript at all.
  Signed-in dashboard pages may load one file, `/enhance.js` (`script-src 'self'`), which updates a
  waiting page in place and stops a form being sent twice; every page works the same without it.
- **No secrets in git.** The two secrets live only in HermitShell's `.env` and in the Worker's
  encrypted secrets. Your KV namespace ID goes in an untracked `wrangler.local.jsonc`.
  `JOB_FEEDBACK_SECRET` signs both the email links and HermitShell's API requests, so it must match on
  both sides.

## What you need

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up).
- Node.js 18 or newer on the machine you deploy from (your PC is fine; it doesn't have to be the
  HermitShell server).
- This repository checked out on that machine.

**Easiest: let the setup wizard deploy it.** Give `scripts/setup.py` your Cloudflare account ID and
an API token and it creates the KV namespace, uploads the Worker, sets its secrets and fills in
`JOB_FEEDBACK_URL`, with no Node.js needed: see [docs/cloudflare-setup.md](cloudflare-setup.md).
The rest of this page is for deploying by hand.

Deploying by hand takes about ten minutes. Pick one of the two routes below; they end in the same
place. Afterwards, run the setup wizard (or edit `.env`) as described in
[Connect HermitShell](#connect-hermitshell).

## Route A: let an AI agent do it with the Cloudflare MCP

If you use an AI coding agent with MCP support (Cursor, Claude Code, VS Code and others), the
[Cloudflare MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/)
let the agent create the resources for you. In Cursor, install the Cloudflare plugin; elsewhere,
add the **Workers Bindings** server (`https://bindings.mcp.cloudflare.com/mcp`) and, optionally,
**Workers Observability** (`https://observability.mcp.cloudflare.com/mcp`) to your MCP config.

1. Open this repository in the agent and ask something like:

   > Deploy the vacancy feedback Worker in `packages/daily-vacancy-report/feedback-worker`
   > following `docs/feedback-worker.md`. Use the Cloudflare MCP to create the KV namespace,
   > put its ID in a `wrangler.local.jsonc` (not the committed `wrangler.jsonc`), deploy with
   > wrangler and give me the workers.dev URL. Don't print any secrets.

2. The agent signs in to the MCP server. Your browser opens a Cloudflare page where you choose
   the account and approve access.
3. It calls `kv_namespaces_list` to check what exists, then `kv_namespace_create` (for example
   with the title `vacancy-feedback-FEEDBACK`), and writes the returned ID into
   `wrangler.local.jsonc`.
4. It runs `npm install`, `npm test` and `npx wrangler login` (approve in the browser again),
   then `npx wrangler deploy --config wrangler.local.jsonc`. If your account has never used
   Workers, Cloudflare first asks you to choose a `workers.dev` subdomain. Anyone who sees a
   button link sees this name, so a neutral one is a good choice.
5. It can confirm the deployment with the MCP's `workers_get_worker` tool, and check requests
   later with the observability server.
6. Note the URL, e.g. `https://vacancy-feedback.<subdomain>.workers.dev`, and continue with
   [Connect HermitShell](#connect-hermitshell). The secrets are created there.

## Route B: by hand with wrangler

From the repository root:

```sh
cd packages/daily-vacancy-report/feedback-worker
npm install
npm test                 # optional: runs the Worker's tests locally
npx wrangler login       # opens the browser once
npx wrangler kv namespace create FEEDBACK
```

The last command prints an `id`. Copy the config and put the ID in the copy:

```sh
cp wrangler.jsonc wrangler.local.jsonc
# edit wrangler.local.jsonc: replace REPLACE_WITH_YOUR_KV_NAMESPACE_ID with the id
npx wrangler deploy --config wrangler.local.jsonc
```

(You can edit `wrangler.jsonc` itself and run plain `npx wrangler deploy` instead. Just don't
commit the ID if you share your fork.)

On the first deploy, wrangler may ask you to register a `workers.dev` subdomain; accept it and
pick a name. The deploy prints your URL, e.g.
`https://vacancy-feedback.<subdomain>.workers.dev`. Opening it in a browser shows
"HermitShell feedback endpoint."

## Connect HermitShell

HermitShell and the Worker must share two random secrets.

### With the setup wizard (recommended)

```sh
python3 scripts/setup.py daily-vacancy-report
```

Paste the Worker URL when asked about feedback buttons. The wizard generates
`JOB_FEEDBACK_SECRET` and `JOB_FEEDBACK_API_TOKEN`, saves them to `.env` in HermitShell's home and, if
`npx` is available where the wizard runs, offers to pipe them straight into
`wrangler secret put` so they are never shown on screen. If wrangler isn't available there, the
wizard prints commands like these to run from the `feedback-worker` folder on the machine you
deployed from. They read the values from `.env` and pipe them, so they are never displayed:

```sh
sed -n 's/^JOB_FEEDBACK_SECRET=//p' /opt/hermitshell/data/.env | npx wrangler secret put JOB_FEEDBACK_SECRET
sed -n 's/^JOB_FEEDBACK_API_TOKEN=//p' /opt/hermitshell/data/.env | npx wrangler secret put JOB_FEEDBACK_API_TOKEN
```

Add `--config wrangler.local.jsonc` if you deployed with a local config.

### By hand

Generate two values and add them to `$HERMITSHELL_HOME/.env` (keep the file at mode 600):

```sh
python3 -c "import secrets; print('JOB_FEEDBACK_SECRET=' + secrets.token_urlsafe(32))" >> "$HERMITSHELL_HOME/.env"
python3 -c "import secrets; print('JOB_FEEDBACK_API_TOKEN=' + secrets.token_urlsafe(32))" >> "$HERMITSHELL_HOME/.env"
echo 'JOB_FEEDBACK_URL=https://vacancy-feedback.<subdomain>.workers.dev' >> "$HERMITSHELL_HOME/.env"
```

Then copy the two secrets to the Worker with the `sed ... | npx wrangler secret put` commands
above.

## Check it works

```sh
# from the Worker folder: the endpoint answers
curl https://vacancy-feedback.<subdomain>.workers.dev/
# the API refuses requests without the token (expect 401)
curl -i https://vacancy-feedback.<subdomain>.workers.dev/events
# a dry run syncs feedback first; "feedback Worker unreachable" in the log means a wrong URL or token
python3 job_scanner.py --dry-run --limit 3
```

The next email has buttons under each job. Press one, confirm, and the following run logs
`synced 1 feedback answers from the feedback Worker`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Link not valid" when pressing a button | The Worker's `JOB_FEEDBACK_SECRET` differs from `.env`. Put it again with `wrangler secret put`. |
| Report banner: "feedback Worker unreachable (HTTP 401)" | The API token or `JOB_FEEDBACK_SECRET` (which signs every request) differs. Put both again, or check with `npx wrangler tail`: `bad signature` means the secret, `unauthorised` the token. `signature expired` means the server's clock is more than five minutes out. |
| "Not saved: HermitShell hasn't sent the key..." on Global settings | HermitShell is older than the Worker, or not connected yet. Update it (the container updates itself); the key arrives with its next status. |
| "HermitShell and this Worker don't match" | Update whichever it says is older: `docker exec hermitshell /app/entrypoint.sh worker` redeploys the Worker. |
| Log: "JOB_FEEDBACK_URL must start with https://" | HermitShell never sends the token over plain http. Use the `https://` address the wizard printed. |
| TLS or handshake errors right after the first deploy | A new `workers.dev` subdomain takes a few minutes to get its certificate. Wait and retry. |
| No buttons in the email | `JOB_FEEDBACK_URL` or `JOB_FEEDBACK_SECRET` is empty in `.env`. |
| Answers never arrive | Check requests with `npx wrangler tail`, or the Workers Observability MCP / dashboard logs. |
| No cover letter email | Check `python3 scheduler.py list` for `vacancy-cover-letters` and its output in `cron/output/`; run `python3 cover_letter.py` by hand to see errors. |
| No daily report for someone you invited | Check `python3 scheduler.py list` for their `vacancy-report-<id>` job and its output in `cron/output/`; `python3 profiles.py report <id>` runs it by hand. A report sent with **Send jobs now** logs to `state/profiles/runs.log`. |

Answers wait in KV until HermitShell fetches them, so a server that is off for a few days loses
nothing (up to 30 days).

## Cover letters

**Cover letter** on a job card opens the usual confirmation page, where you can add guidance
("mention my Azure work") and choose its **Length** (short, about 200 words in 3 paragraphs; standard,
about 300 in 4; detailed, about 400 in 5) and **Tone** (professional, warm, direct or formal). After you
confirm:

```
Cover letter button ──> Worker (confirm) ──> KV ──> cover_letter.py every 5 min ──> email + PDF
```

1. `cover_letter.py`, a scheduled job, fetches the request from the Worker within 5 minutes.
2. The model first maps the job: the advert's main requirements, each with the fact from your CV that
   shows it, or marked as not shown ([evidence map](configuration.md#cover-letters-from-an-evidence-map),
   kept per job so a new letter or the tailored CV reuses it). It then writes the letter from that map,
   `job_profile.md` (plus `COVER_LETTER_CV_FILE` if set), the listing and your note, in the length and
   tone asked for, using only facts from your CV.
3. The draft is checked without a model (`writing_checks.py`). One that is too short, has placeholders,
   or uses a job title or figure your CV doesn't have is sent back with exactly what is wrong, up to
   twice, and refused if it still does. Stock phrases ("I am excited", "passionate"), missing most of
   the requirements the CV shows, or being off the length asked for get one rewrite.
4. The letter is laid out as an A4 PDF with real, selectable text (`letter_pdf.py`, no extra
   packages), saved in `state/cover_letters/`, and emailed to you with the job details, a
   preview and a View job button. With `DOC_WORD_COPIES=1` a Word copy (`letter_docx.py`) is saved
   beside it and attached too.

<img src="images/emails/cover-letter.png" alt="Cover letter email" width="360"> <img src="images/emails/cover-letter-pdf.png" alt="Cover letter PDF" width="300">

**Tailored CV** follows the same path: `cover_letter.py` asks the model to reorder and reword your
CV for the job (titles, employers and dates are copied, never invented), led by the same evidence map as
the letter, and emails it as a PDF ([email](images/emails/tailored-cv.png),
[PDF](images/emails/tailored-cv-pdf.png)). Bullets that name what the job asks for come first, each
starting with an action verb, cut to about two pages. The email ends with a match report: how many of the
requirements your CV shows the tailored CV covers, and what the advert asks for that your CV doesn't show
([Tailored CVs](configuration.md#tailored-cvs)).

The letter and CV are written on your HermitShell server; the Worker sees the job key and your note,
and afterwards keeps the finished PDF for download (below). Failed attempts are retried on the next
two runs, then given up (see `letters` in `state/job_tracker.db`).

**Made once, kept for 7 days.** Each finished letter or CV is kept for `COVER_LETTER_KEEP_DAYS`
days (default `7`, at most `30`, `0` turns this off), counted from when it was first made:

- Pressing the same button again, in any email, opens a page that offers the one already made
  (**Download PDF**) instead of queueing another, with **Confirm: write a new cover letter** if you
  want a new one anyway.
- A request that reaches the server with no note, while a PDF made for that job is still on disk
  and within those days, emails that PDF again without using the model. A note, a length or tone
  other than standard and professional, or asking for a new one, always writes a new one.
- The Worker keeps each PDF in KV (`doc:<profile>:<kind>:<job hash>`) encrypted with AES-GCM under
  a key derived from `JOB_FEEDBACK_SECRET`, bound to that profile, job and kind, and KV deletes it
  when its days are up. It is served only to a signed-in admin or through a signed email link for
  that job, as a download that the browser cannot run as a page.

<img src="images/worker/confirm-cover-letter-ready.png" alt="The cover letter page offering the letter made earlier for download" width="300">

Put your name and contact line in `.env` so they appear on the letter:

```sh
COVER_LETTER_NAME=Sam Taylor
COVER_LETTER_CONTACT=Belfast · sam@example.com · 07700 900000
```

The wizard schedules the job; by hand:

```sh
python3 scheduler.py create "*/5 * * * *" "Cover letter requests" \
    --name vacancy-cover-letters --script cover_letter.py
python3 cover_letter.py --job <tracker key> --dry-run   # try one without email
python3 cover_letter.py --job <tracker key> --length short --tone warm --dry-run
```

The job prints nothing when there is nothing to do, so its runs leave no output file.

## Adding missing skills

Each job card lists the skills the listing asks for that your CV doesn't show, as amber tags
under **Missing from your CV**. If you have one of them, tap it. The Worker opens a page with
that skill ticked and the job's other missing skills beside it, plus a box for any other skills
you want to add. After you confirm:

<img src="images/worker/confirm-add-skill.png" alt="Add to my skills page" width="300"> <img src="images/worker/saved-add-skill.png" alt="Skills added" width="300">

- the skills join your skills pool (`skills` in `state/job_tracker.db`) at the next sync, which
  happens within 5 minutes when cover letters are set up, otherwise at the next scan;
- the scanner treats them as CV keywords, so they count as matches instead of gaps, and adds
  them to the profile the model rates jobs against;
- cover letters may mention them as general skills, never as work done at a named employer.

The same can be done from the dashboard's list of jobs sent, by pressing a missing skill on an
opened job ([below](#jobs-sent)); it needs a signed-in session and the form's CSRF token.

The skill list is part of the link's signature, so a link can't be edited to offer other
skills; typed skills are limited to letters, numbers and `+ # . / & ( ) -`. Your CV files are
never changed. To review or undo:

```sh
python3 job_scanner.py --skills                   # list the skills you added
python3 job_scanner.py --remove-skill "Kubernetes"
```

## Recruits and the admin page

One HermitShell sends reports to people looking for work, each built from their own CV. The admin page
calls them **recruits** (on the server each one is a profile under `state/profiles/<id>/`). You and your
recruiters are staff: you manage recruits from the Worker's admin page and are never recruits yourselves.
HermitShell applies the changes, since the Worker can't reach your server.

```
/admin (you) ──> invite link ──> /join (them: details + CV) ──> KV ──> profiles.py (checks every 15 s)
```

1. Set an admin password on the Worker (and optionally a username; the default is `admin`). Pipe
   it in so it never lands in your shell history, e.g. from a password manager's CLI:

   ```sh
   <print-password-command> | npx wrangler secret put ADMIN_PASSWORD --config wrangler.local.jsonc
   echo admin | npx wrangler secret put ADMIN_USER --config wrangler.local.jsonc   # optional
   ```

2. Schedule `profiles.py` (the wizard does this):

   ```sh
   python3 scheduler.py create "*/5 * * * *" "Extra profiles" \
       --name vacancy-profiles --script profiles.py
   ```

   Each run syncs, then makes sure the **live link** is up: a background `profiles.py listen`
   process that keeps a WebSocket open from your server to the Worker's `/api/live`. The Worker
   pushes a message down it the moment anything is queued, so dashboard changes and sign-ups are
   applied within a second or two, and the dashboard shows **HermitShell is online**. The link
   pings every 30 seconds, reconnects by itself after a drop (every Worker deploy closes it) and
   restarts when `profiles.py` changes; if the process dies, the next run starts another.
   `python3 profiles.py --once` syncs once and exits. Items are applied in the order they were
   queued; before a slow one (a sign-up, a new CV or a test email) starts, everything already
   applied is reported to the Worker, so those changes stop showing as waiting straight away.

   The link runs on a [Durable Object](https://developers.cloudflare.com/durable-objects/) (`Hub`,
   binding `HUB`) that `cloudflare_worker.py` creates with the Worker. It is on the free plan: the
   socket is hibernatable and the pings are answered without waking it, so an idle link costs
   nothing. Your server still accepts no incoming connections; the WebSocket is outgoing, like
   the polling it replaces.

   Without the link (a Worker deployed before it existed, `JOB_PROFILES_LIVE=off`, or no
   `websockets` Python package) each run instead keeps watching until just before the next one:
   every 15 seconds it reads `/api/queue/flag` (one KV read, no list) and syncs as soon as
   something new is queued. It tries the link again every hour. `JOB_PROFILES_WATCH_SECONDS`
   (default 250, counted from the start of the run so it ends before the next one; `0` turns
   watching off) and `JOB_PROFILES_POLL_SECONDS` (default 15, at least 5) tune that fallback.

3. Open `https://vacancy-feedback.<subdomain>.workers.dev/admin`, sign in and press
   **Create invite link**. Each link works once and expires after 7 days; send it to the person. The link
   opens on its own page, so reloading that page shows the same link rather than making another.
   (`python3 profiles.py --invite "note"` makes one from the server too.)
4. They fill in their name, email, optional phone and town, the roles they want, and upload a CV
   (PDF, Word .docx or text, up to 5 MB) or paste it. The CV waits in KV, deleted once HermitShell has it.
5. Within seconds `profiles.py` downloads it, reads the text (`cv_text.py`, no extra packages;
   scanned image-only PDFs can't be read, so the pasted text is used instead), and asks HermitShell's
   model for a summary, job titles, skills and gaps. From those it writes the person's
   `job_profile.md`, `cv_keywords.json` and search settings under `state/profiles/<id>/`, emails
   them a welcome message listing what it will search for, and emails you a note.

<img src="images/worker/join-form.png" alt="Sign-up form" width="280"> <img src="images/emails/welcome.png" alt="Welcome email" width="330">

*The sign-up form and the welcome email. The other states are in
[screenshots.md](screenshots.md#sign-up-page).*

From then on each recruit has their own daily report: a scheduled job named
`vacancy-report-<id>` that `profiles.py` creates with the recruit, running `profile_report.py`
from their folder. It is paused while the recruit is and removed when they are deleted, so
`python3 scheduler.py list` shows every recruit's report, when it last ran and whether it worked,
and one recruit's slow or failed run doesn't hold up the others. A new recruit's report starts 15
minutes after the latest one; change any recruit's time on their page. The setup's own
`job_scanner.py` job no longer searches for anyone: it only starts the weekly roll-ups and cover
letters for each active recruit. Without the scheduler (no `cron/jobs.json`), that daily run runs
everyone's reports one after the other instead. Each recruit keeps their own job search (region,
places, titles, salary, job types; a new recruit's searches start from the town they signed up
with, and any region is set on their page), seen jobs, tracker, feedback buttons and skills pool.
They share the server's job sources, search keys and model settings, and every
model request (ratings, cover letters, CVs, sign-ups, for all recruits) waits in one shared queue,
so the model only ever gets one request at a time; see
[configuration](configuration.md#where-settings-come-from). A sign-up
that uses the email of an existing recruit is not applied (so an invite can't take over someone
else's profile); HermitShell emails you about it instead. Opening the same invite twice creates only
one recruit.

CVs are read in a separate process with a time and memory limit, so a broken or hostile file
can't stall the server.

The main admin is the `owner` row: staff, with no CV, job search or report of their own. Once the
Worker is linked (`JOB_FEEDBACK_URL` and `JOB_FEEDBACK_API_TOKEN` set), `profiles.py` moves a job
search still set up in the server's `.env` (from before recruits, or from a single-person setup) to a
normal recruit once: same name, email, CV, job history, answers and report time, then manages it like
any other. Links in reports sent before the move still work: their answers, letters and CVs go to that
recruit, and their unsubscribe link pauses it. Recruits that were sharing the `.env` search each get
their own copy of it once, so changing one recruit's search never changes another's.

### The admin page

Once the wizard has deployed the Worker, everything else can be set here: the email server, the
web search keys, and each recruit's details, job search and CV. Three tabs split it up: **Recruits** (each
recruit's details, job search and CV), **Users and roles** (who else can sign in, and as what) and **Global
settings** (the email server and web search keys the whole tool shares). Recruiters see only the
**Recruits** tab, with only their own pool in it; see [Users and roles](#users-and-roles).

<img src="images/worker/admin-dashboard-setup.png" alt="Admin page right after setup, with the checklist" width="720">

- **HermitShell is online**, with a green dot, while the live link is up (changes take effect
  within seconds), followed by when it last reported its recruits. Without the link the line says
  when HermitShell last checked in instead (each poll counts). Times on every admin page are in
  your timezone (`HERMES_TIMEZONE`). If it hasn't checked in for 45 minutes, a warning asks you to
  check its `vacancy-profiles` job.
- **Finish setting up**: a progress bar and checklist until HermitShell has connected, the email server is set and a
  test email worked, there is a web search key, and the first recruit has joined. Each item links
  to its form, the last one to **Create invite link**.
- **HermitShell could not apply**: changes HermitShell rejected in the last day (a mistyped SMTP server,
  for example), with the reason.
- **Recruits**: every recruit HermitShell reports (never you or another dashboard user), with the date they joined, their status, when their
  last report ran (hover it for the exact time), their report time (**Daily at 08:00** or
  **Weekdays at 08:15**) and a **no CV** tag when there is none yet. The buttons sit on one line at
  the end of the row. **Send jobs** runs that recruit's report straight away (see
  [Send jobs now](#send-jobs-now)); while a report is running, daily or sent now, it says
  **Finding jobs…** and the row says **finding jobs now**. **Manage** opens that recruit's page (details,
  job search, report time and CV). The sent button has two halves: the little chart opens its
  [stats page](#stats) and **24 sent** the [list of jobs sent](#jobs-sent). The pause and play
  buttons pause or resume their reports, and the red bin button deletes them: it opens a window where you tick **Yes, delete their CV and everything HermitShell has about them** and press **Delete**.
  A pause, resume, delete, assignment or send shows on the row at once with a tag (**pausing&hellip;**,
  **deleting&hellip;**), and the page reloads itself, keeping where you had scrolled, until HermitShell has
  applied it (the same timings as [Global settings](#global-settings)). Pressing the same button again, or
  several times at once, queues nothing more: a pause, resume, retire, delete or assignment already waiting
  for that recruit counts, and so does the same press in the last two minutes until HermitShell reports again
  (the hub decides this in one statement, so of presses arriving together only one goes through; without the
  hub a short-lived KV key does). A recruit who already is what was pressed gets **Nothing had changed**, and
  the bulk bar skips them. Recruiters only see their own
  recruits' changes. Sign-ups and new CVs take minutes and show their own progress, so they don't reload the page.
  Deleting removes their CV and history from your server, their answers still waiting in KV and
  their name and email from the logs. Retired recruits ([Retiring a recruit](#retiring-a-recruit)) are left
  out of the list, with **N retired** beside the count to show them.
- **Pending sign-ups**: someone who has sent the invite form gets a **pending** row straight away
  (name, email, when and what they're looking for), while HermitShell reads their CV and sets them
  up. HermitShell reports the new recruit before it takes the sign-up off the queue, so the row
  turns into the recruit without the person dropping off the dashboard in between.
- **Search**: the magnifying glass above the table slides out a search box and a status dropdown
  (CSS only). Press Enter and the page lists only the recruits whose name, email, id, place, tags or
  recruiter contain every word you typed (`/admin?q=`), with a count and **&times;** to show everyone
  again. Status isn't typed: pick **Active**, **Paused**, **Finding jobs now**, **No CV**, **Pending
  sign-up** or **Retired** from the dropdown (`/admin?s=`) to list only those, on its own or with the words. Picking
  one lists them at once; without JavaScript a **Show** button appears beside it instead. Searching
  a recruiter's name or username puts the recruiter at the top, followed by all of their recruits
  and then anyone else who matches; a recruiter and a person together (`casey jordan`) finds that
  person under their recruiter.
- **Recruiter** (admins and managers): the recruiter's initials and a list showing whose pool each
  recruit is in (**?** and **Unassigned** when nobody's). Pick someone else and an **Assign** button
  appears next to the list. The change is shown at once and HermitShell records it within seconds. A
  manager's list holds only their team's recruiters (and themselves, when they recruit too), and
  has no **Unassigned**: only an admin can leave a recruit with nobody.
- **Invites**: create, see and revoke unused links. An admin picks whose recruit the person
  becomes (their own, when they have the Recruiter role), a manager picks a recruiter in their
  team, and a recruiter's invites always join their own pool.

<img src="images/worker/admin-recruiter-search.png" alt="Searching a recruiter: the recruiter first, then their recruits" width="720">

#### Users and roles

`/admin/users`, admins and managers. The main admin signs in with `ADMIN_USER` and the
`ADMIN_PASSWORD` secret, as before, and always has the Admin role. Everyone else gets an account here.

<img src="images/worker/admin-users.png" alt="Users and roles: the three roles and the dashboard users" width="720">

| Role | What they can do |
|---|---|
| **Admin** | Everything: every recruit, assigning recruits, users and roles, global settings and deleting recruits |
| **Manager** | Their team: the recruiters an admin puts in it or they add, and those recruiters' recruits. Everything a recruiter can do for those recruits, plus moving recruits between the team's recruiters, inviting people to any of them, adding, renaming, resetting and deleting the team's recruiters, the team's desk with fees and setting fees on the Pipeline. Never other teams, unassigned recruits, admins or other managers, the task list, the server, the theme, exporting notes, deleting recruits or the settings |
| **Recruiter** | Their own pool only: the people they invite and the recruits assigned to them. They manage those recruits' details, CVs and daily reports, send jobs now, pause or resume them and see their stats and jobs sent, but never see anyone else, the task list or the settings |

- **Add user** opens a window for a name, a username (2 to 32 lower-case letters, numbers, `-` or
  `_`) and a password, and the roles. Passwords shorter than 12 characters are allowed but marked
  **short password** on the list.
- Each row's actions are icon buttons, with their name when you point at them: the pencil,
  the key and the red bin.
- **Edit** (the pencil) changes a user's name and roles, and for a recruiter with no other role,
  their **Manager**: the team they are in. The **Manager** list hides as soon as Manager or Admin is
  ticked, in **Edit** and **Add user** alike, since managers and admins are in no team. The list shows
  "in Morgan Ellis's team" under their roles, and how many recruiters each manager has.
- **Reset password** (the key button) opens a window for a new password, typed twice. The user is
  signed out everywhere at once and signs in with the new password; it isn't emailed, so tell them
  yourself. It isn't offered for the main admin's account; on your own row the key opens
  **Change password** instead.
- The red bin button opens a window to confirm; tick the box and press **Delete** to sign the user
  out, delete their unused invites and leave their recruits unassigned. You can't delete or demote
  the account you are signed in with.
- The main admin's own **Edit** window adds or removes the Recruiter role for you, so people you
  invite can join your own pool.

A team lives on the recruiter accounts, in the Worker's KV with the rest of the users; HermitShell
only sees which recruiter each recruit has. Only a recruiter-only account can be in a team, and only
under a user with the Manager role and not Admin, so taking a manager's role away or deleting them
empties their team at once, and giving a team member another role takes them out of it.

A manager's **Your team** tab is this page cut down to them and their team. **Add a recruiter**
always makes a recruiter in their team, whatever roles the form carries; **Edit** changes only the
name; the key and the bin work as for an admin, but only on their team. Deleting a recruiter moves
their recruits to the manager when the manager recruits too, and otherwise leaves them unassigned,
where only an admin sees them. Anything aimed at someone outside the team answers "Managers can
change only the recruiters in their own team."

Passwords are stored in the Worker's KV only as a salted PBKDF2-SHA256 hash of an HMAC under
`JOB_FEEDBACK_SECRET`, so the KV value alone can't be guessed against. Every route checks who is
signed in: a recruiter who opens another recruit's page, stats, jobs sent or documents gets
"Recruit not found", and so does a manager for anyone outside their team; admin pages or actions
answer "Admins only", and Users and roles answers a recruiter "Admins and managers only". Each user signs out on their
own; the main admin's **Sign out** still signs out every main-admin session.

#### Changing your own password

Every dashboard page shows who is signed in at the top right: a badge with your initials, name and
roles, and under it the key button (**Change password**) and **Sign out**. On narrower windows they sit
in a row above the page, with just your initials. Recruits and Users and roles grow with the window (up
to 1320px), so they keep the row above the page up to 1860px wide.

<img src="images/worker/admin-signed-in.png" alt="The signed-in badge at the top right: initials, name and role, then the key button and Sign out" width="720">

Admins also get a **server** button before the key button. Point at it (or Tab to it) and a panel
opens with the machine HermitShell runs on: CPU and its load, memory, each GPU's memory and free
disk, each with a bar (amber from 70%, red from 90%). The GPUs come from the host's hardware report,
written every 2 minutes by the Ollama watchdog; when it is late, each GPU seen in the last day stays
listed with its memory and "Use not reported since&hellip;" instead of vanishing, and its bar is back as soon
as a report arrives (HermitShell sends a GPU going or coming back at once). Under them are the AI models in the order they
are asked, each with its model name and whether it is ready, how many requests it answered today or
why it is resting, then which one gave the last answer. **Backups** shows the last backup, its size
and how many are kept (or why the last one failed), when the last one was sent to
[Cloudflare](#backups-on-cloudflare) and how many copies are kept there, with a **Download** link (or why
they aren't sent, or that sending the last one failed), a reminder to keep `HERMES_DATA_KEY` away from the
server, and **Back up now**, which asks HermitShell for a backup straight away (once per 10 minutes; it
won't run beside the nightly one, see [Data protection](configuration.md#data-protection)). Last comes
**Model settings**. It needs no JavaScript, and it shows what HermitShell last reported (see
[AI models](#ai-models)). Recruiters don't get the button.

<img src="images/worker/admin-server-panel.png" alt="The admin's server panel: CPU, memory, GPU and disk bars, then the models in the order they are asked, the last backup and Back up now" width="720">

Between the server button and the key button, admins have a **palette** button that opens
[Theme and branding](#theme-and-branding).

Every dashboard user, recruiters included, changes their password with the key button (or
**Change password** on their own row under Users and roles). It asks for the current
password and the new one twice. You stay signed in in that browser and are signed out everywhere
else. Five wrong current passwords lock changing it for that account for 15 minutes; an admin's
**Reset password** clears the lock.

The main admin's password is the `ADMIN_PASSWORD` secret, so their window shows how to change it
instead: `npx wrangler secret put ADMIN_PASSWORD` from the `feedback-worker` folder, which asks for
the new password. That signs everyone out, every dashboard user included.

<img src="images/worker/admin-password-modal.png" alt="A recruiter's Change password window: current password and the new one twice" width="380">

<img src="images/worker/admin-recruiter-view.png" alt="A recruiter's view: only their own recruits and their invites" width="720">

<table>
<tr><th>A manager's recruits</th><th>A manager's team</th></tr>
<tr>
<td><img src="images/worker/admin-manager-view.png" alt="A manager signed in: their team's recruits, a Recruiter column limited to the team and team-only invites" width="380"></td>
<td><img src="images/worker/admin-manager-team.png" alt="The Your team page: the manager and the recruiters in their team, with Add a recruiter" width="380"></td>
</tr>
</table>

HermitShell keeps each recruit's recruiter in their `profile.json`. From the server:

```bash
python3 profiles.py --list                       # the recruiter is the third column
python3 profiles.py --assign sam-lee-456789 casey   # "" puts them in nobody's pool
```

#### Theme and branding

`/admin/theme`, from the palette button at the top right (admins only). It sets how every page the
Worker draws looks: the dashboard, sign-in, the sign-up form and the pages behind email buttons.
**Save theme** applies it for everyone within about a minute; **Reset to default** goes back
to the default, which is what a new Worker starts with and stores nothing. **Back to recruits** at the
top left returns to the dashboard.

<img src="images/worker/admin-theme.png" alt="Theme and branding: name, logo and logo options, eight palettes and a custom one, and the look options, with a live preview on the right" width="720">

- **Branding.** A **Name** (up to 40 characters) shown at the top of every page in place of
  HermitShell; messages about the HermitShell server keep its name. A **Logo** in PNG, JPEG, GIF or
  WebP up to 200 KB, checked by its content rather than its name. SVG is refused, as it can carry
  script. Then whether the name shows next to the logo, whether the logo is the browser tab's icon,
  and a small or large logo. Tick **Remove the logo** under the current one to go back to the
  HermitShell mark.
- **Palette.** HermitShell's indigo and violet, Ocean, Forest, Royal, Berry, Sunset, Ember and
  Graphite, or **Custom** with two colour pickers. Custom colours too light for white button text are
  darkened a little. The whole family of brand colours (buttons, links, focus rings, the background's
  glow, charts and the favicon) moves to the palette; status colours such as green, amber and red stay, and
  the search and AI providers' logos keep their own brand colours.
- **Look.** Background (aurora, still or plain), corners (rounded, soft or sharp), font (system,
  rounded, serif or mono), spacing (comfortable or compact) and motion (full, or calm, which stops the
  background drifting and cards sliding in).

The preview beside the form follows the palette, corners, font, spacing and name as you change them,
and shows a logo as soon as you pick the file, before it is saved. A file over 200 KB, or one that isn't a
PNG, JPEG, GIF or WebP picture, is cleared straight away with the reason. The picked file is shown from the
browser's own copy (a `blob:` address, allowed for images on signed-in pages only) and is only uploaded
by **Save theme**, which checks it again.
The theme is kept in KV (`theme`, and `theme:logo` for the picture) and demo mode shows it too.
Emails are drawn by HermitShell, so they keep HermitShell's look.

<img src="images/worker/admin-theme-applied.png" alt="The Recruits page under the name Northwind Talent in the Ocean palette with soft corners" width="720">

#### Global settings

`/admin/settings`, the **Global settings** tab. These apply to every recruit.

<img src="images/worker/admin-settings.png" alt="Global settings: email server, web search and AI model API keys" width="720">

- **Email server**: outgoing mail server (SMTP), port, username, password (for Gmail an
  [app password](api-keys.md#gmail-app-password)) and an optional sender address, used for
  everyone's reports. The password box stays empty; leave it empty to keep the saved one. Changing
  the server or username without a new password clears the old password, so it is never sent to a
  different server. **Send a test email** reports the result on the page after HermitShell's next check.
  **Use the server's own email settings instead** undoes the dashboard values. Where each person's reports
  go is set on their own page under **Recruits**.
- **Web search API keys**: one row each for Firecrawl, Tavily and Scrapfly, showing whether the key
  was set here or comes from `.env` and its start and end. **Add key** or **Change** opens a window
  (CSS only, no JavaScript) to pick the provider and paste the key; Firecrawl takes several keys,
  comma separated, used in turn. **Use the .env key** undoes a dashboard key. These keys are used for
  everyone: recruits no longer have keys of their own. [Where to get each key](api-keys.md).
- **Key usage**: a provider with a key shows how many credits are left, and pressing it opens its
  keys in the order they are tried (Firecrawl's main key, then its backups). Each key shows its start
  and end, a bar of what is left (green, amber under 40%, red under 15%), the plan, when the allowance
  resets and when it was checked, or why it couldn't be checked (a rejected key, for example).
  HermitShell asks each provider's own account endpoint (Firecrawl's credit usage, Tavily's usage,
  Scrapfly's account), which spends no search credits, at most every `WEB_KEY_USAGE_MINUTES`
  (60; `0` turns it off), and a failed check again after 15 minutes. It keeps the answers in
  `state/key_usage.json` under a hash of each key; the keys themselves never leave the server.
  `python3 key_usage.py` prints the same on the server.

<img src="images/worker/admin-settings-key-usage.png" alt="Global settings with Firecrawl opened: its main and backup keys, each with a bar of the credits left, its plan and when it resets" width="620">

<img src="images/worker/admin-global-key-modal.png" alt="The Add key window on Global settings: Firecrawl, Tavily or Scrapfly" width="380">

##### AI models

For servers that can't run a model themselves, the **AI model API keys** section adds cloud models
from OpenRouter, BazaarLink, Featherless or Hugging Face. It works like the web search keys: one
row per provider with its icon, **Add key** or **Change** opening a window to pick the provider,
paste the key and, optionally, a model (blank keeps the current one; each provider's free or cheap
default is listed), and **Use the .env key** to undo a dashboard key. A row with a key shows its
model, what is left (OpenRouter's free requests today or dollars of credit, BazaarLink's credits,
Featherless's plan, Hugging Face's account) and whether it is ready or resting, and opens to the
key's usage like the web search keys.

HermitShell asks the providers with a key in turn and uses the server model when none has a key or
credits left. A provider that runs out of credits or hits its daily limit rests until the next day
(UTC), a rejected key for six hours and a rate limit for as long as it asks. The **Server model** row
shows the model it runs, where it last ran and, when it differs, the model that suits the machine
([how it's picked](configuration.md#autofit-gpu-cpu-and-context-chosen-for-you)), tagged **set here**,
**from .env** or **fits this machine** for where the model comes from. **Cloud first**
or **Server first** sets which is asked first; with **Server first** the cloud is only used when
the server model (its own Ollama) doesn't answer. Cloud models are sent each recruit's CV and the adverts it is compared with,
and free models may keep what they are sent, which the [privacy notice](#privacy-notice) says.
[Where to get each key](api-keys.md#cloud-models).

<img src="images/worker/admin-settings-models.png" alt="The AI model API keys section: OpenRouter opened to its key's usage, BazaarLink, Featherless, Hugging Face, the server model and the order" width="720">

<img src="images/worker/admin-model-key-modal.png" alt="The AI model key window: pick the provider, paste the key and an optional model" width="420">

**Change** on the **Server model** row opens a window to switch away from the recommended model.
It lists Qwen3 30B-A3B, Qwen2.5 14B and 7B, Qwen2.5-Coder 7B, Llama 3.1 8B, the 4B default and
Qwen2.5 1.5B, plus any other model the server's Ollama already has, each with its download size,
whether it would run on the GPU or the CPU and how quick it would be on this machine, and tags for
**recommended**, **downloaded** and **in use**. A model too big for the machine's memory can't be
picked, and while Ollama is offline only models already downloaded can. **Default** goes back to
`.env`'s `OLLAMA_MODEL`, or the model that fits the machine; **Another Ollama model** takes any name
from the Ollama library (such as `mistral:7b`). `JOB_SCANNER_MODEL` in `.env` still wins over the pick, and the row says so.

<img src="images/worker/admin-model-picker.png" alt="The Server model window: the recommended Qwen2.5 14B, the downloaded and in-use 4B, the 30B that is too big for the machine, and other models with their size, where they run and how quick they are" width="560">

A model the server already has is used within seconds. Any other is downloaded first by
`model_pull.py` in the background, which checks there is room on the disk (the model plus 2 GB)
and switches to the model only once Ollama lists it. While it downloads, the admin dashboard shows
a notice with a progress bar, the gigabytes done and a link to **Tasks**, where the download is listed
as **Server model download** with a **Stop** button. When it is ready the notice turns green
(**is downloaded and is now the server model**) for a day; a failed download says why and links back
to the model settings. A failed or stopped download leaves the old model running. Managers and
recruiters see neither the notice nor the task.

<img src="images/worker/admin-dashboard-model-download.png" alt="The admin dashboard with a notice: Downloading the new server model, a progress bar at 47%, 4.1 of 8.6 GB, Follow it in Tasks" width="720">

<img src="images/worker/admin-tasks-model-download.png" alt="Tasks with Server model download: 4.1 of 8.6 GB, with Stop" width="560">

<img src="images/worker/admin-dashboard-model-ready.png" alt="The admin dashboard with a green notice: the new server model is downloaded and is now the server model" width="720">

##### Model tokens used

Below the model keys, **Model tokens used** shows what each task sent to the models and got back over
the last 7 days, for every recruit together: requests today and over the week (with any that failed),
tokens in and out, tokens a request and the average time a request took. A bar under each task shows its
share of the week's tokens, so the task worth trimming stands out; counts a provider didn't report are
estimated and marked **~**. It comes from HermitShell's status ([how it's counted](configuration.md#tokens-used))
and never holds a prompt, a reply or a key.

<img src="images/worker/admin-settings-usage.png" alt="Model tokens used: job ratings, title screening, second opinions, summaries, cover letters and tailored CVs, each with requests, tokens in and out, tokens a request and time" width="720">

Keys and passwords are stored on the HermitShell server (`state/dashboard.json`, mode 600) and shown only as their last four characters. Changes wait in KV and
are applied by `profiles.py`, within seconds over the live link. Until then a **Working on&hellip;** bar at the top
says what is pending (it is the only message: no **Saved** note beside it), the key or model being changed carries a **saving&hellip;** tag, a new model order
is shown picked, and the email server form shows what you saved rather than the old values. The page
updates itself every 4 seconds for the first 45, then every 20, and once HermitShell has applied the
change it shows it with **Done. The page shows the change.** After 5 minutes it stops and says HermitShell may be
offline, so an offline server doesn't use up KV's daily list operations. Where scripts run, the dashboard's
script fetches the page in the background and swaps in the new card, keeping what you are typing, open
windows and menus, focus and the scroll: it waits while a field has focus or has been typed in, while a
window is open and while the tab is hidden. The swap is immediate and skipped when nothing has changed. Without scripts a refresh tag reloads the page instead, keeping
you at the keys, models or email section. Entrance animations count as already played while it waits, and
looping ones (spinners, the circle on a letter or CV being made, the status dots, the background) keep
turning from where they were rather than starting over.
Passwords and keys typed into the page are deleted from KV after 2 days if HermitShell hasn't collected
them.

##### Features

On/off switches for optional features, each shown once HermitShell has the feature and reports it:
**Admin alerts by email** ([what they check](configuration.md#admin-alerts)) and **Automatic interview
prep packs** (off at first; see [Pipeline](#pipeline)). **Save features** queues
the change like the other settings; HermitShell writes only these switches to its settings and ignores
anything else in the request.

<img src="images/worker/admin-settings-features.png" alt="The Features section of Global settings with the Admin alerts by email switch on" width="620">

##### Demo mode

The **Demo mode** switch, at the foot of Global settings, fills every dashboard page with a made-up
recruitment desk instead of the real one, so HermitShell can be shown to someone without showing
anyone's data. It is a busy desk, to show HermitShell under load: 35 fictional recruits (active, paused,
several scanning at once, without a CV and waiting to be set up), two managers with their teams (one also
recruits), recruiters in and out of a team, sign-ups, invites, a full Tasks list (reports rating jobs,
letters, tailored CVs and prep packs waiting, the server model downloading), a cover letter to download,
months of stats, jobs sent and history, the Features switches, the server's model picker with a model
downloading, and backups on Cloudflare (a week of nightly copies and a month of weekly ones on
[Backups](#backups-on-cloudflare), each downloading as made-up bytes). The names are made up from the
same short list of first names and surnames, and every email address is at one of the reserved `example` domains. A manager or
recruiter signed in sees the desk as a made-up manager or recruiter like them (as the made-up account
with their username only when it has the same roles and isn't an admin), so they see a team or a pool
and never a page their own role can't open. Only admins can switch it, and it applies to everyone signed in until an admin turns it off, with the
switch (which says since when it has been on) or **Turn off** on the ribbon at the foot of each page,
which turns it off in one press and goes back to the real recruits. The switch is a plain form, so it works without scripts, and screen readers hear it as a switch
that is on or off.

<img src="images/worker/admin-settings-demo.png" alt="Global settings with the demo mode switch on: what it does and when it was turned on" width="720">

<img src="images/worker/admin-dashboard-demo.png" alt="The recruits list in demo mode: made-up recruits, recruiters and invites, and the demo mode ribbon" width="720">

<img src="images/worker/admin-users-demo.png" alt="Users in demo mode: two made-up managers with their teams, recruiters in and out of a team, and the admin" width="720">

<img src="images/worker/admin-tasks-demo.png" alt="Tasks in demo mode under load: several job reports at once, letters, a tailored CV and an interview prep pack waiting, and the server model downloading" width="720">

Every press works as it would, and a pretend HermitShell plays its part a few seconds later, on the
made-up data only: **Generate** on a cover letter or tailored CV shows **Being made&hellip;** and then a
made-up PDF to download, **Send** turns into **Emailed**, a missing skill goes from **adding** to
**added**, and pausing, resuming, assigning, deleting, **Send now** (a short pretend scan) and stopping
tasks show on the dashboard as HermitShell would apply them. **Save features** turns the switches,
picking a server model switches to it at once if it is downloaded or shows it downloading in Tasks
(where **Stop** leaves the model as it was) until it is ready, and **Back up now** adds a copy to the
backups on Cloudflare. What it did is kept for two hours in one
`demo:state` entry, cleared whenever the switch is turned on or off. Settings, keys, CVs and users can be
saved but are not kept past that page, nothing typed into them goes into `demo:state`, nothing is queued
and nothing reaches HermitShell. Changing your own password is still real. The Worker's API, the buttons
in emails, sign-up links and the privacy notice carry on with the real data, so daily reports keep
running while it is on.

<img src="images/worker/admin-stats-demo.png" alt="A made-up recruit's stats page in demo mode" width="620">

<img src="images/worker/admin-sent-demo.png" alt="A made-up job opened in demo mode: the cover letter asked for earlier made and ready to download, the Terraform skill added, and the tailored CV asked for just now being made" width="620">

#### A recruit's page

<img src="images/worker/admin-profile.png" alt="A recruit's settings page" width="720">

**Back to recruits** stays in the top-left corner while you scroll. The page has its own two tabs,
**Manage** (this page) and **History** (see [History](#history)); **Users and roles** and **Global
settings** are only on the dashboard. Each box has a short hint
under it. Details, job search and the daily report time are one form with one **Save changes**
button; **Send jobs now** and the CV's **Save CV** have their own.

- **Details**: name, the email address their reports go to, phone and home town (shown on cover
  letters, and where the distance below is measured from).
- **Job search**: up to 8 job titles, region or city (web searches use it, with the country as a
  filter), country (picked from a list by name; a two-letter code set by hand in `.env` that isn't in
  the list shows as its own option and is kept when the form is saved), the towns that count as local
  (comma separated), **Maximum distance from home town (km)** (in a straight line, up to 500; empty is no limit;
  town locations from GeoNames, CC BY 4.0: see
  [Distance from home](../packages/daily-vacancy-report/README.md#distance-from-home)), whether fully
  remote jobs elsewhere count, seniority,
  minimum salary (empty means no minimum; `45000`, `45k` and `£45,000` all work), the salary
  currency (a list: salaries in other currencies are converted to it, or As advertised),
  employment types, work location and whether to hide agency adverts that don't name the
  employer. Saving rebuilds the web search queries and the title filter when the titles or
  location change.
- **Daily report**: the time (in `HERMES_TIMEZONE`) and days (every day, or weekdays) HermitShell sends
  this recruit's report. HermitShell moves the recruit's scheduled job when it applies the
  save; until then the dashboard says the time is moving.
  A schedule set by hand with `scheduler.py edit` shows here too, and a cron expression that isn't a
  plain time leaves the box empty until you pick one.
- **Send jobs now**: see below.
- **CV**: upload a PDF, Word or text file, or paste it. HermitShell reads it, rebuilds the profile and
  skills the jobs are rated against, and emails a summary. Your previous `job_profile.md` and
  `cv_keywords.json` are kept as `.bak` copies.

**Their own CV.** Two buttons at the top right of the card download and make the recruit's CV as a PDF.
**Generate** asks HermitShell to lay out the CV they uploaded, every role included and not tailored to any
job; it spins as **Generating…** (the page checks again every 15 seconds) until the PDF is back, usually
within a few minutes. HermitShell uploads it to the Worker (`POST /api/cv`, with the API token) instead of
emailing it. **CV** only appears once one has been made, and downloads it as `CV - <name>.pdf`. The CV is
kept encrypted in KV with no expiry: pressing **Generate** again replaces it, and it is deleted when the
recruit unsubscribes or is deleted. A recruit with no uploaded CV has **Generate** greyed out.

<table><tr><th>Generate pressed</th><th>Made and kept</th></tr>
<tr><td><img src="images/worker/admin-profile-cv-making.png" alt="A recruit's page with Generating and a spinner at the top right while their CV is being made" width="360"></td>
<td><img src="images/worker/admin-profile-cv.png" alt="A recruit's page with a green CV download button beside Generate at the top right" width="360"></td></tr></table>

**Saving without losing anything.** The Worker can't reach your server, so a save waits in KV until
`profiles.py` collects it: a second or two after the live link tells it, or at its next poll
without the link. Meanwhile:

- The page shows what HermitShell last reported with every save still waiting laid over it, so the
  form keeps what you saved instead of jumping back to the old values.
- A small box at the top says **Saved. Taking effect in a few seconds**, then **Done. Your changes are in effect** (or
  **A change didn't work** and why). It reloads itself every 5 seconds for a minute, then every 20 seconds for
  3 more, then stops; each check lists the KV queue, which the free plan limits to 1,000 a day.
  The box needs no JavaScript: it is a small frame that only the dashboard itself can embed.
- Only the fields you changed are saved. Each form remembers the values it opened with, so if
  someone else (another admin tab, a CV rebuild) changed *other* fields in the meantime, both
  changes are kept. If they changed the *same* field, nothing is saved: the page comes back with
  your version still in the form and a list of each clashing field with both values. **Save
  changes** again keeps yours.
- A save with nothing changed says so and queues nothing. A bad email address, an empty name or a
  missing report time shows the page again with what you typed.

#### Send jobs now

**Send jobs now** on each recruit's page (**Send jobs** on the Recruits list) runs that recruit's report straight
away instead of waiting for its daily time. A second press for the same recruit within a minute (a double click
or a reload) is the same request, so the scan is not queued twice. HermitShell gets the request over the live link within
seconds and starts the scan in the background (`profiles.py report --now <id>`, logged to
`state/profiles/runs.log`), so other dashboard changes keep being applied while it runs. The email
arrives when the scan finishes, usually 10 to 20 minutes later, and it is sent even when nothing
new turned up (like `JOB_SCANNER_EMAIL_WHEN_EMPTY=1`), so you know it ran. Jobs already sent in an
earlier report aren't repeated. It works for a paused recruit too, as a one-off.

<img src="images/worker/admin-profile-scanning.png" alt="A recruit's page while their report is running" width="720">

While any report is running, daily or sent now, the dashboard row shows **finding jobs now**, the
button becomes **Finding jobs…**, and the recruit's page status box says when the search started,
checking every 30 seconds (from HermitShell's status report only, with no KV listing) for up to 40
minutes. A second press while a scan is running does nothing. A recruit without a CV has no button;
HermitShell refuses the request and says so under **HermitShell could not apply**.

#### Several recruits at once

Each row on the Recruits list has a tick box. Ticking one or more brings up a bar under the list with how
many are ticked and **Pause**, **Resume**, **Send jobs now**, for admins a recruiter list with
**Assign**, and at the end a red **Retire** button, which opens a window to confirm (see
[Retiring a recruit](#retiring-a-recruit)). The tick boxes belong to the bar's form, so it works without
scripts; browsers without `:has` show the bar all the time.

<img src="images/worker/admin-dashboard-bulk.png" alt="Two recruits ticked and the bar under the list" width="620">

- Up to 25 recruits at a time. The Worker checks each one as the single button would: a recruiter only
  changes their own recruits and cannot assign, and the main admin's row is never one. Anyone else is
  skipped, as is anyone retired, already paused or active as asked, already that recruiter's, or asked for
  jobs in the last minute. The note afterwards says how many were done and how many skipped.
- The batch is one queue item (`action: "bulk"`, the operation and the recruit ids), so it costs one queue
  write; each recruit gets their own history line. KV writes: up to 2 + 2 per recruit (the queue item and
  flag, then each history line and, for **Send jobs now**, the one-minute repeat guard).
- HermitShell applies it per recruit with the same checks as the single action. **Send jobs now** runs
  their reports one after another in one background process (`profiles.py report --now <id> <id>...`),
  not all at once. Recruits it could not change are listed under **HermitShell could not apply**.
- Until it is applied the batch shows as that change on each recruit's row, and as a task per recruit;
  cancelling one of those tasks cancels the whole batch.

#### Notes and tags

The **Notes** box on a recruit's page keeps notes and tags for you and the other recruiters. A note is up
to 1,000 characters (the newest 100 are kept) and shows who wrote it and when; its writer and admins can
delete it. Tags are up to 8 per recruit, each up to 20 letters, numbers, spaces or dashes, separated by
commas. They show as pills beside the recruit's name on the Recruits list; pressing one lists only the
recruits with that tag (`/admin?tag=<tag>`), and the search finds tags too.

<img src="images/worker/admin-profile-notes.png" alt="The Notes box on a recruit's page: tags, a note being added and two earlier notes" width="620">

Notes stay on the Worker and never reach HermitShell or the recruit. Each recruit's notes and tags are
one KV value (`notes:<id>`) and every recruit's tags one index (`tags`, so the list costs one read), both
encrypted with a key derived from `JOB_FEEDBACK_SECRET` and bound to their KV key, like kept documents.
Recruiters see and change only their own pool's; the history records **Added a note** or **Changed their
tags**, never the text. A save costs one KV write, plus one for the index when the tags change and one for
the history. Unsubscribing or deleting the recruit deletes them. If two people change tags at the same
moment, opening the recruit's page puts their tags back into the index.

#### History

The **History** tab on a recruit's page (`/admin/history?u=<id>`, also linked from their Stats and
Jobs sent pages) is a timeline of everything done on their account, newest first and grouped by day.
Each entry says who did it: an admin or recruiter by name, the recruit **from an email button**, or
**HermitShell**. It records:

- saves on their page (which fields changed: details, job search or report time), CV uploads and pasted CVs;
- **Send jobs now**, pausing and resuming, assigning or unassigning a recruiter (also when their
  recruiter's account is deleted);
- cover letters and tailored CVs asked for or emailed, jobs emailed to them and skills added from the
  Jobs sent list; while the letter or CV is still kept for download (`COVER_LETTER_KEEP_DAYS`, 7 days
  by default) its entry has a green **Download** button, for the newest one made for that job;
- tasks stopped or cancelled from the Tasks window;
- every email button they press (Interested, Applied, a cover letter and so on), once, even if they
  press Confirm again; their notes are never copied in;
- from HermitShell's status reports: each job report that ran and each time it read a new CV.

<img src="images/worker/admin-history.png" alt="A recruit's History tab: a timeline of reports, changes by their recruiter and email answers, grouped by day, with a Download button on a tailored CV still kept" width="720">

Entries are kept in KV by month (`history:<id>:YYYY-MM`, at most 1,000 a month); the pills at the
top switch months and the oldest ends with the day they joined. Recruiters see only their own
recruits' history. Nothing expires while the recruit is subscribed: their history is deleted with
the rest of their data when they unsubscribe or are deleted from the dashboard. Yours is kept. A
failed history write never stops the action itself.

#### Pipeline

The **Pipeline** tab on a recruit's page (`/admin/pipeline?u=<id>`, also linked from their Stats and
Jobs sent pages) shows where each application stands, in six columns: **Interested** (with Good
match), **Applied** (with Heard back), **Interview**, **Offer**, **Placed** and **Rejected**. Jobs
marked Not for me are left off. Each card has the job's title, employer and the day it reached that
stage, and a **Move to** menu.

<img src="images/worker/admin-pipeline.png" alt="A recruit's Pipeline: columns for Interested, Applied, Interview, Offer, Placed and Rejected, each card with a Move to menu" width="720">

- **Moving a job** (`POST /admin/stage`, CSRF-checked) stores the move as the matching email answer
  would be, so HermitShell collects it at its next sync, within about 5 minutes, and sends that
  recruit's stats again straight away, so the board shows it soon after; the page says so. The same move for the same job in the same
  minute is one event, so a double click does nothing extra. Each move is written in the
  [history](#history), for example **Moved to Interview: Data Engineer at Northwind**.
- **Start date and fee** (admins, and managers for their team) go with an **Offer** or **Placed** move. The start date must
  be within two years, the fee a number from 0 to 1,000,000 with at most two decimals, and the
  currency one of the profile currencies. The fee is sealed for HermitShell before it is stored, the
  same way as API keys, so KV only holds ciphertext until HermitShell collects it. Recruiters don't get
  the fields, and a recruiter's form that sends a fee is refused with 403. Without HermitShell's sealing
  key yet, the fee is not saved and the page says why.
- **Email buttons**: follow-up emails gain **Got an interview** beside Heard back and Rejected, and
  **Offer** is a valid email answer too. **Placed** is only set here.
- **Reminders** follow the stage: once a job reaches Interview, or any later answer, the "did you hear
  back" reminders stop.
- **Interview prep**: cards at **Interview** and **Offer** have an **Interview prep** button that asks
  for the job's [prep pack](#jobs-sent), then show **Prep pack being made** and, once it is kept, a
  green **Prep pack** download. With **Automatic interview prep packs** switched on (Global settings,
  Features, or `INTERVIEW_PREP_AUTO=1`), HermitShell makes one by itself when a job reaches Interview
  in the last two days: one per job, ever, and none if one was already asked for.

The board comes from the recruit's tracker: `profile_stats.py` lists each job's latest answer from the
last 365 days, up to 200 jobs, with its title and employer only, never notes or fees. It travels with the
jobs sent and is kept in the same KV value (`sent:<id>`, now `{jobs, board}`; one written by an older
Worker as a bare list still reads), so it costs no extra KV writes. A move costs one event write and one
history write. HermitShell only sends the board, and the Interview button, once the Worker reports
protocol 3 or later (`X-HermitShell-Protocol`), so updating one side before the other is safe.
Recruiters see and move only their own pool's jobs. Fees stay in the tracker on your server (plain
SQLite, readable only by its user, like salaries and answers); neither the board nor the stats bring
them back to the Worker. Only their totals do, sealed, for the [desk](#desk).

#### Desk

The **Desk** tab (`/admin/desk`) is the whole desk on one page for the last **7 days**, **30 days**,
**90 days** or **12 months**, laid out so a big desk stays easy to read:

- **The funnel**: jobs sent, applied, interviews, offers and placed, each with how many of the stage
  before got that far (**4.4% of sent**, **30% of applied** and so on), and for admins and managers the
  fees from placements, summed per currency.
- **Teams** (admins, once there is a manager): a card per manager's team, in its own colour, with how
  many recruiters and recruits it has, its interviews, offers and placements and its fees, and
  **No team** for recruiters outside one. Pressing a card shows only that team on the whole page
  (`?team=`); **Show every team** goes back.
- **Recruiters** (admins and managers): one line per recruiter, ranked by placements (then offers,
  interviews, applied and sent), with their initials in their team's colour, a team tag, how many
  recruits they have and each count. The top three get gold, silver and bronze ranks and the best
  figure in each column is green. Pressing a column heading ranks by it (`?sort=`), and recruiters with
  no recruits yet still show, at the bottom. Recruits without a recruiter come last, unranked.
- **Recruits by recruiter**: a group per recruiter, whose heading keeps their interviews, offers,
  placements and fees in view and says how many recruits had no activity. Past three recruiters the
  groups start folded; pressing a recruiter in the ranking opens theirs (`?rec=`). Inside, recruits
  come furthest along first, each tagged with the furthest stage a job reached (**Placed**, **Offer**,
  **Interviewing**, **Applied**, **Jobs sent**, **No activity** or **No data yet**), and quiet ones are
  greyed. Each name opens the recruit's page, and **Jobs sent** their list.
- **Salaries by job title across the desk**: the median of each advert's lowest yearly figure over the
  last 90 days, across every recruit's jobs rated, in each recruit's own currency, for titles with at
  least 3 salaries.

<img src="images/worker/admin-desk.png" alt="The Desk page: the funnel with conversion rates, the recruiters ranked and each recruiter's recruits with their furthest stage, and the salaries by job title" width="720">

In demo mode the desk carries 35 recruits across two managers' teams and the recruiters outside them,
which is what it looks like at scale, and with one team picked and a recruiter opened:

<img src="images/worker/admin-desk-demo.png" alt="The desk under load: the funnel, three team cards, nine recruiters ranked with team tags and medals, and folded groups per recruiter" width="720">

<img src="images/worker/admin-desk-demo-team.png" alt="One team on its own: its recruiters ranked and a recruiter opened, with each recruit's furthest stage" width="720">

- **Counting**: Sent counts the jobs emailed in the period; Applied to Placed count each job once if it
  reached that stage in the period, however often it was moved (a job that went from Applied to Placed
  counts in each).
  Fees come only from **Placed** moves.
- **Managers** see their team's recruits, with their recruiters ranked and the fees, but no team cards
  (`?team=` is ignored for them); the page says **Your team's recruits, grouped by recruiter.**
- **Recruiters** get the tab too: the funnel and their own recruits, open, with no ranking, teams, fees
  column or fees tile; the page says **Your recruits only.**
- `?team=`, `?sort=` and `?rec=` only pick from the teams, columns and recruiters on the page; anything
  else is ignored and never shown back.
- **Where it comes from**: `profiles.py` adds up every recruit's tracker (`profile_stats.desk`) and
  sends the result (`POST /api/desk`) at most every 30 minutes and only when it has changed, so a
  quiet desk costs no KV writes. The Worker seals it before it is stored (`stats:desk`, like API keys),
  checks its shape and size (300 KB) first, and draws the page from it. Until the first upload the page
  says HermitShell sends the desk within 30 minutes.

HermitShell only sends the desk, and the [Also suits](#jobs-sent) list, once the Worker reports
protocol 4 or later. Until you redeploy the Worker, `doctor.py` and the Global settings page warn that
it is older than HermitShell; nothing else changes.

<table><tr><th>A recruiter's desk</th><th>A manager's desk</th></tr>
<tr><td><img src="images/worker/admin-desk-recruiter.png" alt="A recruiter's desk with only their recruits and no fees" width="480"></td>
<td><img src="images/worker/admin-desk-manager.png" alt="A manager's desk: their team's recruiters and recruits, with fees" width="480"></td></tr></table>

#### Tasks

The **Tasks** button next to the search (admins only) shows a loading circle while something is running
and, in its corner, how many tasks there are. It opens a window listing everything HermitShell is doing or has
waiting, whoever started it. Each running task has the same circle round its icon, and it keeps
turning smoothly as the list refreshes. While this or any other window is open, the dashboard behind it
is dimmed (not blurred) and stops animating, so the window stays smooth however busy the page is. Where
scripts run, the button's count follows the list each time it refreshes, so it clears as soon as the last
task finishes rather than on the next page load:

<img src="images/worker/admin-tasks.png" alt="The Tasks window with a running report, a cover letter being written and requests waiting" width="720">

- **Running**: daily reports and reports sent now, with their stage and, while jobs are rated, how
  many of how many (`job_scanner.py` reports its progress to `profiles.py`, which pushes it with the
  status about once a minute), and the cover letter or tailored CV being written.
- **Waiting**: cover letter and tailored CV requests queued on the server, email-button requests
  the Worker is holding until HermitShell collects them (kept in KV as `tasks:requests`, removed when
  acknowledged), and dashboard changes, sign-ups and resume requests in the queue.
- Each row says where it came from: scheduled, from the dashboard, an email button, the sign-up form
  or an unsubscribe link.

**Stop** or **Cancel** on a row (`POST /admin/tasks`, CSRF-checked):

- A queued change or held request is deleted from KV straight away.
- A running report, or a request already on the server, is queued as a `cancel` for HermitShell. It
  checks the task id and the profile, then stops the report's scan (its whole process group, only
  if it is still running `job_scanner.py`) and records no report for that day, or marks the request
  cancelled in the tracker (`letters.status = 'cancelled'`) and stops its writer. The row shows
  **Stopping…** meanwhile.
- Answers to the email buttons are not tasks and can't be removed here.

Each cancel is written in that recruit's [history](#history) with who pressed it, for example
**Cancelled the tailored CV: Data Engineer at Northwind** or **Stopped the job report**. A
cancelled global settings change or sign-up belongs to no recruit, so it is not kept.

Recruiters don't get the button or the window, and `/admin/tasks` answers them with 403; their waiting
changes still show, as the **Working on&hellip;** bar for a press on the dashboard and as **Waiting for
HermitShell: N changes** in the status line for the rest.

The window has no JavaScript: its list is a frame (`/admin/tasks`, only embeddable by the dashboard)
that reloads every 5 seconds for 2 minutes, then every 15 seconds for 9 more, then stops; with
nothing running, every 20 seconds for 10 minutes. Reopen the window to start again.

#### Stats

Each dashboard row shows a small line of the jobs sent each day this week and how many. The line
opens `/admin/stats` (the recruit's page has a **View stats** link too), one page of KPIs and charts
for that recruit over the last **7 days**, **30 days**, **90 days** or **12 months**. The number
opens the [jobs sent](#jobs-sent).

<img src="images/worker/admin-stats.png" alt="A recruit's stats page: KPI tiles, activity chart, funnel, answers, match scores, applications and top lists" width="720">

- **Tiles**: postings scanned, jobs rated, jobs sent, average match of the jobs sent (out of 10),
  liked (Interested or Good match), applied, interviews, and cover letters plus tailored CVs asked
  for. Each has a line of the period and, when there is data for the period before, the change
  against it (not for 12 months, since older data is pruned after a year).
- **Chips**: strong matches (8 and over), scans, the best day, week or month, the median salary of the
  jobs sent, and "not for me" presses.
- **Activity**: jobs rated and sent per day (per week for 90 days, per month for 12 months), with a
  green dot where applications were made. Hover a bar for its numbers.
- **Funnel** from scanned through applied to interview and placed, with the share kept at each step;
  **Answers**, a ring of the buttons pressed and the Pipeline moves; **Match scores**, how the jobs
  rated scored from 0 to 10.
- **Where applications stand**: every job's latest answer, whatever the period: waiting (applied),
  heard back, interview, offer, placed and rejected, with the reply rate (any answer after applying).
- **Top employers**, **Top sources** (with the split between hybrid, remote and on-site) and the
  **best matches sent**, each with a ring of its score.
- **Salaries by job title**: the median of each advert's lowest yearly figure for the commonest job
  titles among the jobs rated in the period (up to 8), each shown once 3 jobs with that title give a
  salary. Titles are matched without brackets or anything after a dash, so "Data Engineer (Python)"
  and "Data Engineer - Remote" count together, but seniority is kept. The weekly summary email's
  **Who is hiring** card carries the top 3 as **Typical salaries this week**.

Scores share one colour scale on every chart and list: green from 8, amber from 6, orange at 5 and grey
below. Rings sweep in as the page opens and scores of 8 and over glow twice, then hold a soft, steady
glow while their row is hovered; the motion stops if the browser asks for reduced motion.

<table><tr><th>90 days</th><th>Someone who joined last week</th></tr>
<tr><td><img src="images/worker/admin-stats-90-days.png" alt="The stats page for 90 days" width="360"></td>
<td><img src="images/worker/admin-stats-new-profile.png" alt="The stats page of a recruit who is a few days old" width="360"></td></tr></table>

The numbers come from the recruit's tracker (`job_tracker.db`) on your server:
`profile_stats.py` counts each day in `HERMES_TIMEZONE` and `profiles.py` sends the result to the
Worker (`POST /api/stats`, kept in KV as `stats:<id>`) when it has changed, at most every 30
minutes per recruit, and straight after each report. Notes typed on the buttons' pages and the
listing text are never sent. For the [jobs sent](#jobs-sent) list, each job sent in the last 90 days
also carries its title, employer, place, work mode, salary, score, source, advert link, last answer
and the details its email card showed (kept apart as `sent:<id>` so the stats page stays quick,
together with the [Pipeline](#pipeline) board).
Email addresses, phone numbers and the recruit's name and email are removed from that text first.
A deleted recruit's stats are removed with them. The page is drawn on the Worker as plain SVG and CSS,
without JavaScript, and its icons and charts animate in unless your system asks for reduced motion.
`python3 profile_stats.py state/profiles/<id>/state/job_tracker.db` prints a recruit's counts on the server
(each one today, over 7 days and over every day kept, the Pipeline and how many jobs were sent), never job titles,
employers, links or salaries.

#### Jobs sent

The **24 sent** half of a dashboard row's button, and **Jobs sent** on the stats page, open
`/admin/sent`: the jobs in that recruit's reports, newest first and grouped by day, for the last
**7 days**, **30 days** or **90 days** (up to 150 jobs). Each shows its match score, title (a link to
the advert, opened in a new tab), employer, place, work mode, salary, source and the last button
pressed. Filters above the list show **All**, **No answer yet** or one answer (**Applied**,
**Heard back**…), with a count for each.

<img src="images/worker/admin-sent.png" alt="The jobs sent to a recruit this week, grouped by day" width="720">

Click a job to open its full card, like the one in the email: the advertiser if an agency posted
it, contract type, seniority, when it was posted and closes, the score's confidence and CV keyword
match, why it was rated a fit, what the role and company are, the skills matched and missing, and
links to the advert and the employer's site. Each amber **Missing from the CV** skill is a button:
press one the recruit has and it is stored as the email's **Add to my skills** answer, so it joins
their skills pool at HermitShell's next sync and counts as on the CV from then on (see
[Adding missing skills](#adding-missing-skills)). It then shows as added (dashed, with a tick) until
HermitShell collects it and sends that recruit's stats again (within about 5 minutes), listing it with a solid tick. Admins can do this for
any recruit, a recruiter only for their own pool.

**Also suits** lists up to 5 other recruits the same job was rated a fit for in the last 90 days (at
or above each one's own `JOB_SCANNER_MIN_SCORE`), best first, each with their score and a link to
their jobs sent. HermitShell works it out from the trackers on your server, rereading one only when it
has changed, and sends only profile ids and scores. The Worker shows only the recruits the viewer can
see, so a recruiter never learns of a recruit outside their pool, and the recruit themselves never
appears. Below that are the document tiles. For a **Cover
letter**, a **Tailored CV** and, once the recruit has answered **I applied** or anything after it, an
**Interview prep** pack:

- **Generate** asks HermitShell for one. It is made within 5 minutes (a loading circle shows
  meanwhile, and the page refreshes itself every 15 seconds until it is ready) and is **not**
  emailed; it waits here for download.
- **Download** appears once one has been made for that job in the last `COVER_LETTER_KEEP_DAYS`
  days (7 by default), from here or from an email button. With **Word copies of letters and CVs** on
  (Global settings, Features, or `DOC_WORD_COPIES=1`), it opens a menu of **PDF** and **Word**: the same
  document as a `.docx` to edit, which is also attached to its email. The history's Download has a
  **Word** button beside it, and the email button's page a **Word** link.
- **Email to Sam** (the recruit's first name) sits beside **Download** and has HermitShell
  email the one kept to that recruit, as an email button would: the same PDF, with no model used
  (a new one is written only if the file has gone from your server). The tile says
  **Emailing to Sam…** until it has gone. The request carries `send: 1`, which HermitShell's tracker
  keeps as the `send` flag in place of the download-only `quiet`.
- **Regenerate** writes a new one, replacing the one kept.
- **Options**, beside **Generate** and **Regenerate**, opens the cover letter's **Length** and **Tone**
  and, for either document, **Anything to stress?**: an optional note of up to 300 characters, as the
  email button's page asks. The request carries the length and tone as `len` and `tone` (only the listed
  values; the defaults aren't sent) and the note as `r`, with control characters but line breaks made
  spaces. A note always gets a new one written. HermitShell puts it in the model's prompt only in its own
  labelled "candidate's note" block, to follow where it fits the CV, never among the instructions. The
  history says, for example, "Asked for a cover letter (short, warm, with a note)", never the note itself,
  and the task list doesn't keep it. **Email to Sam** sends the kept one, so it takes no note.

<img src="images/worker/admin-sent-letter-options.png" alt="The cover letter's Options open on an opened job, with Length, Tone and a note" width="460">

**Word copies** are written on your server by `letter_docx.py` with the standard library only, laid out as
the PDF is. Every piece of text is XML-escaped with the characters XML can't hold removed, and the file has
fixed part names and no fields, macros or links to anything outside it. HermitShell sends the PDF and its
Word copy to the Worker in one upload, kept as one encrypted value, so a document still costs two KV writes.
The Worker checks the Word part by its zip directory alone (it must name `word/document.xml` and no macros)
and never unpacks it, and serves it as an attachment with the Word type, `nosniff` and a sandboxing CSP. The
upload is at most 4 MB, with the PDF at most 2 MB as before. HermitShell only sends Word copies once the
Worker reports protocol 5; an older Worker keeps getting the PDF alone. Switch the feature on after opening
one copy in Word or LibreOffice.

<img src="images/worker/admin-sent-download.png" alt="A kept cover letter's Download open, offering the PDF or the Word copy" width="460">

An **interview prep pack** is a PDF in four parts: facts about the employer, taken only from the advert
(HermitShell looks nothing up on the web); the eight questions they are most likely to ask, each with why;
answers to some of them in situation, task, action and result form, built only from the job's evidence
map of the CV (with no evidence map there are no answers, rather than made-up ones); and questions to ask
them. HermitShell checks it as it checks letters (figures the CV and advert don't state, placeholders,
stock phrases) and rewrites it once if it fails. If it still fails, it is sent with a "Check before use"
line at the top rather than dropped. It is emailed to the recruit and kept for download like a letter,
and it also counts under its own task in **Tokens used**.

The last tile, **Email to Sam**, sends the job itself to that
recruit's address: **Send** asks HermitShell, which emails it within 5 minutes as the card it had in
the daily report, with its buttons (applied, cover letter, tailored CV and the rest) signed for that
profile. No model is used. A loading circle shows while it goes, then **Emailed to Sam** with when,
and **Send again**. The Worker keeps only when each job was emailed, under a hash of its key
(`emailed:<profile>`, the last 300 jobs, 90 days), and forgets it with the recruit. This can only be
asked for from the signed-in dashboard, never from an email link
([the email](images/emails/job-email.png)).

<img src="images/worker/admin-sent-open.png" alt="A job on the jobs sent list opened to its full details, with Download, Email and Regenerate for the cover letter, the CV being made and Send to email the job to the recruit" width="620">

Only `http` and `https` advert and company links are kept, both on your server and again on the
Worker, and they open with `rel="noopener noreferrer"`.

Every control is described in [screenshots.md](screenshots.md#recruits).

Sign-in: five wrong passwords lock that address (an IPv6 /64 counts as one address) out for 15
minutes, and 30 wrong passwords from anywhere lock sign-in for everyone for 15 minutes. The
failures are counted in the link's Durable Object (`Hub`), so wrong passwords don't use up KV's
1,000 writes a day; a Worker without the `HUB` binding counts them in KV. If the count can't be
read or recorded, sign-in is refused rather than allowed. Sessions last 12 hours in a `__Host-`
HttpOnly, SameSite=Strict cookie and every form carries a CSRF token. **Sign out** ends every
session, and so does changing `ADMIN_PASSWORD`.

#### Recommended: Cloudflare Access in front of /admin

[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) (part of
Zero Trust, free for up to 50 users) can require an emailed one-time code before `/admin` even
shows the password form. The Worker then checks Access' signed token on every admin request.

1. In the Cloudflare dashboard open **Zero Trust**. The first time, pick a team name (this is your
   `<team>.cloudflareaccess.com` domain) and the **Free** plan; a card is asked for but not charged.
2. **Settings -> Authentication**: make sure **One-time PIN** is enabled.
3. **Access -> Applications -> Add an application -> Self-hosted**. Name it, add the domain
   `vacancy-feedback.<subdomain>.workers.dev` with the path `admin`, and add a policy **Allow**
   with **Include -> Emails** set to your own address.
4. Copy the application's **Application Audience (AUD) Tag**, then give the Worker both values:

   ```sh
   echo '<aud-tag>' | npx wrangler secret put ACCESS_AUD --config wrangler.local.jsonc
   echo '<team>.cloudflareaccess.com' | npx wrangler secret put ACCESS_TEAM_DOMAIN --config wrangler.local.jsonc
   ```

With `ACCESS_AUD` set, `/admin` answers 403 to any request without a valid Access token for that
audience, even if the password is right. Buttons, `/join` invites and the HermitShell API are not
behind Access and keep working.

From the server:

```sh
python3 profiles.py --list
python3 profiles.py --pause <id>     # or --resume, --delete
```

### Unsubscribe

Every daily report and weekly roll-up ends with an **Unsubscribe** link (signed like the buttons,
with a confirmation page). For a recruit the Worker drops their answers still waiting in
KV and their [history](#history) straight away, and the next `profiles.py` run deletes the profile, CV, tracker and letters,
replaces their name and email address with `[deleted]` in the logs, emails them a confirmation and
tells you (without their address). The unsubscribe link in a report you received before your own job
search moved to a recruit only pauses that recruit (the others keep running) until you resume it from
`/admin` or with `profiles.py --resume <id>`.

### Retiring a recruit

When a recruit has found work or stopped looking, retire them instead of deleting them: their reports
stop, and they choose by email whether HermitShell keeps their profile for when they look again.

- **Where:** the red **Retire** button on the [bulk bar](#several-recruits-at-once) for the ticked recruits,
  or **Retire** at the bottom of a recruit's page (after Manage's CV box). Both open a window where you tick
  the box and press **Retire**; without the tick nothing happens. Admins, managers and recruiters can retire
  the recruits they can see, never the main admin. The history notes who did it.

<img src="images/worker/admin-dashboard-bulk-retire.png" alt="Two recruits ticked and the confirm window for retiring them" width="620">

<img src="images/worker/admin-profile-retire.png" alt="The Retire section at the bottom of a recruit's page" width="620">

- **What happens:** HermitShell sets them to **retired** (their daily job is paused, they can't sign in to
  `/me`, and **Send jobs** and bulk changes skip them) and emails them a signed link (the action `retire`,
  working for 90 days like the other buttons). They are left out of the Recruits list; **N retired** beside the
  count, or **Retired** in the status dropdown, lists them with when they were retired and until when their
  data is kept.
- **Their choice:** the link opens a page with **Keep it for 6 months**, **12 months** or **24 months**, or
  **Delete everything now**. Nothing changes until they press **Confirm my choice**. A keep choice is queued
  as `retire_choice` and HermitShell emails them the date; they can use the link again to change it.
  Deleting drops what the Worker keeps of them at once and HermitShell deletes the rest within minutes.
  A link from before the latest retirement, or used after they were reactivated, changes nothing.
- **No answer:** the profile is kept for `HERMES_RETIRE_KEEP_MONTHS` (6 by default), then the nightly
  maintenance run deletes it and emails them.
- **Deleting, backups included:** their folder, their traces in the logs, everything the Worker keeps of
  them (`POST /api/forget` with the API token, refused for the main admin), and their copies in every
  backup, on the server and on [Cloudflare](#backups-on-cloudflare): each archive is rewritten without them
  and the copy on Cloudflare replaced (see [Data protection](configuration.md#data-protection)). You get an
  email saying it is done, without their address.
- **Bringing them back:** **Reactivate** at the bottom of their page (where **Retire** was) starts their
  reports again and clears the keep date.

<img src="images/worker/confirm-retire.png" alt="The retired recruit's page: keep for 6, 12 or 24 months or delete everything now" width="300">

### Recruits' own page

With the **Recruits' own page** switch under Features on Global settings (`HERMES_SELF_SERVICE=1`, off by
default; it needs Worker and HermitShell protocol 6), each active recruit can sign in at `/me` with a link
emailed to the address their reports go to. While it is off, every `/me` address is a 404.

- **Finding it:** while the switch is on, a recruit's daily report, weekly roll-up and welcome email end with
  a **Your page** link beside Unsubscribe. It is the plain `<JOB_FEEDBACK_URL>/me` address with nothing
  added, so a forwarded email signs nobody in: the page still asks for the address and emails a sign-in
  link. The main admin's own reports never show it, and nor does any email while the switch is off or
  `JOB_FEEDBACK_URL` is not https.
- **Asking for a link:** `/me` asks for the email address. Requests are counted in the hub (5 a minute per
  address range, an IPv6 /64 counting as one; 3 an hour per address, kept as a hash; 50 an hour in total)
  before anything is written to KV, so refused requests cost nothing from the 1,000 writes a day. Every
  address gets the same answer, and the matching happens after it is sent. Only an active recruit's address
  gets a link: never the main admin, a paused recruit or a stranger. Without the hub (or with its allowance
  used up) the page says links are unavailable and nothing is made: a token is never kept in KV, where a
  deleted key can still be read elsewhere for a minute or more.
- **The link:** 32 random bytes. The hub keeps only its SHA-256, for 15 minutes; the token reaches HermitShell
  sealed in a `login_link` queue item, and `profiles.py` emails `<JOB_FEEDBACK_URL>/me/login?t=…`, built
  from its own setting, never from the request, to the address on the recruit's profile, at most one every 5
  minutes per recruit. Opening it only shows a **Sign in** button (mail scanners open links); pressing it
  spends the token in one SQLite statement, so it works once even when two presses race.
- **The session:** a `__Host-hv_me` cookie (`Secure`, `HttpOnly`, `SameSite=Strict`, 7 days), signed under
  its own label with the recruit's epoch. **Sign out everywhere** moves the epoch on, which every other
  session notices within about a minute. Pausing or deleting the recruit ends it. A recruit's session never
  opens `/admin`, and an admin's never opens `/me`: separate cookies, signing labels and form tokens.
- **The pages:** **My jobs** (the jobs sent in their recent reports with fit, answer and link), **My job
  search** (the job search and daily report boxes of their profile page; a save carrying any other field,
  such as their name or email address, is refused whole, and HermitShell refuses a recruit's own change that
  touches their details or arrives while the switch is off), **My documents** (letters, tailored CVs and prep
  packs kept for them, with Word copies when kept, and their own CV with **Make my CV**), **Sign out** and
  **Unsubscribe** (with a tick box). Their changes show in the [history](#history) as made on their own page.
  Notes, tags, fees and other recruits are never shown.

Notes about a recruit are their personal data on a subject access request even though `/me` never shows them:
admins have **Export these notes** under Notes on a recruit's page, a text file of the notes and tags.

<img src="images/worker/me-jobs.png" alt="A recruit's own page: My jobs" width="560">

### Backups on Cloudflare

A backup on the same machine as HermitShell is lost with that machine. From Worker and HermitShell
protocol 7, each nightly backup (and each **Back up now**) is also sent to the Worker, so a copy lives on
Cloudflare. The copy on the server stays too.

- **What is sent:** the same encrypted archive written to `HERMES_BACKUP_DIR`, byte for byte. HermitShell
  encrypts it with `HERMES_DATA_KEY` before it leaves the server and only sends encrypted backups, so
  neither Cloudflare nor anyone who gets into the Worker can open one. Without `HERMES_DATA_KEY` set,
  nothing is sent and the server panel says so.
- **How:** in 1 MB parts over the signed API (`POST /api/backup/part`, with each part's place, the number
  of parts and the archive's SHA-256), into the hub Durable Object's SQLite storage, in an instance of
  its own (`backups`) so the sign-in and rate-limit data never share it. The Worker refuses anything that
  isn't a HermitShell backup name or doesn't start like an encrypted archive, and a backup only counts
  once every part has arrived; an upload left unfinished for a day is removed.
- **How many:** HermitShell keeps the 7 newest plus the newest of each of the 4 weeks before
  (`HERMES_BACKUP_OFFSITE_KEEP_DAILY` / `_KEEP_WEEKLY`) and deletes the rest after each upload. The Worker
  also holds at most 40 backups and 1 GB, well inside the free plan's 5 GB.
- **When it fails:** the backup on the server is still made. The server panel says sending the last one
  failed and an [admin alert](configuration.md#admin-alerts) is emailed; the next backup tries again.
  Turn it off with `HERMES_BACKUP_OFFSITE=0`.
- **Downloading one:** **Download** in the server panel opens **Backups on Cloudflare** (`/admin/backups`,
  admins only), which lists each copy with its date and size. Managers and recruiters are refused.

<img src="images/worker/admin-backups.png" alt="Backups on Cloudflare: nine encrypted backups, each with its date, file name, size and a Download link, then how to restore one after losing the server" width="380">

**Restoring after losing the server.** Install HermitShell on the new machine, put the same
`HERMES_DATA_KEY` in its `.env`, download a backup into its data folder (for example
`/opt/hermitshell/data`, which is `/data` in the container), then unpack it into an empty folder and copy
back what you need:

```sh
docker exec hermitshell python3 maintenance.py --restore /data/hermitshell-20261002-031500.tar.gz.enc --to /data/restore
```

(without Docker, run `python3 maintenance.py --restore FILE --to DIR` in the scripts folder). A server that
still has its `.env` can list and fetch the copies itself: `python3 maintenance.py --list-offsite`, then
`--fetch NAME` (add `--out PATH` to choose where it goes; the SHA-256 is checked). Without that key no one
can open the backups, so keep a copy of it away from the server, in a password manager.

### Privacy notice

The Worker serves `/privacy`: what is kept about the people you invite, where, for how long, how
it is protected and how to have it deleted. The sign-up form, the welcome email and the
unsubscribe page link to it. It is the same text as [PRIVACY.md](../PRIVACY.md); if you change how
you run HermitShell (for example turn encryption off or change the retention days), edit both
`src/privacy.js` and that file.

<img src="images/worker/confirm-unsubscribe.png" alt="Unsubscribe confirmation" width="300">

### Free-plan limits

Workers KV's free plan allows 1,000 list operations, 1,000 writes and 100,000 reads a day, and
Workers 100,000 requests. Polling (`/events` every 5 minutes for cover letters, `/api/queue` for
profiles) reads a small flag key instead of listing, and only lists when something is waiting, plus
an hourly and a daily full check. With the live link, `profiles.py` only lists after a push (and
up to three short retries if the new item isn't listed yet); its pings cost a few hundred Durable
Object requests a day, well inside that plan's 100,000 requests and 13,000 GB-seconds, because
a hibernating socket isn't billed for time. Without the link it reads `/api/queue/flag` every 15
seconds between runs (about 5,200 reads and requests a day, each one Durable Object request that both
checks the signature's nonce and records the check-in) and only syncs when its value
changes, so an item that keeps failing is retried by the next run rather than listed every 15
seconds. Admin pages also skip the listing when the flag says the queue is empty. Each flag holds when it was
last set, and a listing that finds nothing under a flag set over two minutes ago takes it down (KV lists can
show a deleted key for about a minute), so a flag can't stay on after its items have gone and cost a list on
every poll. Each request reads a KV key at most once (`src/memo.js`: later reads, and reads after
the request's own writes, come from memory, and each caller gets its own parsed copy). The recruits
list reads its sparklines from one key (`statsweeks`: the last nine days of each recruit's counts,
rewritten only when they change) and its invites from one list (each invite key carries the invite as
metadata), instead of a read per recruit and per invite. Status reports
from HermitShell are only written when something changed or every 15 minutes (at most 96 of the
1,000 writes a day), plus two per report (when it starts and when it ends), about one a minute for
a report's progress while it runs (a 20-minute scan adds about 20), and one per cover letter or
tailored CV as it starts and finishes. An
email-button request adds one write when it arrives and one when HermitShell collects it. The
Tasks window only lists the queue when its flag says something is waiting. Each recruit's stats
are written only when they changed, at most every 30 minutes, plus once after each report and once
when new answers are collected (in practice a few writes per recruit a day). Each [history](#history) entry adds one write, and a
History page one list. A [backup sent to Cloudflare](#backups-on-cloudflare) writes one SQLite row a
megabyte (a couple of hundred of the 100,000 rows a day, even with Back up now). If the Durable Object allowance ever ran out, saves still work and
HermitShell falls back to polling.

## Removing it

Delete the Worker and the KV namespace in the Cloudflare dashboard (or with
`npx wrangler delete` and `npx wrangler kv namespace delete`), then clear the three
`JOB_FEEDBACK_*` values in `.env`. Your saved history stays in `state/job_tracker.db`.

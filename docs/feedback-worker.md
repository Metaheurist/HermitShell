# Feedback buttons (Cloudflare Worker)

The Daily Vacancy Report can put buttons on every job, next to **View job**: **I applied**,
round thumbs up (**Good match**) and thumbs down (**Not for me**) buttons, **Interested** and
**Cover letter**, plus **Heard back** and **Rejected** on follow-up reminders. Your answers:

- calibrate the model: recent jobs you liked (thumbs up, Interested, I applied) and turned down
  (thumbs down, with your reason) are added to the rating prompt as examples;
- drive reminders: jobs you applied to come back in a "Follow up" section after 7 and 14 days;
- feed the Sunday roll-up (applications, replies, rejections);
- request a tailored cover letter, emailed to you as a PDF (see [Cover letters](#cover-letters));
- add skills you have but your CV doesn't mention, by tapping the amber missing-skill tags (see
  [Adding missing skills](#adding-missing-skills)).

The button icons are [Lucide](https://lucide.dev) SVGs (`packages/daily-vacancy-report/icons/src`)
rendered to PNG by `icons/build_icons.py`, because Gmail strips SVG from emails.

Emails can't talk to a server on your home network, and opening a port for Hermes isn't a good
idea. Instead, the buttons link to a tiny [Cloudflare Worker](https://developers.cloudflare.com/workers/)
that stores each answer in Workers KV. Hermes collects the answers at the start of every run over
HTTPS. Nothing on your server is exposed, and the Workers free plan is more than enough.

```
email button ──> Worker /f (confirm page) ──> KV ──> Hermes GET /events, POST /ack
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
- **Private API.** `/events`, `/ack` and `/api/*` need `Authorization: Bearer <JOB_FEEDBACK_API_TOKEN>`.
- **Protected admin page.** `/admin` is off until you set `ADMIN_PASSWORD`, and can sit behind
  Cloudflare Access (an emailed one-time code) as well; see
  [Extra profiles](#extra-profiles-and-the-admin-page).
- **Size limits.** Request bodies are capped (answers and status reports at a few KB, sign-ups at
  the CV limit), and uploaded CVs are checked to really be a PDF, .docx or text file.
- **Short-lived data.** Answers are deleted once Hermes has saved them, and expire after 30 days
  in any case. Only the job key, action, optional note and time are stored.
- **No secrets in git.** The two secrets live only in Hermes' `.env` and in the Worker's
  encrypted secrets. Your KV namespace ID goes in an untracked `wrangler.local.jsonc`.

## What you need

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up).
- Node.js 18 or newer on the machine you deploy from (your PC is fine; it doesn't have to be the
  Hermes server).
- This repository checked out on that machine.

**Easiest: let the setup wizard deploy it.** Give `scripts/setup.py` your Cloudflare account ID and
an API token and it creates the KV namespace, uploads the Worker, sets its secrets and fills in
`JOB_FEEDBACK_URL`, with no Node.js needed: see [docs/cloudflare-setup.md](cloudflare-setup.md).
The rest of this page is for deploying by hand.

Deploying by hand takes about ten minutes. Pick one of the two routes below; they end in the same
place. Afterwards, run the setup wizard (or edit `.env`) as described in
[Connect Hermes](#connect-hermes).

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
   [Connect Hermes](#connect-hermes). The secrets are created there.

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
"Daily Vacancy Report feedback endpoint."

## Connect Hermes

Hermes and the Worker must share two random secrets.

### With the setup wizard (recommended)

```sh
python3 scripts/setup.py daily-vacancy-report
```

Paste the Worker URL when asked about feedback buttons. The wizard generates
`JOB_FEEDBACK_SECRET` and `JOB_FEEDBACK_API_TOKEN`, saves them to `$HERMES_HOME/.env` and, if
`npx` is available where the wizard runs, offers to pipe them straight into
`wrangler secret put` so they are never shown on screen. If wrangler isn't available there, the
wizard prints commands like these to run from the `feedback-worker` folder on the machine you
deployed from. They read the values from `.env` and pipe them, so they are never displayed:

```sh
sed -n 's/^JOB_FEEDBACK_SECRET=//p' /path/to/hermes/.env | npx wrangler secret put JOB_FEEDBACK_SECRET
sed -n 's/^JOB_FEEDBACK_API_TOKEN=//p' /path/to/hermes/.env | npx wrangler secret put JOB_FEEDBACK_API_TOKEN
```

Add `--config wrangler.local.jsonc` if you deployed with a local config.

### By hand

Generate two values and add them to `$HERMES_HOME/.env` (keep the file at mode 600):

```sh
python3 -c "import secrets; print('JOB_FEEDBACK_SECRET=' + secrets.token_urlsafe(32))" >> "$HERMES_HOME/.env"
python3 -c "import secrets; print('JOB_FEEDBACK_API_TOKEN=' + secrets.token_urlsafe(32))" >> "$HERMES_HOME/.env"
echo 'JOB_FEEDBACK_URL=https://vacancy-feedback.<subdomain>.workers.dev' >> "$HERMES_HOME/.env"
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
| Report banner: "feedback Worker unreachable (HTTP 401)" | The API token differs. Put `JOB_FEEDBACK_API_TOKEN` again. |
| TLS or handshake errors right after the first deploy | A new `workers.dev` subdomain takes a few minutes to get its certificate. Wait and retry. |
| No buttons in the email | `JOB_FEEDBACK_URL` or `JOB_FEEDBACK_SECRET` is empty in `.env`. |
| Answers never arrive | Check requests with `npx wrangler tail`, or the Workers Observability MCP / dashboard logs. |
| No cover letter email | Check `hermes cron list` for `vacancy-cover-letters` and its output in `cron/output/`; run `python3 cover_letter.py` by hand to see errors. |

Answers wait in KV until Hermes fetches them, so a server that is off for a few days loses
nothing (up to 30 days).

## Cover letters

**Cover letter** on a job card opens the usual confirmation page, where you can add guidance
("mention my Azure work", "keep it short"). After you confirm:

```
Cover letter button ──> Worker (confirm) ──> KV ──> cover_letter.py every 5 min ──> email + PDF
```

1. `cover_letter.py`, a `hermes cron` job, fetches the request from the Worker within 5 minutes.
2. Hermes' model writes the letter from `job_profile.md` (plus `COVER_LETTER_CV_FILE` if set),
   the listing saved when the job was rated, and your note. It is told to use only facts from
   your CV. Letters that are too short or contain placeholders are rejected and retried.
3. The letter is laid out as an A4 PDF with real, selectable text (`letter_pdf.py`, no extra
   packages), saved in `state/cover_letters/`, and emailed to you with the job details, a
   preview and a View job button.

<img src="images/emails/cover-letter.png" alt="Cover letter email" width="360"> <img src="images/emails/cover-letter-pdf.png" alt="Cover letter PDF" width="300">

**Tailored CV** follows the same path: `cover_letter.py` asks the model to reorder and reword your
CV for the job (titles, employers and dates are copied, never invented) and emails it as a PDF
([email](images/emails/tailored-cv.png), [PDF](images/emails/tailored-cv-pdf.png)).

Everything runs on your Hermes server; the Worker only sees the job key and your note. Failed
attempts are retried on the next two runs, then given up (see `letters` in
`state/job_tracker.db`). Put your name and contact line in `.env` so they appear on the letter:

```sh
COVER_LETTER_NAME=Sam Taylor
COVER_LETTER_CONTACT=Belfast · sam@example.com · 07700 900000
```

The wizard schedules the job; by hand:

```sh
hermes cron create "*/5 * * * *" "Cover letter requests" \
    --name vacancy-cover-letters --script cover_letter.py --no-agent --deliver local
python3 cover_letter.py --job <tracker key> --dry-run   # try one without email
```

The job prints nothing when there is nothing to do, so Hermes records it as a silent run.

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

The skill list is part of the link's signature, so a link can't be edited to offer other
skills; typed skills are limited to letters, numbers and `+ # . / & ( ) -`. Your CV files are
never changed. To review or undo:

```sh
python3 job_scanner.py --skills                   # list the skills you added
python3 job_scanner.py --remove-skill "Kubernetes"
```

## Extra profiles and the admin page

One Hermes can send reports to other people too, each built from their own CV. You manage them
from the Worker's admin page; Hermes applies the changes, since the Worker can't reach your server.

```
/admin (you) ──> invite link ──> /join (them: details + CV) ──> KV ──> profiles.py every 5 min
```

1. Set an admin password on the Worker (and optionally a username; the default is `admin`). Pipe
   it in so it never lands in your shell history, e.g. from a password manager's CLI:

   ```sh
   <print-password-command> | npx wrangler secret put ADMIN_PASSWORD --config wrangler.local.jsonc
   echo admin | npx wrangler secret put ADMIN_USER --config wrangler.local.jsonc   # optional
   ```

2. Schedule `profiles.py` (the wizard does this):

   ```sh
   hermes cron create "*/5 * * * *" "Vacancy profiles" \
       --name vacancy-profiles --script profiles.py --no-agent --deliver local
   ```

3. Open `https://vacancy-feedback.<subdomain>.workers.dev/admin`, sign in and press
   **Create invite link**. Each link works once and expires after 7 days; send it to the person.
   (`python3 profiles.py --invite "note"` makes one from the server too.)
4. They fill in their name, email, optional phone and town, the roles they want, and upload a CV
   (PDF, Word .docx or text, up to 5 MB) or paste it. The CV waits in KV, deleted once Hermes has it.
5. Within 5 minutes `profiles.py` downloads it, reads the text (`cv_text.py`, no extra packages;
   scanned image-only PDFs can't be read, so the pasted text is used instead), and asks Hermes'
   model for a summary, job titles, skills and gaps. From those it writes the person's
   `job_profile.md`, `cv_keywords.json` and search settings under `state/profiles/<id>/`, emails
   them a welcome message listing what it will search for, and emails you a note.

<img src="images/worker/join-form.png" alt="Sign-up form" width="280"> <img src="images/emails/welcome.png" alt="Welcome email" width="330">

*The sign-up form and the welcome email. The other states are in
[screenshots.md](screenshots.md#sign-up-page).*

From then on every daily report, weekly roll-up and cover letter run also runs for each active
profile, one after the other once your own run has finished, with their own seen jobs, tracker,
feedback buttons and skills pool. They share your region, sources and model settings, and every
model request (ratings, cover letters, CVs, sign-ups, for all profiles) waits in one shared queue,
so the model only ever gets one request at a time; see
[configuration](configuration.md#where-settings-come-from). A sign-up
that uses the email of an existing profile is not applied (so an invite can't take over someone
else's profile); Hermes emails you about it instead. Opening the same invite twice creates only
one profile.

CVs are read in a separate process with a time and memory limit, so a broken or hostile file
can't stall the server.

You are the `owner` profile: your `.env`, `job_profile.md` and `cv_keywords.json` stay exactly as
they are. `profiles.py` registers you on its first run.

### The admin page

<img src="images/worker/admin-dashboard.png" alt="Admin page" width="720">

- **Profiles**: everyone Hermes reports, with status and last report. Pause, resume or delete
  (deleting removes their CV and history from your server; the owner can't be deleted).
- **Crawler keys**: give a profile its own Firecrawl key (it then uses only that key), or leave
  it on the global key. **Global crawler key** replaces the keys in `.env` for everyone without
  their own, you included; **Go back to the .env keys** undoes it. Keys are stored on the Hermes
  server (`state/profiles/`, mode 600) and shown only as `fc-...1234`.
- **Invites**: create, see and revoke unused links.

Changes wait in KV and are applied by `profiles.py` within 5 minutes ("Waiting for Hermes" shows
what is pending). Keys typed into the page are deleted from KV after 2 days if Hermes hasn't
collected them.

Every control is described in [screenshots.md](screenshots.md#profiles).

Sign-in: five wrong passwords lock that address (an IPv6 /64 counts as one address) out for 15
minutes, and 30 wrong passwords from anywhere lock sign-in for everyone for 15 minutes. If KV
can't be read, sign-in is refused rather than allowed. Sessions last 12 hours in a `__Host-`
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
audience, even if the password is right. Buttons, `/join` invites and the Hermes API are not
behind Access and keep working.

From the server:

```sh
python3 profiles.py --list
python3 profiles.py --pause <id>     # or --resume, --delete
```

### Unsubscribe

Every daily report and weekly roll-up ends with an **Unsubscribe** link (signed like the buttons,
with a confirmation page). For an extra profile it deletes the profile, CV and history at the next
`profiles.py` run and tells you; for the owner it only pauses your own reports (the others keep
running) until you resume from `/admin` or with `profiles.py --resume owner`.

<img src="images/worker/confirm-unsubscribe.png" alt="Unsubscribe confirmation" width="300">

### Free-plan limits

Workers KV's free plan allows 1,000 list operations a day. Polling (`/events` every 5 minutes for
cover letters, `/api/queue` for profiles) reads a small flag key instead of listing, and only lists
when something is waiting, plus an hourly and a daily full check. Status reports from Hermes are
only written when something changed or once an hour.

## Removing it

Delete the Worker and the KV namespace in the Cloudflare dashboard (or with
`npx wrangler delete` and `npx wrangler kv namespace delete`), then clear the three
`JOB_FEEDBACK_*` values in `.env`. Your saved history stays in `state/job_tracker.db`.

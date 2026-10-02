# Vacancy feedback Worker

A small Cloudflare Worker that gives the Daily Vacancy Report email working buttons
(I applied, Good match, Not for me, Interested, Cover letter, Heard back, Rejected, and the
missing-skill tags) without opening any port on your server.

- Each button is a signed link (`/f?j=…&a=…&n=…&t=…`). Opening it only shows a confirmation page, so
  mail scanners that follow every link cannot record answers.
- Missing-skill tags use `a=add_skill` with the job's missing skills in `s` (covered by the
  signature) and the tapped one in `p`. The page offers them as checkboxes plus a free-text box;
  the saved event carries the chosen `skills`.
- Pressing **Confirm** saves the answer in Workers KV for up to 30 days.
- On its next run the scanner calls `GET /events`, stores the answers in `job_tracker.db`, then calls
  `POST /ack` to delete them from KV. Both API calls need `Authorization: Bearer <JOB_FEEDBACK_API_TOKEN>`.
- Links for extra profiles carry the profile id in `u` (covered by the signature); `/events?u=<id>`
  returns only that profile's answers. `a=unsubscribe` asks for confirmation, then queues the removal.
- Links are signed over every field plus the send day (`d`) and expire after 90 days.
- `/admin` (the main admin's password in the `ADMIN_PASSWORD` secret, optional `ADMIN_USER`;
  optionally behind Cloudflare Access with `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`) creates single-use
  invite links, lists the recruits HermitShell reports and queues changes: details, pause, resume,
  delete, assignments and the global keys. `/admin/users` adds dashboard users with the Admin or
  Recruiter role (salted PBKDF2 hashes in KV); a recruiter sees and changes only their own pool.
  Admins reset users' passwords there, and every user changes their own from `/admin`
  (`POST /admin/password`).
- `/join?i=<invite>` is the sign-up form with the CV upload; the CV is kept raw in KV until HermitShell
  collects it through `/api/queue`, `/api/file` and `/api/queue/ack`. HermitShell reports its profiles
  with `POST /api/status`.
- `/api/live` is HermitShell's live link: a WebSocket, opened from the HermitShell server, that a
  Durable Object (`Hub`, binding `HUB`) tells the moment anything is queued. The dashboard shows
  **HermitShell is online** while it is up. Without it HermitShell polls `/api/queue/flag`.

Source: `src/index.js` (buttons, routing), `src/join.js` (invites, sign-up), `src/admin.js` (admin
page, HermitShell API), `src/users.js` (dashboard users and roles), `src/keys.js` (global web search
keys), `src/hub.js` (the live link), `src/lib.js` (signing, pages). It fits in the
Cloudflare free plan (Workers, KV and SQLite-backed Durable Objects, whose hibernating WebSocket
isn't billed while idle); polling reads flag keys instead of listing KV, which the free plan limits
to 1,000 lists a day.

## Setup

The full guide, with a route using the Cloudflare MCP in an AI agent and a route using wrangler by
hand, is in [docs/feedback-worker.md](../../../docs/feedback-worker.md). In short:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create FEEDBACK      # copy the id into wrangler.jsonc
npx wrangler secret put JOB_FEEDBACK_SECRET     # paste the same value you put in .env
npx wrangler secret put JOB_FEEDBACK_API_TOKEN  # paste the same value you put in .env
npx wrangler secret put ADMIN_PASSWORD          # optional: turns on /admin for extra profiles
npx wrangler deploy
```

Then set these in HermitShell's `.env` (`$HERMITSHELL_HOME/.env`):

```bash
JOB_FEEDBACK_URL=https://vacancy-feedback.<your-subdomain>.workers.dev
JOB_FEEDBACK_SECRET=<same value as the Worker secret>
JOB_FEEDBACK_API_TOKEN=<same value as the Worker secret>
```

## Tests

```bash
npm test
```

The tests run the Worker against an in-memory KV and check the signature format shared with
`job_tracker.py`, that opening a link saves nothing, that changed links are refused, that the
API needs the token, and the invite, sign-up, admin (lockout, CSRF, sessions) and unsubscribe flows.
`test/users.test.js` covers dashboard users: hashed passwords, per-user sessions and sign-out,
changing your own password and admin resets, and that a recruiter can reach only their own recruits
on every route.
`test/hub.test.js` runs the real `Hub` class on an in-memory Durable Object state: pushes, the
WebSocket upgrade, presence on the dashboard and saves that still work without the binding.

### Browser tests

```bash
npx playwright install chromium   # once
npm run e2e
```

`e2e/` drives the pages in Chromium with Playwright. `playwright.config.js` starts the Worker with
`wrangler dev` (the real workerd runtime, local KV and Durable Objects) on a fresh state folder with
throwaway secrets, and `e2e/global-setup.js` reports three fictional recruits to it as HermitShell would.
No Cloudflare account is needed. The tests run one at a time in file order, since they share one KV:

| File | What it checks |
| --- | --- |
| `admin.spec.js` | Sign-in (wrong password, then right), the recruits list, search, the dashboard tabs, sign-out closing every page |
| `email.spec.js` | An email button asks first, saves once and shows in History without the note; changed and expired links; the privacy notice |
| `join.spec.js` | An invite link signs someone up once and they show as pending; a missing CV keeps what was typed |
| `layout.spec.js` | No admin page scrolls sideways on a phone, the recruits table becomes cards, and grows past 900px on a wide screen |
| `recruit.spec.js` | A recruit's Manage and History tabs; a saved change stays in the form and is recorded; Send jobs now and pausing, newest first |
| `security.spec.js` | Cookie flags, CSP and no-store headers, a forged CSRF token refused, the API token, markup in an invite note shown as text |
| `users.spec.js` | Adding a recruiter, assigning a recruit (recorded in History), and a recruiter seeing only their own recruits |

The Playwright workflow runs them on every push and uploads the HTML report and traces when one fails.

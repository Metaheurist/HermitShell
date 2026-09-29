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
- `/admin` (password in the `ADMIN_PASSWORD` secret, optional `ADMIN_USER`; optionally behind
  Cloudflare Access with `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`) creates single-use invite
  links, lists the profiles HermitShell reports and queues changes: crawler keys, pause, resume, delete.
- `/join?i=<invite>` is the sign-up form with the CV upload; the CV is kept raw in KV until HermitShell
  collects it through `/api/queue`, `/api/file` and `/api/queue/ack`. HermitShell reports its profiles
  with `POST /api/status`.

Source: `src/index.js` (buttons, routing), `src/join.js` (invites, sign-up), `src/admin.js` (admin
page, HermitShell API), `src/lib.js` (signing, pages). It fits in the Cloudflare free plan (Workers and KV);
polling reads flag keys instead of listing KV, which the free plan limits to 1,000 lists a day.

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

Then set these in `$HERMES_HOME/.env`:

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

# Feedback buttons (Cloudflare Worker)

The Daily Vacancy Report can put buttons on every job: **Interested**, **Not for me** and
**I applied**, plus **Heard back** and **Rejected** on follow-up reminders. Your answers:

- calibrate the model: recent jobs you liked and turned down (with your reason) are added to
  the rating prompt as examples;
- drive reminders: jobs you applied to come back in a "Follow up" section after 7 and 14 days;
- feed the Sunday roll-up (applications, replies, rejections).

Emails can't talk to a server on your home network, and opening a port for Hermes isn't a good
idea. Instead, the buttons link to a tiny [Cloudflare Worker](https://developers.cloudflare.com/workers/)
that stores each answer in Workers KV. Hermes collects the answers at the start of every run over
HTTPS. Nothing on your server is exposed, and the Workers free plan is more than enough.

```
email button ──> Worker /f (confirm page) ──> KV ──> Hermes GET /events, POST /ack
```

## How it stays safe

- **Signed links.** Every button carries an HMAC signature of the job, action and title made
  with `JOB_FEEDBACK_SECRET`. Changed or made-up links are refused.
- **Nothing is saved on click.** Opening a link only shows a confirmation page (with an
  optional note). Mail scanners that open every link can't record answers; only pressing
  **Confirm** saves one.
- **Private API.** `/events` and `/ack` need `Authorization: Bearer <JOB_FEEDBACK_API_TOKEN>`.
- **Short-lived data.** Answers are deleted once Hermes has saved them, and expire after 30 days
  in any case. Only the job key, action, optional note and time are stored.
- **No secrets in git.** The two secrets live only in Hermes' `.env` and in the Worker's
  encrypted secrets. Your KV namespace ID goes in an untracked `wrangler.local.jsonc`.

## What you need

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up).
- Node.js 18 or newer on the machine you deploy from (your PC is fine; it doesn't have to be the
  Hermes server).
- This repository checked out on that machine.

Deploying takes about ten minutes. Pick one of the two routes below; they end in the same
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

Answers wait in KV until Hermes fetches them, so a server that is off for a few days loses
nothing (up to 30 days).

## Removing it

Delete the Worker and the KV namespace in the Cloudflare dashboard (or with
`npx wrangler delete` and `npx wrangler kv namespace delete`), then clear the three
`JOB_FEEDBACK_*` values in `.env`. Your saved history stays in `state/job_tracker.db`.

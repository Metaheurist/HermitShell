# Cloudflare setup (automatic)

The feedback buttons, cover letter and tailored CV requests, the `/admin` page and the sign-up links
all run on a small Cloudflare Worker. You don't have to deploy it by hand: give the setup wizard a
free Cloudflare account's **account ID** and an **API token**, and it creates everything and fills in
the Worker's address (`JOB_FEEDBACK_URL`) for you. No Node.js or wrangler is needed; the wizard
talks to the Cloudflare API directly.

What the wizard does with the token:

1. Checks the token, and finds your `workers.dev` subdomain (or creates the one you pick).
2. Finds or creates the KV namespace `vacancy-feedback-FEEDBACK`.
3. Uploads the Worker (`packages/daily-vacancy-report/feedback-worker/src`) and turns on its
   `https://vacancy-feedback.<subdomain>.workers.dev` address.
4. Stores the Worker secrets: the link-signing secret and API token it generated for Hermes, and
   the `/admin` username and password you type in. Secrets already on the Worker are kept.
5. Optionally puts `/admin` behind [Cloudflare Access](#protect-admin-with-cloudflare-access), so an
   emailed one-time code is needed before the password page.

Everything else (profiles, email settings, keys, invites) is then managed from the Worker's pages.

## 1. Create a Cloudflare account

1. Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) with your email
   and a password, then confirm the email Cloudflare sends you.
2. You don't need a domain, a paid plan or a payment card for the Worker.

## 2. Copy your account ID

In the dashboard open **Workers & Pages** (or the account home page). The **Account ID** is shown on
the right-hand side; it is 32 letters and digits. You can also use the account menu's **Copy account
ID**.

## 3. Create an API token

Create a token that can only do what the wizard needs:

1. Either **Manage account -> Account API tokens -> Create token** (an account-owned token, starts
   with `cfat_`) or **My Profile -> API Tokens -> Create Token** (a user token). Both work.
2. Pick **Create custom token**, give it a name such as `hermitshell`, and add these permissions:

   | Scope   | Permission                  | Access | Needed for                            |
   | ------- | --------------------------- | ------ | ------------------------------------- |
   | Account | Workers Scripts             | Edit   | uploading the Worker, its secrets     |
   | Account | Workers KV Storage          | Edit   | the Worker's storage                  |
   | Account | Access: Apps and Policies   | Edit   | only to protect `/admin` with Access  |

3. Under **Account resources**, include only your account. Optionally restrict the token to your
   server's IP address and give it an expiry date.
4. Create it and copy the token straight away; Cloudflare shows it once.

Don't give the wizard R2 or S3 credentials or a Global API Key; HermitShell doesn't use them.

## 4. Run the wizard

```sh
python3 scripts/setup.py
```

At **Feedback buttons and admin page (Cloudflare)**, the first question after installing, answer yes.
Then paste the account ID and the token (the token is typed without echo). The wizard then asks for:

- a `workers.dev` subdomain, only if your account doesn't have one yet;
- a new `/admin` password (12 or more characters, typed twice) and username. A new Worker needs a
  password; for an existing one, Enter keeps its current password;
- whether to protect `/admin` with Cloudflare Access, and which emails may sign in.

Then it asks only for your timezone, optionally the email server, and the run times. The job search,
CV, web search keys and (if you skipped it) the email server are set on `/admin` instead
([what to set there](feedback-worker.md#the-admin-page)). With `--advanced`, the wizard asks
everything first and the Worker last.

After you confirm the review, it deploys the Worker and prints its address. The account ID, token,
Worker name and Access emails are saved in `$HERMES_HOME/.env` (mode 600); the admin password is
only stored on the Worker.

Unattended installs put the same values in the answers file:

```sh
CLOUDFLARE_ACCOUNT_ID=<32-character account ID>
CLOUDFLARE_API_TOKEN=<token>
CLOUDFLARE_SUBDOMAIN=<only used when the account has no workers.dev subdomain>
CLOUDFLARE_ACCESS_EMAILS=you@example.com      # optional
ADMIN_PASSWORD=<12+ characters>                # optional; never written to .env
```

```sh
python3 scripts/setup.py --non-interactive --answers answers.env
```

## Updating the Worker

After updating HermitShell (`git pull`), upload the new Worker code with the saved settings:

```sh
python3 scripts/cloudflare_worker.py                      # add --hermes-home /path if needed
```

The same command changes the admin password (piped, so it never lands in your shell history) or adds
Access:

```sh
<print-password-command> | python3 scripts/cloudflare_worker.py --admin-password-stdin --admin-user admin
python3 scripts/cloudflare_worker.py --access you@example.com
```

Changing the admin password signs everyone out of `/admin`.

## Protect /admin with Cloudflare Access

[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) asks for a
one-time code sent to an allowed email address before `/admin` shows its password form. Buttons,
sign-up links and the Hermes API are not affected.

1. Once, in the dashboard, open **Zero Trust** and pick a team name (your
   `<team>.cloudflareaccess.com` address) and the **Free** plan (up to 50 users). Cloudflare may ask
   for a payment method; the free plan isn't charged.
2. Make sure the token has **Access: Apps and Policies: Edit**.
3. Answer yes to the Access question in the wizard, or run
   `python3 scripts/cloudflare_worker.py --access you@example.com`.

The wizard creates a self-hosted Access application for `vacancy-feedback.<subdomain>.workers.dev/admin`
with an allow policy for those emails, reads your team domain from Access' sign-in redirect and
sets the Worker's `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`. From then on the Worker refuses any `/admin`
request without a valid Access token. To add people later, edit the policy under **Zero Trust ->
Access -> Applications**.

## Free plan limits

Everything above fits in Cloudflare's free plans:

| Service               | Free allowance                                                  | What HermitShell uses                                   |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| Workers               | 100,000 requests a day, 10 ms CPU per request                   | about 600 polls a day plus your button presses          |
| Workers KV            | 100,000 reads, 1,000 writes, 1,000 deletes, 1,000 lists a day; 1 GB | small flag reads; lists only when something is waiting |
| Zero Trust (Access)   | up to 50 users                                                  | you (and anyone you add)                                |

Polling reads a flag key instead of listing KV, so the 1,000 lists a day aren't reached. Each button
press, sign-up or admin change is one or two writes.

## Keeping the token safe

- The token is stored only in `$HERMES_HOME/.env` (mode 600) and never printed; the review screen
  shows `****` and the last four characters.
- Dashboard settings can't change `CLOUDFLARE_*` values; only the wizard or `.env` can.
- If the token may have leaked (pasted into a chat, a screenshot, a shared file), roll it in the
  Cloudflare dashboard and re-run the wizard with the new one. Rolling doesn't affect the Worker.

## Troubleshooting

| Message | Fix |
| ------- | --- |
| `The Cloudflare account ID should be 32 hexadecimal characters` | Copy the account ID again (not the zone ID or the token). |
| `... failed (10000: Authentication error)` | The token lacks a permission from the table above, or covers another account. |
| `The Cloudflare API token is not active` | The token expired or was revoked; create a new one. |
| subdomain already taken | Pick another `workers.dev` subdomain. |
| `Access not set up: ...` | Create the Zero Trust team first (step 1 of the Access section) and check the token's Access permission. The Worker works without Access. |
| `team domain couldn't be read yet` | Access can take a minute to apply; run `python3 scripts/cloudflare_worker.py --access you@example.com` again. |

Prefer to deploy by hand? [docs/feedback-worker.md](feedback-worker.md) covers wrangler and the
Cloudflare MCP.

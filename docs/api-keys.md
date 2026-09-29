# Accounts and API keys

Everything HermitShell uses has a free plan. You need an email account to send from, one web search
key, and Ollama on the Hermes machine. Cloudflare is optional but gives you the buttons, the sign-up
links and the `/admin` dashboard where all of the keys below can be entered.

| Service | Needed? | What for | Free plan (checked September 2026) | Where it goes |
| --- | --- | --- | --- | --- |
| [Cloudflare](#cloudflare) | Recommended | Buttons in the emails, `/admin`, sign-up links | Workers free plan: 100,000 requests a day | Setup wizard |
| [Gmail](#gmail-app-password) (or any SMTP account) | Yes | Sending the reports | About 500 recipients a day for a personal Gmail account | `/admin` → Email server, or the wizard |
| [Firecrawl](#firecrawl) | One search key is | Web search and reading job pages | 1,000 credits a month, 2 requests at a time, no card | `/admin` → Web search API keys |
| [Tavily](#tavily) | Optional | Second search provider when Firecrawl fails or runs out | 1,000 credits a month, no card | `/admin` → Web search API keys |
| [Scrapfly](#scrapfly) | Optional | Reading pages that block ordinary requests | 1,000 credits when you sign up, no card | `/admin` → Web search API keys |
| [Ollama](#ollama) | Yes | The model that rates jobs and writes letters, on your own machine | Free and open source | Set up by the wizard |

Free plans change: check each pricing page before relying on the numbers. Keys and passwords typed
on `/admin` wait in the Worker only until HermitShell picks them up (within minutes; they expire after
two days if HermitShell is off). HermitShell then keeps them
in `state/dashboard.json`, readable only by the Hermes account like `.env`. The dashboard only ever
shows their last four characters.

## How much a run uses

One daily report uses about 20 to 40 Firecrawl credits: 4 searches plus up to
`JOB_SCANNER_MAX_SCRAPE` page reads. Pages that can be fetched directly (job boards with structured
data, company home pages) cost nothing. So one person's daily report fits in Firecrawl's free
1,000 credits a month, and Tavily covers the days it runs out.

For extra profiles, either give each person their own Firecrawl key (on `/admin`, in their row
under **Crawler**; each person can make a free account), or add several global Firecrawl keys
separated by commas: HermitShell moves to the next key when one runs low. The footer of every report
shows the credits each provider used.

## Cloudflare

See [Cloudflare setup](cloudflare-setup.md): create a free account, copy the account ID, create an
API token with Workers Scripts and Workers KV Storage edit rights, and give both to the setup
wizard. It deploys the Worker and prints the `/admin` address. No domain or payment card is
needed. The free plan's limits are in [Free plan limits](cloudflare-setup.md#free-plan-limits).

## Gmail app password

Gmail doesn't accept your normal password from other programs; it needs an app password.

1. Open [myaccount.google.com/security](https://myaccount.google.com/security) and turn on
   **2-Step Verification** if it's off (app passwords need it).
2. Open [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), type a
   name such as `HermitShell` and press **Create**.
3. Copy the 16-letter password Google shows. It is only shown once. Spaces in it don't matter.
4. On `/admin` under **Email server** enter:

   | Field | Value |
   | --- | --- |
   | SMTP server | `smtp.gmail.com` |
   | Port | `587` |
   | Username | your Gmail address |
   | Password | the app password |

5. Press **Save email server**, then **Send a test email**. The result shows on the page after
   HermitShell's next check (within about 5 minutes).

A personal Gmail account can send to about 500 recipients a day, far more than the reports need.
Consider a separate Gmail account for HermitShell, so the app password can't reach your main inbox.
Revoke the app password on the same page if it ever leaks; changing your Google password also
revokes it.

**Other providers.** Any account that allows SMTP with a password works. Look up your provider's
"SMTP settings" page for the server and port: 587 (STARTTLS) or 465 (SSL) both work. For
Outlook.com it is `smtp-mail.outlook.com`, port 587. Microsoft is phasing out password sign-in for
SMTP on consumer accounts, so if the test email reports an authentication error, use Gmail or a
transactional email service's SMTP relay.

## Firecrawl

1. Sign up at [firecrawl.dev](https://www.firecrawl.dev) with an email address, Google or GitHub.
2. Open [API keys](https://www.firecrawl.dev/app/api-keys) in the dashboard and copy the key (it
   starts with `fc-`).
3. Paste it on `/admin` under **Web search API keys** → Firecrawl. Several keys can be pasted
   separated by commas; they are used in turn.

Free plan: 1,000 credits a month (a search costs about 2 credits per 10 results, a page read 1
credit), 2 requests at a time, no card.

## Tavily

1. Sign up at [app.tavily.com](https://app.tavily.com).
2. The dashboard home page shows your API key (it starts with `tvly-`); copy it.
3. Paste it on `/admin` under **Web search API keys** → Tavily.

Free plan: 1,000 credits a month, no card. A basic search costs 1 credit. Tavily is used when
Firecrawl fails or runs out, so the free plan is usually plenty.

## Scrapfly

1. Sign up at [scrapfly.io](https://scrapfly.io/register).
2. The [dashboard](https://scrapfly.io/dashboard) shows your API key; copy it.
3. Paste it on `/admin` under **Web search API keys** → Scrapfly.

Free: 1,000 credits when you sign up, no card. A plain page read costs 1 credit; pages that need a
real browser or proxies cost more. Scrapfly is only used for pages Firecrawl can't read, so it is
optional.

## Ollama

Ollama runs the model on your own machine, so CVs never go to a cloud AI service. The setup
wizard sets it up: when no Ollama server answers and Hermes runs in Docker, it starts an
`ollama/ollama` container next to Hermes (with the GPU when there is one) and downloads the model.
To do it by hand, see [Check the prerequisites](installation.md#3-check-the-prerequisites).

The default model, `qwen3:4b-instruct-2507-q4_K_M`, is about 2.5 GB and runs on a CPU; about 8 GB
of free memory is comfortable. With a GPU, a larger model such as `qwen3:8b` rates jobs more
carefully (set `OLLAMA_MODEL`, then run `python3 doctor.py --fix`).

## Keys in .env instead

Everything above can also go in `$HERMES_HOME/.env`, for example when there's no Cloudflare
Worker: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `FIRECRAWL_API_KEY`,
`FIRECRAWL_BACKUP_KEYS`, `TAVILY_API_KEY` and `SCRAPFLY_API_KEY`
([all settings](configuration.md)). Values saved on `/admin` take priority over `.env`; each
section's "use the .env ..." button goes back to the `.env` value.

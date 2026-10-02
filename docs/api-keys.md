# Accounts and API keys

Everything HermitShell uses has a free plan. You need an email account to send from, one web search
key, and Ollama where HermitShell can reach it, or a [cloud model](#cloud-models) key when the server can't
run one. Cloudflare is optional but gives you the buttons, the sign-up
links and the `/admin` dashboard where all of the keys below can be entered.

| Service | Needed? | What for | Free plan (checked September 2026) | Where it goes |
| --- | --- | --- | --- | --- |
| [Cloudflare](#cloudflare) | Recommended | Buttons in the emails, `/admin`, sign-up links | Workers free plan: 100,000 requests a day | Setup wizard |
| [Gmail](#gmail-app-password) (or any SMTP account) | Yes | Sending the reports | About 500 recipients a day for a personal Gmail account | Global settings (`/admin/settings`) → Email server, or the wizard |
| [Firecrawl](#firecrawl) | One search key is | Web search and reading job pages | 1,000 credits a month, 2 requests at a time, no card | Global settings → Web search API keys |
| [Tavily](#tavily) | Optional | Second search provider when Firecrawl fails or runs out | 1,000 credits a month, no card | Global settings → Web search API keys |
| [Scrapfly](#scrapfly) | Optional | Reading pages that block ordinary requests | 1,000 credits when you sign up, no card | Global settings → Web search API keys |
| [Ollama](#ollama) | Yes, unless a cloud model key is set | The model that rates jobs and writes letters, on your own machine | Free and open source | Set up by the wizard |
| [OpenRouter](#openrouter) | Optional | A cloud model for servers that can't run Ollama | Free models: 20 requests a minute, 50 a day (1,000 a day once you have bought $10 of credits) | Global settings → AI model API keys |
| [BazaarLink](#bazaarlink) | Optional | Another cloud model router | Free `auto:free` router with a daily limit | Global settings → AI model API keys |
| [Featherless](#featherless) | Optional | Open models with a flat monthly price, prompts not logged | Paid plans only | Global settings → AI model API keys |
| [Hugging Face](#hugging-face) | Optional | Open models through Hugging Face's inference providers | $0.10 of credit a month ($2 with PRO) | Global settings → AI model API keys |

Free plans change: check each pricing page before relying on the numbers. Keys and passwords typed
on `/admin` wait in the Worker only until HermitShell picks them up (within minutes; they expire after
two days if HermitShell is off). HermitShell then keeps them
in `state/dashboard.json`, readable only by HermitShell's account like `.env`. The dashboard only ever
shows their last four characters.

## How much a run uses

One daily report uses about 20 to 40 Firecrawl credits: 4 searches plus up to
`JOB_SCANNER_MAX_SCRAPE` page reads. Pages that can be fetched directly (job boards with structured
data, company home pages) cost nothing. So one person's daily report fits in Firecrawl's free
1,000 credits a month, and Tavily covers the days it runs out.

Web search keys are global: every recruit's report uses the same keys, set in `.env` or on the
dashboard under **Global settings** (**Add key** or **Change** on the provider's row). For more
recruits, add several Firecrawl keys separated by commas: HermitShell moves to the next key when one
runs low, and falls back to Tavily. The footer of every report shows the credits each provider used.

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
4. On the **Global settings** tab (`/admin/settings`) under **Email server** enter:

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
3. Paste it on the **Global settings** tab under **Web search API keys** → Firecrawl. Several keys can be pasted
   separated by commas; they are used in turn.

Free plan: 1,000 credits a month (a search costs about 2 credits per 10 results, a page read 1
credit), 2 requests at a time, no card.

## Tavily

1. Sign up at [app.tavily.com](https://app.tavily.com).
2. The dashboard home page shows your API key (it starts with `tvly-`); copy it.
3. Paste it on the **Global settings** tab under **Web search API keys** → Tavily.

Free plan: 1,000 credits a month, no card. A basic search costs 1 credit. Tavily is used when
Firecrawl fails or runs out, so the free plan is usually plenty.

## Scrapfly

1. Sign up at [scrapfly.io](https://scrapfly.io/register).
2. The [dashboard](https://scrapfly.io/dashboard) shows your API key; copy it.
3. Paste it on the **Global settings** tab under **Web search API keys** → Scrapfly.

Free: 1,000 credits when you sign up, no card. A plain page read costs 1 credit; pages that need a
real browser or proxies cost more. Scrapfly is only used for pages Firecrawl can't read, so it is
optional.

## Ollama

Ollama runs the model on your own machine, so CVs never go to a cloud AI service. The setup
wizard sets it up: when no Ollama server answers and Docker is there, it starts an
`ollama/ollama` container next to HermitShell (with the GPU when there is one) and downloads the model.
To do it by hand, see [Check the prerequisites](installation.md#3-check-the-prerequisites).

Unless `OLLAMA_MODEL` is set, `doctor.py --fix` downloads the model that fits the machine
(`autofit.suggested_model()`):

| Machine | Model | Download |
| --- | --- | --- |
| A GPU with 24 GB, or 48 GB of RAM | `qwen3:30b-a3b-instruct-2507-q4_K_M` (a mixture of experts, quick on a CPU for its size) | about 18.6 GB |
| A GPU with 12 GB | `qwen2.5:14b-instruct-q4_K_M` | about 9 GB |
| A GPU with 8 GB | `qwen2.5:7b-instruct-q4_K_M` | about 4.7 GB |
| A GPU with 4 GB, or 6 GB of RAM | `qwen3:4b-instruct-2507-q4_K_M` (the default) | about 2.5 GB |
| Less | `qwen2.5:1.5b-instruct` | about 1 GB |

The scripts prefer that model when Ollama has it, and otherwise use whichever of the others it has.
`HERMES_AUTOFIT=off` always picks the default. To run another one (such as `qwen2.5-coder:7b-instruct`
for technical CVs), pick it under Global settings > **Server model** > **Change**: the server downloads
it, shows the progress on the admin dashboard and switches once it is ready
([more](feedback-worker.md#ai-models)).

## Cloud models

For a server that can't run a model (a small VPS, a Raspberry Pi), HermitShell can send each request
to a cloud model instead. Add a key on the **Global settings** tab under **AI model API keys** (or in
`.env`). With **Cloud first** (the default) the providers with a key are asked in order (OpenRouter,
BazaarLink, Featherless, Hugging Face, or `LLM_PROVIDERS`), and the server model (its own Ollama)
answers when none has a key or credits left. **Server first** (`LLM_ORDER=local`) asks Ollama first and the cloud only when
Ollama doesn't answer, so the cloud covers for a machine that is off or busy. With the cloud first, a
run rates `LLM_CLOUD_CONCURRENCY` jobs at once (2 by default, up to 8); free plans allow only a few
requests a minute, so raise it only for a paid plan.

A provider that runs out of credits or reaches its daily limit rests until midnight UTC; one that
rejects its key rests for six hours, and one that is down or rate limited for a few minutes. Each
provider's row shows its model, whether it is resting and why, the requests it answered today and,
pressed, what is left of its allowance (OpenRouter's free requests today or dollars, BazaarLink's
dollars, Featherless' and Hugging Face's plan). Press **Change** to set another model; blank keeps the
current one.

**Privacy.** A cloud model is sent each recruit's CV and the job adverts it is rated against. Free
models on OpenRouter and BazaarLink may keep what they are sent; Featherless doesn't log prompts.
The [privacy notice](../PRIVACY.md) says so. Keep Ollama as the main model where you can.

### OpenRouter

1. Sign up at [openrouter.ai](https://openrouter.ai) and open [Keys](https://openrouter.ai/settings/keys).
2. Press **Create key** and copy it (it starts with `sk-or-`).
3. Paste it on **Global settings** → **AI model API keys** → OpenRouter.

The default model, `openrouter/free`, picks a free model for each request. Free models allow 20
requests a minute and 50 a day, or 1,000 a day once you have bought $10 of credits. Each job a report
rates is one request, so the free 50 cover about one recruit's report a day, with Ollama taking the
rest. Set another model (for example `meta-llama/llama-3.3-70b-instruct:free`, or a paid one) with
**Change** or `OPENROUTER_MODEL`.

### BazaarLink

1. Sign up at [bazaarlink.ai](https://bazaarlink.ai) and open **API Keys**.
2. Create a key (it starts with `sk-bl-`) and paste it under BazaarLink.

The default model, `auto:free`, routes to a free model with a daily limit; credits unlock paid
models (`BAZAARLINK_MODEL`).

### Featherless

1. Sign up at [featherless.ai](https://featherless.ai), choose a plan and copy your API key.
2. Paste it under Featherless.

Plans are paid, with no per-request charge within the plan's model size and concurrency, and prompts
are not logged. The default model is `Qwen/Qwen2.5-7B-Instruct` (`FEATHERLESS_MODEL`).

### Hugging Face

1. Sign in at [huggingface.co](https://huggingface.co) and open [Access tokens](https://huggingface.co/settings/tokens).
2. Create a **fine-grained** token with **Make calls to Inference Providers** and copy it (it starts
   with `hf_`).
3. Paste it under Hugging Face.

Free accounts get $0.10 of inference credit a month and PRO accounts $2. The default model,
`openai/gpt-oss-20b:cheapest`, runs on whichever provider is cheapest (`HUGGINGFACE_MODEL`).

## Keys in .env instead

Everything above can also go in HermitShell's `.env`, for example when there's no Cloudflare
Worker: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `FIRECRAWL_API_KEY`,
`FIRECRAWL_BACKUP_KEYS`, `TAVILY_API_KEY`, `SCRAPFLY_API_KEY`, `OPENROUTER_API_KEY`, `BAZAARLINK_API_KEY`,
`FEATHERLESS_API_KEY` and `HUGGINGFACE_API_KEY` (each with a `_MODEL`)
([all settings](configuration.md)). Values saved on `/admin` take priority over `.env`; each
section's "use the .env ..." button goes back to the `.env` value.

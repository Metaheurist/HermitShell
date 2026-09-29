# Web providers

`hermes_common.WebClient` gives packages one `search()` / `scrape()` interface over three paid
providers. It fails over between them automatically.

| Provider | Used for | Key |
| --- | --- | --- |
| [Firecrawl](https://firecrawl.dev) | Search (with recency filters) and page scraping to markdown | `FIRECRAWL_API_KEY`, `FIRECRAWL_BACKUP_KEYS` |
| [Tavily](https://tavily.com) | Search and page extraction | `TAVILY_API_KEY` |
| [Scrapfly](https://scrapfly.io) | Scraping bot-protected pages | `SCRAPFLY_API_KEY` |

Only providers with a key are used. You need at least one search provider: Firecrawl or Tavily.

## Order and failover

- `WEB_SEARCH_ORDER` (default `firecrawl,tavily`) and `WEB_SCRAPE_ORDER` (default
  `firecrawl,scrapfly,tavily`) set the priority.
- Each call tries providers in order and returns the first non-empty result.
- A provider that reports an invalid key or no credits (HTTP 401/402, or "insufficient
  credits") is dropped for the rest of the run, with a single log line.

## Firecrawl backup keys

At startup the client checks the remaining credits on `FIRECRAWL_API_KEY`. If the balance is
below the package's minimum (`JOB_SCANNER_MIN_CREDITS`), it moves on
to the next key in `FIRECRAWL_BACKUP_KEYS`. It also switches keys mid-run if one runs out. Logs
only ever show a masked key such as `fc-1a2b...9z8y`.

## Free fetches first

Where possible, packages fetch pages directly with `requests` before paying for a scrape.
Examples are nijobs.com listings, structured `JobPosting` data and company homepages. The
email footer reports how many pages were fetched for free and how many credits each provider
used.

## Typical usage per run

| Package | Firecrawl credits |
| --- | --- |
| Daily Vacancy Report | about 20-40: 4 searches plus up to `JOB_SCANNER_MAX_SCRAPE` scrapes |

That fits inside Firecrawl's free monthly allowance when run once a day for one person. Tavily's
free tier covers occasional failover. How to get each key and the free limits:
[Accounts and API keys](api-keys.md).

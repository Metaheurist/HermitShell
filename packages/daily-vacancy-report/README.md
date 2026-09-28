# Daily Vacancy Report

A Hermes cron package that searches for jobs matching your CV. The model Hermes already uses
rates each one, and you get a scored, logo-rich HTML email that renders properly in Gmail's
light and dark modes.

![Daily Vacancy Report email](../../docs/images/daily-vacancy-report.png)

*Dry run with the fictional example profile and the Northern Ireland example config.
[Full-length email](../../docs/images/daily-vacancy-report-full.png).*

## What it does

1. **Discover.** Searches Indeed through the [Indeed MCP server](#indeed-mcp-source) connected to
   Hermes, and runs web searches for single job postings through Firecrawl, with Tavily as the
   backup. It can also read [nijobs.com](https://www.nijobs.com) keyword listings, which is useful
   for Northern Ireland.
2. **Pre-filter.** Keeps only relevant titles (configurable regexes), drops internships, part-time
   work and jobs already seen in the last 90 days, then fetches each posting. Indeed descriptions
   come from the MCP job-detail tool, so they cost no scraping credits. For other boards, where
   the page has structured `JobPosting` data, the scanner uses that.
3. **Hard filters.** Optionally restricts results to one region (towns, postcodes or any regex),
   and accepts only full-time permanent or contract roles.
4. **Rate.** Hermes' model scores each job 0-10 against `job_profile.md`, with a confidence value,
   matched CV keywords, gaps and a short reason. For agency adverts it also identifies the real
   employer.
5. **Enrich.** Adds the hiring company's website, a circular logo and an expandable "About the
   company" section. Lookups are cached for 30 days in `state/companies.json`.
6. **Email.** Sends a summary with CV keyword coverage, then one card per job with a link to
   apply.

It only emails when there are new matches, unless `JOB_SCANNER_EMAIL_WHEN_EMPTY=1` is set.

## Files

| File | Purpose |
| --- | --- |
| `job_scanner.py` | Entry point run by the cron job |
| `companies.py` | Employer website, logo and profile lookup with caching |
| `indeed_mcp.py` | Indeed job search and job details through Hermes' Indeed MCP connection |
| `job_profile.example.md` | Template for your candidate profile (copy to `job_profile.md`) |
| `cv_keywords.example.json` | Template for skills to match and gaps to flag (copy to `cv_keywords.json`) |
| `.env.example` | Every package setting with its default |
| `examples/northern-ireland.env` | Complete regional example including nijobs.com and BT postcodes |

It also needs `hermes_common.py` from [`common/`](../../common) in the same directory, which the
installer handles.

## Install

From the repository root, on the machine (or inside the container) running Hermes:

```sh
HERMES_HOME=/opt/data ./scripts/install.sh daily-vacancy-report
cd /opt/data/scripts
cp job_profile.example.md job_profile.md        # then describe yourself
cp cv_keywords.example.json cv_keywords.json    # then list your skills
```

Add the shared settings from the root [`.env.example`](../../.env.example) (SMTP plus at least
one search provider key) to `$HERMES_HOME/.env`. Then add any settings from this package's
`.env.example` that you want to change.

### Try it

```sh
python3 job_scanner.py --test-email              # SMTP check only
python3 job_scanner.py --dry-run --limit 5       # full pipeline, no email, no state update
```

A dry run writes the rendered email to `state/job_scanner_last.html` and the raw results to
`state/job_scanner_last.json`.

### Indeed MCP source

Indeed publishes an [MCP server](https://docs.indeed.com/mcp) for job search and job details.
Hermes handles the connection and OAuth. The scanner reuses Hermes' authorised session, so it
never sees or stores Indeed credentials.

1. Add the server to Hermes, either from the dashboard's MCP catalog (**indeed**) or in
   `config.yaml`:

   ```yaml
   mcp_servers:
     indeed:
       url: https://mcp.indeed.com/claude/mcp
       auth: oauth
       enabled: true
   ```

2. Authorise once. Either approve it from the dashboard's MCP page, or run the login
   interactively and approve access in the browser:

   ```sh
   docker exec -it -u hermes hermes-agent hermes mcp login indeed   # or: hermes mcp login indeed
   hermes mcp test indeed                                           # should list the Indeed tools
   ```

3. Restart the Hermes session so the tools load, then run a dry run. The log shows one
   `indeed '<query>' ...` line per query.

Tokens are stored by Hermes in `$HERMES_HOME/mcp-tokens/` and refreshed by Hermes. Until the
server is authorised, the scanner logs `Indeed MCP: not authorised yet` and carries on with the
other sources, so a missing or expired login never breaks the report. Set `JOB_INDEED=0` (or pass
`--no-indeed`) to turn the source off.

The Indeed source needs Hermes' Python environment (the MCP SDK and Hermes' `tools` package), so
run the scanner inside the `hermes-agent` container, which is how Hermes cron runs it. Tool and
argument names are read from the server's tool list at run time. If Indeed renames a tool, pin it
with `JOB_INDEED_SEARCH_TOOL` / `JOB_INDEED_DETAIL_TOOL`.

### Schedule it

```sh
hermes cron create "0 7 * * *" "Daily vacancy report" \
    --name daily-vacancy-report --script job_scanner.py --no-agent --deliver local
hermes cron list
```

Cron times are in the container's timezone, which is usually UTC.

## Command-line options

| Option | Effect |
| --- | --- |
| `--dry-run` | Do everything except send the email and update seen-state |
| `--test-email` | Send a short SMTP test email and exit |
| `--limit N` | Scrape and rate at most N job pages this run |
| `--include-seen` | Re-rate jobs reported in previous runs |
| `--no-search` | Board listings only (nijobs.com, Indeed); skip web searches |
| `--no-indeed` | Skip the Indeed MCP source for this run |

## Configuration

Every option is an environment variable (or a line in `$HERMES_HOME/.env`). See
[`.env.example`](.env.example) for the full list with defaults. The most important ones are:

- **`JOB_REGION_NAME`, `JOB_REGION_PLACES`, `JOB_REGION_REGEX`.** Restrict results to one region.
  With none of these set, jobs from any location are kept.
- **`JOB_SEARCH_LOCATION`, `JOB_SCANNER_QUERIES`.** Control what gets searched. The default queries
  target AI / ML / automation / data roles, with your location inserted.
- **`JOB_INDEED_QUERIES`, `JOB_INDEED_LOCATION`, `JOB_INDEED_DOMAIN`.** What the Indeed source
  searches for (plain job titles, `||`-separated), where, and which Indeed site the job links point
  to (for example `uk.indeed.com`).
- **`JOB_TITLE_STRONG`, `JOB_TITLE_MEDIUM`.** Title regexes deciding which results are worth
  fetching.
- **`JOB_SENIOR_PENALTY`, `JOB_LEAD_PENALTY`.** Lower the score of Senior or Lead titles if you
  are not targeting them.
- **`JOB_SCANNER_MIN_SCORE`.** The cut-off (0-10) for a job to appear in the report.

### Writing a good profile

`job_profile.md` is sent verbatim to the model for every job. It works best when it states:

- Your current role and years of experience.
- Your concrete skills.
- The titles and seniority you want.
- Your deal-breakers.
- Your honest gaps.

The keys in `cv_keywords.json` are the only labels the model may use as "matched skills". The
regex values are also used to compute keyword coverage directly from the job text. Entries under
`other_tech` are shown as possible gaps.

## Cost and runtime

A typical run uses 4 searches plus up to `JOB_SCANNER_MAX_SCRAPE` page fetches, roughly 20-40
Firecrawl credits. Indeed searches and job details go through the MCP server and use no web
credits; the report footer shows how many Indeed calls a run made. When Firecrawl credits drop below `JOB_SCANNER_MIN_CREDITS`, the scanner
switches to your backup keys, then Tavily and Scrapfly. Rating takes 10-40 seconds per job on a
4B model running on a CPU.

# Screenshots

Every email, PDF and web page HermitShell produces, with what each part does. All of them use
fictional data: the example candidate Alex Morgan, made-up employers (Northwind Traders, Contoso
Health, Fabrikam...) and `example.com` addresses.

- [Daily report](#daily-report)
- [Weekly roll-up](#weekly-roll-up)
- [Cover letters and tailored CVs](#cover-letters-and-tailored-cvs)
- [Profile emails](#profile-emails)
- [Test emails](#test-emails)
- [Button pages](#button-pages)
- [Sign-up page](#sign-up-page)
- [Admin page](#admin-page)
- [Regenerating these images](#regenerating-these-images)

## Daily report

The email `job_scanner.py` sends each morning.
[Full-length version](images/emails/daily-report.png).

<img src="images/daily-vacancy-report.png" alt="Top of the daily report" width="640">

**Header.** Your region (`JOB_REGION_NAME`) and the run time, the report title and tagline
(`JOB_REPORT_TITLE`, `JOB_REPORT_TAGLINE`), then four figures: matches in this email, strong fits
(7 or more, in green), the average fit and how many jobs were rated this run.

**HermitShell's take.** A short summary the model writes over all the matches: what to apply for
first and which gaps keep coming up.

**Sections.** *Top matches* (fit 7+) come first and *Worth a look* (below 7, down to
`JOB_SCANNER_MIN_SCORE`) second. Inside each, jobs closing within three days go first. *Follow up*
lists jobs you marked **I applied** with no reply after 7 and 14 days.

### A job card

<img src="images/emails/daily-report-card.png" alt="One job card" width="640">

From top to bottom:

| Part | What it shows |
| --- | --- |
| Avatar | The employer's logo from its website, or coloured initials when none is found |
| `#1 · JOBS.EXAMPLE.COM` | Rank in this email and where the job was found |
| Title, company, location | The title links to the listing; the company links to its website |
| Salary | The advertised pay as a headline. Day and hourly rates also show a yearly estimate. Jobs clearly below `JOB_MIN_SALARY` never get here |
| Pills | Closing date (red within three days), employment type, work mode, level (or "Senior-level stretch"), posting age; "Salary not listed" when there is none |
| Fit circle | The final 0-10 score: green 8+, teal 7, amber 5-6, red below 5 |
| Meters | **HermitShell fit**, the model's **Confidence**, and **CV keyword match** (the share of technologies in the listing that are on your CV) |
| Reasoning | The model's one or two sentences on why it scored the job this way |
| About the company | Industry, size, website and a one-line description. For agency adverts it names the real employer and the agency separately |
| Strongest matches | Your three strongest matching skills in bold, the rest on one line |
| Missing from your CV | Skills the listing asks for that your CV lacks. Tap one you do have to add it ([how](feedback-worker.md#adding-missing-skills)) |
| Buttons | Thumbs up (**Good match**) and thumbs down (**Not for me**) under the score; **View job**, **I applied** and **Interested** below a divider; **Cover letter** and **Tailored CV** side by side in a "Made for this job" panel ([button pages](#button-pages)) |
| Notes | "Checked twice" when a stricter second look lowered the score, and other agencies advertising the same job |

The buttons and tags only appear when the [feedback Worker](feedback-worker.md) is set up.

### Notices, CV additions and shortened entries

<img src="images/emails/daily-report-notices.png" alt="Report with a source warning, CV additions and one-line entries" width="640">

- **Check your sources** (amber) lists search providers that failed or found nothing, and a
  feedback Worker that didn't answer.
- **Added to your CV** (cyan) lists skills you added from the missing-skill tags that were merged
  into your CV this run.
- **More matches**: when the email would be clipped by Gmail (over about 100 KB), the
  lowest-ranked jobs become one-line entries with text links instead of full cards.
- **Footer**: the filters in force, how many jobs each filter excluded, the model, the sources, the
  web credits used, how fit penalties work, and the **Unsubscribe** link.

### No new matches

<img src="images/emails/daily-report-empty.png" alt="Report with no new matches and a follow-up section" width="640">

Sent when only follow-ups are due, or on every run with `JOB_SCANNER_EMAIL_WHEN_EMPTY=1`. The
**Heard back** and **Rejected** buttons update the application in your tracker.

## Weekly roll-up

`job_weekly.py`, Sundays at 18:00 by default.

<img src="images/emails/weekly.png" alt="Weekly roll-up" width="640">

The header shows jobs rated, jobs emailed, average fit and applications this week. Then:

- **Best of the week**: the five highest-scoring jobs emailed to you.
- **Applications**: everything you marked **I applied**, how long ago, and its status (Waiting,
  Heard back, Rejected), plus a count of your button presses this week.
- **Skills that keep coming up as gaps**: the most common missing skills, with how many
  listings asked for each.
- **Who is hiring**: the employers with the most roles this week.
- **Fit scores this week**: how the ratings spread over 9-10, 7-8, 5-6 and 0-4.
- **Source health**: postings found per source. Amber means a source had failed or empty runs.

## Cover letters and tailored CVs

Press **Cover letter** or **Tailored CV** on a job, confirm, and within about 10 minutes you get
an email with a PDF attached ([how it works](feedback-worker.md#cover-letters)).

<table>
<tr><th>Cover letter email</th><th>Cover letter PDF</th></tr>
<tr>
<td><img src="images/emails/cover-letter.png" alt="Cover letter email" width="400"></td>
<td><img src="images/emails/cover-letter-pdf.png" alt="Cover letter PDF" width="340"></td>
</tr>
<tr><th>Tailored CV email</th><th>Tailored CV PDF</th></tr>
<tr>
<td><img src="images/emails/tailored-cv.png" alt="Tailored CV email" width="400"></td>
<td><img src="images/emails/tailored-cv-pdf.png" alt="Tailored CV PDF" width="340"></td>
</tr>
</table>

The email repeats the job details (employer, agency, location, type, salary, closing date, fit),
your note from the confirmation page, and a preview: the letter's paragraphs, or the CV's
headline, profile and skills. The letter uses your name and `COVER_LETTER_CONTACT`; the CV only
reorders and rephrases what is already on your CV, keeping titles, employers and dates.

## Profile emails

Sent by `profiles.py` when you use [extra profiles](feedback-worker.md#extra-profiles-and-the-admin-page).

<table>
<tr><th>Welcome (to the new person)</th><th>New profile (to you)</th></tr>
<tr>
<td><img src="images/emails/welcome.png" alt="Welcome email" width="400"></td>
<td><img src="images/emails/owner-new-profile.png" alt="New profile notice" width="400"></td>
</tr>
<tr><th>Unsubscribed (to you)</th><th>Goodbye (to the person who left)</th></tr>
<tr>
<td><img src="images/emails/owner-unsubscribed.png" alt="Unsubscribe notice" width="400"></td>
<td><img src="images/emails/goodbye.png" alt="Goodbye email" width="400"></td>
</tr>
</table>

- **Welcome** lists the job titles HermitShell will search for and the skills it read from the CV, so
  the person can reply if something is wrong. It is sent again as "Profile updated" when they
  send a new CV.
- **Notices to you** share one layout, with a count of active and paused profiles and a
  **Manage profiles** link: new profile, profile updated, unsubscribed (with their feedback),
  your own CV rebuilt from the dashboard, and sign-ups that couldn't be applied.
- **Goodbye** is the last email an extra profile gets: it confirms that their profile, CV and
  history are deleted and their name and email removed from the logs.

## Test emails

<table>
<tr><th>From the dashboard's test button</th><th><code>job_scanner.py --test-email</code></th></tr>
<tr>
<td><img src="images/emails/test-email.png" alt="Dashboard test email" width="400"></td>
<td><img src="images/emails/smtp-test.png" alt="SMTP test email" width="400"></td>
</tr>
</table>

Both only check that the SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`,
`SMTP_FROM`) can send. The setup wizard sends the second one at the end.

## Button pages

Every button in an email opens a page on the feedback Worker. Nothing is saved until you press
**Confirm**, so mail scanners that open links can't record answers.

<table>
<tr><th>Good match</th><th>Not for me</th><th>Interested</th></tr>
<tr>
<td><img src="images/worker/confirm-good-match.png" alt="Good match" width="260"></td>
<td><img src="images/worker/confirm-not-for-me.png" alt="Not for me" width="260"></td>
<td><img src="images/worker/confirm-interested.png" alt="Interested" width="260"></td>
</tr>
<tr><th>I applied</th><th>Heard back</th><th>Rejected</th></tr>
<tr>
<td><img src="images/worker/confirm-applied.png" alt="I applied" width="260"></td>
<td><img src="images/worker/confirm-heard-back.png" alt="Heard back" width="260"></td>
<td><img src="images/worker/confirm-rejected.png" alt="Rejected" width="260"></td>
</tr>
<tr><th>Cover letter</th><th>Tailored CV</th><th>Add to my skills</th></tr>
<tr>
<td><img src="images/worker/confirm-cover-letter.png" alt="Cover letter" width="260"></td>
<td><img src="images/worker/confirm-tailored-cv.png" alt="Tailored CV" width="260"></td>
<td><img src="images/worker/confirm-add-skill.png" alt="Add to my skills" width="260"></td>
</tr>
</table>

- The note box is optional. Notes on **Not for me** and **Good match** are shown to the model as
  examples of what you want; notes on **Cover letter** and **Tailored CV** guide what it writes.
- **Add to my skills** lists the job's missing skills with the one you tapped already ticked,
  plus a box for any others.

After **Confirm**:

<table>
<tr><th>Saved</th><th>Cover letter requested</th><th>Tailored CV requested</th></tr>
<tr>
<td><img src="images/worker/saved.png" alt="Saved" width="260"></td>
<td><img src="images/worker/saved-cover-letter.png" alt="Cover letter requested" width="260"></td>
<td><img src="images/worker/saved-tailored-cv.png" alt="Tailored CV requested" width="260"></td>
</tr>
<tr><th>Skills added</th><th>No skill ticked</th><th></th></tr>
<tr>
<td><img src="images/worker/saved-add-skill.png" alt="Skills added" width="260"></td>
<td><img src="images/worker/saved-nothing-selected.png" alt="No skill ticked" width="260"></td>
<td></td>
</tr>
</table>

### Unsubscribe

<table>
<tr><th>Extra profile</th><th>Your own reports</th><th>Confirmed</th></tr>
<tr>
<td><img src="images/worker/confirm-unsubscribe.png" alt="Unsubscribe an extra profile" width="260"></td>
<td><img src="images/worker/confirm-unsubscribe-owner.png" alt="Pause your own reports" width="260"></td>
<td><img src="images/worker/saved-unsubscribe.png" alt="Unsubscribed" width="260"></td>
</tr>
</table>

For an extra profile it deletes the profile, CV and history; for you (the owner) it only pauses
your reports.

### Link problems

<table>
<tr><th>Changed or incomplete link</th><th>Older than 90 days</th><th>Profile deleted</th></tr>
<tr>
<td><img src="images/worker/link-invalid.png" alt="Link not valid" width="260"></td>
<td><img src="images/worker/link-expired.png" alt="Link expired" width="260"></td>
<td><img src="images/worker/link-profile-removed.png" alt="Profile removed" width="260"></td>
</tr>
</table>

"Link not valid" on every button usually means the Worker's `JOB_FEEDBACK_SECRET` differs from
the one in `.env` ([troubleshooting](feedback-worker.md#troubleshooting)).

## Sign-up page

`/join?i=<invite>`, the link you create on the admin page. Each link works once and expires after
7 days.

<table>
<tr><th>Form</th><th>Missing CV</th></tr>
<tr>
<td><img src="images/worker/join-form.png" alt="Sign-up form" width="340"></td>
<td><img src="images/worker/join-error.png" alt="Sign-up form with an error" width="340"></td>
</tr>
<tr><th>Done</th><th>Used or expired invite</th></tr>
<tr>
<td><img src="images/worker/join-thanks.png" alt="Sign-up done" width="340"></td>
<td><img src="images/worker/join-expired.png" alt="Invite not valid" width="340"></td>
</tr>
</table>

| Field | Used for |
| --- | --- |
| Full name | Their reports, cover letters and CVs |
| Email for your reports | Where their reports go; also stops one invite taking over another profile |
| Phone, where you live | Optional; shown on cover letters |
| Roles you are looking for | Turned into job titles and search queries by the model |
| CV file or pasted CV | PDF, Word .docx or text up to 5 MB; the pasted text is used when a file can't be read |
| Consent | Required; every report has an unsubscribe link that deletes the data |

### Privacy page

`/privacy`, linked from the consent box, the welcome email and the unsubscribe pages. It tells
people who join what is kept, why, where, for how long, how it is protected and how to have it
deleted ([data protection](configuration.md#data-protection)).

<img src="images/worker/privacy.png" alt="How your data is handled" width="520">

## Admin page

`/admin` on the feedback Worker, off until `ADMIN_PASSWORD` is set
([setup](feedback-worker.md#extra-profiles-and-the-admin-page)).

<table>
<tr><th>Sign-in</th><th>Wrong password</th><th>Locked for 15 minutes</th></tr>
<tr>
<td><img src="images/worker/admin-login.png" alt="Admin sign-in" width="260"></td>
<td><img src="images/worker/admin-login-wrong.png" alt="Wrong password" width="260"></td>
<td><img src="images/worker/admin-locked.png" alt="Too many attempts" width="260"></td>
</tr>
<tr><th>Behind Cloudflare Access, without a code</th><th></th><th></th></tr>
<tr>
<td><img src="images/worker/admin-access-required.png" alt="Cloudflare Access required" width="260"></td>
<td></td><td></td>
</tr>
</table>

### Profiles

<img src="images/worker/admin-dashboard.png" alt="Admin page with three profiles" width="760">

| Control | What it does |
| --- | --- |
| Status line | **HermitShell is connected** (green dot) while its live link is up, so changes reach it within seconds, then when it last reported its profiles. Without the link: when HermitShell last checked in, with the time in your timezone (`HERMES_TIMEZONE`). Also lists changes still **Waiting for HermitShell**. A warning appears above it if HermitShell hasn't checked in for 45 minutes |
| Profile, Status | Name, email and start date, **no CV** when there is none yet; owner, active or paused; time of the last report |
| **Manage** | Opens [that profile's page](#a-profiles-page): details, job search and CV |
| Crawler: **Their Firecrawl key** + **Save** | Gives that profile its own Firecrawl key, used instead of the global one |
| **Use global key** | Takes a profile back to the global key |
| **Pause** / **Resume** | Stops or restarts that profile's reports |
| **Delete** (with the tick box) | Deletes an extra profile's CV and history from your server. The owner can't be deleted |
| **Profiles** / **Global settings** tabs | Switch between the profiles and the [settings shared by the whole tool](#global-settings) |
| Invite someone + **Create invite link** | Makes a one-time `/join` link; the note is only for you |
| **Revoke** | Cancels an unused invite |
| **Sign out** | Ends every admin session |

<table>
<tr><th>Right after setup: the checklist</th><th>Before HermitShell has reported</th><th>New invite link</th></tr>
<tr>
<td><img src="images/worker/admin-dashboard-setup.png" alt="Admin page with the setup checklist and a rejected change" width="300"></td>
<td><img src="images/worker/admin-dashboard-empty.png" alt="Admin page before the first report" width="300"></td>
<td><img src="images/worker/admin-invite-link.png" alt="New invite link" width="260"></td>
</tr>
</table>

The checklist stays until HermitShell has connected, the email server is set and a test worked, a web
search key is in, and your CV and job search are set. **HermitShell could not apply** lists changes
HermitShell rejected in the last day, with the reason.

### Global settings

`/admin/settings`: the email server and web search keys every profile uses.

<img src="images/worker/admin-settings.png" alt="Global settings: email server and web search API keys" width="620">

| Control | What it does |
| --- | --- |
| Email server + **Save email server** | SMTP server, port, username, password and sender for everyone's emails. The password box stays empty; leave it empty to keep the saved password |
| **Send a test email** | Sends a test to the address typed (default: yours); the result shows under Email server after HermitShell's next check |
| **Go back to the .env email settings** | Shown when the email server was set here; undoes it |
| Web search API keys + **Save keys** | Firecrawl (several, comma separated), Tavily and Scrapfly keys for everyone without their own; empty boxes leave a key as it is |
| **Use the .env key** | Shown next to a key set here; goes back to the one in `.env` |

Keys are shown only as `fc-...1234`. Keys typed here are removed from the Worker after 2 days if
HermitShell hasn't collected them.

### A profile's page

<img src="images/worker/admin-profile.png" alt="A profile's settings page" width="620">

| Section | What it sets |
| --- | --- |
| **Back to profiles** | Floats in the top-left corner while you scroll |
| Status box | Under the tabs: **Up to date**, **Waiting for HermitShell** while a save is queued (it checks again by itself), **Applied by HermitShell**, or why a change couldn't be applied |
| Details | Name, the email address reports go to, phone and home town (for cover letters) |
| Job search | Job titles (up to 8), region or city (used in web searches), country from a list, towns, remote elsewhere, seniority, minimum salary (empty = none) and currency, employment types, work location, hiding unnamed agency adverts |
| **Save changes** | One button for details and job search; only the fields you changed are sent |
| CV + **Upload CV** | A new CV file or pasted text; HermitShell rebuilds the profile and skills from it and emails a summary |

<table><tr><th>Just saved</th><th>Someone else changed the same field</th></tr>
<tr><td><img src="images/worker/admin-profile-saved.png" alt="Profile page right after saving, waiting for HermitShell" width="380"></td>
<td><img src="images/worker/admin-profile-conflict.png" alt="Profile page showing a clash with another change" width="380"></td></tr></table>

After **Save changes** the form keeps the saved values (the page lays every change still waiting
for HermitShell over what it last reported) and the status box follows it until it is applied. If
someone else changed the same field since you opened the page, nothing is saved: the box lists each
clashing field with both values and your version stays in the form, so **Save changes** again keeps
yours. Changes to different fields are both kept.

## Regenerating these images

The pictures are made by the real code, so they stay accurate after a change. Run this from the
repository root with Python, Node.js 18+ and Chrome, Chromium or Edge installed:

```sh
pip install requests pillow pymupdf
python3 scripts/screenshots/make.py                 # rewrites docs/images/{emails,worker}/ and the README image
python3 scripts/screenshots/make.py --chrome /usr/bin/chromium --out /tmp/shots
```

`make.py` renders the emails and PDFs with fictional data in a temporary Hermes home (your own
`.env` and state are never read), `worker_pages.mjs` runs the Worker in memory to produce each
page, and headless Chrome takes 2x screenshots trimmed to the content.

# Email rendering

HermitShell emails are designed for Gmail on the web, Android and iOS, which is the most
restrictive of the common clients. They also render in Outlook and Apple Mail. This page
explains the techniques, for anyone building a new package.

## Layout

<img src="images/emails/daily-report-card.png" alt="A job card" width="520">

- Tables for layout, with all CSS inline. Some clients drop `<style>` blocks, and Outlook
  ignores flexbox and grid. See [Size](#size-staying-under-gmails-clipping-limit) for the one
  case where styles are moved into classes.
- A centred 680px content column (`max-width`) with percentage widths inside, so it shrinks on
  phones.
- Every email also has a plain-text part (`multipart/alternative`), for clients that block HTML.

## Phones

<img src="images/emails/daily-report-phone.png" alt="The daily report at phone width" width="300">

On a narrow screen a table cell shrinks to fit its content, so anything drawn with a cell's
size or padding gets squashed. The base layout avoids that without relying on media queries:

- Circles (company initials, the score) are `<div>`s with a fixed `width`, `height`,
  `min-width` and `line-height`, not table cells, so they stay round.
- Bars are nested `<div>`s with a percentage width inside a fixed-height track. Empty cells
  used as bars collapse to nothing in some clients.
- Anything long gets its own row instead of sharing one with fixed-width columns. On the job
  card, the salary and tags sit under the title, and the score column keeps a fixed width.
- `table-layout:fixed` on grids such as the meters, so columns split evenly.

`EMAIL_HEAD` also has a separate `<style>` block with a `max-width:540px` media query, for
clients that support it (Gmail's apps with a Gmail account do). It is separate so an error in
it can't make Gmail drop the dark-mode block. Its classes need `!important` to beat inline
styles, and `compact_html()` leaves tags that already have a class alone:

| Class | On a phone |
| --- | --- |
| `m-wrap`, `m-pad`, `m-head` | Tighter outer, card and header padding |
| `m-stack` | Cell becomes a full-width block, so side-by-side cells stack |
| `m-inline`, `m-below` | Paired with `m-stack` to drop a cell under its neighbour |
| `m-flush` | Removes the left indent under the avatar |
| `m-sep` | Narrower gap before each header stat |
| `m-num`, `m-title`, `m-score`, `m-label` | Smaller header numbers, title, score circle and meter labels |

`scripts/screenshots/make.py` renders `emails/daily-report-phone.png` at 390px wide to check
this. Headless Chrome won't make a window narrower than 500px, so it loads the email in a
390px iframe and crops.

## Size: staying under Gmail's clipping limit

Gmail cuts off any message whose HTML is over 102 KB and shows "[Message clipped] View entire
message". Anything after the cut is hidden, including buttons, and inline images from the hidden
part show up as loose attachments. Inline styles repeated on every card add up quickly: 16 job
cards came to 126 KB.

`send_email()` runs `hermes_common.compact_html()` on every email, so packages don't need to
handle this themselves:

1. Under `EMAIL_HTML_BUDGET` (95 KB) the email is sent unchanged, with all styles inline.
2. Otherwise whitespace between tags is collapsed.
3. If it's still too big, inline styles that repeat on tags without a `class` move into short
   classes (`.h0`, `.h1`, ...) in `<style>` blocks. These stay inside Gmail's limits: each block
   is under 8,192 characters, the total is under 16 KB, and there are no `url(`, gradients or
   `background-image`, any of which makes Gmail drop the whole block. Tags that already have a
   class, such as the dark-mode wrappers, keep their inline styles.

The result renders the same: the 126 KB report became 69 KB with identical computed styles on
every element. The vacancy report also uses `fitted_html()`. If the compacted email is still
over budget, the lowest-ranked jobs appear as one-line entries under "More matches" instead of
full cards. They keep the feedback buttons and their icons (`mini_buttons()`), at a smaller size.

## Images: inline attachments, not SVG or remote URLs

Gmail strips inline `<svg>` and SVG images, and many clients block remote images by default.
Icons and company logos are therefore:

1. Stored as PNGs rendered at 3x for sharpness. `packages/daily-vacancy-report/icons/build_icons.py`
   rasterises the SVG sources with PyMuPDF.
2. Referenced in the HTML as `<img src="cid:name">`.
3. Attached as `multipart/related` parts by `hermes_common.inline_images()` and `send_email()`.

Dry runs rewrite `cid:` references to relative file paths in `state/*_last.html`, so the
preview opens correctly in a browser.

## Gmail dark mode

Gmail's mobile apps invert text colours in dark mode but leave background images and gradients
alone. White text on a dark gradient header becomes dark text on a dark header, which is
unreadable.

`hermes_common.EMAIL_HEAD` and `gmail_dark_safe()` fix this:

```html
<style>
u + .body .gmail-screen { background:#000000; mix-blend-mode:screen; }
u + .body .gmail-difference { background:#000000; mix-blend-mode:difference; }
</style>
<div class="gmail-screen"><div class="gmail-difference">…header text…</div></div>
```

The `u + .body` selector only matches inside Gmail, which wraps the body in a `<u>` sibling.
The two blend modes cancel Gmail's inversion and restore the original light text. Other clients
see `color-scheme: light only` and keep the light design.

Keep images out of `gmail_dark_safe()` wrappers, because blend modes invert them too.

## Text hygiene

- Model output is cleaned of em and en dashes (`hermes_common.plain_dashes`), so generated
  prose reads naturally.
- Summaries are trimmed at whole-sentence boundaries, never mid-word.
- Subjects stay short: `Daily Vacancy Report: 8 new jobs`, `Daily Vacancy Report: your week (40 rated, 3 applied)`.

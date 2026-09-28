# Email rendering

HermitShell emails are designed for Gmail on the web, Android and iOS, which is the most
restrictive of the common clients. They also render in Outlook and Apple Mail. This page
explains the techniques, for anyone building a new package.

## Layout

- Tables for layout, with all CSS inline. Gmail drops most `<style>` rules, and Outlook ignores
  flexbox and grid.
- A centred 680px content column (`max-width`) with percentage widths inside, so it shrinks on
  phones.
- Every email also has a plain-text part (`multipart/alternative`), for clients that block HTML.

## Images: inline attachments, not SVG or remote URLs

Gmail strips inline `<svg>` and SVG images, and many clients block remote images by default.
Icons and company logos are therefore:

1. Stored as PNGs rendered at 3x for sharpness. `packages/news-digest/icons/build_icons.py`
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

Keep images out of `gmail_dark_safe()` wrappers, because blend modes invert them too. The
digest's sun icon sits in its own table cell for that reason.

## Text hygiene

- Model output is cleaned of em and en dashes (`hermes_common.plain_dashes`), so generated
  prose reads naturally.
- Summaries are trimmed at whole-sentence boundaries, never mid-word.
- Subjects stay short: `Daily Vacancy Report: 8 new jobs`, `News Digest: 23 stories`.

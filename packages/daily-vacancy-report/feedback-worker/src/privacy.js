// /privacy: what HermitShell keeps about someone who joins, where, for how long, and how to have it deleted.
// Linked from the sign-up form, the unsubscribe page and the welcome email. Keep in step with PRIVACY.md.

import { page } from "./lib.js";

const SECTIONS = [
  ["Who runs this", `These reports come from a HermitShell server run by the person who invited you. They decide how it
is set up and are the one to contact: reply to any report with a question or request.`],
  ["What is kept", `Your name, email address, optional phone number and town, the roles you want and your CV.
Then the jobs found for you, the buttons you press and notes you type, and the cover letters and tailored CVs you
ask for.`],
  ["Why", `To find and rate job adverts for you and write the letters and CVs you request. You agreed to this on the
sign-up form and can withdraw at any time with the unsubscribe link.`],
  ["Where", `Your CV and details are read on the HermitShell server, by an AI model running on that server, unless the
operator has chosen a cloud AI service instead (OpenRouter, BazaarLink, Featherless or Hugging Face, for servers that
cannot run one): then your CV, details and the job adverts are sent to that service to be rated and written about, and
its free models may keep what they are sent. This page, the sign-up form and the email buttons run on Cloudflare Workers, where what you send waits
only until HermitShell collects it (at most 30 days); the operator's admin page there lists your name and email address,
a stats page of counts (jobs found, buttons pressed, the employers and titles of jobs sent) and the jobs sent to you in
the last 90 days (each advert's title, employer, place, salary, link, the details shown on its email card and the last
button you pressed on it), never your notes, until HermitShell next reports that you have left. A job that also suited
you can show your match score on another job seeker's list, only to those who can sign in to your page, and an encrypted
desk page counts the jobs sent to you and how far your applications got (with any placement fee shown only to the
admins). It also keeps a history of
what was done for you (changes to your profile, the requests and buttons you or the operator pressed with each job's title,
and the reports that ran), never your notes, until you unsubscribe or are deleted. Your recruiter and the admins can
keep their own notes and short tags about you there (for example how a call went), encrypted, until you unsubscribe or
are deleted. Only the operator's admins
and your recruiter (the person who invited you, unless the operator moves you to another) can sign in to that page. Cover letters,
tailored CVs and interview prep packs made for you are also kept there, encrypted, for 7 days so they can be downloaded
again (a prep pack is built only from your CV and the job's advert, with nothing looked up about you or the employer), and a CV made from
the one you uploaded is kept there, encrypted, until a new one replaces it or you unsubscribe. When the
operator emails you a job from that list, the time it was sent is kept for 90 days (with a scrambled form of the job's
link, not the link itself). Job searches send
job titles and a location to web search services, never your CV or contact details. Emails go through the operator's
email provider.`],
  ["How long", `Everything is kept while you are subscribed, except that by default jobs, answers, letters and CVs
older than 12 months and logs older than 90 days are deleted, and letters and CVs kept for download on Cloudflare are
deleted after 7 days (the CV made from yours, when the next one replaces it). Encrypted nightly backups are kept for about two
months (14 daily and 8 weekly copies), then deleted.`],
  ["How it is protected", `Every connection uses HTTPS. On the server your files are readable only by HermitShell's
account and, when the operator has turned encryption on, your CV, profile, letters and CVs are encrypted
(AES-256-GCM), as are the backups. Email buttons are signed and stop working after 90 days.`],
  ["Deleting your data", `The unsubscribe link at the end of every report deletes your profile, CV, jobs, answers,
letters and tailored CVs from the server, drops anything still waiting on Cloudflare and your history and the notes
about you there, removes your name and email
address from the logs and emails you a confirmation. Copies in the encrypted backups disappear as those backups are
rotated out. For a copy of your data or a correction, reply to any report.`],
];

export function privacyPage() {
  const body = SECTIONS.map(([heading, text]) => `<h2>${heading}</h2><p>${text.replace(/\s*\n\s*/g, " ")}</p>`).join("");
  return page("How your data is handled", body, { wide: true });
}

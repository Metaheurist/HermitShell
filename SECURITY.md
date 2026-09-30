# Security policy

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub instead: the repository's
**Security** tab, then **Report a vulnerability**
([direct link](https://github.com/Metaheurist/HermitShell/security/advisories/new)).

Say what is affected, how to reproduce it and what an attacker could do with it. Use fictional
data and throwaway keys in the report, never a real CV, email address or live secret. You'll get a
reply within a week, and a fix is announced in the [changelog](CHANGELOG.md) and credited to you
if you like once it is released.

## Supported versions

Fixes go into `main` and the container image published from it (`latest-build`). A container set
up with [`install-updater.sh`](docs/installation.md#keep-the-container-up-to-date) picks them up by
itself; a service install gets them with `git pull` and a restart. After a fix to the feedback
Worker, redeploy it as well (the dashboard says when HermitShell and the Worker differ).

## Scope

In scope: the Python code (`common/`, `packages/`, `scripts/`), the feedback Worker
(`packages/daily-vacancy-report/feedback-worker/`), the container image and the install scripts.

Out of scope: how a particular server is set up (its own firewall, `.env` or Cloudflare account),
the third-party services HermitShell can use (Cloudflare, Ollama, cloud AI models, web search
providers, the email server) and the free-plan limits of those services.

## How HermitShell protects data

- **No secrets in the code.** Keys and passwords live only in the server's `.env` and the Worker's
  encrypted secrets, and every push is scanned for leaked secrets across the whole history.
  See [Keeping secrets safe](docs/configuration.md#keeping-secrets-safe).
- **Encryption at rest.** With `HERMES_DATA_KEY` set (the wizard generates one), CVs, profiles,
  cover letters, tailored CVs, saved job reports and backups are encrypted with AES-256-GCM, and
  every file is created readable by HermitShell's account only. Logs, which are not encrypted, name
  the roles but never keys, employers or salaries. See [Data protection](docs/configuration.md#data-protection).
- **A signed, HTTPS-only link to the Worker.** Every request is signed with HMAC-SHA256 over the
  method, path, body, time and a one-time nonce, and is refused if it is altered, replayed or more
  than five minutes old. Redirects are never followed.
- **Secrets sealed for the server.** Passwords, API keys and CVs entered on the dashboard or the
  sign-up form are encrypted with the server's public key (RSA-OAEP wrapping AES-256-GCM) before
  they are stored on Cloudflare, so only the server can read them.
- **A locked-down dashboard.** Signed-in sessions with secure cookies, CSRF tokens on every form that changes something, a
  Content-Security-Policy that blocks inline and outside scripts (signed-in pages load only the Worker's
  own `/enhance.js`; public pages run none), and roles: recruiters see only their own candidates.
  It can also sit behind Cloudflare Access.
- **Signed email buttons.** Changed or made-up links are refused, and links stop working after 90
  days. Opening one saves nothing until the person presses **Confirm**.
- **A hardened container.** A read-only, unprivileged image running as its own user, with all
  capabilities dropped, scanned for known CVEs before it is published.
- **Personal data.** Retention periods, encrypted rotated backups, and unsubscribing deletes a
  person's data and scrubs them from the logs. What people are told is in [PRIVACY.md](PRIVACY.md).

The full details are in [How it stays safe](docs/feedback-worker.md#how-it-stays-safe). Every push
runs the security tests, CodeQL, Bandit and dependency CVE audits, and they run again every Monday;
see [Tests and CI](README.md#tests-and-ci).

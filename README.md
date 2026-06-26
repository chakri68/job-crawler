# job-cron

Watches official company career pages (API-first) and alerts on new matching
jobs. On demand, tailors a base resume to a specific job with a headless Claude
Code instance and renders a PDF.

See [`design.md`](./design.md) for the full design.

## Requirements

- **Node 24+** (runs `.ts` directly, uses built-in `node:sqlite` — no build step, no native deps)
- `claude` CLI on PATH (only for `tailor`)
- `resume-to-pdf` CLI on PATH (only for the PDF step of `tailor`; or set `RESUME_PDF_CLI`)

## Setup

```bash
npm install                       # dev types only; nothing runtime-critical
cp config.example.json config.json   # then edit sources/filters
cp .env.example .env                 # then fill in your webhook/bot secrets
```

Secrets are read from a `.env` file in the project root (loaded automatically at
startup via Node's built-in `process.loadEnvFile` — no dependency). Real shell
environment variables still take precedence, so you can also just
`export DISCORD_WEBHOOK_URL=...` instead. Without any of these, alerts fall back
to the console.

### Notifiers

Set `notifier` in `config.json`. Without a configured channel, alerts fall back to the console/journal.

```jsonc
// Discord
"notifier": { "type": "discord", "webhookUrlEnv": "DISCORD_WEBHOOK_URL" }

// Telegram — webhookUrlEnv holds the bot token, chatIdEnv the target chat id
"notifier": { "type": "telegram", "webhookUrlEnv": "TELEGRAM_BOT_TOKEN", "chatIdEnv": "TELEGRAM_CHAT_ID" }
```

For Telegram, create a bot via [@BotFather](https://t.me/BotFather) for the token, then:

```bash
export TELEGRAM_BOT_TOKEN=123456:ABC-DEF...   # from @BotFather
export TELEGRAM_CHAT_ID=...                    # your user/group/channel chat id
```

### Install globally (optional)

Link the CLI once so you can run `job-cron` from any directory instead of typing
`node src/cli.ts`:

```bash
npm link              # symlinks a global `job-cron` → this repo (no sudo with nvm)
job-cron              # now works anywhere — opens the TUI
job-cron status       # …or any subcommand
```

`npm link` points the global `job-cron` straight at this repo, so edits you make
here take effect immediately — no re-linking. Your `config.json`, `data/jobs.db`,
and `resumes/` are always read from **this project folder** (paths resolve
relative to the source), no matter which directory you invoke the command from.

To remove it:

```bash
npm unlink -g job-cron        # or: npm rm -g job-cron
```

Caveats / alternatives:
- **nvm:** the link lives in the *current* Node version's bin dir. After
  `nvm use <other-version>`, re-run `npm link` under that version to restore it.
- Prefer `npm link` over `npm install -g .` while you're still editing:
  `install -g` copies a *snapshot* into the global dir, so `data/jobs.db` would
  live there and local edits wouldn't apply until you reinstall.
- A shell alias is a lighter-weight option:
  `alias job-cron='node ~/Repos/personal_projects/job-cron/src/cli.ts'`.

## Commands

> These assume you've linked the CLI globally (above). If you haven't, run the
> equivalent `node src/cli.ts <command>` from the repo instead.

```bash
job-cron run            # poll all enabled sources once; alert on new matches
job-cron tui            # interactive browser: jobs + details + source health
job-cron status         # dashboard: job counts + per-source health
job-cron list [n]       # show recently seen jobs + their ids
job-cron sources        # list configured sources and their health
job-cron tailor <id>    # tailor resumes/base.json to a job → PDF
job-cron purge          # delete stale jobs (--days N, --dry-run)
job-cron                # no args → opens the TUI
```

`status`, `list`, and `sources` render colorized, aligned tables (via `chalk` +
`cli-table3`); color is auto-disabled when piped or when `NO_COLOR` is set.

### Deploy (local hourly timer)

`job-cron deploy <cmd>` manages a user-level systemd timer that runs `run` +
`purge` hourly — no sudo (see [Hosting](#hosting) for details):

```bash
job-cron deploy install      # enable + start the hourly timer
job-cron deploy status       # timer state + next run time
job-cron deploy run          # trigger one run now and tail its logs
job-cron deploy logs -f      # follow logs
job-cron deploy print        # preview the unit files without installing
job-cron deploy uninstall    # stop + remove (keeps your DB and config)
```

`install` and `uninstall` each send a one-off alert through your configured
notifier (✅ on install, 🛑 on uninstall), so you have a record of when scheduled
polling started and stopped. It's best-effort — if no webhook/token is set, the
deploy command still succeeds.

### Interactive TUI

`job-cron tui` (or just `job-cron` with no command) opens a full-screen browser
(built on `blessed`):

- **Left** — scrollable jobs list (`●` = seen in the last 24h).
- **Right** — full details for the selected job (source, seen/posted time, alert
  status, id, apply URL).
- **Top** — live counts: jobs, new (24h), and source health.

Keys: `j/k` (or arrows) move · `enter`/`o` open the apply URL in your browser ·
`t` tailor the selected job (drops into the `tailor` flow) · `d` dismiss the
selected job (asks to confirm; `y` dismisses, `n`/`esc` cancels) · `s` toggle the
source-health panel · `/` filter by company/title/location · `q` quit.

Dismissing is a **soft delete**: the row is kept as a tombstone (marked
`dismissed`) and hidden from all listings/counts, so a job you dismiss never
re-alerts and never comes back on the next `run`, even while it's still live on
the career page.

First run per source is **seed mode**: existing jobs are recorded silently (no
alert flood). Alerts only fire on jobs that appear afterwards.

### Purging old jobs

`purge` deletes jobs that are **not looked at** and have **fallen off the
listings** for N days (default 7):

```bash
job-cron purge --dry-run     # preview what would be deleted
job-cron purge               # delete (>7 days gone, not looked at)
job-cron purge --days 14     # custom window
```

Two safety rules:
- A job counts as "looked at" once you run `tailor` on it — those are **never**
  purged.
- "Old" is measured by `last_seen` (last poll the job still appeared), not when
  it was first found. A role that's still posted keeps getting refreshed and is
  never purged — deleting a live job would make it look new and **re-alert** you.
  Only roles that have disappeared from the career page for N days are removed.

The hourly workflow runs `purge --days 7` after each poll, so hosted state
self-cleans.

## Adding companies

Most companies use an ATS with a public JSON API. Add a config entry — usually no code:

```json
{ "provider": "greenhouse", "board": "stripe", "company": "Stripe", "enabled": true }
{ "provider": "lever",      "board": "rippling", "company": "Rippling", "enabled": true }
{ "provider": "ashby",      "board": "ramp",    "company": "Ramp",    "enabled": true }
```

In-house sources use the `CUSTOM` registry in `src/fetchers/index.ts`. **Google**
and **Microsoft** are already built in; pass query params via `query`:

```json
{ "provider": "custom", "customKey": "google",
  "company": "Google",    "enabled": true,
  "query": { "location": "India", "q": "software engineer", "maxPages": "3" } }

{ "provider": "custom", "customKey": "microsoft",
  "company": "Microsoft", "enabled": true,
  "query": { "lc": "India", "q": "software engineer", "pgSz": "20", "maxPages": "3" } }
```

Google has no public JSON API, so its fetcher parses the server-rendered results
HTML (no browser). Microsoft uses its `gcsservices.careers.microsoft.com` JSON
backend. Add more (Amazon, etc.) by writing a fetcher and registering it.

## Resume tailoring

`tailor` reads `resumes/base.json` (the source of truth), asks `claude -p` to
reorder/rephrase it toward the job — **using only facts already in the base** —
validates the result isn't fabricated, then renders a PDF via
`bin/resume-pdf.mjs`.

PDF rendering uses the `resume-to-pdf` CLI (`resume-to-pdf <json> -o <pdf>`) by
default. Override with `RESUME_PDF_CLI` — e.g. `RESUME_PDF_CLI=./bin/resume-pdf.mjs`
to use the bundled HTML fallback renderer (handy when `resume-to-pdf` isn't installed).

## Hosting

Two options. **Local is recommended** for this project (home IP keeps the Google
fetcher happy, the DB stays off git, and `tailor` lives in the same place).

### Recommended: local systemd timer

`job-cron deploy` (a thin wrapper over `deploy/job-cron.sh`) installs a
**user-level** systemd timer (no sudo) that runs `run` + `purge` hourly. It pins
the absolute `node` path (systemd has no nvm shims), uses `Persistent=true` so a
missed slot (laptop asleep) fires on the next wake, and adds jitter so it doesn't
hit career pages exactly on the hour.

```bash
job-cron deploy install      # enable + start the hourly timer
job-cron deploy status       # timer state + next run time
job-cron deploy run          # trigger one run now and tail its logs
job-cron deploy logs -f      # follow logs
job-cron deploy uninstall    # stop + remove (keeps your DB and config)
job-cron deploy print        # preview the unit files without installing
```

(If you haven't linked the CLI globally, the script also works directly:
`./deploy/job-cron.sh <cmd>`.)

Set secrets (e.g. your Discord webhook) in `~/.config/job-cron/env` — the install
step creates a template there. Without a webhook, alerts go to the journal
(`job-cron deploy logs`).

Notes:
- **Laptop caveat:** the timer can't fire while the machine is asleep/off.
  `Persistent=true` catches up on the next wake (no lost state), but you'll miss
  polls during sleep. For true 24/7 hourly, run the same script on an always-on
  box (cheap VPS / Raspberry Pi).
- By default the timer keeps running when you're logged out (`enable-linger`,
  attempted best-effort during install).
- Change the purge window with `JOB_CRON_PURGE_DAYS=14 job-cron deploy install`.

### Alternative: GitHub Actions

`.github/workflows/hourly.yml` runs hourly and commits the SQLite state back to
the repo. Set the `DISCORD_WEBHOOK_URL` repo secret. Trade-offs to know:

- **Use a private repo** — the committed `data/jobs.db` would otherwise publish
  your watch history (and bloats git history regardless).
- GitHub's scheduled cron is often delayed/skipped, and is **auto-disabled after
  60 days of repo inactivity** — weaker for an "apply early" tool.
- Shared runner IPs get bot-challenged more, so the **Google** (HTML-scrape)
  fetcher is the most likely to break; the ATS/Microsoft JSON fetchers are fine.
- `tailor` can't run here (it needs your local `claude` + `resume-to-pdf`), so
  Actions only does watch + alert.

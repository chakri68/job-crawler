# job-cron

The early bird gets the job. Aggregators are slow, noisy, and weeks behind — so
this skips them and watches company career pages straight from the source
(API-first, no scraping where an API exists). New role matches your filters? It
pings you before the listing has time to get stale.

On demand it'll tailor your base resume to a specific job — a headless Claude
Code instance reorders and rephrases toward the posting, strictly from facts
already in the base (no inventing a PhD you don't have), then spits out a PDF.

An interactive TUI ties it together: browse jobs, tailor them, and shove each one
through your pipeline (`new` → `applied` / `rejected`) without leaving the
terminal.

Basically a personal job-hunt cron that yells at you when something worth
applying to shows up.

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

Secrets live in a `.env` file in the project root — loaded automatically at
startup via Node's built-in `process.loadEnvFile`, so no `dotenv`, no extra
dependency, nothing. Real shell env vars still win, so `export
DISCORD_WEBHOOK_URL=...` works just as well. Skip all of it and alerts just print
to the console — nothing breaks, you just have to go look for them.

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

- **nvm:** the link lives in the _current_ Node version's bin dir. After
  `nvm use <other-version>`, re-run `npm link` under that version to restore it.
- Prefer `npm link` over `npm install -g .` while you're still editing:
  `install -g` copies a _snapshot_ into the global dir, so `data/jobs.db` would
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

`install` and `uninstall` each fire a one-off alert through your configured
notifier (✅ on install, 🛑 on uninstall), so future-you has a paper trail of when
the cron was actually running. Best-effort — no webhook set, no alert, and the
deploy still goes through fine.

### Interactive TUI

`job-cron tui` (or just `job-cron` with no command) opens a full-screen browser
(built on `blessed`):

- **Left** — scrollable jobs list. The leading marker is `●` (seen in the last
  24h), `✓` (applied), or `✗` (rejected).
- **Right** — full details for the selected job (status, source, seen/posted
  time, alert status, id, apply URL).
- **Top** — live counts: jobs, new (24h), applied, rejected, and source health.

Keys: `j/k` (or arrows) move · `enter`/`o` open the apply URL in your browser ·
`t` tailor the selected job (opens a modal, see below) · `a` mark applied ·
`x` mark rejected · `f`/`Tab` cycle the status filter (`Shift-Tab` reverse) ·
`d` dismiss the selected job (asks to confirm; `y` dismisses, `n`/`esc` cancels) ·
`r` run all sources now · `s` toggle the source-health panel ·
`/` filter by company/title/location · `q` quit.

**Tailoring modal.** Pressing `t` opens a modal that streams the `tailor` logs
live and, when the run finishes, shows the generated PDF path. It can't be
dismissed while tailoring is in progress; once done, `enter` opens the job's
apply URL and `esc` closes the modal.

**Job status / pipeline.** Every job carries a status — `new` by default, which
you move to `applied` (`a`) or `rejected` (`x`); pressing the same key again
clears it back to `new`. The status shows as the list marker (`✓`/`✗`), a line in
the details pane, and a count in the header. Cycle the list through
`all → new → applied → rejected` with `f`/`Tab` (`Shift-Tab` to go back) to focus
one bucket; the active filter shows in the list's title and composes with `/`
search. Like `tailor`, marking a job `applied`/`rejected` **exempts it from
purge** (see below). Statuses also surface in `job-cron list` via the same
`● ✓ ✗` markers.

Dismissing is a **soft delete**: the row is kept as a tombstone (marked
`dismissed`) and hidden from all listings/counts, so a job you dismiss never
re-alerts and never comes back on the next `run`, even while it's still live on
the career page.

First run per source is **seed mode**: everything already posted gets recorded
silently, so you don't get blasted with 200 alerts for jobs that have been up for
weeks. Only roles that show up _after_ that first poll actually ping you.

### Purging old jobs

`purge` deletes jobs that are **not looked at** and have **fallen off the
listings** for N days (default 7):

```bash
job-cron purge --dry-run     # preview what would be deleted
job-cron purge               # delete (>7 days gone, not looked at)
job-cron purge --days 14     # custom window
```

Two safety rules:

- A job counts as "looked at" once you run `tailor` on it, and any job you've
  marked `applied` or `rejected` is likewise engaged — those are **never** purged.
- "Old" is measured by `last_seen` (last poll the job still appeared), not when
  it was first found. A role that's still posted keeps getting refreshed and is
  never purged — deleting a live job would make it look new and **re-alert** you.
  Only roles that have disappeared from the career page for N days are removed.

The hourly workflow runs `purge --days 7` after each poll, so hosted state
self-cleans.

## Adding companies

Good news: most companies don't build their own careers page, they rent an ATS —
and those all have a public JSON API. So adding a company is usually just a config
entry, no code:

```json
{ "provider": "greenhouse",      "board": "stripe",   "company": "Stripe",   "enabled": true }
{ "provider": "lever",           "board": "rippling", "company": "Rippling", "enabled": true }
{ "provider": "ashby",           "board": "ramp",     "company": "Ramp",     "enabled": true }
{ "provider": "smartrecruiters", "board": "Visa",     "company": "Visa",     "enabled": true }
```

**Workday** is in-house but ubiquitous, so it's a generic provider too. A board
is a `(tenant, datacenter, site)` triple — `board` is the tenant; pass the rest
via `query`. Find them in any Workday careers URL
(`https://{tenant}.{dc}.myworkdayjobs.com/{site}`):

```json
{
  "provider": "workday",
  "board": "nvidia",
  "company": "NVIDIA",
  "enabled": true,
  "query": { "dc": "wd5", "site": "NVIDIAExternalCareerSite", "maxPages": "5" }
}
```

In-house sources use the `CUSTOM` registry in `src/fetchers/index.ts`. **Google**,
**Microsoft**, and **Amazon** are already built in; pass query params via `query`:

```json
{ "provider": "custom", "customKey": "google",
  "company": "Google",    "enabled": true,
  "query": { "location": "India", "q": "software engineer", "maxPages": "3" } }

{ "provider": "custom", "customKey": "microsoft",
  "company": "Microsoft", "enabled": true,
  "query": { "lc": "India", "q": "software engineer", "pgSz": "20", "maxPages": "3" } }

{ "provider": "custom", "customKey": "amazon",
  "company": "Amazon", "enabled": true,
  "query": { "loc_query": "India", "base_query": "software engineer", "maxPages": "3" } }

{ "provider": "custom", "customKey": "atlassian", "company": "Atlassian", "enabled": true }

{ "provider": "custom", "customKey": "uber",
  "company": "Uber", "enabled": true, "query": { "q": "software engineer", "maxPages": "3" } }

{ "provider": "custom", "customKey": "netflix",
  "company": "Netflix", "enabled": true, "query": { "q": "engineer", "maxPages": "3" } }
```

Google has no public JSON API, so its fetcher parses the server-rendered results
HTML (no browser). Microsoft uses its `gcsservices.careers.microsoft.com` JSON
backend. Amazon uses the `amazon.jobs/search.json` API (descriptions live in the
search payload, since its job pages are client-rendered). Atlassian returns every
posting (with descriptions) from one listings endpoint — filtering happens
downstream, so it takes no `query`. Uber and Netflix use their in-house JSON
search APIs. Add more by writing a fetcher and registering it.

> **Heads up — Microsoft and Netflix are flaky.** The config entries are here and
> the fetchers exist, but I never got either fully reliable. Microsoft's
> `gcsservices` backend is fussy about headers/params and likes to hand back
> empty pages or bot-challenge you.
> Treat both as experimental — they might just work for you, they might return
> nothing. Everything else in this list is solid; those two are the finicky ones.

Every source that takes a `query` (all the `custom` fetchers plus `workday`) also
accepts an **array of queries** — several searches run in one poll and their
results are merged, de-duplicated by job id. Use it to cover multiple search
terms or locations from one board:

```json
{
  "provider": "custom",
  "customKey": "google",
  "company": "Google",
  "enabled": true,
  "query": [
    { "location": "India", "q": "software engineer", "maxPages": "3" },
    { "location": "India", "q": "backend engineer", "maxPages": "3" }
  ]
}
```

For `workday`, the structural `dc`/`site` are read from the first query; only the
`q`/`maxPages` search params vary across the array.

## Resume tailoring

`tailor` reads `resumes/base.json` (the one source of truth) and hands it to
`claude -p` to reorder and rephrase toward the job — **using only facts already
in the base**. Then it double-checks the model didn't quietly hallucinate you a
new job title or a degree you never earned, and only then renders the PDF via
`bin/resume-pdf.mjs`. Tailor, not fabricate.

### The renderer

The default renderer is [`resume-to-pdf`](https://github.com/chakri68/resume) —
my own CLI (`resume-to-pdf <json> -o <pdf>`). It doesn't lay out a PDF from
scratch; it spins up headless Chrome (Puppeteer), feeds the JSON into my live
resume site at [resume.chakri.me](https://resume.chakri.me), and prints the
rendered page. So the tailored PDF comes out looking exactly like my real web
resume — same template, one source of styling — instead of some parallel
PDF-only theme I'd have to keep in sync. The tradeoff: it needs Chrome and a
network round-trip to the site.

Not me? You've got two ways out:

- Point `RESUME_PDF_CLI` at your own renderer. Anything that takes
  `<input.json> -o <output.pdf>` drops in — swap in your own site URL via
  `resume-to-pdf`'s `-u` flag, or a completely different tool.
- Fall back to the bundled `bin/resume-pdf.mjs` with
  `RESUME_PDF_CLI=./bin/resume-pdf.mjs` — a zero-dependency HTML renderer that
  needs no external CLI, no Chrome, no network. Uglier, but it always works.

## Hosting

Two options, and **local wins** for this one. Your home IP keeps the Google
fetcher from getting bot-challenged, the DB stays off git where it belongs, and
`tailor` needs your local `claude` anyway — so it all lives in one place.

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
the repo — someone else's always-on box, technically free. Set the
`DISCORD_WEBHOOK_URL` repo secret. The catches, because there are a few:

- **Use a private repo** — the committed `data/jobs.db` would otherwise publish
  your watch history (and bloats git history regardless).
- GitHub's scheduled cron is often delayed/skipped, and is **auto-disabled after
  60 days of repo inactivity** — weaker for an "apply early" tool.
- Shared runner IPs get bot-challenged more, so the **Google** (HTML-scrape)
  fetcher is the most likely to break; the ATS/Microsoft JSON fetchers are fine.
- `tailor` can't run here (it needs your local `claude` + `resume-to-pdf`), so
  Actions only does watch + alert.

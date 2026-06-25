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
export DISCORD_WEBHOOK_URL=...    # for Discord alerts (optional; falls back to console)
```

## Commands

```bash
node src/cli.ts run            # poll all enabled sources once; alert on new matches
node src/cli.ts list [n]       # show recently seen jobs + their ids
node src/cli.ts sources        # list configured sources
node src/cli.ts tailor <id>    # tailor resumes/base.json to a job → PDF
```

First run per source is **seed mode**: existing jobs are recorded silently (no
alert flood). Alerts only fire on jobs that appear afterwards.

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

`.github/workflows/hourly.yml` runs hourly on GitHub Actions and commits the
SQLite state back to the repo. Set the `DISCORD_WEBHOOK_URL` repo secret.

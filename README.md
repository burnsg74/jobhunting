# Job Hunting

Local job hunting app at **http://jobhunting.localhost**. Vite + Svelte 5 SPA (plain JS), a small `node:http` API on port **4002** (pm2 `jobhunting-api`), and CSV + markdown files in the vault as the data store. Replaces `3002-jobs` (Next.js + Postgres), now archived at `../_archive/3002-jobs`. Modelled on `../4001-budget`.

```
frontend/   Vite + Svelte 5 SPA, own history router, Tiptap markdown editor
backend/    node:http API (no framework): CSV/markdown store, validation, reports, pull run manager
capture/    Wellfound capture script + fit scorer (plain JavaScript, own dependencies)
scripts/    export-from-postgres.mjs (one-shot), verify.mjs, dev.mjs
data/dev/   synthetic jobs.csv, events.csv, postings/, events/ (committed)
deploy/     nginx/jobhunting.conf, ecosystem.config.cjs, setup.sh, deploy.sh, teardown.sh
```

## Data

| | Location |
| --- | --- |
| Production | vault `10 Projects/Job Hunting/data/` (`VAULT_PATH` + `DATA_DIR`) |
| Development | `data/dev/` in this repo (synthetic) |

Override with `DATA_PATH` (absolute directory). See `.env.example`. Real data never goes in this repo.

- `jobs.csv`: one row per job, keyed by `source_id`. Holds the listing fields, the fit scores, and a cached `status` / `status_at`.
- `postings/{source_id}.md`: the job description.
- `events.csv`: the log, one row per event (`captured`, `applied`, `deleted`, `rejected`, `interviewing`, `saved`, `offer`, `withdrew`, `note`, `pull`). The source of truth for history and the daily report.
- `events/{event_id}.md`: optional long-form body for an event.

Every write goes through one serialized queue: markdown file first, then the CSV rows, each atomically (temp file + rename). Reads and writes time out after 5 seconds if Dropbox hangs.

Statuses: `new`, `saved`, `applied`, `interviewing`, `rejected`, `deleted`. An applied job with no reply after 14 days shows a "No reply, 14d" badge.

## Pages

- `/` Inbox: triage queue sorted by fit, then recency. Keys: `S` save, `A` apply (opens the posting), `D` delete, `J`/`K` and arrows move, `Z` undo (all off while typing). Filters: fully remote (default on), minimum match, skills, minimum compensation. Pull button and progress live in the header.
- `/jobs` and `/jobs/:id`: tabs by status and search; Deleted has Restore and an Auto-deleted filter. The job page has the timeline and a status menu.
- `/log`: events grouped by day, markdown entries, filters by type, job and date range, backdatable.
- `/reports`: per-day counts, totals, New vs Applied chart (default last 14 days, America/Los_Angeles days).

## Develop

```bash
npm install
npm --prefix frontend install
npm --prefix capture install
npm run dev          # API on :4002 (data/dev) + Vite on http://localhost:5173
```

Dev edits write to `data/dev/`. To reset it: `npm run export:dev -- --force` (needs the old DB).

## Deploy

```bash
deploy/setup.sh      # idempotent: build, nginx site, /etc/hosts (sudo), pm2 start + save, brew services nginx, verify
deploy/deploy.sh     # later updates: build, restart API, reload nginx
deploy/teardown.sh   # remove nginx site, pm2 process, hosts lines (data untouched)
```

`setup.sh` needs the vault `jobs.csv` and `events.csv` first (see Migration). It asks before replacing an existing nginx conf and offers to remove dangling links in nginx's `servers/`. If nginx was started with `sudo`, its pid file is root-owned: `nginx -t` and `nginx -s reload` then fail as your user, so run `sudo nginx -s reload` once after the first setup. A fresh `brew services start nginx` as your user avoids this.

`.localhost` names already resolve to loopback on macOS, so the `/etc/hosts` lines are a belt-and-braces extra.

### macOS and Dropbox

pm2 starts at login under launchd. macOS can block such a process from reading Dropbox's File Provider folder, so reads hang. The API times out after 5 seconds and `/api/health` returns 503. Fix: add the node binary pm2 runs (path in `deploy/ecosystem.config.cjs`; it changes when fnm moves to a new Node version) to System Settings > Privacy & Security > Full Disk Access, then `pm2 restart jobhunting-api`.

## Wellfound pull

The Pull button in the Inbox header starts `POST /api/pulls`. The API spawns `capture/scripts/wellfound-capture.js`, one run at a time. The script drives a separate Chrome-Remote profile (copied from your Chrome profile), reads the job list, then for each job it has not seen:

1. opens the listing and extracts the job data,
2. scores fit with Claude using the prompt at `WELLFOUND_PROMPT_FILE`,
3. `POST /api/jobs` (idempotent on `source_id`), which writes the posting, a `captured` event, and a `deleted` event with summary `Auto: <reason>` when the scorer auto-deletes it.

It prints one JSON line per step on stdout (`listing`, `skip`, `saved`, `failed`, `done`); the API parses them into the progress line (`Job 12 of 38: 5 new, 6 known, 1 failed`) and keeps the last log lines. The UI polls `GET /api/pulls/current` every 2 seconds. When the run ends the API writes a `pull` event with the counts, which feeds "Last pulled ...".

Cancel sends `SIGTERM`; the script's cleanup closes Chrome and removes the temporary profile (the API escalates to `SIGKILL` after 20 s). Stopping the API (pm2 stop or restart) cancels a running pull the same way.

Configure in `.env.production` (gitignored, read by pm2 through `--env-file-if-exists`):

```bash
ANTHROPIC_API_KEY=sk-ant-...   # without it jobs are saved unscored with fit_error: no_api_key
WELLFOUND_PROMPT_FILE=/Users/greg/Library/CloudStorage/Dropbox/Notebooks/Work/10 Clients/Work/Alfred/Job Hunt/8-Prompts/evaluate-job-fit.md
```

Then `pm2 restart jobhunting-api --update-env`. Other knobs are listed in `.env.example` (`WELLFOUND_MAX_JOBS`, `WELLFOUND_SCORE_JOBS`, `WELLFOUND_SAVE_NETWORK`). The script copies the last-used Chrome profile (override with `WELLFOUND_CHROME_PROFILE`), so be signed in to Wellfound in that profile.

From a terminal (API must be up): `npm run capture:wellfound`. Try a dry run first: `WELLFOUND_MAX_JOBS=3 npm run capture:wellfound`.

## API

`GET /api/health` · `GET /api/jobs` (`status`, `q`, `auto_deleted`) · `GET /api/jobs/ids` · `POST /api/jobs` · `GET /api/jobs/:id` · `POST /api/jobs/:id/status` · `GET|POST /api/events` · `GET|PATCH|DELETE /api/events/:id` · `GET /api/reports/daily` · `POST /api/pulls` · `GET /api/pulls/current` · `POST /api/pulls/current/cancel`

`DELETE /api/events/:id` removes the row and its markdown file, and reverts the job's status when it was the latest status-changing event (this powers Undo). Status events cannot be edited; `offer`, `withdrew` and `note` events can.

## Migration from Postgres

One-shot, already run:

```bash
npm run export:prod   # real data  -> vault 10 Projects/Job Hunting/data/ (refuses to overwrite without --force)
npm run export:dev    # synthetic  -> data/dev/
npm run verify        # 139 jobs and postings, event counts 139/30/110/2, status counts 110/27/2
```

Cutover done 2026-10-31: the old pm2 `jobs` process is gone, `3002-jobs` moved to `../_archive/3002-jobs`, and `~/Code/Local/PORTS.md` is updated. Postgres is untouched and read-only.

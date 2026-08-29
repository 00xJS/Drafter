# Drafter

A local-first social media post planner. Plan upcoming posts, draft and come back later, track whether something was posted (kanban-style), and understand how your past posts on X, Instagram, and other platforms performed.

## Run it

```bash
npm install
npm run dev          # app on http://localhost:5173
```

### Modes

**Cloud mode (Supabase)** — active when `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are set (`.env.local` locally, site env vars on Netlify). The app requires sign-in (Supabase Auth; accounts are created in the Supabase dashboard — no public sign-up), syncs every change to Postgres, and bots can manage posts through the Supabase REST API (documented in the local, unpublished `BOTS.md`). Schema lives in `supabase/migrations/` (`supabase db push` applies it).

**Local mode** — with no Supabase env vars, data stays in the browser (IndexedDB). Useful for offline dev; there is no separate local server anymore.

### Deploying to Netlify

`netlify.toml` is ready: build `npm run build`, publish `dist`, plus an `/api/ai` function that proxies Claude server-side (session-gated, so visitors can't burn credits). Set these site environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and optionally `ANTHROPIC_API_KEY` for AI features (plus `ANTHROPIC_WORKSPACE_ID` if that key is identity-linked and not scoped to a single workspace).

## Views

- **Dashboard** — the at-a-glance view: upcoming/overdue/drafts/ideas/canceled counts, time since last post, countdown to the next one, posting cadence stats, plus "Up next" and "Needs attention" (overdue, unscheduled, stale drafts) lists.
- **Board** — kanban columns for Idea → Draft → Scheduled → Posted → Canceled. Drag cards between columns; dropping into Posted stamps the posted date. Recurring posts (↻) auto-create their next occurrence when marked posted; denied or discarded work goes to Canceled instead of being deleted.
- **Calendar** — month view of scheduled and posted posts. Click a day to schedule; drag a pill to another day to reschedule.
- **Posts** — searchable, filterable list of everything, plus importing (see below), JSON backup/export, and undo-able deletes.
- **Insights** — date-range filter scoping stat tiles (with vs-previous-period deltas and engagement rate), publishing cadence, engagement by platform, a best-time-to-post heatmap, per-tag performance, top posts, and an optional AI analysis of what your best posts have in common. Every chart has a table view.

The composer supports per-platform character counts, per-platform content overrides (one post, different text for X vs the IG caption), image attachments, recurrence (weekly / biweekly / monthly), tags, notes, scheduling, and per-platform results once posted. The ✨ buttons draft platform variants and suggest tags with AI.

## Getting your history in

**Account archives (recommended, free, no API keys):**

- **X (Twitter):** x.com → Settings → Your account → *Download an archive of your data*. Import the .zip (or just `data/tweets.js` for very large archives) via **Posts → Import archive**. Text, dates, likes, and reposts come along; retweets are skipped.
- **Instagram:** Accounts Center → Your information and permissions → *Download your information*, **JSON** format. Import the .zip or `your_instagram_activity/content/posts_1.json`. Captions and dates come along (the export has no metrics).

Re-importing an archive is idempotent — posts match by platform id, and your local edits always win.

**Also supported:** a generic analytics CSV (headers like `date, platform, text, likes, comments, shares, impressions`), manual "Log past post", and JSON backup import.

## Reminders, backup, PWA

- **Reminders:** enable notifications in Settings to get pinged when a scheduled post's time arrives (while the app is open).
- **Auto-backup:** pick a backup file in Settings (Chromium browsers) and every change is written to it automatically.
- **PWA:** the production build is installable and works offline.

## Data & sync model

Posts cache locally in IndexedDB (validated and migrated on load) and sync to Postgres with **delta sync**: only posts newer than the last cursor move in either direction, so an imported archive doesn't turn every sync into a megabyte exchange. Sync also fires when the app returns to the foreground. Last-write-wins per post by `updatedAt` is **enforced by a database trigger** for every writer (app, MCP, raw REST), with strictly-increasing stamps on every edit. Deletes are tombstones (undo-able, purged after 90 days). Images upload to Supabase Storage (owner-scoped) with IndexedDB as the offline cache, so they follow you across devices.

## Development

```bash
npm test             # vitest: importers, schema/migrations, merge/recurrence
npm run build        # type-check + production build (+ PWA service worker)
```

## Roadmap ideas

- Live X API / Instagram Graph API metric syncing (needs paid/dev credentials).
- Media in sync + export (currently browser-local only).
- Auth on the sync server if it ever leaves localhost.

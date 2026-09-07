# Drafter

A local-first personal project manager. Projects hold tasks with due dates, priorities, checklists and a comment trail; a roadmap lays projects and milestones out over time; the Today page tells you what's overdue, due today and due this week. Tasks can link to GitHub issues, pull requests, repos or Projects boards and show their live state. Social posting is a built-in mode: any task can be a post with per-platform text, results, and the Insights analytics that the app started life with.

## Run it

```bash
npm install
npm run dev          # app on http://localhost:5173
```

### Modes

**Cloud mode (Supabase)** — active when `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are set (`.env.local` locally, site env vars on Netlify). The app requires sign-in (Supabase Auth; accounts are created in the Supabase dashboard — no public sign-up), syncs every change to Postgres, and bots can manage posts through the Supabase REST API (documented in the local, unpublished `BOTS.md`). Schema lives in `supabase/migrations/` (`supabase db push` applies it).

**Local mode** — with no Supabase env vars, data stays in the browser (IndexedDB). Useful for offline dev; there is no separate local server anymore.

### Deploying to Netlify

`netlify.toml` is ready: build `npm run build`, publish `dist`, plus an `/api/ai` function that proxies the model server-side (session-gated, so visitors can't burn credits). Set these site environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, optionally `GITHUB_TOKEN` (see GitHub links), and one AI key for the ✨ features:

- `NVIDIA_API_KEY` — a free key from [build.nvidia.com](https://build.nvidia.com) (NVIDIA Developer Program, ~40 requests/min). Uses the OpenAI-compatible NIM endpoint; pick a model with `NVIDIA_MODEL` (default `nvidia/nemotron-3-super-120b-a12b`; list at `https://integrate.api.nvidia.com/v1/models`).
- `ANTHROPIC_API_KEY` — Claude instead (plus `ANTHROPIC_WORKSPACE_ID` if that key is identity-linked and not scoped to a single workspace; model via `ANTHROPIC_MODEL`).

If both keys are set NVIDIA wins; force one with `AI_PROVIDER=nvidia|anthropic`.

## Model

- **Project** — a container with a name, color, status (active / paused / done / archived), optional start and target dates, milestones, and an optional GitHub repo or Projects URL.
- **Task** — title, description, status (Wishlist → To do → Doing → Blocked → Done, plus Canceled), priority (low / normal / high / urgent), due date, tags, a checklist, a timestamped comment trail, notes, images, an optional GitHub link, and recurrence (daily / weekly / biweekly / monthly — completing one spawns the next). A task with `social` set is a post: platforms, per-platform overrides, and results.

The **project bar** under the header filters every view to one project (double-click a chip to edit it).

## Views

- **Today** — overdue, due today, this week, in-progress-without-a-date, blocked, and going-stale lists with one-tap complete; progress cards per active project; recently done.
- **Board** — kanban by status. Drag cards between columns (or use the ⇄ picker on touch). Dropping into Done stamps the completion date and spawns the next occurrence of a repeating task.
- **Calendar → Timeline** — projects as bars across months (dashed when the span is inferred — set start/target dates to pin it), milestones as ◆, due tasks as dots, a today line. Click anything to open it.
- **Calendar → Month** — month view by due date (done tasks show on their completion day). Click a day to add; drag a pill to move its due date.
- **Tasks** — searchable, filterable, sortable list of everything, plus JSON backup/export, social archive / CSV import, and undo-able deletes.
- **Insights** — analytics for the social posts: engagement by platform, best time to post, per-tag performance, top posts, and an optional AI analysis. Every chart has a table view.

The task editor's ✨ buttons break a task into checklist steps, suggest tags, and (for posts) draft platform variants.

## GitHub links

Paste a GitHub URL into a task's or project's **GitHub** field — an issue, pull request, repository, or a Projects (v2) board like `https://github.com/users/you/projects/3` — and the editor shows a live card: title, open/closed/merged/draft state, labels, assignees, comment count, last update. The lookup goes through the session-gated `/api/github` function. Public issues and repos work without configuration; set `GITHUB_TOKEN` on Netlify (a fine-grained PAT with read access to the repos, plus `read:project` for Projects boards) for private repos, Projects, and a far higher rate limit. Read-only by design: nothing is ever written to GitHub.

## Getting your history in

**Account archives (recommended, free, no API keys):**

- **X (Twitter):** x.com → Settings → Your account → *Download an archive of your data*. Import the .zip (or just `data/tweets.js` for very large archives) via **Posts → Import archive**. Text, dates, likes, and reposts come along; retweets are skipped.
- **Instagram:** Accounts Center → Your information and permissions → *Download your information*, **JSON** format. Import the .zip or `your_instagram_activity/content/posts_1.json`. Captions and dates come along (the export has no metrics).

Re-importing an archive is idempotent — posts match by platform id, and your local edits always win.

**Also supported:** a generic analytics CSV (headers like `date, platform, text, likes, comments, shares, impressions`), "Log something done", and JSON backup import. Imported posts land in the built-in **Social media** project.

## Reminders, backup, PWA

- **Reminders:** enable notifications in Settings to get pinged when a task's due time arrives (while the app is open).
- **Auto-backup:** pick a backup file in Settings (Chromium browsers) and every change is written to it automatically.
- **PWA:** the production build is installable and works offline.

## Data & sync model

Tasks and projects cache locally in IndexedDB (validated and migrated on load) and sync to Postgres with **delta sync**: only records newer than the last cursor move in either direction, so an imported archive doesn't turn every sync into a megabyte exchange. The table is still called `posts`; each row is a task or a project (`data->>'kind'`). **Pre-v3 rows are never rewritten** — every reader (the app, the MCP server) converts a legacy post into a social task on read, so the upgrade needs no data migration, only `supabase db push` for the new generated columns and the wider status validation. Sync also fires when the app returns to the foreground. Last-write-wins per post by `updatedAt` is **enforced by a database trigger** for every writer (app, MCP, raw REST), with strictly-increasing stamps on every edit. Deletes are tombstones (undo-able, purged after 90 days). Images upload to Supabase Storage (owner-scoped) with IndexedDB as the offline cache, so they follow you across devices.

## Development

```bash
npm test             # vitest: importers, schema/legacy migration, merge/recurrence
npm run build        # type-check + production build (+ PWA service worker)
```

## AI agents

`mcp/server.mjs` is a zero-dependency MCP server with project- and task-shaped tools (`list_projects`, `create_task`, `update_task`, `complete_task`, `add_comment`, `get_overview`, …) that write through the same merge-safe RPC as the app. Registration and the raw HTTP alternative are in the local, unpublished `BOTS.md`.

## Roadmap ideas

- Two-way GitHub Projects sync (status/due dates), building on the read-only cards.
- Server-side push reminders.
- Live X API / Instagram Graph API metric syncing (needs paid/dev credentials).

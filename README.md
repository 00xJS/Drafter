# Drafter

A local-first home journal and planner. Five tabs, the same on desktop and phone: **Home · Tasks · Calendar · People · Kitchen**. Home is the day — a briefing strip, what's overdue and due, habits and routines, tonight's dinner, the journal — with the week's review a segment away. Projects hold tasks with due dates, priorities, checklists and a comment trail; a timeline lays projects and milestones out over time; bills sit on their due dates. People and places track who you saw and where you went. Kitchen holds recipes, the week's meals (cooked or eaten out) and a grocery list, and those meals show on the calendar too. Cmd/Ctrl+K is a command palette that jumps anywhere, creates anything and searches everything. Tasks can link to GitHub issues, pull requests, repos or Projects boards and show their live state.

## Run it

```bash
npm install
npm run dev          # app on http://localhost:5173
```

### Modes

**Cloud mode (Supabase)** — active when `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are set (`.env.local` locally, site env vars on Netlify). The app requires sign-in (Supabase Auth; accounts are created in the Supabase dashboard — no public sign-up), syncs every change to Postgres, and bots can manage posts through the Supabase REST API (documented in the local, unpublished `BOTS.md`). Schema lives in `supabase/migrations/` (`supabase db push` applies it).

**Local mode** — with no Supabase env vars, data stays in the browser (IndexedDB). Useful for offline dev; there is no separate local server anymore.

### Deploying to Netlify

`netlify.toml` is ready: build `npm run check`, publish `dist`, plus an `/api/ai` function that proxies the model server-side (session-gated, so visitors can't burn credits). Set these site environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, optionally `GITHUB_TOKEN` (see GitHub links), optionally `SUPABASE_SERVICE_KEY` plus `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` (see Calendar sync), and one AI key for the ✨ features:

- `NVIDIA_API_KEY` — a free key from [build.nvidia.com](https://build.nvidia.com) (NVIDIA Developer Program, ~40 requests/min). Uses the OpenAI-compatible NIM endpoint; pick a model with `NVIDIA_MODEL` (default `nvidia/nemotron-3-super-120b-a12b`; list at `https://integrate.api.nvidia.com/v1/models`).
- `ANTHROPIC_API_KEY` — Claude instead (plus `ANTHROPIC_WORKSPACE_ID` if that key is identity-linked and not scoped to a single workspace; model via `ANTHROPIC_MODEL`).

If both keys are set NVIDIA wins; force one with `AI_PROVIDER=nvidia|anthropic`.

## Model

- **Project** — a container with a name, color, status (active / paused / done / archived), optional start and target dates, milestones, and an optional GitHub repo or Projects URL (a Projects board can sync status and due dates both ways).
- **Task** — title, description, status (Wishlist → To do → Doing → Done; leftover Blocked / Canceled still display), priority (low / normal / high / urgent), due date, tags, a checklist, a timestamped comment trail, notes, images, an optional GitHub link, and recurrence (daily / weekly / biweekly / monthly / quarterly / yearly — completing one spawns the next, on a clamped day so a monthly task due the 31st never skips February).

There is no project bar and no project filter: you are always on your one **home project**, and every view shows everything. Projects still exist as a grouping — a chip on each Board card, a bar on the Timeline, the thing a template or *Draft a plan* creates — and are edited from Today's active-projects list, the Timeline, the Week review and search. A new one comes from the palette: type *New project*; it is not a quick action. **Notes** (a segment of the Tasks tab) opens on an index of every project's notes; pick one to open its notepad and *All notes* returns to the index. Each pad is one running page you type straight into, with a formatting bar (bold, italic, underline, strikethrough, headings, lists, checklists, quotes, inline code, code blocks, links, dividers), an emoji picker, and photos pasted, dropped or picked from the 📷 button and shown inline. Notes are stored as a sanitized HTML subset; photos go to the synced media store and are referenced by id. It autosaves as you type. Older Markdown notes convert automatically on first open.

**Templates:** a new project can start from a template (built in: holiday/trip, moving house, party, quarterly finances, room makeover — or any project you've saved with *Save as template*). The Start date anchors every task and milestone. **✨ Draft a plan from a goal** asks the model for dated tasks and milestones from one sentence; review the list, then create the project with it or add it to an existing one.

**Command palette** (🔍 or Cmd/Ctrl+K) does four things from one box. Empty, it shows quick actions and recent tasks. Typing matches commands by name and keyword — jump to any view or segment (Home, Week, Journal, Tasks, Board, Bills, Notes, Calendar, People, Places, Kitchen) or run **New task / New project / New bill** — beside a search of tasks, notes, comments, checklists, projects, people, places and journal entries. Type something new and **Enter** opens a prefilled task editor, where the sentence is parsed into a date, project, people and priority before you save; **Shift+Enter** captures the line straight to the Inbox with no editor (the offline parse writes instantly, the model's parse merges in afterwards, and the toast says where it landed, with undo). On a phone the installed app is a **share target**: share a link or text from any app and it opens as a new task (a URL lands in the link field, not the title). Tasks with no project and no date show in Today's **Inbox** for a week so nothing captured gets lost. Tasks also carry **files** (any type, synced through the media store), an **estimate and actual cost**, and **blocked-by** links: a blocked task moves to To do by itself when its blockers complete. On a phone the five tabs sit at the bottom and a right-swipe on a Today row completes it.

**Household.** Settings → Household → *Create household*, then add members by their account email (accounts are still created by the site owner in Supabase). Everyone in the household sees the same projects, tasks, notes and people and can assign tasks (*Who's doing it*); the Tasks tab's segment row gains a **Mine / Everyone** switch that narrows Today, the list and the board alike (Home and Calendar say *Showing only your tasks* while it is on, with the way off). Calendars, reminders, reviews and the journal stay personal. Under the hood every record carries its owner and the database policy grants access to your own records plus your household's, replacing the original single-owner policy; existing data is assigned to the owner on migration.

**Deleting is two-step everywhere:** the first click arms the button, a second click within four seconds confirms. Deleted tasks, projects and calendars go to the **Trash** (Tasks → Trash) for 90 days, where one click restores them or a two-step *Delete forever* removes the record from the database outright; the undo toast still works too.

## Views

Five tabs, on desktop and phone alike: **Home · Tasks · Calendar · People · Kitchen**. A tab that has more than one way of looking at its data holds those as **segments** in a row under the tab bar rather than as more tabs — there is no More drawer. Home holds Today / Week / Journal, Tasks holds List / Board / Bills / Notes, Calendar holds Month / Week / Timeline, People holds People / Places. Tasks and People remember the segment you last chose; tapping Home always returns to Today. Old deep links still land: `?view=board|bills|notes` open the Tasks tab on that segment, `?view=today|review` open Home on the day or the week.

- **Home → Today** — a **briefing strip** first: a greeting for the hour — by first name when the account has one — then a tile for each fact the day has — the weather, today's work mode and hours, events (with the first start time), habits done of due, tonight's dinner. On a clear day (no events, nothing due or overdue) a short **from your wishlist** card sits under the strip, so spare time has somewhere to go. Weather is opt-in and comes from Open-Meteo with no key. One picker on the strip offers *Off*, *Use my location*, or a **major city** (Phoenix, London, Tokyo…): pick a city and nothing about where you are is ever asked for — only that city's public coordinates go to Open-Meteo. *Use my location* is the only choice that prompts for permission; either way nothing is stored server-side, and *Off* forgets the location, the city and the forecast. A US city (or a device set to English (US) with its own location) reads in °F, everywhere else in °C. Below that: overdue, due today, this week, the Inbox, Next up, this week's Top 3, tonight's dinner, people due a catch-up, upcoming birthdays and anniversaries, and (on Sunday) last week's review excerpt; one-tap complete and defer.
- **Home → Today: Habits** — things you do most days. Add one with a name, an emoji and the weekdays it is due (none chosen means every day); tick it for today and the ring fills in its colour; the streak shows as 🔥 n. A weekday habit reads *Rest day* at the weekend and its streak survives it — days it is not due on are skipped, not counted as misses, and an as-yet unticked today never zeroes a run. Tap the name to rename, reschedule or delete (two-step, with undo). Habits are personal, like the journal.
- **Home → Today: Routines** — short checklists you run at a time of day: morning, evening or anytime. Ticks belong to the day, so every routine starts fresh tomorrow without anything to reset. The card shows the routines for this time of day, with *Show all* for the rest; add, edit (a renamed step keeps its ticks) and two-step delete with undo.
- **Home → Week** — the weekly (or monthly) review: what got done (with a per-day chart), what slipped (push everything overdue to Monday, or send it back to the wishlist, in one click), what's already planned next, people seen, where you went, what you wrote in the journal, **habit consistency** (done of due per habit and overall, counted from the day each habit was created and only up to today), project movement and stalled projects, spend. Write your Top 3 and reflections, then ✨ write my summary drafts an honest review from the data — journal and habits included. (Sunday's automatic draft in the digest reads the journal but does not count habits yet.)
- **Home → Journal** — also a card on Today: one entry a day in your own words, with an optional mood (five faces). It saves as you type. Tag who the day was about with "+ Who" and their faces sit on the entry; a person's card on People shows how often they appear in your journal, separately from visits. Today shows yesterday's line and your streak; the journal page lists every day with search, inline editing, a 30-day mood average and a chart of the last 12 weeks (one column a day, a weekly average per week). Sunday's digest reads the week's entries when it drafts the review if you let it (Settings → Reminders, off by default). On a phone, `drafter://journal?text=…` offers a line from any Shortcut: the journal opens with the text shown, and it is appended only when you press Add.
- **Tasks → List** — searchable, filterable, sortable list of everything, plus JSON backup/export, "Log something done", the Trash, and undo-able deletes.
- **Tasks → Board** — kanban by status. Drag cards between columns (or use the ⇄ picker on touch). Dropping into Done stamps the completion date and spawns the next occurrence of a repeating task.
- **Tasks → Bills** — a month of payments at a time: overdue, still to come, paid, and what an average month costs (see Bills below).
- **Tasks → Notes** — an index of every project's notes; pick one to open its notepad (rich text with inline photos), and *All notes* returns to the index. The ☐ Task button turns the selected line into a task in that project.
- **Calendar → Month** — month view by due date (done tasks show on their completion day). Click a day to add; drag a pill to move its due date.
- **Calendar → Week** — the week as a list, with each day's tasks, events, meals and work-day badge, and a **+** per day.
- **Calendar → Timeline** — projects as bars across months (dashed when the span is inferred — set start/target dates to pin it), milestones as ◆, due tasks as dots, a today line. Click anything to open it.
- **People** — the people you want to keep close. Give each a rhythm ("every 2 weeks"); any completed task they're attached to counts as seeing them, or log a visit in one tap. Cards show last seen, visits in the last 30/90 days, the average gap, a 12-week sparkline, and a status: on track, due a catch-up, or overdue. Today surfaces the ones that need attention with **Plan something** or **Saw them**. People also carry a birthday and anniversary: Today lists them three weeks out with **Plan a gift** (a task due five days before, seeded with their notes). On a past calendar event, **Who was there?** logs everyone who came in one tap, matches the event's location to a saved place (or saves it as one) so the outing lands there too. The **year with people** table shows visits per month per person, totals and a drifting/more-lately trend. Each person's card lists **where we go** together, and ✨ Ideas draws on those places and on favourites you haven't taken them to yet. **People → Places** is a segment on the same tab: restaurants, fast food, cafés, bars, outdoors, venues, shops. Attach a place on a task or log an outing; the list shows when you last went, how often, how many of those were meals you ate there, and who you usually go with, and ✨ **Where should we go?** suggests outings from your own favourites and the places you've drifted from — tap one to plan it. Give a place a return rhythm and Today and the morning digest say when it's been a while.
- **Kitchen** — recipes with ingredients and steps, a week of breakfast/lunch/dinner/snack slots, and a grocery list built from whatever is planned (duplicate lines merge; Have / Need / Got it). Cook mode walks the steps and keeps the screen awake. Tonight's dinner also shows on Today. The Cook menu starts with **Something new…**: name a dish you are cooking for the first time and it is planned straight away, saved as a recipe with just its name, ready for ingredients and steps on the Kitchen tab. A slot can also be a night you **eat out** rather than cook: pick a saved place from the same menu the recipes are in, or **Somewhere new…** to name it on the spot — that saves the place as you plan the meal, so a first visit starts being tracked without a trip to Places. In both menus, typing a name you already have reuses it rather than making a second copy. "Out, no place" records a bought meal without naming where. A bought meal adds nothing to the grocery list, and once its day has passed it counts as an outing at that place — so the place's card says how often you ate there, and a restaurant you ordered from last night stops nagging you that it's been a while. **Every planned meal, cooked or bought, shows on the calendar** in both the month and week grids, so what you're eating sits beside the rest of the week; cooked nights are orange, nights out are blue. You can plan them there too: the **+** on a week day asks Task, Meal, Event or Work day, and any day you open lists breakfast, lunch and dinner with the same picker the Kitchen tab uses. Planning from either place rebuilds that week's grocery list. On a phone a line you tick stays where it is, struck through, so the list never jumps under your thumb mid-shop and a mis-tap is one tap to undo.

The task editor's ✨ buttons break a task into checklist steps and suggest tags. Pasting or sharing a sentence can fill a date; a URL goes in the link field.

## GitHub links and write-back

Paste a GitHub URL into a task's or project's **GitHub** field — an issue, pull request, repository, or a Projects (v2) board like `https://github.com/users/you/projects/3` — and the editor shows a live card: title, open/closed/merged/draft state, labels, assignees, comment count, last update. The lookup goes through the session-gated `/api/github` function. Public issues and repos work without configuration; set `GITHUB_TOKEN` on Netlify (a fine-grained PAT with read access to the repos, plus `read:project` for Projects boards) for private repos, Projects, and a far higher rate limit. With `GITHUB_TOKEN` granted write access, the card gains **Close issue on GitHub / Reopen**, marking a task with a linked issue done closes the issue, and a task in a project that links a repo can **Create a GitHub issue** from its title and description.

**Two-way Projects sync.** When a project's GitHub field holds a Projects (v2) board, the project editor offers **Sync status and due dates**. Turning it on reads the board's fields and proposes a mapping — each Drafter status (Wishlist, To do, Doing, Done) against the board's Status options, matched by name, and any of the board's date fields to write due dates into — which you can change per row. After that it runs both ways: moving a task here writes its column (and its due date, when that changed) onto the board row of its linked issue, debounced so dragging a card across the board is one write; and on focus and every 30 minutes each synced board is read back, so a card someone moved on GitHub moves the task here, with a toast and an undo. The newer edit always wins — a board row is only honoured when GitHub touched it after the task's own `updatedAt` — and a board row with no date is never read as "clear the due date". Failures are silent by design: GitHub being unreachable must never block a local edit. This needs `GITHUB_TOKEN` to carry the `project` scope (read **and** write); without it the toggle shows exactly that, and nothing else changes.

**Events.** A task marks a moment; an **event** blocks a slot. Add one from the calendar's **+** (or a day's *New event*) with a real start and end, or all day, plus a location and notes. They render in the month grid, the week list and the day sheet in their own colour, alongside tasks and meals, and open again for editing from the day sheet. Events are stored like everything else, so they sync, appear in Trash and survive offline. They also go **out**: every event rides the Drafter ICS feed with its true duration, so a subscribed calendar shows the slot as busy, and it is written straight into your real calendars as a busy block: the Google **Drafter** calendar when Google mirroring is on, and the **Drafter** calendar of *every* Microsoft account you have mirroring enabled for. Unlike a mirrored task, which shows as free time, an event shows as busy — blocking time is the point. Deleting one removes it from those calendars too, and Undo puts it back on them.

**Work days.** Mark where you are working and your hours: a **work day** is set to 🏠 Home or 🏢 Office with a start and an end, from the calendar's **+** (*Work day*), a day's *Set work day*, or the event editor's *Work day* switch. Pick weekdays under *Repeat on* (Monday and Friday at home, say) and a number of weeks, and each of those days is created separately, so any one of them can be changed on its own — the Friday you go in instead. A work day is a property of the day rather than something happening on it, so it shows as a small green 🏠 Home or blue 🏢 Office badge with the hours in am/pm (9am–5:30pm) on the month cell, the week header and the day sheet, and it is left out of the day's item count. Today's briefing strip shows the same mode and hours. It is never busy time: Google gets it as free, Outlook as **working elsewhere** (home) or free (office), and the ICS feed marks it transparent, so it never blocks anyone booking you during your working day.

**Bills.** Track what the household pays: bills, credit cards, subscriptions, loans. A bill is a task with an amount, so tick *This is a bill or payment* in any task (or press **+ Bill** on Tasks → Bills, or *New bill* in the command palette, which starts one repeating monthly), choose its kind, who is paid and whether it is paid automatically, and set the **Amount due**. It then sits on its due date in the calendar as 🧾, 💳, 🔁 or 🏦 with its amount, reminds you like any task, shows on Today, and repeats monthly, quarterly or yearly. A bill falls due on its own day however early or late you paid it, and one due on the 31st goes 31 Jan → 28 Feb → 31 Mar rather than settling on the 28th. Marking it done with nothing under **Paid** records the amount due as paid. The **Bills** segment of the Tasks tab shows a month at a time: what is overdue, what is still to come, what has been paid, and what an average month costs across every repeating payment. Amounts appear only inside Drafter — the Google and Outlook mirrors and the ICS feed send the title you typed and nothing more. Figures are shown in pounds.

## Backups

**JSON backup:** Tasks → Export JSON / Import JSON. Re-importing is last-write-wins by `updatedAt`. "Log something done" is still on the Tasks toolbar for recording something after the fact.

## Calendar sync

All integration secrets are **per user**: each signed-in account's Google tokens and feed link live in its own `user_settings` row, readable only by the Netlify functions (service role, no RLS policies). A browser session never sees a token, and no user can reach another user's calendars. `SUPABASE_SERVICE_KEY` on Netlify is what enables this table.

- **Google Calendar (OAuth).** Settings → Calendars → *Connect Google Calendar*. Tick the calendars to show (birthdays, family, holidays…) and they overlay the Month view (dashed pills), the Timeline (a Calendar row), and Today's *Coming up* list, each with a **Plan** button that creates a prep task due the morning before. Turn on *Mirror my tasks* and open tasks with due dates are written into a "Drafter" calendar in your Google account within seconds of a change (updated as they move, removed when done). Google → Drafter is read-only for your own calendars; the mirror is two-way for mirrored tasks: drag one in Google Calendar and its due date moves here on the next pull (on focus and every 30 minutes). Setup, once per deployment: Google Cloud Console → create a project → *APIs & Services → Library* → enable **Google Calendar API** → *OAuth consent screen* (External; add yourself as a test user, then **publish** the app — while it stays in *Testing*, Google expires refresh tokens after 7 days) → *Credentials → OAuth client ID → Web application* with the authorized redirect URI `https://<your-site>/api/google/callback` → set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on Netlify and redeploy.
- **Outlook / Microsoft 365 (OAuth).** Settings → Calendars → *Connect Outlook*. Personal and work accounts can both be connected at once — add the second with *Connect another account*. Tick the calendars to show and they overlay the Month view, Timeline and Today exactly like Google's. Turn on *Mirror my tasks* per account and open, dated tasks are written into a "Drafter" calendar there; moving one in Outlook moves its due date back here. Setup, once per deployment: [Azure Portal](https://portal.azure.com) → *App registrations* → *New registration* → supported account types **Accounts in any organizational directory and personal Microsoft accounts** → redirect URI (Web) `https://<your-site>/api/microsoft/callback` → copy the Application (client) ID, then *Certificates & secrets* → *New client secret* → set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` on Netlify and redeploy. Recurring events are expanded by Microsoft, so birthdays and weekly meetings arrive as real occurrences.
- **Any other calendar (iCloud, holidays, a .ics link).** Settings → Calendars: paste an ICS address (an iCloud *Public Calendar* webcal link, Google's *Secret address in iCal format* if you'd rather not use OAuth, a holidays feed). Same overlay, read-only, fetched through the session-gated `/api/calendars` function (calendar hosts don't send CORS headers) and cached in IndexedDB. Recurrence (birthdays, weekly classes, monthly bills), EXDATE and detached overrides are expanded server-side by `shared/ics.mjs`.
- **Email in.** Settings → *Create my email-in address* gives a private webhook URL; point Mailgun Routes, SendGrid Inbound Parse, Cloudflare Email Workers, Zapier or Make at it and a forwarded email becomes a task (subject → title, body → description, first link → link, sender in notes).
- **Subscribe link (Apple Calendar and others).** Settings → *Create my subscribe link* gives a private `/api/feed.ics?token=…` address for your account: open tasks with due dates, project targets and milestones as an iCalendar feed. Subscribe once in Apple Calendar (*File → New Calendar Subscription*) or Google (*Other calendars → From URL*); reset or turn the link off any time. Apple refreshes as often as you configure, Google every several hours (which is why Google gets the OAuth mirror instead).

## Reminders, backup, PWA

- **Push reminders (app closed):** Settings → Reminders → *Enable on this device*. An hourly scheduled function sends a morning digest at your chosen local hour (overdue, due today, occasions, people due a catch-up, tonight's dinner) and a nudge when a timed task comes due (hourly granularity). Optionally the digest goes by email too. Host setup: `npx web-push generate-vapid-keys` → `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` on Netlify; for email, `RESEND_API_KEY` (and `DIGEST_FROM`). iPhone needs the app installed to the Home Screen. On Sunday the digest also drafts your weekly review; tick *Let Sunday's draft read my journal* in Settings → Reminders if the week's entries should inform it (off by default — the ✨ summary you press for on Home → Week always may).
- **Reminders while open:** browser notifications on this device when a task's due time arrives.
- **Auto-backup:** pick a backup file in Settings (Chromium browsers) and every change is written to it automatically.
- **Server snapshots (owner only):** a daily scheduled function writes one JSON snapshot per account into the private `media` bucket at `backups/<user id>/<date>.json`, keeps the newest 14, and purges version history past 60 days and purged tombstones past 90. Admin → **Backups** lists what is actually there with sizes and a five-minute signed download, and *Back up now* runs the identical pass on demand — so a schedule that has never fired is visible instead of assumed.
- **Is my data still there? (owner only):** Admin → **Data** counts live records by kind, tombstones, unowned legacy rows, `posts_history` versions, rows per account and the newest server sync — straight through the service key, so it bypasses every policy and shows what the database really holds. Admin → **Integrations** goes further than "configured": it makes a real AI call, sends a real test push to this account's devices, and previews or sends your own digest.
- **PWA:** the production build is installable and works offline.

## iOS app

The same app, in a native shell (Capacitor). Nothing is duplicated: the web
bundle is packaged into `ios/`, talks to the hosted API and Supabase exactly
as the browser does, and syncs through the same `sync_posts` round-trip.

```bash
npm run ios          # builds the bundle for the app, syncs it, opens Xcode
```

Then run on a simulator or a phone from Xcode. `npm run build:ios` alone
rebuilds and syncs without opening Xcode. To preview the native look without
a device build, open the web app with `?native=1`: that stamps `html.native`
the way the shell does, so the iOS layer renders in a browser. The installed app does **not**
pick up a web deploy by itself — run `npm run ios` (or `build:ios` then
Xcode) after native or plugin changes. A free Apple ID installs on your own
iPhone for a week at a time; a paid developer account is needed for
TestFlight, the App Store, push through Apple, widgets, a share extension
and associated domains. This project currently ships the unpaid path.

What the shell adds over the installed web app:

- **Native patterns.** The same five tabs, but iOS large titles, editors as
  card sheets with a grab handle, the segment rows as real iOS segmented
  controls (a filled track with a raised thumb), native touch feedback and
  a frosted tab bar. **Pull to refresh**: drag down from the top of any tab
  and let go to refresh — items, calendars and the briefing, the same refresh
  the app runs when it comes back to the foreground. Gated on `html.native`,
  so the web build is untouched.
- **Reminders with nothing to set up.** Settings → Reminders → *Remind me on
  this iPhone* schedules a notification on the phone itself at each task's due
  time (9am for date-only tasks) and on the morning of a birthday or
  anniversary. No server, no account, works with the app closed. *Hide
  details on the lock screen* makes them say "Something is due" or "An
  occasion today" instead of a task title or a person's name; tapping one
  still opens the right thing.
- **Lock this iPhone.** Opt-in Face ID / Touch ID / device passcode (Settings
  → Reminders) before the signed-in cache is shown. The dark launch screen is
  laid over the window the moment the app stops being active — that is when iOS
  takes the App Switcher snapshot — so the multitasking card never shows the
  planner, and it lifts a beat after the app is forward again.
- **Keyboard.** Sheets shrink above the iOS keyboard, the tab bar slides out
  of the way so it never covers what you are typing, fields no longer zoom the
  page when you tap them, and multi-line fields get a Done key.
- **Dark launch screen.** `#0f1115` with orange “Drafter”, matching the app.
- **Reminders you can act on.** A due-task banner offers **Done** and
  **Tomorrow**; a birthday or anniversary offers **Saw them**. Reminders with
  details hidden get no buttons — a banner that will not name the task should
  not offer to finish it. The app icon's badge counts what is waiting and
  clears when you open the app.
- **Push through Apple.** Needs a paid membership and `APNS_*` on the host.
  Until then, use on-device reminders. Tapping a nudge opens that task;
  Sunday's digest opens the weekly review.
- **Calendar connections that work.** Google and Outlook consent runs in Safari
  and returns to the app through `drafter://oauth` — the API hands the browser
  a one-time token so the cookie-bound state still holds.
- **A URL scheme for capture.** `drafter://new` (an empty capture sheet),
  `drafter://new?title=…`, `drafter://new?url=…`, `drafter://open?task=<id>`,
  `drafter://open?view=review` (Home → Week), `drafter://open?tab=journal` (today's journal
  editor) and `drafter://journal?text=…` (offers the line for today's journal,
  and appends it when you press Add — nothing writes on arrival except a
  reminder's own action buttons) all work from anywhere on the phone. A two-step Shortcut ("Receive text/URLs
  from Share Sheet" → "Open URL" `drafter://new?url=[URL-encoded Shortcut
  Input]`) puts Drafter in every share sheet.
- **Home Screen quick actions.** Long-press the icon for *Journal*, *New task*
  and *Today* — three of the routes above, one gesture from the Home Screen,
  cold start or warm.
- Syncs whenever the app comes to the foreground; haptics when a task
  completes and at each point a swipe latches, so you can defer one-handed
  without watching; dark system UI, and the status bar tucked into the app's
  own header.

Not there yet: a Home Screen widget and a native share extension (both need
their own Swift targets), universal links, and APNs — all waiting on a paid
Apple Developer account.

## Data & sync model

Tasks, projects, people, places, recipes, meals, groceries, events, habits, routines, journal entries, calendars, reviews and templates cache locally in IndexedDB (validated and migrated on load) and sync to Postgres with **delta sync**: only dirty ids push, and only records newer than the last `synced_at` cursor move back. The table is still called `posts`; each row's type is `data->>'kind'`. **Pre-v3 rows are never rewritten** — every reader (the app, the MCP server) converts a legacy post into a task on read, so the upgrade needs no data migration, only `supabase db push` for new generated columns and the wider kind/status validation. A new kind must be added to the `sync_posts` allow-list **before** clients write it, or the server rejects the row; the app retries places, kitchen, journal, habit and routine kinds instead of deleting them. Habits, routines, the journal, reviews and calendars are personal; everything else is shared with the household. Sync also fires when the app returns to the foreground. Last-write-wins per post by `updatedAt` is **enforced by a database trigger** for every writer (app, MCP, raw REST), with strictly-increasing stamps on every edit. Deletes are tombstones (undo-able, purged after 90 days). Images upload to Supabase Storage (owner-scoped) with IndexedDB as the offline cache, so they follow you across devices.

## Development

```bash
npm test             # vitest, ~1s
npm run lint         # eslint src --max-warnings 0
npm run check        # tests + type-check + production build (what Netlify runs)
npm run db:smoke     # throwaway Postgres: apply every migration, exercise sync_posts and the policies
npm run mcp:smoke    # ...and drive the real MCP server process against it, end to end
```

`db:smoke` needs the PostgreSQL binaries on PATH (`brew install postgresql@17`). It stubs what Supabase provides (auth, storage, roles), applies `supabase/migrations` in order, then writes every record kind as a signed-in user, checks a household peer sees shared kinds but not the owner's journal, review or calendar, that the service role writes as the owner, that last-write-wins holds, that history is kept and scoped, and that a purge tombstone is accepted. Run it after any migration: a function can compile and still reject every write.

`mcp:smoke` starts the same throwaway database (both share the boot-and-migrate loop in `scripts/lib/pgtest.sh`), serves a minimal PostgREST shim over it that translates the handful of requests `mcp/server.mjs` makes into SQL — and answers **501 with the path** for anything else, so an unimplemented request can never look like an empty result — then spawns `node mcp/server.mjs` and speaks JSON-RPC to it over stdio. Projects, tasks, recurrence, visits, places, meals, groceries and the journal are each written through a real tool call and then read back straight from Postgres, with the legacy bare-array RPC shape and a rejected id covered too. Neither smoke test is part of `npm run check`: Netlify has no Postgres.

## AI agents

`mcp/server.mjs` is a zero-dependency MCP server whose tools cover the whole planner and write through the same merge-safe RPC as the app: projects and tasks (`list_projects`, `create_task`, `update_task`, `complete_task`, `add_comment`, `get_overview`, …), people and places (`list_people`, `list_places`, `create_place`, `log_visit` — a person, a place, or both), the kitchen (`list_recipes`, `get_week_meals`, `plan_meal` which also rebuilds the grocery list, `get_grocery_list`, `add_grocery_item`, `set_grocery_state`) and the journal (`list_journal`, `add_journal_entry` — appends, never overwrites). The rules an agent needs — week keys, grocery merging, place matching, journal appends — live in `shared/*.mjs` and are the same code the app runs. Registration and the raw HTTP alternative are in the local, unpublished `BOTS.md`.

## Later

- TestFlight / APNs / widgets / share extension / associated domains — needs a paid Apple Developer account.
- Places nearby-now ("I'm here") — needs the location permission and a native build.

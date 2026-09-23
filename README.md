# Drafter

Drafter is a personal planner and home journal for one life. Everything sits in one ongoing home project, so nothing asks which project a thing belongs to. It's an installable web app and the same app on the iPhone, works offline, syncs through Supabase, and lets assistants such as Claude help, within the permissions you give them.

Five tabs — **Home · Tasks · Calendar · Keep · Insights**. Home is today, Tasks is what to do, Calendar is when, **Keep** holds the things you keep records about (People, Places, Kitchen, Wardrobe), and **Insights** is the one tab you never add anything to. Everything else is a segment inside a tab rather than a tab of its own. It's light by default, with Dark and Match system in Settings → Appearance.

In a household, the address book is shared but the log is not: who you saw, where you went and the hours you work are each member's own, and the other person's work day shows beside yours with their name on it.

## What it does

### Home

- **Today**: a briefing strip (the weather if you turn it on, your work day, events, habits, tonight's dinner), up to three focus tasks, and what needs you: overdue, due today, the Inbox, people and places due a visit, birthdays and the next two weeks of events. Habits with streaks and daily routines live here too. Any section but the greeting cards folds away, and stays folded on every device you sign in on.
- **Plan my day** and **Shut down** guide the morning and the evening, each with one Undo. Any nudge — a person, a place, something coming up — can be put off with ×, for a week to three months and never for good.
- **Week** sits on the Today line, and **Review** beside it: what got done, what slipped, who you saw, where you went and what you wore. ✨ can draft it, and each Sunday it's drafted for you. **Plan next week** proposes dinners, catch-ups and new days for overdue tasks.
- **The bell** beside Review counts what is new: the other member finishing, commenting on or changing a task one of you handed the other, the morning digest, alarms, and each reminder the device rang this week — so one swiped away unread can still be read. Tapping one opens what it is about. *Tell me when someone updates a task we share* (Settings → Reminders) turns the task news off.
- **Journal · Notes · Wardrobe** are three cards below. Journal is one private entry a day, with an optional mood, the people it was about, a streak and mood charts; a day you already wrote opens to be read rather than edited.
- **Chat** is in the top bar, two threads that never mix — the household's, and yours with Drafter's assistant ("tell me about my week"). The assistant can also suggest changes — a task, a meal, the grocery list, a visit, a note, an event, or a move or tick on a task it was shown — each as a card with Apply, Edit and Skip; nothing changes until you tap one. What you ask the assistant is personal; the household thread is the household's.

### Tasks

**List · Board · Finance · Notes.** A task has a description, a status (Wishlist, To do, Doing, Done, or Blocked while it waits on another), a priority, a due date, tags, a checklist, comments, photos and files. A repeating task makes the next one when you finish it, a template or ✨ **Draft a plan** from a one-line goal adds a whole dated set at once, and forwarded emails can become tasks. Deleting takes two clicks, and the Trash keeps things for 90 days.

- **Finance** is a month of bills, each person's **paydays**, and **accounts** you type a balance into — with what comes in, what goes out, what is left over, and the first day in the next sixty that the money goes under. Drafter never connects to a bank: every figure is arithmetic over what you wrote down.
- A GitHub link shows the issue or pull request's live state. With a GitHub token, finishing the task can close the issue, and a linked Projects board syncs status and due dates both ways.

### Calendar

- **Month** and **Week** show tasks, events, meals, birthdays and work days together; drag a task to move it. **Timeline** lays out the project and its milestones. Events block time; 🏠 Home and 🏢 Office work days never do.
- Connect **Google** and **Outlook** accounts to see their calendars here, and mirror your tasks and events into a Drafter calendar in each; changes made there come back. Any `.ics` link overlays read-only, and a private subscribe link feeds Apple Calendar.
- **Reminders**: push and a morning digest with the app closed (or by email), browser notifications while it's open, and reminders set on the iPhone itself. Mirrored copies carry no reminders, so nothing rings twice, unless you turn on *Calendar copies remind me too* (Settings → Reminders, off by default).

### Keep

**People · Places · Kitchen · Wardrobe** — the four things you keep records about. Each switches **List · Stats**, and the figures follow the list's own search and chips.

- **People**: give each person a rhythm ("every 2 weeks"). Done tasks, past events and one-tap logs count as seeing them, and Today says who's due a catch-up — plus two a day of the people you've never logged, taking turns. **Rhythms** (Who, and how often) sets everyone at once, suggesting a rhythm from your own visits, and **No reminders** keeps someone on the list without ever nudging you about them. Birthdays and anniversaries come with **Plan a gift**.
- **Places** (restaurants, cafés, bars, the outdoors and more) track when you last went, how often and with whom; a meal eaten out counts. A return rhythm nudges you (set them all at once from **Rhythms**), and ✨ **Where should we go?** suggests outings. **Find address** looks a place up on OpenStreetMap and saves the address you pick with its pin — or **Find missing addresses** goes through every place without one. **I'm here** uses the phone's location to offer nearby saved places, then who you are with; the first log pins the spot so the next visit finds it.
- **Kitchen**: recipes with steps and a cook mode that keeps the screen awake; **This week** plans breakfast, lunch and dinner, cooked or eaten out, and every meal shows on the calendar; **Grocery** builds the list from the plan. In a household, Who sees this is Just me or Household — Household puts the meal on the other person's week as a task that carries the recipe: its steps to tick off, its ingredients and notes, kept in step when the recipe changes. ✨ proposes dinners for the empty nights and suggests recipes like the ones you cook.
  A recipe comes in by paste, by **Import from a link** (the page's own recipe, with a **Source** link back to it), or as a name: **✨ Fill in ingredients & steps** drafts an ordinary home version for you to check before Save. Recipes and this week's meals with no ingredients say so, since they add nothing to the grocery list, and **Fill them in** drafts them one at a time — Save, Edit, Skip or Stop.
- **Wardrobe**: add clothing from photos, each cut out onto white on the device and checked by you — or save a piece on its name alone and add the photo whenever it turns up, from the empty picture on its own sheet. A piece can have a back photo and be marked for Work, Days off or Anytime. **Outfit** dresses a day by swiping through tops, bottoms, outerwear and shoes, and knows a work day from a day off; **Surprise me** deals a look, **Wearing this** logs it, and you can plan up to a year ahead. Today asks **What are you wearing?** with one-tap looks, and offers your coat when it's cold or wet.

### Insights

**Stats · Journal · Review** — every figure the app keeps, in one tab. Nothing here sends you to another tab to read the rest.

- **Overview** reads across all of it: what you finished, days you saw someone, days you cooked and days you dressed over the last 30 days, 12 months or all time; your streaks; a card for each area; and a year of days as one grid.
- **Tasks**, **Money**, **Habits** and **Journal** are counted here and nowhere else — finished work by month, weekday, tag and priority and how long the overdue have waited; what you paid, to whom and on what; each habit kept against what was due; entries, words and moods. The Journal lens shows counts and moods only: nothing you wrote is shown here.
- **People**, **Places**, **Kitchen** and **Wardrobe** are the same figures Keep shows beside its own lists, drawn here. They read the same search and chips, so a number here and the same number there always agree.
- **Journal** is the archive of what you wrote, and **Review** the weekly ones, both beside the lens rather than inside it.

### Search and Ask Drafter

**Cmd/Ctrl+K** (or 🔍) jumps to any tab, runs commands (New task, Plan my day, Shut down, I'm here, Add clothing…) and searches tasks, notes, people, places, the journal and your clothes. Enter opens a new task with its date, people and tags read from what you typed; Shift+Enter (**Capture** on a phone) drops it in the Inbox. 🎤 dictates into the field where the browser has a recogniser — the words go in the box and nowhere else, so the same Enter still opens the editor for you to confirm; on the iPhone the keyboard's own dictation key does the same job. **Ask Drafter** answers questions about your own planner ("when did I last see Mum?"): it finds the matching records on the device, shows them as sources, and one ✨ call answers from those alone.

### Assistants and bots

Drafter is an MCP server with 31 tools at `/api/mcp`. Add it to Claude on claude.ai as a custom connector, approved on Drafter's consent screen, or make a token in **Settings → Assistants** for Claude Code and other clients. Assistants work with tasks, notes, people, places, meals, groceries, the wardrobe and the journal, read Today and propose next week; they can't start a second project. A token always reads, and you choose whether it can change things. No connection reaches the journal unless you allow it. Unused tokens lapse after 180 days, Claude connections after 90.

Automations use the **bot** gateway, a Supabase Edge Function with its own `BOT_TOKEN`. A bot acts as the owner and never sees another member's personal things, or a note, task or meal they kept to themselves.

### The iPhone app

The same app in a Capacitor shell, with iOS sheets, haptics and pull to refresh; reminders the phone schedules itself and a **Plan your day** notification each morning (8:00 unless you change it); **Lock this iPhone** with Face ID, Touch ID or the passcode; Apple's own subject lifting for the cut-out on iOS 17 and later; and `drafter://` links, Home Screen quick actions and a Shortcut for the share sheet.

A **Today widget** on the Home Screen (small and medium) and the Lock Screen shows the date, up to three of today's focus and due tasks with their times, the overdue count and tonight's dinner, by the same rules as Today; tap it for Today, or the medium one's **+** for a new task. With *Hide details on the lock screen* on (Settings → Reminders) it shows counts only, and it never shows the journal. Once its snapshot is 12 hours old it asks you to open Drafter. **Siri and Shortcuts** know “Add a task to Drafter”, “Add to my Drafter grocery list” and “Open Today in Drafter”; the first two work without opening the app, and what they add is saved the next time Drafter opens.

## Privacy and your data

- **Local first.** Records live on the device and sync to Supabase, so the app works offline. Changes from the other device arrive within seconds while the app is open. Edits from two devices merge field by field; when both changed the same field, the newer one wins and a toast offers **Keep mine**.
- **Household.** Settings → Household shares the project, tasks, notes, events, people, places and the kitchen with members you invite. Your journal, habits, routines, reviews, calendar subscriptions and wardrobe never reach the household.
- **Photos.** Note and task photos are shared with the household; wardrobe photos go in a folder only you can read. Assistants never get a wardrobe photo, and see the journal only with permission — Ask Drafter sends only the matching records, masks email addresses and phone numbers, and reads the journal only while its chip is on.
- **Backups.** Each night the server saves an encrypted snapshot of every account, journal included, in private storage and keeps the newest 14; only the site owner can download them, from Admin → Backups. Anyone can export a JSON file from Settings → Data.
  - **Off-site copy.** The owner's Mac copies the encrypted snapshots into iCloud Drive every night at 03:30 (`Drafter Backups/<account>/`) and keeps 60 days of them; a snapshot written before encryption was on never goes there. `scripts/install-offsite-backup.sh` sets that up as a LaunchAgent (`--uninstall` removes it), and each run adds a line to `~/Library/Logs/drafter-backup-offsite.log`.
  - **Restoring.** In Admin → Backups, **Read it** on a snapshot and type the passphrase (it never leaves the browser), then **Save the readable copy** and import that file in Settings → Data → **Import a file** while signed in as the account the snapshot is of: the file's name says whose it is, and Import refuses another account's snapshot, since it would file that person's records as yours. Importing merges by id, so a record edited since the snapshot keeps its newer version, and it says how many came back. The readable copy is unencrypted: delete it once it is imported.
- **Error reports.** When something breaks, the app sends the site owner the error's message, the file, line and column of each step of its stack, the build, whether it was the web or the iPhone app, and which screen. Never your records or anything you typed: before it leaves the device every word of the message that error messages don't use becomes `…`, quoted or not, and so do numbers past two digits, ids past four characters, dates, email addresses, phone numbers and query strings (`shared/errorreport.mts`; the server cleans it again). Only the owner sees them, in Admin → Data, and one nobody hits for 30 days drops off.
- **AI.** ✨ requests go through Drafter's own server (the keys never reach the browser), to NVIDIA first. Claude is an optional backup, used when its key is set and NVIDIA is busy or fails; `AI_PROVIDER` can force one or the other.
- **What leaves the device.** The cut-out never sends a photo anywhere. The weather is off until you turn it on, and then only rounded coordinates go to Open-Meteo. When you tap Find address, the place's name and your rough area go to OpenStreetMap, through Drafter's server. A recipe link you import is fetched by Drafter's server, never by the browser, and it only opens public web pages; a recipe's name, notes and steps go to the AI when you tap ✨ Fill in.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

Without Supabase settings it runs in local mode, keeping everything in the browser. For cloud mode, copy `.env.example` to `.env.local`; it names every environment variable and what each turns on.

```bash
npm run check        # lint, tests, both type-checks, the build and the precache check
npm run db:smoke     # every migration on a throwaway Postgres (brew install postgresql@17)
npm run mcp:smoke    # the real MCP server against that database
npm run e2e          # browser tests: an iPhone in WebKit and a desktop in Chromium (npx playwright install chromium webkit, once)
```

The smoke tests and the browser tests aren't part of `check`, since Netlify has no Postgres and no browsers. Run `db:smoke` after any migration.

## Deploy

- **Web.** Netlify builds `main` with `npm run check`. It needs `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` and `NVIDIA_API_KEY`; everything else is optional and listed in `.env.example`. There's no public sign-up: the owner's account comes from the Supabase dashboard, and the owner adds others in Admin (Settings → Household).
- **Database.** The owner applies migrations before deploying code that needs them: `supabase db push` at the Mac, or **Deploy database** in the repository's Actions tab, which asks you to type `apply`, prints the dry run, pushes, and redeploys the bot. It needs the repository secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` and `SUPABASE_PROJECT_REF`. A new kind of record must be on the sync allow-list first, or the server refuses it.
- **Bot.** A push to `main` that changes `supabase/functions/` or `shared/kinds.mts` deploys it (**Deploy bot**, needing `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`; without them it deploys nothing and still passes). By hand: `supabase functions deploy bot` (add `--use-api` if Docker isn't running). Either way `BOT_TOKEN` is a Supabase secret.
- **iPhone.** `npm run ios`, then Run in Xcode. The app carries its own copy of the web bundle, so rebuild it to pick up changes. `?native=1` previews the iOS look in a browser.
- **Checks.** Admin → Data → Integration health has **Test AI**, **Send test push** and **Preview my digest**; Admin → Data shows what the database holds, the last run of the nightly backup and the hourly digest, and the errors devices reported. The owner's Today gets a banner when an hourly sync check finds the server refusing a kind of record, when the digest has not run for 3 hours, when no backup has worked for 36 hours, or when a run failed.
- **Content Security Policy.** The web app ships a report-only policy (`shared/csp.mts`, written into `dist/_headers` by the build); anything it would block shows up in Admin → Data as `CSP would block …`. To enforce it, set `CSP_ENFORCE=true` in Netlify's environment and redeploy (unset it and redeploy to go back), then check that `curl -sI https://<your-site>/ | grep -i content-security` shows `Content-Security-Policy:`.

### iPhone and the Apple Developer Program

The membership is on and the bundle ID is `app.drafter.ios`; sign with the paid team in Xcode.

- **TestFlight.** `npm run release:ios` raises the version people read and Apple's build number, rebuilds and opens Xcode; then *Product → Archive → Distribute App → App Store Connect*. Add `-- --minor` or `-- --major` for `1.1.0` / `2.0.0`, or `--keep` to raise only the build number. `npm run build:ios` rebuilds without changing either. Settings → Data → About shows `Drafter 1.1.0 (12)` on a phone so installs can be told apart.
- **Push (APNs).** Set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` and `APNS_BUNDLE_ID=app.drafter.ios` on Netlify. Leave `APNS_ENV` unset for TestFlight and the App Store (Apple's production servers); set `APNS_ENV=sandbox` only while testing a build run from Xcode — a token from the other environment is retried there on its own. `App.entitlements` already has `aps-environment`, and `AppDelegate.swift` hands the device token to the push plugin. Then Settings → Reminders → *Enable on this device*; each launch checks the token is still the one the server has. Admin → Integrations shows whether it is configured.
- **Universal Links and Password AutoFill.** Both are on the entitlements (`applinks:` and `webcredentials:drafterz.netlify.app`). The association file is written at build time from `APPLE_TEAM_ID` — see `ios/apple-app-site-association.example.json` for the shape — and `netlify.toml` serves it as JSON.
- **Widget and Siri.** The widget is a second target, `DrafterWidgets` (`app.drafter.ios.widgets`), embedded in the app, and the two share the App Group `group.app.drafter.ios`; automatic signing registers both the first time the paid team builds. `npm run release:ios` raises both targets' numbers together.
- **Not planned.** A share extension: the Shortcut for the share sheet does that job.

## The icon

`public/icon.svg` is the mark, and everything else is drawn from it. After changing it, run `node scripts/app-icons.mjs` to redraw the iPhone and web icons (opaque RGB, as the App Store requires) and `node scripts/launch-logo.mjs` to redraw the iPhone launch screen's artwork; `launchscreen.test.ts` fails if they drift apart.

## Garment cut-out

The cut-out runs on the device: Apple's Vision on iOS 17 and later, and elsewhere MediaPipe's interactive segmenter with the MagicTouch model (about 17.5 MB, downloaded once on the web). Credits: MediaPipe Tasks Vision 1.0.1 (© Google LLC, Apache-2.0, https://github.com/google-ai-edge/mediapipe) and the MediaPipe MagicTouch interactive segmentation model v1 (© Google LLC, Apache-2.0, [model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MagicTouch.pdf)). `/cutout/LICENSE`, `/cutout/NOTICE` and `/cutout/THIRD_PARTY_LICENSES` ship beside them, the last covering the BSD, MIT and MPL-2.0 libraries in the WASM runtime; `public/cutout/NOTICE` lists every component. Nothing AGPL, non-commercial or paid is used.

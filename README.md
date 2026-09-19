# Drafter

Drafter is a personal planner and home journal for one life. Everything sits in one ongoing home project, so nothing asks which project a thing belongs to. It's an installable web app and the same app on the iPhone, works offline, syncs through Supabase, and lets assistants such as Claude help, within the permissions you give them.

Six tabs: five nouns — **Home · Tasks · Calendar · People · Kitchen** — and one lens, **Stats**, the only tab you never add anything to. Everything else is a segment inside a tab rather than a tab of its own. It's light by default, with Dark and Match system in Settings → Appearance.

## What it does

### Home

- **Today**: a briefing strip (the weather if you turn it on, your work day, events, habits, tonight's dinner), up to three focus tasks, and what needs you: overdue, due today, the Inbox, people and places due a visit, birthdays and the next two weeks of events. Habits with streaks and daily routines live here too.
- **Plan my day** and **Shut down** guide the morning and the evening, each with one Undo.
- **Week**: the review of what got done, what slipped, who you saw, where you went and what you wore. ✨ can draft it, and each Sunday it's drafted for you. **Plan next week** proposes dinners, catch-ups and new days for overdue tasks.
- **Journal**: one private entry a day, with an optional mood, the people it was about, a streak and mood charts.

### Tasks

- A task has a description, a status (Wishlist, To do, Doing, Done, or Blocked while it waits on another), a priority, a due date, tags, a checklist, comments, photos and files. A repeating task makes the next one when you finish it.
- **List**, **Board** (drag between statuses), **Bills** (a month of payments, in dollars) and **Notes** (rich-text notes and the project's notepad).
- A template or ✨ **Draft a plan** from a one-line goal adds a set of dated tasks at once.
- A GitHub link shows the issue or pull request's live state. With a GitHub token, finishing the task can close the issue, and a linked Projects board syncs status and due dates both ways.
- Forwarded emails can become tasks. Deleting takes two clicks, and the Trash keeps things for 90 days.

### Calendar

- **Month** and **Week** show tasks, events, meals, birthdays and work days together; drag a task to move it. **Timeline** lays out the project and its milestones.
- Events block time; 🏠 Home and 🏢 Office work days never do.
- Connect **Google** and **Outlook** accounts to see their calendars here, and mirror your tasks and events into a Drafter calendar in each; changes made there come back. Any `.ics` link overlays read-only, and a private subscribe link feeds Apple Calendar.
- **Reminders**: push and a morning digest with the app closed (or by email), browser notifications while it's open, and reminders set on the iPhone itself. Mirrored copies carry no reminders, so nothing rings twice, unless you turn on *Calendar copies remind me too* (Settings → Reminders, off by default).

### People and Places

- Give each person a rhythm ("every 2 weeks"). Done tasks, past events and one-tap logs count as seeing them, and Today says who's due a catch-up. Birthdays and anniversaries come with **Plan a gift**.
- **Places** (restaurants, cafés, bars, the outdoors and more) track when you last went, how often and with whom; a meal eaten out counts. A return rhythm nudges you, and ✨ **Where should we go?** suggests outings.
- **Stats** in each (switch **List · Stats**) follow the list's search and chips, and show:
  - who you see and where you go most, streaks, and a month calendar;
  - each month of the year;
  - groups and kinds of place, and who you go with;
  - who or where is due.

### Kitchen

- **Recipes** with steps, a cook mode that keeps the screen awake, and when you last cooked each.
- **This week** plans breakfast, lunch and dinner, cooked or eaten out, and every meal shows on the calendar. In a household, Share on any slot puts it on the other person's week as a task — either of you can turn that on. **Grocery** builds the list from the plan.
- **Plan this week's meals** proposes dinners for the empty nights, and ✨ suggests recipes like the ones you cook.
- **Stats** shows:
  - your most cooked recipes, home-cooked streaks, and a month calendar of dinners;
  - what you cooked, ate out and bought each month;
  - the sides you pair with each main.

### Stats

Every figure the app keeps, in one tab. Nothing here sends you to another tab to read the rest.

- **Overview** reads across all of it: what you finished, days you saw someone, days you cooked and days you dressed over the last 30 days, 12 months or all time; your streaks; a card for each area; and a year of days as one grid.
- **Tasks**, **Money**, **Habits** and **Journal** are counted here and nowhere else — finished work by month, weekday, tag and priority and how long the overdue have waited; what you paid, to whom and on what; each habit kept against what was due; entries, words and moods.
- **People**, **Places**, **Kitchen** and **Wardrobe** are the same figures those areas keep beside their own lists, drawn here. They read the same search and chips, so a number here and the same number there always agree.

### Wardrobe

Home's fourth segment.

- **Add clothing** from photos, each cut out onto white on the device and checked by you (Looks good, Use original or Retake). A piece can have a back photo and be marked for Work, Days off or Anytime.
- **Outfit** dresses a day by swiping through tops, bottoms, outerwear and shoes, and knows a work day from a day off. **Surprise me** deals a look, **Wearing this** logs it, and you can plan up to a year ahead (a plan counts only once it's worn).
- Saved outfits, a **Clothes** list you can filter, and **Stats**: your streak, a photo calendar, most worn, not worn in 60 days, never worn, your uniform and cost per wear.
- Today asks **What are you wearing?** with one-tap looks, and offers your coat when it's cold or wet.

### Search and Ask Drafter

**Cmd/Ctrl+K** (or 🔍) jumps to any tab, runs commands (New task, Plan my day, Shut down, Add clothing…) and searches tasks, notes, people, places, the journal and your clothes. Enter opens a new task with its date, people and tags read from what you typed; Shift+Enter (**Capture** on a phone) drops it in the Inbox.

**Ask Drafter** answers questions about your own planner ("when did I last see Mum?"). It finds the matching records on the device, shows them as sources, and one ✨ call answers from those alone.

### Assistants and bots

- Drafter is an MCP server with 31 tools at `/api/mcp`. Add it to Claude on claude.ai as a custom connector, approved on Drafter's consent screen, or make a token in **Settings → Assistants** for Claude Code and other clients.
- Assistants work with tasks, notes, people, places, meals, groceries, the wardrobe and the journal, read Today and propose next week. They can't start a second project.
- A token always reads, and you choose whether it can change things. No connection reaches the journal unless you allow it. Unused tokens lapse after 180 days, Claude connections after 90.
- Automations use the **bot** gateway, a Supabase Edge Function with its own `BOT_TOKEN`. A bot acts as the owner and never sees another member's personal things.

### The iPhone app

The same app in a Capacitor shell, with:

- iOS sheets, haptics and pull to refresh;
- reminders the phone schedules itself, and a **Plan your day** notification each morning (8:00 unless you change it);
- **Lock this iPhone** with Face ID, Touch ID or the passcode;
- Apple's own subject lifting for the cut-out, on iOS 17 and later;
- `drafter://` links, Home Screen quick actions and a Shortcut for the share sheet.

## Privacy and your data

- **Local first.** Records live on the device and sync to Supabase, so the app works offline. Edits from two devices merge field by field; when both changed the same field, the newer one wins and a toast offers **Keep mine**.
- **Household.** Settings → Household shares the project, tasks, notes, events, people, places and the kitchen with members you invite. Your journal, habits, routines, reviews, calendar subscriptions and wardrobe never reach the household.
- **Photos.** Note and task photos are shared with the household; wardrobe photos go in a folder only you can read.
- **Backups.** Each night the server saves a snapshot of every account, journal included, in private storage and keeps the newest 14; only the site owner can download them, from **Admin → Backups**. Anyone can export a JSON file from Tasks → List.
- **Assistants** never get a wardrobe photo, and see the journal only with permission. Ask Drafter sends only the matching records, masks email addresses and phone numbers, and reads the journal only while its chip is on.
- **AI.** ✨ requests go through Drafter's own server (the keys never reach the browser), to NVIDIA first. Claude is an optional backup, used when its key is set and NVIDIA is busy or fails; `AI_PROVIDER` can force one or the other.
- **What leaves the device.** The cut-out never sends a photo anywhere. The weather is off until you turn it on, and then only rounded coordinates go to Open-Meteo.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

Without Supabase settings it runs in local mode, keeping everything in the browser. For cloud mode, copy `.env.example` to `.env.local`; it names the environment variables and what each turns on.

```bash
npm run check        # lint, tests, both type-checks, the build and the precache check
npm run db:smoke     # every migration on a throwaway Postgres (brew install postgresql@17)
npm run mcp:smoke    # the real MCP server against that database
```

The smoke tests aren't part of `check`, since Netlify has no Postgres. Run `db:smoke` after any migration.

## Deploy

- **Web.** Netlify builds `main` with `npm run check`. Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the publishable key, `sb_publishable_…`), `SUPABASE_SERVICE_KEY` (the secret key, `sb_secret_…`, for the server features) and `NVIDIA_API_KEY`, with `ANTHROPIC_API_KEY` as the optional backup; the legacy anon and service_role keys still work until the project turns them off; the rest (a second NVIDIA key, GitHub, Google, Outlook, push, email, APNs) are optional and listed in `.env.example`. There's no public sign-up: the owner's account comes from the Supabase dashboard, and the owner adds others in Admin.
- **Database.** The owner applies migrations with `supabase db push` before deploying code that needs them. A new kind of record must be on the sync allow-list first, or the server refuses it.
- **Bot.** `supabase functions deploy bot` (add `--use-api` if Docker isn't running), with `BOT_TOKEN` set as a Supabase secret.
- **iPhone.** `npm run ios`, then Run in Xcode. The app carries its own copy of the web bundle, so rebuild it to pick up changes. `?native=1` previews the iOS look in a browser.
- **Checks.** Admin → Integrations has **Test AI**, **Send test push** and **Preview my digest**; Admin → Data shows what the database holds, and an hourly sync check puts a banner on the owner's Today if the server refuses a kind of record.

### iPhone and the Apple Developer Program

The membership is on. Entitlements already ask for push, Universal Links and Password AutoFill, and the live site serves the association file (written at build time from `APPLE_TEAM_ID`). The same list is in the app under Admin → Apple.

1. **Sign with the paid team** in Xcode. The bundle ID stays `app.drafter.ios`.
2. **Push through Apple (APNs).** Create an APNs key (a `.p8`) if you have not. On Netlify set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` and `APNS_BUNDLE_ID=app.drafter.ios`, plus `APNS_ENV=sandbox` for Xcode builds. `App.entitlements` already has `aps-environment`. Run `npm run ios`, then Settings → Reminders → *Enable on this device*.
3. **Universal Links.** The association file is written from `APPLE_TEAM_ID` (see `ios/apple-app-site-association.example.json` for the shape). `netlify.toml` serves it as JSON, and `applinks:drafterz.netlify.app` is on the entitlements.
4. **Password AutoFill.** `webcredentials:drafterz.netlify.app` is on the same entitlements.
5. **TestFlight and the App Store.** `npm run release:ios` raises the version people read (`1.0.1`, then `1.0.2`…) and Apple's build number, rebuilds, and opens Xcode. Then *Product → Archive → Distribute App → App Store Connect*. Use `npm run release:ios -- --minor` or `--major` for `1.1.0` / `2.0.0`, or `--keep` to only raise the build number. Settings → Data → About shows `Drafter 1.0.1 (7)` on a phone so installs can be told apart. `npm run build:ios` rebuilds without changing either number.
6. **Later builds.** A Home Screen widget and a share extension, neither built yet.

## Garment cut-out

The cut-out runs on the device: Apple's Vision on iOS 17 and later, and elsewhere MediaPipe's interactive segmenter with the MagicTouch model (about 17.5 MB, downloaded once on the web). Credits: MediaPipe Tasks Vision 1.0.1 (© Google LLC, Apache-2.0, https://github.com/google-ai-edge/mediapipe) and the MediaPipe MagicTouch interactive segmentation model v1 (© Google LLC, Apache-2.0, [model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MagicTouch.pdf)). `/cutout/LICENSE`, `/cutout/NOTICE` and `/cutout/THIRD_PARTY_LICENSES` ship beside them, the last covering the BSD, MIT and MPL-2.0 libraries in the WASM runtime; `public/cutout/NOTICE` lists every component. Nothing AGPL, non-commercial or paid is used.

## Later

- Places nearby-now ("I'm here"), which needs the location permission and a native build.

---

The earlier, detailed README is in git history at commit 4c46994 (`git show 4c46994:README.md`).

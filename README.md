# Drafter

A home planner and journal for a household: tasks, the calendar, money, meals, people, places, clothes and a daily journal in one app. It runs in the browser and as the same app on the iPhone, works offline, and syncs through Supabase.

Five tabs, **Home · Tasks · Calendar · Keep · Insights**:

- **Home** is today: a briefing, focus tasks, habits and routines, the journal and notes, the bell for what's new, and the chat, with the household's thread and a private one with Drafter's assistant.
- **Tasks** holds the List, the Board, **Finance** (safe to spend, counting paychecks and bills alike; bills, paydays, check-ins and savings goals) and Notes.
- **Calendar** shows tasks, events, meals and work days, mirrors Google and Outlook, and overlays any `.ics` feed.
- **Keep** is People, Places, Kitchen and Wardrobe: who you've seen, where you went, recipes and the week's meals, and an outfit board for planning what to wear.
- **Insights** is Stats, the Journal archive and the weekly Review.

Cmd/Ctrl+K searches everything, and **Ask Drafter** answers questions about your own records. Assistants such as Claude connect to the MCP server at `/api/mcp`, with the permissions you give them. The iPhone app adds a Home Screen widget, Siri shortcuts, Face ID lock and reminders the phone schedules itself.

## Privacy

- Records live on the device first and sync between devices. When two devices change the same field, the edit saved first is kept, and the other device offers **Keep mine**.
- A household shares tasks, notes, events, people, places and the kitchen. Journals, habits, reviews and wardrobes stay personal.
- The server keeps encrypted nightly backups, and anyone can export their data from Settings → Data.
- ✨ features go through Drafter's own server to NVIDIA, so no key reaches the browser. Garment photos are cut out on the device, and Drafter never connects to a bank.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

Without Supabase settings it runs in local mode, with everything kept in the browser. For cloud mode, copy `.env.example` to `.env.local`; it lists every setting.

```bash
npm run check        # lint, compiler check, unit tests, type-checks, build, precache budget
npm run db:smoke     # every migration on a throwaway Postgres
npm run mcp:smoke    # the MCP server against that database
npm run e2e          # browser tests in WebKit and Chromium
npm run e2e:cloud    # browser tests against a local Supabase stack (needs Docker)
```

## Deploy

- **Web:** Netlify builds `main`. With `DRAFTER_GATED_DEPLOYS` set, it waits for CI to pass (`scripts/netlify-ignore.mjs`).
- **Database:** `supabase db push`, or **Deploy database** in the Actions tab. Apply migrations before the code that needs them.
- **Bot:** **Deploy bot** runs after CI passes on `main`.
- **CI:** every push runs `check`, both smoke tests, both browser lanes and the bot's Deno checks.

### iPhone and the Apple Developer Program

- The bundle ID is `app.drafter.ios`, signed with the paid team. `npm run release:ios` raises the version and build number; then Archive in Xcode and upload to TestFlight.
- **Push:** set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` and `APNS_BUNDLE_ID` on Netlify, and `APNS_ENV=sandbox` only for builds run from Xcode. Admin → Integrations shows whether it is configured.
- **Universal Links and Password AutoFill:** `applinks:` and `webcredentials:drafterz.netlify.app`. The association file is built from `APPLE_TEAM_ID`; its shape is in `ios/apple-app-site-association.example.json`.
- **Widget and Siri:** the `DrafterWidgets` target shares the App Group `group.app.drafter.ios` with the app.

## Garment cut-out

The cut-out runs on the device: Apple's Vision on iOS 17 and later, and elsewhere MediaPipe's interactive segmenter with the MagicTouch model. Credits: MediaPipe Tasks Vision 1.0.1 (© Google LLC, Apache-2.0, https://github.com/google-ai-edge/mediapipe) and the MediaPipe MagicTouch interactive segmentation model v1 (© Google LLC, Apache-2.0, [model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MagicTouch.pdf)). `/cutout/LICENSE`, `/cutout/NOTICE` and `/cutout/THIRD_PARTY_LICENSES` ship beside them, the last covering the BSD, MIT and MPL-2.0 libraries in the WASM runtime.

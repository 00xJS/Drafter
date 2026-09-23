import React from 'react'
import ReactDOM from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import App, { preloadPlanner } from './App'
import { AppBoundary } from './components/ErrorBoundary'
import { startAppUpdates } from './appupdate'
import { installErrorReporting } from './errorreport'
import { prefetchRecordCache } from './idb'
import { isSupabaseConfigured, storedUserId } from './supabase'
import { applyPlatformClasses, syncNativeAppearance } from './native'
import { captureAuthorizeRequest } from './oauthRequest'
import { startTheme } from './theme'
import './styles/index.css'

// What breaks on this device reaches the site owner (src/errorreport.ts):
// listening before anything below runs, so an error while the app starts up is
// heard too. Built apps only — the web and the iOS shell; the dev server shows
// its errors on the screen already.
if (import.meta.env.PROD) installErrorReporting()

// An assistant sends the browser to /oauth/authorize?…: keep that request for
// the consent sheet (App reads it) and show "/" before anything else reads the
// address — the planner's link handling would take the query for a deep link
// and strip it on mount.
captureAuthorizeRequest()

// stamp html.native / html.ios before first paint so the native look never flashes web-first
applyPlatformClasses()
// Settings → Appearance. index.html's inline script already painted the stored
// theme; this re-applies it (should that script not have run) and keeps it true
// for the session: Match system following the device, a change made in another
// tab, and the iPhone's own status bar, keyboard and pickers.
startTheme((pref, theme) => void syncNativeAppearance(pref, theme))

// inside the iOS shell there is no service worker: the bundle IS the app.
// On the web the worker is registered here, and every load and return to the
// app checks for a newer deploy (src/appupdate.ts); Vite's dev server has none.
if (!Capacitor.isNativePlatform() && import.meta.env.PROD) startAppUpdates()

// A device that opens straight to its planner — signed in, or with no account
// to sign in to (local mode) — starts fetching the planner's chunk and reading
// its saved copy now, side by side, instead of one after the other once the
// gate has decided.
if (storedUserId() || !isSupabaseConfigured()) {
  preloadPlanner()
  prefetchRecordCache()
}

// the root boundary: anything no screen's own boundary caught is reported and
// ends on a plain Reload page, never a blank one
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppBoundary>
      <App />
    </AppBoundary>
  </React.StrictMode>,
)

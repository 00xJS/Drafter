import React from 'react'
import ReactDOM from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import App from './App'
import { startAppUpdates } from './appupdate'
import { applyPlatformClasses, syncNativeAppearance } from './native'
import { captureAuthorizeRequest } from './oauthRequest'
import { startTheme } from './theme'
import './styles/index.css'

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

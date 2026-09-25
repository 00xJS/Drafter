import type { CapacitorConfig } from '@capacitor/cli'
import { APP_HOST, APP_NAME } from './shared/apphost.mts'

// The iOS app is the same web app, bundled. It talks to the hosted API and
// Supabase exactly as the browser does — nothing is duplicated natively.
const config: CapacitorConfig = {
  appId: 'app.drafter.ios',
  appName: APP_NAME,
  webDir: 'dist',
  // What iOS puts in every permission prompt. Capacitor's default serves the
  // bundle from `localhost`, so granting the app your location asked about
  // "localhost" — a name that belongs to no app (v3.25). A web origin owns its
  // storage, so the first launch after this change starts with an empty local
  // copy and syncs the account down again; nothing on the server moves. Both
  // origins stay on the API's CORS list (shared/apphost.mts) so a phone that
  // has not been rebuilt keeps working.
  server: { hostname: APP_HOST },
  // the light ground the app opens in (THEME_GROUND.light in src/theme.ts); the
  // bridge in SceneDelegate repaints it from the saved Settings → Appearance
  backgroundColor: '#f6f7f9',
  ios: {
    contentInset: 'never',
    // the status bar follows Settings → Appearance through the window's
    // interface style (SceneDelegate): dark text on light, light text on dark
    preferredContentMode: 'mobile',
  },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
    // iOS shrinks the web view by the keyboard (src/native.ts's watchKeyboard);
    // the plugin's full-screen fix is Android's alone, and there is no Android app
    Keyboard: { resize: 'native' },
  },
}

export default config

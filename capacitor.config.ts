import type { CapacitorConfig } from '@capacitor/core'

// The iOS app is the same web app, bundled. It talks to the hosted API and
// Supabase exactly as the browser does — nothing is duplicated natively.
const config: CapacitorConfig = {
  appId: 'app.drafter.ios',
  appName: 'Drafter',
  webDir: 'dist',
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
    Keyboard: { resize: 'native', resizeOnFullScreen: true },
  },
}

export default config

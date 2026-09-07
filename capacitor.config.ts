import type { CapacitorConfig } from '@capacitor/core'

// The iOS app is the same web app, bundled. It talks to the hosted API and
// Supabase exactly as the browser does — nothing is duplicated natively.
const config: CapacitorConfig = {
  appId: 'app.drafter.ios',
  appName: 'Drafter',
  webDir: 'dist',
  backgroundColor: '#0f1115',
  ios: {
    contentInset: 'never',
    // the web app already paints its own dark chrome; keep the status bar text light
    preferredContentMode: 'mobile',
  },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
}

export default config

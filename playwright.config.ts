import { defineConfig, devices } from '@playwright/test'
import type { AppOptions } from './e2e/fixtures'

/*
 * Browser tests (`npm run e2e`): the app as it ships, built in local mode — no
 * Supabase, so every record stays in the browser's own IndexedDB — and served
 * by `vite preview` the way a deploy is served, service worker and all. Each
 * test starts from an empty planner in a fresh browser context.
 *
 * Two ways in: an iPhone in WebKit wearing the iOS shell's look (?native=1),
 * and a desktop in Chromium. They are not part of `npm run check`: Netlify runs
 * that, and it has no browsers. CI runs them in a job of their own.
 */
const PORT = 5198
/** The e2e build, apart from dist/ so it never stands in for the real one. */
const OUT = 'e2e/.dist'

export default defineConfig<AppOptions>({
  testDir: 'e2e',
  // the cloud lane's tests, which need a Supabase stack (playwright.cloud.config.ts)
  testIgnore: 'cloud/**',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 45_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    // the household's own day: "today" and "tonight" are Phoenix's, which keeps no daylight saving
    timezoneId: 'America/Phoenix',
    locale: 'en-US',
    // page.route cannot see a request a service worker answers, so the worker is
    // left out except where it is the thing under test (offline.spec.ts)
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'iphone-webkit', use: { ...devices['iPhone 16'], appPath: '/?native=1' } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], appPath: '/' } },
  ],
  webServer: {
    command: `npx vite build --outDir ${OUT} --emptyOutDir && npx vite preview --outDir ${OUT} --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // local mode, whatever .env.local holds: an empty value outranks the file
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    timeout: 240_000,
    reuseExistingServer: false,
  },
})

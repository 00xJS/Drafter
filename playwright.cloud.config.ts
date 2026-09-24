import { defineConfig, devices } from '@playwright/test'
import type { CloudOptions } from './e2e/cloud/fixtures'
import { readLane } from './e2e/cloud/lane'

/*
 * The cloud lane (`npm run e2e:cloud`): the app as it ships, built in cloud
 * mode against a local Supabase stack (`supabase start`) and served by `vite
 * preview`. Sign-in, the sync_posts round, the last-write-wins trigger and
 * Realtime all run for real; only Netlify's functions are answered in the
 * page (e2e/cloud/api.ts). CI starts the stack in a job of its own
 * (.github/workflows/ci.yml, e2e-cloud); this Mac has no Docker to run one.
 *
 * The stack comes from the four settings e2e/cloud/lane.ts declares. Without
 * them every test is skipped, saying why; with one that is not this machine,
 * nothing runs at all. The build is handed the stack's address and key
 * explicitly, which outranks .env.local and its production address, and
 * global-setup.ts reads the built bundle back to be sure.
 */
const PORT = 5197
/** The cloud build, apart from dist/ and from the local lane's e2e/.dist. */
const OUT = 'e2e/.dist-cloud'

const lane = readLane(
  {
    E2E_SUPABASE_URL: process.env.E2E_SUPABASE_URL,
    E2E_SUPABASE_ANON_KEY: process.env.E2E_SUPABASE_ANON_KEY,
    E2E_SUPABASE_SERVICE_ROLE_KEY: process.env.E2E_SUPABASE_SERVICE_ROLE_KEY,
    E2E_DATABASE_URL: process.env.E2E_DATABASE_URL,
  },
  !!process.env.CI,
)
if (lane.skip) console.log(lane.skip)

export default defineConfig<CloudOptions>({
  testDir: 'e2e/cloud',
  // one at a time: each test drives two browsers against one stack, and the
  // Realtime window it asserts (seconds) should not be spent waiting for a CPU
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-cloud' }]],
  outputDir: 'test-results-cloud',
  timeout: 90_000,
  // the stack answers, has every migration, and is what the bundle points at
  globalSetup: './e2e/cloud/global-setup.ts',
  metadata: { bundle: OUT },
  use: {
    baseURL: `http://localhost:${PORT}`,
    timezoneId: 'America/Phoenix',
    locale: 'en-US',
    // page.route cannot see a request a service worker answers (/api/* above all)
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    stack: lane.stack,
    skipReason: lane.skip ?? '',
  },
  projects: [{ name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: lane.stack
    ? {
        command: `npx vite build --outDir ${OUT} --emptyOutDir && npx vite preview --outDir ${OUT} --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}`,
        // cloud mode against the local stack, whatever .env.local holds: a
        // variable already set outranks Vite's .env files. No API base: /api
        // is the page's own origin, where the lane answers it.
        env: { VITE_SUPABASE_URL: lane.stack.url, VITE_SUPABASE_ANON_KEY: lane.stack.anonKey, VITE_API_BASE: '' },
        timeout: 240_000,
        reuseExistingServer: false,
      }
    : undefined,
})

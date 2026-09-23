// What every test run starts from, whatever machine it is on.
//
// The build host is not a clean room. Netlify's build environment carries the
// site's real environment variables — including BACKUP_PASSPHRASE, which the
// owner set on 2026-09-21 — so a test that reads `process.env` directly passes
// on a laptop and on GitHub Actions, and fails on the one machine that
// actually ships the site. That is exactly what happened: `backupEncryptionOn`
// answered true where a test expected false, and runBackup wrote an encrypted
// envelope where a test from before encryption expected a plain snapshot. It
// happened again on 2026-09-23: the site's ANTHROPIC_API_KEY made email-in's
// "no AI provider" test find one.
//
// So the environment a test sees is decided HERE, not inherited. A test that
// wants a variable sets it itself and puts it back afterwards; everything else
// can rely on it being absent. ambient-env.test.ts holds this list to every
// variable the code reads, so a new one cannot be missed.

/**
 * Variables that change what the code under test does, cleared before anything
 * runs: every one the app's code reads.
 *
 * The two Supabase settings for the browser decide whether the app runs in
 * cloud or local mode, and every test is written against local mode. They
 * reach vitest from `.env.local` on a laptop, from the site's environment on
 * Netlify, and as placeholders on GitHub, where CI builds with them so the
 * precache budget measures the bundle production ships. A test that wants
 * cloud mode stubs them itself (vi.stubEnv).
 */
export const DECIDED_HERE = [
  // the browser's Supabase settings: cloud or local mode
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  // the server's own settings and secrets
  'AI_PROVIDER',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_WORKSPACE_ID',
  'APNS_BUNDLE_ID',
  'APNS_ENV',
  'APNS_KEY_ID',
  'APNS_PRIVATE_KEY',
  'APNS_TEAM_ID',
  'APPLE_BUNDLE_ID',
  'APPLE_TEAM_ID',
  'BACKUP_PASSPHRASE',
  'BOT_DB_KEY',
  'BOT_TOKEN',
  'CSP_ENFORCE',
  'DIGEST_FROM',
  'GITHUB_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MCP_RATE_LIMIT_PER_MIN',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'NVIDIA_MODEL',
  'OAUTH_REDIRECT_ALLOWLIST',
  'OAUTH_STATE_SECRET',
  'RESEND_API_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_URL',
  'VAPID_PRIVATE_KEY',
  'VAPID_PUBLIC_KEY',
  'VAPID_SUBJECT',
  // what Netlify's build image says about the build
  'BRANCH',
  'COMMIT_REF',
  'CONTEXT',
  'DEPLOY_ID',
  'DEPLOY_PRIME_URL',
  'DRAFTER_GATED_DEPLOYS',
  'INCOMING_HOOK_TITLE',
  'INCOMING_HOOK_URL',
  'PULL_REQUEST',
  'URL',
  // the off-site backup and the connector's stdio proxy, on the owner's Mac
  'DRAFTER_AGENT_TOKEN',
  'DRAFTER_MCP_TIMEOUT_MS',
  'DRAFTER_MCP_URL',
]

/** The NVIDIA keys, however many the host has: NVIDIA_API_KEY, NVIDIA_API_KEY_2 and on (lib/ai.mjs, NVIDIA_KEY_NAME). */
export const NVIDIA_KEYS_DECIDED_HERE = /^NVIDIA_API_KEY(?:_([1-9]\d{0,2}))?$/

/** Whether the setup, not the host, decides `name`. */
export const decidedHere = (name: string) => DECIDED_HERE.includes(name) || NVIDIA_KEYS_DECIDED_HERE.test(name)

for (const key of Object.keys(process.env)) if (decidedHere(key)) delete process.env[key]

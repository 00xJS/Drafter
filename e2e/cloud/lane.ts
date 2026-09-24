// The cloud lane's settings (npm run e2e:cloud): where the local Supabase
// stack is, as `supabase status` prints it. These four names are all the lane
// takes from the environment, besides CI: src/__tests__/ambient-env.test.ts
// holds e2e/ and the Playwright configs to this list. Nothing here reads the
// environment itself; playwright.cloud.config.ts hands the values in.

/** The variables the lane declares, and reads by name in playwright.cloud.config.ts. */
export const LANE_ENV = ['E2E_SUPABASE_URL', 'E2E_SUPABASE_ANON_KEY', 'E2E_SUPABASE_SERVICE_ROLE_KEY', 'E2E_DATABASE_URL'] as const

export type LaneName = (typeof LANE_ENV)[number]

/** The local stack the lane runs against. */
export interface Stack {
  /** The API gateway: sign-in, the database's RPC and Realtime (API_URL). */
  url: string
  /** What the built app signs its requests with, as a deploy's bundle does (ANON_KEY). */
  anonKey: string
  /** The admin key the lane makes its accounts with; never reaches a browser (SERVICE_ROLE_KEY). */
  serviceKey: string
  /** Postgres itself, for psql (DB_URL). */
  dbUrl: string
}

/** The only hosts the lane will talk to. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1']

export const isLocalHost = (hostname: string): boolean => LOCAL_HOSTS.includes(hostname)

/**
 * The value of `name` as an address on this machine, or a throw. The lane
 * builds the app against it and signs in to it, so an address of a hosted
 * project — production's is in .env.local — is refused before anything runs,
 * whatever else is set.
 */
function localAddress(name: LaneName, value: string, protocols: string[]): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} is not an address: the cloud lane expects what \`supabase status\` prints for a local stack.`)
  }
  if (!protocols.includes(url.protocol)) throw new Error(`${name} must be a ${protocols.join(' or ')} address, not ${url.protocol}`)
  if (!isLocalHost(url.hostname)) {
    throw new Error(`${name} points at ${url.hostname}. The cloud lane runs only against a local stack (${LOCAL_HOSTS.join(' or ')}), never a hosted project.`)
  }
  // libpq takes a host from the query string over the one before it
  for (const key of ['host', 'hostaddr', 'service']) {
    if (url.searchParams.has(key)) throw new Error(`${name} names a ${key} in its query string; the cloud lane connects only to the host the address itself names.`)
  }
  return value.replace(/\/+$/, '')
}

/**
 * The stack the settings name. With none of them set the lane is skipped,
 * and says why — except on CI, where a job that meant to run it and skipped
 * it would pass having tested nothing. Some set and some not is a mistake
 * either way.
 */
export function readLane(env: Partial<Record<LaneName, string>>, ci: boolean): { stack: Stack; skip: null } | { stack: null; skip: string } {
  const missing = LANE_ENV.filter(name => !env[name]?.trim())
  const why = `the cloud lane needs a local Supabase stack: \`supabase start\`, then set ${LANE_ENV.join(', ')} from \`supabase status -o env\` (API_URL, ANON_KEY, SERVICE_ROLE_KEY, DB_URL).`
  if (missing.length === LANE_ENV.length && !ci) return { stack: null, skip: `Skipped: ${why}` }
  // the ones that are set are checked first: a hosted address is refused even beside a missing one
  const url = env.E2E_SUPABASE_URL?.trim() ? localAddress('E2E_SUPABASE_URL', env.E2E_SUPABASE_URL.trim(), ['http:', 'https:']) : ''
  const dbUrl = env.E2E_DATABASE_URL?.trim() ? localAddress('E2E_DATABASE_URL', env.E2E_DATABASE_URL.trim(), ['postgres:', 'postgresql:']) : ''
  if (missing.length > 0) throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set: ${why}`)
  return { stack: { url, anonKey: env.E2E_SUPABASE_ANON_KEY!.trim(), serviceKey: env.E2E_SUPABASE_SERVICE_ROLE_KEY!.trim(), dbUrl }, skip: null }
}

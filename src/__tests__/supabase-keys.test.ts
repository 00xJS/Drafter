import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keyHeaders, legacyKey, userHeaders } from '../../netlify/functions/lib/supabasekeys.mjs'
import { rest, storage } from '../../netlify/functions/lib/backup.mjs'
import { serviceHeaders } from '../../netlify/functions/lib/feedrows.mjs'

// Supabase is retiring the legacy anon and service_role keys — JWTs, which
// begin "eyJ" — for publishable and secret keys, which are opaque strings. A
// new-style key sent on Authorization: Bearer as well as apikey is read as a
// JWT and the request refused ("Invalid JWT"), so it goes on apikey alone,
// while a legacy key keeps both headers exactly as it has always had them.
// These pin the one test that decides (lib/supabasekeys.mjs) and the call
// sites that spend the service key, so no refactor can quietly put a
// new-style key back on the bearer and lock the owner out of their own data.

const LEGACY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service-role.signature'
const SECRET = 'sb_secret_Ax7yQ2bL0pNc'
const PUBLISHABLE = 'sb_publishable_Kz3mR8tW1vDe'
const SUPABASE = 'https://db.example.test'

describe('which headers a Supabase key goes on', () => {
  it('sends a legacy JWT key on apikey and the bearer, as every call site always did', () => {
    expect(legacyKey(LEGACY)).toBe(true)
    expect(keyHeaders(LEGACY)).toStrictEqual({ apikey: LEGACY, authorization: `Bearer ${LEGACY}` })
  })

  it('sends a new-style secret or publishable key on apikey alone', () => {
    for (const key of [SECRET, PUBLISHABLE]) {
      expect(legacyKey(key)).toBe(false)
      expect(keyHeaders(key)).toStrictEqual({ apikey: key })
    }
  })

  it('counts anything that is not a JWT as new style, a key the host has not set included', () => {
    expect(legacyKey(undefined)).toBe(false)
    expect(legacyKey('')).toBe(false)
    expect(keyHeaders(undefined)).toStrictEqual({ apikey: undefined })
  })

  it('passes the content type and everything else a caller sends through, and lets it win', () => {
    const extra = { 'content-type': 'application/json', prefer: 'return=minimal' }
    expect(keyHeaders(SECRET, extra)).toStrictEqual({ apikey: SECRET, ...extra })
    expect(keyHeaders(LEGACY, extra)).toStrictEqual({ apikey: LEGACY, authorization: `Bearer ${LEGACY}`, ...extra })
    expect(keyHeaders(LEGACY, { authorization: 'Bearer someone-else' }).authorization).toBe('Bearer someone-else')
  })

  it('never drops a person’s own token, whichever shape the key beside it has', () => {
    expect(userHeaders(PUBLISHABLE, 'jwt-of-the-user')).toStrictEqual({ apikey: PUBLISHABLE, authorization: 'Bearer jwt-of-the-user' })
    expect(userHeaders(`${LEGACY}-anon`, 'jwt-of-the-user')).toStrictEqual({ apikey: `${LEGACY}-anon`, authorization: 'Bearer jwt-of-the-user' })
    expect(userHeaders(PUBLISHABLE, 'jwt-of-the-user', { 'content-type': 'application/json' })['content-type']).toBe('application/json')
  })
})

describe('the calls that spend the service key', () => {
  /** Every request the stubbed fetch saw, with its headers as they were sent. */
  let sent: { url: string; headers: Record<string, string> }[]

  const withKey = (key: string) => {
    vi.stubEnv('SUPABASE_URL', SUPABASE)
    vi.stubEnv('SUPABASE_SERVICE_KEY', key)
  }

  beforeEach(() => {
    sent = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) })
        return Response.json([])
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('reads rows, storage and the feed with a legacy key on both headers', async () => {
    withKey(LEGACY)
    await rest('posts?select=id')
    await storage('/object/list/media', { method: 'POST', body: '{}' })
    expect(sent.map(r => r.url)).toEqual([`${SUPABASE}/rest/v1/posts?select=id`, `${SUPABASE}/storage/v1/object/list/media`])
    for (const r of sent) expect(r.headers).toMatchObject({ apikey: LEGACY, authorization: `Bearer ${LEGACY}` })
    expect(serviceHeaders()).toStrictEqual({ apikey: LEGACY, authorization: `Bearer ${LEGACY}` })
  })

  it('sends a secret key on apikey alone, and leaves everything else about the call as it was', async () => {
    withKey(SECRET)
    await rest('posts?select=id')
    await storage('/object/list/media', { method: 'POST', body: '{}' })
    for (const r of sent) {
      expect(r.headers.apikey).toBe(SECRET)
      expect(r.headers.authorization).toBeUndefined()
    }
    expect(sent[0].headers['content-type']).toBe('application/json')
    expect(serviceHeaders()).toStrictEqual({ apikey: SECRET })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Browser push. web-push was called with no timeout, so one endpoint that
// stalled held the hourly digest until Netlify stopped the run, and every
// account after it lost that hour; APNs has had an 8-second stop since the
// 09-23 review. And subscribe took any endpoint string at all, so a signed-in
// account could have the server POST to an address of its choosing. web-push
// itself is stubbed here: what it was asked to do is the point.

const { sends } = vi.hoisted(() => ({
  sends: [] as { endpoint: string; options: Record<string, unknown>; settle: 'ok' | 'never' | number }[],
}))
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: (sub: { endpoint: string }, _payload: string, options: Record<string, unknown>) => {
      const settle = sub.endpoint.includes('stalled') ? 'never' : sub.endpoint.includes('expired') ? 410 : 'ok'
      sends.push({ endpoint: sub.endpoint, options, settle })
      if (settle === 'never') return new Promise(() => {})
      if (typeof settle === 'number') return Promise.reject(Object.assign(new Error('Received unexpected response code'), { statusCode: settle, body: 'gone' }))
      return Promise.resolve({ statusCode: 201 })
    },
  },
}))

// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import pushFunction, { WEB_PUSH_TIMEOUT_MS, knownPushEndpoint, sendToAll } from '../../netlify/functions/push.mjs'

const push = pushFunction as (req: Request) => Promise<Response>
const SUPABASE = 'https://db.example.test'
const USER = 'user-1'
// a real key's shape: 65 bytes of public key, 16 of auth secret, base64url
const P256DH = Buffer.alloc(65, 4).toString('base64url')
const AUTH = Buffer.alloc(16, 7).toString('base64url')
const FCM = 'https://fcm.googleapis.com/fcm/send/abc:APA91b-xyz'

let row: Record<string, unknown>
let saved: Record<string, unknown>[]
/** What the auth server says about the session's account. */
let account: Record<string, unknown>

beforeEach(() => {
  sends.length = 0
  row = { user_id: USER }
  saved = []
  account = { id: USER, email: 'me@example.test' }
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('VAPID_PUBLIC_KEY', 'public')
  vi.stubEnv('VAPID_PRIVATE_KEY', 'private')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${SUPABASE}/auth/v1/user`) return Response.json(account)
      if (url.startsWith(`${SUPABASE}/rest/v1/user_settings?user_id=eq.${USER}`)) return Response.json([row])
      if (url === `${SUPABASE}/rest/v1/user_settings?on_conflict=user_id` && init?.method === 'POST') {
        const { user_id: _id, ...patch } = JSON.parse(String(init.body))
        saved.push(patch)
        row = { ...row, ...patch }
        return new Response(null, { status: 201 })
      }
      throw new Error(`unexpected ${url}`)
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const web = (endpoint: string) => ({ endpoint, keys: { p256dh: P256DH, auth: AUTH } })

describe('sending to browsers', () => {
  it('gives web-push a timeout of eight seconds, as APNs has', async () => {
    await sendToAll([web(FCM)], { title: 'Drafter', body: 'Hello', tag: 'test' })
    expect(WEB_PUSH_TIMEOUT_MS).toBe(8_000)
    expect(sends).toEqual([{ endpoint: FCM, options: { TTL: 6 * 3600, timeout: 8_000 }, settle: 'ok' }])
  })

  it('gives up on a push service that never answers at eight seconds, and the others still go', async () => {
    vi.useFakeTimers()
    const stalled = 'https://fcm.googleapis.com/fcm/send/stalled'
    let out: Awaited<ReturnType<typeof sendToAll>> | undefined
    sendToAll([web(stalled), web(FCM), web('https://updates.push.services.mozilla.com/wpush/v2/expired')], { title: 'Drafter', body: 'Hello', tag: 'digest' }).then(
      (r: Awaited<ReturnType<typeof sendToAll>>) => (out = r),
    )
    await vi.advanceTimersByTimeAsync(WEB_PUSH_TIMEOUT_MS - 1)
    expect(out).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(out).toEqual({
      gone: ['https://updates.push.services.mozilla.com/wpush/v2/expired'],
      failed: [{ endpoint: stalled, kind: 'web', statusCode: 0, body: 'The push service did not answer within 8000 ms' }],
      updated: [],
    })
    expect(sends.map(s => s.endpoint)).toHaveLength(3)
  })

  it('never sends to an address that is no push service, and drops it like an expired one', async () => {
    const out = await sendToAll([web('https://169.254.169.254/latest/meta-data'), web(FCM)], { title: 'Drafter', body: 'Hello', tag: 'digest' })
    expect(sends.map(s => s.endpoint)).toEqual([FCM])
    expect(out).toEqual({ gone: ['https://169.254.169.254/latest/meta-data'], failed: [], updated: [] })
  })
})

describe('which endpoints are push services', () => {
  it.each([
    FCM,
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
    'https://web.push.apple.com/QGuQyavXutnMH-long-token',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB',
  ])('a browser’s: %s', endpoint => {
    expect(knownPushEndpoint(endpoint)).toBe(true)
  })

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://user:pass@fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/fcm/send/abc',
    'https://evilnotify.windows.com/w/?token=x',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/admin',
    'https://example.test/push',
    'not a url',
    '',
  ])('not a push service: %s', endpoint => {
    expect(knownPushEndpoint(endpoint)).toBe(false)
  })

  it('nor anything that is not a string, or runs past 2 KiB', () => {
    for (const bad of [null, undefined, 42, { href: FCM }]) expect(knownPushEndpoint(bad)).toBe(false)
    expect(knownPushEndpoint(`${FCM}/${'x'.repeat(2048)}`)).toBe(false)
  })
})

describe('POST /api/push subscribe', () => {
  const subscribe = (subscription: unknown) =>
    push(
      new Request('https://site.test/api/push', {
        method: 'POST',
        headers: { authorization: 'Bearer session', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'subscribe', subscription, timezone: 'America/Phoenix' }),
      }),
    )

  it('keeps a browser’s subscription to its push service, and only the fields it needs', async () => {
    const res = await subscribe({ ...web(FCM), expirationTime: null, extra: 'dropped', keys: { p256dh: P256DH, auth: AUTH, extra: 'dropped' } })
    expect(res.status).toBe(200)
    expect(saved).toEqual([{ push_subscriptions: [{ endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH }, expirationTime: null }], timezone: 'America/Phoenix' }])
  })

  it.each([
    ['an address that is no push service', web('https://169.254.169.254/latest/meta-data')],
    ['plain http', web('http://fcm.googleapis.com/fcm/send/abc')],
    ['a look-alike host', web('https://fcm.googleapis.com.evil.example/fcm/send/abc')],
    ['a public key that is not one', { endpoint: FCM, keys: { p256dh: 'short', auth: AUTH } }],
    ['an auth secret that is not base64url', { endpoint: FCM, keys: { p256dh: P256DH, auth: 'not base64!' } }],
    ['no keys', { endpoint: FCM }],
  ])('refuses %s, and saves nothing', async (_what, subscription) => {
    const res = await subscribe(subscription)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid subscription' })
    expect(saved).toEqual([])
  })
})

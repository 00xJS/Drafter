import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DigestEmail } from '../components/settings/Reminders'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import pushFunction, { testPushBody } from '../../netlify/functions/push.mjs'

// "Also email me the morning digest" was offered on a site with no way to send
// email, so switching it on did nothing and said nothing. /api/push now says
// whether email can go at all, and Settings offers the switch only then. And
// the test push promised "a nudge when timed tasks come due", which an iPhone
// never gets from the server any more (it reminds of its own due tasks).

type Handler = (req: Request) => Promise<Response>
const push = pushFunction as Handler
const SUPABASE = 'https://db.example.test'
const USER = 'user-1'
let row: Record<string, unknown>
let saved: Record<string, unknown>[]

beforeEach(() => {
  row = { user_id: USER, digest_email: true }
  saved = []
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('RESEND_API_KEY', '')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${SUPABASE}/auth/v1/user`) return Response.json({ id: USER, email: 'me@example.test' })
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
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const get = async () => (await push(new Request('https://site.test/api/push', { headers: { authorization: 'Bearer session' } }))).text()
const post = (body: Record<string, unknown>) =>
  push(new Request('https://site.test/api/push', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify(body) }))

describe('"Tell me when someone updates a task we share"', () => {
  it('reads as on until switched off, as a row from before the switch does', async () => {
    expect(JSON.parse(await get())).toMatchObject({ notifyActivity: true })
    row = { ...row, notify_activity: false }
    expect(JSON.parse(await get())).toMatchObject({ notifyActivity: false })
  })

  it('saves on a host with no push at all, since the hub keeps notices anyway', async () => {
    for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY', 'APNS_BUNDLE_ID']) vi.stubEnv(key, '')
    expect((await post({ action: 'prefs', digestEmail: false, digestHour: 8, notifyActivity: false })).status).toBe(200)
    expect(saved).toContainEqual({ notify_activity: false })
    expect(JSON.parse(await get())).toMatchObject({ notifyActivity: false })
  })

  it('saves with the other push preferences, and only when it is sent', async () => {
    vi.stubEnv('VAPID_PUBLIC_KEY', 'public')
    vi.stubEnv('VAPID_PRIVATE_KEY', 'private')
    await post({ action: 'prefs', digestEmail: false, digestHour: 7, notifyActivity: false, timezone: 'America/Phoenix' })
    expect(saved).toEqual([{ digest_email: false, notify_activity: false, timezone: 'America/Phoenix', digest_hour: 7 }])
    await post({ action: 'prefs', digestEmail: false, digestHour: 7, timezone: 'America/Phoenix' })
    expect(saved[1]).not.toHaveProperty('notify_activity')
  })
})

describe('/api/push says whether the digest can go by email', () => {
  it('no, on a site with no way to send it', async () => {
    expect(JSON.parse(await get())).toMatchObject({ emailConfigured: false, digestEmail: true })
  })

  it('yes once it can — and never the key itself', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_secret_123')
    const body = await get()
    expect(JSON.parse(body)).toMatchObject({ emailConfigured: true })
    expect(body).not.toContain('re_secret_123')
  })
})

describe('Settings offers the email switch only where email can go', () => {
  const draw = (configured: boolean) =>
    renderToStaticMarkup(<DigestEmail email="me@example.test" on={true} configured={configured} hour={8} onChange={() => {}} onHour={() => {}} />)

  it('the switch, with the address it goes to, and the hour', () => {
    const html = draw(true)
    expect(html).toContain('Also email me the morning digest (me@example.test)')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<select')
  })

  it('says, in one line under the digest, that the 1st brings last month’s recap too', () => {
    for (const configured of [true, false]) {
      const html = draw(configured)
      expect(html.match(/last month’s highlights/g), String(configured)).toHaveLength(1)
      expect(html).toContain('<p class="field-hint">On the 1st it also brings last month’s highlights, from your own log.</p>')
    }
  })

  it('without email, no switch: a line that says so, and the hour push still keeps', () => {
    const html = draw(false)
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('Also email me')
    expect(html).toContain('The digest comes by push only: email isn’t set up on this site.')
    expect(html).toContain('<select')
    // it says what is so, and asks nobody to set anything up
    expect(html).not.toMatch(/resend|provider|api key|set it up/i)
  })
})

describe('the test push promises only what every device gets', () => {
  it('the digest, the household’s messages, and word of a shared task someone else updated', () => {
    const body = testPushBody({})
    expect(body).toBe('Push is on: a digest each morning, messages from your household, and word when someone updates a task you share.')
    expect(body).not.toMatch(/due|timed/i)
  })

  it('the digest and the messages, which have no switch, when that word is switched off', () => {
    expect(testPushBody({ notify_activity: false })).toBe('Push is on: a digest each morning, and messages from your household.')
  })
})

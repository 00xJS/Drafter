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

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('RESEND_API_KEY', '')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `${SUPABASE}/auth/v1/user`) return Response.json({ id: USER, email: 'me@example.test' })
      if (url.startsWith(`${SUPABASE}/rest/v1/user_settings?user_id=eq.${USER}`)) return Response.json([{ user_id: USER, digest_email: true }])
      throw new Error(`unexpected ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const get = async () => (await push(new Request('https://site.test/api/push', { headers: { authorization: 'Bearer session' } }))).text()

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
  it('the digest, and word of a shared task someone else updated', () => {
    const body = testPushBody({})
    expect(body).toBe('Push is on: a digest each morning, and word when someone updates a task you share.')
    expect(body).not.toMatch(/due|timed/i)
  })

  it('the digest alone when that word is switched off', () => {
    expect(testPushBody({ notify_activity: false })).toBe('Push is on: a digest each morning.')
  })
})

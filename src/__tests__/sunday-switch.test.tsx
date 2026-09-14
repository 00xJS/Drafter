import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SundayDraft } from '../components/settings/Reminders'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import pushFunction from '../../netlify/functions/push.mjs'

// Sunday's review draft runs for every account, push or not, so its one
// switch — may the draft read my journal — shows and saves without push. It
// sat inside Settings → Reminders' push block, which /api/push answered 501
// to, so the owner (no push) could neither see nor save it.

type Handler = (req: Request) => Promise<Response>
const push = pushFunction as Handler
const SUPABASE = 'https://db.example.test'
const USER = 'user-1'
const ROW = `${SUPABASE}/rest/v1/user_settings?user_id=eq.${USER}&select=*`
const UPSERT = `${SUPABASE}/rest/v1/user_settings?on_conflict=user_id`

let row: Record<string, unknown> | null
let saved: Record<string, unknown>[]

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  // no web push and no APNs: the owner's host
  for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY', 'APNS_BUNDLE_ID']) vi.stubEnv(key, '')
  row = null
  saved = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${SUPABASE}/auth/v1/user`) return Response.json({ id: USER, email: 'me@example.test' })
      if (url === ROW) return Response.json(row ? [row] : [])
      if (url === UPSERT && init?.method === 'POST') {
        const { user_id: _id, ...patch } = JSON.parse(String(init.body))
        saved.push(patch)
        row = { ...(row ?? { user_id: USER }), ...patch }
        return new Response(null, { status: 201 })
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const call = (method: 'GET' | 'POST', body?: Record<string, unknown>) =>
  push(
    new Request('https://site.test/api/push', {
      method,
      headers: { authorization: 'Bearer session', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
  )

describe('/api/push without push: Sunday’s journal switch still reads and saves', () => {
  it('reads the saved switch, and no subscription the host cannot send to', async () => {
    row = { user_id: USER, digest_journal: true, digest_hour: 7, push_subscriptions: [{ endpoint: 'apns:abc', type: 'apns', token: 'abc' }] }
    expect(await (await call('GET')).json()).toMatchObject({ configured: false, sundayDraft: true, digestJournal: true, digestHour: 7, subscriptions: [] })
  })

  it('saves the switch, and the zone Sunday is counted in when there is none, but nothing that is push’s', async () => {
    const res = await call('POST', { action: 'prefs', digestEmail: true, digestHour: 6, digestJournal: true, timezone: 'Europe/London' })
    expect(res.status).toBe(200)
    expect(saved).toEqual([{ digest_journal: true }, { timezone: 'Europe/London' }])
    expect((await (await call('GET')).json()).digestJournal).toBe(true)
  })

  it('never moves a zone already saved', async () => {
    row = { user_id: USER, timezone: 'Asia/Tokyo' }
    await call('POST', { action: 'prefs', digestEmail: false, digestHour: 8, digestJournal: false, timezone: 'Europe/London' })
    expect(saved).toEqual([{ digest_journal: false }])
    expect(row?.timezone).toBe('Asia/Tokyo')
  })

  it('still refuses what needs push', async () => {
    for (const action of ['subscribe', 'unsubscribe', 'test']) expect((await call('POST', { action })).status).toBe(501)
    expect(saved).toEqual([])
  })

  it('offers no switch where there is nowhere to keep it', async () => {
    vi.stubEnv('SUPABASE_SERVICE_KEY', '')
    expect((await (await call('GET')).json()).sundayDraft).toBe(false)
    expect((await call('POST', { action: 'prefs', digestJournal: true })).status).toBe(501)
    expect(saved).toEqual([])
  })
})

describe('/api/push says whether the host can write the draft at all', () => {
  // the digest drafts only when resolveProvider() finds a key (digest.mjs)
  beforeEach(() => {
    for (const key of ['NVIDIA_API_KEY', 'ANTHROPIC_API_KEY', 'AI_PROVIDER']) vi.stubEnv(key, '')
  })

  it('no when the host has no AI key', async () => {
    expect(await (await call('GET')).json()).toMatchObject({ sundayDraft: true, aiConfigured: false })
  })

  it('yes with either key, and never the key itself or whose it is', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-secret-123')
    const body = await (await call('GET')).text()
    expect(JSON.parse(body)).toMatchObject({ aiConfigured: true })
    expect(body).not.toContain('nvapi-secret-123')
    expect(body).not.toMatch(/nvidia|anthropic/i)
    vi.stubEnv('NVIDIA_API_KEY', '')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret')
    expect((await (await call('GET')).json()).aiConfigured).toBe(true)
  })

  it('no when AI_PROVIDER names a provider whose key is missing, as the digest reads it', async () => {
    vi.stubEnv('AI_PROVIDER', 'anthropic')
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-secret-123')
    expect((await (await call('GET')).json()).aiConfigured).toBe(false)
  })
})

describe('/api/push with push: prefs save as before', () => {
  it('the email digest, its hour, the switch and the zone together', async () => {
    vi.stubEnv('VAPID_PUBLIC_KEY', 'public')
    vi.stubEnv('VAPID_PRIVATE_KEY', 'private')
    row = { user_id: USER, push_subscriptions: [{ endpoint: 'https://push.example/1', keys: { p256dh: 'x', auth: 'y' } }] }
    expect(await (await call('GET')).json()).toMatchObject({ configured: true, sundayDraft: true, subscriptions: ['https://push.example/1'] })
    await call('POST', { action: 'prefs', digestEmail: true, digestHour: 6, digestJournal: true, timezone: 'Europe/London' })
    expect(saved).toEqual([{ digest_email: true, digest_journal: true, timezone: 'Europe/London', digest_hour: 6 }])
  })
})

describe('Settings → Reminders: the switch stands apart from push', () => {
  it('says what it does and nothing about push', () => {
    const off = renderToStaticMarkup(<SundayDraft journal={false} onChange={() => {}} />)
    expect(off).toContain('Sunday’s review')
    expect(off).toContain('Let Sunday’s draft read my journal')
    expect(off).toContain('The week’s entries go to the AI provider with the draft.')
    expect(off).not.toMatch(/push|notification|digest/i)
    expect(off).not.toContain('checked')
    expect(renderToStaticMarkup(<SundayDraft journal onChange={() => {}} />)).toContain('checked=""')
  })

  it('is drawn whenever the server says the draft runs, outside the push block', () => {
    const source = readFileSync(fileURLToPath(new URL('../components/settings/Reminders.tsx', import.meta.url)), 'utf8')
    const body = source.slice(source.indexOf('export function Reminders('))
    const pushBlock = body.slice(body.indexOf('{push?.configured ? ('), body.indexOf(') : push ? ('))
    expect(pushBlock.length).toBeGreaterThan(0)
    expect(pushBlock).not.toContain('SundayDraft')
    expect(pushBlock).not.toContain('digestJournal')
    expect(body).toMatch(/\{push\?\.sundayDraft && \(\s*<SundayDraft /)
    // disabled only on the server's own no: an older server that does not say reads as yes
    expect(body).toMatch(/<SundayDraft[^>]*\bai=\{push\.aiConfigured !== false\}/)
  })

  it('is disabled, with the reason in one line, where the host has no AI key', () => {
    const none = renderToStaticMarkup(<SundayDraft journal ai={false} onChange={() => {}} />)
    expect(none).toContain('Let Sunday’s draft read my journal')
    expect(none).toMatch(/<input type="checkbox"[^>]*disabled=""/)
    expect(none).toContain('No Sunday draft is written: the server has no AI provider key.')
    // no promise of a draft that will never come, and no key name for an account that cannot set one
    expect(none).not.toContain('drafted for you')
    expect(none).not.toContain('go to the AI provider')
    expect(none).not.toMatch(/NVIDIA|ANTHROPIC|API_KEY/)
    expect(renderToStaticMarkup(<SundayDraft journal onChange={() => {}} />)).not.toContain('disabled')
  })
})

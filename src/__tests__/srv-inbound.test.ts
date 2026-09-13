import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import inboundFunction, { BUDGET_MS, CALL_MS } from '../../netlify/functions/inbound.mjs'

// The email webhook made every outbound call with no timeout, so one provider
// that never answered held the function until Netlify killed it. Fake time
// here: each test advances the clock until the webhook answers, and fails if it
// never does.

const inbound = inboundFunction as (req: Request) => Promise<Response>
const SUPABASE = 'https://db.example.test'
const KEY = 'k'.repeat(24)

type Route = 'settings' | 'store' | 'claim' | 'ai'
let slow: Set<Route>
let calls: Route[]
let aiReply = ''
/** The user_settings row the token finds. */
let settingsRow: Record<string, unknown>
/** Each task sent to sync_posts, in order: the raw one, then the triaged one. */
let stored: Record<string, unknown>[]
/** The user message of each model call. */
let prompts: string[]

/** A request that only ever ends by being aborted, like a provider that stopped answering. */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('NVIDIA_API_KEY', 'nvidia-key')
  slow = new Set()
  calls = []
  aiReply = '{"title":"Pay the plumber","priority":"high"}'
  settingsRow = { user_id: 'user-one', inbound_token: KEY }
  stored = []
  prompts = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const route: Route = url.includes('/user_settings?')
        ? 'settings'
        : url.endsWith('/rpc/sync_posts')
          ? 'store'
          : url.includes('/rest/v1/posts?id=eq.')
            ? 'claim'
            : url.startsWith('https://integrate.api.nvidia.com/')
              ? 'ai'
              : (() => {
                  throw new Error(`unexpected fetch ${url}`)
                })()
      calls.push(route)
      if (route === 'store') stored.push(JSON.parse(String(init?.body)).incoming[0])
      if (route === 'ai') prompts.push(JSON.parse(String(init?.body)).messages.at(-1).content)
      if (slow.has(route)) return hang(init)
      if (route === 'settings') return Response.json([settingsRow])
      if (route === 'store') return Response.json({ items: [], rejected: [] })
      if (route === 'claim') return new Response(null, { status: 204 })
      return Response.json({ choices: [{ message: { content: aiReply } }] })
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const email = (mail = { subject: 'Invoice 42', text: 'Please pay by Friday.', from: 'plumber@example.test' }) =>
  new Request(`https://site.test/api/inbound?key=${KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mail),
  })

/** Advance fake time in small steps until the webhook answers; how long it took, in fake time. */
async function answer(req: Request) {
  let res: Response | undefined
  inbound(req).then(r => (res = r))
  const started = Date.now()
  while (!res && Date.now() - started < 60_000) await vi.advanceTimersByTimeAsync(100)
  if (!res) throw new Error('the webhook never answered')
  return { res, elapsed: Date.now() - started }
}

describe('inbound email on a deadline', () => {
  it('stores the task and refines it when everyone answers', async () => {
    const { res } = await answer(email())
    expect(await res.json()).toMatchObject({ ok: true, title: 'Pay the plumber', triaged: true })
    expect(calls).toEqual(['settings', 'store', 'claim', 'ai', 'store', 'claim'])
  })

  it('answers 502 when the store never does, instead of hanging', async () => {
    slow.add('store')
    const { res, elapsed } = await answer(email())
    expect(res.status).toBe(502)
    expect(elapsed).toBeLessThanOrEqual(CALL_MS + 100)
  })

  it('answers 503 — try again — when the token lookup never does', async () => {
    slow.add('settings')
    const { res, elapsed } = await answer(email())
    expect(res.status).toBe(503)
    expect(elapsed).toBeLessThanOrEqual(CALL_MS + 100)
  })

  it('keeps the raw task and answers inside the budget when the AI provider never does', async () => {
    slow.add('ai')
    const { res, elapsed } = await answer(email())
    expect(await res.json()).toMatchObject({ ok: true, title: 'Invoice 42', triaged: false })
    expect(elapsed).toBeLessThan(BUDGET_MS)
    expect(calls).toEqual(['settings', 'store', 'claim', 'ai'])
  })

  it('never writes a refinement that arrives after the deadline', async () => {
    slow.add('ai')
    await answer(email())
    slow.delete('ai')
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    expect(calls.filter(c => c === 'store')).toHaveLength(1)
  })
})

// Triage never told the model the date or the owner's zone, and read a dueAt
// with no offset in the server's own zone, UTC on Netlify: "Thursday 3pm" got
// whatever week the model guessed, an hour late through a British summer. The
// clock here is fixed at Sunday 13 September 2026, 10:00 UTC, and the model's
// reply is stubbed.
describe('inbound email triage dates', () => {
  const appointment = () => email({ subject: 'Dentist', text: 'Your appointment is confirmed for Thursday 3pm.', from: 'reception@dentist.example.test' })
  /** The task as the triage pass wrote it back. */
  const triaged = () => stored[1]
  const nowLine = () => prompts[0].split('\n')[0]

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-09-13T10:00:00.000Z'))
    settingsRow.timezone = 'Europe/London'
  })

  // two zones, so a machine that happens to sit in one cannot pass by reading the time in its own
  it.each([
    ['Europe/London', 'Sunday 2026-09-13 11:00', '2026-09-17T14:00:00.000Z'],
    ['Asia/Tokyo', 'Sunday 2026-09-13 19:00', '2026-09-17T06:00:00.000Z'],
  ])('"Thursday 3pm", answered with no zone, lands on the coming Thursday at 15:00 in %s', async (timezone, now, due) => {
    settingsRow.timezone = timezone
    aiReply = '{"title":"Dentist appointment","dueAt":"2026-09-17T15:00:00"}'
    const { res } = await answer(appointment())
    expect(await res.json()).toMatchObject({ ok: true, title: 'Dentist appointment', triaged: true })
    expect(nowLine()).toBe(`Now: ${now} (${timezone})`)
    expect(triaged().dueAt).toBe(due)
    // still one model call
    expect(calls).toEqual(['settings', 'store', 'claim', 'ai', 'store', 'claim'])
  })

  it.each(['2026-09-17T15:00:00+02:00', '2026-09-17T15:00+0200', '2026-09-17T13:00:00Z'])('keeps a dueAt with an explicit offset as it is: %s', async dueAt => {
    aiReply = JSON.stringify({ title: 'Dentist appointment', dueAt })
    await answer(appointment())
    expect(triaged().dueAt).toBe('2026-09-17T13:00:00.000Z')
  })

  it('drops a dueAt more than a day in the past, and keeps the rest of the triage', async () => {
    aiReply = '{"title":"Dentist appointment","priority":"high","dueAt":"2025-09-18T15:00:00"}'
    const { res } = await answer(appointment())
    expect(await res.json()).toMatchObject({ title: 'Dentist appointment', triaged: true })
    expect(triaged()).toMatchObject({ title: 'Dentist appointment', priority: 'high' })
    expect(triaged()).not.toHaveProperty('dueAt')
  })

  it('keeps one less than a day gone', async () => {
    // 15:00 yesterday in London, twenty hours before the clock
    aiReply = '{"title":"Dentist appointment","dueAt":"2026-09-12T15:00:00"}'
    await answer(appointment())
    expect(triaged().dueAt).toBe('2026-09-12T14:00:00.000Z')
  })

  it('reads a bare day as that day in the owner’s zone, an untimed task there', async () => {
    aiReply = '{"title":"Dentist appointment","dueAt":"2026-09-17"}'
    await answer(appointment())
    expect(triaged().dueAt).toBe('2026-09-16T23:00:00.000Z')
  })

  it.each([undefined, 'Mars/Olympus_Mons'])('counts in UTC when the account’s zone is %s', async timezone => {
    settingsRow.timezone = timezone
    aiReply = '{"title":"Dentist appointment","dueAt":"2026-09-17T15:00:00"}'
    await answer(appointment())
    expect(nowLine()).toBe('Now: Sunday 2026-09-13 10:00 (UTC)')
    expect(triaged().dueAt).toBe('2026-09-17T15:00:00.000Z')
  })

  it.each(['Thursday 3pm', 'September 17, 2026 3:00 PM', '2026-11-31T15:00:00', '2026-09-17T15:00:00+01'])('drops a dueAt that is not an ISO date-time: %s', async dueAt => {
    aiReply = JSON.stringify({ title: 'Dentist appointment', dueAt })
    await answer(appointment())
    expect(triaged()).not.toHaveProperty('dueAt')
  })
})

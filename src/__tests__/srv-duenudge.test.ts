import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The server's "Due now" nudges: step 2 of each account's hourly run in
// netlify/functions/digest.mjs. Three rules, and the watermark that keeps a
// nudge from going twice or not at all:
//
// - Only a time comes due. A task with a date and no time is stored at local
//   midnight and is due all day; at 00:00 it was pushed as "Due now".
// - Only to a browser. The iOS app keeps its own task reminders with push on
//   (9am for a day with no time), so its APNs entry never hears one here.
// - Only to the person doing the task, by the rule the phones use (isMineTask).
//
// Push and the model are stubbed at their modules; the database is a fake
// that keeps what the run writes, so one run sees the last one's watermark.

const { pushes } = vi.hoisted(() => ({ pushes: [] as { to: string[]; title: string }[] }))
vi.mock('../../netlify/functions/push.mjs', () => ({
  pushConfigured: () => true,
  sendToAll: async (subs: { endpoint: string }[], payload: { title: string }) => {
    pushes.push({ to: subs.map(s => s.endpoint), title: payload.title })
    return { gone: [], failed: [], updated: [] }
  },
}))
vi.mock('../../netlify/functions/lib/ai.mjs', () => ({ resolveProvider: () => null, complete: async () => ({ error: 'no model here' }) }))

// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import digestFunction from '../../netlify/functions/digest.mjs'

const SUPABASE = 'https://db.example.test'
const REST = `${SUPABASE}/rest/v1/`
const OWNER = 'a1b2c3d4-0000-4000-8000-0000000000aa'
const PEER = 'e5f6a7b8-0000-4000-8000-0000000000bb'
const STAMP = '2026-09-01T00:00:00.000Z'
const ZONE = 'America/Phoenix'
const runDigest = digestFunction as () => Promise<Response>

/** A browser's subscription, and the iOS app's: an APNs device token. */
const browser = (who: string) => ({ endpoint: `https://push.example.test/${who}`, keys: { p256dh: 'p', auth: 'a' } })
const iphone = (who: string) => ({ endpoint: `apns:${who}0123456789abcdef0123456789abcdef`, type: 'apns', token: `${who}0123456789abcdef0123456789abcdef` })

type Row = { user_id: string | null; data: Record<string, unknown> }
let settings: Record<string, any>[]
let rows: Row[]
let households: { household_id: string; user_id: string }[]

/** An account in Phoenix whose morning digest is not due at any hour these tests run at. */
const account = (user_id: string, subs: unknown[], over: Record<string, unknown> = {}) => ({
  user_id,
  push_subscriptions: subs,
  digest_email: false,
  digest_hour: 23,
  timezone: ZONE,
  nudged: {},
  ...over,
})
const task = (user_id: string, id: string, dueAt: string, over: Record<string, unknown> = {}): Row => ({
  user_id,
  data: { kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', tags: [], dueAt, createdAt: STAMP, updatedAt: STAMP, ...over },
})
const nudges = () => pushes.filter(p => p.title.startsWith('Due now: '))
const titles = () => nudges().map(p => p.title.slice('Due now: '.length))
const watermark = (user_id: string) => settings.find(s => s.user_id === user_id)?.last_due_check

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('URL', 'https://site.test')
  vi.useFakeTimers({ toFake: ['Date'] })
  pushes.length = 0
  settings = []
  rows = []
  households = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (!url.startsWith(REST)) throw new Error(`unexpected fetch ${url}`)
      const path = url.slice(REST.length)
      if (path === 'user_settings?select=*') return Response.json(settings)
      if (path === 'rpc/owner_user_id') return Response.json(OWNER)
      if (path === 'rpc/sync_canary') return Response.json({ ok: true, checked: 15, failures: [] })
      if (path.startsWith('app_config?key=eq.sync_canary')) return Response.json([])
      if (path === 'app_config?on_conflict=key' && method === 'POST') return new Response(null, { status: 201 })
      if (path.startsWith('job_runs?job=eq.')) return Response.json([])
      if (path === 'job_runs?on_conflict=job' && method === 'POST') return new Response(null, { status: 201 })
      if (path.startsWith('posts?select=id,data,user_id&deleted=is.false&')) {
        // every row in one page, as restAll reads it
        const page = rows.map(r => ({ id: r.data.id, ...structuredClone(r) }))
        return new Response(JSON.stringify(page), { headers: { 'content-range': page.length ? `0-${page.length - 1}/${page.length}` : '*/0' } })
      }
      if (path === 'household_members?select=household_id,user_id') return Response.json(households)
      if (path.startsWith('user_settings?user_id=eq.') && method === 'PATCH') {
        Object.assign(settings.find(s => s.user_id === decodeURIComponent(path.slice('user_settings?user_id=eq.'.length))) ?? {}, body)
        return new Response(null, { status: 204 })
      }
      if (path.startsWith('posts?deleted=eq.true') && method === 'DELETE') return new Response(null, { status: 204 })
      throw new Error(`unexpected ${method} ${path}`)
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const runAt = async (iso: string) => {
  vi.setSystemTime(new Date(iso))
  return (await runDigest()).text()
}

// 23 September 2026 in Phoenix (UTC-7, no daylight saving): its midnight is 07:00 UTC
describe('a day with no time is not "due now"', () => {
  it('at the midnight it is stored at, while a task with a time just after it is', async () => {
    settings = [account(OWNER, [browser('joe')], { last_due_check: '2026-09-23T06:30:00.000Z' })]
    rows = [task(OWNER, 'Bins out', '2026-09-23T07:00:00.000Z'), task(OWNER, 'Call the vet', '2026-09-23T07:15:00.000Z')]
    await runAt('2026-09-23T07:30:00.000Z')
    expect(titles()).toEqual(['Call the vet'])
    expect(watermark(OWNER)).toBe('2026-09-23T07:30:00.000Z')
  })

  it('reads the midnight in the account’s zone, not the server’s UTC', async () => {
    // 00:00 in UTC is 17:00 the day before in Phoenix: a time there, so it comes due
    settings = [account(OWNER, [browser('joe')], { last_due_check: '2026-09-22T23:30:00.000Z' })]
    rows = [task(OWNER, 'Water the tomatoes', '2026-09-23T00:00:00.000Z')]
    await runAt('2026-09-23T00:30:00.000Z')
    expect(titles()).toEqual(['Water the tomatoes'])
  })
})

describe('"Due now" goes to a browser, never to the iPhone app', () => {
  it('nudges only the browser subscriptions an account has', async () => {
    settings = [account(OWNER, [iphone('a'), browser('joe')], { last_due_check: '2026-09-23T15:00:00.000Z' })]
    rows = [task(OWNER, 'Call the vet', '2026-09-23T15:15:00.000Z')]
    await runAt('2026-09-23T15:30:00.000Z')
    expect(nudges()).toEqual([{ to: ['https://push.example.test/joe'], title: 'Due now: Call the vet' }])
  })

  it('sends an account with only the iPhone app none, and keeps its watermark moving', async () => {
    settings = [account(OWNER, [iphone('a')], { last_due_check: '2026-09-23T15:00:00.000Z' })]
    rows = [task(OWNER, 'Call the vet', '2026-09-23T15:15:00.000Z')]
    await runAt('2026-09-23T15:30:00.000Z')
    expect(nudges()).toEqual([])
    // a browser added later starts from here, not with the last six hours at once
    expect(watermark(OWNER)).toBe('2026-09-23T15:30:00.000Z')
  })
})

describe('"Due now" goes to the person doing the task', () => {
  it('its assignee, or whoever filed it when nobody is', async () => {
    households = [
      { household_id: 'home', user_id: OWNER },
      { household_id: 'home', user_id: PEER },
    ]
    settings = [
      account(OWNER, [browser('joe')], { last_due_check: '2026-09-23T15:00:00.000Z' }),
      account(PEER, [browser('maria')], { last_due_check: '2026-09-23T15:00:00.000Z' }),
    ]
    rows = [
      task(OWNER, 'Fix the fence', '2026-09-23T15:05:00.000Z', { assigneeId: PEER }),
      task(OWNER, 'Clear the gutter', '2026-09-23T15:10:00.000Z'),
      task(PEER, 'Paint the shed', '2026-09-23T15:15:00.000Z'),
      task(PEER, 'Mow the lawn', '2026-09-23T15:20:00.000Z', { assigneeId: OWNER }),
    ]
    await runAt('2026-09-23T15:30:00.000Z')
    const to = (who: string) => nudges().filter(p => p.to.includes(`https://push.example.test/${who}`)).map(p => p.title.slice('Due now: '.length))
    expect(to('joe')).toEqual(['Clear the gutter', 'Mow the lawn'])
    expect(to('maria')).toEqual(['Fix the fence', 'Paint the shed'])
  })
})

describe('the watermark never passes a nudge that was not sent', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 23, 15, minute)).toISOString()

  it('five a run at most, and the rest the next hour, each once', async () => {
    settings = [account(OWNER, [browser('joe')], { last_due_check: at(0) })]
    rows = Array.from({ length: 8 }, (_, i) => task(OWNER, `Task ${i + 1}`, at(i + 1)))
    await runAt(at(30))
    expect(titles()).toEqual(['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5'])
    // it stops at the last one sent, not at now: six, seven and eight are still to come
    expect(watermark(OWNER)).toBe(at(5))

    pushes.length = 0
    await runAt(new Date(Date.UTC(2026, 8, 23, 16, 30)).toISOString())
    expect(titles()).toEqual(['Task 6', 'Task 7', 'Task 8'])
    expect(watermark(OWNER)).toBe('2026-09-23T16:30:00.000Z')
  })

  it('sends the tasks due at one instant together, as a watermark between them could not tell them apart', async () => {
    settings = [account(OWNER, [browser('joe')], { last_due_check: at(0) })]
    rows = [
      ...Array.from({ length: 4 }, (_, i) => task(OWNER, `Task ${i + 1}`, at(i + 1))),
      ...['A', 'B', 'C'].map(x => task(OWNER, `At five past ${x}`, at(5))),
      task(OWNER, 'At six past', at(6)),
    ]
    await runAt(at(30))
    expect(titles()).toEqual(['Task 1', 'Task 2', 'Task 3', 'Task 4', 'At five past A', 'At five past B', 'At five past C'])
    expect(watermark(OWNER)).toBe(at(5))

    pushes.length = 0
    await runAt(new Date(Date.UTC(2026, 8, 23, 16, 30)).toISOString())
    expect(titles()).toEqual(['At six past'])
  })
})

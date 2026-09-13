import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { firstSentence, previousWeekIn, sundayDraftDue, sundayLine } from '../../netlify/functions/lib/reviewweek.mjs'
import { buildReview } from '../review'
import type { Person, Task } from '../types'

// Sunday's review draft used to run only inside the digest's loop over people
// with push or the email digest, so an account with neither — the site owner's
// — never got one. Now every account is drafted on its own Sunday, from its
// digest hour, once a week: the review is stamped before the model is asked.
// The model and push are stubbed at their modules; the database is a fake
// that keeps what the function writes, so one run sees the last one's draft.

const { pushes, ai } = vi.hoisted(() => ({
  pushes: [] as { title: string; body: string; url: string }[],
  ai: { provider: 'nvidia' as string | null, prompts: [] as string[], answer: {} as { text?: string; error?: string }, throws: false },
}))
vi.mock('../../netlify/functions/push.mjs', () => ({
  pushConfigured: () => true,
  sendToAll: async (_subs: unknown[], payload: { title: string; body: string; url: string }) => {
    pushes.push(payload)
    return { gone: [], failed: [], updated: [] }
  },
}))
vi.mock('../../netlify/functions/lib/ai.mjs', () => ({
  resolveProvider: () => ai.provider,
  complete: async ({ prompt }: { prompt: string }) => {
    ai.prompts.push(prompt)
    if (ai.throws) throw new Error('the function ran out of time')
    return ai.answer
  },
}))

// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import digestFunction, { upsertSundayReview } from '../../netlify/functions/digest.mjs'

const SUPABASE = 'https://db.example.test'
const REST = `${SUPABASE}/rest/v1/`
// ids unlike in their first eight characters, as real ones are: a draft's id carries them
const OWNER = 'a1b2c3d4-0000-4000-8000-0000000000aa'
const PEER = 'e5f6a7b8-0000-4000-8000-0000000000bb'
const STAMP = '2026-09-01T00:00:00.000Z'
const HOUR = 3_600_000
const DAY = 86_400_000
const SUMMARY = 'A steady week: the fence is fixed. Mum came round twice.\n\n- Next: book the dentist.'
const runDigest = digestFunction as () => Promise<Response>

type Row = { user_id: string | null; data: Record<string, any> }
let settings: Record<string, any>[]
let rows: Row[]
let households: { household_id: string; user_id: string }[]
let emails: { subject: string; text: string }[]
let syncDown: boolean

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('RESEND_API_KEY', 'resend-key')
  vi.stubEnv('URL', 'https://site.test')
  vi.useFakeTimers({ toFake: ['Date'] })
  pushes.length = 0
  ai.provider = 'nvidia'
  ai.prompts.length = 0
  ai.answer = { text: SUMMARY }
  ai.throws = false
  settings = []
  rows = []
  households = []
  emails = []
  syncDown = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (url === 'https://api.resend.com/emails') {
        emails.push(body)
        return Response.json({ id: 'email-1' })
      }
      if (url.startsWith(`${SUPABASE}/auth/v1/admin/users/`)) return Response.json({ email: 'me@example.test' })
      if (!url.startsWith(REST)) throw new Error(`unexpected fetch ${url}`)
      const path = url.slice(REST.length)
      if (path === 'user_settings?select=*') return Response.json(settings)
      if (path === 'rpc/owner_user_id') return Response.json(OWNER)
      if (path === 'rpc/sync_canary') return Response.json({ ok: true, checked: 15, failures: [] })
      if (path.startsWith('app_config?key=eq.sync_canary')) return Response.json([])
      if (path === 'app_config?on_conflict=key' && method === 'POST') return new Response(null, { status: 201 })
      if (path === 'posts?select=data,user_id&deleted=is.false') return Response.json(structuredClone(rows))
      if (path === 'household_members?select=household_id,user_id') return Response.json(households)
      if (path === 'rpc/sync_posts' && method === 'POST') {
        if (syncDown) return new Response('down', { status: 500 })
        // as the database does: a new row is the site owner's until it is handed over, and the newer write wins
        for (const item of body.incoming) {
          const row = rows.find(r => r.data.id === item.id)
          if (!row) rows.push({ user_id: OWNER, data: item })
          else if (item.updatedAt > row.data.updatedAt) row.data = item
        }
        return Response.json({ items: [], rejected: [] })
      }
      if (path.startsWith('posts?id=eq.') && method === 'PATCH') {
        const row = rows.find(r => r.data.id === decodeURIComponent(path.slice('posts?id=eq.'.length)))
        if (row) row.user_id = body.user_id
        return new Response(null, { status: 204 })
      }
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
/** Runs the digest every hour from `from` up to `to`; the instant of each draft the model was asked for. */
async function hourly(from: string, to: string): Promise<string[]> {
  const asked: string[] = []
  for (let t = Date.parse(from); t < Date.parse(to); t += HOUR) {
    const before = ai.prompts.length
    await runAt(new Date(t).toISOString())
    for (let i = before; i < ai.prompts.length; i++) asked.push(new Date(t).toISOString())
  }
  return asked
}
const row = (user_id: string | null, data: Record<string, unknown>): Row => ({ user_id, data: { createdAt: STAMP, updatedAt: STAMP, ...data } })
const taskRow = (user_id: string | null, id: string, title: string, over: Record<string, unknown> = {}) =>
  row(user_id, { kind: 'task', id, title, description: '', status: 'todo', priority: 'normal', tags: [], ...over })
const quiet = (user_id: string, over: Record<string, unknown> = {}) => ({ user_id, push_subscriptions: [], digest_email: false, nudged: {}, ...over })
const drafts = () => rows.filter(r => r.data.kind === 'review')

describe('Sunday’s draft runs for every account, push or not', () => {
  it('drafts an account with no push and no email on its own Sunday after its hour — once', async () => {
    settings = [quiet(OWNER, { digest_hour: 9, timezone: 'America/New_York' })]
    rows = [taskRow(OWNER, 'fence', 'Fixed the fence', { status: 'done', completedAt: '2026-09-10T16:00:00.000Z' })]
    // Saturday, all of Sunday and Monday in New York, hour by hour: 9am on
    // Sunday there is 13:00 UTC, the one run that asks the model
    expect(await hourly('2026-09-12T04:00:00Z', '2026-09-15T04:00:00Z')).toEqual(['2026-09-13T13:00:00.000Z'])
    expect(drafts()).toHaveLength(1)
    expect(drafts()[0].user_id).toBe(OWNER)
    expect(drafts()[0].data).toMatchObject({ kind: 'review', period: 'week', key: '2026-W36', summary: SUMMARY, draftedAt: '2026-09-13T13:00:00.000Z' })
    expect(ai.prompts[0]).toContain('Completed:\n- Fixed the fence')
    // nothing was sent, and the settings row was never written
    expect(pushes).toEqual([])
    expect(emails).toEqual([])
    expect(settings[0].last_digest_day).toBeUndefined()

    // once a week, not once ever: the next Sunday drafts the week after
    expect(await hourly('2026-09-20T12:00:00Z', '2026-09-20T15:00:00Z')).toEqual(['2026-09-20T13:00:00.000Z'])
    expect(drafts().map(r => r.data.key)).toEqual(['2026-W36', '2026-W37'])
  })

  it('reads 8am when no hour is set, and drafts an account with no settings row at all, legacy rows included', async () => {
    // the peer has a row but no hour; the site owner has no row, so UTC and 8am
    settings = [quiet(PEER, { digest_hour: null, timezone: 'Europe/London' })]
    rows = [
      taskRow(OWNER, 'fence', 'Fixed the fence', { status: 'done', completedAt: '2026-09-10T16:00:00.000Z' }),
      taskRow(null, 'shed', 'Painted the shed', { status: 'done', completedAt: '2026-09-11T16:00:00.000Z' }),
      taskRow(PEER, 'gutter', 'Cleared the gutter', { status: 'done', completedAt: '2026-09-09T16:00:00.000Z' }),
    ]
    // 8am in London (BST) is 07:00 UTC
    expect(await hourly('2026-09-12T00:00:00Z', '2026-09-13T08:00:00Z')).toEqual(['2026-09-13T07:00:00.000Z'])
    expect(await runAt('2026-09-13T08:00:00Z')).toBe('no subscribers; drafted 1; sync check ok')
    expect(await hourly('2026-09-13T09:00:00Z', '2026-09-14T09:00:00Z')).toEqual([])

    // each drafted from its own records only, and the draft is its own
    const [peers, owners] = ai.prompts
    expect(peers).toContain('Cleared the gutter')
    expect(peers).not.toContain('Fixed the fence')
    expect(owners).toContain('Fixed the fence')
    expect(owners).toContain('Painted the shed')
    expect(owners).not.toContain('Cleared the gutter')
    expect(drafts().map(r => r.user_id).sort()).toEqual([OWNER, PEER].sort())
  })

  it('never twice: a failed call is the week’s one try, hour after hour', async () => {
    settings = [quiet(OWNER, { timezone: 'UTC' })]
    ai.answer = { error: 'NVIDIA answered 502' }
    expect(await hourly('2026-09-13T00:00:00Z', '2026-09-14T00:00:00Z')).toEqual(['2026-09-13T08:00:00.000Z'])
    expect(drafts()).toHaveLength(1)
    expect(drafts()[0].data.draftedAt).toBe('2026-09-13T08:00:00.000Z')
    expect(drafts()[0].data.summary).toBeUndefined()
  })

  it('never twice: a call cut off mid-way is the week’s one try too', async () => {
    settings = [quiet(OWNER, { timezone: 'UTC' })]
    ai.throws = true
    expect(await hourly('2026-09-13T08:00:00Z', '2026-09-13T20:00:00Z')).toEqual(['2026-09-13T08:00:00.000Z'])
  })

  it('asks the model nothing while the stamp cannot be written, and tries again the next hour', async () => {
    settings = [quiet(OWNER, { timezone: 'UTC' })]
    syncDown = true
    await runAt('2026-09-13T08:00:00Z')
    expect(ai.prompts).toEqual([])
    syncDown = false
    expect(await hourly('2026-09-13T09:00:00Z', '2026-09-13T12:00:00Z')).toEqual(['2026-09-13T09:00:00.000Z'])
    expect(drafts()[0].data.summary).toBe(SUMMARY)
  })

  it('costs nothing, and writes nothing, where you wrote reflections or a summary of your own', async () => {
    settings = [quiet(OWNER, { timezone: 'UTC' }), quiet(PEER, { timezone: 'UTC' })]
    rows = [
      row(OWNER, { kind: 'review', id: 'mine', period: 'week', key: '2026-W36', top: [], reflections: 'A good week' }),
      row(PEER, { kind: 'review', id: 'theirs', period: 'week', key: '2026-W36', top: [], summary: 'Pressed for on Friday.' }),
    ]
    const before = structuredClone(rows)
    expect(await hourly('2026-09-13T00:00:00Z', '2026-09-14T00:00:00Z')).toEqual([])
    expect(rows).toEqual(before)
  })

  it('asks for nothing on a site with no AI provider', async () => {
    settings = [quiet(OWNER, { timezone: 'UTC' })]
    ai.provider = null
    expect(await runAt('2026-09-13T08:00:00Z')).toBe('no subscribers; sync check ok')
    expect(drafts()).toEqual([])
  })
})

describe('Sunday’s draft reads the journal only when the account allows it', () => {
  it('each account as it chose, and only its own entries, in a household that shares everything else', async () => {
    households = [OWNER, PEER].map(user_id => ({ household_id: 'home', user_id }))
    settings = [quiet(OWNER, { timezone: 'UTC', digest_journal: false }), quiet(PEER, { timezone: 'UTC', digest_journal: true })]
    rows = [
      taskRow(OWNER, 'fence', 'Fixed the fence', { status: 'done', completedAt: '2026-09-10T16:00:00.000Z' }),
      row(OWNER, { kind: 'journal', id: 'journal~2026-09-08~a', date: '2026-09-08', body: 'Owner wrote about the garden' }),
      row(PEER, { kind: 'journal', id: 'journal~2026-09-09~b', date: '2026-09-09', body: 'Peer wrote about the move' }),
    ]
    await runAt('2026-09-13T08:00:00Z')
    expect(ai.prompts).toHaveLength(2)
    const opted = ai.prompts.filter(p => p.includes('My journal this week:'))
    const notOpted = ai.prompts.filter(p => !p.includes('My journal this week:'))
    expect(opted).toHaveLength(1)
    expect(opted[0]).toContain('Peer wrote about the move')
    expect(opted[0]).not.toContain('Owner wrote about the garden')
    expect(notOpted[0]).not.toContain('wrote about')
    // the household's shared task reaches both, as it does in the digest
    for (const p of ai.prompts) expect(p).toContain('Fixed the fence')
  })
})

describe('Sunday’s digest line carries the review', () => {
  const subscribed = () => [
    { user_id: OWNER, digest_email: true, push_subscriptions: [{ endpoint: 'https://push.example/1', keys: { p256dh: 'x', auth: 'y' } }], digest_hour: 8, timezone: 'UTC', nudged: {} },
  ]
  const lastLine = () => pushes[0].body.split('\n').slice(-1)[0]

  it('its first sentence, drafted in the same run, in the push and the email alike — once', async () => {
    settings = subscribed()
    await runAt('2026-09-13T08:00:00Z')
    expect(pushes).toHaveLength(1)
    expect(lastLine()).toBe('Last week: A steady week: the fence is fixed.')
    expect(emails[0].text).toContain('Last week: A steady week: the fence is fixed.')
    await runAt('2026-09-13T09:00:00Z')
    expect(ai.prompts).toHaveLength(1)
    expect(pushes).toHaveLength(1)
  })

  it('the fixed line while there is no summary', async () => {
    settings = subscribed()
    ai.answer = { error: 'NVIDIA answered 502' }
    await runAt('2026-09-13T08:00:00Z')
    expect(lastLine()).toBe('Sunday: your weekly review is ready.')
  })

  it('a summary you already pressed for, at no cost', async () => {
    settings = subscribed()
    rows = [row(OWNER, { kind: 'review', id: 'mine', period: 'week', key: '2026-W36', top: [], summary: 'You kept all three. The boiler is serviced.' })]
    await runAt('2026-09-13T08:00:00Z')
    expect(ai.prompts).toEqual([])
    expect(lastLine()).toBe('Last week: You kept all three.')
  })
})

describe('sundayDraftDue: the account’s own Sunday, from its hour', () => {
  const at = (iso: string) => new Date(iso)
  it('from 8am when there is no hour or no row, in UTC', () => {
    expect(sundayDraftDue({}, at('2026-09-13T07:59:00Z'))).toBe(false)
    expect(sundayDraftDue({}, at('2026-09-13T08:00:00Z'))).toBe(true)
    expect(sundayDraftDue({ digest_hour: null }, at('2026-09-13T23:59:00Z'))).toBe(true)
    expect(sundayDraftDue(null, at('2026-09-13T09:00:00Z'))).toBe(true)
  })

  it('never on another day', () => {
    expect(sundayDraftDue({}, at('2026-09-12T12:00:00Z'))).toBe(false)
    expect(sundayDraftDue({}, at('2026-09-14T09:00:00Z'))).toBe(false)
  })

  it('at the hour chosen, in the zone saved', () => {
    expect(sundayDraftDue({ digest_hour: 20 }, at('2026-09-13T19:00:00Z'))).toBe(false)
    expect(sundayDraftDue({ digest_hour: 20 }, at('2026-09-13T20:00:00Z'))).toBe(true)
    expect(sundayDraftDue({ digest_hour: 0 }, at('2026-09-13T00:00:00Z'))).toBe(true)
    // 8am on Sunday in Tokyo is still Saturday in UTC, and Sunday afternoon in UTC is Monday there
    expect(sundayDraftDue({ timezone: 'Asia/Tokyo' }, at('2026-09-12T23:00:00Z'))).toBe(true)
    expect(sundayDraftDue({ timezone: 'Asia/Tokyo' }, at('2026-09-13T15:00:00Z'))).toBe(false)
    // a zone nobody knows reads as UTC rather than never
    expect(sundayDraftDue({ timezone: 'Mars/Olympus_Mons' }, at('2026-09-13T08:00:00Z'))).toBe(true)
  })
})

describe('sundayLine: the review’s first sentence', () => {
  it('up to the first full stop that ends a word, bullet dropped', () => {
    expect(sundayLine(SUMMARY)).toBe('Last week: A steady week: the fence is fixed.')
    expect(sundayLine('\n- You spent £12.50 on paint. Then more.')).toBe('Last week: You spent £12.50 on paint.')
    expect(firstSentence('Saw Mr. Smith and the fence is done! Next up.')).toBe('Saw Mr. Smith and the fence is done!')
    expect(firstSentence('No full stop at all')).toBe('No full stop at all')
  })

  it('cut at a word when it runs long', () => {
    const long = firstSentence(`${'word '.repeat(80)}end.`)
    expect(long.length).toBeLessThanOrEqual(200)
    expect(long).toMatch(/word…$/)
  })

  it('the fixed line without a summary', () => {
    for (const none of [undefined, null, '', '  \n ']) expect(sundayLine(none)).toBe('Sunday: your weekly review is ready.')
  })
})

describe('Sunday’s draft and Home → Week read one set of lists (shared/review.mjs)', () => {
  const task = (id: string, title: string, over: Partial<Task> = {}): Task => ({
    kind: 'task',
    id,
    title,
    description: '',
    status: 'todo',
    priority: 'normal',
    tags: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  })

  it('for one week in London, across both its edges', async () => {
    const now = new Date('2026-09-13T08:00:00.000Z')
    const week = previousWeekIn(now, 'Europe/London')
    const s = week.start.getTime()
    const e = week.end.getTime()
    const iso = (ms: number) => new Date(ms).toISOString()
    const mum = { kind: 'person', id: 'mum', name: 'Mum' } as Person
    const tasks = [
      task('fence', 'Fixed the fence', { status: 'done', completedAt: iso(s) }), // the week's first instant: in
      task('gutter', 'Cleared the gutter', { status: 'done', completedAt: iso(e) }), // the next week's first: out
      task('shed', 'Painted the shed', { status: 'done', completedAt: iso(s - 1) }), // the week before's last: out
      task('lunch', 'Lunch with Mum', { status: 'done', completedAt: iso(s + 2 * DAY), tags: ['visit'], peopleIds: ['mum'] }), // a visit: seen, not done
      task('dentist', 'Book the dentist', { dueAt: iso(e - 1) }), // due in the week's last instant, still open: slipped
      task('tyres', 'Check the tyres', { dueAt: iso(e) }), // due as the next week begins: not yet
      task('water', 'Water bill', { dueAt: iso(s + DAY), bill: { kind: 'bill', payee: 'Thames Water' }, estimateCost: 40 }), // a bill is a task: slipped
      task('tax', 'Council tax', { status: 'done', completedAt: iso(s + 3 * DAY), bill: { kind: 'bill' } }), // a paid bill: done
      task('kayak', 'Buy a kayak', { status: 'wishlist', dueAt: iso(s + DAY) }), // a wishlist item is not open: never slipped
    ]

    const app = buildReview({ period: 'week', key: week.key!, start: week.start, end: week.end, label: week.label }, tasks, [], [mum], now)
    await upsertSundayReview(OWNER, [...tasks, mum], now, { timezone: 'Europe/London' })
    const section = (name: string) =>
      ai.prompts[0].split(`${name}:\n`)[1].split('\n\n')[0].split('\n').map(l => l.replace(/^- /, '')).filter(l => l !== 'none')

    expect(section('Completed')).toEqual(app.done.map(t => t.title))
    expect(section('Slipped (due but not done)')).toEqual(app.slipped.map(t => t.title))
    expect(section('People seen')).toEqual(app.people.map(p => p.person.name))
    // …and they are the right lists
    expect(app.done.map(t => t.title)).toEqual(['Council tax', 'Fixed the fence'])
    expect(app.slipped.map(t => t.title)).toEqual(['Book the dentist', 'Water bill'])
    expect(app.visitsDone.map(t => t.title)).toEqual(['Lunch with Mum'])
    expect(app.people.map(p => p.person.name)).toEqual(['Mum'])
  })
})

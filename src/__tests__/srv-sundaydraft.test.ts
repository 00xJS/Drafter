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
  ai: {
    provider: 'nvidia' as string | null,
    prompts: [] as string[],
    answer: {} as { text?: string; error?: string },
    throws: false,
    // never answers
    hangs: false,
    // what happens elsewhere while the model is asked: the clock moving on, a phone's save
    during: null as null | ((prompt: string) => void),
  },
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
    ai.during?.(prompt)
    if (ai.hangs) return new Promise(() => {})
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
/** Rows the run's read of every record misses, as a read cut short at max_rows can. */
let bulkMisses: Set<string>
/** Accounts a row cannot be handed over to: the PATCH fails. */
let handOverFails: Set<string>
/** Every account as Supabase Auth lists them; Admin's Disable sets banned_until. */
let authUsers: { id: string; email: string; banned_until: string | null }[]
/** The first page of that list that fails to answer; Infinity when none does. */
let authFailsFrom: number
/** Each page of that list a run asked for. */
let authPages: string[]
/** PostgREST's max_rows (supabase/config.toml): no request answers more. */
const MAX_ROWS = 1000
const ALL_LIVE = 'posts?select=data,user_id&deleted=is.false&order=id.asc'
const WEEK_REVIEWS = 'posts?select=data,user_id&kind=eq.review&data->>key=eq.'

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
  ai.hangs = false
  ai.during = null
  settings = []
  rows = []
  households = []
  emails = []
  syncDown = false
  bulkMisses = new Set()
  handOverFails = new Set()
  authUsers = []
  authFailsFrom = Infinity
  authPages = []
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
      if (url.startsWith(`${SUPABASE}/auth/v1/admin/users?`)) {
        // Admin's list of every account, a page at a time, as GoTrue answers it
        const q = new URL(url).searchParams
        const page = Number(q.get('page'))
        const perPage = Number(q.get('per_page'))
        authPages.push(`page=${page}&per_page=${perPage}`)
        if (page >= authFailsFrom) return new Response('unavailable', { status: 503 })
        return Response.json({ users: structuredClone(authUsers.slice((page - 1) * perPage, page * perPage)), aud: 'authenticated' })
      }
      if (url.startsWith(`${SUPABASE}/auth/v1/admin/users/`)) return Response.json({ email: 'me@example.test' })
      if (!url.startsWith(REST)) throw new Error(`unexpected fetch ${url}`)
      const path = url.slice(REST.length)
      if (path === 'user_settings?select=*') return Response.json(settings)
      if (path === 'rpc/owner_user_id') return Response.json(OWNER)
      if (path === 'rpc/sync_canary') return Response.json({ ok: true, checked: 15, failures: [] })
      if (path.startsWith('app_config?key=eq.sync_canary')) return Response.json([])
      if (path === 'app_config?on_conflict=key' && method === 'POST') return new Response(null, { status: 201 })
      if (path === ALL_LIVE && method === 'GET') {
        // as PostgREST does: in id order when asked, one Range at a time, never more than max_rows
        const live = rows.filter(r => !r.data.deletedAt && !bulkMisses.has(r.data.id)).sort((a, b) => (a.data.id < b.data.id ? -1 : 1))
        const range = /^(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')
        const from = range ? Number(range[1]) : 0
        const to = Math.min(range ? Number(range[2]) : Infinity, from + MAX_ROWS - 1)
        if (from > 0 && from >= live.length) return new Response('range not satisfiable', { status: 416 })
        return Response.json(structuredClone(live.slice(from, to + 1)))
      }
      if (path.startsWith(WEEK_REVIEWS) && method === 'GET') {
        const key = decodeURIComponent(path.slice(WEEK_REVIEWS.length))
        return Response.json(structuredClone(rows.filter(r => r.data.kind === 'review' && r.data.key === key)))
      }
      if (path === 'household_members?select=household_id,user_id') return Response.json(households)
      if (path === 'rpc/sync_posts' && method === 'POST') {
        if (syncDown) return new Response('down', { status: 500 })
        // as the database does: a new row is the site owner's until it is handed over,
        // the strictly newer write wins, and a different one that loses is answered stale
        const stale: string[] = []
        for (const item of body.incoming) {
          const row = rows.find(r => r.data.id === item.id)
          if (!row) rows.push({ user_id: OWNER, data: item })
          else if (item.updatedAt > row.data.updatedAt) row.data = item
          else if (JSON.stringify(item) !== JSON.stringify(row.data)) stale.push(item.id)
        }
        return Response.json({ items: [], rejected: [], stale, gone: [] })
      }
      if (path.startsWith('posts?id=eq.') && method === 'PATCH') {
        if (handOverFails.has(body.user_id)) return new Response('unavailable', { status: 503 })
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

const doneLastWeek = (user_id: string | null, id: string, title: string) => taskRow(user_id, id, title, { status: 'done', completedAt: '2026-09-10T16:00:00.000Z' })
const withPush = (user_id: string, over: Record<string, unknown> = {}) =>
  quiet(user_id, { timezone: 'UTC', digest_hour: 8, push_subscriptions: [{ endpoint: `https://push.example/${user_id}`, keys: { p256dh: 'x', auth: 'y' } }], ...over })
const lastLines = () => pushes.map(p => p.body.split('\n').slice(-1)[0])
const OWNER_DRAFT = 'review-2026-W36-a1b2c3d4'
const PEER_DRAFT = 'review-2026-W36-e5f6a7b8'

describe('Sunday’s draft, however the run’s read of every record was cut', () => {
  it('reads every record a page at a time: a table past PostgREST’s 1000 rows is read whole', async () => {
    settings = [quiet(OWNER, { timezone: 'UTC' })]
    // 1,100 open tasks sort ahead of the one done last week, which lands on the second page
    rows = [...Array.from({ length: 1100 }, (_, i) => taskRow(OWNER, `t${String(i).padStart(4, '0')}`, `Task ${i}`)), doneLastWeek(OWNER, 'zz-fence', 'Fixed the fence')]
    await runAt('2026-09-13T08:00:00Z')
    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]).toContain('Completed:\n- Fixed the fence')
  })

  it('never twice when that read misses the week’s review: its rows, read again from the table, stop it', async () => {
    settings = [quiet(OWNER, { timezone: 'UTC' })]
    const shapes = [
      // drafted at 8 and the call failed: the stamp alone
      { id: OWNER_DRAFT, draftedAt: '2026-09-13T08:00:00.000Z' },
      // drafted, and written in since
      { id: OWNER_DRAFT, draftedAt: '2026-09-13T08:00:00.000Z', summary: SUMMARY, reflections: 'Tired, but the fence is done.' },
      // one your phone made under an id of its own, never drafted
      { id: '0b6c1f9e-7d1a-4c55-9a51-3f0e6f1d2c11', reflections: 'A good week' },
    ]
    for (const shape of shapes) {
      ai.prompts.length = 0
      rows = [row(OWNER, { kind: 'review', period: 'week', key: '2026-W36', top: ['Book the dentist'], ...shape })]
      bulkMisses = new Set([shape.id])
      const before = structuredClone(rows)
      expect(await hourly('2026-09-13T09:00:00Z', '2026-09-14T00:00:00Z')).toEqual([])
      expect(rows).toEqual(before)
    }
  })
})

describe('Sunday’s draft asks only once the review is its reader’s own', () => {
  it('asks nothing while the hand-over fails, tries again the next hour, and the site owner never takes a peer’s week for theirs', async () => {
    // the peer first, so the owner's draft comes after the peer's claim is left with the site owner
    settings = [quiet(PEER, { timezone: 'UTC' }), quiet(OWNER, { timezone: 'UTC' })]
    rows = [doneLastWeek(PEER, 'gutter', 'Cleared the gutter'), doneLastWeek(OWNER, 'fence', 'Fixed the fence')]
    handOverFails = new Set([PEER])
    const draft = (id: string) => rows.find(r => r.data.id === id)

    await runAt('2026-09-13T08:00:00Z')
    // the peer's claim is written, but it is still the site owner's row: nothing is asked for it
    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]).toContain('Fixed the fence')
    expect(draft(PEER_DRAFT)).toMatchObject({ user_id: OWNER, data: { draftedAt: '2026-09-13T08:00:00.000Z' } })
    expect(draft(PEER_DRAFT)?.data.summary).toBeUndefined()
    // …and the owner's own week is drafted all the same, not skipped for the peer's stamp
    expect(draft(OWNER_DRAFT)).toMatchObject({ user_id: OWNER, data: { summary: SUMMARY } })

    handOverFails.clear()
    expect(await hourly('2026-09-13T09:00:00Z', '2026-09-14T00:00:00Z')).toEqual(['2026-09-13T09:00:00.000Z'])
    expect(ai.prompts[1]).toContain('Cleared the gutter')
    expect(draft(PEER_DRAFT)).toMatchObject({ user_id: PEER, data: { draftedAt: '2026-09-13T09:00:00.000Z', summary: SUMMARY } })
    expect(drafts()).toHaveLength(2)
  })
})

describe('Sunday’s draft never writes over a save made while it runs', () => {
  it('reflections saved while the model is asked stand, and the draft steps aside', async () => {
    settings = [quiet(OWNER, { timezone: 'UTC' })]
    rows = [row(OWNER, { kind: 'review', id: 'mine', period: 'week', key: '2026-W36', top: ['Fix the fence'] })]
    ai.during = () => {
      // the call takes ten seconds; five seconds in, the phone saves reflections onto the claim it pulled
      vi.setSystemTime(Date.now() + 10_000)
      const mine = rows.find(r => r.data.id === 'mine')!
      mine.data = { ...mine.data, reflections: 'Tired, but the fence is done.', updatedAt: '2026-09-13T08:00:05.000Z' }
    }
    expect(await runAt('2026-09-13T08:00:00Z')).toBe('no subscribers; sync check ok')
    expect(ai.prompts).toHaveLength(1)
    const mine = rows.find(r => r.data.id === 'mine')!.data
    expect(mine).toMatchObject({ top: ['Fix the fence'], reflections: 'Tired, but the fence is done.', draftedAt: '2026-09-13T08:00:00.000Z' })
    expect(mine.summary).toBeUndefined()
    // with reflections of your own, it is not asked again
    ai.during = null
    expect(await hourly('2026-09-13T09:00:00Z', '2026-09-14T00:00:00Z')).toEqual([])
  })

  it('nor one saved during an earlier account’s draft in the same run', async () => {
    settings = [quiet(OWNER, { timezone: 'UTC' }), quiet(PEER, { timezone: 'UTC' })]
    rows = [row(PEER, { kind: 'review', id: 'theirs', period: 'week', key: '2026-W36', top: ['Call the plumber'] })]
    ai.during = () => {
      if (ai.prompts.length > 1) return
      // the owner's call takes five seconds; three seconds in, the peer's phone saves reflections
      vi.setSystemTime(Date.now() + 5_000)
      const theirs = rows.find(r => r.data.id === 'theirs')!
      theirs.data = { ...theirs.data, reflections: 'A slow week.', updatedAt: '2026-09-13T08:00:03.000Z' }
    }
    await runAt('2026-09-13T08:00:00Z')
    // the owner's draft only: read again before the stamp, the peer's reflections stop theirs
    expect(ai.prompts).toHaveLength(1)
    const theirs = rows.find(r => r.data.id === 'theirs')!.data
    expect(theirs).toMatchObject({ top: ['Call the plumber'], reflections: 'A slow week.' })
    expect(theirs.draftedAt).toBeUndefined()
    expect(theirs.summary).toBeUndefined()
  })
})

describe('Sunday’s drafts fit the run: Netlify stops the function at 30 seconds', () => {
  it('a digest due goes first, and a draft with no time to finish waits, unstamped, for the next hour', async () => {
    // listed first, the account with neither push nor email is drafted after the one with push
    settings = [quiet(OWNER, { timezone: 'UTC' }), withPush(PEER)]
    rows = [doneLastWeek(OWNER, 'fence', 'Fixed the fence'), doneLastWeek(PEER, 'gutter', 'Cleared the gutter')]
    // every call takes 15 of the run's 22 seconds
    ai.during = () => vi.setSystemTime(Date.now() + 15_000)
    expect(await runAt('2026-09-13T08:00:00Z')).toBe('sent 1; drafted 1; sync check ok')
    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]).toContain('Cleared the gutter')
    expect(lastLines()).toEqual(['Last week: A steady week: the fence is fixed.'])
    // nothing was tried for the owner, so nothing is stamped…
    expect(drafts().map(r => r.user_id)).toEqual([PEER])
    // …and it is drafted the next hour
    expect(await hourly('2026-09-13T09:00:00Z', '2026-09-14T00:00:00Z')).toEqual(['2026-09-13T09:00:00.000Z'])
    expect(ai.prompts[1]).toContain('Fixed the fence')
    expect(drafts().map(r => r.user_id).sort()).toEqual([OWNER, PEER].sort())
    expect(pushes).toHaveLength(1)
  })

  it('an account whose own draft has to wait still gets its digest, with the fixed line', async () => {
    settings = [withPush(OWNER), withPush(PEER)]
    rows = [doneLastWeek(OWNER, 'fence', 'Fixed the fence'), doneLastWeek(PEER, 'gutter', 'Cleared the gutter')]
    ai.during = () => vi.setSystemTime(Date.now() + 15_000)
    expect(await runAt('2026-09-13T08:00:00Z')).toBe('sent 2; drafted 1; sync check ok')
    expect(lastLines()).toEqual(['Last week: A steady week: the fence is fixed.', 'Sunday: your weekly review is ready.'])
    expect(drafts().map(r => r.user_id)).toEqual([OWNER])
    expect(await hourly('2026-09-13T09:00:00Z', '2026-09-13T12:00:00Z')).toEqual(['2026-09-13T09:00:00.000Z'])
    expect(drafts().map(r => r.user_id).sort()).toEqual([OWNER, PEER].sort())
    expect(pushes).toHaveLength(2)
  })

  it('a call that outlasts the run is let go at its deadline: the digest goes, and the week’s try is spent', async () => {
    // the run's own timer is faked too, so the deadline comes without waiting for it
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-09-13T08:00:00Z'))
    settings = [withPush(OWNER), quiet(PEER, { timezone: 'UTC' })]
    rows = [doneLastWeek(OWNER, 'fence', 'Fixed the fence'), doneLastWeek(PEER, 'gutter', 'Cleared the gutter')]
    ai.hangs = true
    let report: string | null = null
    const run = runDigest()
      .then(r => r.text())
      .then(text => (report = text))
    // a quarter of a second at a time, for up to the 30 Netlify allows
    for (let waited = 0; waited < 30_000 && report === null; waited += 250) await vi.advanceTimersByTimeAsync(250)
    await run
    expect(report).toBe('sent 1; sync check ok')
    expect(Date.now() - Date.parse('2026-09-13T08:00:00Z')).toBeLessThanOrEqual(23_000)
    expect(ai.prompts).toHaveLength(1)
    expect(lastLines()).toEqual(['Sunday: your weekly review is ready.'])
    // the owner's try is spent; with no time left, the peer's week was not stamped
    expect(drafts().map(r => [r.user_id, r.data.draftedAt, r.data.summary])).toEqual([[OWNER, '2026-09-13T08:00:00.000Z', undefined]])
    ai.hangs = false
    expect(await hourly('2026-09-13T09:00:00Z', '2026-09-13T12:00:00Z')).toEqual(['2026-09-13T09:00:00.000Z'])
    expect(ai.prompts[1]).toContain('Cleared the gutter')
    expect(drafts().map(r => r.user_id).sort()).toEqual([OWNER, PEER].sort())
  })
})

describe('Sunday’s draft leaves an account disabled in Admin alone', () => {
  // Admin's Disable is a ban of 876,000 hours (admin.mjs); Enable clears it
  const DISABLED = '2126-08-20T08:00:00.000Z'
  const account = (id: string, banned_until: string | null = null) => ({ id, email: `${id.slice(0, 8)}@example.test`, banned_until })
  /** Accounts that fill Admin's list, none of them with records or settings. */
  const others = (n: number) => Array.from({ length: n }, (_, i) => account(`${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`))
  const bothDue = () => {
    settings = [quiet(OWNER, { timezone: 'UTC' }), quiet(PEER, { timezone: 'UTC' })]
    rows = [doneLastWeek(OWNER, 'fence', 'Fixed the fence'), doneLastWeek(PEER, 'gutter', 'Cleared the gutter')]
  }

  it('skips a disabled account and drafts an enabled one, reading the accounts once a run', async () => {
    bothDue()
    authUsers = [account(OWNER), account(PEER, DISABLED)]
    expect(await runAt('2026-09-13T08:00:00Z')).toBe('no subscribers; drafted 1; sync check ok')
    expect(authPages).toEqual(['page=1&per_page=200'])
    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]).toContain('Fixed the fence')
    expect(ai.prompts[0]).not.toContain('Cleared the gutter')
    // nothing is claimed for the disabled account, all Sunday
    expect(drafts().map(r => r.user_id)).toEqual([OWNER])
    expect(await hourly('2026-09-13T09:00:00Z', '2026-09-14T00:00:00Z')).toEqual([])
    expect(drafts().map(r => r.user_id)).toEqual([OWNER])
    // one read in each of the 16 runs from 8am to 11pm
    expect(authPages).toHaveLength(16)
  })

  it('drafts an account whose ban has run out', async () => {
    bothDue()
    authUsers = [account(OWNER), account(PEER, '2026-09-13T07:59:59.000Z')]
    expect(await runAt('2026-09-13T08:00:00Z')).toBe('no subscribers; drafted 2; sync check ok')
    expect(drafts().map(r => r.user_id).sort()).toEqual([OWNER, PEER].sort())
  })

  it('finds a disabled account on a later page of the list', async () => {
    bothDue()
    // the owner and 199 others fill the first page; the disabled account is on the second
    authUsers = [account(OWNER), ...others(199), account(PEER, DISABLED)]
    expect(await runAt('2026-09-13T08:00:00Z')).toBe('no subscribers; drafted 1; sync check ok')
    expect(authPages).toEqual(['page=1&per_page=200', 'page=2&per_page=200'])
    expect(drafts().map(r => r.user_id)).toEqual([OWNER])
  })

  it('drafts as before when the accounts cannot be read, and says so in the log', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      bothDue()
      authUsers = [account(OWNER), account(PEER, DISABLED)]
      authFailsFrom = 1
      expect(await runAt('2026-09-13T08:00:00Z')).toBe('no subscribers; drafted 2; sync check ok')
      expect(drafts().map(r => r.user_id).sort()).toEqual([OWNER, PEER].sort())
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/could not read which accounts are disabled.*503/))
    } finally {
      logged.mockRestore()
    }
  })

  it('drafts as before when a later page cannot be read: a list cut short cannot say who is disabled', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      bothDue()
      // the disabled account is on the first page, which answers; the second does not
      authUsers = [account(PEER, DISABLED), account(OWNER), ...others(203)]
      authFailsFrom = 2
      expect(await runAt('2026-09-13T08:00:00Z')).toBe('no subscribers; drafted 2; sync check ok')
      expect(authPages).toEqual(['page=1&per_page=200', 'page=2&per_page=200'])
      expect(drafts().map(r => r.user_id).sort()).toEqual([OWNER, PEER].sort())
      expect(logged).toHaveBeenCalledOnce()
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/could not read which accounts are disabled.*503/))
    } finally {
      logged.mockRestore()
    }
  })

  it('reads nothing in a run with no draft due', async () => {
    settings = [withPush(OWNER), quiet(PEER, { timezone: 'UTC' })]
    rows = [doneLastWeek(OWNER, 'fence', 'Fixed the fence'), doneLastWeek(PEER, 'gutter', 'Cleared the gutter')]
    authUsers = [account(OWNER), account(PEER, DISABLED)]
    // Saturday's digest, a Sunday before anyone's hour, and a Sunday on a site with no AI provider
    await runAt('2026-09-12T08:00:00Z')
    await runAt('2026-09-13T07:00:00Z')
    ai.provider = null
    await runAt('2026-09-13T09:00:00Z')
    expect(authPages).toEqual([])
    expect(ai.prompts).toEqual([])
    // those runs went through the accounts all the same: the digest went on both days
    expect(settings[0].last_digest_day).toBe('2026-09-13')
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

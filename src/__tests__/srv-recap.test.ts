import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRecap, recapDue, recapNoticeId } from '../../netlify/functions/lib/recap.mjs'
import { forgetNoticesStored } from '../../netlify/functions/lib/notices.mjs'
import { insightFigures, periodSpan, pickHighlights, recapLines } from '../../shared/insights.mts'
import { dayKeysIn } from '../../shared/people.mts'
import { inAppLink, parseLink, paramsOf } from '../links'

// The monthly recap, on the server: on the 1st, from the member's digest hour
// in their own zone, last month's highlights — a push and a notice in the hub,
// once — counted from the member's OWN log, by shared/insights.mts, the module
// the app's Highlights are drawn with.
//
// Push is stubbed at its module, and the database is answered here, as the
// digest's own tests answer it.

const { log, order } = vi.hoisted(() => ({ log: [] as { title: string; body?: string; tag?: string; url?: string; to: string[] }[], order: [] as string[] }))
vi.mock('../../netlify/functions/push.mjs', () => ({
  pushConfigured: () => true,
  sendToAll: async (subs: { endpoint: string }[], payload: { title: string; body?: string; tag?: string; url?: string }) => {
    log.push({ ...payload, to: subs.map(s => s.endpoint) })
    order.push(`push ${payload.tag}`)
    return { gone: [], failed: [], updated: [] }
  },
}))
vi.mock('../../netlify/functions/lib/ai.mjs', () => ({ resolveProvider: () => null, complete: async () => ({ error: 'no model here' }) }))

// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import digestFunction from '../../netlify/functions/digest.mjs'

const SUPABASE = 'https://db.example.test'
const REST = `${SUPABASE}/rest/v1/`
const JOE = 'a1b2c3d4-0000-4000-8000-0000000000aa'
const MARIA = 'e5f6a7b8-0000-4000-8000-0000000000bb'
const STAMP = '2026-08-01T00:00:00.000Z'
const runDigest = digestFunction as () => Promise<Response>

type Row = { user_id: string | null; data: Record<string, unknown> }
let settings: Record<string, any>[]
let rows: Row[]
/** Notices written into posts, by id. */
let kept: Map<string, { user_id: string; data: Record<string, any> }>
/** What the one read of written recaps is answered with; by default, what is kept. */
let listWritten: (() => string[]) | null
let reads: string[]

const browser = (who: string) => ({ endpoint: `https://push.example.test/${who}`, keys: { p256dh: 'p', auth: 'a' } })
/** An account in Phoenix (UTC-7, no daylight saving) with its digest at 8am: 15:00 UTC. */
const account = (user_id: string, over: Record<string, unknown> = {}) => ({
  user_id,
  push_subscriptions: [browser(user_id.slice(0, 4))],
  digest_email: false,
  digest_hour: 8,
  timezone: 'America/Phoenix',
  nudged: {},
  last_digest_day: '2026-09-30',
  ...over,
})
const record = (user_id: string | null, data: Record<string, unknown>): Row => ({ user_id, data: { createdAt: STAMP, updatedAt: STAMP, ...data } })
const done = (user_id: string, id: string, day: string, over: Record<string, unknown> = {}) =>
  record(user_id, { kind: 'task', id, title: id, description: '', status: 'done', priority: 'normal', tags: [], completedAt: `${day}T19:00:00.000Z`, ...over })
const entry = (user_id: string, day: string) => record(user_id, { kind: 'journal', id: `journal~${day}~${user_id.slice(0, 4)}`, date: day, body: 'words' })
const person = (id: string, name: string) => record(JOE, { kind: 'person', id, name, color: '#f472b6', group: 'friends' })

/** Joe's September, and Maria's beside it in the household. */
function september(): Row[] {
  return [
    person('marco', 'Tio Marco'),
    person('ana', 'Ana'),
    person('rosa', 'Rosa'),
    // Joe's work: three Tuesdays and a Thursday
    done(JOE, 'j1', '2026-09-08'),
    done(JOE, 'j2', '2026-09-15'),
    done(JOE, 'j3', '2026-09-22'),
    done(JOE, 'j4', '2026-09-10'),
    // Joe saw Tio Marco
    done(JOE, 'jv', '2026-09-12', { tags: ['visit'], peopleIds: ['marco'] }),
    // Maria's own work, shared with the household: hers, not his
    done(MARIA, 'm1', '2026-09-09'),
    done(MARIA, 'm2', '2026-09-09'),
    // Maria's visit with Ana, shared: her log, not his
    done(MARIA, 'mv', '2026-09-14', { tags: ['visit'], peopleIds: ['ana'] }),
    // Maria's PRIVATE work handed to Joe, and a private visit with Rosa put on
    // him: under Mine each would be his (isMineTask, ownVisit) — if he could
    // read them. The database hides both from him, and so must the recap.
    done(MARIA, 'secret-task', '2026-09-20', { assigneeId: JOE, shared: false }),
    done(MARIA, 'secret-visit', '2026-09-21', { tags: ['visit'], peopleIds: ['rosa'], assigneeId: JOE, shared: false }),
    // Joe's journal, the last nine days of the month; Maria's, every day of it
    ...Array.from({ length: 9 }, (_, i) => entry(JOE, `2026-09-${22 + i}`)),
    ...Array.from({ length: 30 }, (_, i) => entry(MARIA, `2026-09-${String(i + 1).padStart(2, '0')}`)),
  ]
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('URL', 'https://site.test')
  vi.stubEnv('RESEND_API_KEY', '')
  vi.useFakeTimers({ toFake: ['Date'] })
  forgetNoticesStored()
  log.length = 0
  order.length = 0
  settings = []
  rows = []
  kept = new Map()
  listWritten = null
  reads = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (!url.startsWith(REST)) throw new Error(`unexpected fetch ${url}`)
      const path = url.slice(REST.length)
      if (path === 'user_settings?select=*') return Response.json(settings)
      if (path === 'rpc/owner_user_id') return Response.json(JOE)
      if (path === 'rpc/sync_canary') return Response.json({ ok: true, checked: 15, failures: [] })
      if (path.startsWith('app_config?key=eq.sync_canary')) return Response.json([])
      if (path === 'app_config?on_conflict=key' && method === 'POST') return new Response(null, { status: 201 })
      if (path.startsWith('job_runs?job=eq.')) return Response.json([])
      if (path === 'job_runs?on_conflict=job' && method === 'POST') return new Response(null, { status: 201 })
      if (path.startsWith('posts?select=id,data,user_id&deleted=is.false&')) {
        reads.push(decodeURIComponent(path))
        // every row, whatever the filter asks: the recap sorts out what is whose itself
        const page = rows.map(r => ({ id: r.data.id, ...structuredClone(r) }))
        return new Response(JSON.stringify(page), { headers: { 'content-range': page.length ? `0-${page.length - 1}/${page.length}` : '*/0' } })
      }
      if (path === 'household_members?select=household_id,user_id') {
        return Response.json([
          { household_id: 'h1', user_id: JOE },
          { household_id: 'h1', user_id: MARIA },
        ])
      }
      if (path.startsWith('user_settings?user_id=eq.') && method === 'PATCH') {
        const id = decodeURIComponent(path.slice('user_settings?user_id=eq.'.length))
        Object.assign(settings.find(s => s.user_id === id) ?? {}, body)
        return new Response(null, { status: 204 })
      }
      // the one read of the recaps already written this month
      if (path.startsWith('posts?select=id&id=in.(')) {
        const asked = decodeURIComponent(path.slice('posts?select=id&id=in.('.length, -1)).split(',')
        const there = listWritten ? listWritten() : [...kept.keys()]
        return Response.json(asked.filter(id => there.includes(id)).map(id => ({ id })))
      }
      // lib/notices.mjs: whether notices are stored, the row under an id, and a new one
      if (path.startsWith('rpc/record_kind_allowed')) return Response.json(true)
      if (path.startsWith('posts?id=eq.') && method === 'GET') {
        const id = decodeURIComponent(path.slice('posts?id=eq.'.length).split('&')[0])
        const row = kept.get(id)
        return Response.json(row ? [row] : [])
      }
      if (path === 'posts' && method === 'POST') {
        order.push(`notice ${body.id}`)
        kept.set(body.id, { user_id: body.user_id, data: body.data })
        return new Response(null, { status: 201 })
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
const recaps = () => log.filter(e => e.tag?.startsWith('recap-'))

describe('when the recap goes', () => {
  it('goes on the 1st, from the digest hour in the member’s own zone, and not before', () => {
    const joe = account(JOE)
    // 7am in Phoenix on the 1st: not yet
    expect(recapDue(joe, new Date('2026-10-01T14:00:00.000Z'))).toBeNull()
    // 8am: September's
    expect(recapDue(joe, new Date('2026-10-01T15:00:00.000Z'))).toBe('2026-09')
    // still the 1st later in the day, should a run have been missed
    expect(recapDue(joe, new Date('2026-10-02T06:00:00.000Z'))).toBe('2026-09')
    // the 2nd, and the 30th, never
    expect(recapDue(joe, new Date('2026-10-02T15:00:00.000Z'))).toBeNull()
    expect(recapDue(joe, new Date('2026-09-30T15:00:00.000Z'))).toBeNull()
    // Auckland's 1st is still the 30th in UTC: its 8am is 19:00 UTC the day before
    const kiwi = account(JOE, { timezone: 'Pacific/Auckland' })
    expect(recapDue(kiwi, new Date('2026-09-30T18:00:00.000Z'))).toBeNull()
    expect(recapDue(kiwi, new Date('2026-09-30T19:00:00.000Z'))).toBe('2026-09')
    // no hour chosen is 8; a zone that cannot be read is UTC's
    expect(recapDue({ timezone: 'Mars/Olympus' }, new Date('2026-10-01T08:00:00.000Z'))).toBe('2026-09')
    expect(recapDue({ timezone: 'Mars/Olympus' }, new Date('2026-10-01T07:59:00.000Z'))).toBeNull()
    // January's 1st is December's
    expect(recapDue(joe, new Date('2027-01-01T15:00:00.000Z'))).toBe('2026-12')
  })

  it('sends nothing, and reads nothing more, on any other hour', async () => {
    settings = [account(JOE)]
    rows = september()
    await runAt('2026-10-01T14:00:00.000Z')
    await runAt('2026-10-02T15:00:00.000Z')
    expect(recaps()).toEqual([])
    expect([...kept.keys()].filter(id => id.includes('~recap~'))).toEqual([])
    // only the digest's own read: no personal kinds were fetched for a recap not due
    expect(reads.every(r => r.includes('kind=in.(task,project,person,place,meal,recipe,event,review)'))).toBe(true)
  })
})

describe('what the recap says, and to whom', () => {
  it('sends last month’s highlights once, as a push and a notice, opening Insights on that month', async () => {
    settings = [account(JOE)]
    rows = september()
    await runAt('2026-10-01T15:00:00.000Z')
    const [push] = recaps()
    expect(push.title).toBe('Your September in Drafter')
    expect(push.tag).toBe('recap-2026-09')
    expect(push.url).toBe('https://site.test/?insights=month&period=2026-09')
    expect(push.to).toEqual([`https://push.example.test/${JOE.slice(0, 4)}`])
    const notice = kept.get(recapNoticeId(JOE, '2026-09'))!
    expect(recapNoticeId(JOE, '2026-09')).toBe(`notice~${JOE}~recap~2026-09`)
    expect(notice.user_id).toBe(JOE)
    expect(notice.data).toMatchObject({ kind: 'notice', type: 'digest', title: 'Your September in Drafter', target: { kind: 'insights', id: '2026-09' } })
    // the notice and the push say the same lines, most interesting first
    expect(push.body).toBe(notice.data.lines.join('\n'))
    expect(notice.data.lines).toEqual([
      'Journal 9 days in a row · your longest yet',
      '4 tasks done in September, ↑4 on August · Tuesdays were your best',
      'You saw Tio Marco in September, ↑1 on August · on 1 day',
    ])
    // …and the morning digest still went, first, as on any other day
    expect(log.map(e => e.title)).toEqual(['Good morning — today in Drafter', 'Your September in Drafter'])
  })

  it('counts only the member’s own log, and nothing the database would not let them read', async () => {
    settings = [account(JOE), account(MARIA)]
    rows = september()
    await runAt('2026-10-01T15:00:00.000Z')
    const joe = kept.get(recapNoticeId(JOE, '2026-09'))!.data.lines.join('\n')
    // four tasks: not Maria's two, and not her private one handed to him
    expect(joe).toContain('4 tasks done in September')
    // Tio Marco alone: not Maria's Ana, and not the private visit with Rosa
    expect(joe).toContain('You saw Tio Marco in September')
    expect(joe).not.toMatch(/Ana|Rosa/)
    // his nine days of journal, never her thirty
    expect(joe).toContain('Journal 9 days in a row')
    expect(joe).not.toContain('30 days')
    // and Maria's own recap is hers: her thirty days, her two tasks, her Ana
    // …and Maria's is hers: her thirty days, her own two tasks (the one she
    // handed Joe is his to do), and whom she saw, Rosa's private visit included
    const maria = kept.get(recapNoticeId(MARIA, '2026-09'))!.data.lines.join('\n')
    expect(maria).toContain('Journal 30 days in a row')
    expect(maria).toContain('2 tasks done in September')
    expect(maria).toContain('You saw 2 people in September')
    expect(maria).not.toContain('Tio Marco')
    expect(kept.get(recapNoticeId(MARIA, '2026-09'))!.user_id).toBe(MARIA)
  })

  it('agrees line for line with what the app’s Highlights say about the same month', () => {
    const now = new Date('2026-10-01T15:00:00.000Z')
    const recap = buildRecap(september(), JOE, [MARIA], JOE, 'America/Phoenix', now, '2026-09')
    // the app's own path: the same module, on the same records, as Joe reads them
    const day = dayKeysIn('America/Phoenix')
    const mine = september()
      .filter(r => r.user_id === JOE || (r.data.shared !== false && r.data.kind !== 'journal'))
      .map((r): Record<string, unknown> => ({ ...r.data, ownerId: r.user_id ?? undefined }))
    const of = (kind: string) => mine.filter(r => r.kind === kind) as never[]
    const cards = pickHighlights(
      insightFigures(
        { tasks: of('task'), people: of('person'), journal: of('journal'), myId: JOE, whose: 'mine', now, today: '2026-10-01', dayKeyOf: iso => day(Date.parse(iso)) },
        periodSpan('month', '2026-09-01', '2026-10-01'),
      ),
    )
    expect(recap.lines).toEqual(recapLines(cards))
  })

  it('says nothing about a month with nothing in it', async () => {
    settings = [account(JOE)]
    rows = [person('marco', 'Tio Marco')]
    await runAt('2026-10-01T15:00:00.000Z')
    expect(recaps()).toEqual([])
    expect(kept.has(recapNoticeId(JOE, '2026-09'))).toBe(false)
  })
})

describe('exactly once a month', () => {
  it('sends nothing on the next hourly run, the notice being there', async () => {
    settings = [account(JOE)]
    rows = september()
    await runAt('2026-10-01T15:00:00.000Z')
    expect(recaps()).toHaveLength(1)
    await runAt('2026-10-01T16:00:00.000Z')
    await runAt('2026-10-01T23:00:00.000Z')
    expect(recaps()).toHaveLength(1)
    expect([...kept.keys()].filter(id => id.includes('~recap~'))).toEqual([recapNoticeId(JOE, '2026-09')])
  })

  it('pushes nothing when the notice turns out to be written already, even if the first read missed it', async () => {
    settings = [account(JOE)]
    rows = september()
    await runAt('2026-10-01T15:00:00.000Z')
    // a run that raced the first: its one read saw no recap yet, but the write finds one there
    listWritten = () => []
    await runAt('2026-10-01T16:00:00.000Z')
    expect(recaps()).toHaveLength(1)
  })

  it('writes the notice before it pushes, so a run that dies in between loses the push rather than repeating it', async () => {
    settings = [account(JOE)]
    rows = september()
    await runAt('2026-10-01T15:00:00.000Z')
    const recap = order.filter(e => e.includes('recap'))
    expect(recap).toEqual([`notice ${recapNoticeId(JOE, '2026-09')}`, 'push recap-2026-09'])
  })

  it('comes again on the next 1st, for the month just gone', async () => {
    settings = [account(JOE)]
    rows = [...september(), done(JOE, 'oct', '2026-10-06')]
    await runAt('2026-10-01T15:00:00.000Z')
    await runAt('2026-11-01T15:00:00.000Z')
    expect(recaps().map(r => r.title)).toEqual(['Your September in Drafter', 'Your October in Drafter'])
    expect(recaps()[1].url).toBe('https://site.test/?insights=month&period=2026-10')
  })
})

describe('the recap’s link', () => {
  it('opens Insights on its month, from the web and from the iPhone app alike', () => {
    // a browser loads the site at the link, and the app reads its query string
    expect(parseLink(new URLSearchParams('?insights=month&period=2026-09')).insights).toEqual({ period: 'month', at: '2026-09' })
    // the iPhone app is handed the link's path and query as its own
    const { host, params } = paramsOf(inAppLink('https://site.test/?insights=month&period=2026-09'))
    expect(parseLink(params, { host }).insights).toEqual({ period: 'month', at: '2026-09' })
  })
})

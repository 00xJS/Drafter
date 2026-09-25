import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pageOf } from './postgrest'

// The hourly digest (netlify/functions/digest.mjs) read every row of its eight
// kinds on every run, though most hours can send nothing but "Due now": no
// account's morning digest, Sunday draft or recap is due. user_settings, read
// first, says which hour this is, and a quiet one reads only the tasks that
// can come due now — or no record at all when nobody has a browser to nudge.
// What it sends is what it sent. The database here answers the filters the
// runs ask with (kind, status, due_at), so a read too narrow would show.

const { pushes } = vi.hoisted(() => ({ pushes: [] as { to: string[]; title: string }[] }))
vi.mock('../../netlify/functions/push.mjs', () => ({
  pushConfigured: () => true,
  sendToAll: async (subs: { endpoint: string }[], payload: { title: string }) => {
    pushes.push({ to: subs.map(s => s.endpoint), title: payload.title })
    return { gone: [], failed: [], updated: [] }
  },
}))
// no model unless a test says there is one (a recipe night needs one to start)
const ai = vi.hoisted(() => ({ provider: null as null | { name: string } }))
vi.mock('../../netlify/functions/lib/ai.mjs', () => ({ resolveProvider: () => ai.provider, complete: async () => ({ error: 'no model here' }) }))

// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import digestFunction, { RECIPE_ROWS, dueWindowPath } from '../../netlify/functions/digest.mjs'

const SUPABASE = 'https://db.example.test'
const REST = `${SUPABASE}/rest/v1/`
const JOE = 'a1b2c3d4-0000-4000-8000-0000000000aa'
const MARIA = 'e5f6a7b8-0000-4000-8000-0000000000bb'
const STAMP = '2026-09-01T00:00:00.000Z'
const runDigest = digestFunction as () => Promise<Response>

type Row = { id: string; user_id: string; data: Record<string, unknown> }
let settings: Record<string, any>[]
let rows: Row[]
/** Each read of records: the filter it asked with, and how many rows came back. */
let reads: { path: string; rows: number }[]

const browser = (who: string) => ({ endpoint: `https://push.example.test/${who}`, keys: { p256dh: 'p', auth: 'a' } })
const iphone = (who: string) => ({ endpoint: `apns:${who}0123456789abcdef0123456789abcdef`, type: 'apns', token: `${who}0123456789abcdef0123456789abcdef` })
/** An account in Phoenix (UTC-7): its digest at 11pm, due at none of the hours below unless asked. */
const account = (user_id: string, subs: unknown[], over: Record<string, unknown> = {}) => ({
  user_id,
  push_subscriptions: subs,
  digest_email: false,
  digest_hour: 23,
  timezone: 'America/Phoenix',
  nudged: {},
  ...over,
})
const row = (user_id: string, data: Record<string, unknown>): Row => ({ id: String(data.id), user_id, data: { createdAt: STAMP, updatedAt: STAMP, ...data } })
const task = (user_id: string, id: string, dueAt: string | undefined, over: Record<string, unknown> = {}) =>
  row(user_id, { kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', tags: [], ...(dueAt ? { dueAt } : {}), ...over })

/**
 * A household's records as a digest meets them: people, places, meals,
 * recipes, events, reviews and a project beside the tasks, most of which are
 * done, undated or due some other day.
 */
function household(): Row[] {
  const out: Row[] = [row(JOE, { kind: 'project', id: 'home', name: 'Home', status: 'active' })]
  for (let i = 0; i < 20; i++) out.push(row(JOE, { kind: 'person', id: `person-${i}`, name: `Person ${i}` }))
  for (let i = 0; i < 10; i++) out.push(row(JOE, { kind: 'place', id: `place-${i}`, name: `Place ${i}` }))
  for (let i = 0; i < 30; i++) out.push(row(JOE, { kind: 'meal', id: `meal-${i}`, date: '2026-09-01', slot: 'dinner' }))
  for (let i = 0; i < 44; i++) out.push(row(MARIA, { kind: 'recipe', id: `recipe-${i}`, name: `Recipe ${i}` }))
  for (let i = 0; i < 15; i++) out.push(row(JOE, { kind: 'event', id: `event-${i}`, title: `Event ${i}`, date: '2026-09-02' }))
  for (let i = 0; i < 5; i++) out.push(row(JOE, { kind: 'review', id: `review-${i}`, week: `2026-W3${i}` }))
  for (let i = 0; i < 40; i++) out.push(task(JOE, `done-${i}`, '2026-09-23T15:10:00.000Z', { status: 'done' }))
  for (let i = 0; i < 20; i++) out.push(task(MARIA, `someday-${i}`, undefined))
  for (let i = 0; i < 10; i++) out.push(task(JOE, `last-week-${i}`, '2026-09-16T15:10:00.000Z'))
  for (let i = 0; i < 10; i++) out.push(task(MARIA, `next-week-${i}`, '2026-09-30T15:10:00.000Z'))
  // what can come due at this hour: Joe's, Maria's, and one written with an offset
  out.push(task(JOE, 'Call the vet', '2026-09-23T15:15:00.000Z'))
  out.push(task(MARIA, 'Paint the shed', '2026-09-23T15:20:00.000Z'))
  out.push(task(JOE, 'Clear the gutter', '2026-09-23T08:25:00-07:00'))
  // a post from before v3, which reads as a task once converted: no kind, a draft
  out.push(row(JOE, { id: 'legacy-post', title: 'Post the photos', status: 'draft', scheduledFor: '2026-09-23T15:05:00.000Z' }))
  return out
}

/** The rows a read asks for, as the database would answer: its kinds, statuses and due window. */
function answer(path: string): Row[] {
  const q = new URL(`https://x/${path}`).searchParams
  return rows.filter(({ data }) => {
    const kind = String(data.kind ?? 'task')
    const due = (data.dueAt ?? data.scheduledFor) as string | undefined
    for (const [key, value] of q) {
      if (key === 'kind' && value.startsWith('eq.') && kind !== value.slice(3)) return false
      if (key === 'kind' && value.startsWith('in.(') && !value.slice(4, -1).split(',').includes(kind)) return false
      if (key === 'due_at' && value.startsWith('gte.') && !(due !== undefined && due >= value.slice(4))) return false
      if (key === 'due_at' && value.startsWith('lt.') && !(due !== undefined && due < value.slice(3))) return false
      if (key === 'or') {
        const statuses = /^\(data->>kind\.is\.null,status\.in\.\(([^)]*)\)\)$/.exec(value)
        if (!statuses) throw new Error(`a filter this database does not know: or=${value}`)
        if (!(data.kind === undefined || statuses[1].split(',').includes(String(data.status)))) return false
      }
    }
    return true
  })
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('URL', 'https://site.test')
  vi.useFakeTimers({ toFake: ['Date'] })
  pushes.length = 0
  ai.provider = null
  settings = []
  rows = household()
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
        const page = pageOf(path, answer(path))
        reads.push({ path: path.replace(/&id=gt\.[^&]*/, '').replace(/&order=id\.asc&limit=\d+$/, ''), rows: page.length })
        return Response.json(page)
      }
      if (path === 'household_members?select=household_id,user_id') {
        return Response.json([
          { household_id: 'h1', user_id: JOE },
          { household_id: 'h1', user_id: MARIA },
        ])
      }
      if (path.startsWith('user_settings?user_id=eq.') && method === 'PATCH') {
        Object.assign(settings.find(s => s.user_id === decodeURIComponent(path.slice('user_settings?user_id=eq.'.length))) ?? {}, body)
        return new Response(null, { status: 204 })
      }
      if (path.startsWith('posts?select=id&id=in.(')) return Response.json([])
      if (path.startsWith('rpc/record_kind_allowed')) return Response.json(false)
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
const rowsRead = () => reads.reduce((n, r) => n + r.rows, 0)
const nudged = (who: string) =>
  pushes
    .filter(p => p.to.includes(`https://push.example.test/${who}`) && p.title.startsWith('Due now: '))
    .map(p => p.title.slice('Due now: '.length))
    .sort()
const EVERY_KIND = 'posts?select=id,data,user_id&deleted=is.false&kind=in.(task,project,person,place,meal,recipe,event,review)'

// 23 September 2026, 15:30 UTC: 08:30 in Phoenix, a Wednesday
const HOUR = '2026-09-23T15:30:00.000Z'

describe('a quiet hour reads only the tasks that can come due now', () => {
  it('and nudges as it did, from a few rows where it read them all', async () => {
    settings = [account(JOE, [browser('joe')], { last_due_check: '2026-09-23T15:00:00.000Z' }), account(MARIA, [browser('maria')], { last_due_check: '2026-09-23T15:00:00.000Z' })]
    await runAt(HOUR)
    expect(new Set(reads.map(r => r.path))).toEqual(new Set([dueWindowPath(new Date(HOUR))]))
    expect(nudged('joe')).toEqual(['Call the vet', 'Clear the gutter', 'Post the photos'])
    expect(nudged('maria')).toEqual(['Paint the shed'])
    // the four that can come due, of the 209 records it used to read every hour
    expect(rowsRead()).toBe(4)
    expect(rows).toHaveLength(209)
  })

  it('sends what the full read sends: the same hour, read whole because another account’s digest is due', async () => {
    const at = { last_due_check: '2026-09-23T15:00:00.000Z' }
    settings = [account(JOE, [browser('joe')], at), account(MARIA, [browser('maria')], at)]
    await runAt(HOUR)
    const quiet = { joe: nudged('joe'), maria: nudged('maria') }
    expect(reads.every(r => r.path !== EVERY_KIND)).toBe(true)

    pushes.length = 0
    reads = []
    // an account with no browser whose digest is due now: the hour is not quiet
    settings = [account(JOE, [browser('joe')], at), account(MARIA, [browser('maria')], at), account('c0ffee00-0000-4000-8000-0000000000cc', [], { digest_email: true, digest_hour: 8 })]
    await runAt(HOUR)
    expect(reads.map(r => r.path)).toContain(EVERY_KIND)
    expect(rowsRead()).toBe(209)
    expect({ joe: nudged('joe'), maria: nudged('maria') }).toEqual(quiet)
  })

  it('reads no record at all when nobody has a browser to nudge', async () => {
    settings = [account(JOE, [iphone('a')], { last_due_check: '2026-09-23T15:00:00.000Z' }), account(MARIA, [], { digest_email: true })]
    await runAt(HOUR)
    expect(reads).toEqual([])
    expect(pushes).toEqual([])
    // the iPhone's watermark moves on as it did, so a browser added later starts from here
    expect(settings[0].last_due_check).toBe(HOUR)
  })
})

describe('a recipe night that is otherwise quiet', () => {
  // 03:30 in Phoenix, when the nightly recipe drafts start (lib/recipedrafts.mjs):
  // no digest, draft or recap is due, so the hour stays quiet and reads the
  // recipes the drafts look at on their own, never every kind
  it('reads the tasks that can come due and the recipes, not every kind', async () => {
    ai.provider = { name: 'test' }
    const at = { last_due_check: '2026-09-23T10:00:00.000Z' }
    settings = [account(JOE, [browser('joe')], at), account(MARIA, [browser('maria')], at)]
    await runAt('2026-09-23T10:30:00.000Z')
    expect(new Set(reads.map(r => r.path))).toEqual(new Set([dueWindowPath(new Date('2026-09-23T10:30:00.000Z')), RECIPE_ROWS]))
    expect(reads.find(r => r.path === RECIPE_ROWS)?.rows).toBe(44)
  })

  it('reads no recipe on a night hour with no model to draft with', async () => {
    const at = { last_due_check: '2026-09-23T10:00:00.000Z' }
    settings = [account(JOE, [browser('joe')], at), account(MARIA, [browser('maria')], at)]
    await runAt('2026-09-23T10:30:00.000Z')
    expect(reads.map(r => r.path)).not.toContain(RECIPE_ROWS)
  })
})

describe('the hours that need every kind still read them', () => {
  it('an account’s morning digest', async () => {
    settings = [account(JOE, [browser('joe')], { digest_hour: 8, last_due_check: '2026-09-23T15:00:00.000Z' })]
    await runAt(HOUR)
    expect(reads.map(r => r.path)).toEqual([EVERY_KIND, EVERY_KIND])
    expect(pushes.map(p => p.title)).toContain('Good morning — today in Drafter')
    expect(settings[0].last_digest_day).toBe('2026-09-23')
  })

  it('the 1st, from an account’s digest hour, when its recap is still to go', async () => {
    settings = [account(JOE, [browser('joe')], { digest_hour: 8, last_digest_day: '2026-10-01' })]
    await runAt('2026-10-01T15:30:00.000Z')
    expect(reads.map(r => r.path)).toContain(EVERY_KIND)
  })

  it('an hour later that day, with the digest sent, is quiet again', async () => {
    settings = [account(JOE, [browser('joe')], { digest_hour: 8, last_digest_day: '2026-09-23', last_due_check: '2026-09-23T16:00:00.000Z' })]
    await runAt('2026-09-23T16:30:00.000Z')
    expect(reads.map(r => r.path)).toEqual([dueWindowPath(new Date('2026-09-23T16:30:00.000Z')), dueWindowPath(new Date('2026-09-23T16:30:00.000Z'))])
  })
})

describe('dueWindowPath', () => {
  it('asks for open tasks, and every post from before v3, due within a day either side of the last six hours', () => {
    expect(dueWindowPath(new Date(HOUR))).toBe(
      'posts?select=id,data,user_id&deleted=is.false&kind=eq.task&or=(data->>kind.is.null,status.in.(todo,doing,blocked))&due_at=gte.2026-09-22&due_at=lt.2026-09-25',
    )
  })
})

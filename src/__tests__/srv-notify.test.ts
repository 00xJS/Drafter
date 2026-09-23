import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/notify: the actor's device says what it changed on a task, and the
// server decides who hears of it, writes their notice and pushes it. Read with
// the service key, so every visibility rule is applied here: the actor must be
// able to read the task, each recipient must be in their household and able
// to read it too, and a recipient who switched the updates off hears nothing.
//
// The database is a fake that keeps rows and answers sync_posts by
// last-write-wins; push is stubbed at its module.

const { pushes, pushState } = vi.hoisted(() => ({
  pushes: [] as { to: string[]; title: string; body: string; tag: string; url: string }[],
  pushState: { gone: [] as string[] },
}))
vi.mock('../../netlify/functions/push.mjs', () => ({
  pushConfigured: () => true,
  sendToAll: async (subs: { endpoint: string }[], payload: { title: string; body: string; tag: string; url: string }) => {
    pushes.push({ to: subs.map(s => s.endpoint), ...payload })
    return { gone: subs.map(s => s.endpoint).filter(e => pushState.gone.includes(e)), failed: [], updated: [] }
  },
}))

// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import notifyFunction from '../../netlify/functions/notify.mjs'
import { forgetNoticesStored } from '../../netlify/functions/lib/notices.mjs'
import { noticeBucket } from '../../shared/notices.mts'

const SUPABASE = 'https://db.example.test'
const REST = `${SUPABASE}/rest/v1/`
const JOE = 'a1b2c3d4-0000-4000-8000-00000000000a'
const MARIA = 'e5f6a7b8-0000-4000-8000-00000000000b'
const STRANGER = '99999999-0000-4000-8000-0000000000cc'
const NOW = '2026-09-23T16:02:00.000Z'
const notify = notifyFunction as (req: Request) => Promise<Response>

type Row = { user_id: string; data: Record<string, any> }
let actor: string
let rows: Map<string, Row>
let settings: Map<string, Record<string, any>>
let households: { household_id: string; user_id: string }[]
let kindStored: boolean
let writes: string[]

const task = (id: string, owner: string, over: Record<string, unknown> = {}): Row => ({
  user_id: owner,
  data: { kind: 'task', id, title: 'Take bins out', description: '', status: 'todo', priority: 'normal', tags: [], createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', ...over },
})
const browser = (who: string) => ({ endpoint: `https://push.example.test/${who}`, keys: { p256dh: 'p', auth: 'a' } })

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('URL', 'https://site.test')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  forgetNoticesStored()
  actor = MARIA
  pushes.length = 0
  pushState.gone = []
  kindStored = true
  writes = []
  rows = new Map()
  households = [
    { household_id: 'h1', user_id: JOE },
    { household_id: 'h1', user_id: MARIA },
  ]
  settings = new Map([
    [JOE, { user_id: JOE, display_name: 'Joe', timezone: 'America/Phoenix', push_subscriptions: [browser('joe')] }],
    [MARIA, { user_id: MARIA, display_name: 'Maria', timezone: 'America/Phoenix', push_subscriptions: [browser('maria')] }],
  ])
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (url === `${SUPABASE}/auth/v1/user`) return Response.json({ id: actor, email: `${actor.slice(0, 4)}@example.test` })
      if (!url.startsWith(REST)) throw new Error(`unexpected fetch ${url}`)
      const path = url.slice(REST.length)
      const q = new URLSearchParams(path.slice(path.indexOf('?') + 1))
      if (path.startsWith('posts?id=eq.') && method === 'GET') {
        const row = rows.get(decodeURIComponent(q.get('id')!.slice(3)))
        return Response.json(row ? [structuredClone(row)] : [])
      }
      if (path.startsWith('household_members?user_id=eq.')) {
        const me = households.find(h => h.user_id === q.get('user_id')!.slice(3))
        return Response.json(me ? [{ household_id: me.household_id }] : [])
      }
      if (path.startsWith('household_members?household_id=eq.')) {
        return Response.json(households.filter(h => h.household_id === q.get('household_id')!.slice(3)).map(h => ({ user_id: h.user_id })))
      }
      if (path.startsWith('user_settings?user_id=eq.') && method === 'GET') {
        const s = settings.get(q.get('user_id')!.slice(3))
        return Response.json(s ? [structuredClone(s)] : [])
      }
      if (path === 'user_settings?on_conflict=user_id' && method === 'POST') {
        const { user_id, ...patch } = body
        settings.set(user_id, { ...(settings.get(user_id) ?? { user_id }), ...patch })
        return new Response(null, { status: 201 })
      }
      if (path === 'rpc/record_kind_allowed' && method === 'POST') return Response.json(kindStored)
      if (path === 'posts' && method === 'POST') {
        if (rows.has(body.id)) return Response.json({ code: '23505' }, { status: 409 })
        writes.push(`insert ${body.id}`)
        rows.set(body.id, { user_id: body.user_id, data: body.data })
        return new Response(null, { status: 201 })
      }
      if (path === 'rpc/sync_posts' && method === 'POST') {
        const stale: string[] = []
        for (const item of body.incoming) {
          const row = rows.get(item.id)
          writes.push(`sync ${item.id}`)
          // the service key's writes are the site owner's when new; an update keeps the owner
          if (!row) rows.set(item.id, { user_id: JOE, data: item })
          else if (item.updatedAt > row.data.updatedAt) row.data = item
          else stale.push(item.id)
        }
        return Response.json({ items: [], rejected: [], stale, gone: [] })
      }
      throw new Error(`unexpected ${method} ${path}`)
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const call = (body: unknown) =>
  notify(new Request('https://site.test/api/notify', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const noticesOf = (who: string) => [...rows.values()].filter(r => r.data.kind === 'notice' && r.user_id === who)
const bucket = noticeBucket(Date.parse(NOW))

describe('the assignee’s progress reaches whoever handed it over', () => {
  beforeEach(() => {
    rows.set('bins', task('bins', JOE, { assigneeId: MARIA, assignedBy: JOE, shared: true }))
  })

  it('a notice under Joe, in words the lock screen can show, and a push that opens the task', async () => {
    const res = await call({ taskId: 'bins', events: [{ type: 'checklist', detail: 'Green bin', done: true }] })
    expect(await res.json()).toEqual({ ok: true, notified: 1 })
    expect(noticesOf(JOE)).toEqual([
      {
        user_id: JOE,
        data: {
          kind: 'notice',
          id: `notice~${JOE}~bins~${bucket}`,
          at: NOW,
          type: 'progress',
          actorId: MARIA,
          target: { kind: 'task', id: 'bins' },
          title: 'Maria made progress on “Take bins out”',
          lines: ['Ticked “Green bin”'],
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    ])
    expect(noticesOf(MARIA)).toEqual([])
    expect(pushes).toEqual([
      { to: ['https://push.example.test/joe'], title: 'Maria made progress on “Take bins out”', body: 'Ticked “Green bin”', tag: 'task-bins', renotify: true, url: 'https://site.test/?task=bins' },
    ])
  })

  it('more within the quarter hour folds into the same notice, unread again, and replaces the banner', async () => {
    await call({ taskId: 'bins', events: [{ type: 'checklist', detail: 'Green bin', done: true }] })
    // Joe reads it on one of his devices
    const id = `notice~${JOE}~bins~${bucket}`
    rows.get(id)!.data = { ...rows.get(id)!.data, readAt: '2026-09-23T16:03:00.000Z', updatedAt: '2026-09-23T16:03:00.000Z' }
    vi.setSystemTime(new Date('2026-09-23T16:09:00.000Z'))
    await call({ taskId: 'bins', events: [{ type: 'comment', detail: 'Blue one was full' }, { type: 'status', detail: 'done' }] })
    expect(noticesOf(JOE)).toHaveLength(1)
    expect(noticesOf(JOE)[0].data).toMatchObject({
      type: 'done',
      title: 'Maria finished “Take bins out”',
      lines: ['Ticked “Green bin”', '“Blue one was full”', 'Marked it done'],
      at: '2026-09-23T16:09:00.000Z',
      createdAt: NOW,
    })
    expect(noticesOf(JOE)[0].data.readAt).toBeUndefined()
    // the merge went through sync_posts, which keeps the row Joe's
    expect(writes).toEqual([`insert ${id}`, `sync ${id}`])
    expect(pushes.map(p => [p.tag, p.body])).toEqual([
      ['task-bins', 'Ticked “Green bin”'],
      ['task-bins', 'Ticked “Green bin”\n“Blue one was full”\nMarked it done'],
    ])
  })

  it('a new quarter hour is a new notice', async () => {
    await call({ taskId: 'bins', events: [{ type: 'status', detail: 'doing' }] })
    vi.setSystemTime(new Date('2026-09-23T16:31:00.000Z'))
    await call({ taskId: 'bins', events: [{ type: 'status', detail: 'done' }] })
    expect(noticesOf(JOE).map(n => n.data.title)).toEqual(['Maria made progress on “Take bins out”', 'Maria finished “Take bins out”'])
  })

  it('a push service that says a device is gone takes it off the list', async () => {
    pushState.gone = ['https://push.example.test/joe']
    await call({ taskId: 'bins', events: [{ type: 'status', detail: 'done' }] })
    expect(settings.get(JOE)!.push_subscriptions).toEqual([])
  })
})

describe('what the assigner does reaches the assignee when it changes their job', () => {
  beforeEach(() => {
    actor = JOE
    rows.set('bins', task('bins', JOE, { assigneeId: MARIA, assignedBy: JOE, shared: true, dueAt: '2026-09-26T00:00:00.000Z' }))
  })

  it('handing it over, with when it is due', async () => {
    await call({ taskId: 'bins', events: [{ type: 'assigned', detail: MARIA }] })
    expect(noticesOf(MARIA).map(n => [n.data.title, n.data.lines])).toEqual([['Joe asked you to do “Take bins out”', ['Due Fri, Sep 25, 5:00 PM']]])
  })

  it('a new title reads under the new title', async () => {
    await call({ taskId: 'bins', events: [{ type: 'title', detail: 'Bins, both' }] })
    expect(noticesOf(MARIA)[0].data).toMatchObject({ title: 'Joe changed “Bins, both”', lines: ['Renamed it “Bins, both”'] })
  })

  it('but not the assigner ticking steps: nobody hears that', async () => {
    const res = await call({ taskId: 'bins', events: [{ type: 'checklist', detail: 'Green bin', done: true }] })
    expect(await res.json()).toEqual({ ok: true, notified: 0 })
    expect(noticesOf(MARIA)).toEqual([])
    expect(pushes).toEqual([])
  })
})

describe('never anyone who should not hear it', () => {
  it('a task the actor cannot read is no task at all', async () => {
    // Joe keeps this one to himself; Maria cannot see it, so cannot report on it
    rows.set('secret', task('secret', JOE, { shared: false }))
    const res = await call({ taskId: 'secret', events: [{ type: 'comment', detail: 'hello' }] })
    expect(res.status).toBe(404)
    expect(await call({ taskId: 'nope', events: [{ type: 'comment', detail: 'hello' }] }).then(r => r.status)).toBe(404)
    expect(rows.size).toBe(1)
  })

  it('an owner outside the actor’s household hears nothing, whatever the task says', async () => {
    households.push({ household_id: 'h2', user_id: STRANGER })
    rows.set('theirs', task('theirs', STRANGER, { shared: true }))
    expect((await call({ taskId: 'theirs', events: [{ type: 'status', detail: 'done' }] })).status).toBe(404)
    // …and a recipient who has left the household since the task was assigned
    rows.set('bins', task('bins', JOE, { assigneeId: MARIA, assignedBy: STRANGER, shared: true }))
    expect(await (await call({ taskId: 'bins', events: [{ type: 'status', detail: 'done' }] })).json()).toEqual({ ok: true, notified: 0 })
    expect(noticesOf(STRANGER)).toEqual([])
  })

  it('never the actor', async () => {
    rows.set('mine', task('mine', MARIA, { assigneeId: MARIA, assignedBy: MARIA, shared: true }))
    expect(await (await call({ taskId: 'mine', events: [{ type: 'status', detail: 'done' }, { type: 'comment', detail: 'Done it' }] })).json()).toEqual({ ok: true, notified: 0 })
    expect(pushes).toEqual([])
  })

  it('a recipient who switched the updates off gets neither a notice nor a push', async () => {
    settings.get(JOE)!.notify_activity = false
    rows.set('bins', task('bins', JOE, { assigneeId: MARIA, assignedBy: JOE, shared: true }))
    expect(await (await call({ taskId: 'bins', events: [{ type: 'status', detail: 'done' }] })).json()).toEqual({ ok: true, notified: 0 })
    expect(noticesOf(JOE)).toEqual([])
    expect(pushes).toEqual([])
  })

  it('writes nothing until the database stores notices (the v3.32 migration)', async () => {
    kindStored = false
    rows.set('bins', task('bins', JOE, { assigneeId: MARIA, assignedBy: JOE, shared: true }))
    expect(await (await call({ taskId: 'bins', events: [{ type: 'status', detail: 'done' }] })).json()).toEqual({ ok: true, notified: 0 })
    expect(rows.size).toBe(1)
    expect(pushes).toEqual([])
  })
})

describe('what it takes', () => {
  beforeEach(() => {
    rows.set('bins', task('bins', JOE, { assigneeId: MARIA, assignedBy: JOE, shared: true }))
  })

  it('a task and events it knows, and nothing else', async () => {
    for (const body of [
      {},
      { taskId: 'bins' },
      { taskId: 'bins', events: [] },
      { taskId: 'bins', events: [{ type: 'gossip' }] },
      { taskId: 'bins', events: [{ type: 'comment', detail: 42 }] },
      { taskId: 'bins', events: [{ type: 'checklist', detail: 'x', done: 'yes' }] },
      { taskId: 'bins', events: Array.from({ length: 21 }, () => ({ type: 'comment', detail: 'x' })) },
      { taskId: 'x'.repeat(201), events: [{ type: 'comment', detail: 'x' }] },
    ]) {
      expect((await call(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    expect(pushes).toEqual([])
  })

  it('a session: without one, nothing', async () => {
    const res = await notify(new Request('https://site.test/api/notify', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(401)
  })

  it('a ceiling per account on calls', async () => {
    actor = STRANGER
    households.push({ household_id: 'h1', user_id: STRANGER })
    let last = 0
    for (let i = 0; i < 31; i++) last = (await call({ taskId: 'bins', events: [{ type: 'comment', detail: `n${i}` }] })).status
    expect(last).toBe(429)
  })
})

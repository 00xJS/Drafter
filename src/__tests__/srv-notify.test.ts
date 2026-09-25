import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/notify: the actor's device says what it changed on a task, and the
// server decides who hears of it, writes their notice and pushes it. Read with
// the service key, so every visibility rule is applied here: the actor must be
// able to read the task, each recipient must be in their household and able
// to read it too, and a recipient who switched the updates off hears nothing.
//
// The database is a fake that keeps rows and answers sync_posts_as (v3.34)
// by last-write-wins, as the account it names; push is stubbed at its module.

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
/** Each shared rate-limit count asked for, as bucket:subject. */
let limits: string[]
/** Buckets whose shared count says no, whatever this instance has counted. */
let sharedRefuses: Set<string>

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
  limits = []
  sharedRefuses = new Set()
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
      // the count every instance shares (lib/ratelimit.mjs, v3.33)
      if (path === 'rpc/rate_limit_take' && method === 'POST') {
        limits.push(`${body.p_bucket}:${body.p_subject}`)
        if (sharedRefuses.has(body.p_bucket)) return Response.json({ allowed: false, remaining: 0, retry_after_ms: 42_000 })
        return Response.json({ allowed: true, remaining: body.p_limit - 1, retry_after_ms: 0 })
      }
      if (path === 'posts' && method === 'POST') {
        if (rows.has(body.id)) return Response.json({ code: '23505' }, { status: 409 })
        writes.push(`insert ${body.id}`)
        rows.set(body.id, { user_id: body.user_id, data: body.data })
        return new Response(null, { status: 201 })
      }
      if (path === 'rpc/sync_posts_as' && method === 'POST') {
        const rejected: string[] = []
        const stale: string[] = []
        for (const item of body.incoming) {
          const row = rows.get(item.id)
          writes.push(`sync as ${body.p_owner === JOE ? 'Joe' : body.p_owner === MARIA ? 'Maria' : body.p_owner} ${item.id}`)
          // written as the account named: a new row is theirs, a row of anyone else's is refused
          if (row && row.user_id !== body.p_owner) rejected.push(item.id)
          else if (!row) rows.set(item.id, { user_id: body.p_owner, data: item })
          else if (item.updatedAt > row.data.updatedAt) row.data = item
          else stale.push(item.id)
        }
        return Response.json({ items: [], rejected, stale, gone: [] })
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
    // the merge was written as Joe, whose row it stays
    expect(writes).toEqual([`insert ${id}`, `sync as Joe ${id}`])
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

// ---- a household message: { messageId } -----------------------------------------

describe('a household message reaches everyone else in the household', () => {
  const SAM = '5a5a5a5a-0000-4000-8000-0000000000dd'
  const message = (id: string, owner: string, body: string, createdAt = '2026-09-23T16:01:30.000Z', over: Record<string, unknown> = {}): Row => ({
    user_id: owner,
    data: { kind: 'message', id, body, createdAt, updatedAt: createdAt, ...over },
  })
  const say = (id: string, body: string, createdAt?: string) => rows.set(id, message(id, MARIA, body, createdAt))
  const messageBucket = (iso: string) => noticeBucket(Date.parse(iso))
  const joesNotice = (iso = '2026-09-23T16:01:30.000Z') => `notice~${JOE}~messages-${MARIA}~${messageBucket(iso)}`

  it('a notice under Joe with the words as said, and a push headed with her name that opens the chat', async () => {
    say('m1', 'Home by six')
    const res = await call({ messageId: 'm1' })
    expect(await res.json()).toEqual({ ok: true, notified: 1 })
    expect(noticesOf(JOE)).toEqual([
      {
        user_id: JOE,
        data: {
          kind: 'notice',
          id: joesNotice(),
          // when she said it, which the thread shows it at
          at: '2026-09-23T16:01:30.000Z',
          type: 'message',
          actorId: MARIA,
          target: { kind: 'message', id: 'm1' },
          title: 'Maria sent a message',
          lines: ['Home by six'],
          messageIds: ['m1'],
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    ])
    // never the one who said it
    expect(noticesOf(MARIA)).toEqual([])
    expect(pushes).toEqual([
      { to: ['https://push.example.test/joe'], title: 'Maria', body: 'Home by six', tag: `messages-${MARIA}`, renotify: true, url: 'https://site.test/?chat=household' },
    ])
  })

  it('the words are the stored message’s, never what the request says', async () => {
    say('m1', 'Home by six')
    await call({ messageId: 'm1', body: 'Bring me the car keys', lines: ['Bring me the car keys'] })
    expect(noticesOf(JOE)[0].data.lines).toEqual(['Home by six'])
    expect(pushes.map(p => p.body)).toEqual(['Home by six'])
  })

  it('the name is the caller’s own, from their session: her address’s first part when she has set none', async () => {
    settings.get(MARIA)!.display_name = null
    say('m1', 'Home by six')
    await call({ messageId: 'm1' })
    expect(noticesOf(JOE)[0].data.title).toBe(`${MARIA.slice(0, 4)} sent a message`)
    expect(pushes[0].title).toBe(MARIA.slice(0, 4))
  })

  it('each member but the one who said it: a household of three hears it twice', async () => {
    households.push({ household_id: 'h1', user_id: SAM })
    settings.set(SAM, { user_id: SAM, display_name: 'Sam', push_subscriptions: [browser('sam')] })
    say('m1', 'Pizza tonight?')
    expect(await (await call({ messageId: 'm1' })).json()).toEqual({ ok: true, notified: 2 })
    expect([...rows.values()].filter(r => r.data.kind === 'notice').map(r => r.user_id).sort()).toEqual([JOE, SAM].sort())
    expect(pushes.map(p => p.to[0]).sort()).toEqual(['https://push.example.test/joe', 'https://push.example.test/sam'])
    // with no other member, nobody at all
    households = [{ household_id: 'h9', user_id: MARIA }]
    rows.set('m2', message('m2', MARIA, 'Anyone?'))
    expect(await (await call({ messageId: 'm2' })).json()).toEqual({ ok: true, notified: 0 })
  })

  it('more within the quarter hour is a new line in the same notice, counted, unread again, and one banner renewed', async () => {
    say('m1', 'Home by six')
    await call({ messageId: 'm1' })
    // Joe reads it on one of his devices
    const id = joesNotice()
    rows.get(id)!.data = { ...rows.get(id)!.data, readAt: '2026-09-23T16:03:00.000Z', updatedAt: '2026-09-23T16:03:00.000Z' }
    vi.setSystemTime(new Date('2026-09-23T16:05:00.000Z'))
    say('m2', 'Bring milk', '2026-09-23T16:04:50.000Z')
    expect(await (await call({ messageId: 'm2' })).json()).toEqual({ ok: true, notified: 1 })
    // the same words again are a message of their own
    say('m3', 'Bring milk', '2026-09-23T16:04:55.000Z')
    await call({ messageId: 'm3' })
    expect(noticesOf(JOE)).toHaveLength(1)
    expect(noticesOf(JOE)[0].data).toMatchObject({
      title: 'Maria sent 3 messages',
      lines: ['Home by six', 'Bring milk', 'Bring milk'],
      messageIds: ['m1', 'm2', 'm3'],
      at: '2026-09-23T16:04:55.000Z',
      target: { kind: 'message', id: 'm3' },
      createdAt: NOW,
    })
    expect(noticesOf(JOE)[0].data.readAt).toBeUndefined()
    expect(writes).toEqual([`insert ${id}`, `sync as Joe ${id}`, `sync as Joe ${id}`])
    expect(pushes.map(p => [p.tag, p.title, p.body])).toEqual([
      [`messages-${MARIA}`, 'Maria', 'Home by six'],
      [`messages-${MARIA}`, 'Maria', 'Home by six\nBring milk'],
      [`messages-${MARIA}`, 'Maria', 'Home by six\nBring milk\nBring milk'],
    ])
  })

  it('the same message told twice — a retry, another tab — is added once and pushed once, even in the next quarter hour', async () => {
    say('m1', 'Home by six', '2026-09-23T16:14:50.000Z')
    vi.setSystemTime(new Date('2026-09-23T16:14:55.000Z'))
    await call({ messageId: 'm1' })
    const id = joesNotice('2026-09-23T16:14:50.000Z')
    // Joe has read it since
    rows.get(id)!.data = { ...rows.get(id)!.data, readAt: '2026-09-23T16:15:10.000Z', updatedAt: '2026-09-23T16:15:10.000Z' }
    const before = structuredClone(rows.get(id))
    // the answer never reached her phone, so it asks again, in the next quarter hour
    vi.setSystemTime(new Date('2026-09-23T16:16:00.000Z'))
    expect(await (await call({ messageId: 'm1' })).json()).toEqual({ ok: true, notified: 0 })
    expect(noticesOf(JOE)).toHaveLength(1)
    expect(rows.get(id)).toEqual(before)
    expect(writes).toEqual([`insert ${id}`])
    expect(pushes).toHaveLength(1)
  })

  it('a message said in another quarter hour is a notice of its own', async () => {
    say('m1', 'Leaving now', '2026-09-23T15:40:00.000Z')
    say('m2', 'Here', '2026-09-23T16:01:00.000Z')
    await call({ messageId: 'm1' })
    await call({ messageId: 'm2' })
    expect(noticesOf(JOE).map(n => [n.data.id, n.data.title, n.data.lines])).toEqual([
      [joesNotice('2026-09-23T15:40:00.000Z'), 'Maria sent a message', ['Leaving now']],
      [joesNotice('2026-09-23T16:01:00.000Z'), 'Maria sent a message', ['Here']],
    ])
  })

  it('a stamp from a clock that runs fast is dated now; one from days ago, a day back at most', async () => {
    say('ahead', 'From the future', '2026-09-23T18:00:00.000Z')
    say('stale', 'From last week', '2026-09-16T10:00:00.000Z')
    await call({ messageId: 'ahead' })
    await call({ messageId: 'stale' })
    expect(noticesOf(JOE).map(n => n.data.at).sort()).toEqual(['2026-09-22T16:02:00.000Z', NOW])
  })

  it('a push service that says a device is gone takes it off the list', async () => {
    pushState.gone = ['https://push.example.test/joe']
    say('m1', 'Home by six')
    await call({ messageId: 'm1' })
    expect(settings.get(JOE)!.push_subscriptions).toEqual([])
  })

  it('writes nothing, and pushes nothing, until the database stores notices', async () => {
    kindStored = false
    say('m1', 'Home by six')
    expect(await (await call({ messageId: 'm1' })).json()).toEqual({ ok: true, notified: 0 })
    expect(noticesOf(JOE)).toEqual([])
    expect(pushes).toEqual([])
  })
})

describe('a message nobody may be told of', () => {
  it('one not filed under the caller: a row under her name is no proof she said it', async () => {
    // Joe's message, or one written under Joe by anyone: Maria cannot have it told as hers
    rows.set('m1', { user_id: JOE, data: { kind: 'message', id: 'm1', body: 'Hi', createdAt: NOW, updatedAt: NOW } })
    expect((await call({ messageId: 'm1' })).status).toBe(404)
    // …and Joe cannot tell of a row filed under Maria either
    rows.set('m2', { user_id: MARIA, data: { kind: 'message', id: 'm2', body: 'I owe you $100', createdAt: NOW, updatedAt: NOW } })
    actor = JOE
    expect((await call({ messageId: 'm2' })).status).toBe(404)
    expect([...rows.values()].filter(r => r.data.kind === 'notice')).toEqual([])
    expect(pushes).toEqual([])
  })

  it('from someone outside the household: nobody in it hears, whichever message they name', async () => {
    households.push({ household_id: 'h2', user_id: STRANGER })
    settings.set(STRANGER, { user_id: STRANGER, display_name: 'Stranger' })
    actor = STRANGER
    rows.set('m1', { user_id: MARIA, data: { kind: 'message', id: 'm1', body: 'Hi', createdAt: NOW, updatedAt: NOW } })
    expect((await call({ messageId: 'm1' })).status).toBe(404)
    // their own message goes to their own household, which is them alone
    rows.set('s1', { user_id: STRANGER, data: { kind: 'message', id: 's1', body: 'Hello?', createdAt: NOW, updatedAt: NOW } })
    expect(await (await call({ messageId: 's1' })).json()).toEqual({ ok: true, notified: 0 })
    expect([...rows.values()].filter(r => r.data.kind === 'notice')).toEqual([])
    expect(pushes).toEqual([])
  })

  it('a deleted one, one that is not there, and a row that is not a message', async () => {
    rows.set('gone', { user_id: MARIA, data: { kind: 'message', id: 'gone', body: 'Oops', createdAt: NOW, updatedAt: NOW, deletedAt: NOW } })
    rows.set('bins', task('bins', MARIA, { shared: true }))
    rows.set('said-nothing', { user_id: MARIA, data: { kind: 'message', id: 'said-nothing', body: '  ', createdAt: NOW, updatedAt: NOW } })
    for (const messageId of ['gone', 'nope', 'bins', 'said-nothing']) expect((await call({ messageId })).status, messageId).toBe(404)
    expect([...rows.values()].filter(r => r.data.kind === 'notice')).toEqual([])
    expect(pushes).toEqual([])
  })

  it('a message and nothing else: an id, and nothing of a task’s beside it', async () => {
    rows.set('m1', { user_id: MARIA, data: { kind: 'message', id: 'm1', body: 'Hi', createdAt: NOW, updatedAt: NOW } })
    for (const body of [{ messageId: '' }, { messageId: 42 }, { messageId: 'x'.repeat(201) }, { messageId: 'm1', taskId: 'bins' }, { messageId: 'm1', events: [] }]) {
      expect((await call(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    expect(pushes).toEqual([])
  })
})

// Each Netlify instance kept its own count, so calls spread over cold starts
// were never counted together; /api/ai has had the shared count since v3.33.
describe('the ceilings are counted across instances', () => {
  beforeEach(() => {
    rows.set('bins', task('bins', JOE, { assigneeId: MARIA, assignedBy: JOE, shared: true }))
    rows.set('m1', { user_id: MARIA, data: { kind: 'message', id: 'm1', body: 'Hi', createdAt: NOW, updatedAt: NOW } })
  })

  it('asks the shared count for each call, a bucket for tasks and one for messages, per account', async () => {
    await call({ taskId: 'bins', events: [{ type: 'comment', detail: 'On it' }] })
    await call({ messageId: 'm1' })
    expect(limits).toEqual([`notify:${MARIA}`, `notify-message:${MARIA}`])
  })

  it('the shared count’s no is a 429, whatever this instance has counted, and tells nobody', async () => {
    sharedRefuses.add('notify')
    const res = await call({ taskId: 'bins', events: [{ type: 'comment', detail: 'On it' }] })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('42')
    expect(noticesOf(JOE)).toEqual([])
    expect(pushes).toEqual([])
    // the messages' count is its own
    expect((await call({ messageId: 'm1' })).status).toBe(200)
  })
})

describe('a ceiling of its own for messages', () => {
  // accounts of their own: the ceilings are per account, and outlive a test
  const CHATTY = 'c0c0c0c0-0000-4000-8000-0000000000e1'
  const BUSY = 'b0b0b0b0-0000-4000-8000-0000000000e2'

  beforeEach(() => {
    households.push({ household_id: 'h1', user_id: CHATTY }, { household_id: 'h1', user_id: BUSY })
    rows.set('bins', task('bins', JOE, { assigneeId: MARIA, assignedBy: JOE, shared: true }))
  })

  it('a lively chat is held at sixty messages in ten minutes, and never holds up word of a task', async () => {
    actor = CHATTY
    rows.set('c1', { user_id: CHATTY, data: { kind: 'message', id: 'c1', body: 'Hi', createdAt: NOW, updatedAt: NOW } })
    const statuses: number[] = []
    for (let i = 0; i < 61; i++) statuses.push((await call({ messageId: 'c1' })).status)
    expect(statuses.slice(0, 60).every(s => s === 200)).toBe(true)
    expect(statuses[60]).toBe(429)
    // the tasks' ceiling is untouched: a change to a task still goes
    expect((await call({ taskId: 'bins', events: [{ type: 'comment', detail: 'On it' }] })).status).toBe(200)
  })

  it('and a run of task changes never holds up a message', async () => {
    actor = BUSY
    let last = 0
    for (let i = 0; i < 31; i++) last = (await call({ taskId: 'bins', events: [{ type: 'comment', detail: `n${i}` }] })).status
    expect(last).toBe(429)
    rows.set('b1', { user_id: BUSY, data: { kind: 'message', id: 'b1', body: 'Done with the bins', createdAt: NOW, updatedAt: NOW } })
    expect((await call({ messageId: 'b1' })).status).toBe(200)
  })
})

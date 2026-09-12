import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { visibleItemsFor } from '../../shared/digest.mjs'
import { localDayKey } from '../../shared/journal.mjs'
import { groceryId } from '../../shared/kitchen.mjs'
import { weekKeyOf } from '../../shared/weeks.mjs'
import { PERSONAL_KINDS as SHARED_PERSONAL_KINDS } from '../../shared/kinds.mjs'
import { makeClock } from '../../shared/clock.mjs'
import { PAGE_SIZE, PERSONAL_KINDS, SINCE_WINDOW_MS, createRestData, ownerMaySee } from '../../mcp/data.mjs'
import { TOOLS, assertDayKey, createContext, resolveContext, summarizePlace, summarizeTask } from '../../mcp/tools.mjs'
import type { Scope } from '../../mcp/tools.mjs'
import { KNOWN_KINDS } from '../schema'

// The MCP tools reach Supabase through mcp/data.mjs over fetch; here fetch is
// a stub, so these tests pin the data layer's contract with PostgREST and
// sync_posts ({ items, rejected, stale, gone }), both of its views (the user's
// own JWT, and the deprecated service key filtered to the owner), and the
// tools' privacy — with no database and no transport.

const BASE = 'https://db.example.test'
const RPC = `${BASE}/rest/v1/rpc/sync_posts`
type Call = { url: string; method: string; body?: any; headers: Record<string, string> }
const calls: Call[] = []

function respond(handler: (url: string, body: any, headers: Record<string, string>) => unknown) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    calls.push({ url, method: init?.method ?? 'GET', body, headers })
    const out = handler(url, body, headers)
    if (out instanceof Response) return out
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

/** The deprecated local mode: the service key, read in the owner's view. */
const serviceData = () => createRestData({ baseUrl: BASE, mode: 'service', auth: async () => ({ apikey: 'service-key', bearer: 'service-key' }) })
const ALL_SCOPES: Scope[] = ['read', 'write', 'journal']
const ctxFor = (scopes: Scope[] = ALL_SCOPES) => createContext({ db: serviceData(), clock: makeClock(), scopes })

afterEach(() => {
  calls.length = 0
  vi.restoreAllMocks()
})

describe('syncWrite against the sync_posts contract', () => {
  it('unwraps { items, rejected } and returns the normalized list', async () => {
    respond(url => (url === RPC ? { items: [{ kind: 'task', id: 'a', title: 'A', updatedAt: '2026-09-08T10:00:00.000Z' }], rejected: [] } : []))
    const all = await serviceData().syncWrite([{ kind: 'task', id: 'a', title: 'A', updatedAt: '2026-09-08T10:00:00.000Z' }])
    expect(all.map(i => i.id)).toEqual(['a'])
  })

  it('still accepts the legacy bare-array shape', async () => {
    respond(() => [{ kind: 'task', id: 'a', title: 'A', updatedAt: '2026-09-08T10:00:00.000Z' }])
    const all = await serviceData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])
    expect(all).toHaveLength(1)
  })

  it('throws when the server rejected one of the ids it was sent', async () => {
    respond(() => ({ items: [], rejected: ['a'] }))
    await expect(serviceData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])).rejects.toThrow(/refused to store a/)
  })

  it('writeItem throws when the stored copy carries a different stamp (lost the merge)', async () => {
    respond(() => ({ items: [{ kind: 'task', id: 'a', updatedAt: '2026-09-08T12:00:00.000Z' }], rejected: [] }))
    await expect(serviceData().writeItem({ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' })).rejects.toThrow(/last-write-wins/)
  })

  it('writeItem returns the stored copy when the stamps match', async () => {
    respond(() => ({ items: [{ kind: 'task', id: 'a', title: 'stored', updatedAt: '2026-09-08T10:00:00.000Z' }], rejected: [] }))
    const stored = await serviceData().writeItem({ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' })
    expect(stored.title).toBe('stored')
    expect(calls[0].url).toBe(RPC)
    expect((calls[0].body as { incoming: unknown[] }).incoming).toHaveLength(1)
  })

  it('sends a since cursor ten minutes back, so the echo is recent rows and never the whole table', async () => {
    respond(() => ({ items: [{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }], rejected: [] }))
    const before = Date.now()
    await serviceData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])
    const since = Date.parse(calls[0].body.since)
    expect(since).toBeGreaterThanOrEqual(before - SINCE_WINDOW_MS - 1000)
    expect(since).toBeLessThanOrEqual(Date.now() - SINCE_WINDOW_MS + 1000)
  })

  it('confirms an id missing from the echo with one read, and calls it lost only when the read finds nothing', async () => {
    respond(url => (url === RPC ? { items: [], rejected: [], stale: [], gone: [] } : [{ data: { kind: 'task', id: 'a', title: 'kept', updatedAt: '2026-09-08T10:00:00.000Z' } }]))
    const [kept] = await serviceData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])
    expect(kept.title).toBe('kept')
    expect(calls.map(c => c.url)).toEqual([RPC, `${BASE}/rest/v1/posts?id=eq.a&select=data`])

    respond(url => (url === RPC ? { items: [], rejected: [] } : []))
    await expect(serviceData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])).rejects.toThrow(/did not keep a/)
  })

  it('a stale id is a failed write, and a gone id a record deleted for good', async () => {
    respond(() => ({ items: [{ kind: 'task', id: 'a', updatedAt: '2026-09-09T10:00:00.000Z' }], rejected: [], stale: ['a'], gone: [] }))
    await expect(serviceData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])).rejects.toThrow(/A newer edit to that record won — re-read it and try again/)
    respond(() => ({ items: [], rejected: [], stale: [], gone: ['a'] }))
    await expect(serviceData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])).rejects.toThrow(/That record was deleted for good/)
  })
})

describe('fetchJournal reads only the owner', () => {
  it('drops a household peer\'s journal rows and keeps legacy unowned ones', async () => {
    respond(url => {
      if (url.includes('/rpc/owner_user_id')) return 'owner-1'
      if (url.includes('kind=eq.journal'))
        return [
          { user_id: 'owner-1', data: { kind: 'journal', id: 'j1', date: '2026-09-08', body: 'mine' } },
          { user_id: 'peer-2', data: { kind: 'journal', id: 'j2', date: '2026-09-08', body: 'theirs' } },
          { user_id: null, data: { kind: 'journal', id: 'j0', date: '2026-09-07', body: 'legacy' } },
        ]
      return []
    })
    const journal = await serviceData().fetchJournal()
    expect(journal.map(e => e.id).sort()).toEqual(['j0', 'j1'])
  })
})

describe('user mode: the hosted endpoint reads as the user', () => {
  const USER = '00000000-0000-0000-0000-00000000000b'
  const userData = (onUnauthorized: (() => void) | null = null) =>
    createRestData({ baseUrl: BASE, mode: 'user', userId: USER, auth: async () => ({ apikey: 'anon-key', bearer: 'jwt-of-the-user' }), onUnauthorized })

  it('reads the journal filtered to the user\'s own rows, with the anon key and the user\'s JWT', async () => {
    respond(() => [{ user_id: USER, data: { kind: 'journal', id: 'j1', date: '2026-09-08', body: 'mine' } }])
    const journal = await userData().fetchJournal()
    expect(journal.map(e => e.id)).toEqual(['j1'])
    expect(calls[0].url).toContain('kind=eq.journal')
    expect(calls[0].url).toContain(`user_id=eq.${USER}`)
    expect(calls[0].headers).toMatchObject({ apikey: 'anon-key', authorization: 'Bearer jwt-of-the-user' })
    // the posts policies are the filter: no owner lookup, no service key
    expect(calls.some(c => c.url.includes('owner_user_id'))).toBe(false)
  })

  it('carries each row\'s owner and writes with the user\'s JWT', async () => {
    respond(url => (url === RPC ? { items: [{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z', ownerId: USER }], rejected: [] } : [{ user_id: 'peer', data: { kind: 'task', id: 'shared' } }]))
    expect((await userData().fetchAll())[0]).toMatchObject({ id: 'shared', ownerId: 'peer' })
    await userData().writeItem({ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' })
    expect(calls[calls.length - 1].headers.authorization).toBe('Bearer jwt-of-the-user')
  })

  it('drops the session and retries once on a 401, and does not loop on a second', async () => {
    let refusals = 1
    const dropped: string[] = []
    respond(() => (refusals-- > 0 ? new Response('{"message":"JWT expired"}', { status: 401 }) : []))
    await userData(() => dropped.push('x')).fetchAll()
    expect(dropped).toHaveLength(1)
    expect(calls).toHaveLength(2)

    calls.length = 0
    respond(() => new Response('{"message":"JWT expired"}', { status: 401 }))
    await expect(userData(() => dropped.push('y')).fetchAll()).rejects.toThrow(/Supabase 401/)
    expect(calls).toHaveLength(2)
  })
})

describe('reads page past max_rows', () => {
  const OWNER_ID = 'owner-1'
  const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ user_id: OWNER_ID, data: { kind: 'task', id: `t${i}`, title: `T${i}`, status: 'todo', updatedAt: '2026-09-08T10:00:00.000Z' } }))
  const servePages = (rows: ReturnType<typeof rowsOf>) =>
    respond((url, _body, headers) => {
      if (url.includes('owner_user_id')) return OWNER_ID
      const [from, to] = String(headers.range).split('-').map(Number)
      return rows.slice(from, to + 1)
    })

  it('asks for 1000-row pages with Range headers until a short page, and keeps every row', async () => {
    servePages(rowsOf(PAGE_SIZE + 5))
    const all = await serviceData().fetchAll({ kinds: ['task'] })
    expect(all).toHaveLength(PAGE_SIZE + 5)
    const reads = calls.filter(c => c.url.includes('/rest/v1/posts'))
    expect(reads.map(c => c.headers.range)).toEqual(['0-999', '1000-1999'])
    expect(reads.every(c => c.headers['range-unit'] === 'items')).toBe(true)
  })

  it('a table of exactly one page reads the next, empty page rather than assume', async () => {
    servePages(rowsOf(PAGE_SIZE))
    expect(await serviceData().fetchAll()).toHaveLength(PAGE_SIZE)
    expect(calls.filter(c => c.url.includes('/rest/v1/posts')).map(c => c.headers.range)).toEqual(['0-999', '1000-1999'])
  })

  it('orders by a unique key too, so pages never overlap on a tie, and reads a row seen twice once', async () => {
    const rows = rowsOf(3)
    respond(url => (url.includes('owner_user_id') ? OWNER_ID : [...rows, rows[0]]))
    expect(await serviceData().fetchAll()).toHaveLength(3)
    expect(calls.find(c => c.url.includes('/rest/v1/posts'))?.url).toContain('order=updated_at.desc,id.asc')
  })

  it('filters by kind with in.() — the generated column reads a legacy row as a task', async () => {
    servePages([])
    await serviceData().fetchAll({ kinds: ['task', 'project'] })
    expect(calls.find(c => c.url.includes('/rest/v1/posts'))?.url).toContain('kind=in.(task,project)')
  })
})

describe('validators', () => {
  it('assertDayKey accepts real days and refuses impossible or malformed ones', () => {
    expect(assertDayKey('2026-09-08')).toBe('2026-09-08')
    expect(() => assertDayKey('2026-02-30')).toThrow(/not a real calendar date/)
    expect(() => assertDayKey('8 Sep 2026')).toThrow(/YYYY-MM-DD/)
    expect(() => assertDayKey(undefined)).toThrow(/YYYY-MM-DD/)
  })

  it('resolveContext validates people and resolves a place by id or by name', () => {
    const all = [
      { kind: 'person', id: 'mum', name: 'Mum' },
      { kind: 'place', id: 'nopi', name: 'Nopi' },
    ]
    expect(resolveContext(all, { peopleIds: ['mum', 'mum'] })).toEqual({ peopleIds: ['mum'] })
    expect(resolveContext(all, { peopleIds: [] })).toEqual({ peopleIds: undefined })
    expect(() => resolveContext(all, { peopleIds: ['dad'] })).toThrow(/No person with id "dad"/)
    expect(resolveContext(all, { placeId: 'nopi' })).toEqual({ placeId: 'nopi' })
    expect(resolveContext(all, { placeName: 'NOPI, Warwick St' })).toEqual({ placeId: 'nopi' })
    expect(() => resolveContext(all, { placeName: 'Franco' })).toThrow(/No saved place matches/)
    expect(() => resolveContext(all, { placeId: 'x' })).toThrow(/No place with id "x"/)
    expect(resolveContext(all, { placeId: '' })).toEqual({ placeId: undefined })
  })
})

describe('tool catalogue', () => {
  it('lists every tool once with a schema whose required fields exist', () => {
    const names = TOOLS.map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(
      expect.arrayContaining([
        'list_projects', 'create_task', 'update_task', 'complete_task', 'list_people', 'list_places', 'create_place', 'log_visit',
        'list_recipes', 'get_week_meals', 'plan_meal', 'get_grocery_list', 'add_grocery_item', 'set_grocery_state',
        'list_journal', 'add_journal_entry', 'get_overview',
      ]),
    )
    for (const t of TOOLS) {
      expect(t.inputSchema.type, t.name).toBe('object')
      for (const req of t.inputSchema.required ?? []) expect(Object.keys(t.inputSchema.properties), `${t.name}.${req}`).toContain(req)
    }
  })

  it('summaries expose the fields the app links on', () => {
    const task = summarizeTask({ id: 't', title: 'Dinner', description: '', status: 'done', tags: ['visit'], peopleIds: ['mum'], placeId: 'nopi', updatedAt: 'x' })
    expect(task).toMatchObject({ peopleIds: ['mum'], placeId: 'nopi', recurrence: null })
    const place = summarizePlace(
      { id: 'nopi', name: 'Nopi', category: 'restaurant', cadenceDays: 30 },
      [{ id: 'v', status: 'done', completedAt: '2026-08-01T12:00:00.000Z', placeId: 'nopi', peopleIds: ['mum'] }],
      [{ id: 'mum', name: 'Mum' }],
    )
    expect(place.outingsAllTime).toBe(1)
    expect(place.usuallyWith[0]).toMatchObject({ personId: 'mum', name: 'Mum', count: 1 })
  })
})

// ---------------------------------------------------------------------------
// Personal kinds. The service key bypasses every policy, so the local mode
// must keep a household peer's journal, review, calendar, habit and routine
// rows away from every tool — their content, and even their kind.
// ---------------------------------------------------------------------------

const OWNER = 'owner-1'
const PEER = 'peer-2'
/** Written into every personal row of the peer's; no tool output may contain it. */
const SECRET = 'PEER-PRIVATE'
const STAMP = '2026-09-08T09:00:00.000Z'
const DAY = '2026-09-08'

type Row = { user_id: string | null; data: Record<string, any> }

/** The owner's home, a peer's shared chore, and one row of every personal kind of the peer's. */
function household(): Row[] {
  const today = localDayKey()
  const week = weekKeyOf(DAY)!
  const at = (user_id: string | null, data: Record<string, any>): Row => ({ user_id, data: { createdAt: STAMP, updatedAt: STAMP, ...data } })
  return [
    at(OWNER, { kind: 'project', id: 'p1', name: 'Kitchen', status: 'active', color: '#f97316' }),
    at(OWNER, { kind: 'task', id: 't1', title: 'Call the electrician', description: '', status: 'todo', priority: 'normal', tags: [], projectId: 'p1' }),
    at(OWNER, { kind: 'person', id: 'mum', name: 'Mum', group: 'family' }),
    at(OWNER, { kind: 'place', id: 'nopi', name: 'Nopi', category: 'restaurant' }),
    at(OWNER, { kind: 'recipe', id: 'pasta', name: 'Pasta', ingredients: [{ name: 'Spaghetti', qty: 500, unit: 'g' }], tags: [] }),
    at(OWNER, { kind: 'meal', id: `meal~${DAY}~dinner`, date: DAY, slot: 'dinner', title: 'Pasta', recipeId: 'pasta' }),
    at(OWNER, { kind: 'grocery', id: groceryId(week), weekKey: week, items: [{ id: 'g1', name: 'Milk', state: 'need', recipeIds: [] }] }),
    at(OWNER, { kind: 'journal', id: `journal~${today}~own`, date: today, body: 'Mine to read' }),
    at(OWNER, { kind: 'habit', id: 'own-habit', name: 'Stretch', done: [today] }),
    at(null, { id: 'legacy-post', title: 'An old social post', body: 'hello', status: 'draft', platforms: ['x'] }),
    // shared with the household: the owner's agent may see a peer's chore
    at(PEER, { kind: 'task', id: 'peer-task', title: 'Peer chore: bins', description: '', status: 'todo', priority: 'normal', tags: [] }),
    // personal: never the owner's agent's to read, not even by id
    at(PEER, { kind: 'habit', id: 'peer-a', name: `${SECRET} habit`, done: [today] }),
    at(PEER, { kind: 'routine', id: 'peer-b', name: `${SECRET} routine`, when: 'morning', steps: [{ id: 's1', text: SECRET }], ticks: [] }),
    at(PEER, { kind: 'review', id: 'peer-c', period: 'week', key: week, top: [`${SECRET} review`] }),
    at(PEER, { kind: 'calendar', id: 'peer-d', name: `${SECRET} calendar`, url: 'https://example.test/peer.ics', color: '#888', enabled: true }),
    at(PEER, { kind: 'journal', id: `journal~${today}~peer`, date: today, body: `${SECRET} journal`, mood: 2 }),
  ]
}

/** The kind filter PostgREST applies: eq. or in.(), a row with no kind reading as a task. */
function kindMatches(filter: string | null, kind: string) {
  if (!filter) return true
  if (filter.startsWith('eq.')) return filter === `eq.${kind}`
  const list = /^in\.\((.*)\)$/.exec(filter)
  if (list) return list[1].split(',').includes(kind)
  throw new Error(`the stub does not filter kind=${filter}`)
}

/**
 * PostgREST over those rows as the service role sees them: every row, whoever
 * owns it — and sync_posts echoing the whole table. Returns what was written.
 */
function serveHousehold(rows: Row[]) {
  const sent: Record<string, any>[] = []
  respond((url, body, headers) => {
    const u = new URL(url)
    if (u.pathname === '/rest/v1/rpc/owner_user_id') return OWNER
    if (u.pathname === '/rest/v1/rpc/sync_posts') {
      const incoming = (body as { incoming: Record<string, any>[] }).incoming
      sent.push(...incoming)
      const stored = new Map(rows.map(r => [r.data.id, { ...r.data, ownerId: r.user_id }]))
      for (const i of incoming) stored.set(i.id, { ...i, ownerId: OWNER })
      return { items: [...stored.values()], rejected: [] }
    }
    if (u.pathname !== '/rest/v1/posts') throw new Error(`the stub does not serve ${url}`)
    const q = u.searchParams
    const cols = (q.get('select') ?? '').split(',')
    for (const c of cols) if (c !== 'data' && c !== 'user_id') throw new Error(`the stub does not select ${c}`)
    const [from, to] = headers.range ? headers.range.split('-').map(Number) : [0, Infinity]
    return rows
      .filter(r => !q.get('id') || q.get('id') === `eq.${r.data.id}`)
      .filter(r => kindMatches(q.get('kind'), r.data.kind ?? 'task'))
      .filter(r => !q.get('user_id') || q.get('user_id') === `eq.${r.user_id}`)
      .filter(r => q.get('deleted') !== 'is.false' || !r.data.deletedAt)
      .slice(from, to + 1)
      .map(r => Object.fromEntries(cols.map(c => [c, c === 'user_id' ? r.user_id : r.data])))
  })
  return sent
}

const tool = (name: string) => {
  const t = TOOLS.find(x => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

/** One call per tool, each of which must succeed against household(). A new tool fails the sweep until it is added. */
const SWEEP: Record<string, Record<string, unknown>> = {
  list_projects: { includeArchived: true },
  create_project: { name: 'Garden' },
  update_project: { id: 'p1', appendNotes: 'Worktop ordered' },
  list_tasks: { limit: 200 },
  get_task: { id: 't1' },
  create_task: { title: 'Buy bulbs', projectId: 'p1', peopleIds: ['mum'], placeName: 'Nopi' },
  update_task: { id: 't1', status: 'done' },
  complete_task: { id: 't1', comment: 'Done' },
  add_comment: { id: 't1', body: 'Quote came in' },
  delete_task: { id: 't1' },
  list_people: {},
  list_places: {},
  create_place: { name: 'Franco' },
  log_visit: { personId: 'mum', placeName: 'Nopi' },
  list_recipes: {},
  get_week_meals: { date: DAY },
  plan_meal: { date: DAY, recipeName: 'Pasta' },
  get_grocery_list: { date: DAY },
  add_grocery_item: { name: 'Eggs', date: DAY },
  set_grocery_state: { name: 'Milk', state: 'done', date: DAY },
  list_journal: { days: 366 },
  add_journal_entry: { text: 'A walk' },
  get_overview: {},
}

describe('personal kinds stay with their owner', () => {
  it('uses the one list in shared/kinds.mjs', () => {
    expect(PERSONAL_KINDS).toBe(SHARED_PERSONAL_KINDS)
  })

  it('agrees with the digest (and so the posts policy) on every kind the app stores', () => {
    for (const kind of KNOWN_KINDS) {
      const peerRow = { user_id: PEER, data: { kind, id: 'x' } }
      const digestSees = visibleItemsFor([peerRow], OWNER, [PEER], OWNER).length === 1
      expect(ownerMaySee(peerRow, OWNER), `a peer's ${kind}`).toBe(digestSees)
      expect(ownerMaySee({ user_id: OWNER, data: { kind, id: 'x' } }, OWNER), `my ${kind}`).toBe(true)
      expect(ownerMaySee({ user_id: null, data: { kind, id: 'x' } }, OWNER), `an unowned ${kind}`).toBe(true)
    }
  })

  it('the bot gateway carries the same personal kinds (an edge function cannot import shared/)', () => {
    const src = readFileSync(fileURLToPath(new URL('../../supabase/functions/bot/index.ts', import.meta.url)), 'utf8')
    const m = /const PERSONAL_KINDS = new Set\(\[([^\]]*)\]\)/.exec(src)
    expect(m, 'PERSONAL_KINDS in supabase/functions/bot/index.ts').not.toBeNull()
    expect([...m![1].matchAll(/'([a-z]+)'/g)].map(x => x[1]).sort()).toEqual([...PERSONAL_KINDS].sort())
  })

  it('fetchAll drops a peer\'s personal rows and keeps everything the household shares', async () => {
    serveHousehold(household())
    const today = localDayKey()
    const ids = (await serviceData().fetchAll()).map(i => i.id)
    expect(ids).toEqual(expect.arrayContaining(['t1', 'own-habit', `journal~${today}~own`, 'legacy-post', 'peer-task']))
    for (const id of ['peer-a', 'peer-b', 'peer-c', 'peer-d', `journal~${today}~peer`]) expect(ids).not.toContain(id)
  })

  it('a peer\'s personal row reads as missing by id, and nothing is written to it', async () => {
    const probes: [string, Record<string, unknown>][] = [
      ['get_task', { id: 'peer-a' }],
      ['update_task', { id: 'peer-b', title: 'mine now' }],
      ['complete_task', { id: 'peer-c' }],
      ['add_comment', { id: 'peer-d', body: 'hello' }],
      ['delete_task', { id: `journal~${localDayKey()}~peer` }],
      ['update_project', { id: 'peer-a', name: 'mine now' }],
    ]
    for (const [name, args] of probes) {
      const sent = serveHousehold(household())
      const error = await tool(name)
        .run(args, ctxFor())
        .then(
          () => null,
          (e: Error) => e.message,
        )
      expect(error, name).toMatch(/^No (task|project) with id "/)
      expect(sent, name).toEqual([])
    }
    // the owner's own habit may still say what it is
    serveHousehold(household())
    await expect(tool('get_task').run({ id: 'own-habit' }, ctxFor())).rejects.toThrow(/is a habit, not a task/)
  })

  it('syncWrite hands back only the rows it wrote, though sync_posts echoes the whole table', async () => {
    serveHousehold(household())
    const stored = await serviceData().syncWrite([{ kind: 'task', id: 'new', title: 'New', updatedAt: STAMP }])
    expect(stored.map(i => i.id)).toEqual(['new'])
  })

  it('no tool returns a peer\'s personal rows, and what the household shares stays visible', async () => {
    expect(Object.keys(SWEEP).sort(), 'add the new tool to SWEEP').toEqual(TOOLS.map(t => t.name).sort())
    for (const t of TOOLS) {
      serveHousehold(household())
      const out = JSON.stringify(await t.run(SWEEP[t.name], ctxFor()))
      expect(out, t.name).not.toContain(SECRET)
    }
    serveHousehold(household())
    expect(await tool('list_tasks').run({ search: 'Peer chore' }, ctxFor())).toMatchObject({ count: 1 })
    serveHousehold(household())
    const added = (await tool('add_journal_entry').run({ text: 'A walk' }, ctxFor())) as { entry: { id: string; body: string } }
    expect(added.entry).toMatchObject({ id: `journal~${localDayKey()}~own`, body: 'Mine to read\nA walk' })
  })

  it('every read names the kinds it needs, so no tool pulls the whole table', async () => {
    for (const t of TOOLS) {
      serveHousehold(household())
      await t.run(SWEEP[t.name], ctxFor())
      const bulk = calls.filter(c => c.url.includes('/rest/v1/posts?') && !c.url.includes('id=eq.') && !c.url.includes('kind='))
      expect(bulk.map(c => c.url), t.name).toEqual([])
      calls.length = 0
    }
  })
})

describe('"today" is the user\'s today', () => {
  const task = { kind: 'task', id: 'call', title: 'Call the bank', description: '', status: 'todo', priority: 'normal', tags: [], dueAt: '2026-09-11T20:00:00.000Z', updatedAt: STAMP }
  // 06:30 UTC on the 12th is 23:30 on the 11th in Los Angeles
  const at = Date.parse('2026-09-12T06:30:00.000Z')
  const overviewIn = async (tz: string, scopes: Scope[]) => {
    respond(url => (url.includes('owner_user_id') ? OWNER : url.includes('kind=eq.journal') ? [] : [{ user_id: OWNER, data: task }]))
    return (await tool('get_overview').run({}, createContext({ db: serviceData(), clock: makeClock(tz, () => at), scopes }))) as Record<string, any>
  }

  it('get_overview buckets by the user\'s zone, not the process\'s', async () => {
    const la = await overviewIn('America/Los_Angeles', ['read'])
    expect(la).toMatchObject({ today: '2026-09-11', timeZone: 'America/Los_Angeles' })
    expect(la.dueToday.map((t: { id: string }) => t.id)).toEqual(['call'])
    expect(la.overdue).toEqual([])
    const utc = await overviewIn('UTC', ['read'])
    expect(utc.today).toBe('2026-09-12')
    expect(utc.overdue.map((t: { id: string }) => t.id)).toEqual(['call'])
  })

  it('without journal access get_overview neither reads the journal nor says whether today has an entry', async () => {
    const out = await overviewIn('UTC', ['read', 'write'])
    expect(out.journal).toBeNull()
    expect(calls.some(c => c.url.includes('kind=eq.journal'))).toBe(false)
    const withJournal = await overviewIn('UTC', ['read', 'journal'])
    expect(withJournal.journal).toEqual({ writtenToday: false, streak: 0 })
  })

  it('get_week_meals defaults to the user\'s week', async () => {
    respond(url => (url.includes('owner_user_id') ? OWNER : []))
    const out = (await tool('get_week_meals').run({}, createContext({ db: serviceData(), clock: makeClock('America/Los_Angeles', () => at) }))) as { days: string[] }
    expect(out.days).toContain('2026-09-11')
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { visibleItemsFor } from '../../shared/digest.mjs'
import { localDayKey } from '../../shared/journal.mjs'
import { groceryId } from '../../shared/kitchen.mjs'
import { weekKeyOf } from '../../shared/weeks.mjs'
import { KNOWN_KINDS } from '../schema'

// The MCP server talks to Supabase over fetch; here fetch is a stub, so these
// tests pin the write path's contract with sync_posts ({ items, rejected })
// and the pure validators, with no database and no stdio transport.

type Server = typeof import('../../mcp/server.mjs')
let server: Server

const RPC = 'https://db.example.test/rest/v1/rpc/sync_posts'
const calls: { url: string; body?: unknown }[] = []

function respond(handler: (url: string, body: unknown) => unknown) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    const out = handler(url, body)
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

beforeAll(async () => {
  process.env.SUPABASE_URL = 'https://db.example.test'
  process.env.SUPABASE_SERVICE_KEY = 'service-key'
  server = await import('../../mcp/server.mjs')
})

afterEach(() => {
  calls.length = 0
  vi.restoreAllMocks()
})

describe('syncWrite against the sync_posts contract', () => {
  it('unwraps { items, rejected } and returns the normalized list', async () => {
    respond(url => (url === RPC ? { items: [{ kind: 'task', id: 'a', title: 'A', updatedAt: '2026-09-08T10:00:00.000Z' }], rejected: [] } : []))
    const all = await server.syncWrite([{ kind: 'task', id: 'a', title: 'A', updatedAt: '2026-09-08T10:00:00.000Z' }])
    expect(all.map(i => i.id)).toEqual(['a'])
  })

  it('still accepts the legacy bare-array shape', async () => {
    respond(() => [{ kind: 'task', id: 'a', title: 'A', updatedAt: '2026-09-08T10:00:00.000Z' }])
    const all = await server.syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])
    expect(all).toHaveLength(1)
  })

  it('throws when the server rejected one of the ids it was sent', async () => {
    respond(() => ({ items: [], rejected: ['a'] }))
    await expect(server.syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])).rejects.toThrow(/refused to store a/)
  })

  it('writeItem throws when the stored copy carries a different stamp (lost the merge)', async () => {
    respond(() => ({ items: [{ kind: 'task', id: 'a', updatedAt: '2026-09-08T12:00:00.000Z' }], rejected: [] }))
    await expect(server.writeItem({ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' })).rejects.toThrow(/last-write-wins/)
  })

  it('writeItem returns the stored copy when the stamps match', async () => {
    respond(() => ({ items: [{ kind: 'task', id: 'a', title: 'stored', updatedAt: '2026-09-08T10:00:00.000Z' }], rejected: [] }))
    const stored = await server.writeItem({ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' })
    expect(stored.title).toBe('stored')
    expect(calls[0].url).toBe(RPC)
    expect((calls[0].body as { incoming: unknown[] }).incoming).toHaveLength(1)
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
    const journal = await server.fetchJournal()
    expect(journal.map(e => e.id).sort()).toEqual(['j0', 'j1'])
  })
})

describe('validators', () => {
  it('assertDayKey accepts real days and refuses impossible or malformed ones', () => {
    expect(server.assertDayKey('2026-09-08')).toBe('2026-09-08')
    expect(() => server.assertDayKey('2026-02-30')).toThrow(/not a real calendar date/)
    expect(() => server.assertDayKey('8 Sep 2026')).toThrow(/YYYY-MM-DD/)
    expect(() => server.assertDayKey(undefined)).toThrow(/YYYY-MM-DD/)
  })

  it('resolveContext validates people and resolves a place by id or by name', () => {
    const all = [
      { kind: 'person', id: 'mum', name: 'Mum' },
      { kind: 'place', id: 'nopi', name: 'Nopi' },
    ]
    expect(server.resolveContext(all, { peopleIds: ['mum', 'mum'] })).toEqual({ peopleIds: ['mum'] })
    expect(server.resolveContext(all, { peopleIds: [] })).toEqual({ peopleIds: undefined })
    expect(() => server.resolveContext(all, { peopleIds: ['dad'] })).toThrow(/No person with id "dad"/)
    expect(server.resolveContext(all, { placeId: 'nopi' })).toEqual({ placeId: 'nopi' })
    expect(server.resolveContext(all, { placeName: 'NOPI, Warwick St' })).toEqual({ placeId: 'nopi' })
    expect(() => server.resolveContext(all, { placeName: 'Franco' })).toThrow(/No saved place matches/)
    expect(() => server.resolveContext(all, { placeId: 'x' })).toThrow(/No place with id "x"/)
    expect(server.resolveContext(all, { placeId: '' })).toEqual({ placeId: undefined })
  })
})

describe('tool catalogue', () => {
  it('lists every tool once with a schema whose required fields exist', () => {
    const names = server.TOOLS.map((t: { name: string }) => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(
      expect.arrayContaining([
        'list_projects', 'create_task', 'update_task', 'complete_task', 'list_people', 'list_places', 'create_place', 'log_visit',
        'list_recipes', 'get_week_meals', 'plan_meal', 'get_grocery_list', 'add_grocery_item', 'set_grocery_state',
        'list_journal', 'add_journal_entry', 'get_overview',
      ]),
    )
    for (const t of server.TOOLS as { name: string; inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] } }[]) {
      expect(t.inputSchema.type, t.name).toBe('object')
      for (const req of t.inputSchema.required ?? []) expect(Object.keys(t.inputSchema.properties), `${t.name}.${req}`).toContain(req)
    }
  })

  it('summaries expose the fields the app links on', () => {
    const task = server.summarizeTask({ id: 't', title: 'Dinner', description: '', status: 'done', tags: ['visit'], peopleIds: ['mum'], placeId: 'nopi', updatedAt: 'x' })
    expect(task).toMatchObject({ peopleIds: ['mum'], placeId: 'nopi', recurrence: null })
    const place = server.summarizePlace(
      { id: 'nopi', name: 'Nopi', category: 'restaurant', cadenceDays: 30 },
      [{ id: 'v', status: 'done', completedAt: '2026-08-01T12:00:00.000Z', placeId: 'nopi', peopleIds: ['mum'] }],
      [{ id: 'mum', name: 'Mum' }],
    )
    expect(place.outingsAllTime).toBe(1)
    expect(place.usuallyWith[0]).toMatchObject({ personId: 'mum', name: 'Mum', count: 1 })
  })
})

// ---------------------------------------------------------------------------
// Personal kinds. The service key bypasses every policy, so the server itself
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
  const at =(user_id: string | null, data: Record<string, any>): Row => ({ user_id, data: { createdAt: STAMP, updatedAt: STAMP, ...data } })
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

/**
 * PostgREST over those rows as the service role sees them: every row, whoever
 * owns it — and sync_posts echoing the whole table. Returns what was written.
 */
function serveHousehold(rows: Row[]) {
  const sent: Record<string, any>[] = []
  respond((url, body) => {
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
    return rows
      .filter(r => !q.get('id') || q.get('id') === `eq.${r.data.id}`)
      .filter(r => !q.get('kind') || q.get('kind') === `eq.${r.data.kind ?? 'task'}`)
      .filter(r => q.get('deleted') !== 'is.false' || !r.data.deletedAt)
      .map(r => Object.fromEntries(cols.map(c => [c, c === 'user_id' ? r.user_id : r.data])))
  })
  return sent
}

const tool = (name: string) => {
  const t = server.TOOLS.find(x => x.name === name)
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
  it('agrees with the digest (and so the posts policy) on every kind the app stores', () => {
    for (const kind of KNOWN_KINDS) {
      const peerRow = { user_id: PEER, data: { kind, id: 'x' } }
      const digestSees = visibleItemsFor([peerRow], OWNER, [PEER], OWNER).length === 1
      expect(server.ownerMaySee(peerRow, OWNER), `a peer's ${kind}`).toBe(digestSees)
      expect(server.ownerMaySee({ user_id: OWNER, data: { kind, id: 'x' } }, OWNER), `my ${kind}`).toBe(true)
      expect(server.ownerMaySee({ user_id: null, data: { kind, id: 'x' } }, OWNER), `an unowned ${kind}`).toBe(true)
    }
  })

  it('the bot gateway carries the same personal kinds (an edge function cannot import shared/)', () => {
    const src = readFileSync(fileURLToPath(new URL('../../supabase/functions/bot/index.ts', import.meta.url)), 'utf8')
    const m = /const PERSONAL_KINDS = new Set\(\[([^\]]*)\]\)/.exec(src)
    expect(m, 'PERSONAL_KINDS in supabase/functions/bot/index.ts').not.toBeNull()
    expect([...m![1].matchAll(/'([a-z]+)'/g)].map(x => x[1]).sort()).toEqual([...server.PERSONAL_KINDS].sort())
  })

  it('fetchAll drops a peer\'s personal rows and keeps everything the household shares', async () => {
    serveHousehold(household())
    const today = localDayKey()
    const ids = (await server.fetchAll()).map(i => i.id)
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
      const error = await tool(name).run(args).then(
        () => null,
        (e: Error) => e.message,
      )
      expect(error, name).toMatch(/^No (task|project) with id "/)
      expect(sent, name).toEqual([])
    }
    // the owner's own habit may still say what it is
    serveHousehold(household())
    await expect(tool('get_task').run({ id: 'own-habit' })).rejects.toThrow(/is a habit, not a task/)
  })

  it('syncWrite hands back only the rows it wrote, though sync_posts echoes the whole table', async () => {
    serveHousehold(household())
    const stored = await server.syncWrite([{ kind: 'task', id: 'new', title: 'New', updatedAt: STAMP }])
    expect(stored.map(i => i.id)).toEqual(['new'])
  })

  it('no tool returns a peer\'s personal rows, and what the household shares stays visible', async () => {
    expect(Object.keys(SWEEP).sort(), 'add the new tool to SWEEP').toEqual(server.TOOLS.map(t => t.name).sort())
    for (const t of server.TOOLS) {
      serveHousehold(household())
      const out = JSON.stringify(await t.run(SWEEP[t.name]))
      expect(out, t.name).not.toContain(SECRET)
    }
    serveHousehold(household())
    expect(await tool('list_tasks').run({ search: 'Peer chore' })).toMatchObject({ count: 1 })
    serveHousehold(household())
    const added = (await tool('add_journal_entry').run({ text: 'A walk' })) as { entry: { id: string; body: string } }
    expect(added.entry).toMatchObject({ id: `journal~${localDayKey()}~own`, body: 'Mine to read\nA walk' })
  })
})

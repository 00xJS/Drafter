import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { visibleItemsFor } from '../../shared/digest.mjs'
import { localDayKey, shiftDayKey } from '../../shared/journal.mjs'
import { groceryId } from '../../shared/kitchen.mjs'
import { weekKeyOf } from '../../shared/weeks.mjs'
import { PERSONAL_KINDS as SHARED_PERSONAL_KINDS } from '../../shared/kinds.mjs'
import { makeClock } from '../../shared/clock.mjs'
import { PAGE_SIZE, PERSONAL_KINDS, SINCE_WINDOW_MS, createRestData, ownerMaySee } from '../../mcp/data.mjs'
import { MAX_FOCUS, TOOLS, assertDayKey, createContext, noteText, resolveContext, summarizeMeal, summarizePlace, summarizeTask, textToNoteHtml } from '../../mcp/tools.mjs'
import type { Scope } from '../../mcp/tools.mjs'
import { MAX_FOCUS as APP_MAX_FOCUS } from '../focus'
import { KNOWN_KINDS } from '../schema'
import { PLACE_CATEGORIES, PLACE_CATEGORY_META } from '../types'

// The MCP tools reach Supabase through mcp/data.mjs over fetch; here fetch is
// a stub, so these tests pin the data layer's contract with PostgREST and
// sync_posts ({ items, rejected, stale, gone }), its one view (the user's own
// JWT, with a peer's personal rows filtered out again), and the tools'
// privacy — with no database and no transport.

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

/** Whose rows the stubs below hold: the owner of the home, and a household peer. */
const OWNER = 'owner-1'
const PEER = 'peer-2'

/**
 * The owner's view, as the hosted endpoint builds it: their own JWT. Most
 * stubs here answer as the database would the service role — every row — so
 * the data layer's own second filter is what these tests hold to account.
 */
const ownerData = () => createRestData({ baseUrl: BASE, userId: OWNER, auth: async () => ({ apikey: 'anon-key', bearer: 'jwt-of-the-owner' }) })
const ALL_SCOPES: Scope[] = ['read', 'write', 'journal']
const ctxFor = (scopes: Scope[] = ALL_SCOPES) => createContext({ db: ownerData(), clock: makeClock(), scopes, userId: OWNER })

afterEach(() => {
  calls.length = 0
  vi.restoreAllMocks()
})

describe('syncWrite against the sync_posts contract', () => {
  it('unwraps { items, rejected } and returns the normalized list', async () => {
    respond(url => (url === RPC ? { items: [{ kind: 'task', id: 'a', title: 'A', updatedAt: '2026-09-08T10:00:00.000Z' }], rejected: [] } : []))
    const all = await ownerData().syncWrite([{ kind: 'task', id: 'a', title: 'A', updatedAt: '2026-09-08T10:00:00.000Z' }])
    expect(all.map(i => i.id)).toEqual(['a'])
  })

  it('still accepts the legacy bare-array shape', async () => {
    respond(() => [{ kind: 'task', id: 'a', title: 'A', updatedAt: '2026-09-08T10:00:00.000Z' }])
    const all = await ownerData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])
    expect(all).toHaveLength(1)
  })

  it('throws when the server rejected one of the ids it was sent', async () => {
    respond(() => ({ items: [], rejected: ['a'] }))
    await expect(ownerData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])).rejects.toThrow(/refused to store a/)
  })

  it('writeItem throws when the stored copy carries a different stamp (lost the merge)', async () => {
    respond(() => ({ items: [{ kind: 'task', id: 'a', updatedAt: '2026-09-08T12:00:00.000Z' }], rejected: [] }))
    await expect(ownerData().writeItem({ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' })).rejects.toThrow(/last-write-wins/)
  })

  it('writeItem returns the stored copy when the stamps match', async () => {
    respond(() => ({ items: [{ kind: 'task', id: 'a', title: 'stored', updatedAt: '2026-09-08T10:00:00.000Z' }], rejected: [] }))
    const stored = await ownerData().writeItem({ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' })
    expect(stored.title).toBe('stored')
    expect(calls[0].url).toBe(RPC)
    expect((calls[0].body as { incoming: unknown[] }).incoming).toHaveLength(1)
  })

  it('sends a since cursor ten minutes back, so the echo is recent rows and never the whole table', async () => {
    respond(() => ({ items: [{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }], rejected: [] }))
    const before = Date.now()
    await ownerData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])
    const since = Date.parse(calls[0].body.since)
    expect(since).toBeGreaterThanOrEqual(before - SINCE_WINDOW_MS - 1000)
    expect(since).toBeLessThanOrEqual(Date.now() - SINCE_WINDOW_MS + 1000)
  })

  it('confirms an id missing from the echo with one read, and calls it lost only when the read finds nothing', async () => {
    respond(url => (url === RPC ? { items: [], rejected: [], stale: [], gone: [] } : [{ data: { kind: 'task', id: 'a', title: 'kept', updatedAt: '2026-09-08T10:00:00.000Z' } }]))
    const [kept] = await ownerData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])
    expect(kept.title).toBe('kept')
    expect(calls.map(c => c.url)).toEqual([RPC, `${BASE}/rest/v1/posts?id=eq.a&select=data`])

    respond(url => (url === RPC ? { items: [], rejected: [] } : []))
    await expect(ownerData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])).rejects.toThrow(/did not keep a/)
  })

  it('a stale id is a failed write, and a gone id a record deleted for good', async () => {
    respond(() => ({ items: [{ kind: 'task', id: 'a', updatedAt: '2026-09-09T10:00:00.000Z' }], rejected: [], stale: ['a'], gone: [] }))
    await expect(ownerData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])).rejects.toThrow(/A newer edit to that record won — re-read it and try again/)
    respond(() => ({ items: [], rejected: [], stale: [], gone: ['a'] }))
    await expect(ownerData().syncWrite([{ kind: 'task', id: 'a', updatedAt: '2026-09-08T10:00:00.000Z' }])).rejects.toThrow(/That record was deleted for good/)
  })
})

describe('fetchJournal reads only the user', () => {
  it('asks for their own entries, and drops a household peer\'s even when the database hands them over', async () => {
    respond(url =>
      url.includes('kind=eq.journal')
        ? [
            { user_id: OWNER, data: { kind: 'journal', id: 'j1', date: '2026-09-08', body: 'mine' } },
            { user_id: PEER, data: { kind: 'journal', id: 'j2', date: '2026-09-08', body: 'theirs' } },
          ]
        : [],
    )
    const journal = await ownerData().fetchJournal()
    expect(journal.map(e => e.id)).toEqual(['j1'])
    expect(calls[0].url).toContain(`user_id=eq.${OWNER}`)
    // the view is the user's own: nothing asks whose the site is
    expect(calls.some(c => c.url.includes('owner_user_id'))).toBe(false)
  })

  it('needs the user it reads as', () => {
    expect(() => createRestData({ baseUrl: BASE, userId: '', auth: async () => ({ apikey: 'anon-key', bearer: 'x' }) })).toThrow(/needs their id/)
  })
})

describe('user mode: the hosted endpoint reads as the user', () => {
  const USER = '00000000-0000-0000-0000-00000000000b'
  const userData = (onUnauthorized: (() => void) | null = null) =>
    createRestData({ baseUrl: BASE, userId: USER, auth: async () => ({ apikey: 'anon-key', bearer: 'jwt-of-the-user' }), onUnauthorized })

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
    const all = await ownerData().fetchAll({ kinds: ['task'] })
    expect(all).toHaveLength(PAGE_SIZE + 5)
    const reads = calls.filter(c => c.url.includes('/rest/v1/posts'))
    expect(reads.map(c => c.headers.range)).toEqual(['0-999', '1000-1999'])
    expect(reads.every(c => c.headers['range-unit'] === 'items')).toBe(true)
  })

  it('a table of exactly one page reads the next, empty page rather than assume', async () => {
    servePages(rowsOf(PAGE_SIZE))
    expect(await ownerData().fetchAll()).toHaveLength(PAGE_SIZE)
    expect(calls.filter(c => c.url.includes('/rest/v1/posts')).map(c => c.headers.range)).toEqual(['0-999', '1000-1999'])
  })

  it('orders by a unique key too, so pages never overlap on a tie, and reads a row seen twice once', async () => {
    const rows = rowsOf(3)
    respond(url => (url.includes('owner_user_id') ? OWNER_ID : [...rows, rows[0]]))
    expect(await ownerData().fetchAll()).toHaveLength(3)
    expect(calls.find(c => c.url.includes('/rest/v1/posts'))?.url).toContain('order=updated_at.desc,id.asc')
  })

  it('filters by kind with in.() — the generated column reads a legacy row as a task', async () => {
    servePages([])
    await ownerData().fetchAll({ kinds: ['task', 'project'] })
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
        'list_journal', 'add_journal_entry', 'get_overview', 'list_notes', 'get_note', 'create_note', 'update_note', 'get_week_plan_proposal',
        'update_project', 'list_garments', 'list_outfits', 'get_wardrobe_stats', 'log_outfit',
      ]),
    )
    // one ongoing project: an assistant edits it and never starts another
    expect(names).not.toContain('create_project')
    expect(TOOLS).toHaveLength(31)
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
// Personal kinds. The database's policies keep a household peer's journal,
// review, calendar, habit, routine and wardrobe rows from the user, and the
// data layer applies the same rule again, so a mistake in a policy could only
// narrow an answer. The stub below hands over every row, as the service role
// would, so that second rule is what keeps them away from every tool — their
// content, and even their kind.
// ---------------------------------------------------------------------------

/** Written into every personal row of the peer's; no tool output may contain it. */
const SECRET = 'PEER-PRIVATE'
const STAMP = '2026-09-08T09:00:00.000Z'
const DAY = '2026-09-08'

type Row = { user_id: string | null; data: Record<string, any> }

/** The owner's home, a peer's shared chore, and one row of every personal kind of the peer's. */
function household(): Row[] {
  const today = localDayKey()
  const week = weekKeyOf(DAY)!
  /** When most of the wardrobe was added: a month ago, at noon, so no zone moves the day. */
  const added = `${shiftDayKey(today, -30)}T12:00:00.000Z`
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
    at(OWNER, {
      kind: 'note',
      id: 'n1',
      title: 'Garden ideas',
      body: '<p>Raised beds &amp; a <strong>pond</strong></p><ul class="checklist"><li><input type="checkbox" checked> Measure</li></ul>',
      projectId: 'p1',
    }),
    // the owner's wardrobe: personal like the journal, and its photos never leave Drafter
    at(OWNER, {
      kind: 'garment',
      id: 'tee',
      name: 'Navy tee',
      type: 'top',
      color: '#1e2848',
      photoId: 'photo-of-tee',
      thumbId: 'thumb-of-tee',
      // its back, with the logo, and shown first: still no photo leaves
      backPhotoId: 'back-photo-of-tee',
      backThumbId: 'back-thumb-of-tee',
      showBack: true,
      occasion: 'work',
      createdAt: added,
    }),
    at(OWNER, { kind: 'garment', id: 'jeans', name: 'Blue jeans', type: 'bottom', createdAt: added }),
    at(OWNER, { kind: 'garment', id: 'dress', name: 'Green dress', type: 'onepiece', occasion: 'personal', createdAt: added }),
    at(OWNER, { kind: 'garment', id: 'band', name: 'Old band tee', type: 'top', archivedAt: STAMP, createdAt: added }),
    at(OWNER, { kind: 'garment', id: 'scarf', name: 'Wool scarf', type: 'accessory', archivedAt: STAMP, createdAt: added }),
    at(OWNER, { kind: 'garment', id: 'linen', name: 'Linen shirt', type: 'top', createdAt: added }),
    at(OWNER, { kind: 'garment', id: 'trainers', name: 'New trainers', type: 'shoes', createdAt: new Date().toISOString() }),
    at(OWNER, { kind: 'garment', id: 'torn', name: 'Torn hoodie', type: 'top', deletedAt: STAMP, createdAt: added }),
    at(OWNER, { kind: 'outfit', id: 'weekday', name: 'Weekday', garmentIds: ['tee', 'jeans'] }),
    at(OWNER, { kind: 'outfit', id: 'old-fav', garmentIds: ['band', 'jeans'] }),
    at(OWNER, { kind: 'wear', id: `wear~${shiftDayKey(today, -3)}~look000003`, date: shiftDayKey(today, -3), garmentIds: ['tee', 'jeans'] }),
    at(OWNER, { kind: 'wear', id: `wear~${shiftDayKey(today, -70)}~look000070`, date: shiftDayKey(today, -70), garmentIds: ['dress'] }),
    at(null, { id: 'legacy-post', title: 'An old social post', body: 'hello', status: 'draft', platforms: ['x'] }),
    // shared with the household: the owner's agent may see a peer's chore
    at(PEER, { kind: 'task', id: 'peer-task', title: 'Peer chore: bins', description: '', status: 'todo', priority: 'normal', tags: [] }),
    // notes are shared too, like tasks
    at(PEER, { kind: 'note', id: 'peer-note', title: 'Holiday list', body: '<p>Shared with the household</p>', pinned: true }),
    // personal: never the owner's agent's to read, not even by id
    at(PEER, { kind: 'habit', id: 'peer-a', name: `${SECRET} habit`, done: [today] }),
    at(PEER, { kind: 'routine', id: 'peer-b', name: `${SECRET} routine`, when: 'morning', steps: [{ id: 's1', text: SECRET }], ticks: [] }),
    at(PEER, { kind: 'review', id: 'peer-c', period: 'week', key: week, top: [`${SECRET} review`] }),
    at(PEER, { kind: 'calendar', id: 'peer-d', name: `${SECRET} calendar`, url: 'https://example.test/peer.ics', color: '#888', enabled: true }),
    at(PEER, { kind: 'journal', id: `journal~${today}~peer`, date: today, body: `${SECRET} journal`, mood: 2 }),
    at(PEER, { kind: 'garment', id: 'peer-g', name: `${SECRET} shirt`, type: 'top' }),
    at(PEER, { kind: 'outfit', id: 'peer-o', name: `${SECRET} outfit`, garmentIds: ['peer-g'] }),
    // a look has no text of its own, so the marker rides in its piece ids
    at(PEER, { kind: 'wear', id: `wear~${today}~peer000001`, date: today, garmentIds: ['peer-g', `${SECRET}-scarf`] }),
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
  list_notes: { search: 'garden' },
  get_note: { id: 'n1' },
  create_note: { title: 'Paint colours', text: 'Sage\n\n- [ ] Buy samples', projectId: 'p1' },
  update_note: { id: 'n1', appendText: 'Ask about liners' },
  get_week_plan_proposal: {},
  list_garments: {},
  list_outfits: {},
  get_wardrobe_stats: { window: 'all' },
  log_outfit: { garmentIds: ['tee', 'jeans'] },
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
    const ids = (await ownerData().fetchAll()).map(i => i.id)
    expect(ids).toEqual(expect.arrayContaining(['t1', 'own-habit', `journal~${today}~own`, 'legacy-post', 'peer-task']))
    for (const id of ['peer-a', 'peer-b', 'peer-c', 'peer-d', `journal~${today}~peer`, 'peer-g', 'peer-o', `wear~${today}~peer000001`]) expect(ids).not.toContain(id)
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
    const stored = await ownerData().syncWrite([{ kind: 'task', id: 'new', title: 'New', updatedAt: STAMP }])
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

describe('grocery lines taken off the list', () => {
  /** household() with Spaghetti (the pasta's) taken off the list and a hand-added Milk still on it. */
  const withRemoved = (): Row[] => {
    const rows = household()
    rows.find(r => r.data.kind === 'grocery')!.data.items = [
      { id: 'g1', name: 'Milk', state: 'need', recipeIds: [], manual: true },
      { id: 'g2', name: 'Spaghetti', qty: 500, unit: 'g', state: 'need', recipeIds: ['pasta'], removed: true, removedRecipeIds: ['pasta'] },
    ]
    return rows
  }
  type Line = { id: string; name: string; state: string; qty?: number; unit?: string; removed?: boolean; removedRecipeIds?: string[] }

  it('get_grocery_list and get_week_meals leave them out', async () => {
    serveHousehold(withRemoved())
    const list = (await tool('get_grocery_list').run({ date: DAY }, ctxFor())) as { count: number; items: Line[] }
    expect(list.items.map(i => i.name)).toEqual(['Milk'])
    expect(list.count).toBe(1)
    serveHousehold(withRemoved())
    const need = (await tool('get_grocery_list').run({ date: DAY, state: 'need' }, ctxFor())) as { items: Line[] }
    expect(need.items.map(i => i.name)).toEqual(['Milk'])
    serveHousehold(withRemoved())
    const week = (await tool('get_week_meals').run({ date: DAY }, ctxFor())) as { grocery: { items: Line[] } }
    expect(week.grocery.items.map(i => i.name)).toEqual(['Milk'])
  })

  it('add_grocery_item restores a removed line instead of adding a second one', async () => {
    const sent = serveHousehold(withRemoved())
    const out = await tool('add_grocery_item').run({ name: 'spaghetti', date: DAY }, ctxFor())
    expect(out).toMatchObject({ added: 'restored a line that had been taken off the list', count: 2 })
    const items = sent[0].items as Line[]
    expect(items.filter(i => i.name.toLowerCase() === 'spaghetti')).toHaveLength(1)
    const back = items.find(i => i.name === 'Spaghetti')!
    expect(back).toMatchObject({ id: 'g2', state: 'need', qty: 500, unit: 'g' })
    expect(back.removed).toBeUndefined()
    expect(back.removedRecipeIds).toBeUndefined()
  })

  it('plan_meal keeps a removed line off the list while the same recipe is planned', async () => {
    const sent = serveHousehold(withRemoved())
    const out = (await tool('plan_meal').run({ date: DAY, recipeName: 'Pasta' }, ctxFor())) as { groceryItems: number }
    expect(out.groceryItems).toBe(1)
    const grocery = sent.find(i => i.kind === 'grocery')!
    expect((grocery.items as Line[]).find(i => i.name === 'Spaghetti')).toMatchObject({ id: 'g2', removed: true, removedRecipeIds: ['pasta'] })
  })

  it('set_grocery_state will not tick a removed line, and says how to bring it back', async () => {
    const sent = serveHousehold(withRemoved())
    await expect(tool('set_grocery_state').run({ name: 'Spaghetti', state: 'done', date: DAY }, ctxFor())).rejects.toThrow(
      /"Spaghetti" was taken off this week's list\. add_grocery_item puts it back/,
    )
    await expect(tool('set_grocery_state').run({ id: 'g2', state: 'have', date: DAY }, ctxFor())).rejects.toThrow(/taken off/)
    expect(sent).toEqual([])
  })
})

describe('"today" is the user\'s today', () => {
  const task = { kind: 'task', id: 'call', title: 'Call the bank', description: '', status: 'todo', priority: 'normal', tags: [], dueAt: '2026-09-11T20:00:00.000Z', updatedAt: STAMP }
  // 06:30 UTC on the 12th is 23:30 on the 11th in Los Angeles
  const at = Date.parse('2026-09-12T06:30:00.000Z')
  const overviewIn = async (tz: string, scopes: Scope[]) => {
    respond(url => (url.includes('owner_user_id') ? OWNER : url.includes('kind=eq.journal') ? [] : [{ user_id: OWNER, data: task }]))
    return (await tool('get_overview').run({}, createContext({ db: ownerData(), clock: makeClock(tz, () => at), scopes }))) as Record<string, any>
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
    const out = (await tool('get_week_meals').run({}, createContext({ db: ownerData(), clock: makeClock('America/Los_Angeles', () => at) }))) as { days: string[] }
    expect(out.days).toContain('2026-09-11')
  })
})

describe('notes as plain text', () => {
  it('writes the app\'s note HTML and reads it back as the same text', () => {
    const text = 'Sage for the hall\nand the landing\n\n- rollers\n- tape\n\n- [ ] Buy samples\n- [x] Measure'
    const html = textToNoteHtml(text)
    expect(html).toBe(
      '<p>Sage for the hall<br>and the landing</p><ul><li>rollers</li><li>tape</li></ul>' +
        '<ul class="checklist"><li><input type="checkbox"> Buy samples</li><li><input type="checkbox" checked> Measure</li></ul>',
    )
    expect(noteText(html)).toBe(text)
  })

  it('escapes what it writes, decodes what it reads, and reads a photo as [photo]', () => {
    expect(textToNoteHtml('<script>&')).toBe('<p>&lt;script&gt;&amp;</p>')
    expect(textToNoteHtml('  \n\n ')).toBe('')
    expect(noteText('<p>Fish &amp; chips&nbsp;<img data-media="m1" alt=""> <a href="https://x.test">menu</a></p>')).toBe('Fish & chips [photo] menu')
  })
})

describe('notes, focus and the week plan over MCP', () => {
  it('create_note stores the app\'s shape, and never a blank note', async () => {
    const sent = serveHousehold(household())
    const out = (await tool('create_note').run({ text: 'Just a thought' }, ctxFor())) as { created: Record<string, unknown> }
    expect(out.created).toMatchObject({ title: 'Untitled note', excerpt: 'Just a thought', pinned: false, projectId: null })
    expect(sent[0]).toMatchObject({ kind: 'note', title: 'Untitled note', body: '<p>Just a thought</p>' })
    expect('pinned' in sent[0]).toBe(false)
    await expect(tool('create_note').run({ title: '  ', text: '\n' }, ctxFor())).rejects.toThrow(/blank note/)
    await expect(tool('create_note').run({ title: 'Plans', projectId: 'nope' }, ctxFor())).rejects.toThrow(/No project with id "nope"/)
  })

  it('update_note appends and keeps what is there, and will not replace a note with photos', async () => {
    let sent = serveHousehold(household())
    await tool('update_note').run({ id: 'n1', appendText: 'Ask about liners' }, ctxFor())
    expect(sent[0].body).toBe('<p>Raised beds &amp; a <strong>pond</strong></p><ul class="checklist"><li><input type="checkbox" checked> Measure</li></ul><p>Ask about liners</p>')
    const withPhoto = household().map(r => (r.data.id === 'n1' ? { ...r, data: { ...r.data, body: `${r.data.body}<p><img data-media="m1"></p>` } } : r))
    sent = serveHousehold(withPhoto)
    await expect(tool('update_note').run({ id: 'n1', text: 'Start again' }, ctxFor())).rejects.toThrow(/has photos/)
    await expect(tool('update_note').run({ id: 'n1', title: '', text: '' }, ctxFor())).rejects.toThrow(/has photos/)
    sent = serveHousehold(household())
    await expect(tool('update_note').run({ id: 'n1', title: '', text: '' }, ctxFor())).rejects.toThrow(/blank/)
    await expect(tool('update_note').run({ id: 't1', title: 'Not a note' }, ctxFor())).rejects.toThrow(/is a task, not a note/)
    expect(sent).toEqual([])
  })

  it('get_note and list_notes read plain text, pinned first, and the household\'s notes are shared', async () => {
    serveHousehold(household())
    expect(await tool('get_note').run({ id: 'n1' }, ctxFor())).toMatchObject({ title: 'Garden ideas', text: 'Raised beds & a pond\n\n- [x] Measure', photos: 0, projectId: 'p1' })
    serveHousehold(household())
    const found = (await tool('list_notes').run({ search: 'POND measure' }, ctxFor())) as { notes: { id: string }[] }
    expect(found.notes.map(n => n.id)).toEqual(['n1'])
    serveHousehold(household())
    expect(await tool('list_notes').run({ search: 'pond salmon' }, ctxFor())).toMatchObject({ count: 0 })
    serveHousehold(household())
    const all = (await tool('list_notes').run({}, ctxFor())) as { notes: { id: string }[] }
    expect(all.notes.map(n => n.id)).toEqual(['peer-note', 'n1'])
  })

  it('update_task focus puts a task in today\'s focus, three open at most, and takes only today\'s out', async () => {
    expect(MAX_FOCUS).toBe(APP_MAX_FOCUS)
    const today = makeClock().todayKey()
    const task = (id: string, extra: Record<string, unknown>): Row => ({
      user_id: OWNER,
      data: { kind: 'task', id, title: id.toUpperCase(), description: '', status: 'todo', priority: 'normal', tags: [], createdAt: STAMP, updatedAt: STAMP, ...extra },
    })
    let sent = serveHousehold(household())
    await tool('update_task').run({ id: 't1', focus: true }, ctxFor())
    expect(sent[0]).toMatchObject({ id: 't1', focusOn: today })
    // the pick is the user's own, as a household member's is theirs
    expect(sent[0].focusBy).toBe(OWNER)

    const full = [...household(), task('f1', { focusOn: today }), task('f2', { focusOn: today }), task('f3', { focusOn: today }), task('old', { focusOn: '2026-09-01' })]
    sent = serveHousehold(full)
    await expect(tool('update_task').run({ id: 't1', focus: true }, ctxFor())).rejects.toThrow(/already has 3 open tasks \("F1", "F2", "F3"\)/)
    expect(sent).toEqual([])
    serveHousehold(full)
    const overview = (await tool('get_overview').run({}, ctxFor())) as { focus: { id: string; focusOn: string }[] }
    expect(overview.focus.map(t => [t.id, t.focusOn])).toEqual([
      ['f1', today],
      ['f2', today],
      ['f3', today],
    ])

    sent = serveHousehold(full)
    await tool('update_task').run({ id: 'f1', focus: false }, ctxFor())
    expect(sent[0].focusOn).toBeUndefined()
    sent = serveHousehold(full)
    await tool('update_task').run({ id: 'old', focus: false }, ctxFor())
    expect(sent[0].focusOn).toBe('2026-09-01')
  })

  it('get_week_plan_proposal is the app\'s proposal for the week ahead, and writes nothing', async () => {
    // a Thursday: the week to plan starts on Sunday 4 October
    const at = Date.parse('2026-10-01T12:00:00Z')
    serveHousehold(household())
    const plan = (await tool('get_week_plan_proposal').run({}, createContext({ db: ownerData(), clock: makeClock('UTC', () => at) }))) as Record<string, any>
    expect(plan.days[0]).toBe('2026-10-04')
    expect(plan.dinners).toEqual([expect.objectContaining({ date: '2026-10-04', recipeId: 'pasta', title: 'Pasta', isNew: false, why: expect.stringMatching(/^Cooked 1× in six months/) })])
    expect(plan.summary).toBe('1 dinner to fill')
    expect(calls.some(c => c.url.includes('sync_posts'))).toBe(false)
  })
})

describe('list_people counts days seen in the user\'s zone', () => {
  // noon UTC on Saturday 12 September
  const at = Date.parse('2026-09-12T12:00:00.000Z')
  const seen = (id: string, completedAt: string): Row => ({
    user_id: OWNER,
    data: { kind: 'task', id, title: id, description: '', status: 'done', priority: 'normal', tags: ['visit'], peopleIds: ['mum'], completedAt, createdAt: STAMP, updatedAt: STAMP },
  })
  const rows = (): Row[] => [
    { user_id: OWNER, data: { kind: 'person', id: 'mum', name: 'Mum', group: 'family', createdAt: STAMP, updatedAt: STAMP } },
    // three events on one Saturday
    seen('sat-1', '2026-09-05T09:00:00.000Z'),
    seen('sat-2', '2026-09-05T12:00:00.000Z'),
    seen('sat-3', '2026-09-05T15:00:00.000Z'),
    // 23:30 and 00:30 in London: two days there, one in UTC
    seen('late', '2026-09-09T22:30:00.000Z'),
    seen('early', '2026-09-09T23:30:00.000Z'),
    // inside 90 days, outside 30
    seen('july', '2026-07-01T12:00:00.000Z'),
  ]
  const mumIn = async (tz: string) => {
    serveHousehold(rows())
    const out = (await tool('list_people').run({}, createContext({ db: ownerData(), clock: makeClock(tz, () => at) }))) as { people: Record<string, unknown>[] }
    return out.people.find(p => p.id === 'mum')
  }

  it('keeps the visit counts as events and adds the days seen beside them', async () => {
    expect(await mumIn('Europe/London')).toMatchObject({ visitsLast30Days: 5, daysSeenLast30Days: 3, visitsLast90Days: 6, daysSeenLast90Days: 4 })
  })

  it('draws the day line where the user\'s clock does', async () => {
    expect(await mumIn('UTC')).toMatchObject({ visitsLast30Days: 5, daysSeenLast30Days: 2, visitsLast90Days: 6, daysSeenLast90Days: 3 })
  })

  it('says which counts are events and which are days', () => {
    expect(tool('list_people').description).toMatch(/visitsLast30Days\/visitsLast90Days count events/)
    expect(tool('list_people').description).toMatch(/daysSeenLast30Days\/daysSeenLast90Days count the days/)
  })
})

describe('list_people counts your own past events, as the app does', () => {
  const at = Date.parse('2026-10-01T12:00:00Z')
  const row = (data: Record<string, any>): Row => ({ user_id: OWNER, data: { createdAt: STAMP, updatedAt: STAMP, ...data } })
  const gran = row({ kind: 'person', id: 'gran', name: 'Gran', group: 'family', cadenceDays: 14 })
  const august = row({ kind: 'task', id: 'aug', title: 'Tea', description: '', status: 'done', priority: 'normal', completedAt: '2026-08-01T12:00:00.000Z', peopleIds: ['gran'], tags: ['visit'] })
  // an event of the owner's own, two days ago, with Gran on it
  const tea = row({ kind: 'event', id: 'tea', title: 'Tea with Gran', start: '2026-09-29T15:00:00.000Z', end: '2026-09-29T16:00:00.000Z', allDay: false, peopleIds: ['gran'] })
  const granIn = async (rows: Row[]) => {
    serveHousehold([...household(), ...rows])
    const out = (await tool('list_people').run({}, createContext({ db: ownerData(), clock: makeClock('UTC', () => at) }))) as { people: Record<string, any>[] }
    return out.people.find(p => p.id === 'gran')
  }

  it('has Gran on track after tea with her, where the tasks alone said overdue', async () => {
    expect(await granIn([gran, august])).toMatchObject({ status: 'overdue', lastSeen: '2026-08-01T12:00:00.000Z' })
    expect(await granIn([gran, august, tea])).toMatchObject({ status: 'ok', lastSeen: '2026-09-29T15:00:00.000Z', daysSince: 1, visitsLast30Days: 1 })
  })
})

describe('the kitchen over MCP: last cooked and sides', () => {
  /** household(), with rice and naan saved, and the day's pasta served with naan and a salad. */
  const kitchen = (): Row[] => {
    const rows = household()
    const at = (data: Record<string, any>): Row => ({ user_id: OWNER, data: { createdAt: STAMP, updatedAt: STAMP, ...data } })
    rows.push(
      at({ kind: 'recipe', id: 'rice', name: 'Rice', ingredients: [{ name: 'Basmati', qty: 300, unit: 'g' }], tags: [] }),
      at({ kind: 'recipe', id: 'naan', name: 'Naan', ingredients: [{ name: 'Flour', qty: 250, unit: 'g' }], tags: [] }),
    )
    rows.find(r => r.data.kind === 'meal')!.data.sides = [{ recipeId: 'naan', title: 'Naan' }, { title: 'Salad' }]
    return rows
  }
  const on = (iso: string) => createContext({ db: ownerData(), clock: makeClock('UTC', () => Date.parse(iso)) })
  const meal = (sent: Record<string, any>[]) => sent.find(i => i.kind === 'meal')!

  it('summarizeMeal names a meal with its sides, and one without reads as before', () => {
    expect(summarizeMeal({ id: 'm', date: DAY, slot: 'dinner', title: 'Pasta', recipeId: 'pasta', updatedAt: STAMP })).toEqual({
      id: 'm',
      date: DAY,
      slot: 'dinner',
      title: 'Pasta',
      label: 'Pasta',
      recipeId: 'pasta',
      out: false,
      placeId: null,
      sides: [],
      notes: null,
    })
  })

  it('list_recipes says when each recipe was last cooked and how often, a side counting like a main', async () => {
    serveHousehold(kitchen())
    const out = (await tool('list_recipes').run({}, on('2026-09-10T12:00:00Z'))) as { recipes: { id: string; timesCooked: number; lastCooked: string | null }[] }
    expect(Object.fromEntries(out.recipes.map(r => [r.id, [r.timesCooked, r.lastCooked]]))).toEqual({ pasta: [1, DAY], naan: [1, DAY], rice: [0, null] })
    // the day before, that dinner is still only a plan
    serveHousehold(kitchen())
    const before = (await tool('list_recipes').run({}, on('2026-09-07T12:00:00Z'))) as { recipes: { timesCooked: number; lastCooked: string | null }[] }
    expect(before.recipes.map(r => [r.timesCooked, r.lastCooked])).toEqual([
      [0, null],
      [0, null],
      [0, null],
    ])
  })

  it('get_week_meals gives each meal its sides and a label naming them together', async () => {
    serveHousehold(kitchen())
    const week = (await tool('get_week_meals').run({ date: DAY }, ctxFor())) as { meals: Record<string, any>[] }
    expect(week.meals[0]).toMatchObject({ title: 'Pasta', label: 'Pasta with Naan and Salad', sides: [{ recipeId: 'naan', title: 'Naan' }, { recipeId: null, title: 'Salad' }] })
  })

  it('plan_meal takes sides — saved recipes by name or id, dishes by title — and puts their ingredients on the list', async () => {
    const sent = serveHousehold(kitchen())
    const out = (await tool('plan_meal').run({ date: DAY, recipeName: 'Pasta', sides: [{ recipeName: 'rice' }, { title: 'garlic bread' }, { title: 'Pasta' }, { recipeId: 'rice' }] }, ctxFor())) as {
      planned: Record<string, any>
    }
    expect(out.planned).toMatchObject({ label: 'Pasta with Rice and garlic bread', sides: [{ recipeId: 'rice', title: 'Rice' }, { recipeId: null, title: 'garlic bread' }] })
    // the main is not its own side, and a side named twice is there once
    expect(meal(sent).sides).toEqual([{ recipeId: 'rice', title: 'Rice' }, { title: 'garlic bread' }])
    const lines = sent.find(i => i.kind === 'grocery')!.items as { name: string; recipeIds: string[] }[]
    expect(lines.find(l => l.name === 'Basmati')?.recipeIds).toEqual(['rice'])
    expect(lines.find(l => l.name === 'Spaghetti')?.recipeIds).toEqual(['pasta'])
    // the naan it was served with before is not on the list any more
    expect(lines.some(l => l.name === 'Flour')).toBe(false)
  })

  it('plan_meal keeps a meal’s sides while it is still cooked, and a bought meal has none', async () => {
    let sent = serveHousehold(kitchen())
    await tool('plan_meal').run({ date: DAY, title: 'Leftovers' }, ctxFor())
    expect(meal(sent)).toMatchObject({ title: 'Leftovers', sides: [{ recipeId: 'naan', title: 'Naan' }, { title: 'Salad' }] })
    expect(meal(sent)).not.toHaveProperty('recipeId')
    sent = serveHousehold(kitchen())
    await tool('plan_meal').run({ date: DAY, out: true, placeName: 'Nopi' }, ctxFor())
    expect(meal(sent)).not.toHaveProperty('sides')
    sent = serveHousehold(kitchen())
    await tool('plan_meal').run({ date: DAY, recipeName: 'Pasta', sides: [] }, ctxFor())
    expect(meal(sent)).not.toHaveProperty('sides')
  })

  it('plan_meal refuses sides on a bought meal or a breakfast, a side it cannot find, and sides that are not a list', async () => {
    const sent = serveHousehold(kitchen())
    await expect(tool('plan_meal').run({ date: DAY, out: true, sides: [{ title: 'Chips' }] }, ctxFor())).rejects.toThrow(/bought meal has no sides/)
    await expect(tool('plan_meal').run({ date: DAY, slot: 'breakfast', recipeName: 'Pasta', sides: [{ title: 'Toast' }] }, ctxFor())).rejects.toThrow(/lunch or dinner/)
    await expect(tool('plan_meal').run({ date: DAY, recipeName: 'Pasta', sides: [{ recipeName: 'Paella' }] }, ctxFor())).rejects.toThrow(/No recipe named "Paella"/)
    await expect(tool('plan_meal').run({ date: DAY, recipeName: 'Pasta', sides: 'rice' }, ctxFor())).rejects.toThrow(/sides must be a list/)
    expect(sent).toEqual([])
  })
})

describe('place categories over MCP are the app\'s own list', () => {
  it('list_places and create_place offer exactly the categories the app does, and name each as the app labels it', () => {
    for (const name of ['list_places', 'create_place']) {
      const t = tool(name)
      expect((t.inputSchema.properties.category as { enum: string[] }).enum, name).toEqual(PLACE_CATEGORIES)
      for (const c of PLACE_CATEGORIES) expect(t.description, `${name} names ${c}`).toContain(`${c} (${PLACE_CATEGORY_META[c].label})`)
    }
    expect(PLACE_CATEGORIES).toContain('fastfood')
  })

  it('create_place saves a fast food place, and list_places finds it by that category', async () => {
    const sent = serveHousehold(household())
    const out = (await tool('create_place').run({ name: 'Five Guys', category: 'fastfood' }, ctxFor())) as { created: { category: string } }
    expect(out.created.category).toBe('fastfood')
    expect(sent.find(i => i.kind === 'place')).toMatchObject({ name: 'Five Guys', category: 'fastfood' })
    serveHousehold([...household(), { user_id: OWNER, data: { kind: 'place', id: 'five', name: 'Five Guys', category: 'fastfood', createdAt: STAMP, updatedAt: STAMP } }])
    const found = (await tool('list_places').run({ category: 'fastfood' }, ctxFor())) as { places: { id: string }[] }
    expect(found.places.map(p => p.id)).toEqual(['five'])
  })

  it('still refuses a category the app does not have', async () => {
    const sent = serveHousehold(household())
    await expect(tool('create_place').run({ name: 'Moon base', category: 'spaceship' }, ctxFor())).rejects.toThrow(/Invalid category "spaceship"/)
    expect(sent).toEqual([])
  })
})

describe('a place’s address and other names over MCP', () => {
  const pret = { kind: 'place', id: 'pret', name: 'Pret A Manger', category: 'cafe', aliases: ['Pret', 'The Sandwich Shop'], address: '1 Oxford St, London', createdAt: STAMP, updatedAt: STAMP }
  const withPret = () => [...household(), { user_id: OWNER, data: pret }]

  it('create_place keeps both tidied, and says so', async () => {
    const sent = serveHousehold(household())
    const out = (await tool('create_place').run(
      { name: 'Wagamama', category: 'restaurant', address: ' 4 Streatham St,  London ', aliases: ['Waga', 'waga', 'Wagamama', ''] },
      ctxFor(),
    )) as { created: { address: string; aliases: string[] } }
    expect(out.created).toMatchObject({ address: '4 Streatham St, London', aliases: ['Waga'] })
    expect(sent.find(i => i.kind === 'place')).toMatchObject({ name: 'Wagamama', address: '4 Streatham St, London', aliases: ['Waga'] })
    // their descriptions tell an assistant what the two are for
    const schema = tool('create_place').inputSchema.properties as Record<string, { type: string }>
    expect([schema.address.type, schema.aliases.type]).toEqual(['string', 'array'])
  })

  it('list_places gives each place its address and other names: null and [] when it has none', async () => {
    serveHousehold(withPret())
    const { places } = (await tool('list_places').run({}, ctxFor())) as { places: { id: string; address: string | null; aliases: string[] }[] }
    expect(places.find(p => p.id === 'pret')).toMatchObject({ address: '1 Oxford St, London', aliases: ['Pret', 'The Sandwich Shop'] })
    expect(places.find(p => p.id === 'nopi')).toMatchObject({ address: null, aliases: [] })
    expect(summarizePlace({ id: 'x', name: 'X', category: 'other', aliases: 'Pret' })).toMatchObject({ aliases: [] })
  })

  it('refuses a new place named what another already goes by, and other names that are not a list', async () => {
    const sent = serveHousehold(withPret())
    await expect(tool('create_place').run({ name: 'the sandwich shop' }, ctxFor())).rejects.toThrow(/"the sandwich shop" is another name for "Pret A Manger" \(id pret\)/)
    await expect(tool('create_place').run({ name: 'NOPI' }, ctxFor())).rejects.toThrow(/"Nopi" already exists \(id nopi\)/)
    await expect(tool('create_place').run({ name: 'Wagamama', aliases: 'Waga' }, ctxFor())).rejects.toThrow(/aliases must be a list of names/)
    expect(sent).toEqual([])
  })

  it('finds a saved place for a task, a visit or a bought meal by another name, and for a task by its address', async () => {
    const places = withPret().map(r => r.data)
    expect(resolveContext(places, { placeName: 'The Sandwich Shop' }).placeId).toBe('pret')
    expect(resolveContext(places, { placeName: '1 Oxford St, London' }).placeId).toBe('pret')
    const sent = serveHousehold(withPret())
    await tool('log_visit').run({ placeName: 'the sandwich shop', note: 'Lunch' }, ctxFor())
    expect(sent.find(i => i.kind === 'task')).toMatchObject({ status: 'done', placeId: 'pret' })
    await tool('plan_meal').run({ date: DAY, slot: 'lunch', out: true, placeName: 'THE SANDWICH SHOP' }, ctxFor())
    expect(sent.find(i => i.kind === 'meal')).toMatchObject({ out: true, placeId: 'pret' })
  })
})

describe('the wardrobe over MCP', () => {
  const today = localDayKey()
  const daysAgo = (n: number) => shiftDayKey(today, -n)
  /** household() with a look already logged today, holding these pieces. */
  const withLookToday = (garmentIds: string[]): Row[] => [
    ...household(),
    { user_id: OWNER, data: { kind: 'wear', id: `wear~${today}~look000000`, date: today, garmentIds, createdAt: STAMP, updatedAt: STAMP } },
  ]
  type Piece = { id: string; name: string; type: string }
  const ids = (list: { id: string }[]) => list.map(p => p.id)

  it('needs read access to look and "Add and change things" to log, and never the journal\'s', () => {
    for (const name of ['list_garments', 'list_outfits', 'get_wardrobe_stats']) expect(tool(name).scope, name).toBe('read')
    expect(tool('log_outfit').scope).toBe('write')
  })

  it('list_garments gives each piece its last worn day and days worn, retired ones flagged, Trash left out', async () => {
    serveHousehold(household())
    const out = (await tool('list_garments').run({}, ctxFor())) as { today: string; count: number; garments: (Piece & Record<string, unknown>)[] }
    expect(out.today).toBe(today)
    expect(out.garments.map(g => g.name)).toEqual(['Blue jeans', 'Green dress', 'Linen shirt', 'Navy tee', 'New trainers', 'Old band tee', 'Wool scarf'])
    expect(out.garments.find(g => g.id === 'tee')).toEqual({
      id: 'tee',
      name: 'Navy tee',
      type: 'top',
      color: '#1e2848',
      notes: null,
      occasion: 'work',
      retired: false,
      addedOn: daysAgo(30),
      lastWorn: daysAgo(3),
      daysWorn: 1,
      daysWornLast30Days: 1,
      daysWornLast365Days: 1,
    })
    expect(out.garments.find(g => g.id === 'band')).toMatchObject({ retired: true, lastWorn: null, daysWorn: 0 })
    // in the app's words: the stored 'personal' is days off, and a piece marked for neither is for any time
    expect(out.garments.find(g => g.id === 'dress')).toMatchObject({ occasion: 'days off' })
    expect(out.garments.find(g => g.id === 'jeans')).toMatchObject({ occasion: 'anytime' })
    expect(out.garments.every(g => ['work', 'days off', 'anytime'].includes(g.occasion as string))).toBe(true)
    expect(tool('list_garments').description).toContain('occasion: work, days off, or anytime')
    expect(tool('list_garments').description).not.toMatch(/personal|both/)
    serveHousehold(household())
    expect(ids(((await tool('list_garments').run({ type: 'top' }, ctxFor())) as { garments: Piece[] }).garments)).toEqual(['linen', 'tee', 'band'])
    await expect(tool('list_garments').run({ type: 'hat' }, ctxFor())).rejects.toThrow(/Invalid type "hat"/)
  })

  it('list_outfits says whether each can be worn, and how often its core was', async () => {
    serveHousehold(household())
    const out = (await tool('list_outfits').run({}, ctxFor())) as { outfits: Record<string, any>[] }
    expect(out.outfits).toEqual([
      {
        id: 'weekday',
        name: 'Weekday',
        label: 'Weekday',
        pieces: [
          { id: 'tee', name: 'Navy tee', type: 'top' },
          { id: 'jeans', name: 'Blue jeans', type: 'bottom' },
        ],
        piecesDeleted: 0,
        wearable: true,
        notWearable: null,
        daysWorn: 1,
        lastWorn: daysAgo(3),
      },
      {
        id: 'old-fav',
        name: null,
        label: 'Old band tee + Blue jeans',
        pieces: [
          { id: 'band', name: 'Old band tee', type: 'top' },
          { id: 'jeans', name: 'Blue jeans', type: 'bottom' },
        ],
        piecesDeleted: 0,
        wearable: false,
        notWearable: 'Old band tee is retired',
        daysWorn: 0,
        lastWorn: null,
      },
    ])
  })

  it('get_wardrobe_stats: most worn, not worn lately and never worn, by the app\'s rules', async () => {
    serveHousehold(household())
    const all = (await tool('get_wardrobe_stats').run({ window: 'all' }, ctxFor())) as Record<string, any>
    expect(all.piecesInUse).toBe(5)
    // one day each: the latest worn first, then by name
    expect(all.mostWorn).toEqual({
      window: 'all time',
      pieces: [
        { id: 'jeans', name: 'Blue jeans', type: 'bottom', daysWorn: 1, lastWorn: daysAgo(3) },
        { id: 'tee', name: 'Navy tee', type: 'top', daysWorn: 1, lastWorn: daysAgo(3) },
        { id: 'dress', name: 'Green dress', type: 'onepiece', daysWorn: 1, lastWorn: daysAgo(70) },
      ],
    })
    expect(all.notWornLately).toEqual({ days: 60, pieces: [{ id: 'dress', name: 'Green dress', type: 'onepiece', lastWorn: daysAgo(70), daysSince: 70 }] })
    // the retired band tee is left out, and the trainers added today get a week's grace
    expect(all.neverWorn).toEqual({ graceDays: 7, pieces: [{ id: 'linen', name: 'Linen shirt', type: 'top', addedOn: daysAgo(30) }] })
    expect(all.daysLoggedThisMonth).toBe([daysAgo(3), daysAgo(70)].filter(d => d.startsWith(today.slice(0, 7))).length)
    serveHousehold(household())
    const month = (await tool('get_wardrobe_stats').run({}, ctxFor())) as Record<string, any>
    expect(month.mostWorn.window).toBe('last 30 days')
    expect(ids(month.mostWorn.pieces)).toEqual(['jeans', 'tee'])
    await expect(tool('get_wardrobe_stats').run({ window: 'week' }, ctxFor())).rejects.toThrow(/Invalid window "week"/)
  })

  it('never lets a photo out, and never a household peer\'s clothes', async () => {
    for (const name of ['list_garments', 'list_outfits', 'get_wardrobe_stats', 'log_outfit']) {
      serveHousehold(household())
      const out = JSON.stringify(await tool(name).run(SWEEP[name], ctxFor()))
      // the front's photos or the back's, by id or by field
      expect(out, name).not.toMatch(/photo-of-tee|thumb-of-tee|back-photo-of-tee|back-thumb-of-tee|photoId|thumbId|backPhotoId|backThumbId|showBack/)
      expect(out, name).not.toContain(SECRET)
    }
  })

  it('log_outfit writes a new look for a day with none, as the app writes one', async () => {
    const sent = serveHousehold(household())
    const out = (await tool('log_outfit').run({ garmentIds: ['tee', 'jeans'] }, ctxFor())) as Record<string, any>
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'wear', date: today, garmentIds: ['tee', 'jeans'] })
    expect(sent[0].id).toMatch(new RegExp(`^wear~${today}~[0-9a-f]{10}$`))
    expect(sent[0].updatedAt).toBe(sent[0].createdAt)
    expect('projectId' in sent[0]).toBe(false)
    expect(out).toMatchObject({ logged: 'new look', look: { date: today, label: 'Navy tee + Blue jeans' }, looksThatDay: 1 })
  })

  it('changes the day\'s latest look under its own id, stamped newer', async () => {
    const sent = serveHousehold(withLookToday(['tee', 'jeans']))
    const out = (await tool('log_outfit').run({ garmentIds: ['dress'] }, ctxFor())) as Record<string, any>
    expect(sent[0]).toMatchObject({ id: `wear~${today}~look000000`, garmentIds: ['dress'], createdAt: STAMP })
    expect(sent[0].updatedAt > STAMP).toBe(true)
    expect(out).toMatchObject({ logged: 'look updated', looksThatDay: 1 })
  })

  it('keeps what the look held that could not be chosen — a retired scarf — while a new top takes the place of one in Trash', async () => {
    const sent = serveHousehold(withLookToday(['torn', 'jeans', 'scarf']))
    await tool('log_outfit').run({ garmentIds: ['tee', 'jeans'] }, ctxFor())
    expect(sent[0].garmentIds).toEqual(['tee', 'jeans', 'scarf'])
  })

  it('adds a second look with another: true, and wears a saved outfit on a past day', async () => {
    let sent = serveHousehold(withLookToday(['tee', 'jeans']))
    const evening = (await tool('log_outfit').run({ garmentIds: ['dress'], another: true }, ctxFor())) as Record<string, any>
    expect(sent[0].id).not.toBe(`wear~${today}~look000000`)
    expect(evening).toMatchObject({ logged: 'new look', looksThatDay: 2 })
    sent = serveHousehold(household())
    await tool('log_outfit').run({ outfitId: 'weekday', date: daysAgo(1) }, ctxFor())
    expect(sent[0]).toMatchObject({ date: daysAgo(1), garmentIds: ['tee', 'jeans'] })
    expect(sent[0].id).toMatch(new RegExp(`^wear~${daysAgo(1)}~`))
  })

  it('counts a look planned for today in no figure, and log_outfit on its day confirms it with what was worn', async () => {
    const plan = { kind: 'wear', id: `wear~${today}~plan000000`, date: today, garmentIds: ['linen', 'jeans'], planned: true, createdAt: STAMP, updatedAt: STAMP }
    const withPlan = (): Row[] => [...household(), { user_id: OWNER, data: plan }]
    serveHousehold(withPlan())
    const { garments } = (await tool('list_garments').run({}, ctxFor())) as { garments: (Piece & Record<string, unknown>)[] }
    expect(garments.find(g => g.id === 'linen')).toMatchObject({ lastWorn: null, daysWorn: 0 })
    expect(garments.find(g => g.id === 'jeans')).toMatchObject({ lastWorn: daysAgo(3), daysWorn: 1 })
    serveHousehold(withPlan())
    const stats = (await tool('get_wardrobe_stats').run({ window: 'all' }, ctxFor())) as Record<string, any>
    expect(ids(stats.neverWorn.pieces)).toEqual(['linen'])
    expect(stats.daysLoggedThisMonth).toBe([daysAgo(3), daysAgo(70)].filter(d => d.startsWith(today.slice(0, 7))).length)
    // the composer's Wearing this and Today's Wore it: a log records what was worn, so the day's plan takes the
    // pieces under its own id, stamped newer, and is a plan no longer; no second look is added beside it
    const sent = serveHousehold(withPlan())
    const out = (await tool('log_outfit').run({ garmentIds: ['tee', 'jeans'] }, ctxFor())) as Record<string, any>
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'wear', id: plan.id, date: today, garmentIds: ['tee', 'jeans'], createdAt: STAMP })
    expect('planned' in sent[0]).toBe(false)
    expect(sent[0].updatedAt > STAMP).toBe(true)
    expect(out).toMatchObject({ logged: 'plan confirmed', look: { id: plan.id, label: 'Navy tee + Blue jeans' }, looksThatDay: 1 })
    // and it counts from then on; the linen shirt the plan held, not worn after all, still counts nowhere
    serveHousehold([...household(), { user_id: OWNER, data: sent[0] }])
    const after = (await tool('list_garments').run({}, ctxFor())) as { garments: (Piece & Record<string, unknown>)[] }
    expect(after.garments.find(g => g.id === 'tee')).toMatchObject({ lastWorn: today, daysWorn: 2 })
    expect(after.garments.find(g => g.id === 'linen')).toMatchObject({ lastWorn: null, daysWorn: 0 })
  })

  it('confirms a plan on a day gone by too; another: true leaves it a plan beside a look of its own; a planned day ahead is refused', async () => {
    const yesterday = daysAgo(1)
    const plan = { kind: 'wear', id: `wear~${yesterday}~plan000001`, date: yesterday, garmentIds: ['linen', 'jeans'], planned: true, createdAt: STAMP, updatedAt: STAMP }
    const withPlan = (): Row[] => [...household(), { user_id: OWNER, data: plan }]
    let sent = serveHousehold(withPlan())
    const confirmed = (await tool('log_outfit').run({ outfitId: 'weekday', date: yesterday }, ctxFor())) as Record<string, any>
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ id: plan.id, date: yesterday, garmentIds: ['tee', 'jeans'] })
    expect('planned' in sent[0]).toBe(false)
    expect(confirmed).toMatchObject({ logged: 'plan confirmed', looksThatDay: 1 })
    // an evening change, asked for: the plan stays as it was, and is no look worn
    sent = serveHousehold(withPlan())
    const beside = (await tool('log_outfit').run({ garmentIds: ['dress'], date: yesterday, another: true }, ctxFor())) as Record<string, any>
    expect(sent).toHaveLength(1)
    expect(sent[0].id).not.toBe(plan.id)
    expect(sent[0]).toMatchObject({ date: yesterday, garmentIds: ['dress'] })
    expect(beside).toMatchObject({ logged: 'new look', looksThatDay: 1 })
    // a plan for tomorrow is still a day that has not happened
    const tomorrow = shiftDayKey(today, 1)
    sent = serveHousehold([...household(), { user_id: OWNER, data: { ...plan, id: `wear~${tomorrow}~plan000002`, date: tomorrow } }])
    await expect(tool('log_outfit').run({ garmentIds: ['tee', 'jeans'], date: tomorrow }, ctxFor())).rejects.toThrow(/has not happened yet/)
    expect(sent).toEqual([])
  })

  it('tells an assistant, in the tool’s own words, that a log confirms the day’s plan', () => {
    const said = tool('log_outfit').description
    expect(said).toMatch(/on a day whose latest look is a plan the user made ahead, today or a day gone by, that plan is confirmed/)
    expect(said).toContain('the answer says "plan confirmed"')
    expect(said).toContain('With another: true the plan is left a plan')
    expect(said).not.toMatch(/never changed here/)
  })

  it('refuses what the app would not write, and writes nothing', async () => {
    const refusals: [Record<string, unknown>, RegExp][] = [
      [{ garmentIds: ['tee', 'jeans'], date: shiftDayKey(today, 1) }, /has not happened yet/],
      [{ garmentIds: ['tee', 'jeans'], date: '2026-02-30' }, /not a real calendar date/],
      [{ garmentIds: ['band', 'jeans'] }, /Old band tee is retired/],
      [{ garmentIds: ['nope', 'jeans'] }, /No piece of clothing with id "nope"/],
      [{ garmentIds: ['peer-g', 'jeans'] }, /No piece of clothing with id "peer-g"/],
      [{ garmentIds: ['torn', 'jeans'] }, /No piece of clothing with id "torn"/],
      [{ garmentIds: ['jeans'] }, /needs a top and a bottom, or a one-piece/],
      [{ garmentIds: Array.from({ length: 13 }, (_, i) => `piece-${i}`) }, /at most 12 pieces/],
      [{ outfitId: 'old-fav' }, /cannot be worn as it is: Old band tee is retired/],
      [{ outfitId: 'peer-o' }, /No saved outfit with id "peer-o"/],
      [{}, /garmentIds .* or an outfitId/],
      [{ garmentIds: ['tee', 'jeans'], outfitId: 'weekday' }, /one of the two/],
    ]
    for (const [args, why] of refusals) {
      const sent = serveHousehold(household())
      await expect(tool('log_outfit').run(args, ctxFor()), JSON.stringify(args)).rejects.toThrow(why)
      expect(sent, JSON.stringify(args)).toEqual([])
    }
  })
})

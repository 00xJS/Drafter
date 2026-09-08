import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

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

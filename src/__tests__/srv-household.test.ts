import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import householdFunction from '../../netlify/functions/household.mjs'
import { PERSONAL_KINDS } from '../../shared/kinds.mjs'

// Removing a member and leaving a household each stamped a household_epoch
// setting on every member, for their apps to notice and resync. user_settings
// has no such column, so every one of those writes failed, and silently. They
// are gone: the app that asked resyncs in full itself (Settings → Household),
// and nothing ever read an epoch.

const household = householdFunction as (req: Request) => Promise<Response>
const SUPABASE = 'https://db.example.test'
const OWNER = '00000000-0000-0000-0000-00000000000a'
const MEMBER = '00000000-0000-0000-0000-00000000000b'
const HH = '00000000-0000-0000-0000-0000000000f1'
/** An account with a household of its own, which this household's owner has no business touching. */
const OUTSIDER = '00000000-0000-0000-0000-00000000000c'

let calls: { method: string; path: string; query: string; body?: unknown }[]
let me: string
let members: { user_id: string; role: string }[]
/** The posts the fake database holds, so a PATCH can be seen to move some rows and not others. */
let posts: { id: string; user_id: string; kind: string; data: Record<string, unknown> }[]

/**
 * PostgREST, as far as the filter forms THIS endpoint sends:
 * `user_id=eq.<uuid>`, `kind=eq.note`, `kind=not.in.(a,b,c)`,
 * `data->>shared=eq.true` and one flat `or=(term,term,term)`. It models
 * nothing else on purpose — a stand-in that pretended to be general would
 * quietly answer differently from the database, and that is also why the
 * endpoint sends two simple statements rather than one nested filter. That the
 * real syntax parses was checked against the live PostgREST, which is the half
 * a stand-in cannot tell you.
 */
function matches(row: { user_id: string; kind: string; data: Record<string, unknown> }, q: URLSearchParams): boolean {
  const user = q.get('user_id')
  if (user && user !== `eq.${row.user_id}`) return false
  const kind = q.get('kind')
  const notIn = kind && /^not\.in\.\((.*)\)$/.exec(kind)
  if (notIn && notIn[1].split(',').filter(Boolean).includes(row.kind)) return false
  const isKind = kind && /^eq\.(.*)$/.exec(kind)
  if (isKind && isKind[1] !== row.kind) return false
  const flag = q.get('data->>shared')
  // `->>` is text in Postgres: an absent key reads as null, never as 'false'
  const asText = row.data.shared === undefined || row.data.shared === null ? null : String(row.data.shared)
  if (flag) {
    if (flag === 'eq.true') {
      if (asText !== 'true') return false
    } else throw new Error(`the stand-in does not model the filter data->>shared=${flag}`)
  }
  const or = q.get('or')
  if (or) {
    const terms = or.replace(/^\(|\)$/g, '').split(',')
    const any = terms.some(t => {
      if (t === 'kind.neq.note') return row.kind !== 'note'
      if (t === 'kind.neq.task') return row.kind !== 'task'
      if (t === 'data->>shared.eq.true') return asText === 'true'
      if (t === 'data->>shared.is.null') return asText === null
      // null is not unequal to anything in SQL, which is exactly why the
      // is.null term above has to be there
      if (t === 'data->>shared.neq.false') return asText !== null && asText !== 'false'
      throw new Error(`the stand-in does not model the filter term ${t}`)
    })
    if (!any) return false
  }
  return true
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  calls = []
  me = OWNER
  posts = [
    { id: 't1', user_id: MEMBER, kind: 'task', data: { kind: 'task', id: 't1' } },
    { id: 'j1', user_id: MEMBER, kind: 'journal', data: { kind: 'journal', id: 'j1' } },
    // the three states a note can be in, and only the shared one is household work
    { id: 'n-private', user_id: MEMBER, kind: 'note', data: { kind: 'note', id: 'n-private' } },
    { id: 'n-false', user_id: MEMBER, kind: 'note', data: { kind: 'note', id: 'n-false', shared: false } },
    { id: 'n-shared', user_id: MEMBER, kind: 'note', data: { kind: 'note', id: 'n-shared', shared: true } },
    // and the two a task can be in, the other way round: no flag is household work
    { id: 't-private', user_id: MEMBER, kind: 'task', data: { kind: 'task', id: 't-private', shared: false } },
  ]
  members = [
    { user_id: OWNER, role: 'owner' },
    { user_id: MEMBER, role: 'member' },
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      const q = url.searchParams
      calls.push({ method, path: url.pathname, query: url.search, body })
      if (url.pathname === '/auth/v1/user') return Response.json({ id: me, email: `${me}@example.test` })
      if (url.pathname === '/auth/v1/admin/users') return Response.json({ users: members.map(m => ({ id: m.user_id, email: `${m.user_id}@example.test` })) })
      if (url.pathname === '/rest/v1/user_settings') {
        // the table has no household_epoch column: PostgREST refuses the write
        if (method !== 'GET') return Response.json({ message: "Could not find the 'household_epoch' column of 'user_settings'" }, { status: 400 })
        return Response.json([])
      }
      if (url.pathname === '/rest/v1/household_members') {
        if (method === 'DELETE') {
          members = members.filter(m => `eq.${m.user_id}` !== q.get('user_id'))
          return new Response(null, { status: 204 })
        }
        const rows = q.get('user_id') ? members.filter(m => `eq.${m.user_id}` === q.get('user_id')) : members
        return Response.json(rows.map(m => ({ household_id: HH, user_id: m.user_id, role: m.role, joined_at: '2026-01-01T00:00:00Z' })))
      }
      if (url.pathname === '/rest/v1/households') {
        if (method === 'DELETE') return new Response(null, { status: 204 })
        return Response.json([{ id: HH, name: 'Home', created_by: OWNER }])
      }
      if (url.pathname === '/rest/v1/posts' && method === 'PATCH') {
        for (const row of posts) if (matches(row, q)) Object.assign(row, body)
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected ${method} ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const post = (action: string, payload: Record<string, unknown> = {}) =>
  household(
    new Request('https://site.test/api/household', {
      method: 'POST',
      headers: { authorization: 'Bearer session', 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    }),
  )

/** Every write to user_settings: there should be none on remove or leave. */
const settingsWrites = () => calls.filter(c => c.path === '/rest/v1/user_settings' && c.method !== 'GET')

describe('Household → remove and leave', () => {
  it('removing a member hands their rows to the owner, takes them out, and writes no setting', async () => {
    const res = await post('remove', { userId: MEMBER })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).not.toHaveProperty('householdEpoch')
    expect(body.members.map((m: { id: string }) => m.id)).toEqual([OWNER])
    // the stamp moves with the owner, or the other devices never hear of it:
    // a delta returns rows newer than the caller's cursor, and changing hands
    // touches neither `data` nor `updated_at`
    const move = calls.find(c => c.method === 'PATCH' && c.path === '/rest/v1/posts')?.body as { user_id: string; synced_at: string }
    expect(move.user_id).toBe(OWNER)
    expect(Number.isFinite(Date.parse(move.synced_at))).toBe(true)
    expect(calls.some(c => c.method === 'DELETE' && c.path === '/rest/v1/household_members')).toBe(true)
    expect(settingsWrites()).toEqual([])
  })

  // A personal kind belongs to one account even inside a household. This used
  // to hand the lot over: the departing member's journal, wardrobe, habits,
  // routines, reviews and calendars all became the creator's, in their app,
  // their ICS feed, their nightly backup and their MCP tools — while the
  // member lost their own. The database has said the opposite all along
  // (admin_prepare_user_deletion deletes the personal rows rather than passing
  // them to an heir); only this path disagreed.
  it('re-attributes the shared work and leaves every personal kind with its owner', async () => {
    await post('remove', { userId: MEMBER })
    const patch = calls.find(c => c.method === 'PATCH' && c.path === '/rest/v1/posts')!
    const q = new URLSearchParams(patch.query)
    expect(q.get('user_id')).toBe(`eq.${MEMBER}`)
    // notes move in a statement of their own now, so this one excludes them
    // along with every personal kind
    const excluded = (q.get('kind') ?? '').replace(/^not\.in\.\(|\)$/g, '').split(',').filter(Boolean)
    expect(new Set(excluded)).toEqual(new Set([...PERSONAL_KINDS, 'note']))
    // and the rows themselves moved the way the filters say
    expect(posts.filter(p => p.user_id === OWNER).map(p => p.id)).toEqual(['t1', 'n-shared'])
    expect(posts.filter(p => p.user_id === MEMBER).map(p => p.id)).toEqual(['j1', 'n-private', 'n-false', 't-private'])
  })

  // v3.19 gives a task the same per-record audience, with the default the
  // other way round. A task nobody withheld is household work and moves; one
  // its author kept to themselves is not, and handing it to the creator would
  // be the same disclosure as handing over a private note — worse, in fact,
  // since the creator's ICS feed publishes tasks.
  it('leaves a task its author kept private with its author, and moves the rest', async () => {
    await post('remove', { userId: MEMBER })
    const owned = (id: string) => posts.find(p => p.id === id)!.user_id
    expect(owned('t1'), 'a task with no flag is the household\'s and moves').toBe(OWNER)
    expect(owned('t-private'), 'a task marked private stays with the member').toBe(MEMBER)
  })

  // `note` is not a personal kind — a shared note IS household work and moves
  // like a task. But since v3.16 a note is its author's until they share it,
  // and "not a personal kind" handed every private note the leaving member had
  // written to the household creator: into their Notes list, their ICS feed,
  // their nightly backup and their MCP tools. The member was already out of
  // the household by then, so the same statement lost it to its author too.
  it('leaves a note its author never shared with its author, and moves one they did', async () => {
    await post('remove', { userId: MEMBER })
    const owned = (id: string) => posts.find(p => p.id === id)!.user_id
    expect(owned('n-private'), 'a note with no flag is private and stays').toBe(MEMBER)
    expect(owned('n-false'), 'an explicit shared:false stays too').toBe(MEMBER)
    expect(owned('n-shared'), 'a shared note is household work and moves').toBe(OWNER)
    expect(owned('t1'), 'a task still moves').toBe(OWNER)
    expect(owned('j1'), 'a journal still stays').toBe(MEMBER)
  })

  // Owning SOME household was the only check on the id, and the
  // household-scoped membership DELETE ran after the rows had already moved.
  // So any household owner could name any account and take everything it had.
  it('refuses an account that is not in the caller\'s household, without touching a row', async () => {
    calls.length = 0
    const res = await post('remove', { userId: OUTSIDER })
    expect(res.status).toBe(404)
    expect(calls.some(c => c.path === '/rest/v1/posts')).toBe(false)
    expect(calls.some(c => c.method === 'DELETE' && c.path === '/rest/v1/household_members')).toBe(false)
  })

  it('refuses an id that is not a uuid before it reaches a filter', async () => {
    calls.length = 0
    const res = await post('remove', { userId: '*' })
    expect(res.status).toBe(400)
    expect(calls.some(c => c.path === '/rest/v1/posts')).toBe(false)
  })

  it('takes the membership away before moving anything, so a failure cannot leave them a member with no rows', async () => {
    calls.length = 0
    await post('remove', { userId: MEMBER })
    const del = calls.findIndex(c => c.method === 'DELETE' && c.path === '/rest/v1/household_members')
    const patch = calls.findIndex(c => c.method === 'PATCH' && c.path === '/rest/v1/posts')
    expect(del).toBeGreaterThanOrEqual(0)
    expect(patch).toBeGreaterThan(del)
  })

  it('leaving takes you out and writes no setting; the last one out closes the household', async () => {
    me = MEMBER
    const res = await post('leave')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ household: null, members: [] })
    expect(calls.some(c => c.method === 'DELETE' && c.path === '/rest/v1/households')).toBe(false)
    me = OWNER
    await post('leave')
    expect(calls.some(c => c.method === 'DELETE' && c.path === '/rest/v1/households')).toBe(true)
    expect(settingsWrites()).toEqual([])
  })
})

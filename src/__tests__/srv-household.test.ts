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

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  calls = []
  me = OWNER
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
      if (url.pathname === '/rest/v1/posts' && method === 'PATCH') return new Response(null, { status: 204 })
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
    expect(calls.find(c => c.method === 'PATCH' && c.path === '/rest/v1/posts')?.body).toEqual({ user_id: OWNER })
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
    const excluded = (q.get('kind') ?? '').replace(/^not\.in\.\(|\)$/g, '').split(',').filter(Boolean)
    expect(new Set(excluded)).toEqual(PERSONAL_KINDS)
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

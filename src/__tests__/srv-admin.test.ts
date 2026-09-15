import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNC_KINDS } from '../../shared/kinds.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import adminFunction from '../../netlify/functions/admin.mjs'

// Deleting an account that owned a single row used to fail outright:
// posts.user_id is NOT NULL, and its foreign key is ON DELETE SET NULL. Admin
// now hands the records over (admin_prepare_user_deletion, db-smoke step 14)
// before it asks the auth server to delete the sign-in — never the other way.
// Its wardrobe photos (personal/<id>/ in the media bucket) go in between.

const admin = adminFunction as (req: Request) => Promise<Response>
const SUPABASE = 'https://db.example.test'
const OWNER = '00000000-0000-0000-0000-00000000000a'
const LEAVER = '00000000-0000-0000-0000-00000000000d'
const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'
const P3 = '33333333-3333-4333-8333-333333333333'

let calls: string[]
let prepareFails: boolean
let deleteFails: boolean
let stored: unknown
/** The sync check as app_config holds it (canary.mjs CANARY_KEY); null before any has run. */
let canary: unknown
/** Whose session asks: the owner's unless a test says otherwise. */
let signedIn: string
/** app_config does not answer. */
let configDown: boolean
/** Every piece of clothing left on the server once the leaver's own are deleted. */
let garmentRows: { id: string; user_id: string; data: Record<string, unknown> }[]
/** What the storage list answers for personal/<leaver>/. */
let listed: { name: string; id: string | null; updated_at?: string }[]
let listFails: boolean
let removed: string[][]

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  calls = []
  prepareFails = false
  deleteFails = false
  stored = null
  canary = null
  signedIn = 'owner@example.test'
  configDown = false
  garmentRows = []
  listed = []
  listFails = false
  removed = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(SUPABASE, '')
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push(`${method} ${url.split('?')[0]}`)
      if (url === '/auth/v1/user') return Response.json({ id: OWNER, email: signedIn })
      if (url.startsWith('/rest/v1/app_config?key=eq.owner_email')) return Response.json([{ value: 'owner@example.test' }])
      if (url === `/auth/v1/admin/users/${LEAVER}` && method === 'GET') return Response.json({ id: LEAVER, email: 'leaving@example.test' })
      if (url === '/rest/v1/rpc/admin_prepare_user_deletion') {
        expect(body).toEqual({ target: LEAVER, heir: OWNER })
        if (prepareFails) return new Response('{"message":"Could not find the function"}', { status: 404 })
        return Response.json({ reassigned: 3, deleted: 2, historyReassigned: 1, historyDeleted: 4 })
      }
      if (url === `/auth/v1/admin/users/${LEAVER}` && method === 'DELETE') {
        return deleteFails ? Response.json({ msg: 'Database error deleting user' }, { status: 500 }) : Response.json({})
      }
      if (url.startsWith('/rest/v1/posts?select=id,user_id,data&kind=eq.garment') && method === 'GET') {
        const range = garmentRows.length ? `0-${garmentRows.length - 1}/${garmentRows.length}` : '*/0'
        return new Response(JSON.stringify(garmentRows), { headers: { 'content-range': range } })
      }
      if (url === '/storage/v1/object/list/media' && method === 'POST') {
        expect(body.prefix).toBe(`personal/${LEAVER}/`)
        if (listFails) return new Response('{"message":"storage is down"}', { status: 503 })
        return Response.json(body.offset === 0 ? listed : [])
      }
      if (url === '/storage/v1/object/media' && method === 'DELETE') {
        removed.push(body.prefixes)
        return Response.json(body.prefixes.map((name: string) => ({ name })))
      }
      if (url.startsWith('/rest/v1/app_config?key=eq.sync_canary')) {
        if (configDown) return new Response('unavailable', { status: 503 })
        return Response.json(canary ? [{ value: JSON.stringify(canary) }] : [])
      }
      if (url === '/rest/v1/rpc/sync_canary') return Response.json({ ok: true, checked: body.kinds.length, failures: [] })
      if (url === '/rest/v1/app_config?on_conflict=key' && method === 'POST') {
        stored = JSON.parse(body.value)
        return new Response(null, { status: 201 })
      }
      throw new Error(`unexpected ${method} ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const act = (action: string, payload: Record<string, unknown> = {}) =>
  admin(
    new Request('https://site.test/api/admin', {
      method: 'POST',
      headers: { authorization: 'Bearer owner-session', 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    }),
  )

describe('Admin → delete an account', () => {
  it('hands the records over first, then deletes the sign-in, and says what moved', async () => {
    const res = await act('deleteUser', { userId: LEAVER })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, email: 'leaving@example.test', reassigned: 3, deleted: 2, historyReassigned: 1, historyDeleted: 4, photosDeleted: 0 })
    const prepare = calls.indexOf('POST /rest/v1/rpc/admin_prepare_user_deletion')
    const remove = calls.indexOf(`DELETE /auth/v1/admin/users/${LEAVER}`)
    expect(prepare).toBeGreaterThan(-1)
    expect(remove).toBeGreaterThan(prepare)
  })

  it('deletes nothing when the records cannot be handed over', async () => {
    prepareFails = true
    const res = await act('deleteUser', { userId: LEAVER })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/^Could not hand their records over, so nothing was deleted/)
    expect(calls).not.toContain(`DELETE /auth/v1/admin/users/${LEAVER}`)
  })

  it('says so when the records moved but the sign-in did not go', async () => {
    deleteFails = true
    const res = await act('deleteUser', { userId: LEAVER })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/handed over, but the sign-in could not be deleted: Database error deleting user\. Try again\.$/)
    expect(body.reassigned).toBe(3)
  })

  it('still refuses to delete the account that is asking', async () => {
    const res = await act('deleteUser', { userId: OWNER })
    expect(res.status).toBe(400)
    expect(calls).not.toContain('POST /rest/v1/rpc/admin_prepare_user_deletion')
  })
})

describe('Admin → delete an account → its wardrobe photos', () => {
  it('deletes the photos in its personal/ folder after handing the records over and before the sign-in goes', async () => {
    listed = [
      { name: P1, id: 'o1', updated_at: '2026-09-13T08:00:00.000Z' },
      { name: P2, id: 'o2', updated_at: '2026-01-01T08:00:00.000Z' },
    ]
    const res = await act('deleteUser', { userId: LEAVER })
    expect(res.status).toBe(200)
    expect((await res.json()).photosDeleted).toBe(2)
    // whatever their age: the account is going
    expect(removed).toEqual([[`personal/${LEAVER}/${P1}`, `personal/${LEAVER}/${P2}`]])
    const prepare = calls.indexOf('POST /rest/v1/rpc/admin_prepare_user_deletion')
    const photos = calls.indexOf('DELETE /storage/v1/object/media')
    const signIn = calls.indexOf(`DELETE /auth/v1/admin/users/${LEAVER}`)
    expect(prepare).toBeLessThan(calls.indexOf('POST /storage/v1/object/list/media'))
    expect(photos).toBeGreaterThan(prepare)
    expect(signIn).toBeGreaterThan(photos)
  })

  it('keeps a photo another piece still points at, and anything in the folder that is not one of its photos', async () => {
    garmentRows = [{ id: 'g-kept', user_id: OWNER, data: { kind: 'garment', id: 'g-kept', name: 'Coat', type: 'outerwear', photoId: `personal/${LEAVER}/${P3}` } }]
    listed = [
      { name: P1, id: 'o1' },
      { name: P3, id: 'o3' },
      { name: 'nested', id: null },
      { name: 'x', id: 'ox' },
    ]
    const res = await act('deleteUser', { userId: LEAVER })
    expect((await res.json()).photosDeleted).toBe(1)
    expect(removed).toEqual([[`personal/${LEAVER}/${P1}`]])
  })

  it('keeps the sign-in when the photos cannot be deleted, so Try again finishes the job', async () => {
    listFails = true
    const res = await act('deleteUser', { userId: LEAVER })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/^Their records were handed over, but their wardrobe photos could not be deleted, so the sign-in was kept: .*503.*\. Try again\.$/)
    expect(body.reassigned).toBe(3)
    expect(calls).not.toContain(`DELETE /auth/v1/admin/users/${LEAVER}`)
  })
})

describe('Admin → Data → Check now', () => {
  it('runs the canary for every kind, keeps the answer, and reports it in a sentence', async () => {
    const res = await act('runSyncCanary')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sentence).toBe(`The server accepted a test write for all ${SYNC_KINDS.size} kinds, just now.`)
    expect(body.record).toMatchObject({ ok: true, checked: SYNC_KINDS.size, failures: [], alertedAt: null })
    expect(stored).toEqual(body.record)
  })
})

describe('Today’s sync alarm reads the check as Admin → Data does', () => {
  const failing = {
    ok: false,
    checked: 18,
    failures: [{ kind: 'habit', reason: 'rejected' }],
    error: null,
    at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    failingSince: new Date(Date.now() - 50 * 3_600_000).toISOString(),
    alertedAt: null,
  }

  it('answers the stored record and Data’s own sentence, and runs nothing', async () => {
    canary = failing
    const res = await act('syncCheck')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ record: failing, sentence: 'The server refused a test write for habit (rejected), 3 hours ago. First seen 2 days ago.' })
    expect(calls).not.toContain('POST /rest/v1/rpc/sync_canary')
    expect(stored).toBeNull()
  })

  it('says none has run before the first', async () => {
    expect(await (await act('syncCheck')).json()).toEqual({ record: null, sentence: 'No sync check has run yet. The hourly digest runs one, or press Check now.' })
  })

  it('is the owner’s alone', async () => {
    canary = failing
    signedIn = 'someone@example.test'
    const res = await act('syncCheck')
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).not.toContain('habit')
  })

  it('fails, rather than saying none has run, when the record cannot be read', async () => {
    configDown = true
    expect((await act('syncCheck')).status).toBe(502)
  })
})

// The owner's digest, as Admin runs it, read every record in one request, and
// PostgREST answers at most max_rows (1000) a request: past that the digest it
// showed or sent was cut short. It now pages as the scheduled run does.
describe('Admin → the digest it runs reads every record, past a thousand', () => {
  const MAX_ROWS = 1000
  let ranges: string[]
  let rows: { user_id: string; data: Record<string, unknown> }[]

  beforeEach(() => {
    ranges = []
    rows = Array.from({ length: 1500 }, (_, i) => {
      const id = `t-${String(i).padStart(4, '0')}`
      const at = '2020-01-01T00:00:00.000Z'
      return { user_id: OWNER, data: { kind: 'task', id, title: `Chore ${i}`, description: '', status: 'todo', priority: 'normal', tags: [], dueAt: '2020-01-01T09:00:00.000Z', createdAt: at, updatedAt: at } }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input).replace(SUPABASE, '')
        if (url === '/auth/v1/user') return Response.json({ id: OWNER, email: signedIn })
        if (url.startsWith('/rest/v1/app_config?key=eq.owner_email')) return Response.json([{ value: 'owner@example.test' }])
        if (url.startsWith(`/rest/v1/user_settings?user_id=eq.${OWNER}&`)) return Response.json([{ user_id: OWNER, timezone: 'UTC' }])
        if (url === '/rest/v1/household_members?select=household_id,user_id') return Response.json([])
        if (url === '/rest/v1/rpc/owner_user_id') return Response.json(OWNER)
        if (url === '/rest/v1/posts?select=data,user_id&deleted=is.false&order=id.asc') {
          const range = new Headers(init?.headers).get('range') ?? ''
          ranges.push(range)
          const [from, to] = range.split('-').map(Number)
          if (from >= rows.length) return new Response(null, { status: 416 })
          return Response.json(rows.slice(from, Math.min(to + 1, from + MAX_ROWS)))
        }
        throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
      }),
    )
  })

  it('counts all 1,500 overdue tasks, a thousand a request', async () => {
    const res = await act('runDigest')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.counts.overdue).toBe(1500)
    expect(body.lines).toContainEqual(expect.stringMatching(/^1500 overdue: /))
    expect(ranges).toEqual(['0-999', '1000-1999'])
  })
})

// A second NVIDIA key, NVIDIA_API_KEY_2, is optional: either one alone means
// the ✨ features are set up, and the panel says how many there are, never
// what they are.
describe('Admin → status counts either NVIDIA key, and names neither', () => {
  beforeEach(() => {
    for (const key of ['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2', 'ANTHROPIC_API_KEY', 'AI_PROVIDER']) vi.stubEnv(key, '')
  })
  const aiStatus = async () => {
    const text = await (await act('status')).text()
    return { ai: JSON.parse(text).ai, text }
  }

  it('is set up with the second key alone', async () => {
    vi.stubEnv('NVIDIA_API_KEY_2', 'nvapi-second-secret')
    const { ai, text } = await aiStatus()
    expect(ai).toEqual({ configured: true, missing: [], nvidia: true, nvidiaKeys: 1, anthropic: false })
    expect(text).not.toContain('nvapi-second-secret')
  })

  it('counts two keys, one value under both names as one, and none as missing', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-main-secret')
    vi.stubEnv('NVIDIA_API_KEY_2', 'nvapi-second-secret')
    const both = await aiStatus()
    expect(both.ai).toMatchObject({ configured: true, nvidia: true, nvidiaKeys: 2 })
    expect(both.text).not.toMatch(/nvapi-(main|second)-secret/)
    vi.stubEnv('NVIDIA_API_KEY_2', 'nvapi-main-secret')
    expect((await aiStatus()).ai).toMatchObject({ nvidiaKeys: 1 })
    vi.stubEnv('NVIDIA_API_KEY', '')
    vi.stubEnv('NVIDIA_API_KEY_2', '')
    expect((await aiStatus()).ai).toEqual({ configured: false, missing: ['NVIDIA_API_KEY or ANTHROPIC_API_KEY'], nvidia: false, nvidiaKeys: 0, anthropic: false })
  })
})

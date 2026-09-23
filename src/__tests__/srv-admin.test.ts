import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNC_KINDS } from '../../shared/kinds.mts'
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

  it('deletes its pieces’ back photos with the rest, and keeps a back another piece still points at', async () => {
    // P1 was the back of one of its own pieces, deleted with them; P2 and P3 are the back of a piece handed over
    garmentRows = [
      { id: 'g-heir', user_id: OWNER, data: { kind: 'garment', id: 'g-heir', name: 'Band tee', type: 'top', backPhotoId: `personal/${LEAVER}/${P3}`, backThumbId: `personal/${LEAVER}/${P2}` } },
    ]
    listed = [
      { name: P1, id: 'o1' },
      { name: P2, id: 'o2' },
      { name: P3, id: 'o3' },
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

/** PostgREST's max_rows on Supabase: a page is never longer, whatever limit was asked for. */
const MAX_ROWS = 1000

/**
 * One page of `rows` as PostgREST answers restAll: the rows after the id it
 * carried on from, in id order, at most MAX_ROWS, and how many were left.
 */
function pageOf<T extends { id: string }>(url: string, rows: T[]) {
  const q = new URL(`https://x${url}`).searchParams
  const after = q.get('id')?.replace(/^gt\./, '') ?? null
  const left = rows.filter(r => after === null || r.id > after).sort((a, b) => (a.id < b.id ? -1 : 1))
  const page = left.slice(0, Math.min(Number(q.get('limit')), MAX_ROWS))
  return new Response(JSON.stringify(page), { headers: { 'content-range': page.length ? `0-${page.length - 1}/${left.length}` : `*/${left.length}` } })
}

/** Where a restAll read carried on from: null for its first page. */
const carriedOn = (url: string) => new URL(`https://x${url}`).searchParams.get('id')?.replace(/^gt\./, '') ?? null

// The owner's digest, as Admin runs it, read every record in one request, and
// PostgREST answers at most max_rows (1000) a request: past that the digest it
// showed or sent was cut short. It now reads a page at a time as the scheduled
// run does (restAll), and a page it can't read is an error: the offset pager it
// had first took any failure after the first page for the end of the records.
describe('Admin → the digest it runs reads every record, past a thousand', () => {
  /** Where each page of the read carried on from. */
  let pages: (string | null)[]
  let rows: { id: string; user_id: string; data: Record<string, unknown> }[]
  let laterPagesFail: boolean

  beforeEach(() => {
    pages = []
    laterPagesFail = false
    rows = Array.from({ length: 1500 }, (_, i) => {
      const id = `t-${String(i).padStart(4, '0')}`
      const at = '2020-01-01T00:00:00.000Z'
      return { id, user_id: OWNER, data: { kind: 'task', id, title: `Chore ${i}`, description: '', status: 'todo', priority: 'normal', tags: [], dueAt: '2020-01-01T09:00:00.000Z', createdAt: at, updatedAt: at } }
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
        if (url.startsWith('/rest/v1/posts?select=id,data,user_id&deleted=is.false&')) {
          const after = carriedOn(url)
          pages.push(after)
          if (after !== null && laterPagesFail) return Response.json({ message: 'canceling statement due to statement timeout' }, { status: 500 })
          return pageOf(url, rows)
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
    expect(pages).toEqual([null, 't-0999'])
  })

  it('answers an error, never a digest of the first thousand, when a later page cannot be read', async () => {
    laterPagesFail = true
    const res = await act('runDigest')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: expect.stringMatching(/^posts: 500 .*statement timeout/) })
    expect(pages).toEqual([null, 't-0999'])
  })
})

// Admin → Data answers "is my data still there?": a count cut short would say
// no when the answer is yes. It reads every row a page at a time, and a page
// it can't read is an error rather than a short count.
describe('Admin → Data counts every record, past a thousand, or says it could not', () => {
  let rows: { id: string; user_id: string; deleted: boolean; synced_at: string; kind: string; purged: string | null }[]
  let laterPagesFail: boolean

  beforeEach(() => {
    laterPagesFail = false
    rows = Array.from({ length: 1500 }, (_, i) => ({
      id: `r-${String(i).padStart(4, '0')}`,
      user_id: OWNER,
      deleted: i % 10 === 0,
      synced_at: '2026-09-14T08:00:00.000Z',
      kind: 'task',
      purged: null,
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input).replace(SUPABASE, '')
        const method = init?.method ?? 'GET'
        if (url === '/auth/v1/user') return Response.json({ id: OWNER, email: signedIn })
        if (url.startsWith('/rest/v1/app_config?key=eq.owner_email')) return Response.json([{ value: 'owner@example.test' }])
        if (url.startsWith('/auth/v1/admin/users?')) return Response.json({ users: [{ id: OWNER, email: 'owner@example.test' }] })
        // posts_history, households and household_members, counted without their rows
        if (method === 'HEAD') return new Response(null, { headers: { 'content-range': '0-0/3' } })
        if (url.startsWith('/rest/v1/app_config?key=eq.sync_canary')) return Response.json([])
        if (url.startsWith('/rest/v1/posts?select=id,user_id,deleted,synced_at,kind:data->>kind,purged:data->>purged&')) {
          if (carriedOn(url) !== null && laterPagesFail) return Response.json({ message: 'canceling statement due to statement timeout' }, { status: 500 })
          return pageOf(url, rows)
        }
        throw new Error(`unexpected ${method} ${url}`)
      }),
    )
  })

  it('counts all 1,500, a thousand a request', async () => {
    const res = await act('dataStats')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ total: 1500, live: 1350, tombstones: 150, historyRows: 3 })
    expect(body.kinds.task).toBe(1350)
    expect(body.users).toEqual([{ userId: OWNER, email: 'owner@example.test', live: 1350, deleted: 150 }])
  })

  it('answers an error, never the first thousand’s counts, when a later page cannot be read', async () => {
    laterPagesFail = true
    const res = await act('dataStats')
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/^posts: 500 .*statement timeout/)
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
    expect((await aiStatus()).ai).toEqual({ configured: false, missing: ['NVIDIA_API_KEY'], nvidia: false, nvidiaKeys: 0, anthropic: false })
  })

  it('counts a third key and on, and an Anthropic key only where AI_PROVIDER names it', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-main-secret')
    vi.stubEnv('NVIDIA_API_KEY_2', 'nvapi-second-secret')
    vi.stubEnv('NVIDIA_API_KEY_3', 'nvapi-third-secret')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret')
    const three = await aiStatus()
    expect(three.ai).toEqual({ configured: true, missing: [], nvidia: true, nvidiaKeys: 3, anthropic: false })
    expect(three.text).not.toMatch(/nvapi-(main|second|third)-secret|sk-ant-secret/)
    for (const name of ['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3']) vi.stubEnv(name, '')
    expect((await aiStatus()).ai).toMatchObject({ configured: false, missing: ['NVIDIA_API_KEY'], anthropic: false })
    vi.stubEnv('AI_PROVIDER', 'anthropic')
    expect((await aiStatus()).ai).toEqual({ configured: true, missing: [], nvidia: false, nvidiaKeys: 0, anthropic: true })
  })
})

// The second key goes first only for work nobody watches (Sunday's draft,
// email-in's triage), and a test the main key answers never shows that key is
// rejected. So with two, Test AI asks each key on its own as well, and says
// which one failed, by name.
describe('Admin → Test AI asks each NVIDIA key on its own', () => {
  const MAIN = 'nvapi-main-secret'
  const SECOND = 'nvapi-second-secret'
  /** Each NVIDIA call, by the key it carried. */
  let nvidia: string[]
  /** Keys NVIDIA answers 401. */
  let rejected: Set<string>

  beforeEach(() => {
    for (const key of ['ANTHROPIC_API_KEY', 'AI_PROVIDER', 'NVIDIA_MODEL']) vi.stubEnv(key, '')
    vi.stubEnv('NVIDIA_API_KEY', MAIN)
    vi.stubEnv('NVIDIA_API_KEY_2', SECOND)
    nvidia = []
    rejected = new Set()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input).replace(SUPABASE, '')
        if (url === '/auth/v1/user') return Response.json({ id: OWNER, email: signedIn })
        if (url.startsWith('/rest/v1/app_config?key=eq.owner_email')) return Response.json([{ value: 'owner@example.test' }])
        if (url === 'https://integrate.api.nvidia.com/v1/chat/completions') {
          const key = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '')
          nvidia.push(key === MAIN ? 'main' : key === SECOND ? 'second' : 'neither')
          if (rejected.has(key)) return Response.json({ error: { message: 'Unauthorized' } }, { status: 401 })
          return Response.json({ choices: [{ message: { content: 'ok' } }] })
        }
        throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
      }),
    )
  })

  it('asks once with one key, as before', async () => {
    vi.stubEnv('NVIDIA_API_KEY_2', '')
    expect(await (await act('testAi')).json()).toEqual({ ok: true, provider: 'nvidia', latencyMs: expect.any(Number), sample: 'ok', error: null })
    expect(nvidia).toEqual(['main'])
  })

  it('with two, asks each as well, and passes when both answer', async () => {
    const body = await (await act('testAi')).json()
    expect(body.ok).toBe(true)
    expect(body.keys).toEqual([
      { name: 'NVIDIA_API_KEY', ok: true, latencyMs: expect.any(Number), error: null },
      { name: 'NVIDIA_API_KEY_2', ok: true, latencyMs: expect.any(Number), error: null },
    ])
    expect(nvidia.sort()).toEqual(['main', 'main', 'second'])
  })

  it('fails on a second key NVIDIA rejects, though the main key answered, and names it, never its value', async () => {
    rejected.add(SECOND)
    const text = await (await act('testAi')).text()
    expect(JSON.parse(text)).toEqual({
      ok: false,
      provider: 'nvidia',
      latencyMs: expect.any(Number),
      sample: 'ok',
      error: null,
      keys: [
        { name: 'NVIDIA_API_KEY', ok: true, latencyMs: expect.any(Number), error: null },
        { name: 'NVIDIA_API_KEY_2', ok: false, latencyMs: expect.any(Number), error: 'NVIDIA rejected the API key — check NVIDIA_API_KEY_2 on the host.' },
      ],
    })
    expect(text).not.toMatch(/nvapi-(main|second)-secret/)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNC_KINDS } from '../../shared/kinds.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import adminFunction from '../../netlify/functions/admin.mjs'

// Deleting an account that owned a single row used to fail outright:
// posts.user_id is NOT NULL, and its foreign key is ON DELETE SET NULL. Admin
// now hands the records over (admin_prepare_user_deletion, db-smoke step 14)
// before it asks the auth server to delete the sign-in — never the other way.

const admin = adminFunction as (req: Request) => Promise<Response>
const SUPABASE = 'https://db.example.test'
const OWNER = '00000000-0000-0000-0000-00000000000a'
const LEAVER = '00000000-0000-0000-0000-00000000000d'

let calls: string[]
let prepareFails: boolean
let deleteFails: boolean
let stored: unknown

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  calls = []
  prepareFails = false
  deleteFails = false
  stored = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(SUPABASE, '')
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push(`${method} ${url.split('?')[0]}`)
      if (url === '/auth/v1/user') return Response.json({ id: OWNER, email: 'owner@example.test' })
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
      if (url.startsWith('/rest/v1/app_config?key=eq.sync_canary')) return Response.json([])
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
    expect(await res.json()).toEqual({ ok: true, email: 'leaving@example.test', reassigned: 3, deleted: 2, historyReassigned: 1, historyDeleted: 4 })
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

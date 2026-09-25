import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expireNotices, forgetNoticesStored } from '../../netlify/functions/lib/notices.mjs'
import { sanitizeItem } from '../schema'

// The nightly job lets the hub's notices go after thirty days, by the path
// "Delete forever" takes: each becomes a content-free tombstone written as its
// recipient (sync_posts_as, v3.34), so it stays theirs and every device of
// theirs drops it on its next round; the tombstone itself ages out with the
// rest. A database before v3.34 takes them through sync_posts, as before.

const SUPABASE = 'https://db.example.test'
const REST = `${SUPABASE}/rest/v1/`
const NOW = new Date('2026-10-24T03:00:00.000Z')

let reads: string[]
/** Each batch written, and the account it was written as ('site owner' through plain sync_posts). */
let sent: { as: string; items: Record<string, any>[] }[]
let stored: boolean
/** The database predates v3.34: PostgREST has no sync_posts_as. */
let writeAsMissing: boolean

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  forgetNoticesStored()
  reads = []
  sent = []
  stored = true
  writeAsMissing = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(REST.length)
      if (path === 'rpc/record_kind_allowed') return Response.json(stored)
      if (path.startsWith('posts?select=id,data,user_id&kind=eq.notice')) {
        reads.push(decodeURIComponent(path))
        return Response.json([
          { id: 'notice~u1~bins~1', user_id: 'u1', data: { kind: 'notice', id: 'notice~u1~bins~1', at: '2026-09-20T10:00:00.000Z', createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-21T08:00:00.000Z' } },
          { id: 'notice~u2~digest~2026-09-21', user_id: 'u2', data: { kind: 'notice', id: 'notice~u2~digest~2026-09-21', at: '2026-09-21T15:00:00.000Z', createdAt: '2026-09-21T15:00:00.000Z', updatedAt: '2026-09-21T15:00:00.000Z' } },
          { id: 'notice~u1~bins~2', user_id: 'u1', data: { kind: 'notice', id: 'notice~u1~bins~2', at: '2026-09-22T10:00:00.000Z', createdAt: '2026-09-22T10:00:00.000Z', updatedAt: '2026-09-22T10:00:00.000Z' } },
        ])
      }
      if (path === 'rpc/sync_posts_as' || path === 'rpc/sync_posts') {
        const body = JSON.parse(String(init?.body))
        if (path === 'rpc/sync_posts_as' && writeAsMissing) return Response.json({ code: 'PGRST202' }, { status: 404 })
        sent.push({ as: path === 'rpc/sync_posts_as' ? body.p_owner : 'site owner', items: body.incoming })
        return Response.json({ items: [], rejected: [], stale: ['notice~u2~digest~2026-09-21'], gone: [] })
      }
      throw new Error(`unexpected ${path}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('notices older than thirty days', () => {
  const tomb = (id: string, createdAt: string) => ({ kind: 'notice', id, deletedAt: NOW.toISOString(), purged: true, createdAt, updatedAt: NOW.toISOString() })

  it('are read by when they happened, and turned into tombstones written as each recipient', async () => {
    const n = await expireNotices(NOW)
    expect(reads).toEqual(['posts?select=id,data,user_id&kind=eq.notice&deleted=is.false&data->>at=lt.2026-09-24T03:00:00.000Z&order=id.asc&limit=1000'])
    expect(sent).toEqual([
      { as: 'u1', items: [tomb('notice~u1~bins~1', '2026-09-20T10:00:00.000Z'), tomb('notice~u1~bins~2', '2026-09-22T10:00:00.000Z')] },
      { as: 'u2', items: [tomb('notice~u2~digest~2026-09-21', '2026-09-21T15:00:00.000Z')] },
    ])
    // one lost to a newer edit waits for the next night
    expect(n).toBe(2)
  })

  it('on a database before v3.34, through sync_posts as before', async () => {
    writeAsMissing = true
    expect(await expireNotices(NOW)).toBe(2)
    expect(sent.map(b => [b.as, b.items.map(t => t.id)])).toEqual([
      ['site owner', ['notice~u1~bins~1', 'notice~u1~bins~2']],
      ['site owner', ['notice~u2~digest~2026-09-21']],
    ])
  })

  it('each tombstone is one a device takes, and drops the notice for', async () => {
    await expireNotices(NOW)
    for (const t of sent.flatMap(b => b.items)) expect(sanitizeItem(t)).toMatchObject({ kind: 'notice', id: t.id, deletedAt: NOW.toISOString(), purged: true })
  })

  it('nothing to let go before the database stores notices', async () => {
    stored = false
    expect(await expireNotices(NOW)).toBe(0)
    expect(reads).toEqual([])
  })
})

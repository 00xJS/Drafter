import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expireNotices, forgetNoticesStored } from '../../netlify/functions/lib/notices.mjs'
import { sanitizeItem } from '../schema'

// The nightly job lets the hub's notices go after thirty days, by the path
// "Delete forever" takes: each becomes a content-free tombstone written
// through sync_posts, so it stays its recipient's and every device of theirs
// drops it on its next round; the tombstone itself ages out with the rest.

const SUPABASE = 'https://db.example.test'
const REST = `${SUPABASE}/rest/v1/`
const NOW = new Date('2026-10-24T03:00:00.000Z')

let reads: string[]
let sent: Record<string, any>[][]
let stored: boolean

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  forgetNoticesStored()
  reads = []
  sent = []
  stored = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(REST.length)
      if (path === 'rpc/record_kind_allowed') return Response.json(stored)
      if (path.startsWith('posts?select=id,data&kind=eq.notice')) {
        reads.push(decodeURIComponent(path))
        return Response.json([
          { id: 'notice~u1~bins~1', data: { kind: 'notice', id: 'notice~u1~bins~1', at: '2026-09-20T10:00:00.000Z', createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-21T08:00:00.000Z' } },
          { id: 'notice~u2~digest~2026-09-21', data: { kind: 'notice', id: 'notice~u2~digest~2026-09-21', at: '2026-09-21T15:00:00.000Z', createdAt: '2026-09-21T15:00:00.000Z', updatedAt: '2026-09-21T15:00:00.000Z' } },
        ])
      }
      if (path === 'rpc/sync_posts') {
        const body = JSON.parse(String(init?.body))
        sent.push(body.incoming)
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
  it('are read by when they happened, and turned into tombstones through sync_posts', async () => {
    const n = await expireNotices(NOW)
    expect(reads).toEqual(['posts?select=id,data&kind=eq.notice&deleted=is.false&data->>at=lt.2026-09-24T03:00:00.000Z&order=id.asc&limit=1000'])
    expect(sent).toEqual([
      [
        { kind: 'notice', id: 'notice~u1~bins~1', deletedAt: NOW.toISOString(), purged: true, createdAt: '2026-09-20T10:00:00.000Z', updatedAt: NOW.toISOString() },
        { kind: 'notice', id: 'notice~u2~digest~2026-09-21', deletedAt: NOW.toISOString(), purged: true, createdAt: '2026-09-21T15:00:00.000Z', updatedAt: NOW.toISOString() },
      ],
    ])
    // one lost to a newer edit waits for the next night
    expect(n).toBe(1)
  })

  it('each tombstone is one a device takes, and drops the notice for', async () => {
    await expireNotices(NOW)
    for (const t of sent[0]) expect(sanitizeItem(t)).toMatchObject({ kind: 'notice', id: t.id, deletedAt: NOW.toISOString(), purged: true })
  })

  it('nothing to let go before the database stores notices', async () => {
    stored = false
    expect(await expireNotices(NOW)).toBe(0)
    expect(reads).toEqual([])
  })
})

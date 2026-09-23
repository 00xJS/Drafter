import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOMBSTONE_TTL_MS, purgeExpiredTrash, runBackup } from '../../netlify/functions/lib/backup.mjs'
import { tombstoneFor } from '../../shared/tombstone.mts'
import { sanitizeItem } from '../schema'
import { purgeTombstone } from '../sync'

// The Trash says an item disappears for good after 90 days, and on every
// device it does — but the server kept the row, content and all, for good,
// and a full exchange downloaded it again. The nightly job now turns a row
// deleted more than 90 days ago into the content-free tombstone "Delete
// forever" writes, so the existing hard delete and purge ledger finish it.
// The server is a stand-in here.

const SUPABASE = 'https://db.example.test'
const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const NOW = new Date('2026-09-14T03:00:00.000Z')
/** Before NOW minus 90 days (16 June). */
const OLD = '2026-05-01T00:00:00.000Z'
const OLDER = '2026-04-01T00:00:00.000Z'
const RECENT = '2026-09-01T00:00:00.000Z'

type Row = { id: string; user_id: string; updated_at: string; synced_at: string; data: Record<string, unknown> }
let posts: Row[]
let history: { id: string; data: Record<string, unknown> }[]
let calls: string[]
/** Runs as a PATCH arrives, before it is applied: where a device writes meanwhile. */
let beforePatch: ((id: string) => void) | null

const row = (id: string, user: string, data: Record<string, unknown>, updatedAt = (data.deletedAt as string) ?? OLD): Row => ({
  id,
  user_id: user,
  updated_at: updatedAt,
  synced_at: updatedAt,
  data: { id, createdAt: OLDER, updatedAt, ...data },
})

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  calls = []
  beforePatch = null
  posts = [
    row('old-task', A, { kind: 'task', title: 'Secret plan', description: 'Every detail', status: 'todo', priority: 'normal', tags: ['x'], shared: false, deletedAt: OLD }),
    row('old-note', B, { kind: 'note', title: 'Diary', body: '<p>Dear diary</p>', shared: true, deletedAt: OLDER }),
    row('legacy-post', A, { title: 'Old social post', status: 'posted', deletedAt: OLD }),
    row('recent', A, { kind: 'task', title: 'Still in the Trash', status: 'todo', priority: 'normal', tags: [], deletedAt: RECENT }),
    row('live', A, { kind: 'task', title: 'Live', status: 'todo', priority: 'normal', tags: [] }, OLD),
    row('purged', A, { kind: 'task', title: '', description: '', status: 'canceled', priority: 'normal', tags: [], purged: true, deletedAt: OLD }),
  ]
  history = [
    { id: 'old-task', data: { title: 'An earlier secret plan' } },
    { id: 'live', data: { title: 'Earlier live' } },
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = decodeURIComponent(String(input).replace(SUPABASE, ''))
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      const q = new URL(`https://x${url}`).searchParams
      if (method === 'GET' && url.startsWith('/rest/v1/posts?select=id,user_id,updated_at,data&deleted=eq.true&data->>purged=is.null&data->>deletedAt=lt.')) {
        const cutoff = q.get('data->>deletedAt')!.replace(/^lt\./, '')
        const after = q.get('id')?.replace(/^gt\./, '') ?? null
        const left = posts
          .filter(p => typeof p.data.deletedAt === 'string' && p.data.purged == null && (p.data.deletedAt as string) < cutoff)
          .filter(p => after === null || p.id > after)
          .sort((x, y) => (x.id < y.id ? -1 : 1))
        const page = left.slice(0, Number(q.get('limit'))).map(({ id, user_id, updated_at, data }) => ({ id, user_id, updated_at, data }))
        return new Response(JSON.stringify(page), { headers: { 'content-range': page.length ? `0-${page.length - 1}/${left.length}` : `*/${left.length}` } })
      }
      if (method === 'PATCH' && url.startsWith('/rest/v1/posts?id=eq.')) {
        const id = q.get('id')!.replace(/^eq\./, '')
        beforePatch?.(id)
        const p = posts.find(x => x.id === id && x.updated_at === q.get('updated_at')!.replace(/^eq\./, ''))
        if (p) {
          const body = JSON.parse(String(init!.body))
          // enforce_lww: a write that is not strictly newer is refused
          if (!(body.updated_at > p.updated_at)) return new Response('{"message":"stale write rejected"}', { status: 400 })
          // posts_history_capture: the version a write replaces is kept
          history.push({ id, data: p.data })
          Object.assign(p, { data: body.data, updated_at: body.updated_at, synced_at: body.synced_at })
        }
        return new Response(null, { status: 204, headers: { 'content-range': `*/${p ? 1 : 0}` } })
      }
      if (method === 'DELETE' && url.startsWith('/rest/v1/posts_history?id=in.(')) {
        const ids = url.slice(url.indexOf('in.(') + 4, -1).split(',').map(s => s.replace(/^"|"$/g, ''))
        history = history.filter(h => !ids.includes(h.id))
        return new Response(null, { status: 204 })
      }
      // everything else runBackup does, answered as the photo sweep's own tests do
      if (method === 'GET' && url.startsWith('/rest/v1/posts?select=id,data,user_id&deleted=is.false')) return new Response('[]', { headers: { 'content-range': '*/0' } })
      if (method === 'GET' && url.startsWith('/rest/v1/posts?select=id,user_id,data&kind=eq.garment')) return new Response('[]', { headers: { 'content-range': '*/0' } })
      if (method === 'DELETE') return new Response(null, { status: 204, headers: { 'content-range': '*/0' } })
      if (method === 'POST' && url === '/storage/v1/object/list/media') return Response.json([])
      throw new Error(`unexpected ${method} ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const byId = (id: string) => posts.find(p => p.id === id)!

describe('purgeExpiredTrash', () => {
  it('turns a row deleted over 90 days ago into the tombstone Delete forever writes: nothing of what it said is left', async () => {
    expect(await purgeExpiredTrash(NOW)).toBe(3)
    const task = byId('old-task')
    // strictly newer, and moved for the delta every device pulls
    expect(task.updated_at > OLD).toBe(true)
    expect(task.synced_at > OLD).toBe(true)
    expect(task.data).toEqual(tombstoneFor({ kind: 'task', id: 'old-task', shared: false }, task.updated_at, OLD))
    expect(task.data).toMatchObject({ purged: true, deletedAt: OLD, title: '', shared: false })
    expect(JSON.stringify(task.data)).not.toMatch(/Secret|detail/)
    // the same owner: nothing moves between accounts
    expect(task.user_id).toBe(A)
    // a shared note stays shared, so the housemate's copy is withdrawn by the tombstone, not by a policy refusal
    expect(byId('old-note').data).toMatchObject({ kind: 'note', purged: true, shared: true, title: '', body: '' })
    expect(byId('old-note').user_id).toBe(B)
    // a row with no kind is a task, as sync_posts reads it
    expect(byId('legacy-post').data).toMatchObject({ kind: 'task', purged: true, title: '' })
  })

  it('leaves alone what is still in its 90 days, what is live, and what was deleted forever already', async () => {
    const before = JSON.stringify(['recent', 'live', 'purged'].map(byId))
    await purgeExpiredTrash(NOW)
    expect(JSON.stringify(['recent', 'live', 'purged'].map(byId))).toBe(before)
  })

  it('takes the versions the history kept of an emptied row with it, and no one else’s', async () => {
    await purgeExpiredTrash(NOW)
    expect(history.map(h => h.id)).toEqual(['live'])
  })

  it('leaves a row restored meanwhile as the device left it', async () => {
    beforePatch = id => {
      if (id !== 'old-task') return
      const p = byId('old-task')
      p.data = { ...p.data, deletedAt: undefined, title: 'Brought back', updatedAt: '2026-09-14T02:59:00.000Z' }
      p.updated_at = '2026-09-14T02:59:00.000Z'
    }
    expect(await purgeExpiredTrash(NOW)).toBe(2)
    expect(byId('old-task').data).toMatchObject({ title: 'Brought back' })
  })

  it('does the longest there first, a night’s share at a time', async () => {
    expect(await purgeExpiredTrash(NOW, 1)).toBe(1)
    expect(byId('old-note').data.purged).toBe(true)
    expect(byId('old-task').data.purged).toBeUndefined()
  })

  it('writes what every device takes as a tombstone', async () => {
    await purgeExpiredTrash(NOW)
    for (const id of ['old-task', 'old-note', 'legacy-post']) expect(sanitizeItem(byId(id).data), id).toMatchObject({ id, purged: true })
    // and it is the app's own: one rule for both
    expect(purgeTombstone('note', 'n', RECENT)).toEqual(tombstoneFor({ kind: 'note', id: 'n' }, RECENT))
  })

  it('is null, touching nothing, when the Trash cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"down"}', { status: 503 })))
    expect(await purgeExpiredTrash(NOW)).toBeNull()
  })
})

describe('runBackup', () => {
  it('empties the Trash before the hard delete, which leaves those for their own 90 days, and says how many', async () => {
    const report = await runBackup(NOW)
    expect(report.trashEmptied).toBe(3)
    const emptied = calls.findIndex(c => c.startsWith('PATCH /rest/v1/posts?id=eq.'))
    const hardDelete = calls.findIndex(c => c.startsWith('DELETE /rest/v1/posts?deleted=eq.true'))
    expect(emptied).toBeGreaterThan(-1)
    expect(hardDelete).toBeGreaterThan(emptied)
    // stamped now: the hard delete's cutoff (updated_at older than 90 days) is nowhere near
    expect(Date.parse(byId('old-task').updated_at)).toBeGreaterThan(NOW.getTime() - TOMBSTONE_TTL_MS)
  })
})

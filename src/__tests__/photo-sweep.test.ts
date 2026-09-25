import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { garmentMediaIds, isPersonalMediaOf, mediaIdsOf, personalFolder } from '../../shared/media.mts'
import { PHOTO_GRACE_MS, TOMBSTONE_TTL_MS, TRASH_KEEPS_PHOTOS_MS, photosToSweep, restAll, runBackup, sweepPersonalPhotos } from '../../netlify/functions/lib/backup.mjs'
import { unwrapSnapshot } from '../backupcrypto'
import { pageOf as postgrestPage } from './postgrest'

// Wardrobe photos are private, under personal/<user id>/ in the media bucket,
// and nothing used to clear them out: a replaced photo, a piece aged out of
// Trash or deleted forever all left theirs behind. These pin the rule both
// sides share (shared/media.mts) and the nightly sweep that runs with the
// tombstone purge (netlify/functions/lib/backup.mjs): a photo goes only when it
// is that account's own, no piece of clothing, live or in Trash, points at it,
// and it is as old as a tombstone is kept. Note photos, task images and the
// backups/ snapshots are never touched. The server is a stand-in here.

const SUPABASE = 'https://db.example.test'
const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const C = '00000000-0000-0000-0000-00000000000c'
const NOW = new Date('2026-09-14T03:00:00.000Z')
/** Before NOW minus 90 days (16 June). */
const OLD = '2026-05-01T00:00:00.000Z'
const RECENT = '2026-09-01T00:00:00.000Z'
/** A uuid the media store could have made: n repeated, 1–9. */
const uid = (n: number) => `${`${n}`.repeat(8)}-${`${n}`.repeat(4)}-4${`${n}`.repeat(3)}-8${`${n}`.repeat(3)}-${`${n}`.repeat(12)}`
const photo = (user: string, n: number) => `personal/${user}/${uid(n)}`

type Row = { id: string; user_id: string; deleted: boolean; data: Record<string, unknown> }
const garment = (id: string, user: string, extra: Record<string, unknown> = {}): Row => ({
  id,
  user_id: user,
  deleted: !!extra.deletedAt,
  data: { kind: 'garment', id, name: id, type: 'top', createdAt: OLD, updatedAt: OLD, ...extra },
})

let posts: Row[]
let objects: Map<string, { updated_at?: string; created_at?: string }>
let calls: string[]
/** PostgREST's max_rows: a page is never longer, whatever limit was asked for. */
let maxRows: number
/** Every page after the first fails, as a read that times out part-way does. */
let laterPagesFail: boolean
let garmentsFail: boolean
let listFails: string | null
/** Each snapshot runBackup wrote, by its path in the bucket. */
let snapshots: Map<string, { exportedAt: string; userId: string; items: { id: string }[] }>

/**
 * One page of `rows` as PostgREST answers restAll: the rows after the id it
 * carried on from, in id order, never more than maxRows — or, with
 * laterPagesFail, a statement timeout for any page but the first.
 */
function pageOf(url: string, rows: Row[]) {
  if (laterPagesFail && new URL(`https://x${url}`).searchParams.has('id')) return Response.json({ message: 'canceling statement due to statement timeout' }, { status: 500 })
  return Response.json(postgrestPage(url, rows, maxRows).map(({ id, user_id, data }) => ({ id, user_id, data })))
}

/** What the storage list endpoint answers for a prefix: its objects, and a null-id entry per folder under it. */
function listUnder(prefix: string) {
  const files: { name: string; id: string | null; updated_at: string | null; created_at: string | null }[] = []
  const folders = new Set<string>()
  for (const [path, o] of objects) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    if (rest.includes('/')) folders.add(rest.slice(0, rest.indexOf('/')))
    else files.push({ name: rest, id: `obj:${path}`, updated_at: o.updated_at ?? null, created_at: o.created_at ?? null })
  }
  return [...[...folders].map(name => ({ name, id: null, updated_at: null, created_at: null })), ...files].sort((a, b) => a.name.localeCompare(b.name))
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  calls = []
  maxRows = 1000
  laterPagesFail = false
  garmentsFail = false
  listFails = null
  snapshots = new Map()
  posts = [
    garment('g-live', A, { photoId: photo(A, 1), thumbId: photo(A, 2) }),
    garment('g-trash', A, { photoId: photo(A, 3), deletedAt: RECENT }),
    garment('g-expired', A, { photoId: photo(A, 4), deletedAt: OLD }),
    garment('g-purged', A, { deletedAt: RECENT, purged: true }),
    garment('g-b', B, { photoId: photo(B, 6) }),
    // another account's piece pointing into A's folder still counts
    garment('g-b2', B, { photoId: `personal/${A}/${uid(9)}` }),
    { id: 'n-note', user_id: A, deleted: false, data: { kind: 'note', id: 'n-note', title: 'Paint', body: `<img data-media="${uid(5)}">`, createdAt: OLD, updatedAt: OLD } },
  ]
  objects = new Map([
    [photo(A, 1), { updated_at: OLD, created_at: OLD }],
    [photo(A, 2), { updated_at: OLD, created_at: OLD }],
    [photo(A, 3), { updated_at: OLD, created_at: OLD }],
    [photo(A, 4), { updated_at: OLD, created_at: OLD }],
    // replaced long ago, and nothing points at it now
    [photo(A, 5), { updated_at: OLD, created_at: OLD }],
    // just uploaded: its piece may not have reached the server yet
    [photo(A, 7), { updated_at: RECENT, created_at: OLD }],
    // times that can't be read
    [photo(A, 8), {}],
    [`personal/${A}/${uid(9)}`, { updated_at: OLD, created_at: OLD }],
    [`personal/${A}/nested/${uid(1)}`, { updated_at: OLD, created_at: OLD }],
    [`personal/${A}/short`, { updated_at: OLD, created_at: OLD }],
    [photo(B, 6), { updated_at: OLD, created_at: OLD }],
    [photo(B, 7), { updated_at: OLD, created_at: OLD }],
    // C's pieces never reached the server: its folder is left alone
    [photo(C, 1), { updated_at: OLD, created_at: OLD }],
    [`backups/${A}/2026-06-01.json`, { updated_at: OLD, created_at: OLD }],
    [uid(5), { updated_at: OLD, created_at: OLD }],
  ])
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(SUPABASE, '')
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push(`${method} ${decodeURIComponent(url)}${body?.prefix ? ` ${body.prefix}` : ''}`)
      // every live record, as runBackup reads them for the snapshots
      if (method === 'GET' && url.startsWith('/rest/v1/posts?select=id,data,user_id&deleted=is.false')) return pageOf(url, posts.filter(p => !p.deleted))
      if (method === 'GET' && url.startsWith('/rest/v1/posts?select=id,user_id,data&kind=eq.garment')) {
        if (garmentsFail) return new Response('{"message":"boom"}', { status: 500 })
        return pageOf(url, posts.filter(p => p.data.kind === 'garment'))
      }
      if (method === 'POST' && url === '/storage/v1/object/list/media') {
        if (listFails && body.prefix === personalFolder(listFails)) return new Response('{"message":"storage is down"}', { status: 503 })
        return Response.json(listUnder(body.prefix).slice(body.offset ?? 0, (body.offset ?? 0) + body.limit))
      }
      if (method === 'POST' && url.startsWith('/storage/v1/object/media/backups/')) {
        const path = url.slice('/storage/v1/object/media/'.length)
        objects.set(path, { updated_at: NOW.toISOString(), created_at: NOW.toISOString() })
        snapshots.set(path, body)
        return Response.json({ Key: url })
      }
      if (method === 'DELETE' && url === '/storage/v1/object/media') {
        const gone = (body.prefixes as string[]).filter(p => objects.delete(p))
        return Response.json(gone.map(name => ({ name })))
      }
      if (method === 'DELETE' && url.startsWith('/rest/v1/posts_history')) return new Response(null, { status: 204, headers: { 'content-range': '*/0' } })
      if (method === 'DELETE' && url.startsWith('/rest/v1/posts?deleted=eq.true')) return new Response(null, { status: 204, headers: { 'content-range': '*/1' } })
      throw new Error(`unexpected ${method} ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('the shared rule: whose photo, and what still points at it', () => {
  it('knows an account’s own photo from everything else in the bucket', () => {
    expect(personalFolder(A)).toBe(`personal/${A}/`)
    expect(isPersonalMediaOf(photo(A, 1), A)).toBe(true)
    for (const other of [uid(1), photo(B, 1), `backups/${A}/2026-09-13.json`, `personal/${A}/nested/${uid(1)}`, `personal/${A}/../${uid(1)}`, `personal/${A}/`, `personal/${A}/short`, 42, null]) {
      expect(isPersonalMediaOf(other, A), String(other)).toBe(false)
    }
    // no account, no photo of theirs
    expect(isPersonalMediaOf(photo(A, 1), null)).toBe(false)
    expect(isPersonalMediaOf('personal/x/12345678', 'x')).toBe(false)
  })

  it('counts a live piece’s photos and one’s in Trash, never a piece deleted forever or anything else', () => {
    const ids = garmentMediaIds(posts.map(p => p.data))
    expect([...ids].sort()).toEqual([photo(A, 1), photo(A, 2), photo(A, 3), photo(A, 4), `personal/${A}/${uid(9)}`, photo(B, 6)].sort())
  })

  it('with a cutoff, stops counting a piece that left every Trash before it, and still counts one whose deletion can’t be read', () => {
    const cutoff = new Date(NOW.getTime() - TOMBSTONE_TTL_MS).toISOString()
    const ids = garmentMediaIds([...posts.map(p => p.data), { kind: 'garment', photoId: 'personal/odd', deletedAt: 'last spring' }], { expiredBefore: cutoff })
    expect(ids.has(photo(A, 4))).toBe(false)
    expect(ids.has(photo(A, 3))).toBe(true)
    expect(ids.has('personal/odd')).toBe(true)
  })

  it('sweeps a photo only when it is the account’s own, unpointed at and old enough — or at any age, for a deleted account', () => {
    const listed = [
      { name: uid(5), id: 'o5', updated_at: OLD, created_at: OLD },
      { name: uid(7), id: 'o7', updated_at: RECENT, created_at: OLD },
      { name: uid(8), id: 'o8' },
      { name: uid(1), id: 'o1', updated_at: OLD, created_at: OLD },
      { name: 'nested', id: null },
      { name: 'short', id: 'os', updated_at: OLD, created_at: OLD },
    ]
    const inUse = new Set([photo(A, 1)])
    expect(photosToSweep(A, listed, inUse, '2026-06-16T03:00:00.000Z')).toEqual([photo(A, 5)])
    expect(photosToSweep(A, listed, inUse, null)).toEqual([photo(A, 5), photo(A, 7), photo(A, 8)])
    expect(photosToSweep('not-an-account', listed, inUse, null)).toEqual([])
  })

  it('waits as long as a tombstone is kept, and counts a piece in Trash a month longer than any device keeps it there', () => {
    expect(PHOTO_GRACE_MS).toBe(TOMBSTONE_TTL_MS)
    expect(TRASH_KEEPS_PHOTOS_MS).toBe(TOMBSTONE_TTL_MS + 30 * 86_400_000)
  })
})

// A piece can carry a photo of its back too (a shirt whose logo is there):
// the same shape, under the same folder, and every clean-up reads it from
// the one list, mediaIdsOf, so the back is never the side one forgets.
describe('a piece’s back photo', () => {
  /** A back photo's id: a uid the media store could have made, apart from the fixtures' fronts. */
  const backOf = (user: string, n: number) => `personal/${user}/b${String(n).repeat(7)}-back`

  it('is one of the photos a piece points at, after its front', () => {
    const g = { photoId: photo(A, 1), thumbId: photo(A, 2), backPhotoId: backOf(A, 1), backThumbId: backOf(A, 2) }
    expect(mediaIdsOf(g)).toEqual([photo(A, 1), photo(A, 2), backOf(A, 1), backOf(A, 2)])
    expect(mediaIdsOf({ backPhotoId: backOf(A, 3), thumbId: '' })).toEqual([backOf(A, 3)])
    expect(mediaIdsOf(null)).toEqual([])
    const ids = garmentMediaIds([
      { kind: 'garment', backPhotoId: backOf(A, 1), backThumbId: backOf(A, 2), deletedAt: RECENT },
      { kind: 'garment', purged: true, backPhotoId: backOf(A, 3) },
      { kind: 'note', backPhotoId: backOf(A, 4) },
    ])
    expect([...ids].sort()).toEqual([backOf(A, 1), backOf(A, 2)])
  })

  it('is kept while a live piece, or one in Trash, points at it, and swept once the piece is deleted forever', async () => {
    posts.push(garment('g-band', A, { photoId: photo(A, 1), backPhotoId: backOf(A, 1), backThumbId: backOf(A, 2) }))
    posts.push(garment('g-coat', A, { backPhotoId: backOf(A, 3), backThumbId: backOf(A, 4), deletedAt: RECENT }))
    for (const n of [1, 2, 3, 4]) objects.set(backOf(A, n), { updated_at: OLD, created_at: OLD })
    // the fixtures' usual three, and no back
    expect(await sweepPersonalPhotos(NOW)).toEqual({ deleted: 3, failures: [] })
    for (const n of [1, 2, 3, 4]) expect(objects.has(backOf(A, n)), `back ${n}`).toBe(true)
    // Delete forever on the band tee: its tombstone points at nothing
    const band = posts.find(p => p.id === 'g-band')!
    band.deleted = true
    band.data = { kind: 'garment', id: 'g-band', name: '', type: 'top', purged: true, deletedAt: RECENT, createdAt: OLD, updatedAt: RECENT }
    expect(await sweepPersonalPhotos(NOW)).toEqual({ deleted: 2, failures: [] })
    expect(objects.has(backOf(A, 1)) || objects.has(backOf(A, 2))).toBe(false)
    // the front it shared with a live piece stays, and so does the coat in Trash's back
    expect(objects.has(photo(A, 1))).toBe(true)
    expect(objects.has(backOf(A, 3)) && objects.has(backOf(A, 4))).toBe(true)
  })
})

describe('restAll: every row, or a throw', () => {
  it('reads past a max_rows cap shorter than the page it asked for, carrying on after the last id', async () => {
    maxRows = 2
    const rows = await restAll('posts?select=id,user_id,data&kind=eq.garment')
    expect(rows.map(r => r.id)).toEqual(['g-b', 'g-b2', 'g-expired', 'g-live', 'g-purged', 'g-trash'])
    // three pages of two, and a fourth, empty, that says the third was the last
    expect(calls.filter(c => c.startsWith('GET /rest/v1/posts')).length).toBe(4)
    expect(calls[1]).toContain('&id=gt.g-b2&')
    // carried on at the size the server answered with
    expect(calls[1]).toContain('&limit=2')
  })

  it('asks for no count, and ends at a page shorter than a full one', async () => {
    const asked: (string | null)[] = []
    const answer = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      asked.push(new Headers(init?.headers).get('prefer'))
      return answer(input, init)
    })
    // a short first page could be the server's cap: one more read says it was the end
    expect(await restAll('posts?select=id,user_id,data&kind=eq.garment')).toHaveLength(6)
    expect(calls.filter(c => c.startsWith('GET /rest/v1/posts'))).toEqual([
      'GET /rest/v1/posts?select=id,user_id,data&kind=eq.garment&order=id.asc&limit=1000',
      'GET /rest/v1/posts?select=id,user_id,data&kind=eq.garment&id=gt.g-trash&order=id.asc&limit=6',
    ])
    expect(asked).toEqual([null, null])
    // after a full page, a short one is the end at once
    calls.length = 0
    expect(await restAll('posts?select=id,user_id,data&kind=eq.garment', 4)).toHaveLength(6)
    expect(calls.filter(c => c.startsWith('GET /rest/v1/posts'))).toHaveLength(2)
  })

  it('refuses an answer that is not a list of rows, and a page that does not carry on', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => Response.json({ message: 'not rows' }))
    await expect(restAll('posts?select=id,user_id,data&kind=eq.garment')).rejects.toThrow(/did not answer with rows/)
    // a server that ignores where the read carried on from answers the same page again
    vi.mocked(fetch).mockImplementation(async () => Response.json([{ id: 'g-1' }, { id: 'g-2' }]))
    await expect(restAll('posts?select=id,user_id,data&kind=eq.garment')).rejects.toThrow(/did not carry on after the last row/)
  })
})

describe('sweepPersonalPhotos: the nightly pass', () => {
  it('keeps a piece’s photos for a month past its 90 days in Trash, for a Restore that arrives late, and lets them go after', async () => {
    // deleted 100 days ago: a device offline since just before day 90 may have restored it and not sent that yet
    posts.push(garment('g-late', A, { photoId: photo(A, 6), deletedAt: '2026-06-06T00:00:00.000Z' }))
    objects.set(photo(A, 6), { updated_at: OLD, created_at: OLD })
    expect((await sweepPersonalPhotos(NOW)).deleted).toBe(3)
    expect(objects.has(photo(A, 6))).toBe(true)
    // 126 days on, the month is over
    expect(await sweepPersonalPhotos(new Date('2026-10-10T03:00:00.000Z'))).toEqual({ deleted: 1, failures: [] })
    expect(objects.has(photo(A, 6))).toBe(false)
  })

  it('deletes what nothing points at — replaced, aged out of Trash — once old enough, and keeps everything else', async () => {
    const before = new Set(objects.keys())
    expect(await sweepPersonalPhotos(NOW)).toEqual({ deleted: 3, failures: [] })
    const gone = [...before].filter(p => !objects.has(p)).sort()
    expect(gone).toEqual([photo(A, 4), photo(A, 5), photo(B, 7)].sort())
    // C holds no piece on the server: its folder is never even listed
    expect(calls.some(c => c.endsWith(personalFolder(C)))).toBe(false)
    expect(objects.has(`backups/${A}/2026-06-01.json`) && objects.has(uid(5))).toBe(true)
  })

  it('reads every piece even when the server hands them over two at a time', async () => {
    maxRows = 2
    expect((await sweepPersonalPhotos(NOW)).deleted).toBe(3)
    expect(objects.has(photo(A, 1)) && objects.has(photo(B, 6)) && objects.has(`personal/${A}/${uid(9)}`)).toBe(true)
  })

  it('deletes nothing when the pieces cannot all be read', async () => {
    laterPagesFail = true
    const before = objects.size
    await expect(sweepPersonalPhotos(NOW)).rejects.toThrow()
    expect(objects.size).toBe(before)
    expect(calls.some(c => c.startsWith('DELETE /storage'))).toBe(false)
  })

  it('carries on past an account whose folder cannot be listed, and says so', async () => {
    listFails = A
    const { deleted, failures } = await sweepPersonalPhotos(NOW)
    expect(deleted).toBe(1)
    expect(objects.has(photo(B, 7))).toBe(false)
    expect(objects.has(photo(A, 5))).toBe(true)
    expect(failures).toEqual([expect.stringMatching(new RegExp(`^photos of ${A}: storage /object/list/media: 503`))])
  })
})

describe('runBackup: the sweep rides with the tombstone purge', () => {
  it('reports the photos deleted, and sweeps before the tombstones go', async () => {
    const report = await runBackup(NOW)
    expect(report.photosDeleted).toBe(3)
    expect(report.tombstonesPurged).toBe(1)
    expect(report.failures).toEqual([])
    const read = calls.findIndex(c => c.startsWith('GET /rest/v1/posts?select=id,user_id,data&kind=eq.garment'))
    const purge = calls.findIndex(c => c.startsWith('DELETE /rest/v1/posts?deleted=eq.true'))
    expect(read).toBeGreaterThan(-1)
    expect(purge).toBeGreaterThan(read)
  })

  it('still writes the snapshots and purges the tombstones when the sweep cannot run', async () => {
    garmentsFail = true
    const report = await runBackup(NOW)
    expect(report.photosDeleted).toBeNull()
    expect(report.users.map(u => u.userId).sort()).toEqual([A, B])
    expect(report.tombstonesPurged).toBe(1)
    expect(report.failures).toEqual([expect.stringMatching(/^photos: posts: 500/)])
  })
})

// The nightly snapshot read every live record in one request, and PostgREST
// answers at most max_rows (1000) a request: an account past that was backed
// up short, and the snapshot looked whole. It now reads a page at a time.
describe('runBackup reads every live record, however many there are', () => {
  const task = (n: number): Row => {
    const id = `t-${String(n).padStart(5, '0')}`
    return { id, user_id: A, deleted: false, data: { kind: 'task', id, title: `Chore ${n}`, status: 'todo', createdAt: OLD, updatedAt: OLD } }
  }

  it('pages past max_rows, and the snapshot keeps its shape', async () => {
    // the shape of an UNencrypted snapshot: this host holds no
    // BACKUP_PASSPHRASE (src/__tests__/setup.ts decides that, rather than
    // leaving it to whichever machine is running — Netlify's build carries the
    // real one, which is how this assertion first failed in production)
    expect(process.env.BACKUP_PASSPHRASE).toBeUndefined()
    posts.push(...Array.from({ length: 2345 }, (_, n) => task(n)))
    const report = await runBackup(NOW)
    const snapshot = snapshots.get(`backups/${A}/2026-09-14.json`)!
    expect(Object.keys(snapshot)).toEqual(['exportedAt', 'userId', 'items'])
    expect(snapshot).toMatchObject({ exportedAt: NOW.toISOString(), userId: A })
    // A's live piece and note, and every one of the 2,345 tasks, once each
    expect(snapshot.items).toHaveLength(2347)
    expect(new Set(snapshot.items.map(i => i.id)).size).toBe(2347)
    expect(report.users.find(u => u.userId === A)?.items).toBe(2347)
    // 2,349 live rows across both accounts: 1,000, 1,000 and 349
    expect(calls.filter(c => c.startsWith('GET /rest/v1/posts?select=id,data,user_id&deleted=is.false'))).toHaveLength(3)
  })

  it('encrypts what it writes when the host holds a passphrase, and it opens again', async () => {
    // wrapSnapshot is unit-tested on its own (backup-encryption.test.ts); this
    // is the path the nightly job actually takes — runBackup → backupUser →
    // wrapSnapshot → the bucket — which nothing covered until the Netlify
    // build failed and showed it running for the first time.
    process.env.BACKUP_PASSPHRASE = 'a passphrase the host holds'
    try {
      posts.push(task(1))
      const report = await runBackup(NOW)
      expect(report.encrypted).toBe(true)
      const written = snapshots.get(`backups/${A}/2026-09-14.json`)!
      expect(Object.keys(written)).toContain('ct')
      expect(JSON.stringify(written)).not.toContain('Chore 1')
      const opened = await unwrapSnapshot(written, 'a passphrase the host holds')
      // Snapshot.items is unknown[]: the envelope is opaque until it is opened
      expect(opened.items.some(i => (i as { id?: string }).id === 't-00001')).toBe(true)
    } finally {
      delete process.env.BACKUP_PASSPHRASE
    }
  })

  it('writes no snapshot at all when the read cannot be finished, rather than a short one', async () => {
    posts.push(...Array.from({ length: 1500 }, (_, n) => task(n)))
    laterPagesFail = true
    await expect(runBackup(NOW)).rejects.toThrow(/^posts: 500 .*statement timeout/)
    expect(snapshots.size).toBe(0)
  })
})

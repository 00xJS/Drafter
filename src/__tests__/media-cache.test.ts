import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The photo cache on this device (src/media.ts). Every photo viewed was kept
// in IndexedDB for good and never let go: only Delete forever took one out, a
// note a housemate stopped sharing left its photos readable here, and every
// object URL made stayed alive with its whole blob. Two views asking for one
// photo at once made two URLs, the first never let go. Now the URLs are
// capped, one lookup runs per photo, and the cache is trimmed — never a photo
// still waiting to upload, and nothing at all in local mode.

const { rows, sb, urls } = vi.hoisted(() => ({
  rows: new Map<string, { id: string; name: string; type: string; blob: Blob; pending?: true }>(),
  sb: { client: null as unknown, downloads: 0, removed: [] as string[][] },
  urls: { made: 0, revoked: [] as string[] },
}))

vi.mock('../idb', () => ({
  idbGet: vi.fn(async (_store: string, key: string) => rows.get(key)),
  idbSet: vi.fn(async (_store: string, key: string, value: never) => void rows.set(key, value)),
  idbDel: vi.fn(async (_store: string, key: string) => void rows.delete(key)),
  idbAll: vi.fn(async () => [...rows.values()]),
}))
vi.mock('../supabase', () => ({ getSupabase: () => sb.client, storedUserId: () => null }))

const bytes = (n: number) => new Blob([new Uint8Array(n)], { type: 'image/jpeg' })
const photo = (id: string, size = 10, pending = false) => ({ id, name: id, type: 'image/jpeg', blob: bytes(size), ...(pending ? { pending: true as const } : {}) })

/** A signed-in client whose bucket answers downloads (a moment later) and records removals. */
function signedIn() {
  sb.client = {
    storage: {
      from: () => ({
        download: async () => {
          sb.downloads++
          await new Promise(r => setTimeout(r, 5))
          return { data: bytes(10), error: null }
        },
        remove: async (ids: string[]) => {
          sb.removed.push(ids)
          return { data: [], error: null }
        },
        upload: async () => ({ error: null }),
      }),
    },
  }
}

beforeEach(() => {
  rows.clear()
  sb.client = null
  sb.downloads = 0
  sb.removed = []
  urls.made = 0
  urls.revoked = []
  vi.resetModules()
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++urls.made}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(u => void urls.revoked.push(u))
  const kv = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('object URLs', () => {
  it('two views asking for one photo at once share one lookup and one URL', async () => {
    signedIn()
    const media = await import('../media')
    const [a, b] = await Promise.all([media.mediaURL('p1'), media.mediaURL('p1')])
    expect(a).toBe(b)
    expect(sb.downloads).toBe(1)
    expect(urls.made).toBe(1)
    expect(await media.mediaURL('p1')).toBe(a)
    expect(urls.made).toBe(1)
  })

  it('past the cap, the least recently asked for is let go — its blob with it', async () => {
    const media = await import('../media')
    for (let i = 0; i <= media.URL_MAX; i++) rows.set(`p${i}`, photo(`p${i}`))
    const first = await media.mediaURL('p0')
    const second = await media.mediaURL('p1')
    // p0 asked for again: p1 is now the oldest
    expect(media.peekMediaURL('p0')).toBe(first)
    for (let i = 2; i <= media.URL_MAX; i++) await media.mediaURL(`p${i}`)
    expect(urls.revoked).toEqual([second])
    expect(media.peekMediaURL('p1')).toBeNull()
    expect(media.peekMediaURL('p0')).toBe(first)
  })

  it('a photo deleted forever lets go of its URL', async () => {
    const media = await import('../media')
    rows.set('p1', photo('p1'))
    const url = await media.mediaURL('p1')
    await media.deleteMedia(['p1'])
    expect(urls.revoked).toEqual([url])
    expect(media.peekMediaURL('p1')).toBeNull()
  })
})

describe('what the trim lets go of', () => {
  const HOUR = 3_600_000
  const now = 100 * HOUR

  it('every photo no record points at, but never one waiting to upload or one just shown', async () => {
    const { photosToTrim } = await import('../media')
    const photos = [
      { id: 'kept', bytes: 10 },
      { id: 'orphan', bytes: 10 },
      { id: 'waiting', bytes: 10, pending: true },
      { id: 'just-shown', bytes: 10 },
    ]
    const used = new Map([['just-shown', now - 60_000]])
    expect(photosToTrim(photos, new Set(['kept']), used, 1_000, now)).toEqual(['orphan'])
  })

  it('past the cap, the least recently shown of the rest, down to four fifths of it', async () => {
    const { photosToTrim } = await import('../media')
    const photos = [
      { id: 'a', bytes: 40 },
      { id: 'b', bytes: 40 },
      { id: 'c', bytes: 40 },
      { id: 'up', bytes: 40, pending: true },
    ]
    const used = new Map([
      ['a', now - 3 * HOUR],
      ['b', now - 5 * HOUR],
      ['c', now - 1 * HOUR],
    ])
    // 160 bytes against a cap of 100: b then a go (to 80 or under), never the pending one
    expect(photosToTrim(photos, new Set(['a', 'b', 'c', 'up']), used, 100, now)).toEqual(['b', 'a'])
  })

  it('reads every photo the records point at, deleted-forever tombstones apart', async () => {
    const { mediaReferences } = await import('../media')
    const refs = mediaReferences(
      [
        { kind: 'garment', id: 'g', photoId: 'personal/u/1', backThumbId: 'personal/u/2' },
        { kind: 'task', id: 't', mediaIds: ['img-1'], attachments: [{ id: 'file-1', name: 'a.pdf' }] },
        { kind: 'note', id: 'n', body: '<p>Paint</p><img data-media="img-2" alt="">' },
        { kind: 'garment', id: 'gone', purged: true, photoId: 'personal/u/3' },
      ],
      ['face-1', null],
    )
    for (const id of ['personal/u/1', 'personal/u/2', 'img-1', 'file-1', 'img-2', 'face-1']) expect(refs.has(id), id).toBe(true)
    expect(refs.has('personal/u/3')).toBe(false)
  })
})

describe('trimMediaCache', () => {
  it('in local mode touches nothing: this device holds the only copy', async () => {
    const media = await import('../media')
    rows.set('orphan', photo('orphan'))
    expect(await media.trimMediaCache(() => new Set())).toBe(0)
    expect(rows.has('orphan')).toBe(true)
  })

  it('signed in, lets go of this device’s copy only — the bucket keeps its own — and not again for hours', async () => {
    signedIn()
    const media = await import('../media')
    rows.set('kept', photo('kept'))
    rows.set('orphan', photo('orphan'))
    rows.set('waiting', photo('waiting', 10, true))
    const orphanURL = await media.mediaURL('orphan')
    const later = Date.now() + media.RECENT_USE_MS + 1
    expect(await media.trimMediaCache(() => new Set(['kept']), later)).toBe(1)
    expect([...rows.keys()].sort()).toEqual(['kept', 'waiting'])
    expect(sb.removed).toEqual([])
    expect(urls.revoked).toEqual([orphanURL])
    rows.set('orphan-2', photo('orphan-2'))
    expect(await media.trimMediaCache(() => new Set(['kept']), later + 60_000)).toBe(0)
    expect(rows.has('orphan-2')).toBe(true)
  })
})

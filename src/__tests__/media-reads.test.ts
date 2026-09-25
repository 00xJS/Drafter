import { beforeEach, describe, expect, it, vi } from 'vitest'

// The photo store (src/media.ts) was read whole, blobs and all, on every
// return to the app and every reconnect, to find the few photos (usually
// none) still waiting to upload — and read whole again by the cache's trim on
// every cold launch. The ids of the photos waiting are listed now, so a flush
// reads just those, and nothing when none waits; and when the trim last ran
// is kept, so a cold launch a few hours after one does not trim again.

const { rows, sb, kv } = vi.hoisted(() => ({
  rows: new Map<string, { id: string; name: string; type: string; blob: Blob; pending?: true }>(),
  sb: { client: null as unknown, uploads: [] as string[], fail: false },
  kv: new Map<string, string>(),
}))

vi.mock('../idb', () => ({
  idbGet: vi.fn(async (_store: string, key: string) => rows.get(key)),
  idbSet: vi.fn(async (_store: string, key: string, value: never) => void rows.set(key, value)),
  idbDel: vi.fn(async (_store: string, key: string) => void rows.delete(key)),
  idbAll: vi.fn(async () => [...rows.values()]),
}))
vi.mock('../supabase', () => ({ getSupabase: () => sb.client, storedUserId: () => null }))

import { idbAll, idbGet } from '../idb'

const blob = (size = 10) => new Blob([new Uint8Array(size)], { type: 'image/jpeg' })
const photo = (id: string, pending = false) => ({ id, name: id, type: 'image/jpeg', blob: blob(), ...(pending ? { pending: true as const } : {}) })
const HOUR = 3_600_000

let media: typeof import('../media')

/** A fresh launch: the module's memory gone, this device's storage kept. */
async function launch() {
  vi.resetModules()
  media = await import('../media')
}

const listed = () => (kv.has('drafter:media-pending') ? (JSON.parse(kv.get('drafter:media-pending')!) as string[]) : null)

beforeEach(async () => {
  rows.clear()
  kv.clear()
  sb.uploads = []
  sb.fail = false
  sb.client = {
    storage: {
      from: () => ({
        upload: async (id: string) => {
          sb.uploads.push(id)
          return { data: null, error: sb.fail ? { message: 'offline' } : null }
        },
        remove: async () => ({ data: [], error: null }),
        download: async () => ({ data: null, error: { message: 'not there' } }),
      }),
    },
  }
  vi.stubGlobal('localStorage', { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) })
  vi.mocked(idbAll).mockClear()
  vi.mocked(idbGet).mockClear()
  await launch()
})

describe('a flush reads only the photos waiting to upload', () => {
  it('a return to the app with nothing waiting reads no photo at all', async () => {
    kv.set('drafter:media-pending', '[]')
    for (const id of ['a', 'b', 'c']) rows.set(id, photo(id))
    const win = new EventTarget() as unknown as Window
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' }) as unknown as Document
    const stop = media.watchPendingMedia(win, doc)
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(media.flushPendingMedia()).resolves.toBe(0))
    stop()
    expect(idbAll).not.toHaveBeenCalled()
    expect(idbGet).not.toHaveBeenCalled()
    expect(sb.uploads).toEqual([])
  })

  it('a photo saved is listed, sent by a flush that reads it alone, and unlisted once the bucket has it', async () => {
    kv.set('drafter:media-pending', '[]')
    for (const id of ['a', 'b', 'c']) rows.set(id, photo(id))
    sb.fail = true
    const id = await media.saveMedia(blob())
    await media.flushPendingMedia()
    // refused: still listed, for the next flush
    expect(listed()).toEqual([id])
    vi.mocked(idbGet).mockClear()
    sb.fail = false
    expect(await media.flushPendingMedia()).toBe(1)
    expect(vi.mocked(idbGet).mock.calls.map(([, key]) => key)).toEqual([id, id])
    expect(idbAll).not.toHaveBeenCalled()
    expect(rows.get(id)?.pending).toBeUndefined()
    expect(listed()).toEqual([])
    vi.mocked(idbGet).mockClear()
    expect(await media.flushPendingMedia()).toBe(0)
    expect(idbGet).not.toHaveBeenCalled()
  })

  it('an id whose photo is gone, or went up from another tab, leaves the list', async () => {
    kv.set('drafter:media-pending', JSON.stringify(['gone', 'sent', 'waiting']))
    rows.set('sent', photo('sent'))
    rows.set('waiting', photo('waiting', true))
    expect(await media.flushPendingMedia()).toBe(1)
    expect(sb.uploads).toEqual(['waiting'])
    expect(listed()).toEqual([])
  })

  it('the first flush on a device with no list looks through every photo once, and lists what waits', async () => {
    // saved before there was a list
    rows.set('old', photo('old', true))
    rows.set('up', photo('up'))
    sb.fail = true
    expect(await media.flushPendingMedia()).toBe(0)
    expect(idbAll).toHaveBeenCalledTimes(1)
    expect(listed()).toEqual(['old'])
    sb.fail = false
    expect(await media.flushPendingMedia()).toBe(1)
    expect(sb.uploads).toEqual(['old', 'old'])
    expect(idbAll).toHaveBeenCalledTimes(1)
  })

  it('a photo saved while that first look is under way is listed and sent too', async () => {
    rows.set('old', photo('old', true))
    let release = () => {}
    vi.mocked(idbAll).mockImplementationOnce(async () => {
      const seen = [...rows.values()]
      await new Promise<void>(r => (release = r))
      return seen
    })
    const first = media.flushPendingMedia()
    await vi.waitFor(() => expect(idbAll).toHaveBeenCalledTimes(1))
    const saved = await media.saveMedia(blob())
    release()
    await first
    await media.flushPendingMedia()
    expect(sb.uploads.sort()).toEqual(['old', saved].sort())
    expect(listed()).toEqual([])
  })

  it('a look that fails leaves the list to the next flush', async () => {
    rows.set('old', photo('old', true))
    vi.mocked(idbAll).mockRejectedValueOnce(new Error('connection lost'))
    expect(await media.flushPendingMedia()).toBe(0)
    expect(listed()).toBeNull()
    expect(await media.flushPendingMedia()).toBe(1)
    expect(sb.uploads).toEqual(['old'])
  })

  it('without storage to keep a list in, every flush looks through every photo, as it always did', async () => {
    vi.stubGlobal('localStorage', undefined)
    rows.set('old', photo('old', true))
    expect(await media.flushPendingMedia()).toBe(1)
    rows.set('next', photo('next', true))
    expect(await media.flushPendingMedia()).toBe(1)
    expect(sb.uploads).toEqual(['old', 'next'])
  })

  it('deleting a photo forever unlists it', async () => {
    kv.set('drafter:media-pending', '[]')
    sb.fail = true
    const id = await media.saveMedia(blob())
    expect(listed()).toEqual([id])
    await media.deleteMedia([id])
    expect(listed()).toEqual([])
  })
})

describe('the trim runs at most every few hours, across launches too', () => {
  it('a cold launch soon after the last trim does not read the photos again; one after the gap does', async () => {
    const t0 = Date.parse('2026-09-25T08:00:00Z')
    rows.set('kept', photo('kept'))
    expect(await media.trimMediaCache(() => new Set(['kept']), t0)).toBe(0)
    expect(idbAll).toHaveBeenCalledTimes(1)
    await launch()
    expect(await media.trimMediaCache(() => new Set(['kept']), t0 + HOUR)).toBe(0)
    expect(idbAll).toHaveBeenCalledTimes(1)
    await launch()
    await media.trimMediaCache(() => new Set(['kept']), t0 + 6 * HOUR)
    expect(idbAll).toHaveBeenCalledTimes(2)
  })

  it('a clock set back does not hold the trim off', async () => {
    kv.set('drafter:media-trimmed', String(Date.parse('2027-01-01T00:00:00Z')))
    await media.trimMediaCache(() => new Set(), Date.parse('2026-09-25T08:00:00Z'))
    expect(idbAll).toHaveBeenCalledTimes(1)
  })

  it('photos piling up past the cap ask for a trim at the next launch too', async () => {
    kv.set('drafter:media-pending', '[]')
    const t0 = Date.parse('2026-09-25T08:00:00Z')
    await media.trimMediaCache(() => new Set(), t0)
    expect(kv.get('drafter:media-trimmed')).toBe(String(t0))
    // a photo bigger than the cache may hold, as its size says
    await media.saveMedia({ size: media.cacheBytesMax() + 1, type: 'image/jpeg', name: 'huge' } as unknown as Blob)
    expect(kv.has('drafter:media-trimmed')).toBe(false)
    await launch()
    await media.trimMediaCache(() => new Set(), t0 + HOUR)
    expect(idbAll).toHaveBeenCalledTimes(2)
  })

  it('lists a photo waiting to upload that the list is missing, and sends it', async () => {
    kv.set('drafter:media-pending', '[]')
    rows.set('missed', photo('missed', true))
    await media.trimMediaCache(() => new Set(['missed']), Date.parse('2026-09-25T08:00:00Z'))
    await vi.waitFor(() => expect(sb.uploads).toEqual(['missed']))
    await vi.waitFor(() => expect(listed()).toEqual([]))
    expect(rows.get('missed')?.pending).toBeUndefined()
  })
})

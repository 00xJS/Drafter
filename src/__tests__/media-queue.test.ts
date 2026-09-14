import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The media store's upload queue: a photo is kept on this device first,
// marked pending, and uploaded once; a failure is left for the next try, and
// nothing saved before the queue (or downloaded) is ever sent again. A
// garment's photo is filed under its uploader's own personal/<user id>/, and
// is never sent under anything else: a bare id is one the household can read.
// IndexedDB and the bucket are stand-ins here: vitest runs in node.

const { rows, sb } = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  sb: { client: null as unknown, stored: null as string | null },
}))

vi.mock('../idb', () => ({
  idbGet: vi.fn(async (_store: string, key: string) => rows.get(key)),
  idbSet: vi.fn(async (_store: string, key: string, value: unknown) => void rows.set(key, value)),
  idbDel: vi.fn(async (_store: string, key: string) => void rows.delete(key)),
  idbAll: vi.fn(async () => [...rows.values()]),
}))
vi.mock('../supabase', () => ({ getSupabase: () => sb.client, storedUserId: () => sb.stored }))

import { idbDel } from '../idb'
import {
  deleteMedia,
  dueForRemoval,
  flushPendingMedia,
  mediaURL,
  NotSignedIn,
  RETIRE_AFTER_MS,
  RETIRE_KEY,
  retireDue,
  retireMedia,
  saveMedia,
  swappedOut,
  trackMediaInUse,
  unsentPhotoCount,
  uploadPending,
  watchPendingMedia,
  type MediaInUse,
  type MediaItem,
  type Retiring,
} from '../media'
import { sanitizeGarment } from '../schema'

const USER = '00000000-0000-0000-0000-00000000000a'
const blob = () => new Blob(['jpeg bytes'], { type: 'image/jpeg' })
const pending = (id: string): MediaItem => ({ id, name: id, type: 'image/jpeg', blob: blob(), pending: true })
/** A few ticks: long enough for a flush that an event started to finish against the stand-ins. */
const settle = () => new Promise(r => setTimeout(r, 20))

/**
 * A signed-in client whose bucket records what it was sent; `fail` refuses
 * some uploads. Asking auth-js for the session is a failure here: it can hold
 * a save for half a minute of refresh retries, and nothing may wait on it.
 */
function signedIn(opts: { fail?: (id: string) => boolean; during?: (id: string) => void } = {}) {
  const uploads: string[] = []
  const removed: string[][] = []
  const getSession = vi.fn(async () => {
    throw new Error('getSession is never asked: it can refresh, and a refresh can hang')
  })
  sb.client = {
    auth: { getSession },
    storage: {
      from: () => ({
        upload: async (id: string) => {
          uploads.push(id)
          opts.during?.(id)
          return { data: null, error: opts.fail?.(id) ? { message: 'offline' } : null }
        },
        remove: async (ids: string[]) => {
          removed.push(ids)
          return { data: [], error: null }
        },
        download: async () => ({ data: null, error: { message: 'not there' } }),
      }),
    },
  }
  return { uploads, removed, getSession }
}

afterEach(async () => {
  await flushPendingMedia()
  rows.clear()
  sb.client = null
  sb.stored = null
  vi.restoreAllMocks()
})

describe('uploadPending: the queue’s core', () => {
  it('uploads only pending items, clears the mark on success, leaves a failure pending and counts what went', async () => {
    const legacy: MediaItem = { id: 'legacy', name: 'legacy', type: 'image/jpeg', blob: blob() }
    const items = [pending('a'), pending('b'), legacy]
    const put = vi.fn(async (_item: MediaItem) => {})
    const upload = vi.fn(async (item: MediaItem) => item.id !== 'b')
    expect(await uploadPending({ items: async () => items, put, upload })).toBe(1)
    expect(upload.mock.calls.map(([item]) => item.id)).toEqual(['a', 'b'])
    expect(put).toHaveBeenCalledTimes(1)
    const [kept] = put.mock.calls[0]
    expect(kept.id).toBe('a')
    expect('pending' in kept).toBe(false)
    // the failed one and the old one are left exactly as they were
    expect(items[1].pending).toBe(true)
    expect(items[2]).toBe(legacy)
  })

  it('reads a throw as a failure, and keeps going', async () => {
    const put = vi.fn(async (_item: MediaItem) => {})
    const upload = vi.fn(async (item: MediaItem) => {
      if (item.id === 'a') throw new Error('network')
      return true
    })
    expect(await uploadPending({ items: async () => [pending('a'), pending('b')], put, upload })).toBe(1)
    expect(put.mock.calls.map(([item]) => item.id)).toEqual(['b'])
  })
})

describe('saveMedia: kept here first, then sent', () => {
  it('files a personal photo under the account the planner names, marked personal and pending until the bucket has it', async () => {
    const { uploads, getSession } = signedIn()
    const id = await saveMedia(blob(), { personal: true, userId: USER })
    expect(id).toMatch(new RegExp(`^personal/${USER}/[0-9a-f-]{36}$`))
    // the garment's sanitizer keeps an id of exactly this shape
    expect(sanitizeGarment({ id: 'g', name: 'Tee', type: 'top', photoId: id })?.photoId).toBe(id)
    expect(rows.get(id)).toMatchObject({ id, personal: true, pending: true })
    await flushPendingMedia()
    expect(uploads).toEqual([id])
    expect((rows.get(id) as MediaItem).pending).toBeUndefined()
    expect((rows.get(id) as MediaItem).blob).toBeInstanceOf(Blob)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('falls back to the account stored on this device, which outlives an expired token and needs no network', async () => {
    const { getSession } = signedIn()
    sb.stored = USER
    const id = await saveMedia(blob(), { personal: true })
    expect(id).toMatch(new RegExp(`^personal/${USER}/[0-9a-f-]{36}$`))
    // the planner's own account wins over the stored one
    sb.stored = '00000000-0000-0000-0000-00000000000b'
    expect(await saveMedia(blob(), { personal: true, userId: USER })).toMatch(new RegExp(`^personal/${USER}/`))
    expect(getSession).not.toHaveBeenCalled()
  })

  it('refuses a personal photo with no account to file it under, and keeps nothing: never a bare id the household can read', async () => {
    const { uploads, getSession } = signedIn()
    await expect(saveMedia(blob(), { personal: true })).rejects.toBeInstanceOf(NotSignedIn)
    await expect(saveMedia(blob(), { personal: true, userId: null })).rejects.toThrow(/Sign in again/)
    expect(rows.size).toBe(0)
    await flushPendingMedia()
    expect(uploads).toEqual([])
    expect(getSession).not.toHaveBeenCalled()
  })

  it('never sends a personal photo that has a bare id, however it came to have one', async () => {
    const { uploads } = signedIn()
    rows.set('bare', { ...pending('bare'), personal: true })
    rows.set(`personal/${USER}/filed`, { ...pending(`personal/${USER}/filed`), personal: true })
    expect(await flushPendingMedia()).toBe(1)
    expect(uploads).toEqual([`personal/${USER}/filed`])
    // kept on this device, still pending: nothing is lost, and nothing is shared
    expect(rows.get('bare')).toMatchObject({ pending: true, personal: true })
  })

  it('in local mode: a bare id, kept here, and nothing to send', async () => {
    const id = await saveMedia(blob(), { personal: true })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows.get(id)).toMatchObject({ id, type: 'image/jpeg' })
    expect('pending' in (rows.get(id) as object)).toBe(false)
    expect(await flushPendingMedia()).toBe(0)
  })

  it('still saves a note photo the way it always did: a bare id, its own name, and now retried', async () => {
    const { uploads } = signedIn({ fail: () => true })
    const id = await saveMedia(new File(['png'], 'garden.png', { type: 'image/png' }))
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows.get(id)).toMatchObject({ id, name: 'garden.png', type: 'image/png', pending: true })
    expect('personal' in (rows.get(id) as object)).toBe(false)
    await flushPendingMedia()
    // refused: still here, still pending, for the next flush
    expect((rows.get(id) as MediaItem).pending).toBe(true)
    expect(uploads).toContain(id)
  })
})

describe('flushPendingMedia and watchPendingMedia', () => {
  it('uploads each item once when two flushes are asked for together', async () => {
    const { uploads } = signedIn()
    rows.set('p1', pending('p1'))
    rows.set('p2', pending('p2'))
    const [a, b] = await Promise.all([flushPendingMedia(), flushPendingMedia()])
    expect(uploads.sort()).toEqual(['p1', 'p2'])
    expect(a).toBe(2)
    expect(b).toBe(2)
  })

  it('sends a failure on the next flush, once the bucket takes it', async () => {
    let online = false
    const { uploads } = signedIn({ fail: () => !online })
    rows.set('p1', pending('p1'))
    expect(await flushPendingMedia()).toBe(0)
    online = true
    expect(await flushPendingMedia()).toBe(1)
    expect(uploads).toEqual(['p1', 'p1'])
    expect((rows.get('p1') as MediaItem).pending).toBeUndefined()
  })

  it('never brings back a photo deleted forever while it was uploading', async () => {
    signedIn({ during: id => rows.delete(id) })
    rows.set('p1', pending('p1'))
    await flushPendingMedia()
    expect(rows.has('p1')).toBe(false)
  })

  it('flushes at once, when the connection is back and when the page is shown again, until unsubscribed', async () => {
    const { uploads } = signedIn()
    const win = new EventTarget() as unknown as Window
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' }) as unknown as Document & { visibilityState: string }
    rows.set('p1', pending('p1'))
    const stop = watchPendingMedia(win, doc)
    await settle()
    expect(uploads).toEqual(['p1'])

    rows.set('p2', pending('p2'))
    win.dispatchEvent(new Event('online'))
    await settle()
    expect(uploads).toEqual(['p1', 'p2'])

    rows.set('p3', pending('p3'))
    doc.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(uploads, 'a page going into the background sends nothing').toEqual(['p1', 'p2'])
    ;(doc as { visibilityState: string }).visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(uploads).toEqual(['p1', 'p2', 'p3'])

    stop()
    rows.set('p4', pending('p4'))
    win.dispatchEvent(new Event('online'))
    await settle()
    expect(uploads).toEqual(['p1', 'p2', 'p3'])
  })
})

describe('deleteMedia: Trash → Delete forever on a piece of clothing', () => {
  it('drops both photos from this device and the bucket, and lets go of a cached URL', async () => {
    const { removed } = signedIn()
    const photo = `personal/${USER}/11111111-1111-4111-8111-111111111111`
    const thumb = `personal/${USER}/22222222-2222-4222-8222-222222222222`
    rows.set(photo, { id: photo, name: photo, type: 'image/jpeg', blob: blob() })
    rows.set(thumb, { id: thumb, name: thumb, type: 'image/jpeg', blob: blob() })
    const url = await mediaURL(thumb)
    expect(url).toMatch(/^blob:/)
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    await deleteMedia([photo, thumb, undefined])
    expect(rows.has(photo)).toBe(false)
    expect(rows.has(thumb)).toBe(false)
    expect(vi.mocked(idbDel).mock.calls.map(([, key]) => key)).toEqual(expect.arrayContaining([photo, thumb]))
    expect(removed).toEqual([[photo, thumb]])
    expect(revoke).toHaveBeenCalledWith(url)
  })

  it('does nothing for a piece that never had a photo', async () => {
    const { removed } = signedIn()
    await deleteMedia([undefined, undefined])
    expect(removed).toEqual([])
  })

  it('in local mode, drops this device’s copies only', async () => {
    rows.set('local-photo', { id: 'local-photo', name: 'x', type: 'image/jpeg', blob: blob() })
    await deleteMedia(['local-photo'])
    expect(rows.has('local-photo')).toBe(false)
  })
})

// Signing out wipes this device, so it asks first while a photo is still
// waiting; the count it asks with is here. A piece's photo and its thumbnail
// are one photo to the person signing out.
describe('unsentPhotoCount: what signing out would lose', () => {
  it('counts every photo still waiting — note photos too — a piece’s thumbnail with its photo as one, and nothing already up', async () => {
    signedIn()
    const photo = `personal/${USER}/11111111-1111-4111-8111-111111111111`
    rows.set(photo, { ...pending(photo), personal: true })
    rows.set('thumb', { ...pending('thumb'), personal: true, thumbOf: photo })
    rows.set('note-photo', pending('note-photo'))
    rows.set('uploaded', { id: 'uploaded', name: 'uploaded', type: 'image/jpeg', blob: blob() })
    // a thumbnail still waiting after its photo went up is a photo of its own to lose
    rows.set('lone-thumb', { ...pending('lone-thumb'), thumbOf: 'uploaded' })
    expect(await unsentPhotoCount()).toBe(3)
  })

  it('links a piece’s thumbnail to its photo when it is saved', async () => {
    signedIn({ fail: () => true })
    const photoId = await saveMedia(blob(), { personal: true, userId: USER })
    const thumbId = await saveMedia(blob(), { personal: true, userId: USER, thumbOf: photoId })
    expect(rows.get(thumbId)).toMatchObject({ thumbOf: photoId, personal: true, pending: true })
    expect('thumbOf' in (rows.get(photoId) as object)).toBe(false)
    expect(await unsentPhotoCount()).toBe(1)
  })

  it('is nothing in local mode, where nothing is ever sent', async () => {
    rows.set('x', pending('x'))
    expect(await unsentPhotoCount()).toBe(0)
  })
})

const OLD_PHOTO = `personal/${USER}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
const OLD_THUMB = `personal/${USER}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
const NEW_PHOTO = `personal/${USER}/cccccccc-cccc-4ccc-8ccc-cccccccccccc`
const NEW_THUMB = `personal/${USER}/dddddddd-dddd-4ddd-8ddd-dddddddddddd`
const PIECE = 'g-tee'

/** What the planner answers: the photos pieces here point at, the records the server has not confirmed, and what its copies of them point at. */
const known = (ids: string[], unsynced: readonly string[] = [], onServer: readonly string[] = []): MediaInUse => ({
  userId: USER,
  ids: new Set(ids),
  unsynced: new Set(unsynced),
  onServer: new Set(onServer),
})

// Replace photo used to leave the old two in the bucket for good. They now go
// once the new two are up, the Undo toast has long gone and the server has the
// piece's edit, and only if no piece of clothing on this device, live or in
// Trash, nor any copy the server may still hold, points at them then.
describe('dueForRemoval: which swapped-out photos may go', () => {
  const T = 1_000_000
  const entry = (over: Partial<Retiring> = {}): Retiring => ({ ids: [OLD_PHOTO, OLD_THUMB], after: [NEW_PHOTO, NEW_THUMB], at: T, garment: PIECE, ...over })
  const used = (ids: string[] = [NEW_PHOTO, NEW_THUMB]) => known(ids)

  it('lets go of the old photos once the new ones are up and the Undo has had its time', () => {
    expect(dueForRemoval([entry()], new Set(), used(), T + RETIRE_AFTER_MS)).toEqual({ keep: [], remove: [OLD_PHOTO, OLD_THUMB] })
  })

  it('waits while a replacement is still uploading, and while an Undo could still bring the old ones back', () => {
    expect(dueForRemoval([entry()], new Set([NEW_THUMB]), used(), T + 10 * RETIRE_AFTER_MS)).toEqual({ keep: [entry()], remove: [] })
    expect(dueForRemoval([entry()], new Set(), used(), T + RETIRE_AFTER_MS - 1)).toEqual({ keep: [entry()], remove: [] })
  })

  it('waits while the server has not confirmed the piece’s edit, or while a copy it may hold still points at them', () => {
    // Replace photo offline: the new two are up, but the edit pointing at them has not reached the server
    expect(dueForRemoval([entry()], new Set(), known([NEW_PHOTO, NEW_THUMB], [PIECE], [OLD_PHOTO, OLD_THUMB]), T + 10 * RETIRE_AFTER_MS)).toEqual({ keep: [entry()], remove: [] })
    expect(dueForRemoval([entry()], new Set(), known([NEW_PHOTO, NEW_THUMB], [PIECE]), T + RETIRE_AFTER_MS).keep).toEqual([entry()])
    // another record waiting whose confirmed copy still points at one of them
    expect(dueForRemoval([entry()], new Set(), known([NEW_PHOTO, NEW_THUMB], ['g-other'], [OLD_THUMB]), T + RETIRE_AFTER_MS).keep).toEqual([entry()])
    // an unrelated record waiting to push holds nothing back
    expect(dueForRemoval([entry()], new Set(), known([NEW_PHOTO, NEW_THUMB], ['t-paint']), T + RETIRE_AFTER_MS)).toEqual({ keep: [], remove: [OLD_PHOTO, OLD_THUMB] })
  })

  it('keeps a photo a piece points at again — an Undo, another device — and is done with the entry', () => {
    expect(dueForRemoval([entry()], new Set(), used([OLD_PHOTO, OLD_THUMB]), T + RETIRE_AFTER_MS)).toEqual({ keep: [], remove: [] })
    expect(dueForRemoval([entry()], new Set(), used([OLD_THUMB, NEW_PHOTO]), T + RETIRE_AFTER_MS)).toEqual({ keep: [], remove: [OLD_PHOTO] })
  })

  it('never lets go of another account’s photo, a bare id (a note photo’s) or a backup', () => {
    const ids = [`personal/00000000-0000-0000-0000-00000000000b/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', `backups/${USER}/2026-09-13.json`, OLD_PHOTO]
    expect(dueForRemoval([entry({ ids })], new Set(), used(), T + RETIRE_AFTER_MS).remove).toEqual([OLD_PHOTO])
  })

  it('does nothing before the planner’s records have loaded, or without an account', () => {
    expect(dueForRemoval([entry()], new Set(), null, T + RETIRE_AFTER_MS)).toEqual({ keep: [entry()], remove: [] })
    expect(dueForRemoval([entry()], new Set(), { ...used(), userId: null }, T + RETIRE_AFTER_MS).keep).toHaveLength(1)
  })

  it('swappedOut: the ones already no loss — settled on the server, pointed at by nothing — whatever the minute or the uploads say', () => {
    expect(swappedOut([entry({ at: Date.now() })], used())).toEqual([OLD_PHOTO, OLD_THUMB])
    expect(swappedOut([entry()], known([NEW_PHOTO, NEW_THUMB], [PIECE]))).toEqual([])
    expect(swappedOut([entry()], used([OLD_PHOTO]))).toEqual([OLD_THUMB])
    expect(swappedOut([entry()], null)).toEqual([])
  })
})

describe('retireMedia: Replace photo lets go of the old two', () => {
  let kv: Map<string, string>
  let untrack = () => {}
  const queued = () => JSON.parse(kv.get(RETIRE_KEY) ?? '[]') as Retiring[]
  const uploaded = (id: string): MediaItem => ({ id, name: id, type: 'image/jpeg', blob: blob(), personal: true })

  beforeEach(() => {
    kv = new Map()
    vi.stubGlobal('localStorage', { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-09-14T09:00:00.000Z'))
  })

  afterEach(() => {
    untrack()
    untrack = () => {}
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('deletes them, here and in the bucket, once the new two are up and the minute is gone — on its own', async () => {
    const { removed } = signedIn()
    rows.set(NEW_PHOTO, { ...pending(NEW_PHOTO), personal: true })
    rows.set(NEW_THUMB, { ...pending(NEW_THUMB), personal: true, thumbOf: NEW_PHOTO })
    rows.set(OLD_PHOTO, uploaded(OLD_PHOTO))
    untrack = trackMediaInUse(() => known([NEW_PHOTO, NEW_THUMB]))
    retireMedia([OLD_PHOTO, OLD_THUMB], [NEW_PHOTO, NEW_THUMB], PIECE)
    expect(queued()).toHaveLength(1)
    await flushPendingMedia()
    // up, but an Undo could still bring the old ones back
    expect(removed).toEqual([])
    expect(rows.has(OLD_PHOTO)).toBe(true)
    // nothing else flushes from here: the flush it scheduled for itself, a minute on, does it
    await vi.advanceTimersByTimeAsync(RETIRE_AFTER_MS + 1_000)
    await vi.waitFor(() => expect(removed).toEqual([[OLD_PHOTO, OLD_THUMB]]))
    expect(rows.has(OLD_PHOTO)).toBe(false)
    expect(kv.has(RETIRE_KEY)).toBe(false)
  })

  it('waits for as long as a new photo cannot upload', async () => {
    const { removed } = signedIn({ fail: id => id === NEW_THUMB })
    rows.set(NEW_PHOTO, { ...pending(NEW_PHOTO), personal: true })
    rows.set(NEW_THUMB, { ...pending(NEW_THUMB), personal: true, thumbOf: NEW_PHOTO })
    untrack = trackMediaInUse(() => known([NEW_PHOTO, NEW_THUMB]))
    retireMedia([OLD_PHOTO, OLD_THUMB], [NEW_PHOTO, NEW_THUMB], PIECE)
    vi.setSystemTime(Date.now() + 5 * RETIRE_AFTER_MS)
    await flushPendingMedia()
    expect(removed).toEqual([])
    expect(queued()).toHaveLength(1)
  })

  it('deletes nothing while the piece’s edit is still waiting to sync — a sign-out could still lose it — and lets go once the server has it', async () => {
    const { removed } = signedIn()
    rows.set(NEW_PHOTO, { ...pending(NEW_PHOTO), personal: true })
    rows.set(NEW_THUMB, { ...pending(NEW_THUMB), personal: true, thumbOf: NEW_PHOTO })
    rows.set(OLD_PHOTO, uploaded(OLD_PHOTO))
    rows.set(OLD_THUMB, uploaded(OLD_THUMB))
    // Replace photo offline: the server's copy of the piece still points at the old two
    const server = { unsynced: [PIECE], onServer: [OLD_PHOTO, OLD_THUMB] }
    untrack = trackMediaInUse(() => known([NEW_PHOTO, NEW_THUMB], server.unsynced, server.onServer))
    retireMedia([OLD_PHOTO, OLD_THUMB], [NEW_PHOTO, NEW_THUMB], PIECE)
    // back online long after the minute: the photos go up before the edit's round has landed
    vi.setSystemTime(Date.now() + 5 * RETIRE_AFTER_MS)
    await flushPendingMedia()
    expect((rows.get(NEW_PHOTO) as MediaItem).pending).toBeUndefined()
    expect(removed).toEqual([])
    expect(rows.has(OLD_PHOTO) && rows.has(OLD_THUMB)).toBe(true)
    expect(queued()).toHaveLength(1)
    // the round that confirms the edit: the planner looks again when it is answered
    server.unsynced = []
    server.onServer = []
    await retireDue()
    expect(removed).toEqual([[OLD_PHOTO, OLD_THUMB]])
    expect(queued()).toEqual([])
  })

  it('keeps the old two when Undo put them back, and lets go of the new two instead', async () => {
    const { removed } = signedIn()
    rows.set(NEW_PHOTO, { ...pending(NEW_PHOTO), personal: true })
    rows.set(NEW_THUMB, { ...pending(NEW_THUMB), personal: true, thumbOf: NEW_PHOTO })
    rows.set(OLD_PHOTO, uploaded(OLD_PHOTO))
    rows.set(OLD_THUMB, uploaded(OLD_THUMB))
    untrack = trackMediaInUse(() => known([OLD_PHOTO, OLD_THUMB]))
    // Replace photo, then its Undo: two swaps, each the other's reverse
    retireMedia([OLD_PHOTO, OLD_THUMB], [NEW_PHOTO, NEW_THUMB], PIECE)
    retireMedia([NEW_PHOTO, NEW_THUMB], [OLD_PHOTO, OLD_THUMB], PIECE)
    vi.setSystemTime(Date.now() + RETIRE_AFTER_MS)
    await flushPendingMedia()
    expect(removed).toEqual([[NEW_PHOTO, NEW_THUMB]])
    expect(rows.has(OLD_PHOTO) && rows.has(OLD_THUMB)).toBe(true)
    expect(queued()).toEqual([])
  })

  it('does nothing until the planner’s records have loaded', async () => {
    const { removed } = signedIn()
    untrack = trackMediaInUse(() => null)
    retireMedia([OLD_PHOTO, OLD_THUMB], [NEW_PHOTO, NEW_THUMB], PIECE)
    vi.setSystemTime(Date.now() + RETIRE_AFTER_MS)
    await flushPendingMedia()
    expect(removed).toEqual([])
    expect(queued()).toHaveLength(1)
  })

  it('queues only a piece’s own photos, with the piece, and nothing at all in local mode', () => {
    retireMedia([OLD_PHOTO], [NEW_PHOTO], PIECE)
    expect(kv.has(RETIRE_KEY)).toBe(false)
    signedIn()
    retireMedia(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', undefined], [NEW_PHOTO], PIECE)
    retireMedia([OLD_PHOTO], [NEW_PHOTO], '')
    expect(kv.has(RETIRE_KEY)).toBe(false)
    retireMedia([OLD_PHOTO, undefined], [NEW_PHOTO, undefined], PIECE)
    expect(queued()).toEqual([{ ids: [OLD_PHOTO], after: [NEW_PHOTO], at: Date.now(), garment: PIECE }])
  })

  it('never acts on an entry that names no piece: it is forgotten, its photos left to the nightly sweep', async () => {
    const { removed } = signedIn()
    kv.set(RETIRE_KEY, JSON.stringify([{ ids: [OLD_PHOTO], after: [], at: 0 }]))
    untrack = trackMediaInUse(() => known([]))
    await flushPendingMedia()
    expect(removed).toEqual([])
    retireMedia([OLD_THUMB], [NEW_THUMB], PIECE)
    expect(queued()).toEqual([{ ids: [OLD_THUMB], after: [NEW_THUMB], at: Date.now(), garment: PIECE }])
  })

  it('a sign-out does not count a photo swapped out of a piece once the server has the swap and nothing points at it', async () => {
    signedIn({ fail: () => true })
    // the piece's first photo never went up, and then it was replaced
    rows.set(OLD_PHOTO, { ...pending(OLD_PHOTO), personal: true })
    rows.set(OLD_THUMB, { ...pending(OLD_THUMB), personal: true, thumbOf: OLD_PHOTO })
    rows.set(NEW_PHOTO, { ...pending(NEW_PHOTO), personal: true })
    rows.set(NEW_THUMB, { ...pending(NEW_THUMB), personal: true, thumbOf: NEW_PHOTO })
    const server = { loaded: false, unsynced: [PIECE], onServer: [OLD_PHOTO, OLD_THUMB] }
    untrack = trackMediaInUse(() => (server.loaded ? known([NEW_PHOTO, NEW_THUMB], server.unsynced, server.onServer) : null))
    retireMedia([OLD_PHOTO, OLD_THUMB], [NEW_PHOTO, NEW_THUMB], PIECE)
    // before the records are in, and while the server's piece still points at the old two, both count
    expect(await unsentPhotoCount()).toBe(2)
    server.loaded = true
    expect(await unsentPhotoCount()).toBe(2)
    server.unsynced = []
    server.onServer = []
    expect(await unsentPhotoCount()).toBe(1)
  })
})

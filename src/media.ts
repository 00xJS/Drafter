import { PERSONAL_PREFIX, isPersonalMediaOf } from '../shared/media.mts'
import { idbAll, idbDel, idbGet, idbSet } from './idb'
import { getSupabase, storedUserId } from './supabase'
import { browserKV, type KV } from './syncstate'
import { uid } from './utils'

// Images live in the Supabase Storage bucket "media" so every signed-in device
// — and the backup story — sees them. IndexedDB is the local copy, the offline
// fallback and the upload queue: a photo is saved here first, marked pending,
// and loses the mark only once the bucket has it, so one taken offline or on a
// flaky connection goes up later rather than never. Note photos and task
// images are the household's; a garment's is personal, under its uploader's
// own personal/<user id>/ folder, which the v3.14 storage policies keep to
// that account, and it is never sent under anything else: a bare id is one
// every household member may list and download. Local mode keeps working,
// local-only.

export interface MediaItem {
  id: string
  name: string
  type: string
  blob: Blob
  /** Saved here, not yet in the bucket. Absent on every item saved before the
   *  queue and on every downloaded copy, so nothing old is ever re-uploaded. */
  pending?: true
  /** A garment's photo: sent only under personal/<user id>/. */
  personal?: true
  /** A piece's thumbnail: the id of the photo it was made from, so the two count as one photo. */
  thumbOf?: string
}

/** The images among files picked, pasted or dropped: a note takes these inline, and Add clothing takes them as photos. */
export const imageFiles = (files: FileList | readonly File[]): File[] => Array.from(files).filter(f => f.type.startsWith('image/'))

/** A personal photo with no account to file it under: nothing is saved, and the sheet says so. */
export class NotSignedIn extends Error {
  constructor() {
    super('Sign in again to save photos of your clothes — this one was not saved')
    this.name = 'NotSignedIn'
  }
}

/**
 * Keep a photo or file on this device and queue it for the bucket. A personal
 * one is filed under personal/<user id>/: the account the caller names (the
 * planner's own), else the one auth-js last stored on this device — read with
 * no network and no token refresh, so it is there offline and after the
 * access token has expired. With neither it is refused, never given a bare id.
 * In local mode the id is a bare uid, as a note photo's always is.
 */
export async function saveMedia(file: Blob & { name?: string }, opts: { personal?: boolean; userId?: string | null; thumbOf?: string } = {}): Promise<string> {
  const sb = getSupabase()
  let id = uid()
  if (opts.personal && sb) {
    const user = opts.userId || storedUserId()
    if (!user) throw new NotSignedIn()
    id = `personal/${user}/${uid()}`
  }
  const item: MediaItem = { id, name: file.name ?? id, type: file.type, blob: file }
  if (opts.personal) item.personal = true
  if (opts.thumbOf) item.thumbOf = opts.thumbOf
  if (sb) item.pending = true
  await idbSet('media', id, item)
  // just made: it belongs to an edit that may not be saved yet, so no trim takes it
  noteUse(id)
  grew(file.size)
  void flushPendingMedia()
  return id
}

/**
 * The queue's core, with storage and the network handed in (the tests run it
 * with neither): upload each pending item in turn and, once the bucket has it,
 * write it back without the mark. A failure leaves it pending for the next
 * flush, and its local copy is never touched. Returns how many went up.
 */
export async function uploadPending(deps: {
  items(): Promise<MediaItem[]>
  put(item: MediaItem): Promise<unknown>
  upload(item: MediaItem): Promise<boolean>
}): Promise<number> {
  let sent = 0
  for (const item of await deps.items()) {
    if (!item.pending) continue
    let ok = false
    try {
      ok = await deps.upload(item)
    } catch {
      ok = false
    }
    if (!ok) continue
    const { pending: _sent, ...uploaded } = item
    await deps.put(uploaded)
    sent++
  }
  return sent
}

async function toBucket(item: MediaItem): Promise<boolean> {
  const sb = getSupabase()
  if (!sb) return false
  // the household may read a bare id: a personal photo stays on this device rather than go up under one
  if (item.personal && !item.id.startsWith('personal/')) return false
  const { error } = await sb.storage.from('media').upload(item.id, item.blob, { contentType: item.type, upsert: true })
  if (error) console.error('Media upload failed (kept on this device, will retry):', error.message)
  return !error
}

/** Written back only while it is still here: a photo deleted forever mid-upload must not come back. */
async function keepUploaded(item: MediaItem): Promise<void> {
  if (await idbGet<MediaItem>('media', item.id)) await idbSet('media', item.id, item)
}

let flushing: Promise<number> | null = null
let again = false

/**
 * Send every pending item, one flush at a time. Asked again while one runs, it
 * goes round once more when that one ends, so a photo saved mid-flush is not
 * left for the next reconnect; either way each item goes up once.
 */
export function flushPendingMedia(): Promise<number> {
  if (!getSupabase()) return Promise.resolve(0)
  if (flushing) {
    again = true
    return flushing
  }
  const run = async () => {
    let sent = 0
    do {
      again = false
      sent += await uploadPending({ items: () => idbAll<MediaItem>('media'), put: keepUploaded, upload: toBucket }).catch(() => 0)
    } while (again)
    // what just went up may be what a swapped-out photo was waiting on
    await retireSwapped().catch(() => {})
    return sent
  }
  flushing = run().finally(() => {
    flushing = null
  })
  return flushing
}

/** Flush now, whenever the connection comes back and whenever the page is shown again; returns the unsubscribe. */
export function watchPendingMedia(win: Window = window, doc: Document = document): () => void {
  const flush = () => void flushPendingMedia()
  const shown = () => {
    if (doc.visibilityState === 'visible') flush()
  }
  flush()
  win.addEventListener('online', flush)
  doc.addEventListener('visibilitychange', shown)
  return () => {
    win.removeEventListener('online', flush)
    doc.removeEventListener('visibilitychange', shown)
  }
}

/**
 * Photos this device holds that the bucket does not have yet: what signing out
 * would lose, as clearLocalData deletes the whole database. A piece's
 * thumbnail counts with its photo, as one; waiting alone, it counts itself.
 * A photo swapped out of a piece that nothing points at any more, here or on
 * the server (swappedOut), is no loss, and is left out.
 */
export async function unsentPhotoCount(): Promise<number> {
  if (!getSupabase()) return 0
  const spare = new Set(swappedOut(readRetiring(), currentUse()))
  const waiting = (await idbAll<MediaItem>('media')).filter(i => i.pending && !spare.has(i.id))
  const ids = new Set(waiting.map(i => i.id))
  return waiting.filter(i => !(i.thumbOf && ids.has(i.thumbOf))).length
}

// ---- photos swapped out of a piece of clothing

/** The swaps still to finish. A drafter:* key, so signing out forgets them with everything else. */
export const RETIRE_KEY = 'drafter:media-retire'
/** Well past the Undo toast (6 s, 15 s with an action), so an Undo never brings back a photo already deleted. */
export const RETIRE_AFTER_MS = 60_000
/** Kept at most: the oldest beyond it are forgotten, their photos left to the server's nightly sweep. */
const MAX_RETIRING = 100

/**
 * A piece's photos swapped out: `ids` go once every one of `after` is in the
 * bucket, RETIRE_AFTER_MS has passed since `at`, and the server has confirmed
 * the edit of `garment` that let them go.
 */
export interface Retiring {
  ids: string[]
  after: string[]
  at: number
  /** The piece they were swapped out of. */
  garment: string
}

/**
 * What the planner knows: whose photos these are, every one a piece of
 * clothing here, live or in Trash, points at, and what the server may still
 * hold otherwise — the records whose latest edit it has not confirmed, and
 * every photo its last confirmed copy of one of them points at.
 */
export interface MediaInUse {
  userId: string | null
  ids: ReadonlySet<string>
  unsynced: ReadonlySet<string>
  onServer: ReadonlySet<string>
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** The queue. An entry that names no piece can't be checked against the server, so it is forgotten, its photos left to the nightly sweep. */
function readRetiring(kv: KV = browserKV): Retiring[] {
  try {
    const list: unknown = JSON.parse(kv.getItem(RETIRE_KEY) ?? '[]')
    if (!Array.isArray(list)) return []
    return list.flatMap(e =>
      e && typeof e === 'object' && typeof e.at === 'number' && typeof e.garment === 'string' && e.garment
        ? [{ ids: strings(e.ids), after: strings(e.after), at: e.at, garment: e.garment }]
        : [],
    )
  } catch {
    return []
  }
}

function writeRetiring(list: readonly Retiring[], kv: KV = browserKV): void {
  try {
    if (list.length) kv.setItem(RETIRE_KEY, JSON.stringify(list))
    else kv.removeItem(RETIRE_KEY)
  } catch {
    /* storage may be unavailable: the photos stay, which is the safe way to be wrong */
  }
}

let inUse: (() => MediaInUse | null) | null = null

/** The planner's records, for the swaps: `get` answers null until they have loaded. Returns the unsubscribe. */
export function trackMediaInUse(get: () => MediaInUse | null): () => void {
  inUse = get
  return () => {
    if (inUse === get) inUse = null
  }
}

/** The planner's answer now, with the account auth-js last stored on this device when the planner names none. */
function currentUse(): MediaInUse | null {
  const used = inUse?.() ?? null
  return used && { ...used, userId: used.userId ?? storedUserId() }
}

/**
 * A piece's photos swapped out — by Replace photo, or by the Undo of one:
 * delete them, from this device and the bucket, once every photo that took
 * their place is up, the Undo toast has long gone and the server has the edit
 * of the piece, and then only the ones that are this account's own and that
 * nothing points at: no piece of clothing here, live or in Trash, and no copy
 * the server may still hold. Kept on this device, so a swap whose new photo
 * is still uploading when the app closes finishes at a later launch. Signed
 * in only: a local copy's photos have no bucket to be left in.
 */
export function retireMedia(ids: readonly (string | undefined)[], after: readonly (string | undefined)[], garment: string): void {
  if (!getSupabase() || !garment) return
  const gone = ids.filter((id): id is string => !!id && id.startsWith(PERSONAL_PREFIX))
  if (gone.length === 0) return
  writeRetiring([...readRetiring(), { ids: gone, after: after.filter((id): id is string => !!id), at: Date.now(), garment }].slice(-MAX_RETIRING))
  // nothing else may flush for a while: look again once the minute is up
  setTimeout(() => void flushPendingMedia(), RETIRE_AFTER_MS + 1_000)
}

/**
 * The server has the piece as this device last wrote it, and no copy it may
 * still hold points at these photos. Until then they stay: deleted while the
 * edit that let them go is still waiting to push, and then lost to a failed
 * round or a sign-out, they would leave the server's piece pointing at nothing.
 */
const settled = (e: Retiring, used: MediaInUse) => !used.unsynced.has(e.garment) && !e.ids.some(id => used.onServer.has(id))
/** Of an entry's photos, the ones that are this account's own and that no piece here points at. */
const unused = (e: Retiring, used: MediaInUse, userId: string) => e.ids.filter(id => isPersonalMediaOf(id, userId) && !used.ids.has(id))

/**
 * The swaps' core, with their state handed in (the tests run it with none). An
 * entry is due once none of its replacements is waiting to upload,
 * RETIRE_AFTER_MS has passed and it is settled on the server; a due entry's
 * photos go if they are this account's own and nothing points at them, and
 * the entry is done either way — a photo pointed at again was brought back
 * (an Undo, another device) and stays. Without the planner's records, or an
 * account, nothing is due.
 */
export function dueForRemoval(entries: readonly Retiring[], waiting: ReadonlySet<string>, used: MediaInUse | null, now: number): { keep: Retiring[]; remove: string[] } {
  const keep: Retiring[] = []
  const remove = new Set<string>()
  const userId = used?.userId
  for (const e of entries) {
    if (!used || !userId || now - e.at < RETIRE_AFTER_MS || e.after.some(id => waiting.has(id)) || !settled(e, used)) {
      keep.push(e)
      continue
    }
    for (const id of unused(e, used, userId)) remove.add(id)
  }
  return { keep, remove: [...remove] }
}

/**
 * Swapped-out photos that are already no loss: the swap is settled on the
 * server and nothing points at them, so they only wait for their minute. A
 * sign-out doesn't count them as photos it would lose.
 */
export function swappedOut(entries: readonly Retiring[], used: MediaInUse | null): string[] {
  const userId = used?.userId
  if (!used || !userId) return []
  return entries.flatMap(e => (settled(e, used) ? unused(e, used, userId) : []))
}

/** After a flush, or a sync round: let go of the swapped-out photos that are due. */
async function retireSwapped(): Promise<void> {
  if (!inUse || readRetiring().length === 0) return
  const waiting = new Set((await idbAll<MediaItem>('media')).filter(i => i.pending).map(i => i.id))
  // the records as they are now, and the queue read and written with no await
  // between, so a swap queued meanwhile is not lost
  const { keep, remove } = dueForRemoval(readRetiring(), waiting, currentUse(), Date.now())
  writeRetiring(keep)
  if (remove.length) await deleteMedia(remove)
}

/**
 * Look at the swaps again, without a flush: the planner calls it whenever a
 * sync round is answered, as that may be the round that confirmed the edit a
 * swap waits on. With none queued it reads nothing but the queue.
 */
export function retireDue(): Promise<void> {
  if (!getSupabase()) return Promise.resolve()
  return retireSwapped().catch(() => {})
}

/**
 * Gone for good: the object URL, this device's copy and the bucket's, best
 * effort. Trash → Delete forever on a garment calls it, and so does a swap
 * (retireMedia) for a photo no piece points at any more; a plain delete keeps
 * the photos so Restore brings the piece back whole.
 */
export async function deleteMedia(ids: readonly (string | undefined)[]): Promise<void> {
  const gone = ids.filter((id): id is string => !!id)
  if (gone.length === 0) return
  for (const id of gone) {
    forgetURL(id)
    forgetUse(id)
    await idbDel('media', id).catch(() => {})
  }
  const sb = getSupabase()
  if (sb) await sb.storage.from('media').remove(gone).catch(() => {})
}

// ---- object URLs ------------------------------------------------------------------
//
// Every photo drawn needs an object URL, and each one keeps its whole blob in
// memory until revoked. They were never revoked, so an app left open for days
// held every photo it had shown. Now at most URL_MAX of them, and URL_BYTES
// between them, are kept, the least recently asked for let go first — well
// beyond what one screen shows, so what goes is what nobody is looking at.

const native = (): boolean => (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true
/** Object URLs kept at most. */
export const URL_MAX = 400
/** And the bytes they keep in memory between them: the iPhone has less to spare. */
export const urlBytesMax = (): number => (native() ? 48 : 96) * 1024 * 1024

/** Object URLs by photo id, the least recently asked for first. */
const urlCache = new Map<string, { url: string; bytes: number }>()
let urlBytes = 0

function forgetURL(id: string): void {
  const had = urlCache.get(id)
  if (!had) return
  URL.revokeObjectURL(had.url)
  urlBytes -= had.bytes
  urlCache.delete(id)
}

/** Keep this URL, as the most recently asked for, and let the oldest go past the caps (never the one just kept). */
function keepURL(id: string, url: string, bytes: number): void {
  forgetURL(id)
  urlCache.set(id, { url, bytes })
  urlBytes += bytes
  for (const old of urlCache.keys()) {
    if (old === id || (urlCache.size <= URL_MAX && urlBytes <= urlBytesMax())) break
    forgetURL(old)
  }
}

/** The URL for this id, moved up as the most recently asked for. */
function cachedURL(id: string): string | null {
  const had = urlCache.get(id)
  if (!had) return null
  urlCache.delete(id)
  urlCache.set(id, had)
  noteUse(id)
  return had.url
}

/** The object URL already made for this id, if any: a thumbnail seen once paints at once the next time. */
export const peekMediaURL = (id: string): string | null => cachedURL(id)

/** One lookup per id at a time: two views asking at once made two URLs, and the first was never let go. */
const lookups = new Map<string, Promise<string | null>>()

export function mediaURL(id: string): Promise<string | null> {
  const cached = cachedURL(id)
  if (cached) return Promise.resolve(cached)
  let pending = lookups.get(id)
  if (!pending) {
    pending = lookUp(id).finally(() => lookups.delete(id))
    lookups.set(id, pending)
  }
  return pending
}

async function lookUp(id: string): Promise<string | null> {
  let item = await idbGet<MediaItem>('media', id)
  if (!item) {
    // not on this device — pull from the cloud bucket and cache it
    const sb = getSupabase()
    if (!sb) return null
    let data = await throughLink(id)
    if (!data) {
      const got = await sb.storage.from('media').download(id)
      if (got.error || !got.data) return null
      data = got.data
    }
    item = { id, name: id, type: data.type, blob: data }
    idbSet('media', id, item)
      .then(() => grew(data.size))
      .catch(() => {})
  }
  noteUse(id)
  const url = URL.createObjectURL(item.blob)
  keepURL(id, url, item.blob.size)
  return url
}

// ---- a housemate's picture ---------------------------------------------------------
//
// A member's picture (v3.25) is in no record, so the storage policy — which
// lets a housemate read a photo only when a record they can read vouches for
// it — refuses the other member's, and they saw initials. /api/household signs
// a short-lived link to each member's picture instead (src/household.ts hands
// them here). A picture fetched through one is kept on this device like any
// other photo, so the link is needed once.

/** A link is left alone this long before it expires: a fetch under way should not outlive it. */
const LINK_MARGIN_MS = 60_000

const mediaLinks = new Map<string, { url: string; until: number }>()
const linkWaiters = new Map<string, Set<() => void>>()

/**
 * Signed links to pictures, as /api/household answers them: the newest for
 * each id wins, one already expired is ignored, and a view waiting on one is
 * told it has come.
 */
export function rememberMediaLinks(links: Iterable<{ id: string; url: string; expiresAt: string }>, now = Date.now()): void {
  for (const { id, url, expiresAt } of links) {
    const until = Date.parse(expiresAt)
    if (!id || !/^https:\/\//.test(url) || !(until - LINK_MARGIN_MS > now)) continue
    mediaLinks.set(id, { url, until })
    for (const tell of linkWaiters.get(id) ?? []) tell()
  }
}

/** Be told when a link to this picture comes; returns the unsubscribe. */
export function onMediaLink(id: string, tell: () => void): () => void {
  const waiting = linkWaiters.get(id) ?? new Set()
  waiting.add(tell)
  linkWaiters.set(id, waiting)
  return () => {
    waiting.delete(tell)
    if (!waiting.size) linkWaiters.delete(id)
  }
}

/** The picture through its signed link, or null when there is no live link or it fails. */
async function throughLink(id: string): Promise<Blob | null> {
  const link = mediaLinks.get(id)
  if (!link || link.until - LINK_MARGIN_MS <= Date.now()) return null
  try {
    const res = await fetch(link.url)
    return res.ok ? await res.blob() : null
  } catch {
    return null
  }
}

// ---- the photo cache on this device -----------------------------------------------
//
// Every photo viewed was kept in IndexedDB for good: only Delete forever took
// one out. So the cache grew with everything ever looked at, and a note a
// housemate stopped sharing left its photos readable here until sign-out. It
// is trimmed now, with the bucket as the copy that counts: a photo still
// waiting to upload is never touched, and in local mode — no bucket, this is
// the only copy — nothing is.

/** The cache kept at most, photos waiting to upload included: less in the app. */
export const cacheBytesMax = (): number => (native() ? 80 : 150) * 1024 * 1024
/** Trimmed down to this share of the cap, so it is not trimmed again at the next photo. */
const TRIM_TO = 0.8
/** A photo used this recently stays, whatever else: it may belong to an edit not saved yet. */
export const RECENT_USE_MS = 30 * 60_000
/** Trimmed at most this often. */
const TRIM_EVERY_MS = 6 * 3_600_000
/** When each photo was last shown (epoch ms), kept across launches. A drafter:* key, so sign-out forgets it. */
export const USED_KEY = 'drafter:media-used'

let used: Map<string, number> | null = null
let usedTimer: ReturnType<typeof setTimeout> | undefined

function shownMap(kv: KV = browserKV): Map<string, number> {
  if (used) return used
  used = new Map()
  try {
    const raw: unknown = JSON.parse(kv.getItem(USED_KEY) ?? '{}')
    if (raw && typeof raw === 'object') for (const [id, at] of Object.entries(raw)) if (typeof at === 'number') used.set(id, at)
  } catch {
    /* a corrupt list only costs the order photos are let go in */
  }
  return used
}

function saveUse(kv: KV = browserKV): void {
  if (usedTimer !== undefined) return
  usedTimer = setTimeout(() => {
    usedTimer = undefined
    try {
      kv.setItem(USED_KEY, JSON.stringify(Object.fromEntries(shownMap(kv))))
    } catch {
      /* storage full: the order is kept in memory for this session */
    }
  }, 5_000)
}

function noteUse(id: string): void {
  shownMap().set(id, Date.now())
  saveUse()
}

function forgetUse(id: string): void {
  if (shownMap().delete(id)) saveUse()
}

/** Bytes downloaded since the last trim: past the cap, the next trim comes sooner. */
let grownSince = 0
let lastTrim = 0
let cacheBytes: number | null = null

function grew(bytes: number): void {
  grownSince += bytes
  if (cacheBytes !== null && cacheBytes + grownSince > cacheBytesMax()) lastTrim = 0
}

/** A cached photo as the trim weighs it. */
export interface CachedPhoto {
  id: string
  bytes: number
  /** Still waiting to upload: this device holds the only copy. */
  pending?: boolean
}

/**
 * The trim's core, with its inputs handed in: which of the photos this device
 * holds to let go. Never one waiting to upload, nor one shown in the last
 * RECENT_USE_MS. First every photo no record points at; then, while the cache
 * is over `cap`, the least recently shown of the rest, down to TRIM_TO of it.
 */
export function photosToTrim(photos: readonly CachedPhoto[], referenced: ReadonlySet<string>, usedAt: ReadonlyMap<string, number>, cap: number, now: number): string[] {
  const out: string[] = []
  let total = photos.reduce((n, p) => n + p.bytes, 0)
  const spare = photos.filter(p => !p.pending && now - (usedAt.get(p.id) ?? 0) >= RECENT_USE_MS)
  for (const p of spare) {
    if (referenced.has(p.id)) continue
    out.push(p.id)
    total -= p.bytes
  }
  if (total <= cap) return out
  const byAge = spare.filter(p => referenced.has(p.id)).sort((a, b) => (usedAt.get(a.id) ?? 0) - (usedAt.get(b.id) ?? 0))
  for (const p of byAge) {
    if (total <= cap * TRIM_TO) break
    out.push(p.id)
    total -= p.bytes
  }
  return out
}

/**
 * Every photo id the records point at: the pieces of clothing's fields, a
 * task's images and files, and every <img data-media> in a note or a
 * project's pad — found by walking each record whole, so a field added later
 * cannot be the one missed. Tombstones deleted forever point at nothing.
 */
export function mediaReferences(records: readonly unknown[], extra: Iterable<string | null | undefined> = []): Set<string> {
  const ids = new Set<string>()
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      ids.add(v)
      if (v.includes('data-media')) for (const m of v.matchAll(/data-media="([^"]+)"/g)) ids.add(m[1])
    } else if (Array.isArray(v)) for (const x of v) walk(x)
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
  }
  for (const r of records) if (!(r as { purged?: unknown } | null)?.purged) walk(r)
  for (const id of extra) if (id) ids.add(id)
  return ids
}

/**
 * Let go of the cached photos the trim picks (photosToTrim): from this
 * device only — the bucket keeps its copy, and a photo asked for again comes
 * back from it. With the planner's records in hand, after a round has
 * answered; at most every few hours, or sooner once downloads pass the cap.
 * Does nothing in local mode.
 */
export async function trimMediaCache(referenced: () => ReadonlySet<string>, now = Date.now()): Promise<number> {
  if (!getSupabase() || now - lastTrim < TRIM_EVERY_MS) return 0
  lastTrim = now
  const items = await idbAll<MediaItem>('media').catch(() => null)
  if (!items) return 0
  const photos = items.map(i => ({ id: i.id, bytes: i.blob?.size ?? 0, pending: i.pending }))
  const drop = photosToTrim(photos, referenced(), shownMap(), cacheBytesMax(), now)
  for (const id of drop) {
    forgetURL(id)
    forgetUse(id)
    await idbDel('media', id).catch(() => {})
  }
  const left = new Set(photos.map(p => p.id).filter(id => !drop.includes(id)))
  // what nothing here holds any more has no order to keep
  for (const id of [...shownMap().keys()]) if (!left.has(id)) forgetUse(id)
  cacheBytes = photos.filter(p => left.has(p.id)).reduce((n, p) => n + p.bytes, 0)
  grownSince = 0
  return drop.length
}

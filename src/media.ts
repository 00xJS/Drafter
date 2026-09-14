import { PERSONAL_PREFIX, isPersonalMediaOf } from '../shared/media.mjs'
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

const urlCache = new Map<string, string>()

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
    const url = urlCache.get(id)
    if (url) {
      URL.revokeObjectURL(url)
      urlCache.delete(id)
    }
    await idbDel('media', id).catch(() => {})
  }
  const sb = getSupabase()
  if (sb) await sb.storage.from('media').remove(gone).catch(() => {})
}

/** The object URL already made for this id, if any: a thumbnail seen once paints at once the next time. */
export const peekMediaURL = (id: string): string | null => urlCache.get(id) ?? null

export async function mediaURL(id: string): Promise<string | null> {
  const cached = urlCache.get(id)
  if (cached) return cached

  let item = await idbGet<MediaItem>('media', id)
  if (!item) {
    // not on this device — pull from the cloud bucket and cache it
    const sb = getSupabase()
    if (!sb) return null
    const { data, error } = await sb.storage.from('media').download(id)
    if (error || !data) return null
    item = { id, name: id, type: data.type, blob: data }
    idbSet('media', id, item).catch(() => {})
  }

  const url = URL.createObjectURL(item.blob)
  urlCache.set(id, url)
  return url
}

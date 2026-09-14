import { idbAll, idbDel, idbGet, idbSet } from './idb'
import { getSupabase } from './supabase'
import { uid } from './utils'

// Images live in the Supabase Storage bucket "media" so every signed-in device
// — and the backup story — sees them. IndexedDB is the local copy, the offline
// fallback and the upload queue: a photo is saved here first, marked pending,
// and loses the mark only once the bucket has it, so one taken offline or on a
// flaky connection goes up later rather than never. Note photos and task
// images are the household's; a garment's is personal, under its uploader's
// own personal/<user id>/ folder, which the v3.14 storage policies keep to
// that account. Local mode keeps working, local-only.

export interface MediaItem {
  id: string
  name: string
  type: string
  blob: Blob
  /** Saved here, not yet in the bucket. Absent on every item saved before the
   *  queue and on every downloaded copy, so nothing old is ever re-uploaded. */
  pending?: true
}

const urlCache = new Map<string, string>()

/**
 * Keep a photo or file on this device and queue it for the bucket. A personal
 * one is filed under personal/<the session's user id>/ (getSession reads local
 * storage, so this works offline); in local mode, or with no session, the id is
 * a bare uid, as a note photo's always is.
 */
export async function saveMedia(file: Blob & { name?: string }, opts: { personal?: boolean } = {}): Promise<string> {
  const sb = getSupabase()
  let id = uid()
  if (opts.personal && sb) {
    try {
      const { data } = await sb.auth.getSession()
      const user = data.session?.user.id
      if (user) id = `personal/${user}/${uid()}`
    } catch {
      /* no session to read: a bare id, which the owner-scoped policies still cover */
    }
  }
  const item: MediaItem = { id, name: file.name ?? id, type: file.type, blob: file }
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
 * Gone for good: the object URL, this device's copy and the bucket's, best
 * effort. Only Trash → Delete forever on a garment calls it; a plain delete
 * keeps the photos so Restore brings the piece back whole.
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

import { idbGet, idbSet } from './idb'
import { getSupabase } from './supabase'
import { uid } from './utils'

// Images live in the Supabase Storage bucket "media" (owner-scoped) so every
// signed-in device — and the backup story — sees them. IndexedDB stays as the
// local cache and the offline fallback; local mode keeps working, local-only.

export interface MediaItem {
  id: string
  name: string
  type: string
  blob: Blob
}

const urlCache = new Map<string, string>()

export async function saveMedia(file: File): Promise<string> {
  const id = uid()
  const item: MediaItem = { id, name: file.name, type: file.type, blob: file }
  await idbSet('media', id, item)
  const sb = getSupabase()
  if (sb) {
    sb.storage
      .from('media')
      .upload(id, file, { contentType: file.type, upsert: true })
      .then(({ error }) => {
        if (error) console.error('Media upload failed (kept locally):', error.message)
      })
  }
  return id
}

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

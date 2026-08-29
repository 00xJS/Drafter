import { idbGet, idbSet } from './idb'
import { uid } from './utils'

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
  return id
}

export async function mediaURL(id: string): Promise<string | null> {
  const cached = urlCache.get(id)
  if (cached) return cached
  const item = await idbGet<MediaItem>('media', id)
  if (!item) return null
  const url = URL.createObjectURL(item.blob)
  urlCache.set(id, url)
  return url
}

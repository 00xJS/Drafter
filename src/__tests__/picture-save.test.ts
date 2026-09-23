import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A task's or a note's picture as the media store keeps it (src/picture.ts, src/media.ts):
// the picture preparePicture made, under a JPEG's name, with its small copy in
// the same entry for the task editor's squares — or the file as it came when
// this browser could not read it. preparePicture itself is picture.test.ts's.

const { rows, prepare, urls } = vi.hoisted(() => ({
  rows: new Map<string, { id: string; name: string; type: string; blob: Blob; thumb?: Blob; pending?: true }>(),
  prepare: vi.fn(),
  urls: { made: new Map<string, Blob>(), revoked: [] as string[] },
}))

vi.mock('../idb', () => ({
  idbGet: vi.fn(async (_store: string, key: string) => rows.get(key)),
  idbSet: vi.fn(async (_store: string, key: string, value: never) => void rows.set(key, value)),
  idbDel: vi.fn(async (_store: string, key: string) => void rows.delete(key)),
  idbAll: vi.fn(async () => [...rows.values()]),
}))
vi.mock('../supabase', () => ({ getSupabase: () => null, storedUserId: () => null }))
vi.mock('../photo', () => ({ preparePicture: prepare }))

import { deleteMedia, mediaThumbURL, mediaURL } from '../media'
import { jpegName, savePicture } from '../picture'

const camera = () => new File([new Uint8Array(3_000_000)], 'IMG_0412.HEIC', { type: 'image/heic' })
const jpeg = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })

beforeEach(() => {
  rows.clear()
  prepare.mockReset()
  urls.made.clear()
  urls.revoked = []
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    const url = `blob:${++n}`
    urls.made.set(url, blob as Blob)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(u => void urls.revoked.push(u))
  const kv = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('savePicture', () => {
  it('keeps the redrawn picture, named as the JPEG it now is, with its small copy beside it', async () => {
    const picture = jpeg(310_000)
    const thumb = jpeg(24_000)
    prepare.mockResolvedValueOnce({ picture, thumb })
    const id = await savePicture(camera())
    const kept = rows.get(id)!
    expect(kept.name).toBe('IMG_0412.jpg')
    expect(kept.type).toBe('image/jpeg')
    expect(kept.blob.size).toBe(310_000)
    expect(kept.thumb).toBe(thumb)
  })

  it('keeps a picture that needed no redraw as it came, name and all', async () => {
    const file = new File([new Uint8Array(40_000)], 'receipt.png', { type: 'image/png' })
    prepare.mockResolvedValueOnce({ picture: file, thumb: null })
    const id = await savePicture(file)
    expect(rows.get(id)!.blob).toBe(file)
    expect(rows.get(id)!.name).toBe('receipt.png')
    expect(rows.get(id)!.thumb).toBeUndefined()
  })

  it('keeps a picture this browser cannot read as it came, rather than losing it', async () => {
    prepare.mockRejectedValueOnce(new Error('That photo can’t be read here'))
    const file = camera()
    const id = await savePicture(file)
    expect(rows.get(id)!.blob).toBe(file)
    expect(rows.get(id)!.name).toBe('IMG_0412.HEIC')
  })

  it('names a JPEG after the picture it came from', () => {
    expect(jpegName('IMG_0412.HEIC')).toBe('IMG_0412.jpg')
    expect(jpegName('scan.of.page.png')).toBe('scan.of.page.jpg')
    expect(jpegName('pasted')).toBe('pasted.jpg')
    expect(jpegName('.png')).toBe('picture.jpg')
  })
})

describe('mediaThumbURL: a square drawn from the small copy', () => {
  it('draws from the small copy where this device has one, and remembers it', async () => {
    const thumb = jpeg(24_000)
    prepare.mockResolvedValueOnce({ picture: jpeg(310_000), thumb })
    const id = await savePicture(camera())
    const url = await mediaThumbURL(id)
    expect(urls.made.get(url!)).toBe(thumb)
    expect(await mediaThumbURL(id)).toBe(url)
    expect(urls.made.size).toBe(1)
    // the picture itself is its own URL
    expect(urls.made.get((await mediaURL(id))!)!.size).toBe(310_000)
  })

  it('draws the picture itself where there is no small copy: one downloaded, or saved before', async () => {
    rows.set('old', { id: 'old', name: 'old.jpg', type: 'image/jpeg', blob: jpeg(900_000) })
    const url = await mediaThumbURL('old')
    expect(urls.made.get(url!)!.size).toBe(900_000)
    expect(await mediaURL('old')).toBe(url)
  })

  it('lets go of both URLs when the picture goes', async () => {
    prepare.mockResolvedValueOnce({ picture: jpeg(310_000), thumb: jpeg(24_000) })
    const id = await savePicture(camera())
    const small = await mediaThumbURL(id)
    const big = await mediaURL(id)
    await deleteMedia([id])
    expect(urls.revoked.sort()).toEqual([small, big].sort())
    expect(rows.has(id)).toBe(false)
  })
})

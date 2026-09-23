import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PICTURE_EDGE, PhotoUnreadable, THUMB_EDGE, keepsPicture, preparePicture } from '../photo'

// A task's or a note's picture, made ready before it is saved: the rule for
// what is kept as it came, and the one decode that makes the rest — here with
// a stand-in <img> and canvas, since node has neither, recording every
// drawing asked of them. The decode itself (orientation included) is the
// browser's, and the same one the garment photos have always used.

describe('keepsPicture: what is saved byte for byte', () => {
  it('keeps a screenshot or a saved image already within the edge', () => {
    expect(keepsPicture('image/png', 1179, 1600)).toBe(true)
    expect(keepsPicture('image/jpeg', 1600, 1200)).toBe(true)
    expect(keepsPicture('image/webp', 800, 600)).toBe(true)
  })

  it('keeps a GIF or an SVG at any size: a redraw would still the one and flatten the other', () => {
    expect(keepsPicture('image/gif', 4000, 3000)).toBe(true)
    expect(keepsPicture('image/svg+xml', 5000, 5000)).toBe(true)
  })

  it("redraws the camera's full photo, and a HEIC of any size, which not every browser shows", () => {
    expect(keepsPicture('image/jpeg', 4032, 3024)).toBe(false)
    expect(keepsPicture('image/png', 1179, 2556)).toBe(false)
    expect(keepsPicture('image/heic', 4032, 3024)).toBe(false)
    expect(keepsPicture('image/heic', 800, 600)).toBe(false)
    expect(keepsPicture('', 800, 600)).toBe(false)
  })

  it('gives a picture more room than a garment photo, and the same thumbnail', () => {
    expect(PICTURE_EDGE).toBe(1600)
    expect(THUMB_EDGE).toBe(360)
  })
})

// ---- a stand-in browser: an <img> that decodes what it is told, and canvases that remember

/** What each picked file decodes to, by the object URL made for it; absent, it will not decode. */
const sizes = new Map<Blob, { w: number; h: number }>()
const urls = new Map<string, Blob>()
/** Every canvas drawn: its size, and the JPEG asked of it. */
let canvases: { width: number; height: number; drew: number; type?: string; quality?: number }[] = []
let decodes = 0

class FakeImage {
  src = ''
  naturalWidth = 0
  naturalHeight = 0
  async decode() {
    decodes++
    const size = sizes.get(urls.get(this.src)!)
    if (!size) throw new Error('EncodingError')
    ;[this.naturalWidth, this.naturalHeight] = [size.w, size.h]
  }
  removeAttribute() {}
}

beforeEach(() => {
  sizes.clear()
  urls.clear()
  canvases = []
  decodes = 0
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    const url = `blob:${++n}`
    urls.set(url, blob as Blob)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        drew: 0,
        getContext: () => ({ fillStyle: '', fillRect() {}, drawImage: () => void canvas.drew++ }),
        toBlob(done: (b: Blob) => void, type: string, quality: number) {
          Object.assign(record, { type, quality })
          done(new Blob([`${canvas.width}x${canvas.height}`], { type }))
        },
      }
      const record = canvas as (typeof canvases)[number]
      canvases.push(record)
      return canvas
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A picked file that decodes to w × h. */
function picked(type: string, w: number, h: number): Blob {
  const file = new Blob(['pixels'], { type })
  sizes.set(file, { w, h })
  return file
}

describe('preparePicture: one decode, then only what is needed', () => {
  it("draws the camera's 12MP photo at 1600px and a 360px thumbnail, both JPEGs", async () => {
    const file = picked('image/jpeg', 4032, 3024)
    const { picture, thumb } = await preparePicture(file)
    expect(decodes).toBe(1)
    expect(canvases.map(c => [c.type, c.quality])).toEqual([
      ['image/jpeg', 0.82],
      ['image/jpeg', 0.72],
    ])
    expect(await picture.text()).toBe('1600x1200')
    expect(picture.type).toBe('image/jpeg')
    expect(await thumb!.text()).toBe('360x270')
    // the pixels are let go at once
    expect(canvases.every(c => c.width === 0 && c.height === 0)).toBe(true)
  })

  it('keeps a portrait screenshot within the edge as it came, with a thumbnail beside it', async () => {
    const file = picked('image/png', 1179, 1600)
    const { picture, thumb } = await preparePicture(file)
    expect(picture).toBe(file)
    expect(canvases).toHaveLength(1)
    expect(await thumb!.text()).toBe('265x360')
  })

  it('makes no thumbnail for a picture no bigger than one', async () => {
    const file = picked('image/png', 300, 200)
    expect(await preparePicture(file)).toEqual({ picture: file, thumb: null })
    expect(canvases).toHaveLength(0)
  })

  it('redraws a HEIC this browser can read, at its own size when it is small, so every device can show it', async () => {
    const { picture } = await preparePicture(picked('image/heic', 1000, 800))
    expect(picture.type).toBe('image/jpeg')
    expect(await picture.text()).toBe('1000x800')
  })

  it('keeps a GIF whole, without decoding it', async () => {
    const file = picked('image/gif', 2000, 2000)
    expect(await preparePicture(file)).toEqual({ picture: file, thumb: null })
    expect(decodes).toBe(0)
  })

  it('says it cannot read a picture this browser cannot decode, so the caller keeps it as it came', async () => {
    await expect(preparePicture(new Blob(['?'], { type: 'image/heic' }))).rejects.toBeInstanceOf(PhotoUnreadable)
    expect(canvases).toHaveLength(0)
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FACE_EDGE, PhotoUnreadable, faceCrop, prepareFace } from '../photo'

// Settings → You's picture. It was decoded with createImageBitmap, which can
// leave the EXIF rotation unapplied, so an iPhone photo could come out lying on
// its side. It goes through the <img> decode every other photo in the app
// takes now, which turns it the way the camera held it, and is then cut to its
// middle square — here with a stand-in <img> and canvas, as node has neither.

describe('faceCrop: the middle square, at most the edge across', () => {
  it('takes a portrait photo’s middle, its width across', () => {
    expect(faceCrop(3024, 4032, FACE_EDGE)).toEqual({ sx: 0, sy: 504, side: 3024, size: 512 })
  })

  it('takes a landscape one’s middle, its height across', () => {
    expect(faceCrop(4032, 3024, FACE_EDGE)).toEqual({ sx: 504, sy: 0, side: 3024, size: 512 })
  })

  it('never draws a small one bigger, and never under a pixel', () => {
    expect(faceCrop(300, 200, FACE_EDGE)).toEqual({ sx: 50, sy: 0, side: 200, size: 200 })
    expect(faceCrop(0, 0, FACE_EDGE).size).toBe(1)
  })
})

// ---- a stand-in browser

const sizes = new Map<string, { w: number; h: number }>()
let drawn: unknown[][] = []
let decodes = 0

class FakeImage {
  src = ''
  naturalWidth = 0
  naturalHeight = 0
  async decode() {
    decodes++
    const size = sizes.get(this.src)
    if (!size) throw new Error('EncodingError')
    ;[this.naturalWidth, this.naturalHeight] = [size.w, size.h]
  }
  removeAttribute() {}
}

beforeEach(() => {
  sizes.clear()
  drawn = []
  decodes = 0
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++n}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('Image', FakeImage)
  // the decode that could leave a photo on its side is never reached for
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      throw new Error('not this one')
    }),
  )
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: '', fillRect() {}, drawImage: (...args: unknown[]) => void drawn.push(args.slice(1)) }),
        toBlob: (done: (b: Blob) => void, type: string, quality: number) => done(new Blob([`${canvas.width}x${canvas.height} ${quality}`], { type })),
      }
      return canvas
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('prepareFace', () => {
  it('decodes once through an <img>, which turns the photo upright, and cuts the middle square', async () => {
    // an iPhone portrait: the <img> reports it the way the camera held it
    sizes.set('blob:1', { w: 3024, h: 4032 })
    const face = await prepareFace(new Blob(['jpeg'], { type: 'image/jpeg' }))
    expect(decodes).toBe(1)
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(drawn).toEqual([[0, 504, 3024, 3024, 0, 0, 512, 512]])
    expect(face.type).toBe('image/jpeg')
    expect(await face.text()).toBe('512x512 0.85')
  })

  it('says it cannot read what this browser cannot decode, so the picture is kept as picked', async () => {
    await expect(prepareFace(new Blob(['?'], { type: 'image/heic' }))).rejects.toBeInstanceOf(PhotoUnreadable)
  })

  it('is what Settings → You uses, and nothing there decodes a photo another way', () => {
    const profile = readFileSync(fileURLToPath(new URL('../components/settings/Profile.tsx', import.meta.url)), 'utf8')
    expect(profile).toMatch(/return await prepareFace\(file\)/)
    expect(profile).not.toMatch(/createImageBitmap/)
  })
})

import { describe, expect, it } from 'vitest'
import { PHOTO_EDGE, PhotoUnreadable, THUMB_EDGE, averageHex, fitWithin, keepsAsIs } from '../photo'
import { colorName } from '../wardrobe'

// A garment photo's two sizes and its colour: the maths prepareGarmentPhoto
// runs on the canvas. The decode itself needs a browser (see the browser
// check); everything it computes is here.

const pixels = (...rgba: [number, number, number, number][]) => new Uint8ClampedArray(rgba.flat())

describe('keepsAsIs: the cut-out step, a cut-out never encoded twice', () => {
  it('keeps the cut-out sheet’s JPEG as the photo when it is 1200px or less', () => {
    expect(keepsAsIs('image/jpeg', 1200, 900, true)).toBe(true)
    expect(keepsAsIs('image/jpeg', 651, 1200, true)).toBe(true)
    expect(keepsAsIs('image/jpeg', 84, 144, true)).toBe(true)
  })

  it('draws anything else afresh: a larger cut-out, another type, or the photo as picked', () => {
    expect(keepsAsIs('image/jpeg', 1201, 900, true)).toBe(false)
    expect(keepsAsIs('image/png', 800, 600, true)).toBe(false)
    expect(keepsAsIs('image/jpeg', 800, 600, false)).toBe(false)
    expect(keepsAsIs('', 800, 600, true)).toBe(false)
  })

  it('agrees with the cut-out’s own size: its long edge is the piece photo’s', () => {
    expect(PHOTO_EDGE).toBe(1200)
  })
})

describe('fitWithin: inside the longest edge, never upscaled', () => {
  it('fits a landscape photo by its width', () => {
    expect(fitWithin(4032, 3024, PHOTO_EDGE)).toEqual({ w: 1200, h: 900 })
  })

  it('fits a portrait photo by its height', () => {
    expect(fitWithin(3024, 4032, THUMB_EDGE)).toEqual({ w: 270, h: 360 })
  })

  it('fits a square one', () => {
    expect(fitWithin(2000, 2000, PHOTO_EDGE)).toEqual({ w: 1200, h: 1200 })
  })

  it('leaves a photo already small enough as it is', () => {
    expect(fitWithin(300, 200, THUMB_EDGE)).toEqual({ w: 300, h: 200 })
    expect(fitWithin(360, 360, THUMB_EDGE)).toEqual({ w: 360, h: 360 })
  })

  it('rounds, and never goes under a pixel', () => {
    // 333 × 360 / 1001 = 119.76
    expect(fitWithin(1001, 333, THUMB_EDGE)).toEqual({ w: 360, h: 120 })
    expect(fitWithin(5000, 1, THUMB_EDGE)).toEqual({ w: 360, h: 1 })
    expect(fitWithin(0, 0, THUMB_EDGE)).toEqual({ w: 1, h: 1 })
  })

  it('makes the two sizes the rows and the piece sheet use', () => {
    expect([PHOTO_EDGE, THUMB_EDGE]).toEqual([1200, 360])
  })
})

describe('averageHex: the garment’s colour, not the sheet it lies on', () => {
  it('reads a solid colour', () => {
    expect(averageHex(pixels([31, 42, 68, 255], [31, 42, 68, 255]))).toBe('#1f2a44')
    // and names it the way the sheet suggests names
    expect(colorName(averageHex(pixels([31, 42, 68, 255])))).toBe('navy')
  })

  it('averages every pixel it keeps', () => {
    expect(averageHex(pixels([0, 0, 0, 255], [100, 50, 20, 255]))).toBe('#32190a')
  })

  it('skips near-white pixels while anything else is left', () => {
    expect(averageHex(pixels([250, 250, 250, 255], [255, 255, 255, 255], [120, 72, 40, 255]))).toBe('#784828')
    // one channel under 245 is not white
    expect(averageHex(pixels([255, 255, 255, 255], [244, 250, 250, 255]))).toBe('#f4fafa')
  })

  it('reads white when white is all there is', () => {
    expect(averageHex(pixels([255, 255, 255, 255], [250, 248, 246, 255]))).toBe('#fdfcfb')
  })

  it('skips transparent pixels', () => {
    expect(averageHex(pixels([0, 0, 0, 0], [200, 0, 0, 255], [0, 0, 255, 20]))).toBe('#c80000')
    expect(averageHex(pixels([10, 10, 10, 0]))).toBe('#ffffff')
    expect(averageHex(new Uint8ClampedArray())).toBe('#ffffff')
  })

  it('always gives a colour the sanitizer keeps', () => {
    for (const c of [pixels([1, 2, 3, 255]), pixels([255, 0, 128, 255]), pixels([7, 7, 7, 0])]) expect(averageHex(c)).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('an unreadable photo', () => {
  it('says what to try instead', () => {
    const err = new PhotoUnreadable()
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('That photo can’t be read here — try a JPEG or PNG')
  })
})

import { describe, expect, it } from 'vitest'
import {
  chooseSubjects,
  compositeOnWhite,
  CUTOUT,
  dilate,
  erode,
  fillSmallHoles,
  finishOnWhite,
  fitWithin,
  judgeMask,
  keepMainComponents,
  keepSubjects,
  liftedAlpha,
  maskStats,
  paddedBox,
  pickBest,
  pickForegroundMask,
  planeToAlpha,
  pointInContainedImage,
  refineMask,
  resizeArea,
  resizePlaneBilinear,
  smoothstep,
  subjectAt,
  subjectForTap,
  subjectsIn,
  usableMask,
  type InstanceMask,
  type MaskStats,
  type Plane,
  type Rgba,
} from '../cutoutmath'

// The garment cut-out's finish and the web engine's mask clean-up, on buffers
// small enough to check by hand. All of it runs in node: no canvas, no DOM.

/** A width × height image of one colour. */
function solid(width: number, height: number, rgba: number[]): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i)
  return { width, height, data }
}

/** A plane from a function of the pixel. */
function plane(width: number, height: number, f: (x: number, y: number) => number): Plane {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x, y)
  return { width, height, data }
}

const inRect = (x0: number, y0: number, w: number, h: number) => (x: number, y: number) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h

/** An alpha channel: `value` inside the rectangle, 0 outside. */
function alphaRect(width: number, height: number, x0: number, y0: number, w: number, h: number, value = 255): Uint8Array {
  const inside = inRect(x0, y0, w, h)
  const alpha = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (inside(x, y)) alpha[y * width + x] = value
  return alpha
}

const pixel = (img: Rgba, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)]
const at = (p: Plane, x: number, y: number) => p.data[y * p.width + x]
const ones = (p: Plane) => p.data.reduce((n, v) => n + (v >= 0.5 ? 1 : 0), 0)

describe('fitWithin', () => {
  it('fits the long edge and keeps the shape', () => {
    expect(fitWithin(3000, 2000, 1200)).toEqual({ width: 1200, height: 800 })
    expect(fitWithin(2000, 3000, 1200)).toEqual({ width: 800, height: 1200 })
    expect(fitWithin(1201, 1, 1200)).toEqual({ width: 1200, height: 1 })
  })

  it('never upscales, and never goes below a pixel', () => {
    expect(fitWithin(1000, 800, 1200)).toEqual({ width: 1000, height: 800 })
    expect(fitWithin(5000, 1, 1200)).toEqual({ width: 1200, height: 1 })
    expect(fitWithin(1, 9000, 1024)).toEqual({ width: 1, height: 1024 })
  })
})

describe('resizeArea', () => {
  it('averages whole blocks exactly', () => {
    const src = solid(4, 2, [0, 0, 0, 255])
    ;[10, 20, 30, 40, 50, 60, 70, 80].forEach((v, i) => (src.data[i * 4] = v))
    const out = resizeArea(src, 2, 1)
    expect([out.width, out.height]).toEqual([2, 1])
    expect([pixel(out, 0, 0)[0], pixel(out, 1, 0)[0]]).toEqual([35, 55])
  })

  it('weights the partial pixels of an uneven step', () => {
    const src = solid(3, 1, [0, 0, 0, 255])
    ;[0, 90, 180].forEach((v, i) => (src.data[i * 4] = v))
    const out = resizeArea(src, 2, 1)
    // [0, 1.5) takes all of 0 and half of 90; [1.5, 3) half of 90 and all of 180
    expect([pixel(out, 0, 0)[0], pixel(out, 1, 0)[0]]).toEqual([30, 150])
  })

  it('keeps pure white exactly 255 at any ratio', () => {
    const out = resizeArea(solid(97, 53, [255, 255, 255, 255]), 31, 17)
    expect(out.data.every(v => v === 255)).toBe(true)
  })

  it('turns a black and white checkerboard into one mid-grey pixel', () => {
    const src = solid(2, 2, [255, 255, 255, 255])
    src.data.set([0, 0, 0, 255], 0)
    src.data.set([0, 0, 0, 255], 12)
    expect(pixel(resizeArea(src, 1, 1), 0, 0)).toEqual([128, 128, 128, 255])
  })

  it('copies an image that is already the size asked for', () => {
    const src = solid(3, 2, [1, 2, 3, 4])
    const out = resizeArea(src, 3, 2)
    expect(out.data).toEqual(src.data)
    expect(out.data).not.toBe(src.data)
  })
})

describe('resizePlaneBilinear', () => {
  it('keeps a constant constant', () => {
    const out = resizePlaneBilinear(plane(3, 2, () => 0.37), 7, 5)
    for (const v of out.data) expect(v).toBeCloseTo(0.37, 6)
  })

  it('keeps the corners when growing a mask to the photo', () => {
    const src = plane(2, 2, (x, y) => [0, 1, 0.25, 0.5][y * 2 + x])
    const out = resizePlaneBilinear(src, 5, 4)
    expect([at(out, 0, 0), at(out, 4, 0), at(out, 0, 3), at(out, 4, 3)]).toEqual([0, 1, 0.25, 0.5])
  })

  it('stays inside [0, 1]', () => {
    let seed = 7
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
    const out = resizePlaneBilinear(plane(9, 7, () => random()), 40, 23)
    expect(Math.min(...out.data)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...out.data)).toBeLessThanOrEqual(1)
  })
})

describe('compositeOnWhite', () => {
  const src = solid(3, 1, [0, 0, 0, 255])
  src.data.set([200, 40, 30, 255], 4)

  it('shows white where alpha is 0 and the photo where it is 255', () => {
    const out = compositeOnWhite(src, new Uint8Array([0, 255, 0]), { x: 0, y: 0, width: 3, height: 1 })
    expect(pixel(out, 0, 0)).toEqual([255, 255, 255, 255])
    expect(pixel(out, 1, 0)).toEqual([200, 40, 30, 255])
  })

  it('lays half-transparent black over white as 127', () => {
    const out = compositeOnWhite(src, new Uint8Array([128, 0, 0]), { x: 0, y: 0, width: 1, height: 1 })
    expect(pixel(out, 0, 0)).toEqual([127, 127, 127, 255])
  })

  it('paints the part of the crop outside the photo white, and everything opaque', () => {
    const out = compositeOnWhite(src, new Uint8Array([255, 255, 255]), { x: -2, y: -1, width: 7, height: 3 })
    expect([out.width, out.height]).toEqual([7, 3])
    expect(pixel(out, 0, 0)).toEqual([255, 255, 255, 255])
    expect(pixel(out, 6, 2)).toEqual([255, 255, 255, 255])
    expect(pixel(out, 2, 1)).toEqual([0, 0, 0, 255])
    expect(pixel(out, 3, 1)).toEqual([200, 40, 30, 255])
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(255)
  })
})

describe('finishOnWhite', () => {
  it('crops a 20 × 10 garment with 12 px of white on every side', () => {
    const src = solid(100, 100, [180, 30, 40, 255])
    const done = finishOnWhite(src, alphaRect(100, 100, 40, 45, 20, 10), CUTOUT.outEdge)!
    // max(12, round(0.08 × 20)) = 12
    expect(done.crop).toEqual({ x: 28, y: 33, width: 44, height: 34 })
    expect([done.image.width, done.image.height]).toEqual([44, 34])
    const { image } = done
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const garment = x >= 12 && x < 32 && y >= 12 && y < 22
        expect(pixel(image, x, y), `${x},${y}`).toEqual(garment ? [180, 30, 40, 255] : [255, 255, 255, 255])
      }
    }
  })

  it('has nothing to finish when the alpha is empty', () => {
    expect(finishOnWhite(solid(10, 10, [0, 0, 0, 255]), new Uint8Array(100), CUTOUT.outEdge)).toBeNull()
  })

  it('fits a wide garment to 1200 px', () => {
    const done = finishOnWhite(solid(4000, 10, [9, 9, 9, 255]), alphaRect(4000, 10, 0, 2, 4000, 6), CUTOUT.outEdge)!
    expect(done.crop.width).toBe(4000 + 2 * 320)
    expect(done.image.width).toBe(1200)
    expect(done.image.height).toBe(Math.round((done.crop.height * 1200) / done.crop.width))
  })
})

describe('maskStats', () => {
  it('boxes the garment exactly', () => {
    const s = maskStats(alphaRect(20, 10, 5, 4, 3, 2), 20, 10)
    expect(s.box).toEqual({ x: 5, y: 4, width: 3, height: 2 })
    expect(s.coverage).toBeCloseTo(6 / 200)
    expect(s.edgesTouched).toBe(0)
  })

  it('ignores a faint pixel below alpha 26', () => {
    const alpha = new Uint8Array(100)
    alpha[55] = 20
    expect(maskStats(alpha, 10, 10)).toEqual({ coverage: 0, box: null, edgesTouched: 0 })
  })

  it('reports an empty mask as having no box', () => {
    expect(maskStats(new Uint8Array(64), 8, 8).box).toBeNull()
  })

  it('sees a mask that fills the frame', () => {
    const s = maskStats(new Uint8Array(400).fill(255), 20, 20)
    expect(s.coverage).toBe(1)
    expect(s.edgesTouched).toBe(4)
  })

  it('counts a side as touched within max(2 px, 1%)', () => {
    // 300 wide: 1% is 3 px; 100 high: the 2 px floor
    expect(maskStats(alphaRect(300, 100, 3, 2, 100, 50), 300, 100).edgesTouched).toBe(2)
    expect(maskStats(alphaRect(300, 100, 4, 3, 100, 50), 300, 100).edgesTouched).toBe(0)
  })
})

describe('judgeMask and pickBest', () => {
  const stats = (coverage: number, edgesTouched = 0, box: MaskStats['box'] = { x: 10, y: 10, width: 10, height: 10 }): MaskStats => ({ coverage, box, edgesTouched })

  it('rejects a speck, the whole photo and a mask pressed into three sides', () => {
    expect(judgeMask(stats(0.3))).toBe('ok')
    expect(judgeMask(stats(0.3, 0, null))).toBe('empty')
    expect(judgeMask(stats(0.01))).toBe('tiny')
    expect(judgeMask(stats(0.95))).toBe('whole-photo')
    expect(judgeMask(stats(0.4, 3))).toBe('frame')
    expect(judgeMask(stats(0.4, 2))).toBe('ok')
  })

  it('takes the largest accepted mask', () => {
    const tried = [{ seed: 'a', stats: stats(0.2) }, { seed: 'b', stats: stats(0.4) }, { seed: 'c', stats: stats(0.01) }]
    expect(pickBest(tried)).toEqual({ pick: tried[1], doubtful: false })
  })

  it('falls back to the first mask with anything in it, doubtful', () => {
    const tried = [{ seed: 'a', stats: stats(0, 0, null) }, { seed: 'b', stats: stats(0.01) }, { seed: 'c', stats: stats(0.5, 4) }]
    expect(pickBest(tried)).toEqual({ pick: tried[1], doubtful: true })
  })

  it('gives up when every mask is empty', () => {
    expect(pickBest([{ stats: stats(0, 0, null) }, { stats: stats(0, 0, null) }])).toBeNull()
    expect(pickBest([])).toBeNull()
  })
})

describe('paddedBox', () => {
  it('pads by 8% of the long side, the same on every side', () => {
    expect(paddedBox({ x: 100, y: 50, width: 200, height: 400 }, 0.08, 12)).toEqual({ x: 68, y: 18, width: 264, height: 464 })
  })

  it('pads a small box by at least 12 px', () => {
    expect(paddedBox({ x: 20, y: 20, width: 5, height: 5 }, 0.08, 12)).toEqual({ x: 8, y: 8, width: 29, height: 29 })
  })

  it('runs past the photo beside an edge', () => {
    const box = paddedBox({ x: 3, y: 0, width: 50, height: 50 }, 0.08, 12)
    expect([box.x, box.y]).toEqual([-9, -12])
  })
})

describe('keepMainComponents', () => {
  it('keeps the garment and a part a tenth its size, and drops a speck', () => {
    const big = inRect(2, 2, 10, 10)
    const second = inRect(25, 25, 4, 4)
    const core = keepMainComponents(plane(40, 40, (x, y) => (big(x, y) || second(x, y) || (x === 35 && y === 5) ? 0.9 : 0.1)), 0.5, 0.1)
    expect(ones(core)).toBe(100 + 16)
    expect(at(core, 35, 5)).toBe(0)
    expect(at(core, 26, 26)).toBe(1)
  })

  it('joins parts that touch only at a corner', () => {
    // apart, the 2 × 2 is under 90% of the 3 × 3 and would go
    const a = inRect(0, 0, 3, 3)
    const b = inRect(3, 3, 2, 2)
    const core = keepMainComponents(plane(10, 10, (x, y) => (a(x, y) || b(x, y) ? 1 : 0)), 0.5, 0.9)
    expect(ones(core)).toBe(13)
  })

  it('takes the part under the seed as the garment', () => {
    const medium = inRect(2, 2, 6, 6)
    const big = inRect(20, 20, 20, 20)
    const conf = plane(48, 48, (x, y) => (medium(x, y) || big(x, y) || (x === 44 && y === 2) ? 1 : 0))
    // without a seed the 400 px part rules and the 36 px one is under a tenth of it
    expect(at(keepMainComponents(conf, 0.5, 0.1), 4, 4)).toBe(0)
    // tapped, the 36 px part is the garment; the big one is well over a tenth of it, the speck is not
    const tapped = keepMainComponents(conf, 0.5, 0.1, { x: 4.5 / 48, y: 4.5 / 48 })
    expect([at(tapped, 4, 4), at(tapped, 30, 30), at(tapped, 44, 2)]).toEqual([1, 1, 0])
  })

  it('measures a speck against the largest part, even when the seed is on a tiny one', () => {
    const island = inRect(2, 2, 3, 3)
    const blob = inRect(20, 20, 20, 20)
    const speck = inRect(41, 45, 5, 1)
    const conf = plane(48, 48, (x, y) => (island(x, y) || blob(x, y) || speck(x, y) ? 1 : 0))
    // a tenth of the 9 px island would keep the 5 px speck; a tenth of the 400 px blob does not
    const tapped = keepMainComponents(conf, 0.5, 0.1, { x: 3.5 / 48, y: 3.5 / 48 })
    expect([at(tapped, 3, 3), at(tapped, 30, 30), at(tapped, 43, 45)]).toEqual([1, 1, 0])
    expect(ones(tapped)).toBe(9 + 400)
  })

  it('walks a 200 × 200 garment without recursion', () => {
    expect(ones(keepMainComponents(plane(200, 200, () => 1), 0.5, 0.1))).toBe(40_000)
  })

  it('keeps nothing when nothing is confident', () => {
    expect(ones(keepMainComponents(plane(8, 8, () => 0.2), 0.5, 0.1))).toBe(0)
  })
})

describe('fillSmallHoles', () => {
  it('fills a pinhole and keeps an opening', () => {
    const hole = inRect(20, 20, 6, 6)
    const core = plane(40, 40, (x, y) => (hole(x, y) || (x === 8 && y === 8) ? 0 : 1))
    const filled = fillSmallHoles(core, 20)
    expect(at(filled, 8, 8)).toBe(1)
    expect(at(filled, 22, 22)).toBe(0)
  })

  it('never fills background that reaches the border', () => {
    const notch = inRect(0, 10, 3, 1)
    const filled = fillSmallHoles(plane(20, 20, (x, y) => (notch(x, y) ? 0 : 1)), 1000)
    expect([at(filled, 0, 10), at(filled, 2, 10)]).toEqual([0, 0])
  })
})

describe('dilate and erode', () => {
  it('grow a pixel into a (2r + 1)² square and shrink it back', () => {
    const dot = plane(11, 11, (x, y) => (x === 5 && y === 5 ? 1 : 0))
    const grown = dilate(dot, 2)
    expect(ones(grown)).toBe(25)
    expect([at(grown, 3, 3), at(grown, 7, 7), at(grown, 2, 5)]).toEqual([1, 1, 0])
    const back = erode(grown, 2)
    expect(ones(back)).toBe(1)
    expect(at(back, 5, 5)).toBe(1)
  })

  it('does not eat into a mask from the image edges', () => {
    expect(ones(erode(plane(9, 6, () => 1), 3))).toBe(54)
  })
})

describe('refineMask', () => {
  // a soft disk of radius 16, its edge ramping over 5 px, with a pinhole
  // inside and a confident speck far away
  const conf = plane(64, 64, (x, y) => {
    if (x === 32 && y === 30) return 0
    if (x === 4 && y === 58) return 0.9
    return Math.min(1, Math.max(0, 0.5 + (16 - Math.hypot(x - 32, y - 32)) / 5))
  })
  const refined = refineMask(conf, { x: 0.5, y: 0.5 })

  it('makes one solid garment: the pinhole filled, the speck gone', () => {
    expect(at(refined, 32, 32)).toBe(1)
    expect(at(refined, 32, 30)).toBe(1)
    expect(at(refined, 4, 58)).toBe(0)
    expect(at(refined, 0, 0)).toBe(0)
  })

  it('leaves a soft rim of at most 2 px', () => {
    for (const row of [refined.data.subarray(32 * 64, 32 * 64 + 33), Float32Array.from({ length: 33 }, (_, y) => at(refined, 32, y))]) {
      const soft = [...row].filter(v => v > 0.01 && v < 0.99)
      expect(soft.length).toBeGreaterThan(0)
      expect(soft.length).toBeLessThanOrEqual(2)
    }
  })

  it('turns into alpha bytes', () => {
    const alpha = planeToAlpha(refined)
    expect([alpha[32 * 64 + 32], alpha[0]]).toEqual([255, 0])
  })
})

describe('smoothstep', () => {
  it('is 0 at lo, 1 at hi, and never goes back down', () => {
    expect(smoothstep(0.3, 0.7, 0.3)).toBe(0)
    expect(smoothstep(0.3, 0.7, 0.7)).toBe(1)
    expect(smoothstep(0.3, 0.7, 0.5)).toBeCloseTo(0.5)
    let last = -1
    for (let v = 0; v <= 1; v += 0.01) {
      const s = smoothstep(0.3, 0.7, v)
      expect(s).toBeGreaterThanOrEqual(last)
      last = s
    }
  })
})

describe('pickForegroundMask', () => {
  const fg = plane(16, 16, (x, y) => (x > 4 && x < 12 && y > 4 && y < 12 ? 0.92 : 0.05))
  const bg = plane(16, 16, (x, y) => 1 - at(fg, x, y))

  it('takes the mask that is higher at the seed, in either order', () => {
    expect(pickForegroundMask([bg, fg], { x: 0.5, y: 0.5 })).toBe(fg)
    expect(pickForegroundMask([fg, bg], { x: 0.5, y: 0.5 })).toBe(fg)
  })

  it('passes a single mask through', () => {
    expect(pickForegroundMask([bg], { x: 0.5, y: 0.5 })).toBe(bg)
  })
})

describe('pointInContainedImage', () => {
  // a 600 × 300 photo contained in a 300 × 300 box is drawn 300 × 150, 75 px down
  const box = { width: 300, height: 300 }
  const image = { width: 600, height: 300 }

  it('maps a tap on the photo to where it is in the photo', () => {
    expect(pointInContainedImage({ x: 150, y: 150 }, box, image)).toEqual({ x: 0.5, y: 0.5 })
    expect(pointInContainedImage({ x: 0, y: 75 }, box, image)).toEqual({ x: 0, y: 0 })
  })

  it('ignores a tap on the empty bar above it', () => {
    expect(pointInContainedImage({ x: 150, y: 30 }, box, image)).toBeNull()
  })
})

describe('Vision’s subjects', () => {
  /** A 20 × 16 instance mask: each [label, x, y, width, height] painted in turn over the background. */
  function mask(...rects: [number, number, number, number, number][]): InstanceMask {
    const data = new Uint8Array(20 * 16)
    for (const [label, x0, y0, w, h] of rects) for (let y = y0; y < y0 + h; y++) data.fill(label, y * 20 + x0, y * 20 + x0 + w)
    return { width: 20, height: 16, data }
  }
  // a rug over the whole frame, and a pair of trainers standing on it
  const rugAndShoes = mask([1, 0, 0, 20, 16], [2, 4, 4, 3, 8], [3, 12, 4, 3, 8])
  const onLeftShoe = { x: 5 / 20, y: 8 / 16 }
  const onRightShoe = { x: 13 / 20, y: 8 / 16 }

  it('measures each subject: its share of the frame, its box and the sides it touches', () => {
    expect(subjectsIn(rugAndShoes)).toEqual([
      { label: 1, area: 272 / 320, box: { x: 0, y: 0, width: 20, height: 16 }, edgesTouched: 4 },
      { label: 2, area: 24 / 320, box: { x: 4, y: 4, width: 3, height: 8 }, edgesTouched: 0 },
      { label: 3, area: 24 / 320, box: { x: 12, y: 4, width: 3, height: 8 }, edgesTouched: 0 },
    ])
    expect(subjectsIn(mask())).toEqual([])
  })

  it('reads the subject under a point of the frame, and 0 on the background', () => {
    const shoe = mask([2, 4, 4, 3, 8])
    expect(subjectAt(shoe, onLeftShoe)).toBe(2)
    expect(subjectAt(shoe, { x: 0.9, y: 0.9 })).toBe(0)
    // the far corner lands on the last pixel, not past it
    expect(subjectAt(mask([5, 19, 15, 1, 1]), { x: 1, y: 1 })).toBe(5)
  })

  it('leaves out the ground a garment lies on, and keeps both shoes of a pair', () => {
    expect(chooseSubjects(rugAndShoes)).toEqual({ keep: [2, 3], doubtful: false })
  })

  it('drops a subject under a fifth of the largest, and never lets a speck beat the ground', () => {
    // a shirt, and a tag a tenth its size
    expect(chooseSubjects(mask([1, 3, 3, 10, 8], [2, 15, 10, 2, 4]))).toEqual({ keep: [1], doubtful: false })
    // a garment filling the frame, pressed into every side, and one stray pixel: the garment, doubted
    expect(chooseSubjects(mask([1, 0, 0, 20, 16], [2, 10, 8, 1, 1]))).toEqual({ keep: [1], doubtful: true })
  })

  it('keeps a lone subject whatever it touches, and finds nothing in an empty mask', () => {
    expect(chooseSubjects(mask([1, 0, 0, 20, 16]))).toEqual({ keep: [1], doubtful: false })
    expect(chooseSubjects(mask())).toBeNull()
  })

  it('gives a tap the subject under it alone, the ground too, but not the background or what is already shown', () => {
    expect(subjectForTap(rugAndShoes, onRightShoe, [2, 3])).toEqual([3])
    expect(subjectForTap(rugAndShoes, { x: 0.02, y: 0.02 }, [2, 3])).toEqual([1])
    expect(subjectForTap(mask([2, 4, 4, 3, 8]), { x: 0.9, y: 0.9 }, [])).toBeNull()
    // trainers Vision saw as one with their rug: the tap would give back the same, so the web engine takes it
    expect(subjectForTap(mask([1, 0, 0, 20, 16]), onRightShoe, [1])).toBeNull()
  })

  it('hands back the same alpha when no subject is left out', () => {
    const alpha = alphaRect(40, 32, 8, 8, 6, 16)
    expect(keepSubjects(alpha, 40, 32, mask([2, 4, 4, 3, 8]), [2])).toBe(alpha)
  })

  it('takes a subject left out away, fringe and all, and keeps the soft edge of the one kept', () => {
    // a frame twice the mask's size: a shoe at (8, 8), 6 × 16, and a hanger at
    // (28, 12), 4 × 4, each opaque with a one-pixel rim at 128 either side, as
    // Vision's soft edge is
    const alpha = new Uint8Array(40 * 32)
    for (let y = 8; y < 24; y++) {
      alpha.fill(255, y * 40 + 8, y * 40 + 14)
      alpha[y * 40 + 7] = alpha[y * 40 + 14] = 128
    }
    for (let y = 12; y < 16; y++) {
      alpha.fill(255, y * 40 + 28, y * 40 + 32)
      alpha[y * 40 + 27] = alpha[y * 40 + 32] = 128
    }
    const out = keepSubjects(alpha, 40, 32, mask([2, 4, 4, 3, 8], [3, 14, 6, 2, 2]), [2])
    for (let y = 8; y < 24; y++) expect([...out.subarray(y * 40 + 7, y * 40 + 15)], `row ${y}`).toEqual([128, 255, 255, 255, 255, 255, 255, 128])
    for (let y = 12; y < 16; y++) expect([...out.subarray(y * 40 + 27, y * 40 + 33)], `row ${y}`).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('draws the line through a rug with the instance mask, softly', () => {
    const out = keepSubjects(new Uint8Array(40 * 32).fill(255), 40, 32, rugAndShoes, [2, 3])
    const a = (x: number, y: number) => out[y * 40 + x]
    // inside a shoe, deep in the rug, and the edge between, which falls across a pixel or two
    expect(a(11, 16)).toBe(255)
    expect(a(0, 0)).toBe(0)
    expect(a(20, 16)).toBe(0)
    expect(a(14, 16)).toBeGreaterThan(0)
    expect(a(14, 16)).toBeLessThan(a(13, 16))
    expect(a(13, 16)).toBeLessThan(255)
  })

  it('hands the cut-out the frame’s alpha with the right subjects left', () => {
    const src = solid(40, 32, [240, 240, 240, 255])
    // no tap: the rug goes and the trainers stay
    const auto = liftedAlpha(src, rugAndShoes, undefined, [])!
    expect(auto).toMatchObject({ keep: [2, 3], doubtful: false })
    expect(auto.alpha[16 * 40 + 11]).toBe(255)
    expect(auto.alpha[0]).toBe(0)
    // a tap on the left shoe: that one alone
    expect(liftedAlpha(src, rugAndShoes, onLeftShoe, auto.keep)).toMatchObject({ keep: [2], doubtful: false })
    // no mask: everything stays, and a tap has nothing to go on
    expect(liftedAlpha(src, null, undefined, [])).toMatchObject({ keep: [], doubtful: false })
    expect(liftedAlpha(src, null, onLeftShoe, [])).toBeNull()
  })

  it('reads only a mask with a byte for every pixel', () => {
    expect(usableMask(rugAndShoes)).toBe(true)
    expect(usableMask({ width: 20, height: 16, data: new Uint8Array(10) })).toBe(false)
    expect(usableMask({ width: 0, height: 0, data: new Uint8Array(0) })).toBe(false)
    expect(usableMask(null)).toBe(false)
  })

  it('tunes what stays beside the largest to a fifth, as the iPhone did before it chose in the page', () => {
    expect(CUTOUT.subjectShare).toBe(0.2)
    expect(CUTOUT.frameEdges).toBe(3)
  })
})

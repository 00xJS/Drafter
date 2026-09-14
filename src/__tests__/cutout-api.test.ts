import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseWebEngine, createGarmentExtractor, CUTOUT_WATCHDOG_MS, garmentFile, type CutoutProgress, type ExtractorDeps, type WebEngineProbe, type WebSegment } from '../cutout'
import { inPageMath } from '../cutoutjobs'
import type { InstanceMask, Point, Rgba } from '../cutoutmath'
import type { SubjectLift } from '../native'

// extractGarment is a capture step: whatever the device, the network or the
// photo does, it must hand back either a garment on white or the photo with a
// reason, and never throw. createGarmentExtractor takes the I/O as fakes here,
// so each branch of the order (Vision, then the web engine) runs in node.

const photo = new Blob([new Uint8Array([9, 9, 9])], { type: 'image/jpeg' })
/** What Vision hands back: the frame as a JPEG, and its subjects' mask as a PNG. */
const frameJpeg = new Blob([new Uint8Array([0xff, 0xd8, 1])], { type: 'image/jpeg' })
const png = new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' })
const jpeg = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' })

/** The maths as the page runs it with no worker, each job a spy. */
const spyMath = () => ({
  refine: vi.fn(inPageMath.refine),
  union: vi.fn(inPageMath.union),
  grow: vi.fn(inPageMath.grow),
  finishWeb: vi.fn(inPageMath.finishWeb),
  finishLift: vi.fn(inPageMath.finishLift),
})

function image(width: number, height: number, rgba: number[], inside?: (x: number, y: number) => boolean, outsideAlpha = rgba[3]): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(rgba, (y * width + x) * 4)
      if (inside && !inside(x, y)) data[(y * width + x) * 4 + 3] = outsideAlpha
    }
  }
  return { width, height, data }
}

function rectAlpha(width: number, height: number, x0: number, y0: number, w: number, h: number): Uint8Array {
  const alpha = new Uint8Array(width * height)
  for (let y = y0; y < y0 + h; y++) alpha.fill(255, y * width + x0, y * width + x0 + w)
  return alpha
}

const probe = (over: Partial<WebEngineProbe> = {}): WebEngineProbe => ({ wasm: true, simd: true, bundled: false, cached: true, online: true, ...over })

const inRect = (x0: number, y0: number, w: number, h: number) => (x: number, y: number) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h

/** An instance mask of 200 × 150, a quarter of Vision's 800 × 600 frame: each [label, x, y, width, height] painted in turn over the background. */
function subjects(...rects: [number, number, number, number, number][]): InstanceMask {
  const data = new Uint8Array(200 * 150)
  for (const [label, x0, y0, w, h] of rects) for (let y = y0; y < y0 + h; y++) data.fill(label, y * 200 + x0, y * 200 + x0 + w)
  return { width: 200, height: 150, data }
}

/** Vision's lift: an 800 × 600 frame, and one subject, the garment, at (200, 150) and 400 × 300. */
const lifted = (over: Partial<Extract<SubjectLift, { ok: true }>> = {}): SubjectLift => ({
  ok: true,
  frame: frameJpeg,
  alpha: png,
  width: 800,
  height: 600,
  mask: subjects([1, 50, 37, 100, 76]),
  found: 1,
  ...over,
})

/**
 * A work photo of 100 × 80 red, and a web engine that finds a 20 × 20 garment
 * off to the right. Vision's JPEG and its mask's PNG both decode to `frame`,
 * which gives the colours and the alpha both: by default the garment, opaque
 * where lifted() says it is, on transparency.
 */
function fakes(over: { lift?: SubjectLift; probe?: WebEngineProbe; segment?: ExtractorDeps['webEngine']['segment']; frame?: Rgba } = {}) {
  const work = image(100, 80, [200, 30, 40, 255])
  const frame = over.frame ?? image(800, 600, [20, 90, 160, 255], inRect(200, 150, 400, 300), 0)
  const found: WebSegment = { alpha: rectAlpha(100, 80, 60, 10, 20, 20), doubtful: false, point: { x: 0.5, y: 0.5 }, points: [{ x: 0.5, y: 0.5 }] }
  const deps = {
    lift: vi.fn(async (_photo: Blob, _max: number) => over.lift ?? ({ ok: false, reason: 'unavailable' } as SubjectLift)),
    math: spyMath(),
    webEngine: {
      probe: vi.fn(async () => over.probe ?? probe()),
      segment: vi.fn(over.segment ?? (async () => found)),
    },
    decodeRgba: vi.fn(async (blob: Blob, _max: number) => (blob === png || blob === frameJpeg ? frame : work)),
    encodeJpeg: vi.fn(async (_image: Rgba, _quality: number) => jpeg),
    now: vi.fn(() => 0),
  }
  return deps
}

/** Let the fakes' promises settle: every step resolves at once. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('chooseWebEngine', () => {
  it('needs WebAssembly with SIMD, whatever else is true', () => {
    expect(chooseWebEngine(probe({ wasm: false, bundled: true }))).toEqual({ ok: false, reason: 'unsupported' })
    expect(chooseWebEngine(probe({ simd: false, bundled: true }))).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('runs from the app bundle, from the cache, or online', () => {
    expect(chooseWebEngine(probe({ bundled: true, cached: false, online: false }))).toEqual({ ok: true })
    expect(chooseWebEngine(probe({ cached: true, online: false }))).toEqual({ ok: true })
    expect(chooseWebEngine(probe({ cached: false, online: true }))).toEqual({ ok: true })
  })

  it('says offline when the files are not here and cannot be fetched', () => {
    expect(chooseWebEngine(probe({ cached: false, online: false }))).toEqual({ ok: false, reason: 'offline' })
  })
})

/** An 800 × 600 frame of Vision's: transparent (or `ground` everywhere), with each [rgb, x, y, width, height] painted opaque over it. */
function painted(ground: number[] | null, ...rects: [number[], number, number, number, number][]): Rgba {
  const img = image(800, 600, ground ?? [0, 0, 0, 0])
  for (const [rgb, x0, y0, w, h] of rects) for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.data.set([...rgb, 255], (y * 800 + x) * 4)
  return img
}

const WHITE_SHOE = [240, 240, 240]
/** Two shoes side by side, 140 × 320 each, at x 160 and x 500 of the frame; subjects 2 and 3 on the mask (a quarter of the size). */
const SHOES: [number[], number, number, number, number][] = [
  [WHITE_SHOE, 160, 140, 140, 320],
  [WHITE_SHOE, 500, 140, 140, 320],
]
const shoeSubjects: [number, number, number, number, number][] = [
  [2, 40, 35, 35, 80],
  [3, 125, 35, 35, 80],
]

describe('on an iPhone that can lift subjects', () => {
  it('uses Vision, finishes the frame on white around the garment, and never loads the web engine', async () => {
    const deps = fakes({ lift: lifted() })
    const progress: CutoutProgress[] = []
    const r = await createGarmentExtractor(deps)(photo, { onProgress: p => progress.push(p) })
    expect(deps.lift).toHaveBeenCalledWith(photo, 1600)
    // the frame and its subjects' mask, laid together by the maths
    expect(deps.decodeRgba).toHaveBeenCalledWith(frameJpeg, 1600)
    expect(deps.decodeRgba).toHaveBeenCalledWith(png, 1600)
    expect(deps.math.finishLift).toHaveBeenCalledTimes(1)
    // the garment is 400 × 300 in an 800 × 600 frame, padded by round(0.08 × 400) = 32 on each side
    expect(r).toMatchObject({ method: 'ios-vision', image: jpeg, width: 464, height: 364, doubtful: false })
    expect(r.reason).toBeUndefined()
    expect(r.point).toBeUndefined()
    expect(deps.encodeJpeg.mock.calls[0][0]).toMatchObject({ width: 464, height: 364 })
    expect(deps.encodeJpeg.mock.calls[0][1]).toBe(0.88)
    expect(deps.webEngine.probe).not.toHaveBeenCalled()
    expect(deps.webEngine.segment).not.toHaveBeenCalled()
    expect(deps.math.finishWeb).not.toHaveBeenCalled()
    expect(progress).toEqual([{ phase: 'cutting' }])
  })

  it('calls a lift doubtful when it covers too little or nearly all of the frame, or is pressed into three of its sides', async () => {
    const run = (frame: Rgba) => createGarmentExtractor(fakes({ lift: lifted(), frame }))(photo)
    expect((await run(painted(null, [WHITE_SHOE, 400, 300, 10, 10]))).doubtful).toBe(true)
    expect((await run(painted(null, [WHITE_SHOE, 2, 2, 796, 596]))).doubtful).toBe(true)
    expect((await run(painted(null, [WHITE_SHOE, 0, 0, 600, 600]))).doubtful).toBe(true)
    expect((await run(painted(null, [WHITE_SHOE, 200, 150, 400, 300]))).doubtful).toBe(false)
  })

  it('leaves out the rug the trainers stand on, and keeps both of them', async () => {
    // Vision lifted the rug (subject 1, the whole frame) and each trainer on it
    const RUG = [200, 180, 150]
    const deps = fakes({ lift: lifted({ mask: subjects([1, 0, 0, 200, 150], ...shoeSubjects), found: 3 }), frame: painted(RUG, ...SHOES) })
    const r = await createGarmentExtractor(deps)(photo)
    expect(r).toMatchObject({ method: 'ios-vision', doubtful: false })
    const out = deps.encodeJpeg.mock.calls[0][0]
    // both trainers, 480 × 320 across, and round(0.08 × 480) = 38 px of padding
    // round them; the instance mask's line through the rug may move the edge a
    // pixel or two
    expect(Math.abs(out.width - 556)).toBeLessThanOrEqual(4)
    expect(Math.abs(out.height - 396)).toBeLessThanOrEqual(4)
    // no rug left: at full strength it would be r = 200
    let darkest = 255
    for (let i = 0; i < out.data.length; i += 4) darkest = Math.min(darkest, out.data[i])
    expect(darkest).toBeGreaterThanOrEqual(230)
  })

  it('picks the subject under a tap at once, without lifting the photo again', async () => {
    const deps = fakes({ lift: lifted({ mask: subjects(...shoeSubjects), found: 2 }), frame: painted(null, ...SHOES) })
    const extract = createGarmentExtractor(deps)
    // no tap: both shoes, 480 × 320 plus round(0.08 × 480) = 38 all round
    expect(await extract(photo)).toMatchObject({ method: 'ios-vision', width: 556, height: 396 })
    // a tap on the right-hand shoe: that one alone, 140 × 320 plus round(0.08 × 320) = 26
    const tap: Point = { x: 570 / 800, y: 300 / 600 }
    expect(await extract(photo, { point: tap })).toMatchObject({ method: 'ios-vision', width: 192, height: 372, doubtful: false, point: tap })
    expect(deps.lift).toHaveBeenCalledTimes(1)
    expect(deps.webEngine.probe).not.toHaveBeenCalled()
  })

  it('takes a tap to the web engine, from that point, where Vision has nothing more to offer', async () => {
    const deps = fakes({ lift: lifted() })
    const extract = createGarmentExtractor(deps)
    await extract(photo)
    // on the one subject already cut out (Vision saw nothing else there)...
    const onIt: Point = { x: 0.5, y: 0.5 }
    expect(await extract(photo, { point: onIt })).toMatchObject({ method: 'web' })
    expect(deps.webEngine.segment.mock.calls[0][1].points).toEqual([onIt])
    // ...and on the background
    const beside: Point = { x: 0.05, y: 0.05 }
    expect(await extract(photo, { point: beside })).toMatchObject({ method: 'web' })
    expect(deps.webEngine.segment.mock.calls[1][1].points).toEqual([beside])
    // with the web engine's cut-out showing, the subject is Vision's to give back
    expect(await extract(photo, { point: onIt })).toMatchObject({ method: 'ios-vision', width: 464, height: 364 })
    expect(deps.lift).toHaveBeenCalledTimes(1)
  })

  it('keeps both shoes when two taps name them, from the lift it has, and says where each is', async () => {
    const deps = fakes({ lift: lifted({ mask: subjects(...shoeSubjects), found: 2 }), frame: painted(null, ...SHOES) })
    const extract = createGarmentExtractor(deps)
    // no tap: both shoes, each with a point on it for the preview to add a tap to
    const auto = await extract(photo)
    expect(auto.points!.map(p => Math.round(p.x * 800))).toEqual([230, 570])
    // a tap picked the right shoe alone; + Add another taps the left one
    const right: Point = { x: 570 / 800, y: 300 / 600 }
    const left: Point = { x: 230 / 800, y: 300 / 600 }
    expect(await extract(photo, { point: right })).toMatchObject({ method: 'ios-vision', width: 192 })
    const both = await extract(photo, { points: [right, left] })
    expect(both).toMatchObject({ method: 'ios-vision', width: 556, height: 396, doubtful: false, points: [right, left] })
    expect(both.point).toBeUndefined()
    expect(deps.lift).toHaveBeenCalledTimes(1)
    expect(deps.webEngine.segment).not.toHaveBeenCalled()
  })

  it('gives several taps to the web engine where Vision has one subject under them all', async () => {
    const deps = fakes({ lift: lifted() })
    const extract = createGarmentExtractor(deps)
    await extract(photo)
    // both on the one garment Vision found: it has nothing to split, so the web engine runs from each
    const taps: Point[] = [
      { x: 0.4, y: 0.5 },
      { x: 0.6, y: 0.5 },
    ]
    expect(await extract(photo, { points: taps })).toMatchObject({ method: 'web', points: [{ x: 0.5, y: 0.5 }] })
    expect(deps.webEngine.segment.mock.calls[0][1].points).toEqual(taps)
    expect(deps.lift).toHaveBeenCalledTimes(1)
  })

  it('lifts each new photo afresh, and forgets the last one', async () => {
    const deps = fakes({ lift: lifted() })
    const extract = createGarmentExtractor(deps)
    const other = new Blob([new Uint8Array([7])], { type: 'image/jpeg' })
    await extract(photo)
    await extract(other)
    expect(deps.lift).toHaveBeenCalledTimes(2)
    // a tap on the first photo now finds no lift to pick from
    expect((await extract(photo, { point: { x: 0.5, y: 0.5 } })).method).toBe('web')
    expect(deps.lift).toHaveBeenCalledTimes(2)
  })

  it('keeps everything Vision lifted when the shell sends no mask, and gives taps to the web engine', async () => {
    const deps = fakes({ lift: lifted({ mask: { width: 0, height: 0, data: new Uint8Array(0) } }) })
    const extract = createGarmentExtractor(deps)
    expect(await extract(photo)).toMatchObject({ method: 'ios-vision', width: 464, height: 364 })
    expect((await extract(photo, { point: { x: 0.5, y: 0.5 } })).method).toBe('web')
  })

  it('keeps the photo when Vision finds nothing, and does not run the web engine by itself', async () => {
    const deps = fakes({ lift: { ok: false, reason: 'no-subject' } })
    const r = await createGarmentExtractor(deps)(photo)
    expect(r).toMatchObject({ method: 'none', reason: 'no-garment', doubtful: false, width: 0, height: 0 })
    expect(r.image).toBe(photo)
    expect(deps.webEngine.probe).not.toHaveBeenCalled()
    expect(deps.webEngine.segment).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'too-large', 'failed'] as const)('moves on to the web engine when Vision is %s', async reason => {
    const deps = fakes({ lift: { ok: false, reason } })
    const r = await createGarmentExtractor(deps)(photo)
    expect(deps.webEngine.segment).toHaveBeenCalled()
    expect(r.method).toBe('web')
  })
})

describe('asking for the web engine', () => {
  it('never asks Vision when there is a tap, and passes the tap on', async () => {
    const deps = fakes({ lift: lifted() })
    const point: Point = { x: 0.7, y: 0.25 }
    const r = await createGarmentExtractor(deps)(photo, { point })
    expect(deps.lift).not.toHaveBeenCalled()
    expect(deps.webEngine.segment.mock.calls[0][1].points).toEqual([point])
    expect(r.method).toBe('web')
    // and its maths goes to the same place the finish's does
    expect(deps.webEngine.segment.mock.calls[0][1].math).toBe(deps.math)
  })

  it('runs the web engine from each of several taps on a photo Vision never lifted', async () => {
    const deps = fakes({ lift: lifted() })
    const taps: Point[] = [
      { x: 0.2, y: 0.5 },
      { x: 0.8, y: 0.5 },
    ]
    expect((await createGarmentExtractor(deps)(photo, { points: taps })).method).toBe('web')
    expect(deps.lift).not.toHaveBeenCalled()
    expect(deps.webEngine.segment.mock.calls[0][1].points).toEqual(taps)
  })

  it("never asks Vision with engine: 'web'", async () => {
    const deps = fakes({ lift: lifted() })
    expect((await createGarmentExtractor(deps)(photo, { engine: 'web' })).method).toBe('web')
    expect(deps.lift).not.toHaveBeenCalled()
  })
})

describe('the web engine', () => {
  it('finishes its mask with the same even padding, around the garment wherever it was', async () => {
    const deps = fakes()
    const r = await createGarmentExtractor(deps)(photo, { engine: 'web' })
    expect(deps.decodeRgba).toHaveBeenCalledWith(photo, 1600)
    const out = deps.encodeJpeg.mock.calls[0][0]
    // a 20 × 20 garment at (60, 10): max(12, round(0.08 × 20)) = 12 px of white all round
    expect([out.width, out.height]).toEqual([44, 44])
    let [left, top, right, bottom] = [out.width, out.height, -1, -1]
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const i = (y * out.width + x) * 4
        expect(out.data[i + 3]).toBe(255)
        if (out.data[i] === 255 && out.data[i + 1] === 255 && out.data[i + 2] === 255) continue
        expect([...out.data.subarray(i, i + 3)]).toEqual([200, 30, 40])
        ;[left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x), Math.max(bottom, y)]
      }
    }
    expect([left, top, out.width - 1 - right, out.height - 1 - bottom]).toEqual([12, 12, 12, 12])
    expect(r).toMatchObject({ method: 'web', image: jpeg, width: 44, height: 44, point: { x: 0.5, y: 0.5 }, points: [{ x: 0.5, y: 0.5 }] })
    // 44 px across is a thumbnail, not a garment photo
    expect(r.doubtful).toBe(true)
    // the web engine's own finish: its edge snapped and its rim defringed first
    expect(deps.math.finishWeb).toHaveBeenCalledTimes(1)
    expect(deps.math.finishLift).not.toHaveBeenCalled()
  })

  it('passes on its own doubt, and keeps the photo when it finds nothing', async () => {
    const doubtful = fakes({ segment: async () => ({ alpha: rectAlpha(100, 80, 0, 0, 100, 80), doubtful: true, point: { x: 0.5, y: 0.64 }, points: [{ x: 0.5, y: 0.64 }] }) })
    expect(await createGarmentExtractor(doubtful)(photo, { engine: 'web' })).toMatchObject({ method: 'web', doubtful: true, point: { x: 0.5, y: 0.64 } })
    const nothing = fakes({ segment: async () => null })
    const r = await createGarmentExtractor(nothing)(photo, { engine: 'web' })
    expect(r).toMatchObject({ method: 'none', reason: 'no-garment' })
    expect(r.image).toBe(photo)
  })

  it('answers offline at once, without decoding or segmenting', async () => {
    const deps = fakes({ probe: probe({ cached: false, online: false }) })
    expect(await createGarmentExtractor(deps)(photo)).toMatchObject({ method: 'none', reason: 'offline', image: photo })
    expect(deps.decodeRgba).not.toHaveBeenCalled()
    expect(deps.webEngine.segment).not.toHaveBeenCalled()
  })

  it('answers unsupported without WASM SIMD', async () => {
    expect(await createGarmentExtractor(fakes({ probe: probe({ simd: false }) }))(photo)).toMatchObject({ method: 'none', reason: 'unsupported' })
  })

  it('forwards its progress', async () => {
    const deps = fakes({
      segment: async (work, opts) => {
        opts.onProgress?.({ phase: 'download', loaded: 5, total: 10 })
        opts.onProgress?.({ phase: 'cutting' })
        return { alpha: rectAlpha(work.width, work.height, 30, 20, 40, 40), doubtful: false, point: { x: 0.5, y: 0.5 }, points: [{ x: 0.5, y: 0.5 }] }
      },
    })
    const progress: CutoutProgress[] = []
    await createGarmentExtractor(deps)(photo, { engine: 'web', onProgress: p => progress.push(p) })
    expect(progress).toEqual([{ phase: 'download', loaded: 5, total: 10 }, { phase: 'cutting' }])
  })
})

describe('failures never reject', () => {
  it('turns a web engine that throws into failed, with the photo as the image', async () => {
    const r = await createGarmentExtractor(fakes({ segment: async () => Promise.reject(new Error('RuntimeError: memory access out of bounds')) }))(photo)
    expect(r).toMatchObject({ method: 'none', reason: 'failed', doubtful: false, width: 0, height: 0 })
    expect(r.image).toBe(photo)
  })

  it('turns a probe or an encoder that throws into failed', async () => {
    const deps = fakes()
    deps.webEngine.probe.mockRejectedValue(new Error('chunk failed to load'))
    expect((await createGarmentExtractor(deps)(photo)).reason).toBe('failed')
    const encoder = fakes({ lift: lifted() })
    encoder.encodeJpeg.mockRejectedValue(new Error('toBlob gave null'))
    expect((await createGarmentExtractor(encoder)(photo)).reason).toBe('failed')
  })

  it('calls a photo this browser cannot decode unsupported', async () => {
    const deps = fakes()
    deps.decodeRgba.mockRejectedValue(new DOMException('The source image cannot be decoded', 'EncodingError'))
    expect(await createGarmentExtractor(deps)(photo)).toMatchObject({ method: 'none', reason: 'unsupported', image: photo })
  })

  it('answers cancelled at once when aborted mid-run, and passes the abort on', async () => {
    const deps = fakes({ segment: () => new Promise(() => {}) })
    const controller = new AbortController()
    const run = createGarmentExtractor(deps)(photo, { signal: controller.signal })
    await settle()
    expect(deps.webEngine.segment).toHaveBeenCalled()
    controller.abort()
    expect(await run).toMatchObject({ method: 'none', reason: 'cancelled', image: photo })
    expect(deps.webEngine.segment.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('answers cancelled without doing anything when already aborted', async () => {
    const deps = fakes()
    const controller = new AbortController()
    controller.abort()
    expect((await createGarmentExtractor(deps)(photo, { signal: controller.signal })).reason).toBe('cancelled')
    expect(deps.lift).not.toHaveBeenCalled()
  })

  it('gives up on a segmenter that never answers after 20 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const deps = fakes({ segment: () => new Promise(() => {}) })
    let settled = false
    const run = createGarmentExtractor(deps)(photo).finally(() => (settled = true))
    await settle()
    await vi.advanceTimersByTimeAsync(CUTOUT_WATCHDOG_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await run).toMatchObject({ method: 'none', reason: 'failed' })
    // the engine is told why, so it can drop a segmenter that hung
    expect(deps.webEngine.segment.mock.calls[0][1].signal.reason.name).toBe('TimeoutError')
  })

  it('does not count the download against the watchdog', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let report: ((p: CutoutProgress) => void) | undefined
    const deps = fakes({
      segment: (_work, opts) => {
        report = opts.onProgress
        opts.onProgress?.({ phase: 'download', loaded: 0, total: 100 })
        return new Promise(() => {})
      },
    })
    let settled = false
    const run = createGarmentExtractor(deps)(photo).finally(() => (settled = true))
    await settle()
    // a slow minute of downloading is not a hang
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).toBe(false)
    report!({ phase: 'cutting' })
    await vi.advanceTimersByTimeAsync(CUTOUT_WATCHDOG_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await run).reason).toBe('failed')
  })

  it('times the whole call', async () => {
    const deps = fakes({ lift: lifted() })
    deps.now.mockReturnValueOnce(1000).mockReturnValue(1042)
    expect((await createGarmentExtractor(deps)(photo)).ms).toBe(42)
  })
})

describe('garmentFile', () => {
  it('wraps a Blob as a named File, keeping its type', () => {
    const file = garmentFile(jpeg, 'shirt-cutout.jpg')
    expect(file).toBeInstanceOf(File)
    expect([file.name, file.type, file.size]).toEqual(['shirt-cutout.jpg', 'image/jpeg', 2])
  })

  it('defaults the name, and calls a typeless Blob a JPEG', () => {
    const file = garmentFile(new Blob([new Uint8Array(3)]))
    expect([file.name, file.type]).toEqual(['garment.jpg', 'image/jpeg'])
  })
})

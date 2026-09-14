import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseWebEngine, createGarmentExtractor, CUTOUT_WATCHDOG_MS, garmentFile, type CutoutProgress, type ExtractorDeps, type WebEngineProbe, type WebSegment } from '../cutout'
import type { Point, Rgba } from '../cutoutmath'
import type { SubjectLift } from '../native'

// extractGarment is a capture step: whatever the device, the network or the
// photo does, it must hand back either a garment on white or the photo with a
// reason, and never throw. createGarmentExtractor takes the I/O as fakes here,
// so each branch of the order (Vision, then the web engine) runs in node.

const photo = new Blob([new Uint8Array([9, 9, 9])], { type: 'image/jpeg' })
const png = new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' })
const jpeg = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' })

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
const lifted = (over: Partial<Extract<SubjectLift, { ok: true }>> = {}): SubjectLift => ({
  ok: true,
  cutout: png,
  width: 400,
  height: 300,
  frameWidth: 1600,
  frameHeight: 1200,
  coverage: 0.3,
  found: 1,
  kept: 1,
  ...over,
})

/** A work photo of 100 × 80 red, and a web engine that finds a 20 × 20 garment off to the right. */
function fakes(over: { lift?: SubjectLift; probe?: WebEngineProbe; segment?: ExtractorDeps['webEngine']['segment'] } = {}) {
  const work = image(100, 80, [200, 30, 40, 255])
  const found: WebSegment = { alpha: rectAlpha(100, 80, 60, 10, 20, 20), doubtful: false, point: { x: 0.5, y: 0.5 } }
  const deps = {
    lift: vi.fn(async (_photo: Blob, _max: number) => over.lift ?? ({ ok: false, reason: 'unavailable' } as SubjectLift)),
    webEngine: {
      probe: vi.fn(async () => over.probe ?? probe()),
      segment: vi.fn(over.segment ?? (async () => found)),
    },
    decodeRgba: vi.fn(async (blob: Blob, _max: number) =>
      // Vision's PNG: a tight crop, opaque where the garment is; the photo: the work image
      blob === png ? image(400, 300, [20, 90, 160, 255], (x, y) => x > 0 && y > 0, 0) : work,
    ),
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

describe('on an iPhone that can lift subjects', () => {
  it('uses Vision, finishes the PNG on white, and never loads the web engine', async () => {
    const deps = fakes({ lift: lifted() })
    const progress: CutoutProgress[] = []
    const r = await createGarmentExtractor(deps)(photo, { onProgress: p => progress.push(p) })
    expect(deps.lift).toHaveBeenCalledWith(photo, 1600)
    expect(deps.decodeRgba).toHaveBeenCalledWith(png, 1600)
    // the PNG's garment is 399 × 299, padded by round(0.08 × 399) = 32 on each side
    expect(r).toMatchObject({ method: 'ios-vision', image: jpeg, width: 463, height: 363, doubtful: false })
    expect(r.reason).toBeUndefined()
    expect(deps.encodeJpeg.mock.calls[0][0]).toMatchObject({ width: 463, height: 363 })
    expect(deps.encodeJpeg.mock.calls[0][1]).toBe(0.88)
    expect(deps.webEngine.probe).not.toHaveBeenCalled()
    expect(deps.webEngine.segment).not.toHaveBeenCalled()
    expect(progress).toEqual([{ phase: 'cutting' }])
  })

  it('calls a lift doubtful when it covers too little or nearly all of the frame', async () => {
    expect((await createGarmentExtractor(fakes({ lift: lifted({ coverage: 0.01 }) }))(photo)).doubtful).toBe(true)
    expect((await createGarmentExtractor(fakes({ lift: lifted({ coverage: 0.95 }) }))(photo)).doubtful).toBe(true)
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
    expect(deps.webEngine.segment.mock.calls[0][1].point).toEqual(point)
    expect(r.method).toBe('web')
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
    expect(r).toMatchObject({ method: 'web', image: jpeg, width: 44, height: 44, point: { x: 0.5, y: 0.5 } })
    // 44 px across is a thumbnail, not a garment photo
    expect(r.doubtful).toBe(true)
  })

  it('passes on its own doubt, and keeps the photo when it finds nothing', async () => {
    const doubtful = fakes({ segment: async () => ({ alpha: rectAlpha(100, 80, 0, 0, 100, 80), doubtful: true, point: { x: 0.5, y: 0.64 } }) })
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
        return { alpha: rectAlpha(work.width, work.height, 30, 20, 40, 40), doubtful: false, point: { x: 0.5, y: 0.5 } }
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

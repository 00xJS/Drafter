import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CutoutProgress } from '../cutout'
import { CUTOUT_ASSETS, CUTOUT_MODEL, CUTOUT_TOTAL_BYTES, type CutoutAsset } from '../cutoutassets'
import { inPageMath } from '../cutoutjobs'
import type { Point, Rgba } from '../cutoutmath'

/*
 * The web engine's life in the page (src/cutoutweb.ts): when the segmenter is
 * made, when it is closed, and who hears the shared download. MediaPipe, the
 * canvas, Cache Storage and fetch are fakes, so this runs in node; the image
 * maths the engine calls is the real one.
 */

const engine = vi.hoisted(() => ({ created: vi.fn(), closed: vi.fn(), keypoints: [] as unknown[] }))

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { isSimdSupported: async () => true },
  InteractiveSegmenterLegacy: {
    createFromOptions: async (...args: unknown[]) => {
      engine.created(...args)
      return {
        // a confident block, half the width and half the height of whatever it is shown, round the point
        segment: ({ width, height }: { width: number; height: number }, roi: { keypoint: { x: number; y: number } }) => {
          engine.keypoints.push(roi.keypoint)
          const { x: kx, y: ky } = roi.keypoint
          const data = new Float32Array(width * height)
          for (let y = Math.max(0, Math.floor(height * (ky - 0.25))); y < Math.min(height, Math.floor(height * (ky + 0.25))); y++) {
            for (let x = Math.max(0, Math.floor(width * (kx - 0.25))); x < Math.min(width, Math.floor(width * (kx + 0.25))); x++) data[y * width + x] = 1
          }
          return { confidenceMasks: [{ width, height, getAsFloat32Array: () => data }], close() {} }
        },
        close: engine.closed,
      }
    },
  },
}))

vi.mock('../native', () => ({ isNative: () => false }))

const ascii = (s: string) => new TextEncoder().encode(s)

/** A body of the asset's exact size that starts the way its kind should. */
function bodyFor(asset: CutoutAsset): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(asset.bytes)
  if (asset.kind === 'wasm') bytes.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
  if (asset.kind === 'tflite') bytes.set([0x1c, 0x00, 0x00, 0x00, ...ascii('TFL3')])
  if (asset.kind === 'js') bytes.set(ascii('var M='))
  return bytes
}

/** Cache Storage, as a Map of bytes: each match is a fresh Response, as the real one is. */
function fakeCache() {
  const store = new Map<string, Uint8Array<ArrayBuffer>>()
  const cache = {
    match: async (url: RequestInfo | URL) => {
      const bytes = store.get(String(url))
      return bytes && new Response(bytes)
    },
    put: async (url: RequestInfo | URL, response: Response) => {
      store.set(String(url), new Uint8Array(await response.arrayBuffer()))
    },
  }
  vi.stubGlobal('caches', { open: async () => cache })
  return store
}

/** fetch for our own /cutout/ files that answers nothing until the test opens the gate. */
function gatedFetch() {
  let open = () => {}
  const gate = new Promise<void>(resolve => (open = resolve))
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    await gate
    const asset = CUTOUT_ASSETS.find(a => a.url === String(input))
    return asset ? new Response(bodyFor(asset)) : new Response('not here', { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, open }
}

const canvas = () => ({ width: 0, height: 0, getContext: () => ({ imageSmoothingQuality: 'low', putImageData() {}, drawImage() {} }) })

const work: Rgba = { width: 64, height: 48, data: new Uint8ClampedArray(64 * 48 * 4).fill(200) }

let web: typeof import('../cutoutweb')

/** A run with no taps, its maths done in place. */
const segment = (opts: { signal: AbortSignal; onProgress?(p: CutoutProgress): void }) => web.segment(work, { points: [], math: inPageMath, ...opts })

beforeEach(async () => {
  // a fresh module each time: the engine, the download and the idle timer are module state
  vi.resetModules()
  engine.created.mockClear()
  engine.closed.mockClear()
  engine.keypoints.length = 0
  vi.stubGlobal('document', { createElement: canvas })
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    },
  )
  vi.stubGlobal('navigator', { onLine: true })
  web = await import('../cutoutweb')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a run cancelled during the first download', () => {
  it('makes no engine, and the files it started fetching are still kept for the next photo', async () => {
    const store = fakeCache()
    const net = gatedFetch()
    const controller = new AbortController()
    const run = segment({ signal: controller.signal })
    run.catch(() => {})
    await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(1))
    // the sheet moves on (Use original), then the download finishes
    controller.abort(new DOMException('The cut-out was cancelled', 'AbortError'))
    net.open()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(engine.created).not.toHaveBeenCalled()
    expect([...store.keys()]).toEqual(CUTOUT_ASSETS.map(a => a.url))
    // the next photo needs no download, and makes the engine once
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const next = await segment({ signal: new AbortController().signal })
    expect(next?.alpha).toHaveLength(work.width * work.height)
    expect(engine.created).toHaveBeenCalledTimes(1)
    expect(net.fetch).toHaveBeenCalledTimes(3)
    // the model by URL, never as bytes (MediaPipe's legacy graph loses those): an object URL of the cached file, let go once the engine is made
    const [, options] = engine.created.mock.calls[0] as [unknown, { baseOptions: Record<string, unknown> }]
    expect(options.baseOptions).toEqual({ modelAssetPath: expect.stringMatching(/^blob:/), delegate: 'CPU' })
    expect(revoke).toHaveBeenCalledWith(options.baseOptions.modelAssetPath)
    revoke.mockRestore()
  })
})

describe('closing the engine once the sheet lets go', () => {
  it('closes it after a minute nobody uses it', async () => {
    fakeCache()
    gatedFetch().open()
    expect(await segment({ signal: new AbortController().signal })).not.toBeNull()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    web.release()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(engine.closed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(engine.closed).toHaveBeenCalledTimes(1))
  })

  it('still closes it when a run was waiting on a slow download as the minute ran out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fakeCache()
    const net = gatedFetch()
    const run = segment({ signal: new AbortController().signal })
    await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(1))
    // the sheet closes while the files are still coming, and they take over a minute
    web.release()
    await vi.advanceTimersByTimeAsync(60_000)
    net.open()
    await vi.waitFor(() => expect(engine.created).toHaveBeenCalledTimes(1))
    expect(await run).not.toBeNull()
    expect(engine.closed).not.toHaveBeenCalled()
    // the close was put off, not dropped: a minute on, nobody has used it
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(engine.closed).toHaveBeenCalledTimes(1))
  })
})

describe('several taps', () => {
  it('runs once from each, and keeps what each found as one mask', async () => {
    fakeCache()
    gatedFetch().open()
    const taps: Point[] = [
      { x: 0.2, y: 0.5 },
      { x: 0.8, y: 0.5 },
    ]
    const found = await web.segment(work, { points: taps, math: inPageMath, signal: new AbortController().signal })
    expect(engine.keypoints).toEqual(taps)
    expect(found?.points).toEqual(taps)
    // both blocks, and the gap between them left out
    const at = (x: number) => found!.alpha[24 * work.width + x]
    expect(at(8)).toBe(255)
    expect(at(56)).toBe(255)
    expect(at(31)).toBe(0)
  })

  it('takes a single tap as before, its point the seed', async () => {
    fakeCache()
    gatedFetch().open()
    const found = await web.segment(work, { points: [{ x: 0.5, y: 0.5 }], math: inPageMath, signal: new AbortController().signal })
    expect(engine.keypoints).toHaveLength(1)
    expect(found).toMatchObject({ point: { x: 0.5, y: 0.5 }, points: [{ x: 0.5, y: 0.5 }] })
  })
})

describe('the shared download', () => {
  it('tells a run that joins the warm-up half way where it has got to, at once', async () => {
    fakeCache()
    // the model arrives, then the WASM's first kilobyte, then the network stalls
    const stalled = new Promise<never>(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const asset = CUTOUT_ASSETS.find(a => a.url === String(input))!
        if (asset.kind === 'tflite') return new Response(bodyFor(asset))
        let sent = false
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) return stalled
            sent = true
            controller.enqueue(bodyFor(asset).subarray(0, 1024))
          },
        })
        return new Response(body)
      }),
    )
    const warm: CutoutProgress[] = []
    void web.prepare(p => warm.push(p))
    await vi.waitFor(() => expect(warm[warm.length - 1]?.loaded).toBe(CUTOUT_MODEL.bytes + 1024))
    const heard: CutoutProgress[] = []
    void segment({ signal: new AbortController().signal, onProgress: p => heard.push(p) }).catch(() => {})
    // before any await: the cut-out's watchdog rests on this, not on the next chunk
    expect(heard).toEqual([{ phase: 'download', loaded: CUTOUT_MODEL.bytes + 1024, total: CUTOUT_TOTAL_BYTES }])
  })

  it('has nothing to tell a run that starts after it is over', async () => {
    fakeCache()
    gatedFetch().open()
    await web.prepare()
    const heard: CutoutProgress[] = []
    await segment({ signal: new AbortController().signal, onProgress: p => heard.push(p) })
    expect(heard).toEqual([{ phase: 'cutting' }])
  })
})

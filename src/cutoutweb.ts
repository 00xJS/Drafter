import { FilesetResolver, InteractiveSegmenterLegacy } from '@mediapipe/tasks-vision'
import type { CutoutProgress, WebEngineProbe, WebSegment } from './cutout'
import { CUTOUT_CACHE, CUTOUT_LOADER, CUTOUT_MODEL, CUTOUT_WASM, cutoutAssetsCached, loadCutoutAssets, type CutoutAsset } from './cutoutassets'
import { CUTOUT, fitWithin, judgeMask, maskStats, pickBest, pickForegroundMask, planeToAlpha, refineMask, resizePlaneBilinear, type Plane, type Point, type Rgba } from './cutoutmath'
import { isNative } from './native'

/*
 * The web cut-out engine: MediaPipe's interactive segmenter running the
 * MagicTouch model (Apache-2.0) in this page, on the CPU. This is the only
 * module that imports @mediapipe/tasks-vision, and src/cutout.ts reaches it
 * only through import('./cutoutweb'), so its JS loads when a cut-out first
 * needs it. The 17.5 MB of model and WASM come then too, from our own /cutout/
 * files, and stay in Cache Storage (src/cutoutassets.ts). In the app they are
 * in the bundle already.
 *
 * Used on the web, on iPhones before iOS 17, in the Simulator, after Vision
 * fails, and whenever the photo is tapped: "the thing under this point" is
 * what MagicTouch answers, which beats guessing between a garment and the
 * patterned duvet under it.
 */

/** A segmenter nobody has used for this long is closed. A burst of captures reuses it. */
const IDLE_CLOSE_MS = 60_000

/** In the app the model is read from the bundle: a progress bar only if that is slow. */
const BUNDLE_PROGRESS_AFTER_MS = 300

/** Everyone waiting on the files now. The download is shared, and its progress goes to all of them. */
const listeners = new Set<(p: CutoutProgress) => void>()
/** Where a download under way has got to; null when none is. */
let downloading: CutoutProgress | null = null
const tell = (p: CutoutProgress) => {
  downloading = p.phase === 'download' ? p : null
  for (const listener of listeners) listener(p)
}

/**
 * Hear the download's progress until the returned function is called. One
 * that joins a download half way (the warm-up started it) is told at once
 * where it has got to: the cut-out's watchdog rests only once it hears.
 */
function listen(listener: (p: CutoutProgress) => void): () => void {
  listeners.add(listener)
  if (downloading) listener(downloading)
  return () => listeners.delete(listener)
}

const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason
}

/** What chooseWebEngine needs. SIMD is asked of MediaPipe itself, the one that needs it. */
export async function probe(): Promise<WebEngineProbe> {
  const wasm = typeof WebAssembly === 'object' && typeof WebAssembly.validate === 'function'
  const simd = wasm && (await FilesetResolver.isSimdSupported().catch(() => false))
  const bundled = isNative()
  const cached =
    !bundled &&
    typeof caches !== 'undefined' &&
    (await caches
      .open(CUTOUT_CACHE)
      .then(cache => cutoutAssetsCached(cache))
      .catch(() => false))
  return { wasm, simd, bundled, cached, online: navigator.onLine !== false }
}

let download: Promise<void> | null = null

/**
 * Fetch whatever is missing into Cache Storage: once a session, and shared.
 * The sheet that started it does not own it, so closing that sheet half way
 * (Use original) leaves it running and the next photo finds it done. Nothing
 * to fetch in the app, whose bundle holds the files.
 */
function ensureDownloaded(): Promise<void> {
  if (isNative()) return Promise.resolve()
  if (!download) {
    download = (async () => {
      const cache = await caches.open(CUTOUT_CACHE)
      if (await cutoutAssetsCached(cache)) return
      await loadCutoutAssets({
        cache,
        fetch: (input, init) => fetch(input, init),
        online: () => navigator.onLine !== false,
        onProgress: (loaded, total) => tell({ phase: 'download', loaded, total }),
      })
    })()
      .catch(err => {
        download = null
        throw err
      })
      .finally(() => {
        // over, either way: one who joins now has no download to hear about
        downloading = null
      })
  }
  return download
}

/** Warm-up: make sure the files are here (src/cutout.ts, prepareGarmentCutout). */
export async function prepare(onProgress?: (p: CutoutProgress) => void): Promise<void> {
  const unlisten = onProgress && listen(onProgress)
  try {
    await ensureDownloaded()
  } finally {
    unlisten?.()
  }
}

interface Opened {
  fileset: { wasmLoaderPath: string; wasmBinaryPath: string }
  model: Uint8Array
  close(): void
}

/** The runtime's two files as URLs MediaPipe can load, and the model's bytes. */
async function openAssets(): Promise<Opened> {
  if (isNative()) {
    // The app: MediaPipe fetches the runtime from the bundle itself, and only
    // the model is read into memory here.
    const started = performance.now()
    let told = false
    const bytes = await loadCutoutAssets(
      {
        cache: null,
        fetch: (input, init) => fetch(input, init),
        online: () => true,
        onProgress: (loaded, total) => {
          if (performance.now() - started < BUNDLE_PROGRESS_AFTER_MS) return
          told = true
          tell({ phase: 'download', loaded, total })
        },
      },
      [CUTOUT_MODEL],
    )
    if (told) tell({ phase: 'cutting' })
    return { fileset: { wasmLoaderPath: CUTOUT_LOADER.url, wasmBinaryPath: CUTOUT_WASM.url }, model: bytes.get(CUTOUT_MODEL.url)!, close: () => {} }
  }
  const cache = await caches.open(CUTOUT_CACHE)
  const read = async (asset: CutoutAsset) => {
    const response = await cache.match(asset.url)
    if (response) return response.blob()
    // cleared since the download (the app's self-heal empties every cache): fetch again next time
    download = null
    throw new Error(`${asset.url} is no longer cached`)
  }
  const [loader, wasm, model] = await Promise.all([read(CUTOUT_LOADER), read(CUTOUT_WASM), read(CUTOUT_MODEL)])
  const urls = [URL.createObjectURL(loader), URL.createObjectURL(wasm)]
  return {
    fileset: { wasmLoaderPath: urls[0], wasmBinaryPath: urls[1] },
    model: new Uint8Array(await model.arrayBuffer()),
    close: () => urls.forEach(url => URL.revokeObjectURL(url)),
  }
}

interface Engine {
  segmenter: InteractiveSegmenterLegacy
  canvas: HTMLCanvasElement
}

let engine: Promise<Engine> | null = null
let running = 0
let idle: ReturnType<typeof setTimeout> | undefined

async function createEngine(): Promise<Engine> {
  const opened = await openAssets()
  // MediaPipe's runner makes a WebGL context even on the CPU delegate, and an
  // OffscreenCanvas has none before Safari 17, so it gets a canvas of its own.
  const canvas = document.createElement('canvas')
  try {
    const segmenter = await InteractiveSegmenterLegacy.createFromOptions(opened.fileset, {
      baseOptions: { modelAssetBuffer: opened.model, delegate: 'CPU' },
      canvas,
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    })
    return { segmenter, canvas }
  } catch (err) {
    canvas.width = 0
    canvas.height = 0
    throw err
  } finally {
    opened.close()
  }
}

/** The segmenter, made once a session and kept; a failed start is not remembered. */
function loadEngine(): Promise<Engine> {
  if (!engine) {
    engine = createEngine().catch(err => {
      engine = null
      throw err
    })
  }
  return engine
}

function closeEngine(e: Engine): void {
  try {
    e.segmenter.close()
  } catch {
    /* already closed */
  }
  e.canvas.width = 0
  e.canvas.height = 0
}

/** Forget the segmenter, closing it once it is here. MediaPipe can fail inside without throwing, so one that hung or threw is never reused. */
function dropEngine(): void {
  const held = engine
  engine = null
  void held?.then(closeEngine, () => {})
}

/**
 * The preview has closed: close the segmenter after a minute nobody uses it.
 * A run still going then (one waiting on a slow download the closed sheet
 * started) puts the close off by another minute, so it is never skipped.
 */
export function release(): void {
  clearTimeout(idle)
  idle = setTimeout(() => {
    idle = undefined
    if (running) release()
    else dropEngine()
  }, IDLE_CLOSE_MS)
}

/** One run from one seed: the garment's confidence mask, copied out before MediaPipe frees it. */
function runOnce(segmenter: InteractiveSegmenterLegacy, image: HTMLCanvasElement, seed: Point): Plane {
  const result = segmenter.segment(image, { keypoint: { x: seed.x, y: seed.y } })
  try {
    const masks = (result.confidenceMasks ?? []).map(m => ({ width: m.width, height: m.height, data: new Float32Array(m.getAsFloat32Array()) }))
    if (!masks.length) throw new Error('The segmenter returned no mask')
    return pickForegroundMask(masks, seed)
  } finally {
    result.close()
  }
}

/**
 * Find the garment in the work photo. With a tap, one run from that point.
 * Without one, the seeds in CUTOUT.seeds in turn, stopping at the first mask
 * that looks like one garment; else the best of the three. Each mask is
 * cleaned up at 1024 px (refineMask), then grown back to the work photo.
 */
export async function segment(work: Rgba, opts: { point?: Point; signal: AbortSignal; onProgress?(p: CutoutProgress): void }): Promise<WebSegment | null> {
  clearTimeout(idle)
  running++
  // a download already under way (the warm-up's) is heard at once, so the watchdog rests
  const unlisten = opts.onProgress && listen(opts.onProgress)
  // the cut-out's watchdog gave up: this segmenter may never answer again
  const onAbort = () => {
    if (opts.signal.reason?.name === 'TimeoutError') dropEngine()
  }
  opts.signal.addEventListener('abort', onAbort, { once: true })
  const source = document.createElement('canvas')
  const input = document.createElement('canvas')
  try {
    await ensureDownloaded()
    // Cancelled while the files came: they stay cached for the next photo, but
    // this run makes no engine (11.7 MB of WASM to compile, and a WebGL canvas).
    throwIfAborted(opts.signal)
    opts.onProgress?.({ phase: 'cutting' })
    const { segmenter } = await loadEngine()
    throwIfAborted(opts.signal)
    // what the model looks at: the work photo, fitted to 1024
    source.width = work.width
    source.height = work.height
    source.getContext('2d')!.putImageData(new ImageData(work.data, work.width, work.height), 0, 0)
    const size = fitWithin(work.width, work.height, CUTOUT.maskEdge)
    input.width = size.width
    input.height = size.height
    const g = input.getContext('2d')!
    g.imageSmoothingQuality = 'high'
    g.drawImage(source, 0, 0, size.width, size.height)
    source.width = 0
    source.height = 0
    const tried: { seed: Point; refined: Plane; stats: ReturnType<typeof maskStats> }[] = []
    for (const seed of opts.point ? [opts.point] : CUTOUT.seeds) {
      // segment() holds the main thread until it is done: let "Cutting out…" paint first
      await new Promise(resolve => setTimeout(resolve, 0))
      throwIfAborted(opts.signal)
      let conf: Plane
      try {
        conf = runOnce(segmenter, input, seed)
      } catch (err) {
        dropEngine()
        throw err
      }
      const refined = refineMask(conf, seed)
      const stats = maskStats(planeToAlpha(refined), refined.width, refined.height)
      tried.push({ seed, refined, stats })
      if (judgeMask(stats) === 'ok') break
    }
    const best = pickBest(tried)
    if (!best) return null
    const alpha = planeToAlpha(resizePlaneBilinear(best.pick.refined, work.width, work.height))
    return { alpha, doubtful: best.doubtful, point: best.pick.seed }
  } finally {
    for (const c of [source, input]) {
      c.width = 0
      c.height = 0
    }
    opts.signal.removeEventListener('abort', onAbort)
    unlisten?.()
    running--
  }
}

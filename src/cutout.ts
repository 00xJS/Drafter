import { inPageMath, workerMath, type CutoutMath, type WorkerLike } from './cutoutjobs'
import { CUTOUT, fitWithin, judgeMask, looksCutOut, usableMask, type Box, type Point, type Rgba } from './cutoutmath'
import { canLiftSubject, liftSubject, type SubjectLift } from './native'

/*
 * The garment cut-out: a photo of a garment becomes the garment on pure white,
 * cropped with the same padding on every side, as a JPEG at most 1200 px on
 * its long edge. This is the one module the wardrobe imports.
 *
 * On an iPhone with iOS 17, Apple's Vision lifts the subject (liftSubject in
 * src/native.ts). Everywhere else (the web, older iPhones, the Simulator, or
 * after Vision fails) MediaPipe's MagicTouch model runs in the page
 * (src/cutoutweb.ts, loaded on first use), and a tap on the photo tells it
 * which thing is the garment. Both paths finish through one tested function,
 * finishOnWhite (src/cutoutmath.ts), which runs with the rest of the maths in
 * a worker (src/cutoutjobs.ts). Nothing about the photo leaves the device:
 * the only requests are for our own /cutout/ files.
 *
 * Nothing touches the DOM at module load, so node tests import this and drive
 * every branch through createGarmentExtractor with the I/O faked.
 */

export type CutoutMethod = 'ios-vision' | 'web' | 'none'
export type CutoutReason = 'no-garment' | 'offline' | 'unsupported' | 'failed' | 'cancelled'

export interface CutoutProgress {
  phase: 'download' | 'cutting'
  loaded?: number
  total?: number
}

export interface CutoutOptions {
  /** A tap, normalised 0..1 in the upright photo: Vision's subject under it where Vision lifted this photo, else the web engine from this point. */
  point?: Point
  /**
   * Several taps, each on a thing to keep (both shoes of a pair): Vision's
   * subjects under them where they name two or more, else the web engine from
   * each, its masks as one.
   */
  points?: readonly Point[]
  signal?: AbortSignal
  onProgress?(p: CutoutProgress): void
  /** 'web' skips Vision (tests, device checks). Default 'auto'. */
  engine?: 'auto' | 'web'
}

export interface CutoutResult {
  /** image/jpeg: the garment on #FFFFFF, evenly padded, long edge ≤ 1200. When method is 'none', the photo itself, untouched. */
  image: Blob
  method: CutoutMethod
  /** Set only when method is 'none'. */
  reason?: CutoutReason
  /** The mask looked wrong: tiny, the whole photo, or touching three edges. The preview says so. */
  doubtful: boolean
  /** Of `image`; 0 when method is 'none'. */
  width: number
  height: number
  /** The seed the web engine used, for the preview's dot. */
  point?: Point
  /**
   * A point on each thing the cut-out holds: the taps, the web engine's seed,
   * or one on each of Vision's subjects. The preview adds a tap to these when
   * one more thing should stay.
   */
  points?: Point[]
  ms: number
}

/** What chooseWebEngine weighs. */
export interface WebEngineProbe {
  wasm: boolean
  simd: boolean
  /** In the app: the engine's files are in the bundle. */
  bundled: boolean
  /** On the web: all three files are in Cache Storage already. */
  cached: boolean
  online: boolean
}

/** The web engine's answer for the work photo: an alpha the same size, the seed it used, and every seed the mask came from. */
export interface WebSegment {
  alpha: Uint8Array
  doubtful: boolean
  point: Point
  points: Point[]
}

export interface WebEngine {
  /** What this device can do now. Loads the engine's JS (a precached chunk), never its 17.5 MB. */
  probe(): Promise<WebEngineProbe>
  /**
   * Fetch the files on first use, make the segmenter once, and find the garment
   * in the work photo: from each tap in `points`, as one mask, or with none
   * from its own seeds. Its maths runs through `math`. Progress is 'download'
   * while files arrive, then 'cutting' once they are all here. Null when there
   * was nothing to find.
   */
  segment(work: Rgba, opts: { points: readonly Point[]; signal: AbortSignal; math: CutoutMath; onProgress?(p: CutoutProgress): void }): Promise<WebSegment | null>
}

/** The cut-out's I/O. extractGarment runs on domExtractorDeps(); tests pass fakes. */
export interface ExtractorDeps {
  lift(photo: Blob, maxDimension: number): Promise<SubjectLift>
  /** The maths: a worker in the page (src/cutoutjobs.ts), the same jobs in place in tests. */
  math: CutoutMath
  webEngine: WebEngine
  /** Decode upright (EXIF orientation applied), fitted to maxEdge, with straight alpha. */
  decodeRgba(image: Blob, maxEdge: number): Promise<Rgba>
  encodeJpeg(image: Rgba, quality: number): Promise<Blob>
  now(): number
}

/** Creating the web engine and segmenting may take this long; the download is not counted. */
export const CUTOUT_WATCHDOG_MS = 20_000

/** Pure: may the web engine run here, now? */
export function chooseWebEngine(s: WebEngineProbe): { ok: true } | { ok: false; reason: 'offline' | 'unsupported' } {
  if (!s.wasm || !s.simd) return { ok: false, reason: 'unsupported' }
  if (s.bundled || s.cached || s.online) return { ok: true }
  return { ok: false, reason: 'offline' }
}

/** Why a run stopped early: the caller's abort, or the watchdog. */
class Stopped {
  readonly reason: 'cancelled' | 'failed'
  constructor(reason: 'cancelled' | 'failed') {
    this.reason = reason
  }
}

/** A crop this small is a thumbnail of something, not a garment photo. */
const smallCrop = (crop: Box) => Math.max(crop.width, crop.height) < CUTOUT.smallCropPx

/**
 * The cut-out with its I/O passed in. The attempts, in order; the first that
 * settles the result ends the call:
 * 1. Vision on this iPhone, unless `engine: 'web'` asked for the web engine.
 *    Of the subjects it finds, the garment-like ones stay (chooseSubjects), so
 *    a rug pressed into the frame's sides gives way to the trainers on it. "No
 *    subject" keeps the photo (a tap can try again); unavailable, too large or
 *    failed moves on. A tap on a photo Vision has lifted picks the subject
 *    under it at once, without a second lift; one on the background, or on the
 *    subject already cut out, has nothing more from Vision and moves on.
 *    Several taps keep the subjects under them, when they name two or more.
 * 2. The web engine, where chooseWebEngine allows it, from the taps if there
 *    were any, their masks as one.
 * Never rejects: every failure resolves as method 'none' with a reason, so a
 * capture step cannot break.
 */
export function createGarmentExtractor(deps: ExtractorDeps): (photo: Blob, opts?: CutoutOptions) => Promise<CutoutResult> {
  // The last photo Vision lifted, and which of its subjects that photo's
  // cut-out shows, so a tap can pick among them. One photo's worth at a time.
  let seen: { photo: Blob; lifted: Extract<SubjectLift, { ok: true }>; shown: number[] } | null = null
  return async (photo, opts = {}) => {
    const started = deps.now()
    const result = (r: Omit<CutoutResult, 'ms'>): CutoutResult => ({ ...r, ms: deps.now() - started })
    const none = (reason: CutoutReason) => result({ image: photo, method: 'none', reason, doubtful: false, width: 0, height: 0 })
    if (opts.signal?.aborted) return none('cancelled')

    // One signal for the caller's abort and the watchdog: whichever comes first
    // ends the run at once, whatever the step it is waiting on is doing.
    const stop = new AbortController()
    const why = () => (stop.signal.reason?.name === 'TimeoutError' ? 'failed' : 'cancelled')
    const cancel = () => stop.abort(new DOMException('The cut-out was cancelled', 'AbortError'))
    opts.signal?.addEventListener('abort', cancel, { once: true })
    const stopped = new Promise<never>((_, reject) => stop.signal.addEventListener('abort', () => reject(new Stopped(why())), { once: true }))
    stopped.catch(() => {})
    const step = <T>(work: Promise<T>): Promise<T> => Promise.race([work, stopped])
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => stop.abort(new DOMException('The cut-out took too long', 'TimeoutError')), CUTOUT_WATCHDOG_MS)
    }
    const disarm = () => clearTimeout(watchdog)

    try {
      // what the owner pointed at: a tap, or several (both shoes of a pair)
      const taps: Point[] = opts.points?.length ? [...opts.points] : opts.point ? [opts.point] : []
      // 1. Vision, on this iPhone: taps only on a photo it has lifted already
      const known = seen?.photo === photo ? seen : null
      if (opts.engine !== 'web' && (!taps.length || known)) {
        opts.onProgress?.({ phase: 'cutting' })
        const lifted = known?.lifted ?? (await step(deps.lift(photo, CUTOUT.workEdge)))
        if (lifted.ok) {
          // the whole frame (a JPEG) and its subjects' mask (a PNG's alpha), laid together in the worker
          const [frame, mask] = await step(Promise.all([deps.decodeRgba(lifted.frame, CUTOUT.workEdge), deps.decodeRgba(lifted.alpha, CUTOUT.workEdge)]))
          const picked = await step(deps.math.finishLift(frame, mask, usableMask(lifted.mask) ? lifted.mask : null, taps, known?.shown ?? []))
          if (picked) {
            seen = { photo, lifted, shown: picked.keep }
            const done = picked.finished
            if (!done) return none('no-garment')
            const image = await step(deps.encodeJpeg(done.image, CUTOUT.jpegQuality))
            // the web engine's judge too: a speck, nearly the whole frame, or pressed into three of its sides
            const doubtful = picked.doubtful || judgeMask(done.stats) !== 'ok' || smallCrop(done.crop)
            return result({
              image,
              method: 'ios-vision',
              doubtful,
              width: done.image.width,
              height: done.image.height,
              point: taps.length === 1 ? taps[0] : undefined,
              points: picked.points,
            })
          }
          // taps Vision has nothing more for go on to the web engine, from those points
        } else if (lifted.reason === 'no-subject') {
          // Vision looked and found nothing: keep the photo rather than run a
          // second engine on it unasked. The preview offers a tap instead.
          return none('no-garment')
        }
      }

      // 2. The web engine, where it can run: offline and uncached answers at once
      const gate = chooseWebEngine(await step(deps.webEngine.probe()))
      if (!gate.ok) return none(gate.reason)
      let work: Rgba
      try {
        work = await step(deps.decodeRgba(photo, CUTOUT.workEdge))
      } catch (err) {
        if (err instanceof Stopped) throw err
        // a photo this browser cannot open, such as HEIC in desktop Chrome or Firefox
        return none('unsupported')
      }
      // The watchdog covers making the engine and segmenting. It rests while
      // files download, which have their own progress bar.
      let downloading = false
      arm()
      const found = await step(
        deps.webEngine.segment(work, {
          points: taps,
          signal: stop.signal,
          math: deps.math,
          onProgress: p => {
            if (p.phase === 'download' && !downloading) {
              downloading = true
              disarm()
            } else if (p.phase === 'cutting' && downloading) {
              downloading = false
              arm()
            }
            opts.onProgress?.(p)
          },
        }),
      )
      disarm()
      if (!found) return none('no-garment')
      // its edge onto the photo's, its rim in the garment's colour, then on white
      const done = await step(deps.math.finishWeb(work, found.alpha))
      if (!done) return none('no-garment')
      const image = await step(deps.encodeJpeg(done.image, CUTOUT.jpegQuality))
      // the web engine's cut-out is what the photo shows now, none of Vision's subjects
      if (seen?.photo === photo) seen = { ...seen, shown: [] }
      return result({
        image,
        method: 'web',
        doubtful: found.doubtful || smallCrop(done.crop),
        width: done.image.width,
        height: done.image.height,
        point: found.point,
        points: found.points,
      })
    } catch (err) {
      return none(err instanceof Stopped ? err.reason : stop.signal.aborted ? why() : 'failed')
    } finally {
      disarm()
      opts.signal?.removeEventListener('abort', cancel)
    }
  }
}

// ---- in the page ---------------------------------------------------------------

let webModule: Promise<typeof import('./cutoutweb')> | null = null

/** The web engine, loaded once; a failed load is not remembered. The only way to @mediapipe/tasks-vision. */
function loadWeb(): Promise<typeof import('./cutoutweb')> {
  if (!webModule) {
    webModule = import('./cutoutweb').catch(err => {
      webModule = null
      throw err
    })
  }
  return webModule
}

/**
 * Decode through an <img>: `decode()` applies the EXIF orientation (Safari
 * 13.1+, Chrome 81+, Firefox 77+), so a portrait iPhone photo comes out
 * upright. Not createImageBitmap, whose orientation handling differs between
 * browsers.
 */
async function decodeImage(image: Blob, maxEdge: number): Promise<Rgba> {
  const url = URL.createObjectURL(image)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, maxEdge)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    try {
      const g = canvas.getContext('2d', { willReadFrequently: true })
      if (!g) throw new Error('No 2D canvas')
      g.imageSmoothingQuality = 'high'
      g.drawImage(img, 0, 0, width, height)
      return { width, height, data: g.getImageData(0, 0, width, height).data }
    } finally {
      // a canvas holds its pixels until it is resized, however soon it is dropped
      canvas.width = 0
      canvas.height = 0
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** A JPEG from a canvas: sRGB, and no EXIF, since a canvas writes none. */
async function encodeImage(image: Rgba, quality: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  try {
    const g = canvas.getContext('2d')
    if (!g) throw new Error('No 2D canvas')
    g.putImageData(new ImageData(image.data, image.width, image.height), 0, 0)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob) throw new Error('The JPEG could not be written')
    return blob
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

let math: CutoutMath | null = null

/**
 * The cut-out's maths in a module worker (src/cutout.worker.ts), started on
 * first use; in the page where there are no workers. Vite builds the worker
 * from this very line, into a chunk the precache keeps for offline use.
 */
function pageMath(): CutoutMath {
  math ??= typeof Worker === 'function' ? workerMath(() => new Worker(new URL('./cutout.worker.ts', import.meta.url), { type: 'module' }) as WorkerLike) : inPageMath
  return math
}

/** The browser's I/O, which extractGarment runs on. Exported so a device check can swap one piece (a fake lift) and keep the rest real. */
export function domExtractorDeps(): ExtractorDeps {
  return {
    lift: liftSubject,
    math: pageMath(),
    webEngine: {
      probe: async () => (await loadWeb()).probe(),
      segment: async (work, opts) => (await loadWeb()).segment(work, opts),
    },
    decodeRgba: decodeImage,
    encodeJpeg: encodeImage,
    now: () => performance.now(),
  }
}

let extractor: ReturnType<typeof createGarmentExtractor> | null = null

/** Never rejects. Every failure resolves as method 'none' with a reason, so a capture step can't break. */
export function extractGarment(photo: Blob, opts?: CutoutOptions): Promise<CutoutResult> {
  extractor ??= createGarmentExtractor(domExtractorDeps())
  return extractor(photo, opts)
}

/**
 * Warm-up for when "Add clothing" opens (wired at the wardrobe merge): fetch
 * and cache the web engine if this device will need it. Quiet on failure.
 */
export async function prepareGarmentCutout(onProgress?: (p: CutoutProgress) => void): Promise<'native' | 'ready' | 'offline' | 'unsupported' | 'failed'> {
  try {
    if (await canLiftSubject()) return 'native'
    const web = await loadWeb()
    const gate = chooseWebEngine(await web.probe())
    if (!gate.ok) return gate.reason
    await web.prepare(onProgress)
    return 'ready'
  } catch {
    return 'failed'
  }
}

/** Whether a tap on the photo can run the web engine here: the preview makes the photo tappable when it can. */
export async function canPickGarment(): Promise<boolean> {
  try {
    return chooseWebEngine(await (await loadWeb()).probe()).ok
  } catch {
    return false
  }
}

/**
 * Whether a cut-out can be made here, now: by Vision on this iPhone, by the
 * web engine (from the app's bundle, the cache, or online), not while offline
 * before the web engine's one-time download, or not in this browser at all.
 * Fetches nothing big: the web engine's own JS is a precached chunk.
 */
export async function cutoutAvailability(): Promise<'native' | 'web' | 'offline' | 'unsupported'> {
  try {
    if (await canLiftSubject()) return 'native'
    const gate = chooseWebEngine(await (await loadWeb()).probe())
    return gate.ok ? 'web' : gate.reason
  } catch {
    return 'unsupported'
  }
}

/** A saved photo is read this small to tell whether it is a cut-out already: the size of its thumbnail. */
const CUT_CHECK_EDGE = 360

/** Whether a saved photo is a cut-out already, white all round its edge (looksCutOut); null when it cannot be read here. */
export async function isCutOutPhoto(photo: Blob): Promise<boolean | null> {
  try {
    return looksCutOut(await decodeImage(photo, CUT_CHECK_EDGE))
  } catch {
    return null
  }
}

/**
 * The preview calls this on unmount. The web segmenter closes after 60 s idle,
 * so a burst of captures reuses it; the last photo's Vision lift, kept for its
 * taps, goes at once.
 */
export function releaseGarmentCutout(): void {
  extractor = null
  if (webModule) void webModule.then(web => web.release(), () => {})
}

/** The cut-out as a named File, for the wardrobe's photo step (prepareGarmentPhoto). A typeless Blob is called a JPEG. */
export function garmentFile(blob: Blob, name = 'garment.jpg'): File {
  return new File([blob], name, { type: blob.type || 'image/jpeg' })
}

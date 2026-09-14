/*
 * The web cut-out engine's three files: the MagicTouch model and MediaPipe's
 * WASM runtime with its loader. They come from our own origin, and only when a
 * cut-out first needs them. After that they live in Cache Storage. They are
 * never in the service worker's precache (vite.config.ts ignores cutout/**),
 * so an app update never downloads 17.5 MB by itself. The cache, fetch and
 * connectivity are all passed in, so src/__tests__/cutout-assets.test.ts
 * drives every branch in node.
 */

/** The installed @mediapipe/tasks-vision, pinned exactly; cutout-wiring.test.ts holds the two together. */
export const MEDIAPIPE_VERSION = '1.0.1'

/** SHA-256 of public/cutout/magic-touch-v1/magic_touch.tflite; cutout-wiring.test.ts holds the file to it. */
export const MODEL_SHA256 = 'e24338a717c1b7ad8d159666677ef400babb7f33b8ad60c4d96db4ecf694cd25'

/** The page's own Cache Storage, not the service worker's: it works on a first visit and in dev too. */
export const CUTOUT_CACHE = 'drafter-cutout-v1'

export interface CutoutAsset {
  /** Same-origin, in a versioned folder: its contents never change, so it is served immutable. */
  url: string
  /** The exact size. Progress is counted against it, since a compressed response carries no Content-Length. */
  bytes: number
  kind: 'tflite' | 'wasm' | 'js'
  /** The content-type the cached copy is stored with. */
  type: string
}

const RUNTIME = `/cutout/mediapipe-${MEDIAPIPE_VERSION}`

export const CUTOUT_MODEL: CutoutAsset = { url: '/cutout/magic-touch-v1/magic_touch.tflite', bytes: 6_227_884, kind: 'tflite', type: 'application/octet-stream' }
export const CUTOUT_WASM: CutoutAsset = { url: `${RUNTIME}/vision_wasm_internal.wasm`, bytes: 11_756_954, kind: 'wasm', type: 'application/wasm' }
export const CUTOUT_LOADER: CutoutAsset = { url: `${RUNTIME}/vision_wasm_internal.js`, bytes: 323_377, kind: 'js', type: 'text/javascript' }

export const CUTOUT_ASSETS: readonly CutoutAsset[] = [CUTOUT_MODEL, CUTOUT_WASM, CUTOUT_LOADER]

/** 18,308,215 bytes: the first-use download, "17.5 MB" in the preview. */
export const CUTOUT_TOTAL_BYTES = CUTOUT_ASSETS.reduce((sum, a) => sum + a.bytes, 0)

/** Why the files could not be made ready. The message is the reason, so `offline` reads as itself. */
export class CutoutAssetError extends Error {
  readonly reason: 'offline' | 'status' | 'size' | 'content'
  constructor(reason: CutoutAssetError['reason'], detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason)
    this.name = 'CutoutAssetError'
    this.reason = reason
  }
}

/**
 * Whether these bytes start the way this kind of file does, so a 200 that is
 * really the app's index.html (a missing file answered by an SPA fallback) is
 * never cached as a model: WASM starts `00 61 73 6D`, a TFLite flatbuffer has
 * `TFL3` at offset 4, and a script does not start with `<`.
 */
export function looksLike(kind: CutoutAsset['kind'], head: Uint8Array): boolean {
  if (kind === 'wasm') return head.length >= 4 && head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d
  if (kind === 'tflite') return head.length >= 8 && head[4] === 0x54 && head[5] === 0x46 && head[6] === 0x4c && head[7] === 0x33
  let i = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++
  return i < head.length && head[i] !== 0x3c
}

export interface AssetDeps {
  /** Where finished files are kept. Null in the app, which reads them from its own bundle. */
  cache: Pick<Cache, 'match' | 'put'> | null
  fetch: typeof fetch
  /** navigator.onLine on the web. The app passes () => true: its files are in the bundle. */
  online(): boolean
  onProgress?(loaded: number, total: number): void
  signal?: AbortSignal
}

const aborted = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('The download was stopped', 'AbortError')

/** One file from our origin, counted as it streams in and checked before anything keeps it. */
async function download(asset: CutoutAsset, deps: AssetDeps, onBytes: (read: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  const { signal } = deps
  const response = await deps.fetch(asset.url, { signal })
  if (response.status !== 200 || !response.body) throw new CutoutAssetError('status', `${asset.url} answered ${response.status}`)
  const bytes = new Uint8Array(asset.bytes)
  const reader = response.body.getReader()
  // a stream that ignores the signal still stops: every read races it
  const stop = signal && new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(aborted(signal)), { once: true }))
  stop?.catch(() => {})
  let read = 0
  try {
    for (;;) {
      if (signal?.aborted) throw aborted(signal)
      const { done, value } = await (stop ? Promise.race([reader.read(), stop]) : reader.read())
      if (done) break
      if (read + value.length > asset.bytes) throw new CutoutAssetError('size', `${asset.url} is longer than ${asset.bytes} bytes`)
      bytes.set(value, read)
      read += value.length
      onBytes(read)
    }
  } catch (err) {
    void reader.cancel().catch(() => {})
    throw err
  }
  if (read !== asset.bytes) throw new CutoutAssetError('size', `${asset.url} is ${read} bytes, not ${asset.bytes}`)
  if (!looksLike(asset.kind, bytes.subarray(0, 16))) throw new CutoutAssetError('content', `${asset.url} is not a ${asset.kind} file`)
  return bytes
}

/**
 * Make each file ready, in order. One already cached counts as loaded. One
 * that is not, while offline, stops everything with `offline` before any
 * request is made. Any other is fetched, counted against the constant totals
 * as it streams in, checked (status 200, the exact size, the right first
 * bytes) and only then cached. So a download cut off half way, or a page that
 * is not the file, caches nothing wrong, and the next run fetches only what is
 * still missing. An abort stops mid-stream and caches nothing for that file.
 * Progress is also told just before each request, so a server slow to send
 * its first byte already reads as a download: the cut-out's watchdog rests
 * while one runs, and must not take the wait for a hang.
 *
 * Resolves with the bytes of each file it had nowhere to keep: every file in
 * the app, where `cache` is null; none on the web, where they are in the cache.
 */
export async function loadCutoutAssets(deps: AssetDeps, list: readonly CutoutAsset[] = CUTOUT_ASSETS): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const total = list.reduce((sum, a) => sum + a.bytes, 0)
  const unkept = new Map<string, Uint8Array<ArrayBuffer>>()
  let loaded = 0
  for (const asset of list) {
    if (deps.signal?.aborted) throw aborted(deps.signal)
    if (!(deps.cache && (await deps.cache.match(asset.url)))) {
      if (!deps.online()) throw new CutoutAssetError('offline')
      deps.onProgress?.(loaded, total)
      const bytes = await download(asset, deps, read => deps.onProgress?.(loaded + read, total))
      if (deps.cache) await deps.cache.put(asset.url, new Response(bytes, { headers: { 'content-type': asset.type } }))
      else unkept.set(asset.url, bytes)
    }
    loaded += asset.bytes
    deps.onProgress?.(loaded, total)
  }
  return unkept
}

/** Whether every file is already in the cache, so the engine can run offline. */
export async function cutoutAssetsCached(cache: Pick<Cache, 'match'>, list: readonly CutoutAsset[] = CUTOUT_ASSETS): Promise<boolean> {
  for (const asset of list) if (!(await cache.match(asset.url))) return false
  return true
}

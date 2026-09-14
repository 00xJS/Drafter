import { describe, expect, it, vi } from 'vitest'
import {
  CUTOUT_ASSETS,
  CUTOUT_LOADER,
  CUTOUT_MODEL,
  CUTOUT_TOTAL_BYTES,
  CUTOUT_WASM,
  cutoutAssetsCached,
  loadCutoutAssets,
  looksLike,
  type CutoutAsset,
} from '../cutoutassets'

// The web cut-out's 17.5 MB arrives once, from our own origin, and is kept in
// Cache Storage. A half-finished download, an offline start or a 200 that is
// really the app's page must never leave a wrong file behind.

const ascii = (s: string) => new TextEncoder().encode(s)

/** A body of the asset's exact size that starts the way its kind should. */
function bodyFor(asset: CutoutAsset): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(asset.bytes)
  if (asset.kind === 'wasm') bytes.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
  if (asset.kind === 'tflite') bytes.set([0x1c, 0x00, 0x00, 0x00, ...ascii('TFL3')])
  if (asset.kind === 'js') bytes.set(ascii('var M='))
  return bytes
}

/** Cache Storage, as a Map. */
function fakeCache(have: readonly CutoutAsset[] = []) {
  const store = new Map<string, Response>(have.map(a => [a.url, new Response(bodyFor(a))]))
  const puts: { url: string; type: string | null; bytes: number }[] = []
  const cache = {
    match: async (url: RequestInfo | URL) => store.get(String(url)),
    put: async (url: RequestInfo | URL, response: Response) => {
      const bytes = new Uint8Array(await response.arrayBuffer())
      puts.push({ url: String(url), type: response.headers.get('content-type'), bytes: bytes.length })
      store.set(String(url), new Response(bytes))
    },
  }
  return { cache: cache as unknown as Pick<Cache, 'match' | 'put'>, store, puts }
}

/** fetch, streaming each body in chunks and with no Content-Length, as a compressed response has none. */
function fakeFetch(files: Record<string, { body: Uint8Array | string; status?: number }>, chunk = 1 << 20) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const file = files[String(input)]
    if (!file) return new Response('not here', { status: 404 })
    const bytes = typeof file.body === 'string' ? ascii(file.body) : file.body
    let at = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) return controller.close()
        controller.enqueue(bytes.slice(at, at + chunk))
        at += chunk
      },
    })
    return new Response(body, { status: file.status ?? 200 })
  })
}

const real = Object.fromEntries(CUTOUT_ASSETS.map(a => [a.url, { body: bodyFor(a) }]))

/** Three small files, for the cases that do not need 17.5 MB. */
const small: CutoutAsset[] = [
  { url: '/cutout/t/model.tflite', bytes: 32, kind: 'tflite', type: 'application/octet-stream' },
  { url: '/cutout/t/runtime.wasm', bytes: 24, kind: 'wasm', type: 'application/wasm' },
  { url: '/cutout/t/loader.js', bytes: 15, kind: 'js', type: 'text/javascript' },
]
const smallFiles = () => Object.fromEntries(small.map(a => [a.url, { body: bodyFor(a) }]))
const online = () => true

describe('what is downloaded', () => {
  it('is 18,308,215 bytes, the sum of the three files', () => {
    expect(CUTOUT_TOTAL_BYTES).toBe(18_308_215)
    expect(CUTOUT_ASSETS.reduce((sum, a) => sum + a.bytes, 0)).toBe(CUTOUT_TOTAL_BYTES)
    expect(CUTOUT_ASSETS).toEqual([CUTOUT_MODEL, CUTOUT_WASM, CUTOUT_LOADER])
  })
})

describe('files already cached', () => {
  it('are not fetched again', async () => {
    const { cache } = fakeCache([CUTOUT_MODEL])
    const fetch = fakeFetch(real)
    await loadCutoutAssets({ cache, fetch, online })
    expect(fetch.mock.calls.map(c => String(c[0]))).toEqual([CUTOUT_WASM.url, CUTOUT_LOADER.url])
  })

  it('resolve at once when all three are there, counted as loaded', async () => {
    const { cache, puts } = fakeCache(CUTOUT_ASSETS)
    const fetch = fakeFetch(real)
    const progress: number[] = []
    await loadCutoutAssets({ cache, fetch, online, onProgress: loaded => progress.push(loaded) })
    expect(fetch).not.toHaveBeenCalled()
    expect(puts).toEqual([])
    expect(progress[progress.length - 1]).toBe(CUTOUT_TOTAL_BYTES)
    expect(await cutoutAssetsCached(cache)).toBe(true)
  })
})

describe('a file that is not cached yet', () => {
  it('is fetched, checked, then cached with its content-type', async () => {
    const { cache, puts } = fakeCache()
    expect(await cutoutAssetsCached(cache)).toBe(false)
    await loadCutoutAssets({ cache, fetch: fakeFetch(real), online })
    expect(puts).toEqual(CUTOUT_ASSETS.map(a => ({ url: a.url, type: a.type, bytes: a.bytes })))
    expect(puts.map(p => p.type)).toEqual(['application/octet-stream', 'application/wasm', 'text/javascript'])
    expect(await cutoutAssetsCached(cache)).toBe(true)
  })

  it('is refused when a 200 turns out to be the app page, and nothing is cached', async () => {
    const { cache, store } = fakeCache()
    const files = { ...smallFiles(), [small[2].url]: { body: '<!doctype html>' } }
    await expect(loadCutoutAssets({ cache, fetch: fakeFetch(files), online }, small)).rejects.toMatchObject({ reason: 'content' })
    expect(store.has(small[2].url)).toBe(false)
  })

  it('is refused at the wrong length, or with any status but 200', async () => {
    const short = fakeCache()
    await expect(loadCutoutAssets({ cache: short.cache, fetch: fakeFetch({ [small[0].url]: { body: bodyFor(small[0]).subarray(0, 31) } }), online }, small)).rejects.toMatchObject({ reason: 'size' })
    const long = fakeCache()
    await expect(loadCutoutAssets({ cache: long.cache, fetch: fakeFetch({ [small[0].url]: { body: new Uint8Array(33).fill(0x54) } }), online }, small)).rejects.toMatchObject({ reason: 'size' })
    const missing = fakeCache()
    await expect(loadCutoutAssets({ cache: missing.cache, fetch: fakeFetch({}), online }, small)).rejects.toMatchObject({ reason: 'status' })
    const partial = fakeCache()
    await expect(loadCutoutAssets({ cache: partial.cache, fetch: fakeFetch({ [small[0].url]: { body: bodyFor(small[0]), status: 206 } }), online }, small)).rejects.toMatchObject({ reason: 'status' })
    for (const { store } of [short, long, missing, partial]) expect(store.size).toBe(0)
  })

  it('leaves what did arrive cached, so the next run fetches only what is missing', async () => {
    const { cache, store } = fakeCache()
    const broken = { ...smallFiles(), [small[1].url]: { body: '<html>not wasm!!!!!!!!!!' } }
    await expect(loadCutoutAssets({ cache, fetch: fakeFetch(broken), online }, small)).rejects.toThrow()
    expect([...store.keys()]).toEqual([small[0].url])
    const fetch = fakeFetch(smallFiles())
    await loadCutoutAssets({ cache, fetch, online }, small)
    expect(fetch.mock.calls.map(c => String(c[0]))).toEqual([small[1].url, small[2].url])
  })
})

describe('progress', () => {
  it('only ever rises, and ends at the full 18,308,215 bytes with no Content-Length', async () => {
    const { cache } = fakeCache()
    const seen: [number, number][] = []
    await loadCutoutAssets({ cache, fetch: fakeFetch(real), online, onProgress: (loaded, total) => seen.push([loaded, total]) })
    expect(seen.length).toBeGreaterThan(10)
    expect(seen.every(([, total]) => total === CUTOUT_TOTAL_BYTES)).toBe(true)
    expect(seen.every(([loaded], i) => i === 0 || loaded >= seen[i - 1][0])).toBe(true)
    expect(seen[seen.length - 1][0]).toBe(CUTOUT_TOTAL_BYTES)
  })

  it('is told before the first byte, so a server slow to answer reads as a download', async () => {
    const { cache } = fakeCache()
    const seen: [number, number][] = []
    const silent = vi.fn(() => new Promise<Response>(() => {}))
    void loadCutoutAssets({ cache, fetch: silent, online, onProgress: (loaded, total) => seen.push([loaded, total]) })
    await vi.waitFor(() => expect(silent).toHaveBeenCalledTimes(1))
    expect(seen).toEqual([[0, CUTOUT_TOTAL_BYTES]])
  })

  it('is not told while offline, where nothing downloads', async () => {
    const { cache } = fakeCache()
    const seen: number[] = []
    await expect(loadCutoutAssets({ cache, fetch: fakeFetch(real), online: () => false, onProgress: loaded => seen.push(loaded) })).rejects.toThrow('offline')
    expect(seen).toEqual([])
  })
})

describe('offline', () => {
  it('stops with offline before asking the network when a file is missing', async () => {
    const { cache } = fakeCache([CUTOUT_MODEL])
    const fetch = fakeFetch(real)
    await expect(loadCutoutAssets({ cache, fetch, online: () => false })).rejects.toThrow('offline')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('needs nothing from the network once everything is cached', async () => {
    const { cache } = fakeCache(CUTOUT_ASSETS)
    await expect(loadCutoutAssets({ cache, fetch: fakeFetch({}), online: () => false })).resolves.toBeInstanceOf(Map)
  })
})

describe('an abort', () => {
  it('stops mid-stream and caches nothing for that file', async () => {
    const { cache, store } = fakeCache()
    const controller = new AbortController()
    const big: CutoutAsset = { url: '/cutout/t/big.wasm', bytes: 64, kind: 'wasm', type: 'application/wasm' }
    const fetch = fakeFetch({ [big.url]: { body: bodyFor(big) } }, 16)
    const onProgress = (loaded: number) => {
      if (loaded >= 16) controller.abort()
    }
    await expect(loadCutoutAssets({ cache, fetch, online, onProgress, signal: controller.signal }, [big])).rejects.toMatchObject({ name: 'AbortError' })
    expect(store.size).toBe(0)
  })

  it('also stops a stream that never answers again', async () => {
    const controller = new AbortController()
    const stuck = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), { status: 200 }))
    const run = loadCutoutAssets({ cache: null, fetch: stuck, online, signal: controller.signal }, [small[0]])
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('in the app', () => {
  it('reads the files from the bundle without caching them, and hands the bytes back', async () => {
    const fetch = fakeFetch(smallFiles())
    const bytes = await loadCutoutAssets({ cache: null, fetch, online: () => true }, small)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect([...bytes.keys()]).toEqual(small.map(a => a.url))
    expect(bytes.get(small[0].url)).toEqual(bodyFor(small[0]))
  })
})

describe('looksLike', () => {
  it('knows WASM by 00 61 73 6D', () => {
    expect(looksLike('wasm', new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).toBe(true)
    expect(looksLike('wasm', ascii('<!doctype html>'))).toBe(false)
  })

  it('knows a TFLite model by TFL3 at offset 4', () => {
    expect(looksLike('tflite', new Uint8Array([0x1c, 0, 0, 0, ...ascii('TFL3')]))).toBe(true)
    expect(looksLike('tflite', ascii('TFL3 at the start'))).toBe(false)
  })

  it('refuses a script that starts with <, even after a byte-order mark or blank lines', () => {
    expect(looksLike('js', ascii('var Module = {}'))).toBe(true)
    expect(looksLike('js', ascii('<!DOCTYPE html>'))).toBe(false)
    expect(looksLike('js', new Uint8Array([0xef, 0xbb, 0xbf, ...ascii('\n  <html>')]))).toBe(false)
    expect(looksLike('js', new Uint8Array(0))).toBe(false)
  })
})

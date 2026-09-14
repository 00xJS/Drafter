import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/*
 * MediaPipe itself, in node: the bundle, its 11.7 MB of WASM and the MagicTouch
 * model as installed, with no browser. Node has no WebGL, so no segmenter runs
 * here, but a graph starts far enough to show where the model has to go, and
 * what the bundle tries to send. Nothing leaves this machine: fetch serves the
 * one model URL and refuses everything else.
 */

vi.mock('../native', () => ({ isNative: () => false }))

const root = fileURLToPath(new URL('../../', import.meta.url))
const mp = `${root}node_modules/@mediapipe/tasks-vision/`
const fileset = { wasmLoaderPath: `${mp}wasm/vision_wasm_internal.js`, wasmBinaryPath: `${mp}wasm/vision_wasm_internal.wasm` }
const model = new Uint8Array(readFileSync(`${root}public/cutout/magic-touch-v1/magic_touch.tflite`))
const MODEL_URL = 'blob:cutout/magic-touch-v1/magic_touch.tflite'

const urlOf = (input: RequestInfo | URL) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
/** Every request that reached the network's stand-in, past the page's guard. */
const reached: string[] = []
/** Every request the page made, the guard's refusals too. */
const asked: string[] = []

let mediapipe: typeof import('@mediapipe/tasks-vision')
let web: typeof import('../cutoutweb')

beforeAll(async () => {
  // what the bundle's loader asks of a page, in node
  vi.stubGlobal('self', globalThis)
  vi.stubGlobal('require', createRequire(import.meta.url))
  vi.stubGlobal('__dirname', `${mp}wasm`)
  vi.stubGlobal('__filename', fileset.wasmLoaderPath)
  vi.stubGlobal('importScripts', (url: string) => runInThisContext(readFileSync(url, 'utf8'), { filename: url }))
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    reached.push(urlOf(input))
    if (urlOf(input) === MODEL_URL) return new Response(model.slice())
    throw new TypeError(`no network here: ${urlOf(input)}`)
  })
  // the page's guard goes round fetch as src/cutoutweb.ts loads, as in the app
  web = await import('../cutoutweb')
  const guarded = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(urlOf(input))
    return guarded(input, init)
  })
  mediapipe = await import('@mediapipe/tasks-vision')
  // the logger's minute: never waited for here
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})

afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const canvas = () => ({ width: 1, height: 1, getContext: () => null, addEventListener() {}, removeEventListener() {} }) as unknown as HTMLCanvasElement

const start = (baseOptions: { modelAssetBuffer: Uint8Array } | { modelAssetPath: string }) =>
  mediapipe.InteractiveSegmenterLegacy.createFromOptions(fileset, {
    baseOptions: { ...baseOptions, delegate: 'CPU' },
    canvas: canvas(),
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  })

describe('MediaPipe 1.0.1’s legacy interactive segmenter, with MagicTouch', () => {
  it('loses a model handed over as bytes, before the graph starts', async () => {
    await expect(start({ modelAssetBuffer: model })).rejects.toThrow(/ExternalFile must specify at least one of 'file_content'/)
  })

  it('keeps one given by URL, so only WebGL, which node lacks, stops the graph here', async () => {
    const error = await start({ modelAssetPath: MODEL_URL }).then(
      () => null,
      (err: unknown) => String(err),
    )
    expect(error).toMatch(/WebGL/)
    expect(error).not.toMatch(/ExternalFile/)
    expect(reached).toContain(MODEL_URL)
  })

  it('tries to post the failed start to Google a minute on, and the page’s guard refuses it before fetch', async () => {
    expect(asked.map(url => new URL(url).hostname)).not.toContain(web.USAGE_LOG_HOST)
    vi.advanceTimersByTime(60_000)
    await vi.waitFor(() => expect(asked.map(url => new URL(url).hostname)).toContain(web.USAGE_LOG_HOST))
    expect(reached.every(url => url === MODEL_URL)).toBe(true)
  })

  it('names no other host than its usage log', () => {
    const bundle = readFileSync(`${mp}vision_bundle.mjs`, 'utf8')
    const hosts = new Set([...bundle.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(m => m[1]))
    expect([...hosts]).toEqual([web.USAGE_LOG_HOST])
  })
})

describe('the guard round fetch', () => {
  const log = `https://${'odml.pa.googleapis.com'}/v1/log`

  it('refuses the usage log however it is asked for, and lets everything else through as it was asked', async () => {
    const real = vi.fn(async () => new Response('ok'))
    const refusing = web.refusingUsageLog(real as unknown as typeof fetch)
    for (const input of [log, new URL(log), new Request(log, { method: 'POST' })]) await expect(refusing(input)).rejects.toThrow(TypeError)
    expect(real).not.toHaveBeenCalled()
    const init = { method: 'POST', body: 'x' }
    await refusing('/cutout/magic-touch-v1/magic_touch.tflite', init)
    await refusing(MODEL_URL)
    expect(real.mock.calls).toEqual([['/cutout/magic-touch-v1/magic_touch.tflite', init], [MODEL_URL, undefined]])
  })

  it('goes round fetch once, as the module loads', () => {
    const src = readFileSync(`${root}src/cutoutweb.ts`, 'utf8')
    expect(src).toContain('if (typeof fetch === \'function\' && !(fetch as { refusesUsageLog?: boolean }).refusesUsageLog) globalThis.fetch = refusingUsageLog(fetch)')
    expect(web.USAGE_LOG_HOST).toBe('odml.pa.googleapis.com')
  })
})

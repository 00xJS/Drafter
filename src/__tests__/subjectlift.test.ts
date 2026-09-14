import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Apple's subject lifting reaches the web view through one small plugin
// compiled into the app (ios/App/App/SubjectLiftPlugin.swift). Its wrapper in
// native.ts must never throw, must never touch the plugin outside the app,
// and must turn each way the plugin can fail into the reason the cut-out acts
// on: keep the photo, or move on to the web engine.

const env = vi.hoisted(() => ({
  native: true,
  plugins: ['SubjectLift'],
  registered: [] as string[],
  plugin: {
    isAvailable: vi.fn(async (): Promise<{ available: boolean; reason?: string }> => ({ available: true })),
    lift: vi.fn(),
  },
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => env.native,
    getPlatform: () => (env.native ? 'ios' : 'web'),
    isPluginAvailable: (name: string) => env.plugins.includes(name),
  },
  registerPlugin: (name: string) => {
    env.registered.push(name)
    return env.plugin
  },
}))

/** native.ts afresh: the plugin handle and the availability answer live for one launch. */
const load = () => import('../native')

const photo = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/jpeg' })
const unavailable = { ok: false, reason: 'unavailable' }

beforeEach(() => {
  vi.resetModules()
  env.native = true
  env.plugins = ['SubjectLift']
  env.registered = []
  env.plugin.isAvailable.mockReset().mockResolvedValue({ available: true })
  env.plugin.lift.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the base64 helpers', () => {
  it('agree with node at every slice boundary, and round-trip', async () => {
    const { base64ToBytes, bytesToBase64 } = await load()
    for (const n of [0, 1, 2, 3, 0x7fff, 0x8000, 0x8001, 100_003]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 131 + 7) & 0xff)
      const base64 = bytesToBase64(bytes)
      expect(base64, `${n} bytes`).toBe(Buffer.from(bytes).toString('base64'))
      expect(base64ToBytes(base64), `${n} bytes`).toEqual(bytes)
    }
  })
})

describe('where there is no subject lifting', () => {
  it('is unavailable in a browser, and never registers the plugin', async () => {
    env.native = false
    const { canLiftSubject, liftSubject } = await load()
    expect(await liftSubject(photo, 1600)).toEqual(unavailable)
    expect(await canLiftSubject()).toBe(false)
    expect(env.registered).toEqual([])
  })

  it('is unavailable in an app built before the plugin', async () => {
    env.plugins = []
    const { liftSubject } = await load()
    expect(await liftSubject(photo, 1600)).toEqual(unavailable)
    expect(env.registered).toEqual([])
  })

  it('is unavailable in the Simulator without calling lift, and asks only once a launch', async () => {
    env.plugin.isAvailable.mockResolvedValue({ available: false, reason: 'simulator' })
    const { canLiftSubject, liftSubject } = await load()
    expect(await liftSubject(photo, 1600)).toEqual(unavailable)
    expect(await liftSubject(photo, 1600)).toEqual(unavailable)
    expect(await canLiftSubject()).toBe(false)
    expect(env.plugin.isAvailable).toHaveBeenCalledTimes(1)
    expect(env.plugin.lift).not.toHaveBeenCalled()
    expect(env.registered).toEqual(['SubjectLift'])
  })

  it('asks again when the question itself failed', async () => {
    env.plugin.isAvailable.mockRejectedValueOnce(new Error('bridge hiccup'))
    const { canLiftSubject } = await load()
    expect(await canLiftSubject()).toBe(false)
    expect(await canLiftSubject()).toBe(true)
    expect(env.plugin.isAvailable).toHaveBeenCalledTimes(2)
  })
})

describe('the size cap', () => {
  it('sends nothing over 16 MB across the bridge', async () => {
    const { liftSubject, SUBJECT_LIFT_MAX_BYTES } = await load()
    expect(await liftSubject(new Blob([new Uint8Array(SUBJECT_LIFT_MAX_BYTES + 1)]), 1600)).toEqual({ ok: false, reason: 'too-large' })
    expect(env.plugin.lift).not.toHaveBeenCalled()
  })
})

describe('a lift', () => {
  it('sends the photo as base64 with the frame size, and hands back exactly the PNG it got', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9])
    env.plugin.lift.mockResolvedValue({ image: Buffer.from(png).toString('base64'), width: 438, height: 457, frameWidth: 1600, frameHeight: 1200, coverage: 0.21, found: 2, kept: 1 })
    const { liftSubject } = await load()
    const lifted = await liftSubject(photo, 1600)
    expect(env.plugin.lift).toHaveBeenCalledWith({ image: Buffer.from([1, 2, 3, 4, 5]).toString('base64'), maxDimension: 1600 })
    expect(lifted).toMatchObject({ ok: true, width: 438, height: 457, frameWidth: 1600, frameHeight: 1200, coverage: 0.21, found: 2, kept: 1 })
    if (!lifted.ok) throw new Error('expected a lift')
    expect(lifted.cutout.type).toBe('image/png')
    expect(new Uint8Array(await lifted.cutout.arrayBuffer())).toEqual(png)
  })

  it.each([
    ['NO_SUBJECT', 'no-subject'],
    ['TOO_LARGE', 'too-large'],
    ['UNAVAILABLE', 'unavailable'],
    ['VISION_FAILED', 'failed'],
    ['ENCODE_FAILED', 'failed'],
    ['BAD_IMAGE', 'failed'],
  ])('turns the plugin’s %s into %s', async (code, reason) => {
    env.plugin.lift.mockRejectedValue(Object.assign(new Error(code), { code }))
    const { liftSubject } = await load()
    expect(await liftSubject(photo, 1600)).toEqual({ ok: false, reason })
  })

  it('fails on an error with no code', async () => {
    env.plugin.lift.mockRejectedValue(new Error('something else'))
    const { liftSubject } = await load()
    expect(await liftSubject(photo, 1600)).toEqual({ ok: false, reason: 'failed' })
  })

  it('fails when Vision has not answered in 20 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    env.plugin.lift.mockReturnValue(new Promise(() => {}))
    const { liftSubject, SUBJECT_LIFT_TIMEOUT_MS } = await load()
    let settled = false
    const run = liftSubject(photo, 1600).finally(() => (settled = true))
    // reading the photo is real I/O: wait until the call has reached the plugin
    while (!env.plugin.lift.mock.calls.length) await new Promise(resolve => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(SUBJECT_LIFT_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await run).toEqual({ ok: false, reason: 'failed' })
  })
})

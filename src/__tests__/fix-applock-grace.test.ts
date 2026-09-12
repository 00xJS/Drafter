import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// watchAppLock listens to the document and, in the app, to Capacitor's App
// plugin. Both are stood in for here so the clock can be moved by hand.
const env = vi.hoisted(() => ({ native: true, listeners: new Map<string, () => void>() }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => env.native, getPlatform: () => (env.native ? 'ios' : 'web') },
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (name: string, fn: () => void) => {
      env.listeners.set(name, fn)
      return {
        remove: async () => {
          env.listeners.delete(name)
        },
      }
    },
  },
}))

import { APP_LOCK_GRACE_MS, pastLockGrace, setAppLockShowing, watchAppLock } from '../native'

class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible'
}

let doc: FakeDocument
let clock = 0
let lockOn = true

beforeEach(() => {
  doc = new FakeDocument()
  vi.stubGlobal('document', doc)
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k === 'drafter:app-lock' && lockOn ? '1' : null),
    setItem: () => {},
    removeItem: () => {},
  })
  clock = 1_000_000
  lockOn = true
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  env.native = true
  env.listeners.clear()
  setAppLockShowing(false, { silent: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const hide = () => {
  doc.visibilityState = 'hidden'
  doc.dispatchEvent(new Event('visibilitychange'))
}
const show = () => {
  doc.visibilityState = 'visible'
  doc.dispatchEvent(new Event('visibilitychange'))
}
const fire = (name: 'pause' | 'resume') => env.listeners.get(name)!()

describe('one grace period for the web and the app', () => {
  it('is twelve seconds, measured strictly', () => {
    expect(APP_LOCK_GRACE_MS).toBe(12_000)
    expect(pastLockGrace(0, APP_LOCK_GRACE_MS)).toBe(false)
    expect(pastLockGrace(0, APP_LOCK_GRACE_MS + 1)).toBe(true)
  })
})

describe('the app lock on the iPhone', () => {
  it('does not ask for Face ID again after a quick trip away', async () => {
    const onLock = vi.fn()
    const stop = await watchAppLock(onLock)
    fire('pause')
    clock += 5_000
    fire('resume')
    expect(onLock).not.toHaveBeenCalled()
    stop()
  })

  it('locks once the app has been away longer than the grace', async () => {
    const onLock = vi.fn()
    const stop = await watchAppLock(onLock)
    fire('pause')
    clock += APP_LOCK_GRACE_MS + 1
    fire('resume')
    expect(onLock).toHaveBeenCalledTimes(1)
    stop()
  })

  it('times the absence from the web view hiding as well as from pause', async () => {
    const onLock = vi.fn()
    const stop = await watchAppLock(onLock)
    hide()
    clock += 5_000
    fire('resume')
    show()
    expect(onLock).not.toHaveBeenCalled()
    stop()
  })

  it('fails closed when it never saw the app leave', async () => {
    const onLock = vi.fn()
    const stop = await watchAppLock(onLock)
    fire('resume')
    expect(onLock).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does nothing when the lock is off', async () => {
    lockOn = false
    const onLock = vi.fn()
    const stop = await watchAppLock(onLock)
    fire('pause')
    clock += APP_LOCK_GRACE_MS * 10
    fire('resume')
    expect(onLock).not.toHaveBeenCalled()
    stop()
  })

  it('lets go of both native listeners when disposed', async () => {
    const stop = await watchAppLock(() => {})
    expect([...env.listeners.keys()].sort()).toEqual(['pause', 'resume'])
    stop()
    await Promise.resolve()
    expect(env.listeners.size).toBe(0)
  })
})

describe('the app lock in a browser tab', () => {
  it('keeps its grace, and never listens for native events', async () => {
    env.native = false
    const onLock = vi.fn()
    const stop = await watchAppLock(onLock)
    expect(env.listeners.size).toBe(0)
    hide()
    clock += 5_000
    show()
    expect(onLock).not.toHaveBeenCalled()
    hide()
    clock += APP_LOCK_GRACE_MS + 1
    show()
    expect(onLock).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does not lock on a first "visible" with no hide before it', async () => {
    env.native = false
    const onLock = vi.fn()
    const stop = await watchAppLock(onLock)
    clock += APP_LOCK_GRACE_MS * 10
    show()
    expect(onLock).not.toHaveBeenCalled()
    stop()
  })
})

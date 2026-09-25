import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// An alert iOS puts up for the app — may Drafter notify you, know where you
// are, Face ID — makes the scene inactive, and the shell covers an inactive
// scene with the launch screen, so the alert stood on a blank screen with
// nothing to say what it was for. The page now tells the shell just before it
// asks (expectSystemPrompt in src/native.ts, ShellPlugin.swift), and the shell
// leaves that one pass uncovered. ios-shell.test.ts holds the Swift side.

const env = vi.hoisted(() => ({
  native: true,
  pluginAvailable: true,
  /** Everything asked of the shell and of iOS, in order. */
  log: [] as string[],
  display: 'prompt' as string,
  /** The shell's answer to expectSystemPrompt: at once, or never. */
  shellAnswers: true,
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => env.native, getPlatform: () => (env.native ? 'ios' : 'web'), isPluginAvailable: (name: string) => env.pluginAvailable && name === 'Shell' },
  registerPlugin: (name: string) => ({
    expectSystemPrompt: () => {
      env.log.push(`${name}.expectSystemPrompt`)
      return env.shellAnswers ? Promise.resolve() : new Promise(() => {})
    },
  }),
}))
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: env.display }),
    requestPermissions: async () => {
      env.log.push('iOS asks: notifications')
      return { display: 'granted' }
    },
  },
}))
vi.mock('@aparajita/capacitor-biometric-auth', () => ({
  BiometricAuth: {
    authenticate: async () => void env.log.push('iOS asks: Face ID'),
  },
  BiometryType: {},
}))

import { authenticateAppLock, requestLocalNotificationPermission } from '../native'
import { nativeToken, type TokenSource } from '../push'
import { requestDevicePosition } from '../geo'
import { requestLocation } from '../weather'

beforeEach(() => {
  env.native = true
  env.pluginAvailable = true
  env.log = []
  env.display = 'prompt'
  env.shellAnswers = true
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the page tells the shell before it asks iOS', () => {
  it('for notifications, while iOS has yet to be answered', async () => {
    for (const display of ['prompt', 'prompt-with-rationale']) {
      env.log = []
      env.display = display
      expect(await requestLocalNotificationPermission()).toBe(true)
      expect(env.log, display).toEqual(['Shell.expectSystemPrompt', 'iOS asks: notifications'])
    }
  })

  it('not once iOS has been answered: no alert comes, so nothing is left uncovered for it', async () => {
    env.display = 'denied'
    await requestLocalNotificationPermission()
    expect(env.log).toEqual(['iOS asks: notifications'])
    env.log = []
    env.display = 'granted'
    await requestLocalNotificationPermission()
    expect(env.log).toEqual([])
  })

  it('for push, the same question asked through the push plugin', async () => {
    const plugin: TokenSource = {
      checkPermissions: async () => ({ receive: 'prompt' }),
      requestPermissions: async () => {
        env.log.push('iOS asks: push')
        return { receive: 'denied' }
      },
      addListener: async () => ({ remove: async () => {} }),
      register: async () => {},
    }
    await expect(nativeToken({ plugin })).rejects.toThrow(/not allowed/)
    expect(env.log).toEqual(['Shell.expectSystemPrompt', 'iOS asks: push'])
  })

  it('for Face ID, every time: it always stands over the app', async () => {
    expect(await authenticateAppLock()).toBe(true)
    expect(env.log).toEqual(['Shell.expectSystemPrompt', 'iOS asks: Face ID'])
  })

  it('for your location, from I’m here and from the forecast', async () => {
    const getCurrentPosition = vi.fn((ok: (p: { coords: { latitude: number; longitude: number } }) => void) => {
      env.log.push('iOS asks: location')
      ok({ coords: { latitude: 33.45, longitude: -112.07 } })
    })
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    expect(await requestDevicePosition()).toEqual({ lat: 33.45, lon: -112.07 })
    expect(await requestLocation()).toEqual({ lat: 33.45, lon: -112.07 })
    expect(env.log).toEqual(['Shell.expectSystemPrompt', 'iOS asks: location', 'Shell.expectSystemPrompt', 'iOS asks: location'])
  })
})

describe('the word never stands in the way of the ask', () => {
  it('asks iOS anyway after half a second when the shell does not answer', async () => {
    vi.useFakeTimers()
    env.shellAnswers = false
    const asked = requestLocalNotificationPermission()
    await vi.advanceTimersByTimeAsync(499)
    expect(env.log).toEqual(['Shell.expectSystemPrompt'])
    await vi.advanceTimersByTimeAsync(1)
    expect(await asked).toBe(true)
    expect(env.log).toEqual(['Shell.expectSystemPrompt', 'iOS asks: notifications'])
  })

  it('says nothing on the web, or to a shell built before the plugin', async () => {
    // the plugin is looked up once per page, so each case is a fresh page
    for (const [native, available] of [
      [false, true],
      [true, false],
    ]) {
      vi.resetModules()
      env.native = native
      env.pluginAvailable = available
      const fresh = await import('../native')
      await fresh.expectSystemPrompt()
      expect(await fresh.authenticateAppLock()).toBe(true)
    }
    expect(env.log).toEqual(['iOS asks: Face ID', 'iOS asks: Face ID'])
  })
})

describe('the plugin the page calls is the one the shell registers', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

  it('by name and method', () => {
    const swift = read('ios/App/App/ShellPlugin.swift')
    const native = read('src/native.ts')
    expect(/registerPlugin<ShellPlugin>\('(\w+)'\)/.exec(native)?.[1]).toBe(/public let jsName = "(\w+)"/.exec(swift)?.[1])
    expect(native).toMatch(/Capacitor\.isPluginAvailable\('Shell'\)/)
    expect(swift).toContain('CAPPluginMethod(name: "expectSystemPrompt", returnType: CAPPluginReturnPromise)')
    expect(native).toMatch(/interface ShellPlugin \{\s*expectSystemPrompt\(\): Promise<void>/)
  })
})

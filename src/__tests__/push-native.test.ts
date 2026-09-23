import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Server push on the iPhone. It could not register at all: iOS hands the
// device token to the app delegate, and ours had nowhere to put it, so the
// plugin never answered and Settings waited out its 15 seconds. With that
// fixed, what the app does with a token matters: each attempt must take its
// listeners away again, each launch checks the token is still the one the
// server holds, and a tapped push must land where it points.

const { native } = vi.hoisted(() => ({ native: { on: true } }))
vi.mock('../native', () => ({ isNative: () => native.on }))

import { inAppLink, paramsOf, parseLink } from '../links'
import { nativeToken, refreshNativePush, type TokenSource } from '../push'

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: k => m.get(k) ?? null,
    key: i => [...m.keys()][i] ?? null,
    removeItem: k => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  }
}

/** The push plugin as iOS drives it: permission as given, and Apple's answer to register() — a token, or a refusal. */
function plugin(answer: { token?: string; error?: string }, permission = 'granted') {
  const listeners = new Map<string, Set<(v: never) => void>>()
  const removed: string[] = []
  const src: TokenSource & { live(): number; removed: string[]; asked: number } = {
    removed,
    asked: 0,
    live: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    checkPermissions: async () => ({ receive: permission }),
    requestPermissions: async () => {
      src.asked++
      return { receive: permission }
    },
    addListener: (async (event: string, fn: (v: never) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(fn)
      listeners.set(event, set)
      return {
        remove: async () => {
          set.delete(fn)
          removed.push(event)
        },
      }
    }) as TokenSource['addListener'],
    register: async () => {
      queueMicrotask(() => {
        if (answer.token) for (const fn of listeners.get('registration') ?? []) (fn as (t: { value: string }) => void)({ value: answer.token })
        if (answer.error) for (const fn of listeners.get('registrationError') ?? []) (fn as (e: { error: string }) => void)({ error: answer.error })
      })
    },
  }
  return src
}

beforeEach(() => {
  native.on = true
  vi.stubGlobal('localStorage', memoryStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the app delegate hands iOS’s answer to the push plugin', () => {
  it('posts the device token, and the failure, as the notifications the plugin listens for', () => {
    const swift = read('../../ios/App/App/AppDelegate.swift')
    expect(swift).toMatch(/^import Capacitor$/m)
    expect(swift).toMatch(
      /func application\(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data\) \{\s*NotificationCenter\.default\.post\(name: \.capacitorDidRegisterForRemoteNotifications, object: deviceToken\)\s*\}/,
    )
    expect(swift).toMatch(
      /func application\(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error\) \{\s*NotificationCenter\.default\.post\(name: \.capacitorDidFailToRegisterForRemoteNotifications, object: error\)\s*\}/,
    )
  })
})

describe('asking iOS for a device token', () => {
  it('answers the token and takes both of its listeners away again', async () => {
    const p = plugin({ token: 'AB12CD34' })
    await expect(nativeToken({ plugin: p })).resolves.toBe('AB12CD34')
    expect(p.live()).toBe(0)
    expect(p.removed.sort()).toEqual(['registration', 'registrationError'])
  })

  it('leaves nothing behind across attempts, so one token is one answer', async () => {
    const p = plugin({ token: 'AB12CD34' })
    await nativeToken({ plugin: p })
    await nativeToken({ plugin: p })
    await nativeToken({ plugin: p })
    expect(p.live()).toBe(0)
  })

  it('turns Apple’s refusal into the reason, and still tidies up', async () => {
    const p = plugin({ error: 'no valid "aps-environment" entitlement string found for application' })
    await expect(nativeToken({ plugin: p })).rejects.toThrow('Apple only issues device tokens to apps signed by an Apple Developer Program team')
    expect(p.live()).toBe(0)
  })

  it('never asks for permission on the quiet re-check, and says so when it was taken away', async () => {
    const p = plugin({ token: 'AB12CD34' }, 'denied')
    await expect(nativeToken({ ask: false, plugin: p })).rejects.toThrow('Notifications were not allowed')
    expect(p.asked).toBe(0)
  })
})

describe('the launch’s check on the token', () => {
  it('does nothing while push is off on this iPhone', async () => {
    const post = vi.fn()
    await expect(refreshNativePush({ plugin: plugin({ token: 'AB12' }), post })).resolves.toBe('off')
    native.on = false
    localStorage.setItem('drafter:apns-token', 'AB12')
    await expect(refreshNativePush({ plugin: plugin({ token: 'AB12' }), post })).resolves.toBe('off')
    expect(post).not.toHaveBeenCalled()
  })

  it('leaves the server alone when Apple hands back the same token', async () => {
    localStorage.setItem('drafter:apns-token', 'AB12')
    const post = vi.fn()
    await expect(refreshNativePush({ plugin: plugin({ token: 'AB12' }), post })).resolves.toBe('unchanged')
    expect(post).not.toHaveBeenCalled()
  })

  it('swaps a changed token on the server: the new one added first, then the old one dropped', async () => {
    localStorage.setItem('drafter:apns-token', 'OLD1')
    const post = vi.fn(async () => ({ subscriptions: [] }))
    await expect(refreshNativePush({ plugin: plugin({ token: 'NEW2' }), post })).resolves.toBe('updated')
    expect(post.mock.calls.map(c => (c as unknown[])[0])).toEqual([
      { action: 'subscribe', subscription: { type: 'apns', token: 'NEW2' }, timezone: expect.any(String) },
      { action: 'unsubscribe', endpoint: 'apns:OLD1' },
    ])
    expect(localStorage.getItem('drafter:apns-token')).toBe('NEW2')
  })

  it('keeps the old token when the server did not take the new one, so the next launch tries again', async () => {
    localStorage.setItem('drafter:apns-token', 'OLD1')
    const post = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(refreshNativePush({ plugin: plugin({ token: 'NEW2' }), post })).rejects.toThrow('offline')
    expect(localStorage.getItem('drafter:apns-token')).toBe('OLD1')
  })
})

describe('a tapped push lands where it points', () => {
  it('reads the site’s own address as the app’s link', () => {
    expect(inAppLink('https://drafterz.netlify.app/?task=t-1')).toBe('/?task=t-1')
    expect(inAppLink('https://drafterz.netlify.app/?view=review&plan=week')).toBe('/?view=review&plan=week')
    expect(inAppLink('/?plan=day')).toBe('/?plan=day')
    expect(inAppLink('drafter://open?plan=day')).toBe('drafter://open?plan=day')
  })

  it('which parseLink then opens: the task, not nothing', () => {
    // the site's full address names another host, and parseLink ignores an unknown host
    const raw = 'https://drafterz.netlify.app/?task=t-1'
    const whole = paramsOf(raw)
    expect(parseLink(whole.params, { host: whole.host }).task).toBeUndefined()
    const mine = paramsOf(inAppLink(raw))
    expect(parseLink(mine.params, { host: mine.host }).task).toBe('t-1')
  })

  it('goes through inAppLink in the shell’s push listener', () => {
    const src = read('../native.ts')
    expect(src).toMatch(/pushNotificationActionPerformed[\s\S]{0,400}hooks\.onUrl\(inAppLink\(url\)\)/)
  })
})

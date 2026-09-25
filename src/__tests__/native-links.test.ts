import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// How a link reaches the page inside the iOS shell (initNative in src/native.ts).
//
// Capacitor's scene proxy holds a cold start's link until the bridge's view
// appears, then sends it as `appUrlOpen`, which AppPlugin keeps until the page
// listens — so that event is the one channel. App.getLaunchUrl() was read as
// well, and it answers with the last link the app was ever handed, for good:
// every reload of the page (iOS reclaiming the web view, a sign-out, the error
// screen's Reload) ran that link again. And a Universal Link, the site's full
// address tapped in Mail or Messages, opened the app to nothing, because its
// https host is not the page's own.

const env = vi.hoisted(() => ({
  listeners: new Map<string, (e: any) => void>(),
  /** What App.getLaunchUrl() would answer: Capacitor's lastURL, which is never cleared. */
  launchUrl: null as string | null,
  launchReads: 0,
}))

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' }, registerPlugin: () => ({}) }))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (name: string, fn: (e: any) => void) => {
      env.listeners.set(name, fn)
      return { remove: async () => void env.listeners.delete(name) }
    },
    getLaunchUrl: async () => {
      env.launchReads++
      return env.launchUrl ? { url: env.launchUrl } : undefined
    },
  },
}))
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    addListener: async (name: string, fn: (e: any) => void) => {
      env.listeners.set(name, fn)
      return { remove: async () => void env.listeners.delete(name) }
    },
  },
}))
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    addListener: async (name: string, fn: (e: any) => void) => {
      env.listeners.set(name, fn)
      return { remove: async () => void env.listeners.delete(name) }
    },
  },
}))
vi.mock('@capacitor/haptics', () => ({ Haptics: {}, ImpactStyle: {}, NotificationType: {} }))

import { paramsOf, parseLink } from '../links'
import { initNative } from '../native'

beforeEach(() => {
  env.listeners.clear()
  env.launchUrl = null
  env.launchReads = 0
  // watchTextSize measures a probe in the page; node has no page
  vi.stubGlobal('document', {
    createElement: () => ({ setAttribute() {}, style: {}, remove() {} }),
    body: { appendChild() {} },
    documentElement: { style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {} } },
    addEventListener() {},
    removeEventListener() {},
  })
  vi.stubGlobal('getComputedStyle', () => ({ fontSize: '17px' }))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** The page starting up in the shell, and every link it was handed. */
async function start() {
  const opened: [string, boolean | undefined][] = []
  const dispose = await initNative({ onUrl: (url, fromNotification) => void opened.push([url, fromNotification]), onResume: () => {} })
  return { opened, dispose }
}

describe('a link reaches the page once, as appUrlOpen', () => {
  it('applies a cold start’s link, held for the page until it listens, once', async () => {
    env.launchUrl = 'drafter://new'
    const { opened } = await start()
    env.listeners.get('appUrlOpen')!({ url: 'drafter://new' })
    expect(opened).toEqual([['drafter://new', undefined]])
  })

  it('never asks for the launch URL, so a reload does not run the last link again', async () => {
    // the page reloaded (a reclaimed web view, a sign-out, Reload): nothing new
    // was tapped, and Capacitor still remembers the widget link from this morning
    env.launchUrl = 'drafter://open?plan=day'
    const { opened } = await start()
    expect(opened).toEqual([])
    expect(env.launchReads).toBe(0)
  })

  it('lets the same link through again later: tapping a quick action twice opens it twice', async () => {
    const { opened } = await start()
    env.listeners.get('appUrlOpen')!({ url: 'drafter://open?view=today' })
    env.listeners.get('appUrlOpen')!({ url: 'drafter://open?view=today' })
    expect(opened.map(([url]) => url)).toEqual(['drafter://open?view=today', 'drafter://open?view=today'])
  })

  it('source: native.ts reads no launch URL at all', () => {
    const src = readFileSync(fileURLToPath(new URL('../native.ts', import.meta.url)), 'utf8')
    // the code, without the comments that say why
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/getLaunchUrl/)
  })
})

describe('a Universal Link opens what it names', () => {
  it('keeps the path and query of the site’s address, as a push’s link does', async () => {
    const { opened } = await start()
    env.listeners.get('appUrlOpen')!({ url: 'https://drafterz.netlify.app/?task=abc' })
    env.listeners.get('appUrlOpen')!({ url: 'https://drafterz.netlify.app/?plan=day' })
    expect(opened).toEqual([
      ['/?task=abc', undefined],
      ['/?plan=day', undefined],
    ])
    // …which the planner reads as its own: the task, and Plan my day
    const read = (url: string) => {
      const { host, params } = paramsOf(url)
      return parseLink(params, { host })
    }
    expect(read(opened[0][0]).task).toBe('abc')
    expect(read(opened[1][0]).plan).toBe('day')
    // the full address named another host, which the planner ignored
    expect(read('https://drafterz.netlify.app/?task=abc')).toEqual({})
  })

  it('never lets one write on arrival: only a reminder’s own buttons may', async () => {
    const { opened } = await start()
    env.listeners.get('appUrlOpen')!({ url: 'https://drafterz.netlify.app/?task=abc&act=done' })
    const [[url, fromNotification]] = opened
    expect(fromNotification).toBeFalsy()
    const { host, params } = paramsOf(url)
    expect(parseLink(params, { host, allowAct: !!fromNotification }).act).toBeUndefined()
  })

  it('leaves a drafter:// link as it is', async () => {
    const { opened } = await start()
    env.listeners.get('appUrlOpen')!({ url: 'drafter://journal?text=Hello' })
    expect(opened).toEqual([['drafter://journal?text=Hello', undefined]])
  })
})

describe('a tap on one of the phone’s own reminders', () => {
  it('still carries its button, and only it is marked as a notification', async () => {
    const { opened } = await start()
    env.listeners.get('localNotificationActionPerformed')!({ actionId: 'done', notification: { extra: { url: '/?task=abc' } } })
    env.listeners.get('localNotificationActionPerformed')!({ actionId: 'tap', notification: { extra: { url: '/?task=abc' } } })
    env.listeners.get('pushNotificationActionPerformed')!({ notification: { data: { url: 'https://drafterz.netlify.app/?chat=household' } } })
    expect(opened).toEqual([
      ['/?task=abc&act=done', true],
      ['/?task=abc', true],
      ['/?chat=household', undefined],
    ])
  })
})

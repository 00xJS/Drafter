// @vitest-environment happy-dom
import { act, render } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The planner's side of the iOS shell (useNativeShell), with Capacitor stood in
// for at its plugins. The phone's reminders are set whenever the data changes;
// setting them never asks iOS whether Drafter may notify — that question comes
// only from a button someone pressed, with what it is for on screen — and a yes
// from any of those buttons sets them at once.

const env = vi.hoisted(() => ({
  display: 'prompt' as string,
  asked: 0,
  scheduled: [] as Record<string, any>[][],
  app: new Map<string, (e?: any) => void>(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: () => false },
  registerPlugin: () => ({}),
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (name: string, fn: (e?: any) => void) => {
      env.app.set(name, fn)
      return { remove: async () => void env.app.delete(name) }
    },
  },
}))
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: env.display }),
    requestPermissions: async () => {
      env.asked++
      env.display = 'granted'
      return { display: 'granted' }
    },
    registerActionTypes: async () => {},
    getPending: async () => ({ notifications: env.scheduled.at(-1) ?? [] }),
    cancel: async () => {},
    schedule: async ({ notifications }: { notifications: Record<string, any>[] }) => void env.scheduled.push(notifications),
    addListener: async () => ({ remove: async () => {} }),
    removeAllDeliveredNotifications: async () => {},
  },
}))
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: { addListener: async () => ({ remove: async () => {} }) } }))
vi.mock('@capacitor/haptics', () => ({ Haptics: {}, ImpactStyle: {}, NotificationType: {} }))
// the widget and the browser's own notifications have tests of their own
vi.mock('../widgetbridge', () => ({ useWidgetBridge: () => {} }))
vi.mock('../notify', () => ({ notifyDue: () => {} }))

import { useNativeShell } from '../components/planner/useNativeShell'
import { requestLocalNotificationPermission } from '../native'
import type { Store } from '../store'
import type { Task } from '../types'

const NOW = new Date(2026, 8, 25, 10)
const task = (id: string, dueAt: Date): Task => ({
  kind: 'task',
  id,
  title: id,
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  dueAt: dueAt.toISOString(),
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
})

function fakeStore(tasks: Task[]): Store {
  return { loaded: true, tasks, people: [], places: [], meals: [], events: [], journal: [], syncNowManual: async () => {} } as unknown as Store
}

function Shell({ store }: { store: Store }) {
  useNativeShell({ store, applyLinkRef: { current: () => {} }, myId: null })
  return null
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
  env.display = 'prompt'
  env.asked = 0
  env.scheduled = []
  env.app.clear()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Let the reminders' debounce run out and every write settle. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
}

describe('the phone’s reminders never ask iOS by themselves', () => {
  it('sets nothing and asks nothing while iOS has not been asked, though Plan your day is on', async () => {
    render(<Shell store={fakeStore([task('a', new Date(2026, 8, 26, 15))])} />)
    await settle()
    expect(env.asked).toBe(0)
    expect(env.scheduled).toEqual([])
  })

  it('nor when the app comes back to the front', async () => {
    render(<Shell store={fakeStore([])} />)
    await settle()
    await act(async () => env.app.get('resume')!())
    await settle()
    expect(env.asked).toBe(0)
  })

  it('sets them the moment a button someone pressed gets a yes', async () => {
    render(<Shell store={fakeStore([task('a', new Date(2026, 8, 26, 15))])} />)
    await settle()
    // Settings → Notifications' Allow, the bell's Turn on, the offer after a due time
    await act(async () => void (await requestLocalNotificationPermission()))
    await settle()
    expect(env.asked).toBe(1)
    // Plan your day, on by default, is on the phone now, with no change to the data
    expect(env.scheduled.at(-1)?.map(n => n.extra.url)).toEqual(['/?plan=day'])
  })

  it('keeps setting them on every change once iOS has said yes', async () => {
    env.display = 'granted'
    // Settings → Notifications → Remind me on this iPhone
    localStorage.setItem('drafter:local-reminders', '1')
    const { rerender } = render(<Shell store={fakeStore([])} />)
    await settle()
    rerender(<Shell store={fakeStore([task('a', new Date(2026, 8, 26, 15))])} />)
    await settle()
    expect(env.scheduled.map(set => set.map(n => n.extra.url))).toEqual([['/?plan=day'], ['/?task=a', '/?plan=day']])
    expect(env.asked).toBe(0)
  })
})

// @vitest-environment happy-dom
import { act, render } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The planner's side of the iOS shell (useNativeShell), with Capacitor stood in
// for at its plugins. The phone's reminders are set whenever the data changes;
// setting them never asks iOS whether Drafter may notify — that question comes
// only from a button someone pressed, with what it is for on screen — and a yes
// from any of those buttons sets them at once.
//
// The Home Screen badge means one thing: my tasks overdue or due today, the
// morning digest's number. It used to count the reminders that had rung since
// the app was last opened, and opening the app zeroed it by emptying
// Notification Centre, a household message not yet read with it.

const env = vi.hoisted(() => ({
  display: 'prompt' as string,
  asked: 0,
  scheduled: [] as Record<string, any>[][],
  /** App's listeners by event: the planner's, and the text size's, both hear a resume. */
  app: new Map<string, Set<(e?: any) => void>>(),
  badges: [] as number[],
  cleared: 0,
  auth: null as ((event: string) => void) | null,
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: (name: string) => name === 'Shell' },
  registerPlugin: () => ({
    expectSystemPrompt: async () => {},
    setBadge: async ({ count }: { count: number }) => void env.badges.push(count),
  }),
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (name: string, fn: (e?: any) => void) => {
      const set = env.app.get(name) ?? new Set()
      env.app.set(name, set.add(fn))
      return { remove: async () => void set.delete(fn) }
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
    removeAllDeliveredNotifications: async () => void env.cleared++,
  },
}))
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: { addListener: async () => ({ remove: async () => {} }) } }))
vi.mock('@capacitor/haptics', () => ({ Haptics: {}, ImpactStyle: {}, NotificationType: {} }))
// the widget and the browser's own notifications have tests of their own
vi.mock('../widgetbridge', () => ({ useWidgetBridge: () => {} }))
vi.mock('../notify', () => ({ notifyDue: () => {} }))
vi.mock('../supabase', async importOriginal => ({
  ...(await importOriginal<typeof import('../supabase')>()),
  getSupabase: () => ({
    auth: {
      onAuthStateChange: (fn: (event: string) => void) => {
        env.auth = fn
        return { data: { subscription: { unsubscribe: () => void (env.auth = null) } } }
      },
    },
  }),
}))

import { buildDigest } from '../../shared/digest.mts'
import { useNativeShell } from '../components/planner/useNativeShell'
import { requestLocalNotificationPermission } from '../native'
import { badgeCount } from '../reminders'
import type { Store } from '../store'
import type { Task } from '../types'

const NOW = new Date(2026, 8, 25, 10)
const task = (id: string, dueAt: Date, over: Partial<Task> = {}): Task => ({
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
  ...over,
})

function fakeStore(tasks: Task[]): Store {
  return { loaded: true, tasks, people: [], places: [], meals: [], events: [], journal: [], syncNowManual: async () => {} } as unknown as Store
}

function Shell({ store, myId = null }: { store: Store; myId?: string | null }) {
  useNativeShell({ store, applyLinkRef: { current: () => {} }, myId })
  return null
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
  env.display = 'prompt'
  env.asked = 0
  env.scheduled = []
  env.app.clear()
  env.badges = []
  env.cleared = 0
})
afterEach(() => {
  vi.useRealTimers()
})

/** The app coming back to the front. */
const resume = () => act(async () => env.app.get('resume')?.forEach(fn => fn()))

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
    await resume()
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

describe('the Home Screen badge: what is overdue or due today, and nothing else', () => {
  const ME = 'me'
  // overdue, due this morning, due tonight, tomorrow's, one done, the other member's
  const tasks = [
    task('late', new Date(2026, 8, 23, 9), { ownerId: ME }),
    task('bins', new Date(2026, 8, 25), { ownerId: ME }),
    task('call', new Date(2026, 8, 25, 18), { ownerId: ME }),
    task('dentist', new Date(2026, 8, 26, 9), { ownerId: ME }),
    task('paid', new Date(2026, 8, 24), { ownerId: ME, status: 'done' }),
    task('theirs', new Date(2026, 8, 25, 12), { ownerId: 'them' }),
  ]

  it('is the morning digest’s number: my open tasks overdue or due today', () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const digest = buildDigest(tasks, tz, NOW, {}, ME)
    expect(badgeCount(tasks, ME, NOW)).toBe(3)
    expect(badgeCount(tasks, ME, NOW)).toBe(digest.overdue.length + digest.dueToday.length)
    // tomorrow's joins it tomorrow
    expect(badgeCount(tasks, ME, new Date(2026, 8, 26, 9))).toBe(4)
  })

  it('is set as the planner’s data comes in, and again on coming back to the app', async () => {
    render(<Shell store={fakeStore(tasks)} myId={ME} />)
    await settle()
    expect(env.badges).toEqual([3])
    // a day later, with nothing done: tomorrow's is due today now
    vi.setSystemTime(new Date(2026, 8, 26, 8))
    await resume()
    expect(env.badges).toEqual([3, 4])
  })

  it('never empties Notification Centre: a household message not yet read stays there', async () => {
    render(<Shell store={fakeStore(tasks)} myId={ME} />)
    await settle()
    await resume()
    await settle()
    expect(env.cleared).toBe(0)
  })

  it('says nothing before the local copy is in: an empty planner is not a day with nothing due', async () => {
    render(<Shell store={{ ...fakeStore([]), loaded: false } as Store} myId={ME} />)
    await settle()
    await resume()
    expect(env.badges).toEqual([])
  })

  it('goes on a sign-out', async () => {
    render(<Shell store={fakeStore(tasks)} myId={ME} />)
    await settle()
    await act(async () => env.auth!('SIGNED_OUT'))
    expect(env.badges).toEqual([3, 0])
  })

  it('is what each of the phone’s reminders leaves as it rings; Plan your day leaves it alone', async () => {
    env.display = 'granted'
    localStorage.setItem('drafter:local-reminders', '1')
    render(<Shell store={fakeStore(tasks)} myId={ME} />)
    await settle()
    const set = env.scheduled.at(-1)!
    const badge = (url: string) => set.find(n => n.extra.url === url)?.badge
    // tonight's call rings with today's three; tomorrow's dentist with four
    expect(badge('/?task=call')).toBe(3)
    expect(badge('/?task=dentist')).toBe(4)
    expect(set.find(n => n.extra.url === '/?plan=day')).not.toHaveProperty('badge')
  })
})

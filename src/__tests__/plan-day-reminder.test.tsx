import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../types'

// The morning's Plan your day (Q15). With push and the email digest off,
// nothing reached the owner outside the app; this is a local notification the
// phone repeats every day by itself, on at 8:00 until changed, and tapping it
// opens Plan my day. The shell answers as the iOS app and the plugin is
// stubbed at its module, keeping what it is asked to schedule and cancel.

const { plugin } = vi.hoisted(() => ({
  plugin: {
    permission: 'granted',
    pending: [] as { id: number }[],
    cancelled: [] as number[],
    scheduled: [] as Record<string, any>[],
  },
}))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' }, registerPlugin: () => ({}) }))
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: plugin.permission }),
    requestPermissions: async () => ({ display: plugin.permission }),
    registerActionTypes: async () => {},
    getPending: async () => ({ notifications: plugin.pending }),
    cancel: async ({ notifications }: { notifications: { id: number }[] }) => {
      plugin.cancelled.push(...notifications.map(n => n.id))
    },
    schedule: async ({ notifications }: { notifications: Record<string, any>[] }) => {
      plugin.scheduled.push(...notifications)
    },
  },
}))

import { PlanDayReminder } from '../components/settings/Reminders'
import { paramsOf, parseLink } from '../links'
import { PLAN_DAY_DEFAULT, planDayPref, scheduleLocalReminders, setPlanDayPref, validTime } from '../native'
import { PLAN_DAY_URL, deviceReminders, planDayReminder, reminderId } from '../reminders'

const NOW = new Date(2026, 8, 7, 12, 0) // Monday 7 September, noon, local
const saved = new Map<string, string>()

beforeEach(() => {
  saved.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  plugin.permission = 'granted'
  plugin.pending = []
  plugin.cancelled = []
  plugin.scheduled = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const due = (id: string, at: Date): Task => ({
  kind: 'task',
  id,
  title: `Task ${id}`,
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  dueAt: at.toISOString(),
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
})
const phone = (tasks: Task[] = []) => ({ tasks, people: [], places: [], meals: [] })
const planDayOf = (list: Record<string, any>[]) => list.find(n => n.extra?.url === PLAN_DAY_URL)

describe('Plan your day: what it is set to on this phone', () => {
  it('is on, at 8:00, on a phone that has never been told otherwise', () => {
    expect(planDayPref()).toEqual({ on: true, time: '08:00' })
    expect(PLAN_DAY_DEFAULT).toEqual({ on: true, time: '08:00' })
  })

  it('keeps the switch and the time chosen', () => {
    setPlanDayPref({ on: false, time: '06:45' })
    expect(planDayPref()).toEqual({ on: false, time: '06:45' })
  })

  it('reads a part it cannot understand as the default, and no storage at all as the default', () => {
    saved.set('drafter:plan-day-reminder', '{"on":false,"time":"25:00"}')
    expect(planDayPref()).toEqual({ on: false, time: '08:00' })
    saved.set('drafter:plan-day-reminder', 'not json')
    expect(planDayPref()).toEqual(PLAN_DAY_DEFAULT)
    vi.stubGlobal('localStorage', undefined)
    expect(planDayPref()).toEqual(PLAN_DAY_DEFAULT)
  })

  it('takes only a time of day', () => {
    expect(validTime('23:59')).toBe('23:59')
    for (const bad of ['8:00', '24:00', '07:60', '', null, 730]) expect(validTime(bad), String(bad)).toBeNull()
  })
})

describe('Plan your day: the notification', () => {
  it('is next due at 8:00 tomorrow from noon, and this morning before 8, and repeats every day', () => {
    const r = planDayReminder(PLAN_DAY_DEFAULT, NOW)
    expect(r).toMatchObject({ id: reminderId('plan-day'), title: 'Plan your day', url: '/?plan=day', daily: true })
    expect(r?.at).toEqual(new Date(2026, 8, 8, 8, 0))
    expect(planDayReminder(PLAN_DAY_DEFAULT, new Date(2026, 8, 7, 7, 59))?.at).toEqual(new Date(2026, 8, 7, 8, 0))
    expect(planDayReminder({ on: true, time: '06:45' }, NOW)?.at).toEqual(new Date(2026, 8, 8, 6, 45))
    expect(planDayReminder({ on: false, time: '08:00' }, NOW)).toBeNull()
  })

  it('opens Plan my day, the link the morning digest uses, which writes nothing', () => {
    const { host, params } = paramsOf(PLAN_DAY_URL)
    const link = parseLink(params, { host, allowAct: true })
    expect(link.plan).toBe('day')
    expect(link.act).toBeUndefined()
    expect(link.capture).toBeUndefined()
  })

  it('is in the phone’s set with the local reminders on or off, and gone only when switched off', () => {
    const tasks = [due('a', new Date(2026, 8, 9, 18))]
    expect(deviceReminders(phone(tasks), NOW, { local: false, planDay: PLAN_DAY_DEFAULT }).map(r => r.url)).toEqual([PLAN_DAY_URL])
    expect(deviceReminders(phone(tasks), NOW, { local: true, planDay: PLAN_DAY_DEFAULT }).map(r => r.url)).toEqual(['/?task=a', PLAN_DAY_URL])
    expect(deviceReminders(phone(tasks), NOW, { local: true, planDay: { on: false, time: '08:00' } }).map(r => r.url)).toEqual(['/?task=a'])
    expect(deviceReminders(phone(tasks), NOW, { local: false, planDay: { on: false, time: '08:00' } })).toEqual([])
  })
})

describe('Plan your day: scheduled with the phone’s own local notifications', () => {
  it('repeats at the hour and minute chosen, with no badge, beside the reminders that fire once', async () => {
    plugin.pending = [{ id: 1 }, { id: 2 }]
    const set = deviceReminders(phone([due('a', new Date(2026, 8, 9, 18))]), NOW, { local: true, planDay: { on: true, time: '07:15' } })
    expect(await scheduleLocalReminders(set)).toBe(2)
    // what was pending is replaced, not added to
    expect(plugin.cancelled).toEqual([1, 2])
    const plan = planDayOf(plugin.scheduled)
    expect(plan).toMatchObject({ id: reminderId('plan-day'), title: 'Plan your day', schedule: { on: { hour: 7, minute: 15 }, repeats: true, allowWhileIdle: true } })
    expect(plan?.schedule).not.toHaveProperty('at')
    expect(plan).not.toHaveProperty('badge')
    expect(plugin.scheduled.find(n => n.extra.url === '/?task=a')).toMatchObject({ badge: 1, schedule: { at: new Date(2026, 8, 9, 18) } })
  })

  it('keeps its slot on a full phone: the soonest 59 of the rest fill the 60', async () => {
    const tasks = Array.from({ length: 70 }, (_, i) => due(`t${i}`, new Date(2026, 8, 8, 9, i)))
    expect(await scheduleLocalReminders(deviceReminders(phone(tasks), NOW, { local: true, planDay: PLAN_DAY_DEFAULT }))).toBe(60)
    expect(planDayOf(plugin.scheduled)).toBeTruthy()
    const once = plugin.scheduled.filter(n => n.extra.url !== PLAN_DAY_URL)
    expect(once).toHaveLength(59)
    expect(once.map(n => n.badge)).toEqual(Array.from({ length: 59 }, (_, i) => i + 1))
    expect(once[once.length - 1].extra.url).toBe('/?task=t58')
  })

  it('is all the phone holds with the local reminders off', async () => {
    await scheduleLocalReminders(deviceReminders(phone([due('a', new Date(2026, 8, 9, 18))]), NOW, { local: false, planDay: PLAN_DAY_DEFAULT }))
    expect(plugin.scheduled.map(n => n.extra.url)).toEqual([PLAN_DAY_URL])
    expect(planDayOf(plugin.scheduled)?.schedule.on).toEqual({ hour: 8, minute: 0 })
  })

  it('switched off, it is taken off the phone', async () => {
    plugin.pending = [{ id: reminderId('plan-day') }]
    expect(await scheduleLocalReminders(deviceReminders(phone(), NOW, { local: false, planDay: { on: false, time: '08:00' } }))).toBe(0)
    expect(plugin.cancelled).toEqual([reminderId('plan-day')])
    expect(plugin.scheduled).toEqual([])
  })

  it('sets nothing where iOS has not allowed notifications', async () => {
    plugin.permission = 'denied'
    expect(await scheduleLocalReminders(deviceReminders(phone(), NOW, { local: false, planDay: PLAN_DAY_DEFAULT }))).toBe(0)
    expect(plugin.scheduled).toEqual([])
  })
})

describe('Plan your day: in the shell and in Settings → Reminders', () => {
  const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

  it('the shell sets it with the rest, even with the local reminders off, and asks iOS once, never over the lock', () => {
    const shell = source('components/planner/useNativeShell.ts')
    expect(shell).toMatch(/deviceReminders\(store, new Date\(\), \{ local, skipTaskDue, generic: genericRemindersEnabled\(\), planDay \}\)/)
    expect(shell).toMatch(/if \(!local && !planDay\.on\) return/)
    expect(shell).not.toMatch(/!localRemindersEnabled\(\)\) return/)
    expect(shell).toMatch(/if \(planDay\.on && !isAppLockShowing\(\)\) await requestLocalNotificationPermission\(\)/)
  })

  it('no switch in Settings takes it off the phone by scheduling an empty set', () => {
    const settings = source('components/settings/Reminders.tsx')
    expect(settings).not.toMatch(/scheduleLocalReminders\(\[\]\)/)
    expect(settings).toMatch(/<PlanDayReminder\s+pref=\{planDay\}/)
  })

  it('shows it on at 8:00 with the time to change, and the time set aside while it is off', () => {
    const on = renderToStaticMarkup(<PlanDayReminder pref={PLAN_DAY_DEFAULT} onChange={() => {}} />)
    expect(on).toContain('<h4>Plan your day</h4>')
    expect(on).toMatch(/<input type="checkbox" checked=""/)
    expect(on).toMatch(/<input type="time" value="08:00"\/>/)
    expect(on).toContain('with no push and no server; tapping it opens Plan my day.')
    const off = renderToStaticMarkup(<PlanDayReminder pref={{ on: false, time: '06:45' }} onChange={() => {}} />)
    expect(off).not.toMatch(/<input type="checkbox" checked=""/)
    // React writes an input's value last
    expect(off).toMatch(/<input type="time" disabled="" value="06:45"\/>/)
  })
})

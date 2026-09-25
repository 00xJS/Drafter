import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEntry, Task } from '../types'

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

import { NotificationsOff, PlanDayReminder } from '../components/settings/Reminders'
import { paramsOf, parseLink } from '../links'
import { PLAN_DAY_DEFAULT, localNotificationPermission, planDayPref, scheduleLocalReminders, setPlanDayPref, validTime } from '../native'
import { PLAN_DAY_URL, deviceReminders, distinctIds, planDayReminder, reminderId } from '../reminders'

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
const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

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
    expect(r).toMatchObject({ id: reminderId('plan-day'), title: 'Plan your day', url: '/?plan=day', daily: { hour: 8, minute: 0 } })
    expect(r?.at).toEqual(new Date(2026, 8, 8, 8, 0))
    expect(planDayReminder(PLAN_DAY_DEFAULT, new Date(2026, 8, 7, 7, 59))?.at).toEqual(new Date(2026, 8, 7, 8, 0))
    expect(planDayReminder({ on: true, time: '06:45' }, NOW)).toMatchObject({ at: new Date(2026, 8, 8, 6, 45), daily: { hour: 6, minute: 45 } })
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

  it('rides in one set with my own events, so neither switch takes the other off, and no two share a number', () => {
    const at = new Date(2026, 8, 9, 18)
    const event: CalendarEntry = {
      kind: 'event',
      id: 'a',
      title: 'Dentist',
      start: new Date(2026, 8, 8, 15).toISOString(),
      end: new Date(2026, 8, 8, 16).toISOString(),
      allDay: false,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ownerId: 'me',
    }
    const set = (local: boolean, on: boolean) => deviceReminders(phone([due('a', at)]), NOW, { local, planDay: { on, time: '08:00' }, events: [event], myId: 'me' })
    // a task and an event with the same id are two reminders, with two numbers
    expect(set(true, true).map(r => r.url)).toEqual(['/?view=calendar', '/?task=a', PLAN_DAY_URL])
    expect(new Set(set(true, true).map(r => r.id)).size).toBe(3)
    // Remind me on this iPhone off: the event and the task go, Plan your day stays
    expect(set(false, true).map(r => r.url)).toEqual([PLAN_DAY_URL])
    // Plan your day off: the event and the task stay
    expect(set(true, false).map(r => r.url)).toEqual(['/?view=calendar', '/?task=a'])
  })

  it('moves a number another reminder in the set already holds to the next free one', () => {
    const at = new Date(2026, 8, 9, 18)
    const r = (id: number, url: string) => ({ id, title: url, body: '', at, url })
    const list = [r(7, 'a'), r(7, 'b'), r(8, 'c'), r(0x7fffffff, 'd'), r(0x7fffffff, 'e')]
    const out = distinctIds(list)
    expect(out.map(x => x.id)).toEqual([7, 8, 9, 0x7fffffff, 0])
    expect(out.map(x => x.url)).toEqual(['a', 'b', 'c', 'd', 'e'])
    // one that was free is left as it was
    expect(out[0]).toBe(list[0])
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

  it('repeats at the time chosen, not wherever its next time landed: the morning the clocks go forward', async () => {
    // on 28 March 2027 in London, setHours(1, 30) gives 02:30, as 01:30 never
    // happens that day; the phone must still repeat at 01:30 every other morning
    const plan = { ...planDayReminder({ on: true, time: '01:30' }, NOW)!, at: new Date(2026, 8, 8, 2, 30) }
    expect(plan.daily).toEqual({ hour: 1, minute: 30 })
    await scheduleLocalReminders([plan])
    expect(planDayOf(plugin.scheduled)?.schedule.on).toEqual({ hour: 1, minute: 30 })
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

// It is on by default, so a No when iOS asked, notifications turned off later
// in the Settings app, or iOS never asked at all, left it ticked at 08:00 in
// Settings while scheduleLocalReminders quietly set nothing. Settings now says
// so, and offers to ask while iOS has yet to.
describe('Plan your day: when iOS won’t let it through', () => {
  it('reads what iOS allows without asking', async () => {
    for (const [display, read] of [
      ['granted', 'granted'],
      ['denied', 'denied'],
      ['prompt', 'prompt'],
      ['prompt-with-rationale', 'prompt'],
    ] as const) {
      plugin.permission = display
      expect(await localNotificationPermission(), display).toBe(read)
    }
  })

  it('says so under the switches, with where to turn notifications on, or a button while iOS has yet to ask', () => {
    const denied = renderToStaticMarkup(<NotificationsOff allowed="denied" onAllow={() => {}} />)
    expect(denied).toMatch(/^<p class="warn">None of these can reach you/)
    expect(denied).toContain('Turn them on in the iPhone Settings app, under Drafter.')
    const prompt = renderToStaticMarkup(<NotificationsOff allowed="prompt" onAllow={() => {}} />)
    expect(prompt).toContain('<button class="btn">Allow notifications</button>')
    for (const allowed of ['granted', null] as const) expect(renderToStaticMarkup(<NotificationsOff allowed={allowed} onAllow={() => {}} />)).toBe('')
  })

  it('Settings reads it on open and on coming back to the app, shows it while a reminder is on, and a new time asks too', () => {
    const settings = source('components/settings/Reminders.tsx')
    expect(settings).toMatch(/localNotificationPermission\(\)\.then\(/)
    expect(settings).toMatch(/document\.addEventListener\('visibilitychange', onShow\)/)
    expect(settings).toMatch(/\(localOn \|\| planDay\.on\) && \(\s*<NotificationsOff\s+allowed=\{allowed\}/)
    // not only when it is switched on: a change of time asks as well
    expect(settings).toMatch(/const ok = next\.on \? await ask\(\) : true/)
    expect(settings).not.toMatch(/next\.on && !planDay\.on && !\(await requestLocalNotificationPermission\(\)\)/)
  })
})

describe('Plan your day: in the shell and in Settings → Reminders', () => {
  it('the shell sets it with the rest, even with the local reminders off, and never asks iOS itself', () => {
    const shell = source('components/planner/useNativeShell.ts')
    // with the calendar's own events, which ring through the same set, and
    // the tasks' own due rows whether or not server push is on for this phone:
    // the server's "Due now" nudges go to browsers, never to an iPhone
    // worked out when the rewrite's turn comes (scheduleLocalReminders runs one at a time), from the latest data
    expect(shell).toMatch(
      /deviceReminders\(now, new Date\(\), \{ local: localRemindersEnabled\(\), generic: genericRemindersEnabled\(\), planDay: planDayPref\(\), events: now\.events, myId: me \}\)/,
    )
    expect(shell).not.toMatch(/skipTaskDue|fetchPushInfo/)
    expect(shell).toMatch(/if \(!localRemindersEnabled\(\) && !planDayPref\(\)\.on\) return/)
    expect(shell).not.toMatch(/!localRemindersEnabled\(\)\) return/)
    // the question comes from a button someone pressed (reminder-offer.test.ts)
    expect(shell).not.toMatch(/requestLocalNotificationPermission/)
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

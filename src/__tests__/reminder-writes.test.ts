import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingReminder } from '../native'

// The phone's own reminders are one set, replaced whole: read what iOS holds,
// cancel it, schedule the new set. Two rewrites at once interleaved those
// steps, so an older set could land last — a "Due now" for a task already done
// on the other phone. And the whole set was rewritten 1.5 s after any change
// at all. Now one write runs at a time, the newest set waiting is the only one
// written after it (read when its turn comes), and a set iOS already holds is
// left alone. The plugin is faked at its module and logs every call.

const { plugin } = vi.hoisted(() => ({
  plugin: {
    log: [] as string[],
    pending: [] as { id: number }[],
    scheduled: [] as Record<string, unknown>[][],
    /** A gate the next getPending waits on, to hold a write half way. */
    hold: null as Promise<void> | null,
  },
}))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' }, registerPlugin: () => ({}) }))
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: 'granted' }),
    requestPermissions: async () => ({ display: 'granted' }),
    registerActionTypes: async () => {},
    getPending: async () => {
      plugin.log.push('getPending')
      const wait = plugin.hold
      plugin.hold = null
      if (wait) await wait
      return { notifications: [...plugin.pending] }
    },
    cancel: async ({ notifications }: { notifications: { id: number }[] }) => {
      plugin.log.push(`cancel ${notifications.map(n => n.id).join(',')}`)
      plugin.pending = plugin.pending.filter(p => !notifications.some(n => n.id === p.id))
    },
    schedule: async ({ notifications }: { notifications: (Record<string, unknown> & { id: number })[] }) => {
      plugin.log.push(`schedule ${notifications.map(n => n.id).join(',')}`)
      plugin.scheduled.push(notifications)
      plugin.pending = [...plugin.pending, ...notifications.map(n => ({ id: n.id }))]
    },
  },
}))

import { scheduleLocalReminders } from '../native'

const NOW = new Date(2026, 8, 7, 12, 0)
const reminder = (id: number, title = `Task ${id}`): PendingReminder => ({ id, title, body: '', at: new Date(2026, 8, 8, 9, id % 60), url: `/?task=${id}` })

/** A promise and the function that settles it. */
function deferred() {
  let open = () => {}
  const promise = new Promise<void>(resolve => (open = resolve))
  return { promise, open }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  plugin.log = []
  plugin.pending = []
  plugin.scheduled = []
  plugin.hold = null
})
afterEach(() => {
  vi.useRealTimers()
})

describe('one rewrite of the phone’s reminders at a time', () => {
  it('a set asked for mid-write waits, and the newest set is the one iOS ends up holding', async () => {
    // the first write is held after reading what is pending, as a slow bridge would hold it
    const gate = deferred()
    plugin.hold = gate.promise
    const first = scheduleLocalReminders([reminder(1), reminder(2)])
    await Promise.resolve()
    // …a task is marked done on the other phone meanwhile: the newer set has no 2
    const second = scheduleLocalReminders([reminder(1)])
    gate.open()
    expect(await first).toBe(1)
    expect(await second).toBe(1)
    // never interleaved: each write reads, cancels and schedules before the next begins
    expect(plugin.log).toEqual(['getPending', 'schedule 1,2', 'getPending', 'cancel 1,2', 'schedule 1'])
    expect(plugin.pending.map(p => p.id)).toEqual([1])
  })

  it('of three asked for during one write, only the newest is written after it', async () => {
    const gate = deferred()
    plugin.hold = gate.promise
    const runs = [scheduleLocalReminders([reminder(10)])]
    await Promise.resolve()
    runs.push(scheduleLocalReminders([reminder(11)]), scheduleLocalReminders([reminder(12)]), scheduleLocalReminders([reminder(13)]))
    gate.open()
    await Promise.all(runs)
    expect(plugin.scheduled.map(set => set.map(n => n.id))).toEqual([[10], [13]])
  })

  it('a set given as a function is worked out when its turn comes, from the data as it is then', async () => {
    const gate = deferred()
    plugin.hold = gate.promise
    let tasks = [reminder(20), reminder(21)]
    const first = scheduleLocalReminders([reminder(20), reminder(21)])
    await Promise.resolve()
    const second = scheduleLocalReminders(() => tasks)
    // the data moves on after it was asked for, before its turn
    tasks = [reminder(20)]
    gate.open()
    await Promise.all([first, second])
    expect(plugin.scheduled[plugin.scheduled.length - 1].map(n => n.id)).toEqual([20])
  })
})

describe('an unchanged set is left alone', () => {
  it('writes nothing when iOS already holds exactly the set, and rewrites once it changes', async () => {
    await scheduleLocalReminders([reminder(30), reminder(31)])
    plugin.log = []
    await scheduleLocalReminders([reminder(30), reminder(31)])
    expect(plugin.log).toEqual(['getPending'])
    // a renamed task is a different set
    await scheduleLocalReminders([reminder(30), reminder(31, 'Task 31, renamed')])
    expect(plugin.log).toEqual(['getPending', 'getPending', 'cancel 30,31', 'schedule 30,31'])
  })

  it('rewrites a set iOS no longer holds whole, even when it is the one written last', async () => {
    await scheduleLocalReminders([reminder(40), reminder(41)])
    // something took one off the phone
    plugin.pending = plugin.pending.filter(p => p.id !== 41)
    plugin.log = []
    await scheduleLocalReminders([reminder(40), reminder(41)])
    expect(plugin.log).toEqual(['getPending', 'cancel 40', 'schedule 40,41'])
  })
})

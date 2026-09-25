import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The iPhone's notifications question, asked from the moment it is for: the
// first time a task of mine is given a time to be due, one line says what the
// answer is for, and only its button puts iOS's question (src/reminderoffer.ts).
// The planner used to ask by itself a second and a half after it opened.

const env = vi.hoisted(() => ({ native: true, display: 'prompt' as string, asked: 0, answer: 'granted' }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => env.native, getPlatform: () => (env.native ? 'ios' : 'web'), isPluginAvailable: () => false },
  registerPlugin: () => ({}),
}))
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: env.display }),
    requestPermissions: async () => {
      env.asked++
      env.display = env.answer
      return { display: env.answer }
    },
  },
}))

import { localRemindersEnabled, onNotificationsAllowed } from '../native'
import { REMINDER_OFFER_BUTTON, REMINDER_OFFER_KEY, REMINDER_OFFER_LINE, allowDueReminders, givesDueTime, takeReminderOffer } from '../reminderoffer'
import type { Task } from '../types'

const saved = new Map<string, string>()
beforeEach(() => {
  saved.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  })
  env.native = true
  env.display = 'prompt'
  env.asked = 0
  env.answer = 'granted'
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const ME = 'me'
const at = (h: number, m = 0) => new Date(2026, 8, 26, h, m).toISOString()
const task = (over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: 't',
  title: 'Call the plumber',
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  createdAt: at(0),
  updatedAt: at(0),
  ownerId: ME,
  ...over,
})

describe('givesDueTime: a task of mine given a time to be due', () => {
  it('a new task with a time, or a time added or changed', () => {
    expect(givesDueTime(undefined, task({ dueAt: at(15) }), ME)).toBe(true)
    expect(givesDueTime({ dueAt: undefined }, task({ dueAt: at(15) }), ME)).toBe(true)
    expect(givesDueTime({ dueAt: at(0) }, task({ dueAt: at(15) }), ME)).toBe(true)
    expect(givesDueTime({ dueAt: at(9) }, task({ dueAt: at(15, 30) }), ME)).toBe(true)
  })

  it('not a day alone, a time kept as it was, one that is done, or the other member’s', () => {
    expect(givesDueTime(undefined, task({ dueAt: at(0) }), ME)).toBe(false)
    expect(givesDueTime({ dueAt: at(15) }, task({ dueAt: at(15) }), ME)).toBe(false)
    expect(givesDueTime(undefined, task({ dueAt: at(15), status: 'done' }), ME)).toBe(false)
    expect(givesDueTime(undefined, task({ dueAt: at(15), assigneeId: 'them' }), ME)).toBe(false)
    expect(givesDueTime(undefined, task(), ME)).toBe(false)
  })
})

describe('takeReminderOffer: once, in the app, while iOS has yet to be asked', () => {
  it('offers the first time, and never again on this phone, whatever became of it', async () => {
    expect(await takeReminderOffer(undefined, task({ dueAt: at(15) }), ME)).toBe(true)
    expect(saved.has(REMINDER_OFFER_KEY)).toBe(true)
    expect(await takeReminderOffer(undefined, task({ id: 'u', dueAt: at(16) }), ME)).toBe(false)
    // offering is not asking: iOS has been asked nothing
    expect(env.asked).toBe(0)
  })

  it('not once iOS has been answered, nor on the web, nor for a save that sets no time', async () => {
    for (const display of ['granted', 'denied']) {
      env.display = display
      expect(await takeReminderOffer(undefined, task({ dueAt: at(15) }), ME), display).toBe(false)
    }
    env.display = 'prompt'
    env.native = false
    expect(await takeReminderOffer(undefined, task({ dueAt: at(15) }), ME)).toBe(false)
    env.native = true
    expect(await takeReminderOffer(undefined, task({ dueAt: at(0) }), ME)).toBe(false)
    expect(saved.has(REMINDER_OFFER_KEY)).toBe(false)
  })

  it('never on a phone that can keep nothing: it would offer on every save', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(await takeReminderOffer(undefined, task({ dueAt: at(15) }), ME)).toBe(false)
  })
})

describe('allowDueReminders: the offer’s button', () => {
  it('asks iOS, and on a yes turns this phone’s reminders on and sets them', async () => {
    const heard = vi.fn()
    const stop = onNotificationsAllowed(() => heard(localRemindersEnabled()))
    expect(await allowDueReminders()).toBe(true)
    stop()
    expect(env.asked).toBe(1)
    expect(localRemindersEnabled()).toBe(true)
    // the reminders are set on the yes, with the switch already on
    expect(heard).toHaveBeenCalledWith(true)
  })

  it('on a no, leaves them off', async () => {
    env.answer = 'denied'
    expect(await allowDueReminders()).toBe(false)
    expect(localRemindersEnabled()).toBe(false)
  })
})

describe('in the planner', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

  it('is offered as the task editor saves, with the line first and the button to ask', () => {
    const overlays = read('components/planner/Overlays.tsx')
    expect(overlays).toMatch(/offerReminders\(before, t, isNew \? addedLine\(t\)\.msg : null\)/)
    expect(overlays).toMatch(/label: REMINDER_OFFER_BUTTON,\s*run: \(\) => void allowDueReminders\(\)/)
    expect(REMINDER_OFFER_LINE).toBe('Drafter can remind you on this iPhone when a task is due.')
    expect(REMINDER_OFFER_BUTTON).toBe('Remind me')
  })

  it('and asked by nothing else in the shell', () => {
    const shell = read('components/planner/useNativeShell.ts')
    expect(shell).not.toMatch(/requestLocalNotificationPermission|requestPermissions/)
    expect(shell).toMatch(/onNotificationsAllowed\(\(\) => remindersRef\.current\(\)\)/)
  })
})

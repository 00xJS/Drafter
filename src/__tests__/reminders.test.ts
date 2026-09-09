import { describe, expect, it } from 'vitest'
import { Person, Place, Task } from '../types'
import { buildLocalReminders } from '../reminders'

const NOW = new Date(2026, 8, 7, 12, 0) // Mon 7 Sep 2026, noon local

const task = (id: string, extra: Partial<Task>): Task => ({
  kind: 'task',
  id,
  title: `Task ${id}`,
  description: '',
  status: 'todo',
  priority: 'normal',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  tags: [],
  ...extra,
})

const person = (id: string, birthday: string): Person => ({
  kind: 'person',
  id,
  name: `Person ${id}`,
  group: 'family',
  color: '#f97316',
  birthday,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
})

const place = (id: string, name: string, cadenceDays?: number): Place => ({
  kind: 'place',
  id,
  name,
  color: '#f97316',
  category: 'other',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  ...(cadenceDays === undefined ? {} : { cadenceDays }),
})

/** A logged outing: a done task tagged visit, carrying the place id. */
const outing = (id: string, placeId: string, daysAgo: number): Task =>
  task(id, {
    status: 'done',
    tags: ['visit'],
    placeId,
    completedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
  })

/** 9am tomorrow — NOW is noon, so the next morning slot is the day after. */
const TOMORROW_9 = new Date(2026, 8, 8, 9, 0)

describe('local reminders', () => {
  it('fires at a timed task\'s due time and opens that task', () => {
    const due = new Date(2026, 8, 8, 18, 30)
    const [r] = buildLocalReminders([task('a', { title: 'Bins out', dueAt: due.toISOString() })], [], [], NOW)
    expect(r.at.getTime()).toBe(due.getTime())
    expect(r.title).toBe('Due now: Bins out')
    expect(r.url).toBe('/?task=a')
    expect(r.actionTypeId).toBe('DRAFTER_TASK')
  })

  it('moves a date-only (midnight) due to the morning instead of 00:00', () => {
    const [r] = buildLocalReminders([task('a', { dueAt: new Date(2026, 8, 9, 0, 0).toISOString() })], [], [], NOW)
    expect([r.at.getHours(), r.at.getMinutes()]).toEqual([9, 0])
  })

  it('skips done, undated, past and far-future work', () => {
    const list = buildLocalReminders(
      [
        task('done', { status: 'done', dueAt: new Date(2026, 8, 8).toISOString() }),
        task('undated', {}),
        task('past', { dueAt: new Date(2026, 8, 6, 10).toISOString() }),
        task('far', { dueAt: new Date(2026, 11, 25).toISOString() }),
        task('soon', { dueAt: new Date(2026, 8, 10, 8).toISOString() }),
      ],
      [],
      [],
      NOW,
    )
    expect(list.map(r => r.url)).toEqual(['/?task=soon'])
  })

  it('adds a 9am reminder on the day of a birthday', () => {
    const list = buildLocalReminders([], [person('mum', '1960-09-12')], [], NOW)
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe("Person mum's birthday today")
    expect([list[0].at.getMonth(), list[0].at.getDate(), list[0].at.getHours()]).toEqual([8, 12, 9])
    expect(list[0].body).toContain('66 years')
    expect(list[0].actionTypeId).toBe('DRAFTER_OCCASION')
  })

  it('skips task due rows when skipTaskDue is set (APNs already subscribed)', () => {
    const due = new Date(2026, 8, 8, 18, 30)
    const list = buildLocalReminders([task('a', { title: 'Bins out', dueAt: due.toISOString() })], [person('mum', '1960-09-12')], [], NOW, 30, {
      skipTaskDue: true,
    })
    expect(list.every(r => !r.url.startsWith('/?task='))).toBe(true)
    expect(list.some(r => r.title.includes('birthday'))).toBe(true)
  })
})

describe('generic lock-screen reminders', () => {
  it('keeps titles and names out of the notification but the deep link intact', () => {
    const due = new Date(2026, 8, 8, 18, 30)
    const list = buildLocalReminders([task('a', { title: 'Call the bank', dueAt: due.toISOString(), description: 'account 1234' })], [person('mum', '1960-09-12')], [], NOW, 30, { generic: true })
    const taskRow = list.find(r => r.url === '/?task=a')!
    const occasion = list.find(r => r.url === '/?saw=mum')!
    // a banner that will not say which task it is must not offer a blind Done
    expect(taskRow.actionTypeId).toBeUndefined()
    expect(occasion.actionTypeId).toBeUndefined()
    expect(taskRow.title).toBe('Something is due')
    expect(taskRow.body).not.toContain('1234')
    expect(occasion.title).toBe('An occasion today')
    expect(occasion.body).not.toContain('mum')
    expect(JSON.stringify(list)).not.toContain('Call the bank')
  })
})

describe('place cadence reminders', () => {
  it('nudges for a place whose rhythm you clearly missed, on a 9am within the week', () => {
    const list = buildLocalReminders([outing('v1', 'nopi', 63)], [], [place('nopi', 'Nopi', 30)], NOW)
    expect(list).toHaveLength(1)
    const [r] = list
    expect(r.title).toBe('Been a while: Nopi')
    expect(r.url).toBe('/?place=nopi')
    expect([r.at.getHours(), r.at.getMinutes()]).toEqual([9, 0])
    expect(r.at.getTime()).toBeGreaterThan(NOW.getTime())
    expect(r.at.getTime()).toBeLessThanOrEqual(NOW.getTime() + 7 * 86_400_000)
    expect(r.body).toContain('63 days ago')
    expect(r.body).toContain('every 30 days')
    // no action buttons: there is nothing a banner can do about a place
    expect(r.actionTypeId).toBeUndefined()
  })

  it('keeps that place on its own weekday, so a daily rebuild cannot nudge daily', () => {
    const tasks = [outing('v1', 'nopi', 63)]
    const places = [place('nopi', 'Nopi', 30)]
    const weekdays = new Set<number>()
    for (let d = 0; d < 7; d++) {
      const [r] = buildLocalReminders(tasks, [], places, new Date(NOW.getTime() + d * 86_400_000))
      weekdays.add(r.at.getDay())
    }
    expect(weekdays.size).toBe(1)
  })

  it('ignores merely due, never-visited-without-a-rhythm, cadence-less and deleted places', () => {
    const places = [
      place('due', 'Only due', 30), // 35 days: past the cadence, not past 1.5x
      place('norhythm', 'No rhythm'), // opt-in only — a place you went once is never overdue
      { ...place('gone', 'Deleted', 30), deletedAt: NOW.toISOString() },
    ]
    const tasks = [outing('v1', 'due', 35), outing('v2', 'norhythm', 400), outing('v3', 'gone', 400)]
    expect(buildLocalReminders(tasks, [], places, NOW)).toEqual([])
  })

  it('caps places at three per rebuild, keeping the longest overdue', () => {
    const days = [200, 100, 400, 90, 300]
    const places = days.map((_, i) => place(`p${i}`, `Place ${i}`, 30))
    const tasks = days.map((d, i) => outing(`v${i}`, `p${i}`, d))
    const list = buildLocalReminders(tasks, [], places, NOW)
    expect(list).toHaveLength(3)
    // 400, 300 and 200 days survive the cap; the emitted order is by morning
    // slot, which each place picks from its own id
    expect(list.map(r => r.url).sort()).toEqual(['/?place=p0', '/?place=p2', '/?place=p4'])
  })

  it('hides the name when the lock screen is generic, and keeps the link', () => {
    const list = buildLocalReminders([outing('v1', 'nopi', 63)], [], [place('nopi', 'Nopi', 30)], NOW, 30, { generic: true })
    expect(list[0].title).toBe('Somewhere to revisit')
    expect(list[0].url).toBe('/?place=nopi')
    expect(JSON.stringify(list)).not.toContain('Nopi')
  })

  // 'ivy' is a place whose id puts its weekday slot on tomorrow, so all three
  // rows land in the same 9am and the tie-break is what is under test
  it('keeps a place behind the tasks and occasions sharing its morning', () => {
    const list = buildLocalReminders(
      [task('bins', { dueAt: new Date(2026, 8, 8, 0, 0).toISOString() }), outing('v1', 'ivy', 63)],
      [person('mum', '1960-09-08')],
      [place('ivy', 'Ivy', 30)],
      NOW,
    )
    expect(list.map(r => r.at.getTime())).toEqual([TOMORROW_9.getTime(), TOMORROW_9.getTime(), TOMORROW_9.getTime()])
    expect(list.map(r => r.url)).toEqual(['/?task=bins', '/?saw=mum', '/?place=ivy'])
  })

  it('still nudges when server push owns the due rows', () => {
    const list = buildLocalReminders([outing('v1', 'nopi', 63)], [], [place('nopi', 'Nopi', 30)], NOW, 30, { skipTaskDue: true })
    expect(list.map(r => r.url)).toEqual(['/?place=nopi'])
  })
})

import { describe, expect, it } from 'vitest'
import { CalendarEntry, Person, Place, Task } from '../types'
import { buildLocalReminders, reminderId } from '../reminders'
import { dueNotices } from '../notify'

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
    const [r] = buildLocalReminders([task('a', { title: 'Bins out', dueAt: due.toISOString() })], [], [], [], NOW)
    expect(r.at.getTime()).toBe(due.getTime())
    expect(r.title).toBe('Due now: Bins out')
    expect(r.url).toBe('/?task=a')
    expect(r.actionTypeId).toBe('DRAFTER_TASK')
  })

  it('moves a date-only (midnight) due to the morning instead of 00:00, and says it is due today rather than now', () => {
    const [r] = buildLocalReminders([task('a', { title: 'Bins out', dueAt: new Date(2026, 8, 9, 0, 0).toISOString() })], [], [], [], NOW)
    expect([r.at.getDate(), r.at.getHours(), r.at.getMinutes()]).toEqual([9, 9, 0])
    // a day with no time is due all of it, so 9am is no deadline
    expect(r.title).toBe('Due today: Bins out')
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
      [],
      NOW,
    )
    expect(list.map(r => r.url)).toEqual(['/?task=soon'])
  })

  it('adds a 9am reminder on the day of a birthday', () => {
    const list = buildLocalReminders([], [person('mum', '1960-09-12')], [], [], NOW)
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe("Person mum's birthday today")
    expect([list[0].at.getMonth(), list[0].at.getDate(), list[0].at.getHours()]).toEqual([8, 12, 9])
    expect(list[0].body).toContain('66 years')
    expect(list[0].actionTypeId).toBe('DRAFTER_OCCASION')
  })

  // The owner's call (2026-09-23): a chore assigned to the other member rang
  // on both phones. It rings for the person doing it, by the rule the mirrors
  // and feeds already use (isMineTask): the assignee, or whoever filed it
  // when nobody is.
  it('rings only for the person doing the task: its assignee, or whoever filed it when nobody is', () => {
    const ME = 'me-0001'
    const THEM = 'partner-0002'
    const due = new Date(2026, 8, 8, 18, 30).toISOString()
    const tasks = [
      task('assigned-to-me', { dueAt: due, ownerId: THEM, assigneeId: ME }),
      task('assigned-to-them', { dueAt: due, ownerId: ME, assigneeId: THEM }),
      task('filed-by-me', { dueAt: due, ownerId: ME }),
      task('filed-by-them', { dueAt: due, ownerId: THEM }),
      task('from-before-accounts', { dueAt: due }),
    ]
    const urls = (myId?: string | null) => buildLocalReminders(tasks, [], [], [], NOW, 30, { myId }).map(r => r.url)
    expect(urls(ME)).toEqual(['/?task=assigned-to-me', '/?task=filed-by-me', '/?task=from-before-accounts'])
    expect(urls(THEM)).toEqual(['/?task=assigned-to-them', '/?task=filed-by-them', '/?task=from-before-accounts'])
    // no account (local mode): every task is yours
    expect(urls(null)).toHaveLength(5)
  })
})

describe('generic lock-screen reminders', () => {
  it('keeps titles and names out of the notification but the deep link intact', () => {
    const due = new Date(2026, 8, 8, 18, 30)
    const list = buildLocalReminders([task('a', { title: 'Call the bank', dueAt: due.toISOString(), description: 'account 1234' })], [person('mum', '1960-09-12')], [], [], NOW, 30, { generic: true })
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
    const list = buildLocalReminders([outing('v1', 'nopi', 63)], [], [place('nopi', 'Nopi', 30)], [], NOW)
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
      const [r] = buildLocalReminders(tasks, [], places, [], new Date(NOW.getTime() + d * 86_400_000))
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
    expect(buildLocalReminders(tasks, [], places, [], NOW)).toEqual([])
  })

  it('caps places at three per rebuild, keeping the longest overdue', () => {
    const days = [200, 100, 400, 90, 300]
    const places = days.map((_, i) => place(`p${i}`, `Place ${i}`, 30))
    const tasks = days.map((d, i) => outing(`v${i}`, `p${i}`, d))
    const list = buildLocalReminders(tasks, [], places, [], NOW)
    expect(list).toHaveLength(3)
    // 400, 300 and 200 days survive the cap; the emitted order is by morning
    // slot, which each place picks from its own id
    expect(list.map(r => r.url).sort()).toEqual(['/?place=p0', '/?place=p2', '/?place=p4'])
  })

  it('hides the name when the lock screen is generic, and keeps the link', () => {
    const list = buildLocalReminders([outing('v1', 'nopi', 63)], [], [place('nopi', 'Nopi', 30)], [], NOW, 30, { generic: true })
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
      [],
      NOW,
    )
    expect(list.map(r => r.at.getTime())).toEqual([TOMORROW_9.getTime(), TOMORROW_9.getTime(), TOMORROW_9.getTime()])
    expect(list.map(r => r.url)).toEqual(['/?task=bins', '/?saw=mum', '/?place=ivy'])
  })

})

// Drafter alone reminds: the copies of my events in Google and Outlook carry
// no reminder of their own any more, so the phone covers my own events, on the
// same rule as a task's due date. Nothing may lose its only reminder.
describe('my own events', () => {
  const ME = 'me-0001'
  const event = (id: string, extra: Partial<CalendarEntry>): CalendarEntry => ({
    kind: 'event',
    id,
    title: `Event ${id}`,
    start: new Date(2026, 8, 8, 15, 0).toISOString(),
    end: new Date(2026, 8, 8, 16, 0).toISOString(),
    allDay: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ownerId: ME,
    ...extra,
  })
  const build = (events: CalendarEntry[], opts: { generic?: boolean } = {}) => buildLocalReminders([], [], [], [], NOW, 30, { events, myId: ME, ...opts })

  it('fires at a timed event’s start, saying where, and opens the calendar', () => {
    const [r] = build([event('e1', { title: 'Dentist', location: 'High Street' })])
    expect(r.at.getTime()).toBe(new Date(2026, 8, 8, 15, 0).getTime())
    expect(r.title).toBe('Starts now: Dentist')
    expect(r.body).toBe('High Street')
    expect(r.url).toBe('/?view=calendar')
    // Done and Tomorrow mean nothing for an event
    expect(r.actionTypeId).toBeUndefined()
  })

  it('reminds about an all-day event on the morning of its first day, as a date-only task does', () => {
    const [r] = build([event('e1', { title: 'Mum visiting', allDay: true, start: '2026-09-10', end: '2026-09-13', notes: 'Spare room ready' })])
    expect([r.at.getFullYear(), r.at.getMonth(), r.at.getDate(), r.at.getHours(), r.at.getMinutes()]).toEqual([2026, 8, 10, 9, 0])
    expect(r.title).toBe('Today: Mum visiting')
    expect(r.body).toBe('Spare room ready')
  })

  it('leaves out work days, a household member’s events, deleted ones, and what is past or beyond the horizon', () => {
    const list = build([
      event('work', { work: 'office' }),
      event('theirs', { ownerId: 'partner-0002' }),
      event('gone', { deletedAt: NOW.toISOString() }),
      event('past', { start: new Date(2026, 8, 7, 9, 0).toISOString() }),
      event('far', { start: new Date(2026, 11, 25, 9, 0).toISOString() }),
      event('unowned', { ownerId: undefined }),
      event('mine', {}),
    ])
    expect(list.map(r => r.id).sort()).toEqual([reminderId('event:mine'), reminderId('event:unowned')].sort())
  })

  it('rings for my event and my task alike: server push takes neither off the phone, as its nudges go to browsers alone', () => {
    const list = buildLocalReminders([task('a', { dueAt: new Date(2026, 8, 8, 18, 30).toISOString() })], [], [], [], NOW, 30, { events: [event('e1', {})], myId: ME })
    expect(list.map(r => r.url)).toEqual(['/?view=calendar', '/?task=a'])
  })

  it('keeps the title and the place off a generic lock screen', () => {
    const [r] = build([event('e1', { title: 'Clinic', location: '12 Harley Street' })], { generic: true })
    expect(r.title).toBe('Something on your calendar')
    expect(JSON.stringify(r)).not.toContain('Clinic')
    expect(JSON.stringify(r)).not.toContain('Harley')
  })

  it('one reminder per event, so a rebuild after a move replaces it rather than adding another', () => {
    const [a] = build([event('e1', {})])
    const [b] = build([event('e1', { start: new Date(2026, 8, 9, 10, 0).toISOString(), end: new Date(2026, 8, 9, 11, 0).toISOString() })])
    expect(a.id).toBe(b.id)
    expect(b.at.getDate()).toBe(9)
  })

  it('sits after the tasks and before the occasions sharing its morning', () => {
    const list = buildLocalReminders([task('bins', { dueAt: new Date(2026, 8, 8, 0, 0).toISOString() })], [person('mum', '1960-09-08')], [], [], NOW, 30, {
      events: [event('fair', { allDay: true, start: '2026-09-08', end: '2026-09-09' })],
      myId: ME,
    })
    expect(list.map(r => r.url)).toEqual(['/?task=bins', '/?view=calendar', '/?saw=mum'])
  })
})

// A browser with Drafter open is the other place a reminder can come from, and
// without the phone's own it was the only one for an event whose copy in
// Google or Outlook no longer rings. It goes by the phone's rule.
describe('while the app is open (a browser’s notifications)', () => {
  const ME = 'me-0001'
  const event = (id: string, extra: Partial<CalendarEntry>): CalendarEntry => ({
    kind: 'event',
    id,
    title: `Event ${id}`,
    start: new Date(2026, 8, 8, 15, 0).toISOString(),
    end: new Date(2026, 8, 8, 16, 0).toISOString(),
    allDay: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ownerId: ME,
    ...extra,
  })
  const on8th = (h: number, m = 0) => new Date(2026, 8, 8, h, m).getTime()

  it('rings as one of my events starts, saying where; not before, not once it is over, and again once moved', () => {
    const e = event('e1', { title: 'Dentist', location: 'High Street' })
    expect(dueNotices([], on8th(14, 59), { events: [e], myId: ME })).toEqual([])
    const [n] = dueNotices([], on8th(15, 10), { events: [e], myId: ME })
    expect(n).toEqual({ key: `event:e1@${e.start}`, title: 'Dentist starts now', body: 'High Street' })
    expect(dueNotices([], on8th(16, 0), { events: [e], myId: ME })).toEqual([])
    const moved = { ...e, start: new Date(2026, 8, 8, 17, 0).toISOString(), end: new Date(2026, 8, 8, 18, 0).toISOString() }
    expect(dueNotices([], on8th(17, 5), { events: [moved], myId: ME })[0].key).not.toBe(n.key)
  })

  it('an all-day event rings from 9am on its first day, as the phone’s does, and not the day after', () => {
    const e = event('fair', { title: 'School fair', allDay: true, start: '2026-09-08', end: '2026-09-09', notes: 'Bring cakes' })
    expect(dueNotices([], on8th(8, 59), { events: [e] })).toEqual([])
    expect(dueNotices([], on8th(20, 0), { events: [e] })).toEqual([{ key: 'event:fair@2026-09-08', title: 'School fair is today', body: 'Bring cakes' }])
    expect(dueNotices([], new Date(2026, 8, 9, 9, 30).getTime(), { events: [e] })).toEqual([])
  })

  it('never a work day, a household member’s event or a deleted one', () => {
    const mine = event('mine', {})
    const list = dueNotices([], on8th(15, 30), {
      events: [event('work', { work: 'office' }), event('theirs', { ownerId: 'partner-0002' }), event('gone', { deletedAt: NOW.toISOString() }), mine],
      myId: ME,
    })
    expect(list.map(n => n.key)).toEqual([`event:mine@${mine.start}`])
  })

  it('tasks ring as they always did: open, due within the last day, keyed by the task', () => {
    const list = dueNotices(
      [
        task('a', { dueAt: new Date(2026, 8, 8, 15, 0).toISOString(), description: 'Card on file' }),
        task('done', { dueAt: new Date(2026, 8, 8, 15, 0).toISOString(), status: 'done' }),
        task('stale', { dueAt: new Date(2026, 8, 6, 15, 0).toISOString() }),
        task('later', { dueAt: new Date(2026, 8, 8, 18, 0).toISOString() }),
      ],
      on8th(15, 30),
    )
    expect(list).toEqual([{ key: 'a', title: 'Task a is due now', body: 'Card on file', tag: 'due-a' }])
  })

  it('a day with no time rings at 9am as the phone’s does, “due today”, never at the 00:00 it is stored at, and not once the day is over', () => {
    const bins = task('bins', { title: 'Bins out', dueAt: new Date(2026, 8, 8).toISOString() })
    expect(dueNotices([bins], on8th(0, 0))).toEqual([])
    expect(dueNotices([bins], on8th(8, 59))).toEqual([])
    expect(dueNotices([bins], on8th(9, 0))).toEqual([{ key: 'bins', title: 'Bins out is due today', body: 'Open Drafter for the details.', tag: 'due-bins' }])
    expect(dueNotices([bins], on8th(23, 59))).toHaveLength(1)
    // overdue from midnight: Home says so, and "due today" would not be true
    expect(dueNotices([bins], new Date(2026, 8, 9, 0, 1).getTime())).toEqual([])
  })

  it('rings only for the person doing the task', () => {
    const due = new Date(2026, 8, 8, 15, 0).toISOString()
    const tasks = [task('mine', { dueAt: due, ownerId: 'x', assigneeId: ME }), task('theirs', { dueAt: due, ownerId: ME, assigneeId: 'partner-0002' }), task('unowned', { dueAt: due })]
    expect(dueNotices(tasks, on8th(15, 30), { myId: ME }).map(n => n.key)).toEqual(['mine', 'unowned'])
    expect(dueNotices(tasks, on8th(15, 30)).map(n => n.key)).toEqual(['mine', 'theirs', 'unowned'])
  })
})

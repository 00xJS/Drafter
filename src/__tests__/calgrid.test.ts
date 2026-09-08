import { describe, expect, it } from 'vitest'
import { dayItems, daySummary, eventsByDay, marksByDay, monthCells, occasionsByMonthDay, taskDayIso, tasksByDay, weekDays, weekLabel } from '../calgrid'
import { CalendarEvent, Person, Project, Task } from '../types'
import { dateKey } from '../utils'

function task(over: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id: 't1',
    title: 'Book the plumber',
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: '2026-09-09T14:30:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    tags: [],
    ...over,
  }
}

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    sourceId: 'src1',
    title: 'Standup',
    start: '2026-09-09T09:00:00.000Z',
    end: '2026-09-09T09:30:00.000Z',
    allDay: false,
    ...over,
  }
}

function project(over: Partial<Project> = {}): Project {
  return {
    kind: 'project',
    id: 'p1',
    name: 'Kitchen refresh',
    color: '#f97316',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function person(over: Partial<Person> = {}): Person {
  return {
    kind: 'person',
    id: 'mum',
    name: 'Mum',
    color: '#34d399',
    group: 'family',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

/** Local-midnight Date, so the tests read in the same zone the grid renders in. */
const day = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min)
const local = (y: number, m: number, d: number, h: number, min: number) => day(y, m, d, h, min).toISOString()

describe('week ranges', () => {
  it('starts the week on the Sunday before the given day', () => {
    const days = weekDays(day(2026, 9, 9)) // a Wednesday
    expect(days).toHaveLength(7)
    expect(dateKey(days[0])).toBe('2026-09-06')
    expect(dateKey(days[6])).toBe('2026-09-12')
  })

  it('keeps a Sunday in its own week', () => {
    expect(dateKey(weekDays(day(2026, 9, 6))[0])).toBe('2026-09-06')
  })

  it('crosses month and year boundaries', () => {
    const days = weekDays(day(2026, 12, 31))
    expect(dateKey(days[0])).toBe('2026-12-27')
    expect(dateKey(days[6])).toBe('2027-01-02')
  })

  it('labels a week, widening only when it spans a month or a year', () => {
    expect(weekLabel(day(2026, 9, 9), 'en-US')).toBe('Sep 6 – 12, 2026')
    expect(weekLabel(day(2026, 9, 30), 'en-US')).toBe('Sep 27 – Oct 3, 2026')
    expect(weekLabel(day(2026, 12, 31), 'en-US')).toBe('Dec 27, 2026 – Jan 2, 2027')
  })
})

describe('month grid', () => {
  it('pads a month out to whole Sunday-start weeks', () => {
    const cells = monthCells(day(2026, 9, 1)) // September 2026 starts on a Tuesday
    expect(cells.length % 7).toBe(0)
    expect(dateKey(cells[0])).toBe('2026-08-30')
    expect(dateKey(cells[cells.length - 1])).toBe('2026-10-03')
  })

  it('gives a month that starts on a Sunday no leading days', () => {
    expect(dateKey(monthCells(day(2026, 11, 1))[0])).toBe('2026-11-01')
  })
})

describe('bucketing by day', () => {
  it('files a task under its due date, and a done task under the day it was finished', () => {
    const open = task({ id: 'a', dueAt: local(2026, 9, 9, 14, 30) })
    const done = task({ id: 'b', status: 'done', dueAt: local(2026, 9, 9, 14, 30), completedAt: local(2026, 9, 11, 8, 0) })
    const map = tasksByDay([open, done])
    expect(map.get('2026-09-09')?.map(t => t.id)).toEqual(['a'])
    expect(map.get('2026-09-11')?.map(t => t.id)).toEqual(['b'])
  })

  it('leaves canceled tasks off the calendar', () => {
    expect(taskDayIso(task({ status: 'canceled' }))).toBeUndefined()
    expect(tasksByDay([task({ status: 'canceled' })]).size).toBe(0)
  })

  it('spreads a multi-day all-day event across every day it covers', () => {
    const map = eventsByDay([event({ id: 'trip', allDay: true, start: '2026-09-10', end: '2026-09-13' })])
    expect([...map.keys()].sort()).toEqual(['2026-09-10', '2026-09-11', '2026-09-12'])
  })

  it('sorts a day all-day first, then by start time', () => {
    const map = eventsByDay([
      event({ id: 'late', start: local(2026, 9, 9, 17, 0), end: local(2026, 9, 9, 18, 0) }),
      event({ id: 'early', start: local(2026, 9, 9, 9, 0), end: local(2026, 9, 9, 9, 30) }),
      event({ id: 'allday', allDay: true, start: '2026-09-09', end: '2026-09-10' }),
    ])
    expect(map.get('2026-09-09')?.map(e => e.id)).toEqual(['allday', 'early', 'late'])
  })

  it('files project targets and dated milestones, and skips archived projects', () => {
    const map = marksByDay([
      project({ targetAt: local(2026, 9, 20, 0, 0), milestones: [{ id: 'm1', name: 'Cabinets in', dueAt: local(2026, 9, 12, 0, 0) }, { id: 'm2', name: 'No date' }] }),
      project({ id: 'p2', name: 'Old', status: 'archived', targetAt: local(2026, 9, 20, 0, 0) }),
    ])
    expect(map.get('2026-09-20')?.map(m => m.label)).toEqual(['Kitchen refresh target'])
    expect(map.get('2026-09-12')?.map(m => m.kind)).toEqual(['milestone'])
    expect([...map.keys()].sort()).toEqual(['2026-09-12', '2026-09-20'])
  })

  it('keys occasions by month and day so they repeat every year', () => {
    const map = occasionsByMonthDay([person({ birthday: '1984-09-11', anniversary: '0000-09-11' })])
    expect(map.get('09-11')?.map(o => o.kind).sort()).toEqual(['anniversary', 'birthday'])
    expect(map.get('09-11')?.find(o => o.kind === 'birthday')?.year).toBe(1984)
    // a 0000 year means the date was recorded without one: no age to show
    expect(map.get('09-11')?.find(o => o.kind === 'anniversary')?.year).toBeUndefined()
  })
})

describe('a day, gathered', () => {
  const sources = {
    tasks: tasksByDay([
      task({ id: 'chore', dueAt: local(2026, 9, 11, 16, 0) }),
      task({ id: 'someday', title: 'Sort the shed', dueAt: local(2026, 9, 11, 0, 0) }),
    ]),
    events: eventsByDay([
      event({ id: 'dentist', start: local(2026, 9, 11, 11, 0), end: local(2026, 9, 11, 12, 0) }),
      event({ id: 'holiday', allDay: true, start: '2026-09-11', end: '2026-09-12' }),
    ]),
    marks: marksByDay([project({ targetAt: local(2026, 9, 11, 0, 0) })]),
    occasions: occasionsByMonthDay([person({ birthday: '1984-09-11' })]),
  }

  it('reads top to bottom: occasions, all-day, timed, tasks, project dates', () => {
    const items = dayItems(day(2026, 9, 11), sources)
    expect(items.map(i => i.id)).toEqual(['occ-mum-birthday', 'ev-holiday', 'ev-dentist', 'task-chore', 'task-someday', 'mark-p1-target'])
  })

  it('works out the age from the day it lands on', () => {
    const items = dayItems(day(2026, 9, 11), sources)
    expect(items[0].kind === 'occasion' && items[0].occasion.years).toBe(42)
  })

  it('holds nothing on an empty day', () => {
    expect(dayItems(day(2026, 9, 14), sources)).toEqual([])
  })

  it('counts a day for its header', () => {
    expect(daySummary(dayItems(day(2026, 9, 11), sources))).toBe('2 events · 2 tasks · 1 occasion · 1 project date')
    expect(daySummary(dayItems(day(2026, 9, 14), sources))).toBe('Nothing planned')
  })
})

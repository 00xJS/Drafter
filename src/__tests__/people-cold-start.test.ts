import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NEVER_NUDGES, neverInTurn, peopleToNudge, personStats, type PersonStats } from '../people'
import { Today } from '../components/Today'
import { makeSnooze } from '../snooze'
import type { Person, Task } from '../types'
import { button, elements, settled, textOf } from './rendered'

// Thirty-four people on the list, thirty of them never logged, and Today asked
// after none of them. It took `due` and `overdue` only, and seenStatus gives
// someone with no visit `never` — so a person had to have been logged once
// before Today would ever suggest logging them. The prompt that would have
// started it only appeared once it had started.

const T = (iso: string) => new Date(iso)
const NOW = T('2026-09-17T12:00:00.000Z')

const person = (id: string, name: string, added: string, cadenceDays?: number, over: Partial<Person> = {}): Person => ({
  kind: 'person',
  id,
  name,
  group: 'family',
  color: '#888888',
  cadenceDays,
  createdAt: added,
  updatedAt: added,
  ...over,
})

/** A completed task with someone on it is how the app counts seeing them. */
const saw = (id: string, personId: string, at: string): Task =>
  ({
    kind: 'task',
    id,
    title: 'Saw them',
    status: 'done',
    priority: 'normal',
    peopleIds: [personId],
    completedAt: at,
    createdAt: at,
    updatedAt: at,
  }) as Task

const statsFor = (people: Person[], tasks: Task[]) => people.map(p => personStats(p, tasks, NOW))
const ids = (list: PersonStats[]) => list.map(s => s.person.id)

describe('who Today asks after', () => {
  it('offers people nobody has logged, which is why thirty of them were unreachable', () => {
    const people = [person('mum', 'Mum', '2026-01-01'), person('dad', 'Dad', '2026-01-02')]
    const nudges = peopleToNudge(statsFor(people, []))
    expect(ids(nudges)).toEqual(['mum', 'dad'])
    expect(nudges.every(s => s.status === 'never')).toBe(true)
  })

  it('puts the drifting first, and the never-logged under them', () => {
    const people = [
      person('never', 'Never', '2026-01-01'),
      person('drifting', 'Drifting', '2026-02-01', 50),
      person('gone', 'Long gone', '2026-03-01', 10),
    ]
    // 60 days since each: past a 50-day rhythm is due, past 10 by six times is overdue
    const tasks = [saw('t1', 'drifting', '2026-07-19T12:00:00.000Z'), saw('t2', 'gone', '2026-07-19T12:00:00.000Z')]
    expect(peopleToNudge(statsFor(people, tasks), { todayKey: '2026-09-17' }).map(s => [s.person.id, s.status])).toEqual([
      ['gone', 'overdue'],
      ['drifting', 'due'],
      ['never', 'never'],
    ])
  })

  it('offers at most two of the never-logged a day, so the morning page is not a backlog', () => {
    const many = Array.from({ length: 30 }, (_, i) => person(`p${i}`, `P${i}`, `2026-0${(i % 9) + 1}-01`))
    for (const day of ['2026-09-17', '2026-09-18', '2026-12-31']) {
      const nudges = peopleToNudge(statsFor(many, []), { todayKey: day })
      expect(nudges).toHaveLength(NEVER_NUDGES)
      expect(NEVER_NUDGES).toBe(2)
    }
  })

  it('without a day, starts at the ones that have sat on the list longest', () => {
    const people = [person('newest', 'Newest', '2026-09-01'), person('oldest', 'Oldest', '2026-01-01'), person('middle', 'Middle', '2026-05-01')]
    expect(ids(peopleToNudge(statsFor(people, [])))).toEqual(['oldest', 'middle'])
  })

  it('never crowds out the drifting: the cap is on the whole list', () => {
    const drifting = Array.from({ length: 6 }, (_, i) => person(`d${i}`, `D${i}`, '2026-01-01', 10))
    const tasks = drifting.map((p, i) => saw(`t${i}`, p.id, '2026-07-19T12:00:00.000Z'))
    const stats = statsFor([...drifting, person('never', 'Never', '2026-01-01')], tasks)
    const nudges = peopleToNudge(stats, { todayKey: '2026-09-17' })
    expect(nudges).toHaveLength(6)
    expect(nudges.some(s => s.status === 'never')).toBe(false)
  })

  it('leaves out anyone on track, logged or not', () => {
    const people = [person('seen', 'Seen', '2026-01-01', 30)]
    const recent = statsFor(people, [saw('t', 'seen', '2026-09-15T12:00:00.000Z')])
    expect(recent[0].status).toBe('ok')
    expect(peopleToNudge(recent, { todayKey: '2026-09-17' })).toEqual([])
  })
})

describe('the never-logged take turns, a new two each day', () => {
  // five on the list, added a month apart: A is the oldest
  const five = ['a', 'b', 'c', 'd', 'e'].map((id, i) => person(id, id.toUpperCase(), `2026-0${i + 1}-01`))
  const on = (day: string, opts: Parameters<typeof peopleToNudge>[1] = {}) => ids(peopleToNudge(statsFor(five, []), { todayKey: day, ...opts }))

  it('is the same two all day, on every device, and two others tomorrow', () => {
    expect(on('2026-09-17')).toEqual(on('2026-09-17'))
    // added in a different order, the turn is the same: it goes by when each joined the list
    expect(ids(peopleToNudge(statsFor([...five].reverse(), []), { todayKey: '2026-09-17' }))).toEqual(on('2026-09-17'))
    expect(on('2026-09-18')).not.toEqual(on('2026-09-17'))
    expect(on('2026-09-18').some(id => on('2026-09-17').includes(id))).toBe(false)
  })

  it('comes round to everyone within ceil(n / 2) days, and then again in the same order', () => {
    const days = ['2026-09-17', '2026-09-18', '2026-09-19']
    expect(new Set(days.flatMap(d => on(d)))).toEqual(new Set(['a', 'b', 'c', 'd', 'e']))
    // the turn keeps its order: the start moves two along each day
    const order = ids(neverInTurn(statsFor(five, []), '2026-09-17'))
    const next = ids(neverInTurn(statsFor(five, []), '2026-09-18'))
    expect(next).toEqual([...order.slice(2), ...order.slice(0, 2)])
  })

  it('moves on by itself as well: Saw them on one of today’s keeps the other and brings the next in turn up', () => {
    const turn = ids(neverInTurn(statsFor(five, []), '2026-09-17'))
    expect(on('2026-09-17')).toEqual(turn.slice(0, 2))
    // logged this morning: the turn is still over everyone never-logged when the day began
    const logged = statsFor(five, [saw('t', turn[0], '2026-09-17T11:00:00.000Z')])
    expect(ids(peopleToNudge(logged, { todayKey: '2026-09-17' }))).toEqual([turn[1], turn[2]])
  })

  it('an × on one of today’s two brings the next in turn, and the other stays', () => {
    const [first, second] = on('2026-09-17')
    const turn = ids(neverInTurn(statsFor(five, []), '2026-09-17'))
    const after = on('2026-09-17', { putOff: new Set([first]) })
    expect(after).toEqual([second, turn[2]])
    expect(after).not.toContain(first)
  })

  it('an × keeps a drifting person off too, while the never-logged still get their two', () => {
    const drifting = person('gran', 'Gran', '2026-01-01', 10)
    const stats = statsFor([drifting, ...five], [saw('t', 'gran', '2026-07-19T12:00:00.000Z')])
    expect(ids(peopleToNudge(stats, { todayKey: '2026-09-17' }))[0]).toBe('gran')
    const putOff = ids(peopleToNudge(stats, { todayKey: '2026-09-17', putOff: new Set(['gran']) }))
    expect(putOff).not.toContain('gran')
    expect(putOff).toHaveLength(2)
  })

  it('never offers someone on No reminders, logged or not, drifting or not', () => {
    const quiet = [
      person('colleague', 'Colleague', '2025-01-01', undefined, { noReminders: true }),
      person('ex', 'Ex', '2025-01-01', undefined, { noReminders: true }),
    ]
    // one of them long overdue on the old 90 days, and neither would otherwise take a turn first
    const stats = statsFor([...quiet, ...five], [saw('t', 'ex', '2025-06-01T12:00:00.000Z')])
    expect(stats.slice(0, 2).map(s => s.status)).toEqual(['off', 'off'])
    for (const day of ['2026-09-17', '2026-09-18', '2026-09-19']) {
      const shown = ids(peopleToNudge(stats, { todayKey: day }))
      expect(shown).not.toContain('colleague')
      expect(shown).not.toContain('ex')
      expect(shown).toHaveLength(2)
    }
  })
})

describe('Today’s People card with the cold start', () => {
  const noop = () => {}
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    // the journal card asks the viewport how wide it is; a static render has none
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const bins: Task = { kind: 'task', id: 'bins', title: 'Put the bins out', description: '', status: 'todo', priority: 'normal', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', tags: [] }
  const props = (over: Partial<ComponentProps<typeof Today>> = {}): ComponentProps<typeof Today> => ({
    tasks: [bins],
    people: [],
    places: [],
    reviews: [],
    onPlanWith: noop,
    onWentTo: noop,
    onPlanAt: noop,
    onPlanOccasion: noop,
    onSaw: noop,
    onSaveReview: noop,
    projects: [],
    events: [],
    sourceMap: new Map(),
    onPlan: noop,
    onOpen: noop,
    onStatus: noop,
    onDefer: noop,
    onDeferAll: noop,
    onNew: noop,
    meals: [],
    recipes: [],
    onOpenKitchen: noop,
    onOpenReview: noop,
    onCookRecipe: noop,
    journal: [],
    onSaveJournal: noop,
    onDeleteJournal: noop,
    onOpenJournal: noop,
    habits: [],
    onSaveHabit: noop,
    onDeleteHabit: noop,
    routines: [],
    onSaveRoutine: noop,
    onDeleteRoutine: noop,
    ...over,
  })
  const card = (over: Partial<ComponentProps<typeof Today>>) => {
    const html = renderToStaticMarkup(createElement(Today, props(over)))
    const from = html.indexOf('class="chart-card people-nudges"')
    return from < 0 ? '' : html.slice(from, html.indexOf('</section>', from))
  }
  const five = ['a', 'b', 'c', 'd', 'e'].map((id, i) => person(id, `Person ${id.toUpperCase()}`, `2026-0${i + 1}-01`))

  it('shows today’s two never-logged, how many are waiting, and Set up rhythms', () => {
    const turn = neverInTurn(statsFor(five, []), '2026-09-17').slice(0, 2)
    const html = card({ people: five, onSetUpRhythms: noop })
    for (const s of turn) expect(html).toContain(s.person.name)
    expect(html.match(/No visits yet/g)).toHaveLength(2)
    expect(html).toContain('5 people have no visit logged yet; 2 a day come up here.')
    expect(html).toContain('Set up rhythms')
  })

  it('Set up rhythms opens the sheet', () => {
    const open = vi.fn()
    const tree = settled(Today, props({ people: five, onSetUpRhythms: open }))
    ;(button(tree, 'Set up rhythms').props.onClick as () => void)()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('an × on one of them brings the next in turn on Today too', () => {
    const turn = neverInTurn(statsFor(five, []), '2026-09-17')
    const snoozes = [makeSnooze('person', turn[0].person.id, '2026-10-17T12:00:00.000Z', NOW)]
    const html = card({ people: five, snoozes, onSnooze: noop, onSetUpRhythms: noop })
    expect(html).not.toContain(turn[0].person.name)
    expect(html).toContain(turn[1].person.name)
    expect(html).toContain(turn[2].person.name)
  })

  it('has no Set up rhythms when nobody is waiting, and never shows someone on No reminders', () => {
    const quiet = five.map(p => ({ ...p, noReminders: true }))
    expect(card({ people: quiet, onSetUpRhythms: noop })).toBe('')
    const tree = settled(Today, props({ people: quiet, onSetUpRhythms: noop }))
    expect(elements(tree).some(e => e.type === 'button' && textOf(e.props.children).trim() === 'Set up rhythms')).toBe(false)
  })
})

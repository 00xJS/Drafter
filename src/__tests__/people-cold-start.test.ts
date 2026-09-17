import { describe, expect, it } from 'vitest'
import { NEVER_NUDGES, peopleToNudge, personStats } from '../people'
import type { Person, Task } from '../types'

// Thirty-four people on the list, thirty of them never logged, and Today asked
// after none of them. It took `due` and `overdue` only, and seenStatus gives
// someone with no visit `never` — so a person had to have been logged once
// before Today would ever suggest logging them. The prompt that would have
// started it only appeared once it had started.

const T = (iso: string) => new Date(iso)
const NOW = T('2026-09-17T12:00:00.000Z')

const person = (id: string, name: string, added: string, cadenceDays?: number): Person => ({
  kind: 'person',
  id,
  name,
  group: 'family',
  color: '#888888',
  cadenceDays,
  createdAt: added,
  updatedAt: added,
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

describe('who Today asks after', () => {
  it('offers people nobody has logged, which is why thirty of them were unreachable', () => {
    const people = [person('mum', 'Mum', '2026-01-01'), person('dad', 'Dad', '2026-01-02')]
    const nudges = peopleToNudge(statsFor(people, []))
    expect(nudges.map(s => s.person.id)).toEqual(['mum', 'dad'])
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
    expect(peopleToNudge(statsFor(people, tasks)).map(s => [s.person.id, s.status])).toEqual([
      ['gone', 'overdue'],
      ['drifting', 'due'],
      ['never', 'never'],
    ])
  })

  it('offers only a couple of the never-logged, so the morning page is not a backlog', () => {
    const many = Array.from({ length: 30 }, (_, i) => person(`p${i}`, `P${i}`, `2026-0${(i % 9) + 1}-01`))
    const nudges = peopleToNudge(statsFor(many, []))
    expect(nudges).toHaveLength(NEVER_NUDGES)
  })

  it('takes the ones that have sat on the list longest', () => {
    const people = [
      person('newest', 'Newest', '2026-09-01'),
      person('oldest', 'Oldest', '2026-01-01'),
      person('middle', 'Middle', '2026-05-01'),
    ]
    expect(peopleToNudge(statsFor(people, [])).map(s => s.person.id)).toEqual(['oldest', 'middle'])
  })

  it('moves on by itself: logging one brings the next up, with nothing to rotate', () => {
    const people = [person('a', 'A', '2026-01-01'), person('b', 'B', '2026-02-01'), person('c', 'C', '2026-03-01')]
    expect(peopleToNudge(statsFor(people, [])).map(s => s.person.id)).toEqual(['a', 'b'])
    // A is logged today, so A is on track and drops out; C comes up behind B
    const after = peopleToNudge(statsFor(people, [saw('t', 'a', '2026-09-17T09:00:00.000Z')]))
    expect(after.map(s => s.person.id)).toEqual(['b', 'c'])
  })

  it('never crowds out the drifting: the cap is on the whole list', () => {
    const drifting = Array.from({ length: 6 }, (_, i) => person(`d${i}`, `D${i}`, '2026-01-01', 10))
    const tasks = drifting.map((p, i) => saw(`t${i}`, p.id, '2026-07-19T12:00:00.000Z'))
    const stats = statsFor([...drifting, person('never', 'Never', '2026-01-01')], tasks)
    const nudges = peopleToNudge(stats)
    expect(nudges).toHaveLength(6)
    expect(nudges.some(s => s.status === 'never')).toBe(false)
  })

  it('leaves out anyone on track, logged or not', () => {
    const people = [person('seen', 'Seen', '2026-01-01', 30)]
    const recent = statsFor(people, [saw('t', 'seen', '2026-09-15T12:00:00.000Z')])
    expect(recent[0].status).toBe('ok')
    expect(peopleToNudge(recent)).toEqual([])
  })
})

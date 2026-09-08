import { describe, expect, it } from 'vitest'
import { deterministicCapture } from '../ai'
import { dueLabel, dueTone, duplicateTask } from '../taskutils'
import { plannedGift, personStats } from '../people'
import { nextUp } from '../review'
import { plannedVisit } from '../../shared/people.mjs'
import { Person, Task } from '../types'

const baseTask = (partial: Partial<Task> & { id: string }): Task => ({
  kind: 'task',
  title: partial.title ?? partial.id,
  description: '',
  status: 'todo',
  priority: 'normal',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  tags: [],
  ...partial,
})

describe('dueTone late', () => {
  it('marks a same-day past time as late, not overdue', () => {
    const now = new Date('2026-09-07T17:00:00')
    const t = baseTask({ id: 'a', dueAt: new Date(2026, 8, 7, 15, 0, 0).toISOString() })
    expect(dueTone(t, now)).toBe('late')
    expect(dueLabel(t, now)).toMatch(/^Was/)
  })
})

describe('duplicateTask', () => {
  it('copies fields with a new id, unchecked checklist, and no comments/completion', () => {
    const source = baseTask({
      id: 'src',
      title: 'Paint fence',
      description: 'Back garden',
      status: 'done',
      priority: 'high',
      projectId: 'p1',
      dueAt: '2026-09-10T12:00:00.000Z',
      completedAt: '2026-09-07T12:00:00.000Z',
      tags: ['home'],
      notes: 'buy paint',
      checklist: [
        { id: 'c1', text: 'Sand', done: true },
        { id: 'c2', text: 'Prime', done: false },
      ],
      comments: [{ id: 'm1', body: 'started', createdAt: '2026-09-01T00:00:00.000Z' }],
      peopleIds: ['person-1'],
      placeId: 'place-1',
      actualCost: 40,
    })
    const copy = duplicateTask(source)
    expect(copy.id).not.toBe(source.id)
    expect(copy.title).toBe('Paint fence')
    expect(copy.status).toBe('todo')
    expect(copy.completedAt).toBeUndefined()
    expect(copy.comments).toBeUndefined()
    expect(copy.actualCost).toBeUndefined()
    expect(copy.checklist).toEqual([
      { id: expect.any(String), text: 'Sand', done: false },
      { id: expect.any(String), text: 'Prime', done: false },
    ])
    expect(copy.checklist![0].id).not.toBe('c1')
    expect(copy.peopleIds).toEqual(['person-1'])
    expect(copy.placeId).toBe('place-1')
    expect(copy.createdAt).not.toBe(source.createdAt)
  })
})

describe('nextUp late reason', () => {
  it('scores a missed same-day time between overdue and due-today', () => {
    const now = new Date('2026-09-07T17:00:00.000Z')
    const late = baseTask({ id: 'late', dueAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(), createdAt: '2026-09-01T00:00:00.000Z' })
    const undated = baseTask({ id: 'undated', createdAt: '2026-06-01T00:00:00.000Z' })
    const ranked = nextUp([undated, late], [], 6, now)
    expect(ranked[0].task.id).toBe('late')
    expect(ranked[0].reason).toMatch(/due \d+h ago/)
  })

  it('pins Top 3 titles to the head', () => {
    const now = new Date('2026-09-07T12:00:00.000Z')
    const pinned = baseTask({ id: 'pin', title: 'Finish taxes', createdAt: '2026-08-01T00:00:00.000Z' })
    const urgent = baseTask({ id: 'u', title: 'Other', dueAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' })
    expect(nextUp([urgent, pinned], [], 6, now, ['Finish taxes'])[0].reason).toBe('your top 3')
  })
})

describe('deterministicCapture', () => {
  it('parses tomorrow and a time offline', () => {
    const now = new Date('2026-09-07T10:00:00')
    const c = deterministicCapture('dentist tomorrow 3pm', now)
    expect(c?.title.toLowerCase()).toContain('dentist')
    expect(c?.dueAt).toBeTruthy()
    const due = new Date(c!.dueAt!)
    expect(due.getDate()).toBe(8)
    expect(due.getHours()).toBe(15)
  })
})

describe('planned visit suppression', () => {
  const person: Person = {
    kind: 'person',
    id: 'p1',
    name: 'Sam',
    color: '#fff',
    group: 'friends',
    cadenceDays: 14,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  it('exposes planned open visit tasks on personStats', () => {
    const plan = baseTask({
      id: 'v',
      status: 'todo',
      tags: ['visit'],
      peopleIds: ['p1'],
      dueAt: '2026-09-14T09:00:00.000Z',
    })
    const stats = personStats(person, [plan], new Date('2026-09-07T12:00:00.000Z'))
    expect(stats.planned?.id).toBe('v')
    expect(plannedVisit('p1', [plan])?.id).toBe('v')
  })

  it('finds a planned gift near an occasion', () => {
    const at = new Date(2026, 8, 20)
    const gift = baseTask({
      id: 'g',
      status: 'todo',
      tags: ['gift', 'birthday'],
      peopleIds: ['p1'],
      dueAt: new Date(2026, 8, 15, 9, 0, 0).toISOString(),
    })
    expect(plannedGift('p1', 'birthday', at, [gift])?.id).toBe('g')
  })
})

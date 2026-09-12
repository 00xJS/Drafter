import { describe, expect, it } from 'vitest'
import { defaultReviewAnchor, nextUp, weekRange } from '../review'
import type { Task } from '../types'

describe('weekRange', () => {
  it('runs Sunday through Saturday', () => {
    const sunday = new Date(2026, 8, 6, 12, 0, 0)
    expect(sunday.getDay()).toBe(0)
    const r = weekRange(sunday)
    expect(r.start.getDay()).toBe(0)
    expect(r.end.getTime() - r.start.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
    expect(r.start.getDate()).toBe(6)
    expect(r.end.getDate()).toBe(13)
  })
})

describe('defaultReviewAnchor', () => {
  it('anchors to the previous week on Sunday', () => {
    const sunday = new Date(2026, 8, 6, 15, 0, 0)
    expect(sunday.getDay()).toBe(0)
    const anchor = defaultReviewAnchor(sunday)
    const range = weekRange(anchor)
    expect(range.start.getDate()).toBe(30)
    expect(range.end.getDate()).toBe(6)
    expect(range.start.getMonth()).toBe(7)
  })

  it('anchors to the previous week when less than one day of the range has elapsed', () => {
    const sundayMorning = new Date(2026, 8, 6, 6, 0, 0)
    const anchor = defaultReviewAnchor(sundayMorning)
    expect(weekRange(anchor).start.getDate()).toBe(30)
  })

  it('uses today mid-week', () => {
    const wednesday = new Date(2026, 8, 9, 12, 0, 0)
    expect(wednesday.getDay()).toBe(3)
    expect(defaultReviewAnchor(wednesday).getDate()).toBe(9)
  })
})

describe('nextUp with exclude', () => {
  // today's focus has a card of its own, so Next up leaves those tasks out
  const now = new Date('2026-09-11T12:00:00.000Z')
  const task = (id: string, over: Partial<Task> = {}): Task => ({
    kind: 'task',
    id,
    title: id,
    description: '',
    status: 'todo',
    priority: 'normal',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    tags: [],
    ...over,
  })
  const tasks = [
    task('late', { dueAt: '2026-09-05T09:00:00.000Z' }),
    task('soon', { dueAt: '2026-09-13T09:00:00.000Z' }),
    task('undated'),
    task('urgent', { priority: 'urgent' }),
    task('doing', { status: 'doing' }),
  ]

  it('leaves excluded tasks out and ranks the rest exactly as before', () => {
    const all = nextUp(tasks, [], 6, now).map(n => n.task.id)
    expect(all[0]).toBe('late')
    expect(nextUp(tasks, [], 6, now, [], new Set(['late'])).map(n => n.task.id)).toEqual(all.filter(id => id !== 'late'))
  })

  it('fills the limit from what is left', () => {
    const all = nextUp(tasks, [], 6, now).map(n => n.task.id)
    expect(nextUp(tasks, [], 2, now, [], new Set(['late', 'soon'])).map(n => n.task.id)).toEqual(all.filter(id => id !== 'late' && id !== 'soon').slice(0, 2))
  })

  it('excludes nothing by default', () => {
    expect(nextUp(tasks, [], 6, now)).toHaveLength(5)
    expect(nextUp(tasks, [], 6, now, [], new Set())).toEqual(nextUp(tasks, [], 6, now))
  })
})

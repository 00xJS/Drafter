import { describe, expect, it } from 'vitest'
import { nextUp } from '../review'
import { Project, Task } from '../types'

// With one home project a project no longer ranks or explains a task: every
// undated task used to read "project is moving", because LIFE always was.

const NOW = new Date('2026-09-13T12:00:00Z')
const DAY = 86_400_000
const STAMP = '2026-01-01T00:00:00.000Z'
const life: Project = { kind: 'project', id: 'life', name: 'LIFE', color: '#6c8cff', status: 'active', createdAt: STAMP, updatedAt: NOW.toISOString() }
const task = (id: string, idleDays: number, over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id,
  title: id,
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  projectId: 'life',
  createdAt: STAMP,
  updatedAt: new Date(NOW.getTime() - idleDays * DAY).toISOString(),
  ...over,
})

describe('next up with one home project', () => {
  it('never says "project is moving", and says how long an undated task has sat', () => {
    const up = nextUp([task('fresh', 2), task('old', 30)], [life], 6, NOW)
    expect(up.map(u => [u.task.id, u.reason])).toEqual([
      ['old', 'untouched 30d'],
      ['fresh', 'no date yet'],
    ])
  })

  it('ranks a task in LIFE no higher than an unfiled one', () => {
    // the unfiled task comes first and stays first: nothing lifts the filed one past it
    const up = nextUp([task('unfiled', 5, { projectId: undefined }), task('filed', 5)], [life], 6, NOW)
    expect(up.map(u => u.task.id)).toEqual(['unfiled', 'filed'])
  })
})

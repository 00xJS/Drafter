import { describe, expect, it } from 'vitest'
import { projectsForToday } from '../components/Today'
import type { Project, Task } from '../types'

// Today used to show every active project as a progress card — including the
// one ongoing home project, whose "% done" never means anything. Only a
// project with an end, a target date, gets a card now.

const stamp = '2026-09-01T00:00:00.000Z'
const project = (over: Partial<Project>): Project =>
  ({ kind: 'project', id: 'p', name: 'P', color: '#888', status: 'active', createdAt: stamp, updatedAt: stamp, ...over }) as Project
let n = 0
const task = (projectId: string, status: Task['status']): Task =>
  ({ kind: 'task', id: `t${n++}`, title: 't', description: '', status, priority: 'normal', tags: [], projectId, createdAt: stamp, updatedAt: stamp }) as Task

describe('projectsForToday', () => {
  it('leaves out an active project with no target date — the never-ending home project', () => {
    const home = project({ id: 'home', name: 'Home' })
    const trip = project({ id: 'trip', name: 'Trip', targetAt: '2026-10-01T00:00:00.000Z' })
    expect(projectsForToday([home, trip], []).map(p => p.project.name)).toEqual(['Trip'])
  })

  it('keeps a dated project with its progress', () => {
    const trip = project({ id: 'trip', name: 'Trip', targetAt: '2026-10-01T00:00:00.000Z' })
    const [card] = projectsForToday([trip], [task('trip', 'done'), task('trip', 'todo'), task('home', 'done')])
    expect(card.progress.done).toBe(1)
    expect(card.progress.total).toBe(2)
  })

  it('still skips paused, done and archived projects', () => {
    const dated = { targetAt: '2026-10-01T00:00:00.000Z' }
    const list = (['paused', 'done', 'archived'] as const).map(status => project({ id: status, name: status, status, ...dated }))
    expect(projectsForToday(list, [])).toEqual([])
  })
})

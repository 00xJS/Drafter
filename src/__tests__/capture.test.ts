import { describe, it, expect } from 'vitest'
import { buildCapturedTask, quickCaptureFields } from '../ai'

// The palette's Shift+Enter files a task from these two pure steps with no
// editor in between, so what they produce is exactly what lands in the store.
const now = new Date(2026, 8, 9, 10, 0, 0)
const lookup = {
  projects: [
    { id: 'p-kitchen', name: 'Kitchen' },
    { id: 'p-garden', name: 'Garden' },
  ],
  people: [
    { id: 'u-sam', name: 'Sam' },
    { id: 'u-ana', name: 'Ana Ruiz' },
  ],
}

describe('quickCaptureFields: the instant, offline read of a line', () => {
  it('reads a day and clock time and strips them from the title', () => {
    const f = quickCaptureFields('Call Sam tomorrow at 3pm', now)
    expect(f.title).toBe('Call Sam')
    const due = new Date(f.dueAt!)
    expect([due.getFullYear(), due.getMonth(), due.getDate(), due.getHours(), due.getMinutes()]).toEqual([2026, 8, 10, 15, 0])
  })

  it('returns only a trimmed title when there is no date to find', () => {
    expect(quickCaptureFields('  Fix the gate latch  ', now)).toEqual({ title: 'Fix the gate latch' })
  })

  it('keeps a title to 140 characters', () => {
    expect(quickCaptureFields('x'.repeat(200), now).title).toHaveLength(140)
  })
})

describe('buildCapturedTask: fields become a task the way the editor would apply them', () => {
  it('a bare title is an Inbox task: todo, normal, undated, unprojected', () => {
    const t = buildCapturedTask({ title: 'Fix the gate latch' }, lookup, { id: 't1', now })
    expect(t).toEqual({
      kind: 'task',
      id: 't1',
      title: 'Fix the gate latch',
      description: '',
      status: 'todo',
      priority: 'normal',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      tags: [],
    })
    // Today's Inbox rule, verbatim
    expect(!t.projectId && !t.dueAt && t.status === 'todo').toBe(true)
    expect('projectId' in t).toBe(false)
    expect('peopleIds' in t).toBe(false)
    expect('dueAt' in t).toBe(false)
  })

  it('matches a project by name regardless of case', () => {
    const t = buildCapturedTask({ title: 'Descale the kettle', projectName: 'kitchen' }, lookup, { id: 't2', now })
    expect(t.projectId).toBe('p-kitchen')
  })

  it('drops a project or person it does not know rather than guessing', () => {
    const t = buildCapturedTask({ title: 'Ring the plumber', projectName: 'Bathroom', peopleNames: ['Nobody'] }, lookup, { id: 't3', now })
    expect(t.projectId).toBeUndefined()
    expect(t.peopleIds).toBeUndefined()
  })

  it('maps people to ids and de-dupes them', () => {
    const t = buildCapturedTask({ title: 'Lunch', peopleNames: ['sam', 'Sam', 'ana ruiz'] }, lookup, { id: 't4', now })
    expect(t.peopleIds).toEqual(['u-sam', 'u-ana'])
  })

  it('carries the date, priority, lowercase tags and recurrence through', () => {
    const f = quickCaptureFields('Water the plants tomorrow at 8am', now)
    const t = buildCapturedTask({ ...f, priority: 'high', tags: [' Home ', 'home', ''], recurrence: 'weekly' }, lookup, { id: 't5', now })
    expect(t.title).toBe('Water the plants')
    expect(t.dueAt).toBe(f.dueAt)
    expect(t.priority).toBe('high')
    expect(t.tags).toEqual(['home'])
    expect(t.recurrence).toEqual({ freq: 'weekly' })
  })

  it('trims and truncates the title to 140', () => {
    const t = buildCapturedTask({ title: '  ' + 'y'.repeat(200) }, lookup, { id: 't6', now })
    expect(t.title).toHaveLength(140)
  })
})

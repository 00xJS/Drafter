import { describe, expect, it } from 'vitest'
import { mergeItems, nextOccurrence, purgeTombstones } from '../itemops'
import { Task } from '../types'

function task(id: string, updatedAt: string, over: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id,
    title: id,
    description: '',
    status: 'todo',
    priority: 'normal',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    tags: [],
    ...over,
  }
}

describe('mergeItems', () => {
  it('keeps the newer version of the same id', () => {
    const merged = mergeItems(
      [task('a', '2026-01-01T00:00:00.000Z', { title: 'old' })],
      [task('a', '2026-01-02T00:00:00.000Z', { title: 'new' }), task('b', '2026-01-01T00:00:00.000Z')],
    )
    expect(merged).toHaveLength(2)
    expect(merged.find(p => p.id === 'a')?.title).toBe('new')
  })

  it('a newer tombstone wins over an older live version', () => {
    const merged = mergeItems(
      [task('a', '2026-01-01T00:00:00.000Z')],
      [task('a', '2026-01-03T00:00:00.000Z', { deletedAt: '2026-01-03T00:00:00.000Z' })],
    )
    expect(merged[0].deletedAt).toBeDefined()
  })

  it('an older incoming copy never clobbers local edits', () => {
    const merged = mergeItems(
      [task('a', '2026-01-05T00:00:00.000Z', { title: 'edited locally' })],
      [task('a', '2026-01-01T00:00:00.000Z', { title: 'stale archive copy' })],
    )
    expect(merged[0].title).toBe('edited locally')
  })
})

describe('purgeTombstones', () => {
  it('drops only tombstones older than the TTL', () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z')
    const items = [
      task('live', '2026-01-01T00:00:00.000Z'),
      task('fresh-dead', '2026-05-30T00:00:00.000Z', { deletedAt: '2026-05-30T00:00:00.000Z' }),
      task('old-dead', '2026-01-01T00:00:00.000Z', { deletedAt: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(purgeTombstones(items, now).map(p => p.id)).toEqual(['live', 'fresh-dead'])
  })
})

describe('nextOccurrence', () => {
  const uid = () => 'new-id'

  it('spawns an open clone one period later with the checklist reset', () => {
    const src = task('a', '2026-01-01T00:00:00.000Z', {
      status: 'done',
      projectId: 'home',
      priority: 'high',
      completedAt: '2026-03-06T09:00:00.000Z',
      recurrence: { freq: 'weekly' },
      tags: ['chores'],
      checklist: [{ id: 'c', text: 'vacuum', done: true }],
      social: { platforms: ['x'], variants: { x: 'short' } },
    })
    const next = nextOccurrence(src, uid)
    expect(next).not.toBeNull()
    expect(next?.id).toBe('new-id')
    expect(next?.status).toBe('todo')
    expect(next?.projectId).toBe('home')
    expect(next?.priority).toBe('high')
    expect(next?.dueAt).toBe('2026-03-13T09:00:00.000Z')
    expect(next?.recurrence).toEqual({ freq: 'weekly' })
    expect(next?.tags).toEqual(['chores'])
    expect(next?.checklist).toEqual([{ id: 'c', text: 'vacuum', done: false }])
    expect(next?.social?.variants).toEqual({ x: 'short' })
    expect(next?.completedAt).toBeUndefined()
  })

  it('supports daily, biweekly and monthly', () => {
    const base = task('a', '2026-01-01T00:00:00.000Z', { status: 'done', completedAt: '2026-01-31T12:00:00.000Z' })
    expect(nextOccurrence({ ...base, recurrence: { freq: 'daily' } }, uid)?.dueAt).toBe('2026-02-01T12:00:00.000Z')
    expect(nextOccurrence({ ...base, recurrence: { freq: 'biweekly' } }, uid)?.dueAt).toBe('2026-02-14T12:00:00.000Z')
    expect(nextOccurrence({ ...base, recurrence: { freq: 'monthly' } }, uid)?.dueAt).toBe(
      '2026-03-03T12:00:00.000Z', // Jan 31 + 1 month rolls over (no Feb 31)
    )
  })

  it('returns null without recurrence', () => {
    expect(nextOccurrence(task('a', '2026-01-01T00:00:00.000Z'), uid)).toBeNull()
  })
})

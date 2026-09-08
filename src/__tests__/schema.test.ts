import { describe, expect, it } from 'vitest'
import { migrateStored, sanitizeItem, sanitizePlace, sanitizeProject, sanitizeTask } from '../schema'
import { Task } from '../types'

function valid(over: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id: 't1',
    title: 't',
    description: 'd',
    status: 'todo',
    priority: 'normal',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    tags: [],
    ...over,
  }
}

describe('sanitizeTask', () => {
  it('passes a valid task through', () => {
    const t = sanitizeTask(valid({ projectId: 'p1', dueAt: '2026-03-01T09:00:00.000Z' }))
    expect(t).toMatchObject({ id: 't1', status: 'todo', projectId: 'p1', dueAt: '2026-03-01T09:00:00.000Z' })
  })

  it('rejects garbage', () => {
    expect(sanitizeTask(null)).toBeNull()
    expect(sanitizeTask('nope')).toBeNull()
    expect(sanitizeTask({ title: 'no id' })).toBeNull()
  })

  it('defaults unknown status/priority and infers done from completedAt', () => {
    const t = sanitizeTask({ ...valid(), status: 'zombie', priority: 'meh', completedAt: '2026-02-01T10:00:00.000Z' })
    expect(t?.status).toBe('done')
    expect(t?.priority).toBe('normal')
  })

  it('drops completedAt when status is not done', () => {
    const t = sanitizeTask(valid({ status: 'doing', completedAt: '2026-02-01T10:00:00.000Z' }))
    expect(t?.completedAt).toBeUndefined()
  })

  it('cleans checklist, comments and drops invalid dates/recurrence', () => {
    const t = sanitizeTask({
      ...valid(),
      dueAt: 'not a date',
      recurrence: { freq: 'hourly' },
      checklist: [{ id: 'c1', text: ' step ', done: 'yes' }, { text: 'no id' }],
      comments: [
        { id: 'k2', body: 'later', createdAt: '2026-01-03T00:00:00.000Z' },
        { id: 'k1', body: 'first', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'k3', body: '', createdAt: '2026-01-02T00:00:00.000Z' },
      ],
    })
    expect(t?.dueAt).toBeUndefined()
    expect(t?.recurrence).toBeUndefined()
    expect(t?.checklist).toEqual([{ id: 'c1', text: 'step', done: false }])
    expect(t?.comments?.map(c => c.id)).toEqual(['k1', 'k2'])
  })

  it('coerces social metrics and keeps valid variants only', () => {
    const t = sanitizeTask(
      valid({
        social: {
          platforms: ['x', 'myspace' as 'x'],
          metrics: { x: { likes: '1,200' as unknown as number, shares: -5 } },
          variants: { x: 'short', myspace: 'nope', instagram: '   ' } as Task['social'] extends infer S ? (S extends { variants?: infer V } ? V : never) : never,
        },
      }),
    )
    expect(t?.social?.platforms).toEqual(['x'])
    expect(t?.social?.metrics?.x).toEqual({ likes: 1200 })
    expect(t?.social?.variants).toEqual({ x: 'short' })
  })
})

describe('sanitizeProject', () => {
  it('fills defaults and validates color/status', () => {
    const p = sanitizeProject({ kind: 'project', id: 'p1', name: '  Kitchen ', color: 'red', status: 'weird' })
    expect(p).toMatchObject({ id: 'p1', name: 'Kitchen', status: 'active' })
    expect(p?.color).toMatch(/^#/)
  })

  it('keeps milestones with names', () => {
    const p = sanitizeProject({ kind: 'project', id: 'p1', name: 'x', milestones: [{ id: 'm1', name: 'Demo', dueAt: '2026-05-01' }, { id: 'm2' }] })
    expect(p?.milestones).toHaveLength(1)
    expect(p?.milestones?.[0].dueAt).toBe('2026-05-01T00:00:00.000Z')
  })
})

describe('sanitizeItem (legacy posts)', () => {
  const legacy = {
    id: 'old1',
    title: 'Launch teaser',
    body: 'We are live!',
    platforms: ['x', 'instagram'],
    status: 'posted',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    scheduledFor: '2026-01-05T09:00:00.000Z',
    postedAt: '2026-01-05T09:03:00.000Z',
    tags: ['launch'],
    metrics: { x: { likes: 10 } },
    variants: { x: 'short' },
  }

  it('converts a pre-v3 post into a social task in the social project', () => {
    const t = sanitizeItem(legacy)
    expect(t?.kind).toBe('task')
    if (t?.kind !== 'task') return
    expect(t.status).toBe('done')
    expect(t.description).toBe('We are live!')
    expect(t.dueAt).toBe('2026-01-05T09:00:00.000Z')
    expect(t.completedAt).toBe('2026-01-05T09:03:00.000Z')
    expect(t.projectId).toBe('project-social')
    expect(t.social).toEqual({ platforms: ['x', 'instagram'], metrics: { x: { likes: 10 } }, variants: { x: 'short' } })
    expect(t.updatedAt).toBe('2026-01-02T00:00:00.000Z') // never bumped by a shape conversion
  })

  it('maps every legacy status', () => {
    const status = (s: string) => {
      const t = sanitizeItem({ ...legacy, status: s, postedAt: undefined })
      return t?.kind === 'task' ? t.status : null
    }
    expect(status('idea')).toBe('wishlist')
    expect(status('draft')).toBe('todo')
    expect(status('scheduled')).toBe('todo')
    expect(status('canceled')).toBe('canceled')
  })

  it('routes projects by kind', () => {
    expect(sanitizeItem({ kind: 'project', id: 'p1', name: 'X' })?.kind).toBe('project')
  })

  it('routes places and rejects unknown kinds', () => {
    expect(sanitizePlace({ kind: 'place', id: 'pl1', name: 'Nopi' })?.kind).toBe('place')
    expect(sanitizeItem({ kind: 'place', id: 'pl1', name: 'Nopi' })?.kind).toBe('place')
    expect(sanitizeItem({ kind: 'alien', id: 'a1', title: 'nope' })).toBeNull()
  })

  it('keeps placeId on sanitized tasks', () => {
    expect(sanitizeTask(valid({ placeId: 'pl1' }))?.placeId).toBe('pl1')
  })
})

describe('migrateStored', () => {
  it('accepts the v1 bare array', () => {
    expect(migrateStored([valid()])).toHaveLength(1)
  })

  it('accepts the v2 posts wrapper and the v3 items wrapper', () => {
    expect(migrateStored({ version: 2, posts: [valid(), { junk: true }] })).toHaveLength(1)
    expect(migrateStored({ version: 3, items: [valid(), { kind: 'project', id: 'p', name: 'P' }] })).toHaveLength(2)
  })

  it('rejects unknown shapes', () => {
    expect(migrateStored({ nope: 1 })).toBeNull()
    expect(migrateStored('x')).toBeNull()
  })
})

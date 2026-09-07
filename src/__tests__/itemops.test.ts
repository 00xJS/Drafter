import { describe, expect, it } from 'vitest'
import { applySync, mergeItems, nextOccurrence, purgeTombstones } from '../itemops'
import { nextUp } from '../review'
import { Project, Task } from '../types'

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

describe('applySync', () => {
  const T = '2026-09-10T10:00:00.000Z'

  it('merges onto CURRENT state, so an edit made during the request survives', () => {
    // the snapshot the request was built from
    const before = [task('a', '2026-09-10T09:00:00.000Z', { title: 'old' })]
    // …but by the time the response lands the user has edited it
    const current = [task('a', '2026-09-10T09:30:00.000Z', { title: 'edited while syncing' })]
    const remote = [task('b', T)]
    const d = applySync(current, before, remote, null)
    const kept = d.merged.find(i => i.id === 'a')
    expect(kept?.kind === 'task' && kept.title).toBe('edited while syncing')
    expect(d.merged.map(i => i.id).sort()).toEqual(['a', 'b'])
  })

  it('advances the cursor only over what the server actually returned', () => {
    // we optimistically sent a stamp far in the future; the server stored it as "now"
    const sent = [task('a', '2027-01-01T00:00:00.000Z')]
    const remote = [task('a', T)]
    const d = applySync([], sent, remote, null)
    // never jump to 2027 — rows written between now and then would be skipped forever
    expect(d.cursor).toBe(T)
  })

  it('holds the cursor below a change the server did not confirm, so it is retried', () => {
    const sent = [task('a', '2026-09-10T09:00:00.000Z'), task('rejected', '2026-09-10T09:05:00.000Z')]
    const remote = [task('a', '2026-09-10T09:00:00.000Z')] // 'rejected' never came back
    const d = applySync([], sent, remote, '2026-09-10T08:00:00.000Z')
    expect(d.unconfirmed).toEqual(['rejected'])
    expect(d.cursor! < '2026-09-10T09:05:00.000Z').toBe(true)
  })

  it('leaves the cursor alone when the server returned nothing', () => {
    expect(applySync([], [], [], '2026-09-10T08:00:00.000Z').cursor).toBeNull()
  })

  it('confirms a push that comes back at the same stamp', () => {
    const sent = [task('a', T)]
    const d = applySync([], sent, [task('a', T)], null)
    expect(d.unconfirmed).toEqual([])
    expect(d.cursor).toBe(T)
  })
})

describe('nextUp', () => {
  const proj = (id: string): Project => ({
    kind: 'project',
    id,
    name: id,
    color: '#fff',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })

  it('puts a just-created task first, ahead of older work', () => {
    const now = new Date('2026-09-11T12:00:00.000Z')
    const old = Array.from({ length: 8 }, (_, i) =>
      task(`old${i}`, '2026-08-01T00:00:00.000Z', { projectId: 'p', createdAt: '2026-08-01T00:00:00.000Z' }),
    )
    const fresh = task('fresh', '2026-09-11T11:59:00.000Z', { projectId: 'p', createdAt: '2026-09-11T11:59:00.000Z', title: 'Buy a tap washer' })
    const ranked = nextUp([...old, fresh], [proj('p')], 6, now)
    expect(ranked[0].task.id).toBe('fresh')
    expect(ranked[0].reason).toBe('just added')
  })

  it('still ranks overdue work above an older undated task', () => {
    const now = new Date('2026-09-11T12:00:00.000Z')
    const late = task('late', '2026-09-01T00:00:00.000Z', { dueAt: '2026-09-05T09:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' })
    const undated = task('undated', '2026-06-01T00:00:00.000Z', { createdAt: '2026-06-01T00:00:00.000Z' })
    expect(nextUp([undated, late], [], 6, now)[0].task.id).toBe('late')
  })
})

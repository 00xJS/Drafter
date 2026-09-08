import { describe, expect, it } from 'vitest'
import { applySync, mergeItems, nextOccurrence, purgeTombstones } from '../itemops'
import { nextUp } from '../review'
import { Place, Project, Recipe, Task } from '../types'

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

  it('last-write-wins a recipe the same way as a task (kitchen sync)', () => {
    const oldR: Recipe = {
      kind: 'recipe',
      id: 'pizza',
      name: 'Pizza',
      ingredients: [{ id: 'i', name: 'Flour' }],
      tags: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const newR: Recipe = { ...oldR, name: 'Friday pizza', updatedAt: '2026-01-02T00:00:00.000Z' }
    const merged = mergeItems([oldR], [newR])
    expect(merged).toHaveLength(1)
    expect(merged[0].kind).toBe('recipe')
    expect((merged[0] as Recipe).name).toBe('Friday pizza')
  })

  it('last-write-wins a place the same way as a task', () => {
    const oldP: Place = {
      kind: 'place',
      id: 'nopi',
      name: 'Nopi',
      color: '#f97316',
      category: 'restaurant',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const newP: Place = { ...oldP, name: 'Nopi Soho', notes: 'book ahead', updatedAt: '2026-01-02T00:00:00.000Z' }
    const merged = mergeItems([oldP], [newP])
    expect(merged).toHaveLength(1)
    expect(merged[0].kind).toBe('place')
    expect((merged[0] as Place).name).toBe('Nopi Soho')
    expect((merged[0] as Place).notes).toBe('book ahead')
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
    expect(next?.id).toBe('a~weekly~2026-03-13')
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

  it('copies peopleIds and placeId so recurring outings keep counting', () => {
    const src = task('a', '2026-01-01T00:00:00.000Z', {
      status: 'done',
      completedAt: '2026-03-06T09:00:00.000Z',
      recurrence: { freq: 'weekly' },
      peopleIds: ['mum'],
      placeId: 'franco',
    })
    const next = nextOccurrence(src, uid)
    expect(next?.peopleIds).toEqual(['mum'])
    expect(next?.placeId).toBe('franco')
  })

  it('two devices agree on the spawn id', () => {
    const src = task('chore', '2026-01-01T00:00:00.000Z', {
      status: 'done',
      completedAt: '2026-03-06T09:00:00.000Z',
      recurrence: { freq: 'weekly' },
    })
    expect(nextOccurrence(src, () => 'a')?.id).toBe(nextOccurrence(src, () => 'b')?.id)
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

  it('advances the cursor over syncedAt when present', () => {
    const remote = [{ ...task('a', '2026-09-10T09:00:00.000Z'), syncedAt: T }]
    const d = applySync([], [], remote, null)
    expect(d.cursor).toBe(T)
  })

  it('merges a stamp earlier than since when syncedAt is newer', () => {
    const early = task('late', '2026-09-10T09:58:00.000Z', { title: 'offline edit' })
    const d = applySync([], [], [{ ...early, syncedAt: '2026-09-10T10:05:00.000Z' }], '2026-09-10T10:00:00.000Z')
    expect((d.merged.find(i => i.id === 'late') as Task | undefined)?.title).toBe('offline edit')
    expect(d.cursor).toBe('2026-09-10T10:05:00.000Z')
  })

  it('does not clamp the cursor for rejected ids', () => {
    const sent = [task('a', '2026-09-10T09:00:00.000Z'), task('rejected', '2026-09-10T09:05:00.000Z')]
    const remote = [task('a', '2026-09-10T09:00:00.000Z')]
    const d = applySync([], sent, remote, '2026-09-10T08:00:00.000Z', ['rejected'])
    expect(d.rejected).toEqual(['rejected'])
    expect(d.unconfirmed).toEqual([])
    expect(d.cursor).toBe('2026-09-10T09:00:00.000Z')
  })

  it('lists unconfirmed when not rejected and not returned', () => {
    const sent = [task('a', '2026-09-10T09:00:00.000Z'), task('pending', '2026-09-10T09:05:00.000Z')]
    const remote = [task('a', '2026-09-10T09:00:00.000Z')]
    const d = applySync([], sent, remote, '2026-09-10T08:00:00.000Z')
    expect(d.unconfirmed).toEqual(['pending'])
  })

  it('leaves the cursor alone when the server returned nothing', () => {
    expect(applySync([], [], [], '2026-09-10T08:00:00.000Z').cursor).toBeNull()
  })

  it('on a full exchange drops local ghosts that were neither returned nor sent', () => {
    const ghost = task('peer', '2026-09-10T09:00:00.000Z', { title: 'partner chore' })
    const mine = task('a', '2026-09-10T09:00:00.000Z')
    const d = applySync([ghost, mine], [mine], [mine], null)
    expect(d.merged.map(i => i.id).sort()).toEqual(['a'])
  })

  // The board bounce-back: a column swap made while a round was in flight was
  // reported as confirmed (the server echoed the copy we sent, which was the
  // pre-swap one), so the caller dropped it from the dirty set and the new
  // status was never pushed — the old column came back on the next full pull.
  it('a status swap made during the request stays unconfirmed so it is pushed again', () => {
    const wasSent = task('x', '2026-09-10T09:00:00.000Z', { status: 'todo' })
    const echoed = [{ ...wasSent, syncedAt: '2026-09-10T09:00:02.000Z' }]
    const current = [task('x', '2026-09-10T09:00:01.000Z', { status: 'doing' })]
    const d = applySync(current, [wasSent], echoed, null)
    const kept = d.merged.find(i => i.id === 'x') as Task
    expect(kept.status).toBe('doing')
    expect(d.unconfirmed).toEqual(['x'])
  })

  it('keeps the swap dirty on a delta round too', () => {
    const wasSent = task('x', '2026-09-10T09:00:00.000Z', { status: 'todo' })
    const current = [task('x', '2026-09-10T09:00:01.000Z', { status: 'doing' })]
    const d = applySync(current, [wasSent], [wasSent], '2026-09-10T08:00:00.000Z')
    expect((d.merged.find(i => i.id === 'x') as Task).status).toBe('doing')
    expect(d.unconfirmed).toEqual(['x'])
  })

  it('does not discard a local copy that moved on after the sent version was rejected', () => {
    const wasSent = task('x', '2026-09-10T09:00:00.000Z', { status: 'todo' })
    const current = [task('x', '2026-09-10T09:00:01.000Z', { status: 'doing' })]
    const d = applySync(current, [wasSent], [wasSent], null, ['x'])
    expect((d.merged.find(i => i.id === 'x') as Task).status).toBe('doing')
    expect(d.rejected).toEqual([])
    expect(d.unconfirmed).toEqual(['x'])
  })

  it('still abandons a rejected write the user has not touched since', () => {
    const dead = task('x', '2026-09-10T09:00:00.000Z', { status: 'doing' })
    const d = applySync([dead], [dead], [task('x', '2026-09-10T08:00:00.000Z')], null, ['x'])
    expect(d.rejected).toEqual(['x'])
    expect(d.unconfirmed).toEqual([])
    expect((d.merged.find(i => i.id === 'x') as Task).status).toBe('todo')
  })

  it('keeps a rejected place that the server never stored so the next session can retry', () => {
    const placeRow = {
      kind: 'place' as const,
      id: 'nopi',
      name: 'Nopi',
      color: '#f97316',
      category: 'restaurant' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
    }
    const d = applySync([placeRow], [placeRow], [], null, ['nopi'])
    expect(d.merged.find(i => i.id === 'nopi')).toMatchObject({ kind: 'place', name: 'Nopi' })
    expect(d.rejected).toEqual(['nopi'])
  })

  it('keeps a rejected place even when it was not in this push', () => {
    const placeRow = {
      kind: 'place' as const,
      id: 'nopi',
      name: 'Nopi',
      color: '#f97316',
      category: 'restaurant' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
    }
    const d = applySync([placeRow], [], [], null, ['nopi'])
    expect(d.merged.find(i => i.id === 'nopi')).toMatchObject({ kind: 'place', name: 'Nopi' })
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

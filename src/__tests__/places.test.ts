import { describe, expect, it } from 'vitest'
import { sanitizeItem, sanitizePlace, sanitizeTask } from '../schema'
import { outingsAt, placeStats, placesWith } from '../places'
import { Person, Place, Task } from '../types'

function place(over: Partial<Place> = {}): Place {
  return {
    kind: 'place',
    id: 'pl1',
    name: "Franco's",
    color: '#f97316',
    category: 'restaurant',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function task(over: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id: 't1',
    title: 'Dinner',
    description: '',
    status: 'done',
    priority: 'normal',
    completedAt: '2026-03-01T12:00:00.000Z',
    createdAt: '2026-03-01T12:00:00.000Z',
    updatedAt: '2026-03-01T12:00:00.000Z',
    tags: ['visit'],
    placeId: 'pl1',
    ...over,
  }
}

function person(over: Partial<Person> = {}): Person {
  return {
    kind: 'person',
    id: 'mum',
    name: 'Mum',
    color: '#f472b6',
    group: 'family',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('sanitizePlace', () => {
  it('round-trips a place', () => {
    const p = sanitizePlace(place({ emoji: '🍝', notes: ' book the booth ' }))
    expect(p).toMatchObject({ kind: 'place', id: 'pl1', name: "Franco's", category: 'restaurant', emoji: '🍝', notes: 'book the booth' })
  })

  it('defaults unknown category and color', () => {
    const p = sanitizePlace({ kind: 'place', id: 'x', name: 'Park', category: 'spaceship', color: 'red' })
    expect(p?.category).toBe('other')
    expect(p?.color).toMatch(/^#/)
  })
})

describe('sanitizeItem places', () => {
  it('routes place kind', () => {
    expect(sanitizeItem(place())?.kind).toBe('place')
  })

  it('returns null for unknown kinds so stale clients cannot rewrite them as tasks', () => {
    expect(sanitizeItem({ kind: 'widget', id: 'w1', name: 'X', updatedAt: '2026-01-01T00:00:00.000Z' })).toBeNull()
  })

  it('keeps placeId on tasks', () => {
    const t = sanitizeTask(task({ placeId: 'pl9' }))
    expect(t?.placeId).toBe('pl9')
  })
})

describe('places insights', () => {
  const now = new Date('2026-03-15T12:00:00.000Z')

  it('outingsAt ignores open tasks and tombstones', () => {
    const tasks = [
      task({ id: 'a', completedAt: '2026-03-10T12:00:00.000Z' }),
      task({ id: 'b', status: 'todo', completedAt: undefined }),
      task({ id: 'c', completedAt: '2026-03-11T12:00:00.000Z', deletedAt: '2026-03-12T00:00:00.000Z' }),
      task({ id: 'd', placeId: 'other', completedAt: '2026-03-09T12:00:00.000Z' }),
    ]
    const visits = outingsAt('pl1', tasks)
    expect(visits.map(v => v.task.id)).toEqual(['a'])
  })

  it('orders newest first and counts companions', () => {
    const mum = person()
    const dad = person({ id: 'dad', name: 'Dad' })
    const tasks = [
      task({ id: 'a', completedAt: '2026-03-01T12:00:00.000Z', peopleIds: ['mum'] }),
      task({ id: 'b', completedAt: '2026-03-10T12:00:00.000Z', peopleIds: ['mum', 'dad'] }),
      task({ id: 'c', completedAt: '2026-02-01T12:00:00.000Z', peopleIds: ['mum'] }),
    ]
    const stats = placeStats(place(), tasks, [mum, dad], now)
    expect(stats.visits.map(v => v.task.id)).toEqual(['b', 'a', 'c'])
    expect(stats.companions.map(c => c.person.id)).toEqual(['mum', 'dad'])
    expect(stats.companions[0].count).toBe(3)
    expect(stats.count365).toBe(3)
  })

  it('placesWith groups a person visits by place', () => {
    const nopi = place({ id: 'nopi', name: 'Nopi' })
    const tasks = [
      task({ id: 'a', placeId: 'pl1', peopleIds: ['mum'], completedAt: '2026-03-01T12:00:00.000Z' }),
      task({ id: 'b', placeId: 'nopi', peopleIds: ['mum'], completedAt: '2026-03-05T12:00:00.000Z' }),
      task({ id: 'c', placeId: 'pl1', peopleIds: ['mum'], completedAt: '2026-03-10T12:00:00.000Z' }),
    ]
    const rows = placesWith('mum', [place(), nopi], tasks)
    expect(rows.map(r => r.place.id)).toEqual(['pl1', 'nopi'])
    expect(rows[0].count).toBe(2)
  })
})

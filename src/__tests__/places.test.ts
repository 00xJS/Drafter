import { describe, expect, it } from 'vitest'
import { sanitizeItem, sanitizePlace, sanitizeTask } from '../schema'
import { favourites, lapsed, matchPlace, normalisePlaceText, outingsAt, placeCadenceStatus, placeStats, placesWith } from '../places'
import { Meal, Person, Place, Task } from '../types'

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

  it('keeps a positive rounded cadence and drops anything else', () => {
    expect(sanitizePlace(place({ cadenceDays: 30.4 }))?.cadenceDays).toBe(30)
    expect(sanitizePlace(place({ cadenceDays: 0 }))?.cadenceDays).toBeUndefined()
    expect(sanitizePlace({ ...place(), cadenceDays: 'monthly' })?.cadenceDays).toBeUndefined()
    expect(sanitizePlace(place())?.cadenceDays).toBeUndefined()
  })

  it('keeps a tombstone with a blank name so deletes still sync', () => {
    const p = sanitizePlace({
      kind: 'place',
      id: 'pl1',
      name: '',
      deletedAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
    })
    expect(p?.deletedAt).toBeTruthy()
    expect(p?.id).toBe('pl1')
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
    expect(visits.map(v => (v.kind === 'task' ? v.task.id : v.meal.id))).toEqual(['a'])
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
    expect(stats.visits.map(v => (v.kind === 'task' ? v.task.id : v.meal.id))).toEqual(['b', 'a', 'c'])
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

describe('matchPlace / favourites / lapsed', () => {
  it('matches an exact name, an alias-free contained name, and refuses a fuzzy guess', () => {
    const nopi = place({ id: 'nopi', name: 'Nopi' })
    const parc = place({ id: 'parc', name: 'Parc Sant Joan', category: 'outdoors' })
    expect(matchPlace('NOPI, 21 Warwick St', [place(), nopi, parc])?.id).toBe('nopi')
    expect(matchPlace("Franco's", [place(), nopi])?.id).toBe('pl1')
    expect(matchPlace('Dinner at Parc Sant Joan (main gate)', [nopi, parc])?.id).toBe('parc')
    expect(matchPlace('Nopisserie bakery', [nopi])).toBeUndefined()
    expect(matchPlace('', [nopi])).toBeUndefined()
    expect(normalisePlaceText('  Café  Kafka, 12 ')).toBe('cafe kafka 12')
  })

  it('favourites need two outings this year; lapsed needs a real gap', () => {
    const now = new Date('2026-09-08T12:00:00.000Z')
    const often = place({ id: 'often', name: 'Often' })
    const once = place({ id: 'once', name: 'Once' })
    const old = place({ id: 'old', name: 'Old haunt' })
    const tasks = [
      task({ id: 'a', placeId: 'often', completedAt: '2026-08-01T12:00:00.000Z' }),
      task({ id: 'b', placeId: 'often', completedAt: '2026-08-20T12:00:00.000Z' }),
      task({ id: 'c', placeId: 'once', completedAt: '2026-08-25T12:00:00.000Z' }),
      task({ id: 'd', placeId: 'old', completedAt: '2026-01-05T12:00:00.000Z' }),
      task({ id: 'e', placeId: 'old', completedAt: '2026-02-05T12:00:00.000Z' }),
    ]
    expect(favourites([often, once, old], tasks, [], now).map(s => s.place.id)).toEqual(['often', 'old'])
    expect(lapsed([often, once, old], tasks, [], now).map(s => s.place.id)).toEqual(['old'])
  })
})

describe('placeCadenceStatus', () => {
  const now = new Date('2026-09-08T12:00:00.000Z')
  const went = (daysAgo: number, over: Partial<Task> = {}) =>
    task({ id: `d${daysAgo}`, completedAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(), ...over })

  it('is none (never due) when no cadence is set, however long ago you went', () => {
    const s = placeCadenceStatus(place(), [went(400)], now)
    expect(s).toEqual({ status: 'none', reason: '' })
    expect(placeStats(place(), [went(400)], [], now).status).toBe('none')
  })

  it('is never when a cadence is set but nothing was logged', () => {
    const s = placeCadenceStatus(place({ cadenceDays: 30 }), [], now)
    expect(s.status).toBe('never')
    expect(s.reason).toBe('No outings yet — you aimed for every 30 days')
    expect(s.cadenceDays).toBe(30)
  })

  it('is ok up to the cadence, due past it, overdue past 1.5x', () => {
    const p = place({ cadenceDays: 30 })
    expect(placeCadenceStatus(p, [went(30)], now).status).toBe('ok')
    expect(placeCadenceStatus(p, [went(31)], now)).toMatchObject({ status: 'due', daysSince: 31, reason: "It's been 31 days; you aimed for every 30 days" })
    expect(placeCadenceStatus(p, [went(45)], now).status).toBe('due')
    expect(placeCadenceStatus(p, [went(46)], now)).toMatchObject({ status: 'overdue', reason: 'Last went 46 days ago — you aimed for every 30 days' })
  })

  it('ignores open tasks, tombstones and other places when finding the last outing', () => {
    const p = place({ cadenceDays: 30 })
    const tasks = [
      went(100),
      went(2, { status: 'todo', completedAt: undefined }),
      went(3, { deletedAt: '2026-09-07T00:00:00.000Z' }),
      went(4, { placeId: 'elsewhere' }),
    ]
    expect(placeCadenceStatus(p, tasks, now)).toMatchObject({ status: 'overdue', daysSince: 100 })
  })

  it('appends the rhythm to the list reason only when due or overdue', () => {
    expect(placeStats(place({ cadenceDays: 30 }), [went(50)], [], now).reason).toBe('Last went 50 days ago · 1 time this year — you aimed for every 30 days')
    expect(placeStats(place({ cadenceDays: 30 }), [went(5)], [], now).reason).toBe('Last went 5 days ago · 1 time this year')
    expect(placeStats(place(), [went(50)], [], now).reason).toBe('Last went 50 days ago · 1 time this year')
  })
})

describe('matchPlace picks the place named first', () => {
  it('prefers the earliest-named place over a longer one later in the text', () => {
    const nopi = place({ id: 'nopi', name: 'Nopi' })
    const soho = place({ id: 'soho', name: 'Soho House', category: 'venue' })
    expect(matchPlace('Nopi, then drinks at Soho House', [soho, nopi])?.id).toBe('nopi')
    expect(matchPlace('Soho House then Nopi', [nopi, soho])?.id).toBe('soho')
  })
})

describe('eating out counts as an outing', () => {
  const now = new Date('2026-09-09T12:00:00.000Z')
  const meal = (over: Partial<Meal> = {}): Meal => ({
    kind: 'meal',
    id: `m-${over.date ?? 'x'}-${over.slot ?? 'dinner'}`,
    date: '2026-09-01',
    slot: 'dinner',
    out: true,
    placeId: 'pl1',
    title: 'Curry house',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  })

  it('counts a past takeaway alongside a logged task', () => {
    const tasks = [task({ id: 'a', completedAt: '2026-08-01T12:00:00.000Z' })]
    const visits = outingsAt('pl1', tasks, [meal()], now)
    expect(visits.map(v => v.kind)).toEqual(['meal', 'task'])
    expect(visits).toHaveLength(2)
  })

  it('ignores a meal planned for the future — a plan is not a visit', () => {
    const visits = outingsAt('pl1', [], [meal({ date: '2026-12-25' })], now)
    expect(visits).toEqual([])
  })

  it('ignores a cooked meal, a tombstone, and another place', () => {
    const meals = [
      meal({ date: '2026-09-02', out: undefined, recipeId: 'r1' }),
      meal({ date: '2026-09-03', deletedAt: '2026-09-04T00:00:00.000Z' }),
      meal({ date: '2026-09-04', placeId: 'other' }),
    ]
    expect(outingsAt('pl1', [], meals, now)).toEqual([])
  })

  it('a takeaway resets the cadence, so "been a while" does not nag', () => {
    const p = { ...place(), cadenceDays: 30 }
    const stale = placeCadenceStatus(p, [], now, [])
    expect(stale.status).toBe('never')
    const fresh = placeCadenceStatus(p, [], now, [meal({ date: '2026-09-08' })])
    expect(fresh.status).toBe('ok')
  })

  it('reports how often you ate there, separately from all outings', () => {
    const tasks = [task({ id: 'a', completedAt: '2026-08-01T12:00:00.000Z' })]
    const meals = [meal({ date: '2026-09-01' }), meal({ date: '2026-09-05' })]
    const stats = placeStats(place(), tasks, [], now, meals)
    expect(stats.count365).toBe(3)
    expect(stats.eatenOut).toBe(2)
    expect(stats.eatenOut365).toBe(2)
    expect(stats.reason).toContain('ate here 2 times')
  })

  it('leaves companions to tasks — a meal records the place, not the company', () => {
    const mum = person()
    const tasks = [task({ id: 'a', completedAt: '2026-08-01T12:00:00.000Z', peopleIds: ['mum'] })]
    const stats = placeStats(place(), tasks, [mum], now, [meal()])
    expect(stats.companions.map(c => c.person.id)).toEqual(['mum'])
    expect(stats.companions[0].count).toBe(1)
  })
})

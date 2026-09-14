import { describe, expect, it } from 'vitest'
import { sanitizeItem, sanitizePlace, sanitizeTask } from '../schema'
import {
  favourites,
  findsPlace,
  lapsed,
  mapsUrl,
  matchPlace,
  normalisePlaceText,
  outingsAt,
  placeAliasesFromText,
  placeByName,
  placeCadenceStatus,
  placeNameKey,
  placeStats,
  placeYearReport,
  placesWith,
  prefersAppleMaps,
} from '../places'
import { MAX_PLACE_ALIASES } from '../../shared/places.mjs'
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

  // meals are required: these have none, and say so
  it('is none (never due) when no cadence is set, however long ago you went', () => {
    const s = placeCadenceStatus(place(), [went(400)], now, [])
    expect(s).toEqual({ status: 'none', reason: '' })
    expect(placeStats(place(), [went(400)], [], now).status).toBe('none')
  })

  it('is never when a cadence is set but nothing was logged', () => {
    const s = placeCadenceStatus(place({ cadenceDays: 30 }), [], now, [])
    expect(s.status).toBe('never')
    expect(s.reason).toBe('No outings yet — you aimed for every 30 days')
    expect(s.cadenceDays).toBe(30)
  })

  it('is ok up to the cadence, due past it, overdue past 1.5x', () => {
    const p = place({ cadenceDays: 30 })
    expect(placeCadenceStatus(p, [went(30)], now, []).status).toBe('ok')
    expect(placeCadenceStatus(p, [went(31)], now, [])).toMatchObject({ status: 'due', daysSince: 31, reason: "It's been 31 days; you aimed for every 30 days" })
    expect(placeCadenceStatus(p, [went(45)], now, []).status).toBe('due')
    expect(placeCadenceStatus(p, [went(46)], now, [])).toMatchObject({ status: 'overdue', reason: 'Last went 46 days ago — you aimed for every 30 days' })
  })

  it('ignores open tasks, tombstones and other places when finding the last outing', () => {
    const p = place({ cadenceDays: 30 })
    const tasks = [
      went(100),
      went(2, { status: 'todo', completedAt: undefined }),
      went(3, { deletedAt: '2026-09-07T00:00:00.000Z' }),
      went(4, { placeId: 'elsewhere' }),
    ]
    expect(placeCadenceStatus(p, tasks, now, [])).toMatchObject({ status: 'overdue', daysSince: 100 })
  })

  it('appends the rhythm to the list reason only when due or overdue', () => {
    expect(placeStats(place({ cadenceDays: 30 }), [went(50)], [], now).reason).toBe('Last went 50 days ago · 1 time in 12 months — you aimed for every 30 days')
    expect(placeStats(place({ cadenceDays: 30 }), [went(5)], [], now).reason).toBe('Last went 5 days ago · 1 time in 12 months')
    expect(placeStats(place(), [went(50)], [], now).reason).toBe('Last went 50 days ago · 1 time in 12 months')
  })

  it('says the window it counts: last November is one outing in 12 months, and none in this year', () => {
    // 30 November 2025, seen on 8 September 2026: the row counts it, this year's table does not
    const november = placeStats(place(), [went(282)], [], now)
    expect(november.count365).toBe(1)
    expect(november.reason).toMatch(/ · 1 time in 12 months$/)
    expect(placeYearReport([place()], [went(282)], [], 2026, now)[0].total).toBe(0)
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

describe('placeByName: naming somewhere new must not duplicate somewhere old', () => {
  const nopi = { ...place(), id: 'pl1', name: 'Nopi' }
  const taco = { ...place(), id: 'pl2', name: 'Taco Cartel' }
  const gone = { ...place(), id: 'pl3', name: 'Closed Diner', deletedAt: '2026-01-01T00:00:00.000Z' }
  const all = [nopi, taco, gone]

  it('matches regardless of case and stray whitespace', () => {
    expect(placeByName('taco cartel', all)?.id).toBe('pl2')
    expect(placeByName('  TACO   CARTEL  ', all)?.id).toBe('pl2')
    expect(placeByName('Nopi', all)?.id).toBe('pl1')
  })

  it('returns undefined for a genuinely new name, so the caller creates one', () => {
    expect(placeByName('Some New Bistro', all)).toBeUndefined()
  })

  it('ignores a deleted place rather than resurrecting it', () => {
    expect(placeByName('Closed Diner', all)).toBeUndefined()
  })

  it('treats an empty or missing name as no match', () => {
    expect(placeByName('', all)).toBeUndefined()
    expect(placeByName('   ', all)).toBeUndefined()
    expect(placeByName(null, all)).toBeUndefined()
  })

  // the meal picker's Somewhere new: normalisePlaceText kept only a–z and 0–9,
  // so a new 金龙 Restaurant was quietly saved as the 银龙 Restaurant you had
  it('reads every script, so it never takes one place for another', () => {
    const silver = { ...place(), id: 'pl4', name: '银龙 Restaurant' }
    const graen = { ...place(), id: 'pl5', name: 'Græn' }
    expect(placeByName('金龙 Restaurant', [silver])).toBeUndefined()
    expect(placeByName('Grøn', [graen])).toBeUndefined()
    expect(placeByName('C++ Bar', [{ ...place(), id: 'pl6', name: 'C Bar' }])).toBeUndefined()
    expect(placeByName('银龙 restaurant', [silver])?.id).toBe('pl4')
    expect(placeByName('Cafe Kafka', [{ ...place(), id: 'pl7', name: 'Café Kafka' }])?.id).toBe('pl7')
  })

  // "Pret" typed in a Where picker made a second Pret beside the Pret A Manger
  // that goes by it, splitting its outings
  it('knows a place by one of its other names, after any place’s own name', () => {
    const pret = { ...place(), id: 'pret', name: 'Pret A Manger', aliases: ['Pret', 'The Sandwich Shop'] }
    expect(placeByName('pret', [pret])?.id).toBe('pret')
    expect(placeByName('  the SANDWICH shop ', [pret])?.id).toBe('pret')
    // a place called just that is the one it means, and the Trash keeps its names to itself
    const mine = { ...place(), id: 'mine', name: 'Pret' }
    expect(placeByName('Pret', [pret, mine])?.id).toBe('mine')
    expect(placeByName('Pret', [{ ...pret, deletedAt: '2026-01-01T00:00:00.000Z' }])).toBeUndefined()
    // part of another name is not that name
    expect(placeByName('Sandwich', [pret])).toBeUndefined()
  })
})

describe('placeNameKey: what makes two names the same place', () => {
  it('sets aside case, Latin accents, punctuation and spacing', () => {
    expect(placeNameKey('  Café  Kafka, 12 ')).toBe('cafe kafka 12')
    expect(placeNameKey('Franco’s')).toBe('franco s')
    // a spacing accent typed for an apostrophe is punctuation too
    expect(placeNameKey('Franco´s')).toBe('franco s')
    expect(placeNameKey('Phở')).toBe('pho')
    expect(placeNameKey('')).toBe('')
    expect(placeNameKey(null)).toBe('')
  })

  it('keeps every other letter, mark, digit and symbol, in any script', () => {
    expect(placeNameKey('金龙 Restaurant')).toBe('金龙 restaurant')
    expect(placeNameKey('Grøn')).toBe('grøn')
    expect(placeNameKey('C++ Bar')).toBe('c++ bar')
    // a dakuten and a Hindi vowel sign spell different words, unlike an accent
    expect(placeNameKey('ガスト')).not.toBe(placeNameKey('カスト'))
    expect(placeNameKey('कमला')).not.toBe(placeNameKey('कमल'))
  })
})

describe('placeYearReport: the year in places counts outings', () => {
  const now = new Date(2026, 8, 13, 12, 0) // local noon, Sunday 13 September 2026
  const local = (m: number, d: number, h = 12) => new Date(2026, m - 1, d, h).toISOString()
  const meal = (date: string, over: Partial<Meal> = {}): Meal => ({
    kind: 'meal',
    id: `m-${date}`,
    date,
    slot: 'dinner',
    out: true,
    placeId: 'pl1',
    title: "Franco's",
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  })
  const nopi = place({ id: 'nopi', name: 'Nopi' })
  const tasks = [
    // lunch and dinner at Franco's on one March day: two outings, where People would count one day
    task({ id: 'lunch', completedAt: local(3, 7, 13) }),
    task({ id: 'dinner', completedAt: local(3, 7, 20) }),
    task({ id: 'aug', completedAt: local(8, 20) }),
    task({ id: 'may', placeId: 'nopi', completedAt: local(5, 2) }),
    task({ id: 'nye', completedAt: new Date(2025, 11, 31, 20).toISOString() }),
  ]
  const meals = [
    meal('2026-09-12'), // last night's takeaway
    meal('2026-09-25'), // booked for later this month: a plan, not an outing yet
    meal('2026-09-05', { out: undefined, recipeId: 'r1' }), // cooked at home
  ]
  const [first, second] = placeYearReport([nopi, place()], tasks, meals, 2026, now)

  it('puts each outing in its month, a meal eaten out included and one still to come not', () => {
    expect(first.place.id).toBe('pl1')
    expect(first.months).toEqual([0, 0, 2, 0, 0, 0, 0, 1, 1, 0, 0, 0])
    expect(first.total).toBe(4)
    expect(second.place.id).toBe('nopi')
    expect(second.months[4]).toBe(1)
    expect(second.total).toBe(1)
  })

  it('sorts by outings, then by name', () => {
    expect([first.place.id, second.place.id]).toEqual(['pl1', 'nopi'])
    expect(placeYearReport([nopi, place({ id: 'alpha', name: 'Alpha' })], [], [], 2026, now).map(r => r.place.name)).toEqual(['Alpha', 'Nopi'])
  })

  it('reads the trend in outings, the last 90 days against the 90 before', () => {
    // August and last night are recent; March is older than both windows
    expect(first.trend).toBe(2)
    // May's visit to Nopi is in the 90 days before, with nothing since
    expect(second.trend).toBe(-1)
  })

  it('gives another year its own months, while the trend stays about now', () => {
    const [last] = placeYearReport([place()], tasks, meals, 2025, now)
    expect(last.months[11]).toBe(1)
    expect(last.total).toBe(1)
    expect(last.trend).toBe(2)
  })

  it('files a meal on its own date east of UTC+11, where midday UTC is already the next day', () => {
    const tz = process.env.TZ
    process.env.TZ = 'Pacific/Auckland'
    try {
      const inAuckland = new Date(2026, 8, 13, 12) // noon on Sunday 13 September, New Zealand time
      const eaten = [meal('2026-01-31'), meal('2025-12-31')]
      // the last takeaway of January is January's, not February's
      const [thisYear] = placeYearReport([place()], [], eaten, 2026, inAuckland)
      expect(thisYear.months.slice(0, 2)).toEqual([1, 0])
      expect(thisYear.total).toBe(1)
      // New Year's Eve's is that year's, not the next one's
      const [lastYear] = placeYearReport([place()], [], eaten, 2025, inAuckland)
      expect(lastYear.months[11]).toBe(1)
      expect(lastYear.total).toBe(1)
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })
})

describe('a place’s address and other names are kept tidy', () => {
  it('keeps the address on one line, and each other name once, never the name again', () => {
    const p = sanitizePlace({ ...place(), address: '  21 Warwick St,\n  London ', aliases: [' Pret ', 'pret', "FRANCO'S", '', 7, 'Pret  A Manger', null] })
    expect(p?.address).toBe('21 Warwick St, London')
    expect(p?.aliases).toEqual(['Pret', 'Pret A Manger'])
  })

  it('reads a place saved before either existed as it was, with neither', () => {
    const p = sanitizePlace(place({ notes: 'booth' }))
    expect(p?.address).toBeUndefined()
    expect(p?.aliases).toBeUndefined()
    expect(p?.notes).toBe('booth')
  })

  it('drops what is not an address or a list of names, blanks included, and caps both', () => {
    const odd = sanitizePlace({ ...place(), address: 42, aliases: 'Pret' })
    expect([odd?.address, odd?.aliases]).toEqual([undefined, undefined])
    const blank = sanitizePlace({ ...place(), address: '   ', aliases: ['  ', ''] })
    expect([blank?.address, blank?.aliases]).toEqual([undefined, undefined])
    const many = Array.from({ length: MAX_PLACE_ALIASES + 5 }, (_, i) => `Name ${i}`)
    expect(sanitizePlace({ ...place(), aliases: many })?.aliases).toEqual(many.slice(0, MAX_PLACE_ALIASES))
    expect(sanitizePlace({ ...place(), address: 'x'.repeat(500) })?.address).toHaveLength(200)
  })

  it('keeps them on a tombstone too, so a delete syncs as it always did', () => {
    const p = sanitizePlace({ kind: 'place', id: 'pl1', name: '', aliases: ['Pret'], deletedAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z' })
    expect(p).toMatchObject({ id: 'pl1', aliases: ['Pret'], deletedAt: '2026-09-08T00:00:00.000Z' })
  })

  it('reads the editor’s Other names box: split at the commas, tidied the same way', () => {
    expect(placeAliasesFromText(' Pret,  Pret A Manger ,, pret ', 'Pret A Manger (Soho)')).toEqual(['Pret', 'Pret A Manger'])
    expect(placeAliasesFromText('Nopi', 'nopi')).toBeUndefined()
    expect(placeAliasesFromText('', 'Nopi')).toBeUndefined()
  })
})

describe('matchPlace finds a place by its name, other names or address', () => {
  const pret = place({ id: 'pret', name: 'Pret A Manger', category: 'cafe', aliases: ['Pret', 'The Sandwich Shop'] })
  const nopi = place({ id: 'nopi', name: 'Nopi', address: '21-22 Warwick St, London W1B 5NE' })
  const bo = place({ id: 'bo', name: 'Café Bo', category: 'cafe', aliases: ['Bo', 'Q'] })

  it('knows an other name, whole or inside the location, whatever its case and spacing', () => {
    expect(matchPlace('Pret', [pret])?.id).toBe('pret')
    expect(matchPlace('  pret  ', [pret])?.id).toBe('pret')
    expect(matchPlace('PRET, 1 Oxford St', [pret])?.id).toBe('pret')
    expect(matchPlace('Lunch at the sandwich shop (upstairs)', [pret])?.id).toBe('pret')
  })

  it('knows a full address the location opens with, but not a piece of it', () => {
    expect(matchPlace('21-22 Warwick St, London W1B 5NE, United Kingdom', [nopi])?.id).toBe('nopi')
    expect(matchPlace('21-22 Warwick St, London W1B 5NE', [nopi])?.id).toBe('nopi')
    expect(matchPlace('The Warwick Arms, Warwick St', [nopi])).toBeUndefined()
  })

  // an address was looked for anywhere in a location, so the street, the town or
  // the building a place shares with other venues marked their events as there
  it('never marks another venue’s event by the street, the town or the building they share', () => {
    const park = place({ id: 'park', name: 'Hyde Park', category: 'outdoors', address: 'London W2' })
    const city = place({ id: 'city', name: 'Nopi', address: 'London' })
    const uniqlo = place({ id: 'uniqlo', name: 'Uniqlo', category: 'shop', address: 'Oxford St, London' })
    const waga = place({ id: 'waga', name: 'Wagamama', address: 'Westfield Stratford City, London E20 1EJ' })
    const pilgrims = place({ id: 'pilgrims', name: 'Pizza Pilgrims', address: '2 Stratford Pl, London E20 1EJ' })
    const all = [park, city, uniqlo, waga, pilgrims]
    expect(matchPlace('Paddington Station, Praed St, London W2', all)).toBeUndefined()
    expect(matchPlace('Dentist, 5 Harley St, London', all)).toBeUndefined()
    expect(matchPlace('London Bridge Station', all)).toBeUndefined()
    expect(matchPlace('Selfridges, 400 Oxford St, London', all)).toBeUndefined()
    expect(matchPlace('Oxford St, London W1', all)).toBeUndefined()
    expect(matchPlace("Nando's, Westfield Stratford City, London E20 1EJ", all)).toBeUndefined()
    // a house number is not enough after another venue's name: a food hall, a shopping centre
    expect(matchPlace("Nando's, 2 Stratford Pl, London E20 1EJ", all)).toBeUndefined()
    // each still marks a location that is exactly it, and one naming its door a location that opens with it
    expect(matchPlace('London W2', all)?.id).toBe('park')
    expect(matchPlace('Westfield Stratford City, London E20 1EJ', all)?.id).toBe('waga')
    expect(matchPlace('2 Stratford Pl, London E20 1EJ, UK', all)?.id).toBe('pilgrims')
    expect(matchPlace('Pizza Pilgrims, 2 Stratford Pl, London E20 1EJ', all)?.id).toBe('pilgrims')
  })

  it('never finds a name or other name inside another word, a hyphenated one included', () => {
    expect(matchPlace("Bob's Diner, High St", [bo])).toBeUndefined()
    expect(matchPlace('Bonnie Doon', [bo])).toBeUndefined()
    expect(matchPlace('Pretty Things boutique', [pret])).toBeUndefined()
    // a hyphen makes one word of "Co-op", "Wok-to-Walk" and "Stratford-upon-Avon"
    expect(matchPlace('Co-op, High St', [place({ id: 'one', name: 'Coffee One', aliases: ['Co'] })])).toBeUndefined()
    const wok = place({ id: 'wok', name: 'Wok', category: 'fastfood' })
    const stratford = place({ id: 'strat', name: 'The Stratford', category: 'bar', aliases: ['Stratford'] })
    expect(matchPlace('Wok-to-Walk, 4 Hill Rd', [wok])).toBeUndefined()
    expect(matchPlace('Lunch at Hill-Wok', [wok])).toBeUndefined()
    expect(matchPlace('Weekend in Stratford-upon-Avon', [stratford])).toBeUndefined()
    // as a word of its own it is found, before a possessive or a spaced dash too
    expect(matchPlace("Wok's, 4 Hill Rd", [wok])?.id).toBe('wok')
    expect(matchPlace('Train to Stratford - platform 2', [stratford])?.id).toBe('strat')
    expect(matchPlace('Hill-Wok, then Wok', [wok])?.id).toBe('wok')
  })

  it('finds a hyphenated name however its hyphens are typed', () => {
    const coop = place({ id: 'coop', name: 'Co-op', category: 'shop' })
    expect(matchPlace('Co-op, High St', [coop])?.id).toBe('coop')
    expect(matchPlace('Co op, High St', [coop])?.id).toBe('coop')
    // and a place called Pret is not the start of "Pret-A-Manger"
    expect(matchPlace('Pret-A-Manger, 1 High St', [place({ id: 'mine', name: 'Pret' }), pret])?.id).toBe('pret')
  })

  it('takes one or two letters only as the whole location, or the venue it opens with', () => {
    expect(matchPlace('Q', [bo])?.id).toBe('bo')
    expect(matchPlace('Q, 3 Hill Rd', [bo])?.id).toBe('bo')
    expect(matchPlace('Flat Q, 3 Hill Rd', [bo])).toBeUndefined()
    expect(matchPlace('Bo, High St', [bo])?.id).toBe('bo')
    expect(matchPlace('Coffee at Bo, High St', [bo])).toBeUndefined()
    const oz = place({ id: 'oz', name: 'Oz' })
    expect(matchPlace('Oz, 4 Hill Rd', [oz])?.id).toBe('oz')
    expect(matchPlace('Oz\n4 Hill Rd', [oz])?.id).toBe('oz')
    expect(matchPlace('Ozone Bar', [oz])).toBeUndefined()
    // a word in a sentence, or in a question to Ask, is not the bar called Up
    const up = place({ id: 'up', name: 'Up', category: 'bar' })
    expect(matchPlace('Meet up at the station', [up])).toBeUndefined()
    expect(matchPlace('When did we last go up to see Mum?', [up])).toBeUndefined()
    expect(matchPlace('Up', [up])?.id).toBe('up')
  })

  it('gives a place its own name before anyone else’s other name, whole or inside the location', () => {
    const crown = place({ id: 'crown', name: 'The Crown', category: 'bar' })
    const hotel = place({ id: 'hotel', name: 'Crown Hotel', category: 'venue', aliases: ['The Crown'] })
    for (const list of [[hotel, crown], [crown, hotel]]) {
      expect(matchPlace('The Crown', list)?.id).toBe('crown')
      expect(matchPlace('The Crown, 5 High St', list)?.id).toBe('crown')
    }
    // and anyone's other name before an address
    const yard = place({ id: 'yard', name: 'The Yard Bar', category: 'bar', aliases: ['The Yard'] })
    const flat = place({ id: 'flat', name: 'Sam’s flat', category: 'home', address: 'The Yard' })
    for (const list of [[flat, yard], [yard, flat]]) expect(matchPlace('The Yard', list)?.id).toBe('yard')
  })

  it('still takes whichever is named first, by name, other name or address alike', () => {
    expect(matchPlace('Pret, then Nopi', [nopi, pret])?.id).toBe('pret')
    expect(matchPlace('Nopi, then Pret', [pret, nopi])?.id).toBe('nopi')
    expect(matchPlace('21-22 Warwick St, London W1B 5NE, then Pret', [pret, nopi])?.id).toBe('nopi')
  })

  it('ignores a place in the Trash, and other names or an address that are not strings', () => {
    expect(matchPlace('Pret', [{ ...pret, deletedAt: '2026-09-01T00:00:00.000Z' }])).toBeUndefined()
    expect(matchPlace('Pret', [{ ...pret, aliases: 'Pret' as unknown as string[] }])).toBeUndefined()
    const odd = { ...place({ id: 'odd', name: 'Odd Bar' }), aliases: [7, null, {}] as unknown as string[], address: 42 as unknown as string }
    expect(matchPlace('7', [odd])).toBeUndefined()
    expect(matchPlace('42', [odd])).toBeUndefined()
    expect(matchPlace('Odd Bar, 7 Hill Rd', [odd])?.id).toBe('odd')
  })
})

describe('Open in Maps', () => {
  it('searches the address when there is one, else the name', () => {
    const apple = mapsUrl({ name: 'Nopi', address: '21 Warwick St, London' }, true)
    expect(apple).toBe('https://maps.apple.com/?q=21%20Warwick%20St%2C%20London')
    expect(new URL(apple).searchParams.get('q')).toBe('21 Warwick St, London')
    const google = mapsUrl({ name: 'Franco & Sons' }, false)
    expect(google).toBe('https://www.google.com/maps/search/?api=1&query=Franco%20%26%20Sons')
    expect(new URL(google).searchParams.get('query')).toBe('Franco & Sons')
    expect(mapsUrl({ name: ' Nopi ', address: '   ' }, true)).toBe('https://maps.apple.com/?q=Nopi')
  })

  it('uses Apple Maps on an iPhone, an iPad or a Mac, and Google Maps elsewhere', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
    // iPadOS Safari says it is a Mac
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
    const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36'
    expect(prefersAppleMaps({ userAgent: iphone, platform: 'iPhone' })).toBe(true)
    expect(prefersAppleMaps({ userAgent: ipad, platform: 'MacIntel' })).toBe(true)
    expect(prefersAppleMaps({ userAgent: windows, platform: 'Win32' })).toBe(false)
    expect(prefersAppleMaps({ userAgent: android, platform: 'Linux armv8l' })).toBe(false)
    expect(prefersAppleMaps({})).toBe(false)
  })
})

describe('Places’ find box', () => {
  it('looks in the other names, the address and the notes as well as the name', () => {
    const p = place({ name: 'Pret A Manger', aliases: ['The Sandwich Shop'], address: '1 Oxford St', notes: 'oat latte' })
    for (const q of ['pret', 'sandwich', 'oxford', 'latte', '']) expect(findsPlace(p, q), q).toBe(true)
    expect(findsPlace(p, 'nopi')).toBe(false)
  })
})

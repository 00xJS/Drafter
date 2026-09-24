import { describe, expect, it } from 'vitest'
import { dayLetter, dayMark, dealIdeas, hasLook, pickerGroups, pickerOrder, seeded, weekOf, weekRange } from '../components/wardrobe/board'
import { heldPieces, rowsOf } from '../components/wardrobe/composer'
import type { Garment, GarmentType, Wear } from '../types'
import { dayWeather, wearIndex, type DayOccasion } from '../wardrobe'

// The Outfit board's rules: the week strip's marks, the picker's order and
// groups, and the ideas. The owner's complaint was that the
// pieces moved — by rest, frozen per visit, regrouped by the day — so what is
// held here most of all is that the order is the same wherever it is asked
// from, and says why a piece sits where it does.

const T0 = '2026-08-01T09:00:00.000Z'
/** A Monday. */
const TODAY = '2026-09-14'
const piece = (id: string, type: GarmentType, over: Partial<Garment> = {}): Garment => ({ kind: 'garment', id, name: id, type, createdAt: T0, updatedAt: T0, ...over })
let made = 0
const look = (date: string, garmentIds: string[], over: Partial<Wear> = {}): Wear => {
  made++
  return { kind: 'wear', id: `wear~${date}~${String(made).padStart(10, '0')}`, date, garmentIds, createdAt: `${date}T08:00:00.000Z`, updatedAt: `${date}T08:00:00.000Z`, ...over }
}
const ids = (list: readonly Garment[]) => list.map(g => g.id)

describe('a seeded draw', () => {
  it('draws the same numbers from the same seed, and others from another, each in [0, 1)', () => {
    const a = seeded('ideas|2026-09-14|work|0')
    const b = seeded('ideas|2026-09-14|work|0')
    const first = Array.from({ length: 20 }, () => a())
    expect(Array.from({ length: 20 }, () => b())).toEqual(first)
    expect(first.every(n => n >= 0 && n < 1)).toBe(true)
    const c = seeded('ideas|2026-09-14|work|1')
    expect(Array.from({ length: 20 }, () => c())).not.toEqual(first)
    // spread out, not stuck in one corner
    expect(Math.min(...first)).toBeLessThan(0.25)
    expect(Math.max(...first)).toBeGreaterThan(0.75)
  })
})

describe('the week strip', () => {
  it('runs Sunday to Saturday, the app’s weeks, whatever day of it is dressed', () => {
    expect(weekOf(TODAY)).toEqual(['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'])
    expect(weekOf('2026-09-13')).toEqual(weekOf('2026-09-19'))
    expect(weekOf(TODAY).map(dayLetter).join('')).toBe('SMTWTFS')
  })

  it('names the week in the app’s own order, with the year only when it is not this one', () => {
    expect(weekRange(weekOf(TODAY), TODAY)).toBe('13 – 19 Sep')
    expect(weekRange(weekOf('2026-09-01'), TODAY)).toBe('30 Aug – 5 Sep')
    expect(weekRange(weekOf('2027-03-10'), TODAY)).toBe('7 – 13 Mar 2027')
    expect(weekRange(weekOf('2026-12-31'), TODAY)).toBe('27 Dec 2026 – 2 Jan 2027')
  })

  it('marks a day with a look worn with a dot, one with only a plan with a ring, and an empty or deleted look not at all', () => {
    const wears = [
      look('2026-09-13', ['tee', 'jeans']),
      look('2026-09-14', ['tee', 'jeans'], { planned: true }),
      look('2026-09-14', ['shirt', 'jeans']),
      look('2026-09-16', ['tee', 'jeans'], { planned: true }),
      look('2026-09-17', []),
      look('2026-09-18', ['tee', 'jeans'], { deletedAt: T0 }),
    ]
    expect(weekOf(TODAY).map(d => dayMark(wears, d))).toEqual([
      'logged',
      // a plan beside a look worn: worn wins the day
      'logged',
      null,
      'planned',
      null,
      null,
      null,
    ])
    expect(hasLook(wears, '2026-09-16')).toBe(true)
    expect(hasLook(wears, '2026-09-17')).toBe(false)
  })
})

describe('the picker', () => {
  const tops = [
    piece('suit', 'top', { occasion: 'work', name: 'Suit' }),
    piece('shirt', 'top', { name: 'Shirt' }),
    piece('gym', 'top', { occasion: 'personal', name: 'Gym top' }),
    piece('band', 'top', { name: 'Band tee', tags: ['gig'] }),
    piece('aran', 'top', { name: 'Aran', favourite: true }),
    piece('polo', 'top', { name: 'Polo', occasion: 'work', favourite: true }),
  ]
  const wears = [look('2026-09-12', ['shirt']), look('2026-08-30', ['suit']), look('2026-09-01', ['gym']), look('2026-09-10', ['polo'])]
  const ix = wearIndex(wears, TODAY)

  it('opens on the longest rested first, never worn before any worn, a tie by name', () => {
    // Aran and Band tee never worn (A–Z), then the suit (30 Aug), the gym top (1 Sep), the polo (10 Sep), the shirt (12 Sep)
    expect(pickerOrder(tops, ix)).toEqual(['aran', 'band', 'suit', 'gym', 'polo', 'shirt'])
  })

  it('shows the pieces for the day and for any time under For work, and says how many it leaves out', () => {
    const order = pickerOrder(tops, ix)
    const work = pickerGroups(tops, order, 'work', 'fit')
    expect(ids(work.fit)).toEqual(['aran', 'band', 'suit', 'polo', 'shirt'])
    expect(work.other).toEqual([])
    expect(work.hidden).toBe(1)
    const off = pickerGroups(tops, order, 'personal', 'fit')
    expect(ids(off.fit)).toEqual(['aran', 'band', 'gym', 'shirt'])
    expect(off.hidden).toBe(2)
  })

  it('keeps both groups under All and Favourites, the others after the day’s, each in the order it opened with', () => {
    const order = pickerOrder(tops, ix)
    const all = pickerGroups(tops, order, 'work', 'all')
    expect([ids(all.fit), ids(all.other), all.hidden]).toEqual([['aran', 'band', 'suit', 'polo', 'shirt'], ['gym'], 0])
    const favourites = pickerGroups(tops, order, 'personal', 'favourites')
    expect([ids(favourites.fit), ids(favourites.other)]).toEqual([['aran'], ['polo']])
  })

  it('finds a piece by a word of its name or a tag, in any case, keeping the order', () => {
    const order = pickerOrder(tops, ix)
    expect(ids(pickerGroups(tops, order, 'work', 'all', 'SH').fit)).toEqual(['shirt'])
    expect(ids(pickerGroups(tops, order, 'work', 'all', 'gig').fit)).toEqual(['band'])
    expect(ids(pickerGroups(tops, order, 'work', 'all', ' t').other)).toEqual(['gym'])
  })

  it('never re-sorts while it is open: a piece worn meanwhile keeps its place, and one added goes last', () => {
    const order = pickerOrder(tops, ix)
    // the Aran is worn and a new top arrives by sync, the sheet still open
    const later = [...tops, piece('new', 'top', { name: 'Alpaca' })]
    const worn = wearIndex([...wears, look(TODAY, ['aran'])], TODAY)
    expect(pickerOrder(later, worn)[0]).not.toBe('aran')
    expect(ids(pickerGroups(later, order, 'work', 'fit').fit)).toEqual(['aran', 'band', 'suit', 'polo', 'shirt', 'new'])
  })

  it('is the same order on every day of a week, and on a day off keeps each piece where it was among its group', () => {
    // the ix is today's whatever day is dressed, and the order reads nothing else
    const tuesday = pickerGroups(tops, pickerOrder(tops, ix), 'work', 'all')
    const thursday = pickerGroups(tops, pickerOrder(tops, ix), 'work', 'all')
    expect(thursday).toEqual(tuesday)
    // a day off moves the gym top up to its group and the work pieces down to theirs; within each, rest decides as ever
    const saturday = pickerGroups(tops, pickerOrder(tops, ix), 'personal', 'all')
    const rank = (list: Garment[]) => (a: string, b: string) => list.findIndex(g => g.id === a) - list.findIndex(g => g.id === b)
    const workOrder = [...tuesday.fit, ...tuesday.other]
    const offOrder = [...saturday.fit, ...saturday.other]
    for (const [a, b] of [['aran', 'shirt'], ['band', 'shirt'], ['suit', 'polo']]) {
      expect(Math.sign(rank(workOrder)(a, b)), `${a} before ${b}`).toBe(Math.sign(rank(offOrder)(a, b)))
    }
    expect([ids(saturday.fit), ids(saturday.other)]).toEqual([['aran', 'band', 'gym', 'shirt'], ['suit', 'polo']])
  })

  it('leads with what the day’s look holds that is retired or in Trash, badged, whatever the filter', () => {
    const old = piece('old', 'top', { name: 'Old tee', archivedAt: T0, occasion: 'personal' })
    const held = heldPieces(look(TODAY, ['old', 'jeans']), [...tops, old], [])
    const pieces = rowsOf([...tops, old], held).top
    expect(pieces[0].id).toBe('old')
    const order = pickerOrder(pieces, ix)
    for (const filter of ['fit', 'all', 'favourites'] as const) expect(ids(pickerGroups(pieces, order, 'work', filter).held), filter).toEqual(['old'])
  })
})

describe('ideas for the day', () => {
  const tops = ['t1', 't2', 't3', 't4'].map(id => piece(id, 'top'))
  const bottoms = ['b1', 'b2', 'b3'].map(id => piece(id, 'bottom'))
  const opts = { occasion: 'work' as DayOccasion, season: 'autumn' as const }
  const rowsFor = (garments: Garment[]) => rowsOf(garments)

  it('deals three looks, each a combination of its own, with no top or bottom twice while the wardrobe allows', () => {
    const ix = wearIndex([], TODAY)
    for (let n = 0; n < 12; n++) {
      const ideas = dealIdeas(rowsFor([...tops, ...bottoms]), ix, { ...opts, seed: `t|${n}` })
      expect(ideas).toHaveLength(3)
      const core = ideas.map(i => i.core)
      expect(new Set(core.map(c => c[0])).size, `tops, deal ${n}`).toBe(3)
      expect(new Set(core.map(c => c[1])).size, `bottoms, deal ${n}`).toBe(3)
      expect(new Set(ideas.map(i => i.key)).size).toBe(3)
    }
  })

  it('shares a piece only once it must, and never deals one combination twice', () => {
    const ix = wearIndex([], TODAY)
    // two tops: the third look shares a top, but not its bottom
    const two = dealIdeas(rowsFor([tops[0], tops[1], ...bottoms]), ix, { ...opts, seed: 'x' })
    expect(two).toHaveLength(3)
    expect(new Set(two.map(i => i.core[1])).size).toBe(3)
    // one top and one bottom: one look is all there is
    expect(dealIdeas(rowsFor([tops[0], bottoms[0]]), ix, { ...opts, seed: 'x' })).toHaveLength(1)
    // nothing to dress: nothing
    expect(dealIdeas(rowsFor(tops), ix, { ...opts, seed: 'x' })).toEqual([])
  })

  it('leans on the ones rested longest: each look is as likely as its pieces’ rest multiplied', () => {
    const garments = [piece('t-today', 'top'), piece('t-month', 'top'), piece('t-never', 'top'), piece('b', 'bottom')]
    const ix = wearIndex([look(TODAY, ['t-today', 'b']), look('2026-08-15', ['t-month', 'b'])], TODAY)
    const drawn = (r: number) => dealIdeas(rowsOf(garments), ix, { ...opts, count: 1, random: () => r })[0].core[0]
    // the bottom was worn today, so weighs 1: the looks weigh what their tops do —
    // a month's rest 31, never worn 61, today's 1, 93 between them, in the tops' A–Z
    expect(drawn(0.1)).toBe('t-month')
    expect(drawn(0.5)).toBe('t-never')
    expect(drawn(0.999)).toBe('t-today')
  })

  it('never deals a piece only held for the day, nor one out of season while there is one in it', () => {
    const old = piece('old', 'top', { archivedAt: T0 })
    const held = heldPieces(look(TODAY, ['old', 'b1']), [old, ...tops, ...bottoms], [])
    const rows = rowsOf([old, ...tops, ...bottoms], held)
    expect(rows.top[0].id).toBe('old')
    for (let n = 0; n < 10; n++) expect(dealIdeas(rows, wearIndex([], TODAY), { ...opts, seed: `h|${n}` }).flatMap(i => i.core)).not.toContain('old')
    const summer = piece('summer', 'top', { seasons: ['summer'] })
    const wool = piece('wool', 'top', { seasons: ['winter'] })
    const seasonal = rowsOf([summer, wool, bottoms[0]])
    // in winter the wool top only, whatever the draw; with nothing in season, the summer tee after all
    for (let n = 0; n < 10; n++) expect(dealIdeas(seasonal, wearIndex([], TODAY), { ...opts, season: 'winter', seed: `s|${n}` }).map(i => i.core[0])).toEqual(['wool'])
    expect(dealIdeas(rowsOf([summer, bottoms[0]]), wearIndex([], TODAY), { ...opts, season: 'winter', seed: 's' }).map(i => i.core[0])).toEqual(['summer'])
  })

  it('keeps to the day’s occasion: pieces for it or for any time, and none for a type with nothing for the day', () => {
    const suit = piece('suit', 'top', { occasion: 'work' })
    const gym = piece('gym', 'top', { occasion: 'personal' })
    const slacks = piece('slacks', 'bottom', { occasion: 'work' })
    const jeans = piece('jeans', 'bottom')
    const rows = rowsOf([suit, gym, slacks, jeans, tops[0]])
    for (let n = 0; n < 10; n++) {
      const work = dealIdeas(rows, wearIndex([], TODAY), { ...opts, occasion: 'work', seed: `w|${n}` }).flatMap(i => i.core)
      expect(work).not.toContain('gym')
      const off = dealIdeas(rows, wearIndex([], TODAY), { ...opts, occasion: 'personal', seed: `o|${n}` }).flatMap(i => i.core)
      expect(off).not.toContain('suit')
      expect(off).not.toContain('slacks')
    }
    // a day off with only work tops has no look to offer
    expect(dealIdeas(rowsOf([suit, jeans]), wearIndex([], TODAY), { ...opts, occasion: 'personal', seed: 'x' })).toEqual([])
  })

  it('puts the day’s coat on every look, and deals a one-piece as a look of its own', () => {
    const mac = piece('mac', 'outerwear')
    const dress = piece('dress', 'onepiece')
    const ideas = dealIdeas(rowsOf([tops[0], bottoms[0], dress, mac]), wearIndex([], TODAY), { ...opts, coat: mac, seed: 'c' })
    expect(ideas.map(i => i.ids.at(-1))).toEqual(['mac', 'mac'])
    expect(ideas.map(i => i.core.join('+')).sort()).toEqual(['dress', 't1+b1'])
    // only one-pieces: one-piece looks
    expect(dealIdeas(rowsOf([dress, piece('jumpsuit', 'onepiece')]), wearIndex([], TODAY), { ...opts, seed: 'o' }).map(i => i.core)).toHaveLength(2)
  })

  it('deals the same looks from the same seed, and New ideas three others while the wardrobe has them', () => {
    const rows = rowsOf([...tops, ...bottoms, piece('t5', 'top'), piece('t6', 'top'), piece('b4', 'bottom'), piece('b5', 'bottom'), piece('b6', 'bottom')])
    const ix = wearIndex([], TODAY)
    const first = dealIdeas(rows, ix, { ...opts, seed: 'ideas|0' })
    expect(dealIdeas(rows, ix, { ...opts, seed: 'ideas|0' })).toEqual(first)
    const next = dealIdeas(rows, ix, { ...opts, seed: 'ideas|1', last: first.map(i => i.key), avoid: first.flatMap(i => i.core) })
    expect(next).toHaveLength(3)
    // six tops and six bottoms: none of the three before, and no piece of theirs either
    expect(next.map(i => i.key).filter(k => first.some(f => f.key === k))).toEqual([])
    expect(next.flatMap(i => i.core).filter(id => first.some(f => f.core.includes(id)))).toEqual([])
  })
})

describe('the day line’s weather', () => {
  it('says the high and the sky in a word to dress by, and a wet day’s chance when the sky does not', () => {
    expect(dayWeather({ tempC: 84, hiC: 91, loC: 70, rainPct: 5, code: 0, unit: '°F' })).toBe('91° and sunny')
    expect(dayWeather({ tempC: 5, hiC: 8, loC: 2, rainPct: 80, code: 61, unit: '°C' })).toBe('8° and rainy')
    expect(dayWeather({ tempC: 60, hiC: 64, loC: 50, rainPct: 60, code: 3, unit: '°F' })).toBe('64° and overcast · rain 60%')
    expect(dayWeather({ tempC: 60, hiC: 64, loC: 50, rainPct: 0, code: 42, unit: '°F' })).toBe('64°')
  })
})

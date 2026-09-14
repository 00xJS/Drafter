import { afterEach, describe, expect, it, vi } from 'vitest'
import { visitSummary } from '../people'
import { Garment, GarmentType, Outfit, Wear } from '../types'
import { dateKey } from '../utils'
import {
  NEVER_WORN_GRACE_DAYS,
  NOT_WORN_DAYS,
  byRest,
  canDress,
  clothesOrder,
  colorName,
  coreKey,
  forgotYesterday,
  garmentStats,
  liveById,
  logLook,
  looksOn,
  middayOf,
  mostWorn,
  neverWorn,
  newWear,
  notInUse,
  notWornLately,
  orderPieces,
  outfitDays,
  outfitLabel,
  outfitLine,
  pieceKey,
  renamed,
  repeatedOutfits,
  retired,
  saveOutfit,
  savedOrder,
  suggestedNames,
  swappedPhotos,
  todaySuggestions,
  unwearable,
  wardrobeTiles,
  wardrobeYearReport,
  wearId,
  wearIndex,
  wearable,
  wearsByMonth,
  withPieces,
  wornLine,
  wornShort,
} from '../wardrobe'

// The wardrobe's rules and figures (src/wardrobe.ts): the writers' stamps,
// what makes two looks one outfit, and every number the Clothes, Stats and
// Today screens will show — counted in distinct local days.

const T0 = '2026-08-01T09:00:00.000Z'
const TODAY = '2026-09-14'

/** The day key `n` days before `from` (after, when negative). */
function ago(n: number, from = TODAY): string {
  const [y, m, d] = from.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10)
}

function piece(id: string, type: GarmentType, over: Partial<Garment> = {}): Garment {
  return { kind: 'garment', id, name: id, type, createdAt: T0, updatedAt: T0, ...over }
}

let looks = 0
function look(date: string, garmentIds: string[], over: Partial<Wear> = {}): Wear {
  looks++
  return { kind: 'wear', id: `wear~${date}~${String(looks).padStart(10, '0')}`, date, garmentIds, createdAt: `${date}T08:00:00.000Z`, updatedAt: `${date}T08:00:00.000Z`, ...over }
}

function outfit(id: string, garmentIds: string[], over: Partial<Outfit> = {}): Outfit {
  return { kind: 'outfit', id, garmentIds, createdAt: T0, updatedAt: T0, ...over }
}

const tee = piece('tee', 'top')
const shirt = piece('shirt', 'top')
const jeans = piece('jeans', 'bottom')
const chinos = piece('chinos', 'bottom')
const dress = piece('dress', 'onepiece')
const coat = piece('coat', 'outerwear')
const trainers = piece('trainers', 'shoes')
const boots = piece('boots', 'shoes')
const scarf = piece('scarf', 'accessory')
const watch = piece('watch', 'accessory')
const everything = [tee, shirt, jeans, chinos, dress, coat, trainers, boots, scarf, watch]

afterEach(() => {
  vi.useRealTimers()
})

describe('ids and writers', () => {
  it('gives a look an id with its day and ten random characters, like a journal entry’s', () => {
    expect(wearId(TODAY)).toMatch(/^wear~2026-09-14~.{10}$/)
    expect(wearId(TODAY)).not.toBe(wearId(TODAY))
    const w = newWear(TODAY, ['tee', 'jeans', 'tee', ' '], '2026-09-14T08:00:00.000Z')
    expect(w.id).toMatch(/^wear~\d{4}-\d{2}-\d{2}~.{10}$/)
    expect(w).toMatchObject({ kind: 'wear', date: TODAY, garmentIds: ['tee', 'jeans'], createdAt: '2026-09-14T08:00:00.000Z', updatedAt: '2026-09-14T08:00:00.000Z' })
  })

  it('stamps every edit strictly newer than the copy it was made on, even one from the future', () => {
    vi.useFakeTimers({ now: new Date('2026-09-14T08:00:00.000Z') })
    // another device's clock, ten minutes fast
    const future = '2026-09-14T08:10:00.000Z'
    const g = piece('tee', 'top', { updatedAt: future })
    const edits = [
      withPieces(look(TODAY, ['tee', 'jeans'], { updatedAt: future }), ['shirt', 'jeans']),
      renamed(g, 'Navy tee'),
      renamed(outfit('o1', ['tee', 'jeans'], { updatedAt: future }), 'Friday'),
      retired(g, true),
      retired({ ...g, archivedAt: T0 }, false),
    ]
    for (const next of edits) expect(next.updatedAt > future, next.id).toBe(true)
    // behind the clock, the clock's own time
    expect(withPieces(look(TODAY, ['tee'], { updatedAt: T0 }), ['shirt']).updatedAt).toBe('2026-09-14T08:00:00.000Z')
  })

  it('renames and retires the way the piece sheet will', () => {
    const g = piece('tee', 'top', { name: 'White tee' })
    expect(renamed(g, '  Navy tee  ').name).toBe('Navy tee')
    expect(renamed(g, '   ').name).toBe('Top')
    expect(renamed(outfit('o1', ['tee', 'jeans'], { name: 'Friday' }), '').name).toBeUndefined()
    expect(retired(g, true, '2026-09-14T08:00:00.000Z').archivedAt).toBe('2026-09-14T08:00:00.000Z')
    // retired already: the first date stays
    expect(retired({ ...g, archivedAt: T0 }, true).archivedAt).toBe(T0)
    expect('archivedAt' in retired({ ...g, archivedAt: T0 }, false)).toBe(false)
    expect(withPieces(look(TODAY, ['tee']), ['tee', 'tee', ' jeans ']).garmentIds).toEqual(['tee', 'jeans'])
  })

  it('saves an outfit once: the same pieces in another order reuse it', () => {
    const first = saveOutfit([], ['tee', 'jeans'], undefined, T0)
    expect(first.reused).toBe(false)
    expect(first.outfit).toMatchObject({ kind: 'outfit', garmentIds: ['tee', 'jeans'], createdAt: T0, updatedAt: T0 })
    expect(first.outfit.name).toBeUndefined()
    expect(saveOutfit([first.outfit], ['jeans', 'tee'], 'Friday')).toEqual({ outfit: first.outfit, reused: true })
    // a deleted one is not in the way, and one more piece is another outfit
    expect(saveOutfit([{ ...first.outfit, deletedAt: T0 }], ['jeans', 'tee']).reused).toBe(false)
    expect(saveOutfit([first.outfit], ['tee', 'jeans', 'trainers']).reused).toBe(false)
    expect(saveOutfit([], ['tee', 'jeans'], '  Friday smart ').outfit.name).toBe('Friday smart')
  })

  it('lists a day’s live looks oldest first, so the last is the one “Wearing this” edits', () => {
    const morning = look(TODAY, ['tee'], { createdAt: '2026-09-14T07:00:00.000Z' })
    const evening = look(TODAY, ['shirt'], { createdAt: '2026-09-14T18:00:00.000Z' })
    const binned = look(TODAY, ['dress'], { createdAt: '2026-09-14T19:00:00.000Z', deletedAt: '2026-09-14T19:30:00.000Z' })
    expect(looksOn([evening, binned, morning, look(ago(1), ['tee'])], TODAY)).toEqual([morning, evening])
    expect(looksOn([evening, morning], ago(1))).toEqual([])
  })
})

describe('identity', () => {
  const byId = liveById(everything)

  it('liveById keeps retired pieces and drops deleted and purged ones', () => {
    const map = liveById([tee, piece('old', 'top', { archivedAt: T0 }), piece('binned', 'top', { deletedAt: T0 }), piece('purged', 'top', { deletedAt: T0, purged: true })])
    expect([...map.keys()]).toEqual(['tee', 'old'])
  })

  it('orders pieces by slot, stable within one, and drops unknown ids', () => {
    expect(orderPieces(['watch', 'trainers', 'jeans', 'ghost', 'shirt', 'tee', 'coat', 'scarf'], byId)).toEqual(['shirt', 'tee', 'jeans', 'coat', 'trainers', 'watch', 'scarf'])
  })

  it('pieceKey ignores order and repeats', () => {
    expect(pieceKey(['jeans', 'tee'])).toBe('jeans+tee')
    expect(pieceKey(['tee', 'jeans', 'tee'])).toBe('jeans+tee')
  })

  it('coreKey is a top and a bottom, or a one-piece; shoes, outerwear and accessories never change it', () => {
    expect(coreKey(['tee', 'jeans'], byId)).toBe('jeans+tee')
    expect(coreKey(['trainers', 'jeans', 'coat', 'tee', 'scarf'], byId)).toBe('jeans+tee')
    expect(coreKey(['dress'], byId)).toBe('dress')
    expect(coreKey(['dress', 'boots', 'coat'], byId)).toBe('dress')
    expect(coreKey(['shirt', 'tee', 'jeans'], byId)).toBe('jeans+shirt+tee')
    expect(coreKey(['tee'], byId)).toBeNull()
    expect(coreKey(['tee', 'trainers', 'coat'], byId)).toBeNull()
    // an id the wardrobe no longer knows is no part of the core
    expect(coreKey(['tee', 'ghost'], byId)).toBeNull()
    expect(coreKey(['tee', 'jeans', 'ghost'], byId)).toBe('jeans+tee')
  })

  it('canDress needs a live, unretired top and bottom, or a one-piece', () => {
    expect(canDress([tee, jeans])).toBe(true)
    expect(canDress([dress])).toBe(true)
    expect(canDress([tee, coat, trainers, scarf])).toBe(false)
    expect(canDress([tee, { ...jeans, archivedAt: T0 }])).toBe(false)
    expect(canDress([tee, { ...jeans, deletedAt: T0 }])).toBe(false)
    expect(canDress([])).toBe(false)
  })

  it('outfitLabel names the core first, three at most, then how many more', () => {
    const named = liveById([
      piece('tee', 'top', { name: 'White tee' }),
      piece('jeans', 'bottom', { name: 'Black jeans' }),
      piece('coat', 'outerwear', { name: 'Mac' }),
      piece('trainers', 'shoes', { name: 'Trainers' }),
      piece('scarf', 'accessory', { name: 'Scarf' }),
    ])
    expect(outfitLabel(['jeans', 'tee'], named)).toBe('White tee + Black jeans')
    expect(outfitLabel(['scarf', 'trainers', 'jeans', 'coat', 'tee'], named)).toBe('White tee + Black jeans + Mac + 2 more')
    expect(outfitLabel(['ghost', 'jeans'], named)).toBe('Black jeans')
    expect(outfitLabel(['ghost', 'gone'], named)).toBe('Pieces since deleted')
    expect(outfitLabel([], named)).toBe('Pieces since deleted')
  })
})

describe('wearIndex', () => {
  it('counts days, not looks, and skips deleted, empty and future looks', () => {
    const ix = wearIndex(
      [
        look(TODAY, ['tee', 'jeans'], { createdAt: '2026-09-14T07:00:00.000Z' }),
        // an evening change: the same day, not a second time
        look(TODAY, ['tee', 'chinos'], { createdAt: '2026-09-14T18:00:00.000Z' }),
        look(ago(2), ['jeans', 'tee']),
        look(ago(3), []),
        look(ago(4), ['shirt'], { deletedAt: T0 }),
        // tomorrow, from a clock that runs ahead
        look(ago(-1), ['dress']),
      ],
      TODAY,
    )
    expect(ix.dayKey).toBe(TODAY)
    expect(ix.logged).toEqual([TODAY, ago(2)])
    expect(ix.days.get('tee')).toEqual([TODAY, ago(2)])
    expect(ix.days.get('jeans')).toEqual([TODAY, ago(2)])
    expect(ix.days.get('chinos')).toEqual([TODAY])
    expect(ix.days.has('shirt')).toBe(false)
    expect(ix.days.has('dress')).toBe(false)
    expect(ix.looks.get(TODAY)!.map(w => w.garmentIds)).toEqual([
      ['tee', 'jeans'],
      ['tee', 'chinos'],
    ])
  })

  it('files a day at its local midday', () => {
    const at = new Date(middayOf('2026-12-31'))
    expect(at.getHours()).toBe(12)
    expect(dateKey(at)).toBe('2026-12-31')
  })
})

describe('a piece’s line, in the Kitchen’s words', () => {
  const ix = wearIndex(
    [
      look(TODAY, ['tee']),
      look(ago(1), ['shirt']),
      ...[5, 8, 11, 15, 40].map(n => look(ago(n), ['jeans'])),
      ...[21, 30].map(n => look(ago(n), ['chinos'])),
      ...[12, 20, 30, 40, 50].map(n => look(ago(n), ['coat'])),
    ],
    TODAY,
  )

  it('wornLine reads when it was last worn and how many days in all', () => {
    expect(wornLine(ix, 'tee')).toBe('Last worn today · 1 time')
    expect(wornLine(ix, 'shirt')).toBe('Last worn yesterday · 1 time')
    expect(wornLine(ix, 'jeans')).toBe('Last worn 5 days ago · 5 times')
    expect(wornLine(ix, 'chinos')).toBe('Last worn 3 weeks ago · 2 times')
    expect(wornLine(ix, 'coat')).toBe('Last worn 12 days ago · 5 times')
    expect(wornLine(ix, 'dress')).toBe('Not worn yet')
  })

  it('wornShort is the card’s few words, or “new”', () => {
    expect(wornShort(ix, 'tee')).toBe('today')
    expect(wornShort(ix, 'jeans')).toBe('5 days ago')
    expect(wornShort(ix, 'chinos')).toBe('3 weeks ago')
    expect(wornShort(ix, 'dress')).toBe('new')
  })
})

describe('garmentStats', () => {
  it('counts days worn, the first and last, those in 30 and 365 days, and the weekly bars People and Places draw', () => {
    const now = new Date(2026, 8, 14, 9)
    const days = [TODAY, ago(3), ago(10), ago(29), ago(30), ago(200), ago(400)]
    const ix = wearIndex(
      days.map(d => look(d, ['tee'])),
      TODAY,
    )
    const stats = garmentStats(tee, ix, now)
    expect(stats).toMatchObject({ timesWorn: 7, lastWorn: TODAY, firstWorn: ago(400), in30: 4, in365: 6 })
    expect(stats.weekly).toEqual(visitSummary(days.map(d => ({ at: middayOf(d) })), now).weekly)
    expect(stats.weekly).toHaveLength(12)
    expect(stats.weekly.reduce((a, b) => a + b, 0)).toBe(5)
    expect(garmentStats(dress, ix, now)).toEqual({ timesWorn: 0, lastWorn: undefined, firstWorn: undefined, in30: 0, in365: 0, weekly: Array(12).fill(0) })
  })
})

describe('mostWorn', () => {
  it('counts day keys inside the window, so the list is the same in the morning and the afternoon', () => {
    const wears = [look(ago(29), ['tee']), look(ago(30), ['jeans'])]
    vi.useFakeTimers()
    const at = (hour: number) => {
      vi.setSystemTime(new Date(2026, 8, 14, hour))
      return mostWorn([tee, jeans], wearIndex(wears, dateKey(new Date())), 30)
    }
    const morning = at(8)
    expect(at(16)).toEqual(morning)
    expect(morning.map(r => r.garment.id)).toEqual(['tee'])
    // the millisecond line visitSummary draws moves 30 days ago out of the window at midday
    const count30 = (hour: number) => visitSummary([{ at: middayOf(ago(30)) }], new Date(2026, 8, 14, hour)).count30
    expect([count30(8), count30(16)]).toEqual([1, 0])
  })

  it('ranks by days worn, then the latest, then the name; retired pieces count, deleted ones do not', () => {
    const garments = [piece('a', 'top'), piece('b', 'top', { archivedAt: T0 }), piece('c', 'bottom'), piece('d', 'bottom', { deletedAt: T0 }), piece('e', 'shoes')]
    const ix = wearIndex([look(ago(1), ['a', 'c', 'd']), look(ago(2), ['b', 'c', 'd']), look(ago(3), ['b']), look(ago(40), ['e', 'a']), look(ago(400), ['e'])], TODAY)
    const ranked = (window: 30 | 365 | 'all', limit?: number) => mostWorn(garments, ix, window, limit).map(r => [r.garment.id, r.count, r.lastWorn])
    expect(ranked(30)).toEqual([
      ['c', 2, ago(1)],
      ['b', 2, ago(2)],
      ['a', 1, ago(1)],
    ])
    expect(ranked(365).map(r => r[0])).toEqual(['a', 'c', 'b', 'e'])
    expect(ranked('all')).toEqual([
      ['a', 2, ago(1)],
      ['c', 2, ago(1)],
      ['b', 2, ago(2)],
      ['e', 2, ago(40)],
    ])
    expect(ranked('all', 2).map(r => r[0])).toEqual(['a', 'c'])
  })
})

describe('not worn lately, never worn', () => {
  it('not worn lately: 60 days or more, worn before, live and unretired, the longest rested first', () => {
    expect(NOT_WORN_DAYS).toBe(60)
    const garments = [
      piece('fresh', 'top'),
      piece('rested', 'top'),
      piece('older', 'bottom'),
      piece('retired', 'top', { archivedAt: T0 }),
      piece('binned', 'top', { deletedAt: T0 }),
      piece('never', 'top'),
    ]
    const ix = wearIndex([look(ago(59), ['fresh']), look(ago(60), ['rested']), look(ago(90), ['older', 'retired', 'binned'])], TODAY)
    expect(notWornLately(garments, ix).map(g => g.id)).toEqual(['older', 'rested'])
    expect(notWornLately(garments, ix, 90).map(g => g.id)).toEqual(['older'])
  })

  it('never worn: waits 7 local days after a piece is added, then lists the oldest first', () => {
    expect(NEVER_WORN_GRACE_DAYS).toBe(7)
    const added = (n: number) => middayOf(ago(n))
    const garments = [
      piece('six', 'top', { createdAt: added(6) }),
      piece('seven', 'top', { createdAt: added(7) }),
      piece('old', 'bottom', { createdAt: added(100) }),
      piece('worn', 'top', { createdAt: added(100) }),
      piece('retired', 'top', { createdAt: added(100), archivedAt: T0 }),
      piece('binned', 'top', { createdAt: added(100), deletedAt: T0 }),
    ]
    const ix = wearIndex([look(ago(3), ['worn'])], TODAY)
    expect(neverWorn(garments, ix).map(g => g.id)).toEqual(['old', 'seven'])
    expect(neverWorn(garments, ix, 0).map(g => g.id)).toEqual(['old', 'seven', 'six'])
  })
})

describe('by month', () => {
  it('counts days logged and days worn per month, with the 90-against-90-day trend', () => {
    const now = new Date(2026, 8, 14, 9)
    const ix = wearIndex([look(ago(10), ['tee', 'jeans']), look(ago(10), ['tee', 'chinos']), look(ago(20), ['tee']), look(ago(30), ['tee', 'jeans']), look(ago(120), ['jeans'])], TODAY)
    const year = wearsByMonth(ix, 2026, now)
    // 17 May, 15 and 25 August, 4 September: two looks on the 4th are one day
    expect(year.months.slice(4, 9)).toEqual([1, 0, 0, 2, 1])
    expect(year.total).toBe(4)
    // three days in the last 90, one in the 90 before
    expect(year.trend).toBe(2)
    const report = wardrobeYearReport([tee, jeans, chinos, coat, { ...dress, deletedAt: T0 }], ix, 2026, now)
    expect(report.map(r => [r.garment.id, r.total, r.trend])).toEqual([
      ['jeans', 3, 1],
      ['tee', 3, 3],
      ['chinos', 1, 1],
    ])
  })

  it('keeps a look on 31 December in its own year east of UTC+11', () => {
    const tz = process.env.TZ
    process.env.TZ = 'Pacific/Auckland'
    try {
      const now = new Date(2026, 8, 13, 12)
      const ix = wearIndex([look('2025-12-31', ['tee']), look('2026-01-31', ['tee']), look('2026-01-01', ['tee', 'jeans'])], '2026-09-13')
      const last = wearsByMonth(ix, 2025, now)
      expect(last.months[11]).toBe(1)
      expect(last.total).toBe(1)
      const thisYear = wearsByMonth(ix, 2026, now)
      expect(thisYear.months.slice(0, 2)).toEqual([2, 0])
      expect(thisYear.total).toBe(2)
      const [row] = wardrobeYearReport([tee, jeans], ix, 2025, now)
      expect(row.garment.id).toBe('tee')
      expect(row.months[11]).toBe(1)
      expect(wardrobeYearReport([tee, jeans], ix, 2026, now).map(r => [r.garment.id, r.months[0]])).toEqual([
        ['tee', 2],
        ['jeans', 1],
      ])
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })

  it('keeps a look on the 1st of a month in its own month west of UTC, where a UTC midnight is the day before', () => {
    const tz = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      // the zone is in force: 2026-01-01 at UTC midnight is the evening of 31 December here
      expect(new Date(Date.parse('2026-01-01')).getMonth()).toBe(11)
      const now = new Date(2026, 8, 13, 12)
      const ix = wearIndex([look('2026-01-01', ['tee']), look('2026-03-01', ['tee', 'jeans'])], '2026-09-13')
      const year = wearsByMonth(ix, 2026, now)
      expect(year.months.slice(0, 3)).toEqual([1, 0, 1])
      expect(year.total).toBe(2)
      expect(wearsByMonth(ix, 2025, now).total).toBe(0)
      expect(wardrobeYearReport([tee, jeans], ix, 2026, now).map(r => [r.garment.id, r.months.slice(0, 3)])).toEqual([
        ['tee', [1, 0, 1]],
        ['jeans', [0, 0, 1]],
      ])
      expect(wardrobeYearReport([tee, jeans], ix, 2025, now)).toEqual([])
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })

  it('never worn: counts the week’s grace in local days either side of UTC', () => {
    const tz = process.env.TZ
    try {
      // Kiritimati's midday is 22:00 UTC the day before; Los Angeles's evening is 03:00 UTC the day after
      for (const [zone, hour] of [
        ['Pacific/Kiritimati', 12],
        ['America/Los_Angeles', 20],
      ] as const) {
        process.env.TZ = zone
        const addedAt = (n: number) => {
          const [y, m, d] = ago(n).split('-').map(Number)
          return new Date(y, m - 1, d, hour).toISOString()
        }
        // the ISO string's own date is not the local day, so reading it would be a day out
        expect(addedAt(6).slice(0, 10), zone).not.toBe(ago(6))
        const garments = [piece('six', 'top', { createdAt: addedAt(6) }), piece('seven', 'top', { createdAt: addedAt(7) })]
        expect(neverWorn(garments, wearIndex([], TODAY)).map(g => g.id), zone).toEqual(['seven'])
      }
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })
})

describe('repeatedOutfits', () => {
  const byId = liveById(everything)

  it('groups looks by their core: shoes never split one, it takes two days, and a saved outfit is linked', () => {
    const wears = [
      look(ago(1), ['tee', 'jeans', 'trainers']),
      look(ago(3), ['tee', 'jeans', 'boots']),
      look(ago(5), ['jeans', 'tee']),
      look(ago(2), ['dress', 'boots']),
      look(ago(9), ['dress']),
      look(ago(4), ['shirt', 'chinos']),
      look(ago(6), ['tee']),
    ]
    const friday = outfit('friday', ['jeans', 'tee', 'boots'], { name: 'Friday' })
    const ix = wearIndex(wears, TODAY)
    const rows = repeatedOutfits(ix, byId, [friday])
    expect(rows.map(r => [r.key, r.days, r.lastWorn])).toEqual([
      ['jeans+tee', 3, ago(1)],
      ['dress', 2, ago(2)],
    ])
    // the newest such look's pieces, in slot order
    expect(rows[0].garmentIds).toEqual(['tee', 'jeans', 'trainers'])
    expect(rows[0].outfit).toBe(friday)
    expect(rows[1].outfit).toBeUndefined()
    expect(repeatedOutfits(ix, byId, [friday], 1).map(r => r.key)).toEqual(['jeans+tee', 'dress', 'chinos+shirt'])
  })

  it('counts two looks with one core on the same day once', () => {
    const ix = wearIndex([look(ago(1), ['tee', 'jeans']), look(ago(1), ['tee', 'jeans', 'coat'])], TODAY)
    expect(repeatedOutfits(ix, byId, [])).toEqual([])
  })

  it('lets a purged piece drop out: a shoe from the pieces shown, a top from the combination itself', () => {
    const ix = wearIndex([look(ago(1), ['tee', 'jeans', 'trainers']), look(ago(2), ['tee', 'jeans', 'trainers'])], TODAY)
    const noTrainers = liveById(everything.filter(g => g.id !== 'trainers'))
    expect(repeatedOutfits(ix, noTrainers, []).map(r => [r.key, r.garmentIds])).toEqual([['jeans+tee', ['tee', 'jeans']]])
    expect(repeatedOutfits(ix, liveById(everything.filter(g => g.id !== 'tee')), [])).toEqual([])
  })
})

describe('outfitLine', () => {
  it('counts the days with any look of its core, in three wordings', () => {
    const byId = liveById([tee, jeans, trainers, boots])
    const friday = outfit('friday', ['tee', 'jeans', 'trainers'])
    const ix = wearIndex([look(ago(14), ['tee', 'jeans', 'boots']), look(ago(20), ['tee', 'jeans']), look(ago(20), ['tee', 'jeans', 'trainers']), look(ago(30), ['jeans', 'tee']), look(ago(40), ['tee'])], TODAY)
    expect(outfitLine(friday, ix, byId)).toBe('Worn 3 times · last 2 weeks ago')
    expect(outfitLine(friday, wearIndex([], TODAY), byId)).toBe('Not worn yet')
    expect(outfitLine(friday, ix, liveById([jeans, trainers]))).toBe('A piece was deleted')
    expect(outfitLine(friday, wearIndex([look(TODAY, ['tee', 'jeans'])], TODAY), byId)).toBe('Worn 1 time · today')
    expect(outfitLine(friday, wearIndex([look(ago(1), ['tee', 'jeans'])], TODAY), byId)).toBe('Worn 1 time · yesterday')
    // a saved outfit with no core to count (an older client's) is simply unworn
    expect(outfitLine(outfit('shoes', ['trainers', 'boots']), ix, byId)).toBe('Not worn yet')
  })
})

describe('todaySuggestions', () => {
  const oldTop = piece('old-top', 'top', { archivedAt: T0 })
  const garments = [tee, shirt, jeans, chinos, dress, trainers, oldTop]
  const byId = liveById(garments)
  const wears = [
    look(ago(1), ['tee', 'jeans', 'trainers']),
    look(ago(2), ['tee', 'jeans']),
    look(ago(3), ['shirt', 'chinos']),
    look(ago(4), ['shirt', 'chinos']),
    look(ago(5), ['tee', 'jeans']),
    look(ago(6), ['dress']),
    // a retired top is never offered
    look(ago(7), ['old-top', 'jeans']),
    // outside the 60 days: no score
    look(ago(70), ['dress']),
    // today's own look does not count toward today's chips
    look(TODAY, ['shirt', 'jeans']),
  ]
  const ix = wearIndex(wears, TODAY)
  const friday = outfit('friday', ['shirt', 'chinos', 'trainers'], { name: 'Friday smart' })
  const sunday = outfit('sunday', ['dress', 'trainers'], { name: 'Sunday' })

  it('ranks by days worn in the last 60, then the latest; a saved outfit lends its pieces and name; three at most', () => {
    const chips = todaySuggestions(ix, [friday, sunday], byId)
    expect(chips).toEqual([
      { key: 'jeans+tee', garmentIds: ['tee', 'jeans', 'trainers'], label: 'tee + jeans + trainers', reason: 'often' },
      { key: 'chinos+shirt', garmentIds: ['shirt', 'chinos', 'trainers'], label: 'Friday smart', reason: 'saved' },
      { key: 'dress', garmentIds: ['dress', 'trainers'], label: 'Sunday', reason: 'saved' },
    ])
    // the same answer on every call: nothing random
    expect(todaySuggestions(ix, [friday, sunday], byId)).toEqual(chips)
    expect(todaySuggestions(ix, [friday, sunday], byId, 1)).toEqual(chips.slice(0, 1))
  })

  it('offers only what can be worn whole: a retired piece, or a saved outfit that lost its core, leaves', () => {
    const teeRetired = liveById(garments.map(g => (g.id === 'tee' ? { ...g, archivedAt: T0 } : g)))
    expect(todaySuggestions(ix, [friday, sunday], teeRetired).map(s => s.key)).toEqual(['chinos+shirt', 'dress'])
    const noDress = liveById(garments.filter(g => g.id !== 'dress'))
    expect(todaySuggestions(ix, [friday, sunday], noDress).map(s => s.key)).toEqual(['jeans+tee', 'chinos+shirt'])
    // when a core's newest look has a retired piece in it, the newest look wearable whole stands in
    const withOldShoes = liveById([...garments, piece('old-shoes', 'shoes', { archivedAt: T0 })])
    const newest = wearIndex([look(ago(1), ['tee', 'jeans', 'old-shoes']), look(ago(2), ['tee', 'jeans', 'trainers'])], TODAY)
    expect(todaySuggestions(newest, [], withOldShoes)).toEqual([{ key: 'jeans+tee', garmentIds: ['tee', 'jeans', 'trainers'], label: 'tee + jeans + trainers', reason: 'often' }])
  })

  it('offers saved outfits to a wardrobe with nothing logged yet, by name', () => {
    expect(todaySuggestions(wearIndex([], TODAY), [sunday, friday], byId).map(s => [s.label, s.reason])).toEqual([
      ['Friday smart', 'saved'],
      ['Sunday', 'saved'],
    ])
    expect(todaySuggestions(wearIndex([], TODAY), [], byId)).toEqual([])
  })
})

describe('names from a colour', () => {
  it('colorName picks the nearest of 13 names', () => {
    expect(colorName('#1f2a44')).toBe('navy')
    expect(colorName('#f5f5f0')).toBe('white')
    expect(colorName('#7a4a2a')).toBe('brown')
    expect(colorName('#111111')).toBe('black')
    expect(colorName('#808080')).toBe('grey')
    expect(colorName('#c0392b')).toBe('red')
    expect(colorName('#2e7d32')).toBe('green')
    expect(colorName('#F5F5F0')).toBe('white')
    expect(colorName('navy')).toBe('')
  })

  it('suggestedNames offers the colour first, then the plain type', () => {
    expect(suggestedNames('top', '#1f2a44')).toEqual(['Navy top', 'Top'])
    expect(suggestedNames('onepiece', '#f5f5f0')).toEqual(['White one-piece', 'One-piece'])
    expect(suggestedNames('shoes', '#7a4a2a')).toEqual(['Brown shoes', 'Shoes'])
    expect(suggestedNames('bottom')).toEqual(['Bottom'])
    expect(suggestedNames('bottom', 'nope')).toEqual(['Bottom'])
  })
})

describe('the orders the composer and Clothes lead with', () => {
  it('byRest: never worn first, the oldest added first, then the longest rested; retired and deleted left out', () => {
    const early = piece('early', 'top', { createdAt: '2026-07-01T09:00:00.000Z' })
    const late = piece('late', 'top', { createdAt: '2026-09-01T09:00:00.000Z' })
    const ix = wearIndex([look(ago(2), ['tee']), look(ago(30), ['shirt'])], TODAY)
    const gone = piece('gone', 'top', { deletedAt: T0 })
    const old = piece('old', 'top', { archivedAt: T0 })
    expect(byRest([tee, shirt, late, early, gone, old], ix).map(g => g.id)).toEqual(['early', 'late', 'shirt', 'tee'])
  })

  it('clothesOrder: rest order by default, then most worn, newest and A–Z, retired pieces included', () => {
    const coatRetired = piece('a-coat', 'outerwear', { createdAt: '2026-09-10T09:00:00.000Z', archivedAt: T0 })
    const newChinos = piece('chinos', 'bottom', { createdAt: '2026-09-12T09:00:00.000Z' })
    const gone = piece('gone', 'top', { deletedAt: T0 })
    const all = [tee, jeans, newChinos, coatRetired, gone]
    const ix = wearIndex([look(ago(1), ['tee']), look(ago(2), ['tee', 'jeans']), look(ago(40), ['jeans'])], TODAY)
    const ids = (sort: Parameters<typeof clothesOrder>[2]) => clothesOrder(all, ix, sort).map(g => g.id)
    expect(ids('rest')).toEqual(['a-coat', 'chinos', 'jeans', 'tee'])
    // two days each: the one worn more lately first
    expect(ids('most')).toEqual(['tee', 'jeans', 'a-coat', 'chinos'])
    expect(ids('newest')).toEqual(['chinos', 'a-coat', 'jeans', 'tee'])
    expect(ids('name')).toEqual(['a-coat', 'chinos', 'jeans', 'tee'])
  })

  it('wardrobeTiles: pieces in use, the days logged this month so far, and pieces worn in the last 90 days', () => {
    const ix = wearIndex([look(TODAY, ['tee', 'jeans']), look('2026-09-01', ['shirt', 'jeans']), look('2026-08-31', ['chinos', 'coat']), look(ago(95), ['dress'])], TODAY)
    expect(wardrobeTiles([...everything, piece('old', 'top', { archivedAt: T0 })], ix)).toEqual({ pieces: 10, loggedThisMonth: 2, daysThisMonth: 14, wornLately: 5 })
  })
})

describe('logLook: what a log writes, and what its Undo puts back', () => {
  const shownAll = new Set(everything.map(g => g.id))

  it('writes a new look on a day with none, and Undo removes it', () => {
    const { write, undo } = logLook([], TODAY, ['tee', 'jeans'], everything, { now: '2026-09-14T08:00:00.000Z' })
    expect(write).toMatchObject({ kind: 'wear', date: TODAY, garmentIds: ['tee', 'jeans'], createdAt: '2026-09-14T08:00:00.000Z' })
    expect(undo).toEqual({ remove: write.id })
  })

  it('edits the day’s latest look under its own id, strictly newer, and Undo writes the copy back newer still', () => {
    vi.useFakeTimers({ now: new Date('2026-09-14T08:00:00.000Z') })
    const first = look(TODAY, ['tee', 'jeans'], { createdAt: '2026-09-14T07:00:00.000Z' })
    // stamped by another device whose clock runs ten minutes fast
    const latest = look(TODAY, ['shirt', 'jeans'], { createdAt: '2026-09-14T07:30:00.000Z', updatedAt: '2026-09-14T08:10:00.000Z' })
    const { write, undo } = logLook([first, latest], TODAY, ['shirt', 'chinos'], everything, { shown: shownAll })
    expect(write.id).toBe(latest.id)
    expect(write.garmentIds).toEqual(['shirt', 'chinos'])
    expect(write.updatedAt > latest.updatedAt).toBe(true)
    expect(undo).toMatchObject({ id: latest.id, garmentIds: ['shirt', 'jeans'] })
    expect((undo as Wear).updatedAt > write.updatedAt).toBe(true)
  })

  it('writes a second look with `another`, and leaves the first alone', () => {
    const morning = look(TODAY, ['tee', 'jeans'])
    const { write, undo } = logLook([morning], TODAY, ['shirt', 'chinos'], everything, { another: true, shown: shownAll })
    expect(write.id).not.toBe(morning.id)
    expect(write).toMatchObject({ date: TODAY, garmentIds: ['shirt', 'chinos'] })
    expect(undo).toEqual({ remove: write.id })
  })

  it('keeps what the screen did not show — a piece in Trash, a retired one, an id with no record — and drops what it showed', () => {
    const binned = piece('binned-scarf', 'accessory', { deletedAt: T0 })
    const oldShoes = piece('old-shoes', 'shoes', { archivedAt: T0 })
    const day = look(ago(3), ['tee', 'jeans', 'binned-scarf', 'old-shoes', 'ghost'])
    // by default the screen is the composer's rows: every live, unretired piece
    expect(logLook([day], ago(3), ['tee', 'chinos'], [...everything, binned, oldShoes]).write.garmentIds).toEqual(['tee', 'chinos', 'binned-scarf', 'old-shoes', 'ghost'])
    const shown = look(ago(4), ['tee', 'jeans', 'scarf'])
    expect(logLook([shown], ago(4), ['tee', 'jeans'], everything, { shown: new Set(['tee', 'jeans', 'scarf']) }).write.garmentIds).toEqual(['tee', 'jeans'])
  })

  it('lets a piece chosen now take a hidden piece’s slot, so a Restore never finds two tops', () => {
    const binnedTop = piece('binned-top', 'top', { deletedAt: T0 })
    const day = look(ago(3), ['binned-top', 'jeans', 'scarf'])
    const all = [...everything, binnedTop]
    const hidden = new Set<string>()
    expect(logLook([day], ago(3), ['shirt', 'jeans'], all, { shown: hidden }).write.garmentIds).toEqual(['shirt', 'jeans', 'scarf'])
    expect(logLook([day], ago(3), ['dress'], all, { shown: hidden }).write.garmentIds).toEqual(['dress', 'scarf'])
    // an accessory takes nobody's place
    expect(logLook([day], ago(3), ['watch'], all, { shown: hidden }).write.garmentIds).toEqual(['watch', 'binned-top', 'jeans', 'scarf'])
  })
})

describe('the piece sheet’s Wear today: a log of one piece that shows none of today’s look', () => {
  const wear = (ids: string[], id: string) => logLook([look(TODAY, ids)], TODAY, [id], everything, { shown: new Set() }).write.garmentIds

  it('takes its slot, stands a one-piece in for a top and a bottom, and adds an accessory', () => {
    expect(wear(['tee', 'jeans', 'trainers'], 'shirt')).toEqual(['shirt', 'jeans', 'trainers'])
    expect(wear(['tee', 'jeans', 'trainers'], 'dress')).toEqual(['dress', 'trainers'])
    expect(wear(['dress', 'boots'], 'jeans')).toEqual(['jeans', 'boots'])
    expect(wear(['tee', 'jeans', 'scarf'], 'watch')).toEqual(['watch', 'tee', 'jeans', 'scarf'])
    expect(wear(['tee', 'jeans', 'trainers'], 'boots')).toEqual(['boots', 'tee', 'jeans'])
    // already in the look: still once
    expect(wear(['tee', 'jeans'], 'tee')).toEqual(['tee', 'jeans'])
    // an id with no record stays: a piece deleted forever takes nothing with it
    expect(wear(['gone-top', 'jeans'], 'shirt')).toEqual(['shirt', 'gone-top', 'jeans'])
    // nothing on today: a look of its own
    expect(logLook([], TODAY, ['shirt'], everything, { shown: new Set() }).write.garmentIds).toEqual(['shirt'])
  })

  it('never lets a full look drop the piece being added', () => {
    const full = Array.from({ length: 12 }, (_, i) => `acc-${i}`)
    const added = wear(full, 'watch')
    expect(added).toHaveLength(12)
    expect(added[0]).toBe('watch')
  })
})

describe('what can be worn as it is', () => {
  const oldTop = piece('old-top', 'top', { name: 'Old band tee', archivedAt: T0 })
  const mac = piece('mac', 'outerwear', { name: 'Mac', archivedAt: T0 })
  const byId = liveById([...everything, oldTop, mac])

  it('wearable: every piece live and unretired, and a top and a bottom or a one-piece among them — the Today chips’ rule', () => {
    expect(wearable(['tee', 'jeans', 'trainers'], byId)).toBe(true)
    expect(wearable(['dress'], byId)).toBe(true)
    expect(wearable(['old-top', 'jeans'], byId)).toBe(false)
    expect(wearable(['tee', 'jeans', 'mac'], byId)).toBe(false)
    expect(wearable(['tee', 'jeans', 'ghost'], byId)).toBe(false)
    expect(wearable(['tee', 'trainers'], byId)).toBe(false)
    expect(wearable([], byId)).toBe(false)
  })

  it('notInUse names what is retired, and says when a piece was deleted', () => {
    expect(notInUse(['tee', 'jeans'], byId)).toBe('')
    expect(notInUse(['old-top', 'jeans'], byId)).toBe('Old band tee is retired')
    expect(notInUse(['old-top', 'mac'], byId)).toBe('Old band tee and Mac are retired')
    expect(notInUse(['ghost', 'tee'], byId)).toBe('A piece was deleted')
    expect(notInUse(['old-top', 'ghost'], byId)).toBe('Old band tee is retired · A piece was deleted')
  })

  it('unwearable says why not, or nothing when it can be worn', () => {
    expect(unwearable(['tee', 'jeans'], byId)).toBeNull()
    expect(unwearable(['old-top', 'jeans'], byId)).toBe('Old band tee is retired')
    expect(unwearable(['tee', 'trainers'], byId)).toBe('It needs a top and a bottom, or a one-piece')
  })
})

describe('saved outfits and Forgot yesterday', () => {
  const byId = liveById(everything)

  it('outfitDays: the days with a look of its core, newest first; none once its core is gone', () => {
    const ix = wearIndex([look(ago(1), ['tee', 'jeans', 'boots']), look(ago(3), ['tee', 'chinos']), look(ago(5), ['tee', 'jeans'])], TODAY)
    expect(outfitDays(outfit('o', ['tee', 'jeans', 'trainers']), ix, byId)).toEqual([ago(1), ago(5)])
    expect(outfitDays(outfit('p', ['tee', 'purged-bottom']), ix, byId)).toEqual([])
  })

  it('savedOrder: the most worn in the last 60 days first, then the newest saved; deleted ones left out', () => {
    const a = outfit('a', ['tee', 'jeans'], { createdAt: '2026-08-01T09:00:00.000Z' })
    const b = outfit('b', ['shirt', 'chinos'], { createdAt: '2026-09-01T09:00:00.000Z' })
    const c = outfit('c', ['dress'], { createdAt: '2026-09-05T09:00:00.000Z' })
    const d = outfit('d', ['tee', 'chinos'], { createdAt: '2026-09-06T09:00:00.000Z', deletedAt: '2026-09-07T09:00:00.000Z' })
    const ix = wearIndex(
      [look(ago(2), ['tee', 'jeans']), look(ago(4), ['tee', 'jeans']), look(ago(70), ['shirt', 'chinos']), look(ago(71), ['shirt', 'chinos']), look(ago(72), ['shirt', 'chinos']), look(ago(10), ['dress'])],
      TODAY,
    )
    expect(savedOrder([b, a, c, d], ix, byId).map(o => o.id)).toEqual(['a', 'c', 'b'])
  })

  it('forgotYesterday: before noon, when yesterday is empty and an earlier day is not', () => {
    const earlier = wearIndex([look(ago(2), ['tee', 'jeans'])], TODAY)
    expect(forgotYesterday(earlier, 9)).toBe(ago(1))
    expect(forgotYesterday(earlier, 11)).toBe(ago(1))
    expect(forgotYesterday(earlier, 12)).toBeNull()
    expect(forgotYesterday(wearIndex([], TODAY), 9)).toBeNull()
    expect(forgotYesterday(wearIndex([look(ago(1), ['tee', 'jeans']), look(ago(2), ['tee'])], TODAY), 9)).toBeNull()
    // today alone is not an earlier day
    expect(forgotYesterday(wearIndex([look(TODAY, ['tee', 'jeans'])], TODAY), 9)).toBeNull()
    // an empty look is no look
    expect(forgotYesterday(wearIndex([look(ago(1), []), look(ago(3), ['tee'])], TODAY), 9)).toBe(ago(1))
    // across the new year
    expect(forgotYesterday(wearIndex([look('2026-12-30', ['tee'])], '2027-01-01'), 8)).toBe('2026-12-31')
  })
})

describe('swappedPhotos: what a write did to a piece’s photos', () => {
  const P = (n: number) => `personal/00000000-0000-0000-0000-00000000000a/${String(n).repeat(8)}`

  it('Replace photo lets go of both old ids and points at the two new ones; its Undo is the same swap back', () => {
    const before = piece('tee', 'top', { photoId: P(1), thumbId: P(2) })
    const after = { ...before, photoId: P(3), thumbId: P(4) }
    expect(swappedPhotos(before, after)).toEqual({ gone: [P(1), P(2)], now: [P(3), P(4)] })
    expect(swappedPhotos(after, before)).toEqual({ gone: [P(3), P(4)], now: [P(1), P(2)] })
  })

  it('lets go of nothing a write kept: a rename, a retire, a first photo, the half that did not change', () => {
    const g = piece('tee', 'top', { photoId: P(1), thumbId: P(2) })
    expect(swappedPhotos(g, renamed(g, 'Old tee')).gone).toEqual([])
    expect(swappedPhotos(g, retired(g, true)).gone).toEqual([])
    const bare = piece('scarf', 'accessory')
    expect(swappedPhotos(bare, { ...bare, photoId: P(3), thumbId: P(4) })).toEqual({ gone: [], now: [P(3), P(4)] })
    expect(swappedPhotos(g, { ...g, photoId: P(5) })).toEqual({ gone: [P(1)], now: [P(5), P(2)] })
  })
})

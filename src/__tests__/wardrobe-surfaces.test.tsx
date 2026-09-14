import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AskSources, buildAskPrompt, buildCorpus, factsFor, parseQuestion, prepareAsk } from '../ask'
import { formatMoney } from '../bills'
import { Calendar, CalendarView } from '../components/Calendar'
import { Review } from '../components/Review'
import { wardrobeHits } from '../components/Search'
import { OutfitComposer } from '../components/wardrobe/OutfitComposer'
import { Wardrobe } from '../components/wardrobe/Wardrobe'
import { WardrobeStats } from '../components/wardrobe/WardrobeStats'
import type { Garment, GarmentType, Outfit, Recipe, Wear } from '../types'
import {
  coreKey,
  wardrobeCosts,
  garmentTags,
  isPlanned,
  liveById,
  lookCalendar,
  lookOn,
  wearIndex,
  wearStreaks,
  wornBetween,
  yourUniform,
} from '../wardrobe'
import { plannerSource } from './source'

// The wardrobe beyond Home → Wardrobe: the palette finds pieces and saved
// outfits, Ask draws on what was worn, the Calendar and the Week review show
// each day's look, and Stats gains its streaks, a photo calendar, a podium,
// your uniform and cost per wear. Every figure counts days, and a planned look
// never counts as one worn.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const noop = () => {}
const text = (html: string) => html.replace(/<!-- -->/g, '')
const T0 = '2026-08-01T09:00:00.000Z'
/** A Monday. */
const TODAY = '2026-09-14'

const piece = (id: string, type: GarmentType, over: Partial<Garment> = {}): Garment => ({ kind: 'garment', id, name: id, type, createdAt: T0, updatedAt: T0, ...over })
let made = 0
/** A look on a day; a later call on the same day is the later look. */
const look = (date: string, garmentIds: string[], over: Partial<Wear> = {}): Wear => {
  made++
  return { kind: 'wear', id: `wear~${date}~${String(made).padStart(10, '0')}`, date, garmentIds, createdAt: `${date}T08:00:00.000Z`, updatedAt: `${date}T08:00:00.000Z`, ...over }
}
const outfit = (id: string, garmentIds: string[], name?: string, over: Partial<Outfit> = {}): Outfit => ({ kind: 'outfit', id, name, garmentIds, createdAt: T0, updatedAt: T0, ...over })
/** The day key `n` days before TODAY. */
function ago(n: number, from = TODAY): string {
  const [y, m, d] = from.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10)
}
/** A row as a later build may write it: with fields this build's types do not name. */
const withExtra = <T,>(row: T, extra: Record<string, unknown>): T => ({ ...row, ...extra }) as T

afterEach(() => {
  vi.useRealTimers()
})

const at = (d: Date) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(d)
}

describe('one check for a planned look', () => {
  it('counts a planned look nowhere, and every look as worn while no row says otherwise', () => {
    const planned = withExtra(look(ago(1), ['tee', 'jeans']), { planned: true })
    const worn = look(ago(2), ['tee', 'jeans'])
    expect(isPlanned(planned)).toBe(true)
    expect(isPlanned(worn)).toBe(false)
    expect(isPlanned(withExtra(worn, { planned: 'yes' }))).toBe(false)
    const ix = wearIndex([planned, worn], TODAY)
    expect(ix.logged).toEqual([ago(2)])
    expect(ix.days.get('tee')).toEqual([ago(2)])
    expect(ix.looks.has(ago(1))).toBe(false)
  })

  it('is asked in the one place every figure is read from', () => {
    // the shared rules the app and MCP both read: wearIndex asks it, and nothing else there does
    const shared = read('../../shared/wardrobe.mjs')
    const index = shared.slice(shared.indexOf('export function wearIndex'), shared.indexOf('// ---- the lists'))
    expect(index).toContain('isPlanned(w)')
    expect(shared.match(/\bisPlanned\(/g)).toHaveLength(1)
    // and the app's own rules never read the flag but through it
    expect(read('../wardrobe.ts')).not.toMatch(/\.planned\b/)
  })
})

describe('a piece’s tags', () => {
  it('reads them when a row carries them, trimmed and each once; none otherwise', () => {
    expect(garmentTags(piece('a', 'top'))).toEqual([])
    expect(garmentTags(withExtra(piece('a', 'top'), { tags: [' linen ', 'summer', 'linen', 3, ''] }))).toEqual(['linen', 'summer'])
    expect(garmentTags(withExtra(piece('a', 'top'), { tags: 'linen' }))).toEqual([])
  })
})

describe('a day’s look, and days logged in a row', () => {
  it('gives a day its latest look and how many it holds', () => {
    const first = look(ago(1), ['tee'])
    const second = look(ago(1), ['jeans'])
    const ix = wearIndex([second, first], TODAY)
    expect(lookOn(ix, ago(1))).toEqual({ look: second, looks: 2 })
    expect(lookOn(ix, ago(2))).toBeUndefined()
  })

  it('runs to today, two looks on a day being one day, and keeps the best run apart', () => {
    const ix = wearIndex([look(ago(0), ['tee']), look(ago(1), ['tee']), look(ago(1), ['jeans']), ...[3, 4, 5, 6].map(n => look(ago(n), ['tee']))], TODAY)
    expect(wearStreaks(ix)).toEqual({ current: 2, best: 4 })
  })

  it('waits for today rather than breaking, and ends once yesterday is missed too', () => {
    expect(wearStreaks(wearIndex([look(ago(1), ['tee']), look(ago(2), ['tee'])], TODAY))).toEqual({ current: 2, best: 2 })
    expect(wearStreaks(wearIndex([look(ago(2), ['tee']), look(ago(3), ['tee'])], TODAY))).toEqual({ current: 0, best: 2 })
    expect(wearStreaks(wearIndex([], TODAY))).toEqual({ current: 0, best: 0 })
  })

  it('never counts a planned look in a run', () => {
    const ix = wearIndex([withExtra(look(ago(0), ['tee']), { planned: true }), look(ago(1), ['tee'])], TODAY)
    expect(wearStreaks(ix)).toEqual({ current: 1, best: 1 })
  })
})

describe('the photo calendar’s month', () => {
  it('lays a month out as whole Sunday-to-Saturday weeks, each day with its latest look', () => {
    const ix = wearIndex([look('2026-09-01', ['tee']), look('2026-09-14', ['jeans']), look('2026-09-14', ['tee', 'jeans'])], TODAY)
    const cells = lookCalendar(ix, 2026, 9)
    // Tuesday 1 September: Sunday and Monday before it are padding
    expect(cells).toHaveLength(35)
    expect(cells.slice(0, 2).map(c => c.day)).toEqual([null, null])
    expect(cells[2]).toMatchObject({ day: '2026-09-01', looks: 1 })
    expect(cells[15]).toMatchObject({ day: '2026-09-14', looks: 2 })
    expect(cells[15].look?.garmentIds).toEqual(['tee', 'jeans'])
    expect(cells.filter(c => c.day)).toHaveLength(30)
    expect(cells.filter(c => c.look).map(c => c.day)).toEqual(['2026-09-01', '2026-09-14'])
  })

  it('pads nothing for a month that starts on a Sunday and fills its weeks', () => {
    const feb = lookCalendar(wearIndex([], TODAY), 2026, 2)
    expect(feb).toHaveLength(28)
    expect(feb[0].day).toBe('2026-02-01')
    expect(feb[27].day).toBe('2026-02-28')
  })
})

describe('your uniform', () => {
  const g = [piece('tee', 'top'), piece('jeans', 'bottom'), piece('trainers', 'shoes'), piece('mac', 'outerwear'), piece('watch', 'accessory'), piece('shirt', 'top')]
  const byId = liveById(g)
  const ws = [
    look(ago(1), ['tee', 'jeans', 'trainers', 'watch']),
    look(ago(2), ['tee', 'jeans', 'trainers']),
    look(ago(3), ['tee', 'jeans', 'mac']),
    look(ago(4), ['shirt', 'jeans']),
  ]

  it('is the combination repeated most, with its share of the logged days and what usually goes with it', () => {
    const u = yourUniform(wearIndex(ws, TODAY), byId, [])!
    expect(u.key).toBe(coreKey(['tee', 'jeans'], byId))
    expect(u.days).toBe(3)
    expect(u.share).toBeCloseTo(3 / 4)
    // worn on at least half its days: the trainers on two of three; the watch and the mac once each
    expect(u.usually.map(x => x.id)).toEqual(['trainers'])
    expect(u.outfit).toBeUndefined()
  })

  it('names the saved outfit with the same core, and is nothing until a combination is worn twice', () => {
    expect(yourUniform(wearIndex(ws, TODAY), byId, [outfit('o', ['jeans', 'tee'], 'Weekend')])!.outfit?.name).toBe('Weekend')
    expect(yourUniform(wearIndex([ws[3]], TODAY), byId, [])).toBeNull()
  })
})

describe('cost per wear', () => {
  it('divides each price by the days worn, best value first and the never worn last, over the pieces with a price', () => {
    const g = [
      piece('coat', 'outerwear', { price: 120 }),
      piece('tee', 'top', { price: 10 }),
      piece('new', 'top', { price: 40 }),
      piece('free', 'top'),
      piece('trashed', 'top', { price: 99, deletedAt: T0 }),
      piece('old', 'top', { price: 30, archivedAt: T0 }),
      piece('odd', 'top', { price: -5 }),
    ]
    const ws = [look(ago(1), ['coat', 'tee']), look(ago(2), ['tee']), look(ago(3), ['coat', 'tee', 'old']), look(ago(3), ['tee'])]
    const cost = wardrobeCosts(g, wearIndex(ws, TODAY))
    expect(cost.rows.map(r => r.garment.id)).toEqual(['tee', 'old', 'coat', 'new'])
    // two looks on one day are one wear
    expect(cost.rows.map(r => r.wears)).toEqual([3, 1, 2, 0])
    expect(cost.rows[0].perWear).toBeCloseTo(10 / 3)
    expect(cost.rows[2].perWear).toBe(60)
    expect(cost.rows[3].perWear).toBeUndefined()
    expect(cost.spent).toBe(200)
    expect(cost.wears).toBe(6)
    expect(cost.perWear).toBeCloseTo(200 / 6)
  })

  it('has nothing to say with no prices, or no wears', () => {
    expect(wardrobeCosts([piece('tee', 'top')], wearIndex([look(ago(1), ['tee'])], TODAY)).rows).toEqual([])
    expect(wardrobeCosts([piece('tee', 'top', { price: 10 })], wearIndex([], TODAY)).perWear).toBeUndefined()
  })
})

describe('a week of the wardrobe, for the Week review', () => {
  const g = [piece('tee', 'top'), piece('shirt', 'top'), piece('jeans', 'bottom'), piece('chinos', 'bottom')]

  it('lists each day with a look, oldest first, and the piece worn on the most of them', () => {
    // an evening change: made after the day's first look
    const later = look('2026-09-08', ['tee', 'jeans'], { createdAt: '2026-09-08T18:00:00.000Z' })
    const ws = [look('2026-09-06', ['tee', 'jeans']), look('2026-09-07', ['tee', 'chinos']), look('2026-09-08', ['shirt', 'jeans']), later, look('2026-09-13', ['tee', 'jeans'])]
    const week = wornBetween(g, wearIndex(ws, TODAY), '2026-09-06', '2026-09-13')
    expect(week.days.map(d => d.day)).toEqual(['2026-09-06', '2026-09-07', '2026-09-08'])
    expect(week.days[2]).toMatchObject({ look: later, looks: 2 })
    expect(week.top?.garment.id).toBe('tee')
    expect(week.top?.days).toBe(3)
  })

  it('names no most worn when nothing was worn twice, and breaks a tie by the latest worn', () => {
    const once = [look('2026-09-06', ['tee', 'jeans']), look('2026-09-07', ['shirt', 'chinos'])]
    expect(wornBetween(g, wearIndex(once, TODAY), '2026-09-06', '2026-09-13').top).toBeUndefined()
    const tie = [look('2026-09-06', ['tee', 'jeans']), look('2026-09-07', ['tee', 'chinos']), look('2026-09-08', ['shirt', 'jeans'])]
    expect(wornBetween(g, wearIndex(tie, TODAY), '2026-09-06', '2026-09-13').top?.garment.id).toBe('jeans')
  })
})

describe('the palette finds clothes and saved outfits', () => {
  const g = [
    piece('navy-tee', 'top', { name: 'Navy tee' }),
    withExtra(piece('linen', 'top', { name: 'Linen shirt' }), { tags: ['summer', 'holiday'] }),
    piece('jumper', 'top', { name: 'Old navy jumper', archivedAt: T0 }),
    piece('socks', 'accessory', { name: 'Navy socks', deletedAt: T0 }),
    piece('chinos', 'bottom', { name: 'Chinos' }),
  ]
  const o = [outfit('friday', ['linen', 'chinos'], 'Friday smart'), outfit('plain', ['navy-tee', 'chinos']), outfit('gone', ['navy-tee'], 'Navy day', { deletedAt: T0 })]

  it('finds a piece by its name, ranking a retired one below one in use, and never one in Trash', () => {
    const hits = wardrobeHits(g, [], 'navy').sort((a, b) => b.score - a.score)
    expect(hits.map(h => (h.kind === 'garment' ? h.garment.id : h.outfit.id))).toEqual(['navy-tee', 'jumper'])
    expect(hits.every(h => h.kind === 'garment' && h.where === '')).toBe(true)
  })

  it('finds a piece by a tag, and says which', () => {
    const [hit] = wardrobeHits(g, [], 'summer')
    expect(hit).toMatchObject({ kind: 'garment', where: 'tagged summer' })
    expect(hit.kind === 'garment' && hit.garment.id).toBe('linen')
  })

  it('finds a saved outfit by its name, or an unnamed one by its pieces, below the piece itself', () => {
    expect(wardrobeHits(g, o, 'friday')).toEqual([expect.objectContaining({ kind: 'outfit', label: 'Friday smart' })])
    const navy = wardrobeHits(g, o, 'navy')
    const plain = navy.find(h => h.kind === 'outfit')!
    expect(plain).toMatchObject({ label: 'Navy tee + Chinos' })
    expect(plain.score).toBeLessThan(navy.find(h => h.kind === 'garment' && h.garment.id === 'navy-tee')!.score)
    // the deleted outfit is left out
    expect(navy.filter(h => h.kind === 'outfit')).toHaveLength(1)
  })

  it('names an unnamed outfit by its pieces where only outfits open, and never finds one by "Pieces since deleted"', () => {
    const outfitsOnly = wardrobeHits(g, o, 'navy', { pieces: false })
    expect(outfitsOnly).toEqual([expect.objectContaining({ kind: 'outfit', label: 'Navy tee + Chinos' })])
    const orphan = outfit('orphan', ['gone-1', 'gone-2'])
    for (const word of ['pieces', 'since', 'deleted']) expect(wardrobeHits(g, [orphan], word)).toEqual([])
  })

  it('opens a piece on its sheet and an outfit in today’s rows, from the shell', () => {
    const shell = plannerSource()
    expect(shell).toContain('garments={store.garments}')
    expect(shell).toContain('outfits={store.outfits}')
    expect(shell).toContain("onOpenGarment={g => openWardrobe({ tab: 'clothes', garmentId: g.id })}")
    expect(shell).toContain('onOpenOutfit={o => openWardrobe({ outfitId: o.id, date: today })}')
  })
})

describe('a saved outfit asked for from outside goes in the composer’s rows', () => {
  const tops = ['navy-tee', 'white-shirt', 'grey-tee', 'black-tee', 'blue-shirt'].map(id => piece(id, 'top'))
  const bottoms = ['jeans', 'chinos', 'shorts', 'cords', 'joggers'].map(id => piece(id, 'bottom'))
  const garments = [...tops, ...bottoms]
  /** The names on the chosen cards, row by row. */
  const chosenNames = (html: string) => [...html.matchAll(/aria-checked="true"[^>]*class="snap-card">[\s\S]*?class="snap-name">([^<]+)</g)].map(m => m[1])
  const wardrobe = (open: ComponentProps<typeof Wardrobe>['open'], outfits: Outfit[]) =>
    renderToStaticMarkup(<Wardrobe garments={garments} outfits={outfits} wears={[]} onSave={noop} onRemove={noop} onRestore={noop} showToast={noop} open={open} onOpenConsumed={noop} />)

  it('from the palette: Outfit, on today, with the outfit’s pieces chosen', () => {
    at(new Date(2026, 8, 14, 10))
    const saved = outfit('o1', ['white-shirt', 'chinos'], 'Office')
    const html = wardrobe({ outfitId: 'o1', date: TODAY }, [saved])
    expect(html).toContain('aria-selected="true" class="seg on">Outfit</button>')
    expect(chosenNames(html)).toEqual(['white-shirt', 'chinos'])
    // without it the rows start on their first cards
    expect(chosenNames(wardrobe({ date: TODAY }, [saved]))).toEqual(['black-tee', 'chinos'])
  })

  it('opens the rows as usual when that outfit is gone', () => {
    at(new Date(2026, 8, 14, 10))
    expect(chosenNames(wardrobe({ outfitId: 'o1' }, [outfit('o1', ['white-shirt', 'chinos'], undefined, { deletedAt: T0 })]))).toEqual(['black-tee', 'chinos'])
  })

  it('the composer puts a pending outfit in once and hands it back as used', () => {
    const html = renderToStaticMarkup(
      <OutfitComposer
        garments={garments}
        outfits={[]}
        wears={[]}
        byId={liveById(garments)}
        ix={wearIndex([], TODAY)}
        day={TODAY}
        todayKey={TODAY}
        onDay={noop}
        onLog={noop}
        onRemoveLook={noop}
        onSaveOutfit={noop}
        onAdd={noop}
        onOpenPiece={noop}
        onWearOutfit={noop}
        onFavouriteOutfit={noop}
        onRenameOutfit={noop}
        onDeleteOutfit={noop}
        pending={['grey-tee', 'jeans']}
        onPendingUsed={noop}
      />,
    )
    expect(chosenNames(html)).toEqual(['grey-tee', 'jeans'])
    const src = read('../components/wardrobe/OutfitComposer.tsx')
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!pending\) return\s*setSel\(s => load\(s, pending, rows, byId\)\)\s*onPendingUsed\?\.\(\)/)
    // after the day's own look, so the outfit is what shows
    expect(src.indexOf('}, [pending])')).toBeGreaterThan(src.indexOf('}, [day])'))
  })
})

describe('Ask draws on what you wear', () => {
  // Monday 14 September 2026, local time
  const now = new Date(2026, 8, 14, 10)
  const garments = [
    piece('id-tee', 'top', { name: 'Navy tee', price: 20, notes: 'Ring 07700 900123 about the other colour' }),
    piece('id-jeans', 'bottom', { name: 'Black jeans' }),
    piece('id-mac', 'outerwear', { name: 'Grey mac' }),
    piece('id-band', 'top', { name: 'Band tee', archivedAt: T0 }),
    piece('id-never', 'top', { name: 'Yellow shirt' }),
    piece('id-lost', 'top', { name: 'Lost scarf', deletedAt: T0 }),
  ]
  const wears = [
    look('2026-09-12', ['id-tee', 'id-jeans']),
    look('2026-09-08', ['id-tee', 'id-jeans']),
    // a day whose only piece was deleted forever
    look('2026-09-10', ['id-purged']),
    // a planned look is not a day worn
    withExtra(look('2026-09-13', ['id-tee']), { planned: true }),
    // more than 90 days back: its piece's line still counts it
    look('2026-06-01', ['id-mac', 'id-band', 'id-jeans']),
  ]
  const src = (over: Partial<AskSources> = {}): AskSources => ({
    tasks: [],
    projects: [],
    people: [],
    places: [],
    recipes: [],
    meals: [],
    entries: [],
    feedEvents: [],
    journal: [],
    garments,
    outfits: [],
    wears,
    ...over,
  })

  it('lists every piece and 90 days of looks, with the Journal chip off', () => {
    const docs = buildCorpus(src(), { now, includeJournal: false, includeAmounts: false })
    const pieces = docs.filter(d => d.kind === 'garment')
    expect(pieces.map(d => d.title).sort()).toEqual(['Band tee', 'Black jeans', 'Grey mac', 'Navy tee', 'Yellow shirt'])
    expect(pieces.every(d => /^C\d+$/.test(d.ref))).toBe(true)
    const tee = pieces.find(d => d.title === 'Navy tee')!
    expect(tee.text).toBe('top · worn on 2 days · last worn 2026-09-12 · first worn 2026-09-08')
    // a piece's notes are something you wrote: they never go, chip or no chip
    for (const d of buildCorpus(src(), { now, includeJournal: true, includeAmounts: true })) expect(`${d.title} ${d.text}`).not.toMatch(/Ring|07700|\[phone\]|other colour/)
    expect(pieces.find(d => d.title === 'Band tee')!.text).toMatch(/^top · retired · worn on 1 day/)
    expect(pieces.find(d => d.title === 'Yellow shirt')!.text).toBe('top · not worn yet')
    const looks = docs.filter(d => d.kind === 'wear')
    expect(looks.map(d => [d.ref, d.date])).toEqual([
      ['W1', '2026-09-12'],
      ['W2', '2026-09-08'],
    ])
    expect(looks[0]).toMatchObject({ title: 'Navy tee + Black jeans', text: 'worn on 2026-09-12 · pieces: Navy tee, Black jeans' })
    expect(looks[0].links).toEqual(expect.arrayContaining(['id-tee', 'id-jeans']))
  })

  it('sends a price, and the cost per wear, only for a question about money', () => {
    const plain = buildCorpus(src(), { now, includeJournal: false, includeAmounts: false }).find(d => d.title === 'Navy tee')!
    expect(plain.text).not.toContain('price')
    const money = buildCorpus(src(), { now, includeJournal: false, includeAmounts: true }).find(d => d.title === 'Navy tee')!
    expect(money.text).toContain(`price ${formatMoney(20)}`)
    expect(money.text).toContain(`cost per wear ${formatMoney(10)}`)
    // a price the Stats' cost per wear would not use is no price here either
    for (const price of [0, -5, Number.NaN]) {
      const odd = src({ garments: garments.map(g => (g.id === 'id-tee' ? { ...g, price } : g)) })
      expect(buildCorpus(odd, { now, includeJournal: false, includeAmounts: true }).find(d => d.title === 'Navy tee')!.text).not.toMatch(/price|cost per wear/)
    }
  })

  it('names a day by its latest look that still has a piece', () => {
    const docs = buildCorpus(src({ wears: [look('2026-09-05', ['id-tee', 'id-jeans']), look('2026-09-05', ['id-purged'])] }), { now, includeJournal: false, includeAmounts: false })
    expect(docs.filter(d => d.kind === 'wear')).toEqual([expect.objectContaining({ date: '2026-09-05', title: 'Navy tee + Black jeans', text: 'worn on 2026-09-05 · pieces: Navy tee, Black jeans' })])
  })

  it('has no wardrobe to draw on when it is given none', () => {
    const docs = buildCorpus(src({ garments: undefined, outfits: undefined, wears: undefined }), { now, includeJournal: true, includeAmounts: true })
    expect(docs.filter(d => d.kind === 'garment' || d.kind === 'wear')).toEqual([])
    expect(parseQuestion('What did I wear?', src({ garments: undefined }), now).garmentIds).toEqual([])
  })

  it('reads a question about clothes, and a piece named by its whole name', () => {
    const q = parseQuestion('When did I last wear my navy tee?', src(), now)
    expect(q.intents.has('wardrobe')).toBe(true)
    expect(q.garmentIds).toEqual(['id-tee'])
    expect(q.wantsLatest).toBe(true)
    expect(parseQuestion('What outfit did I wear on Saturday?', src(), now).intents.has('wardrobe')).toBe(true)
    expect(parseQuestion('When did I last see Mum?', src(), now).intents.has('wardrobe')).toBe(false)
  })

  it('answers "when did I last wear…" with the latest look first, and the piece’s own figures', () => {
    const prep = prepareAsk('When did I last wear my navy tee?', src(), { now, tz: 'Europe/London', includeJournal: false })
    expect(prep.docs[0]).toMatchObject({ kind: 'wear', date: '2026-09-12' })
    expect(prep.docs.some(d => d.kind === 'garment' && d.title === 'Navy tee')).toBe(true)
    expect(prep.facts).toContain('Navy tee: worn on 2 days, last 2026-09-12 (2 days ago); first worn 2026-09-08.')
    expect(prep.journalHint).toBe(false)
  })

  it('gives a question about clothes the Stats’ own figures', () => {
    const facts = factsFor(parseQuestion('What have I not worn lately?', src(), now), src(), now, 'Europe/London')
    expect(facts).toContain('Most worn in the last 30 days: Black jeans (2 days), Navy tee (2 days).')
    expect(facts).toContain('Not worn in 60 days or more: Grey mac (last 2026-06-01).')
    expect(facts).toContain('Never worn: Yellow shirt.')
    expect(facts).toContain('Most repeated outfit: Navy tee + Black jeans, on 2 days, last 2026-09-12.')
    // the retired piece is history, not a nudge
    expect(facts.join(' ')).not.toContain('Band tee')
  })

  it('keeps the wardrobe out of a question about something else', () => {
    const facts = factsFor(parseQuestion('When did I last see Mum?', src(), now), src(), now, 'Europe/London')
    expect(facts.some(f => /worn/i.test(f))).toBe(false)
  })

  const clothesIn = (docs: { kind: string }[]) => docs.filter(d => d.kind === 'garment' || d.kind === 'wear')

  it('takes "my top 3" to be about something else, whatever a piece is called', () => {
    // a piece saved with no name is left with its type's: Top
    const s = src({ garments: [...garments, piece('id-top', 'top', { name: 'Top' })], wears: [...wears, look('2026-09-11', ['id-top', 'id-jeans'])] })
    const q = parseQuestion('What were my top 3 last week?', s, now)
    expect(q.garmentIds).toEqual([])
    expect(q.intents.has('wardrobe')).toBe(false)
    const prep = prepareAsk('What were my top 3 last week?', s, { now, tz: 'Europe/London', includeJournal: false })
    expect(prep.facts.some(f => /worn|Top:/.test(f))).toBe(false)
    // not the piece called Top, not a top by its type, and not a look for falling in last week
    expect(clothesIn(prep.docs)).toEqual([])
    // "worn on 2 days" is no answer to how a day went
    expect(clothesIn(prepareAsk('How was my day yesterday?', s, { now, tz: 'Europe/London', includeJournal: false }).docs)).toEqual([])
    // asked about clothes, Top is the piece
    expect(parseQuestion('Which top did I wear most?', s, now).garmentIds).toEqual(['id-top'])
  })

  it('still finds a piece by a word of its own name in a question about something else', () => {
    const docs = prepareAsk('Which jeans are black?', src(), { now, tz: 'Europe/London', includeJournal: false }).docs
    expect(docs.some(d => d.kind === 'garment' && d.title === 'Black jeans')).toBe(true)
    expect(docs.some(d => d.kind === 'garment' && d.title === 'Navy tee')).toBe(false)
  })

  it('never sends a real id, and tells the model clothes are part of the planner', () => {
    const prep = prepareAsk('What did I wear last week?', src(), { now, tz: 'Europe/London', includeJournal: false })
    expect(prep.docs.some(d => d.kind === 'wear')).toBe(true)
    const { system, prompt } = buildAskPrompt('What did I wear last week?', prep.docs, prep.facts)
    expect(`${system}\n${prompt}`).not.toMatch(/id-|wear~/)
    expect(system).toContain('bills, clothes and journal')
  })

  it('is wired: the sheet gets the wardrobe whatever the Journal chip says, and a citation opens it', () => {
    const shell = plannerSource()
    expect(shell).toMatch(/journal: store\.journal,\s*garments: store\.garments,\s*outfits: store\.outfits,\s*wears: store\.wears,/)
    expect(shell).toContain("else if (doc.kind === 'garment') openWardrobe({ tab: 'clothes', garmentId: doc.id })")
    expect(shell).toContain("else if (doc.kind === 'wear') openWardrobe({ date: doc.date })")
  })
})

describe('the Calendar shows a day’s look', () => {
  const garments = [piece('tee', 'top', { name: 'Navy tee' }), piece('jeans', 'bottom', { name: 'Black jeans' })]
  const wears = [look('2026-09-10', ['tee', 'jeans']), look('2026-09-12', ['tee']), look('2026-09-12', ['tee', 'jeans'])]
  const render = (view: CalendarView, wardrobe: Partial<ComponentProps<typeof Calendar>> = { garments, wears, onOpenWardrobe: noop }) =>
    text(
      renderToStaticMarkup(
        <Calendar
          view={view}
          tasks={[]}
          projects={[]}
          projectMap={new Map()}
          people={[]}
          meals={[]}
          recipes={[]}
          places={[]}
          events={[]}
          sourceMap={new Map()}
          onOpen={noop}
          onNew={noop}
          onSaveMeal={noop}
          onClearMeal={noop}
          onCreatePlace={() => ({}) as never}
          onCreateRecipe={() => ({}) as Recipe}
          onNewEvent={noop}
          onEditEvent={noop}
          onReschedule={noop}
          onPlan={noop}
          onAttendance={noop}
          onOpenProject={noop}
          onPlanOccasion={noop}
          {...wardrobe}
        />,
      ),
    )

  it('as one small line under a day in the week list: what was worn, and how many looks', () => {
    // Saturday 12 September 2026: the week of 6–12 September
    at(new Date(2026, 8, 12, 9))
    const html = render('week')
    const lines = [...html.matchAll(/<button type="button" class="cal-look"[^>]*>[\s\S]*?<\/button>/g)].map(m => m[0])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('<span class="muted">Wore</span> Navy tee + Black jeans')
    // today reads as now, and the day's second look is counted
    expect(lines[1]).toContain('<span class="muted">Wearing</span> Navy tee + Black jeans')
    expect(lines[1]).toContain('<span class="cal-look-more">2 looks</span>')
    expect(lines[1]).toMatch(/aria-label="Wearing Navy tee \+ Black jeans, and 1 more look: open the wardrobe on [^"]+"/)
  })

  it('not in the month grid, where a phone’s day cell has no room for it', () => {
    at(new Date(2026, 8, 12, 9))
    expect(render('month')).not.toContain('cal-look')
  })

  it('only when the shell hands it the wardrobe and a way in', () => {
    at(new Date(2026, 8, 12, 9))
    expect(render('week', { garments, wears })).not.toContain('cal-look')
    expect(render('week', {})).not.toContain('cal-look')
  })

  it('in the day sheet too, above its rows, and the shell passes what it needs', () => {
    const src = read('../components/Calendar.tsx')
    expect(src).toMatch(/<div className="cal-sheet-body">\s*\{lookLine\(sheetDay\)\}/)
    expect(src).toMatch(/<\/div>\s*\{lookLine\(d\)\}\s*\{items\.length > 0 && <ul className="cal-daylist">/)
    const screen = read('../components/planner/CalendarScreen.tsx')
    for (const prop of ['garments={store.garments}', 'wears={store.wears}', 'onOpenWardrobe={openWardrobe}']) expect(screen).toContain(prop)
  })
})

describe('the Week review shows what you wore', () => {
  const garments = [piece('tee', 'top', { name: 'Navy tee' }), piece('shirt', 'top', { name: 'White shirt' }), piece('jeans', 'bottom', { name: 'Black jeans' }), piece('chinos', 'bottom', { name: 'Chinos' })]
  const wears = [look('2026-09-12', ['tee', 'jeans']), look('2026-09-13', ['tee', 'jeans']), look('2026-09-14', ['shirt', 'jeans']), look('2026-09-15', ['tee', 'chinos'])]
  const review = (over: Partial<ComponentProps<typeof Review>> = {}) =>
    text(
      renderToStaticMarkup(
        <Review
          tasks={[]}
          projects={[]}
          people={[]}
          reviews={[]}
          journal={[]}
          places={[]}
          habits={[]}
          onSaveReview={noop}
          onOpen={noop}
          onStatus={noop}
          onReschedule={noop}
          onNew={noop}
          garments={garments}
          wears={wears}
          onOpenWardrobe={noop}
          {...over}
        />,
      ),
    )

  it('each day’s look this week, and the piece worn on the most days', () => {
    // Wednesday 16 September 2026: the week of 13–19 September
    at(new Date(2026, 8, 16, 12))
    const html = review()
    expect(html).toContain('<h3>What you wore</h3>')
    expect(html).toContain('3 days logged this week')
    expect([...html.matchAll(/class="review-look"[^>]*>[\s\S]*?<span>(\w+)<\/span><\/button>/g)].map(m => m[1])).toEqual(['Sun', 'Mon', 'Tue'])
    // the tee and the jeans both on two days: the tee was worn last
    expect(html).toContain('<span class="muted">Most worn</span> Navy tee</span><strong>2 days</strong>')
  })

  it('leaves the card out with nothing logged in the week, or no way into the wardrobe', () => {
    at(new Date(2026, 8, 16, 12))
    expect(review({ wears: [wears[0]] })).not.toContain('What you wore')
    expect(review({ onOpenWardrobe: undefined })).not.toContain('What you wore')
  })

  it('is handed the wardrobe by Home', () => {
    const home = read('../components/planner/HomeScreen.tsx')
    const week = home.slice(home.indexOf('<Review'), home.indexOf('/>', home.indexOf('<Review')))
    for (const prop of ['garments={store.garments}', 'wears={store.wears}', 'onOpenWardrobe={openWardrobe}']) expect(week).toContain(prop)
  })
})

describe('Stats: streaks, the photo calendar, the podium, your uniform and cost per wear', () => {
  const NOW = new Date(2026, 8, 14, 10)
  const garments = [
    piece('tee', 'top'),
    piece('jeans', 'bottom'),
    piece('shirt', 'top'),
    piece('chinos', 'bottom'),
    piece('old-top', 'top'),
    piece('never', 'top'),
    piece('gone', 'top', { archivedAt: T0 }),
  ]
  const wears = [
    look('2026-09-13', ['tee', 'jeans']),
    look('2026-09-12', ['tee', 'jeans']),
    look('2026-09-10', ['shirt', 'chinos']),
    look('2026-09-09', ['gone', 'chinos']),
    look('2026-06-01', ['old-top', 'chinos']),
  ]
  const stats = (over: Partial<ComponentProps<typeof WardrobeStats>> = {}) =>
    text(
      renderToStaticMarkup(
        <WardrobeStats garments={garments} outfits={[]} byId={liveById(over.garments ?? garments)} ix={wearIndex(wears, TODAY)} onOpenPiece={noop} onRetire={noop} onSaveOutfit={noop} onGoDay={noop} now={NOW} {...over} />,
      ),
    )

  it('tiles the current run and the best, today waiting rather than breaking it', () => {
    const html = stats()
    expect(html).toMatch(/Streak<\/div><div class="stat-value">2 days<\/div><div class="stat-sub">log today to keep it going</)
    expect(html).toMatch(/Best streak<\/div><div class="stat-value">2 days</)
  })

  it('draws the month in photos: padding, a collage on each logged day, today marked, later days inert', () => {
    const html = stats()
    expect(html).toContain('<h3>Photo calendar</h3>')
    expect(html).toContain('Each day’s look · 4 days logged')
    expect(html.match(/class="photo-cal-pad"/g)).toHaveLength(5)
    expect(html.match(/class="photo-cal-cell[^"]*"/g)).toHaveLength(30)
    expect(html.match(/class="photo-cal-cell has-look/g)).toHaveLength(4)
    expect(html).toContain('class="photo-cal-cell today"')
    expect(html.match(/class="photo-cal-cell later"/g)).toHaveLength(16)
    expect(html).toContain('aria-label="Sun 13 Sep: tee + jeans"')
    // a day that has come opens Outfit on it, even with nothing logged
    expect(html).toContain('aria-label="Fri 11 Sep: nothing logged"')
    expect(html).toMatch(/aria-label="Next month" disabled=""/)
    // with no way to Outfit, the days are only pictures
    expect(stats({ onGoDay: undefined })).not.toContain('<button type="button" class="photo-cal-day"')
  })

  it('stands the three most worn of all time on a podium, first to third in reading order', () => {
    const html = stats()
    expect(html).toContain('<h3>Top three</h3>')
    expect([...html.matchAll(/class="podium-piece" aria-label="([^"]+)"/g)].map(m => m[1])).toEqual(['First: chinos, 3 days', 'Second: jeans, 2 days', 'Third: tee, 2 days'])
    expect(html).not.toContain('vacant')
    expect(stats({ ix: wearIndex([], TODAY) })).not.toContain('Top three')
  })

  it('keeps first in the middle with fewer than three: an empty step stands in, hidden from screen readers', () => {
    const two = stats({ ix: wearIndex([look('2026-09-13', ['tee', 'jeans']), look('2026-09-12', ['tee'])], TODAY) })
    expect([...two.matchAll(/class="podium-piece" aria-label="([^"]+)"/g)].map(m => m[1])).toEqual(['First: tee, 2 days', 'Second: jeans, 1 day'])
    expect(two).toContain('<li class="podium-place rank-3 vacant" aria-hidden="true"><span class="podium-step"></span></li>')
    const one = stats({ ix: wearIndex([look('2026-09-13', ['tee'])], TODAY) })
    expect(one.match(/class="podium-place rank-\d vacant" aria-hidden="true"/g)).toEqual([
      'class="podium-place rank-2 vacant" aria-hidden="true"',
      'class="podium-place rank-3 vacant" aria-hidden="true"',
    ])
  })

  it('heads the repeated outfits with your uniform: its share of the days, and Save as outfit until it is saved', () => {
    const html = stats()
    const repeats = html.slice(html.indexOf('<h3>Most repeated outfits</h3>'))
    expect(repeats).toContain('<span class="wardrobe-uniform-label">Your uniform</span>')
    expect(repeats).toContain('tee + jeans')
    expect(repeats).toContain('×2 · last Sun 13 Sep')
    expect(repeats).toContain('40% of the days you logged')
    expect(repeats).toContain('>Save as outfit</button>')
    // the uniform is not listed a second time under itself
    expect(repeats).not.toContain('class="wardrobe-repeats"')
    const saved = stats({ outfits: [outfit('o1', ['tee', 'jeans'], 'Weekend')] })
    expect(saved).toContain('Weekend')
    expect(saved).not.toContain('Save as outfit')
  })

  it('shows cost per wear only once a piece has a price', () => {
    expect(stats()).not.toContain('Cost per wear')
    const priced = garments.map(g => (g.id === 'chinos' ? { ...g, price: 45 } : g.id === 'never' ? { ...g, price: 30 } : g))
    const html = stats({ garments: priced })
    expect(html).toContain('<h3>Cost per wear</h3>')
    // everything they cost over every day worn: the never-worn piece's price counts, and it has no wears
    expect(html).toContain(`${formatMoney(75)} across 2 pieces · ${formatMoney(25)} a wear overall`)
    expect(html).toContain(`<strong>${formatMoney(15)}</strong> <small class="muted">a wear</small>`)
    expect(html).toContain(`${formatMoney(30)} · not worn yet`)
  })
})

describe('the wardrobe’s new styles', () => {
  const css = read('../styles/18-wardrobe.css')

  it('lays the photo calendar in seven columns that shrink rather than scroll at 375pt', () => {
    expect(css).toMatch(/\.photo-cal-head,\s*\.photo-cal \{[^}]*grid-template-columns: repeat\(7, minmax\(0, 1fr\)\);/)
  })

  it('keeps the phone rules behind their guards', () => {
    expect(css).toMatch(/@media \(max-width: 640px\) \{\s*\.wardrobe-tiles > :first-child \{\s*grid-column: 1 \/ -1;/)
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.cal-look,\s*\.review-most-worn \{\s*min-height: 44px;/)
  })

  it('draws a date on the photo calendar on a chip of its own, never on a photo', () => {
    expect(css).toMatch(/\.photo-cal-num \{[^}]*background: var\(--surface\);[^}]*color: var\(--text-2\);/)
  })

  it('divides the day sheet’s look from its rows with a straight line, as a row is divided from the next', () => {
    const rule = /\.cal-sheet-body > \.cal-look \{([^}]*)\}/.exec(css)![1]
    expect(rule).toContain('border-bottom: 1px solid var(--border);')
    expect(rule).not.toContain('border-radius')
  })
})

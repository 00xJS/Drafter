import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ComponentProps, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { mergeRecord } from '../../shared/merge.mjs'
import { workByDay, workDaysOf } from '../calgrid'
import { entryToEvent } from '../calendars'
import { Clothes } from '../components/wardrobe/Clothes'
import { chosenIn, rowsOf, start, surprise, surprisePool } from '../components/wardrobe/composer'
import { GarmentSheet, type SheetMode } from '../components/wardrobe/GarmentSheet'
import { OutfitComposer } from '../components/wardrobe/OutfitComposer'
import { OccasionChoice, PieceDetails } from '../components/wardrobe/PieceDetails'
import { SavedOutfits } from '../components/wardrobe/SavedOutfits'
import { SnapRow } from '../components/wardrobe/SnapRow'
import { WardrobeCard } from '../components/wardrobe/WardrobeCard'
import type { CalendarEntry, Garment, GarmentType, Outfit, Wear } from '../types'
import { dayOccasion, liveById, wearIndex } from '../wardrobe'
import { button, elements, press, propsOf, settled } from './rendered'

// Work and days-off pieces, and a composer that knows a work day: the day's
// occasion from your own work-day entries, flipped for the view alone; the
// rows, their badges and quieter cards; Surprise me's pool; a saved outfit's
// badge; Clothes' filter; Today's one-tap looks; and Wear it for.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const noop = () => {}
const T0 = '2026-08-01T09:00:00.000Z'
/** A Monday. */
const TODAY = '2026-09-14'
const ME = '00000000-0000-0000-0000-00000000000a'
const PEER = '00000000-0000-0000-0000-00000000000b'

const piece = (id: string, type: GarmentType, over: Partial<Garment> = {}): Garment => ({ kind: 'garment', id, name: id, type, createdAt: T0, updatedAt: T0, ...over })
const suit = piece('suit', 'top', { occasion: 'work' })
const shirt = piece('shirt', 'top')
const gym = piece('gym-top', 'top', { occasion: 'personal' })
const slacks = piece('slacks', 'bottom', { occasion: 'work' })
const jeans = piece('jeans', 'bottom')
const joggers = piece('joggers', 'bottom', { occasion: 'personal' })
const wardrobe = [suit, shirt, gym, slacks, jeans, joggers]
/** The rows' rest order as a visit freezes it: never worn, so by name. */
const frozen = ['gym-top', 'jeans', 'joggers', 'shirt', 'slacks', 'suit']

/** A local time on a day, as an entry stores it. */
const at = (day: string, h: number, m = 0) => {
  const [y, mo, d] = day.split('-').map(Number)
  return new Date(y, mo - 1, d, h, m).toISOString()
}
const workEntry = (id: string, day: string, over: Partial<CalendarEntry> = {}): CalendarEntry => ({
  kind: 'event',
  id,
  title: 'Working from home',
  start: at(day, 9),
  end: at(day, 17, 30),
  allDay: false,
  work: 'home',
  ownerId: ME,
  createdAt: T0,
  updatedAt: T0,
  ...over,
})
let looks = 0
const look = (date: string, garmentIds: string[]): Wear => {
  looks++
  return { kind: 'wear', id: `wear~${date}~${String(looks).padStart(10, '0')}`, date, garmentIds, createdAt: `${date}T08:00:00.000Z`, updatedAt: `${date}T08:00:00.000Z` }
}
const outfit = (id: string, garmentIds: string[], name?: string): Outfit => ({ kind: 'outfit', id, name, garmentIds, createdAt: T0, updatedAt: T0 })

type ComposerProps = ComponentProps<typeof OutfitComposer>
function composerProps(over: Partial<ComposerProps> = {}): ComposerProps {
  const garments = over.garments ?? wardrobe
  const wears = over.wears ?? []
  return {
    garments,
    outfits: [],
    wears,
    byId: liveById(garments),
    ix: wearIndex(wears, TODAY),
    day: TODAY,
    todayKey: TODAY,
    // today and tomorrow are work days
    workDays: new Set([TODAY, '2026-09-15']),
    onDay: noop,
    onLog: noop,
    onRemoveLook: noop,
    onSaveOutfit: noop,
    onAdd: noop,
    onOpenPiece: noop,
    onWearOutfit: noop,
    onRenameOutfit: noop,
    onFavouriteOutfit: noop,
    onDeleteOutfit: noop,
    forecast: null,
    ...over,
  }
}
const composer = (over: Partial<ComposerProps> = {}) => renderToStaticMarkup(<OutfitComposer {...composerProps(over)} />)
/** The pieces each row deals, row by row. */
const rowsIn = (tree: ReactNode) => elements(tree).filter(e => e.type === SnapRow).map(e => (e.props.pieces as Garment[]).map(g => g.id))
/** The names on the chosen cards, row by row. */
const chosenNames = (html: string) => [...html.matchAll(/aria-checked="true"[^>]*class="snap-card">[\s\S]*?class="snap-name">([^<]+)</g)].map(m => m[1])

describe('the day’s occasion', () => {
  const entries: CalendarEntry[] = [
    workEntry('w-mon', TODAY),
    workEntry('w-tue', '2026-09-15', { work: 'office', title: 'In the office' }),
    // an ordinary event is no work day
    { ...workEntry('dentist', '2026-09-16'), work: undefined, title: 'Dentist' },
    // a household member's work day is theirs
    workEntry('w-peer', '2026-09-17', { ownerId: PEER }),
    // one deleted is gone
    workEntry('w-gone', '2026-09-18', { deletedAt: T0 }),
    // an all-day one, its end left out
    workEntry('w-all', '2026-09-21', { allDay: true, start: '2026-09-21', end: '2026-09-22' }),
    // local mode: no owner, the device's own
    workEntry('w-local', '2026-09-23', { ownerId: undefined }),
  ]

  it('is a work day where one of your own work-day entries is, and a day off anywhere else', () => {
    const days = workDaysOf(entries, ME)
    expect([...days].sort()).toEqual([TODAY, '2026-09-15', '2026-09-21', '2026-09-23'])
    expect(dayOccasion(TODAY, days)).toBe('work')
    expect(dayOccasion('2026-09-16', days)).toBe('personal')
    expect(dayOccasion('2026-09-17', days)).toBe('personal')
    expect(workDaysOf([], ME).size).toBe(0)
  })

  it('never dresses for work on an Off day or a holiday, though the Calendar still badges them', () => {
    const away = [workEntry('pto', '2026-09-24', { work: 'off', title: 'PTO / Off', allDay: true, start: '2026-09-24', end: '2026-09-25' }), workEntry('hol', '2026-09-25', { work: 'holiday', title: 'Holiday', allDay: true, start: '2026-09-25', end: '2026-09-26' })]
    expect(workDaysOf(away, ME).size).toBe(0)
    expect([...workByDay(away.map(entryToEvent)).keys()].sort()).toEqual(['2026-09-24', '2026-09-25'])
  })

  it('takes no owned entry for yours until this device knows who you are', () => {
    // signed in, the household not read yet: a partner's office day is not yours
    expect(workDaysOf([workEntry('w-peer', '2026-09-17', { ownerId: PEER })], null).size).toBe(0)
    expect(workDaysOf([workEntry('w-mine', TODAY)], null).size).toBe(0)
    // local mode: an entry with no owner is this device's own
    expect([...workDaysOf([workEntry('w-local', '2026-09-23', { ownerId: undefined })], null)]).toEqual(['2026-09-23'])
  })

  it('reads the Calendar’s own work badge: one map, workByDay', () => {
    const mine = entries.filter(e => e.ownerId !== PEER && !e.deletedAt)
    expect([...workByDay(mine.map(entryToEvent)).keys()].sort()).toEqual([...workDaysOf(entries, ME)].sort())
    expect(read('../components/Calendar.tsx')).toContain('const workDays = useMemo(() => workByDay(events), [events])')
    expect(read('../components/wardrobe/Wardrobe.tsx')).toContain('const workDays = useMemo(() => workDaysOf(entries, myId), [entries, myId])')
    expect(read('../components/planner/HomeScreen.tsx')).toContain('entries={store.events}')
  })

  it('shows beside the date, on a day ahead too, in plain words', () => {
    const today = composer()
    expect(today).toMatch(/<span class="wardrobe-day-mid"><span class="wardrobe-day-pick">[\s\S]*?<\/span><button type="button" class="wardrobe-occasion" aria-label="Work day: dress for a day off instead"[^>]*>Work day<\/button><\/span>/)
    expect(composer({ day: '2026-09-15' })).toContain('>Work day</button>')
    expect(composer({ day: '2026-09-16' })).toContain('>Day off</button>')
    expect(composer({ day: '2026-09-13' })).toContain('>Day off</button>')
    // with no work day on the calendar, every day is a day off
    expect(composer({ workDays: new Set() })).toContain('>Day off</button>')
  })

  it('turns the other way at a tap, for the view alone: the rows follow, and nothing is written', () => {
    const [onLog, onSaveOutfit, onDay, onOpenPiece] = [vi.fn(), vi.fn(), vi.fn(), vi.fn()]
    const props = composerProps({ onLog, onSaveOutfit, onDay, onOpenPiece })
    expect(rowsIn(settled(OutfitComposer, props))[0]).toEqual(['shirt', 'suit', 'gym-top'])
    const after = settled(OutfitComposer, props, t => press(t, 'Work day: dress for a day off instead'))
    // the name says it was changed, not only the title
    expect(button(after, 'Day off, changed for now: dress for work instead').props).toMatchObject({ className: 'wardrobe-occasion changed', title: 'Changed for now: nothing is saved' })
    expect(rowsIn(after)[0]).toEqual(['gym-top', 'shirt', 'suit'])
    for (const f of [onLog, onSaveOutfit, onDay, onOpenPiece]) expect(f).not.toHaveBeenCalled()
  })
})

describe('the composer’s rows', () => {
  it('lead with the pieces for the day, or for any time, in their usual order, and keep the others after them', () => {
    expect(rowsOf(wardrobe, frozen, [], 'work').top.map(g => g.id)).toEqual(['shirt', 'suit', 'gym-top'])
    expect(rowsOf(wardrobe, frozen, [], 'personal').top.map(g => g.id)).toEqual(['gym-top', 'shirt', 'suit'])
    expect(rowsOf(wardrobe, frozen, [], 'work').bottom.map(g => g.id)).toEqual(['jeans', 'slacks', 'joggers'])
    // no occasion: the rest order alone
    expect(rowsOf(wardrobe, frozen).top.map(g => g.id)).toEqual(['gym-top', 'shirt', 'suit'])
    // the day's held piece still leads, whatever it is for
    const oldGym = piece('old-gym', 'top', { occasion: 'personal', archivedAt: T0 })
    expect(rowsOf([...wardrobe, oldGym], frozen, [oldGym], 'work').top.map(g => g.id)).toEqual(['old-gym', 'shirt', 'suit', 'gym-top'])
  })

  it('badge a piece marked Work or Days off, none for Anytime, and draw one for the other occasion quieter, never hidden', () => {
    const html = composer()
    expect(html.match(/<span class="badge occasion-badge work">Work<\/span>/g)).toHaveLength(2)
    // stored as 'personal', read as Days off
    expect(html.match(/<span class="badge occasion-badge personal">Days off<\/span>/g)).toHaveLength(2)
    // the shirt and the jeans are for any time: no badge of their own
    expect(html.match(/occasion-badge/g)).toHaveLength(4)
    expect(html).not.toMatch(/>(Personal|Both|Anytime)<\/span>/)
    // on a work day the gym top and the joggers are quieter, and still in their rows
    expect(html.match(/class="snap-cell side off"/g)).toHaveLength(2)
    expect(html).toContain('>gym-top</span>')
    expect(html).toContain('>joggers</span>')
    expect(chosenNames(html)).toEqual(['shirt', 'jeans'])
    // on a day off, the suit and the slacks
    const off = composer({ day: '2026-09-16' })
    expect(off.match(/ off"/g)).toHaveLength(2)
    expect(off.indexOf('>gym-top</span>')).toBeLessThan(off.indexOf('>suit</span>'))
  })

  it('give a held piece’s badge the line: a retired one says Retired, not Work', () => {
    const oldSuit = piece('old-suit', 'top', { occasion: 'work', archivedAt: T0 })
    const html = renderToStaticMarkup(
      <SnapRow label="Tops" pieces={[oldSuit, suit]} ix={wearIndex([], TODAY)} selected="old-suit" onSelect={noop} occasion="work" onInfo={noop} onAdd={noop} addLabel="+ Add top" emptyLabel="No tops yet" />,
    )
    expect(html).toContain('class="badge snap-held">Retired</span>')
    // one Work badge, the suit's; the retired suit's line is its Retired badge alone
    expect(html.match(/occasion-badge work/g)).toHaveLength(1)
  })

  it('still start a day off from a saved outfit for work', () => {
    expect(chosenNames(composer({ day: '2026-09-16', pending: ['suit', 'slacks'] }))).toEqual(['suit', 'slacks'])
  })
})

describe('Surprise me', () => {
  it('draws from the pieces that fit the day, for it or for any time, and then the season', () => {
    const rows = rowsOf(wardrobe, frozen, [], 'work')
    expect(surprisePool(rows.top, 'autumn', 'work').map(g => g.id)).toEqual(['shirt', 'suit'])
    expect(surprisePool(rows.top, 'autumn', 'personal').map(g => g.id)).toEqual(['shirt', 'gym-top'])
    expect(surprisePool([{ ...shirt, seasons: ['summer'] }, suit, gym], 'autumn', 'work').map(g => g.id)).toEqual(['suit'])
    // a row with nothing for the day draws nothing, and a row with nothing in season keeps the day's pieces
    expect(surprisePool([suit], 'autumn', 'personal')).toEqual([])
    expect(surprisePool([{ ...suit, seasons: ['summer'] }], 'autumn', 'work').map(g => g.id)).toEqual(['suit'])
    // so Surprise me leaves that row where it is: a day off never gets the suit
    const workOnly = rowsOf([suit, slacks, jeans], frozen, [], 'personal')
    const onSuit = start(workOnly, undefined, liveById([suit, slacks, jeans]))
    for (const r of [0, 0.5, 0.999]) {
      const { slots } = chosenIn(surprise(onSuit, workOnly, [], wearIndex([], TODAY), { occasion: 'personal', random: () => r }), workOnly, [])
      expect(slots.top, String(r)).toBe(chosenIn(onSuit, workOnly, []).slots.top)
      expect(slots.bottom, String(r)).toBe('jeans')
    }
    // and a draw never lands on a piece for the other occasion
    const sel = start(rows, undefined, liveById(wardrobe))
    for (const r of [0, 0.3, 0.6, 0.999]) {
      const { slots } = chosenIn(surprise(sel, rows, [], wearIndex([], TODAY), { occasion: 'work', random: () => r }), rows, [])
      expect([slots.top, slots.bottom], String(r)).not.toContain('gym-top')
      expect([slots.top, slots.bottom], String(r)).not.toContain('joggers')
    }
  })

  it('is told the day’s occasion by the composer, and so is the coat', () => {
    const src = read('../components/wardrobe/OutfitComposer.tsx')
    expect(src).toContain('surprise(s, rows, openRows, ix, { season: seasonOf(day), occasion })')
    expect(src).toContain('outerwearFor(garments, ix, need, undefined, occasion)')
  })
})

describe('a saved outfit', () => {
  it('is badged Work or Days off from its pieces, and not when they are mixed or all for any time', () => {
    const html = renderToStaticMarkup(
      <SavedOutfits
        outfits={[outfit('o-work', ['suit', 'jeans'], 'Office'), outfit('o-gym', ['gym-top', 'joggers'], 'Gym'), outfit('o-mixed', ['suit', 'joggers'], 'Mixed'), outfit('o-plain', ['shirt', 'jeans'], 'Plain')]}
        byId={liveById(wardrobe)}
        ix={wearIndex([], TODAY)}
        onLoad={noop}
        onWear={noop}
        onRename={noop}
        onFavourite={noop}
        onDelete={noop}
      />,
    )
    const tile = (name: string) => {
      const from = html.indexOf(`>${name}</span>`)
      return html.slice(from, html.indexOf('</li>', from))
    }
    expect(tile('Office')).toContain('<span class="badge occasion-badge work">Work</span>')
    expect(tile('Gym')).toContain('<span class="badge occasion-badge personal">Days off</span>')
    expect(tile('Mixed')).not.toContain('occasion-badge')
    expect(tile('Plain')).not.toContain('occasion-badge')
  })
})

describe('Clothes', () => {
  it('filters by occasion beside the season: Anytime is every piece, Work or Days off the pieces for it and those for any time', () => {
    const props = { garments: wardrobe, ix: wearIndex([], TODAY), onAdd: noop, onOpen: noop }
    const html = renderToStaticMarkup(<Clothes {...props} />)
    expect(html).toContain('<select class="clothes-season" aria-label="Occasion">')
    // exactly three options, Anytime first and chosen; Days off is the stored 'personal'
    const select = html.match(/<select class="clothes-season" aria-label="Occasion">([\s\S]*?)<\/select>/)![1]
    expect([...select.matchAll(/<option value="([^"]*)"[^>]*>([^<]+)<\/option>/g)].map(m => [m[1], m[2]])).toEqual([
      ['', 'Anytime'],
      ['work', 'Work'],
      ['personal', 'Days off'],
    ])
    expect(select).toContain('<option value="" selected="">Anytime</option>')
    for (const old of ['Any occasion', 'For work', 'For personal', 'Personal', 'Both']) expect(html).not.toContain(`>${old}</option>`)
    expect(html.indexOf('aria-label="Occasion"')).toBeGreaterThan(html.indexOf('aria-label="Season"'))
    const shownFor = (value: string) => {
      const tree = settled(Clothes, props, t => {
        const select = elements(t).find(e => e.type === 'select' && e.props['aria-label'] === 'Occasion')!
        ;(select.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } })
      })
      return elements(tree)
        .filter(e => typeof e.type === 'function' && 'garment' in e.props)
        .map(e => (e.props.garment as Garment).id)
        .sort()
    }
    expect(shownFor('work')).toEqual(['jeans', 'shirt', 'slacks', 'suit'])
    expect(shownFor('personal')).toEqual(['gym-top', 'jeans', 'joggers', 'shirt'])
    expect(shownFor('')).toHaveLength(6)
  })
})

describe('Today’s card', () => {
  it('puts the one-tap looks that fit a work day first', () => {
    const ago = (n: number) => new Date(Date.UTC(2026, 8, 14 - n)).toISOString().slice(0, 10)
    const wears = [...[1, 2, 3, 4, 5].map(n => look(ago(n), ['gym-top', 'joggers'])), ...[6, 7].map(n => look(ago(n), ['shirt', 'slacks']))]
    const card = (workDay: boolean) =>
      renderToStaticMarkup(<WardrobeCard garments={wardrobe} outfits={[]} wears={wears} dayKey={TODAY} onLog={noop} onOpen={noop} now={new Date(2026, 8, 14, 9)} forecast={null} workDay={workDay} />)
    const labels = (html: string) => [...html.matchAll(/class="wardrobe-chip-label">([^<]+)</g)].map(m => m[1])
    expect(labels(card(false))).toEqual(['gym-top + joggers', 'shirt + slacks'])
    expect(labels(card(true))).toEqual(['shirt + slacks', 'gym-top + joggers'])
    // Today decides the work day from the same key it hands the card, and that
    // key now follows the clock (useDayKey) rather than being read once at mount
    expect(read('../components/Today.tsx')).toContain('workDay={workDaysOf(entries, myId).has(todayKey)}')
  })
})

describe('Wear it for', () => {
  const sheet = (mode: SheetMode) =>
    renderToStaticMarkup(
      <GarmentSheet
        mode={mode}
        garments={wardrobe}
        outfits={[]}
        byId={liveById(wardrobe)}
        ix={wearIndex([], TODAY)}
        todayKey={TODAY}
        onCreate={noop}
        onEdit={noop}
        onRetire={noop}
        onDelete={noop}
        onWearToday={noop}
        onGoDay={noop}
        onOpenPiece={noop}
        onClose={noop}
      />,
    )
  const choice = (html: string) => html.match(/<span class="segmented garment-occasion" role="radiogroup" aria-label="Wear it for">([\s\S]*?)<\/span>/)?.[1] ?? ''
  const checked = (html: string) => [...choice(html).matchAll(/aria-checked="true" class="seg on">([^<]+)</g)].map(m => m[1])

  it('is Work · Days off · Anytime on the piece sheet, Anytime for a piece marked for neither', () => {
    const words = (html: string) => [...choice(html).matchAll(/class="seg(?: on)?">([^<]+)</g)].map(m => m[1])
    expect(words(sheet({ kind: 'edit', id: 'suit' }))).toEqual(['Work', 'Days off', 'Anytime'])
    expect(checked(sheet({ kind: 'edit', id: 'suit' }))).toEqual(['Work'])
    // stored as 'personal', read as Days off
    expect(checked(sheet({ kind: 'edit', id: 'gym-top' }))).toEqual(['Days off'])
    expect(checked(sheet({ kind: 'edit', id: 'shirt' }))).toEqual(['Anytime'])
  })

  it('is offered when adding clothing, Anytime to start', () => {
    expect(checked(sheet({ kind: 'add' }))).toEqual(['Anytime'])
    expect(choice(sheet({ kind: 'add' }))).not.toMatch(/Personal|Both/)
  })

  it('merges as a plain value: set on one device beside another field on the other, both stay; set two ways, a conflict', () => {
    const base = { ...shirt, updatedAt: '2026-09-14T08:00:00.000Z' }
    const { merged, conflicts } = mergeRecord(base, { ...base, occasion: 'work', updatedAt: '2026-09-14T08:01:00.000Z' }, { ...base, price: 30, updatedAt: '2026-09-14T08:02:00.000Z' })
    expect(merged).toMatchObject({ occasion: 'work', price: 30 })
    expect(conflicts).toEqual([])
    expect(mergeRecord(base, { ...base, occasion: 'work' }, { ...base, occasion: 'personal' }).conflicts.map(c => c.path)).toEqual([['occasion']])
  })

  it('marks the piece as it is tapped, stamped; Anytime takes the mark off, and the one it has writes nothing', () => {
    const onEdit = vi.fn<(change: (cur: Garment) => Garment) => void>()
    const details = (garment: Garment) => ({ garment, ix: wearIndex([], TODAY), byId: liveById(wardrobe), onEdit, onOpenPiece: noop, keep: { current: noop } })
    propsOf(settled(PieceDetails, details(shirt)), OccasionChoice).onChange('work')
    const marked = onEdit.mock.lastCall![0](shirt)
    expect(marked.occasion).toBe('work')
    expect(marked.updatedAt > shirt.updatedAt).toBe(true)
    propsOf(settled(PieceDetails, details(suit)), OccasionChoice).onChange(undefined)
    expect('occasion' in onEdit.mock.lastCall![0](suit)).toBe(false)
    onEdit.mockClear()
    propsOf(settled(PieceDetails, details(suit)), OccasionChoice).onChange('work')
    expect(onEdit).not.toHaveBeenCalled()
  })
})

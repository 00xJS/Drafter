import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { useState, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formatMoney } from '../bills'
import type { PlannerCtx } from '../components/planner/ctx'
import { HomeScreen } from '../components/planner/HomeScreen'
import { Wardrobe as LazyWardrobe } from '../components/planner/lazy'
import type { WardrobeOpen } from '../components/planner/useNavigation'
import { Clothes } from '../components/wardrobe/Clothes'
import { GarmentSheet, type SheetMode } from '../components/wardrobe/GarmentSheet'
import { OutfitComposer } from '../components/wardrobe/OutfitComposer'
import { PieceDetails, readPrice } from '../components/wardrobe/PieceDetails'
import { OutfitMenu } from '../components/wardrobe/SavedOutfits'
import { Wardrobe } from '../components/wardrobe/Wardrobe'
import { WardrobeStats } from '../components/wardrobe/WardrobeStats'
import { imageFiles } from '../media'
import type { Garment, GarmentType, Item, Outfit, Wear } from '../types'
import { liveById, unwearable, wearIndex } from '../wardrobe'
import { button, press, propsOf, rendered, settled, textOf, typeInto } from './rendered'
import { plannerSource } from './source'

// Home → Wardrobe as a server render sees it: the composer's rows and its
// buttons, Clothes, the piece sheet and Stats, from fixtures; the segment on
// Home; and the guards around it (no project anywhere, tokens only, the camera
// key, the photo clean-up wired into Trash).

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const noop = () => {}
const T0 = '2026-08-01T09:00:00.000Z'
/** A Monday. */
const TODAY = '2026-09-14'

const piece = (id: string, type: GarmentType, over: Partial<Garment> = {}): Garment => ({ kind: 'garment', id, name: id, type, createdAt: T0, updatedAt: T0, ...over })
let looks = 0
const look = (date: string, garmentIds: string[]): Wear => {
  looks++
  return { kind: 'wear', id: `wear~${date}~${String(looks).padStart(10, '0')}`, date, garmentIds, createdAt: `${date}T08:00:00.000Z`, updatedAt: `${date}T08:00:00.000Z` }
}
const outfit = (id: string, garmentIds: string[], name?: string): Outfit => ({ kind: 'outfit', id, name, garmentIds, createdAt: T0, updatedAt: T0 })

const tops = ['navy-tee', 'white-shirt', 'grey-tee', 'black-tee', 'blue-shirt'].map(id => piece(id, 'top'))
const bottoms = ['jeans', 'chinos', 'shorts', 'cords', 'joggers'].map(id => piece(id, 'bottom'))

afterEach(() => {
  vi.useRealTimers()
})

type ComposerProps = ComponentProps<typeof OutfitComposer>

function composerProps(over: Partial<ComposerProps> = {}): ComposerProps {
  const garments = over.garments ?? [...tops, ...bottoms]
  const wears = over.wears ?? []
  return {
    garments,
    outfits: [],
    wears,
    byId: liveById(garments),
    ix: wearIndex(wears, TODAY),
    day: TODAY,
    todayKey: TODAY,
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
/** The composer's note field. */
const noteField = (p: Record<string, unknown>) => p.placeholder === 'wedding, interview…'

/** The names on the chosen cards, row by row. */
const chosenNames = (html: string) => [...html.matchAll(/aria-checked="true"[^>]*class="snap-card">[\s\S]*?class="snap-name">([^<]+)</g)].map(m => m[1])

describe('Outfit: the composer', () => {
  it('draws Tops and Bottoms as radiogroups, with exactly one card chosen in each', () => {
    const html = composer()
    const groups = html.split('role="radiogroup"').slice(1)
    expect(groups).toHaveLength(2)
    expect(html).toContain('aria-label="Tops"')
    expect(html).toContain('aria-label="Bottoms"')
    for (const group of groups) expect(group.match(/aria-checked="true"/g)).toHaveLength(1)
    // a roving tabindex: the chosen card is the one Tab lands on
    expect(html.match(/role="radio" aria-checked="true" tabindex="0"/g)).toHaveLength(2)
    expect(html).toContain('role="radio" aria-checked="false" tabindex="-1"')
    // An undressed day sits on None in both rows, so there is no piece to
    // reach. (chosenNames is no help here: with no snap-name on the None card
    // its regex runs on to the next card's, so the card itself is what to ask.)
    expect(html.match(/aria-checked="true"[^>]*class="snap-card"><span class="snap-none">None<\/span>/g)).toHaveLength(2)
    expect(html).not.toContain('aria-label="About black-tee"')
    // a day that was dressed sits on its look, and that card has its way to the piece
    expect(composer({ wears: [look(TODAY, ['black-tee', 'jeans'])] })).toContain('aria-label="About black-tee"')
    expect(html).toContain('+ Add top')
    expect(html).toContain('+ Add bottom')
  })

  it('leads each row with what is rested longest, the never worn first, and marks those New', () => {
    const html = composer({ wears: [look('2026-09-11', ['navy-tee', 'jeans'])] })
    // never worn first, by name when added together; jeans and the navy tee go to the end
    expect(chosenNames(html)).toEqual(['black-tee', 'chinos'])
    expect(html.indexOf('>navy-tee<')).toBeGreaterThan(html.indexOf('>white-shirt<'))
    expect(html).toContain('>3 days ago</span>')
    expect(html).toContain('class="badge snap-new">New</span>')
  })

  it('opens on today with Wearing this, and the day picker goes on a year, to plan', () => {
    const html = composer()
    expect(html).toContain('Today · Mon 14 Sep')
    expect(html).toMatch(/<input type="date" max="2027-09-14"[^>]* value="2026-09-14"\/>/)
    expect(html).not.toContain('aria-label="The day after" disabled=""')
    expect(composer({ day: '2027-09-14' })).toContain('aria-label="The day after" disabled=""')
    expect(html).toContain('>Wearing this</button>')
    expect(html).toContain('>Save outfit</button>')
    expect(html).not.toContain('Update look')
    expect(html).not.toContain('Another look')
    expect(html).not.toContain('Remove look')
  })

  it('starts a logged day on its latest look, with Update look, a look switcher and Remove look', () => {
    const html = composer({ wears: [look(TODAY, ['navy-tee', 'jeans']), look(TODAY, ['grey-tee', 'cords'])] })
    expect(chosenNames(html)).toEqual(['grey-tee', 'cords'])
    expect(html).toContain('>Logged</span>')
    expect(html).toContain('>Update look</button>')
    expect(html).toContain('Look 2 of 2')
    // "+ Another look", or "+ Look" on a phone: starts the next change, not a second save
    expect(html).toContain('aria-label="Another look"')
    expect(html).toContain('+ <span class="wardrobe-another-long">Another look</span><span class="wardrobe-another-short">Look</span>')
    expect(html).toContain('Remove look')
  })

  it('names a past day on its button', () => {
    const html = composer({ day: '2026-09-13' })
    expect(html).toContain('Yesterday · Sun 13 Sep')
    expect(html).toContain('>Log for Sun 13 Sep</button>')
    expect(html).not.toContain('aria-label="The day after" disabled=""')
    expect(composer({ day: '2026-09-02' })).toContain('>Log for Wed 2 Sep</button>')
  })

  it('shows an empty row as one tile that adds a piece, and logs nothing without a top and a bottom', () => {
    const html = composer({ garments: tops })
    expect(html).toContain('No bottoms yet · Add one')
    expect(html.split('role="radiogroup"')).toHaveLength(2)
    expect(html).toContain('<button type="button" class="btn primary" disabled="">Wearing this</button>')
    expect(html).toContain('<button type="button" class="btn" disabled="">Save outfit</button>')
  })

  it('offers Separates or One-piece only when there are both, and the one-pieces alone when that is all', () => {
    const dress = piece('dress', 'onepiece')
    const both = composer({ garments: [...tops, ...bottoms, dress] })
    expect(both).toContain('>Separates</button>')
    expect(both).toContain('aria-label="Tops"')
    const only = composer({ garments: [dress] })
    expect(only).toContain('aria-label="One-pieces"')
    expect(only).not.toContain('Separates')
    // there, but not live: an undressed day has chosen nothing to wear yet
    expect(only).toContain('Wearing this')
    expect(only).toContain('class="btn primary" disabled=""')
    // a look in a one-piece opens on that row
    expect(composer({ garments: [...tops, ...bottoms, dress], wears: [look(TODAY, ['dress'])] })).toContain('aria-label="One-pieces"')
  })

  it('opens Outerwear and Shoes on request, None first, and lists accessories as chips', () => {
    const extras = [...tops, ...bottoms, piece('coat', 'outerwear'), piece('boots', 'shoes'), piece('watch', 'accessory')]
    const html = composer({ garments: extras })
    expect(html).toContain('>+ Outerwear</button>')
    expect(html).toContain('>+ Shoes</button>')
    expect(html).not.toContain('aria-label="Shoes"')
    expect(html).toContain('aria-pressed="false" class="toggle acc-chip"')
    expect(html).toContain('+ Add accessory')
    // a look with shoes on opens the Shoes row for the visit, on them
    const shod = composer({ garments: extras, wears: [look(TODAY, ['navy-tee', 'jeans', 'boots', 'watch'])] })
    expect(shod).toContain('aria-label="Shoes"')
    expect(shod).toContain('>None</span>')
    expect(chosenNames(shod)).toEqual(['navy-tee', 'jeans', 'boots'])
    expect(shod).toContain('aria-pressed="true" class="toggle on acc-chip"')
    expect(shod).toContain('>+ Outerwear</button>')
  })

  it('lists the saved outfits under the rows, each with its line', () => {
    const html = composer({ outfits: [outfit('o1', ['navy-tee', 'jeans'], 'Friday smart'), outfit('o2', ['grey-tee', 'cords'])], wears: [look('2026-09-11', ['navy-tee', 'jeans'])] })
    expect(html).toContain('Saved outfits (2)')
    expect(html.indexOf('Friday smart')).toBeLessThan(html.indexOf('grey-tee + cords'))
    expect(html).toContain('Worn 1 time · last 3 days ago')
    expect(html).toContain('Not worn yet')
    expect(html).toContain('aria-label="More for Friday smart"')
  })

  it('shows a retired piece the day holds first in its row, chosen and badged; any other day leaves it out', () => {
    const old = piece('old-band-tee', 'top', { archivedAt: T0 })
    const garments = [...tops, ...bottoms, old]
    const html = composer({ garments, wears: [look(TODAY, ['old-band-tee', 'jeans'])] })
    expect(chosenNames(html)).toEqual(['old-band-tee', 'jeans'])
    expect(html).toContain('class="badge snap-held">Retired</span>')
    // its sheet, with Bring back, is a tap away
    expect(html).toContain('aria-label="About old-band-tee"')
    expect(html).not.toContain('wardrobe-note')
    expect(composer({ garments, wears: [look('2026-09-13', ['old-band-tee', 'jeans'])] })).not.toContain('old-band-tee')
  })

  it('shows a piece in Trash the day holds, badged and with no sheet, and says when one was deleted forever', () => {
    const binned = piece('binned-tee', 'top', { deletedAt: T0 })
    const html = composer({ inTrash: [binned], wears: [look(TODAY, ['binned-tee', 'chinos', 'purged-scarf'])] })
    expect(chosenNames(html)).toEqual(['binned-tee', 'chinos'])
    expect(html).toContain('class="badge snap-held">In Trash</span>')
    expect(html).not.toContain('aria-label="About binned-tee"')
    expect(html).toContain('<p class="wardrobe-note">A piece was deleted</p>')
    // it still makes a top and a bottom, so the look can be updated
    expect(html).toContain('<button type="button" class="btn primary">Update look</button>')
  })

  it('plans a day ahead: Plan for, then Update plan, with its own badge and its own Remove', () => {
    const tomorrow = '2026-09-15'
    const empty = composer({ day: tomorrow })
    expect(empty).toContain('Tomorrow · Tue 15 Sep')
    expect(empty).toContain('>Plan for Tue 15 Sep</button>')
    const planned = composer({ day: tomorrow, wears: [{ ...look(tomorrow, ['grey-tee', 'cords']), planned: true }] })
    expect(chosenNames(planned)).toEqual(['grey-tee', 'cords'])
    expect(planned).toContain('class="badge wardrobe-planned">Planned</span>')
    expect(planned).toContain('>Update plan</button>')
    expect(planned).toContain('aria-label="Remove plan"')
    expect(planned).toContain('aria-label="Another look"')
  })

  it('reads a plan on its own day as not yet worn: Wearing this says it was', () => {
    const html = composer({ wears: [{ ...look(TODAY, ['grey-tee', 'cords']), planned: true }] })
    expect(chosenNames(html)).toEqual(['grey-tee', 'cords'])
    expect(html).toContain('>Planned</span>')
    expect(html).toContain('>Wearing this</button>')
    expect(html).toContain('Look 1 of 1')
    expect(html).toContain('aria-label="Another look"')
  })

  it('carries the day’s note into its field, and deals a look with Surprise me', () => {
    const html = composer({ wears: [{ ...look(TODAY, ['navy-tee', 'jeans']), note: 'wedding' }] })
    expect(html).toContain('<span>Note on the look</span>')
    expect(html).toContain('value="wedding"')
    expect(html).toContain('Surprise me</button>')
    expect(composer()).not.toContain('value="wedding"')
  })

  it('logs the look with the note in its field, and starts the next change from + Another look', () => {
    const onLog = vi.fn<ComposerProps['onLog']>()
    const noted = composerProps({ wears: [{ ...look(TODAY, ['navy-tee', 'jeans']), note: 'wedding' }], onLog })
    const tree = settled(OutfitComposer, noted)
    press(tree, 'Update look')
    expect(onLog.mock.lastCall?.[2]).toMatchObject({ note: 'wedding' })
    expect(onLog.mock.lastCall?.[2].another).toBeUndefined()
    // + Another look starts a new change: nothing is written until Wearing this
    const draft = settled(OutfitComposer, noted, t => press(t, 'Another look'))
    expect(onLog).toHaveBeenCalledTimes(1)
    expect(textOf(draft)).toContain('New look · 2 of 2')
    expect(button(draft, 'The look before').props.disabled).toBe(false)
    press(draft, 'Wearing this')
    expect(onLog.mock.lastCall?.[2]).toMatchObject({ another: true, note: '' })
    // a note written on the current look stays on Update look
    const written = settled(OutfitComposer, noted, t => typeInto(t, noteField, 'dinner'))
    press(written, 'Update look')
    expect(onLog.mock.lastCall?.[2]).toMatchObject({ note: 'dinner' })
    // and a day with no look yet takes what is typed
    press(
      settled(OutfitComposer, composerProps({ onLog }), t => typeInto(t, noteField, 'interview')),
      'Wearing this',
    )
    expect(onLog.mock.lastCall?.[2]).toMatchObject({ note: 'interview' })
  })

  it('marks a favourite in its row, said as well as drawn', () => {
    const html = composer({ garments: [...tops.map(g => (g.id === 'black-tee' ? { ...g, favourite: true } : g)), ...bottoms] })
    expect(html).toContain('<span class="fav-mark" title="Favourite">')
    expect(html).toContain('<span class="wardrobe-sr">Favourite: </span>')
    expect(html.match(/class="fav-mark"/g)).toHaveLength(1)
  })

  it('offers a coat on a cold or wet today, and on no other day', () => {
    const garments = [...tops, ...bottoms, piece('mac', 'outerwear', { name: 'Mac' })]
    const cold = { tempC: 5, hiC: 8, loC: 2, rainPct: 80, code: 61, unit: '°C' }
    const html = composer({ garments, forecast: cold })
    expect(html).toContain('Cold and wet today · 8° at most · rain')
    expect(html).toContain('>Add Mac</button>')
    expect(composer({ garments, forecast: cold, day: '2026-09-13' })).not.toContain('wardrobe-weather')
    // a look with its coat on has one already
    expect(composer({ garments, forecast: cold, wears: [look(TODAY, ['navy-tee', 'jeans', 'mac'])] })).not.toContain('Add Mac')
  })

  it('lists the favourite saved outfits first, starred', () => {
    const html = composer({ outfits: [outfit('o1', ['navy-tee', 'jeans'], 'Friday smart'), { ...outfit('o2', ['grey-tee', 'cords'], 'Sunday'), favourite: true }] })
    expect(html.indexOf('Sunday')).toBeLessThan(html.indexOf('Friday smart'))
    expect(html).toContain('<span class="fav-mark inline" title="Favourite">')
  })
})

describe('a saved outfit’s menu', () => {
  const menu = (garments: Garment[], o: Outfit) =>
    renderToStaticMarkup(
      <OutfitMenu outfit={o} title="t" placeholder="p" why={unwearable(o.garmentIds, liveById(garments))} onWear={noop} onRename={noop} onFavourite={noop} onDelete={noop} onClose={noop} />,
    )

  it('wears it today only as a Today chip would log it: every piece in use, and a top and a bottom or a one-piece', () => {
    const old = piece('old-band-tee', 'top', { name: 'Old band tee', archivedAt: T0 })
    const garments = [...tops, ...bottoms, piece('boots', 'shoes'), old]
    const fine = menu(garments, outfit('ok', ['navy-tee', 'jeans', 'boots']))
    expect(fine).toContain('<button type="button" class="btn primary">Wear today</button>')
    expect(fine).not.toContain('outfit-why')
    const retiredTop = menu(garments, outfit('r', ['old-band-tee', 'jeans']))
    expect(retiredTop).toContain('<button type="button" class="btn primary" disabled="">Wear today</button>')
    expect(retiredTop).toContain('<p class="outfit-why">Old band tee is retired</p>')
    // a top and shoes with the bottom gone: never a partial look
    expect(menu(garments, outfit('d', ['navy-tee', 'boots', 'gone']))).toContain('<p class="outfit-why">A piece was deleted</p>')
    expect(menu(garments, outfit('s', ['navy-tee', 'boots']))).toContain('<p class="outfit-why">It needs a top and a bottom, or a one-piece</p>')
  })

  it('stars it as a favourite', () => {
    expect(menu(tops, outfit('o', ['navy-tee', 'jeans']))).toContain('aria-pressed="false" class="toggle outfit-fav"')
    expect(menu(tops, { ...outfit('o', ['navy-tee', 'jeans']), favourite: true })).toContain('aria-pressed="true" class="toggle on outfit-fav"')
  })
})

describe('Clothes', () => {
  const clothes = (garments: Garment[], wears: Wear[] = []) => renderToStaticMarkup(<Clothes garments={garments} ix={wearIndex(wears, TODAY)} onAdd={noop} onOpen={noop} />)

  it('draws a tile for every piece, the Add tile first, and the retired apart at the foot', () => {
    const html = clothes([tops[0], tops[1], piece('old-coat', 'outerwear', { archivedAt: T0 })])
    expect(html.match(/class="clothes-tile"/g)).toHaveLength(3)
    expect(html.indexOf('clothes-tile add')).toBeLessThan(html.indexOf('class="clothes-tile"'))
    expect(html).toContain('<summary>Retired (1)</summary>')
    expect(html.indexOf('old-coat')).toBeGreaterThan(html.indexOf('Retired (1)'))
  })

  it('filters by the types there are, with their counts, and sorts by rest first', () => {
    const html = clothes([...tops, bottoms[0], bottoms[1]])
    expect(html).toContain('All <span class="count">7</span>')
    expect(html).toContain('Tops <span class="count">5</span>')
    expect(html).toContain('Bottoms <span class="count">2</span>')
    expect(html).not.toContain('One-pieces')
    expect(html).toMatch(/<option value="rest" selected="">Not worn lately<\/option>/)
    for (const label of ['Most worn', 'Newest', 'A–Z']) expect(html).toContain(`>${label}</option>`)
  })

  it('says when each was last worn, and "new" for one never worn', () => {
    const html = clothes([tops[0], tops[1]], [look('2026-09-02', [tops[0].id])])
    expect(html).toContain('<span class="clothes-worn">12 days ago</span>')
    expect(html).toContain('<span class="clothes-worn">new</span>')
  })

  it('invites the first piece', () => {
    const html = clothes([])
    expect(html).toContain('Nothing here yet. Add a piece — the photo is optional.')
    expect(html).toContain('clothes-tile add')
  })

  it('filters to the favourites, by season and by tag, with the star on each favourite', () => {
    const html = clothes([{ ...tops[0], favourite: true, tags: ['work'] }, { ...tops[1], tags: ['work', 'smart'] }, bottoms[0]])
    expect(html).toMatch(/Favourites <span class="count">1<\/span>/)
    expect(html).toContain('aria-label="Season"')
    expect(html).toContain('<option value="" selected="">Any season</option>')
    expect(html).toContain('aria-label="Tags"')
    expect(html).toContain('work <span class="count">2</span>')
    expect(html).toContain('smart <span class="count">1</span>')
    expect(html.match(/class="fav-mark"/g)).toHaveLength(1)
    // nothing starred and nothing tagged: neither is offered
    const plain = clothes([tops[0], bottoms[0]])
    expect(plain).not.toContain('Favourites')
    expect(plain).not.toContain('aria-label="Tags"')
  })
})

describe('the piece sheet', () => {
  const sheet = (mode: SheetMode, garments: Garment[] = [], wears: Wear[] = [], outfits: Outfit[] = []) =>
    renderToStaticMarkup(
      <GarmentSheet
        mode={mode}
        garments={garments}
        outfits={outfits}
        byId={liveById(garments)}
        ix={wearIndex(wears, TODAY)}
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

  it('reads a piece the Kitchen’s way: "Last worn 12 days ago · 5 times"', () => {
    const tee = piece('tee', 'top', { color: '#1f2a44' })
    const worn = ['2026-09-02', '2026-08-28', '2026-08-20', '2026-08-10', '2026-07-30'].map(d => look(d, ['tee', 'jeans']))
    const html = sheet({ kind: 'edit', id: 'tee' }, [tee, piece('jeans', 'bottom')], worn, [outfit('o1', ['tee', 'jeans'], 'Weekend')])
    expect(html).toContain('Last worn 12 days ago · 5 times')
    expect(html).toContain('First worn Thu 30 Jul · 30 days: 3 · 12 months: 5')
    // the 12 weeks of bars, in the piece's own colour
    expect(html).toContain('title="Days worn per week, last 12 weeks"')
    expect(html).toContain('background:#1f2a44')
    // the days it was worn go to the composer on that day; the outfits it is in are listed
    expect(html).toContain('>Wed 2 Sep</button>')
    expect(html).toContain('<li>Weekend</li>')
    for (const action of ['>Wear today</button>', '>Retire</button>', 'Replace photo', '>Delete</button>']) expect(html).toContain(action)
  })

  it('offers Bring back for a retired piece, and nothing to wear it today', () => {
    const html = sheet({ kind: 'edit', id: 'coat' }, [piece('coat', 'outerwear', { archivedAt: T0 })])
    expect(html).toContain('>Bring back</button>')
    expect(html).toContain('<button type="button" class="btn primary" disabled="">Wear today</button>')
    expect(html).toContain('Not worn yet')
  })

  it('adds a piece: the photo target, the type chosen, and a name to start from', () => {
    const html = sheet({ kind: 'add', type: 'bottom' })
    expect(html).toContain('Add clothing')
    expect(html).toContain('Choose photo')
    // the picker offers the camera, the library and files on an iPhone: no capture attribute
    expect(html).toMatch(/<input type="file" accept="image\/\*" multiple="" class="garment-file"\/>/)
    expect(html).not.toContain('capture')
    expect(html).toContain('role="radio" aria-checked="true" class="toggle on">Bottom</button>')
    expect(html).toContain('placeholder="Bottom"')
    // a piece with no type named starts as a top
    expect(sheet({ kind: 'add' })).toContain('role="radio" aria-checked="true" class="toggle on">Top</button>')
    // on a desktop a photo can be dropped or pasted there too
    expect(html).toContain('Drop or paste a photo here too')
  })

  it('stars a piece, costs it per wear, and keeps its seasons, tags and what it is worn with', () => {
    const tee = piece('tee', 'top', { favourite: true, price: 40, seasons: ['summer'], tags: ['work', 'weekend'] })
    const worn = ['2026-09-02', '2026-08-28', '2026-08-20', '2026-08-10'].map((d, i) => look(d, ['tee', i < 3 ? 'jeans' : 'chinos']))
    const html = sheet({ kind: 'edit', id: 'tee' }, [tee, piece('jeans', 'bottom'), piece('chinos', 'bottom')], worn)
    expect(html).toContain('aria-pressed="true" aria-label="Favourite"')
    expect(html).toContain(`${formatMoney(40)} · ${formatMoney(10)} a wear over 4 days`)
    expect(html).toContain('value="40"')
    expect(html).toContain('value="work, weekend"')
    expect(html).toContain('aria-pressed="true" class="toggle on">Summer</button>')
    expect(html).toContain('aria-pressed="false" class="toggle">Winter</button>')
    const company = html.slice(html.indexOf('>Worn with<'))
    expect(company.indexOf('>jeans<')).toBeLessThan(company.indexOf('>chinos<'))
    expect(company).toContain('3 days')
  })

  it('has no cost line without a price, and nothing worn with until it is worn', () => {
    const html = sheet({ kind: 'edit', id: 'tee' }, [piece('tee', 'top')])
    expect(html).not.toContain('a wear')
    expect(html).not.toContain('Worn with')
    expect(html).toContain('aria-pressed="false" aria-label="Favourite"')
  })

  it('keeps what the details still have typed when the sheet closes, and never after a delete', () => {
    const keep = { current: () => {} }
    const onEdit = vi.fn()
    const tee = piece('tee', 'top', { price: 40, tags: ['work'] })
    renderToStaticMarkup(<PieceDetails garment={tee} ix={wearIndex([], TODAY)} byId={liveById([tee])} onEdit={onEdit} onOpenPiece={noop} keep={keep} />)
    // nothing typed since it opened: nothing to write
    keep.current()
    expect(onEdit).not.toHaveBeenCalled()
    expect(read('../components/wardrobe/GarmentSheet.tsx')).toMatch(/const close = \(\) => \{\s*commitName\(\)\s*commitNotes\(\)\s*keepDetails\.current\(\)\s*onClose\(\)/)
    // Delete leaves without keeping anything, so a draft never writes a deleted piece back
    expect(read('../components/wardrobe/Wardrobe.tsx')).toMatch(/const removePiece = \(g: Garment\) => \{\s*setSheet\(null\)\s*onRemove\(g\.id\)/)
    expect(read('../components/wardrobe/PieceDetails.tsx')).not.toMatch(/useEffect/)
  })

  it('writes nothing for a field left as it was, even once a sync has changed the piece under it', () => {
    const keep = { current: noop }
    const onEdit = vi.fn<(change: (cur: Garment) => Garment) => void>()
    const tee = piece('tee', 'top', { price: 40, tags: ['work'] })
    const synced = { ...tee, price: 55, tags: ['gym'], updatedAt: '2026-09-14T09:00:00.000Z' }
    const ix = wearIndex([], TODAY)
    // the sheet as it stands open: the piece it shows can change under it
    let sync = noop
    function Open() {
      const [g, setG] = useState(tee)
      sync = () => setG(synced)
      return PieceDetails({ garment: g, ix, byId: liveById([g]), onEdit, onOpenPiece: noop, keep })
    }
    rendered(Open, {}, () => sync())
    keep.current()
    expect(onEdit).not.toHaveBeenCalled()
    // a price typed is kept once, over the piece as it is by then
    rendered(Open, {}, t => typeInto(t, p => p.inputMode === 'decimal', '45'))
    keep.current()
    keep.current()
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit.mock.calls[0][0](synced)).toMatchObject({ price: 45, tags: ['gym'] })
  })

  it('reads a typed price as whole units of the currency, nothing at all as no price, and nothing that is not a price', () => {
    expect(readPrice('40')).toBe(40)
    expect(readPrice(' £1,250 ')).toBe(1250)
    expect(readPrice('39.60')).toBe(40)
    expect(readPrice('')).toBeNull()
    // no cost line, Stats row or Ask figure reads a price of nothing, so the field keeps none
    expect(readPrice('0')).toBeNull()
    expect(readPrice('£0.40')).toBeNull()
    expect(readPrice('cheap')).toBeUndefined()
    expect(readPrice('-5')).toBeUndefined()
  })
})

describe('Stats', () => {
  const NOW = new Date(2026, 8, 14, 10)
  const garments = [
    piece('tee', 'top'),
    piece('jeans', 'bottom'),
    piece('shirt', 'top'),
    piece('chinos', 'bottom'),
    piece('old-top', 'top'),
    piece('never', 'top'),
    piece('fresh', 'top', { createdAt: '2026-09-12T09:00:00.000Z' }),
    piece('gone', 'top', { archivedAt: T0 }),
  ]
  const wears = [
    look('2026-09-13', ['tee', 'jeans']),
    look('2026-09-12', ['tee', 'jeans']),
    look('2026-09-10', ['shirt', 'chinos']),
    look('2026-09-09', ['gone', 'chinos']),
    look('2026-06-01', ['old-top', 'chinos']),
  ]
  const stats = (outfits: Outfit[] = [], ws = wears) =>
    renderToStaticMarkup(<WardrobeStats garments={garments} outfits={outfits} byId={liveById(garments)} ix={wearIndex(ws, TODAY)} onOpenPiece={noop} onRetire={noop} onSaveOutfit={noop} now={NOW} />)

  it('shows its tiles and all five sections', () => {
    const html = stats()
    for (const heading of ['Most worn', 'Not worn lately', 'Never worn', 'Wears by month', 'Most repeated outfits']) expect(html).toContain(`<h3>${heading}</h3>`)
    // seven in use (the retired one aside); four days this month out of fourteen; four worn in 90 days
    expect(html).toMatch(/Clothes<\/div><div class="stat-value">7</)
    expect(html).toMatch(/Days logged<\/div><div class="stat-value">4 of 14</)
    expect(html).toMatch(/Worn lately<\/div><div class="stat-value">4 of 7</)
    expect(html).toContain('>30 days</button>')
    expect(html).toContain('>12 months</button>')
    expect(html).toContain('>All</button>')
  })

  it('keeps a retired piece in Most worn, badged, and out of the not-worn lists', () => {
    const html = stats()
    expect(html).toMatch(/wardrobe-hbar-name">gone<\/span><span class="badge wardrobe-retired">Retired<\/span>/)
    const rested = html.slice(html.indexOf('<h3>Not worn lately</h3>'), html.indexOf('<h3>Never worn</h3>'))
    expect(rested).toContain('old-top')
    // 1 June to 14 September is 105 days: three and a half months, said as four
    expect(rested).toContain('Last worn 4 months ago')
    expect(rested).not.toContain('gone')
    const never = html.slice(html.indexOf('<h3>Never worn</h3>'), html.indexOf('<h3>Wears by month</h3>'))
    expect(never).toContain('never')
    expect(never).toContain('Added 6 weeks ago')
    // added two days ago: not nagged yet
    expect(never).not.toContain('fresh')
  })

  it('counts the year by month, with each piece’s row behind By piece', () => {
    const html = stats()
    expect(html).toContain('5 days logged in 2026')
    expect(html).toContain('<summary>By piece</summary>')
    expect(html).toContain('class="year-table"')
    expect(html).toMatch(/aria-label="Days logged: Jan 0, [^"]*Jun 1, [^"]*Sep 4, /)
  })

  it('offers Save as outfit only for a combination not saved yet', () => {
    const unsaved = stats()
    expect(unsaved).toContain('×2 · last Sun 13 Sep')
    expect(unsaved).toContain('>Save as outfit</button>')
    const saved = stats([outfit('o1', ['tee', 'jeans'], 'Weekend')])
    expect(saved).toContain('Weekend')
    expect(saved).not.toContain('Save as outfit')
  })

  it('says what to do before anything is logged', () => {
    const html = stats([], [])
    expect(html).toContain('Log a few days and your most worn shows here.')
    expect(html).toContain('Wear the same top and bottom on two days and they show here.')
    expect(html).toContain('Nothing has rested that long.')
  })
})

describe('Home → Wardrobe', () => {
  beforeAll(() => LazyWardrobe.preload())

  const at10 = () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 14, 10))
  }
  const wardrobe = (open: ComponentProps<typeof Wardrobe>['open']) =>
    renderToStaticMarkup(
      <Wardrobe garments={[...tops, ...bottoms]} outfits={[]} wears={[]} onSave={noop} onRemove={noop} onRestore={noop} showToast={noop} open={open} onOpenConsumed={noop} />,
    )

  it('opens from the day, with a way back, on the composer', () => {
    at10()
    const store = { garments: [...tops, ...bottoms], outfits: [], wears: [], upsert: noop, remove: noop, restore: noop }
    const p = { store, household: { myId: null }, homeTab: 'wardrobe', wardrobeOpen: null, setHomeTab: noop, setJournalOpenDate: noop, setWardrobeOpen: noop, openWardrobe: noop, showToast: noop } as unknown as PlannerCtx
    const html = renderToStaticMarkup(<HomeScreen p={p} />)
    const tabs = [...html.matchAll(/role="tab" aria-selected="(true|false)" class="seg(?: on)?">([^<]+)</g)].map(m => `${m[2]}${m[1] === 'true' ? '*' : ''}`)
    expect(html).toContain('>Today</button>')
    expect(tabs).toEqual(['Outfit*', 'Clothes', 'Stats'])
    expect(html).toContain('aria-label="Tops"')
    expect(html).toContain('Add clothing')
  })

  it('takes a way in once: Clothes with the sheet open to add a piece', () => {
    at10()
    const html = wardrobe({ tab: 'clothes', add: true })
    expect(html).toContain('aria-selected="true" class="seg on">Clothes</button>')
    expect(html).toContain('Choose photo')
  })

  it('takes a way in to a past day, or a day ahead to plan, and never further than a year', () => {
    at10()
    expect(wardrobe({ date: '2026-09-12' })).toContain('>Log for Sat 12 Sep</button>')
    expect(wardrobe({ date: '2026-09-20' })).toContain('>Plan for Sun 20 Sep</button>')
    expect(wardrobe({ date: '2027-09-15' })).toContain('>Wearing this</button>')
    expect(wardrobe({ date: 'soon' })).toContain('Today · Mon 14 Sep')
  })
})

describe('what the wardrobe writes', () => {
  const trainers = piece('trainers', 'shoes')
  const planned = (date: string, ids: string[]): Wear => ({ ...look(date, ids), planned: true })

  /** Home → Wardrobe on the morning of TODAY, with what it saves and says caught. */
  function shell(wears: Wear[], open: WardrobeOpen | null = null, outfits: Outfit[] = []) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 14, 10))
    const onSave = vi.fn<(item: Item) => void>()
    const showToast = vi.fn<(msg: string, undo?: () => void) => void>()
    const tree = settled(Wardrobe, { garments: [...tops, ...bottoms, trainers], outfits, wears, onSave, onRemove: noop, onRestore: noop, showToast, open, onOpenConsumed: noop })
    return { tree, showToast, written: () => onSave.mock.calls.map(c => c[0] as Wear) }
  }

  it('files a look for a day still to come as a plan, and one for today or a day gone as worn', () => {
    const { tree, written, showToast } = shell([])
    const { onLog } = propsOf(tree, OutfitComposer)
    onLog('2026-09-20', ['navy-tee', 'jeans'], { shown: new Set() })
    expect(written()[0]).toMatchObject({ date: '2026-09-20', garmentIds: ['navy-tee', 'jeans'], planned: true })
    expect(showToast).toHaveBeenLastCalledWith('Planned for Sun 20 Sep', expect.any(Function))
    onLog(TODAY, ['navy-tee', 'jeans'], { shown: new Set() })
    onLog('2026-09-12', ['navy-tee', 'jeans'], { shown: new Set() })
    expect(written().slice(1).map(w => 'planned' in w)).toEqual([false, false])
  })

  it('says today’s plan was worn when the composer logs it, the plan’s pieces on screen', () => {
    const plan = planned(TODAY, ['grey-tee', 'cords'])
    const { tree, written, showToast } = shell([plan])
    propsOf(tree, OutfitComposer).onLog(TODAY, ['grey-tee', 'cords'], { shown: new Set(['grey-tee', 'cords']) })
    expect(written()[0]).toMatchObject({ id: plan.id, garmentIds: ['grey-tee', 'cords'] })
    expect('planned' in written()[0]).toBe(false)
    expect(showToast).toHaveBeenLastCalledWith('Logged for today', expect.any(Function))
  })

  it('never says a plan was worn from a piece’s Wear today or a saved outfit’s: each is a look of its own beside it', () => {
    const plan = planned(TODAY, ['grey-tee', 'cords'])
    const friday = outfit('o1', ['navy-tee', 'jeans'], 'Friday')
    const { tree, written, showToast } = shell([plan], { garmentId: 'trainers' }, [friday])
    propsOf(tree, GarmentSheet).onWearToday(trainers)
    expect(written()[0]).toMatchObject({ date: TODAY, garmentIds: ['trainers'] })
    expect('planned' in written()[0]).toBe(false)
    expect(showToast).toHaveBeenLastCalledWith('Logged for today', expect.any(Function))
    propsOf(tree, OutfitComposer).onWearOutfit(friday)
    expect(written()[1]).toMatchObject({ date: TODAY, garmentIds: ['navy-tee', 'jeans'] })
    // the plan is left as it was: it counts only once it is said to be worn
    expect(written().some(w => w.id === plan.id)).toBe(false)
  })

  it('puts a piece worn today into today’s look when that look was worn', () => {
    const worn = look(TODAY, ['grey-tee', 'cords'])
    const { tree, written, showToast } = shell([worn], { garmentId: 'trainers' })
    propsOf(tree, GarmentSheet).onWearToday(trainers)
    expect(written()[0]).toMatchObject({ id: worn.id, garmentIds: ['trainers', 'grey-tee', 'cords'] })
    expect(showToast).toHaveBeenLastCalledWith('trainers added to today’s look', expect.any(Function))
  })
})

describe('the guards around the wardrobe', () => {
  const files = ['Wardrobe', 'OutfitComposer', 'SnapRow', 'SavedOutfits', 'Clothes', 'GarmentSheet', 'PieceDetails', 'WardrobeStats', 'WardrobeCard', 'GarmentPhoto']
  const source = (f: string) => read(`../components/wardrobe/${f}.tsx`)

  it('never mentions a project: there is one, and it is not the wardrobe’s business', () => {
    for (const f of files) expect(source(f), f).not.toMatch(/project/i)
    const shown = [
      composer({ outfits: [outfit('o1', ['navy-tee', 'jeans'])], wears: [look(TODAY, ['navy-tee', 'jeans'])] }),
      renderToStaticMarkup(<Clothes garments={tops} ix={wearIndex([], TODAY)} onAdd={noop} onOpen={noop} />),
    ].join('')
    expect(shown).not.toMatch(/project/i)
  })

  it('buzzes on the Today card’s one tap and nowhere else', () => {
    const buzzing = files.filter(f => /haptic\(/.test(source(f)))
    expect(buzzing).toEqual(['WardrobeCard'])
    expect(source('WardrobeCard').match(/void haptic\('light'\)/g)).toHaveLength(1)
  })

  it('keeps its style sheet to tokens: a piece’s colour is set inline, as a place’s is', () => {
    const css = read('../styles/18-wardrobe.css')
    expect(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)).toBeNull()
    const index = read('../styles/index.css')
    expect(index.indexOf("'./18-habits-routines-briefing.css'")).toBeLessThan(index.indexOf("'./18-wardrobe.css'"))
    expect(index.indexOf("'./18-wardrobe.css'")).toBeLessThan(index.indexOf("'./19-native-shell.css'"))
  })

  it('sends every photo through Check the cut-out, loaded only when it is needed', () => {
    const sheet = source('GarmentSheet')
    // the cut-out sheet and its engine come on demand, never in the wardrobe's own chunk
    expect(sheet).toContain("preloadable(() => import('../CutoutSheet').then(m => m.CutoutSheet), 'CutoutSheet')")
    expect(sheet).not.toMatch(/from '\.\.\/CutoutSheet'|from '\.\.\/\.\.\/cutout'/)
    // warmed as Add clothing opens
    expect(sheet).toContain("warm(CutoutSheet.preload, () => import('../../cutout').then(c => c.prepareGarmentCutout()))")
    expect(sheet).toContain('useEffect(warmCutout, [])')
    // what the sheet hands back is what prepareGarmentPhoto makes the piece's photos from, told whether it is the cut-out
    expect(sheet).toContain('prepareGarmentPhoto(picked.file, { cutout: picked.cutout })')
    expect(sheet).toContain('onDone={(f, info) => setPicked({ file: f, cutout: info.cutout, offline: info.offline })}')
    // and Add clothing's back photo, through the same hook
    expect(sheet).toContain('onDone={(f, info) => setBackPicked({ file: f, cutout: info.cutout, offline: info.offline })}')
    expect(sheet).toContain('const back = usePrepared(backPicked)')
    // Replace photo, and Add or Replace back photo, go the same way
    expect(sheet).toContain('onDone={(f, info) => void replace(f, info.cutout, info.offline, checking.side)}')
    expect(sheet).toContain('prepareGarmentPhoto(file, { cutout })')
    // and no photo reaches prepareGarmentPhoto without the sheet: its only callers are those two
    expect(sheet.match(/prepareGarmentPhoto\(/g)).toHaveLength(2)
  })

  it('lets the iPhone app open the camera, for the wardrobe and for notes', () => {
    expect(read('../../ios/App/App/Info.plist')).toMatch(/<key>NSCameraUsageDescription<\/key>\s*<string>[^<]*wardrobe[^<]*notes[^<]*<\/string>/)
  })

  it('deletes a garment’s photos with Delete forever, and sends waiting photos at launch and on a pull', () => {
    const shell = plannerSource()
    // front and back: the one list every clean-up reads (shared/media.mjs)
    expect(shell).toContain("if (row?.kind === 'garment') void deleteMedia(mediaIdsOf(row))")
    expect(shell).toContain('useEffect(() => watchPendingMedia(), [])')
    expect(shell).toMatch(/const manualSync = async \(\) => \{[\s\S]*?void flushPendingMedia\(\)/)
  })

  it('lets go of the photos Replace photo swapped out, and of the new ones when Undo swaps back', () => {
    const wardrobe = source('Wardrobe')
    expect(wardrobe).toMatch(/const editPiece = [\s\S]*?onSave\(after\)\s*letGo\(before, after\)[\s\S]*?onSave\(back\)\s*letGo\(after, back\)/)
    // each swap names its piece, so it can wait for the server to have the edit
    expect(wardrobe).toMatch(/const \{ gone, now \} = swappedPhotos\(from, to\)\s*if \(gone\.length\) retireMedia\(gone, now, to\.id\)/)
    // a piece's thumbnail is saved as its photo's, so the two count as one photo:
    // one place does it, for Add clothing's front and back and for either side of a piece
    const sheet = source('GarmentSheet')
    expect(sheet.match(/thumbOf: photoId/g)).toHaveLength(1)
    expect(sheet).toContain('const thumbId = await saveMedia(p.thumb, { personal: true, userId, thumbOf: photoId })')
    expect(sheet.match(/await fileAway\(/g)).toHaveLength(3)
    expect(sheet).not.toMatch(/saveMedia\((?!p\.photo|p\.thumb)/)
    // the swaps are told what every piece here, live or in Trash, points at — once the records are in —
    // and what the server may still hold: the records it has not confirmed, and what its copies point at
    const shell = plannerSource()
    expect(shell).toMatch(/mediaInUse\.current = \(\) => \{\s*if \(!store\.loaded\) return null/)
    expect(shell).toContain('const { ids: unsynced, shadows } = store.unconfirmed()')
    expect(shell).toContain('return { userId: household.myId, ids: garmentMediaIds(store.allItems), unsynced, onServer: garmentMediaIds(shadows) }')
    expect(shell).toContain('useEffect(() => trackMediaInUse(() => mediaInUse.current()), [])')
    // and they look again whenever a round is answered
    expect(shell).toContain('useEffect(() => void retireDue(), [store.syncInfo.lastAt])')
  })

  it('takes a dropped or pasted photo through the filter a note’s photos go through', () => {
    const file = (name: string, type: string) => ({ name, type }) as File
    expect(imageFiles([file('a.jpg', 'image/jpeg'), file('b.pdf', 'application/pdf'), file('c.heic', 'image/heic')]).map(f => f.name)).toEqual(['a.jpg', 'c.heic'])
    expect(read('../components/RichNotes.tsx')).toContain('const list = imageFiles(files)')
    const sheet = source('GarmentSheet')
    expect(sheet).toContain('imageFiles(e.clipboardData?.files ?? [])')
    expect(sheet).toContain('const photos = imageFiles(files)')
    expect(sheet).toContain('take.current.drop(e.dataTransfer.files)')
    // a file dropped anywhere while the sheet is open is its to take, never the browser's to open
    expect(sheet).toContain("window.addEventListener('dragover', onDragOver)")
    expect(sheet).toContain("window.addEventListener('drop', onDrop)")
    // and none is taken while a save is still reading the queue
    expect(sheet).toContain('if (chosen.length === 0 || saving) return')
  })

  it('reads the forecast the briefing cached, and never fetches one of its own', () => {
    const hook = read('../components/wardrobe/forecast.ts')
    expect(hook).toContain('cachedForecast()')
    for (const f of [...files.map(source), hook]) expect(f).not.toMatch(/getWeather|fetchForecast|watchWeather|fetch\(/)
  })
})

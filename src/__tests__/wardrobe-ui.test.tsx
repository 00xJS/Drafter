import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formatMoney } from '../bills'
import type { PlannerCtx } from '../components/planner/ctx'
import { HomeScreen } from '../components/planner/HomeScreen'
import { Wardrobe as LazyWardrobe } from '../components/planner/lazy'
import { Clothes } from '../components/wardrobe/Clothes'
import { GarmentSheet, type SheetMode } from '../components/wardrobe/GarmentSheet'
import { OutfitComposer } from '../components/wardrobe/OutfitComposer'
import { PieceDetails, readPrice } from '../components/wardrobe/PieceDetails'
import { OutfitMenu } from '../components/wardrobe/SavedOutfits'
import { Wardrobe } from '../components/wardrobe/Wardrobe'
import { WardrobeStats } from '../components/wardrobe/WardrobeStats'
import { imageFiles } from '../media'
import type { Garment, GarmentType, Outfit, Wear } from '../types'
import { liveById, unwearable, wearIndex } from '../wardrobe'
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

function composer(over: Partial<ComponentProps<typeof OutfitComposer>> = {}) {
  const garments = over.garments ?? [...tops, ...bottoms]
  const wears = over.wears ?? []
  return renderToStaticMarkup(
    <OutfitComposer
      garments={garments}
      outfits={[]}
      wears={wears}
      byId={liveById(garments)}
      ix={wearIndex(wears, TODAY)}
      day={TODAY}
      todayKey={TODAY}
      onDay={noop}
      onLog={noop}
      onRemoveLook={noop}
      onSaveOutfit={noop}
      onAdd={noop}
      onOpenPiece={noop}
      onWearOutfit={noop}
      onRenameOutfit={noop}
      onFavouriteOutfit={noop}
      onDeleteOutfit={noop}
      forecast={null}
      {...over}
    />,
  )
}

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
    // the chosen card's way to its piece, and the dashed tile at each row's end
    expect(html).toContain('aria-label="About black-tee"')
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

  it('starts a logged day on its latest look, with Update look, + Another look and Remove look', () => {
    const html = composer({ wears: [look(TODAY, ['navy-tee', 'jeans']), look(TODAY, ['grey-tee', 'cords'])] })
    expect(chosenNames(html)).toEqual(['grey-tee', 'cords'])
    expect(html).toContain('>Logged</span>')
    expect(html).toContain('>Update look</button>')
    // "+ Another look", or "+ Look" on a phone: named the same either way
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
    expect(only).toContain('<button type="button" class="btn primary">Wearing this</button>')
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
    expect(html).not.toContain('aria-label="Another look"')
  })

  it('carries the day’s note into its field, and deals a look with Surprise me', () => {
    const html = composer({ wears: [{ ...look(TODAY, ['navy-tee', 'jeans']), note: 'wedding' }] })
    expect(html).toContain('<span>Note on the look</span>')
    expect(html).toContain('value="wedding"')
    expect(html).toContain('Surprise me</button>')
    expect(composer()).not.toContain('value="wedding"')
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

  it('reads a typed price as whole units of the currency, and nothing that is not a price', () => {
    expect(readPrice('40')).toBe(40)
    expect(readPrice(' £1,250 ')).toBe(1250)
    expect(readPrice('39.60')).toBe(40)
    expect(readPrice('')).toBeNull()
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

  it('is Home’s fourth segment, and opens on the composer', () => {
    at10()
    const store = { garments: [...tops, ...bottoms], outfits: [], wears: [], upsert: noop, remove: noop, restore: noop }
    const p = { store, household: { myId: null }, homeTab: 'wardrobe', wardrobeOpen: null, setHomeTab: noop, setJournalOpenDate: noop, setWardrobeOpen: noop, openWardrobe: noop, showToast: noop } as unknown as PlannerCtx
    const html = renderToStaticMarkup(<HomeScreen p={p} />)
    const tabs = [...html.matchAll(/role="tab" aria-selected="(true|false)" class="seg(?: on)?">([^<]+)</g)].map(m => `${m[2]}${m[1] === 'true' ? '*' : ''}`)
    expect(tabs).toEqual(['Today', 'Week', 'Journal', 'Wardrobe*', 'Outfit*', 'Clothes', 'Stats'])
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

  it('lets the iPhone app open the camera, for the wardrobe and for notes', () => {
    expect(read('../../ios/App/App/Info.plist')).toMatch(/<key>NSCameraUsageDescription<\/key>\s*<string>[^<]*wardrobe[^<]*notes[^<]*<\/string>/)
  })

  it('deletes a garment’s photos with Delete forever, and sends waiting photos at launch and on a pull', () => {
    const shell = plannerSource()
    expect(shell).toContain("if (row?.kind === 'garment') void deleteMedia([row.photoId, row.thumbId])")
    expect(shell).toContain('useEffect(() => watchPendingMedia(), [])')
    expect(shell).toMatch(/const manualSync = async \(\) => \{[\s\S]*?void flushPendingMedia\(\)/)
  })

  it('takes a dropped or pasted photo through the filter a note’s photos go through', () => {
    const file = (name: string, type: string) => ({ name, type }) as File
    expect(imageFiles([file('a.jpg', 'image/jpeg'), file('b.pdf', 'application/pdf'), file('c.heic', 'image/heic')]).map(f => f.name)).toEqual(['a.jpg', 'c.heic'])
    expect(read('../components/RichNotes.tsx')).toContain('const list = imageFiles(files)')
    const sheet = source('GarmentSheet')
    expect(sheet).toContain('imageFiles(e.clipboardData?.files ?? [])')
    expect(sheet).toContain('imageFiles(e.dataTransfer.files)')
  })

  it('reads the forecast the briefing cached, and never fetches one of its own', () => {
    const hook = read('../components/wardrobe/forecast.ts')
    expect(hook).toContain('cachedForecast()')
    for (const f of [...files.map(source), hook]) expect(f).not.toMatch(/getWeather|fetchForecast|watchWeather|fetch\(/)
  })
})

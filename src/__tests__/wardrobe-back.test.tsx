import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// retireMedia is where a photo a write let go of starts on its way out (after
// the upload, the Undo's minute and the server's confirmation, media.ts): kept
// here instead, so a test can read what each write let go of.
const { retired } = vi.hoisted(() => ({ retired: [] as { gone: string[]; now: string[]; garment: string }[] }))
vi.mock('../media', async importOriginal => ({
  ...(await importOriginal<typeof import('../media')>()),
  retireMedia: (gone: readonly (string | undefined)[], now: readonly (string | undefined)[], garment: string) =>
    void retired.push({ gone: gone.filter((id): id is string => !!id), now: now.filter((id): id is string => !!id), garment }),
}))

import { mergeRecord } from '../../shared/merge.mjs'
import { Clothes } from '../components/wardrobe/Clothes'
import { Collage, GarmentInset, GarmentPhoto, GarmentView, flipLabel, hasBack, mainSide } from '../components/wardrobe/GarmentPhoto'
import { GarmentSheet } from '../components/wardrobe/GarmentSheet'
import { SnapRow } from '../components/wardrobe/SnapRow'
import { Wardrobe } from '../components/wardrobe/Wardrobe'
import type { Garment, GarmentType, Item } from '../types'
import { liveById, wearIndex, withBack } from '../wardrobe'
import { elements, propsOf, settled } from './rendered'

// A piece's back photo (a shirt whose logo is there): the other side drawn
// small in the corner of the card-size views, a button that swaps the two in
// the sheet and on the composer's cards and a mark in Clothes, the main side
// alone on every small thumbnail, and the clean-up a Remove or a Replace of it
// sets off, with its Undo.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const noop = () => {}
const T0 = '2026-08-01T09:00:00.000Z'
const TODAY = '2026-09-14'
const USER = '00000000-0000-0000-0000-00000000000a'
const P = (n: number) => `personal/${USER}/${String(n).repeat(8)}`

const piece = (id: string, type: GarmentType, over: Partial<Garment> = {}): Garment => ({ kind: 'garment', id, name: id, type, createdAt: T0, updatedAt: T0, ...over })
const plain = piece('plain-tee', 'top', { photoId: P(1), thumbId: P(2) })
const band = piece('band-tee', 'top', { photoId: P(3), thumbId: P(4), backPhotoId: P(5), backThumbId: P(6) })
const backFirst: Garment = { ...band, showBack: true }
const jeans = piece('jeans', 'bottom')

/** The side each picture in a render shows, in order. */
const sides = (html: string) => [...html.matchAll(/<span class="garment-photo(?: [^"]*)?"(?: style="[^"]*")?( data-side="back")?>/g)].map(m => (m[1] ? 'back' : 'front'))
/** Calls a GarmentInset's flip, as a tap would. */
const flipIn = (tree: Parameters<typeof propsOf>[0]) => (propsOf(tree, GarmentInset) as { onFlip(): void }).onFlip()

afterEach(() => {
  retired.length = 0
})

describe('a piece’s two sides', () => {
  it('lead with the front, or with the back when Show the back first is on and there is one', () => {
    expect([hasBack(plain), hasBack(band), hasBack(piece('x', 'top', { backThumbId: P(7) }))]).toEqual([false, true, true])
    expect(mainSide(band)).toBe('front')
    expect(mainSide(backFirst)).toBe('back')
    // no back to lead with: the front it is
    expect(mainSide({ ...plain, showBack: true })).toBe('front')
    expect([flipLabel('back'), flipLabel('front')]).toEqual(['Show the back', 'Show the front'])
  })

  it('draw the other side as an inset only for a piece with a back photo, and the back first swaps them', () => {
    expect(renderToStaticMarkup(<GarmentView garment={plain} />)).not.toContain('garment-inset')
    const html = renderToStaticMarkup(<GarmentView garment={band} />)
    expect(html).toContain('<span class="garment-inset" aria-hidden="true">')
    expect(sides(html)).toEqual(['front', 'back'])
    expect(sides(renderToStaticMarkup(<GarmentView garment={backFirst} />))).toEqual(['back', 'front'])
  })

  it('show a small thumbnail by its main side alone, with no inset: a collage, a list’s photo', () => {
    const collage = renderToStaticMarkup(<Collage ids={['band-tee', 'jeans']} byId={liveById([backFirst, jeans])} />)
    expect(collage).not.toContain('garment-inset')
    expect(sides(collage)).toEqual(['back', 'front'])
    expect(sides(renderToStaticMarkup(<GarmentPhoto garment={backFirst} className="thumb-28" />))).toEqual(['back'])
    expect(renderToStaticMarkup(<GarmentPhoto garment={band} />)).not.toMatch(/data-side|garment-inset/)
  })

  it('keep the inset to the card-size views: the piece sheet, a Clothes tile and the composer’s cards', () => {
    const small = ['Today.tsx', 'Calendar.tsx', 'Search.tsx', 'Review.tsx', 'wardrobe/WardrobeCard.tsx', 'wardrobe/WardrobeStats.tsx', 'wardrobe/SavedOutfits.tsx', 'wardrobe/PieceDetails.tsx', 'wardrobe/OutfitComposer.tsx']
    for (const f of small) expect(read(`../components/${f}`), f).not.toMatch(/GarmentView|GarmentInset/)
    expect(read('../components/wardrobe/Clothes.tsx')).toContain('<GarmentView garment={garment} />')
    expect(read('../components/wardrobe/GarmentSheet.tsx')).toContain('<GarmentView key={mainSide(g)} garment={g} size="photo" alt={g.name} flip />')
    expect(read('../components/wardrobe/SnapRow.tsx')).toContain('<GarmentInset garment={g} side={otherSide(shown)} className="snap-flip"')
  })
})

describe('the composer’s cards', () => {
  const rowProps = (over: Partial<ComponentProps<typeof SnapRow>> = {}): ComponentProps<typeof SnapRow> => ({
    label: 'Tops',
    pieces: [plain, band],
    ix: wearIndex([], TODAY),
    selected: 'band-tee',
    onSelect: vi.fn(),
    onInfo: noop,
    onAdd: noop,
    addLabel: '+ Add top',
    emptyLabel: 'No tops yet · Add one',
    ...over,
  })

  it('flip a piece with a back photo with a button beside its card, named for the side it brings up', () => {
    const html = renderToStaticMarkup(<SnapRow {...rowProps()} />)
    expect(html.match(/garment-inset/g)).toHaveLength(1)
    expect(html).toContain('<button type="button" class="garment-inset snap-flip flip" aria-label="Show the back" title="Show the back" tabindex="0">')
    // a side card's is out of the Tab order, as the side cards are
    expect(renderToStaticMarkup(<SnapRow {...rowProps({ selected: 'plain-tee' })} />)).toContain('aria-label="Show the back" title="Show the back" tabindex="-1"')
    // beside the card, never in it: a radio's contents are not a screen reader's to reach, and its tap chooses
    const tree = settled(SnapRow, rowProps())
    const inset = elements(tree).find(e => e.type === GarmentInset)!
    for (const radio of elements(tree).filter(e => e.props.role === 'radio')) expect(elements(radio.props.children)).not.toContain(inset)
  })

  it('swap a card’s two sides at a tap, for the visit only: nothing is chosen, and nothing saved', () => {
    const onSelect = vi.fn()
    const flipped = settled(SnapRow, rowProps({ onSelect }), flipIn)
    expect(elements(flipped).filter(e => e.type === GarmentPhoto).map(e => [(e.props.garment as Garment).id, e.props.side])).toEqual([
      ['plain-tee', 'front'],
      ['band-tee', 'back'],
    ])
    expect(propsOf(flipped, GarmentInset)).toMatchObject({ side: 'front' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('leave the row to scroll from the inset and snap as ever, the target at 44pt however small the card', () => {
    const css = read('../styles/18-wardrobe.css')
    const block = (sel: string) => css.match(new RegExp(`\\n${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? ''
    for (const sel of ['.garment-inset', '.snap-flip']) {
      expect(block(sel), sel).not.toBe('')
      expect(block(sel), sel).not.toMatch(/touch-action|pointer-events|scroll-snap/)
    }
    expect(block('.garment-inset')).toContain('border: 2px solid var(--surface);')
    expect(css).toMatch(/\.garment-inset\.flip::after \{\s*content: '';\s*position: absolute;\s*inset: min\(0px, calc\(50% - 22px\)\);/)
    // a quick fade of the picture alone, which reduced motion drops: no box moves
    expect(css).toMatch(/@keyframes garment-fade \{\s*from \{\s*opacity: 0\.35;\s*\}\s*\}/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.garment-photo\.flippable img \{\s*animation: none;/)
  })
})

describe('the piece sheet', () => {
  const sheet = (g: Garment) =>
    renderToStaticMarkup(
      <GarmentSheet
        mode={{ kind: 'edit', id: g.id }}
        garments={[g, jeans]}
        outfits={[]}
        byId={liveById([g, jeans])}
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

  it('offers Add back photo for a piece with a front alone, and nothing to flip', () => {
    const html = sheet(plain)
    expect(html).toContain('Add back photo')
    expect(html).not.toMatch(/Replace back photo|Remove back photo|Show the back first|garment-inset/)
    // a piece with no photo has no back to add yet
    expect(sheet(jeans)).not.toContain('back photo')
  })

  it('with a back: Replace, Remove and Show the back first, and the photo flips with its inset, a button', () => {
    const html = sheet(band)
    for (const s of ['Replace back photo', '>Remove back photo</button>', 'Show the back first', '<input type="checkbox" role="switch" class="tcheck"/>']) expect(html).toContain(s)
    expect(html).toContain('<button type="button" class="garment-inset flip" aria-label="Show the back" title="Show the back">')
    expect(sides(html).slice(0, 2)).toEqual(['front', 'back'])
    const first = sheet(backFirst)
    expect(first).toContain('<input type="checkbox" role="switch" class="tcheck" checked=""/>')
    expect(first).toContain('aria-label="Show the front"')
    expect(sides(first).slice(0, 2)).toEqual(['back', 'front'])
  })

  it('flips its photo for the view alone', () => {
    const view = settled(GarmentView, { garment: band, size: 'photo', alt: 'band-tee', flip: true }, flipIn)
    expect(propsOf(view, GarmentPhoto)).toMatchObject({ side: 'back', alt: 'band-tee, the back' })
    expect(propsOf(view, GarmentInset)).toMatchObject({ side: 'front' })
  })

  it('offers Add clothing’s + Back photo only once the front is in', () => {
    const add = renderToStaticMarkup(
      <GarmentSheet mode={{ kind: 'add' }} garments={[]} outfits={[]} byId={new Map()} ix={wearIndex([], TODAY)} todayKey={TODAY} onCreate={noop} onEdit={noop} onRetire={noop} onDelete={noop} onWearToday={noop} onGoDay={noop} onOpenPiece={noop} onClose={noop} />,
    )
    expect(add).not.toContain('Back photo')
    expect(read('../components/wardrobe/GarmentSheet.tsx')).toMatch(/\{ready && \(\s*<div className="garment-add-back">/)
    // a Save that fails once the front is filed (the back's write, say) takes the front back out: nothing is left pending
    expect(read('../components/wardrobe/GarmentSheet.tsx')).toMatch(/fileAway\(ready, userId, filed\)[\s\S]*fileAway\(back\.ready, userId, filed\)[\s\S]*catch \(err\) \{[\s\S]*?await deleteMedia\(filed\)/)
  })
})

describe('Clothes', () => {
  it('marks a tile whose piece has a back photo, says so in words, and leaves the tile its one button', () => {
    const html = renderToStaticMarkup(<Clothes garments={[plain, band]} ix={wearIndex([], TODAY)} onAdd={noop} onOpen={noop} />)
    const tiles = html
      .split('<button type="button" class="clothes-tile">')
      .slice(1)
      .map(t => t.slice(0, t.indexOf('</button>')))
    expect(tiles).toHaveLength(2)
    const plainTile = tiles.find(t => t.includes('>plain-tee<'))!
    const bandTile = tiles.find(t => t.includes('>band-tee<'))!
    expect(plainTile).not.toMatch(/garment-inset|back photo/)
    expect(bandTile).toContain('<span class="garment-inset" aria-hidden="true">')
    expect(bandTile).toContain('<span class="wardrobe-sr"> (with a back photo)</span>')
    expect(bandTile).not.toContain('<button')
    expect(html).not.toContain('Show the back')
  })
})

describe('what a back photo’s Remove and Replace let go of', () => {
  function openSheet() {
    const onSave = vi.fn<(item: Item) => void>()
    const toasts: { msg: string; undo?: () => void }[] = []
    const tree = settled(Wardrobe, {
      garments: [band, jeans],
      outfits: [],
      wears: [],
      onSave,
      onRemove: noop,
      onRestore: noop,
      showToast: (msg: string, undo?: () => void) => void toasts.push({ msg, undo }),
      open: { tab: 'clothes', garmentId: 'band-tee' },
      onOpenConsumed: noop,
    })
    return { onEdit: propsOf(tree, GarmentSheet).onEdit, onSave, toasts }
  }

  it('Remove back photo lets go of the back as Replace photo lets go of a front; its Undo brings the ids back and lets go of nothing', () => {
    const { onEdit, onSave, toasts } = openSheet()
    const removed = withBack(band, null)
    onEdit(band, removed, 'Back photo removed')
    expect(onSave).toHaveBeenLastCalledWith(removed)
    expect(retired).toEqual([{ gone: [P(5), P(6)], now: [P(3), P(4)], garment: 'band-tee' }])
    expect(toasts.map(t => t.msg)).toEqual(['Back photo removed'])
    toasts[0].undo!()
    const back = onSave.mock.lastCall![0] as Garment
    expect(back).toMatchObject({ backPhotoId: P(5), backThumbId: P(6) })
    expect(back.updatedAt > removed.updatedAt).toBe(true)
    // pointed at again, the back stays: the swap's clean-up skips whatever a piece points at
    expect(retired).toHaveLength(1)
  })

  it('Replace back photo lets go of the old back; its Undo lets go of the new one and brings the old ids back', () => {
    const { onEdit, onSave, toasts } = openSheet()
    onEdit(band, withBack(band, { photoId: P(7), thumbId: P(8) }), 'Back photo replaced')
    expect(retired).toEqual([{ gone: [P(5), P(6)], now: [P(3), P(4), P(7), P(8)], garment: 'band-tee' }])
    toasts[0].undo!()
    expect(onSave.mock.lastCall![0]).toMatchObject({ backPhotoId: P(5), backThumbId: P(6) })
    expect(retired[1]).toEqual({ gone: [P(7), P(8)], now: [P(3), P(4), P(5), P(6)], garment: 'band-tee' })
  })
})

describe('a back photo in a sync', () => {
  it('merges as plain values: two devices’ different fields both stay, and one field changed both ways is a conflict', () => {
    const base = { ...band, updatedAt: '2026-09-14T08:00:00.000Z' }
    const local: Garment = { ...base, showBack: true, updatedAt: '2026-09-14T08:01:00.000Z' }
    const remote: Garment = { ...base, favourite: true, updatedAt: '2026-09-14T08:02:00.000Z' }
    const { merged, conflicts } = mergeRecord(base, local, remote)
    expect(merged).toMatchObject({ showBack: true, favourite: true, backPhotoId: P(5), backThumbId: P(6) })
    expect(conflicts).toEqual([])
    const replacedHere: Garment = { ...base, backPhotoId: P(7), backThumbId: P(8) }
    const removedThere: Garment = { ...base, backPhotoId: undefined, backThumbId: undefined }
    expect(mergeRecord(base, replacedHere, removedThere).conflicts.map(c => c.path)).toEqual([['backPhotoId'], ['backThumbId']])
  })
})

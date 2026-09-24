import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Clothes } from '../components/wardrobe/Clothes'
import { GarmentPhoto, TYPE_ICON } from '../components/wardrobe/GarmentPhoto'
import { GarmentSheet } from '../components/wardrobe/GarmentSheet'
import type { Garment, GarmentType } from '../types'
import { liveById, wearIndex } from '../wardrobe'
import { partialSource, viewSheet } from './source'

/*
 * A piece you are not holding.
 *
 * Add clothing leads with a photo, and for most pieces that is right — the
 * picture is what you recognise in the rows. But a shirt is still a shirt
 * while it is in the wash, and the whole wardrobe should not wait on a photo
 * session. So a piece can be saved on its name alone and take its photo
 * whenever it turns up: nothing else about it changes, because every row,
 * look, figure and calendar day points at the piece by id and draws whatever
 * photo it has at the time.
 */

const T0 = '2026-08-01T09:00:00.000Z'
const TODAY = '2026-09-14'
const USER = '00000000-0000-0000-0000-00000000000a'
const P = (n: number) => `personal/${USER}/${String(n).repeat(8)}`
const noop = () => {}
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const piece = (id: string, type: GarmentType, over: Partial<Garment> = {}): Garment => ({ kind: 'garment', id, name: id, type, createdAt: T0, updatedAt: T0, ...over })
/** Saved on its name alone: no photoId, no thumbId, no colour sampled from one. */
const unshot = piece('oxford', 'top', { name: 'Blue Oxford shirt' })
const shot = piece('tee', 'top', { name: 'Plain tee', photoId: P(1), thumbId: P(2) })

const sheet = (g: Garment) =>
  renderToStaticMarkup(
    <GarmentSheet
      mode={{ kind: 'edit', id: g.id }}
      garments={[g]}
      outfits={[]}
      byId={liveById([g])}
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

describe('Add clothing: the photo is the usual way in, not the only one', () => {
  const source = read('../components/wardrobe/GarmentSheet.tsx')

  it('says so on the picker, rather than leaving you to guess that Save works empty', () => {
    expect(source).toContain('Or just name it below and Save — you can add the photo later')
  })

  it('never gates Save on a photo: the wait is for one still being cut out, not for one to exist', () => {
    const waiting = /const waiting = ([^\n]+)/.exec(source)?.[1] ?? ''
    expect(waiting).toBeTruthy()
    // `!!file && !ready` is the one photo term, and it is about a photo being
    // cut out, not about there being one. With it taken out nothing else in
    // the expression mentions the photo at all.
    expect(waiting).toContain('(!!file && !ready)')
    expect(waiting.replace('(!!file && !ready)', '')).not.toMatch(/ready|photo/)
  })

  it('files the piece with no photo and no colour, rather than a placeholder of either', () => {
    // the create call names them straight off the photo, so both are undefined
    // when there is none — a colour invented here would be a lie the tints,
    // the name suggestions and the placeholder all repeat
    const create = source.slice(source.indexOf('onCreate({'), source.indexOf('// kept as it was only for want of a connection'))
    expect(create).toContain('photoId: front?.photoId')
    expect(create).toContain('thumbId: front?.thumbId')
    expect(create).toContain('color: ready?.color')
  })
})

describe('the piece sheet: a photo arrives whenever it arrives', () => {
  it('makes the empty picture the picker, so the obvious gesture works', () => {
    const html = sheet(unshot)
    expect(html).toContain('garment-hero-pick')
    expect(html).toContain('Add a photo')
    // the tile still carries the type, so you can see what you are filling
    expect(html).toContain('garment-view')
  })

  it('leaves a piece that has a photo alone: no second picker over its picture', () => {
    const html = sheet(shot)
    expect(html).not.toContain('garment-hero-pick')
    expect(html).not.toContain('Add a photo')
  })

  it('says Add photo in the footer where there is none, and Replace photo where there is', () => {
    expect(sheet(unshot)).toMatch(/Add photo/)
    expect(sheet(unshot)).not.toMatch(/Replace photo/)
    expect(sheet(shot)).toMatch(/Replace photo/)
    expect(sheet(shot)).not.toMatch(/>Add photo/)
  })

  it('keeps the back photo behind the front: a back with no front has nothing to be the back of', () => {
    expect(sheet(unshot)).not.toContain('back photo')
    expect(sheet(shot)).toContain('Add back photo')
  })

  it('reads one answer for whether the piece has a front, so the three controls cannot disagree', () => {
    const source = read('../components/wardrobe/GarmentSheet.tsx')
    expect(source).toContain('const hasPhoto = !!(g.photoId || g.thumbId)')
    // and nothing asks the question its own way afterwards
    const body = source.slice(source.indexOf('const hasPhoto ='))
    expect(body).not.toMatch(/\{\(g\.photoId \|\| g\.thumbId\)/)
  })
})

describe('a piece’s picture, with a photo or without one', () => {
  it('draws a piece with no photo as its type’s outline, never the word for it', () => {
    const html = renderToStaticMarkup(<GarmentPhoto garment={unshot} />)
    expect(html).toMatch(/^<span class="garment-photo"><span class="garment-photo-type" aria-hidden="true"><svg /)
    expect(html).not.toContain('>Top<')
    // one outline for each type, each its own
    expect(new Set(Object.values(TYPE_ICON)).size).toBe(6)
    // and Clothes draws its tile so
    const tiles = renderToStaticMarkup(<Clothes garments={[unshot]} ix={wearIndex([], TODAY)} onAdd={noop} onOpen={noop} />)
    expect(tiles).toContain('<span class="garment-photo-type" aria-hidden="true"><svg')
    expect(tiles).not.toContain('>Top<')
  })

  it('sets a photo on the photo’s own white, so a cut-out has no grey band round it, in a square Clothes tile', () => {
    const css = partialSource('18-wardrobe.css')
    expect(css).toMatch(/\.garment-photo\.has-photo \{\s*background: var\(--photo-white\);\s*\}/)
    // the sunken ground stays for a piece with no photo
    expect(css).toMatch(/\n\.garment-photo \{[^}]*background: var\(--surface-2\);/)
    expect(viewSheet('wardrobe.css')).toMatch(/\.clothes-tile \.garment-view \{\s*width: 100%;\s*aspect-ratio: 1;\s*min-height: 0;\s*\}/)
  })
})

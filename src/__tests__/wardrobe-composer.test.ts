import { describe, expect, it } from 'vitest'
import { chosenIn, heldPieces, load, rowsOf, shownIn, start, type Selection } from '../components/wardrobe/composer'
import type { Garment, GarmentType, Wear } from '../types'
import { byRest, liveById, logLook, looksOn, wearIndex } from '../wardrobe'

// The composer's selection as a thumb drives it, then what Update look
// writes. A day's look is shown as it is — a retired piece in it, or one in
// Trash, joins its row for the visit — so it keeps its day unless you move
// that row, and no piece is written that you did not choose.

const T0 = '2026-08-01T09:00:00.000Z'
const TODAY = '2026-09-14'
const DAY = '2026-08-31'

const piece = (id: string, type: GarmentType, over: Partial<Garment> = {}): Garment => ({ kind: 'garment', id, name: id, type, createdAt: T0, updatedAt: T0, ...over })
const look = (date: string, garmentIds: string[]): Wear => ({ kind: 'wear', id: `wear~${date}~0000000001`, date, garmentIds, createdAt: `${date}T08:00:00.000Z`, updatedAt: `${date}T08:00:00.000Z` })

const bandTee = piece('band-tee', 'top', { name: 'Old band tee', archivedAt: '2026-09-10T09:00:00.000Z' })
const hoodie = piece('hoodie', 'top', { name: 'Grey hoodie' })
const shirt = piece('shirt', 'top')
const jeans = piece('jeans', 'bottom', { name: 'Blue jeans' })
const chinos = piece('chinos', 'bottom')
const trainers = piece('trainers', 'shoes')
const boots = piece('boots', 'shoes')
const scarf = piece('scarf', 'accessory')
const wardrobe = [bandTee, hoodie, shirt, jeans, chinos, trainers, boots, scarf]

/** The composer as it mounts on `day`: the rows dealt, the day's held pieces in them, and its latest look put in them. */
function visit(wears: Wear[], day: string, garments: Garment[] = wardrobe, inTrash: Garment[] = []) {
  const looks = looksOn(wears, day)
  const latest = looks[looks.length - 1]
  const byId = liveById(garments)
  const rows = rowsOf(
    garments,
    byRest(garments, wearIndex(wears, TODAY)).map(g => g.id),
    heldPieces(latest, garments, inTrash),
  )
  return { rows, byId, sel: start(rows, latest, byId) }
}
const picking = (sel: Selection, over: Partial<Selection['picked']>): Selection => ({ ...sel, picked: { ...sel.picked, ...over } })
const sorted = (ids: readonly string[]) => [...ids].sort()

describe('a day holding a retired piece', () => {
  it('shows it first in its row, chosen, with nothing to explain', () => {
    const { rows, sel } = visit([look(DAY, ['band-tee', 'jeans'])], DAY)
    expect(rows.top[0].id).toBe('band-tee')
    expect(chosenIn(sel, rows, []).slots.top).toBe('band-tee')
    expect(chosenIn(sel, rows, []).dressed).toBe(true)
    expect(sel.note).toBeUndefined()
  })

  it('keeps it when only the shoes change: Update look writes it back under the same id', () => {
    const day = look(DAY, ['band-tee', 'jeans', 'trainers'])
    const { rows, sel } = visit([day], DAY)
    const { pieces } = chosenIn(picking(sel, { shoes: 'boots' }), rows, [])
    const { write } = logLook([day], DAY, pieces, wardrobe, { shown: shownIn(rows) })
    expect(write.id).toBe(day.id)
    expect(sorted(write.garmentIds)).toEqual(['band-tee', 'boots', 'jeans'])
  })

  it('keeps it when an accessory is added, and writes no top that was never chosen', () => {
    const day = look('2026-09-01', ['band-tee', 'jeans'])
    const { rows, sel } = visit([day], '2026-09-01')
    const { pieces } = chosenIn(picking(sel, { accessories: ['scarf'] }), rows, [])
    const { write } = logLook([day], '2026-09-01', pieces, wardrobe, { shown: shownIn(rows) })
    expect(sorted(write.garmentIds)).toEqual(['band-tee', 'jeans', 'scarf'])
  })

  it('lets it go when you move its row: that top is replaced, as you chose', () => {
    const day = look(DAY, ['band-tee', 'jeans'])
    const { rows, sel } = visit([day], DAY)
    const { pieces } = chosenIn(picking(sel, { top: 'hoodie' }), rows, [])
    expect(sorted(logLook([day], DAY, pieces, wardrobe, { shown: shownIn(rows) }).write.garmentIds)).toEqual(['hoodie', 'jeans'])
  })

  it('leaves the rows on any other day', () => {
    const { rows } = visit([look(DAY, ['band-tee', 'jeans'])], TODAY)
    expect(rows.top.map(g => g.id)).not.toContain('band-tee')
  })
})

describe('a day holding a piece in Trash', () => {
  const binned = { ...shirt, deletedAt: '2026-09-12T09:00:00.000Z' }
  const live = wardrobe.filter(g => g.id !== 'shirt')

  it('shows it in its row too, so Update look keeps one top and a Restore finds one top, not two', () => {
    const day = look('2026-09-01', ['shirt', 'jeans'])
    const { rows, sel } = visit([day], '2026-09-01', live, [binned])
    expect(rows.top[0].id).toBe('shirt')
    const chosen = chosenIn(picking(sel, { accessories: ['scarf'] }), rows, [])
    expect(chosen.dressed).toBe(true)
    const { write } = logLook([day], '2026-09-01', chosen.pieces, [...live, binned], { shown: shownIn(rows) })
    expect(sorted(write.garmentIds)).toEqual(['jeans', 'scarf', 'shirt'])
  })

  it('keeps an id with no record at all (deleted forever), and says a piece was deleted', () => {
    const day = look('2026-09-01', ['gone-forever', 'hoodie', 'jeans'])
    const { rows, sel } = visit([day], '2026-09-01')
    expect(sel.note).toBe('A piece was deleted')
    const { write } = logLook([day], '2026-09-01', chosenIn(sel, rows, []).pieces, wardrobe, { shown: shownIn(rows) })
    expect(sorted(write.garmentIds)).toEqual(['gone-forever', 'hoodie', 'jeans'])
  })
})

describe('a saved outfit put in the rows', () => {
  it('leaves a retired piece’s row where it was, and names the piece', () => {
    const { rows, sel, byId } = visit([], TODAY)
    const before = chosenIn(sel, rows, []).slots.top
    const loaded = load(sel, ['band-tee', 'chinos'], rows, byId)
    expect(loaded.note).toBe('Old band tee is retired')
    expect(chosenIn(loaded, rows, []).slots.top).toBe(before)
    expect(chosenIn(loaded, rows, []).slots.bottom).toBe('chinos')
    // one deleted as well: both are said
    expect(load(sel, ['band-tee', 'gone', 'chinos'], rows, byId).note).toBe('Old band tee is retired · A piece was deleted')
  })
})

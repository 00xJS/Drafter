import { describe, expect, it } from 'vitest'
import { chosenIn, heldPieces, load, rowsOf, shownIn, start, surprise, type Selection } from '../components/wardrobe/composer'
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

describe('Surprise me', () => {
  // the draw is Math.random's shape: 0 takes the first card in the draw
  const first = () => 0

  it('moves each row on screen off the card it is on, and writes nothing', () => {
    const { rows, sel } = visit([], TODAY)
    const before = chosenIn(sel, rows, [])
    const after = chosenIn(surprise({ ...sel, note: 'A piece was deleted' }, rows, [], wearIndex([], TODAY), { random: first }), rows, [])
    expect(after.slots.top).not.toBe(before.slots.top)
    expect(after.slots.bottom).not.toBe(before.slots.bottom)
    // the rows only move: the shoes stay shut, and nothing is logged or saved
    expect(after.slots.shoes).toBeNull()
    expect(surprise(sel, rows, [], wearIndex([], TODAY), { random: first }).note).toBeUndefined()
  })

  it('leans on the ones rested longest: each is drawn as often as its rest weighs', () => {
    const garments = [piece('t-today', 'top'), piece('t-month', 'top'), piece('t-never', 'top'), piece('b', 'bottom')]
    const ix = wearIndex([look(TODAY, ['t-today', 'b']), look('2026-08-15', ['t-month', 'b'])], TODAY)
    const rows = rowsOf(garments, byRest(garments, ix).map(g => g.id))
    // never worn leads the row, so it is the card the row starts on
    const sel = start(rows, undefined, liveById(garments))
    expect(chosenIn(sel, rows, []).slots.top).toBe('t-never')
    const drawn = (r: number) => chosenIn(surprise(sel, rows, [], ix, { random: () => r }), rows, []).slots.top
    // a month's rest weighs 31, a day's 1: 31 draws in 32 go to the one worn a month ago
    expect(drawn(0.95)).toBe('t-month')
    expect(drawn(0.98)).toBe('t-today')
  })

  it('never deals a piece only held for the day, nor one out of season while the row has one in it', () => {
    const { rows, sel } = visit([look(DAY, ['band-tee', 'jeans'])], DAY)
    // the held tee leads its row and the rows start on it; moved off it first,
    // only the draw itself can keep it out
    expect(rows.top[0].id).toBe('band-tee')
    const moved = picking(sel, { top: 'hoodie' })
    for (const r of [0, 0.5, 0.999]) expect(chosenIn(surprise(moved, rows, [], wearIndex([], TODAY), { random: () => r }), rows, []).slots.top).not.toBe('band-tee')
    const tops = [piece('summer-tee', 'top', { seasons: ['summer'] }), piece('wool-top', 'top', { seasons: ['winter'] }), piece('plain-top', 'top')]
    const garments = [...tops, jeans]
    const ix = wearIndex([], TODAY)
    const dealt = rowsOf(garments, byRest(garments, ix).map(g => g.id))
    const on = start(dealt, undefined, liveById(garments))
    for (const r of [0, 0.5, 0.999]) expect(chosenIn(surprise(on, dealt, [], ix, { season: 'winter', random: () => r }), dealt, []).slots.top).not.toBe('summer-tee')
    // with nothing else in its row, the out-of-season one still comes up
    const lone = rowsOf([tops[0], jeans], ['summer-tee', 'jeans'])
    expect(chosenIn(surprise(start(lone, undefined, liveById([tops[0], jeans])), lone, [], ix, { season: 'winter', random: first }), lone, []).slots.top).toBe('summer-tee')
  })

  it('deals an open optional row a piece too, and leaves the accessories as they were', () => {
    const { rows, sel } = visit([], TODAY)
    const after = chosenIn(surprise(picking(sel, { accessories: ['scarf'] }), rows, ['shoes'], wearIndex([], TODAY), { random: first }), rows, ['shoes'])
    expect(after.slots.shoes).not.toBeNull()
    expect(after.accessories).toEqual(['scarf'])
  })
})

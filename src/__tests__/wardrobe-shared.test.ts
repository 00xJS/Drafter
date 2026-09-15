import { describe, expect, it } from 'vitest'
import { makeClock } from '../../shared/clock.mjs'
import * as shared from '../../shared/wardrobe.mjs'
import * as app from '../wardrobe'
import { CORE_TYPES, GARMENT_TYPES, LOOK_NOTE_MAX, MAX_PIECES } from '../types'
import type { Garment } from '../types'

// The wardrobe's rules live once, in shared/wardrobe.mjs, so an assistant
// counts a piece's days as the Stats screen does and logs a look as the
// composer does. src/wardrobe.ts re-exports them under the names it always had,
// and the screens keep importing them from there.

/** What moved from src/wardrobe.ts to shared/wardrobe.mjs. */
const MOVED = [
  'NEVER_WORN_GRACE_DAYS',
  'NOT_WORN_DAYS',
  'canDress',
  'coreKey',
  'isPlanned',
  'liveById',
  'logLook',
  'looksOn',
  'mostWorn',
  'neverWorn',
  'newWear',
  'notInUse',
  'notWornLately',
  'orderPieces',
  'outfitDays',
  'outfitLabel',
  'pieceKey',
  'unwearable',
  'wearId',
  'wearIndex',
  'wearable',
  'withPieces',
] as const

/** What stayed: the words, the suggestions and the figures by month. */
const STAYED = [
  'renamed',
  'retired',
  'saveOutfit',
  'middayOf',
  'wornLine',
  'wornShort',
  'garmentStats',
  'byRest',
  'CLOTHES_SORTS',
  'clothesOrder',
  'wardrobeTiles',
  'wearsByMonth',
  'wardrobeYearReport',
  'repeatedOutfits',
  'outfitLine',
  'savedOrder',
  'forgotYesterday',
  'todaySuggestions',
  'colorName',
  'suggestedNames',
  // a replaced photo's clean-up, and a piece's back photo
  'swappedPhotos',
  'withBack',
  'showingBack',
  // favourites, details, plans and notes, Surprise me, seasons and tags, worn with and cost per wear, the weather
  'starred',
  'withDetails',
  'PLAN_DAYS',
  'lastPlanDay',
  'confirmed',
  'withNote',
  'planFor',
  'restWeight',
  'pickWeighted',
  'seasonOf',
  'inSeason',
  'clothesMatch',
  'tagsOf',
  'wornWith',
  'costPerWear',
  'costLine',
  'COLD_C',
  'COLD_F',
  'WET_PCT',
  'weatherNeed',
  'weatherLine',
  'outerwearFor',
  'hasOuterwear',
  // the wardrobe in the palette, Ask, the Calendar, the Week review and Stats
  'pieceTags',
  'lookOn',
  'wearStreaks',
  'lookCalendar',
  'yourUniform',
  'priceOf',
  'wardrobeCosts',
  'wornBetween',
]

describe('the wardrobe rules the server shares', () => {
  it('are the very ones src/wardrobe.ts exports, under the same names', () => {
    for (const name of MOVED) expect(app[name], name).toBe(shared[name])
  })

  it('leave src/wardrobe.ts with every name it had', () => {
    expect(Object.keys(app).sort()).toEqual([...MOVED, ...STAYED].sort())
  })

  it('count a planned look in no figure, for the app and an assistant alike, until a log confirms it', () => {
    const look = { kind: 'wear' as const, id: 'wear~2026-09-14~plan000000', date: '2026-09-14', garmentIds: ['tee', 'jeans'], createdAt: '2026-09-13T20:00:00.000Z', updatedAt: '2026-09-13T20:00:00.000Z' }
    const plan = { ...look, planned: true as const }
    expect([shared.isPlanned(plan), shared.isPlanned(look)]).toEqual([true, false])
    const ix = shared.wearIndex([plan], '2026-09-14')
    expect(ix.logged).toEqual([])
    expect(ix.days.has('tee')).toBe(false)
    const { write } = shared.logLook([plan], '2026-09-14', ['tee', 'jeans'], [], { note: ' wedding ' })
    expect(write).toMatchObject({ id: plan.id, note: 'wedding' })
    expect('planned' in write).toBe(false)
    expect(shared.wearIndex([write], '2026-09-14').logged).toEqual(['2026-09-14'])
  })

  it('agree with the app on the types, the core and the most pieces a look holds', () => {
    expect(shared.GARMENT_TYPES).toEqual(GARMENT_TYPES)
    expect(shared.CORE_TYPES).toEqual(CORE_TYPES)
    expect(shared.MAX_PIECES).toBe(MAX_PIECES)
    expect(shared.LOOK_NOTE_MAX).toBe(LOOK_NOTE_MAX)
  })

  it('make a look\'s id from the randomness they are handed, and from ten random characters without', () => {
    expect(shared.wearId('2026-09-14', () => 'abcdefghij')).toBe('wear~2026-09-14~abcdefghij')
    expect(shared.wearId('2026-09-14')).toMatch(/^wear~2026-09-14~[0-9a-z]{10}$/)
    expect(shared.newWear('2026-09-14', [' a ', 'a', 'b'], '2026-09-14T08:00:00.000Z', () => 'r'.repeat(10))).toEqual({
      kind: 'wear',
      id: 'wear~2026-09-14~rrrrrrrrrr',
      date: '2026-09-14',
      garmentIds: ['a', 'b'],
      createdAt: '2026-09-14T08:00:00.000Z',
      updatedAt: '2026-09-14T08:00:00.000Z',
    })
  })

  it('count a new piece\'s week of grace in the zone they are given', () => {
    // made at 23:30 UTC on the 6th, which is already the 7th in Tokyo
    const shirt: Garment = { kind: 'garment', id: 'shirt', name: 'Shirt', type: 'top', createdAt: '2026-09-06T23:30:00.000Z', updatedAt: '2026-09-06T23:30:00.000Z' }
    const ix = shared.wearIndex([], '2026-09-13')
    expect(shared.neverWorn([shirt], ix, 7, iso => makeClock('UTC').dayKeyOf(iso) ?? '').map(g => g.id)).toEqual(['shirt'])
    expect(shared.neverWorn([shirt], ix, 7, iso => makeClock('Asia/Tokyo').dayKeyOf(iso) ?? '')).toEqual([])
  })
})

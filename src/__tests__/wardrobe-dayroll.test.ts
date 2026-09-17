import { afterEach, describe, expect, it, vi } from 'vitest'
import { chosenIn, rowsOf, start } from '../components/wardrobe/composer'
import { dayAfterRoll, untilNextDay } from '../useDayKey'
import type { Garment, Wear } from '../types'
import { byRest, liveById, wearIndex } from '../wardrobe'

// Reported from the phone: dressing a day, midnight passed, and the next day
// showed the previous day's clothes instead of nothing.
//
// Two causes, and the second is the one that could have written bad data.
//
// 1. The rows started on each row's first card, so a day nobody had dressed
//    looked exactly like one that had been — and "Wearing this" was live, so a
//    press logged a look nobody chose.
// 2. Nothing in the app re-rendered at midnight. The Wardrobe read the day
//    once, on mount, and iOS resumes the same page rather than killing it, so
//    an app that was not force-quit went on dressing yesterday. A log then
//    wrote the wear to yesterday's date.

const T0 = '2026-01-01T00:00:00.000Z'
const piece = (id: string, type: Garment['type']): Garment =>
  ({ kind: 'garment', id, name: id, type, createdAt: T0, updatedAt: T0 }) as Garment
const look = (date: string, garmentIds: string[]): Wear =>
  ({ kind: 'wear', id: `wear~${date}`, date, garmentIds, createdAt: T0, updatedAt: T0 }) as Wear

const garments = [piece('tee', 'top'), piece('shirt', 'top'), piece('jeans', 'bottom')]
const byId = liveById(garments)
const rowsFor = (wears: Wear[], today: string) => rowsOf(garments, byRest(garments, wearIndex(wears, today)).map(g => g.id))

afterEach(() => vi.useRealTimers())

describe('a day nobody has dressed', () => {
  it('starts on None, not on whatever card happens to be first', () => {
    const rows = rowsFor([], '2026-09-17')
    const { slots } = chosenIn(start(rows, undefined, byId), rows, [])
    expect(slots.top).toBeNull()
    expect(slots.bottom).toBeNull()
    // the pieces are all still there to swipe to — it is the choice that is empty
    expect(rows.top.map(g => g.id).sort()).toEqual(['shirt', 'tee'])
  })

  it('cannot be logged until something is chosen, so no look is ever a guess', () => {
    const rows = rowsFor([], '2026-09-17')
    const empty = start(rows, undefined, byId)
    expect(chosenIn(empty, rows, []).dressed).toBe(false)
    expect(chosenIn(empty, rows, []).pieces).toEqual([])

    const dressed = { ...empty, picked: { ...empty.picked, top: 'tee', bottom: 'jeans' } }
    expect(chosenIn(dressed, rows, []).dressed).toBe(true)
    expect(chosenIn(dressed, rows, []).pieces).toEqual(['tee', 'jeans'])
  })

  it('still opens on the look when the day has one', () => {
    const wears = [look('2026-09-16', ['shirt', 'jeans'])]
    const rows = rowsFor(wears, '2026-09-16')
    const { slots } = chosenIn(start(rows, wears[0], byId), rows, [])
    expect(slots.top).toBe('shirt')
    expect(slots.bottom).toBe('jeans')
  })

  it('goes to None rather than another garment when the chosen piece leaves its row', () => {
    const wears = [look('2026-09-16', ['shirt', 'jeans'])]
    const sel = start(rowsFor(wears, '2026-09-16'), wears[0], byId)
    // the shirt is retired from its own sheet mid-visit, so its row no longer deals it
    const without = rowsOf([piece('tee', 'top'), piece('jeans', 'bottom')], ['tee', 'jeans'])
    expect(chosenIn(sel, without, []).slots.top).toBeNull()
  })
})

describe('untilNextDay', () => {
  it('waits for the next local midnight, a second past it', () => {
    const at = (iso: string) => untilNextDay(new Date(iso))
    // a second after local midnight, so the tick lands inside the new day
    expect(at('2026-09-17T23:59:59')).toBe(2000)
    expect(at('2026-09-17T00:00:00')).toBe(24 * 3600_000 + 1000)
    expect(at('2026-09-17T12:00:00')).toBe(12 * 3600_000 + 1000)
  })

  it('is always in the future, whatever hour it is asked at', () => {
    for (let h = 0; h < 24; h++) {
      expect(untilNextDay(new Date(`2026-09-17T${String(h).padStart(2, '0')}:30:00`))).toBeGreaterThan(0)
    }
  })
})

describe('when the day rolls under an open app', () => {
  it('follows the clock when it was sitting on the old today', () => {
    // the composer hands its own day to onLog, so a day left behind is a wear
    // written to the wrong date — into the record Stats counts
    expect(dayAfterRoll('2026-09-16', '2026-09-16', '2026-09-17')).toBe('2026-09-17')
  })

  it('leaves a day the wearer went to themselves alone', () => {
    // browsing last Tuesday at midnight is not a reason to be moved off it
    expect(dayAfterRoll('2026-09-08', '2026-09-16', '2026-09-17')).toBe('2026-09-08')
    // including one planned ahead
    expect(dayAfterRoll('2026-09-20', '2026-09-16', '2026-09-17')).toBe('2026-09-20')
  })

  it('changes nothing when the day has not moved', () => {
    expect(dayAfterRoll('2026-09-16', '2026-09-16', '2026-09-16')).toBe('2026-09-16')
    expect(dayAfterRoll('2026-09-08', '2026-09-16', '2026-09-16')).toBe('2026-09-08')
  })
})

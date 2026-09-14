import { describe, expect, it } from 'vitest'
import { placeHits } from '../components/Search'
import type { Place } from '../types'

// Cmd/Ctrl+K finds a place by the other names it goes by and by its address,
// as well as by its name and notes, and says which it matched.

const STAMP = '2026-01-01T00:00:00.000Z'
const place = (id: string, name: string, over: Partial<Place> = {}): Place => ({ kind: 'place', id, name, color: '#c0392b', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP, ...over })

describe('the palette finds a place by its other names and its address', () => {
  const PLACES = [
    place('bk', 'Burger King', { category: 'fastfood', aliases: ['BK', 'Whopper house'] }),
    place('nopi', 'Nopi', { address: '21 Warwick St, London', notes: 'Book the counter' }),
    place('gone', 'Express Café', { deletedAt: STAMP }),
  ]

  it('says what matched when it was not the name', () => {
    expect(placeHits(PLACES, 'whopper')).toMatchObject([{ place: { id: 'bk' }, where: 'also Whopper house' }])
    expect(placeHits(PLACES, 'warwick')).toMatchObject([{ place: { id: 'nopi' }, where: '21 Warwick St, London' }])
    expect(placeHits(PLACES, 'counter')).toMatchObject([{ place: { id: 'nopi' }, where: 'in notes' }])
    expect(placeHits(PLACES, 'burger')).toMatchObject([{ place: { id: 'bk' }, where: '' }])
  })

  it('ranks a name over another place’s other name, and leaves out the Trash', () => {
    const hits = placeHits([place('b', 'Burger Palace', { aliases: ['Kingdom'] }), place('a', 'Kingdom Café')], 'kingdom').sort((x, y) => y.score - x.score)
    expect(hits.map(h => [h.place.id, h.where])).toEqual([
      ['a', ''],
      ['b', 'also Kingdom'],
    ])
    expect(placeHits(PLACES, 'express')).toEqual([])
  })
})

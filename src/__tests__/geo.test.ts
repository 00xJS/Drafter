import { describe, expect, it } from 'vitest'
import { formatDistance, haversineMeters, HERE_METERS, nearbyPlaces, NEARBY_METERS, tidyCoord, tidyCoords } from '../geo'

describe('tidyCoord', () => {
  it('keeps a reading in range to five decimals, and drops the rest', () => {
    expect(tidyCoord(51.5132149, 'lat')).toBe(51.51321)
    expect(tidyCoord(-0.136549, 'lon')).toBe(-0.13655)
    expect(tidyCoord(90, 'lat')).toBe(90)
    expect(tidyCoord(91, 'lat')).toBeUndefined()
    expect(tidyCoord(181, 'lon')).toBeUndefined()
    expect(tidyCoord('  33.45 ', 'lat')).toBe(33.45)
    expect(tidyCoord('east', 'lat')).toBeUndefined()
    expect(tidyCoord(undefined, 'lat')).toBeUndefined()
  })

  it('wants both ends of a pin', () => {
    expect(tidyCoords({ lat: 51.5, lon: -0.1 })).toEqual({ lat: 51.5, lon: -0.1 })
    expect(tidyCoords({ lat: 51.5 })).toBeUndefined()
    expect(tidyCoords({ lon: -0.1 })).toBeUndefined()
  })
})

describe('nearbyPlaces', () => {
  const nopi = { id: 'nopi', lat: 51.51321, lon: -0.13654 }
  const pret = { id: 'pret', lat: 51.5155, lon: -0.1365 }
  const park = { id: 'park', lat: 51.5073, lon: -0.1657 }
  const unnamed = { id: 'home' }

  it('lists pinned places inside 400 m, nearest first, and skips an unpinned one', () => {
    const here = { lat: 51.51321, lon: -0.13654 }
    const near = nearbyPlaces([pret, park, unnamed, nopi], here)
    expect(near.map(n => n.place.id)).toEqual(['nopi', 'pret'])
    expect(near[0].meters).toBeLessThan(HERE_METERS)
    expect(near[1].meters).toBeGreaterThan(HERE_METERS)
    expect(near[1].meters).toBeLessThan(NEARBY_METERS)
  })

  it('says how far in metres or kilometres', () => {
    expect(formatDistance(40)).toBe('40 m')
    expect(formatDistance(180)).toBe('180 m')
    expect(formatDistance(1500)).toBe('1.5 km')
  })

  it('measures a known stretch', () => {
    // ~111 m per 0.001° of latitude
    const meters = haversineMeters({ lat: 51.5, lon: 0 }, { lat: 51.501, lon: 0 })
    expect(meters).toBeGreaterThan(100)
    expect(meters).toBeLessThan(130)
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ImHereSheet } from '../components/ImHereSheet'
import type { Person, Place } from '../types'

const STAMP = '2026-01-01T00:00:00.000Z'
const noop = () => {}
const place = (over: Partial<Place> = {}): Place => ({
  kind: 'place',
  id: 'nopi',
  name: 'Nopi',
  color: '#c0392b',
  category: 'restaurant',
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
})
const person = (id: string, name: string): Person => ({
  kind: 'person',
  id,
  name,
  color: '#f472b6',
  group: 'family',
  createdAt: STAMP,
  updatedAt: STAMP,
})

const sheet = (over: Partial<Parameters<typeof ImHereSheet>[0]> = {}) =>
  renderToStaticMarkup(
    <ImHereSheet
      places={[place({ lat: 51.51321, lon: -0.13654 }), place({ id: 'park', name: 'Hyde Park', category: 'outdoors' })]}
      people={[person('maria', 'Maria'), person('sam', 'Sam')]}
      onLog={noop}
      onSavePlace={noop}
      onClose={noop}
      {...over}
    />,
  )

describe("I'm here", () => {
  it('finds you first, then offers nearby, who you are with, and Log it', () => {
    const html = sheet()
    expect(html).toContain('I&#x27;m here')
    expect(html).toContain('Finding you…')
    expect(html).toContain('Who are you with?')
    expect(html).toContain('Maria')
    expect(html).toContain('Log it')
    expect(html).toContain('disabled')
  })

  it('offers a nearby pinned place and leaves Log it on when one is close enough to pick', () => {
    const html = sheet({ here: { lat: 51.51321, lon: -0.13654 } })
    expect(html).toContain('These of yours are nearby.')
    expect(html).toContain('Nopi')
    expect(html).toContain('0 m')
    expect(html).not.toContain('Hyde Park')
    expect(html).toContain('Or another place')
    expect(html).not.toMatch(/class="btn primary"[^>]*disabled/)
  })

  it('says so when nothing nearby is pinned, and still lets you pick a place', () => {
    const html = sheet({
      here: { lat: 33.45, lon: -112.07 },
      places: [place({ id: 'park', name: 'Hyde Park', category: 'outdoors' })],
    })
    expect(html).toContain('None of your places are nearby yet')
    expect(html).toContain('Where are you?')
    expect(html).toContain('disabled')
  })

  it('still lets you log when location is off', () => {
    const html = sheet({ here: null })
    expect(html).toContain('Location is off — pick the place.')
    expect(html).toContain('Where are you?')
    expect(html).toContain('Who are you with?')
  })
})

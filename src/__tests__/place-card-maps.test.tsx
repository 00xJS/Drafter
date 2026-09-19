import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlaceForm, PlaceRow } from '../components/Places'
import { placeStats } from '../places'
import type { Place } from '../types'

// A place's card opens on its address and its other names, and offers Open in
// Maps beside Went there, Plan a trip and Edit: a link that searches the
// address when there is one, else the name, in Apple Maps on Apple devices and
// Google Maps elsewhere. The editor has a box for each. These are static
// renders; nothing here was tapped in a browser or on the iPhone.

const STAMP = '2026-01-01T00:00:00.000Z'
const noop = () => {}
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const text = (html: string) => html.replace(/<!-- -->/g, '')
const place = (over: Partial<Place> = {}): Place => ({ kind: 'place', id: 'nopi', name: 'Nopi', color: '#c0392b', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP, ...over })
const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', platform: 'iPhone' }
const WINDOWS = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', platform: 'Win32' }

const card = (p: Place, open = true) =>
  text(renderToStaticMarkup(<PlaceRow stats={placeStats(p, [], [])} open={open} onToggle={noop} onEdit={noop} onLog={noop} onPlan={noop} onOpenTask={noop} />))

afterEach(() => vi.unstubAllGlobals())

describe('a place’s card', () => {
  it('heads its detail with the address and the other names', () => {
    const html = card(place({ address: '21 Warwick St, London', aliases: ['NOPI Soho', 'Ottolenghi'] }))
    expect(html).toContain('<div class="person-detail"><div class="place-where"><span>📍 21 Warwick St, London</span><small class="muted">Also called NOPI Soho, Ottolenghi</small></div>')
  })

  it('shows either line alone, neither for a place with none, and nothing while shut', () => {
    expect(card(place({ address: '1 Oxford St' }))).toContain('<div class="place-where"><span>📍 1 Oxford St</span></div>')
    expect(card(place({ aliases: ['Pret'] }))).toContain('<div class="place-where"><small class="muted">Also called Pret</small></div>')
    expect(card(place())).not.toContain('place-where')
    expect(card(place({ address: '1 Oxford St' }), false)).not.toContain('place-where')
  })

  it('offers Open in Maps between Plan a trip and Edit: a link to Apple Maps on an iPhone', () => {
    vi.stubGlobal('navigator', IPHONE)
    const html = card(place({ address: '21 Warwick St, London' }))
    expect(html).toContain('<a class="btn" href="https://maps.apple.com/?q=21%20Warwick%20St%2C%20London" target="_blank" rel="noreferrer">Open in Maps</a>')
    const actions = html.slice(html.indexOf('class="person-actions"'))
    expect(actions.indexOf('Went there')).toBeLessThan(actions.indexOf('Plan a trip'))
    expect(actions.indexOf('Plan a trip')).toBeLessThan(actions.indexOf('Open in Maps'))
    expect(actions.indexOf('Open in Maps')).toBeLessThan(actions.indexOf('>Edit<'))
  })

  it('searches the name in Google Maps elsewhere, when the place has no address', () => {
    vi.stubGlobal('navigator', WINDOWS)
    expect(card(place({ name: 'Hyde Park', category: 'outdoors' }))).toContain('href="https://www.google.com/maps/search/?api=1&amp;query=Hyde%20Park"')
  })

  it('dresses the link as the buttons beside it, with the app’s focus ring', () => {
    const css = read('../styles/12-household-settings.css')
    expect(css).toMatch(/\.person-actions a\.btn \{\s*text-decoration: none;\s*\}/)
    expect(css).toMatch(/\.person-actions a\.btn:focus-visible \{\s*outline: 2px solid var\(--focus-ring\);/)
    // a long address wraps rather than widening the card past a phone
    expect(css).toMatch(/\.place-where \{[^}]*overflow-wrap: anywhere;/)
  })
})

describe('the place editor', () => {
  it('has an Address box and an Other names box, filled from the place', () => {
    const html = text(renderToStaticMarkup(<PlaceForm place={place({ address: '21 Warwick St, London', aliases: ['NOPI Soho', 'Ottolenghi'] })} onSave={noop} onClose={noop} />))
    // your own address is not this place's, so the browser is asked not to offer it for either
    expect(html).toContain('<span>Address <small>(optional)</small></span><input placeholder="e.g. 21 Warwick St, London" autoComplete="off" value="21 Warwick St, London"/>')
    expect(html).toContain('Pin this spot')
    expect(html).toContain('<span>Other names <small>(optional, separated by commas)</small></span><input placeholder="e.g. Franco&#x27;s Pizzeria, Francos" autoComplete="off" value="NOPI Soho, Ottolenghi"/>')
  })

  it('starts both empty for a new place', () => {
    const html = text(renderToStaticMarkup(<PlaceForm onSave={noop} onClose={noop} />))
    expect(html).toContain('<span>Address <small>(optional)</small></span><input placeholder="e.g. 21 Warwick St, London" autoComplete="off" value=""/>')
    expect(html).toContain('<span>Other names <small>(optional, separated by commas)</small></span><input placeholder="e.g. Franco&#x27;s Pizzeria, Francos" autoComplete="off" value=""/>')
  })

  it('saves both tidied, and stamps an edit newer than the copy it replaces', () => {
    const src = read('../components/Places.tsx')
    const save = src.slice(src.indexOf('const save = () => {'), src.indexOf('onClose()\n  }'))
    expect(save).toContain('address: tidyPlaceAddress(address),')
    expect(save).toContain('aliases: placeAliasesFromText(aliases, name.trim()),')
    expect(save).toContain('...(pin ? { lat: pin.lat, lon: pin.lon } : {}),')
    expect(save).toContain('updatedAt: place ? newerStamp(place.updatedAt) : now,')
  })
})

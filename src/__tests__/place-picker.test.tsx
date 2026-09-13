import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PlacePicker, enterPlace } from '../components/PlacePicker'
import { PeoplePlace } from '../components/taskeditor/PeoplePlace'
import { placeSearch } from '../places'
import type { Place } from '../types'

// One place picker for the task editor's Where and Saw them → Where?. A name
// typed there means a saved place however it is spelled, as it does in the
// meal picker (placeByName), so "Cafe Kafka" reuses "Café Kafka" instead of
// offering to make a second copy that would split its counts. vitest runs in
// node, so these are the rules behind the picker and static renders of it;
// the typing was checked in the browser.

const STAMP = '2026-01-01T00:00:00.000Z'
const noop = () => {}
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
// React may mark the seam between neighbouring text nodes; the words are what matter
const text = (html: string) => html.replace(/<!-- -->/g, '')
const place = (id: string, name: string, over: Partial<Place> = {}): Place => ({ kind: 'place', id, name, color: '#c0392b', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP, ...over })

const kafka = place('kafka', 'Café Kafka', { category: 'cafe', emoji: '☕' })
const francos = place('francos', 'Franco’s')
const taco = place('taco', 'Taco Cartel')
const tokyo = place('tokyo', '東京')
const places = [kafka, francos, taco, tokyo]

describe('a typed place name means the saved place however it is spelled', () => {
  it('reuses Café Kafka for "Cafe Kafka", Franco’s for "Franco\'s" and Taco Cartel for "taco   CARTEL"', () => {
    expect(placeSearch('Cafe Kafka', places).exact).toBe(kafka)
    expect(placeSearch("Franco's", places).exact).toBe(francos)
    expect(placeSearch('  taco   CARTEL ', places).exact).toBe(taco)
    // a name wholly in another script is found by its letters too
    expect(placeSearch('東京', places).exact).toBe(tokyo)
  })

  it('finds a place from part of its name, accents or not, the one it means first', () => {
    const corner = place('corner', 'Corner Cafe')
    expect(placeSearch('cafe', places).matches).toEqual([kafka])
    expect(placeSearch('caf', [corner, kafka]).matches).toEqual([corner, kafka])
    expect(placeSearch('Café Kafka', [corner, kafka]).matches).toEqual([kafka])
  })

  it('tidies the name it would save, and never means a place in the Trash', () => {
    expect(placeSearch('  Nopi   Soho ', places).name).toBe('Nopi Soho')
    expect(placeSearch('Cafe Kafka', [{ ...kafka, deletedAt: STAMP }]).exact).toBeUndefined()
    expect(placeSearch('   ', places)).toEqual({ name: '', exact: undefined, matches: [] })
  })
})

describe('a name is never taken for a different place', () => {
  // normalisePlaceText keeps only a–z and 0–9, so each pair below came out as
  // one name ("restaurant", "gr n", "sushi", "c bar"): no Create was offered and
  // Enter attached the saved place, logging an outing somewhere never visited
  const silver = place('silver', '银龙 Restaurant')
  const graen = place('graen', 'Græn')
  const kanji = place('kanji', 'Sushi 寿司')
  const cBar = place('cbar', 'C Bar')

  it('offers 金龙 Restaurant as new beside a saved 银龙 Restaurant, and Enter makes it', () => {
    expect(placeSearch('金龙 Restaurant', [silver])).toEqual({ name: '金龙 Restaurant', exact: undefined, matches: [] })
    expect(enterPlace('金龙 Restaurant', [silver], true)).toEqual({ create: '金龙 Restaurant' })
  })

  it('keeps Grøn from Græn, Sushi 鮨 from Sushi 寿司 and C++ Bar from C Bar', () => {
    expect(placeSearch('Grøn', [graen]).exact).toBeUndefined()
    expect(enterPlace('Grøn', [graen], true)).toEqual({ create: 'Grøn' })
    expect(enterPlace('Sushi 鮨', [kanji], true)).toEqual({ create: 'Sushi 鮨' })
    expect(enterPlace('C++ Bar', [cBar], true)).toEqual({ create: 'C++ Bar' })
  })

  it('still reuses each of them however its own name is cased or spaced', () => {
    expect(enterPlace('银龙  restaurant', [silver], true)).toEqual({ pick: silver })
    expect(enterPlace('GRÆN', [graen], true)).toEqual({ pick: graen })
    expect(placeSearch('寿司', [kanji, silver]).matches).toEqual([kanji])
  })
})

describe('Enter in the picker', () => {
  it('picks the saved place rather than making a second copy', () => {
    expect(enterPlace('Cafe Kafka', places, true)).toEqual({ pick: kafka })
    expect(enterPlace("franco's", places, true)).toEqual({ pick: francos })
    expect(enterPlace('Taco  Cartel', places, true)).toEqual({ pick: taco })
  })

  it('makes somewhere genuinely new when it can, else picks the first match, else does nothing', () => {
    expect(enterPlace('Nopi', places, true)).toEqual({ create: 'Nopi' })
    expect(enterPlace('Taco', places, false)).toEqual({ pick: taco })
    expect(enterPlace('Nopi', places, false)).toBeNull()
    expect(enterPlace('   ', places, true)).toBeNull()
  })
})

describe('the picker in the task editor and in Saw them', () => {
  it('labels the task editor’s Where as before, and shows the chosen place as a chip to remove', () => {
    const html = text(renderToStaticMarkup(<PeoplePlace form={{ peopleIds: [], placeId: 'kafka' }} set={noop} people={[]} places={places} onSavePlace={noop} />))
    expect(html).toContain('<span>Where <small>(marking this done counts as an outing there)</small></span>')
    expect(html).toContain('<button type="button" class="toggle on" title="Remove">☕ Café Kafka ✕</button>')
    // chosen: no search box under it
    expect(html).not.toContain('placeholder="Search places…"')
  })

  it('offers the search box when nothing is chosen, and a place no longer saved reads Unknown', () => {
    const empty = text(renderToStaticMarkup(<PlacePicker onChange={noop} places={places} label="Where?" />))
    expect(empty).toContain('<span>Where?</span>')
    expect(empty).toContain('placeholder="Search places…"')
    const lost = text(renderToStaticMarkup(<PlacePicker placeId="gone" onChange={noop} places={places} label="Where?" />))
    expect(lost).toContain('>Unknown ✕</button>')
  })

  it('is the one picker in both, with no inline copy or plain lower-case compare left', () => {
    for (const src of [read('../components/People.tsx'), read('../components/taskeditor/PeoplePlace.tsx')]) {
      expect(src).toMatch(/<PlacePicker\b/)
      expect(src).not.toContain('Create place')
      expect(src).not.toContain('Search places…')
      expect(src).not.toMatch(/\.name\.toLowerCase\(\) === /)
    }
  })
})

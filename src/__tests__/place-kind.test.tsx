import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AttendancePicker, SaveLocation, canLogAttendance, locationPlaceName, placeAtLocation, placeFromLocation } from '../components/AttendancePicker'
import { SomewhereNew } from '../components/MealSlotRow'
import { PlaceKindChooser } from '../components/PlaceKindChooser'
import { NewPlaceStep, PlacePicker, enterPlace } from '../components/PlacePicker'
import { matchPlace, newPlace, placeFor } from '../places'
import { PLACE_CATEGORIES, PLACE_CATEGORY_META, type CalendarEvent, type Person, type Place, type PlaceCategory } from '../types'

// Somewhere new asks what kind of place it is. A task's Where, Saw them, the
// meal picker's Somewhere new and Who was there? each show the same row of
// nine kinds, none picked, and keep Create / Save disabled until one is — a
// place is never filed under a kind nobody chose. A saved place is reused
// without being asked anything. vitest runs in node with no DOM, so these are
// static renders, the rules behind them, and the hook-free parts called as the
// functions they are with their buttons pressed through onClick; the clicking
// itself was checked in the browser.

const STAMP = '2026-01-01T00:00:00.000Z'
const noop = () => {}
const boom = () => {
  throw new Error('nothing may be saved here')
}
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
// React may mark the seam between neighbouring text nodes; the words are what matter
const text = (html: string) => html.replace(/<!-- -->/g, '')
const place = (id: string, name: string, over: Partial<Place> = {}): Place => ({ kind: 'place', id, name, color: '#c0392b', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP, ...over })
const kafka = place('kafka', 'Café Kafka', { category: 'cafe', emoji: '☕' })
const nopi = place('nopi', 'Nopi')
const tokyo = place('tokyo', '東京')
const places = [kafka, nopi, tokyo]

type Props = Record<string, unknown> & { children?: ReactNode }
type El = ReactElement<Props>

/** Every host element in the tree a hook-free component returns, each hook-free component in it called through to what it renders. */
function flatten(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(flatten)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const el = node as El
  if (typeof el.type === 'function') return flatten((el.type as (props: Props) => ReactNode)(el.props))
  return [el, ...flatten(el.props.children)]
}

function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as El).props.children)
  return ''
}

/** The button called `name` (its text, or the kind after its emoji), to read and to press through its onClick. */
function button(tree: ReactNode, name: string): { disabled: boolean; press(): void } {
  const hit = flatten(tree).find(e => {
    if (e.type !== 'button') return false
    const t = textOf(e.props.children).replace(/\s+/g, ' ').trim()
    return t === name || t.endsWith(` ${name}`)
  })
  if (!hit) throw new Error(`no ${name} button`)
  return { disabled: hit.props.disabled === true, press: () => (hit.props.onClick as () => void)() }
}

describe('the kind chooser', () => {
  it('offers the nine kinds in order, each with its label and emoji, and none picked until you pick', () => {
    const html = text(renderToStaticMarkup(<PlaceKindChooser onChange={noop} />))
    expect(html).toContain('<div class="place-kinds" role="radiogroup" aria-label="Kind of place">')
    expect(PLACE_CATEGORIES.map(c => PLACE_CATEGORY_META[c].label)).toEqual(['Restaurant', 'Fast food', 'Café', 'Bar', 'Outdoors', 'Venue', 'Shop', 'Home', 'Other'])
    const at = PLACE_CATEGORIES.map(c => html.indexOf(`aria-checked="false" class="toggle"><span aria-hidden="true">${PLACE_CATEGORY_META[c].emoji}</span> ${PLACE_CATEGORY_META[c].label}</button>`))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(html).not.toContain('aria-checked="true"')
  })

  it('marks the one picked, and only that one', () => {
    const html = text(renderToStaticMarkup(<PlaceKindChooser value="outdoors" onChange={noop} />))
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
    expect(html).toContain('aria-checked="true" class="toggle on"><span aria-hidden="true">🌳</span> Outdoors</button>')
  })

  it('hands back the kind tapped', () => {
    const onChange = vi.fn()
    button(PlaceKindChooser({ onChange }), 'Fast food').press()
    expect(onChange).toHaveBeenCalledWith('fastfood')
  })
})

describe("a task's Where and Saw them: somewhere new asks what kind of place it is", () => {
  it('keeps Create place disabled until a kind is picked, and pressing it anyway saves nothing', () => {
    const onCreate = vi.fn()
    const html = text(renderToStaticMarkup(<NewPlaceStep name="Nopi Soho" onKind={noop} onCreate={onCreate} onCancel={noop} />))
    expect(html).toContain('What kind of place is “Nopi Soho”?')
    expect(html).toContain('role="radiogroup" aria-label="Kind of place for “Nopi Soho”"')
    expect(html).toContain('<button type="button" class="btn primary" disabled="">Create place</button>')
    const create = button(NewPlaceStep({ name: 'Nopi Soho', onKind: noop, onCreate, onCancel: noop }), 'Create place')
    expect(create.disabled).toBe(true)
    create.press()
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('saves the kind picked', () => {
    const onKind = vi.fn()
    const onCreate = vi.fn()
    button(NewPlaceStep({ name: 'Nopi Soho', onKind, onCreate, onCancel: noop }), 'Venue').press()
    expect(onKind).toHaveBeenCalledWith('venue')
    // the picker hands the answer back in: Create is live and saves that kind
    const ready = NewPlaceStep({ name: 'Nopi Soho', kind: 'venue', onKind, onCreate, onCancel: noop })
    expect(text(renderToStaticMarkup(ready))).toContain('<button type="button" class="btn primary">Create place</button>')
    button(ready, 'Create place').press()
    expect(onCreate).toHaveBeenCalledWith('venue')
    // …and the place the picker builds from it keeps it
    expect(newPlace('  Nopi   Soho ', 'venue', { id: 'p1', color: '#0ea5e9', now: new Date(STAMP) })).toEqual({
      kind: 'place',
      id: 'p1',
      name: 'Nopi Soho',
      category: 'venue',
      color: '#0ea5e9',
      createdAt: STAMP,
      updatedAt: STAMP,
    })
  })

  it('reuses a saved place however it is typed, and asks nothing', () => {
    expect(enterPlace('cafe kafka', places, true)).toEqual({ pick: kafka })
    expect(enterPlace('  NOPI ', places, true)).toEqual({ pick: nopi })
    // nothing typed yet, or a place chosen: no question on the page
    const empty = renderToStaticMarkup(<PlacePicker onChange={noop} places={places} onSavePlace={boom} label="Where?" />)
    expect(empty).not.toContain('radiogroup')
    const chosen = text(renderToStaticMarkup(<PlacePicker placeId="kafka" onChange={noop} places={places} onSavePlace={boom} label="Where?" />))
    expect(chosen).toContain('☕ Café Kafka ✕</button>')
    expect(chosen).not.toContain('radiogroup')
  })

  it('asks only for a name no saved place has', () => {
    const src = read('../components/PlacePicker.tsx')
    expect(src).toMatch(/\{canCreate && asking && <NewPlaceStep\b/)
    expect(src).toContain('New place “{name}”…')
    // typing it into a saved place (or emptying it) closes the question and forgets
    // its kind, so a kind picked for one new name is never carried to the next
    expect(src).toMatch(/const next = enterPlace\(e\.target\.value, everyone, !!onSavePlace\)\s+if \(!next \|\| !\('create' in next\)\) stopAsking\(\)/)
    expect(src).toMatch(/function stopAsking\(\) \{\s+setAsking\(false\)\s+setKind\(undefined\)/)
  })
})

describe("the meal picker's Somewhere new", () => {
  const form = (over: Partial<Parameters<typeof SomewhereNew>[0]> = {}) =>
    SomewhereNew({ name: 'Nopi Soho', places, label: 'Name of the place for dinner on 2026-09-17', onName: noop, onKind: noop, onSave: noop, onCancel: noop, ...over })

  it('keeps Save disabled for a new name until a kind is picked', () => {
    const html = text(renderToStaticMarkup(form()))
    expect(html).toContain('role="radiogroup" aria-label="Kind of place"')
    expect(html).toContain('<button class="btn primary" disabled="">Save</button>')
    expect(button(form(), 'Save').disabled).toBe(true)
    expect(text(renderToStaticMarkup(form({ kind: 'restaurant' })))).toContain('<button class="btn primary">Save</button>')
    // a kind with no name is still nothing to save
    expect(button(form({ name: '  ', kind: 'restaurant' }), 'Save').disabled).toBe(true)
  })

  it('saves the kind picked', () => {
    const onKind = vi.fn()
    button(form({ onKind }), 'Bar').press()
    expect(onKind).toHaveBeenCalledWith('bar')
    const onSave = vi.fn()
    button(form({ kind: 'bar', onSave }), 'Save').press()
    expect(onSave).toHaveBeenCalled()
    // what that Save does: a new place, of that kind
    const create = vi.fn((name: string, kind: PlaceCategory) => place('new', name, { category: kind }))
    const hit = placeFor(' Nopi   Soho ', 'bar', places, create)
    expect(create).toHaveBeenCalledWith('Nopi Soho', 'bar')
    expect(hit).toEqual({ place: place('new', 'Nopi Soho', { category: 'bar' }), created: true })
  })

  it('makes nothing for a new name without a kind', () => {
    const create = vi.fn(boom)
    expect(placeFor('Nopi Soho', undefined, places, create)).toBeNull()
    expect(placeFor('   ', 'bar', places, create)).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it('reuses a saved place however it is typed, asking nothing and leaving its kind alone', () => {
    const html = text(renderToStaticMarkup(form({ name: 'cafe  KAFKA' })))
    expect(html).not.toContain('radiogroup')
    expect(html).toContain('Your saved ☕ Café Kafka')
    expect(html).toContain('<button class="btn primary">Save</button>')
    const create = vi.fn(boom)
    expect(placeFor('cafe  KAFKA', undefined, places, create)).toEqual({ place: kafka, created: false })
    // a kind picked before the name matched changes nothing about the saved place
    expect(placeFor('Cafe Kafka', 'bar', places, create)).toEqual({ place: kafka, created: false })
    expect(kafka.category).toBe('cafe')
    expect(create).not.toHaveBeenCalled()
  })
})

describe('Who was there?', () => {
  const mum: Person = { kind: 'person', id: 'mum', name: 'Mum', group: 'family', color: '#c0392b', createdAt: STAMP, updatedAt: STAMP }
  const event = (location?: string): CalendarEvent => ({ id: 'e1', sourceId: 's1', title: 'Dinner', start: '2026-09-10T19:00:00.000Z', end: '2026-09-10T21:00:00.000Z', allDay: false, location })
  const picker = (location?: string) =>
    text(renderToStaticMarkup(<AttendancePicker event={event(location)} people={[mum]} places={places} onSavePlace={boom} onSavePerson={noop} onDone={noop} onClose={noop} />))

  it('never saves the location by itself: Save “…” as a place starts unticked, with no kind asked', () => {
    const html = picker('Dishoom, 7 Boundary St, London')
    expect(html).toContain('<input type="checkbox"/><span class="cal-source-name">Save “Dishoom, 7 Boundary St, London” as a place</span>')
    expect(html).not.toContain('radiogroup')
    expect(html).toContain('<button class="btn primary" disabled="">Log the outing</button>')
  })

  it('asks what kind once Save is ticked, and Log waits for the answer', () => {
    const html = text(renderToStaticMarkup(<SaveLocation location="Dishoom, 7 Boundary St, London" checked onCheck={noop} onKind={noop} />))
    expect(html).toContain('<input type="checkbox" checked=""/>')
    expect(html).toContain('What kind of place is “Dishoom”?')
    expect(html).toContain('role="radiogroup" aria-label="Kind of place for “Dishoom”"')
    // ticked with no kind holds Log back, even with someone ticked
    expect(canLogAttendance({ people: 1, saving: true })).toBe(false)
    expect(canLogAttendance({ people: 0, saving: true })).toBe(false)
    expect(canLogAttendance({ people: 0, saving: true, kind: 'restaurant' })).toBe(true)
    // unticked, it is as before: someone ticked or a place attached
    expect(canLogAttendance({ people: 0, saving: false })).toBe(false)
    expect(canLogAttendance({ people: 1, saving: false })).toBe(true)
    expect(canLogAttendance({ people: 0, placeId: 'kafka', saving: false })).toBe(true)
  })

  it('ticks and picks only when you do', () => {
    const onCheck = vi.fn()
    const onKind = vi.fn()
    const unticked = SaveLocation({ location: 'Hyde Park', checked: false, onCheck, onKind })
    expect(flatten(unticked).some(e => e.props.role === 'radiogroup')).toBe(false)
    const box = flatten(unticked).find(e => e.type === 'input')!
    ;(box.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } })
    expect(onCheck).toHaveBeenCalledWith(true)
    button(SaveLocation({ location: 'Hyde Park', checked: true, onCheck, onKind }), 'Outdoors').press()
    expect(onKind).toHaveBeenCalledWith('outdoors')
  })

  it('saves the kind picked, named for the venue, the full address in its notes', () => {
    const opts = { id: 'p9', color: '#0ea5e9', now: new Date(STAMP) }
    expect(placeFromLocation('Dishoom, 7 Boundary St, London', 'restaurant', opts)).toEqual({
      kind: 'place',
      id: 'p9',
      name: 'Dishoom',
      category: 'restaurant',
      color: '#0ea5e9',
      notes: 'Dishoom, 7 Boundary St, London',
      createdAt: STAMP,
      updatedAt: STAMP,
    })
    expect(placeFromLocation('Hyde Park', 'outdoors', opts)).toEqual({ kind: 'place', id: 'p9', name: 'Hyde Park', category: 'outdoors', color: '#0ea5e9', createdAt: STAMP, updatedAt: STAMP })
    expect(locationPlaceName(', 12 High St')).toBe(', 12 High St')
  })

  it('attaches a saved place the location names as before, and offers nothing to save', () => {
    const html = picker('Café Kafka, 1 High St')
    expect(html).toContain('☕ Café Kafka ✕</button>')
    expect(html).toContain('Matched from “Café Kafka, 1 High St”')
    expect(html).not.toContain('as a place')
    expect(html).not.toContain('radiogroup')
    expect(html).toContain('<button class="btn primary">Log the outing</button>')
  })

  it('knows a saved place the location opens with, even one matchPlace cannot read', () => {
    // matchPlace keys on a–z and 0–9, so 東京 is invisible to it and was offered as new
    expect(matchPlace('東京, Shibuya', places)).toBeUndefined()
    expect(placeAtLocation('東京, Shibuya', places)).toBe(tokyo)
    expect(picker('東京, Shibuya')).toContain('東京 ✕</button>')
    expect(placeAtLocation('Dishoom, 7 Boundary St', places)).toBeUndefined()
    expect(placeAtLocation('  ', places)).toBeUndefined()
    expect(placeAtLocation(undefined, places)).toBeUndefined()
  })

  it('shows no Where at all for an event with no location', () => {
    expect(picker(undefined)).not.toContain('<span>Where</span>')
  })
})

describe('no path makes a place of a kind nobody chose', () => {
  const paths = ['../components/PlacePicker.tsx', '../components/AttendancePicker.tsx', '../components/MealSlotRow.tsx', '../components/planner/useLifeActions.ts', '../components/Places.tsx']

  it('has no fallback kind left in any of them', () => {
    for (const rel of paths) {
      const src = read(rel)
      expect(src, rel).not.toMatch(/category: 'other'/)
      expect(src, rel).not.toMatch(/useState<PlaceCategory>\('/)
      expect(src, rel).not.toMatch(/\?\? 'restaurant'/)
    }
  })

  it('asks with the one chooser in each path that names somewhere new', () => {
    for (const rel of ['../components/PlacePicker.tsx', '../components/AttendancePicker.tsx', '../components/MealSlotRow.tsx']) {
      expect(read(rel), rel).toMatch(/<PlaceKindChooser\b/)
    }
    // the meal picker's own kind select is gone
    expect(read('../components/MealSlotRow.tsx')).not.toContain('PLACE_CATEGORIES')
  })

  it('keeps Add a place’s Save waiting for a kind too', () => {
    expect(read('../components/Places.tsx')).toContain('disabled={!name.trim() || !category}')
  })
})

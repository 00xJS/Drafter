import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FindAddress, TownField } from '../components/AddressFinder'
import { MissingAddresses, RhythmSheet, chipsFor, personRows, placeRows, saveLine, type RhythmChange } from '../components/RhythmSheet'
import { rhythmsSaved } from '../components/planner/Overlays'
import type { Person, Place, Task } from '../types'
import { button, elements, press, settled, textOf, type El } from './rendered'

// Who, and how often: every person and place with its rhythm chips, what is
// stored selected, a suggestion from your own visits pre-selected and drawn as
// one until tapped, and Save writing only the rows that changed.

const JOE = '11111111-1111-1111-1111-111111111111'
const MARIA = '22222222-2222-2222-2222-222222222222'
const NOW = new Date('2026-09-22T12:00:00.000Z')
const STAMP = '2026-01-01T12:00:00.000Z'
const noop = () => {}

const person = (id: string, over: Partial<Person> = {}): Person => ({ kind: 'person', id, name: id[0].toUpperCase() + id.slice(1), group: 'family', color: '#888888', createdAt: STAMP, updatedAt: STAMP, ...over })
const place = (id: string, over: Partial<Place> = {}): Place => ({ kind: 'place', id, name: id[0].toUpperCase() + id.slice(1), category: 'cafe', color: '#888888', createdAt: STAMP, updatedAt: STAMP, ...over })
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const visit = (id: string, who: string, n: number, ownerId?: string): Task =>
  ({ kind: 'task', id, title: 'Saw them', description: '', status: 'done', priority: 'normal', tags: ['visit'], peopleIds: [who], completedAt: daysAgo(n), createdAt: STAMP, updatedAt: STAMP, ...(ownerId ? { ownerId } : {}) }) as Task

// Mum: monthly, set. Gran: nothing set, seen on three days in the last 90.
// Sam: nothing set, never logged. Dad: No reminders. Aunt: every 60 days, set.
const people = [person('mum', { cadenceDays: 30 }), person('gran'), person('sam'), person('dad', { noReminders: true }), person('aunt', { cadenceDays: 60 })]
const tasks = [visit('g1', 'gran', 5), visit('g2', 'gran', 30), visit('g3', 'gran', 60)]
const props = (over: Partial<Parameters<typeof RhythmSheet>[0]> = {}): Parameters<typeof RhythmSheet>[0] => ({
  people,
  places: [place('nopi', { address: '21 Warwick St, London' }), place('cafe'), place('parc', { noReminders: true })],
  tasks,
  meals: [],
  now: NOW,
  onSave: noop,
  onSavePlace: noop,
  onClose: noop,
  ...over,
})

/** A row's chips, as the sheet hands them out: the element whose row is this one. */
const chipsOf = (tree: unknown, id: string) => elements(tree as El).find(e => (e.props.row as { id?: string } | undefined)?.id === id)!

describe('Who, and how often', () => {
  it('opens on People with every person A to Z, the stored rhythm selected, the suggestion drawn as one', () => {
    const tree = settled(RhythmSheet, props())
    const row = (id: string) => chipsOf(tree, id).props as { chosen: unknown; suggested: boolean }
    expect(row('mum')).toMatchObject({ chosen: 30, suggested: false })
    expect(row('gran')).toMatchObject({ chosen: 30, suggested: true })
    expect(row('sam')).toMatchObject({ chosen: null, suggested: false })
    expect(row('dad')).toMatchObject({ chosen: 'off', suggested: false })
    expect(row('aunt')).toMatchObject({ chosen: 60, suggested: false })
    const order = elements(tree as El)
      .filter(e => (e.props.row as { id?: string } | undefined)?.id)
      .map(e => (e.props.row as { id: string }).id)
    expect(order).toEqual(['aunt', 'dad', 'gran', 'mum', 'sam'])
  })

  it('draws the chips as a radio group: the six, and a rhythm they do not name among them', () => {
    const html = renderToStaticMarkup(<RhythmSheet {...props()} />)
    expect(html).toContain('Who, and how often')
    expect(html).toContain('role="radiogroup" aria-label="How often: Gran"')
    expect(chipsFor(null).map(c => c.label)).toEqual(['1 week', '2 weeks', 'Monthly', '3 months', '6 months', 'No reminders'])
    expect(chipsFor(60).map(c => c.label)).toEqual(['1 week', '2 weeks', 'Monthly', 'Every 2 months', '3 months', '6 months', 'No reminders'])
    // the suggestion is the chosen chip, drawn dashed until tapped
    expect(html).toMatch(/aria-checked="true" class="toggle rhythm-chip suggested"[^>]*>Monthly</)
    expect(html).toMatch(/aria-checked="true" class="toggle rhythm-chip on"[^>]*>No reminders</)
    expect(html).toContain('Seen on 3 days in the last 90 · suggested: monthly')
    expect(html).toContain('Save sets 1 person. It is a suggestion from your own visits, dashed until you tap.')
  })

  it('suggests from YOUR visits: the other member seeing Gran every week is not you', () => {
    const hers = Array.from({ length: 12 }, (_, i) => visit(`m${i}`, 'gran', i * 7 + 1, MARIA))
    const mine = [visit('j1', 'gran', 40, JOE)]
    const gran = (myId: string) => personRows([person('gran')], [...hers, ...mine], [], NOW, myId)[0]
    expect(gran(JOE)).toMatchObject({ suggestion: 90, line: 'Seen on 1 day in the last 90' })
    expect(gran(MARIA)).toMatchObject({ suggestion: 7 })
  })

  it('Save writes only the rows that changed, each stamped newer, and No reminders clears a rhythm', () => {
    const onSave = vi.fn<(changes: RhythmChange[]) => void>()
    const tree = settled(RhythmSheet, props({ onSave }), first => {
      ;(chipsOf(first, 'sam').props.onPick as (v: number | 'off') => void)(14)
      ;(chipsOf(first, 'mum').props.onPick as (v: number | 'off') => void)('off')
      // Aunt tapped to what she already has: no change
      ;(chipsOf(first, 'aunt').props.onPick as (v: number | 'off') => void)(60)
    })
    expect(textOf(elements(tree as El).find(e => e.props.className === 'rhythm-summary')!.props.children)).toBe('Save sets 3 people. One is a suggestion from your own visits, dashed until you tap.')
    ;(button(tree, 'Save').props.onClick as () => void)()
    const changes = onSave.mock.calls[0][0]
    expect(changes.map(c => c.after.id).sort()).toEqual(['gran', 'mum', 'sam'])
    const after = Object.fromEntries(changes.map(c => [c.after.id, c.after]))
    expect(after.gran).toMatchObject({ cadenceDays: 30 })
    expect(after.sam).toMatchObject({ cadenceDays: 14 })
    expect(after.mum.noReminders).toBe(true)
    expect('cadenceDays' in after.mum).toBe(false)
    for (const c of changes) {
      expect(c.before).toBe([...people].find(p => p.id === c.before.id))
      expect(c.after.updatedAt > c.before.updatedAt).toBe(true)
    }
  })

  it('has nothing to save until something differs from what is stored', () => {
    const settledPeople = [person('mum', { cadenceDays: 30 }), person('dad', { noReminders: true })]
    const tree = settled(RhythmSheet, props({ people: settledPeople, tasks: [] }))
    expect(button(tree, 'Save').props.disabled).toBe(true)
  })

  it('on Places: each with its address, Find missing addresses for the ones without, and no suggestion from nothing', () => {
    const html = renderToStaticMarkup(<RhythmSheet {...props({ side: 'places' })} />)
    expect(html).toContain('📍 21 Warwick St, London')
    expect(html).toContain('No address')
    expect(html).toContain('Find missing addresses (2)')
    const rows = placeRows(props().places, [], [], NOW)
    expect(rows.map(r => [r.id, r.current, r.suggestion])).toEqual([
      ['cafe', null, null],
      ['nopi', null, null],
      ['parc', 'off', null],
    ])
  })

  it('says what Save will do over both sides, however many are suggestions', () => {
    const row = (id: string, side: 'people' | 'places') => ({ id, side, name: id, mark: '', color: '', current: null, suggestion: 30, line: '' })
    expect(saveLine([], 0)).toBe('Nothing to save yet.')
    expect(saveLine([row('a', 'people'), row('b', 'places'), row('c', 'places')], 3)).toBe('Save sets 1 person and 2 places. All are suggestions from your own visits, dashed until you tap.')
    expect(saveLine([row('a', 'people'), row('b', 'people')], 0)).toBe('Save sets 2 people.')
    expect(saveLine([row('a', 'people'), row('b', 'people'), row('c', 'people')], 2)).toBe('Save sets 3 people. 2 are suggestions from your own visits, dashed until you tap.')
  })

  it('asks for a town once when nothing else says where your places are, and looks nothing up until then', () => {
    const lookup = vi.fn()
    const tree = settled(FindAddress, { name: 'Nopi', address: '', places: [], onPick: noop, lookup }, first => press(first, 'Find address'))
    expect(elements(tree as El).some(e => e.type === TownField)).toBe(true)
    expect(button(tree, 'Look up Nopi').props.disabled).toBe(true)
    expect(lookup).not.toHaveBeenCalled()
    // Find missing addresses the same: Start waits for the town
    const missing = settled(MissingAddresses, { places: [place('cafe')], lookup, onSavePlace: noop, onDone: noop })
    expect(elements(missing as El).some(e => e.type === TownField)).toBe(true)
    expect(button(missing, 'Start').props.disabled).toBe(true)
  })

  it('leans to your pinned places without asking, and says so', () => {
    const pinned = [place('nopi', { lat: 33.5, lon: -112.03, address: '2502 E Camelback Rd, Phoenix, AZ 85016' })]
    const html = renderToStaticMarkup(<MissingAddresses places={[...pinned, place('cafe')]} lookup={vi.fn()} onSavePlace={noop} onDone={noop} />)
    expect(html).toContain('1 place without an address')
    expect(html).toContain('near your pinned places')
    expect(html).not.toContain('Which town are your places in?')
  })

  it('names what was saved in the toast', () => {
    const change = (after: Person | Place): RhythmChange => ({ before: after, after })
    expect(rhythmsSaved([change(person('mum'))])).toBe('Rhythm saved for Mum')
    expect(rhythmsSaved([change(person('mum')), change(person('dad')), change(place('nopi'))])).toBe('Rhythms saved for 2 people and 1 place')
  })
})

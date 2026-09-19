import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Calendar, CalendarView } from '../components/Calendar'
import { PLACE_CATEGORY_META } from '../types'
import type { CalendarEvent, Place, Recipe } from '../types'

// An event whose location is one of your places (matchPlace) shows that
// place's emoji, or its category's, before the location — in the week list,
// in a month pill's title and in the day sheet, which all read the one line
// itemMeta writes. The day sheet opens on a tap, so it was checked in the
// browser; the week list and the month grid render here.

const STAMP = '2026-01-01T00:00:00.000Z'
const noop = () => {}
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const text = (html: string) => html.replace(/<!-- -->/g, '')
const place = (id: string, name: string, over: Partial<Place> = {}): Place => ({ kind: 'place', id, name, color: '#c0392b', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP, ...over })
const nopi = place('nopi', 'Nopi', { emoji: '🍝' })
const park = place('park', 'Hyde Park', { category: 'outdoors' })
const gone = place('gone', 'The Ivy', { deletedAt: STAMP })

/** Saturday 12 September 2026, local time. */
const at = (h: number) => new Date(2026, 8, 12, h).toISOString()
const event = (id: string, location?: string): CalendarEvent => ({ id, sourceId: 'family', title: `Event ${id}`, start: at(13), end: at(14), allDay: false, location })
const events = [event('a', 'NOPI, 21 Warwick St'), event('b', 'Hyde Park, W2'), event('c', 'The Moon'), event('d', 'The Ivy'), event('e', '1 Oxford St, London')]

const render = (view: CalendarView, places: Place[] = [nopi, park, gone]) =>
  text(
    renderToStaticMarkup(
      <Calendar
        view={view}
        tasks={[]}
        projects={[]}
        projectMap={new Map()}
        people={[]}
        meals={[]}
        recipes={[]}
        places={places}
        events={events}
        sourceMap={new Map()}
        onOpen={noop}
        onNew={noop}
        onSaveMeal={noop}
        onClearMeal={noop}
        onCreatePlace={() => nopi}
        onCreateRecipe={() => ({}) as Recipe}
        onNewEvent={noop}
        onEditEvent={noop}
        onReschedule={noop}
        onPlan={noop}
        onAttendance={noop}
        onOpenProject={noop}
        onPlanOccasion={noop}
      />,
    ),
  )

describe('calendar rows mark a place you know', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 12, 9))
  })
  afterEach(() => vi.useRealTimers())

  it('in the week list: the place’s own emoji, else its category’s, before the location', () => {
    // each event's line under its title: "1:00 PM – 2:00 PM · 🍝 NOPI, 21 Warwick St"
    const metas = [...render('week').matchAll(/<span class="cal-item-meta">([^<]*)<\/span>/g)].map(m => m[1])
    const lineFor = (location: string) => metas.find(m => m.endsWith(location))
    expect(lineFor('NOPI, 21 Warwick St')).toMatch(/^[^·]+ · 🍝 NOPI, 21 Warwick St$/)
    expect(lineFor('Hyde Park, W2')).toMatch(new RegExp(`^[^·]+ · ${PLACE_CATEGORY_META.outdoors.emoji} Hyde Park, W2$`))
    // somewhere unknown, or a place in the Trash, reads as it did
    expect(lineFor('The Moon')).toMatch(/^[^·]+ · The Moon$/)
    expect(lineFor('The Ivy')).toMatch(/^[^·]+ · The Ivy$/)
  })

  it('in the month grid: in each pill’s title, where its location shows', () => {
    const html = render('month')
    expect(html).toContain('title="Event a · ')
    expect(html).toMatch(/title="Event a · [^"]+ · 🍝 NOPI, 21 Warwick St"/)
    expect(html).toMatch(new RegExp(`title="Event b · [^"]+ · ${PLACE_CATEGORY_META.outdoors.emoji} Hyde Park, W2"`))
    expect(html).toMatch(/title="Event c · [^"]+ – [^"]+ · The Moon"/)
  })

  it('knows a place by another name it goes by, or by its address', () => {
    const moon = place('moon', 'Moonbase Diner', { emoji: '🌙', aliases: ['The Moon'] })
    const pret = place('pret', 'Pret A Manger', { emoji: '🥪', category: 'cafe', address: '1 Oxford St, London' })
    const metas = [...render('week', [nopi, park, moon, pret]).matchAll(/<span class="cal-item-meta">([^<]*)<\/span>/g)].map(m => m[1])
    expect(metas.find(m => m.endsWith('The Moon'))).toMatch(/^[^·]+ · 🌙 The Moon$/)
    expect(metas.find(m => m.endsWith('1 Oxford St, London'))).toMatch(/^[^·]+ · 🥪 1 Oxford St, London$/)
    // without them, both read as they did
    const plain = [...render('week').matchAll(/<span class="cal-item-meta">([^<]*)<\/span>/g)].map(m => m[1])
    expect(plain.find(m => m.endsWith('1 Oxford St, London'))).toMatch(/^[^·]+ · 1 Oxford St, London$/)
  })

  it('with no places saved, every location reads as it did', () => {
    const html = render('week', [])
    expect(html).toContain(' · NOPI, 21 Warwick St</span>')
    expect(html).not.toContain('🍝')
  })

  it('the day sheet’s event rows read the same line', () => {
    const src = read('../components/Calendar.tsx')
    const row = src.slice(src.indexOf("if (item.kind === 'event') {\n                const ev = item.event"))
    expect(row).toMatch(/<span className="cal-row-meta">\{itemMeta\(item\)\}<\/span>/)
  })
})

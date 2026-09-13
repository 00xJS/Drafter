import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEditor, buildEntry } from '../components/EventEditor'
import { enterPick } from '../components/PeoplePicker'
import { People } from '../components/People'
import { Today } from '../components/Today'
import { PeoplePlace } from '../components/taskeditor/PeoplePlace'
import { eventVisits, personStats, yearReport } from '../people'
import { newPerson } from '../taskform'
import type { CalendarEntry, Person, Task } from '../types'

// Owner request #10: "+ Add person" in the event editor. People put on an
// event of your own count, once it has happened, exactly as the people "Who
// was there?" logs for a subscribed calendar's event. vitest runs in node, so
// these are static renders plus the rules behind them; the clicks were
// checked in the browser.

const STAMP = '2026-09-01T00:00:00.000Z'
/** A September day in local time. */
const at = (d: number, h = 0, m = 0) => new Date(2026, 8, d, h, m).toISOString()
const NOW = new Date(2026, 8, 14, 9, 0) // Monday 14 September, 9am
const noop = () => {}

const person = (id: string, name: string, over: Partial<Person> = {}): Person => ({ kind: 'person', id, name, color: '#f97316', group: 'family', createdAt: STAMP, updatedAt: STAMP, ...over })
const mum = person('mum', 'Mum', { emoji: '👩', cadenceDays: 14 })
const sam = person('sam', 'Sam')
const people = [mum, sam]

const entry = (id: string, over: Partial<CalendarEntry> = {}): CalendarEntry => ({ kind: 'event', id, title: 'Lunch', start: at(12, 13), end: at(12, 14), allDay: false, createdAt: STAMP, updatedAt: STAMP, ...over })
/** Saturday's lunch with Mum, made in Drafter. */
const lunch = entry('lunch', { title: 'Lunch with Mum', location: 'Nopi', peopleIds: ['mum'] })

/** What "Who was there?" logs for a subscribed calendar's event (logAttendance → logOuting in useLifeActions). */
const logged = (ev: { title: string; start: string; allDay: boolean; location?: string }, peopleIds: string[]): Task => ({
  kind: 'task',
  id: 'logged',
  title: ev.title,
  description: ev.location ? `At ${ev.location}` : '',
  status: 'done',
  priority: 'normal',
  completedAt: ev.allDay ? new Date(`${ev.start}T12:00`).toISOString() : new Date(ev.start).toISOString(),
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  tags: ['visit'],
  peopleIds,
})

/** The slice of `html` from `marker` to the end of the section it opens. */
function sectionAt(html: string, marker: string): string {
  const from = html.indexOf(marker)
  if (from < 0) return ''
  return html.slice(from, html.indexOf('</section>', from))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the event editor’s People field', () => {
  const editor = (over: Partial<ComponentProps<typeof EventEditor>> = {}) =>
    renderToStaticMarkup(<EventEditor defaultStartIso={at(14, 10)} people={people} onSavePerson={noop} onSave={noop} onClose={noop} {...over} />)

  it('asks who an event is with, between its time and its location, and says what that counts as', () => {
    const html = editor()
    expect(html).toContain('<span>People <small>(once it has happened, it counts as seeing them)</small></span>')
    expect(html).toContain('placeholder="Search or add a person…"')
    expect(html.indexOf('>Ends<')).toBeLessThan(html.indexOf('>People '))
    expect(html.indexOf('>People ')).toBeLessThan(html.indexOf('>Location<'))
    // nobody on a new one, and no contact list filling the dialog
    expect(html).not.toContain('platform-toggles')
  })

  it('shows who a saved event has, each a chip that takes them off', () => {
    const html = editor({ entry: entry('ev', { peopleIds: ['mum', 'gone'] }) })
    expect(html).toContain('<button type="button" class="toggle on" title="Remove">👩 Mum ✕</button>')
    // someone deleted since reads "Unknown", never an id
    expect(html).toContain('<button type="button" class="toggle on" title="Remove">Unknown ✕</button>')
    expect(html).toContain('placeholder="Add someone else…"')
  })

  it('is on an all-day event too, and never on a work day, new or saved', () => {
    expect(editor({ entry: entry('ad', { allDay: true, start: '2026-09-20', end: '2026-09-21', peopleIds: ['sam'] }) })).toContain('Sam ✕')
    expect(editor({ defaultWork: 'home' })).not.toContain('people-picker-search')
    expect(editor({ entry: entry('wd', { work: 'office', title: 'Office day', start: at(15, 9), end: at(15, 17), peopleIds: ['sam'] }) })).not.toContain('people-picker-search')
  })

  it('finds people only when it has nowhere to save a new one, and is not drawn with neither', () => {
    expect(editor({ onSavePerson: undefined })).toContain('placeholder="Search people to add…"')
    expect(editor({ people: [], onSavePerson: undefined })).not.toContain('people-picker-search')
    // nobody saved yet, but a name can still be typed in and added
    expect(editor({ people: [] })).toContain('placeholder="Search or add a person…"')
  })
})

describe('adding someone new from the event', () => {
  it('adds a name nobody has, tidied, when Enter is pressed (and offers "+ Add" for it)', () => {
    expect(enterPick('  Aunt   Jo ', people, [], true)).toEqual({ add: 'Aunt Jo' })
  })

  it('never makes a second person of a name already saved', () => {
    expect(enterPick('MUM', people, [], true)).toEqual({ attach: mum })
    // already on the event: Enter does nothing
    expect(enterPick(' mum ', people, ['mum'], true)).toBeNull()
    expect(enterPick('   ', people, [], true)).toBeNull()
  })

  it('without somewhere to save people, takes the first match or nothing', () => {
    expect(enterPick('sa', people, [], false)).toEqual({ attach: sam })
    expect(enterPick('Aunt Jo', people, [], false)).toBeNull()
  })

  it('saves them as the People tab would, and the event is written with them on it', () => {
    const jo = newPerson('Aunt Jo', { id: 'jo', color: '#22c55e', now: NOW })
    expect(jo).toEqual({ kind: 'person', id: 'jo', name: 'Aunt Jo', group: 'family', color: '#22c55e', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
    const saved = buildEntry(undefined, { title: 'Lunch', start: at(20, 13), end: at(20, 14), allDay: false }, { location: '', notes: '', peopleIds: ['mum', jo.id] }, true)
    expect(saved.peopleIds).toEqual(['mum', 'jo'])
  })
})

describe('saving an event writes who is on it (build)', () => {
  const when = { title: 'Lunch', start: at(20, 13), end: at(20, 14), allDay: false }
  const rest = (over: Partial<Parameters<typeof buildEntry>[2]> = {}) => ({ location: '', notes: '', peopleIds: [] as string[], ...over })

  it('writes the people picked on a new event', () => {
    const e = buildEntry(undefined, when, rest({ peopleIds: ['mum', 'sam'] }), true)
    expect(e).toMatchObject({ kind: 'event', title: 'Lunch', start: when.start, end: when.end, peopleIds: ['mum', 'sam'], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
  })

  it('keeps the id and creation time on an edit, and takes someone off', () => {
    const e = buildEntry(entry('ev', { peopleIds: ['mum', 'sam'] }), when, rest({ peopleIds: ['sam'] }), true)
    expect(e).toMatchObject({ id: 'ev', createdAt: STAMP, peopleIds: ['sam'] })
    expect(e.updatedAt > STAMP).toBe(true)
  })

  it('stores no list for nobody, so an event without people is written as it always was', () => {
    const before = entry('old', { location: 'Nopi' })
    const e = buildEntry(before, { ...when, title: before.title }, rest({ location: 'Nopi' }), true)
    expect(e).not.toHaveProperty('peopleIds', [])
    expect(e).toEqual({ ...before, start: when.start, end: when.end, updatedAt: e.updatedAt })
  })

  it('never puts people on a work day, and leaves a saved one’s as they were', () => {
    expect(buildEntry(undefined, when, rest({ work: 'home', peopleIds: ['mum'] }), true).peopleIds).toBeUndefined()
    expect(buildEntry(entry('wd', { work: 'office', peopleIds: ['sam'] }), when, rest({ work: 'office' }), true).peopleIds).toEqual(['sam'])
  })
})

describe('a past event of your own counts toward the People figures', () => {
  it('reads as the visit Who was there? would have logged for it', () => {
    const [v] = eventVisits([lunch], NOW)
    // its own id, so the visit can open the event it came from
    expect(v.id).toBe('lunch')
    const blank = { id: '', createdAt: '', updatedAt: '' }
    expect({ ...v, ...blank }).toEqual({ ...logged(lunch, ['mum']), ...blank })
  })

  it('gives every figure a feed event with attendance gives', () => {
    const mine = personStats(mum, eventVisits([lunch], NOW), NOW)
    const feed = personStats(mum, [logged(lunch, ['mum'])], NOW)
    for (const k of ['lastSeen', 'daysSince', 'count30', 'count90', 'avgGapDays', 'weekly', 'status', 'reason'] as const) expect(mine[k], k).toEqual(feed[k])
    expect(mine).toMatchObject({ status: 'ok', reason: 'Last seen 1 day ago', count30: 1, count90: 1 })
    expect(yearReport([mum], eventVisits([lunch], NOW), 2026, NOW)).toEqual(yearReport([mum], [logged(lunch, ['mum'])], 2026, NOW))
  })

  it('leaves out what has not happened yet, a work day, a deleted one and one with nobody on it', () => {
    const tonight = entry('tonight', { start: at(14, 18), end: at(14, 19), peopleIds: ['mum'] })
    const today = entry('today', { allDay: true, start: '2026-09-14', end: '2026-09-15', peopleIds: ['mum'] })
    const work = entry('work', { work: 'office', peopleIds: ['mum'] })
    const gone = entry('gone', { peopleIds: ['mum'], deletedAt: at(13) })
    const nobody = entry('nobody', { peopleIds: [] })
    expect(eventVisits([tonight, today, work, gone, nobody, entry('plain')], NOW)).toEqual([])
    // an all-day one counts from midday, where its visit is dated, as a logged one is
    expect(eventVisits([today], new Date(2026, 8, 14, 12, 0)).map(v => v.id)).toEqual(['today'])
  })

  const page = (over: Partial<ComponentProps<typeof People>> = {}) =>
    renderToStaticMarkup(<People people={[mum]} tasks={[]} onSave={noop} onDelete={noop} onLogVisit={noop} onPlan={noop} onOpenTask={noop} {...over} />)

  it('reads on the People page exactly as the same event from another calendar does once logged', () => {
    const mine = page({ entries: [lunch] })
    expect(mine).toBe(page({ tasks: [logged(lunch, ['mum'])] }))
    expect(mine).toContain('Last seen 1 day ago')
    expect(mine).toMatch(/Occasions<\/div><div class="stat-value">1</)
    expect(mine).toMatch(/People seen<\/div><div class="stat-value">1</)
    // …and without it, Mum has no visits at all
    expect(page()).toContain('No visits yet')
    expect(page({ entries: [{ ...lunch, peopleIds: undefined }] })).toBe(page())
  })

  function renderToday(over: Partial<ComponentProps<typeof Today>> = {}) {
    // the journal card asks the viewport how wide it is; a static render has none
    if (typeof window === 'undefined') vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
    const props: ComponentProps<typeof Today> = {
      tasks: [],
      allTasks: [],
      people: [mum],
      places: [],
      reviews: [],
      onPlanWith: noop,
      onWentTo: noop,
      onPlanAt: noop,
      onPlanOccasion: noop,
      onSaw: noop,
      onSaveReview: noop,
      projects: [],
      projectMap: new Map(),
      events: [],
      sourceMap: new Map(),
      onPlan: noop,
      onOpen: noop,
      onOpenProject: noop,
      onNewProject: noop,
      onStatus: noop,
      onDefer: noop,
      onDeferAll: noop,
      onNew: noop,
      meals: [],
      recipes: [],
      onOpenKitchen: noop,
      onOpenReview: noop,
      onCookRecipe: noop,
      journal: [],
      onSaveJournal: noop,
      onDeleteJournal: noop,
      onOpenJournal: noop,
      habits: [],
      onSaveHabit: noop,
      onDeleteHabit: noop,
      routines: [],
      onSaveRoutine: noop,
      onDeleteRoutine: noop,
      ...over,
    }
    return renderToStaticMarkup(<Today {...props} />)
  }

  it('stops Today nudging about someone you saw at it', () => {
    // the last visit logged was in early August: overdue on a fortnightly rhythm
    const august: Task = { ...logged(lunch, ['mum']), id: 'august', completedAt: new Date(2026, 7, 1, 12).toISOString() }
    // something on the list, or Today is the welcome page
    const bins: Task = { kind: 'task', id: 'bins', title: 'Put the bins out', description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [] }
    const nudges = (entries: CalendarEntry[]) => sectionAt(renderToday({ tasks: [bins], allTasks: [bins, august], entries }), 'class="chart-card people-nudges"')
    expect(nudges([])).toContain('Mum')
    expect(nudges([])).toContain('Overdue')
    expect(nudges([lunch])).toBe('')
  })
})

describe('the task editor’s People picker reads as it did', () => {
  it('still counts marking the task done, lists who is on it, and adds by name', () => {
    const html = renderToStaticMarkup(<PeoplePlace form={{ peopleIds: ['sam'], placeId: undefined }} set={noop} people={people} places={[]} onSavePerson={noop} />)
    expect(html).toContain('<span>People <small>(marking this done counts as seeing them)</small></span>')
    expect(html).toContain('<button type="button" class="toggle on" title="Remove">Sam ✕</button>')
    expect(html).toContain('placeholder="Add someone else…"')
    expect(html).toContain('Where <small>(marking this done counts as an outing there)</small>')
  })
})

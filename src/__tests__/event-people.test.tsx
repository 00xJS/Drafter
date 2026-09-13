import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDigest } from '../../shared/digest.mjs'
import { proposeWeek } from '../../shared/weekplan.mjs'
import { weekPolishInput } from '../ai'
import { factsFor, parseQuestion } from '../ask'
import type { AskSources } from '../ask'
import { EventEditor, buildEntry } from '../components/EventEditor'
import { enterPick } from '../components/PeoplePicker'
import { People } from '../components/People'
import { Today } from '../components/Today'
import { PeoplePlace } from '../components/taskeditor/PeoplePlace'
import { blocksOn } from '../focus'
import { eventVisits, personStats, seenTasks, yearReport } from '../people'
import { buildReview, weekRange } from '../review'
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

describe('every other place that says whether you have seen someone counts it too', () => {
  // the last visit logged was in early August: overdue on a fortnightly
  // rhythm, until Saturday's lunch of your own with Mum on it
  const august: Task = { ...logged(lunch, ['mum']), id: 'august', completedAt: new Date(2026, 7, 1, 12).toISOString() }

  it('reads the tasks and the visits your own past events amount to (seenTasks)', () => {
    expect(seenTasks([august], [lunch], NOW)).toEqual([august, ...eventVisits([lunch], NOW)])
    expect(personStats(mum, seenTasks([august], [], NOW), NOW).status).toBe('overdue')
    expect(personStats(mum, seenTasks([august], [lunch], NOW), NOW).status).toBe('ok')
  })

  it('Plan next week, and the Sunday digest’s week plan, no longer propose catching up with her', () => {
    const catchUps = (extra: CalendarEntry[]) => proposeWeek([mum, august, ...extra], { todayKey: '2026-09-14', now: NOW })!.people.map(r => r.title)
    expect(catchUps([])).toEqual(['Catch up with Mum'])
    expect(catchUps([lunch])).toEqual([])
  })

  it('the morning digest stops listing her under Catch up with', () => {
    const due = (extra: CalendarEntry[]) => buildDigest([mum, august, ...extra], 'Europe/London', NOW).peopleDue
    expect(due([])).toEqual(['Mum (43d)'])
    expect(due([lunch])).toEqual([])
  })

  it('Review lists her under People for the week of the lunch', () => {
    const week = weekRange(new Date(2026, 8, 12)) // Sunday 6 – Saturday 12 September
    const seenThatWeek = (entries: CalendarEntry[]) => buildReview(week, [august], [], [mum], NOW, [], entries).people.map(r => [r.person.name, r.visits.map(v => v.title)])
    expect(seenThatWeek([])).toEqual([])
    expect(seenThatWeek([lunch])).toEqual([['Mum', ['Lunch with Mum']]])
  })

  it('Ask answers "when did I last see Mum?" with the lunch', () => {
    const src = (entries: CalendarEntry[]): AskSources => ({ tasks: [august], projects: [], people: [mum], places: [], recipes: [], meals: [], entries, feedEvents: [], journal: [] })
    const mumLine = (entries: CalendarEntry[]) => factsFor(parseQuestion('When did I last see Mum?', src(entries), NOW), src(entries), NOW, 'Europe/London').find(f => f.startsWith('Mum:'))
    expect(mumLine([])).toMatch(/^Mum: last seen 2026-08-01 .*overdue a catch-up/)
    expect(mumLine([lunch])).toMatch(/^Mum: last seen 2026-09-12 \(2 days ago\); aims for every 14 days, on track; 2 visits in the last 90 days/)
  })

  it('the ✨ polish of a week plan is told she was seen at the lunch, not in August', () => {
    const plan = proposeWeek([mum, august], { todayKey: '2026-09-14', now: NOW })!
    const daysSince = (entries?: CalendarEntry[]) => weekPolishInput(plan, { recipes: [], people: [mum], meals: [], tasks: [august], entries, now: NOW }).people.map(p => p.daysSince)
    expect(daysSince()).toEqual([43])
    expect(daysSince([lunch])).toEqual([1])
  })
})

describe('a Plan my day block stays its task’s', () => {
  // Plan my day's time for a task: an entry of your own, so the day sheet offers Edit on it
  const block = entry('block', { title: 'Lunch with Mum', start: at(15, 12), end: at(15, 13), taskId: 'lunch-task' })
  const when = { title: 'Lunch with Mum', start: at(15, 12, 30), end: at(15, 13, 30), allDay: false }
  const rest = { location: '', notes: '', peopleIds: [] as string[] }

  it('keeps the task it is time for when edited, so Plan my day still finds it', () => {
    const e = buildEntry(block, when, rest, true)
    expect(e).toMatchObject({ id: 'block', taskId: 'lunch-task', start: when.start, end: when.end })
    expect(blocksOn([e], '2026-09-15').get('lunch-task')?.id).toBe('block')
    // an event made in the editor is still nobody's block
    expect(buildEntry(undefined, when, rest, true).taskId).toBeUndefined()
  })

  it('has no People field and takes none: the task carries them, and counts once done', () => {
    const html = renderToStaticMarkup(<EventEditor entry={block} defaultStartIso={block.start} people={people} onSavePerson={noop} onSave={noop} onClose={noop} />)
    expect(html).toContain('Edit event')
    expect(html).not.toContain('people-picker-search')
    expect(buildEntry(block, when, { ...rest, peopleIds: ['mum'] }, true).peopleIds).toBeUndefined()
  })

  it('never counts as a visit, even with people on it, so its done task is not counted twice', () => {
    const done: Task = { ...logged(block, ['mum']), id: 'lunch-task', tags: [] }
    const withPeople = { ...block, start: at(12, 13), end: at(12, 14), peopleIds: ['mum'] }
    expect(eventVisits([withPeople], NOW)).toEqual([])
    expect(personStats(mum, seenTasks([done], [withPeople], NOW), NOW).count30).toBe(1)
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

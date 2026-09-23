import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { remindersOff, rhythmOf, seenStatus, suggestRhythm, withRhythm } from '../../shared/people.mjs'
import { placeCadenceStatus } from '../../shared/places.mjs'
import { buildDigest } from '../../shared/digest.mjs'
import { proposeWeek } from '../../shared/weekplan.mjs'
import { makeClock } from '../../shared/clock.mjs'
import { TOOLS, createContext } from '../../mcp/tools.mjs'
import type { RestData } from '../../mcp/data.mjs'
import { personRhythmSuggestion, personStats, seenTasks } from '../people'
import { placeRhythmSuggestion, placeStats } from '../places'
import { neverSeen, notSeenLately, togetherCounts } from '../peoplestats'
import { neverBeen, notBeenBack, placesTiles } from '../placestats'
import { buildLocalReminders } from '../reminders'
import { sanitizePerson, sanitizePlace } from '../schema'
import { Today } from '../components/Today'
import type { Meal, Person, Place, Task } from '../types'

// Level-up 2: most of the address book had no rhythm (thirty-odd people on the
// implicit 90 days, no place with any). Who, and how often sets one for each,
// from a suggestion read off YOUR visits, and No reminders is a choice stored
// on the record — `noReminders: true` — that every reader goes by.

const JOE = '11111111-1111-1111-1111-111111111111'
const MARIA = '22222222-2222-2222-2222-222222222222'
const NOW = new Date('2026-09-22T12:00:00.000Z')
const TODAY = '2026-09-22'
const ADDED = '2026-01-01T12:00:00.000Z'

const person = (id: string, over: Partial<Person> = {}): Person => ({ kind: 'person', id, name: id[0].toUpperCase() + id.slice(1), group: 'family', color: '#888888', createdAt: ADDED, updatedAt: ADDED, ...over })
const place = (id: string, over: Partial<Place> = {}): Place => ({ kind: 'place', id, name: id[0].toUpperCase() + id.slice(1), category: 'restaurant', color: '#888888', createdAt: ADDED, updatedAt: ADDED, ...over })
/** A day `n` days before NOW, at midday UTC, so no zone moves it to another day. */
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const visit = (id: string, who: string, at: string, ownerId?: string): Task =>
  ({ kind: 'task', id, title: 'Saw them', description: '', status: 'done', priority: 'normal', tags: ['visit'], peopleIds: [who], completedAt: at, createdAt: at, updatedAt: at, ...(ownerId ? { ownerId } : {}) }) as Task
const outing = (id: string, placeId: string, at: string, ownerId?: string): Task =>
  ({ kind: 'task', id, title: 'Went', description: '', status: 'done', priority: 'normal', tags: ['visit'], placeId, completedAt: at, createdAt: at, updatedAt: at, ...(ownerId ? { ownerId } : {}) }) as Task
const dayKeys = (...ago: number[]) => ago.map(n => daysAgo(n).slice(0, 10))

describe('the rhythm a history suggests', () => {
  it('reads seen on 3 of the last 90 days as about monthly, and once as about every three months', () => {
    expect(suggestRhythm(dayKeys(5, 30, 60), TODAY)).toBe(30)
    expect(suggestRhythm(dayKeys(40), TODAY)).toBe(90)
  })

  it('goes to the nearest of the chips on a log scale', () => {
    expect(suggestRhythm(dayKeys(...Array.from({ length: 12 }, (_, i) => i * 7)), TODAY)).toBe(7)
    expect(suggestRhythm(dayKeys(1, 15, 30, 45, 60, 75), TODAY)).toBe(14)
    // twice in 90 days is a 45-day gap: nearer a month than three
    expect(suggestRhythm(dayKeys(10, 55), TODAY)).toBe(30)
  })

  it('looks back a year when the last 90 days are empty, and suggests nothing with nothing in a year', () => {
    expect(suggestRhythm(dayKeys(200), TODAY)).toBe(180)
    expect(suggestRhythm(dayKeys(400), TODAY)).toBeNull()
    expect(suggestRhythm([], TODAY)).toBeNull()
  })

  it('counts a day once, and never a day still to come', () => {
    expect(suggestRhythm(dayKeys(5, 5, 5), TODAY)).toBe(90)
    expect(suggestRhythm(['2026-10-01', '2026-10-02', '2026-10-03'], TODAY)).toBeNull()
  })

  it('reads YOUR visits, not the household’s: the same Mum suggests differently for each member', () => {
    const mum = person('mum')
    // Joe saw her on three days in the last 90; Maria every week
    const tasks = [
      ...[5, 30, 60].map((n, i) => visit(`j${i}`, 'mum', daysAgo(n), JOE)),
      ...Array.from({ length: 12 }, (_, i) => visit(`m${i}`, 'mum', daysAgo(i * 7 + 1), MARIA)),
    ]
    expect(personRhythmSuggestion(mum, seenTasks(tasks, [], NOW, JOE), TODAY)).toBe(30)
    expect(personRhythmSuggestion(mum, seenTasks(tasks, [], NOW, MARIA), TODAY)).toBe(7)
  })

  it('reads your own outings to a place too, and a meal shared with the household counts for both', () => {
    const cafe = place('cafe')
    const tasks = [outing('j1', 'cafe', daysAgo(20), JOE), outing('m1', 'cafe', daysAgo(3), MARIA), outing('m2', 'cafe', daysAgo(10), MARIA)]
    expect(placeRhythmSuggestion(cafe, tasks, [], TODAY, NOW, JOE)).toBe(90)
    expect(placeRhythmSuggestion(cafe, tasks, [], TODAY, NOW, MARIA)).toBe(30)
    const shared = { kind: 'meal', id: 'meal~x', date: daysAgo(40).slice(0, 10), slot: 'dinner', title: 'Dinner', out: true, placeId: 'cafe', ownerId: MARIA, createdAt: ADDED, updatedAt: ADDED } as Meal
    expect(placeRhythmSuggestion(cafe, tasks, [shared], TODAY, NOW, JOE)).toBe(30)
  })
})

describe('No reminders is stored on the record, one way', () => {
  it('withRhythm writes the one field and clears the other', () => {
    const mum = person('mum', { cadenceDays: 30 })
    expect(withRhythm(mum, 'off')).toEqual({ ...person('mum'), noReminders: true })
    expect(withRhythm({ ...person('mum'), noReminders: true }, 14)).toEqual({ ...person('mum'), cadenceDays: 14 })
    expect(withRhythm(mum, null)).toEqual(person('mum'))
    expect([rhythmOf(mum), rhythmOf({ ...mum, noReminders: true }), rhythmOf(person('dad'))]).toEqual([30, 'off', null])
  })

  it('is never a rhythm of 0, which has always meant none set', () => {
    expect(remindersOff(person('mum', { cadenceDays: 0 }))).toBe(false)
    expect(seenStatus(person('mum', { cadenceDays: 0 }), [], NOW).status).toBe('never')
  })

  it('survives the sanitizers, and wins over a rhythm two devices merged in beside it', () => {
    expect(sanitizePerson({ ...person('mum'), noReminders: true, cadenceDays: 30 })).toMatchObject({ noReminders: true, cadenceDays: undefined })
    expect(sanitizePlace({ ...place('nopi'), noReminders: true, cadenceDays: 30 })).toMatchObject({ noReminders: true, cadenceDays: undefined })
    // only a real true: anything else is none set
    expect(sanitizePerson({ ...person('mum'), noReminders: 'yes', cadenceDays: 30 })).toMatchObject({ noReminders: undefined, cadenceDays: 30 })
  })
})

describe('No reminders reaches every reader', () => {
  const quietMum = person('mum', { noReminders: true })
  const quietNopi = place('nopi', { noReminders: true })
  // a year since Mum was seen, and since anyone went to Nopi: overdue on any rhythm
  const oldVisit = visit('v', 'mum', daysAgo(365))
  const oldOuting = outing('o', 'nopi', daysAgo(365))

  it('the status: off, whatever the visits say, with no rhythm to measure against', () => {
    const seen = seenStatus(quietMum, [oldVisit], NOW)
    expect(seen).toMatchObject({ status: 'off', effectiveCadenceDays: null, daysSince: 365 })
    expect(seen.reason).toBe('Last seen 365 days ago · no reminders')
    expect(seenStatus(person('dad', { noReminders: true }), [], NOW)).toMatchObject({ status: 'off', reason: 'No visits logged · no reminders' })
    expect(placeCadenceStatus(quietNopi, [oldOuting], NOW, [])).toEqual({ status: 'off', reason: '' })
    // …and without it the same history is overdue
    expect(seenStatus(person('mum'), [oldVisit], NOW).status).toBe('overdue')
    expect(placeCadenceStatus(place('nopi', { cadenceDays: 30 }), [oldOuting], NOW, []).status).toBe('overdue')
  })

  it('the phone’s reminders: never a Been a while for a place on No reminders', () => {
    const due = place('parc', { cadenceDays: 30 })
    const out = buildLocalReminders([oldOuting, outing('p', 'parc', daysAgo(365))], [], [quietNopi, due], [], NOW)
    expect(out.map(r => r.title)).toEqual(['Been a while: Parc'])
  })

  it('the phone’s reminders count your own outings: the other member going does not answer yours', () => {
    const parc = place('parc', { cadenceDays: 30 })
    const tasks = [outing('old', 'parc', daysAgo(365), JOE), outing('hers', 'parc', daysAgo(2), MARIA)]
    expect(buildLocalReminders(tasks, [], [parc], [], NOW, 30, { myId: JOE }).map(r => r.title)).toEqual(['Been a while: Parc'])
    expect(buildLocalReminders(tasks, [], [parc], [], NOW, 30, { myId: MARIA })).toEqual([])
  })

  it('the morning digest: neither a Catch up with nor a Been a while', () => {
    const items = [quietMum, person('dad', { noReminders: true }), quietNopi, oldVisit, oldOuting, person('gran', { cadenceDays: 7 }), place('parc', { cadenceDays: 7 }), outing('p', 'parc', daysAgo(365))]
    const d = buildDigest(items, 'UTC', NOW, {}, JOE)
    expect(d.peopleDue).toEqual(['Gran (no visit logged)'])
    expect(d.placesDue).toEqual(['Parc (365d)'])
  })

  it('the morning digest counts the reader’s own visits', () => {
    const items = [person('mum', { cadenceDays: 30 }), visit('old', 'mum', daysAgo(120), JOE), visit('hers', 'mum', daysAgo(2), MARIA)]
    expect(buildDigest(items, 'UTC', NOW, {}, JOE).peopleDue).toEqual(['Mum (120d)'])
    expect(buildDigest(items, 'UTC', NOW, {}, MARIA).peopleDue).toEqual([])
  })

  it('Plan next week proposes no catch-up with them', () => {
    const catchUps = (people: Person[]) => proposeWeek([...people, oldVisit], { todayKey: TODAY, now: NOW })!.people.map(r => r.personId)
    expect(catchUps([person('mum')])).toEqual(['mum'])
    expect(catchUps([quietMum])).toEqual([])
  })

  it('People → Stats: not in the attention tiles, Not seen lately or Never seen', () => {
    const stats = [personStats(quietMum, [oldVisit], NOW), personStats(person('dad', { noReminders: true }), [], NOW), personStats(person('gran', { cadenceDays: 7 }), [visit('g', 'gran', daysAgo(30))], NOW), personStats(person('sam'), [], NOW)]
    expect(togetherCounts(stats, []).attention).toEqual({ overdue: 1, due: 0 })
    expect(notSeenLately(stats).map(s => s.person.id)).toEqual(['gran'])
    expect(neverSeen(stats, TODAY).map(s => s.person.id)).toEqual(['sam'])
  })

  it('Places → Stats: not Been a while, Not been back or Never been', () => {
    const drifted = [outing('a', 'nopi', daysAgo(400)), outing('b', 'nopi', daysAgo(365))]
    const stats = [placeStats(quietNopi, drifted, [], NOW), placeStats(place('empty', { noReminders: true }), [], [], NOW), placeStats(place('fresh'), [], [], NOW), placeStats(place('parc', { cadenceDays: 7 }), [outing('p', 'parc', daysAgo(30))], [], NOW)]
    expect(stats.map(s => s.status)).toEqual(['off', 'off', 'none', 'overdue'])
    expect(placesTiles(stats, NOW).beenAWhile).toBe(1)
    expect(notBeenBack(stats).map(s => s.place.id)).toEqual(['parc'])
    expect(neverBeen(stats).map(s => s.place.id)).toEqual(['fresh'])
    // the same drift with none set is Not been back, as before
    expect(notBeenBack([placeStats(place('nopi'), drifted, [], NOW)]).map(s => s.place.id)).toEqual(['nopi'])
  })
})

describe('No reminders on Today', () => {
  const noop = () => {}
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  const bins = { kind: 'task', id: 'bins', title: 'Put the bins out', description: '', status: 'todo', priority: 'normal', createdAt: ADDED, updatedAt: ADDED, tags: [] } as Task
  const today = (over: Partial<ComponentProps<typeof Today>>) => {
    const props = {
      tasks: [bins],
      people: [],
      places: [],
      reviews: [],
      projects: [],
      events: [],
      sourceMap: new Map(),
      meals: [],
      recipes: [],
      journal: [],
      habits: [],
      routines: [],
      ...Object.fromEntries(
        ['onPlanWith', 'onWentTo', 'onPlanAt', 'onPlanOccasion', 'onSaw', 'onSaveReview', 'onPlan', 'onOpen', 'onStatus', 'onDefer', 'onDeferAll', 'onNew', 'onOpenKitchen', 'onOpenReview', 'onCookRecipe', 'onSaveJournal', 'onDeleteJournal', 'onOpenJournal', 'onSaveHabit', 'onDeleteHabit', 'onSaveRoutine', 'onDeleteRoutine'].map(k => [k, noop]),
      ),
      ...over,
    } as ComponentProps<typeof Today>
    const html = renderToStaticMarkup(createElement(Today, props))
    const from = html.indexOf('class="chart-card people-nudges"')
    return from < 0 ? '' : html.slice(from, html.indexOf('</section>', from))
  }

  it('asks after neither the person nor the place, however long it has been', () => {
    const tasks = [bins, visit('v', 'mum', daysAgo(365)), outing('o', 'nopi', daysAgo(365))]
    const loud = today({ tasks, people: [person('mum')], places: [place('nopi', { cadenceDays: 30 })] })
    expect(loud).toContain('Mum')
    expect(loud).toContain('Nopi')
    expect(today({ tasks, people: [person('mum', { noReminders: true })], places: [place('nopi', { noReminders: true })] })).toBe('')
  })
})

describe('No reminders over MCP', () => {
  const rows = (): Record<string, any>[] => [
    { ...person('mum', { noReminders: true }), ownerId: JOE },
    { ...person('gran', { cadenceDays: 30 }), ownerId: JOE },
    { ...place('nopi', { noReminders: true }), ownerId: JOE },
    { ...visit('mine', 'gran', daysAgo(100)), ownerId: JOE },
    // the other member saw Gran this week: that is not the reader seeing her
    { ...visit('hers', 'gran', daysAgo(2)), ownerId: MARIA },
  ]
  const written: Record<string, any>[] = []
  const db = {
    fetchAll: async ({ kinds }: { kinds?: string[] } = {}) => rows().filter(r => !kinds || kinds.includes(r.kind)),
    writeItem: async (item: Record<string, any>) => {
      written.push(item)
      return item
    },
  } as unknown as RestData
  const ctx = (userId: string | null = JOE) => createContext({ db, clock: makeClock('UTC', () => NOW.getTime()), userId, newId: () => 'mcp-new' })
  const tool = (name: string) => TOOLS.find(t => t.name === name)!

  it('list_people says off and noReminders, with no rhythm, and counts the reader’s own visits', async () => {
    const { people } = (await tool('list_people').run({}, ctx())) as { people: Record<string, any>[] }
    expect(people.find(p => p.id === 'mum')).toMatchObject({ status: 'off', noReminders: true, cadenceDays: null, effectiveCadenceDays: null })
    expect(people.find(p => p.id === 'gran')).toMatchObject({ status: 'overdue', noReminders: false, cadenceDays: 30, effectiveCadenceDays: 30, daysSince: 100 })
    // with no reader to be wrong about, everyone's visits count, as before
    const all = (await tool('list_people').run({}, ctx(null))) as { people: Record<string, any>[] }
    expect(all.people.find(p => p.id === 'gran')).toMatchObject({ status: 'ok', daysSince: 2 })
    expect(tool('list_people').description).toMatch(/off when the user chose No reminders/)
  })

  it('list_places says off and noReminders', async () => {
    const { places } = (await tool('list_places').run({}, ctx())) as { places: Record<string, any>[] }
    expect(places.find(p => p.id === 'nopi')).toMatchObject({ status: 'off', noReminders: true, cadenceDays: null })
  })

  it('create_place saves No reminders as the app stores it, and refuses it beside a rhythm', async () => {
    written.length = 0
    const out = (await tool('create_place').run({ name: 'Home Depot', category: 'shop', noReminders: true }, ctx())) as { created: Record<string, any> }
    expect(written[0]).toMatchObject({ kind: 'place', noReminders: true, cadenceDays: undefined })
    expect(out.created).toMatchObject({ status: 'off', noReminders: true })
    await expect(tool('create_place').run({ name: 'Lowes', noReminders: true, cadenceDays: 30 }, ctx())).rejects.toThrow(/not both/)
    await expect(tool('create_place').run({ name: 'Lowes', noReminders: 'yes' }, ctx())).rejects.toThrow(/true or false/)
  })
})

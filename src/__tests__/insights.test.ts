import { describe, expect, it } from 'vitest'
import {
  INSIGHT_AREAS,
  MAX_HIGHLIGHTS,
  comparedSpan,
  dayStart,
  insightFigures,
  lastMonthKey,
  nextSpan,
  parsePeriodKey,
  periodName,
  periodNote,
  periodPhrase,
  periodSpan,
  pickHighlights,
  previousPhrase,
  recapLines,
  recapTitle,
  scopeRecords,
  type Highlight,
  type InsightInput,
  type InsightPeriod,
} from '../../shared/insights.mts'
import { localDayKey } from '../../shared/journal.mts'
import { soFarBefore } from '../../shared/stats.mts'
import { dayKeysIn } from '../../shared/people.mts'
import { STATS_AREAS } from '../components/planner/routes'
import type { CalendarEntry, Garment, Habit, JournalEntry, Meal, Person, Place, Recipe, Task, Wear } from '../types'

/*
 * Insights' Highlights, as rules: shared/insights.mts picks the few things
 * worth saying about a week, a month or a year, for the app and for the
 * monthly recap alike. These hold what it picks, in what order, against what,
 * and — above all — whose log it counts.
 */

const STAMP = '2026-01-01T00:00:00.000Z'
const JOE = 'joe-0000'
const MARIA = 'maria-000'
/** Thursday 24 September 2026, in the evening, on this machine's own calendar. */
const NOW = new Date(2026, 8, 24, 18, 0)
const TODAY = '2026-09-24'
const dayKeyOf = (iso: string) => localDayKey(new Date(iso))

const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', tags: [], createdAt: STAMP, updatedAt: STAMP, ...over })
/** A task finished at midday on a local day, so no zone moves it. */
const done = (id: string, day: string, over: Partial<Task> = {}) => task(id, { status: 'done', completedAt: `${day}T12:00:00`, ...over })
const person = (id: string, name: string, over: Partial<Person> = {}): Person => ({ kind: 'person', id, name, color: '#f472b6', group: 'friends', createdAt: STAMP, updatedAt: STAMP, ...over }) as Person
const place = (id: string, name: string, over: Partial<Place> = {}): Place => ({ kind: 'place', id, name, color: '#38bdf8', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP, ...over }) as Place
const meal = (id: string, date: string, over: Partial<Meal> = {}): Meal => ({ kind: 'meal', id, date, slot: 'dinner', title: id, createdAt: STAMP, updatedAt: STAMP, ...over }) as Meal
const entry = (day: string, over: Partial<JournalEntry> = {}): JournalEntry => ({ kind: 'journal', id: `journal~${day}~${over.ownerId ?? 'x'}`, date: day, body: 'words', createdAt: STAMP, updatedAt: STAMP, ...over })
const habit = (id: string, days: string[], over: Partial<Habit> = {}): Habit => ({ kind: 'habit', id, name: id, done: days, createdAt: STAMP, updatedAt: STAMP, ...over }) as Habit
const garment = (id: string, name: string, over: Partial<Garment> = {}): Garment => ({ kind: 'garment', id, name, type: 'top', createdAt: STAMP, updatedAt: STAMP, ...over }) as Garment
const wear = (day: string, ids: string[], over: Partial<Wear> = {}): Wear => ({ kind: 'wear', id: `wear~${day}~${ids.join('+')}`, date: day, garmentIds: ids, createdAt: STAMP, updatedAt: STAMP, ...over })
const recipe = (id: string, name: string): Recipe => ({ kind: 'recipe', id, name, createdAt: STAMP, updatedAt: STAMP }) as Recipe
/** The days from `from` for `n` days. */
const run = (from: string, n: number) => Array.from({ length: n }, (_, i) => localDayKey(new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)) + i)))

const input = (over: Partial<InsightInput> = {}): InsightInput => ({ tasks: [], myId: JOE, now: NOW, today: TODAY, dayKeyOf, ...over })
const cards = (over: Partial<InsightInput> = {}, period: InsightPeriod = 'week', anchor = TODAY): Highlight[] => {
  const i = input(over)
  return pickHighlights(insightFigures(i, periodSpan(period, anchor, i.today)))
}
const card = (list: Highlight[], id: Highlight['id']) => list.find(c => c.id === id)

describe('periods', () => {
  it('reads a week Sunday first, a month and a year on the calendar, and counts one still going up to today', () => {
    expect(periodSpan('week', TODAY, TODAY)).toEqual({ period: 'week', key: '2026-W38', start: '2026-09-20', end: '2026-09-26', last: TODAY, current: true })
    expect(periodSpan('month', TODAY, TODAY)).toMatchObject({ key: '2026-09', start: '2026-09-01', end: '2026-09-30', last: TODAY, current: true })
    expect(periodSpan('year', TODAY, TODAY)).toMatchObject({ key: '2026', start: '2026-01-01', end: '2026-12-31', last: TODAY, current: true })
    // a month gone by is counted whole
    expect(periodSpan('month', '2026-02-10', TODAY)).toMatchObject({ key: '2026-02', start: '2026-02-01', end: '2026-02-28', last: '2026-02-28', current: false })
    // …and one that has not started is not a period with anything in it
    expect(periodSpan('month', '2026-11-02', TODAY).key).toBe('2026-09')
  })

  it('sets a period still going against the same days of the one before, and a finished one against the whole', () => {
    // Sunday to Thursday, against last Sunday to Thursday: never a Monday "down 15"
    expect(comparedSpan(periodSpan('week', TODAY, TODAY), TODAY)).toMatchObject({ start: '2026-09-13', last: '2026-09-17', current: false })
    expect(comparedSpan(periodSpan('month', TODAY, TODAY), TODAY)).toMatchObject({ key: '2026-08', start: '2026-08-01', last: '2026-08-24' })
    expect(comparedSpan(periodSpan('year', TODAY, TODAY), TODAY)).toMatchObject({ key: '2025', last: '2025-09-24' })
    // the 31st of March against a February that is only 28 days long
    expect(comparedSpan(periodSpan('month', '2026-03-31', '2026-03-31'), '2026-03-31')).toMatchObject({ key: '2026-02', last: '2026-02-28' })
    // August, finished, against the whole of July
    expect(comparedSpan(periodSpan('month', '2026-08-05', TODAY), TODAY)).toMatchObject({ key: '2026-07', start: '2026-07-01', last: '2026-07-31' })
    expect(nextSpan(periodSpan('month', '2026-08-05', TODAY), TODAY)?.key).toBe('2026-09')
    expect(nextSpan(periodSpan('month', TODAY, TODAY), TODAY)).toBeNull()
  })

  it('cuts a year still going on the calendar date, as soFarBefore does, whatever a leap day does to the count', () => {
    const cut = (today: string) => comparedSpan(periodSpan('year', today, today), today).last
    // after a leap day: the 1st of March against the 1st of March, not the 2nd
    expect(cut('2028-03-01')).toBe('2027-03-01')
    expect(cut('2028-12-31')).toBe('2027-12-31')
    // the year after one: against its 1st of March, not its 29th of February
    expect(cut('2029-03-01')).toBe('2028-03-01')
    expect(cut('2029-02-28')).toBe('2028-02-28')
    // the leap day itself: against the last day of that February
    expect(cut('2028-02-29')).toBe('2027-02-28')
    // and always the date soFarBefore gives, over four years of days
    for (let d = new Date(Date.UTC(2027, 0, 1)); d < new Date(Date.UTC(2031, 0, 1)); d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10)
      expect(cut(key), key).toBe(soFarBefore(key, 'year').end)
    }
    // a month still going already went by the date; a week by its days
    expect(comparedSpan(periodSpan('month', '2028-03-30', '2028-03-30'), '2028-03-30').last).toBe('2028-02-29')
    expect(comparedSpan(periodSpan('week', '2028-03-01', '2028-03-01'), '2028-03-01')).toMatchObject({ start: '2028-02-20', last: '2028-02-23' })
  })

  it('names a period for the header and inside a sentence', () => {
    const week = periodSpan('week', TODAY, TODAY)
    expect([periodName(week, TODAY), periodPhrase(week, TODAY), previousPhrase(week, TODAY)]).toEqual(['This week', 'this week', 'on last week'])
    const last = periodSpan('week', '2026-09-15', TODAY)
    expect([periodName(last, TODAY), periodPhrase(last, TODAY), previousPhrase(last, TODAY)]).toEqual(['Last week', 'last week', 'on the week before'])
    expect(periodName(periodSpan('week', '2026-08-31', TODAY), TODAY)).toBe('Aug 30 – Sep 5')
    const august = periodSpan('month', '2026-08-01', TODAY)
    expect([periodName(august, TODAY), periodPhrase(august, TODAY), previousPhrase(august, TODAY)]).toEqual(['August', 'in August', 'on July'])
    expect(previousPhrase(periodSpan('month', '2026-01-09', TODAY), TODAY)).toBe('on December 2025')
    expect(periodName(periodSpan('year', '2025-05-05', TODAY), TODAY)).toBe('2025')
    // the line under the name: the days where the name does not say them, and what they are set against
    expect(periodNote(week, TODAY)).toBe('Sep 20 – 26 · against the same days of last week')
    expect(periodNote(last, TODAY)).toBe('Sep 13 – 19 · against the week before')
    expect(periodNote(august, TODAY)).toBe('against July')
    expect(periodNote(periodSpan('month', TODAY, TODAY), TODAY)).toBe('September · against the same days of August')
    expect(periodNote(periodSpan('year', '2025-05-05', TODAY), TODAY)).toBe('against 2024')
  })

  it('reads a period named in a link or a notice, and nothing else', () => {
    expect(parsePeriodKey('2026-09')).toEqual({ period: 'month', anchor: '2026-09-01' })
    expect(parsePeriodKey('2026-W38')).toEqual({ period: 'week', anchor: '2026-09-20' })
    expect(parsePeriodKey('2025')).toEqual({ period: 'year', anchor: '2025-01-01' })
    for (const bad of ['2026-13', '2026-00', '2026-W60', '2026-9', 'constructor', '../2026', '', null, undefined]) expect(parsePeriodKey(bad), String(bad)).toBeNull()
  })

  it('names the recap for the month before the 1st it goes on', () => {
    expect(lastMonthKey('2026-10-01')).toBe('2026-09')
    expect(lastMonthKey('2027-01-01')).toBe('2026-12')
    expect(recapTitle('2026-09')).toBe('Your September in Drafter')
  })

  it('finds a day’s first instant in the reader’s own zone, daylight saving and all', () => {
    const inZone = (tz: string) => {
      const day = dayKeysIn(tz)
      return (iso: string) => day(Date.parse(iso))
    }
    expect(new Date(dayStart('2026-09-24', inZone('America/Phoenix'))).toISOString()).toBe('2026-09-24T07:00:00.000Z')
    // thirteen hours ahead: the day starts the evening before, UTC
    expect(new Date(dayStart('2026-09-24', inZone('Pacific/Tongatapu'))).toISOString()).toBe('2026-09-23T11:00:00.000Z')
    // New York's spring-forward day still starts at its own midnight, EST
    expect(new Date(dayStart('2026-03-08', inZone('America/New_York'))).toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(new Date(dayStart('2026-03-09', inZone('America/New_York'))).toISOString()).toBe('2026-03-09T04:00:00.000Z')
  })
})

describe('the chips and the areas agree', () => {
  it('names the same eight areas, in the same order, as the app’s chips', () => {
    expect(STATS_AREAS.map(a => a.key)).toEqual([...INSIGHT_AREAS])
  })
})

describe('what the highlights count', () => {
  it('makes no card for a figure of nothing, and none at all for a quiet period', () => {
    expect(cards()).toEqual([])
    // last week was busy; this week has nothing done yet, so there is no tasks card to be "down" on
    const list = cards({ tasks: [done('a', '2026-09-14'), done('b', '2026-09-15'), done('c', '2026-09-16')] })
    expect(card(list, 'tasks-done')).toBeUndefined()
    for (const c of cards({ tasks: [done('a', '2026-09-22')], journal: [entry('2026-09-22')] })) expect(c.title, c.id).not.toMatch(/\b0\b/)
  })

  it('counts finished work in the week, against the same days of last week, and names the busiest weekday', () => {
    const tasks = [
      // Tuesday 22nd ×3, Monday 21st, Wednesday 23rd
      done('a', '2026-09-22'),
      done('b', '2026-09-22'),
      done('c', '2026-09-22'),
      done('d', '2026-09-21'),
      done('e', '2026-09-23'),
      // last week: Monday 14th and Friday 18th, which is after the same days, so it is left out
      done('f', '2026-09-14'),
      done('g', '2026-09-18'),
      // a visit is not work, a task in Trash is finished by nobody, and an open task is not done
      done('visit', '2026-09-22', { tags: ['visit'] }),
      done('gone', '2026-09-22', { deletedAt: STAMP }),
      task('open', { dueAt: '2026-09-22T12:00:00' }),
    ]
    const c = card(cards({ tasks }), 'tasks-done')!
    expect(c.title).toBe('5 tasks done this week')
    expect(c.delta).toMatchObject({ by: 4, text: '↑4', than: 'on last week' })
    // the household's work, so the busiest day rather than "your best"
    expect(c.detail).toBe('Tuesday was the busiest day')
    expect(c.line).toBe('5 tasks done this week, ↑4 on last week · Tuesday was the busiest day')
    expect(c.area).toBe('tasks')
    // Sunday to Thursday, a point a day
    expect(c.visual).toEqual({ kind: 'spark', series: [0, 1, 3, 1, 0] })
  })

  it('compares a month and a year the same way, and says a fall plainly', () => {
    const tasks = [done('a', '2026-09-02'), done('b', '2026-08-03'), done('c', '2026-08-10'), done('d', '2026-08-30'), done('e', '2025-03-01')]
    const month = card(cards({ tasks }, 'month'), 'tasks-done')!
    // August's 3rd and 10th are before the 24th; the 30th is not
    expect(month.title).toBe('1 task done this month')
    expect(month.delta).toMatchObject({ by: -1, text: '↓1', than: 'on August' })
    const year = card(cards({ tasks }, 'year'), 'tasks-done')!
    expect(year.title).toBe('4 tasks done this year')
    expect(year.delta).toMatchObject({ by: 3, than: 'on 2025' })
    // a year's sparkline is its months, January to this one
    expect(year.visual).toEqual({ kind: 'spark', series: [0, 0, 0, 0, 0, 0, 0, 3, 1] })
    // August, finished, against the whole of July
    const august = card(cards({ tasks }, 'month', '2026-08-15'), 'tasks-done')!
    expect(august.title).toBe('3 tasks done in August')
    expect(august.delta).toMatchObject({ by: 3, than: 'on July' })
  })

  it('reads a run of days as the rules do, today waiting rather than breaking it', () => {
    const tasks = run('2026-09-18', 7).map((d, i) => done(`t${i}`, d))
    const c = card(cards({ tasks }), 'tasks-streak')!
    expect(c.title).toBe('Something done 7 days in a row')
    expect(c.detail).toBe('your longest yet')
    // nothing today yet: the run to yesterday still stands
    const waiting = card(cards({ tasks: tasks.slice(0, 6) }), 'tasks-streak')!
    expect(waiting.title).toBe('Something done 6 days in a row')
    // …and one that stopped the day before yesterday is over
    expect(card(cards({ tasks: tasks.slice(0, 5) }), 'tasks-streak')).toBeUndefined()
    // a shorter run than the best there has been says what the best is
    const again = [...run('2026-08-01', 9), ...run('2026-09-21', 4)].map((d, i) => done(`r${i}`, d))
    expect(card(cards({ tasks: again }), 'tasks-streak')).toMatchObject({ title: 'Something done 4 days in a row', detail: 'your best is 9' })
  })

  it('says a run of the household’s work is the household’s, in a household, and yours alone', () => {
    const tasks = run('2026-09-18', 7).map((d, i) => done(`t${i}`, d))
    const shared = (list: Task[]) => pickHighlights(insightFigures(input({ tasks: list }), periodSpan('week', TODAY, TODAY)), { household: true })
    expect(card(shared(tasks), 'tasks-streak')?.detail).toBe('the household’s longest yet')
    const again = [...run('2026-08-01', 9), ...run('2026-09-21', 4)].map((d, i) => done(`r${i}`, d))
    expect(card(shared(again), 'tasks-streak')?.detail).toBe('the household’s best is 9')
    // no line about the household's tasks says "your", and the journal, yours alone, still does
    const both = pickHighlights(insightFigures(input({ tasks, journal: run('2026-09-18', 7).map(d => entry(d, { ownerId: JOE })) }), periodSpan('week', TODAY, TODAY)), { household: true })
    for (const c of both.filter(c => c.area === 'tasks')) expect(c.line, c.id).not.toMatch(/\byour?\b/i)
    expect(card(both, 'journal')?.detail).toBe('your longest yet')
  })

  it('adds up what was paid by the app’s one rule: a bill’s own amount, never a payday', () => {
    const tasks = [
      done('rent', '2026-09-01', { title: 'Rent', bill: { kind: 'bill', payee: 'Landlord' }, estimateCost: 1200 }),
      done('power', '2026-09-10', { title: 'Power', bill: { kind: 'bill', payee: 'Power co' }, estimateCost: 90, actualCost: 80.5 }),
      done('wage', '2026-09-15', { title: 'Wage', bill: { kind: 'income', payee: 'Acme' }, estimateCost: 3000 }),
      done('save', '2026-09-16', { title: 'Save', bill: { kind: 'saving' }, estimateCost: 400 }),
      done('lunch', '2026-08-20', { title: 'Lunch', actualCost: 20 }),
    ]
    const c = card(cards({ tasks }, 'month'), 'money')!
    expect(c.title).toBe('Paid $1,280.50 this month')
    expect(c.detail).toBe('Landlord is the biggest')
    expect(c.delta).toMatchObject({ by: 1261, text: '↑$1,261.00', than: 'on August' })
  })

  it('counts who you saw by your own log, and the most often seen', () => {
    const people = [person('marco', 'Tio Marco'), person('ana', 'Ana'), person('gone', 'Gone', { deletedAt: STAMP })]
    const tasks = [
      done('v1', '2026-09-21', { tags: ['visit'], peopleIds: ['marco'], ownerId: JOE }),
      done('v2', '2026-09-23', { tags: ['visit'], peopleIds: ['marco', 'ana'], ownerId: JOE }),
      done('v3', '2026-09-22', { tags: ['visit'], peopleIds: ['gone'], ownerId: JOE }),
    ]
    const c = card(cards({ tasks, people }), 'people')!
    expect(c.title).toBe('You saw 2 people this week')
    expect(c.detail).toBe('most often Tio Marco')
    expect(c.line).toBe('You saw 2 people this week, ↑2 on last week · most often Tio Marco')
    // no picture: a ring of days beside a count of people read as people
    expect(c.visual).toBeUndefined()
  })

  it('counts an event of your own that has happened as seeing whoever was on it', () => {
    const people = [person('mum', 'Mum')]
    const events = [{ kind: 'event', id: 'e1', title: 'Lunch', start: '2026-09-23T13:00:00', end: '2026-09-23T14:00:00', peopleIds: ['mum'], createdAt: STAMP, updatedAt: STAMP, ownerId: JOE } as CalendarEntry]
    expect(card(cards({ people, events }), 'people')?.title).toBe('You saw Mum this week')
  })

  it('counts where you went by outingsAt, and a first time there', () => {
    const places = [place('tb', 'Taco Bell'), place('luna', 'Luna’s'), place('old', 'Old haunt')]
    // an outing is logged as a visit (useLifeActions' logOuting), so none of these is work
    const tasks = [done('o1', '2026-09-21', { placeId: 'luna', tags: ['visit'], ownerId: JOE }), done('o0', '2026-06-01', { placeId: 'tb', tags: ['visit'], ownerId: JOE })]
    const meals = [meal('m1', '2026-09-22', { out: true, placeId: 'tb' }), meal('m2', '2026-09-23', { out: true, placeId: 'tb' })]
    const c = card(cards({ tasks, meals, places }), 'places')!
    expect(c.title).toBe('You went to 2 places this week')
    expect(c.detail).toBe('first time at Luna’s')
  })

  it('splits the meals by how they were had, and never counts one still to come', () => {
    const places = [place('tb', 'Taco Bell'), place('luna', 'Luna’s')]
    const recipes = [recipe('chilli', 'Chilli')]
    const meals = [
      meal('c1', '2026-09-20', { recipeId: 'chilli' }),
      meal('c2', '2026-09-21', { recipeId: 'chilli', slot: 'lunch' }),
      meal('c3', '2026-09-22', { title: 'Soup' }),
      meal('o1', '2026-09-22', { out: true, placeId: 'tb', slot: 'lunch' }),
      meal('o2', '2026-09-23', { out: true, placeId: 'tb' }),
      meal('o3', '2026-09-24', { out: true, placeId: 'luna', slot: 'lunch' }),
      meal('o4', '2026-09-21', { out: true, placeId: 'luna', slot: 'lunch' }),
      meal('b1', '2026-09-23', { out: true, slot: 'lunch' }),
      // Friday's dinner is a plan, not a meal had
      meal('later', '2026-09-25', { recipeId: 'chilli' }),
    ]
    const c = card(cards({ meals, places, recipes }), 'kitchen')!
    expect(c.title).toBe('Out 5 times, cooked 3 this week')
    // a tie goes to the name, A–Z
    expect(c.detail).toBe('Luna’s and Taco Bell twice each')
    expect(c.visual).toEqual({
      kind: 'split',
      parts: [
        { key: 'cooked', label: 'Cooked', value: 3 },
        { key: 'out', label: 'Eaten out', value: 4 },
        { key: 'bought', label: 'Bought', value: 1 },
      ],
    })
  })

  it('leads the journal with its run, and says when it is the longest yet', () => {
    const journal = run('2026-09-16', 9).map(d => entry(d, { ownerId: JOE }))
    const c = card(cards({ journal }), 'journal')!
    expect(c.title).toBe('Journal 9 days in a row')
    expect(c.detail).toBe('your longest yet')
    // a shorter run over an older, longer one
    const older = [...run('2026-08-01', 12), ...run('2026-09-22', 3)].map(d => entry(d, { ownerId: JOE }))
    expect(card(cards({ journal: older }), 'journal')?.detail).toBeUndefined()
    // days written without a run of three, and the mood they carried
    const few = [entry('2026-09-21', { mood: 4, ownerId: JOE }), entry('2026-09-23', { mood: 5, ownerId: JOE })]
    expect(card(cards({ journal: few }), 'journal')).toMatchObject({ title: 'Wrote in the journal on 2 days this week', detail: 'mood 4.5 of 5' })
  })

  it('counts habits on the days they were due, as the Review does', () => {
    const habits = [habit('Read', run('2026-09-10', 15), { ownerId: JOE }), habit('Run', ['2026-09-21'], { ownerId: JOE, days: [1, 3, 5] })]
    const c = card(cards({ habits }), 'habits')!
    // Read: Sun–Thu kept (5 of 5); Run: Mon kept, Wed missed (1 of 2)
    expect(c.title).toBe('Habits kept 86% of the time')
    expect(c.detail).toBe('6 of 7 due days · Read 15 days in a row')
    expect(c.visual).toEqual({ kind: 'ring', value: 6, of: 7, label: '86%' })
  })

  it('names a piece never worn, and the days an outfit was logged', () => {
    const garments = [garment('chinos', 'Grey chinos', { createdAt: '2026-08-01T12:00:00', ownerId: JOE }), garment('tee', 'Blue tee', { ownerId: JOE }), garment('new', 'New coat', { createdAt: '2026-09-23T12:00:00', ownerId: JOE })]
    const wears = [wear('2026-09-21', ['tee'], { ownerId: JOE }), wear('2026-09-22', ['tee'], { ownerId: JOE }), wear('2026-09-23', ['tee'], { ownerId: JOE })]
    const list = cards({ garments, wears })
    // the coat is a day old: not nagged about yet
    expect(card(list, 'wardrobe-never')?.title).toBe('Grey chinos: never worn')
    expect(card(list, 'wardrobe-days')).toMatchObject({ title: 'Outfit logged on 3 days this week', detail: 'most worn: Blue tee, 3 days' })
  })

  it('ranks what is interesting first, and draws at most eight', () => {
    const people = [person('marco', 'Tio Marco')]
    const places = [place('tb', 'Taco Bell')]
    const busy: Partial<InsightInput> = {
      tasks: [
        ...run('2026-09-18', 7).map((d, i) => done(`t${i}`, d, { ownerId: JOE })),
        done('rent', '2026-09-21', { bill: { kind: 'bill', payee: 'Landlord' }, estimateCost: 900, ownerId: JOE }),
        done('v', '2026-09-22', { tags: ['visit'], peopleIds: ['marco'], ownerId: JOE }),
        done('o', '2026-09-22', { placeId: 'tb', tags: ['visit'], ownerId: JOE }),
      ],
      people,
      places,
      meals: [meal('c1', '2026-09-22')],
      journal: run('2026-09-10', 15).map(d => entry(d, { ownerId: JOE })),
      habits: [habit('Read', run('2026-09-18', 7), { ownerId: JOE })],
      garments: [garment('chinos', 'Grey chinos', { ownerId: JOE }), garment('tee', 'Tee', { ownerId: JOE })],
      wears: [wear('2026-09-22', ['tee'], { ownerId: JOE })],
    }
    const list = cards(busy)
    expect(list).toHaveLength(MAX_HIGHLIGHTS)
    // a record run in the journal beats everything
    expect(list[0].id).toBe('journal')
    const scores = list.map(c => c.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
    // one card of each kind, each with its own id
    expect(new Set(list.map(c => c.id)).size).toBe(list.length)
    // the recap reads the first four, most interesting first
    expect(recapLines(list)).toEqual(list.slice(0, 4).map(c => c.line))
  })
})

describe('one view: the household’s tasks, money and meals; your own people, places, journal, habits and clothes', () => {
  // Joe and Maria each finish work, each log visits, and each keep a journal, habits and clothes
  const people = [person('marco', 'Tio Marco'), person('ana', 'Ana'), person('rosa', 'Rosa')]
  const places = [place('luna', 'Luna’s')]
  const household: Partial<InsightInput> = {
    people,
    places,
    tasks: [
      done('joe-visit', '2026-09-21', { tags: ['visit'], peopleIds: ['marco'], ownerId: JOE }),
      done('maria-visit', '2026-09-22', { tags: ['visit'], peopleIds: ['ana', 'rosa'], ownerId: MARIA }),
      done('maria-outing', '2026-09-22', { placeId: 'luna', tags: ['visit'], ownerId: MARIA }),
      done('joe-chore', '2026-09-22', { ownerId: JOE }),
      done('maria-chore', '2026-09-22', { ownerId: MARIA }),
      // filed by Joe, handed to Maria
      done('handed', '2026-09-23', { ownerId: JOE, assigneeId: MARIA }),
      // the rent, which Maria paid
      done('rent', '2026-09-21', { title: 'Rent', bill: { kind: 'bill', payee: 'Landlord' }, estimateCost: 900, ownerId: MARIA }),
    ],
    // Maria's own kinds: records Joe's device should never hold, and would never count if it did
    journal: [...run('2026-09-20', 5).map(d => entry(d, { ownerId: MARIA })), entry('2026-09-22', { ownerId: JOE })],
    habits: [habit('Maria’s walk', run('2026-09-01', 24), { ownerId: MARIA })],
    garments: [garment('dress', 'Red dress', { ownerId: MARIA })],
    wears: [wear('2026-09-21', ['dress'], { ownerId: MARIA }), wear('2026-09-22', ['dress'], { ownerId: MARIA })],
  }
  const as = (myId: string) => cards({ ...household, myId })

  it('counts every member’s finished work and money paid, the same for each of them', () => {
    for (const me of [JOE, MARIA]) {
      const list = as(me)
      // two chores, the task handed to Maria and the rent, whoever did them
      expect(card(list, 'tasks-done')?.line, me).toBe('4 tasks done this week, ↑4 on last week · Tuesday was the busiest day')
      expect(card(list, 'money')?.title, me).toBe('Paid $900.00 this week')
    }
  })

  it('counts only your own visits and outings', () => {
    const joe = as(JOE)
    expect(card(joe, 'people')?.title).toBe('You saw Tio Marco this week')
    // Maria went to Luna’s; Joe did not
    expect(card(joe, 'places')).toBeUndefined()
    const maria = as(MARIA)
    expect(card(maria, 'people')?.title).toBe('You saw 2 people this week')
    expect(card(maria, 'places')?.title).toBe('You went to Luna’s this week')
  })

  it('never counts another member’s journal, habits or clothes', () => {
    const joe = as(JOE)
    // one day of Joe's own, never Maria's run of five
    expect(card(joe, 'journal')?.title).toBe('Wrote in the journal on 1 day this week')
    expect(card(joe, 'habits')).toBeUndefined()
    expect(card(joe, 'wardrobe-days')).toBeUndefined()
    expect(card(joe, 'wardrobe-never')).toBeUndefined()
    // …and each is Maria's own, on her device
    const maria = as(MARIA)
    expect(card(maria, 'journal')?.title).toBe('Journal 5 days in a row')
    expect(card(maria, 'habits')?.title).toBe('Habits kept 100% of the time')
    expect(card(maria, 'wardrobe-days')?.title).toBe('Outfit logged on 2 days this week')
  })

  it('labels no card: no badge to draw, and no prefix in its line', () => {
    for (const c of [...as(JOE), ...as(MARIA)]) {
      expect(c.line, c.id).not.toMatch(/^(Both of us|Just you)/)
      expect(Object.keys(c), c.id).not.toContain('who')
    }
  })

  it('scopes the areas’ own pages by the same rule', () => {
    const scoped = scopeRecords({ ...household, tasks: household.tasks!, myId: JOE })
    // every task the device holds is the household's work
    expect(scoped.work.map(t => t.id)).toEqual(household.tasks!.map(t => t.id))
    // …and only the personal records that are Joe's
    expect(scoped.journal.map(e => e.ownerId)).toEqual([JOE])
    expect([scoped.habits, scoped.garments, scoped.wears]).toEqual([[], [], []])
    // with nobody signed in, every record on the device is its own
    const local = scopeRecords({ ...household, tasks: household.tasks!, myId: null })
    expect(local.journal).toHaveLength(household.journal!.length)
    expect(local.garments).toHaveLength(1)
  })

  it('counts the household’s meals whoever planned them; one kept to herself is on Maria’s device alone', () => {
    const places = [place('luna', 'Luna’s')]
    const ours = meal('ours', '2026-09-22', { out: true, placeId: 'luna', ownerId: MARIA })
    const hers = meal('hers', '2026-09-23', { out: true, placeId: 'luna', ownerId: MARIA, shared: false })
    // Joe's device holds the one she shared with the household; the database keeps the other from it
    expect(card(cards({ meals: [ours], places }), 'kitchen')?.title).toBe('Out once this week')
    expect(card(cards({ meals: [ours, hers], places, myId: MARIA }), 'kitchen')?.title).toBe('Out twice this week')
  })
})

import { describe, expect, it } from 'vitest'
import { stripDayWords, tonight, upNext, weekStrip } from '../homeweek'
import { mealWho } from '../kitchen'
import type { CalendarEvent, Meal, Recipe, Task } from '../types'
import { parseWeather, skyPhrase, todaysForecast } from '../weather'

// Home's top section works out the week strip's days, tonight's dinner and
// what is up next from the lists Home holds. These pin what each counts.

const TODAY = '2026-09-25' // a Friday; the week is Sunday 20 to Saturday 26
const STAMP = '2026-09-01T00:00:00.000Z'
/** A September day at a local hour. */
const at = (d: number, h = 0, m = 0) => new Date(2026, 8, d, h, m).toISOString()
const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [], ...over })
const meal = (date: string, slot: Meal['slot'], over: Partial<Meal> = {}): Meal => ({ kind: 'meal', id: `meal~${date}~${slot}~${over.ownerId ?? 'me'}`, date, slot, title: 'Tacos', createdAt: STAMP, updatedAt: STAMP, ...over })
const ev = (id: string, start: string, end: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({ id, sourceId: 's', title: id, start, end, allDay: false, ...over })
const recipe = (id: string, name: string, emoji?: string): Recipe => ({ kind: 'recipe', id, name, emoji, ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP })

describe('the week strip', () => {
  it('is the week today falls in, Sunday first, as the Kitchen’s strip is', () => {
    expect(weekStrip(TODAY, [], [], []).map(d => d.key)).toEqual(['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'])
  })

  it('counts the tasks due on a day, done or open, and no wishlist, cancelled or deleted one', () => {
    const tasks = [
      task('a', { dueAt: at(21, 9) }),
      task('b', { dueAt: at(21), status: 'done', completedAt: at(21, 8) }),
      task('c', { dueAt: at(21), status: 'wishlist' }),
      task('d', { dueAt: at(21), status: 'canceled' }),
      task('e', { dueAt: at(21), deletedAt: STAMP }),
      task('f', { dueAt: at(28) }),
      task('g'),
    ]
    const days = weekStrip(TODAY, tasks, [], [])
    expect(days.map(d => d.tasks)).toEqual([0, 2, 0, 0, 0, 0, 0])
  })

  it('counts a day’s planned meals by slot, so two plans for one dinner are one', () => {
    const meals = [meal('2026-09-22', 'dinner'), meal('2026-09-22', 'dinner', { ownerId: 'peer' }), meal('2026-09-22', 'lunch'), meal('2026-09-27', 'dinner'), meal('2026-09-23', 'dinner', { deletedAt: STAMP })]
    expect(weekStrip(TODAY, [], meals, []).map(d => d.meals)).toEqual([0, 0, 2, 0, 0, 0, 0])
  })

  it('counts events on each day they cover, and never a work day', () => {
    const events = [
      ev('dentist', at(23, 15, 30), at(23, 16, 30)),
      ev('trip', '2026-09-25', '2026-09-27', { allDay: true }),
      ev('office', at(24, 9), at(24, 17), { work: 'office' }),
    ]
    expect(weekStrip(TODAY, [], [], events).map(d => d.events)).toEqual([0, 0, 0, 1, 0, 1, 1])
  })

  it('says a day aloud', () => {
    expect(stripDayWords({ key: TODAY, tasks: 2, meals: 1, events: 1 })).toBe('2 tasks due, 1 meal planned, 1 event')
    expect(stripDayWords({ key: TODAY, tasks: 0, meals: 0, events: 0 })).toBe('nothing on')
  })
})

describe('tonight’s dinner', () => {
  const recipes = [recipe('tacos', 'Tacos', '🌮')]

  it('is your own plan before one someone shared, with its recipe’s mark', () => {
    const mine = meal(TODAY, 'dinner', { recipeId: 'tacos', ownerId: 'me' })
    const shared = meal(TODAY, 'dinner', { ownerId: 'peer', title: 'Curry', shared: true })
    expect(tonight([shared, mine], recipes, TODAY, 'me')).toMatchObject({ meal: mine, mine: true, mark: '🌮', label: 'Tacos' })
    const theirs = tonight([shared], recipes, TODAY, 'me')
    expect(theirs).toMatchObject({ meal: shared, mine: false, mark: '🍽️' })
    // who planned it, as the Kitchen's day card says it
    expect(mealWho(theirs!.meal, { mine: theirs!.mine, myId: 'me', inHousehold: true, nameOf: () => 'Maria' })).toBe('Maria planned')
  })

  it('says who is cooking, as the Kitchen does', () => {
    const t = tonight([meal(TODAY, 'dinner', { recipeId: 'tacos', ownerId: 'me', shared: true, cookId: 'peer' })], recipes, TODAY, 'me')!
    expect(mealWho(t.meal, { mine: t.mine, myId: 'me', inHousehold: true, nameOf: () => 'Maria' })).toBe('Both of you · Maria cooks')
  })

  it('marks a meal out and Leftovers, and is null with nothing planned', () => {
    expect(tonight([meal(TODAY, 'dinner', { out: true, title: 'Pizza place' })], recipes, TODAY, 'me')?.mark).toBe('🥡')
    expect(tonight([meal(TODAY, 'dinner', { quick: 'leftovers', title: 'Leftovers' })], recipes, TODAY, 'me')?.mark).toBe('🍲')
    expect(tonight([meal(TODAY, 'lunch')], recipes, TODAY, 'me')).toBeNull()
    expect(tonight([], recipes, TODAY, 'me')).toBeNull()
  })
})

describe('up next', () => {
  const now = new Date(2026, 8, 25, 11, 32)
  const next = (events: CalendarEvent[], tasks: Task[] = []) => upNext({ events, tasks, now, todayKey: TODAY, myId: 'me' })

  it('is the next timed thing today, event or task, and never one already begun', () => {
    const events = [ev('Standup', at(25, 9), at(25, 12)), ev('Dentist', at(25, 15, 30), at(25, 16, 30))]
    const tasks = [task('Call the plumber', { dueAt: at(25, 14) }), task('No time', { dueAt: at(25) })]
    expect(next(events, tasks)).toMatchObject({ kind: 'task', title: 'Call the plumber', tomorrow: false })
    expect(next(events)).toMatchObject({ kind: 'event', title: 'Dentist', at: at(25, 15, 30), tomorrow: false })
  })

  it('is tomorrow’s first once today has nothing left', () => {
    const events = [ev('Past', at(25, 8), at(25, 9)), ev('Farmers market', at(26, 9), at(26, 11)), ev('Brunch', at(26, 11), at(26, 12)), ev('Later', at(27, 9), at(27, 10))]
    expect(next(events)).toMatchObject({ title: 'Farmers market', tomorrow: true })
    expect(next([ev('Later', at(27, 9), at(27, 10))])).toBeNull()
  })

  it('leaves out work days, all-day events, another member’s entries and tasks that are someone else’s', () => {
    const events = [
      ev('Office', at(25, 13), at(25, 17), { work: 'office' }),
      ev('Holiday', '2026-09-25', '2026-09-26', { allDay: true }),
      ev('Her yoga', at(25, 13), at(25, 14), { ownerId: 'peer' }),
      ev('Mine', at(25, 18), at(25, 19), { ownerId: 'me' }),
    ]
    const tasks = [task('Hers', { dueAt: at(25, 12), assigneeId: 'peer' }), task('Done', { dueAt: at(25, 12), status: 'done' })]
    expect(next(events, tasks)).toMatchObject({ title: 'Mine' })
  })
})

describe('the greeting’s sky', () => {
  const noonToday = new Date(2026, 8, 25, 12).getTime()
  const cached = (over: Record<string, unknown> = {}) =>
    parseWeather(JSON.stringify({ enabled: true, city: 'phoenix', forecast: { tempC: 84, hiC: 96, loC: 72, rainPct: 0, code: 0, unit: '°F' }, fetchedAt: new Date(2026, 8, 25, 9).getTime(), ...over }))

  it('reads today’s forecast from what the weather card keeps, and nothing when it is off or is another day’s', () => {
    expect(todaysForecast(cached(), noonToday)?.tempC).toBe(84)
    expect(todaysForecast(cached({ enabled: false }), noonToday)).toBeNull()
    expect(todaysForecast(cached({ fetchedAt: new Date(2026, 8, 24, 9).getTime() }), noonToday)).toBeNull()
    expect(todaysForecast(parseWeather(''), noonToday)).toBeNull()
    expect(todaysForecast(parseWeather('not json'), noonToday)).toBeNull()
  })

  it('says it in a few words, sunny by day and clear at night', () => {
    expect(skyPhrase({ tempC: 84, code: 0 }, 9)).toBe('84° and sunny')
    expect(skyPhrase({ tempC: 70, code: 0 }, 21)).toBe('70° and clear')
    expect(skyPhrase({ tempC: 61, code: 63 }, 9)).toBe('61° with rain')
    expect(skyPhrase({ tempC: 12, code: 3 }, 9)).toBe('12° and overcast')
    expect(skyPhrase({ tempC: 5, code: 42 }, 9)).toBe('5°')
  })
})

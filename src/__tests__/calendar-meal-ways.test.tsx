import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Calendar, CalendarView } from '../components/Calendar'
import { kitchenIndex, mealWay, savedPlaces, type MealWay } from '../kitchenstats'
import type { Meal, Person, Place, Recipe } from '../types'

// A meal is one colour wherever a colour is drawn for it. The Calendar's month
// pills and its week list colour each meal by the way Kitchen → Stats counts
// it (mealWay): cooked at home, eaten out at a saved place, or bought, with no
// place named or at one since deleted. A plan, its day still to come, is
// coloured by the way it is planned. The glyphs are as they were: 🥡 for any
// meal out, 🍽️ for one cooked; Leftovers wears its own 🍲. The day sheet lists
// a day's meals once, in its Eating rows, where they are chosen and changed.

const STAMP = '2026-01-01T00:00:00.000Z'
const noop = () => {}
const text = (html: string) => html.replace(/<!-- -->/g, '')
/** Thursday 10 September 2026, local time: its week runs Sunday 6 to Saturday 12. */
const NOW = new Date(2026, 8, 10, 9)
const TODAY = '2026-09-10'

const place = (id: string, name: string, over: Partial<Place> = {}): Place => ({ kind: 'place', id, name, color: '#c0392b', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP, ...over })
const nopi = place('nopi', 'Nopi', { emoji: '🍝' })
const ivy = place('ivy', 'The Ivy', { deletedAt: STAMP })
const PLACES = [nopi, ivy]
const meal = (date: string, slot: Meal['slot'], title: string, over: Partial<Meal> = {}): Meal => ({ kind: 'meal', id: `meal~${date}~${slot}`, date, slot, title, createdAt: STAMP, updatedAt: STAMP, ...over })

const MEALS: Meal[] = [
  // had
  meal('2026-09-06', 'dinner', 'Somewhere', { out: true, placeId: 'never-saved' }),
  meal('2026-09-07', 'dinner', 'Chicken curry', { recipeId: 'curry' }),
  meal('2026-09-08', 'dinner', 'Nopi', { out: true, placeId: 'nopi' }),
  meal('2026-09-09', 'lunch', 'Old Ivy', { out: true, placeId: 'ivy' }),
  meal('2026-09-09', 'dinner', 'Takeaway', { out: true }),
  // still to come: plans
  meal('2026-09-11', 'dinner', 'Nopi again', { out: true, placeId: 'nopi' }),
  meal('2026-09-12', 'lunch', 'Beans on toast'),
  meal('2026-09-12', 'dinner', 'Pizza night', { out: true }),
]

/** Each way's colour, as the Calendar and Kitchen → Stats draw it. */
const WAY: Record<MealWay, string> = { cooked: 'var(--accent-ink)', out: 'var(--cal-meal-out)', bought: 'var(--cal-meal-bought)' }

const render = (view: CalendarView, openDay?: string, meals: Meal[] = MEALS) =>
  text(
    renderToStaticMarkup(
      <Calendar
        view={view}
        tasks={[]}
        projects={[]}
        projectMap={new Map()}
        people={[] as Person[]}
        meals={meals}
        recipes={[]}
        places={PLACES}
        events={[]}
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
        openDay={openDay}
      />,
    ),
  )

/** The week list's rows: each meal's title and the colour of its dot. */
const weekDots = (html: string): Record<string, string> =>
  Object.fromEntries([...html.matchAll(/<span class="cal-item-dot" style="background:([^"]+)"><\/span><span class="cal-item-main"><span class="cal-item-title">([^<]+)<\/span>/g)].map(m => [m[2], m[1]]))
/** The month grid's meal pills: each meal's title, and its outline and its text. */
const monthPills = (html: string): Record<string, [string, string]> =>
  Object.fromEntries([...html.matchAll(/<button class="cal-pill meal" style="border-color:([^;"]+);color:([^"]+)" title="([^"]+)"/g)].map(m => [m[3].split(' · ')[0], [m[1], m[2]]]))
/** The day sheet, from its body to its foot. */
const sheetOf = (html: string) => html.slice(html.indexOf('class="cal-sheet-body"'), html.indexOf('class="cal-sheet-foot"'))
/** The day sheet's rows of meals above its Eating section: the glyph, the meal, and the colour of its dot. */
const sheetRows = (html: string) =>
  [...sheetOf(html).matchAll(/<li class="cal-row"><span class="cal-item-dot" style="background:([^"]+)"><\/span><div class="cal-row-main"><span class="cal-row-title">(\S+) ([^<]+)<\/span>/g)].map(m => [m[2], m[3], m[1]])
/** The day sheet's Eating rows that hold a meal: the slot, its mark and the meal. */
const eatingRows = (html: string) =>
  [...sheetOf(html).matchAll(/aria-label="(Breakfast|Lunch|Dinner) on [^":]+: ([^"]+)"><span class="meal-slot-chosen">(?:<span aria-hidden="true">(\S+) <\/span>)?/g)].map(m => [m[1], m[3] ?? '', m[2]])

const HAD = MEALS.filter(m => m.date <= TODAY)
const PLANS = MEALS.filter(m => m.date > TODAY)
const titles = (meals: Meal[]) => meals.map(m => m.title)

describe('a meal on the Calendar is the colour of the way Kitchen → Stats counts it', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('in the week list: cooked in the accent, eaten out at a saved place in blue, and bought in rose, with no place named or at one since deleted', () => {
    const dots = weekDots(render('week'))
    expect(titles(HAD).map(t => [t, dots[t]])).toEqual([
      ['Somewhere', WAY.bought],
      ['Chicken curry', WAY.cooked],
      ['Nopi', WAY.out],
      ['Old Ivy', WAY.bought],
      ['Takeaway', WAY.bought],
    ])
  })

  it('in the month grid: each meal’s pill outlined and written in its way’s colour', () => {
    const pills = monthPills(render('month'))
    expect(titles(HAD).map(t => [t, pills[t]])).toEqual([
      ['Somewhere', [WAY.bought, WAY.bought]],
      ['Chicken curry', [WAY.cooked, WAY.cooked]],
      ['Nopi', [WAY.out, WAY.out]],
      ['Old Ivy', [WAY.bought, WAY.bought]],
      ['Takeaway', [WAY.bought, WAY.bought]],
    ])
  })

  it('in the day sheet: each meal once, in its Eating rows, and not again in a row above them', () => {
    const html = render('week', '2026-09-09')
    expect(sheetRows(html)).toEqual([])
    // each with the Kitchen's own mark (mealShown): a bought one with no place is 🥡
    expect(eatingRows(html).map(([slot, , t]) => [slot, t])).toEqual([
      ['Lunch', 'Old Ivy'],
      ['Dinner', 'Takeaway'],
    ])
    expect(eatingRows(html)[1][1]).toBe('🥡')
    expect(sheetOf(html).match(/Takeaway/g)).toHaveLength(2) // the row's name for it, and what it says
    expect(eatingRows(render('week', '2026-09-07'))).toEqual([['Dinner', '', 'Chicken curry']])
    // a day with meals and nothing else is not "nothing on this day"
    expect(sheetOf(render('week', '2026-09-07'))).not.toContain('Nothing on this day yet.')
  })

  it('marks Leftovers with its own 🍲, as the Kitchen does, in the colour of a meal cooked at home', () => {
    const quick = [meal(TODAY, 'dinner', 'Leftovers', { quick: 'leftovers' })]
    expect(weekDots(render('week', undefined, quick)).Leftovers).toBe(WAY.cooked)
    expect(eatingRows(render('week', TODAY, quick))).toEqual([['Dinner', '🍲', 'Leftovers']])
  })

  it('colours a plan, its day still to come, by the way it is planned, in the week, the month and the day alike', () => {
    const planned = [
      ['Nopi again', WAY.out],
      ['Beans on toast', WAY.cooked],
      ['Pizza night', WAY.bought],
    ]
    const dots = weekDots(render('week'))
    expect(titles(PLANS).map(t => [t, dots[t]])).toEqual(planned)
    const pills = monthPills(render('month'))
    expect(titles(PLANS).map(t => [t, pills[t][0]])).toEqual(planned)
    // the day's own sheet lists them once, where they are changed
    expect(eatingRows(render('week', '2026-09-12')).map(([slot, , t]) => [slot, t])).toEqual([
      ['Lunch', 'Beans on toast'],
      ['Dinner', 'Pizza night'],
    ])
  })

  it('reads the Kitchen’s own rule, not a copy: every meal Stats counts is the colour of the way it counts it', () => {
    const ix = kitchenIndex([], MEALS, PLACES, NOW)
    const dots = weekDots(render('week'))
    expect(HAD.map(m => dots[m.title])).toEqual(HAD.map(m => WAY[ix.ways.get(m.id)!]))
    // a plan counts nowhere yet, and is mealWay's word for it all the same
    expect(PLANS.map(m => ix.ways.has(m.id))).toEqual([false, false, false])
    const saved = savedPlaces(PLACES)
    expect(MEALS.map(m => dots[m.title])).toEqual(MEALS.map(m => WAY[mealWay(m, saved)]))
  })
})

describe('mealWay', () => {
  it('reads a meal’s way whatever its day: cooked unless out, out at a place still saved, bought otherwise', () => {
    const saved = savedPlaces([nopi, ivy, { kind: 'person', id: 'mum', name: 'Mum' } as unknown as Place])
    // a place in the Trash is not saved, and nor is anything else handed in
    expect([...saved.keys()]).toEqual(['nopi'])
    expect(mealWay({}, saved)).toBe('cooked')
    expect(mealWay({ out: false, placeId: 'nopi' }, saved)).toBe('cooked')
    expect(mealWay({ out: true, placeId: 'nopi' }, saved)).toBe('out')
    expect(mealWay({ out: true }, saved)).toBe('bought')
    expect(mealWay({ out: true, placeId: 'ivy' }, saved)).toBe('bought')
    expect(mealWay({ out: true, placeId: 'mum' }, saved)).toBe('bought')
  })
})

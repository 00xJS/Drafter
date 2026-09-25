// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from './dom'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kitchen } from '../components/Kitchen'
import { MealSlotRow } from '../components/MealSlotRow'
import type { GroceryList, Item, Meal, Place, PlaceCategory, Recipe } from '../types'
import { weekKeyOf, weekStartKey } from '../../shared/weeks.mts'

// Kitchen → This week as a thumb uses it, in a household of two: the open
// day's cards, planned and empty; an idea planning a dinner in one tap, and
// Leftovers last among the ideas; the meal picker's For, Who's cooking, its
// two tabs, Leftovers, search and Remove; the Cooking toggle on a card; and a
// recipe starred — with what each writes.

const T0 = '2026-09-01T12:00:00.000Z'
const JOE = 'joe'
const MARIA = 'maria'
const MEMBERS = [
  { id: JOE, displayName: 'Joe' },
  { id: MARIA, displayName: 'Maria' },
]
const recipe = (id: string, name: string, over: Partial<Recipe> = {}): Recipe => ({ kind: 'recipe', id, name, ingredients: [], tags: [], createdAt: T0, updatedAt: T0, ...over })
const meal = (date: string, slot: Meal['slot'], over: Partial<Meal> = {}): Meal => ({ kind: 'meal', id: `meal~${date}~${slot}~${over.ownerId ?? JOE}`, date, slot, title: 'Meal', createdAt: T0, updatedAt: T0, ...over })
const place = (id: string, name: string, category: PlaceCategory = 'fastfood'): Place => ({ kind: 'place', id, name, category, color: '#c0392b', createdAt: T0, updatedAt: T0 })

const parm = recipe('parm', 'Chicken Parm', { favourite: true })
const stew = recipe('stew', 'Beef Stew')
const spag = recipe('spag', 'Spaghetti', { favourite: true })
const ench = recipe('ench', 'Enchiladas')
const dogs = recipe('dogs', 'Hot Dogs', { steps: ['Grill the dogs'] })
/** The owner's week, as Joe sees it: Thursday 24 September 2026 is today. */
function seed(): Item[] {
  return [
    parm,
    stew,
    spag,
    ench,
    dogs,
    place('cfa', 'Chick-fil-A'),
    meal('2026-09-13', 'dinner', { recipeId: 'parm', title: 'Chicken Parm', shared: true }),
    meal('2026-09-10', 'dinner', { recipeId: 'stew', title: 'Beef Stew', shared: true }),
    meal('2026-09-08', 'dinner', { recipeId: 'spag', title: 'Spaghetti', shared: true }),
    // tonight: Maria's, shared, and she is cooking
    meal('2026-09-24', 'dinner', { recipeId: 'dogs', title: 'Hot Dogs', shared: true, cookId: MARIA, ownerId: MARIA, notes: 'Buns in the freezer' }),
    // her lunch today is her own, under the household-wide id of an older build
    { kind: 'meal', id: 'meal~2026-09-24~lunch', date: '2026-09-24', slot: 'lunch', title: 'CFA NOT COOKING', shared: false, ownerId: MARIA, createdAt: T0, updatedAt: T0 },
  ]
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 24, 18, 30))
  localStorage.setItem('drafter:kitchen-tab', 'week')
})
afterEach(() => {
  vi.useRealTimers()
})

/** The Kitchen over a store of its own, as Joe: what it saves lands, what it clears goes, and each toast is kept with its Undo. */
function openKitchen(items: Item[] = seed()) {
  const toasts: { msg: string; undo?: () => void }[] = []
  const savedMeals: Meal[] = []
  const saved: Item[] = []
  const cleared: string[] = []
  function Shell() {
    const [rows, setRows] = useState<Item[]>(items)
    const put = (item: Item) => setRows(list => [...list.filter(x => x.id !== item.id), item])
    const live = <K extends Item['kind']>(kind: K) => rows.filter((i): i is Extract<Item, { kind: K }> => i.kind === kind && !i.deletedAt)
    // what the store hands the views: a meal someone kept to themselves is not among them
    const meals = live('meal').filter(m => !m.ownerId || m.ownerId === JOE || m.shared !== false)
    return (
      <Kitchen
        myId={JOE}
        nameOf={id => MEMBERS.find(m => m.id === id)?.displayName ?? null}
        inHousehold
        members={MEMBERS}
        recipes={live('recipe')}
        meals={meals}
        groceries={live('grocery') as GroceryList[]}
        places={live('place')}
        onSave={item => {
          saved.push(item)
          put(item)
        }}
        onDelete={() => {}}
        onSaveMeal={m => {
          savedMeals.push(m)
          put(m)
        }}
        onClearMeal={id => {
          cleared.push(id)
          setRows(list => list.map(x => (x.id === id ? { ...x, deletedAt: '2026-09-24T20:00:00.000Z' } : x)))
        }}
        onCreatePlace={(name, category) => {
          const p = place(`p-${name}`, name, category)
          put(p)
          return p
        }}
        onCreateRecipe={name => {
          const r = recipe(`r-${name}`, name)
          put(r)
          return r
        }}
        onToast={(msg, undo) => void toasts.push({ msg, undo })}
      />
    )
  }
  render(<Shell />)
  return { toasts, savedMeals, saved, cleared }
}

/** What an idea chip says for itself, its reason (drawn on a phone, in its name everywhere) left out. */
const chipWords = (b: HTMLElement) =>
  Array.from(b.childNodes)
    .filter(n => !(n instanceof Element && n.classList.contains('meal-chip-why')))
    .map(n => n.textContent)
    .join('')
const strip = () => screen.getByRole('navigation', { name: 'Dinners this week' })
const day = (name: RegExp) => within(strip()).getByRole('button', { name })
const card = (slot: 'Breakfast' | 'Lunch' | 'Dinner') => screen.getByRole('region', { name: slot })
const sheet = (name: RegExp) => screen.getByRole('dialog', { name })

describe('the open day’s cards', () => {
  it('draws tonight’s shared dinner planned — who planned it, who cooks, Start cooking — and the empty meals as places to plan one', () => {
    openKitchen()
    const dinner = card('Dinner')
    expect(within(dinner).getByText('Hot Dogs')).toBeTruthy()
    expect(within(dinner).getByText('Maria planned · Maria cooks')).toBeTruthy()
    expect(within(dinner).getByRole('button', { name: 'Start cooking' })).toBeTruthy()
    expect(within(dinner).getByText('Buns in the freezer')).toBeTruthy()
    expect(within(dinner).getByRole('button', { name: 'Plan my own' })).toBeTruthy()
    // Maria's own meal: nothing of Joe's to change
    expect(within(dinner).queryByRole('button', { name: /Change/ })).toBeNull()
    // her private lunch is nowhere, and the slot is empty for Joe
    expect(screen.queryByText('CFA NOT COOKING')).toBeNull()
    // Leftovers is the last of an empty card's ideas, and there with no idea
    // at all: nothing has been breakfast yet, and the one lunch idea is new
    const offered = { Breakfast: ['🍲 Leftovers'], Lunch: ['Enchiladas', '🍲 Leftovers'] }
    for (const slot of ['Breakfast', 'Lunch'] as const) {
      const empty = card(slot)
      expect(empty.className).toContain('empty')
      expect(within(empty).getByRole('button', { name: 'Choose…' })).toBeTruthy()
      const ideas = within(empty).getByRole('group', { name: `Ideas for ${slot.toLowerCase()}` })
      expect(within(ideas).getAllByRole('button').map(b => chipWords(b).trim())).toEqual(offered[slot])
      // one row of chips, and no other one-tap answers
      expect(within(empty).getAllByRole('group').length).toBe(1)
      expect(within(empty).queryByText(/Fend for yourself|Takeout/)).toBeNull()
    }
    // the week keeps its strip, each day's letter over a dot for every meal planned
    expect(day(/^Thu/).getAttribute('aria-label')).toBe('Thu Hot Dogs, 1 meal planned')
    expect(day(/^Thu/).querySelectorAll('.week-strip-dots > i')).toHaveLength(1)
    expect(day(/^Fri/).getAttribute('aria-label')).toBe('Fri, not planned')
    // and "Plan this week's meals" is one line of its header, with the count
    expect(screen.getByText('2 dinners still to plan')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Plan this week’s meals' })).toBeTruthy()
  })

  it('offers the Favourites rotation’s first three as ideas: ★ ones not had lately, then one never had', () => {
    openKitchen()
    fireEvent.click(day(/^Fri/))
    const ideas = within(card('Dinner')).getByRole('group', { name: 'Ideas for dinner' })
    expect(within(ideas).getAllByRole('button').map(chipWords)).toEqual(['★Spaghetti', '★Chicken Parm', 'Enchiladas', '🍲 Leftovers'])
  })

  it('says why each idea is offered in its name, and on the chip in short where nothing hovers', () => {
    openKitchen()
    fireEvent.click(day(/^Fri/))
    const ideas = within(card('Dinner')).getByRole('group', { name: 'Ideas for dinner' })
    const spag = within(ideas).getByRole('button', { name: 'Spaghetti: A favourite, last had 2 weeks ago' })
    expect(spag.querySelector('.meal-chip-why')?.textContent).toBe('2 weeks ago')
    const ench = within(ideas).getByRole('button', { name: 'Enchiladas: Never had' })
    expect(ench.querySelector('.meal-chip-why')?.textContent).toBe('new')
    // …and still as the pointer's tooltip
    expect(spag.getAttribute('title')).toBe('A favourite, last had 2 weeks ago')
  })

  it('plans a dinner from an idea in one tap, in Joe’s own row and for both of them, and Undo takes it back', () => {
    const k = openKitchen()
    fireEvent.click(day(/^Fri/))
    fireEvent.click(within(within(card('Dinner')).getByRole('group', { name: 'Ideas for dinner' })).getByRole('button', { name: /^Spaghetti:/ }))
    expect(k.savedMeals.at(-1)).toMatchObject({ id: 'meal~2026-09-25~dinner~joe', date: '2026-09-25', slot: 'dinner', recipeId: 'spag', title: 'Spaghetti', shared: true })
    expect(k.toasts.map(t => t.msg)).toEqual(['Planned “Spaghetti” for dinner'])
    // the card is the meal now
    expect(within(card('Dinner')).getByText('Both of you')).toBeTruthy()
    expect(within(card('Dinner')).getByRole('button', { name: 'Change dinner' })).toBeTruthy()
    act(() => k.toasts[0].undo!())
    expect(k.cleared).toEqual(['meal~2026-09-25~dinner~joe'])
    expect(card('Dinner').className).toContain('empty')
  })

  it('answers a lunch with Leftovers in one tap: a meal with nothing to cook, just Joe’s', () => {
    const k = openKitchen()
    fireEvent.click(within(within(card('Lunch')).getByRole('group', { name: 'Ideas for lunch' })).getByRole('button', { name: 'Leftovers' }))
    // today's lunch: Maria's private legacy row under meal~2026-09-24~lunch is not touched
    expect(k.savedMeals.at(-1)).toMatchObject({ id: 'meal~2026-09-24~lunch~joe', slot: 'lunch', quick: 'leftovers', title: 'Leftovers', shared: false })
    expect(k.savedMeals.some(m => m.id === 'meal~2026-09-24~lunch')).toBe(false)
    expect(k.savedMeals.at(-1)).not.toHaveProperty('recipeId')
    expect(within(card('Lunch')).getByText('Nothing to cook · just you')).toBeTruthy()
  })
})

describe('the Kitchen’s switches, to a screen reader', () => {
  it('say which segment and which grocery filter is on', () => {
    const week = weekKeyOf(weekStartKey('2026-09-24')!)!
    openKitchen([...seed(), { kind: 'grocery', id: `grocery~${week}`, weekKey: week, ownerId: JOE, items: [{ id: 'g1', name: 'Milk', state: 'need', recipeIds: [], manual: true }], createdAt: T0, updatedAt: T0 }])
    const view = screen.getByRole('group', { name: 'Kitchen view' })
    const on = (group: HTMLElement) => within(group).getAllByRole('button').filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent)
    expect(on(view)).toEqual(['This week'])
    fireEvent.click(within(view).getByRole('button', { name: 'Grocery' }))
    expect(on(view)).toEqual(['Grocery'])
    const show = screen.getByRole('group', { name: 'Show' })
    expect(on(show)).toEqual(['Need 1'])
    fireEvent.click(within(show).getByRole('button', { name: /^All/ }))
    expect(on(show)).toEqual(['All 1'])
  })
})

describe('the open day under a thumb', () => {
  /** A touch on the day's cards at (x, y), as React reads it: changedTouches. */
  const touch = (type: 'touchstart' | 'touchmove' | 'touchend', x: number, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] })
    act(() => void document.querySelector('.meal-day')!.dispatchEvent(e))
  }
  const open = () => document.querySelector('.meal-day-head strong')?.textContent

  it('turns to the next day on a swipe to the left', () => {
    openKitchen()
    expect(open()).toBe('Thursday')
    touch('touchstart', 300, 400)
    touch('touchmove', 280, 402)
    touch('touchend', 200, 405)
    expect(open()).toBe('Friday')
  })

  it('stays on the day for a scroll down the cards that drifts sideways', () => {
    openKitchen()
    touch('touchstart', 300, 400)
    // committed downward in the first few pixels, then carried well over to the side
    touch('touchmove', 297, 385)
    touch('touchmove', 240, 250)
    touch('touchend', 220, 200)
    expect(open()).toBe('Thursday')
  })
})

describe('Plan this week’s meals, from the week’s header', () => {
  it('plans the dinners it proposes for both of them, as the picker starts a dinner, in Joe’s own rows', () => {
    const k = openKitchen()
    fireEvent.click(screen.getByRole('button', { name: 'Plan this week’s meals' }))
    const plan = sheet(/Plan this week’s meals/)
    fireEvent.click(within(plan).getByRole('button', { name: /^Plan \d meals?$/ }))
    // Saturday's is the week's something new; Friday has nothing cooled down enough to offer
    const planned = k.savedMeals.filter(m => m.date > '2026-09-24')
    expect(planned.map(m => [m.id, m.slot, m.recipeId, m.shared])).toEqual([['meal~2026-09-26~dinner~joe', 'dinner', 'ench', true]])
    expect(k.toasts.at(-1)?.msg).toBe('Planned 1 meal — the grocery list is updated')
  })
})

describe('the meal picker', () => {
  it('opens on For — Just me for a lunch — asks who is cooking only for both of them and a dish, searches recipes and places, and a tap saves', () => {
    const k = openKitchen()
    fireEvent.click(day(/^Fri/))
    fireEvent.click(within(card('Lunch')).getByRole('button', { name: 'Choose…' }))
    const picker = sheet(/Fri 25 · Lunch/)
    const forGroup = within(picker).getByRole('group', { name: 'Who this meal is for' })
    expect(within(forGroup).getByRole('button', { name: 'Just me' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(picker).queryByRole('group', { name: 'Who’s cooking' })).toBeNull()
    fireEvent.click(within(forGroup).getByRole('button', { name: 'Both of us' }))
    const cooking = within(picker).getByRole('group', { name: 'Who’s cooking' })
    // nobody yet: neither is pressed
    expect(within(cooking).getAllByRole('button').map(b => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['JJoe', 'false'],
      ['MMaria', 'false'],
    ])
    fireEvent.click(within(cooking).getByRole('button', { name: 'Maria' }))
    expect(within(cooking).getByRole('button', { name: 'Maria' }).getAttribute('aria-pressed')).toBe('true')
    // a meal out is nobody's to cook: the question goes with the tab
    fireEvent.click(within(picker).getByRole('tab', { name: 'Eat out' }))
    expect(within(picker).queryByRole('group', { name: 'Who’s cooking' })).toBeNull()
    expect(within(picker).getByRole('button', { name: /^Chick-fil-A/ })).toBeTruthy()
    fireEvent.click(within(picker).getByRole('tab', { name: 'Cook' }))
    // the Cook list: the rotation's order — ★ ones not had lately, longest
    // since first; then never had; then the rest — each with when it was last had
    const list = within(picker).getByRole('list', { name: 'Recipes' })
    const rows = [...list.querySelectorAll('.meal-pick-row:not(.new):not(.leftovers)')].map(b => [b.querySelector('.meal-pick-name')?.textContent, b.querySelector('.meal-pick-when')?.textContent])
    expect(rows).toEqual([
      ['Spaghetti', '2 weeks ago'],
      ['Chicken Parm', '11 days ago'],
      ['Enchiladas', 'never had'],
      ['Beef Stew', '2 weeks ago'],
      // on the plan this week: offered last, and said when
      ['Hot Dogs', 'on Thu'],
    ])
    // one search over recipes and places
    fireEvent.change(within(picker).getByRole('searchbox', { name: 'Search recipes and places' }), { target: { value: 'chi' } })
    expect(within(picker).getByRole('region', { name: 'Recipes that match' }).textContent).toContain('Chicken Parm')
    expect(within(picker).getByRole('region', { name: 'Places that match' }).textContent).toContain('Chick-fil-A')
    fireEvent.click(within(within(picker).getByRole('region', { name: 'Recipes that match' })).getByRole('button', { name: /^Chicken Parm/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(k.savedMeals.at(-1)).toMatchObject({ id: 'meal~2026-09-25~lunch~joe', recipeId: 'parm', shared: true, cookId: MARIA })
    expect(within(card('Lunch')).getByText('Both of you · Maria cooks')).toBeTruthy()
  })

  it('keeps a planned meal’s own For, changes it there and then, and Remove takes the meal off with an Undo', () => {
    const k = openKitchen()
    fireEvent.click(day(/^Fri/))
    fireEvent.click(within(within(card('Dinner')).getByRole('group', { name: 'Ideas for dinner' })).getByRole('button', { name: /^Enchiladas:/ }))
    fireEvent.click(within(card('Dinner')).getByRole('button', { name: 'Change dinner' }))
    const picker = sheet(/Fri 25 · Dinner/)
    const forGroup = within(picker).getByRole('group', { name: 'Who this meal is for' })
    expect(within(forGroup).getByRole('button', { name: 'Both of us' }).getAttribute('aria-pressed')).toBe('true')
    // the meal's choice is ticked where it stands
    expect(within(picker).getByRole('button', { name: /^Enchiladas/, pressed: true })).toBeTruthy()
    fireEvent.click(within(forGroup).getByRole('button', { name: 'Just me' }))
    expect(k.savedMeals.at(-1)).toMatchObject({ id: 'meal~2026-09-25~dinner~joe', shared: false })
    expect(screen.getByRole('dialog')).toBeTruthy()
    const remove = within(picker).getByRole('button', { name: 'Remove Enchiladas' })
    fireEvent.click(remove)
    fireEvent.click(within(picker).getByRole('button', { name: 'Remove Enchiladas: Tap again to remove' }))
    expect(k.cleared).toEqual(['meal~2026-09-25~dinner~joe'])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(k.toasts.at(-1)?.msg).toBe('Removed “Enchiladas” from dinner')
    act(() => k.toasts.at(-1)!.undo!())
    expect(k.savedMeals.at(-1)).toMatchObject({ id: 'meal~2026-09-25~dinner~joe', recipeId: 'ench', shared: false })
  })

  it('plans a meal of Joe’s own beside the one Maria shared, for him alone', () => {
    const k = openKitchen()
    fireEvent.click(within(card('Dinner')).getByRole('button', { name: 'Plan my own' }))
    const picker = sheet(/Thu 24 · Dinner/)
    expect(within(within(picker).getByRole('group', { name: 'Who this meal is for' })).getByRole('button', { name: 'Just me' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(within(picker).getByRole('list', { name: 'Recipes' })).getByRole('button', { name: /^Leftovers/ }))
    expect(k.savedMeals.at(-1)).toMatchObject({ id: 'meal~2026-09-24~dinner~joe', quick: 'leftovers', title: 'Leftovers', shared: false })
    expect(k.savedMeals.at(-1)).not.toHaveProperty('out')
    // his is the card now, with nothing to cook, and hers is named under it
    expect(within(card('Dinner')).getByText('Leftovers')).toBeTruthy()
    expect(within(card('Dinner')).getByText('Nothing to cook · just you')).toBeTruthy()
    expect(within(card('Dinner')).getByText(/Maria: Hot Dogs/)).toBeTruthy()
  })

  it('has two tabs, Cook and Eat out, with Leftovers the Cook list’s first row after Something new…, and a search for it finds it', () => {
    const k = openKitchen()
    fireEvent.click(day(/^Fri/))
    fireEvent.click(within(card('Dinner')).getByRole('button', { name: 'Choose…' }))
    const picker = sheet(/Fri 25 · Dinner/)
    // no Quick tab
    expect(within(within(picker).getByRole('tablist', { name: 'What kind of meal' })).getAllByRole('tab').map(t => t.textContent)).toEqual(['Cook', 'Eat out'])
    expect(within(picker).queryByRole('tab', { name: 'Quick' })).toBeNull()
    const search = within(picker).getByRole('searchbox', { name: 'Search recipes and places' })
    expect(search.getAttribute('placeholder')).toBe('Search recipes and places')
    // Something new…, then Leftovers with what it means, then the rotation
    const rows = [...within(picker).getByRole('list', { name: 'Recipes' }).querySelectorAll<HTMLElement>('.meal-pick-row')]
    expect(rows.slice(0, 3).map(r => r.querySelector('.meal-pick-name')?.firstChild?.textContent)).toEqual(['Something new…', 'Leftovers', 'Spaghetti'])
    expect(rows[1].querySelector('.meal-pick-mark')?.textContent).toBe('🍲')
    expect(within(rows[1]).getByText('At home, nothing new to cook')).toBeTruthy()
    expect(rows[1].getAttribute('aria-pressed')).toBe('false')
    // a search for "left" finds it among what to cook
    fireEvent.change(search, { target: { value: 'left' } })
    const cook = within(picker).getByRole('region', { name: 'Recipes that match' })
    fireEvent.click(within(cook).getByRole('button', { name: /^Leftovers/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // a dinner, so for both of them, and nobody cooks it
    expect(k.savedMeals.at(-1)).toMatchObject({ id: 'meal~2026-09-25~dinner~joe', quick: 'leftovers', title: 'Leftovers', shared: true })
    expect(k.savedMeals.at(-1)).not.toHaveProperty('cookId')
    expect(within(card('Dinner')).getByText('Nothing to cook · both of you')).toBeTruthy()
    // opened again, it is on Cook, ticked
    fireEvent.click(within(card('Dinner')).getByRole('button', { name: 'Change dinner' }))
    const again = sheet(/Fri 25 · Dinner/)
    expect(within(again).getByRole('tab', { name: 'Cook' }).getAttribute('aria-selected')).toBe('true')
    expect(within(again).getByRole('button', { name: /^Leftovers/, pressed: true })).toBeTruthy()
  })
})

describe('the Cooking toggle on a card', () => {
  it('hands a shared dish to whoever is tapped, and the one cooking tapped again is nobody', () => {
    const k = openKitchen()
    const cooking = within(card('Dinner')).getByRole('group', { name: 'Who’s cooking Hot Dogs' })
    expect(within(cooking).getByRole('button', { name: 'Maria' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(cooking).getByRole('button', { name: 'Joe' }))
    // Maria's row, shared, so Joe may say he is cooking it
    expect(k.savedMeals.at(-1)).toMatchObject({ id: 'meal~2026-09-24~dinner~maria', cookId: JOE })
    expect(within(card('Dinner')).getByText('Maria planned · you cook')).toBeTruthy()
    fireEvent.click(within(within(card('Dinner')).getByRole('group', { name: 'Who’s cooking Hot Dogs' })).getByRole('button', { name: 'Joe' }))
    expect(k.savedMeals.at(-1)).not.toHaveProperty('cookId')
    expect(within(card('Dinner')).getByText('Maria planned')).toBeTruthy()
  })
})

describe('starring a recipe', () => {
  it('stars one on Recipes and in the picker’s Cook list, and moves it up the rotation', () => {
    const k = openKitchen()
    fireEvent.click(screen.getByRole('button', { name: 'Recipes' }))
    const star = screen.getByRole('button', { name: 'Favourite: Beef Stew' })
    expect(star.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(star)
    expect(k.saved.at(-1)).toMatchObject({ id: 'stew', favourite: true })
    expect(screen.getByRole('button', { name: 'Favourite: Beef Stew' }).getAttribute('aria-pressed')).toBe('true')
    // …in the picker too, which now offers it among the ★ ones
    fireEvent.click(screen.getByRole('button', { name: 'This week' }))
    fireEvent.click(day(/^Fri/))
    const ideas = within(card('Dinner')).getByRole('group', { name: 'Ideas for dinner' })
    expect(within(ideas).getAllByRole('button').map(chipWords)).toEqual(['★Spaghetti', '★Beef Stew', '★Chicken Parm', '🍲 Leftovers'])
    fireEvent.click(within(card('Dinner')).getByRole('button', { name: 'Choose…' }))
    const picker = sheet(/Fri 25 · Dinner/)
    fireEvent.click(within(picker).getByRole('button', { name: 'Favourite: Chicken Parm' }))
    expect(k.saved.at(-1)).toMatchObject({ id: 'parm' })
    expect(k.saved.at(-1)).not.toHaveProperty('favourite')
  })
})

describe('the slot row, as the calendar’s day sheet draws it', () => {
  it('opens the same picker in place of the old dropdown, and writes Joe’s own row whatever legacy row of hers is there', () => {
    const onSave = vi.fn()
    const onClear = vi.fn()
    const hers = seed().find(i => i.id === 'meal~2026-09-24~lunch') as Meal
    render(
      <MealSlotRow
        date="2026-09-24"
        slot="lunch"
        // what a stale cache could hand it: her private lunch as the slot's row
        meal={hers}
        myId={JOE}
        inHousehold
        members={MEMBERS}
        recipes={[parm, stew]}
        places={[place('cfa', 'Chick-fil-A')]}
        onSave={onSave}
        onClear={onClear}
        onCreatePlace={() => place('x', 'X')}
      />,
    )
    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Lunch on Thursday, September 24:/ }))
    const picker = sheet(/Thu 24 · Lunch/)
    // it is not his to change, so the sheet is for a new meal of his, and has nothing to remove
    expect(within(picker).queryByRole('button', { name: /^Remove/ })).toBeNull()
    fireEvent.click(within(picker).getByRole('tab', { name: 'Eat out' }))
    fireEvent.click(within(picker).getByRole('button', { name: /^Chick-fil-A/ }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ id: 'meal~2026-09-24~lunch~joe', out: true, placeId: 'cfa', title: 'Chick-fil-A', shared: false })
    expect(onClear).not.toHaveBeenCalled()
  })
})

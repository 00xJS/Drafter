// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Calendar } from '../components/Calendar'
import type { Meal, Person, Place, Recipe } from '../types'

// The week's + on a day, then Meal: it used to open the day sheet, where the
// dinner was one more row and one more tap down. It opens the meal picker on
// that day's dinner now, the same sheet the day's own row opens.

const STAMP = '2026-01-01T00:00:00.000Z'
const noop = () => {}
const tacos: Recipe = { kind: 'recipe', id: 'tacos', name: 'Tacos', ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP }
const nopi: Place = { kind: 'place', id: 'nopi', name: 'Nopi', color: '#c0392b', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // Thursday 10 September 2026: its week runs Sunday 6 to Saturday 12
  vi.setSystemTime(new Date(2026, 8, 10, 9))
})
afterEach(() => {
  vi.useRealTimers()
})

function open(meals: Meal[] = []) {
  const onSaveMeal = vi.fn<(m: Meal) => void>()
  render(
    <Calendar
      view="week"
      tasks={[]}
      projects={[]}
      projectMap={new Map()}
      people={[] as Person[]}
      meals={meals}
      recipes={[tacos]}
      places={[nopi]}
      events={[]}
      sourceMap={new Map()}
      onOpen={noop}
      onNew={noop}
      onSaveMeal={onSaveMeal}
      onClearMeal={noop}
      onCreatePlace={() => nopi}
      onCreateRecipe={() => tacos}
      onNewEvent={noop}
      onEditEvent={noop}
      onReschedule={noop}
      onPlan={noop}
      onAttendance={noop}
      onOpenProject={noop}
      onPlanOccasion={noop}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /^Add to Friday, September 11/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: '🍽️ Meal' }))
  return onSaveMeal
}

describe('+ → Meal on a day of the week', () => {
  it('opens the meal picker on that day’s dinner, not the day sheet', () => {
    open()
    expect(screen.getByRole('dialog', { name: 'Fri 11 · Dinner' })).toBeTruthy()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('plans the dinner picked, on that day, and closes', () => {
    const onSaveMeal = open()
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Fri 11 · Dinner' })).getByRole('button', { name: /^Tacos/ }))
    expect(onSaveMeal).toHaveBeenCalled()
    expect(onSaveMeal.mock.calls[0][0]).toMatchObject({ date: '2026-09-11', slot: 'dinner', recipeId: 'tacos' })
    expect(screen.queryByRole('dialog', { name: 'Fri 11 · Dinner' })).toBeNull()
  })

  it('opens on the dinner already planned, to change it', () => {
    open([{ kind: 'meal', id: 'meal~2026-09-11~dinner', date: '2026-09-11', slot: 'dinner', title: 'Tacos', recipeId: 'tacos', createdAt: STAMP, updatedAt: STAMP }])
    const picker = screen.getByRole('dialog', { name: 'Fri 11 · Dinner' })
    expect(within(picker).getByRole('button', { name: /Remove/ })).toBeTruthy()
  })
})

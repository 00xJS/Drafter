// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from './dom'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Item, Meal, Recipe, Task } from '../types'

// A cook task handed to someone else in the task editor. The meal says who
// cooks, and the planner keeps an open cook task with its meal's cook
// (useCookTaskSync), so a hand-over made on the task alone snapped straight
// back on the next render. It goes to the meal as well now, and the two agree.

// the editor's chunk, as a stand-in whose buttons save the task as the editor would
vi.mock('../components/planner/lazy', () => {
  const none = () => null
  const TaskEditor = ({ task, onSave, onCommit }: { task: Task; onSave(t: Task): void; onCommit(t: Task): void }) => (
    <>
      <button type="button" onClick={() => onSave({ ...task, assigneeId: 'maria', assignedBy: 'joe' })}>
        Save, handed to Maria
      </button>
      <button type="button" onClick={() => onSave({ ...task, assigneeId: undefined })}>
        Save, handed to nobody
      </button>
      <button type="button" onClick={() => onCommit({ ...task, assigneeId: 'maria' })}>
        Duplicate, handed to Maria
      </button>
    </>
  )
  return {
    AskSheet: none,
    AttendancePicker: none,
    EventEditor: none,
    ImHereSheet: none,
    NoticesSheet: none,
    PlanDaySheet: none,
    ProjectEditor: none,
    RhythmSheet: none,
    Search: none,
    ShutdownSheet: none,
    TaskEditor,
    Trash: none,
    WeekPlanSheet: none,
  }
})

import { Overlays } from '../components/planner/Overlays'
import type { PlannerCtx } from '../components/planner/ctx'
import { useCookTaskSync } from '../components/planner/useCookTaskSync'
import { cookTaskFor, cookTaskId, mealForCookHandOver } from '../kitchen'

const JOE = 'joe'
const MARIA = 'maria'
const STAMP = '2026-09-24T12:00:00.000Z'
const noop = () => {}
const dogs: Recipe = { kind: 'recipe', id: 'dogs', name: 'Hot Dogs', ingredients: [], tags: [], steps: ['Grill the dogs'], createdAt: STAMP, updatedAt: STAMP }
/** Tonight's dinner, for both of them, and Joe cooking. */
const dinner: Meal = { kind: 'meal', id: `meal~2026-09-24~dinner~${JOE}`, date: '2026-09-24', slot: 'dinner', recipeId: 'dogs', title: 'Hot Dogs', shared: true, cookId: JOE, ownerId: JOE, createdAt: STAMP, updatedAt: STAMP }
const cook: Task = { ...cookTaskFor(dinner, STAMP, [dogs]), ownerId: JOE }

/** The task editor over the planner's own save paths and its cook-task sync, on a store of its own. */
function openEditor(items: Item[] = [dogs, dinner, cook]) {
  const seen = { items }
  function Shell() {
    const [rows, setRows] = useState<Item[]>(items)
    seen.items = rows
    const upsert = (item: Item) => setRows(list => [...list.filter(x => x.id !== item.id), item])
    const live = <K extends Item['kind']>(kind: K) => rows.filter((i): i is Extract<Item, { kind: K }> => i.kind === kind && !i.deletedAt)
    const store = { loaded: true, tasks: live('task'), meals: live('meal'), recipes: live('recipe'), projects: [], people: [], places: [], upsert }
    useCookTaskSync(store)
    const [editor, setEditor] = useState<{ task: Task } | null>({ task: cook })
    const p = {
      store,
      upsert,
      remove: noop,
      restore: noop,
      purge: async () => true,
      household: { myId: JOE, info: { members: [{ id: JOE, displayName: 'Joe' }, { id: MARIA, displayName: 'Maria' }] } },
      inHousehold: true,
      showToast: noop,
      editor,
      setEditor,
      closeLinkedIssue: noop,
      pushToProjectBoard: noop,
      deleteTask: noop,
    } as unknown as PlannerCtx
    return <Overlays p={p} />
  }
  render(<Shell />)
  const task = () => seen.items.find(i => i.id === cook.id) as Task
  const meal = () => seen.items.find(i => i.id === dinner.id) as Meal
  return { task, meal }
}

describe('a cook task handed to someone else in the task editor', () => {
  it('stays with them: the meal’s cook goes with it, so the sync agrees rather than handing it back', async () => {
    const { task, meal } = openEditor()
    expect(task().assigneeId).toBe(JOE)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save, handed to Maria' })))
    expect(task().assigneeId).toBe(MARIA)
    expect(meal().cookId).toBe(MARIA)
  })

  it('taken off everyone, leaves the meal with nobody cooking, and stays that way', async () => {
    const { task, meal } = openEditor()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save, handed to nobody' })))
    expect(task().assigneeId).toBeUndefined()
    expect(meal()).not.toHaveProperty('cookId')
  })

  it('goes with the task when the editor writes it on the way to a copy', async () => {
    const { task, meal } = openEditor()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Duplicate, handed to Maria' })))
    expect(task().assigneeId).toBe(MARIA)
    expect(meal().cookId).toBe(MARIA)
  })
})

describe('what a hand-over writes to the meal (mealForCookHandOver)', () => {
  const handed = { ...cook, assigneeId: MARIA }

  it('the meal with its new cook, only when the cook task changed hands', () => {
    expect(mealForCookHandOver(cook, handed, [dinner])).toMatchObject({ id: dinner.id, cookId: MARIA })
    // nothing changed hands, or the meal says so already
    expect(mealForCookHandOver(cook, { ...cook, title: 'Cook dinner: Hot Dogs!' }, [dinner])).toBeNull()
    expect(mealForCookHandOver(cook, handed, [{ ...dinner, cookId: MARIA }])).toBeNull()
    // a task being added, or one that is not a cook task
    expect(mealForCookHandOver(undefined, handed, [dinner])).toBeNull()
    expect(mealForCookHandOver({ ...cook, id: 'task~x' }, { ...handed, id: 'task~x' }, [dinner])).toBeNull()
  })

  it('never for a meal with no cook for the household: kept to yourself, eaten out, Leftovers, or gone', () => {
    for (const m of [{ ...dinner, shared: false }, { ...dinner, out: true }, { ...dinner, quick: 'leftovers' as const }, { ...dinner, deletedAt: STAMP }]) {
      expect(mealForCookHandOver(cook, handed, [m])).toBeNull()
    }
    expect(cookTaskId(dinner.id)).toBe(cook.id)
  })
})

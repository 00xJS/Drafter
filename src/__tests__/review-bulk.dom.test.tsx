// @vitest-environment happy-dom
import { fireEvent, render, screen } from './dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The review's two bulk buttons on Slipped & overdue. Push all to Monday used
// to write Monday 9:00 onto every task with no Undo and no word to GitHub;
// Back to Wishlist moved each task on its own, so Undo took back only the
// last. Both go through the planner's own moves now, with one Undo for all.

const board = vi.hoisted(() => ({ pushes: [] as string[] }))
vi.mock('../githubboard', async importOriginal => ({
  ...(await importOriginal<typeof import('../githubboard')>()),
  queueProjectPush: (t: { id: string }) => void board.pushes.push(t.id),
}))

import { Review, nextMonday } from '../components/Review'
import { useTaskActions } from '../components/planner/useTaskActions'
import type { Store } from '../store'
import type { Project, Task, TaskStatus } from '../types'

const STAMP = '2026-09-01T00:00:00.000Z'
const noop = () => {}
const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [], ...over })
const home: Project = { kind: 'project', id: 'home', name: 'Home', color: '#f97316', status: 'active', createdAt: STAMP, updatedAt: STAMP }

beforeEach(() => {
  board.pushes = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the review’s bulk buttons', () => {
  it('hand every overdue task to one move each: the day’s defer to Monday, and one status change', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // Thursday 17 September 2026
    vi.setSystemTime(new Date(2026, 8, 17, 12))
    const onDeferAll = vi.fn()
    const onStatusAll = vi.fn()
    const onStatus = vi.fn()
    const late = [task('fence', { title: 'Fix the fence', dueAt: new Date(2026, 8, 14, 18).toISOString() }), task('gutters', { title: 'Clear the gutters', dueAt: new Date(2026, 8, 15).toISOString() })]
    render(
      <Review tasks={late} projects={[]} people={[]} reviews={[]} journal={[]} places={[]} habits={[]} onSaveReview={noop} onOpen={noop} onStatus={onStatus} onDeferAll={onDeferAll} onStatusAll={onStatusAll} onNew={noop} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Push all to Monday' }))
    expect(onDeferAll).toHaveBeenCalledTimes(1)
    const [ids, day] = onDeferAll.mock.calls[0] as [string[], Date]
    expect([...ids].sort()).toEqual(['fence', 'gutters'])
    expect([day.getFullYear(), day.getMonth(), day.getDate(), day.getDay()]).toEqual([2026, 8, 21, 1])
    fireEvent.click(screen.getByRole('button', { name: 'Back to Wishlist' }))
    expect(onStatusAll).toHaveBeenCalledTimes(1)
    expect([...(onStatusAll.mock.calls[0][0] as string[])].sort()).toEqual(['fence', 'gutters'])
    expect(onStatusAll.mock.calls[0][1]).toBe('wishlist')
    expect(onStatus).not.toHaveBeenCalled()
  })

  it('call a Monday the next one, never the day it is', () => {
    expect(nextMonday(new Date(2026, 8, 21, 8)).getDate()).toBe(28)
    expect(nextMonday(new Date(2026, 8, 20, 23)).getDate()).toBe(21)
  })
})

/** The planner's task moves over a store that keeps its tasks in a list, with every toast and its Undo kept. */
function planner(tasks: Task[]) {
  const toasts: { message: string; undo?: () => void }[] = []
  const store = {
    tasks,
    projects: [home],
    people: [],
    allItems: tasks,
    loaded: true,
    upsert: (t: Task) => {
      const i = tasks.findIndex(x => x.id === t.id)
      if (i >= 0) tasks[i] = t
      else tasks.push(t)
    },
    remove: noop,
    setStatus: (id: string, status: TaskStatus) => {
      const i = tasks.findIndex(x => x.id === id)
      if (i < 0) return null
      const prev = tasks[i]
      const next = { ...prev, status, updatedAt: '2026-09-17T00:00:00.000Z' }
      tasks[i] = next
      return { prev, next }
    },
  } as unknown as Store
  let actions: ReturnType<typeof useTaskActions> | undefined
  function Probe() {
    actions = useTaskActions({ store, showToast: (message, undo) => void toasts.push({ message, undo }), setEditor: noop, setProjectEditor: noop, setNotesProjectId: noop })
    return null
  }
  renderToStaticMarkup(<Probe />)
  return { toasts, actions: actions! }
}

describe('the moves behind them', () => {
  const linked = { projectId: 'home', githubUrl: 'https://github.com/o/r/issues/1' }

  it('Push all to Monday keeps each task’s time, tells the board, and one Undo puts every one back', () => {
    const tasks = [task('fence', { dueAt: new Date(2026, 8, 14, 18, 30).toISOString(), ...linked }), task('gutters', { dueAt: new Date(2026, 8, 15).toISOString(), status: 'wishlist' })]
    const was = tasks.map(t => ({ ...t }))
    const { toasts, actions } = planner(tasks)
    actions.deferAll(['fence', 'gutters'], new Date(2026, 8, 21, 12))
    expect(tasks[0].dueAt).toBe(new Date(2026, 8, 21, 18, 30).toISOString())
    // a day with no time stays a day with no time
    expect(tasks[1].dueAt).toBe(new Date(2026, 8, 21).toISOString())
    expect(tasks[1].status).toBe('todo')
    expect(board.pushes).toContain('fence')
    expect(toasts).toHaveLength(1)
    toasts[0].undo!()
    expect(tasks.map(t => [t.dueAt, t.status])).toEqual(was.map(t => [t.dueAt, t.status]))
  })

  it('Back to Wishlist is one status change, with one toast and one Undo for all of them', () => {
    const tasks = [task('fence', { status: 'todo', ...linked }), task('gutters', { status: 'doing' })]
    const { toasts, actions } = planner(tasks)
    actions.changeStatusAll(['fence', 'gutters'], 'wishlist')
    expect(tasks.map(t => t.status)).toEqual(['wishlist', 'wishlist'])
    expect(toasts.map(t => t.message)).toEqual(['Moved 2 to Wishlist'])
    expect(board.pushes).toContain('fence')
    toasts[0].undo!()
    expect(tasks.map(t => t.status)).toEqual(['todo', 'doing'])
  })
})

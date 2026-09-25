// @vitest-environment happy-dom
import { fireEvent, render, screen } from './dom'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Tasks as a tab: its four segments over one list of tasks. Tapped again,
// the Finance segment goes back to the pay periods, the way a tab tapped
// again goes back to its top; Manage used to stay up until its ‹ Back.

// the segments' own chunks, straight: Finance is the one under test here
vi.mock('../components/planner/lazy', async () => ({
  Finance: (await import('../components/Finance')).Finance,
  TasksTable: () => null,
  Board: () => null,
  NotesView: () => null,
}))

import { TASKS_NOTE_KEY, TasksScreen } from '../components/planner/TasksScreen'
import type { PlannerCtx } from '../components/planner/ctx'
import type { TasksTab } from '../components/planner/routes'

const noop = () => {}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 23, 12))
})
afterEach(() => {
  vi.useRealTimers()
})

/** Tasks over an empty planner, with the segment it is on held as the shell holds it. */
function Shell({ start }: { start: TasksTab }) {
  const [tasksTab, setTasksTab] = useState<TasksTab>(start)
  const p = {
    store: { visibleItems: [], tasks: [], accounts: [], notes: [], projects: [] },
    upsert: noop,
    remove: noop,
    restore: noop,
    household: { info: null, myId: null },
    projectMap: new Map(),
    inHousehold: false,
    tasksTab,
    setTasksTab,
    notesProjectId: null,
    setNotesProjectId: noop,
    setTrashOpen: noop,
    noteOpenId: null,
    setNoteOpenId: noop,
    financeCheckIn: false,
    setFinanceCheckIn: noop,
    financeBill: false,
    setFinanceBill: noop,
    taskShown: null,
    setTaskShown: noop,
    openTask: noop,
    newTask: noop,
    deleteTask: noop,
    changeStatus: noop,
    applyStatus: () => null,
    showToast: noop,
  } as unknown as PlannerCtx
  return <TasksScreen p={p} />
}

const segment = (name: string) => screen.getByRole('tab', { name })
const inManage = () => !!screen.queryByRole('tablist', { name: 'Manage' })

describe('the Finance segment, tapped again', () => {
  it('leaves Manage for the pay periods', () => {
    render(<Shell start="bills" />)
    expect(inManage()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    expect(inManage()).toBe(true)
    fireEvent.click(segment('Finance'))
    expect(inManage()).toBe(false)
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy()
  })

  it('does nothing to the periods it is already on', () => {
    render(<Shell start="bills" />)
    fireEvent.click(segment('Finance'))
    expect(inManage()).toBe(false)
    expect(segment('Finance').getAttribute('aria-selected')).toBe('true')
  })
})

describe('the line that says what Tasks is', () => {
  const line = () => screen.queryByText(/^The day is on Home\./)

  it('is said on this device’s first visit, and not on the next', () => {
    const first = render(<Shell start="list" />)
    expect(line()).toBeTruthy()
    expect(localStorage.getItem(TASKS_NOTE_KEY)).toBe('1')
    first.unmount()
    render(<Shell start="list" />)
    expect(line()).toBeNull()
  })

  it('is never said over Finance', () => {
    render(<Shell start="bills" />)
    expect(line()).toBeNull()
  })
})

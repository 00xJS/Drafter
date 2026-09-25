// @vitest-environment happy-dom
import { fireEvent, render, screen } from './dom'
import { describe, expect, it, vi } from 'vitest'
import { TaskEditor } from '../components/TaskEditor'
import { TasksTable } from '../components/TasksTable'
import { addedLine } from '../components/planner/Overlays'
import type { Task } from '../types'

// Writing down something already finished, from Tasks → List. It read as the
// main new-task action, its sheet was titled New task, its toast said Added,
// and the Open filter the list starts on hid the row it had just saved.

const STAMP = '2026-09-01T00:00:00.000Z'
const noop = () => {}
const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [], ...over })
const mowed = task('mow', { title: 'Mow the lawn', status: 'done', completedAt: '2026-09-24T17:00:00.000Z' })
const fence = task('fence', { title: 'Fix the fence' })
const statusFilter = () => (screen.getByRole('combobox', { name: 'Filter by status' }) as HTMLSelectElement).value

describe('✓ Log a finished task', () => {
  it('is a quiet button beside the list, and opens the editor on a task done now', () => {
    const onNew = vi.fn()
    render(<TasksTable tasks={[fence]} onOpen={noop} onNew={onNew} onDelete={noop} />)
    const log = screen.getByRole('button', { name: '✓ Log a finished task' })
    expect(log.className.split(' ')).toContain('subtle')
    fireEvent.click(log)
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(onNew.mock.calls[0][0]).toMatchObject({ status: 'done' })
    expect(typeof onNew.mock.calls[0][0].completedAt).toBe('string')
  })

  it('opens a sheet of its own: Log something done, when it was done first, and none of the due chips', () => {
    render(
      <TaskEditor
        preset={{ status: 'done', completedAt: new Date(2026, 8, 24, 17).toISOString() }}
        projects={[]}
        people={[]}
        members={[]}
        candidates={[]}
        getLatest={() => undefined}
        onSave={noop}
        onCommit={noop}
        onDelete={noop}
        onClose={noop}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'Log something done' })).toBeTruthy()
    const labels = Array.from(document.querySelectorAll('.field > span')).map(s => s.textContent)
    expect(labels.indexOf('Completed')).toBeGreaterThan(-1)
    expect(labels.indexOf('Completed')).toBeLessThan(labels.indexOf('Due'))
    expect(screen.queryByRole('button', { name: 'Today 6pm' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Next Monday' })).toBeNull()
  })

  it('an ordinary new task keeps its own title and its chips', () => {
    render(<TaskEditor projects={[]} people={[]} members={[]} candidates={[]} getLatest={() => undefined} onSave={noop} onCommit={noop} onDelete={noop} onClose={noop} />)
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Today 6pm' })).toBeTruthy()
  })

  it('says Logged … as done, with Show, where a new task says Added', () => {
    expect(addedLine(mowed)).toEqual({ msg: 'Logged “Mow the lawn” as done', logged: true })
    expect(addedLine(fence)).toEqual({ msg: 'Added “Fix the fence”', logged: false })
  })
})

describe('Show, on the list that is up', () => {
  it('moves the filter to Done and brings the row up, once', () => {
    const onRevealed = vi.fn()
    const { rerender } = render(<TasksTable tasks={[fence, mowed]} onOpen={noop} onNew={noop} onDelete={noop} />)
    expect(statusFilter()).toBe('open')
    expect(screen.queryByText('Mow the lawn')).toBeNull()
    rerender(<TasksTable tasks={[fence, mowed]} onOpen={noop} onNew={noop} onDelete={noop} reveal="mow" onRevealed={onRevealed} />)
    expect(statusFilter()).toBe('done')
    expect(screen.getByText('Mow the lawn')).toBeTruthy()
    expect(document.getElementById('task-row-mow')).toBeTruthy()
    expect(onRevealed).toHaveBeenCalledTimes(1)
  })

  it('does the same for a list that opens on it', () => {
    const onRevealed = vi.fn()
    render(<TasksTable tasks={[fence, mowed]} onOpen={noop} onNew={noop} onDelete={noop} reveal="mow" onRevealed={onRevealed} />)
    expect(statusFilter()).toBe('done')
    expect(screen.getByText('Mow the lawn')).toBeTruthy()
    expect(onRevealed).toHaveBeenCalledTimes(1)
  })
})

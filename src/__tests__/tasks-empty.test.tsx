import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TasksEmpty, TasksTable } from '../components/TasksTable'
import type { Store } from '../store'
import { Task } from '../types'

// The Tasks list used to say "No tasks match." for every empty list — a
// search that found nothing and a day with everything done read the same, and
// the only way back to the finished tasks was the status dropdown.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const T0 = '2026-09-01T09:00:00.000Z'
const noop = () => {}
const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: `Task ${id}`, description: '', status: 'todo', priority: 'normal', tags: [], createdAt: T0, updatedAt: T0, ...over })

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The list as it first opens (the Open filter, no search). It asks matchMedia for its phone layout; node has none, so this is the desktop table. */
function list(tasks: Task[]): string {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
  return renderToStaticMarkup(<TasksTable store={{} as Store} tasks={tasks} onOpen={noop} onNew={noop} onDelete={noop} onOpenTrash={noop} trashCount={0} />)
}

const empty = (over: Partial<Parameters<typeof TasksEmpty>[0]> = {}) =>
  renderToStaticMarkup(<TasksEmpty query="" status="open" hiddenByStatus={false} noTasks={false} onNew={noop} onShowAll={noop} {...over} />)

/** The buttons in an element tree, by their text — enough to press one without a DOM. */
function buttons(node: ReactNode, out = new Map<string, () => void>()): Map<string, () => void> {
  const text = (n: ReactNode): string => (Array.isArray(n) ? n.map(text).join('') : typeof n === 'string' ? n : '')
  if (Array.isArray(node)) for (const n of node) buttons(n, out)
  else if (isValidElement(node)) {
    const { children, onClick } = node.props as { children?: ReactNode; onClick?: () => void }
    if (node.type === 'button' && onClick) out.set(text(children), onClick)
    else buttons(children, out)
  }
  return out
}

describe('the Tasks list says why it is empty', () => {
  it('everything done: nothing open here, with + New task and the way back to every status', () => {
    const html = list([task('1', { status: 'done' }), task('2', { status: 'canceled' })])
    expect(html).toContain('Nothing open here — nice.')
    expect(html).toContain('+ New task')
    expect(html).toContain('Show all statuses')
    expect(html).not.toContain('No tasks match')
  })

  it('rows to show: no empty state at all', () => {
    const html = list([task('1'), task('2', { status: 'done' })])
    expect(html).toContain('Task 1')
    expect(html).not.toMatch(/Nothing open here|No tasks|Show all statuses/)
  })

  it('no tasks at all: says so, with nothing to widen', () => {
    const html = list([])
    expect(html).toContain('No tasks yet.')
    expect(html).toContain('+ New task')
    expect(html).not.toContain('Show all statuses')
  })

  it('a search that found nothing says what was searched for', () => {
    const html = empty({ query: 'paint' })
    expect(html).toContain('No tasks match “paint”.')
    expect(html).toContain('+ New task')
    expect(html).not.toContain('Show all statuses')
    // the search is the reason even when the status filter hides tasks too
    expect(empty({ query: 'paint', hiddenByStatus: true })).not.toMatch(/Nothing open|Show all statuses/)
  })

  it('a single status that is empty is named', () => {
    const html = empty({ status: 'blocked', hiddenByStatus: true })
    expect(html).toContain('Nothing in Blocked.')
    expect(html).toContain('Show all statuses')
  })

  it('what the priority filter left out keeps the plain line, with no status to widen', () => {
    const html = empty()
    expect(html).toContain('No tasks match.')
    expect(html).not.toContain('Show all statuses')
  })

  it('Show all statuses widens the list to every status; + New task starts a blank one', () => {
    const onShowAll = vi.fn()
    const onNew = vi.fn()
    const pressed = buttons(TasksEmpty({ query: '', status: 'open', hiddenByStatus: true, noTasks: false, onNew, onShowAll }))
    expect([...pressed.keys()]).toEqual(['+ New task', 'Show all statuses'])
    pressed.get('Show all statuses')!()
    expect(onShowAll).toHaveBeenCalledOnce()
    expect(onNew).not.toHaveBeenCalled()
    pressed.get('+ New task')!()
    expect(onNew).toHaveBeenCalledOnce()
    // and the list hands it the filter's own setter
    expect(read('../components/TasksTable.tsx')).toContain("onShowAll={() => setStatus('all')}")
  })
})

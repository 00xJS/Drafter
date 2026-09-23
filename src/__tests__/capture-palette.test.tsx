import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapturedFields } from '../capture'

// The model's reading is set per test; the offline half of the capture is the real one.
const model = vi.hoisted(() => ({ parse: vi.fn() }))
vi.mock('../ai', async importOriginal => ({ ...(await importOriginal<typeof import('../ai')>()), parseCapture: model.parse }))

import { useTaskActions } from '../components/planner/useTaskActions'
import type { Store } from '../store'
import { inInbox } from '../taskutils'
import { Person, Project, Task } from '../types'
import { fmtDateTime } from '../utils'

/*
 * The palette's Shift+Enter, end to end through captureTask: what lands in the
 * store and what the toasts say. A capture used to be matched against the
 * active projects, so the one project there is filed it under LIFE — "Filed
 * under LIFE" — and it dropped out of the Inbox.
 */

const T0 = '2026-09-01T09:00:00.000Z'
const LIFE: Project = { kind: 'project', id: 'p-life', name: 'LIFE', emoji: '🌱', color: '#f97316', status: 'active', createdAt: T0, updatedAt: T0 }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
/**
 * The model's reading comes through a dynamic import of ai.ts (kept out of the
 * shell): wait until it is asked, then for its answer. The first import is
 * compiled on the spot, which on a busy machine takes more than a second.
 */
const settle = async () => {
  await vi.waitFor(() => expect(model.parse).toHaveBeenCalled(), { timeout: 10_000 })
  await flush()
}

/** A store with LIFE in it, and captureTask as the shell hands it out. */
function setup(people: Person[] = []) {
  const tasks: Task[] = []
  const toasts: string[] = []
  const store = {
    tasks,
    projects: [LIFE],
    people,
    loaded: true,
    upsert: (t: Task) => {
      const i = tasks.findIndex(x => x.id === t.id)
      if (i >= 0) tasks[i] = t
      else tasks.push(t)
    },
    remove: () => {},
  } as unknown as Store
  let actions: ReturnType<typeof useTaskActions> | undefined
  function Probe() {
    actions = useTaskActions({ store, showToast: msg => void toasts.push(msg), setEditor: () => {}, setProjectEditor: () => {}, setNotesProjectId: () => {} })
    return null
  }
  renderToStaticMarkup(<Probe />)
  return { tasks, toasts, capture: (line: string) => actions!.captureTask(line) }
}

beforeEach(() => {
  model.parse.mockReset()
})

describe('Shift+Enter: a capture waits in the Inbox, never under the project', () => {
  it('lands in the Inbox and stays there once the model’s reading is merged', async () => {
    model.parse.mockResolvedValue({ title: 'Paint the fence', tags: ['garden'] } satisfies CapturedFields)
    const { tasks, toasts, capture } = setup()
    capture('paint the fence')
    expect(toasts).toEqual(['Captured to Inbox'])
    await settle()
    expect(tasks).toHaveLength(1)
    // the model adds to the task; the title stays as it was typed
    expect(tasks[0]).toMatchObject({ title: 'paint the fence', tags: ['garden'] })
    expect('projectId' in tasks[0]).toBe(false)
    expect(inInbox(tasks[0])).toBe(true)
    // nothing moved it, so nothing more is said
    expect(toasts).toEqual(['Captured to Inbox'])
  })

  it('does not tell the model the project’s name, and ignores one it offers anyway', async () => {
    model.parse.mockResolvedValue({ title: 'Paint the fence', projectName: 'LIFE' } as CapturedFields)
    const { tasks, toasts, capture } = setup()
    capture('paint the fence')
    await settle()
    expect(model.parse).toHaveBeenCalledTimes(1)
    const ctx = model.parse.mock.calls[0][1] as Record<string, unknown>
    expect(ctx).not.toHaveProperty('projectNames')
    expect(JSON.stringify(ctx)).not.toContain('LIFE')
    expect(tasks[0].projectId).toBeUndefined()
    expect(inInbox(tasks[0])).toBe(true)
    expect(toasts.filter(t => /Filed under/.test(t))).toEqual([])
  })

  it('says so, with its own undo, when the model finds a date', async () => {
    const due = new Date(2026, 8, 20, 9).toISOString()
    model.parse.mockResolvedValue({ title: 'Paint the fence', dueAt: due } satisfies CapturedFields)
    const { tasks, toasts, capture } = setup()
    capture('paint the fence next weekend')
    await settle()
    expect(tasks[0].dueAt).toBe(due)
    expect(inInbox(tasks[0])).toBe(false)
    expect(toasts).toEqual(['Captured to Inbox', `Due ${fmtDateTime(due)}`])
  })

  it('a line that names a day is due at once, not in the Inbox', () => {
    model.parse.mockReturnValue(new Promise(() => {}))
    const { tasks, toasts, capture } = setup()
    capture('call the plumber tomorrow at 3pm')
    expect(tasks[0].dueAt).toBeDefined()
    expect(inInbox(tasks[0])).toBe(false)
    expect(toasts[0]).toMatch(/^Captured — due /)
  })
})

describe('Shift+Enter: what the model may change, and when it is asked at all', () => {
  const SAM: Person = { kind: 'person', id: 'p-sam', name: 'Sam Ortiz', color: '#f97316', group: 'friends', createdAt: T0, updatedAt: T0 }

  it('never rewords the title it filed: the model adds to a task, it does not rename it unseen', async () => {
    model.parse.mockResolvedValue({ title: 'Buy tickets', tags: ['events'], priority: 'high' } satisfies CapturedFields)
    const { tasks, capture } = setup()
    capture('buy 2 tickets for the show, urgent')
    await settle()
    expect(tasks[0]).toMatchObject({ title: 'buy 2 tickets for the show, urgent', tags: ['events'], priority: 'high' })
  })

  it('asks the model nothing when the date is found and nothing else is there to read', async () => {
    // loaded first, so a call it did make would have landed by the next tick
    await import('../ai')
    const { tasks, toasts, capture } = setup([SAM])
    capture('water the plants tomorrow at 8am')
    await flush()
    await flush()
    expect(model.parse).not.toHaveBeenCalled()
    expect(tasks[0].title).toBe('water the plants')
    expect(toasts).toHaveLength(1)
  })

  it('still asks when a dated line names someone, a priority or a repeat, or when no date was found', async () => {
    model.parse.mockResolvedValue({ title: 'x' } satisfies CapturedFields)
    for (const line of ['lunch with sam tomorrow at 1pm', 'pay the rent tomorrow, urgent!', 'bins out every friday', 'paint the fence next weekend']) {
      model.parse.mockClear()
      setup([SAM]).capture(line)
      await settle()
      expect(model.parse, line).toHaveBeenCalledTimes(1)
    }
  })
})

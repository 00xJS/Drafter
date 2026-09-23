// @vitest-environment happy-dom
import { fireEvent, render, screen } from './dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskEditor } from '../components/TaskEditor'
import type { Project, Task } from '../types'

// The task editor's save, typed into and pressed as a person would: what Save
// writes and onto which copy, when a new task is thrown away instead, the
// keys that save, and what closing asks. The rules underneath are in
// taskform.test.ts; this is the editor holding to them.

const OPENED = '2026-09-01T09:00:00.000Z'
const LATER = '2026-09-01T10:00:00.000Z'
const home = { kind: 'project', id: 'pr1', name: 'Home', color: '#f97316', status: 'active' } as Project

const saved = (over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: 't1',
  title: 'Fix the gate',
  description: 'Hinges are loose.',
  status: 'todo',
  priority: 'normal',
  createdAt: OPENED,
  updatedAt: OPENED,
  tags: [],
  ...over,
})

type EditorProps = Parameters<typeof TaskEditor>[0]

/** The editor with every callback recorded; `latest` is what the store holds now. */
function open(over: Partial<EditorProps> = {}, latest?: Task) {
  const calls = { save: vi.fn(), commit: vi.fn(), close: vi.fn(), discard: vi.fn(), delete: vi.fn() }
  render(
    <TaskEditor
      projects={[home]}
      people={[]}
      members={[]}
      candidates={[]}
      getLatest={() => latest}
      onSave={calls.save}
      onCommit={calls.commit}
      onClose={calls.close}
      onDiscard={calls.discard}
      onDelete={calls.delete}
      {...over}
    />,
  )
  return calls
}

const title = () => screen.getByRole('textbox', { name: 'Title' })
const typeInto = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } })

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The browser's "Discard your changes?", answering `yes`. */
const confirmAnswers = (yes: boolean) => {
  const confirm = vi.fn(() => yes)
  vi.stubGlobal('confirm', confirm)
  return confirm
}

describe('Save', () => {
  it('writes what was changed onto the freshest copy, keeping what another device changed meanwhile', () => {
    const task = saved()
    // while the editor was open, the other phone raised the priority and added a tag
    const calls = open({ task }, { ...task, priority: 'high', tags: ['garden'], updatedAt: LATER })
    typeInto(title(), 'Fix the side gate')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.save).toHaveBeenCalledTimes(1)
    const written = calls.save.mock.calls[0][0] as Task
    expect(written).toMatchObject({ id: 't1', title: 'Fix the side gate', priority: 'high', tags: ['garden'] })
    expect(Date.parse(written.updatedAt)).toBeGreaterThan(Date.parse(LATER))
  })

  it('throws a brand-new task away when nothing was written in it, and says so rather than saving "Untitled"', () => {
    const calls = open()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.save).not.toHaveBeenCalled()
    expect(calls.discard).toHaveBeenCalledTimes(1)
    expect(calls.close).toHaveBeenCalledTimes(1)
  })

  it('saves a new task from its title with Enter', () => {
    const calls = open()
    typeInto(title(), 'Book the electrician')
    fireEvent.keyDown(title(), { key: 'Enter' })
    expect(calls.save).toHaveBeenCalledTimes(1)
    expect(calls.save.mock.calls[0][0]).toMatchObject({ title: 'Book the electrician', status: 'todo', shared: false })
  })

  it('saves with ⌘↩ from any field but the comment box, where ⌘↩ adds the comment instead', () => {
    const calls = open({ task: saved() })
    const comment = screen.getByRole('textbox', { name: 'Add a comment' })
    typeInto(comment, 'Called Dave')
    fireEvent.keyDown(comment, { key: 'Enter', metaKey: true })
    expect(calls.save).not.toHaveBeenCalled()
    // a saved task's comment is written at once, onto the freshest copy
    expect(calls.commit).toHaveBeenCalledTimes(1)
    expect((calls.commit.mock.calls[0][0] as Task).comments?.map(c => c.body)).toEqual(['Called Dave'])
    fireEvent.keyDown(screen.getByPlaceholderText(/What needs to happen/), { key: 'Enter', metaKey: true })
    expect(calls.save).toHaveBeenCalledTimes(1)
  })

  it('writes a step renamed and not yet left before it saves, so the rename is not lost', () => {
    const task = saved({ checklist: [{ id: 's1', text: 'Buy hinges', done: false }] })
    const calls = open({ task }, task)
    typeInto(screen.getByRole('textbox', { name: 'Step' }), 'Buy brass hinges')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.commit).toHaveBeenCalledTimes(1)
    expect((calls.commit.mock.calls[0][0] as Task).checklist?.[0].text).toBe('Buy brass hinges')
    expect(calls.save).toHaveBeenCalledTimes(1)
    expect((calls.save.mock.calls[0][0] as Task).checklist?.[0].text).toBe('Buy brass hinges')
    expect(calls.commit.mock.invocationCallOrder[0]).toBeLessThan(calls.save.mock.invocationCallOrder[0])
  })
})

describe('closing', () => {
  it('asks before throwing away a change, and keeps the editor open on No', () => {
    const confirm = confirmAnswers(false)
    const calls = open({ task: saved() })
    typeInto(title(), 'Fix the side gate')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(confirm).toHaveBeenCalledWith('Discard your changes?')
    expect(calls.close).not.toHaveBeenCalled()
    confirmAnswers(true)
    fireEvent.keyDown(title(), { key: 'Escape' })
    expect(calls.close).toHaveBeenCalledTimes(1)
    expect(calls.save).not.toHaveBeenCalled()
  })

  it('closes at once with nothing changed', () => {
    const confirm = confirmAnswers(false)
    const calls = open({ task: saved() })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(confirm).not.toHaveBeenCalled()
    expect(calls.close).toHaveBeenCalledTimes(1)
  })
})

describe('the foot of a saved task', () => {
  it('shows the ⌘↩ hint, marked so a phone can hide it, and names no project', () => {
    open({ task: saved({ projectId: 'pr1' }) })
    const hint = screen.getByText('⌘↩ to save')
    expect(hint.className).toBe('muted task-foot-note')
    expect(document.querySelectorAll('.task-foot-note')).toHaveLength(1)
    // one ongoing project: "in Home" said the same on every task
    expect(document.body.textContent).not.toMatch(/\bin Home\b/)
  })
})

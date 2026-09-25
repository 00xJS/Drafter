// @vitest-environment happy-dom
import { fireEvent, render, screen } from './dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskEditor } from '../components/TaskEditor'
import { localMidnightIso } from '../../shared/domain.mts'
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
  const question = () => screen.queryByRole('alertdialog', { name: 'Discard changes?' })

  it('asks before throwing away a change, in the app, and keeps the editor open on Keep editing', () => {
    const confirm = confirmAnswers(true)
    const calls = open({ task: saved() })
    typeInto(title(), 'Fix the side gate')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(question()).toBeTruthy()
    expect(confirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(calls.close).not.toHaveBeenCalled()
    expect(title()).toHaveProperty('value', 'Fix the side gate')
    fireEvent.keyDown(title(), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(calls.close).toHaveBeenCalledTimes(1)
    expect(calls.save).not.toHaveBeenCalled()
  })

  it('closes at once with nothing changed', () => {
    const confirm = confirmAnswers(false)
    const calls = open({ task: saved() })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(confirm).not.toHaveBeenCalled()
    expect(question()).toBeNull()
    expect(calls.close).toHaveBeenCalledTimes(1)
  })

  it('still writes a step renamed and not yet left when a change is discarded', () => {
    const task = saved({ checklist: [{ id: 's1', text: 'Buy hinges', done: false }] })
    const calls = open({ task }, task)
    typeInto(title(), 'Fix the side gate')
    typeInto(screen.getByRole('textbox', { name: 'Step' }), 'Buy brass hinges')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect((calls.commit.mock.calls[0][0] as Task).checklist?.[0].text).toBe('Buy brass hinges')
    expect(calls.save).not.toHaveBeenCalled()
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

describe('money in the editor', () => {
  const payday = (over: Partial<Task> = {}) =>
    saved({ id: 'pay', title: 'Joe’s pay', description: '', bill: { kind: 'income' }, estimateCost: 2450, recurrence: { freq: 'biweekly' }, shared: true, ...over })
  const dateField = (name: string) => screen.getByLabelText(name) as HTMLInputElement

  it('asks a payday for a day, not a time, and saves the day picked as local midnight', () => {
    const calls = open({ task: payday() })
    const field = dateField('Next payday')
    // on an iPhone a date-and-time field picked for its date alone can hold no value at all
    expect(field.type).toBe('date')
    expect(field.value).toBe('')
    expect(screen.getByText('Add a date so Finance can count it.')).toBeTruthy()
    // the chips that are times of day are for chores
    expect(screen.queryByRole('button', { name: 'Today 18:00' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tomorrow 09:00' })).toBeNull()
    typeInto(field, '2026-09-25')
    expect(screen.queryByText('Add a date so Finance can count it.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.save).toHaveBeenCalledTimes(1)
    const written = calls.save.mock.calls[0][0] as Task
    expect(written.dueAt).toBe(localMidnightIso('2026-09-25'))
    expect(written.dueAt).toBe(new Date(2026, 8, 25).toISOString())
    expect(written).toMatchObject({ bill: { kind: 'income' }, estimateCost: 2450, recurrence: { freq: 'biweekly' } })
  })

  it('shows a saved day as it is, and keeps it through a save that does not touch it', () => {
    const dueAt = new Date(2026, 8, 30).toISOString()
    const calls = open({ task: saved({ id: 'rent', title: 'Rent', bill: { kind: 'bill' }, estimateCost: 1850, recurrence: { freq: 'monthly' }, dueAt }) })
    expect(dateField('Next due').value).toBe('2026-09-30')
    typeInto(title(), 'Rent, flat 2')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((calls.save.mock.calls[0][0] as Task).dueAt).toBe(dueAt)
  })

  it('clears the day and picks today from the chips a day needs', () => {
    const calls = open({ task: saved({ id: 'rent', title: 'Rent', bill: { kind: 'bill' }, estimateCost: 1850, dueAt: new Date(2026, 8, 30).toISOString() }) })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(dateField('Next due').value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    const today = new Date()
    expect(dateField('Next due').value).toBe(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((calls.save.mock.calls[0][0] as Task).dueAt).toBe(new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString())
  })

  it('keeps a date and a time for an ordinary task', () => {
    open({ task: saved({ dueAt: new Date(2026, 8, 30, 18, 0).toISOString() }) })
    const due = document.querySelector('input[type="datetime-local"]') as HTMLInputElement
    expect(due.value).toBe('2026-09-30T18:00')
    expect(document.querySelector('input[type="date"]')).toBeNull()
    // (its chips sit inside its label, which happy-dom lends the buttons' names: found by their words)
    expect(screen.getByText('Today 18:00').tagName).toBe('BUTTON')
    expect(screen.queryByText('Add a date so Finance can count it.')).toBeNull()
  })

  it('has one amount for a payday, what it takes home, and says what arrived only once one has', () => {
    open({ task: payday({ dueAt: new Date(2026, 8, 25).toISOString() }) })
    expect((screen.getByLabelText('Take-home pay') as HTMLInputElement).value).toBe('2450')
    // never a second figure beside it that reads as before and after tax
    expect(screen.queryByLabelText('Arrived this time')).toBeNull()
    expect(screen.queryByText(/Amount paid in|Actually received/)).toBeNull()
  })

  it('asks a done payday what arrived that time, and shows the take-home pay until something else is typed', () => {
    const calls = open({ task: payday({ status: 'done', completedAt: new Date(2026, 8, 25, 9).toISOString(), dueAt: new Date(2026, 8, 25).toISOString() }) })
    const arrived = screen.getByLabelText('Arrived this time') as HTMLInputElement
    expect(arrived.value).toBe('')
    expect(arrived.placeholder).toBe('2450')
    typeInto(arrived, '2391.50')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.save.mock.calls[0][0]).toMatchObject({ estimateCost: 2450, actualCost: 2391.5 })
  })

  it('keeps a bill’s two amounts', () => {
    open({ task: saved({ id: 'rent', title: 'Rent', bill: { kind: 'bill' }, estimateCost: 1850, dueAt: new Date(2026, 8, 30).toISOString() }) })
    expect(screen.getByLabelText('Amount due')).toBeTruthy()
    expect(screen.getByLabelText('Paid')).toBeTruthy()
  })

  it('keeps a set-aside’s two amounts, and its day', () => {
    open({ task: saved({ id: 'fund', title: 'Fund', bill: { kind: 'saving' }, estimateCost: 100, dueAt: new Date(2026, 8, 30).toISOString() }) })
    expect(screen.getByLabelText('Set aside each time')).toBeTruthy()
    expect(screen.getByLabelText('Actually set aside')).toBeTruthy()
    expect(screen.getByLabelText('Next due')).toBeTruthy()
  })
})

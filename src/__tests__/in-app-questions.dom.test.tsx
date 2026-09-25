// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The four questions the browser used to ask, asked in the app instead. The
// browser's prompt() and confirm() are system alerts in the iPhone app, naming
// the page's address — and under iOS 27 they wait behind its Safe Browsing
// check. no-system-dialogs.test.ts holds that none is left anywhere in src;
// these hold what each one became.

const disconnects: string[] = []
vi.mock('../calendars', async importOriginal => ({
  ...(await importOriginal<typeof import('../calendars')>()),
  googleAction: async (action: string) => {
    disconnects.push(action)
    return {}
  },
}))

import { ProjectEditor } from '../components/ProjectEditor'
import { RichNotes } from '../components/RichNotes'
import { GoogleCalendar } from '../components/settings/GoogleCalendar'
import type { SettingsCtx } from '../components/settings/context'
import type { Project, Task } from '../types'

const T0 = '2026-09-01T09:00:00.000Z'
const noop = () => {}
const edits: [string, string | undefined][] = []

beforeEach(() => {
  edits.length = 0
  disconnects.length = 0
  // happy-dom edits no page: what the pad asks of the browser is heard here
  document.execCommand = ((command: string, _ui?: boolean, value?: string) => {
    edits.push([command, value])
    return true
  }) as typeof document.execCommand
  // a system dialog, were anything to ask for one, fails the test
  for (const name of ['alert', 'confirm', 'prompt'] as const) {
    vi.stubGlobal(name, () => {
      throw new Error(`the browser's ${name}() was called`)
    })
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const pad = () => document.querySelector('.notes-editable') as HTMLElement

/** The caret in the pad's text, or `word` in it selected. */
function place(word?: string) {
  const text = pad().querySelector('p')!.firstChild as Text
  const at = word ? text.data.indexOf(word) : text.data.length
  const range = document.createRange()
  range.setStart(text, at)
  range.setEnd(text, word ? at + word.length : at)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

describe('the notes pad asks for a link’s address itself', () => {
  it('in a row under its bar, and writes the address out where the caret was', () => {
    render(<RichNotes value="<p>Recipe here</p>" onChange={noop} />)
    place()
    fireEvent.click(screen.getByRole('button', { name: 'Link (Cmd/Ctrl+K)' }))
    const ask = screen.getByRole('form', { name: 'Link address' })
    const field = within(ask).getByRole('textbox', { name: 'Link address' })
    expect((field as HTMLInputElement).value).toBe('https://')
    // not an address yet: nothing to add
    expect((within(ask).getByRole('button', { name: 'Add link' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'https://example.com/soup' } })
    fireEvent.click(within(ask).getByRole('button', { name: 'Add link' }))
    expect(edits).toEqual([['insertHTML', '<a href="https://example.com/soup">https://example.com/soup</a>']])
    expect(screen.queryByRole('form', { name: 'Link address' })).toBeNull()
    // the caret is back in the note
    expect(document.activeElement).toBe(pad())
  })

  it('links the words that were selected', () => {
    render(<RichNotes value="<p>Recipe here</p>" onChange={noop} />)
    place('Recipe')
    fireEvent.click(screen.getByRole('button', { name: 'Link (Cmd/Ctrl+K)' }))
    const field = screen.getByRole('textbox', { name: 'Link address' })
    fireEvent.change(field, { target: { value: 'https://example.com/soup' } })
    fireEvent.submit(field.closest('form')!)
    expect(edits).toEqual([['createLink', 'https://example.com/soup']])
    // …on the selection the question left, put back before the link was made
    expect(window.getSelection()?.toString()).toBe('Recipe')
  })

  it('puts the row away on Cancel or Escape, and adds nothing', () => {
    render(<RichNotes value="<p>Recipe here</p>" onChange={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Link (Cmd/Ctrl+K)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'Link address' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Link (Cmd/Ctrl+K)' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Link address' }), { key: 'Escape' })
    expect(screen.queryByRole('form', { name: 'Link address' })).toBeNull()
    expect(edits).toEqual([])
  })
})

describe('the notes pad asks for a task’s title itself', () => {
  it('when nothing is picked and there is no line to take', () => {
    const made: string[] = []
    render(<RichNotes value="" onChange={noop} onCreateTask={t => made.push(t)} />)
    window.getSelection()?.removeAllRanges()
    fireEvent.click(screen.getByRole('button', { name: 'Turn the selected line into a task' }))
    const field = screen.getByRole('textbox', { name: 'Task title' })
    fireEvent.change(field, { target: { value: '  Buy tulip bulbs  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    expect(made).toEqual(['Buy tulip bulbs'])
    expect(screen.queryByRole('textbox', { name: 'Task title' })).toBeNull()
  })

  it('takes the line the caret is on without asking at all', () => {
    const made: string[] = []
    render(<RichNotes value="<p>Call the plumber</p>" onChange={noop} onCreateTask={t => made.push(t)} />)
    place()
    fireEvent.click(screen.getByRole('button', { name: 'Turn the selected line into a task' }))
    expect(made).toEqual(['Call the plumber'])
    expect(screen.queryByRole('textbox', { name: 'Task title' })).toBeNull()
  })
})

describe('deleting a project asks once', () => {
  const project: Project = { kind: 'project', id: 'p1', name: 'Garden', color: '#f97316', status: 'active', createdAt: T0, updatedAt: T0 }
  const task = (id: string): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', tags: [], projectId: 'p1', createdAt: T0, updatedAt: T0 })
  const open = (tasks: Task[]) => {
    const deleted: string[] = []
    render(<ProjectEditor project={project} tasks={tasks} getLatest={() => project} onSave={noop} onDelete={id => deleted.push(id)} onClose={noop} />)
    return deleted
  }

  it('by its own Tap again, which says its tasks stay', () => {
    const deleted = open([task('t1'), task('t2')])
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to delete it: its 2 tasks stay, unassigned' }))
    expect(deleted).toEqual(['p1'])
  })

  it('in the singular for one task', () => {
    open([task('t1')])
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('button', { name: 'Tap again to delete it: its 1 task stays, unassigned' })).toBeTruthy()
  })

  it('plainly, when it has no tasks', () => {
    open([])
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('button', { name: 'Tap again to delete the project' })).toBeTruthy()
  })
})

describe('Settings → Google Calendar asks before it disconnects', () => {
  const ctx = {
    store: { calendars: [], remove: noop },
    calendars: { events: [], errors: {}, names: {}, loading: false, refresh: async () => {} },
    googlePush: { pending: false, pushNow: async () => {} },
    household: { info: null, myId: 'me', refresh: async () => {} },
  } as unknown as SettingsCtx

  it('with a second tap on its own button', async () => {
    render(<GoogleCalendar {...ctx} initialStatus={{ configured: true, connected: true, email: 'me@gmail.com', missing: [], redirectUri: 'https://example.org/api/google/callback' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(disconnects).toEqual([])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tap again to disconnect' }))
    })
    expect(disconnects).toEqual(['disconnect'])
  })
})

// @vitest-environment happy-dom
import { fireEvent, render, screen } from './dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The task editor said every ✨ failure — and the GitHub issue button's — in
// one line at the foot of the form, two to four screens below the button on a
// phone, so a tap seemed to do nothing. Each failure now sits under the button
// that met it. Pressed in a page here: the ✨ buttons' code (ai.ts) loads on
// the first press, not with the editor, so what they say comes a moment after
// the press (taskeditor-errors.test.tsx holds the rest).

vi.mock('../ai', async importOriginal => ({
  ...(await importOriginal<typeof import('../ai')>()),
  refineDescription: async () => {
    throw new Error('The rewrite did not come back.')
  },
  suggestChecklist: async () => {
    throw new Error('No steps came back.')
  },
  suggestTags: async () => {
    throw new Error('No tags came back.')
  },
}))
const { issue } = vi.hoisted(() => ({ issue: vi.fn<() => Promise<{ url: string; number: number }>>() }))
vi.mock('../github', async importOriginal => ({ ...(await importOriginal<typeof import('../github')>()), createIssue: () => issue() }))

import { TaskEditor } from '../components/TaskEditor'
import type { Project, Task } from '../types'

const OPENED = '2026-09-01T09:00:00.000Z'
const noop = () => {}
const task: Task = { kind: 'task', id: 't1', title: 'Fix the gate', description: 'Hinges are loose.', status: 'todo', priority: 'normal', projectId: 'pr1', createdAt: OPENED, updatedAt: OPENED, tags: [] }
// a repo on the project, so the editor offers to open an issue in it
const home = { kind: 'project', id: 'pr1', name: 'Home', color: '#f97316', status: 'active', githubUrl: 'https://github.com/joe/house' } as Project

function open() {
  return render(<TaskEditor task={task} projects={[home]} people={[]} members={[]} candidates={[]} getLatest={() => undefined} onSave={noop} onCommit={noop} onDelete={noop} onClose={noop} />).container
}

/** Each failure said, in document order. */
const failures = () => screen.queryAllByRole('alert').map(e => e.textContent)
/** `a` comes after `b` in the page. */
const after = (a: Element, b: Element | null) => !!b && (b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
/** The button that says `words`: the ✨ ones sit inside their field's label, which names them to a screen reader, so by what they say. */
const press = (words: string) => fireEvent.click(screen.getByText(words, { selector: 'button' }))

beforeEach(() => {
  issue.mockReset()
  issue.mockRejectedValue(new Error('GitHub refused the issue.'))
})

describe('a failed ✨ or GitHub button says why beside itself', () => {
  it('a rewrite: under the description and its ✨ buttons, above the links', async () => {
    const page = open()
    press('✨ Clarify')
    const said = await screen.findByText('The rewrite did not come back.')
    expect(failures()).toEqual(['The rewrite did not come back.'])
    expect(after(said, page.querySelector('.desc-ai'))).toBe(true)
    expect(after(page.querySelector('.desc-links')!, said)).toBe(true)
  })

  it('Break it down: under the checklist, whose last row the button is on, before the side column', async () => {
    const page = open()
    press('✨ Break it down')
    const said = await screen.findByText('No steps came back.')
    expect(after(said, page.querySelector('.check-add'))).toBe(true)
    expect(after(page.querySelector('.editor-side')!, said)).toBe(true)
  })

  it('Suggest tags: under the tags, before the comments', async () => {
    const page = open()
    press('✨ Suggest tags')
    const said = await screen.findByText('No tags came back.')
    expect(after(said, page.querySelector('.tags-field'))).toBe(true)
    expect(after(page.querySelector('.activity')!, said)).toBe(true)
  })

  it('Create a GitHub issue: under the links it sits among, above the checklist', async () => {
    const page = open()
    press('Create a GitHub issue in house')
    const said = await screen.findByText('GitHub refused the issue.')
    expect(after(said, page.querySelector('.desc-links'))).toBe(true)
    expect(after(page.querySelector('.check-add')!, said)).toBe(true)
  })

  it('keeps each failure by its own button, and clears only that one when it is pressed again', async () => {
    open()
    press('✨ Suggest tags')
    await screen.findByText('No tags came back.')
    press('Create a GitHub issue in house')
    await screen.findByText('GitHub refused the issue.')
    expect(failures()).toEqual(['GitHub refused the issue.', 'No tags came back.'])
    // the issue button starting again clears its own line and leaves the tags' be
    issue.mockReturnValue(new Promise(() => {}))
    press('Create a GitHub issue in house')
    expect(failures()).toEqual(['No tags came back.'])
  })
})

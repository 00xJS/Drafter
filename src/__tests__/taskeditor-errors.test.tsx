import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

// The task editor said every ✨ failure — and the GitHub issue button's — in
// one line at the foot of the form, two to four screens below the button on a
// phone, so a tap seemed to do nothing. Each failure now sits under the button
// that met it. The ✨ buttons' code loads on the first press, so what they
// say comes a moment later: those are pressed in a page, as the GitHub
// button's is too (taskeditor-errors.dom.test.tsx). Here, what a render shows.

import { TaskEditor } from '../components/TaskEditor'
import { Attachments } from '../components/taskeditor/Attachments'
import { ChecklistField } from '../components/taskeditor/ChecklistField'
import { DescriptionLinks } from '../components/taskeditor/DescriptionLinks'
import type { Project, Task } from '../types'
import { elements, propsOf, settled, textOf, type El } from './rendered'

const OPENED = '2026-09-01T09:00:00.000Z'
const noop = () => {}
const task: Task = {
  kind: 'task',
  id: 't1',
  title: 'Fix the gate',
  description: 'Hinges are loose.',
  status: 'todo',
  priority: 'normal',
  createdAt: OPENED,
  updatedAt: OPENED,
  tags: [],
}
const home = { kind: 'project', id: 'pr1', name: 'Home', color: '#f97316', status: 'active' } as Project
const props = { task, projects: [home], people: [], members: [], candidates: [], getLatest: () => undefined, onSave: noop, onCommit: noop, onDelete: noop, onClose: noop }

/** The editor after `act` has pressed what it presses. */
const editor = (act: (tree: ReactNode) => void) => settled(TaskEditor, props, act)

/** Each failure said in the tree, in document order. */
const failures = (tree: ReactNode) => elements(tree).filter(e => e.type === 'p' && e.props.role === 'alert')

/** Where `el` sits among every element of the tree. */
const at = (tree: ReactNode, pick: (e: El) => boolean) => {
  const i = elements(tree).findIndex(pick)
  expect(i).toBeGreaterThan(-1)
  return i
}
const component = (type: unknown) => (e: El) => e.type === type
const saying = (words: string) => (e: El) => e.type === 'p' && textOf(e.props.children) === words

describe('a failed ✨ or GitHub button says why beside itself', () => {
  it('Create a GitHub issue: under the links it sits among, above the checklist', () => {
    const tree = editor(t => propsOf(t, DescriptionLinks).setAiError('GitHub refused the issue.'))
    const said = at(tree, saying('GitHub refused the issue.'))
    expect(said).toBeGreaterThan(at(tree, component(DescriptionLinks)))
    expect(said).toBeLessThan(at(tree, component(ChecklistField)))
  })

  it('leaves Attachments to say its own, with no line of the editor’s for it', () => {
    const tree = editor(noop)
    expect(Object.keys(propsOf(tree, Attachments)).sort()).toEqual(['attachments', 'set'])
    expect(failures(tree)).toEqual([])
  })
})

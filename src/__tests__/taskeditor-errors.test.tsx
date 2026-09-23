import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

// The task editor said every ✨ failure — and the GitHub issue button's — in
// one line at the foot of the form, two to four screens below the button on a
// phone, so a tap seemed to do nothing. Each failure now sits under the button
// that met it.

vi.mock('../ai', async importOriginal => ({
  ...(await importOriginal<typeof import('../ai')>()),
  // thrown at once rather than after a wait, so the failure lands inside the
  // render that pressed the button (see rendered.tsx)
  refineDescription: () => {
    throw new Error('The rewrite did not come back.')
  },
  suggestChecklist: () => {
    throw new Error('No steps came back.')
  },
  suggestTags: () => {
    throw new Error('No tags came back.')
  },
}))

import { TaskEditor } from '../components/TaskEditor'
import { Attachments } from '../components/taskeditor/Attachments'
import { ChecklistField } from '../components/taskeditor/ChecklistField'
import { CommentsField } from '../components/taskeditor/CommentsField'
import { DescriptionField } from '../components/taskeditor/DescriptionField'
import { DescriptionLinks } from '../components/taskeditor/DescriptionLinks'
import { TagsField } from '../components/taskeditor/TagsField'
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
  it('a rewrite: under the description and its ✨ buttons, above the links', () => {
    const tree = editor(t => propsOf(t, DescriptionField).onRefine('clarify'))
    expect(failures(tree).map(e => textOf(e.props.children))).toEqual(['The rewrite did not come back.'])
    const said = at(tree, saying('The rewrite did not come back.'))
    expect(said).toBeGreaterThan(at(tree, component(DescriptionField)))
    expect(said).toBeLessThan(at(tree, component(DescriptionLinks)))
  })

  it('Create a GitHub issue: under the links it sits among, above the checklist', () => {
    const tree = editor(t => propsOf(t, DescriptionLinks).setAiError('GitHub refused the issue.'))
    const said = at(tree, saying('GitHub refused the issue.'))
    expect(said).toBeGreaterThan(at(tree, component(DescriptionLinks)))
    expect(said).toBeLessThan(at(tree, component(ChecklistField)))
  })

  it('Break it down: under the checklist, whose last row the button is on, before the side column', () => {
    const tree = editor(t => propsOf(t, ChecklistField).onBreakDown())
    const said = at(tree, saying('No steps came back.'))
    expect(said).toBeGreaterThan(at(tree, component(ChecklistField)))
    expect(said).toBeLessThan(at(tree, component(Attachments)))
  })

  it('Suggest tags: under the tags, before the comments', () => {
    const tree = editor(t => propsOf(t, TagsField).onSuggestTags())
    const said = at(tree, saying('No tags came back.'))
    expect(said).toBeGreaterThan(at(tree, component(TagsField)))
    expect(said).toBeLessThan(at(tree, component(CommentsField)))
  })

  it('keeps each failure by its own button, and clears only that one when it is pressed again', () => {
    const both = editor(t => {
      propsOf(t, TagsField).onSuggestTags()
      propsOf(t, DescriptionLinks).setAiError('GitHub refused the issue.')
    })
    expect(failures(both).map(e => textOf(e.props.children))).toEqual(['GitHub refused the issue.', 'No tags came back.'])
    // the issue button starting again clears its own line and leaves the tags' be
    const again = editor(t => {
      propsOf(t, TagsField).onSuggestTags()
      propsOf(t, DescriptionLinks).setAiError('GitHub refused the issue.')
      propsOf(t, DescriptionLinks).setAiError('')
    })
    expect(failures(again).map(e => textOf(e.props.children))).toEqual(['No tags came back.'])
  })

  it('leaves Attachments to say its own, with no line of the editor’s for it', () => {
    const tree = editor(noop)
    expect(Object.keys(propsOf(tree, Attachments)).sort()).toEqual(['attachments', 'set'])
    expect(failures(tree)).toEqual([])
  })
})

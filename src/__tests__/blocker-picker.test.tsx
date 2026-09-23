import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { blockerCandidates } from '../components/planner/Overlays'
import { AssignFields, BLOCKER_OPTIONS_MAX, blockerOptions } from '../components/taskeditor/AssignFields'
import { initForm } from '../taskform'
import type { Task, TaskStatus } from '../types'
import { elements, rendered, settled, textOf, typeInto, type El } from './rendered'

// The "Blocked by" picker offered every task that was not canceled — done and
// wishlist ones too, the household's whole history in one select — and built
// an option for each on every keystroke anywhere in the editor. Picking a done
// task made a blocker that had never been there.

const T0 = '2026-09-01T09:00:00.000Z'

const task = (id: string, over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id,
  title: `Task ${id}`,
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  createdAt: T0,
  updatedAt: T0,
  ...over,
})

const noop = () => {}

/** Every status once, and the task being edited. */
const board = (['wishlist', 'todo', 'doing', 'blocked', 'done', 'canceled'] as TaskStatus[]).map(status => task(status, { status }))

describe('what the editor offers as a blocker', () => {
  it('only open tasks: to do, doing and blocked, never the task itself', () => {
    const editing = task('me')
    expect(
      blockerCandidates([...board, editing], editing)
        .map(t => t.id)
        .sort(),
    ).toEqual(['blocked', 'doing', 'todo'])
  })

  it('and the ones it already waits on, whatever became of them, so their chips keep a name', () => {
    const editing = task('me', { status: 'blocked', blockedBy: ['done', 'canceled'] })
    expect(
      blockerCandidates(board, editing)
        .map(t => t.id)
        .sort(),
    ).toEqual(['blocked', 'canceled', 'doing', 'done', 'todo'])
    const tree = settled(AssignFields, { form: initForm(editing), set: noop, members: [], candidates: blockerCandidates(board, editing), taskId: editing.id })
    const chips = elements(tree).filter(e => e.type === 'button' && e.props.title === 'Remove blocker')
    expect(chips.map(c => textOf(c.props.children))).toEqual(['✓ Task done ✕', '⏳ Task canceled ✕'])
  })

  it('from the task’s own project when it has one', () => {
    const editing = task('me', { projectId: 'home' })
    const tasks = [task('a', { projectId: 'home' }), task('b', { projectId: 'other' }), task('c')]
    expect(blockerCandidates(tasks, editing).map(t => t.id)).toEqual(['a'])
  })

  it('in the list itself too, whatever it is handed, and not what it already waits on', () => {
    const { options } = blockerOptions([...board, task('me')], 'me', ['doing'])
    expect(options.map(t => t.id).sort()).toEqual(['blocked', 'todo'])
  })
})

describe('a long list', () => {
  const many = Array.from({ length: BLOCKER_OPTIONS_MAX + 20 }, (_, i) =>
    task(`t${i}`, { title: i === 7 ? 'Call the plumber' : `Chore ${i}`, updatedAt: new Date(Date.parse(T0) + i * 60_000).toISOString() }),
  )

  it('holds the most recently changed, and says how many more there are', () => {
    const { options, more } = blockerOptions(many, 'me', [])
    expect(options).toHaveLength(BLOCKER_OPTIONS_MAX)
    expect(more).toBe(20)
    expect(options[0].id).toBe(`t${BLOCKER_OPTIONS_MAX + 19}`)
    expect(options.map(t => t.id)).not.toContain('t7')
  })

  it('finds the rest by name', () => {
    expect(blockerOptions(many, 'me', [], ' plumber ').options.map(t => t.id)).toEqual(['t7'])
    expect(blockerOptions(many, 'me', [], 'PLUMB').more).toBe(0)
  })

  const fields = (candidates: Task[]) => ({ form: initForm(task('me')), set: noop, members: [], candidates, taskId: 'me' })
  const options = (tree: unknown) => elements(tree as El).filter(e => e.type === 'option')
  const finder = (props: Record<string, unknown>) => props.type === 'search'

  it('draws no more options than it holds, and a box to find the rest only when there are more', () => {
    const long = settled(AssignFields, fields(many))
    expect(options(long)).toHaveLength(BLOCKER_OPTIONS_MAX + 2)
    const drawn = options(long)
    expect(textOf(drawn[drawn.length - 1].props.children)).toBe('…and 20 more — find them by name above')
    expect(elements(long).some(e => e.type === 'input' && finder(e.props))).toBe(true)

    const short = settled(AssignFields, fields(many.slice(0, 3)))
    expect(options(short)).toHaveLength(4)
    expect(elements(short).some(e => e.type === 'input')).toBe(false)
  })

  it('narrows to what is typed in the box', () => {
    const found = settled(AssignFields, fields(many), tree => typeInto(tree, finder, 'plumber'))
    expect(options(found).map(o => textOf(o.props.children))).toEqual(['Add a blocker…', 'Call the plumber'])
    const none = settled(AssignFields, fields(many), tree => typeInto(tree, finder, 'electrician'))
    expect(options(none).map(o => textOf(o.props.children))).toEqual(['No open task by that name'])
  })
})

describe('typing in the editor', () => {
  /** The editor around the fields: its own typing draws them again, with a new form each time, as its reducer makes one. */
  function Editor(props: Parameters<typeof AssignFields>[0]) {
    const [title, setTitle] = useState('')
    return (
      <>
        <input aria-label="Title" value={title} onChange={e => setTitle(e.target.value)} />
        {AssignFields({ ...props, form: { ...props.form } })}
      </>
    )
  }

  it('does not build the blocker list again', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => task(`t${i}`))
    const trees = rendered(Editor, { form: initForm(task('me')), set: noop, members: [], candidates, taskId: 'me' }, tree =>
      typeInto(tree, p => p['aria-label'] === 'Title', 'B'),
    )
    expect(trees).toHaveLength(2)
    const [before, after] = trees.map(t => elements(t).filter(e => e.type === 'option' && e.props.value !== ''))
    expect(after).toHaveLength(30)
    after.forEach((option, i) => expect(option).toBe(before[i]))
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssignFields } from '../components/taskeditor/AssignFields'
import { Board } from '../components/Board'
import { ShareMark } from '../components/bits'
import { TaskCard } from '../components/TaskCard'
import { TasksTable } from '../components/TasksTable'
import { initForm } from '../taskform'
import { Store } from '../store'
import { Task } from '../types'
import { button, elements, press, settled, textOf } from './rendered'

// "I want to see which tasks are shared vs which are private with a simple
// glance at a task." Driven rather than grepped: the control has to reach the
// form, and the rows have to carry the mark. A test that looked for the word
// "Private" in the source would pass with either wired to nothing.

const T0 = '2026-09-01T09:00:00.000Z'
const ME = 'user-me'
const PEER = 'user-peer'
const MEMBERS = [
  { id: ME, displayName: 'Joseph' },
  { id: PEER, displayName: 'Maria' },
]

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

/** The words each mark draws, through the component the row hands its props to. */
const badges = (tree: ReturnType<typeof settled>) =>
  elements(tree)
    .filter(e => e.type === ShareMark)
    .map(e => textOf(settled(ShareMark, e.props as Parameters<typeof ShareMark>[0])).replace(/\s+/g, ' ').trim())

describe('the control in the editor', () => {
  const fields = (over: Partial<Task> = {}, onSet: (patch: unknown) => void = noop, members = MEMBERS) => {
    const t = task('t1', over)
    return settled(AssignFields, {
      form: initForm(t),
      set: onSet as Parameters<typeof AssignFields>[0]['set'],
      members,
      candidates: [],
      taskId: t.id,
      myId: ME,
    })
  }

  it('reads Shared for a task nobody has withheld, which is what a task is', () => {
    expect(button(fields(), '👥 Shared').props['aria-pressed']).toBe(true)
    expect(button(fields(), '🔒 Private').props['aria-pressed']).toBe(false)
  })

  it('reads Private once its owner has', () => {
    expect(button(fields({ shared: false }), '🔒 Private').props['aria-pressed']).toBe(true)
  })

  it('one press withholds it, and the form carries what the database reads', () => {
    const patches: unknown[] = []
    press(fields({}, p => patches.push(p)), '🔒 Private')
    expect(patches).toEqual([{ shared: false }])
  })

  it('one press hands it back', () => {
    const patches: unknown[] = []
    press(fields({ shared: false }, p => patches.push(p)), '👥 Shared')
    expect(patches).toEqual([{ shared: true }])
  })

  it('is not offered outside a household, where there is nobody to withhold it from', () => {
    const solo = fields({}, noop, [{ id: ME, displayName: 'Joseph' }])
    expect(elements(solo).filter(e => e.type === 'button').map(e => textOf(e.props.children))).not.toContain('🔒 Private')
  })

  it('is not offered at all on a task of the housemate\'s: only its owner can withhold it', () => {
    // the policy's `with check` refuses a peer's write that withholds a row, so
    // a button here would be a lie the server refuses — the task would sit
    // dirty, retried for good, wearing a private badge nobody else could see
    const t = task('t1', { ownerId: PEER })
    const tree = settled(AssignFields, {
      form: initForm(t),
      set: noop as Parameters<typeof AssignFields>[0]['set'],
      members: MEMBERS,
      candidates: [],
      taskId: t.id,
      myId: ME,
      ownerId: PEER,
    })
    const words = elements(tree).filter(e => e.type === 'button').map(e => textOf(e.props.children))
    expect(words).not.toContain('🔒 Private')
    expect(words).not.toContain('👥 Shared')
    expect(textOf(tree)).toContain('Maria’s task')
  })

  it('refuses to withhold a task the other member is doing, and says who', () => {
    // whose job it is and who can see it are different questions, but one
    // answer rules out the other: they cannot do what they cannot see. Said
    // and refused here rather than allowed and then undone by the server.
    const tree = fields({ assigneeId: PEER })
    expect(button(tree, '🔒 Private').props.disabled).toBe(true)
    expect(button(tree, '🔒 Private').props.title).toContain('Maria')
  })

  it('is offered again once the assignee has left the household', () => {
    // a name that is not on the members list any more is nobody, and locking
    // the control against it left a task that could never be made private
    const tree = fields({ assigneeId: 'user-gone' })
    expect(button(tree, '🔒 Private').props.disabled).toBeFalsy()
  })

  it('shares a task as it is handed to the other member', () => {
    const patches: unknown[] = []
    const tree = fields({ shared: false }, p => patches.push(p))
    const picker = elements(tree).find(e => e.type === 'select' && e.props.children)!
    ;(picker.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: PEER } })
    expect(patches).toEqual([{ assigneeId: PEER, shared: true }])
  })

  it('leaves it alone when the one doing it is you', () => {
    const patches: unknown[] = []
    const tree = fields({ shared: false }, p => patches.push(p))
    const picker = elements(tree).find(e => e.type === 'select' && e.props.children)!
    ;(picker.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: ME } })
    expect(patches).toEqual([{ assigneeId: ME }])
  })
})

describe('the mark on a row', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // the list asks matchMedia for its phone layout; node has none, so this is
  // the desktop table
  const table = (tasks: Task[], inHousehold = true) => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
    return settled(TasksTable, {
      store: { visibleItems: [] } as unknown as Store,
      tasks,
      onOpen: noop,
      onNew: noop,
      onDelete: noop,
      onOpenTrash: noop,
      trashCount: 0,
      inHousehold,
      myId: ME,
      nameOf: (id: string | undefined) => MEMBERS.find(m => m.id === id)?.displayName ?? null,
    })
  }

  it('marks both states in the task list, so neither is read off a blank space', () => {
    expect(badges(table([task('a'), task('b', { shared: false })]))).toEqual(['👥 Shared', '🔒 Private'])
  })

  it('names the housemate whose task it is', () => {
    expect(badges(table([task('c', { ownerId: PEER })]))).toEqual(['👥 Maria'])
  })

  it('marks nothing outside a household, where every row would say the same thing', () => {
    expect(badges(table([task('a'), task('b', { shared: false })], false))).toEqual([])
  })

  it('marks a board card too, where the same glance is wanted', () => {
    const card = settled(TaskCard, { task: task('a', { shared: false }), inHousehold: true, onOpen: noop })
    expect(badges(card)).toEqual(['🔒 Private'])
    expect(badges(settled(TaskCard, { task: task('a'), inHousehold: true, onOpen: noop }))).toEqual(['👥 Shared'])
    expect(badges(settled(TaskCard, { task: task('a'), onOpen: noop }))).toEqual([])
  })

  it('the board hands every card the answer, rather than each card working it out', () => {
    const tree = settled(Board, { tasks: [task('a')], members: MEMBERS, inHousehold: true, onOpen: noop, onStatus: noop, onNew: noop })
    expect(elements(tree).find(e => e.type === TaskCard)!.props.inHousehold).toBe(true)
  })
})

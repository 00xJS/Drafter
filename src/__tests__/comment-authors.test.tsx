import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommentsField } from '../components/taskeditor/CommentsField'
import { TaskUpdates } from '../components/settings/Reminders'
import { initForm, mergeOnto } from '../taskform'
import { duplicateTask } from '../taskutils'
import type { Task } from '../types'
import { button, elements, rendered, textOf, typeInto } from './rendered'

// Who wrote a comment, and who handed a task over: the two facts the other
// member's notice is built from (v3.32). A comment is signed as it is written
// and names its author; "Who's doing it" says who changed it.

const ME = 'user-me'
const PEER = 'user-peer'
const MEMBERS = [
  { id: ME, displayName: 'Joseph' },
  { id: PEER, displayName: 'Maria' },
]
const T = '2026-09-23T16:00:00.000Z'
const task = (over: Partial<Task> = {}): Task => ({ kind: 'task', id: 't1', title: 'Bins', description: '', status: 'todo', priority: 'normal', tags: [], createdAt: T, updatedAt: T, ...over })

describe('a comment says who wrote it', () => {
  const comments = [
    { id: 'c0', body: 'From before names were kept', createdAt: '2026-09-01T10:00:00.000Z' },
    { id: 'c1', body: 'Blue one was full', createdAt: T, by: PEER },
    { id: 'c2', body: 'From someone who left', createdAt: T, by: 'user-gone' },
  ]
  const draw = (members = MEMBERS) =>
    renderToStaticMarkup(<CommentsField comments={comments} set={() => {}} persisted latest={() => task()} onCommit={() => {}} myId={ME} members={members} />)

  it('its author’s name beside it, when known; an old comment, or a member who left, names nobody', () => {
    const html = draw()
    expect(html.match(/class="comment-by"/g)).toHaveLength(1)
    expect(html).toContain('Maria · </strong>')
    expect(html).not.toContain('user-gone')
  })

  it('no names at all outside a household', () => {
    expect(draw([])).not.toContain('comment-by')
  })

  it('is signed by whoever writes it, and saved at once on a saved task', () => {
    const committed: Task[] = []
    const trees = rendered(
      CommentsField,
      { comments: [], set: () => {}, persisted: true, latest: () => task(), onCommit: (t: Task) => void committed.push(t), myId: ME, members: MEMBERS },
      tree => typeInto(tree, p => p['aria-label'] === 'Add a comment', 'On my way'),
    )
    ;(button(trees[trees.length - 1], 'Comment').props.onClick as () => void)()
    expect(committed[0].comments).toEqual([{ id: expect.any(String), body: 'On my way', createdAt: expect.any(String), by: ME }])
  })

  it('and signed by nobody where there is nobody else (local mode)', () => {
    const committed: Task[] = []
    const trees = rendered(
      CommentsField,
      { comments: [], set: () => {}, persisted: true, latest: () => task(), onCommit: (t: Task) => void committed.push(t), myId: null },
      tree => typeInto(tree, p => p['aria-label'] === 'Add a comment', 'Note to self'),
    )
    ;(button(trees[trees.length - 1], 'Comment').props.onClick as () => void)()
    expect(committed[0].comments?.[0]).not.toHaveProperty('by')
  })
})

describe('who handed a task over', () => {
  it('is written when "Who’s doing it" changes, and only then', () => {
    const base = task({ assigneeId: ME, assignedBy: PEER })
    const handed = mergeOnto(base, { ...initForm(base), assigneeId: PEER, assignedBy: ME }, base, true)
    expect(handed).toMatchObject({ assigneeId: PEER, assignedBy: ME })
    const retitled = mergeOnto(base, { ...initForm(base), title: 'Both bins' }, base, true)
    expect(retitled).toMatchObject({ assigneeId: ME, assignedBy: PEER })
  })

  it('goes with a duplicate, as the pair it is', () => {
    expect(duplicateTask(task({ assigneeId: PEER, assignedBy: ME }))).toMatchObject({ assigneeId: PEER, assignedBy: ME })
  })
})

describe('Settings → Reminders: the switch for a shared task’s updates', () => {
  it('says what it does, reads as set, and shows its own error beside it', () => {
    const on = renderToStaticMarkup(<TaskUpdates on busy={false} onChange={() => {}} />)
    expect(on).toContain('Tell me when someone updates a task we share')
    expect(on).toMatch(/<input type="checkbox" checked=""/)
    const failed = renderToStaticMarkup(<TaskUpdates on={false} busy={false} error="Could not save" onChange={() => {}} />)
    expect(failed).not.toMatch(/checked=""/)
    expect(failed).toContain('<p class="warn">Could not save</p>')
  })

  it('hands the new answer to its owner', () => {
    const got: boolean[] = []
    const tree = rendered(TaskUpdates, { on: true, busy: false, onChange: (v: boolean) => void got.push(v) })[0]
    const box = elements(tree).find(e => e.type === 'input')!
    ;(box.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: false } })
    expect(got).toEqual([false])
    expect(textOf(tree)).toContain('under the bell on Home')
  })
})

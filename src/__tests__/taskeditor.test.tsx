import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TaskEditor } from '../components/TaskEditor'
import type { Project, Task } from '../types'

/*
 * The task editor's first render (vitest runs in node, so no effects and no
 * typing): which fields it has, and the order of the foot of the form. The
 * rules behind each are in taskform.test.ts.
 */

const OPENED = '2026-09-01T09:00:00.000Z'
const noop = () => {}

const task = (over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: 't1',
  title: 'Fix the gate',
  description: '',
  status: 'todo',
  priority: 'normal',
  createdAt: OPENED,
  updatedAt: OPENED,
  tags: [],
  ...over,
})

const home = { kind: 'project', id: 'pr1', name: 'Home', color: '#f97316', status: 'active' } as Project

type EditorProps = Parameters<typeof TaskEditor>[0]
const render = (over: Partial<EditorProps> = {}) =>
  renderToStaticMarkup(
    <TaskEditor projects={[home]} people={[]} members={[]} candidates={[]} getLatest={() => undefined} onSave={noop} onCommit={noop} onDelete={noop} onClose={noop} {...over} />,
  )

describe('the task editor', () => {
  it('has no project field — for a new task, a bill, or a saved task in a project', () => {
    for (const html of [render(), render({ preset: { bill: { kind: 'bill' } } }), render({ task: task({ projectId: 'pr1' }) })]) {
      expect(html).not.toContain('No project')
      expect(html).not.toMatch(/<span>Project<\/span>/)
    }
    // the project a saved task is in is still said, just not offered for change
    expect(render({ task: task({ projectId: 'pr1' }) })).toContain('in Home')
  })

  it('asks for costs only on a bill — or on a task that already has one', () => {
    expect(render()).not.toMatch(/<span>(Estimate|Actual cost|Amount due|Paid)<\/span>/)
    const bill = render({ preset: { bill: { kind: 'bill' } } })
    expect(bill).toContain('<span>Amount due</span>')
    expect(bill).toContain('<span>Paid</span>')
    const estimated = render({ task: task({ estimateCost: 40 }) })
    expect(estimated).toContain('<span>Estimate</span>')
    expect(estimated).toContain('value="40"')
  })

  it('puts Repeat, then Tags, then Activity after every other field, and Versions last', () => {
    const html = render({ task: task({ comments: [{ id: 'm1', body: 'Called Dave', createdAt: OPENED }] }) })
    const at = (needle: string) => {
      const i = html.indexOf(needle)
      expect(i, needle).toBeGreaterThan(-1)
      return i
    }
    const order = ['<span>Checklist', '<span>Status</span>', '<span>Where', '</aside>', 'class="field repeat-field"', 'class="field tags-field"', 'class="field activity"', 'Called Dave', 'aria-label="Add a comment"', 'class="versions"'].map(at)
    expect(order).toEqual([...order].sort((x, y) => x - y))
    // the ✨ button goes with the tags; the side column has neither field now
    expect(at('✨ Suggest tags')).toBeGreaterThan(at('class="field tags-field"'))
    expect(html.slice(0, at('</aside>'))).not.toMatch(/<span>(Repeat|Tags)/)
    // a new task has no versions: Activity is the last section
    const fresh = render()
    expect(fresh.lastIndexOf('class="field')).toBe(fresh.indexOf('class="field activity"'))
  })
})

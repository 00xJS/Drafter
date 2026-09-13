import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TaskEditor } from '../components/TaskEditor'
import type { Person, Project, Task } from '../types'

/*
 * The task editor's first render (vitest runs in node, so no effects and no
 * typing): which fields it has, what the description opens with, what sits
 * under it, and the order of the foot of the form. The rules behind each are
 * in taskform.test.ts.
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
const sam: Person = { kind: 'person', id: 'p1', name: 'Sam', color: '#f97316', group: 'family', createdAt: OPENED, updatedAt: OPENED }

type EditorProps = Parameters<typeof TaskEditor>[0]
const render = (over: Partial<EditorProps> = {}) =>
  renderToStaticMarkup(
    <TaskEditor projects={[home]} people={[]} members={[]} candidates={[]} getLatest={() => undefined} onSave={noop} onCommit={noop} onDelete={noop} onClose={noop} {...over} />,
  )

/** The Description field's text as rendered. */
const descriptionOf = (html: string) => /<textarea[^>]*placeholder="What needs to happen[^"]*"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1]

describe('the task editor', () => {
  it('has no project, notes, link or GitHub field — for a new task, a bill, or a saved task in a project', () => {
    for (const html of [render(), render({ preset: { bill: { kind: 'bill' } } }), render({ task: task({ projectId: 'pr1', githubUrl: 'https://github.com/00xJS/Drafter/issues/12' }) })]) {
      expect(html).not.toContain('No project')
      expect(html).not.toMatch(/<span>(Project|Notes|Link|GitHub)<\/span>/)
      expect(html).not.toContain('Private scratch space')
      expect(html).not.toContain('Issue, PR, repo or project URL')
      expect(html).not.toContain('placeholder="https://…"')
    }
    // nor is the project a saved task is in said: there is one ongoing project
    expect(render({ task: task({ projectId: 'pr1' }) })).not.toContain('in Home')
  })

  it('opens a saved task with its notes and link in the description', () => {
    const html = render({ task: task({ description: 'Hinges are loose.', notes: 'Measure first', link: 'https://example.com/hinges' }) })
    expect(descriptionOf(html)).toBe('Hinges are loose.\n\nMeasure first\n\nhttps://example.com/hinges')
  })

  it('shows the GitHub card and a chip for every other link under the description', () => {
    const issue = 'https://github.com/00xJS/Drafter/issues/12'
    const html = render({ task: task({ description: `Tracking ${issue}\nParts: https://example.com/hinges.` }) })
    expect(html).toContain('class="gh-card"')
    expect(html).toContain('00xJS/Drafter#12')
    expect(html.match(/class="link-chip"/g)).toHaveLength(1)
    expect(html).toContain('href="https://example.com/hinges"')
    expect(html).toContain('>example.com/hinges</span>')
    // read from the text, the card has nothing to unlink; the task's own link does
    expect(html).not.toContain('Unlink from this task')
    expect(render({ task: task({ githubUrl: issue }) })).toContain('Unlink from this task')
    // nothing under a description without links
    expect(render({ task: task({ description: 'Just words.' }) })).not.toContain('desc-links')
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

  it('offers People for adding someone new only when it can save them', () => {
    expect(render()).not.toContain('counts as seeing them')
    expect(render({ people: [sam] })).toContain('placeholder="Search people to add…"')
    const adding = render({ onSavePerson: noop })
    expect(adding).toContain('counts as seeing them')
    expect(adding).toContain('placeholder="Search or add a person…"')
  })
})

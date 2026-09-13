import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProjectEditor, withEdits } from '../components/ProjectEditor'
import type { SettingsCtx } from '../components/settings/context'
import { Templates } from '../components/settings/Templates'
import { BUILT_IN_TEMPLATES, extendProject } from '../templates'
import { Project, Template } from '../types'
import { toLocalInput } from '../utils'

// The one project's editor adds a template's (or a drafted plan's) tasks and
// milestones into the project, dated from a day of their own. The project
// stays itself: the newest copy is the one extended, with the form's edits,
// so its name, colour, dates, notepad, pin and owner all survive.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const T0 = '2026-09-01T09:00:00.000Z'
const noop = () => {}
const LIFE: Project = {
  kind: 'project',
  id: 'p-life',
  name: 'LIFE',
  emoji: '🌱',
  color: '#f97316',
  status: 'active',
  milestones: [{ id: 'm0', name: 'Kept' }],
  notes: 'Groceries',
  notesHtml: '<p>Groceries</p>',
  notesPinned: true,
  ownerId: 'u1',
  createdAt: T0,
  updatedAt: T0,
}
const party = BUILT_IN_TEMPLATES.find(t => t.id === 'tpl-party')!
/** The party on 10 October 2026, at local noon as the editor passes it. */
const partyDay = new Date(2026, 9, 10, 12)
const day = (iso?: string) => toLocalInput(iso).slice(0, 10)
/** The fields the editor's form holds, as it read them from `p`. */
const fields = (p: Project) => ({ name: p.name, emoji: p.emoji, color: p.color, description: p.description, status: p.status, startAt: p.startAt, targetAt: p.targetAt, milestones: p.milestones, githubUrl: p.githubUrl, githubProjectSync: p.githubProjectSync })

describe('a template added to the project', () => {
  const { project, tasks } = extendProject(LIFE, party, partyDay)

  it('keeps the notepad, its pin, its owner and the rest of the project as they were', () => {
    expect(project).toMatchObject({ id: 'p-life', name: 'LIFE', emoji: '🌱', color: '#f97316', status: 'active', notes: 'Groceries', notesHtml: '<p>Groceries</p>', notesPinned: true, ownerId: 'u1', createdAt: T0 })
  })

  it('never fills in the project’s start or target: the one project has no end', () => {
    expect(project.startAt).toBeUndefined()
    expect(project.targetAt).toBeUndefined()
  })

  it('adds its milestones after the project’s own, dated from the day chosen', () => {
    expect(project.milestones?.map(m => [m.name, day(m.dueAt)])).toEqual([
      ['Kept', ''],
      ['Party', '2026-10-10'],
    ])
  })

  it('files each of its tasks in the project, counting back from the party', () => {
    expect(tasks).toHaveLength(party.tasks.length)
    expect(tasks.every(t => t.projectId === 'p-life' && t.status === 'todo')).toBe(true)
    expect(day(tasks.find(t => t.title === 'Send invitations')?.dueAt)).toBe('2026-09-19')
  })

  it('fills an empty notepad from a saved template, and never one that has words', () => {
    const saved: Template = { ...party, id: 'tpl-mine', notesHtml: '<p>From the template</p>' }
    const bare: Project = { ...LIFE, notes: undefined, notesHtml: undefined }
    expect(extendProject(bare, saved, partyDay).project.notesHtml).toBe('<p>From the template</p>')
    expect(extendProject({ ...bare, notes: 'Older words' }, saved, partyDay).project.notesHtml).toBeUndefined()
    expect(extendProject(LIFE, saved, partyDay).project.notesHtml).toBe('<p>Groceries</p>')
  })
})

describe('what the editor writes', () => {
  // the editor opened on LIFE unpinned; the notepad's Pin, and a colour from
  // another device, landed before Add was pressed
  const opened: Project = { ...LIFE, notesPinned: undefined }
  const newest: Project = { ...LIFE, color: '#22d3ee', updatedAt: '2026-09-02T09:00:00.000Z' }
  const was = fields(opened)

  it('lays the form’s edits over the newest copy, under a newer stamp', () => {
    const next = withEdits(newest, was, { ...was, name: 'LIFE 2026' })
    expect(next).toMatchObject({ name: 'LIFE 2026', color: '#22d3ee', notesPinned: true, notes: 'Groceries', ownerId: 'u1' })
    expect(next.updatedAt > newest.updatedAt).toBe(true)
  })

  it('keeps the notepad pinned when a template or a drafted plan is added', () => {
    const { project } = extendProject(withEdits(newest, was, was), party, partyDay)
    expect(project.notesPinned).toBe(true)
    expect(project.color).toBe('#22d3ee')
    expect(project.updatedAt > newest.updatedAt).toBe(true)
  })

  it('is what Save and Add both write', () => {
    const src = read('../components/ProjectEditor.tsx')
    expect(src).toContain('const edited = () => withEdits(getLatest(base.id) ?? base, baseValues(), formValues())')
    expect(src).toContain('onSave(edited())')
    expect(src).toMatch(/extendProject\(edited\(\), tpl, /)
  })
})

describe('the project editor', () => {
  const mine: Template = { ...party, id: 'tpl-mine', name: 'Birthday' }
  const html = renderToStaticMarkup(
    <ProjectEditor project={LIFE} tasks={[]} getLatest={() => LIFE} onSave={noop} onDelete={noop} onClose={noop} onCreateMany={noop} onSaveTemplate={noop} templates={[mine]} />,
  )

  it('offers every template on the project it edits: yours, then the built-in ones', () => {
    expect(html).toContain('Add tasks from a template')
    expect(html).toContain('<optgroup label="Your templates">')
    for (const name of ['Birthday', ...BUILT_IN_TEMPLATES.map(t => t.name)]) expect(html, name).toContain(name)
  })

  it('has nothing left of starting a project', () => {
    expect(html).toContain('Edit project')
    expect(html).not.toMatch(/New project|Blank project|Create project|Create with/)
    expect(read('../components/ProjectEditor.tsx')).not.toMatch(/New project|Blank project|Create project|Create with|project\?: Project|!project/)
  })
})

describe('where a template is picked', () => {
  it('Settings and the Save as template toast point to the project editor', () => {
    const html = renderToStaticMarkup(<Templates {...({ store: { templates: [{ ...party, id: 'tpl-mine' }], remove: noop } } as unknown as SettingsCtx)} />)
    expect(html).toContain('Pick one there to add its tasks and milestones')
    const overlays = read('../components/planner/Overlays.tsx')
    expect(overlays).toContain('pick it in the project editor to add its tasks')
    for (const src of [html, overlays]) expect(src).not.toMatch(/when creating|creating a (new )?project|chips/)
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NotesIndex } from '../components/notes/NotesIndex'
import { NotesView } from '../components/NotesView'
import { Roadmap } from '../components/Roadmap'
import { Search } from '../components/Search'
import { TaskCard } from '../components/TaskCard'
import { buildPaletteCommands } from '../components/planner/commands'
import { Note, Project, Task } from '../types'
import { plannerSource } from './source'

// There is one ongoing project — the owner's LIFE — so no task row names it,
// nothing starts a second one, and nothing asks which project something
// belongs to. The one project is still edited from its Timeline bar and from
// search (one-project-pages.test.ts covers Home and the Week review).

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const T0 = '2026-09-01T09:00:00.000Z'
const noop = () => {}
const LIFE: Project = { kind: 'project', id: 'p-life', name: 'LIFE', emoji: '🌱', color: '#f97316', status: 'active', createdAt: T0, updatedAt: T0 }
const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: `Task ${id}`, description: '', status: 'todo', priority: 'normal', tags: [], projectId: LIFE.id, createdAt: T0, updatedAt: T0, ...over })

/** Whatever a row would show for the project: a chip, its name, its emoji, or "No project". */
const namesProject = (html: string) => /pchip|LIFE|🌱|No project/.test(html)

describe('no task row names the project', () => {
  it('on a Board card', () => {
    expect(namesProject(renderToStaticMarkup(<TaskCard task={task('1')} onOpen={noop} onStatus={noop} />))).toBe(false)
    expect(read('../components/Board.tsx')).not.toMatch(/projects|ProjectChip/)
  })

  it('on the Tasks list: no chip on a phone row, no Project column, no project in its search', () => {
    const src = read('../components/TasksTable.tsx')
    for (const gone of ['ProjectChip', '<th>Project</th>', 'projectMap', 'projectId']) expect(src, gone).not.toContain(gone)
  })

  it('in the calendar: the day sheet, the week list and a pill’s title', () => {
    const src = read('../components/Calendar.tsx')
    for (const gone of ['ProjectChip', 'project?.name', "' · ' + project.name"]) expect(src, gone).not.toContain(gone)
  })

  it('in search: a task shows when it is due, never a project', () => {
    const html = renderToStaticMarkup(
      <Search tasks={[task('1', { dueAt: '2026-09-20T09:00:00.000Z' }), task('2')]} projects={[LIFE]} people={[]} onOpenTask={noop} onOpenProject={noop} onOpenPerson={noop} onCreateTask={noop} onClose={noop} />,
    )
    expect(html).toContain('Task 1')
    expect(html).toContain('Task 2')
    expect(namesProject(html)).toBe(false)
    // the dated task has a line under it, the undated one none
    expect(html.match(/<small>/g)).toHaveLength(1)
    expect(read('../components/Search.tsx')).not.toMatch(/No project|projectName/)
  })

  it('on a note’s row in Tasks → Notes', () => {
    const notes: Note[] = [{ kind: 'note', id: 'n1', title: 'Garden', body: '<p>Beds</p>', projectId: LIFE.id, createdAt: T0, updatedAt: T0 }]
    const html = renderToStaticMarkup(<NotesIndex notes={notes} projects={[LIFE]} query="" onQuery={noop} onOpenNote={noop} onOpenPad={noop} />)
    expect(html).toContain('Garden')
    expect(namesProject(html)).toBe(false)
  })

  it('in the task editor’s footer', () => {
    expect(read('../components/TaskEditor.tsx')).not.toMatch(/>\s*in \{project/)
  })
})

describe('nothing starts a second project', () => {
  it('the palette has no New project', () => {
    const nav = { goView: noop, setHomeTab: noop, setView: noop, openJournal: noop, goTasksTab: noop, setPeopleTab: noop }
    const commands = buildPaletteCommands(nav, { newTask: noop, setSettingsOpen: noop, openSheet: noop })
    expect(commands.filter(c => /project/i.test(c.label)).map(c => c.label)).toEqual([])
  })

  it('the Timeline has no + New project, and with no project says so plainly', () => {
    const html = renderToStaticMarkup(<Roadmap projects={[]} tasks={[]} events={[]} sourceMap={new Map()} onOpenProject={noop} onOpenTask={noop} />)
    expect(html).toContain('<h2>No projects</h2>')
    expect(html).not.toMatch(/New project|<button/)
    expect(read('../components/Roadmap.tsx')).not.toMatch(/New project|onNewProject/)
  })

  it('Notes has no "Notes live inside projects" hero', () => {
    const html = renderToStaticMarkup(<NotesView projects={[]} getLatest={() => undefined} onSave={noop} onSelectProject={noop} onBack={noop} onCreateTask={noop} />)
    expect(html).not.toMatch(/Notes live inside projects|New project|<button/)
  })

  it('the shell hands nothing a way to start one', () => {
    expect(plannerSource()).not.toMatch(/newProject|onNewProject/)
    for (const f of ['../components/NotesView.tsx', '../components/Roadmap.tsx']) expect(read(f), f).not.toMatch(/onNewProject|\+ New project/)
  })

  it('still opens the one project from its Timeline bar and from search', () => {
    expect(read('../components/planner/CalendarScreen.tsx')).toMatch(/<Roadmap [^>]*onOpenProject=\{openProject\}/)
    expect(read('../components/Roadmap.tsx')).toMatch(/className=\{row\.inferred \? 'rm-bar inferred' : 'rm-bar'\}[\s\S]{0,200}onClick=\{\(\) => onOpenProject\(row\.project\)\}/)
    expect(read('../components/planner/Overlays.tsx')).toContain('onOpenProject={openProject}')
  })
})

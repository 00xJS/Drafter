import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Landing } from '../components/Landing'
import { NotesIndex } from '../components/notes/NotesIndex'
import { NotesView } from '../components/NotesView'
import { Roadmap } from '../components/Roadmap'
import { Search } from '../components/Search'
import { TaskCard } from '../components/TaskCard'
import { buildPaletteCommands } from '../components/planner/commands'
import { CaptureProposal } from '../components/taskeditor/CaptureProposal'
import { inInbox } from '../taskutils'
import { Note, Project, Task } from '../types'
import { plannerSource, sheetSource } from './source'

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

  it('the landing page’s palette creates a task or a bill, and no card promises a project', () => {
    const html = renderToStaticMarkup(<Landing configured={false} />)
    expect(html).toContain('creates a task or bill')
    const cards = html.match(/<article[\s\S]*?<\/article>/g) ?? []
    expect(cards.length).toBeGreaterThan(5)
    for (const card of cards) expect(card).not.toMatch(/project/i)
  })
})

describe('no progress for the project', () => {
  it('the Timeline draws LIFE’s span with no progress bar, count or fill', () => {
    const tasks = [task('1', { status: 'done', dueAt: '2026-09-02T09:00:00.000Z' }), task('2', { dueAt: '2026-09-03T09:00:00.000Z' })]
    const html = renderToStaticMarkup(<Roadmap projects={[LIFE]} tasks={tasks} events={[]} sourceMap={new Map()} onOpenProject={noop} onOpenTask={noop} />)
    expect(html).toContain('class="rm-bar inferred"')
    expect(html).toContain('LIFE')
    expect(html).not.toMatch(/rm-progress|rm-bar-fill|progress|1\/2/)
  })

  it('nothing on the Timeline works it out, and its rules are gone from the sheet', () => {
    const src = read('../components/Roadmap.tsx')
    for (const gone of ['ProgressBar', 'projectProgress', 'rm-progress', 'rm-bar-fill']) expect(src, gone).not.toContain(gone)
    expect(sheetSource()).not.toMatch(/\.rm-progress|\.rm-bar-fill/)
  })
})

describe('a capture is never filed under the project', () => {
  it('the palette’s Shift+Enter sends no project names and never says “Filed under”', () => {
    const src = read('../components/planner/useTaskActions.ts')
    const capture = src.slice(src.indexOf('const captureTask'), src.indexOf('const deleteTask'))
    expect(capture).not.toMatch(/projectNames|projectId|store\.projects|Filed under/)
    // the toast asks the Inbox's own question
    expect(capture).toContain("inInbox(first) ? 'Captured to Inbox'")
  })

  it('the model is not asked for one, and the editor’s suggestion has no Project row', () => {
    const ai = read('../ai.ts')
    const parse = ai.slice(ai.indexOf('export async function parseCapture'), ai.indexOf('export function quickCaptureFields'))
    expect(parse).not.toMatch(/project/i)
    const html = renderToStaticMarkup(
      <CaptureProposal
        proposal={{ title: 'Dentist', dueAt: '2026-09-20T09:00:00.000Z', priority: 'high', peopleNames: ['Sam'], tags: ['health'], recurrence: 'monthly' }}
        parsing={false}
        onApply={noop}
        onDismiss={noop}
      />,
    )
    for (const row of ['Title', 'Due', 'Priority', 'People', 'Tags', 'Repeat']) expect(html, row).toContain(`<strong>${row}</strong>`)
    expect(html).not.toMatch(/Project/)
    expect(read('../components/taskeditor/CaptureProposal.tsx')).not.toMatch(/project/i)
  })
})

describe('the Inbox goes by the date, not the project', () => {
  it('an undated to-do is in it whether or not it is filed under LIFE; a date or another status takes it out', () => {
    expect(inInbox(task('1'))).toBe(true)
    expect(inInbox(task('2', { projectId: undefined }))).toBe(true)
    expect(inInbox(task('3', { dueAt: '2026-09-20T09:00:00.000Z' }))).toBe(false)
    for (const status of ['wishlist', 'doing', 'blocked', 'done', 'canceled'] as const) expect(inInbox(task('4', { status })), status).toBe(false)
  })

  it('Today draws its Inbox by that rule and asks only for a date', () => {
    const today = read('../components/Today.tsx')
    expect(today).toContain('open.filter(inInbox)')
    expect(today).toContain("sub: 'Captured, not yet triaged — give each a date'")
    expect(today).not.toMatch(/give each a project|!t\.projectId/)
  })
})

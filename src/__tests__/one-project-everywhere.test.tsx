import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Landing } from '../components/Landing'
import { NotesIndex } from '../components/notes/NotesIndex'
import { NotesView } from '../components/NotesView'
import { ProjectEditor } from '../components/ProjectEditor'
import { Search } from '../components/Search'
import { TaskCard } from '../components/TaskCard'
import { Today } from '../components/Today'
import { buildPaletteCommands } from '../components/planner/commands'
import { CaptureProposal } from '../components/taskeditor/CaptureProposal'
import { inInbox } from '../taskutils'
import { Note, Project, Task } from '../types'
import { plannerSource, sheetSource } from './source'

// There is one ongoing project — the owner's LIFE — so no task row names it,
// nothing starts a second one, and nothing asks which project something
// belongs to. The one project is still edited from a calendar day and from
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

  // the task editor's foot names none either: rendered in taskeditor.dom.test.tsx
})

describe('nothing starts a second project', () => {
  it('the palette has no New project', () => {
    const nav = { goView: noop, setView: noop, openJournal: noop,
    openReview: noop, goTasksTab: noop, setKeepTab: noop, goInnerView: noop, openWardrobe: noop, openStats: noop, openKitchen: noop, openLens: noop }
    const commands = buildPaletteCommands(nav, { newTask: noop, setPushed: noop, openSheet: noop })
    expect(commands.filter(c => /project/i.test(c.label)).map(c => c.label)).toEqual([])
  })

  it('Notes has no "Notes live inside projects" hero', () => {
    const html = renderToStaticMarkup(<NotesView projects={[]} getLatest={() => undefined} onSave={noop} onSelectProject={noop} onBack={noop} onCreateTask={noop} />)
    expect(html).not.toMatch(/Notes live inside projects|New project|<button/)
  })

  it('the shell hands nothing a way to start one', () => {
    expect(plannerSource()).not.toMatch(/newProject|onNewProject/)
    expect(read('../components/NotesView.tsx')).not.toMatch(/onNewProject|\+ New project/)
  })

  it('still opens the one project from a calendar day and from search', () => {
    expect(read('../components/planner/CalendarScreen.tsx')).toContain('onOpenProject={openProject}')
    expect(read('../components/Calendar.tsx')).toMatch(/onOpenProject\(project\)/)
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
  it('the project’s own editor has no progress bar or count of tasks done, and keeps the rest', () => {
    const tasks = [task('1', { status: 'done' }), task('2'), task('3', { status: 'canceled' })]
    const html = renderToStaticMarkup(<ProjectEditor project={LIFE} tasks={tasks} getLatest={() => LIFE} onSave={noop} onDelete={noop} onClose={noop} onOpenNotes={noop} />)
    for (const kept of ['Edit project', 'Name', 'Description', 'Milestones', 'GitHub', 'Open the notepad', 'Delete']) expect(html, kept).toContain(kept)
    expect(html).not.toMatch(/[Pp]rogress|tasks done|1 of 2/)
    expect(read('../components/ProjectEditor.tsx')).not.toMatch(/ProgressBar|projectProgress|project-progress|tasks done/)
    // the bar, its sum and its styles went with it: nothing else drew one
    expect(read('../components/bits.tsx')).not.toContain('ProgressBar')
    expect(read('../types.ts')).not.toContain('projectProgress')
    expect(sheetSource()).not.toMatch(/\.project-progress-row|\.progress-fill|\.progress \{/)
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
    const parse = ai.slice(ai.indexOf('export async function parseCapture'), ai.indexOf('export interface WeekPolishInput'))
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

  describe('on Today', () => {
    // a static render on a fixed morning, with one undated LIFE to-do from this
    // week and one untouched since early August — the owner's older tasks carry LIFE's id
    const NOW = new Date(2026, 8, 14, 9)
    const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
    const fresh = task('fresh', { title: 'Fresh LIFE to-do', createdAt: daysAgo(2), updatedAt: daysAgo(2) })
    const old = task('old', { title: 'Old LIFE to-do', createdAt: daysAgo(40), updatedAt: daysAgo(40) })

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
      // the journal card asks the viewport how wide it is; a static render has none
      if (typeof window === 'undefined') vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
    })
    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    function renderToday(tasks: Task[]): string {
      const props: ComponentProps<typeof Today> = {
        tasks,
        projects: [LIFE],
        people: [],
        places: [],
        reviews: [],
        events: [],
        sourceMap: new Map(),
        meals: [],
        recipes: [],
        journal: [],
        habits: [],
        routines: [],
        onPlanWith: noop,
        onWentTo: noop,
        onPlanAt: noop,
        onPlanOccasion: noop,
        onSaw: noop,
        onSaveReview: noop,
        onPlan: noop,
        onOpen: noop,
        onStatus: noop,
        onDefer: noop,
        onDeferAll: noop,
        onNew: noop,
        onOpenKitchen: noop,
        onOpenReview: noop,
        onCookRecipe: noop,
        onSaveJournal: noop,
        onDeleteJournal: noop,
        onOpenJournal: noop,
        onSaveHabit: noop,
        onDeleteHabit: noop,
        onSaveRoutine: noop,
        onDeleteRoutine: noop,
      }
      return renderToStaticMarkup(<Today {...props} />)
    }

    /** The key of every Today list (`id="today-…"`) with a row for this title. */
    const listsHolding = (html: string, title: string) =>
      [...html.matchAll(/<section[^>]*\bid="today-(\w+)"[\s\S]*?<\/section>/g)].filter(m => m[0].includes(title)).map(m => m[1])

    it('lists a fresh undated LIFE to-do in the Inbox, asking only for a date', () => {
      const html = renderToday([fresh])
      expect(listsHolding(html, 'Fresh LIFE to-do')).toEqual(['inbox'])
      expect(html).toContain('Captured, not yet triaged — give each a date')
      expect(read('../components/Today.tsx')).not.toMatch(/give each a project|!t\.projectId/)
    })

    it('leaves a stale undated to-do off Home — the backlog is Tasks', () => {
      const html = renderToday([fresh, old])
      expect(listsHolding(html, 'Fresh LIFE to-do')).toEqual(['inbox'])
      expect(listsHolding(html, 'Old LIFE to-do')).toEqual([])
      expect(html).toContain('Inbox <span class="board-count">1</span>')
      expect(html).not.toContain('id="today-stale"')
      expect(html).not.toContain('Going stale')
    })

    it('with only stale to-dos there is no Inbox at all', () => {
      const html = renderToday([old])
      expect(listsHolding(html, 'Old LIFE to-do')).toEqual([])
      expect(html).not.toContain('id="today-inbox"')
    })
  })
})

// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from './dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttendancePicker } from '../components/AttendancePicker'
import { colorName } from '../components/ColorSwatches'
import { RecipeForm } from '../components/Kitchen'
import { LogOuting, PlaceForm } from '../components/Places'
import { PersonForm } from '../components/People'
import { ProjectEditor } from '../components/ProjectEditor'
import { Review } from '../components/Review'
import { TaskEditor } from '../components/TaskEditor'
import { TasksTable } from '../components/TasksTable'
import { SnoozeButton, TaskRow, spokenSnooze } from '../components/Today'
import { MealSlotRow } from '../components/MealSlotRow'
import { PROJECT_COLORS, type CalendarEvent, type Person, type Place, type Project, type Task } from '../types'
import { scrollBehavior } from '../utils'

// What a screen reader hears. A row of choices said which one was on only by
// its colour; a colour was a hex code; "1w" was a snooze; five "Mark done"
// boxes in a row said nothing of which task each was; a meal's day was
// "2026-09-24". And a smooth scroll ran whatever Reduce Motion asked.

const STAMP = '2026-09-01T00:00:00.000Z'
const noop = () => {}
const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [], ...over })
const mum: Person = { kind: 'person', id: 'mum', name: 'Mum', color: '#f97316', group: 'family', createdAt: STAMP, updatedAt: STAMP }
const dad: Person = { ...mum, id: 'dad', name: 'Dad' }
const nopi: Place = { kind: 'place', id: 'nopi', name: 'Nopi', category: 'restaurant', color: '#818cf8', createdAt: STAMP, updatedAt: STAMP }
const home: Project = { kind: 'project', id: 'home', name: 'Home', color: '#f97316', status: 'active', createdAt: STAMP, updatedAt: STAMP }

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Which of a group's buttons are pressed, by name. */
const pressed = (group: HTMLElement) =>
  within(group)
    .getAllByRole('button')
    .filter(b => b.getAttribute('aria-pressed') === 'true')
    .map(b => b.textContent?.trim() || b.getAttribute('aria-label'))

describe('a row of choices says which one is on', () => {
  it('the task editor’s Status and Priority', () => {
    render(<TaskEditor task={task('t1', { status: 'doing', priority: 'high' })} projects={[]} people={[]} members={[]} candidates={[]} getLatest={() => undefined} onSave={noop} onCommit={noop} onDelete={noop} onClose={noop} />)
    expect(pressed(screen.getByRole('group', { name: 'Status' }))).toEqual(['Doing'])
    const priority = screen.getByRole('group', { name: 'Priority' })
    expect(pressed(priority)).toEqual(['High'])
    fireEvent.click(within(priority).getByRole('button', { name: 'Low' }))
    expect(pressed(priority)).toEqual(['Low'])
  })

  it('a person’s Group and a place’s Category', () => {
    render(<PersonForm person={mum} onSave={noop} onClose={noop} />)
    expect(pressed(screen.getByRole('group', { name: 'Group' }))).toHaveLength(1)
    document.body.innerHTML = ''
    render(<PlaceForm place={nopi} onSave={noop} onClose={noop} />)
    expect(pressed(screen.getByRole('group', { name: 'Category' }))).toEqual([expect.stringContaining('Restaurant')])
  })

  it('the project’s status', () => {
    render(<ProjectEditor project={home} tasks={[]} getLatest={() => home} onSave={noop} onDelete={noop} onClose={noop} />)
    expect(pressed(screen.getByRole('group', { name: 'Status' }))).toEqual(['Active'])
  })

  it('the people in Went to… and in Who was at…', () => {
    render(<LogOuting place={nopi} people={[mum, dad]} onLog={noop} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mum' }))
    expect(screen.getByRole('button', { name: 'Mum' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Dad' }).getAttribute('aria-pressed')).toBe('false')
    document.body.innerHTML = ''
    const event: CalendarEvent = { id: 'e1', sourceId: 'family', title: 'Lunch', start: '2026-09-20T12:00:00.000Z', end: '2026-09-20T13:00:00.000Z', allDay: false }
    render(<AttendancePicker event={event} people={[mum, dad]} onDone={noop} onClose={noop} />)
    const who = screen.getByRole('group', { name: 'Who was there' })
    fireEvent.click(within(who).getByRole('button', { name: 'Dad' }))
    expect(pressed(who)).toEqual(['Dad'])
  })

  it('the list’s sort on a phone', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width: 640px'), addEventListener: noop, removeEventListener: noop }))
    render(<TasksTable tasks={[task('t1')]} onOpen={noop} onNew={noop} onDelete={noop} />)
    const sort = screen.getByRole('group', { name: 'Sort by' })
    expect(pressed(sort)).toEqual(['Due ▲'])
    fireEvent.click(within(sort).getByRole('button', { name: 'Prio' }))
    expect(pressed(sort)).toEqual(['Prio ▼'])
  })
})

describe('what a control is called', () => {
  it('a colour swatch by its colour, the chosen one pressed', () => {
    render(<PersonForm person={mum} onSave={noop} onClose={noop} />)
    const colors = screen.getByRole('group', { name: 'Color' })
    expect(within(colors).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Orange', 'Yellow', 'Green', 'Cyan', 'Indigo', 'Pink', 'Red', 'Grey'])
    expect(pressed(colors)).toEqual(['Orange'])
    // one name for every swatch there is, and never a code
    expect(PROJECT_COLORS.map(colorName).every(name => !name.startsWith('#'))).toBe(true)
  })

  it('a recipe’s ingredient boxes, by what each holds and its row', () => {
    render(<RecipeForm onSave={noop} onClose={noop} />)
    for (const name of ['Ingredient 1: amount', 'Ingredient 1: unit', 'Ingredient 1: what it is']) expect(screen.getByRole('textbox', { name })).toBeTruthy()
  })

  it('a snooze by how long, as it is said', () => {
    render(<SnoozeButton label="Mum" onPick={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Put Mum off for a while' }))
    const options = within(screen.getByRole('group', { name: 'Put Mum off for' })).getAllByRole('button')
    expect(options.map(b => b.getAttribute('aria-label'))).toEqual(['1 week', '2 weeks', '1 month', '3 months', 'Keep asking'])
    expect(options[0].textContent).toBe('1w')
    expect(spokenSnooze(90)).toBe('3 months')
  })

  it('each Mark done box by its task, on Home and on the review', () => {
    render(<TaskRow task={task('t1', { title: 'Fix the fence' })} onOpen={noop} onStatus={noop} />)
    expect(screen.getByRole('checkbox', { name: 'Mark “Fix the fence” done' })).toBeTruthy()
    document.body.innerHTML = ''
    render(<TaskRow task={task('t1', { title: 'Fix the fence', status: 'done' })} onOpen={noop} onStatus={noop} />)
    expect(screen.getByRole('checkbox', { name: 'Reopen “Fix the fence”' })).toBeTruthy()
    document.body.innerHTML = ''
    const late = task('t2', { title: 'Clear the gutters', dueAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })
    render(<Review tasks={[late]} projects={[]} people={[]} reviews={[]} journal={[]} places={[]} habits={[]} onSaveReview={noop} onOpen={noop} onStatus={noop} onDeferAll={noop} onStatusAll={noop} onNew={noop} />)
    expect(screen.getByRole('checkbox', { name: 'Mark “Clear the gutters” done' })).toBeTruthy()
  })

  it('a meal’s day as it is said, not as a key', () => {
    render(<MealSlotRow date="2026-09-24" slot="dinner" recipes={[]} places={[]} onSave={noop} onClear={noop} onCreatePlace={() => nopi} />)
    expect(screen.getByRole('button', { name: 'Dinner on Thursday, September 24: choose' })).toBeTruthy()
  })
})

describe('Reduce Motion', () => {
  it('turns the app’s own smooth scrolls into a jump', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }))
    expect(scrollBehavior()).toBe('auto')
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    expect(scrollBehavior()).toBe('smooth')
  })
})

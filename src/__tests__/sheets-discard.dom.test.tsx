// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from './dom'
import { describe, expect, it, vi } from 'vitest'

// The sheets you type into ask before throwing it away. Each is opened, has
// something typed or picked in it, and is closed from its Cancel: the one
// in-app "Discard changes?" comes up and the sheet stays until Discard. One
// opened and closed untouched goes at once, with no question.

import { NoteSheet } from '../components/ChatCards'
import { EventEditor } from '../components/EventEditor'
import { RecipeForm } from '../components/Kitchen'
import { MealPlanSheet } from '../components/MealPlanSheet'
import { LogVisit, PersonForm } from '../components/People'
import { LogOuting, PlaceForm } from '../components/Places'
import { PlanDaySheet } from '../components/PlanDaySheet'
import { ProjectEditor } from '../components/ProjectEditor'
import { ShutdownSheet } from '../components/ShutdownSheet'
import { WeekPlanSheet } from '../components/WeekPlanSheet'
import { weekDayKeys } from '../../shared/weeks.mts'
import type { WeekPlan } from '../../shared/weekplan.mts'
import type { Person, Place, Project, Recipe, Task } from '../types'

const STAMP = '2026-09-01T00:00:00.000Z'
const noop = () => {}
const mum: Person = { kind: 'person', id: 'mum', name: 'Mum', color: '#f97316', group: 'family', createdAt: STAMP, updatedAt: STAMP }
const nopi: Place = { kind: 'place', id: 'nopi', name: 'Nopi', category: 'restaurant', color: '#6366f1', createdAt: STAMP, updatedAt: STAMP }
const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [], ...over })

const question = () => screen.queryByRole('alertdialog', { name: 'Discard changes?' })
const cancel = () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
const typeInto = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } })

/** Cancel on a changed sheet: asked, kept on Keep editing, closed once on Discard. */
function asksThenCloses(onClose: ReturnType<typeof vi.fn>) {
  cancel()
  expect(question()).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  expect(onClose).not.toHaveBeenCalled()
  cancel()
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
  expect(onClose).toHaveBeenCalledTimes(1)
}

describe('a sheet with something typed in it asks before Cancel throws it away', () => {
  it('the event editor', () => {
    const onClose = vi.fn()
    render(<EventEditor defaultStartIso={new Date(2026, 8, 25, 10).toISOString()} people={[]} onSave={noop} onClose={onClose} />)
    typeInto(screen.getByRole('textbox', { name: 'Title' }), 'Dentist')
    asksThenCloses(onClose)
  })

  it('a person', () => {
    const onClose = vi.fn()
    render(<PersonForm onSave={noop} onClose={onClose} />)
    typeInto(screen.getByRole('textbox', { name: 'Name' }), 'Auntie Jo')
    asksThenCloses(onClose)
  })

  it('Saw…', () => {
    const onClose = vi.fn()
    render(<LogVisit person={mum} places={[]} onLog={noop} onClose={onClose} />)
    typeInto(screen.getByRole('textbox', { name: 'What did you do?' }), 'Sunday lunch')
    asksThenCloses(onClose)
  })

  it('a place', () => {
    const onClose = vi.fn()
    render(<PlaceForm onSave={noop} onClose={onClose} />)
    typeInto(screen.getByRole('textbox', { name: 'Name' }), 'Franco’s')
    asksThenCloses(onClose)
  })

  it('Went to…', () => {
    const onClose = vi.fn()
    render(<LogOuting place={nopi} people={[mum]} onLog={noop} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mum' }))
    asksThenCloses(onClose)
  })

  it('a recipe', () => {
    const onClose = vi.fn()
    render(<RecipeForm onSave={noop} onClose={onClose} />)
    typeInto(screen.getByRole('textbox', { name: 'Name' }), 'Friday pizza')
    asksThenCloses(onClose)
  })

  it('a new note from the assistant', () => {
    const onClose = vi.fn()
    render(<NoteSheet action={{ type: 'create_note', title: 'Gift ideas', text: 'Scarf' }} id="n1" onSave={noop} onClose={onClose} />)
    typeInto(screen.getByRole('textbox', { name: 'Note title' }), 'Gift ideas for Mum')
    asksThenCloses(onClose)
  })

  it('Plan this week’s meals', () => {
    const onClose = vi.fn()
    const now = new Date(2026, 8, 21, 12)
    render(
      <MealPlanSheet
        week={{ key: '2026-W38', start: new Date(2026, 8, 20), label: 'This week' }}
        items={[]}
        recipes={[]}
        places={[]}
        meals={[]}
        onCreatePlace={() => nopi}
        onCreateRecipe={() => {
          throw new Error('not here')
        }}
        onApply={() => null}
        onClose={onClose}
        now={now}
      />,
    )
    typeInto(screen.getByRole('textbox', { name: 'What would you like this week?' }), 'Something light')
    asksThenCloses(onClose)
  })

  it('Plan next week', () => {
    const onClose = vi.fn()
    const plan: WeekPlan = {
      week: { startKey: '2026-09-27', dayKeys: weekDayKeys('2026-09-27'), weekKey: '2026-W39', prevWeekKey: '2026-W38' },
      dinners: [],
      people: [],
      overdue: [{ key: 'resched:t1', taskId: 't1', title: 'Fix the fence', fromDue: '2026-09-10T09:00:00.000Z', toDay: '2026-09-28', why: 'Overdue' }],
      bills: [],
      top3: [],
    }
    render(<WeekPlanSheet plan={plan} recipes={[]} places={[]} people={[]} meals={[]} tasks={[]} onCreatePlace={() => nopi} onApply={noop} onClose={onClose} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Move “Fix the fence”' }))
    asksThenCloses(onClose)
  })

  it('Plan my day, from its Cancel and its backdrop alike', () => {
    const onClose = vi.fn()
    render(
      <PlanDaySheet
        tasks={[task('bins', { title: 'Put the bins out', dueAt: new Date(2026, 8, 14).toISOString() })]}
        projects={[]}
        reviews={[]}
        events={[]}
        today="2026-09-14"
        now={new Date(2026, 8, 14, 9)}
        myId="me"
        onApply={noop}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^Put the bins out — / }))
    fireEvent.mouseDown(document.querySelector('.modal-backdrop')!)
    expect(question()).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    asksThenCloses(onClose)
  })

  it('Shut down', () => {
    const onClose = vi.fn()
    render(
      <ShutdownSheet
        tasks={[task('bins', { title: 'Put the bins out', dueAt: new Date(2026, 8, 14).toISOString() })]}
        projects={[]}
        reviews={[]}
        routines={[]}
        journal={[]}
        people={[]}
        today="2026-09-14"
        tomorrow="2026-09-15"
        myId="me"
        onSaveRoutine={noop}
        onSaveJournal={noop}
        onDeleteJournal={noop}
        onApply={noop}
        onClose={onClose}
      />,
    )
    fireEvent.click(within(screen.getByRole('group', { name: 'Move “Put the bins out” to' })).getAllByRole('button')[0])
    asksThenCloses(onClose)
  })
})

describe('an untouched sheet', () => {
  it('closes from Cancel at once, with no question', () => {
    const onClose = vi.fn()
    render(<PersonForm person={mum} onSave={noop} onClose={onClose} />)
    cancel()
    expect(question()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('one header layout', () => {
  const home: Project = { kind: 'project', id: 'home', name: 'Home', color: '#f97316', status: 'active', createdAt: STAMP, updatedAt: STAMP }
  const tacos: Recipe = { kind: 'recipe', id: 'tacos', name: 'Tacos', ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP }
  const sheets: [string, () => React.ReactElement, string][] = [
    ['New event', () => <EventEditor defaultStartIso={new Date(2026, 8, 25, 10).toISOString()} people={[]} onSave={noop} onClose={noop} />, 'Save'],
    ['Add a person', () => <PersonForm onSave={noop} onClose={noop} />, 'Save'],
    ['Edit Mum', () => <PersonForm person={mum} onSave={noop} onDelete={noop} onClose={noop} />, 'Save'],
    ['Saw Mum', () => <LogVisit person={mum} places={[]} onLog={noop} onClose={noop} />, 'Log it'],
    ['Add a place', () => <PlaceForm onSave={noop} onClose={noop} />, 'Save'],
    ['Went to Nopi', () => <LogOuting place={nopi} people={[]} onLog={noop} onClose={noop} />, 'Log it'],
    ['Edit Tacos', () => <RecipeForm recipe={tacos} onSave={noop} onDelete={noop} onClose={noop} />, 'Save'],
    ['New note', () => <NoteSheet action={{ type: 'create_note', title: 'Gifts', text: '' }} id="n1" onSave={noop} onClose={noop} />, 'Save'],
    ['Edit project', () => <ProjectEditor project={home} tasks={[]} getLatest={() => home} onSave={noop} onDelete={noop} onClose={noop} />, 'Save'],
  ]

  it.each(sheets)('%s: Cancel, the title, then its Save, in the title bar and nowhere else', (title, sheet, save) => {
    render(sheet())
    const head = document.querySelector('.modal-head') as HTMLElement
    expect(head.classList.contains('modal-head-compose')).toBe(true)
    const parts = Array.from(head.children).map(el => (el.tagName === 'H2' ? `h2:${el.textContent}` : el.textContent))
    expect(parts).toEqual(['Cancel', `h2:${title}`, save])
    expect(within(screen.getByRole('dialog', { name: title })).getAllByRole('button', { name: save })).toHaveLength(1)
    expect(within(screen.getByRole('dialog', { name: title })).getAllByRole('button', { name: 'Cancel' })).toHaveLength(1)
  })
})

// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from './dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Garment, Project } from '../types'

// Screens the React Compiler compiles now, where it used to leave them as
// written: each is mounted as the compiler builds it (every DOM test runs its
// output), so a clock it reads as it draws, or an effect it runs once per
// ask, is held to what the screen did before.

vi.mock('../media', () => ({ mediaURL: async () => 'blob:photo', saveMedia: async () => 'm1', deleteMedia: async () => {} }))
vi.mock('../cutout', () => ({ isCutOutPhoto: async () => false, cutoutAvailability: async () => 'web' }))

import { Calendar } from '../components/Calendar'
import { NotesView } from '../components/NotesView'
import { CutoutLater, keptOffline } from '../components/wardrobe/CutoutLater'

const noop = () => {}
const T0 = '2026-09-01T09:00:00.000Z'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

type CalendarProps = Parameters<typeof Calendar>[0]
const calendar = (over: Partial<CalendarProps> = {}): CalendarProps => ({
  view: 'month',
  tasks: [],
  projects: [],
  projectMap: new Map(),
  people: [],
  meals: [],
  recipes: [],
  places: [],
  events: [],
  sourceMap: new Map(),
  onOpen: noop,
  onNew: noop,
  onSaveMeal: noop,
  onClearMeal: noop,
  onCreatePlace: () => {
    throw new Error('not here')
  },
  onCreateRecipe: () => {
    throw new Error('not here')
  },
  onNewEvent: noop,
  onEditEvent: noop,
  onReschedule: noop,
  onPlan: noop,
  onAttendance: noop,
  onOpenProject: noop,
  onPlanOccasion: noop,
  ...over,
})

describe('the Calendar', () => {
  const ringed = () => document.querySelector('.cal-cell.today .cal-daynum')?.textContent

  it('moves the today ring at midnight, with nothing else drawing it again', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date(2026, 8, 23, 23, 58))
    render(<Calendar {...calendar()} />)
    expect(ringed()).toBe('23')
    act(() => void vi.advanceTimersByTime(3 * 60_000))
    expect(ringed()).toBe('24')
  })

  it('says a day asked for was taken once per ask, however often the shell hands it a new setter', () => {
    const taken = vi.fn()
    const view = render(<Calendar {...calendar({ openDay: '2026-09-10', onOpenDayConsumed: () => taken() })} />)
    expect(taken).toHaveBeenCalledTimes(1)
    // the shell draws again, the same day still asked for, with a new function
    view.rerender(<Calendar {...calendar({ openDay: '2026-09-10', onOpenDayConsumed: () => taken() })} />)
    expect(taken).toHaveBeenCalledTimes(1)
    // let go, then asked for again: taken again
    view.rerender(<Calendar {...calendar({ openDay: null, onOpenDayConsumed: () => taken() })} />)
    view.rerender(<Calendar {...calendar({ openDay: '2026-09-10', onOpenDayConsumed: () => taken() })} />)
    expect(taken).toHaveBeenCalledTimes(2)
  })
})

describe('a project’s notes pad', () => {
  const pad = (over: Partial<Project> = {}): Project => ({ kind: 'project', id: 'p1', name: 'Home', color: '#f97316', status: 'active', notesHtml: '<p>Paint the hall</p>', createdAt: T0, updatedAt: T0, ...over })

  it('left straight after typing, saves the words onto the newest copy, not the one it opened on', () => {
    const saved: Project[] = []
    const opened = pad()
    const props = { projects: [opened], onSave: (p: Project) => void saved.push(p), onSelectProject: noop, onBack: noop, onCreateTask: noop }
    const view = render(<NotesView {...props} project={opened} getLatest={() => opened} />)
    // pinned meanwhile — here, or on the other phone — as the pad stays open
    const pinned = pad({ notesPinned: true, updatedAt: '2026-09-01T10:00:00.000Z' })
    view.rerender(<NotesView {...props} projects={[pinned]} project={pinned} getLatest={() => pinned} />)
    const editor = document.querySelector('.notes-editable') as HTMLElement
    editor.innerHTML = '<p>Paint the hall sage</p>'
    fireEvent.input(editor)
    // gone before the autosave: the words are saved as the pad unmounts
    view.unmount()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ id: 'p1', notesPinned: true, notesHtml: '<p>Paint the hall sage</p>' })
  })
})

describe('Cut out later, on a piece’s sheet', () => {
  const tee: Garment = { kind: 'garment', id: 'g1', name: 'Tee', type: 'top', photoId: 'p1', thumbId: 't1', createdAt: T0, updatedAt: T0 }

  it('says Cut out now as soon as its photo is noted as kept offline, with nothing else drawing it again', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Blob(['x'], { type: 'image/jpeg' })))
    render(<CutoutLater garment={tee} onCutout={noop} />)
    expect(await screen.findByRole('button', { name: 'Cut out background' })).toBeTruthy()
    act(() => keptOffline('p1'))
    expect(screen.getByRole('button', { name: 'Cut out now' })).toBeTruthy()
  })
})

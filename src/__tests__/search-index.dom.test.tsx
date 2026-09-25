// @vitest-environment happy-dom
import { fireEvent, render, screen } from './dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Search, searchIndex } from '../components/Search'
import type { Note, Project, Task } from '../types'

// The palette searches as you type, and every keystroke used to read every
// note's and project pad's HTML as text again (a DOMParser each) and lowercase
// every task's title, description, tags, comments and steps. It builds that
// index when the lists change now, and a keystroke only looks the words up.

const T0 = '2026-09-12T09:00:00.000Z'
const task = (id: string, title: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title, description: '', status: 'todo', priority: 'normal', tags: [], createdAt: T0, updatedAt: T0, ...over })
const note = (id: string, title: string, body: string): Note => ({ kind: 'note', id, title, body, createdAt: T0, updatedAt: T0 })
const home = { kind: 'project', id: 'home', name: 'Home', color: '#f97316', status: 'active', notesHtml: '<p>Paint the <b>shed</b> in spring</p>', createdAt: T0, updatedAt: T0 } as Project

const TASKS = [
  task('t1', 'Paint the hall', { description: 'Two coats of sage', tags: ['Decorating'] }),
  task('t2', 'Buy brushes', { description: 'For the PAINT job', comments: [{ id: 'c', body: 'Wide ones', createdAt: T0 }] as Task['comments'] }),
  task('t3', 'Call Sam', { checklist: [{ id: 's', text: 'Ask about paint colours', done: false }] as Task['checklist'] }),
]
const NOTES = [note('n1', 'Colours', '<p>Sage for the hall, <em>paint</em> samples in the drawer</p>'), note('n2', 'Garden', '<p>Beds by the fence</p>')]

const noop = () => {}
const field = () => screen.getByRole('combobox', { name: 'Search' })
const rows = () => screen.queryAllByRole('option').map(o => o.textContent)
const typeIn = (value: string) => fireEvent.change(field(), { target: { value } })

afterEach(() => {
  vi.restoreAllMocks()
})

function palette(over: Partial<Parameters<typeof Search>[0]> = {}) {
  const props = { tasks: TASKS, projects: [home], people: [], notes: NOTES, onOpenTask: noop, onOpenProject: noop, onOpenPerson: noop, onOpenNote: noop, onCreateTask: noop, onClose: noop, ...over }
  return { props, ...render(<Search {...props} />) }
}

describe('the palette’s index', () => {
  it('reads each note’s and the project pad’s HTML once, however many keys are typed', () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString')
    palette()
    const built = parse.mock.calls.length
    // the two notes and the project's pad
    expect(built).toBe(3)
    for (const q of ['p', 'pa', 'pai', 'pain', 'paint', 'paint ', 'paint t']) typeIn(q)
    expect(parse).toHaveBeenCalledTimes(built)
    expect(rows().length).toBeGreaterThan(0)
  })

  it('finds and ranks as it did: a title first, then a description, a tag, a comment, a step, a note and the pad', () => {
    palette()
    typeIn('paint')
    const found = rows()
    expect(found[0]).toMatch(/^＋Create task “paint”/)
    expect(found[1]).toMatch(/^Paint the hall/)
    expect(found.some(r => r?.startsWith('Buy brushes') && r.includes('For the PAINT job'))).toBe(true)
    expect(found.some(r => r?.startsWith('Call Sam') && r.includes('in checklist'))).toBe(true)
    expect(found.some(r => r?.includes('📝Colours') && r.includes('paint samples in the drawer'))).toBe(true)
    expect(found.some(r => r?.includes('Home') && r.includes('in notes'))).toBe(true)
  })

  it('puts Create task below the hits when a task has exactly that title, as it did', () => {
    palette()
    typeIn('  Buy Brushes ')
    const found = rows()
    expect(found[0]).toMatch(/^Buy brushes/)
    expect(found.at(-1)).toMatch(/^＋Create task “Buy Brushes”/)
  })

  it('follows the lists: a note that arrives while the palette is open is found', () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString')
    const { props, rerender } = palette()
    typeIn('fence')
    expect(rows().some(r => r?.includes('📝Garden'))).toBe(true)
    expect(rows().some(r => r?.includes('📝Shed plans'))).toBe(false)
    const before = parse.mock.calls.length
    rerender(<Search {...props} notes={[...NOTES, note('n3', 'Shed plans', '<p>Against the fence</p>')]} />)
    expect(rows().some(r => r?.includes('📝Shed plans'))).toBe(true)
    // the new list is read once, and the query did not read it again
    expect(parse.mock.calls.length - before).toBe(3)
  })

  it('reads no note when notes cannot be opened from here', () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString')
    palette({ onOpenNote: undefined })
    typeIn('paint')
    // the project's pad only
    expect(parse).toHaveBeenCalledTimes(1)
    expect(rows().some(r => r?.includes('📝Colours'))).toBe(false)
  })
})

describe('searchIndex', () => {
  it('holds each haystack lowercased, and what is shown as written', () => {
    const index = searchIndex({ tasks: TASKS, projects: [home], people: [], places: [], journal: [], notes: NOTES, garments: [], outfits: [] })
    expect(index.tasks.entries[1]).toMatchObject({ title: 'buy brushes', description: { raw: 'For the PAINT job', low: 'for the paint job' }, comments: 'wide ones' })
    expect(index.projects[0].notes).toBe('paint the shed in spring')
    expect(index.notes.map(n => n.text.raw)).toEqual(['Sage for the hall, paint samples in the drawer', 'Beds by the fence'])
    expect(index.tasks.titles.has('buy brushes')).toBe(true)
  })
})

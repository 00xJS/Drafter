import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drawLists, LISTS, type DrawnLists } from '../kindlists'
import { newerStamp } from '../itemops'
import { groupByKind } from '../syncengine'
import { Garment, JournalEntry, Meal, Note, Recipe, Task } from '../types'
import { editTask, recordDevice, settle } from './record-fakes'
import { FakeServer, task } from './sync-fakes'

// The lists every view renders are drawn from one kind's array each, and a
// kind's array is replaced only when a record of that kind changed. Editing a
// task hands Kitchen the very recipes array it had — and every list but the
// tasks is the one drawn before.

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

const T = '2026-09-01T00:00:00.000Z'
const recipe = (id: string, name = id): Recipe => ({ kind: 'recipe', id, name, ingredients: [], tags: [], createdAt: T, updatedAt: T }) as Recipe
const meal = (id: string, over: Partial<Meal> = {}): Meal => ({ kind: 'meal', id, date: '2026-09-10', slot: 'dinner', title: 'Pasta', createdAt: T, updatedAt: T, ...over }) as Meal
const journal = (id: string, over: Partial<JournalEntry> = {}): JournalEntry => ({ kind: 'journal', id, date: '2026-09-09', body: 'Quiet day', createdAt: T, updatedAt: T, ...over }) as JournalEntry
const note = (id: string, over: Partial<Note> = {}): Note => ({ kind: 'note', id, title: id, html: '', createdAt: T, updatedAt: T, ...over }) as Note
const garment = (id: string, over: Partial<Garment> = {}): Garment => ({ kind: 'garment', id, name: id, type: 'top', createdAt: T, updatedAt: T, ...over }) as Garment

describe('the engine keeps one array per kind', () => {
  it('replaces only the array of the kind that changed', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'), recipe('pasta'), recipe('soup'), meal('meal~2026-09-10~dinner~me'))
    const d = recordDevice(server)
    await settle(d)
    const before = d.engine.getState().byKind
    expect(before.recipe.map(r => r.name)).toEqual(['pasta', 'soup'])

    editTask(d, 'a', { title: 'Buy paint' })
    const after = d.engine.getState().byKind
    expect(after.task).not.toBe(before.task)
    expect(after.task.find(t => t.id === 'a')!.title).toBe('Buy paint')
    expect(after.recipe).toBe(before.recipe)
    expect(after.meal).toBe(before.meal)
    expect(after.person).toBe(before.person)
  })

  it('a round that brings nothing leaves every array — and the arrays object — as it was', async () => {
    const server = new FakeServer()
    server.seed(task('a'), recipe('pasta'))
    const d = recordDevice(server)
    await settle(d)
    const before = d.engine.getState()
    await d.engine.sync()
    const after = d.engine.getState()
    expect(after.syncInfo.lastAt).toBeDefined()
    expect(after.items).toBe(before.items)
    expect(after.byKind).toBe(before.byKind)
  })

  it('a round that brings a recipe replaces the recipes, and nothing else', async () => {
    const server = new FakeServer()
    server.seed(task('a'), recipe('pasta'))
    const d = recordDevice(server)
    await settle(d)
    const before = d.engine.getState().byKind
    server.patch('pasta', { name: 'Pasta bake', updatedAt: '2026-09-10T09:00:00.000Z' })
    await d.engine.sync()
    const after = d.engine.getState().byKind
    expect(after.recipe).not.toBe(before.recipe)
    expect(after.task).toBe(before.task)
  })

  it('a record that leaves takes its kind with it, and a kind with none is the one shared empty array', () => {
    const lists = groupByKind([task('a'), recipe('pasta')], null)
    const next = groupByKind([task('a')], new Set(['recipe']), lists)
    expect(next.recipe).toEqual([])
    expect(next.recipe).toBe(next.person)
    expect(next.task).toBe(lists.task)
  })
})

describe('the lists drawn from them', () => {
  const draw = (items: Parameters<typeof groupByKind>[0], myId: string | null = 'me', prev?: DrawnLists) => drawLists(groupByKind(items, null), myId, prev)

  it('editing a task keeps the recipes array, and every list but the tasks', () => {
    const items = [task('a'), task('b'), recipe('soup'), recipe('pasta'), meal('m1'), note('n1')]
    const first = drawLists(groupByKind(items, null), 'me')
    const edited = { ...task('a'), title: 'Buy paint', updatedAt: newerStamp(T) } as Task
    const nextItems = [edited, ...items.slice(1)]
    const byKind = groupByKind(nextItems, new Set(['task']), first.byKind)
    const second = drawLists(byKind, 'me', first)
    expect(second.rebuilt).toEqual(['tasks'])
    expect(second.lists.recipes).toBe(first.lists.recipes)
    expect(second.lists.meals).toBe(first.lists.meals)
    expect(second.lists.notes).toBe(first.lists.notes)
    expect(second.lists.tasks).not.toBe(first.lists.tasks)
    expect(second.lists.tasks.map(t => t.title)).toEqual(['Buy paint', 'b'])
    // same inputs again: the drawing itself, untouched
    expect(drawLists(byKind, 'me', second)).toBe(second)
  })

  it('a garment edit redraws both garment lists — the live ones and the Trash — and nothing else', () => {
    const first = draw([garment('tee'), garment('old', { deletedAt: T }), recipe('pasta')])
    expect(first.lists.garments.map(g => g.id)).toEqual(['tee'])
    expect(first.lists.garmentsInTrash.map(g => g.id)).toEqual(['old'])
    const byKind = groupByKind([garment('tee', { name: 'White tee' }), garment('old', { deletedAt: T }), recipe('pasta')], new Set(['garment']), first.byKind)
    expect(drawLists(byKind, 'me', first).rebuilt.sort()).toEqual(['garments', 'garmentsInTrash'])
  })

  it('a new account redraws the lists that ask whose a record is, and only those', () => {
    const first = draw([task('a'), recipe('pasta'), journal('j1', { ownerId: 'me' }), journal('j2', { ownerId: 'peer' })], 'me')
    expect(first.lists.journal.map(j => j.id)).toEqual(['j1'])
    const second = drawLists(first.byKind, 'peer', first)
    expect(second.lists.journal.map(j => j.id)).toEqual(['j2'])
    expect(second.lists.recipes).toBe(first.lists.recipes)
    expect(second.lists.tasks).toBe(first.lists.tasks)
    const personal = Object.entries(LISTS)
      .filter(([, s]) => 'mine' in s && s.mine)
      .map(([name]) => name)
    expect(second.rebuilt.sort()).toEqual(personal.sort())
  })

  it('draws what the store always drew: live records, in each list’s own order, a peer’s personal ones never', () => {
    const lists = draw(
      [
        task('a'),
        task('gone', { deletedAt: T }),
        recipe('soup'),
        recipe('pasta'),
        note('plain', { updatedAt: '2026-09-05T00:00:00.000Z' }),
        note('pinned', { pinned: true }),
        journal('mine', { ownerId: 'me', date: '2026-09-01' }),
        journal('newer', { ownerId: 'me', date: '2026-09-08' }),
        journal('theirs', { ownerId: 'peer' }),
        meal('shared', { ownerId: 'peer' }),
        meal('kept', { ownerId: 'peer', shared: false }),
      ],
      'me',
    ).lists
    expect(lists.tasks.map(t => t.id)).toEqual(['a'])
    expect(lists.recipes.map(r => r.id)).toEqual(['pasta', 'soup'])
    expect(lists.notes.map(n => n.id)).toEqual(['pinned', 'plain'])
    expect(lists.journal.map(j => j.id)).toEqual(['newer', 'mine'])
    expect(lists.meals.map(m => m.id)).toEqual(['shared'])
  })
})

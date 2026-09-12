import { describe, expect, it } from 'vitest'
import { applyLocalChoice, mergeRecord, same, sameContent } from '../../shared/merge.mjs'
import { GroceryList, Habit, Routine, Task } from '../types'

const T0 = '2026-09-10T09:00:00.000Z'

function task(over: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id: 't1',
    title: 'Buy paint',
    description: '',
    status: 'todo',
    priority: 'normal',
    createdAt: T0,
    updatedAt: T0,
    tags: [],
    checklist: [
      { id: 'c1', text: 'Pick a colour', done: false },
      { id: 'c2', text: 'Go to the shop', done: false },
    ],
    ...over,
  }
}

function grocery(items: GroceryList['items'], over: Partial<GroceryList> = {}): GroceryList {
  return { kind: 'grocery', id: 'grocery~2026-W37', weekKey: '2026-W37', items, createdAt: T0, updatedAt: T0, ...over }
}

const line = (name: string, state: 'need' | 'have' | 'done' = 'need', over: object = {}) => ({ id: `g~${name.toLowerCase()}|`, name, state, recipeIds: [], ...over })

describe('three-way merge of one record', () => {
  it('keeps a title edited here and a checklist tick made there', () => {
    const base = task()
    const local = task({ title: 'Buy blue paint', updatedAt: '2026-09-10T09:05:00.000Z' })
    const remote = task({ checklist: [{ ...base.checklist![0], done: true }, base.checklist![1]], updatedAt: '2026-09-10T09:06:00.000Z' })
    const { merged, conflicts } = mergeRecord(base, local, remote)
    expect(merged.title).toBe('Buy blue paint')
    expect(merged.checklist?.map(c => c.done)).toEqual([true, false])
    expect(conflicts).toEqual([])
  })

  it('lets the other device win a field both changed, and says which', () => {
    const base = task()
    const local = task({ title: 'Buy blue paint' })
    const remote = task({ title: 'Buy green paint' })
    const { merged, conflicts } = mergeRecord(base, local, remote)
    expect(merged.title).toBe('Buy green paint')
    expect(conflicts).toEqual([{ path: ['title'], local: 'Buy blue paint', remote: 'Buy green paint' }])
    // Keep mine puts this device's value back
    expect(applyLocalChoice(merged, conflicts).title).toBe('Buy blue paint')
  })

  it('merges a checklist line field by field, and Keep mine reaches into the line', () => {
    const base = task()
    const local = task({ checklist: [{ id: 'c1', text: 'Pick a colour (blue)', done: false }, base.checklist![1]] })
    const remote = task({ checklist: [{ id: 'c1', text: 'Pick a colour (green)', done: true }, base.checklist![1]] })
    const { merged, conflicts } = mergeRecord(base, local, remote)
    expect(merged.checklist![0]).toEqual({ id: 'c1', text: 'Pick a colour (green)', done: true })
    expect(conflicts).toEqual([{ path: ['checklist', 'c1', 'text'], local: 'Pick a colour (blue)', remote: 'Pick a colour (green)' }])
    expect(applyLocalChoice(merged, conflicts).checklist![0]).toEqual({ id: 'c1', text: 'Pick a colour (blue)', done: true })
  })

  it('keeps lines added on both sides, in place', () => {
    const base = task()
    const local = task({ checklist: [...base.checklist!, { id: 'mine', text: 'Buy brushes', done: false }] })
    const remote = task({ checklist: [{ id: 'theirs', text: 'Clear the room', done: false }, ...base.checklist!] })
    const { merged } = mergeRecord(base, local, remote)
    expect(merged.checklist!.map(c => c.id)).toEqual(['theirs', 'c1', 'c2', 'mine'])
  })

  it('honours a deletion the other side did not touch, and refuses one it did', () => {
    const base = task()
    // this device deleted c2; the other ticked c1 and left c2 alone
    const a = mergeRecord(base, task({ checklist: [base.checklist![0]] }), task({ checklist: [{ ...base.checklist![0], done: true }, base.checklist![1]] }))
    expect(a.merged.checklist).toEqual([{ id: 'c1', text: 'Pick a colour', done: true }])
    // this device deleted c2; the other edited it — the edit survives
    const b = mergeRecord(base, task({ checklist: [base.checklist![0]] }), task({ checklist: [base.checklist![0], { ...base.checklist![1], done: true }] }))
    expect(b.merged.checklist!.map(c => c.id)).toEqual(['c1', 'c2'])
  })

  it('takes the reordered list from the side that reordered it', () => {
    const steps = [
      { id: 's1', text: 'Water' },
      { id: 's2', text: 'Stretch' },
      { id: 's3', text: 'Coffee' },
    ]
    const routine = (over: Partial<Routine>): Routine => ({ kind: 'routine', id: 'r', name: 'Morning', when: 'morning', steps, ticks: [], createdAt: T0, updatedAt: T0, ...over })
    const local = routine({ steps: [steps[2], steps[0], steps[1]] })
    const remote = routine({ ticks: ['2026-09-10|s1'] })
    const { merged } = mergeRecord(routine({}), local, remote)
    expect(merged.steps.map(s => s.id)).toEqual(['s3', 's1', 's2'])
    expect(merged.ticks).toEqual(['2026-09-10|s1'])
  })

  it('merges string sets: ticks from both devices survive, an untick stays unticked', () => {
    const habit = (done: string[]): Habit => ({ kind: 'habit', id: 'h', name: 'Walk', done, createdAt: T0, updatedAt: T0 })
    const base = habit(['2026-09-01', '2026-09-02'])
    const local = habit(['2026-09-01', '2026-09-02', '2026-09-09'])
    const remote = habit(['2026-09-01', '2026-09-10']) // ticked the 10th, unticked the 2nd
    expect(mergeRecord(base, local, remote).merged.done).toEqual(['2026-09-01', '2026-09-09', '2026-09-10'])
  })

  it('a purge beats any edit, from either side', () => {
    const base = task()
    const purged = task({ title: '', checklist: undefined, purged: true, deletedAt: T0 })
    expect(mergeRecord(base, task({ title: 'edited' }), purged).merged.purged).toBe(true)
    const mine = mergeRecord(base, purged, task({ title: 'edited there' }))
    expect(mine.merged.purged).toBe(true)
    expect(mine.merged.title).toBe('')
  })

  it('a soft delete on one side keeps the other side’s edits, so Restore brings the latest back', () => {
    const base = task()
    const { merged } = mergeRecord(base, task({ deletedAt: '2026-09-10T09:05:00.000Z' }), task({ title: 'Buy blue paint' }))
    expect(merged.deletedAt).toBe('2026-09-10T09:05:00.000Z')
    expect(merged.title).toBe('Buy blue paint')
  })

  it('keeps the server’s bookkeeping', () => {
    const { merged } = mergeRecord(task(), task({ title: 'x', createdAt: '2026-01-01T00:00:00.000Z' }), task({ ownerId: 'u1', updatedAt: '2026-09-10T10:00:00.000Z' }))
    expect(merged.createdAt).toBe(T0)
    expect(merged.ownerId).toBe('u1')
    expect(merged.updatedAt).toBe('2026-09-10T10:00:00.000Z')
  })
})

describe('grocery lists', () => {
  it('two people tick different lines of the same list: both ticks survive', () => {
    const base = grocery([line('Milk'), line('Eggs'), line('Bread')])
    const local = grocery([line('Milk', 'done'), line('Eggs'), line('Bread')])
    const remote = grocery([line('Milk'), line('Eggs'), line('Bread', 'have')])
    const { merged, conflicts } = mergeRecord(base, local, remote)
    expect(merged.items.map(l => `${l.name}:${l.state}`)).toEqual(['Milk:done', 'Eggs:need', 'Bread:have'])
    expect(conflicts).toEqual([])
  })

  it('matches lines by name and unit, not by an id that differs per device', () => {
    const base = grocery([line('Milk', 'need', { id: 'g-1' })])
    const local = grocery([line('Milk', 'done', { id: 'g-1' })])
    // the other device's copy was re-read with positional ids after a line was added in front
    const remote = grocery([line('Apples', 'need', { id: 'g-1', manual: true }), line('Milk', 'need', { id: 'g-2' })])
    const { merged } = mergeRecord(base, local, remote)
    expect(merged.items.map(l => `${l.name}:${l.state}`)).toEqual(['Apples:need', 'Milk:done'])
  })

  it('with no base (the week’s list built on two devices) lines are unioned', () => {
    const local = grocery([line('Milk', 'have'), line('Paper towels', 'need', { id: 'u-a', manual: true })])
    const remote = grocery([line('Milk'), line('Onions')], { createdAt: '2026-09-10T08:00:00.000Z' })
    const { merged, conflicts } = mergeRecord(undefined, local, remote)
    expect(merged.items.map(l => l.name).sort()).toEqual(['Milk', 'Onions', 'Paper towels'])
    // a scalar both set differently goes to the other side, and says so
    expect(merged.items.find(l => l.name === 'Milk')!.state).toBe('need')
    expect(conflicts).toEqual([{ path: ['items', 'milk|', 'state'], local: 'have', remote: 'need' }])
    expect(merged.createdAt).toBe('2026-09-10T08:00:00.000Z')
  })
})

describe('equality', () => {
  it('treats every flavour of nothing as the same, and key order as irrelevant', () => {
    expect(same(undefined, '')).toBe(true)
    expect(same([], undefined)).toBe(true)
    expect(same(null, undefined)).toBe(true)
    expect(same({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(same(false, undefined)).toBe(false)
    expect(same([1, 2], [2, 1])).toBe(false)
  })

  it('compares content without stamps or server annotations', () => {
    expect(sameContent(task(), { ...task({ updatedAt: '2026-09-11T00:00:00.000Z', ownerId: 'u' }), syncedAt: 'x' })).toBe(true)
    expect(sameContent(task(), task({ title: 'other' }))).toBe(false)
  })
})

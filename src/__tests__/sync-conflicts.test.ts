import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newerStamp } from '../itemops'
import { conflictMessage, type EngineConflict } from '../syncengine'
import { GroceryList, Item, Meal, Task } from '../types'
import { FakeServer, device, edit, idle, ready, task, type Device, type ServerShape } from './sync-fakes'

// Two devices, one server. The server keeps last-write-wins per row; these are
// the cases where that used to erase one side's edit, and now both survive.

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

const later = (ms = 1000) => vi.setSystemTime(Date.now() + ms)

const paintJob = () =>
  task('t', {
    title: 'Buy paint',
    checklist: [
      { id: 'c1', text: 'Pick a colour', done: false },
      { id: 'c2', text: 'Go to the shop', done: false },
    ],
  })

const tick = (d: Device, lineId: string) =>
  edit(d, 't', { checklist: d.item<Task>('t')!.checklist!.map(c => (c.id === lineId ? { ...c, done: true } : c)) })

async function pair(shape: ServerShape, ...seed: Item[]) {
  const server = new FakeServer()
  server.shape = shape
  server.seed(...seed)
  const a = device(server)
  const b = device(server)
  await ready(a)
  await ready(b)
  const seen: EngineConflict[][] = []
  a.engine.onConflict(c => seen.push(c))
  return { server, a, b, seen }
}

describe('a title edited on one device, a checklist line ticked on the other', () => {
  it('both survive when this device’s edit is the newer one (it would have won whole)', async () => {
    const { server, a, b, seen } = await pair('new', paintJob())
    tick(b, 'c1')
    await b.engine.sync()
    later()
    edit(a, 't', { title: 'Buy blue paint' })
    await a.engine.sync()
    await b.engine.sync()
    for (const t of [server.row<Task>('t')!, a.item<Task>('t')!, b.item<Task>('t')!]) {
      expect(t.title).toBe('Buy blue paint')
      expect(t.checklist!.map(c => c.done)).toEqual([true, false])
    }
    expect(seen).toEqual([])
    expect(a.engine.inspect().dirty).toEqual([])
  })

  it('both survive when this device’s edit is the older one (it lost last-write-wins)', async () => {
    const { server, a, b } = await pair('new', paintJob())
    edit(a, 't', { title: 'Buy blue paint' })
    later()
    tick(b, 'c1')
    await b.engine.sync()
    await a.engine.sync()
    await b.engine.sync()
    expect(server.row<Task>('t')).toMatchObject({ title: 'Buy blue paint', checklist: [{ done: true }, { done: false }] })
    expect(b.item<Task>('t')).toMatchObject({ title: 'Buy blue paint', checklist: [{ done: true }, { done: false }] })
  })

  for (const shape of ['new', 'old'] as const) {
    it(`both survive a write that lands mid-round (${shape} server${shape === 'new' ? ', reported stale' : ', seen as a newer row'})`, async () => {
      const { server, a, b } = await pair(shape, paintJob())
      edit(a, 't', { title: 'Buy blue paint' })
      // the other device's tick reaches the server between this device's pull and its push
      const theirs: Task = { ...paintJob(), checklist: paintJob().checklist!.map(c => (c.id === 'c1' ? { ...c, done: true } : c)), updatedAt: '2026-09-10T11:00:00.000Z' }
      server.beforeAnswer = n => {
        if (server.calls[n - 1].outgoing.some(o => o.id === 't')) {
          server.beforeAnswer = null
          server.seed(theirs)
        }
      }
      await a.engine.sync()
      expect(server.row<Task>('t')!.title).toBe('Buy paint')
      // merged here, stamped newer than both, and waiting to go out
      expect(a.item<Task>('t')).toMatchObject({ title: 'Buy blue paint', checklist: [{ done: true }, { done: false }] })
      expect(a.item('t')!.updatedAt > theirs.updatedAt).toBe(true)
      expect(a.engine.inspect().dirty).toEqual(['t'])
      await vi.advanceTimersByTimeAsync(2000)
      await idle(a)
      await b.engine.sync()
      expect(server.row<Task>('t')).toMatchObject({ title: 'Buy blue paint', checklist: [{ done: true }, { done: false }] })
      expect(b.item<Task>('t')).toMatchObject({ title: 'Buy blue paint', checklist: [{ done: true }, { done: false }] })
    })
  }
})

describe('both devices edited the same field', () => {
  it('the other device’s title wins, the toast says so, and Keep mine restores this one', async () => {
    const { server, a, b, seen } = await pair('new', paintJob())
    edit(b, 't', { title: 'Buy green paint' })
    await b.engine.sync()
    edit(a, 't', { title: 'Buy blue paint' })
    await a.engine.sync()
    expect(a.item<Task>('t')!.title).toBe('Buy green paint')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual([
      expect.objectContaining({ id: 't', label: 'Buy blue paint', fields: [{ path: ['title'], local: 'Buy blue paint', remote: 'Buy green paint' }] }),
    ])
    expect(conflictMessage(seen[0])).toBe('“Buy blue paint” changed on another device too — kept the newer edit')
    // the merge came out as the server's copy: nothing left to push
    expect(a.engine.inspect().dirty).toEqual([])

    a.engine.keepMine(seen[0])
    expect(a.item<Task>('t')!.title).toBe('Buy blue paint')
    await a.engine.sync()
    await b.engine.sync()
    expect(server.row<Task>('t')!.title).toBe('Buy blue paint')
    expect(b.item<Task>('t')!.title).toBe('Buy blue paint')
    expect(seen).toHaveLength(1)
  })

  it('names several records in one toast', () => {
    expect(conflictMessage([{ label: 'Buy paint' }, { label: 'Walk' }, { label: 'Milk' }])).toBe('“Buy paint” and 2 more changed on another device too — kept the newer edits')
  })
})

describe('grocery lists', () => {
  const list = (): GroceryList => ({
    kind: 'grocery',
    id: 'grocery~2026-W37',
    weekKey: '2026-W37',
    items: ['Milk', 'Eggs', 'Bread'].map(name => ({ id: `g~${name.toLowerCase()}|`, name, state: 'need' as const, recipeIds: [] })),
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
  })
  const setLine = (d: Device, name: string, state: 'have' | 'done') => {
    const cur = d.item<GroceryList>('grocery~2026-W37')!
    d.engine.upsert({ ...cur, items: cur.items.map(l => (l.name === name ? { ...l, state } : l)), updatedAt: newerStamp(cur.updatedAt) })
  }
  const states = (g: GroceryList | undefined) => g!.items.map(l => `${l.name}:${l.state}`)

  it('two people tick different lines of the same list: both ticks survive', async () => {
    const { server, a, b, seen } = await pair('new', list())
    setLine(a, 'Milk', 'done')
    setLine(b, 'Bread', 'have')
    await b.engine.sync()
    await a.engine.sync()
    await b.engine.sync()
    const want = ['Milk:done', 'Eggs:need', 'Bread:have']
    expect(states(server.row<GroceryList>('grocery~2026-W37'))).toEqual(want)
    expect(states(a.item<GroceryList>('grocery~2026-W37'))).toEqual(want)
    expect(states(b.item<GroceryList>('grocery~2026-W37'))).toEqual(want)
    expect(seen).toEqual([])
  })

  it('the same week’s list started on two devices keeps both hand-added lines', async () => {
    const { server, a, b } = await pair('new')
    const fresh = (name: string): GroceryList => ({
      kind: 'grocery',
      id: 'grocery~2026-W37',
      weekKey: '2026-W37',
      items: [{ id: `hand-${name}`, name, state: 'need', recipeIds: [], manual: true }],
      createdAt: new Date().toISOString(),
      updatedAt: newerStamp(),
    })
    a.engine.upsert(fresh('Paper towels'))
    later()
    b.engine.upsert(fresh('Eggs'))
    await b.engine.sync()
    await a.engine.sync()
    await vi.advanceTimersByTimeAsync(2000)
    await idle(a)
    await b.engine.sync()
    expect(server.row<GroceryList>('grocery~2026-W37')!.items.map(l => l.name).sort()).toEqual(['Eggs', 'Paper towels'])
    expect(b.item<GroceryList>('grocery~2026-W37')!.items.map(l => l.name).sort()).toEqual(['Eggs', 'Paper towels'])
  })
})

describe('records created on two devices under one id, with no base', () => {
  for (const shape of ['new', 'old'] as const) {
    it(`the meal planned elsewhere wins, and this one can be kept (${shape} server)`, async () => {
      const { server, a, b, seen } = await pair(shape)
      const meal = (title: string): Meal => ({ kind: 'meal', id: 'meal~2026-09-12~dinner', date: '2026-09-12', slot: 'dinner', title, createdAt: new Date().toISOString(), updatedAt: newerStamp() })
      a.engine.upsert(meal('Pasta'))
      later()
      b.engine.upsert(meal('Pizza'))
      await b.engine.sync()
      await a.engine.sync()
      expect(a.item<Meal>('meal~2026-09-12~dinner')!.title).toBe('Pizza')
      expect(seen[0]).toEqual([expect.objectContaining({ label: 'Pasta', fields: [{ path: ['title'], local: 'Pasta', remote: 'Pizza' }] })])
      a.engine.keepMine(seen[0])
      await a.engine.sync()
      expect(server.row<Meal>('meal~2026-09-12~dinner')!.title).toBe('Pasta')
    })
  }
})

describe('the merge base survives the app being killed', () => {
  it('an edit left from the last session still merges with what changed meanwhile', async () => {
    const { server, a, b } = await pair('new', paintJob())
    server.offline = true
    edit(a, 't', { title: 'Buy blue paint' })
    await vi.advanceTimersByTimeAsync(300)
    a.engine.stop()
    server.offline = false
    tick(b, 'c2')
    await b.engine.sync()
    const relaunched = device(server, { kv: a.kv, snapshot: a.snapshot() })
    await ready(relaunched)
    await b.engine.sync()
    expect(server.row<Task>('t')).toMatchObject({ title: 'Buy blue paint', checklist: [{ done: false }, { done: true }] })
    expect(b.item<Task>('t')).toMatchObject({ title: 'Buy blue paint', checklist: [{ done: false }, { done: true }] })
  })
})

describe('deletes against edits', () => {
  it('a delete here keeps the edit made there, so Restore brings back the latest', async () => {
    const { server, a, b } = await pair('new', paintJob())
    edit(b, 't', { title: 'Buy blue paint' })
    await b.engine.sync()
    later()
    a.engine.remove('t')
    await a.engine.sync()
    expect(server.row<Task>('t')).toMatchObject({ title: 'Buy blue paint' })
    expect(server.row<Task>('t')!.deletedAt).toBeTruthy()
    a.engine.restore(['t'])
    expect(a.item<Task>('t')).toMatchObject({ title: 'Buy blue paint', deletedAt: undefined })
  })
})

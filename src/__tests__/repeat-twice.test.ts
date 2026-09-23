import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { duplicateSpawnPairs, duplicateSpawns, newerStamp, nextOccurrence, spawnId } from '../../shared/domain.mts'
import { retiredMessage, type RetiredSpawn } from '../syncengine'
import { Task } from '../types'
import { FakeServer, device, edit, idle, ready, task, type Device } from './sync-fakes'

// A repeating chore ticked off on two devices before they synced came back
// twice when the two ticks fell on different days. The same day was already
// safe: the next occurrence's id is its chore's id, its repeat and its due
// day, so both devices spawn one id and the server keeps one row. A day apart
// they spawn two. The rule that keeps one lives beside spawnId, whose ids it
// reads, and the sync engine applies it after every round, so it holds on
// every device, whichever of them sees both first.

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-14T10:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

const DAY = 86_400_000
const nextDay = () => vi.setSystemTime(Date.now() + DAY)

/** Water the plants, every week, due this morning. */
const chore = () => task('water', { title: 'Water the plants', recurrence: { freq: 'weekly' }, dueAt: '2026-09-14T08:00:00.000Z' })

/** The chore's open occurrences as one device holds them. */
const open = (d: Device) =>
  d.engine
    .getState()
    .items.filter((i): i is Task => i.kind === 'task' && i.id.startsWith('water') && !i.deletedAt && i.status !== 'done')
    .map(t => t.id)
    .sort()

async function pair() {
  const server = new FakeServer()
  server.seed(chore())
  const a = device(server)
  const b = device(server)
  await ready(a)
  await ready(b)
  return { server, a, b }
}

describe('a repeating chore ticked off on two devices before they sync', () => {
  it('on different days: one next occurrence, the same one on both devices and the server', async () => {
    const { server, a, b } = await pair()
    // Monday on the phone
    const onA = a.engine.setStatus('water', 'done')!.spawnedId!
    await a.engine.sync()
    // Tuesday at the desk, which has not heard about Monday
    nextDay()
    const onB = b.engine.setStatus('water', 'done')!.spawnedId!
    expect(onB).not.toBe(onA)
    await b.engine.sync()
    await idle(b)
    await a.engine.sync()
    await idle(a)

    // the one due latest stays: a chore comes round again from when it was last done
    expect(onB).toBe(spawnId('water', 'weekly', '2026-09-22T10:00:00.000Z'))
    expect(open(a)).toEqual([onB])
    expect(open(b)).toEqual([onB])
    expect(server.row<Task>(onB)!.deletedAt).toBeUndefined()
    expect(server.row<Task>(onB)!.recurrence).toEqual({ freq: 'weekly' })
    // the other is in the Trash, not gone, and no longer repeats
    const extra = server.row<Task>(onA)!
    expect(extra.deletedAt).toBeDefined()
    expect(extra.recurrence).toBeUndefined()
    expect(a.item<Task>(onA)!.deletedAt).toBeDefined()
    // nothing is left waiting to go out on either side
    expect(a.engine.inspect().dirty).toEqual([])
    expect(b.engine.inspect().dirty).toEqual([])
  })

  it('the device that ticked first sees the other’s occurrence first, and keeps the same one', async () => {
    const { server, a, b } = await pair()
    const onA = a.engine.setStatus('water', 'done')!.spawnedId!
    nextDay()
    const onB = b.engine.setStatus('water', 'done')!.spawnedId!
    // this time the later tick reaches the server first
    await b.engine.sync()
    await idle(b)
    await a.engine.sync()
    await idle(a)
    await b.engine.sync()
    await idle(b)
    expect(open(a)).toEqual([onB])
    expect(open(b)).toEqual([onB])
    expect(server.row<Task>(onA)!.deletedAt).toBeDefined()
  })

  it('a copy restored from the Trash stays, as a one-off', async () => {
    const { a, b } = await pair()
    const onA = a.engine.setStatus('water', 'done')!.spawnedId!
    await a.engine.sync()
    nextDay()
    const onB = b.engine.setStatus('water', 'done')!.spawnedId!
    await b.engine.sync()
    await idle(b)
    await a.engine.sync()
    await idle(a)
    a.engine.restore([onA])
    await a.engine.sync()
    await idle(a)
    await b.engine.sync()
    await idle(b)
    for (const d of [a, b]) {
      expect(open(d)).toEqual([onA, onB].sort())
      expect(d.item<Task>(onA)!.recurrence).toBeUndefined()
      expect(d.item<Task>(onB)!.recurrence).toEqual({ freq: 'weekly' })
    }
  })

  it('on the same day: one id from the start, and nothing goes to the Trash', async () => {
    const { server, a, b } = await pair()
    const onA = a.engine.setStatus('water', 'done')!.spawnedId!
    const onB = b.engine.setStatus('water', 'done')!.spawnedId!
    expect(onB).toBe(onA)
    await a.engine.sync()
    await b.engine.sync()
    await idle(b)
    await a.engine.sync()
    await idle(a)
    expect(open(a)).toEqual([onA])
    expect(open(b)).toEqual([onA])
    expect(server.row<Task>(onA)!.deletedAt).toBeUndefined()
  })
})

describe('duplicateSpawns: which next occurrences are extra', () => {
  const spawn = (id: string, over: Partial<Task> = {}) => task(id, { recurrence: { freq: 'daily' }, ...over })

  it('keeps the one due latest and names the rest', () => {
    const items = [spawn('x~daily~2026-09-15'), spawn('x~daily~2026-09-17'), spawn('x~daily~2026-09-16')]
    expect(duplicateSpawns(items).sort()).toEqual(['x~daily~2026-09-15', 'x~daily~2026-09-16'])
  })

  it('reaches the same verdict in any order, from ids alone', () => {
    const items = [spawn('x~daily~2026-09-15', { dueAt: '2026-09-30T09:00:00.000Z' }), spawn('x~daily~2026-09-16')]
    expect(duplicateSpawns(items)).toEqual(['x~daily~2026-09-15'])
    expect(duplicateSpawns([...items].reverse())).toEqual(['x~daily~2026-09-15'])
  })

  it('counts an occurrence of an occurrence as the same chore, under an id grown by an older build', () => {
    // Ticked Monday and again Tuesday on one device, once on Tuesday on the
    // other: both are due Wednesday. Before the ids stopped growing the first
    // device's carried both ticks, and such rows are never rewritten.
    const items = [spawn('x~daily~2026-09-15~daily~2026-09-16'), spawn('x~daily~2026-09-16')]
    expect(duplicateSpawns(items)).toEqual(['x~daily~2026-09-15~daily~2026-09-16'])
  })

  it('leaves alone what is not an open, repeating next occurrence', () => {
    const keep = spawn('x~daily~2026-09-16')
    expect(duplicateSpawns([keep, spawn('x~daily~2026-09-15', { status: 'done' })])).toEqual([])
    expect(duplicateSpawns([keep, spawn('x~daily~2026-09-15', { status: 'canceled' })])).toEqual([])
    expect(duplicateSpawns([keep, spawn('x~daily~2026-09-15', { deletedAt: '2026-09-15T00:00:00.000Z' })])).toEqual([])
    // reopened by hand, or restored from the Trash: no repeat of its own
    expect(duplicateSpawns([keep, spawn('x~daily~2026-09-15', { recurrence: undefined })])).toEqual([])
    // the chore itself, a duplicate made with Duplicate (a fresh id), another chore
    expect(duplicateSpawns([keep, spawn('x'), spawn('k3j9x2'), spawn('y~daily~2026-09-15')])).toEqual([])
  })

  it('names the one kept in each extra’s place', () => {
    const items = [spawn('x~daily~2026-09-15'), spawn('x~daily~2026-09-17'), spawn('y~daily~2026-09-15'), spawn('y~daily~2026-09-14')]
    expect(duplicateSpawnPairs(items)).toEqual([
      { id: 'x~daily~2026-09-15', keptId: 'x~daily~2026-09-17' },
      { id: 'y~daily~2026-09-14', keptId: 'y~daily~2026-09-15' },
    ])
  })
})

// A next occurrence's id used to be the id of the one just done with another
// `~freq~day` on the end, so a daily chore's grew by some 17 characters a day.
// Now it is the series' root and one segment, whatever came before.
describe('a repeating chore’s ids stay short', () => {
  const ROOT = 'water'
  const SHORT = ROOT.length + '~daily~2026-09-14'.length

  /** Every task of the chore one device holds, tombstones included. */
  const chain = (d: Device) => d.engine.getState().items.filter((i): i is Task => i.kind === 'task' && i.id.startsWith(ROOT))

  async function daily() {
    const server = new FakeServer()
    server.seed(task(ROOT, { title: 'Water the plants', recurrence: { freq: 'daily' }, dueAt: '2026-09-14T08:00:00.000Z' }))
    const d = device(server)
    await ready(d)
    return { server, d }
  }

  it('however many times it comes round', async () => {
    const { d } = await daily()
    let current = ROOT
    for (let day = 0; day < 400; day++) {
      current = d.engine.setStatus(current, 'done')!.spawnedId!
      expect(current.length, current).toBeLessThanOrEqual(SHORT)
      nextDay()
    }
    expect(current).toBe(`${ROOT}~daily~2027-10-19`)
    expect(chain(d)).toHaveLength(401)
    expect(Math.max(...chain(d).map(t => t.id.length))).toBe(SHORT)
  })

  it('from an id an older build grew: its next occurrence takes the short form, and the old row keeps its id', async () => {
    const server = new FakeServer()
    const grown = `${ROOT}~daily~2026-09-12~daily~2026-09-13~daily~2026-09-14`
    server.seed(task(grown, { recurrence: { freq: 'daily' }, dueAt: '2026-09-14T08:00:00.000Z' }))
    const d = device(server)
    await ready(d)
    const next = d.engine.setStatus(grown, 'done')!.spawnedId!
    expect(next).toBe(`${ROOT}~daily~2026-09-15`)
    expect(d.item<Task>(grown)!.status).toBe('done')
    await d.engine.sync()
    await idle(d)
    expect(server.row<Task>(grown)!.status).toBe('done')
    expect(server.row<Task>(next)!.status).toBe('todo')
    // and the duplicate check still reads both as one chore
    expect(duplicateSpawnPairs([task(grown, { recurrence: { freq: 'daily' } }), task(next, { recurrence: { freq: 'daily' } })])).toEqual([{ id: grown, keptId: next }])
  })

  it('ticked off early, the next one never takes the id of one already there', async () => {
    const { d } = await daily()
    // today's, then tomorrow's, then the one that came round for tomorrow again, all today:
    // after the first, each next one falls due on a day its series has already had
    const first = d.engine.setStatus(ROOT, 'done')!.spawnedId!
    const second = d.engine.setStatus(first, 'done')!.spawnedId!
    const third = d.engine.setStatus(second, 'done')!.spawnedId!
    expect(first).toBe(`${ROOT}~daily~2026-09-15`)
    expect(new Set([ROOT, first, second, third]).size).toBe(4)
    expect(second.startsWith(first)).toBe(true)
    expect(third.startsWith(second)).toBe(true)
    // the next tick on a later day is short again
    nextDay()
    nextDay()
    const back = d.engine.setStatus(third, 'done')!.spawnedId!
    expect(back).toBe(`${ROOT}~daily~2026-09-17`)
    const ids = chain(d).map(t => t.id)
    expect(new Set(ids).size, 'one record per id').toBe(ids.length)
    expect(chain(d).filter(t => t.status === 'done')).toHaveLength(4)
  })

  it('ticked off, undone and ticked off again, the next occurrence comes back once, and the server keeps it', async () => {
    const { server, d } = await daily()
    const change = d.engine.setStatus(ROOT, 'done')!
    // the toast's Undo
    d.engine.upsert({ ...change.prev, updatedAt: newerStamp(change.prev.updatedAt) })
    d.engine.remove(change.spawnedId!)
    await d.engine.sync()
    await idle(d)
    expect(server.row<Task>(change.spawnedId!)!.deletedAt).toBeDefined()

    const again = d.engine.setStatus(ROOT, 'done')!
    expect(again.spawnedId).toBe(change.spawnedId)
    const copies = chain(d).filter(t => t.id === again.spawnedId)
    expect(copies, 'the tombstone is replaced, not joined').toHaveLength(1)
    expect(copies[0].deletedAt).toBeUndefined()
    await d.engine.sync()
    await idle(d)
    expect(server.row<Task>(again.spawnedId!)!.deletedAt).toBeUndefined()
    expect(server.row<Task>(again.spawnedId!)!.status).toBe('todo')
  })

  it('never lands on a live record another device wrote under the same id', () => {
    const done = task(`${ROOT}~daily~2026-09-15`, { status: 'done', completedAt: '2026-09-15T10:00:00.000Z', recurrence: { freq: 'daily' } })
    const theirs = task(`${ROOT}~daily~2026-09-16`, { recurrence: { freq: 'daily' } })
    const held = (id: string) => (id === theirs.id ? theirs : undefined)
    expect(nextOccurrence(done, () => '')!.id).toBe(theirs.id)
    expect(nextOccurrence(done, () => '', held)!.id).toBe(`${done.id}~daily~2026-09-16`)
  })
})

// The one kept is picked by its due day alone, so the extra may hold what was
// done on it before the two met. Then the Trash is not silent: the toast says
// so, with Restore. A copy that differs only in when it falls due goes quietly.
describe('an extra that held something the one kept does not', () => {
  it('is named to the device that put it in the Trash, and Restore brings it back with what was on it', async () => {
    const { a, b } = await pair()
    const onA = a.engine.setStatus('water', 'done')!.spawnedId!
    edit(a, onA, { description: 'Use the green can' })
    await a.engine.sync()
    await idle(a)
    nextDay()
    const told: RetiredSpawn[][] = []
    a.engine.onRetired(r => told.push(r))
    b.engine.onRetired(r => told.push(r))
    const onB = b.engine.setStatus('water', 'done')!.spawnedId!
    await b.engine.sync()
    await idle(b)
    await a.engine.sync()
    await idle(a)
    expect(told).toEqual([[{ id: onA, keptId: onB, label: 'Water the plants' }]])
    expect(retiredMessage(told[0])).toBe('“Water the plants” came round twice, ticked off on two devices — kept the later one; the other, with what was changed on it, is in the Trash')
    // the toast's Restore
    b.engine.restore(told[0].map(r => r.id))
    await b.engine.sync()
    await idle(b)
    await a.engine.sync()
    await idle(a)
    for (const d of [a, b]) {
      expect(open(d)).toEqual([onA, onB].sort())
      expect(d.item<Task>(onA)!.description).toBe('Use the green can')
    }
    expect(told).toHaveLength(1)
  })

  it('one that differs only in when it falls due goes quietly, on either device', async () => {
    const { a, b } = await pair()
    const told: RetiredSpawn[][] = []
    a.engine.onRetired(r => told.push(r))
    b.engine.onRetired(r => told.push(r))
    a.engine.setStatus('water', 'done')
    await a.engine.sync()
    nextDay()
    b.engine.setStatus('water', 'done')
    await b.engine.sync()
    await idle(b)
    await a.engine.sync()
    await idle(a)
    expect(open(a)).toHaveLength(1)
    expect(told).toEqual([])
  })

  it('says how many when a round finds several', () => {
    expect(retiredMessage([{ label: 'Water the plants' }, { label: 'Bins out' }])).toBe(
      '“Water the plants” and 1 more came round twice, ticked off on two devices — kept the later ones; the others, with what was changed on them, are in the Trash',
    )
  })
})

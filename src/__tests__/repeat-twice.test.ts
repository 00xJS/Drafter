import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { duplicateSpawns, spawnId } from '../../shared/domain.mjs'
import { Task } from '../types'
import { FakeServer, device, idle, ready, task, type Device } from './sync-fakes'

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

  it('counts an occurrence of an occurrence as the same chore', () => {
    // ticked Monday and again Tuesday on one device, once on Tuesday on the other: both are due Wednesday
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
})

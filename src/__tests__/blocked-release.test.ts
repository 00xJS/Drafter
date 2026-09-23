import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newerStamp } from '../itemops'
import { Task } from '../types'
import { FakeServer, device, edit, idle, ready, task, type Device } from './sync-fakes'

// A blocked task unblocks itself when what it waits on is done — on the device
// where that happens. It used to be read afresh on every edit anywhere, and a
// blocker the device could not see counted as out of the way. A task kept
// private (v3.19) is exactly that on the other member's device, so Maria
// renaming anything at all moved Joseph's shared task to To do, and the move
// went out to every device.

const ME = '00000000-0000-0000-0000-00000000000a'
const PEER = '00000000-0000-0000-0000-00000000000b'

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-23T10:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

/** The task as one device holds it. */
const held = (d: Device, id: string) => d.item<Task>(id)

/** A round as `who`: the server answers that account, so its policy is theirs. */
async function roundAs(server: FakeServer, who: string, d: Device) {
  server.caller = who
  await d.engine.sync()
  await idle(d)
}

/**
 * Two shared tasks of mine wait on a quote I kept to myself; the second waits
 * on tape the household can see as well. My housemate's device holds both
 * tasks and the tape, never the quote.
 */
async function household() {
  const server = new FakeServer()
  server.caller = ME
  server.seed(
    task('paint', { title: 'Paint the hall', status: 'blocked', blockedBy: ['quote'] }),
    task('hall', { title: 'Tidy the hall', status: 'blocked', blockedBy: ['quote', 'tape'] }),
    task('quote', { title: 'Get a quote', shared: false }),
    task('tape', { title: 'Buy tape' }),
    task('bins', { title: 'Bins out' }),
  )
  const mine = device(server)
  const theirs = device(server)
  server.caller = ME
  await ready(mine, ME)
  server.caller = PEER
  await ready(theirs, PEER)
  return { server, mine, theirs }
}

describe('a blocker the other member cannot see', () => {
  it('is not in their copy at all', async () => {
    const { mine, theirs } = await household()
    expect(held(mine, 'quote')).toBeDefined()
    expect(held(theirs, 'quote')).toBeUndefined()
    expect(held(theirs, 'paint')?.status).toBe('blocked')
  })

  it('keeps the task blocked when they edit something else', async () => {
    const { server, mine, theirs } = await household()
    edit(theirs, 'bins', { title: 'Bins and recycling out' })
    expect(held(theirs, 'paint')?.status).toBe('blocked')
    await roundAs(server, PEER, theirs)
    await roundAs(server, ME, mine)
    expect(server.row<Task>('paint')?.status).toBe('blocked')
    expect(held(mine, 'paint')?.status).toBe('blocked')
  })

  it('keeps it blocked when they edit the task itself', async () => {
    const { server, theirs } = await household()
    edit(theirs, 'paint', { description: 'The green one' })
    expect(held(theirs, 'paint')).toMatchObject({ status: 'blocked', description: 'The green one' })
    await roundAs(server, PEER, theirs)
    expect(server.row<Task>('paint')?.status).toBe('blocked')
  })

  it('keeps it blocked when they finish the blocker they can see', async () => {
    const { server, theirs } = await household()
    theirs.engine.setStatus('tape', 'done')
    expect(held(theirs, 'hall')?.status).toBe('blocked')
    await roundAs(server, PEER, theirs)
    expect(server.row<Task>('hall')?.status).toBe('blocked')
  })

  it('frees it when its owner finishes the last one, and both devices hear', async () => {
    const { server, mine, theirs } = await household()
    theirs.engine.setStatus('tape', 'done')
    await roundAs(server, PEER, theirs)
    await roundAs(server, ME, mine)
    expect(held(mine, 'hall')?.status).toBe('blocked')

    mine.engine.setStatus('quote', 'done')
    expect(held(mine, 'paint')?.status).toBe('todo')
    expect(held(mine, 'hall')?.status).toBe('todo')
    await roundAs(server, ME, mine)
    await roundAs(server, PEER, theirs)
    for (const id of ['paint', 'hall']) {
      expect(server.row<Task>(id)?.status).toBe('todo')
      expect(held(theirs, id)?.status).toBe('todo')
    }
  })
})

describe('what frees a blocked task on one device', () => {
  async function one(...tasks: Task[]) {
    const d = device(null)
    await d.engine.boot(null)
    for (const t of tasks) d.engine.upsert(t)
    return d
  }

  it('finishing its last blocker, by status or by a saved edit', async () => {
    const d = await one(task('a'), task('b'), task('c', { status: 'blocked', blockedBy: ['a', 'b'] }))
    d.engine.setStatus('a', 'done')
    expect(held(d, 'c')?.status).toBe('blocked')
    const b = held(d, 'b')!
    d.engine.upsert({ ...b, status: 'done', completedAt: new Date().toISOString(), updatedAt: newerStamp(b.updatedAt) })
    expect(held(d, 'c')?.status).toBe('todo')
  })

  it('never an edit that finishes none of its blockers', async () => {
    // put in Blocked behind a task that is already done: it waits until told otherwise
    const d = await one(task('a', { status: 'done', completedAt: '2026-09-22T10:00:00.000Z' }), task('other'))
    const c = task('c', { status: 'blocked', blockedBy: ['a'] })
    d.engine.upsert(c)
    expect(held(d, 'c')?.status).toBe('blocked')
    d.engine.setStatus('other', 'done')
    expect(held(d, 'c')?.status).toBe('blocked')
  })

  it('sending its last blocker to the Trash, as surely as ticking it off', async () => {
    const d = await one(task('a'), task('b'), task('c', { status: 'blocked', blockedBy: ['a', 'b'] }), task('e', { status: 'blocked', blockedBy: ['a', 'gone'] }))
    d.engine.remove('a')
    // b still holds c; e waits on a task this device has never seen
    expect(held(d, 'c')?.status).toBe('blocked')
    expect(held(d, 'e')?.status).toBe('blocked')
    d.engine.remove('b')
    expect(held(d, 'c')?.status).toBe('todo')
    expect(held(d, 'e')?.status).toBe('blocked')
  })

  it('reads a blocker in the Trash as out of the way, and one it does not hold as still in it', async () => {
    const d = await one(task('a'), task('b'), task('c', { status: 'blocked', blockedBy: ['a', 'b'] }), task('e', { status: 'blocked', blockedBy: ['a', 'gone'] }))
    d.engine.remove('b')
    d.engine.setStatus('a', 'done')
    expect(held(d, 'c')?.status).toBe('todo')
    expect(held(d, 'e')?.status).toBe('blocked')
  })
})

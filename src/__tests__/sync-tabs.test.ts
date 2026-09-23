import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERIODIC_MS } from '../syncengine'
import { browserLeadership } from '../synclead'
import type { Task } from '../types'
import { FakeDisk, FakeTabs, editTask, recordDevice, settle, type RecordDevice } from './record-fakes'
import { FakeServer, task } from './sync-fakes'

// Two tabs of the web app used to run two sync engines over one IndexedDB
// cache and one set of sync bookkeeping, with nothing between them. A tab back
// from the background pulled from the cursor the other had already moved,
// missed the partner's rename the other had pulled, and its next edit wrote
// the old title back over it; and the tabs wrote their dirty sets over each
// other's. Now one tab leads (a Web Lock) and runs every round; the others
// read what it wrote and hand their edits to it (src/synclead.ts).

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

/** Two tabs over one disk: A opened first and leads, B follows. */
async function twoTabs(server: FakeServer, opts: { bVisible?: boolean } = {}) {
  const tabs = new FakeTabs()
  const disk = new FakeDisk()
  const kv = new Map<string, string>()
  const A = recordDevice(server, { disk, kv, leadership: tabs.tab('A') })
  await settle(A)
  const B = recordDevice(server, { disk, kv, leadership: tabs.tab('B', opts.bVisible ?? true) })
  // as watchLifecycle tells an engine at start
  if (opts.bVisible === false) B.engine.setHidden(true)
  await settle(B)
  return { tabs, disk, kv, A, B }
}

/** Let messages, hand-overs, writes and a push run. */
async function settleTabs(...tabs: RecordDevice[]): Promise<void> {
  await vi.advanceTimersByTimeAsync(2_500)
  for (const t of tabs) if (t.engine.inspect().syncing) await t.engine.sync()
  await vi.advanceTimersByTimeAsync(500)
}

describe('two tabs, one syncing', () => {
  it('a tab back from the background sees the partner’s rename, and its edit keeps it', async () => {
    const server = new FakeServer()
    server.seed(task('y'), ...Array.from({ length: 12 }, (_, i) => task('o' + i)))
    const { A, B } = await twoTabs(server)
    // the partner renames y; twelve more writes land over the next seconds
    server.patch('y', { title: 'partner title', updatedAt: '2026-09-10T09:59:00.000Z' })
    for (let i = 0; i < 12; i++) server.patch('o' + i, { title: 'o' + i + '!', updatedAt: '2026-09-10T09:59:30.000Z' })
    await A.engine.sync()
    await B.engine.sync()
    await vi.advanceTimersByTimeAsync(300)
    expect(B.item<Task>('y')!.title).toBe('partner title')
    editTask(B, 'y', { description: 'added in tab B' })
    await settleTabs(A, B)
    expect(server.row<Task>('y')).toMatchObject({ title: 'partner title', description: 'added in tab B' })
    expect(B.item<Task>('y')).toMatchObject({ title: 'partner title', description: 'added in tab B' })
    expect(A.engine.inspect().leading).toBe(true)
    expect(B.engine.inspect().leading).toBe(false)
  })

  it('only the leader runs rounds: the other asks it, and never polls', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const { A, B } = await twoTabs(server)
    A.engine.start()
    B.engine.start()
    expect(A.engine.inspect().pollMs).toBe(PERIODIC_MS)
    expect(B.engine.inspect().pollMs).toBeNull()
    let calls = server.calls.length
    await vi.advanceTimersByTimeAsync(PERIODIC_MS)
    expect(server.calls.length).toBe(calls + 1)
    // Sync now in the follower: the leader runs one round and says it went
    calls = server.calls.length
    expect(await B.engine.sync()).toBe(true)
    expect(server.calls.length).toBe(calls + 1)
    A.engine.stop()
    B.engine.stop()
  })

  it('edits made offline in both tabs are all kept and all sent', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'))
    const { A, B, disk } = await twoTabs(server)
    server.offline = true
    editTask(A, 'a', { title: 'from A' })
    editTask(B, 'b', { title: 'from B' })
    await settleTabs(A, B)
    expect(A.engine.inspect().dirty).toEqual(['a', 'b'])
    expect([...disk.meta!.sync!.dirty].sort()).toEqual(['a', 'b'])
    // B's edit left the outbox with the write that marked it dirty
    expect(disk.outbox.size).toBe(0)
    server.offline = false
    await A.engine.sync()
    expect(server.row<Task>('a')!.title).toBe('from A')
    expect(server.row<Task>('b')!.title).toBe('from B')
    await vi.advanceTimersByTimeAsync(300)
    expect(B.item<Task>('a')!.title).toBe('from A')
  })

  it('the leader takes a handed-over edit on top of the newer copy it holds, not over it', async () => {
    const server = new FakeServer()
    server.seed(task('y'))
    const { A, B } = await twoTabs(server)
    server.patch('y', { title: 'partner title', updatedAt: '2026-09-10T09:59:00.000Z' })
    await A.engine.sync()
    // before A's write lands, B edits the copy it has
    expect(B.item<Task>('y')!.title).toBe('y')
    editTask(B, 'y', { description: 'from B' })
    await settleTabs(A, B)
    expect(server.row<Task>('y')).toMatchObject({ title: 'partner title', description: 'from B' })
    expect(A.item<Task>('y')).toMatchObject({ title: 'partner title', description: 'from B' })
    expect(B.item<Task>('y')).toMatchObject({ title: 'partner title', description: 'from B' })
  })

  it('tells the other tabs where sync stands: last synced, and what the server refused', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const { A, B } = await twoTabs(server)
    server.refuse.set('a', 'status not allowed')
    editTask(A, 'a', { title: 'Refused' })
    await settleTabs(A, B)
    expect(B.engine.getState().syncInfo).toEqual(A.engine.getState().syncInfo)
    expect(B.engine.getState().failures).toEqual([expect.objectContaining({ id: 'a', reason: 'status not allowed' })])
  })
})

describe('the lead passes on', () => {
  it('when the leader closes, the next tab takes over — with the edit it handed over that nobody took', async () => {
    const server = new FakeServer()
    server.seed(task('y'))
    const { tabs, A, B } = await twoTabs(server)
    // B edits, and A is gone before it hears of it
    editTask(B, 'y', { title: 'handed over' })
    A.engine.stop()
    tabs.close('A')
    await settleTabs(B)
    expect(tabs.leader()).toBe('B')
    expect(B.engine.inspect().leading).toBe(true)
    expect(server.row<Task>('y')!.title).toBe('handed over')
    B.engine.start()
    expect(B.engine.inspect().pollMs).toBe(PERIODIC_MS)
    B.engine.stop()
  })

  it('a leader going out of view gives the lead to a tab in view, keeping what it had not sent', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const { tabs, A, B } = await twoTabs(server, { bVisible: false })
    // B comes into view and waits in line; A, in view too, keeps the lead
    tabs.setVisible('B', true)
    B.engine.setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(A.engine.inspect().leading).toBe(true)
    // an edit A could not send, then A goes out of view
    server.offline = true
    editTask(A, 'a', { title: 'kept' })
    tabs.setVisible('A', false)
    A.engine.setHidden(true)
    await settleTabs(A, B)
    expect(tabs.leader()).toBe('B')
    expect(A.engine.inspect().leading).toBe(false)
    expect(B.engine.inspect().dirty).toEqual(['a'])
    server.offline = false
    await B.engine.sync()
    expect(server.row<Task>('a')!.title).toBe('kept')
  })

  it('a tab that leads again after nobody else wrote carries on from memory, without reading the cache again', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const tabs = new FakeTabs()
    const disk = new FakeDisk()
    const A = recordDevice(server, { disk, leadership: tabs.tab('A') })
    await settle(A)
    const reads = disk.reads
    // a second tab opens hidden and closes again without ever leading
    const B = recordDevice(server, { disk, leadership: tabs.tab('B', false) })
    await settle(B)
    B.engine.stop()
    tabs.close('B')
    // A out of view and back: nobody waited, so it never let go
    A.engine.setHidden(true)
    await vi.advanceTimersByTimeAsync(0)
    A.engine.setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(A.engine.inspect().leading).toBe(true)
    expect(disk.reads).toBe(reads + 1)
  })
})

describe('where there is nothing to agree with, every page syncs as before', () => {
  it('the iOS shell, a runtime with no page, and a browser without Web Locks', () => {
    expect(browserLeadership(true)).toBeNull()
    // Node has Web Locks and BroadcastChannel, and no tabs to agree with
    expect(browserLeadership(false)).toBeNull()
    vi.stubGlobal('document', { visibilityState: 'visible' })
    vi.stubGlobal('navigator', {})
    try {
      expect(browserLeadership(false)).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('an engine given no leadership leads', async () => {
    const d = recordDevice(new FakeServer())
    await settle(d)
    expect(d.engine.inspect().leading).toBe(true)
  })
})

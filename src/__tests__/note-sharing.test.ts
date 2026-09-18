import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { revokedNotes } from '../itemops'
import { sanitizeNote } from '../schema'
import { parseSyncResponse } from '../sync'
import { Item, Note } from '../types'
import { FakeServer, device, idle, ready } from './sync-fakes'

// A note is its owner's until they share it (v3.16). The database decides that
// — these cover the half that cannot live in a policy: telling the person
// already holding a copy that it is not theirs to hold any more.
//
// Un-sharing is invisible by construction. A client asks for rows newer than
// its cursor; a row it may no longer select is simply absent, which is exactly
// what "nothing changed" looks like. So sync_posts states the whole set of
// peer-owned notes the caller can see, every round, and the client drops
// whatever of someone else's it is still holding that is not in it.

const ME = 'user-1'
const PEER = 'user-2'
const at = '2026-09-10T09:00:00.000Z'

const note = (id: string, over: Partial<Note> = {}): Note => ({
  kind: 'note',
  id,
  title: id,
  body: `<p>${id}</p>`,
  createdAt: at,
  updatedAt: at,
  ...over,
})

describe('revokedNotes: what a round says this account may no longer hold', () => {
  const held = [note('mine', { ownerId: ME }), note('local'), note('theirs', { ownerId: PEER, shared: true })] as Item[]

  it('drops a peer’s note the server no longer lists', () => {
    expect([...revokedNotes(held, [], new Set(), ME)]).toEqual(['theirs'])
  })

  it('keeps it while the server still lists it', () => {
    expect([...revokedNotes(held, ['theirs'], new Set(), ME)]).toEqual([])
  })

  it('never touches your own notes, listed or not — the flag says who ELSE may read them', () => {
    // 'mine' is owned here, 'local' has not round-tripped yet and so has no owner
    expect([...revokedNotes(held, [], new Set(), ME)]).not.toContain('mine')
    expect([...revokedNotes(held, [], new Set(), ME)]).not.toContain('local')
  })

  it('never drops a note with an edit still waiting to go out', () => {
    // un-shared mid-edit, the push is refused and Settings offers Discard —
    // a visible outcome, rather than words vanishing off the screen
    expect([...revokedNotes(held, [], new Set(['theirs']), ME)]).toEqual([])
  })

  it('drops a note the server refused in the same breath, dirty or not', () => {
    // The refusal and the absence are the same answer: a row you cannot read
    // is one you can never write, so the edit is not pending, it is impossible.
    expect([...revokedNotes(held, [], new Set(['theirs']), ME, new Set(['theirs']))]).toEqual(['theirs'])
  })

  it('drops nothing when the server did not say, which is how an older sync_posts answers', () => {
    // null is "no information". Reading it as "nothing is visible" would empty
    // the Notes list of every device that reached a server one deploy behind.
    expect([...revokedNotes(held, null, new Set(), ME)]).toEqual([])
  })

  it('drops nothing before this device knows whose it is', () => {
    expect([...revokedNotes(held, [], new Set(), null)]).toEqual([])
  })

  it('leaves every other kind alone, however it arrives', () => {
    const rows = [{ kind: 'task', id: 't', ownerId: PEER, title: 't', status: 'todo', priority: 'normal', tags: [], description: '', createdAt: at, updatedAt: at }] as unknown as Item[]
    expect([...revokedNotes(rows, [], new Set(), ME)]).toEqual([])
  })
})

describe('the answer carries it, or says nothing at all', () => {
  it('reads peerNotes when the server sends it', () => {
    expect(parseSyncResponse({ items: [], rejected: [], peerNotes: ['a', 'b'] })!.peerNotes).toEqual(['a', 'b'])
  })

  it('is null for a server that does not send it, and for the legacy array shape', () => {
    expect(parseSyncResponse({ items: [], rejected: [] })!.peerNotes).toBeNull()
    expect(parseSyncResponse([])!.peerNotes).toBeNull()
    // an empty list is an answer, and a different one: nothing of theirs is visible
    expect(parseSyncResponse({ items: [], rejected: [], peerNotes: [] })!.peerNotes).toEqual([])
  })
})

describe('the flag survives the round trip', () => {
  it('sanitizeNote keeps it, so a push never quietly unshares a note', () => {
    // sync_posts overwrites `data` wholesale. A build that dropped the flag on
    // the way through would push the note back without it.
    expect(sanitizeNote(note('n', { shared: true }))!.shared).toBe(true)
    expect(sanitizeNote(note('n'))!.shared).toBeUndefined()
    // only the boolean shares it, so a stray string cannot
    expect(sanitizeNote({ ...note('n'), shared: 'true' })!.shared).toBeUndefined()
  })
})

describe('un-sharing, through the engine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a peer’s note arrives once it is shared, and leaves when they stop', async () => {
    const server = new FakeServer()
    server.seedAs(PEER, note('peer-open', { shared: true }))
    server.seedAs(PEER, note('peer-shut'))
    const d = device(server)
    await ready(d, ME)

    // only the shared one was ever this account's to read
    expect(d.item('peer-open')).toBeDefined()
    expect(d.item('peer-shut')).toBeUndefined()

    // its owner turns sharing off on their own device
    server.patch('peer-open', { shared: undefined, updatedAt: '2026-09-10T11:00:00.000Z' })
    await d.engine.sync()
    await idle(d)

    expect(d.item('peer-open')).toBeUndefined()
  })

  it('and it is gone from the cache on disk too, not just the screen', async () => {
    const server = new FakeServer()
    server.seedAs(PEER, note('peer-open', { shared: true }))
    const d = device(server)
    await ready(d, ME)
    expect(d.snapshot()!.items.map(i => i.id)).toContain('peer-open')

    server.patch('peer-open', { shared: undefined, updatedAt: '2026-09-10T11:00:00.000Z' })
    await d.engine.sync()
    await idle(d)
    await vi.advanceTimersByTimeAsync(300)

    expect(d.snapshot()!.items.map(i => i.id)).not.toContain('peer-open')
  })

  it('keeps this account’s own notes through the same round, shared or not', async () => {
    const server = new FakeServer()
    server.seed(note('mine-shared', { shared: true }), note('mine-private'))
    server.seedAs(PEER, note('peer-open', { shared: true }))
    const d = device(server)
    await ready(d, ME)

    server.patch('peer-open', { shared: undefined, updatedAt: '2026-09-10T11:00:00.000Z' })
    await d.engine.sync()
    await idle(d)

    expect(d.item('mine-shared')).toBeDefined()
    expect(d.item('mine-private')).toBeDefined()
    expect(d.item('peer-open')).toBeUndefined()
  })

  it('a peer note with an edit waiting is still let go once the server refuses that edit', async () => {
    // The deadlock this closes: B pins A's shared note while offline, A
    // un-shares it, B reconnects. The push is refused because the row is no
    // longer B's to write; the refusal puts the id back in `dirty`; `dirty`
    // used to suppress the drop; the undropped note is pushed again and
    // refused again. Nothing broke the loop, so A's un-shared note stayed in
    // B's list — body and all — for good.
    const server = new FakeServer()
    server.caller = ME
    server.seedAs(PEER, note('peer-open', { shared: true }))
    const d = device(server)
    await ready(d, ME)
    expect(d.item('peer-open')).toBeDefined()

    // B edits it (dirty), and it cannot land: the owner has un-shared it
    const held = d.item<Note>('peer-open')!
    d.engine.upsert({ ...held, pinned: true, updatedAt: '2026-09-10T10:30:00.000Z' })
    server.patch('peer-open', { shared: undefined, updatedAt: '2026-09-10T11:00:00.000Z' })
    server.refuse.set('peer-open', 'not readable')

    for (let round = 0; round < 3; round++) {
      await d.engine.sync()
      await idle(d)
    }
    await vi.advanceTimersByTimeAsync(300)

    expect(d.item('peer-open'), 'the note is let go').toBeUndefined()
    // and it leaves no "1 unsynced" behind for a record that is no longer here
    expect(d.engine.inspect().dirty).not.toContain('peer-open')
    expect(d.engine.getState().failures.map(f => f.id)).not.toContain('peer-open')
    expect(d.snapshot()!.items.map(i => i.id)).not.toContain('peer-open')
  })

  it('without the drop the note stays forever — which is what makes this worth having', async () => {
    // The same round against a server one deploy behind, which says nothing
    // about peer notes. The row is un-shared and cannot come back in `items`;
    // silence is all the client gets, and it keeps showing the note.
    const server = new FakeServer()
    server.seedAs(PEER, note('peer-open', { shared: true }))
    const d = device(server)
    await ready(d, ME)
    server.shape = 'old'

    server.patch('peer-open', { shared: undefined, updatedAt: '2026-09-10T11:00:00.000Z' })
    await d.engine.sync()
    await idle(d)

    expect(d.item('peer-open')).toBeDefined()
  })
})

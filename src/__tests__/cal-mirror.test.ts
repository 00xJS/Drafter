import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMirrorBatch } from '../../netlify/functions/lib/mirror.mjs'
import {
  type MirrorBatchReply,
  type MirrorLedger,
  type PassTarget,
  mirrorCandidates,
  mirrorPass,
  mirrorPayload,
  mirrorStamp,
  pushEventToGoogle,
  seedLedger,
  sweepMirror,
} from '../calendars'
import type { CalendarEntry, Item, Task } from '../types'

// The mirrors used to keep one updatedAt cursor per provider and only ever
// swept tasks. Entries went out once, on save, and never again; a failed batch
// or a slow device clock left changes behind for good; and one dead Outlook
// account stopped every other. These pin the replacement: a per-record ledger
// of what each provider confirmed, a sweep that sends whatever is still owed in
// chunks the function's time limit can finish, and a pass that keeps every
// account's trouble to itself. The "provider" here is the real server batch
// runner with a stubbed write, so both halves of the contract are exercised.

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: k => m.get(k) ?? null,
    key: i => [...m.keys()][i] ?? null,
    removeItem: k => {
      m.delete(k)
    },
    setItem: (k, v) => {
      m.set(k, String(v))
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const ME = 'me-0001'
const PARTNER = 'partner-0002'
// ledgers, locks and refusals live at module level, so every test gets fresh ids
let n = 0
const fresh = (p: string) => `${p}-${++n}`

function task(over: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id: fresh('t'),
    title: 'Pay rent',
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: '2026-09-20T09:00:00.000Z',
    tags: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
    ownerId: ME,
    ...over,
  }
}

function entry(over: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    kind: 'event',
    id: fresh('e'),
    title: 'Dentist',
    start: '2026-09-21T14:00:00.000Z',
    end: '2026-09-21T15:00:00.000Z',
    allDay: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
    ownerId: ME,
    ...over,
  }
}

const target = () => ({ key: fresh('ledger'), lock: fresh('lock') })

/** A provider calendar: the real batch runner around a write that succeeds unless told otherwise. */
function provider(opts: { calendarId?: () => string; refuse?: (r: Record<string, unknown>) => { error: string; status: number } | null; perRequest?: number } = {}) {
  const calls: Record<string, unknown>[][] = []
  return {
    calls,
    sent: () => calls.flat().map(r => String(r.id)),
    async send(records: Record<string, unknown>[]): Promise<MirrorBatchReply> {
      calls.push(records)
      const res = await runMirrorBatch(
        records as { id: string }[],
        async r => {
          const no = opts.refuse?.(r as Record<string, unknown>)
          if (no) throw Object.assign(new Error(no.error), { status: no.status })
          return 'updated'
        },
        { budgetMs: Infinity, max: opts.perRequest },
      )
      return { ...res, calendarId: opts.calendarId?.() ?? 'cal-1' }
    },
  }
}

describe('runMirrorBatch: one request inside the function time limit', () => {
  it('stops starting writes once the budget is spent, and names what it never reached', async () => {
    let clock = 0
    const res = await runMirrorBatch(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      async () => {
        clock += 3000
        return 'created'
      },
      { budgetMs: 7000, now: () => clock, startedAt: 0 },
    )
    expect(res.done).toEqual(['a', 'b', 'c'])
    expect(res.left).toEqual(['d'])
    expect(res.created).toBe(3)
  })

  it('always tries the first record, however long the lookups before it took', async () => {
    const res = await runMirrorBatch([{ id: 'a' }, { id: 'b' }], async () => 'updated', { budgetMs: 7000, now: () => 20_000, startedAt: 0 })
    expect(res.done).toEqual(['a'])
    expect(res.left).toEqual(['b'])
  })

  it('carries on past a refused record, but stops at a refused account', async () => {
    const push = (status: number) => async (r: { id: string }) => {
      if (r.id === 'b') throw Object.assign(new Error('nope'), { status })
      return 'updated'
    }
    const one = await runMirrorBatch([{ id: 'a' }, { id: 'b' }, { id: 'c' }], push(400))
    expect(one.done).toEqual(['a', 'c'])
    expect(one.errors).toEqual([{ id: 'b', error: 'nope', status: 400 }])
    expect(one.fatal).toBe(false)
    const all = await runMirrorBatch([{ id: 'a' }, { id: 'b' }, { id: 'c' }], push(409))
    expect(all.done).toEqual(['a'])
    expect(all.fatal).toBe(true)
    expect(all.left).toEqual(['c'])
  })

  it('looks at no more than `max` records, and says which it left', async () => {
    const res = await runMirrorBatch([{ id: 'a' }, { id: 'b' }, { id: 'c' }], async () => 'skipped', { max: 2 })
    expect(res.done).toEqual(['a', 'b'])
    expect(res.left).toEqual(['c'])
    expect(res.skipped).toBe(2)
  })
})

describe('the ledger: what a provider calendar is owed', () => {
  it('owes my tasks and my entries, never a partner’s', () => {
    const mine = task()
    const assigned = task({ ownerId: PARTNER, assigneeId: ME })
    const ev = entry()
    const theirs = task({ ownerId: PARTNER })
    const theirEvening = entry({ ownerId: PARTNER })
    const owed = mirrorCandidates([mine, assigned, ev, theirs, theirEvening], { v: 1, seen: {} }, ME).map(r => r.id)
    expect(owed.sort()).toEqual([mine.id, assigned.id, ev.id].sort())
  })

  it('does not owe a confirmed version, and owes any other — whatever its clock says', () => {
    const t = task()
    const ledger: MirrorLedger = { v: 1, seen: { [t.id]: `${mirrorStamp(t.updatedAt)}.0` } }
    expect(mirrorCandidates([t], ledger, ME)).toEqual([])
    // an edit synced from a phone whose clock runs behind: stamped EARLIER than
    // what was confirmed. The old cursor skipped exactly this; it is still owed.
    const behind = { ...t, title: 'Pay rent (edited)', updatedAt: '2026-09-10T09:00:00.000Z' }
    expect(mirrorCandidates([behind], ledger, ME).map(r => r.id)).toEqual([t.id])
  })

  it('sends the newest change first', () => {
    const old = task({ updatedAt: '2026-09-01T00:00:00.000Z' })
    const mid = entry({ updatedAt: '2026-09-05T00:00:00.000Z' })
    const recent = task({ updatedAt: '2026-09-09T00:00:00.000Z' })
    expect(mirrorCandidates([old, mid, recent], { v: 1, seen: {} }, ME).map(r => r.id)).toEqual([recent.id, mid.id, old.id])
  })

  it('upgrading keeps the tasks the old cursor had passed, and backfills every entry once', () => {
    const before = task({ updatedAt: '2026-09-01T00:00:00.000Z' })
    const after = task({ updatedAt: '2026-09-11T00:00:00.000Z' })
    const ev = entry({ updatedAt: '2026-08-01T00:00:00.000Z' })
    const ledger = seedLedger([before, after, ev], ME, '2026-09-05T00:00:00.000Z')
    expect(mirrorCandidates([before, after, ev], ledger, ME).map(r => r.id)).toEqual([after.id, ev.id])
    expect(seedLedger([before], ME, '').seen).toEqual({})
  })

  it('sends only what the provider bodies read', () => {
    const t = { ...task(), notes: 'secret', comments: [{ id: 'c1', text: 'private' }], checklist: [{ id: 'k1', text: 'x', done: false }] } as unknown as Task
    const p = mirrorPayload(t)
    expect(p).not.toHaveProperty('comments')
    expect(p).not.toHaveProperty('notes')
    expect(p).not.toHaveProperty('checklist')
    expect(p).toMatchObject({ kind: 'task', id: t.id, title: 'Pay rent', status: 'todo', dueAt: t.dueAt, updatedAt: t.updatedAt })
    const e = entry({ notes: 'Bring the form', location: 'High Street', work: 'home' })
    expect(mirrorPayload(e)).toMatchObject({ kind: 'event', notes: 'Bring the form', location: 'High Street', work: 'home', start: e.start, end: e.end, allDay: false })
  })
})

describe('sweepMirror: one provider calendar', () => {
  it('backfills entries with the tasks, a chunk per request, and owes nothing once confirmed', async () => {
    const items: Item[] = [task(), task(), task(), entry(), entry({ work: 'home' }), task({ ownerId: PARTNER })]
    const p = provider()
    const t = target()
    const res = await sweepMirror(t, items, ME, p.send, { chunk: 2 })
    expect(p.calls.map(c => c.length)).toEqual([2, 2, 1])
    expect(res).toMatchObject({ confirmed: 5, waiting: 0, errors: [] })
    expect(p.sent()).not.toContain(items[5].id)
    const again = provider()
    expect((await sweepMirror(t, items, ME, again.send)).confirmed).toBe(0)
    expect(again.calls).toEqual([])
  })

  it('gets an edit out from a device whose clock runs behind', async () => {
    const original = task()
    const t = target()
    const p = provider()
    await sweepMirror(t, [original], ME, p.send)
    const behind = { ...original, dueAt: '2026-09-22T09:00:00.000Z', updatedAt: '2026-09-10T09:30:00.000Z' }
    await sweepMirror(t, [behind], ME, p.send)
    expect(p.calls).toHaveLength(2)
    expect(p.calls[1][0]).toMatchObject({ id: original.id, dueAt: '2026-09-22T09:00:00.000Z' })
  })

  it('loses nothing while offline: a failed request confirms nothing, and the next pass sends it all', async () => {
    const items = [task(), entry(), entry({ deletedAt: '2026-09-11T00:00:00.000Z' })]
    const t = target()
    const down = await sweepMirror(t, items, ME, async () => {
      throw new Error('The server is unreachable from here')
    })
    expect(down).toMatchObject({ confirmed: 0, waiting: 3, fatal: 'The server is unreachable from here' })
    const up = await sweepMirror(t, items, ME, provider().send)
    expect(up).toMatchObject({ confirmed: 3, waiting: 0 })
  })

  it('keeps trying a failed delete until the busy block is gone, without hammering the provider', async () => {
    const gone = entry({ deletedAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z' })
    const t = target()
    let clock = Date.parse('2026-09-12T10:00:00.000Z')
    const now = () => clock
    const failing = provider({ refuse: () => ({ error: 'Backend Error', status: 503 }) })
    const first = await sweepMirror(t, [gone], ME, failing.send, { now })
    expect(first).toMatchObject({ confirmed: 0, waiting: 1, ready: 0, errors: [{ id: gone.id, error: 'Backend Error' }] })
    const p = provider()
    await sweepMirror(t, [gone], ME, p.send, { now })
    expect(p.calls).toEqual([])
    clock += 31_000
    const later = await sweepMirror(t, [gone], ME, p.send, { now })
    expect(later).toMatchObject({ confirmed: 1, waiting: 0 })
    expect(p.calls[0][0]).toMatchObject({ id: gone.id, deletedAt: gone.deletedAt })
  })

  it('sends a new version of a refused record at once', async () => {
    const bad = entry({ end: '2026-09-21T13:00:00.000Z' })
    const t = target()
    const p = provider({ refuse: r => (String(r.end) < String(r.start) ? { error: 'The specified time range is empty.', status: 400 } : null) })
    expect((await sweepMirror(t, [bad], ME, p.send)).errors).toHaveLength(1)
    const fixed = { ...bad, end: '2026-09-21T16:00:00.000Z', updatedAt: '2026-09-10T11:00:00.000Z' }
    expect(await sweepMirror(t, [fixed], ME, p.send)).toMatchObject({ confirmed: 1, waiting: 0 })
  })

  it('picks up where the time budget stopped, within the same pass', async () => {
    const items = [task(), task(), task()]
    // the function only ever gets through one before its budget runs out
    const p = provider({ perRequest: 1 })
    const res = await sweepMirror(target(), items, ME, p.send, { chunk: 3 })
    expect(p.calls.map(c => c.length)).toEqual([3, 2, 1])
    expect(res).toMatchObject({ confirmed: 3, waiting: 0 })
  })

  it('stops rather than spin when a request gets nothing done', async () => {
    const p = provider({ perRequest: 0 })
    const res = await sweepMirror(target(), [task(), task()], ME, p.send)
    expect(p.calls).toHaveLength(1)
    expect(res).toMatchObject({ stalled: true, confirmed: 0, waiting: 2 })
  })

  it('owes everything again when the Drafter calendar is not the one it confirmed to', async () => {
    const items: Item[] = [task(), entry(), task()]
    let cal = 'cal-1'
    const p = provider({ calendarId: () => cal })
    const t = target()
    await sweepMirror(t, items, ME, p.send)
    // the owner deleted the calendar, or reconnected another account: a new one
    cal = 'cal-2'
    const edited = { ...(items[0] as Task), title: 'Renamed', updatedAt: '2026-09-12T00:00:00.000Z' }
    const next: Item[] = [edited, items[1], items[2]]
    const res = await sweepMirror(t, next, ME, p.send)
    expect(res).toMatchObject({ replaced: true, waiting: 0 })
    expect(new Set(p.calls.slice(1).flat().map(r => r.id))).toEqual(new Set(next.map(i => i.id)))
  })

  it('counts an entry push-event already confirmed, rather than sending it twice', async () => {
    const ev = entry()
    let release: () => void = () => {}
    const gate = new Promise<void>(r => {
      release = r
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate
        return new Response(JSON.stringify({ result: 'created' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }),
    )
    // Planner's on-save push, still on its way when the sweep comes round
    const saving = pushEventToGoogle(ev)
    const p = provider()
    const sweeping = sweepMirror({ key: fresh('ledger'), lock: 'google' }, [ev], ME, p.send)
    release()
    await saving
    expect(await sweeping).toMatchObject({ confirmed: 1, waiting: 0 })
    expect(p.calls).toEqual([])
  })
})

describe('mirrorPass: every account on its own', () => {
  const passTarget = (id: string, send: (records: Record<string, unknown>[]) => Promise<MirrorBatchReply>, pull = vi.fn(async () => {})): PassTarget => ({
    id,
    key: fresh('ledger'),
    lock: fresh('lock'),
    push: records => send(records),
    pull,
  })

  it('one account refusing does not stop the others, and each keeps its own error', async () => {
    const items = [task(), entry()]
    const expired = 'Microsoft access for old@work.example expired or was revoked — reconnect it in Settings.'
    const dead = passTarget('acct-dead', async () => {
      throw new Error(expired)
    })
    const fine = provider()
    const ok = passTarget('acct-ok', fine.send)
    const picky = passTarget('acct-picky', provider({ refuse: r => (r.kind === 'event' ? { error: 'The event is invalid.', status: 400 } : null) }).send)
    const pass = await mirrorPass([dead, ok, picky], items, {}, ME, { pull: true })
    // before: the throw from the first account ended the loop, and the second
    // account's refusal was overwritten by the "synced" that followed
    expect(pass.accountErrors).toEqual({ 'acct-dead': expired, 'acct-picky': 'The event is invalid.' })
    expect(fine.sent().sort()).toEqual(items.map(i => i.id).sort())
    expect(ok.pull).toHaveBeenCalled()
    expect(picky.pull).toHaveBeenCalled()
    expect(dead.pull).not.toHaveBeenCalled()
    expect(pass).toMatchObject({ failed: true, waiting: 3 })
  })

  it('pulls when asked, or when something went out — not on every keystroke', async () => {
    const t = passTarget('google', provider().send)
    const items = [task()]
    await mirrorPass([t], items, {}, ME, { pull: false })
    expect(t.pull).toHaveBeenCalledTimes(1)
    await mirrorPass([t], items, {}, ME, { pull: false })
    expect(t.pull).toHaveBeenCalledTimes(1)
    await mirrorPass([t], items, {}, ME, { pull: true })
    expect(t.pull).toHaveBeenCalledTimes(2)
  })

  it('shows a dead account even when nothing was owed to it', async () => {
    const t = passTarget(
      'acct',
      provider().send,
      vi.fn(async () => {
        throw new Error('That Microsoft account is not connected.')
      }),
    )
    const pass = await mirrorPass([t], [], {}, ME, { pull: true })
    expect(pass.accountErrors).toEqual({ acct: 'That Microsoft account is not connected.' })
    expect(pass.failed).toBe(true)
  })
})

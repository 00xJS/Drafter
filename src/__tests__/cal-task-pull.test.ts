import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { googlePullRows, googleTaskBody } from '../../netlify/functions/lib/google.mjs'
import { graphTaskBody, graphTaskChange } from '../../netlify/functions/lib/microsoft.mjs'
import { type EntryChange, type GoogleChange, type MirrorStore, applyMirrorChanges, mirrorChangeWrites } from '../calendars'
import type { CalendarEntry, Item, Task, TaskStatus } from '../types'

// A task mirrored into Google or Outlook comes back when it is moved or
// deleted there, and now when it is renamed or its description rewritten
// there too. What that does to the task lived in a closure inside the
// planner's calendar hook, where no test reached it, and each rule has already
// shipped its bug once: the pull rewrote every untimed task to 09:00 and said
// Google had moved it, and moving a task to Wishlist marked it done seconds
// later. These run in London, where the 09:00 rewrite was seen: in summer, a
// task's local midnight is 23:00 the day before in UTC.

const zone = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Europe/London'
})
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const SITE = 'https://drafterz.netlify.app'
const STAMP = '2026-09-10T10:00:00.000Z'
/** A provider's edit five minutes after the task's own last one. */
const LATER = '2026-09-10T10:05:00.000Z'

/** Local midnight on a September day: a task with a day and no time. */
const day = (d: number) => new Date(2026, 8, d).toISOString()
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString()

function task(over: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id: 't1',
    title: 'Pay rent',
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: day(20),
    tags: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: STAMP,
    ...over,
  }
}

/** What googlePullRows (or the Outlook pull) hands back for a mirrored task. */
const change = (over: Partial<GoogleChange> = {}): GoogleChange => ({ taskId: 't1', deleted: false, start: '2026-09-20', allDay: true, updated: LATER, ...over })
const deleted = (over: Partial<GoogleChange> = {}) => change({ deleted: true, start: null, allDay: false, ...over })

const NOTHING = { writes: [], done: [], events: [], trashed: [] }

/** What Google hands back for a task copy written from googleTaskBody, with whatever the owner changed there. */
function googleCopy(t: Task, patch: Record<string, unknown> = {}) {
  const b = googleTaskBody({ ...t }, 'LIFE', SITE, 'Europe/London')
  return { id: `g-${t.id}`, status: 'confirmed', updated: LATER, summary: b.summary, description: b.description, start: b.start, end: b.end, extendedProperties: b.extendedProperties, ...patch }
}

/** What Graph hands back for a task copy written from graphTaskBody, asked for as text: Outlook's line endings, a trailing one. */
function graphCopy(t: Task, patch: Record<string, unknown> = {}) {
  const b = graphTaskBody({ ...t }, 'LIFE', SITE, 'Europe/London')
  return {
    id: `m-${t.id}`,
    subject: b.subject,
    body: { contentType: 'text', content: `${b.body.content.replace(/\n/g, '\r\n')}\r\n` },
    isAllDay: b.isAllDay,
    isCancelled: false,
    start: { dateTime: `${b.start.dateTime}.0000000`, timeZone: 'UTC' },
    lastModifiedDateTime: LATER,
    singleValueExtendedProperties: b.singleValueExtendedProperties,
    ...patch,
  }
}

const fromGoogle = (copy: unknown) => googlePullRows([copy]).changes
const fromOutlook = (copy: unknown) => [graphTaskChange(copy)!]
const PROVIDERS = [
  ['Google', (t: Task, patch?: Record<string, unknown>) => fromGoogle(googleCopy(t, patch))],
  ['Outlook', (t: Task, patch?: Record<string, unknown>) => fromOutlook(graphCopy(t, patch))],
] as const

describe('mirrorChangeWrites: a task moved in Google or Outlook', () => {
  it('runs where a local day starts the evening before in UTC', () => {
    expect(day(20)).toBe('2026-09-19T23:00:00.000Z')
  })

  it('writes nothing for an all-day change on the task’s own local day', () => {
    // what Google hands back straight after the push wrote the task as all-day
    expect(mirrorChangeWrites([task()], [change()])).toEqual(NOTHING)
  })

  it('writes nothing for a Google 09:00 echo', () => {
    // the old pull sent a date-only start as `${date}T09:00:00`: read by its date, it has not moved
    expect(mirrorChangeWrites([task()], [change({ start: '2026-09-20T09:00:00' })])).toEqual(NOTHING)
    // and a task that pull already moved to 09:00 is left alone by its own all-day event
    expect(mirrorChangeWrites([task({ dueAt: at(20, 9) })], [change()])).toEqual(NOTHING)
    // nor is one just after local midnight, which is the day before in UTC
    expect(mirrorChangeWrites([task({ dueAt: at(20, 0, 30) })], [change()])).toEqual(NOTHING)
  })

  it('moves an untimed task to local midnight of the day it was moved to', () => {
    const t = task()
    const { writes, done } = mirrorChangeWrites([t], [change({ start: '2026-09-22' })])
    expect(done).toEqual([])
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ id: 't1', title: 'Pay rent', status: 'todo', dueAt: day(22) })
    expect(writes[0].dueAt).toBe('2026-09-21T23:00:00.000Z')
    expect(writes[0].updatedAt > t.updatedAt).toBe(true)
  })

  it('moves an untimed task one day forward or back', () => {
    // the commonest reschedule. Here the new day's local midnight is 23:00 on
    // the task's old day in UTC, which the guard once read as no move at all
    const forward = mirrorChangeWrites([task()], [change({ start: '2026-09-21' })]).writes
    expect(forward).toHaveLength(1)
    expect(forward[0].dueAt).toBe(day(21))
    expect(forward[0].dueAt).toBe('2026-09-20T23:00:00.000Z')
    const back = mirrorChangeWrites([task()], [change({ start: '2026-09-19' })]).writes
    expect(back).toHaveLength(1)
    expect(back[0].dueAt).toBe(day(19))
    expect(back[0].dueAt).toBe('2026-09-18T23:00:00.000Z')
  })

  it('moves a timed task to the instant the provider gives, whatever zone it answers in', () => {
    const [row] = mirrorChangeWrites([task({ dueAt: at(20, 14) })], [change({ allDay: false, start: '2026-09-21T15:30:00+01:00' })]).writes
    expect(row.dueAt).toBe('2026-09-21T14:30:00.000Z')
  })

  it('ignores a change no newer than the task’s own last edit, one with no start, and one for a task it does not have', () => {
    expect(mirrorChangeWrites([task()], [change({ start: '2026-09-22', updated: STAMP })])).toEqual(NOTHING)
    expect(mirrorChangeWrites([task()], [change({ start: null })])).toEqual(NOTHING)
    expect(mirrorChangeWrites([task()], [change({ taskId: 'gone', start: '2026-09-22' })])).toEqual(NOTHING)
  })
})

describe('mirrorChangeWrites: a task deleted in Google or Outlook', () => {
  it('marks a mirrored task done, keeping the status Undo puts back', () => {
    const tasks = [task(), task({ id: 't2', status: 'doing' }), task({ id: 't3', status: 'blocked', dueAt: at(20, 14) })]
    const { writes, done } = mirrorChangeWrites(tasks, [deleted(), deleted({ taskId: 't2' }), deleted({ taskId: 't3' })])
    expect(writes).toEqual([])
    expect(done).toEqual([
      { id: 't1', prevStatus: 'todo' },
      { id: 't2', prevStatus: 'doing' },
      { id: 't3', prevStatus: 'blocked' },
    ])
  })

  it('does not mark done a task just moved to Wishlist: that cancellation was the mirror’s own', () => {
    // moved to Wishlist at 10:05, the mirror took the event down, and the pull saw it cancelled at 10:05:03
    const t = task({ status: 'wishlist', updatedAt: LATER })
    expect(mirrorChangeWrites([t], [deleted({ updated: '2026-09-10T10:05:03.000Z' })])).toEqual(NOTHING)
  })

  it('does not mark done a task whose date was cleared, or one already finished', () => {
    expect(mirrorChangeWrites([task({ dueAt: undefined })], [deleted()])).toEqual(NOTHING)
    expect(mirrorChangeWrites([task({ status: 'done' })], [deleted()])).toEqual(NOTHING)
    expect(mirrorChangeWrites([task({ status: 'canceled' })], [deleted()])).toEqual(NOTHING)
  })

  it('ignores a delete no newer than the task’s own last edit', () => {
    expect(mirrorChangeWrites([task()], [deleted({ updated: STAMP })])).toEqual(NOTHING)
  })

  it('a delete says nothing of the title or the notes', () => {
    const [row] = fromGoogle(googleCopy(task(), { status: 'cancelled' }))
    expect(row).toMatchObject({ taskId: 't1', deleted: true })
    expect(row).not.toHaveProperty('title')
    expect(row).not.toHaveProperty('notes')
    const [gone] = fromOutlook(graphCopy(task(), { isCancelled: true }))
    expect(gone).not.toHaveProperty('title')
    expect(gone).not.toHaveProperty('notes')
  })
})

describe.each(PROVIDERS)('mirrorChangeWrites: a task renamed or rewritten in %s', (_, pulled) => {
  const lease = () => task({ priority: 'high', description: 'Ring the landlord about the lease' })

  it('an echo of Drafter’s own copy changes nothing: its footer and priority mark are Drafter’s', () => {
    expect(mirrorChangeWrites([lease()], pulled(lease()))).toEqual(NOTHING)
    expect(mirrorChangeWrites([task({ priority: 'urgent' })], pulled(task({ priority: 'urgent' })))).toEqual(NOTHING)
    // no description at all, just the footer
    expect(mirrorChangeWrites([task()], pulled(task()))).toEqual(NOTHING)
  })

  it('a rename made there comes back, without the priority mark', () => {
    const t = lease()
    const title = _ === 'Google' ? { summary: '▲ Pay the rent early' } : { subject: '▲ Pay the rent early' }
    const { writes } = mirrorChangeWrites([t], pulled(t, title))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ id: 't1', title: 'Pay the rent early', dueAt: t.dueAt, priority: 'high', description: t.description })
    expect(writes[0].updatedAt > t.updatedAt).toBe(true)
  })

  it('a description rewritten there comes back, Drafter’s footer taken off', () => {
    const t = lease()
    const text = 'Ring the landlord first\n\nThen the agent\n\nProject: LIFE\n\nStatus: todo · Priority: high\n\nOpen in Drafter: ' + SITE
    const notes = _ === 'Google' ? { description: text } : { body: { contentType: 'text', content: text.replace(/\n/g, '\r\n') } }
    const [row] = mirrorChangeWrites([t], pulled(t, notes)).writes
    expect(row.description).toBe('Ring the landlord first\n\nThen the agent')
    expect(row.title).toBe('Pay rent')
  })

  it('a move and a rename made together are one write', () => {
    const t = lease()
    const patch =
      _ === 'Google'
        ? { summary: '▲ Pay rent (card)', start: { date: '2026-09-22' }, end: { date: '2026-09-23' } }
        : { subject: '▲ Pay rent (card)', start: { dateTime: '2026-09-22T00:00:00.0000000', timeZone: 'UTC' } }
    const { writes } = mirrorChangeWrites([t], pulled(t, patch))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ title: 'Pay rent (card)', dueAt: day(22) })
  })

  it('never overrides a Drafter edit newer than the change', () => {
    const t = lease()
    const title = _ === 'Google' ? { summary: 'Something else' } : { subject: 'Something else' }
    expect(mirrorChangeWrites([{ ...t, updatedAt: '2026-09-10T10:06:00.000Z' }], pulled(t, title))).toEqual(NOTHING)
  })

  it('an emptied title is no rename, and “Untitled task” is only Drafter’s placeholder', () => {
    const emptied = _ === 'Google' ? { summary: undefined } : { subject: '' }
    expect(mirrorChangeWrites([lease()], pulled(lease(), emptied))).toEqual(NOTHING)
    const untitled = task({ title: '' })
    expect(mirrorChangeWrites([untitled], pulled(untitled))).toEqual(NOTHING)
  })

  it('a note of the owner’s that ends like Drafter’s own footer stays theirs', () => {
    const t = task({ description: 'Kitchen\n\nProject: phase 2' })
    expect(mirrorChangeWrites([t], pulled(t))).toEqual(NOTHING)
  })
})

describe('what each calendar does to text, which is nobody’s edit', () => {
  it('Google’s own editor saves HTML: the words come back, not the markup', () => {
    const t = task({ description: 'Ring the landlord' })
    const html = `Ring the landlord <b>first</b> &amp; the agent<br><ul><li>lease</li><li>deposit</li></ul><br>Project: LIFE<br><br>Status: todo &middot; Priority: normal<br><br>Open in Drafter: <a href="${SITE}">${SITE}</a>`
    const [row] = mirrorChangeWrites([t], fromGoogle(googleCopy(t, { description: html }))).writes
    expect(row.description).toBe('Ring the landlord first & the agent\n- lease\n- deposit')
  })

  it('Outlook: line endings, blank lines and a linked address change nothing', () => {
    const t = task({ description: 'Lease at https://example.test/lease\nDeposit too' })
    const content = `Lease at https://example.test/lease<https://example.test/lease>\r\nDeposit too\r\n\r\n\r\nProject: LIFE\r\n\r\nStatus: todo · Priority: normal\r\n\r\nOpen in Drafter: ${SITE}<${SITE}/>\r\n`
    expect(mirrorChangeWrites([t], fromOutlook(graphCopy(t, { body: { contentType: 'text', content } })))).toEqual(NOTHING)
  })

  it('an older function sends no title and no notes: only the date can move', () => {
    // `change` carries neither, as the functions did before
    const { writes } = mirrorChangeWrites([task({ description: 'keep me' })], [change({ start: '2026-09-22' })])
    expect(writes[0]).toMatchObject({ title: 'Pay rent', description: 'keep me', dueAt: day(22) })
  })
})

/** The store as applyMirrorChanges sees it, recording what was done to it. */
function fakeStore(tasks: Task[], events: CalendarEntry[] = []) {
  const trashed: string[] = []
  const restored: string[] = []
  const store: MirrorStore & { trashed: string[]; restored: string[] } = {
    tasks,
    events,
    trashed,
    restored,
    upsert(item: Item) {
      if (item.kind === 'task') store.tasks = store.tasks.map(t => (t.id === item.id ? item : t))
      if (item.kind === 'event') store.events = store.events.map(e => (e.id === item.id ? item : e))
    },
    setStatus(id: string, status: TaskStatus) {
      const t = store.tasks.find(x => x.id === id)
      if (!t || t.status === status) return null
      store.tasks = store.tasks.map(x => (x.id === id ? { ...x, status } : x))
      return true
    },
    remove(id: string) {
      trashed.push(id)
      store.events = store.events.filter(e => e.id !== id)
    },
    restore(ids: string[]) {
      restored.push(...ids)
    },
  }
  return store
}

function entry(over: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    kind: 'event',
    id: 'ev1',
    title: 'Dentist',
    start: '2026-09-21T14:00:00.000Z',
    end: '2026-09-21T15:00:00.000Z',
    allDay: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: STAMP,
    ...over,
  }
}
const entryGone = (over: Partial<EntryChange> = {}): EntryChange => ({ eventId: 'ev1', deleted: true, title: '', start: null, end: null, allDay: false, updated: LATER, ...over })

describe('applyMirrorChanges: saves what came back, and says so once', () => {
  const toasts = () => {
    const seen: { msg: string; undo?: () => void }[] = []
    return { seen, toast: (msg: string, undo?: () => void) => void seen.push({ msg, undo }) }
  }

  it('a move says moved, as it always did; a rename says updated', () => {
    const t = toasts()
    const store = fakeStore([task()])
    applyMirrorChanges(store, { changes: [change({ start: '2026-09-22' })] }, 'Google Calendar', t.toast)
    expect(t.seen).toEqual([{ msg: '1 task moved from Google Calendar', undo: undefined }])
    expect(store.tasks[0].dueAt).toBe(day(22))
    applyMirrorChanges(fakeStore([task()]), { changes: [change({ title: 'Pay the rent' })] }, 'Outlook', t.toast)
    expect(t.seen[1].msg).toBe('1 task updated from Outlook')
  })

  it('a task deleted there is marked done, and Undo puts its status back', () => {
    const t = toasts()
    const store = fakeStore([task({ status: 'doing' })])
    applyMirrorChanges(store, { changes: [deleted()] }, 'Outlook', t.toast)
    expect(store.tasks[0].status).toBe('done')
    expect(t.seen[0].msg).toBe('1 task marked done from Outlook')
    t.seen[0].undo!()
    expect(store.tasks[0].status).toBe('doing')
  })

  it('an event deleted there goes to the Trash, and Undo brings it back', () => {
    const t = toasts()
    const store = fakeStore([], [entry(), entry({ id: 'ev2' })])
    applyMirrorChanges(store, { entries: [entryGone(), entryGone({ eventId: 'ev2' })] }, 'Google Calendar', t.toast)
    expect(store.trashed).toEqual(['ev1', 'ev2'])
    expect(t.seen[0].msg).toBe('2 events moved to Trash from Google Calendar')
    t.seen[0].undo!()
    expect(store.restored).toEqual(['ev1', 'ev2'])
  })

  it('one toast for everything one pull brought, its Undo taking back only what came off the lists', () => {
    const t = toasts()
    const store = fakeStore([task(), task({ id: 't2' })], [entry()])
    applyMirrorChanges(store, { changes: [change({ start: '2026-09-22' }), deleted({ taskId: 't2' })], entries: [entryGone()] }, 'Outlook', t.toast)
    expect(t.seen).toHaveLength(1)
    expect(t.seen[0].msg).toBe('1 task moved, 1 task marked done, 1 event moved to Trash from Outlook')
    t.seen[0].undo!()
    expect(store.tasks.find(x => x.id === 't2')!.status).toBe('todo')
    expect(store.restored).toEqual(['ev1'])
    // the move is the owner's own, made in Outlook: Undo leaves it
    expect(store.tasks.find(x => x.id === 't1')!.dueAt).toBe(day(22))
  })

  it('says nothing when nothing changed', () => {
    const t = toasts()
    applyMirrorChanges(fakeStore([task()], [entry()]), { changes: [change()], entries: [entryGone({ updated: STAMP })] }, 'Google Calendar', t.toast)
    expect(t.seen).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { PERSONAL_KINDS, SYNC_KINDS, readableRow } from '../../shared/kinds.mts'
import {
  NOTICE_LINES_MAX,
  activityLine,
  dueWords,
  mergeNotice,
  noticeBucket,
  noticeId,
  noticeRecipients,
  noticeTitle,
  noticeTypeOf,
  type ActivityEvent,
} from '../../shared/notices.mts'
import { inTrash } from '../itemops'
import { sanitizeItem, sanitizeNotice, sanitizeTask } from '../schema'
import { purgeTombstone } from '../sync'
import type { Notice } from '../types'

// Notices (v3.32): the notification hub's records, and the rules that decide
// who hears about what a member does to a task they share.

const JOE = 'joe-0000-4000-8000-00000000000a'
const MARIA = 'maria-000-4000-8000-00000000000b'
const T = '2026-09-23T16:00:00.000Z'

const notice = (over: Partial<Notice> = {}): Notice => ({
  kind: 'notice',
  id: noticeId(JOE, 'bins', 1),
  at: T,
  type: 'progress',
  actorId: MARIA,
  target: { kind: 'task', id: 'bins' },
  title: 'Maria made progress on “Take bins out”',
  lines: ['Ticked “Green bin”'],
  createdAt: T,
  updatedAt: T,
  ...over,
})

describe('the kind', () => {
  it('is stored by the server and personal: its recipient’s alone', () => {
    expect(SYNC_KINDS.has('notice')).toBe(true)
    expect(PERSONAL_KINDS.has('notice')).toBe(true)
    // the member a notice is about never reads their housemate's
    expect(readableRow(notice(), JOE, MARIA)).toBe(false)
    expect(readableRow(notice(), JOE, JOE)).toBe(true)
  })

  it('never shows in the Trash', () => {
    expect(inTrash(notice({ deletedAt: T }))).toBe(false)
  })
})

describe('sanitizeNotice', () => {
  it('keeps what the hub reads', () => {
    const n = notice({ readAt: '2026-09-23T17:00:00.000Z', ownerId: JOE })
    expect(sanitizeItem(n)).toEqual(n)
  })

  it('keeps the newest eight lines, each one line long at most', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`)
    expect(sanitizeNotice(notice({ lines }))?.lines).toEqual(lines.slice(-NOTICE_LINES_MAX))
    expect(sanitizeNotice(notice({ lines: ['  ', 'x'.repeat(400)] }))?.lines).toEqual(['x'.repeat(160)])
  })

  it('refuses one with no headline or a kind the hub does not know, but keeps a tombstone', () => {
    expect(sanitizeNotice(notice({ title: ' ' }))).toBeNull()
    expect(sanitizeNotice({ ...notice(), type: 'gossip' })).toBeNull()
    // the nightly job's tombstone carries no words at all, and must still land
    const tomb = purgeTombstone('notice', notice().id, '2026-10-24T03:00:00.000Z')
    expect(sanitizeItem(tomb)).toMatchObject({ kind: 'notice', id: notice().id, deletedAt: '2026-10-24T03:00:00.000Z', purged: true })
  })

  it('drops a target it cannot open', () => {
    expect(sanitizeNotice({ ...notice(), target: { kind: 'journal', id: 'x' } })?.target).toBeUndefined()
    expect(sanitizeNotice({ ...notice(), target: { kind: 'task' } })?.target).toBeUndefined()
  })
})

describe('the task fields notices read', () => {
  const base = { kind: 'task', id: 't', title: 'Bins', status: 'todo', priority: 'normal', tags: [], createdAt: T, updatedAt: T }

  it('a comment keeps who wrote it, and one from before keeps no name', () => {
    const t = sanitizeTask({
      ...base,
      comments: [
        { id: 'c1', body: 'Old one', createdAt: '2026-09-01T00:00:00.000Z' },
        { id: 'c2', body: 'New one', createdAt: T, by: MARIA },
      ],
    })
    expect(t?.comments).toEqual([
      { id: 'c1', body: 'Old one', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 'c2', body: 'New one', createdAt: T, by: MARIA },
    ])
  })

  it('a task keeps who handed it over', () => {
    expect(sanitizeTask({ ...base, assigneeId: MARIA, assignedBy: JOE })).toMatchObject({ assigneeId: MARIA, assignedBy: JOE })
    expect(sanitizeTask({ ...base, assignedBy: { who: JOE } })?.assignedBy).toBeUndefined()
  })
})

describe('who hears about an edit', () => {
  const ticked: ActivityEvent = { type: 'checklist', detail: 'Green bin', done: true }
  const done: ActivityEvent = { type: 'status', detail: 'done' }
  const said: ActivityEvent = { type: 'comment', detail: 'Can you get oat milk?' }
  const due: ActivityEvent = { type: 'due', detail: T }
  const heard = (m: Map<string, ActivityEvent[]>) => Object.fromEntries([...m].map(([who, es]) => [who === JOE ? 'joe' : who === MARIA ? 'maria' : who, es.map(e => e.type)]))

  it('the assignee’s progress, words and finish go to whoever handed it over', () => {
    const task = { ownerId: JOE, assigneeId: MARIA, assignedBy: JOE }
    expect(heard(noticeRecipients(task, MARIA, [ticked, said, done]))).toEqual({ joe: ['checklist', 'comment', 'status'] })
  })

  it('the owner stands in for a task assigned before the assigner was kept', () => {
    expect(heard(noticeRecipients({ ownerId: JOE, assigneeId: MARIA }, MARIA, [done]))).toEqual({ joe: ['status'] })
  })

  it('the assigner who is not the owner hears it too', () => {
    // Maria handed Joe his own task
    expect(heard(noticeRecipients({ ownerId: JOE, assigneeId: JOE, assignedBy: MARIA }, JOE, [done]))).toEqual({ maria: ['status'] })
  })

  it('the assignee hears what changes their job — not the assigner ticking steps', () => {
    const task = { ownerId: JOE, assigneeId: MARIA, assignedBy: JOE }
    expect(heard(noticeRecipients(task, JOE, [{ type: 'assigned', detail: MARIA }, ticked, said, due, { type: 'title', detail: 'Bins' }, done]))).toEqual({
      maria: ['assigned', 'comment', 'due', 'title', 'status'],
    })
  })

  it('on a shared task nobody is doing, its owner hears a finish or a comment, and nothing else', () => {
    expect(heard(noticeRecipients({ ownerId: JOE }, MARIA, [ticked, due, said, done]))).toEqual({ joe: ['comment', 'status'] })
    expect(heard(noticeRecipients({ ownerId: JOE }, MARIA, [ticked, { type: 'status', detail: 'doing' }]))).toEqual({})
  })

  it('a third hand’s finish or comment reaches whoever is doing it', () => {
    // Maria's own task, assigned to herself; Joe comments
    expect(heard(noticeRecipients({ ownerId: MARIA, assigneeId: MARIA, assignedBy: MARIA }, JOE, [ticked, said]))).toEqual({ maria: ['comment'] })
  })

  it('never the actor, whatever the roles say', () => {
    expect(noticeRecipients({ ownerId: JOE, assigneeId: JOE, assignedBy: JOE }, JOE, [done, said]).size).toBe(0)
    expect(noticeRecipients({ ownerId: JOE }, JOE, [done]).size).toBe(0)
    expect(noticeRecipients({}, JOE, [done]).size).toBe(0)
  })
})

describe('what a notice says', () => {
  it('its kind is the weightiest change in it', () => {
    expect(noticeTypeOf([{ type: 'checklist', detail: 'x', done: true }])).toBe('progress')
    expect(noticeTypeOf([{ type: 'checklist', detail: 'x', done: true }, { type: 'comment', detail: 'y' }])).toBe('comment')
    expect(noticeTypeOf([{ type: 'comment', detail: 'y' }, { type: 'status', detail: 'done' }])).toBe('done')
    expect(noticeTypeOf([{ type: 'due', detail: T }])).toBe('changed')
    expect(noticeTypeOf([{ type: 'status', detail: 'doing' }])).toBe('progress')
  })

  it('a headline as the lock screen says it', () => {
    expect(noticeTitle('done', 'Maria', 'Take bins out')).toBe('Maria finished “Take bins out”')
    expect(noticeTitle('assigned', 'Joe', 'Book the dentist')).toBe('Joe asked you to do “Book the dentist”')
    expect(noticeTitle('comment', '', '   ')).toBe('Someone commented on “Untitled task”')
    expect(noticeTitle('progress', 'Maria', 'x'.repeat(100))).toMatch(/^Maria made progress on “x+…”$/)
  })

  it('a line for each change', () => {
    expect(activityLine({ type: 'checklist', detail: 'Green bin', done: true })).toBe('Ticked “Green bin”')
    expect(activityLine({ type: 'checklist', detail: 'Green bin', done: false })).toBe('Unticked “Green bin”')
    expect(activityLine({ type: 'comment', detail: 'Can you\nget oat milk?' })).toBe('“Can you get oat milk?”')
    expect(activityLine({ type: 'status', detail: 'done' })).toBe('Marked it done')
    expect(activityLine({ type: 'status', detail: 'doing' })).toBe('Started it')
    expect(activityLine({ type: 'title', detail: 'Bins, both of them' })).toBe('Renamed it “Bins, both of them”')
    expect(activityLine({ type: 'due', detail: '' })).toBe('Took the due date off')
    expect(activityLine({ type: 'assigned', detail: MARIA })).toBeNull()
  })

  it('a due date in the reader’s own zone, with no time for a day that has none', () => {
    // 5pm in Phoenix; and a date-only task, stored at Phoenix midnight
    expect(dueWords('2026-09-26T00:00:00.000Z', 'America/Phoenix')).toBe('Fri, Sep 25, 5:00 PM')
    expect(dueWords('2026-09-26T07:00:00.000Z', 'America/Phoenix')).toBe('Sat, Sep 26')
    expect(activityLine({ type: 'due', detail: '2026-09-26T07:00:00.000Z' }, 'America/Phoenix')).toBe('Due Sat, Sep 26')
    expect(dueWords('not a date', 'UTC')).toBe('')
  })
})

describe('one notice per member, task and quarter of an hour', () => {
  it('an id per bucket', () => {
    expect(noticeBucket(Date.parse('2026-09-23T16:14:59.999Z'))).toBe(noticeBucket(Date.parse('2026-09-23T16:00:00.000Z')))
    expect(noticeBucket(Date.parse('2026-09-23T16:15:00.000Z'))).toBe(noticeBucket(Date.parse('2026-09-23T16:00:00.000Z')) + 1)
    expect(noticeId(JOE, 'bins', 7)).toBe(`notice~${JOE}~bins~7`)
  })

  it('news folds in: lines appended, the weightier headline, the later time, unread again', () => {
    const read = notice({ readAt: '2026-09-23T16:05:00.000Z' })
    const later = notice({ at: '2026-09-23T16:10:00.000Z', type: 'done', title: 'Maria finished “Take bins out”', lines: ['Marked it done'], createdAt: '2026-09-23T16:10:00.000Z' })
    expect(mergeNotice(read, later)).toMatchObject({
      type: 'done',
      title: 'Maria finished “Take bins out”',
      lines: ['Ticked “Green bin”', 'Marked it done'],
      at: '2026-09-23T16:10:00.000Z',
      createdAt: T,
      readAt: undefined,
    })
    // a lighter change keeps the weightier headline it already had
    const comment = notice({ at: '2026-09-23T16:12:00.000Z', type: 'changed', title: 'Maria changed “Take bins out”', lines: ['Due Fri'] })
    expect(mergeNotice(mergeNotice(read, later), comment)).toMatchObject({ type: 'done', title: 'Maria finished “Take bins out”' })
  })

  it('keeps only the newest eight lines', () => {
    let n = notice({ lines: [] })
    for (let i = 0; i < 12; i++) n = mergeNotice(n, notice({ lines: [`step ${i}`] }))
    expect(n.lines).toEqual(Array.from({ length: 8 }, (_, i) => `step ${i + 4}`))
  })

  it('the same batch told twice (two tabs) is appended once', () => {
    const once = mergeNotice(notice({ lines: ['Ticked “Green bin”'] }), notice({ lines: ['“On it”', 'Marked it done'] }))
    expect(mergeNotice(once, notice({ lines: ['“On it”', 'Marked it done'] })).lines).toEqual(['Ticked “Green bin”', '“On it”', 'Marked it done'])
  })

  it('a tombstone takes the news as new', () => {
    expect(mergeNotice(notice({ deletedAt: T, lines: ['old'] }), notice({ lines: ['new'] })).lines).toEqual(['new'])
  })
})

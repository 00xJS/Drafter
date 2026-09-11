import { describe, expect, it } from 'vitest'
import { feedFor, withOwner } from '../../netlify/functions/lib/feedrows.mjs'
import { isMirroredTask } from '../calendars'

// Two calendar bugs found by the Google/Microsoft parity audit and fixed by
// hand, each pinned here so it cannot quietly come back.

const ME = '00000000-0000-0000-0000-00000000000a'
const PEER = '00000000-0000-0000-0000-00000000000b'
const SITE = 'https://drafterz.netlify.app'

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: 'task',
  id,
  title: `Task ${id}`,
  description: '',
  status: 'todo',
  priority: 'normal',
  dueAt: '2026-09-20T14:00:00.000Z',
  tags: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...extra,
})
const project = (id: string) => ({
  kind: 'project',
  id,
  name: `Project ${id}`,
  color: '#f97316',
  status: 'active',
  targetAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
})
const entry = (id: string) => ({
  kind: 'event',
  id,
  title: `Event ${id}`,
  start: '2026-09-21T10:00:00.000Z',
  end: '2026-09-21T11:00:00.000Z',
  allDay: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
})

// What the table holds: sync_posts strips ownerId before storing, so a row
// read straight from it has no owner inside its data.
const stored = [
  { data: task('mine'), user_id: ME },
  { data: task('theirs'), user_id: PEER },
  { data: project('myproj'), user_id: ME },
  { data: project('peerproj'), user_id: PEER },
  { data: entry('myev'), user_id: ME },
  { data: entry('peerev'), user_id: PEER },
]
const uids = (rows: { uid: string }[]) => rows.map(r => r.uid).sort()

describe('the ICS feed publishes only the reader’s own rows', () => {
  it('leaked every household peer’s rows when the owner was missing — the bug', () => {
    const leaked = uids(feedFor(stored.map(r => r.data), SITE, 'Europe/London', ME))
    expect(leaked).toContain('task-theirs@drafter')
    expect(leaked).toContain('project-peerproj@drafter')
    expect(leaked).toContain('event-peerev@drafter')
  })

  it('keeps only mine once each row carries its owner — the fix', () => {
    const rows = uids(feedFor(stored.map(r => withOwner(r.data, r.user_id)), SITE, 'Europe/London', ME))
    expect(rows).toEqual(['event-myev@drafter', 'project-myproj@drafter', 'task-mine@drafter'])
  })

  it('still publishes a peer’s task that is assigned to me', () => {
    const assigned = withOwner(task('assigned', { assigneeId: ME }), PEER)
    expect(uids(feedFor([assigned], SITE, 'Europe/London', ME))).toEqual(['task-assigned@drafter'])
  })

  it('leaves a row with no owner untouched rather than inventing one', () => {
    const orphan = task('orphan')
    expect(withOwner(orphan, null)).toBe(orphan)
    expect(withOwner(orphan, undefined)).toBe(orphan)
  })
})

describe('isMirroredTask: a cancellation the mirror caused is not the owner’s delete', () => {
  it('is true only for an open, dated, live task — exactly what the mirror pushes', () => {
    expect(isMirroredTask({ status: 'todo', dueAt: '2026-09-20T14:00:00.000Z' })).toBe(true)
    expect(isMirroredTask({ status: 'doing', dueAt: '2026-09-20T14:00:00.000Z' })).toBe(true)
    expect(isMirroredTask({ status: 'blocked', dueAt: '2026-09-20T14:00:00.000Z' })).toBe(true)
  })

  it('is false after moving to Wishlist, so the pull no longer marks it done', () => {
    expect(isMirroredTask({ status: 'wishlist', dueAt: '2026-09-20T14:00:00.000Z' })).toBe(false)
  })

  it('is false once the due date is cleared, for the same reason', () => {
    expect(isMirroredTask({ status: 'todo', dueAt: undefined })).toBe(false)
  })

  it('is false for finished and deleted tasks', () => {
    expect(isMirroredTask({ status: 'done', dueAt: '2026-09-20T14:00:00.000Z' })).toBe(false)
    expect(isMirroredTask({ status: 'canceled', dueAt: '2026-09-20T14:00:00.000Z' })).toBe(false)
    expect(isMirroredTask({ status: 'todo', dueAt: '2026-09-20T14:00:00.000Z', deletedAt: '2026-09-10T00:00:00.000Z' })).toBe(false)
  })
})

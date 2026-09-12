import { describe, expect, it } from 'vitest'
import { buildSnapshot } from '../../netlify/functions/lib/backup.mjs'
import { KINDS, shapeDataStats } from '../../netlify/functions/lib/datastats.mjs'
import { feedFor, readableItems, withOwner } from '../../netlify/functions/lib/feedrows.mjs'
import { buildDigest, visibleItemsFor } from '../../shared/digest.mjs'

// kind 'note' (v3.13) through the server's readers, which all read with the
// service key and so decide for themselves what a row is. A note is a page of
// text shared with the household: it is backed up with its owner and reaches a
// peer like a task, and the calendar feed and the morning digest have nothing
// to say about it. None of them needed a change for that; this keeps it so.

const ME = '00000000-0000-0000-0000-00000000000a'
const PEER = '00000000-0000-0000-0000-00000000000b'
const SITE = 'https://drafter.example.test'
const at = '2026-09-01T00:00:00.000Z'

const note = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: 'note',
  id,
  title: 'Paint colours',
  body: '<p>Sage for the hall</p><p><img data-media="m-swatch" alt="swatch"></p>',
  projectId: 'p1',
  createdAt: at,
  updatedAt: at,
  ...extra,
})

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: 'task',
  id,
  title: 'Bins out',
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  dueAt: '2026-09-12T09:00:00.000Z',
  createdAt: at,
  updatedAt: at,
  ...extra,
})

/** A note carrying every field a task or an entry would be published by, so only its kind can keep it out. */
const decoy = note('decoy', { status: 'todo', dueAt: '2026-09-01T09:00:00.000Z', start: '2026-09-12T10:00:00.000Z', end: '2026-09-12T11:00:00.000Z' })

describe('notes on the server', () => {
  it('ride in their owner’s backup, whole', () => {
    const snap = buildSnapshot(ME, [{ user_id: ME, data: note('n1') }, { user_id: ME, data: task('t1') }], new Date(at))
    expect(snap.items).toEqual([note('n1'), task('t1')])
  })

  it('reach a household peer like a task, through the digest’s and the feed’s readers', () => {
    const rows = [{ user_id: PEER, data: note('peer-note') }]
    expect((visibleItemsFor(rows, ME, [PEER], ME) as { id: string }[]).map(i => i.id)).toEqual(['peer-note'])
    expect(readableItems(rows, ME).map(i => i.id)).toEqual(['peer-note'])
  })

  it('never reach the calendar feed, whatever fields they carry', () => {
    const items = [withOwner(task('t1'), ME), withOwner(note('n1'), ME), withOwner(decoy, ME)]
    expect(feedFor(items, SITE, 'Europe/London', ME).map(e => e.uid)).toEqual(['task-t1@drafter'])
  })

  it('leave the morning digest exactly as it was', () => {
    const now = new Date('2026-09-12T07:00:00.000Z')
    const without = buildDigest([task('t1')], 'UTC', now)
    const withNotes = buildDigest([task('t1'), note('n1'), decoy], 'UTC', now)
    expect(withNotes.lines).toEqual(without.lines)
    expect(withNotes.overdue).toEqual([])
    expect(withNotes.dueToday.map(t => t.id)).toEqual(['t1'])
  })

  it('are counted in Admin → Data, at zero when there are none', () => {
    expect(KINDS).toContain('note')
    expect(shapeDataStats([]).kinds.note).toBe(0)
    const stats = shapeDataStats([
      { user_id: ME, deleted: false, kind: 'note', purged: null, synced_at: at },
      { user_id: ME, deleted: true, kind: 'note', purged: 'true', synced_at: at },
    ])
    expect(stats.kinds.note).toBe(1)
    expect(stats).toMatchObject({ live: 1, tombstones: 1, purged: 1 })
  })
})

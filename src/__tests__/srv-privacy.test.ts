import { describe, expect, it } from 'vitest'
import { PERSONAL_KINDS } from '../../shared/kinds.mjs'
import { feedFor, readableItems } from '../../netlify/functions/lib/feedrows.mjs'
import { buildSnapshot } from '../../netlify/functions/lib/backup.mjs'

// Every reader under the service key bypasses the database policy, so each has
// to drop a household member's personal rows itself. These pin the two that
// read the household's rows in bulk: the ICS feed and the nightly backup.

const ME = '00000000-0000-0000-0000-00000000000a'
const PEER = '00000000-0000-0000-0000-00000000000b'
const row = (user_id: string, kind: string | undefined, id: string, extra: Record<string, unknown> = {}) => ({
  user_id,
  data: { ...(kind ? { kind } : {}), id, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...extra },
})

describe('the ICS feed never holds a household member’s personal rows', () => {
  it('drops a peer’s journal, review, calendar, habit and routine, and keeps their shared rows and my own', () => {
    const rows = [
      ...[...PERSONAL_KINDS].map(k => row(PEER, k, `peer-${k}`)),
      row(PEER, 'task', 'peer-task'),
      row(PEER, 'event', 'peer-event'),
      row(ME, 'habit', 'my-habit'),
      row(ME, 'journal', 'my-journal'),
    ]
    expect(readableItems(rows, ME).map(i => i.id).sort()).toEqual(['my-habit', 'my-journal', 'peer-event', 'peer-task'])
  })

  it('carries each row’s owner and still converts a legacy row with no kind', () => {
    const items = readableItems([row(PEER, undefined, 'legacy', { title: 'Old post', status: 'idea' }), row(ME, 'task', 'mine', { status: 'todo' })], ME)
    expect(items.map(i => [i.id, i.kind, i.ownerId])).toEqual([
      ['legacy', 'task', PEER],
      ['mine', 'task', ME],
    ])
  })

  it('publishes the same feed as before for the rows that remain', () => {
    const due = { title: 'Bins', status: 'todo', priority: 'normal', dueAt: '2026-09-20T14:00:00.000Z', tags: [] }
    const items = readableItems([row(ME, 'task', 't1', due), row(PEER, 'habit', 'h1')], ME)
    expect(feedFor(items, 'https://site.test', 'Europe/London', ME).map(r => r.uid)).toEqual(['task-t1@drafter'])
  })
})

describe('a backup snapshot holds no other member’s personal rows', () => {
  it('keeps the account’s own personal rows and drops a peer’s, even when a caller hands them over', () => {
    const snap = buildSnapshot(ME, [
      row(ME, 'journal', 'j-mine'),
      row(PEER, 'journal', 'j-peer'),
      row(PEER, 'habit', 'h-peer'),
      row(PEER, 'routine', 'r-peer'),
      row(PEER, 'task', 't-peer'),
      row(ME, 'routine', 'r-mine'),
    ])
    expect((snap.items as { id: string }[]).map(i => i.id)).toEqual(['j-mine', 't-peer', 'r-mine'])
  })
})

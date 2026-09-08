import { describe, expect, it } from 'vitest'
import { KEEP_BACKUPS, backupPath, buildSnapshot, dayKey, groupRowsByUser, isSnapshotPath, snapshotsToDrop } from '../../netlify/functions/lib/backup.mjs'
import { shapeDataStats } from '../../netlify/functions/lib/datastats.mjs'

const UID_A = '11111111-1111-4111-8111-111111111111'
const UID_B = '22222222-2222-4222-8222-222222222222'

describe('backup snapshot builder', () => {
  it('writes exportedAt, the owner and the raw records — nothing else', () => {
    const rows = [{ user_id: UID_A, data: { id: 't1', kind: 'task', title: 'Bins' } }, { user_id: UID_A, data: { id: 'p1', kind: 'project' } }]
    expect(buildSnapshot(UID_A, rows, new Date('2026-09-07T22:00:00.000Z'))).toEqual({
      exportedAt: '2026-09-07T22:00:00.000Z',
      userId: UID_A,
      items: [
        { id: 't1', kind: 'task', title: 'Bins' },
        { id: 'p1', kind: 'project' },
      ],
    })
  })

  it('names the object by owner and UTC day', () => {
    expect(dayKey(new Date('2026-09-07T22:00:00.000Z'))).toBe('2026-09-07')
    expect(backupPath(UID_A, '2026-09-07')).toBe(`backups/${UID_A}/2026-09-07.json`)
  })

  it('groups rows per owner and leaves unowned rows out — there is no account to restore them into', () => {
    const grouped = groupRowsByUser([
      { user_id: UID_A, data: { id: '1' } },
      { user_id: null, data: { id: '2' } },
      { user_id: UID_B, data: { id: '3' } },
      { user_id: UID_A, data: { id: '4' } },
    ])
    expect([...grouped.keys()]).toEqual([UID_A, UID_B])
    expect(grouped.get(UID_A)).toHaveLength(2)
    expect(grouped.get(UID_B)).toHaveLength(1)
  })

  it('keeps the newest KEEP_BACKUPS snapshots and ignores anything that is not one', () => {
    const names = Array.from({ length: 20 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}.json`)
    const { kept, drop } = snapshotsToDrop([...names, 'notes.txt', undefined])
    expect(kept).toHaveLength(KEEP_BACKUPS)
    expect(kept[0]).toBe('2026-09-20.json')
    expect(drop).toEqual(['2026-09-06.json', '2026-09-05.json', '2026-09-04.json', '2026-09-03.json', '2026-09-02.json', '2026-09-01.json'])
  })

  it('only ever signs a path that is one of our own snapshots', () => {
    expect(isSnapshotPath(`backups/${UID_A}/2026-09-07.json`)).toBe(true)
    expect(isSnapshotPath(`backups/${UID_A}/../../secret.json`)).toBe(false)
    expect(isSnapshotPath('backups/2026-09-07.json')).toBe(false)
    expect(isSnapshotPath(`uploads/${UID_A}/2026-09-07.json`)).toBe(false)
    expect(isSnapshotPath(`backups/${UID_A}/2026-09-07.json.txt`)).toBe(false)
    expect(isSnapshotPath(null)).toBe(false)
  })
})

describe('data overview shaping', () => {
  const rows = [
    { user_id: UID_A, deleted: false, kind: 'task', purged: null, synced_at: '2026-09-05T10:00:00Z' },
    { user_id: UID_A, deleted: false, kind: 'task', purged: null, synced_at: '2026-09-07T10:00:00Z' },
    { user_id: UID_A, deleted: false, kind: 'project', purged: null, synced_at: '2026-09-06T10:00:00Z' },
    { user_id: UID_A, deleted: false, kind: null, purged: null, synced_at: '2026-09-01T10:00:00Z' },
    { user_id: UID_B, deleted: false, kind: 'person', purged: null, synced_at: '2026-09-02T10:00:00Z' },
    { user_id: UID_B, deleted: true, kind: 'task', purged: 'true', synced_at: '2026-09-03T10:00:00Z' },
    { user_id: null, deleted: true, kind: 'task', purged: null, synced_at: '2026-08-30T10:00:00Z' },
  ]
  const stats = shapeDataStats(rows, { emails: { [UID_A]: 'owner@example.com', [UID_B]: 'friend@example.com' } })

  it('tallies live records by kind, counting pre-kind rows as legacy', () => {
    expect(stats.live).toBe(5)
    expect(stats.kinds.task).toBe(2)
    expect(stats.kinds.project).toBe(1)
    expect(stats.kinds.person).toBe(1)
    expect(stats.kinds.unknown).toBe(1)
    expect(stats.kinds.place).toBe(0)
  })

  it('separates tombstones from the purged ones waiting on a hard delete', () => {
    expect(stats.total).toBe(7)
    expect(stats.tombstones).toBe(2)
    expect(stats.purged).toBe(1)
    expect(stats.unowned).toBe(1)
  })

  it('reports the newest server sync, not the newest row it happened to read last', () => {
    expect(stats.newestSyncedAt).toBe('2026-09-07T10:00:00Z')
  })

  it('names the per-account row counts and puts the busiest account first', () => {
    expect(stats.users.map(u => [u.email, u.live, u.deleted])).toEqual([
      ['owner@example.com', 4, 0],
      ['friend@example.com', 1, 1],
      [null, 0, 1],
    ])
  })

  it('survives an empty database instead of throwing at the owner', () => {
    const empty = shapeDataStats([])
    expect(empty).toMatchObject({ total: 0, live: 0, tombstones: 0, unowned: 0, newestSyncedAt: null, users: [] })
  })
})

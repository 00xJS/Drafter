import { describe, expect, it } from 'vitest'
import { isUntimed, localDate, localMidnightIso } from '../../shared/domain.mjs'
import { buildDigest, localParts, visibleItemsFor } from '../../shared/digest.mjs'

describe('isUntimed / localDate', () => {
  it('treats local midnight in Europe/London July as untimed (BST)', () => {
    // 2026-07-15 00:00 Europe/London = 2026-07-14T23:00:00.000Z
    const iso = '2026-07-14T23:00:00.000Z'
    expect(isUntimed(iso, 'Europe/London')).toBe(true)
    expect(localDate(iso, 'Europe/London')).toBe('2026-07-15')
  })

  it('treats local midnight in Europe/London January as untimed (GMT)', () => {
    const iso = '2026-01-15T00:00:00.000Z'
    expect(isUntimed(iso, 'Europe/London')).toBe(true)
    expect(localDate(iso, 'Europe/London')).toBe('2026-01-15')
  })

  it('does not treat a timed afternoon as untimed', () => {
    expect(isUntimed('2026-07-15T14:00:00.000Z', 'Europe/London')).toBe(false)
  })

  it('builds a local-midnight ISO from a date key', () => {
    const iso = localMidnightIso('2026-09-07')
    expect(iso).toBeTruthy()
    const d = new Date(iso!)
    expect(d.getHours()).toBe(0)
    expect(d.getDate()).toBe(7)
  })
})

describe('digest buildDigest + visibility', () => {
  const now = new Date('2026-09-07T22:30:00.000Z') // evening UTC → still 7 Sep in US, late in London

  it('buckets a 23:30 local due as dueToday', () => {
    // America/Los_Angeles: 2026-09-07T23:30 local = 2026-09-08T06:30Z
    const dueAt = '2026-09-08T06:30:00.000Z'
    const items = [
      {
        kind: 'task',
        id: 't1',
        title: 'Late chore',
        status: 'todo',
        dueAt,
        deletedAt: undefined,
      },
    ]
    const d = buildDigest(items, 'America/Los_Angeles', new Date('2026-09-08T02:00:00.000Z'))
    expect(d.dueToday.map((t: { id: string }) => t.id)).toContain('t1')
    expect(d.overdue).toHaveLength(0)
  })

  it('only lists overdue people, and caps never to those created > 30 days ago', () => {
    const items = [
      { kind: 'person', id: 'p1', name: 'Old friend', cadenceDays: 14, createdAt: '2026-01-01T00:00:00.000Z' },
      { kind: 'person', id: 'p2', name: 'New', cadenceDays: 14, createdAt: now.toISOString() },
      { kind: 'person', id: 'p3', name: 'Recent', cadenceDays: 90, createdAt: '2026-01-01T00:00:00.000Z' },
      {
        kind: 'task',
        id: 'v1',
        status: 'done',
        completedAt: '2026-09-01T00:00:00.000Z',
        peopleIds: ['p3'],
        title: 'Saw Recent',
      },
    ]
    const d = buildDigest(items, 'UTC', now)
    expect(d.peopleDue.some((s: string) => s.includes('Old friend'))).toBe(true)
    expect(d.peopleDue.some((s: string) => s.includes('New'))).toBe(false)
    expect(d.peopleDue.some((s: string) => s.includes('Recent'))).toBe(false)
  })

  it('respects the nudge watermark so a name is not repeated daily', () => {
    const items = [
      { kind: 'person', id: 'p1', name: 'Mum', cadenceDays: 7, createdAt: '2026-01-01T00:00:00.000Z' },
    ]
    const first = buildDigest(items, 'UTC', now, {})
    expect(first.peopleDue.some((s: string) => s.includes('Mum'))).toBe(true)
    const second = buildDigest(items, 'UTC', now, first.nudgedNext)
    expect(second.peopleDue.some((s: string) => s.includes('Mum'))).toBe(false)
  })

  it('visibleItemsFor includes peers and null-owner rows for the site owner', () => {
    const rows = [
      { user_id: 'u1', data: { kind: 'task', id: 'a', status: 'todo', title: 'mine' } },
      { user_id: 'u2', data: { kind: 'task', id: 'b', status: 'todo', title: 'peer' } },
      { user_id: null, data: { kind: 'task', id: 'c', status: 'todo', title: 'legacy' } },
      { user_id: 'u3', data: { kind: 'task', id: 'd', status: 'todo', title: 'other' } },
    ]
    const items = visibleItemsFor(rows, 'u1', ['u1', 'u2'], 'u1') as { id: string }[]
    expect(items.map(i => i.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('localParts never throws on a bad timezone', () => {
    expect(localParts(now, 'Not/AZone').day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('digest places line', () => {
  const now = new Date('2026-09-08T09:00:00.000Z')
  const outing = (placeId: string, completedAt: string) => ({ kind: 'task', id: `o-${placeId}`, status: 'done', completedAt, placeId, title: 'Dinner' })

  it('never lists a place without a cadence, and only overdue ones with a cadence', () => {
    const items = [
      { kind: 'place', id: 'nopi', name: 'Nopi', category: 'restaurant', createdAt: '2026-01-01T00:00:00.000Z' },
      { kind: 'place', id: 'parc', name: 'Parc', category: 'outdoors', cadenceDays: 30, createdAt: '2026-01-01T00:00:00.000Z' },
      { kind: 'place', id: 'cafe', name: 'Cafe', category: 'cafe', cadenceDays: 30, createdAt: '2026-01-01T00:00:00.000Z' },
      { kind: 'place', id: 'new', name: 'Fresh', category: 'bar', cadenceDays: 30, createdAt: '2026-01-01T00:00:00.000Z' },
      outing('nopi', '2025-01-01T12:00:00.000Z'),
      outing('parc', '2026-05-01T12:00:00.000Z'), // 129d: overdue
      outing('cafe', '2026-08-01T12:00:00.000Z'), // 38d: due, not overdue
    ]
    const d = buildDigest(items, 'UTC', now)
    expect(d.placesDue).toEqual(['Parc (129d)'])
    expect(d.lines).toContain('Been a while: Parc (129d)')
    expect(d.lines.join('\n')).not.toContain('Nopi')
    expect(d.lines.join('\n')).not.toContain('Fresh')
  })

  it('suppresses a place for a week after it was nudged, keyed by place id', () => {
    const items = [
      { kind: 'place', id: 'parc', name: 'Parc', category: 'outdoors', cadenceDays: 30, createdAt: '2026-01-01T00:00:00.000Z' },
      outing('parc', '2026-05-01T12:00:00.000Z'),
    ]
    const first = buildDigest(items, 'UTC', now, {})
    expect(first.placesDue).toEqual(['Parc (129d)'])
    expect(first.nudgedNext.parc).toBe('2026-09-08')
    const second = buildDigest(items, 'UTC', now, first.nudgedNext)
    expect(second.placesDue).toEqual([])
    expect(second.lines.some((l: string) => l.startsWith('Been a while'))).toBe(false)
  })

  it('caps the line at three names', () => {
    const items = ['a', 'b', 'c', 'd'].flatMap(id => [
      { kind: 'place', id, name: id.toUpperCase(), category: 'other', cadenceDays: 7, createdAt: '2026-01-01T00:00:00.000Z' },
      outing(id, '2026-05-01T12:00:00.000Z'),
    ])
    const d = buildDigest(items, 'UTC', now)
    expect(d.lines.find((l: string) => l.startsWith('Been a while'))).toBe('Been a while: A (129d), B (129d), C (129d), +1 more')
  })
})

describe('digest: a name past the first three gets its turn', () => {
  // Every due name used to be stamped as nudged, including the "+n more" ones,
  // so with four overdue the fourth was never read out.
  const day1 = new Date('2026-09-08T09:00:00.000Z')
  const day2 = new Date('2026-09-09T09:00:00.000Z')

  it('stamps only the three people it names, so the fourth is read out the next day', () => {
    const items = ['a', 'b', 'c', 'd'].map(id => ({ kind: 'person', id, name: id.toUpperCase(), cadenceDays: 7, createdAt: '2026-01-01T00:00:00.000Z' }))
    const first = buildDigest(items, 'UTC', day1, {})
    expect(first.lines).toContain('Catch up with: A (no visit logged), B (no visit logged), C (no visit logged), +1 more')
    expect(Object.keys(first.nudgedNext).sort()).toEqual(['a', 'b', 'c'])
    const second = buildDigest(items, 'UTC', day2, first.nudgedNext)
    expect(second.peopleDue).toEqual(['D (no visit logged)'])
    expect(second.nudgedNext.d).toBe('2026-09-09')
  })

  it('does the same for places', () => {
    const items = ['a', 'b', 'c', 'd'].flatMap(id => [
      { kind: 'place', id, name: id.toUpperCase(), category: 'other', cadenceDays: 7, createdAt: '2026-01-01T00:00:00.000Z' },
      { kind: 'task', id: `o-${id}`, status: 'done', completedAt: '2026-05-01T12:00:00.000Z', placeId: id, title: 'Dinner' },
    ])
    const first = buildDigest(items, 'UTC', day1, {})
    expect(first.placesDue).toHaveLength(4)
    expect(Object.keys(first.nudgedNext).sort()).toEqual(['a', 'b', 'c'])
    const second = buildDigest(items, 'UTC', day2, first.nudgedNext)
    expect(second.placesDue).toHaveLength(1)
    expect(second.placesDue[0]).toMatch(/^D \(\d+d\)$/)
  })
})

describe('digest kitchen line', () => {
  it('adds tonight\'s dinner from the household meal plan', () => {
    const now = new Date('2026-09-08T09:00:00.000Z')
    const items = [
      { kind: 'recipe', id: 'r1', name: 'Pasta', ingredients: [{ id: 'a', name: 'Spaghetti' }, { id: 'b', name: 'Garlic' }], tags: [] },
      { kind: 'meal', id: 'meal~2026-09-08~dinner', date: '2026-09-08', slot: 'dinner', recipeId: 'r1', title: 'Pasta' },
      { kind: 'meal', id: 'meal~2026-09-09~dinner', date: '2026-09-09', slot: 'dinner', title: 'Leftovers' },
    ]
    const d = buildDigest(items, 'UTC', now)
    expect(d.tonight).toBe('Tonight: Pasta (2 ingredients)')
    expect(d.lines).toContain('Tonight: Pasta (2 ingredients)')
    expect(buildDigest([], 'UTC', now).tonight).toBeNull()
  })
})

describe('visibleItemsFor carries ownership', () => {
  it('attaches ownerId from the row so personal kinds can be told apart', () => {
    const rows = [
      { user_id: 'u1', data: { kind: 'journal', id: 'j1', date: '2026-09-08', body: 'mine' } },
      { user_id: 'u2', data: { kind: 'journal', id: 'j2', date: '2026-09-08', body: 'theirs' } },
      { user_id: null, data: { kind: 'task', id: 't1', title: 'legacy' } },
    ]
    const items = visibleItemsFor(rows, 'u1', ['u1', 'u2'], 'u1') as { id: string; kind: string; ownerId?: string }[]
    expect(items.find(i => i.id === 'j1')?.ownerId).toBe('u1')
    // a peer's journal never reaches my digest at all — the policy hides it and so does this mirror
    expect(items.find(i => i.id === 'j2')).toBeUndefined()
    expect(items.find(i => i.id === 't1')?.ownerId).toBeUndefined()
    const peerTask = visibleItemsFor([{ user_id: 'u2', data: { kind: 'task', id: 't2', title: 'shared chore' } }], 'u1', ['u1', 'u2'], 'u1')
    expect(peerTask).toHaveLength(1)
    // what upsertSundayReview does with it: only my own diary reaches the prompt
    const mine = items.filter(i => i.kind === 'journal' && (i.ownerId == null || i.ownerId === 'u1'))
    expect(mine.map(i => i.id)).toEqual(['j1'])
  })
})

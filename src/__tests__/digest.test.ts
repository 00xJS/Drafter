import { describe, expect, it } from 'vitest'
import { isUntimed, localDate, localMidnightIso } from '../../shared/domain.mjs'
import { buildDigest, localParts, visibleItemsFor } from '../../netlify/functions/digest.mjs'

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

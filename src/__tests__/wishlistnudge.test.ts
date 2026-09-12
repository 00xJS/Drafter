import { describe, expect, it } from 'vitest'
import { Task } from '../types'
import { freeTimeWishlist } from '../components/Today'

// On a clear day Today offers the wishlist. These pin what it offers: only
// wishlist items, the most wanted first, and only a handful.
function task(id: string, priority: Task['priority'], updatedAt: string, status: Task['status'] = 'wishlist'): Task {
  return { kind: 'task', id, title: id, description: '', status, priority, tags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt }
}

describe('freeTimeWishlist', () => {
  it('offers wishlist items only, most wanted first, then most recently touched', () => {
    const out = freeTimeWishlist([
      task('low-old', 'low', '2026-09-01T00:00:00.000Z'),
      task('todo', 'urgent', '2026-09-10T00:00:00.000Z', 'todo'),
      task('high', 'high', '2026-09-05T00:00:00.000Z'),
      task('normal-new', 'normal', '2026-09-09T00:00:00.000Z'),
      task('normal-old', 'normal', '2026-09-02T00:00:00.000Z'),
      { ...task('gone', 'urgent', '2026-09-11T00:00:00.000Z'), deletedAt: '2026-09-11T01:00:00.000Z' },
    ])
    expect(out.map(t => t.id)).toEqual(['high', 'normal-new', 'normal-old', 'low-old'])
  })
  it('is a handful, not a list', () => {
    const many = Array.from({ length: 9 }, (_, i) => task('w' + i, 'normal', '2026-09-0' + ((i % 9) + 1) + 'T00:00:00.000Z'))
    expect(freeTimeWishlist(many)).toHaveLength(5)
    expect(freeTimeWishlist(many, 2)).toHaveLength(2)
  })
  it('is empty when there is nothing wished for', () => {
    expect(freeTimeWishlist([task('t', 'normal', '2026-09-01T00:00:00.000Z', 'todo')])).toEqual([])
  })
})

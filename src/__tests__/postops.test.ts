import { describe, expect, it } from 'vitest'
import { mergePosts, nextOccurrence, purgeTombstones } from '../postops'
import { Post } from '../types'

function post(id: string, updatedAt: string, over: Partial<Post> = {}): Post {
  return {
    id,
    title: id,
    body: '',
    platforms: ['x'],
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    tags: [],
    ...over,
  }
}

describe('mergePosts', () => {
  it('keeps the newer version of the same id', () => {
    const merged = mergePosts(
      [post('a', '2026-01-01T00:00:00.000Z', { title: 'old' })],
      [post('a', '2026-01-02T00:00:00.000Z', { title: 'new' }), post('b', '2026-01-01T00:00:00.000Z')],
    )
    expect(merged).toHaveLength(2)
    expect(merged.find(p => p.id === 'a')?.title).toBe('new')
  })

  it('a newer tombstone wins over an older live version', () => {
    const merged = mergePosts(
      [post('a', '2026-01-01T00:00:00.000Z')],
      [post('a', '2026-01-03T00:00:00.000Z', { deletedAt: '2026-01-03T00:00:00.000Z' })],
    )
    expect(merged[0].deletedAt).toBeDefined()
  })

  it('an older incoming copy never clobbers local edits', () => {
    const merged = mergePosts(
      [post('a', '2026-01-05T00:00:00.000Z', { title: 'edited locally' })],
      [post('a', '2026-01-01T00:00:00.000Z', { title: 'stale archive copy' })],
    )
    expect(merged[0].title).toBe('edited locally')
  })
})

describe('purgeTombstones', () => {
  it('drops only tombstones older than the TTL', () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z')
    const posts = [
      post('live', '2026-01-01T00:00:00.000Z'),
      post('fresh-dead', '2026-05-30T00:00:00.000Z', { deletedAt: '2026-05-30T00:00:00.000Z' }),
      post('old-dead', '2026-01-01T00:00:00.000Z', { deletedAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const purged = purgeTombstones(posts, now)
    expect(purged.map(p => p.id)).toEqual(['live', 'fresh-dead'])
  })
})

describe('nextOccurrence', () => {
  const uid = () => 'new-id'

  it('spawns a scheduled clone one period later', () => {
    const src = post('a', '2026-01-01T00:00:00.000Z', {
      status: 'posted',
      postedAt: '2026-03-06T09:00:00.000Z',
      recurrence: { freq: 'weekly' },
      tags: ['build-in-public'],
      variants: { x: 'short' },
    })
    const next = nextOccurrence(src, uid)
    expect(next).not.toBeNull()
    expect(next?.id).toBe('new-id')
    expect(next?.status).toBe('scheduled')
    expect(next?.scheduledFor).toBe('2026-03-13T09:00:00.000Z')
    expect(next?.recurrence).toEqual({ freq: 'weekly' })
    expect(next?.tags).toEqual(['build-in-public'])
    expect(next?.variants).toEqual({ x: 'short' })
    expect(next?.postedAt).toBeUndefined()
  })

  it('supports biweekly and monthly', () => {
    const base = post('a', '2026-01-01T00:00:00.000Z', { status: 'posted', postedAt: '2026-01-31T12:00:00.000Z' })
    expect(nextOccurrence({ ...base, recurrence: { freq: 'biweekly' } }, uid)?.scheduledFor).toBe(
      '2026-02-14T12:00:00.000Z',
    )
    expect(nextOccurrence({ ...base, recurrence: { freq: 'monthly' } }, uid)?.scheduledFor).toBe(
      '2026-03-03T12:00:00.000Z', // Jan 31 + 1 month rolls over (no Feb 31)
    )
  })

  it('returns null without recurrence', () => {
    expect(nextOccurrence(post('a', '2026-01-01T00:00:00.000Z'), uid)).toBeNull()
  })
})

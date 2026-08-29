import { describe, expect, it } from 'vitest'
import { migrateStored, sanitizePost } from '../schema'
import { Post } from '../types'

function valid(over: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    title: 't',
    body: 'b',
    platforms: ['x'],
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    tags: [],
    ...over,
  }
}

describe('sanitizePost', () => {
  it('passes a valid post through', () => {
    const p = sanitizePost(valid())
    expect(p).toMatchObject({ id: 'p1', status: 'draft', platforms: ['x'] })
  })

  it('rejects garbage', () => {
    expect(sanitizePost(null)).toBeNull()
    expect(sanitizePost('nope')).toBeNull()
    expect(sanitizePost({ title: 'no id' })).toBeNull()
  })

  it('coerces string metrics and drops negatives', () => {
    const p = sanitizePost(valid({ metrics: { x: { likes: '1,200' as unknown as number, shares: -5 } } }))
    expect(p?.metrics?.x).toEqual({ likes: 1200 })
  })

  it('drops unknown platforms and statuses, inferring status from dates', () => {
    const p = sanitizePost({
      ...valid(),
      platforms: ['x', 'myspace'],
      status: 'zombie',
      postedAt: '2026-02-01T10:00:00.000Z',
    })
    expect(p?.platforms).toEqual(['x'])
    expect(p?.status).toBe('posted')
  })

  it('drops postedAt when status is not posted', () => {
    const p = sanitizePost(valid({ status: 'draft', postedAt: '2026-02-01T10:00:00.000Z' }))
    expect(p?.postedAt).toBeUndefined()
  })

  it('drops invalid dates and recurrence', () => {
    const p = sanitizePost({ ...valid(), scheduledFor: 'not a date', recurrence: { freq: 'hourly' } })
    expect(p?.scheduledFor).toBeUndefined()
    expect(p?.recurrence).toBeUndefined()
  })

  it('keeps valid variants only', () => {
    const p = sanitizePost(valid({ variants: { x: 'short', myspace: 'nope', instagram: '   ' } as Post['variants'] }))
    expect(p?.variants).toEqual({ x: 'short' })
  })
})

describe('migrateStored', () => {
  it('accepts the v1 bare array', () => {
    expect(migrateStored([valid()])).toHaveLength(1)
  })

  it('accepts the v2 wrapper', () => {
    expect(migrateStored({ version: 2, posts: [valid(), { junk: true }] })).toHaveLength(1)
  })

  it('rejects unknown shapes', () => {
    expect(migrateStored({ nope: 1 })).toBeNull()
    expect(migrateStored('x')).toBeNull()
  })
})

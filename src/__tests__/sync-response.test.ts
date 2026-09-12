import { describe, expect, it } from 'vitest'
import { parseSyncResponse } from '../sync'

const row = (id: string, over: object = {}) => ({
  kind: 'task',
  id,
  title: id,
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  createdAt: '2026-09-10T09:00:00.000Z',
  updatedAt: '2026-09-10T09:00:00.000Z',
  ...over,
})

// Production runs the old server until the owner pushes the migration, and a
// server older still answered with a bare array. All three must keep working.
describe('reading a sync_posts answer', () => {
  it('reads the legacy bare array: rows only, nothing reported', () => {
    const r = parseSyncResponse([row('a', { syncedAt: '2026-09-10T09:00:01.000Z' })])!
    expect(r.items.map(i => i.id)).toEqual(['a'])
    expect((r.items[0] as { syncedAt?: string }).syncedAt).toBe('2026-09-10T09:00:01.000Z')
    expect(r.reportsRejections).toBe(false)
    expect(r).toMatchObject({ rejected: [], stale: [], gone: [] })
  })

  it("reads today's { items, rejected }", () => {
    const r = parseSyncResponse({ items: [row('a')], rejected: ['b'] })!
    expect(r.items.map(i => i.id)).toEqual(['a'])
    expect(r.rejected).toEqual(['b'])
    expect(r.reportsRejections).toBe(true)
    expect(r).toMatchObject({ stale: [], gone: [], reasons: {} })
  })

  it('reads the new { items, rejected, stale, gone }', () => {
    const r = parseSyncResponse({ items: [row('s', { title: 'server copy' })], rejected: [], stale: ['s'], gone: ['old'] })!
    expect(r.stale).toEqual(['s'])
    expect(r.gone).toEqual(['old'])
    expect(r.items[0]).toMatchObject({ id: 's', title: 'server copy' })
  })

  it('keeps a reason, whether it rides on the rejected entry or in a map', () => {
    const r = parseSyncResponse({ items: [], rejected: [{ id: 'a', reason: 'unknown kind' }, 'b', { id: 'c', message: 'too big' }], reasons: { b: 'bad status' } })!
    expect(r.rejected).toEqual(['a', 'b', 'c'])
    expect(r.reasons).toEqual({ a: 'unknown kind', b: 'bad status', c: 'too big' })
  })

  it('drops rows no sanitizer accepts and ids that are not strings', () => {
    const r = parseSyncResponse({ items: [row('a'), { kind: 'spaceship', id: 'z' }, 7], rejected: [1, 'b'], stale: [null, 's'] })!
    expect(r.items.map(i => i.id)).toEqual(['a'])
    expect(r.rejected).toEqual(['b'])
    expect(r.stale).toEqual(['s'])
  })

  it('gives up on anything else', () => {
    expect(parseSyncResponse(null)).toBeNull()
    expect(parseSyncResponse('ok')).toBeNull()
  })
})

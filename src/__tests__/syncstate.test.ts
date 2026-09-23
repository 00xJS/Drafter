import { describe, expect, it } from 'vitest'
import { CURSOR_KEY, DIRTY_KEY, FAILURES_KEY, KINDS_KEY, forgetLegacyBookkeeping, parseBookkeeping, readLegacyBookkeeping, type KV } from '../syncstate'

// The sync bookkeeping lives beside the records now (IndexedDB 'meta'); what an
// older build kept in localStorage is read once, moved over, and removed.

const kvOf = (entries: [string, string][]): KV & { map: Map<string, string> } => {
  const map = new Map(entries)
  return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: k => void map.delete(k) }
}

describe('readLegacyBookkeeping', () => {
  it('reads nothing from a device an older build never synced on', () => {
    expect(readLegacyBookkeeping(kvOf([]))).toBeNull()
  })

  it('reads the cursor, the dirty set, the refusals and the kinds list an older build kept', () => {
    const kv = kvOf([
      [CURSOR_KEY, '2026-09-07T12:00:00.000Z'],
      [DIRTY_KEY, '["a","b","a",7]'],
      [FAILURES_KEY, JSON.stringify([{ id: 'b', reason: 'nope', attempts: 2, nextAt: 5, firstAt: 1 }, { nonsense: true }])],
      [KINDS_KEY, 'project,task'],
    ])
    expect(readLegacyBookkeeping(kv)).toEqual({
      cursor: '2026-09-07T12:00:00.000Z',
      kinds: 'project,task',
      dirty: ['a', 'b'],
      failures: [{ id: 'b', reason: 'nope', attempts: 2, nextAt: 5, firstAt: 1 }],
    })
  })

  it('a corrupt value costs only itself', () => {
    const kv = kvOf([
      [DIRTY_KEY, '{not json'],
      [CURSOR_KEY, '2026-09-07T12:00:00.000Z'],
    ])
    expect(readLegacyBookkeeping(kv)).toEqual({ cursor: '2026-09-07T12:00:00.000Z', kinds: null, dirty: [], failures: [] })
  })

  it('forgets all four keys once they are beside the records', () => {
    const kv = kvOf([
      [CURSOR_KEY, 'x'],
      [DIRTY_KEY, '[]'],
      [FAILURES_KEY, '[]'],
      [KINDS_KEY, 'task'],
      ['drafter:theme', 'dark'],
    ])
    forgetLegacyBookkeeping(kv)
    expect([...kv.map.keys()]).toEqual(['drafter:theme'])
  })
})

describe('parseBookkeeping: what the meta row holds, read back', () => {
  it('is null for a row an older build wrote, which has none', () => {
    expect(parseBookkeeping(undefined)).toBeNull()
    expect(parseBookkeeping([])).toBeNull()
  })

  it('keeps only what has the right shape', () => {
    expect(parseBookkeeping({ cursor: '', kinds: 3, dirty: ['a', 1, 'a'], failures: [{ id: 'a', attempts: 'x' }] })).toEqual({
      cursor: null,
      kinds: null,
      dirty: ['a'],
      failures: [{ id: 'a', reason: undefined, attempts: 1, nextAt: 0, firstAt: 0 }],
    })
  })
})

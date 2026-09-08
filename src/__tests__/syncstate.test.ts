import { beforeEach, describe, expect, it } from 'vitest'
import {
  CURSOR_KEY,
  DIRTY_KEY,
  clearSyncCursor,
  prepareFullResync,
  readCursor,
  readDirty,
  writeCursor,
  writeDirty,
} from '../syncstate'

const mem = new Map<string, string>()

beforeEach(() => {
  mem.clear()
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, String(v))
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size
    },
  }
})

describe('prepareFullResync', () => {
  it('clears the cursor so the next sync is a full exchange', () => {
    writeCursor('2026-09-07T12:00:00.000Z')
    expect(readCursor()).toBe('2026-09-07T12:00:00.000Z')
    prepareFullResync()
    expect(readCursor()).toBeNull()
    expect(mem.has(CURSOR_KEY)).toBe(false)
  })

  it('optionally drops the dirty set for an empty local cache', () => {
    writeCursor('2026-09-07T12:00:00.000Z')
    writeDirty(new Set(['a', 'b']))
    expect([...readDirty()].sort()).toEqual(['a', 'b'])
    prepareFullResync({ clearDirty: true })
    expect(readCursor()).toBeNull()
    expect(readDirty().size).toBe(0)
    expect(mem.has(DIRTY_KEY)).toBe(false)
  })

  it('keeps dirty ids when only the cursor is reset (re-auth with local rows)', () => {
    writeCursor('2026-09-07T12:00:00.000Z')
    writeDirty(new Set(['pending']))
    clearSyncCursor()
    expect(readCursor()).toBeNull()
    expect([...readDirty()]).toEqual(['pending'])
  })
})

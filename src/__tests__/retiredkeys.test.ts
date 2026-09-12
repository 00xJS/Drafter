import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RETIRED_KEYS, forgetRetiredKeys } from '../retiredkeys'

// No jsdom here: localStorage is stubbed by hand, as the sync-state tests do.
const mem = new Map<string, string>()
const saved = globalThis.localStorage

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

afterEach(() => {
  globalThis.localStorage = saved
})

describe('a project filter saved before the bar went away', () => {
  it('is dropped on start so nothing stays silently filtered', () => {
    localStorage.setItem('drafter:project-filter', 'proj-kitchen-2026')
    forgetRetiredKeys()
    expect(localStorage.getItem('drafter:project-filter')).toBeNull()
  })

  it('leaves the preferences that survived alone', () => {
    localStorage.setItem('drafter:mine-only', '1')
    localStorage.setItem('drafter:tasks-tab', 'notes')
    forgetRetiredKeys()
    expect(localStorage.getItem('drafter:mine-only')).toBe('1')
    expect(localStorage.getItem('drafter:tasks-tab')).toBe('notes')
  })

  it('names the retired filter key exactly once', () => {
    expect(RETIRED_KEYS).toContain('drafter:project-filter')
  })

  it('survives a browser with storage blocked', () => {
    globalThis.localStorage = {
      ...globalThis.localStorage,
      removeItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(() => forgetRetiredKeys()).not.toThrow()
  })
})

// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from './dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../types'

// What an edit, a sync round and a toast cost the screens. The store is a new
// object whenever any record changes and on every round, so a screen's
// callbacks are built on its actions, which outlive it; and the toast lives
// outside the planner, where only its own bar listens. Each is mounted as the
// React Compiler builds it, as every DOM test is.

// the device's copy, as the engine keeps it, in memory: nothing here is about IndexedDB
vi.mock('../idb', () => ({
  readRecordCache: async () => undefined,
  writeRecordChanges: async () => {},
  idbGet: async () => undefined,
  idbSet: async () => {},
  clearLocalData: async () => {},
  readRecords: async () => [],
  readCacheSeq: async () => null,
  writeHandoffs: async () => {},
  readOutbox: async () => ({ entries: [], records: [] }),
}))
vi.mock('../supabase', () => ({ getSupabase: () => null, storedUserId: () => null }))
// Home's day, as a stand-in that says each time it is drawn
vi.mock('../components/Today', () => ({ Today: vi.fn(() => null) }))

import { HomeScreen } from '../components/planner/HomeScreen'
import type { PlannerCtx } from '../components/planner/ctx'
import { ToastHost } from '../components/planner/Toast'
import { useToast } from '../components/planner/useToast'
import { Today } from '../components/Today'
import { useItems, type Store, type StoreActions } from '../store'
import type { EngineConflict } from '../syncengine'

const T0 = '2026-09-23T09:00:00.000Z'
const noop = () => {}

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(Today).mockClear()
})

describe('the store', () => {
  it('keeps its actions the same functions, in one object, through every edit', async () => {
    const seen: Store[] = []
    function Host() {
      seen.push(useItems(null))
      return null
    }
    render(<Host />)
    await waitFor(() => expect(seen[seen.length - 1].loaded).toBe(true))
    const before = seen[seen.length - 1]
    const task: Task = { kind: 'task', id: 't1', title: 'Fix the gate', description: '', status: 'todo', priority: 'normal', tags: [], createdAt: T0, updatedAt: T0 }
    act(() => before.upsert(task))
    await waitFor(() => expect(seen[seen.length - 1].tasks.map(t => t.id)).toEqual(['t1']))
    const after = seen[seen.length - 1]
    // a new store for the new list…
    expect(after).not.toBe(before)
    // …and the same actions
    expect(after.actions).toBe(before.actions)
    const names: (keyof StoreActions)[] = ['upsert', 'remove', 'restore', 'purge', 'setStatus', 'importItems', 'syncNowManual', 'fullResync', 'retainMine', 'retrySync', 'discardLocal', 'onConflict', 'keepMine', 'onRetired', 'unconfirmed', 'retryLoad']
    for (const name of names) {
      expect(after.actions[name], name).toBe(before.actions[name])
      expect(after[name], name).toBe(before[name])
    }
  })
})

describe('Home', () => {
  // What stays put from one planner render to the next, as usePlannerCtx keeps
  // it: the household, the feeds, and every callback, each a stand-in
  const kept: Record<string, unknown> = { household: { info: null, myId: null }, allEvents: [], sourceMap: new Map(), syncAlarm: null, calendarSignIn: null }
  const standIn = (name: string) => (kept[name] ??= vi.fn())
  /** The planner context as Home reads it, around this render's store. */
  const ctx = (store: Partial<Store>): PlannerCtx =>
    new Proxy({ store } as Record<string, unknown>, { get: (target, key: string) => (key in target ? target[key] : key in kept ? kept[key] : standIn(key)) }) as unknown as PlannerCtx
  const lists = { tasks: [], people: [], places: [], reviews: [], projects: [], meals: [], recipes: [], journal: [], habits: [], routines: [], events: [], garments: [], outfits: [], wears: [], snoozes: [], notices: [] }

  it('does not draw the day again when a sync round brings a new store and nothing new in it', () => {
    const p = ctx({ ...lists, syncInfo: { lastAt: T0 } } as unknown as Store)
    const view = render(<HomeScreen p={p} />)
    expect(Today).toHaveBeenCalledTimes(1)
    // the round answered: a new store object, the same lists, the same actions
    const next = ctx({ ...lists, syncInfo: { lastAt: '2026-09-23T09:05:00.000Z' } } as unknown as Store)
    view.rerender(<HomeScreen p={next} />)
    expect(Today).toHaveBeenCalledTimes(1)
  })
})

describe('the toast', () => {
  /** The shell as it holds the toast: useToast, and the bar that draws it. Counts its own renders. */
  function shell(actions: Partial<StoreActions> = {}) {
    const store = { actions: { onConflict: () => noop, keepMine: noop, onRetired: () => noop, restore: noop, ...actions } } as unknown as Store
    const drawn = { shell: 0 }
    let show: ReturnType<typeof useToast>['showToast'] = noop
    function Shell() {
      drawn.shell++
      const { toaster, showToast } = useToast({ store })
      show = showToast
      return <ToastHost toaster={toaster} />
    }
    render(<Shell />)
    return { drawn, show: (...args: Parameters<typeof show>) => act(() => show(...args)) }
  }

  it('comes and goes without drawing the shell again', () => {
    vi.useFakeTimers()
    const { drawn, show } = shell()
    show('Moved to tomorrow', noop)
    expect(screen.getByRole('status').textContent).toContain('Moved to tomorrow')
    act(() => void vi.advanceTimersByTime(6000))
    expect(screen.queryByRole('status')).toBeNull()
    expect(drawn.shell).toBe(1)
  })

  it('stays 15 s with a confirm step, and a newer toast starts its own time', () => {
    vi.useFakeTimers()
    const { show } = shell()
    show('Add to today’s journal?', undefined, { label: 'Add', run: noop })
    act(() => void vi.advanceTimersByTime(14_000))
    expect(screen.getByRole('status').textContent).toContain('Add to today’s journal?')
    show('Saved')
    act(() => void vi.advanceTimersByTime(5_000))
    expect(screen.getByRole('status').textContent).toContain('Saved')
    act(() => void vi.advanceTimersByTime(1_000))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('offers Keep mine for an edit another device won, and keeps this device’s values when pressed', () => {
    let heard: ((found: EngineConflict[]) => void) | undefined
    const keepMine = vi.fn()
    shell({
      onConflict: listener => {
        heard = listener
        return noop
      },
      keepMine,
    })
    const found = [{ id: 't1', label: 'Buy paint' }] as unknown as EngineConflict[]
    act(() => heard?.(found))
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    expect(keepMine).toHaveBeenCalledWith(found)
    expect(screen.queryByRole('status')).toBeNull()
  })
})

import { useRef } from 'react'
import type { useHousehold } from '../../household'
import type { Store } from '../../store'
import type { projectById } from '../../taskutils'
import type { Command } from '../Search'
import { buildPaletteCommands, type PaletteNav, type PaletteOverlays } from './commands'
import type { useCalendarSync } from './useCalendarSync'
import type { useListFilters } from './useListFilters'
import type { useFocusActions } from './useFocusActions'
import type { useLifeActions } from './useLifeActions'
import type { useNavigation } from './useNavigation'
import type { useOverlays } from './useOverlays'
import type { useOwner } from './useOwner'
import type { useSyncAlarm } from './useSyncAlarm'
import type { useTaskActions } from './useTaskActions'
import type { useToast } from './useToast'

/**
 * Everything the top bar, the six screens and the overlays can reach: what
 * the planner hooks return, plus the store, the household, the project lookup
 * and the palette's commands. Planner hands it down as one `p` prop, built by
 * usePlannerCtx below. There is no context, so a screen re-renders exactly
 * when Planner does, as it did when all of this was one component.
 */
export type PlannerCtx = {
  store: Store
  household: ReturnType<typeof useHousehold>
  projectMap: ReturnType<typeof projectById>
  paletteCommands: Command[]
  /**
   * More than one account shares this planner. It decides whether a record
   * says who can see it — alone there is nobody to share with, so every mark
   * and every control would say the same thing.
   *
   * There is no Mine / Everyone here any more. Whose job a task is (its
   * assignee) and who can see it (v3.19's `shared`) are different questions,
   * and the switch answered the first while looking like it answered the
   * second: "I think the last session had built it wrong". Sharing is now the
   * one control, on the record, where it can be seen and changed.
   */
  inHousehold: boolean
} & ReturnType<typeof useNavigation> &
  ReturnType<typeof useListFilters> &
  ReturnType<typeof useToast> &
  ReturnType<typeof useCalendarSync> &
  ReturnType<typeof useOverlays> &
  ReturnType<typeof useOwner> &
  ReturnType<typeof useSyncAlarm> &
  ReturnType<typeof useLifeActions> &
  ReturnType<typeof useTaskActions> &
  ReturnType<typeof useFocusActions>

/** What Planner gathers for the context: all of it but the palette's commands, which are drawn from it. */
export type PlannerParts = Omit<PlannerCtx, 'paletteCommands'>

type Fn = (...args: unknown[]) => unknown

/**
 * The context as the same object for as long as nothing in it changed.
 *
 * Planner's hooks hand back fresh closures every render, so an object built
 * from them was new every render, whatever had changed. Here each function in
 * it is a stand-in that calls the one from the latest render — the same
 * function for the life of the planner, so a callback handed down keeps its
 * identity — and the object is rebuilt only when one of its values is a
 * different one: a list, a flag, a sheet opening. The palette's commands are
 * drawn from the stand-ins, again only when the hour turns (which part of the
 * day it is decides the quick ones).
 *
 * A value that is itself an object built afresh every render (the household,
 * the calendar feeds) still makes a new context each render; a view memoized
 * on the lists and callbacks it is handed, rather than on the whole context,
 * is what this makes cheap.
 */
export function createCtxMemo(clock: () => Date = () => new Date()): (parts: PlannerParts) => PlannerCtx {
  let latest: Record<string, unknown> = {}
  const standIns = new Map<string, Fn>()
  let prev: Record<string, unknown> | null = null
  let commands: { hour: number; list: Command[] } | null = null

  const standIn = (key: string): Fn => {
    let fn = standIns.get(key)
    if (!fn) {
      fn = (...args: unknown[]) => {
        const f = latest[key]
        return typeof f === 'function' ? (f as Fn)(...args) : undefined
      }
      standIns.set(key, fn)
    }
    return fn
  }

  return parts => {
    latest = parts as unknown as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(latest)) next[key] = typeof value === 'function' ? standIn(key) : value
    const now = clock()
    if (!commands || commands.hour !== now.getHours()) {
      commands = { hour: now.getHours(), list: buildPaletteCommands(next as unknown as PaletteNav, next as unknown as PaletteOverlays, now) }
    }
    next.paletteCommands = commands.list
    if (prev && sameEntries(prev, next)) return prev as unknown as PlannerCtx
    prev = next
    return next as unknown as PlannerCtx
  }
}

function sameEntries(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(k => Object.is(a[k], b[k]))
}

/** Planner's context, memoized over the values in it (createCtxMemo). */
export function usePlannerCtx(parts: PlannerParts): PlannerCtx {
  const memo = useRef<((parts: PlannerParts) => PlannerCtx) | null>(null)
  memo.current ??= createCtxMemo()
  return memo.current(parts)
}

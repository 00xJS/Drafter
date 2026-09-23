import { useSyncExternalStore } from 'react'

/**
 * The time, for a view that says how long ago or how soon something is.
 *
 * Read as the view mounts, then every `stepMs` and whenever the page comes
 * back — never while it renders, so a render gives the same answer however
 * often React runs it, and a page left open still moves on (iOS resumes the
 * same page for days rather than reloading it; see useDayKey). Never a
 * `new Date()` in the render instead: the React Compiler caches a value worked
 * out from nothing that changes, for as long as the view is mounted.
 *
 * One clock for each step, shared by every view that asks: a due badge on
 * each of a hundred rows costs one timer, not a hundred, and every row turns
 * at the same moment. It reads whole steps — whole minutes, by default — so
 * the views on a page agree on it, and it moves at each step's start.
 */
export function useNow(stepMs = 60_000): number {
  const clock = clockFor(stepMs)
  return useSyncExternalStore(clock.subscribe, clock.read, clock.read)
}

interface SharedClock {
  subscribe(listener: () => void): () => void
  /** The step last handed out while anyone listens; a fresh reading while nobody does (and on a server render). */
  read(): number
}

const clocks = new Map<number, SharedClock>()

const wholeStep = (ms: number, step: number): number => ms - (ms % step)

function clockFor(step: number): SharedClock {
  const known = clocks.get(step)
  if (known) return known
  const listeners = new Set<() => void>()
  let shown = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = () => {
    const now = Date.now()
    clearTimeout(timer)
    // to the next step's start and a moment into it, so the reading lands
    // inside the new step rather than on its edge (useDayKey does the same)
    timer = setTimeout(tick, step - (now % step) + 20)
    const at = wholeStep(now, step)
    if (at === shown) return
    shown = at
    for (const listener of [...listeners]) listener()
  }
  // a timer does not fire while iOS has the page suspended
  const onVisible = () => {
    if (document.visibilityState === 'visible') tick()
  }
  const clock: SharedClock = {
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        shown = wholeStep(Date.now(), step)
        tick()
        document.addEventListener('visibilitychange', onVisible)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        clearTimeout(timer)
        document.removeEventListener('visibilitychange', onVisible)
      }
    },
    read: () => (listeners.size > 0 ? shown : wholeStep(Date.now(), step)),
  }
  clocks.set(step, clock)
  return clock
}

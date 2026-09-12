/**
 * Pull to refresh, the arithmetic only. The hook in PullToRefresh.tsx owns the
 * touch listeners and the painting; everything that decides what a finger
 * position means lives here, DOM-free, so it can be tested with fixed numbers
 * the way the swipe row's bands are.
 */

/** How far the indicator must travel (after damping) before letting go refreshes. */
export const PULL_THRESHOLD = 72
/** The indicator never travels past this, however far the finger goes. */
export const PULL_MAX = 110
/**
 * How far back above the line the finger must come before the pull disarms.
 * Entering the band is what buzzes, so a thumb resting on the threshold must
 * not rattle on every touchmove (see BAND_HYSTERESIS in Today.tsx).
 */
export const PULL_HYSTERESIS = 10
/**
 * The first few pixels decide the axis: a sideways start is a swipe row or the
 * board's horizontal scroll and is handed off untouched. The swipe row reads
 * the same dead zone through lockAxis, so both gestures decide on the same
 * sample and never both claim one touch.
 */
export const AXIS_LOCK = 8

/**
 * Which way a touch has committed: null while it is still inside the dead
 * zone, then 'x' or 'y' for good. A tie goes sideways — the swipe row and the
 * pull both use this one rule, so whichever listener runs first, the other
 * reaches the same verdict and yields.
 */
export function lockAxis(dx: number, dy: number): 'x' | 'y' | null {
  if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return null
  return Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
}

/**
 * Rubber-band: half the finger's travel, capped, never negative. Half rather
 * than one-to-one so the disc reads as resisting — the way iOS's own list
 * headers do — and so a full-height flick cannot throw it off the screen.
 */
export function damp(dy: number): number {
  return Math.min(PULL_MAX, Math.max(0, dy) * 0.5)
}

/** What letting go right now would do: nothing, or refresh. */
export type PullBand = 'none' | 'armed'

/**
 * Whether letting go at `travel` (already damped) refreshes, given the band a
 * moment ago. Holding the band you are already in is the only thing the
 * hysteresis does; a pull that has clearly left it is re-read from scratch.
 */
export function bandOf(travel: number, prev: PullBand): PullBand {
  if (prev === 'armed' && travel >= PULL_THRESHOLD - PULL_HYSTERESIS) return 'armed'
  return travel >= PULL_THRESHOLD ? 'armed' : 'none'
}

export type PullPhase = 'idle' | 'deciding' | 'pulling' | 'refreshing'

export interface PullState {
  phase: PullPhase
  startX: number
  startY: number
  /** damped distance the indicator has been pulled, in px */
  travel: number
  band: PullBand
}

export type PullEvent =
  | { type: 'start'; x: number; y: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'end' }
  | { type: 'cancel' }
  | { type: 'done' }

export const IDLE: PullState = { phase: 'idle', startX: 0, startY: 0, travel: 0, band: 'none' }

export interface PullStep {
  state: PullState
  /** letting go past the line: the hook should run the refresh now */
  refresh?: true
  /** the band was just entered: one light haptic, never repeated while parked on the line */
  buzz?: true
}

/**
 * One touch event in, the next state out. Anything the event cannot change
 * hands back the same state object, so the hook can skip a paint by identity.
 * The minimum spin after `refresh` is the hook's business, not this file's:
 * it is about how the screen reads, not about where the finger is.
 */
export function step(s: PullState, e: PullEvent): PullStep {
  switch (e.type) {
    case 'start':
      // one pull at a time: a second finger during a refresh changes nothing
      if (s.phase !== 'idle') return { state: s }
      return { state: { phase: 'deciding', startX: e.x, startY: e.y, travel: 0, band: 'none' } }
    case 'move': {
      const dx = e.x - s.startX
      const dy = e.y - s.startY
      if (s.phase === 'deciding') {
        const axis = lockAxis(dx, dy)
        if (!axis) return { state: s }
        // sideways (or a tie) belongs to a swipe row or the board: hand off
        if (axis === 'x') return { state: IDLE }
        // an upward start is an ordinary scroll, not a pull
        if (dy < 0) return { state: IDLE }
        // a hard flick can land past the line on its first decisive sample;
        // that is still entering the band, and gets the same one tap
        const band = bandOf(damp(dy), 'none')
        const next: PullState = { ...s, phase: 'pulling', travel: damp(dy), band }
        return band === 'armed' ? { state: next, buzz: true } : { state: next }
      }
      if (s.phase !== 'pulling') return { state: s }
      const travel = damp(dy)
      const band = bandOf(travel, s.band)
      const next: PullState = { ...s, travel, band }
      return band === 'armed' && s.band === 'none' ? { state: next, buzz: true } : { state: next }
    }
    case 'end':
      if (s.phase !== 'pulling') return { state: s.phase === 'deciding' ? IDLE : s }
      if (s.band === 'armed') return { state: { ...s, phase: 'refreshing', travel: PULL_THRESHOLD }, refresh: true }
      return { state: IDLE }
    case 'cancel':
      // the escape hatch for a touch the system took away; a refresh already
      // running is not a touch and keeps its spinner until `done`
      return s.phase === 'refreshing' ? { state: s } : { state: IDLE }
    case 'done':
      return { state: IDLE }
  }
}

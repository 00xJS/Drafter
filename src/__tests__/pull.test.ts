import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { plannerSource, sheetSource } from './source'
import { describe, expect, it } from 'vitest'
import { AXIS_LOCK, IDLE, PULL_HYSTERESIS, PULL_MAX, PULL_THRESHOLD, PullState, bandOf, damp, lockAxis, step } from '../pull'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/**
 * The pull-down has one line to cross and one thing to say when it is
 * crossed, so the arithmetic is pinned with fixed numbers the way the swipe
 * row's bands are.
 */
describe('damp: the disc resists, and never leaves the screen', () => {
  it('starts at rest and ignores an upward finger', () => {
    expect(damp(0)).toBe(0)
    expect(damp(-20)).toBe(0)
  })

  it('travels half the finger, capped', () => {
    expect(damp(40)).toBe(20)
    expect(damp(144)).toBe(72)
    expect(damp(300)).toBe(PULL_MAX)
    expect(damp(1000)).toBe(PULL_MAX)
  })

  it('never moves back while the finger keeps going', () => {
    const points = [0, 10, 50, 100, 144, 220, 400]
    let prev = -1
    for (const p of points) {
      const d = damp(p)
      expect(d).toBeGreaterThanOrEqual(prev)
      prev = d
    }
  })
})

describe('bandOf: armed exactly at the line, held through a wobble', () => {
  it('arms at the threshold and not a hair before', () => {
    expect(bandOf(PULL_THRESHOLD - 0.1, 'none')).toBe('none')
    expect(bandOf(PULL_THRESHOLD, 'none')).toBe('armed')
    expect(bandOf(200, 'none')).toBe('armed')
  })

  it('holds armed through the hysteresis, so a resting thumb does not rattle', () => {
    expect(bandOf(PULL_THRESHOLD - PULL_HYSTERESIS + 1, 'armed')).toBe('armed')
    expect(bandOf(PULL_THRESHOLD - PULL_HYSTERESIS - 0.1, 'armed')).toBe('none')
    // hysteresis only holds a band you are in; it never arms early
    expect(bandOf(PULL_THRESHOLD - PULL_HYSTERESIS + 3, 'none')).toBe('none')
  })
})

describe('lockAxis: one dead zone and one tie-break for both gestures', () => {
  it('waits inside the dead zone', () => {
    expect(lockAxis(0, 0)).toBeNull()
    expect(lockAxis(AXIS_LOCK - 1, AXIS_LOCK - 1)).toBeNull()
  })

  it('commits on the first sample out of it, and a tie goes sideways', () => {
    expect(lockAxis(AXIS_LOCK, 0)).toBe('x')
    expect(lockAxis(0, AXIS_LOCK)).toBe('y')
    expect(lockAxis(9, 12)).toBe('y')
    expect(lockAxis(12, 9)).toBe('x')
    expect(lockAxis(AXIS_LOCK, AXIS_LOCK)).toBe('x')
    expect(lockAxis(-AXIS_LOCK, AXIS_LOCK)).toBe('x')
  })
})

describe('step: one pull, one buzz, one refresh', () => {
  const start = step(IDLE, { type: 'start', x: 0, y: 0 }).state

  it('waits for the first few pixels before deciding', () => {
    expect(start.phase).toBe('deciding')
    expect(step(start, { type: 'move', x: 0, y: AXIS_LOCK - 4 }).state).toBe(start)
    const s = step(start, { type: 'move', x: 0, y: 20 }).state
    expect(s.phase).toBe('pulling')
    expect(s.travel).toBe(10)
  })

  it('hands a sideways start to the swipe rows, and an upward one to the scroller', () => {
    expect(step(start, { type: 'move', x: 12, y: 3 }).state).toBe(IDLE)
    expect(step(start, { type: 'move', x: 0, y: -12 }).state).toBe(IDLE)
  })

  it('buzzes once on entering the band, then holds it through a wobble', () => {
    const pulling = step(start, { type: 'move', x: 0, y: 20 }).state
    const under = step(pulling, { type: 'move', x: 0, y: 143 })
    expect(under.state.travel).toBe(71.5)
    expect(under.state.band).toBe('none')
    expect(under.buzz).toBeUndefined()
    const on = step(under.state, { type: 'move', x: 0, y: 144 })
    expect(on.state.travel).toBe(72)
    expect(on.state.band).toBe('armed')
    expect(on.buzz).toBe(true)
    const past = step(on.state, { type: 'move', x: 0, y: 150 })
    expect(past.state.band).toBe('armed')
    expect(past.buzz).toBeUndefined()
    const wobble = step(past.state, { type: 'move', x: 0, y: 130 })
    expect(wobble.state.travel).toBe(65)
    expect(wobble.state.band).toBe('armed')
    expect(wobble.buzz).toBeUndefined()
  })

  it('buzzes for a flick that lands past the line on its first sample', () => {
    // a hard flick coalesces to one touchmove; that is still entering the band
    const flick = step(start, { type: 'move', x: 0, y: 160 })
    expect(flick.state.phase).toBe('pulling')
    expect(flick.state.band).toBe('armed')
    expect(flick.buzz).toBe(true)
    // and the next sample, still armed, stays quiet
    expect(step(flick.state, { type: 'move', x: 0, y: 170 }).buzz).toBeUndefined()
  })

  it('refreshes on letting go past the line, and only then', () => {
    const pulling = step(start, { type: 'move', x: 0, y: 20 }).state
    const short = step(pulling, { type: 'move', x: 0, y: 120 }).state
    expect(short.travel).toBe(60)
    expect(step(short, { type: 'end' })).toEqual({ state: IDLE })
    const armed = step(pulling, { type: 'move', x: 0, y: 160 }).state
    const release = step(armed, { type: 'end' })
    expect(release.refresh).toBe(true)
    expect(release.state.phase).toBe('refreshing')
    // the disc parks on the line while the sync runs, not wherever the finger left it
    expect(release.state.travel).toBe(PULL_THRESHOLD)
    expect(step(release.state, { type: 'done' }).state).toBe(IDLE)
  })

  it('lets a cancelled touch go, but not a refresh already running', () => {
    const pulling = step(start, { type: 'move', x: 0, y: 160 }).state
    expect(step(pulling, { type: 'cancel' }).state).toBe(IDLE)
    const refreshing: PullState = { ...pulling, phase: 'refreshing' }
    expect(step(refreshing, { type: 'cancel' }).state).toBe(refreshing)
    // and a second finger during the spin starts nothing
    expect(step(refreshing, { type: 'start', x: 5, y: 5 }).state).toBe(refreshing)
  })
})

/**
 * The hook is DOM-bound and vitest runs in node, so its wiring is checked in
 * the source, the way the swipe row's is.
 */
describe('pull to refresh: wired the way the shell needs', () => {
  // comments are allowed to name what the code must not call
  const hook = read('../components/PullToRefresh.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const planner = plannerSource()
  const css = sheetSource()

  it('gates on the html.native class so ?native=1 can preview it, not on isNative()', () => {
    expect(hook).toContain("classList.contains('native')")
    expect(hook).not.toContain('isNative(')
  })

  it('goes non-passive only for the touchmove of a live pull', () => {
    const nonPassive = hook.match(/passive: false/g) ?? []
    expect(nonPassive).toHaveLength(1)
    expect(hook).toMatch(/addEventListener\('touchmove', onMove, \{ passive: false \}\)/)
  })

  it('refuses a pull that starts on a sheet, a field, or under the keyboard', () => {
    expect(hook).toContain('.cal-sheet-backdrop')
    expect(hook).toContain('.modal-backdrop')
    expect(hook).toContain("classList.contains('keyboard-open')")
    expect(hook).toContain('window.scrollY > 0')
  })

  it('buzzes only on entering the band, from the step result', () => {
    expect(hook.match(/void haptic\('light'\)/g)).toHaveLength(1)
    expect(hook).toMatch(/if \(r\.buzz\) void haptic\('light'\)/)
  })

  it('runs the same refresh the header pill does, and the pill runs the foreground set', () => {
    expect(planner).toContain('onRefresh={manualSync}')
    expect(planner).toContain('Promise.allSettled([store.syncNowManual(), calendars.refresh(), googlePush.pullNow(), microsoftSync.pullNow()])')
  })

  it('has a refresh icon, and its chrome lives in the native shell block', () => {
    expect(read('../components/Icon.tsx')).toMatch(/\n {2}refresh: \(/)
    expect(css.indexOf('.native .ptr {')).toBeGreaterThan(css.indexOf('NATIVE SHELL'))
    expect(css).toContain('@keyframes ptr-spin')
    // the sticky top bar and the body scroller mean only the disc may move
    expect(css).not.toMatch(/\.native \.ptr[^{]*\.content/)
  })

  it('slides out from under the top bar, not across it', () => {
    // the disc rests inside the bar's box, so it must stack beneath the bar
    const z = (sel: string) => Number(css.slice(css.indexOf(sel)).match(/z-index: (\d+)/)![1])
    expect(z('.native .ptr {')).toBeLessThan(z('.topbar {'))
    expect(z('.native .ptr {')).toBeGreaterThan(5)
  })

  it('shares its axis lock with the swipe row, so a diagonal start goes to one of them', () => {
    const row = read('../components/Today.tsx')
    expect(row).toMatch(/import \{ lockAxis \} from '\.\.\/pull'/)
    expect(row).toMatch(/const axis = lockAxis\(ddx, ddy\)/)
    // no second dead zone of its own
    expect(row).not.toMatch(/Math\.abs\(ddx\) < \d/)
  })

  it('waits for the sync already running instead of reporting done at once', () => {
    // a pull right after a foreground resume joins that sync; a false or an
    // early return would collapse the disc while the real sync is in flight
    const store = read('../store.ts')
    expect(store).toMatch(/if \(syncInflight\.current\) return syncInflight\.current/)
    expect(store).not.toMatch(/syncBusy/)
    const cal = read('../calendars.ts')
    const feeds = cal.slice(cal.indexOf('const refresh = useCallback('), cal.indexOf('// boot: serve the cache'))
    expect(feeds).toMatch(/if \(inflight\.current\) return inflight\.current/)
    expect(feeds).not.toMatch(/busy\.current/)
  })

  it('names no chrome that is gone', () => {
    // the More drawer left with the five-tab bar; its selector would keep
    // its dead CSS looking live
    expect(hook).not.toContain('.more-backdrop')
    expect(css).not.toMatch(/\.more-(backdrop|sheet|item)/)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dragSheet } from '../components/Modal'

// Dragging a sheet down past the line asks it to close. A close can be turned
// down — the task editor's "Discard your changes?" answered Cancel — and the
// sheet was left pushed down where the finger let go, with no way back up but
// another drag. It now goes back up when it is still there a frame later.
//
// The drag is driven here on stand-ins for the title bar and the panel: the
// real gesture on a WKWebView was checked in the simulator (modal.test.ts).

type Listener = (ev: { clientY: number; timeStamp: number }) => void

let frames: (() => void)[]

beforeEach(() => {
  frames = []
  vi.stubGlobal('document', { documentElement: { classList: { contains: (c: string) => c === 'native' } } })
  // nothing pressed here is a control in the bar
  vi.stubGlobal('Element', class {})
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => frames.push(fn))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A sheet on screen and its title bar, with the drag's listeners kept where a test can fire them. */
function sheet() {
  const panel = { isConnected: true, style: {} as Record<string, string> }
  const listeners = new Map<string, Listener>()
  const head = {
    closest: (selector: string) => (selector === '[role="dialog"]' ? panel : null),
    setPointerCapture: () => {},
    addEventListener: (type: string, fn: Listener) => void listeners.set(type, fn),
    removeEventListener: (type: string) => void listeners.delete(type),
  }
  /** Press at y = 100, move to `to`, and lift there, slowly enough not to count as a throw. */
  const drag = (to: number, close: () => void) => {
    dragSheet({ button: 0, pointerType: 'touch', pointerId: 1, clientY: 100, timeStamp: 0, target: {}, currentTarget: head } as unknown as Parameters<typeof dragSheet>[0], close)
    listeners.get('pointermove')!({ clientY: to, timeStamp: 400 })
    listeners.get('pointerup')!({ clientY: to, timeStamp: 1000 })
  }
  return { panel, listeners, drag }
}

describe('letting go of a sheet dragged past the line', () => {
  it('goes back up when the close was turned down', () => {
    const { panel, drag } = sheet()
    const close = vi.fn() // "Discard your changes?" → Cancel: the sheet stays
    drag(260, close)
    expect(close).toHaveBeenCalledTimes(1)
    // still where the finger let go until the frame has shown whether it went
    expect(panel.style.transform).toBe('translateY(160px)')
    frames.forEach(f => f())
    expect(panel.style.transform).toBe('')
    expect(panel.style.transition).toMatch(/^transform 0\.24s/)
  })

  it('is left alone when the close went through and the sheet is gone', () => {
    const { panel, drag } = sheet()
    drag(260, () => {
      panel.isConnected = false
    })
    frames.forEach(f => f())
    expect(panel.style.transform).toBe('translateY(160px)')
  })

  it('goes back at once, with no animation, for someone who asked for less motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { panel, drag } = sheet()
    drag(260, () => {})
    frames.forEach(f => f())
    expect(panel.style.transform).toBe('')
    expect(panel.style.transition).toBe('none')
  })
})

describe('a short drag', () => {
  it('springs back without asking to close, and lets go of its listeners', () => {
    const { panel, listeners, drag } = sheet()
    const close = vi.fn()
    drag(150, close)
    expect(close).not.toHaveBeenCalled()
    expect(panel.style.transform).toBe('')
    expect(frames).toEqual([])
    expect(listeners.size).toBe(0)
  })
})

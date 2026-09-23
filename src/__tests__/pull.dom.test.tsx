// @vitest-environment happy-dom
import { act, render, screen, waitFor } from './dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Pull to refresh in the iOS shell, driven with touches as a finger would
// drive it: the hook listens on the document, so each touch is dispatched on
// whatever the finger landed on and bubbles up to it. pull.test.ts pins the
// arithmetic (how far is far enough); this is the gesture around it.

const haptic = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../native', () => ({ haptic }))

import { PullToRefresh } from '../components/PullToRefresh'

/** A touch at (x, y) on `target`, or the finger lifting when there is no point. */
function touch(type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', target: EventTarget, point?: { x: number; y: number }) {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'touches', { value: point ? [{ clientX: point.x, clientY: point.y }] : [] })
  act(() => void target.dispatchEvent(e))
  return e
}

/** Down from `from`, through each y in `ys`, and let go: what one pull does. */
function pull(target: EventTarget, ys: number[], from = 100) {
  touch('touchstart', target, { x: 50, y: from })
  const moves = ys.map(y => touch('touchmove', target, { x: 50, y }))
  touch('touchend', target)
  return moves
}

let finishRefresh = () => {}
const onRefresh = vi.fn(() => new Promise<void>(resolve => (finishRefresh = resolve)))

beforeEach(() => {
  document.documentElement.className = 'native'
  document.body.innerHTML = '<main class="tab"><p>Today</p><input aria-label="Title" /><div class="modal-backdrop"><div role="dialog">Sheet</div></div></main>'
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
  haptic.mockClear()
  onRefresh.mockClear()
})
afterEach(() => {
  document.documentElement.className = ''
})

const page = () => document.querySelector('main p')!

describe('pull to refresh in the iOS shell', () => {
  it('refreshes once when a pull from the top is let go past the line, buzzing once on the way', async () => {
    render(<PullToRefresh enabled onRefresh={onRefresh} />)
    // 144px of finger is 72px of disc: the line; the wobble back stays inside the band
    pull(page(), [120, 200, 250, 240, 260])
    expect(haptic).toHaveBeenCalledTimes(1)
    expect(haptic).toHaveBeenCalledWith('light')
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Refreshing…')).toBeTruthy()
    // the disc stays up while the sync runs, and goes when it is done
    act(() => finishRefresh())
    await waitFor(() => expect(screen.queryByText('Refreshing…')).toBeNull(), { timeout: 2000 })
  })

  it('does nothing for a pull let go short of the line', () => {
    render(<PullToRefresh enabled onRefresh={onRefresh} />)
    pull(page(), [120, 180, 230])
    expect(onRefresh).not.toHaveBeenCalled()
    expect(haptic).not.toHaveBeenCalled()
  })

  it('owns the touch only once it is a pull: then it stops the page bouncing, before that it never listens', () => {
    const listen = vi.spyOn(document, 'addEventListener')
    render(<PullToRefresh enabled onRefresh={onRefresh} />)
    const moves = () => listen.mock.calls.filter(([type]) => type === 'touchmove')
    // mounting adds no touchmove listener: ordinary scrolling never pays for one
    expect(moves()).toEqual([])
    touch('touchstart', page(), { x: 50, y: 100 })
    expect(moves()).toHaveLength(1)
    expect(moves()[0][2]).toEqual({ passive: false })
    const e = touch('touchmove', page(), { x: 50, y: 160 })
    expect(e.defaultPrevented).toBe(true)
    touch('touchend', page())
    listen.mockRestore()
  })

  it('hands a sideways start to the swipe rows, and lets the page scroll', () => {
    render(<PullToRefresh enabled onRefresh={onRefresh} />)
    touch('touchstart', page(), { x: 50, y: 100 })
    const sideways = touch('touchmove', page(), { x: 80, y: 104 })
    expect(sideways.defaultPrevented).toBe(false)
    // later samples are not the pull's either, however far down they go
    expect(touch('touchmove', page(), { x: 80, y: 300 }).defaultPrevented).toBe(false)
    touch('touchend', page())
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('leaves alone a touch that starts in a field, a sheet or a dialog', () => {
    render(<PullToRefresh enabled onRefresh={onRefresh} />)
    pull(document.querySelector('input')!, [200, 300])
    pull(document.querySelector('.modal-backdrop')!, [200, 300])
    pull(screen.getByRole('dialog'), [200, 300])
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('does nothing under the keyboard, below the top of the page, or while a sheet owns the screen', () => {
    const { rerender } = render(<PullToRefresh enabled onRefresh={onRefresh} />)
    document.documentElement.classList.add('keyboard-open')
    pull(page(), [200, 300])
    document.documentElement.classList.remove('keyboard-open')
    Object.defineProperty(window, 'scrollY', { value: 40, configurable: true })
    pull(page(), [200, 300])
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
    rerender(<PullToRefresh enabled={false} onRefresh={onRefresh} />)
    pull(page(), [200, 300])
    expect(onRefresh).not.toHaveBeenCalled()
    // and the same pull with none of those in the way refreshes
    rerender(<PullToRefresh enabled onRefresh={onRefresh} />)
    pull(page(), [200, 300])
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('is not there at all outside the iOS look: html.native, not a native bridge, decides', () => {
    document.documentElement.className = ''
    const { container } = render(<PullToRefresh enabled onRefresh={onRefresh} />)
    expect(container.innerHTML).toBe('')
    pull(page(), [200, 300])
    expect(onRefresh).not.toHaveBeenCalled()
  })
})

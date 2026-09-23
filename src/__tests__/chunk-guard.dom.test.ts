// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHUNK_RELOAD_KEY, guardChunkLoads } from '../lazyload'

// A chunk that will not load reloads the page once, so a page open across a
// deploy picks up the new files. WebKit also rejects the imports a page was
// still fetching when it starts to navigate away — with the same error — and
// a reload then cut into the navigation already under way (the e2e journal
// test's second open landed back on the page it was leaving, every time).

const reload = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  reload.mockClear()
  sessionStorage.removeItem(CHUNK_RELOAD_KEY)
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })
  guardChunkLoads()
})

afterEach(() => {
  vi.useRealTimers()
})

const chunkFails = () => window.dispatchEvent(new Event('vite:preloadError'))

describe('a chunk that will not load', () => {
  it('reloads the page, as after a deploy', () => {
    chunkFails()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload a page that has started to leave', () => {
    window.dispatchEvent(new Event('beforeunload'))
    chunkFails()
    window.dispatchEvent(new Event('pagehide'))
    chunkFails()
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads again once a navigation was called off, or the page came back', () => {
    window.dispatchEvent(new Event('beforeunload'))
    vi.advanceTimersByTime(3_001)
    chunkFails()
    expect(reload).toHaveBeenCalledTimes(1)

    sessionStorage.removeItem(CHUNK_RELOAD_KEY)
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('pageshow'))
    chunkFails()
    expect(reload).toHaveBeenCalledTimes(2)
  })
})

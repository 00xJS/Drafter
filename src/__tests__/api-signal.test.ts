import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// apiFetch and a caller's own abort signal. The caller's signal was spread into
// the request with the rest of its options and then replaced by the timeout's,
// so a request someone stopped carried on to the end. The two are one signal
// now, put together by hand: AbortSignal.any would need iOS 17.4.

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' }, registerPlugin: () => ({}) }))
// no session to attach, and no reading of this machine's environment
vi.mock('../supabase', () => ({ getSupabase: () => null, isSupabaseConfigured: () => true }))

import { ApiError, apiFetch } from '../api'

/** A fetch that answers only when told, and fails as a browser does when its signal goes. */
function pendingFetch() {
  const seen: { signal: AbortSignal; answer(r: Response): void }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init.signal!
          if (signal.aborted) return reject(signal.reason)
          signal.addEventListener('abort', () => reject(signal.reason))
          seen.push({ signal, answer: resolve })
        }),
    ),
  )
  return seen
}

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a caller’s signal reaches the request', () => {
  it('stops it when the caller stops, and the caller hears its own abort, not “unreachable”', async () => {
    const seen = pendingFetch()
    const stop = new AbortController()
    const asked = apiFetch('/api/ai', { signal: stop.signal })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].signal.aborted).toBe(false)
    stop.abort()
    const e = await asked.catch(x => x)
    expect(seen[0].signal.aborted).toBe(true)
    expect(e).not.toBeInstanceOf(ApiError)
    expect((e as DOMException).name).toBe('AbortError')
  })

  it('never sends one stopped before it was asked', async () => {
    const seen = pendingFetch()
    const stop = new AbortController()
    stop.abort()
    await expect(apiFetch('/api/ai', { signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(seen).toHaveLength(0)
  })

  it('still times out on its own, and says the server was slow', async () => {
    vi.useFakeTimers()
    const seen = pendingFetch()
    const stop = new AbortController()
    const asked = apiFetch('/api/ai', { signal: stop.signal, timeoutMs: 5000 }).catch(x => x)
    await vi.advanceTimersByTimeAsync(4999)
    expect(seen[0].signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const e = (await asked) as ApiError
    expect(e).toBeInstanceOf(ApiError)
    expect(e.message).toBe('Drafter’s server took too long to answer — try again in a moment.')
    // the caller's own signal is left as it was
    expect(stop.signal.aborted).toBe(false)
  })

  it('times out with no signal of the caller’s, as before', async () => {
    vi.useFakeTimers()
    pendingFetch()
    const asked = apiFetch('/api/push').catch(x => x)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(((await asked) as ApiError).message).toMatch(/took too long/)
  })

  it('answers as ever when the server does, with the options passed through', async () => {
    const seen = pendingFetch()
    const asked = apiFetch('/api/push', { method: 'POST', body: '{}', timeoutMs: 1000 })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    seen[0].answer(new Response('ok'))
    expect(await (await asked).text()).toBe('ok')
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit & { timeoutMs?: number }]
    expect(init).toMatchObject({ method: 'POST', body: '{}' })
    expect(init).not.toHaveProperty('timeoutMs')
  })
})

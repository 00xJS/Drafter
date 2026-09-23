import { afterEach, describe, expect, it, vi } from 'vitest'

// Every request that got no answer said "The server is unreachable from here
// — this runs on the hosted site (or via `netlify dev` locally)", and Find
// address said it "works on the hosted site and in the iPhone app" — in the
// iPhone app, and when the phone was simply offline. Both read as something
// not set up. Offline is now said as offline, and the app is never told to go
// and use the app.

const env = vi.hoisted(() => ({ native: false, configured: true }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => env.native, getPlatform: () => (env.native ? 'ios' : 'web') },
  registerPlugin: () => ({}),
}))
// no session to attach, and no reading of this machine's environment
vi.mock('../supabase', () => ({ getSupabase: () => null, isSupabaseConfigured: () => env.configured }))

import { ApiError, OFFLINE_MESSAGE, apiFetch, isOffline } from '../api'
import { LookupError, NEEDS_SERVER, SERVER_DID_NOT_ANSWER, findAddress } from '../geocode'

const failWith = (e: unknown) =>
  vi.stubGlobal('fetch', async () => {
    throw e
  })
const online = (on: boolean) => vi.stubGlobal('navigator', { onLine: on })

afterEach(() => {
  env.native = false
  env.configured = true
  vi.unstubAllGlobals()
})

describe('a request that got no answer', () => {
  it('says offline when the fetch failed at the network', async () => {
    online(true)
    failWith(new TypeError('Load failed'))
    const e = await apiFetch('/api/geocode').catch(x => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({ message: OFFLINE_MESSAGE, offline: true })
    expect(OFFLINE_MESSAGE).toBe('You’re offline — try again when you’re connected.')
  })

  it('says offline whenever the device says it is, whatever the fetch threw', async () => {
    online(false)
    failWith(new DOMException('The operation timed out.', 'TimeoutError'))
    await expect(apiFetch('/api/ai')).rejects.toMatchObject({ message: OFFLINE_MESSAGE, offline: true })
  })

  it('calls a timeout while online a slow server, not a missing one', async () => {
    online(true)
    failWith(new DOMException('The operation timed out.', 'TimeoutError'))
    const e = (await apiFetch('/api/ai').catch(x => x)) as ApiError
    expect(e.offline).toBe(false)
    expect(e.message).toBe('Drafter’s server took too long to answer — try again in a moment.')
  })

  it('never tells the iPhone app to use the hosted site', async () => {
    env.native = true
    online(true)
    failWith(new DOMException('Blocked', 'SecurityError'))
    const e = (await apiFetch('/api/household').catch(x => x)) as ApiError
    expect(e.message).toBe('Drafter’s server could not be reached — try again in a moment.')
    expect(e.message).not.toMatch(/hosted site|netlify dev/)
  })

  it('keeps the hint for a copy of the web app running on its own', async () => {
    online(true)
    failWith(new DOMException('Blocked', 'SecurityError'))
    await expect(apiFetch('/api/household')).rejects.toThrow('this runs on the hosted site')
  })

  it('tells offline apart for anyone holding a failure', () => {
    online(true)
    expect(isOffline(new TypeError('Failed to fetch'))).toBe(true)
    expect(isOffline(new ApiError(OFFLINE_MESSAGE, 0, true))).toBe(true)
    expect(isOffline(new ApiError('Refused', 403))).toBe(false)
    expect(isOffline(new Error('Something else'))).toBe(false)
    online(false)
    expect(isOffline()).toBe(true)
  })
})

describe('Find address', () => {
  const answer = (res: Response | Error) => ({ fetch: async () => (res instanceof Error ? Promise.reject(res) : res), sleep: async () => {} })

  it('says offline when the phone is offline, in the app and on the web', async () => {
    online(true)
    for (const native of [true, false]) {
      env.native = native
      await expect(findAddress('Chipotle', null, answer(new TypeError('Load failed')))).rejects.toMatchObject({ message: OFFLINE_MESSAGE, kind: 'server' })
    }
    // and through the app's own request, which says so for itself
    failWith(new TypeError('Load failed'))
    const e = await findAddress('Chipotle', null, { sleep: async () => {} }).catch(x => x)
    expect(e).toBeInstanceOf(LookupError)
    expect(e.message).toBe(OFFLINE_MESSAGE)
  })

  it('in the app, a server that answers nothing usable is not "a copy running on its own"', async () => {
    env.native = true
    online(true)
    for (const res of [new Response('Not Found', { status: 404 }), new Response('<!doctype html>', { status: 200 })]) {
      await expect(findAddress('x', null, answer(res))).rejects.toMatchObject({ message: SERVER_DID_NOT_ANSWER, kind: 'server' })
    }
    // a lookup that did not go through says try again, not "use the app"
    await expect(findAddress('x', null, answer(new DOMException('Blocked', 'SecurityError')))).rejects.toMatchObject({
      message: 'The lookup did not go through. Try again in a moment.',
    })
  })

  it('on the web, a copy with no backend still says it needs the server', async () => {
    online(true)
    await expect(findAddress('x', null, answer(new Response('<!doctype html>', { status: 200 })))).rejects.toMatchObject({ message: NEEDS_SERVER })
    env.configured = false
    await expect(findAddress('x', null, answer(new DOMException('Blocked', 'SecurityError')))).rejects.toMatchObject({ message: NEEDS_SERVER })
  })
})

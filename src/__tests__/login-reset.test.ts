import { afterEach, describe, expect, it, vi } from 'vitest'
import { OFFLINE_MESSAGE } from '../api'
import { resetReply } from '../components/Login'

// Forgot password said "a link … is on its way" whatever Supabase answered:
// offline, or with Drafter's few emails an hour used up, a reset that never
// went out read as one that had. It now says those two — neither of which
// depends on the address — and still never tells an address with an account
// from one without, since the form is public.

const TO = 'maria@example.com'
const SENT = { sent: `If ${TO} has an account, a link to set a new password is on its way. It can take a minute.` }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('what Forgot password says', () => {
  it('says a link is on its way when Supabase took the request', () => {
    expect(resetReply(TO, null)).toEqual(SENT)
  })

  it('says offline when the request never reached Supabase', () => {
    vi.stubGlobal('navigator', { onLine: true })
    expect(resetReply(TO, { name: 'AuthRetryableFetchError', status: 0, message: 'Load failed' })).toEqual({ error: OFFLINE_MESSAGE })
    vi.stubGlobal('navigator', { onLine: false })
    expect(resetReply(TO, { name: 'AuthApiError', status: 400, message: 'anything' })).toEqual({ error: OFFLINE_MESSAGE })
  })

  it('says the site’s email allowance is used up, without a word about the address', () => {
    const reply = resetReply(TO, { name: 'AuthApiError', status: 429, message: 'email rate limit exceeded' })
    expect(reply).toEqual({ error: 'No reset email went out: Drafter can send only a few emails an hour, and it has just sent them. Try again later.' })
    expect(JSON.stringify(reply)).not.toContain(TO)
  })

  it('answers an account’s own "wait N seconds" exactly as a sent link, since only a real account is ever told to wait', () => {
    expect(resetReply(TO, { name: 'AuthApiError', status: 429, message: 'For security purposes, you can only request this after 42 seconds.' })).toEqual(SENT)
  })

  it('answers every other refusal as a sent link, since Supabase may give one only for a real account', () => {
    for (const failure of [
      { name: 'AuthRetryableFetchError', status: 500, message: 'Error sending recovery email' },
      { name: 'AuthRetryableFetchError', status: 504, message: 'HTTP 504' },
      { name: 'AuthApiError', status: 422, message: 'User not allowed' },
      { name: 'AuthUnknownError', message: 'Unexpected token' },
    ]) {
      expect(resetReply(TO, failure), failure.message).toEqual(SENT)
    }
  })
})

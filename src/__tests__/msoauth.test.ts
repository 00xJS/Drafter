import { describe, expect, it } from 'vitest'
import { oauthFailureCode } from '../../netlify/functions/lib/microsoft.mjs'

// The browser refuses to show anything but a bare code (see oauthReasonLabel),
// so the only way a failed Outlook connect can explain itself is for the server
// to read the AADSTS code out of Microsoft's prose and send a token the client
// has words for. These pin the mapping for the failures people actually hit.
describe('oauthFailureCode', () => {
  const prose = (n: number, text: string) => ({ error: 'invalid_client', error_description: `AADSTS${n}: ${text}. Trace ID: 0000` })

  it('names an expired or mistyped client secret', () => {
    expect(oauthFailureCode(prose(7000222, 'The provided client secret keys for app x are expired'))).toBe('secret_expired')
    expect(oauthFailureCode(prose(7000215, 'Invalid client secret provided'))).toBe('bad_client_secret')
    // invalid_client with no AADSTS code at all is still a secret problem
    expect(oauthFailureCode({ error: 'invalid_client' })).toBe('bad_client_secret')
  })

  it('names the app-registration mistakes', () => {
    expect(oauthFailureCode(prose(700016, 'Application not found in the directory'))).toBe('bad_client_id')
    expect(oauthFailureCode(prose(50011, 'The reply URL specified in the request does not match'))).toBe('redirect_uri')
    // the reply URL was added under "Single-page application" instead of "Web"
    expect(oauthFailureCode({ error: 'invalid_request', error_description: "AADSTS9002327: Tokens issued for the 'Single-Page Application' client-type may only be redeemed via cross-origin requests" })).toBe('spa_platform')
    expect(oauthFailureCode(prose(50194, 'Application is not configured as a multi-tenant application'))).toBe('account_type')
    expect(oauthFailureCode({ error: 'unauthorized_client', error_description: 'AADSTS50020: User account from identity provider does not exist in tenant' })).toBe('account_type')
  })

  it('names consent and a stale sign-in', () => {
    expect(oauthFailureCode({ error: 'access_denied', error_description: 'AADSTS65001: The user or administrator has not consented' })).toBe('consent_required')
    expect(oauthFailureCode(prose(70000, 'The provided authorization code is expired'))).toBe('invalid_grant')
    expect(oauthFailureCode({ error: 'invalid_grant' })).toBe('invalid_grant')
  })

  it('keeps a plain refusal as itself and falls back safely on anything else', () => {
    expect(oauthFailureCode({ error: 'access_denied', error_description: 'The user cancelled' })).toBe('access_denied')
    expect(oauthFailureCode({ error_description: 'Something went wrong with a colon: and spaces' })).toBe('exchange_failed')
    expect(oauthFailureCode({})).toBe('exchange_failed')
    expect(oauthFailureCode(undefined)).toBe('exchange_failed')
  })

  it('never returns anything the client would refuse to show', () => {
    const samples = [{ error: 'weird value!' }, { error: 'x'.repeat(80) }, { error: '<script>' }, prose(1, 'nothing known')]
    for (const s of samples) expect(oauthFailureCode(s)).toMatch(/^[a-z0-9_]{1,40}$/)
  })
})

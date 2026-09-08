import { describe, expect, it } from 'vitest'
import { oauthReasonLabel, paramsOf, parseLink, safeHttpUrl } from '../links'

describe('parseLink', () => {
  it('parses OAuth success and maps known failure reasons', () => {
    expect(parseLink(new URLSearchParams('google=connected')).oauth).toEqual({
      provider: 'google',
      ok: true,
      reason: undefined,
    })
    expect(parseLink(new URLSearchParams('microsoft=error&reason=bad_state')).oauth).toMatchObject({
      provider: 'microsoft',
      ok: false,
      reason: 'bad state',
    })
    expect(oauthReasonLabel('<script>alert(1)</script>')).toBe('unknown error')
  })

  it('scopes drafter://oauth host to OAuth only', () => {
    const p = parseLink(new URLSearchParams('title=Nope&google=connected'), { host: 'oauth' })
    expect(p.oauth?.ok).toBe(true)
    expect(p.capture).toBeUndefined()
  })

  it('ignores unknown drafter:// hosts', () => {
    expect(parseLink(new URLSearchParams('title=Hack'), { host: 'evil' })).toEqual({})
  })

  it('moves a bare URL title into link and rejects javascript:', () => {
    const cap = parseLink(new URLSearchParams('title=https://example.com/x')).capture
    expect(cap?.title).toBe('')
    expect(cap?.link).toBe('https://example.com/x')
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined()
    expect(parseLink(new URLSearchParams('url=javascript:alert(1)&title=Hi')).capture?.link).toBeUndefined()
  })

  it('parses saw / task / view together with capture fields', () => {
    const p = parseLink(new URLSearchParams('view=today&saw=p1&due=2026-09-10T15:00:00.000Z&title=Dentist'))
    expect(p.view).toBe('today')
    expect(p.saw).toBe('p1')
    expect(p.capture?.title).toBe('Dentist')
    expect(p.capture?.dueAt).toBe('2026-09-10T15:00:00.000Z')
  })

  it('paramsOf extracts host from drafter:// URLs', () => {
    expect(paramsOf('drafter://oauth?google=connected').host).toBe('oauth')
    expect(paramsOf('drafter://new?title=Hi').params.get('title')).toBe('Hi')
  })
})

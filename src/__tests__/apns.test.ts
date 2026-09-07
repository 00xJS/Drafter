import { describe, expect, it } from 'vitest'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { apnsPayload, isGoneReason, makeApnsJwt } from '../../netlify/functions/lib/apns.mjs'

describe('APNs provider token', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

  it('is a JWT Apple will accept: ES256 header, team + issued-at, P-1363 signature', () => {
    const jwt = makeApnsJwt({ keyId: 'ABC123DEFG', teamId: 'TEAM123456', privateKey: pem }, Date.UTC(2026, 8, 7, 12))
    const [h, c, sig] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' })
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({ iss: 'TEAM123456', iat: Math.floor(Date.UTC(2026, 8, 7, 12) / 1000) })
    const ok = createVerify('SHA256')
      .update(`${h}.${c}`)
      .verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))
    expect(ok).toBe(true)
  })

  it('accepts a key pasted into an env var with literal \\n escapes', () => {
    const escaped = pem.replace(/\n/g, '\\n')
    expect(() => makeApnsJwt({ keyId: 'K', teamId: 'T', privateKey: escaped })).not.toThrow()
  })
})

describe('APNs payload', () => {
  it('carries title, body, a thread for collapsing, and the url for the tap handler', () => {
    expect(apnsPayload({ title: 'Due now: Bins', body: 'Tonight', tag: 'due-1', url: 'https://x/?task=1' })).toEqual({
      aps: { alert: { title: 'Due now: Bins', body: 'Tonight' }, sound: 'default', 'thread-id': 'due-1' },
      url: 'https://x/?task=1',
    })
  })

  it('knows which of Apple\'s answers mean "stop sending to this device"', () => {
    expect(isGoneReason(410, 'Unregistered')).toBe(true)
    expect(isGoneReason(400, 'BadDeviceToken')).toBe(true)
    expect(isGoneReason(403, 'InvalidProviderToken')).toBe(false)
    expect(isGoneReason(200, '')).toBe(false)
  })
})

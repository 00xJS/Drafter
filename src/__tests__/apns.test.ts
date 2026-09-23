import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { apnsPayload, appLink, isGoneReason, makeApnsJwt, sendApns } from '../../netlify/functions/lib/apns.mjs'

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
      // the app's own link: in the iPhone app the site's address names another host, and a tap opened nothing
      url: '/?task=1',
    })
  })

  it('hands the app the path and query of a site link, and any other link as it is', () => {
    expect(appLink('https://drafterz.netlify.app/?plan=day')).toBe('/?plan=day')
    expect(appLink('https://drafterz.netlify.app/?view=review&plan=week')).toBe('/?view=review&plan=week')
    expect(appLink('https://site.test')).toBe('/')
    expect(appLink('/?task=a%20b')).toBe('/?task=a%20b')
    expect(appLink('drafter://open?plan=day')).toBe('drafter://open?plan=day')
  })

  it('knows which of Apple\'s answers mean "stop sending to this device"', () => {
    expect(isGoneReason(410, 'Unregistered')).toBe(true)
    expect(isGoneReason(400, 'DeviceTokenNotForTopic')).toBe(true)
    // BadDeviceToken is a host mismatch, not a gone device
    expect(isGoneReason(400, 'BadDeviceToken')).toBe(false)
    expect(isGoneReason(403, 'InvalidProviderToken')).toBe(false)
    expect(isGoneReason(200, '')).toBe(false)
  })

  it('can carry a badge count for the home-screen icon', () => {
    expect(apnsPayload({ title: 'Hi', body: 'There', badge: 3 }).aps.badge).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// The hard stop. A stalled connection to Apple emits nothing — no error, no
// end — and the send used to wait on it for ever, holding the hourly digest
// until Netlify killed the run. A stand-in for node:http2 plays Apple here.
// ---------------------------------------------------------------------------

type Behaviour = 'answer' | 'stall' | 'close' | 'error'

/** A session whose one stream answers 200, never answers, closes with no answer, or errors. */
function session(behaviour: Behaviour) {
  const s = Object.assign(new EventEmitter(), { close: vi.fn(), destroy: vi.fn(), requests: 0 })
  const request = () => {
    s.requests++
    const req = Object.assign(new EventEmitter(), {
      setEncoding: () => {},
      end: () => {
        queueMicrotask(() => {
          if (behaviour === 'answer') {
            req.emit('response', { ':status': 200 })
            req.emit('end')
            req.emit('close')
          } else if (behaviour === 'close') req.emit('close')
          else if (behaviour === 'error') s.emit('error', new Error('socket hang up'))
        })
      },
    })
    return req
  }
  return Object.assign(s, { request })
}

describe('one notification to one device', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const stubKeys = () => {
    vi.stubEnv('APNS_KEY_ID', 'ABC123DEFG')
    vi.stubEnv('APNS_TEAM_ID', 'TEAM123456')
    vi.stubEnv('APNS_PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)
    vi.stubEnv('APNS_BUNDLE_ID', 'app.drafter.ios')
  }
  afterEach(() => vi.unstubAllEnvs())

  it('resolves Apple’s answer and closes the session politely', async () => {
    stubKeys()
    const s = session('answer')
    await expect(sendApns('ab'.repeat(32), { aps: {} }, { env: 'production', connect: () => s })).resolves.toEqual({ status: 200, reason: '', env: 'production' })
    expect(s.close).toHaveBeenCalled()
    expect(s.destroy).not.toHaveBeenCalled()
  })

  it('gives up on a stalled connection at the timer, tearing the session down', async () => {
    stubKeys()
    const s = session('stall')
    const started = Date.now()
    await expect(sendApns('ab'.repeat(32), { aps: {} }, { env: 'production', timeoutMs: 40, connect: () => s })).rejects.toThrow('APNs did not answer within 40 ms')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(s.destroy).toHaveBeenCalled()
  })

  it('rejects at once when the stream closes without an answer, or the session errors', async () => {
    stubKeys()
    await expect(sendApns('ab'.repeat(32), {}, { env: 'production', timeoutMs: 5_000, connect: () => session('close') })).rejects.toThrow('closed the stream without an answer')
    await expect(sendApns('ab'.repeat(32), {}, { env: 'production', timeoutMs: 5_000, connect: () => session('error') })).rejects.toThrow('socket hang up')
  })
})

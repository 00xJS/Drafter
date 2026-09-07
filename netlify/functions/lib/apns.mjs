// Apple Push Notification service, spoken directly: HTTP/2 to Apple with a
// provider token signed by the .p8 key. No SDK, nothing to update.
//
// Host env: APNS_KEY_ID (10 chars, from the key), APNS_TEAM_ID, APNS_PRIVATE_KEY
// (the .p8 file's contents; "\n" escapes are fine), APNS_BUNDLE_ID
// (app.drafter.ios) and APNS_ENV=sandbox for builds run from Xcode.

import http2 from 'node:http2'
import { createPrivateKey, createSign } from 'node:crypto'

const REQUIRED = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY', 'APNS_BUNDLE_ID']
export const missingApnsEnv = () => REQUIRED.filter(k => !process.env[k])
export const apnsConfigured = () => missingApnsEnv().length === 0

const host = () => (process.env.APNS_ENV === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com')

const b64url = s => Buffer.from(s).toString('base64url')

/** ES256 provider token. Apple wants a fresh one every 20–60 minutes. */
export function makeApnsJwt({ keyId, teamId, privateKey }, nowMs = Date.now()) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(nowMs / 1000) }))
  const key = createPrivateKey(String(privateKey).replace(/\\n/g, '\n'))
  const signature = createSign('SHA256').update(`${header}.${claims}`).sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url')
  return `${header}.${claims}.${signature}`
}

let cached = { token: '', at: 0 }
function providerToken(force = false) {
  const now = Date.now()
  if (force || !cached.token || now - cached.at > 40 * 60_000) {
    cached = { token: makeApnsJwt({ keyId: process.env.APNS_KEY_ID, teamId: process.env.APNS_TEAM_ID, privateKey: process.env.APNS_PRIVATE_KEY }, now), at: now }
  }
  return cached.token
}

/** The web-push payload, translated. `url` rides along for the tap handler. */
export function apnsPayload({ title, body, tag, url }) {
  return {
    aps: { alert: { title: String(title ?? 'Drafter'), body: String(body ?? '') }, sound: 'default', ...(tag ? { 'thread-id': String(tag) } : {}) },
    ...(url ? { url: String(url) } : {}),
  }
}

/** Apple's way of saying "this device is gone, stop sending". */
export const isGoneReason = (status, reason) => status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic'

/**
 * One notification to one device. Resolves { status, reason } for any HTTP
 * outcome; rejects only when Apple could not be reached at all.
 */
export function sendApns(deviceToken, payload, { topic = process.env.APNS_BUNDLE_ID, collapseId, ttlSeconds = 6 * 3600 } = {}) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(host())
    let settled = false
    const done = (fn, v) => {
      if (settled) return
      settled = true
      client.close()
      fn(v)
    }
    client.on('error', e => done(reject, e))
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken()}`,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + ttlSeconds),
      ...(collapseId ? { 'apns-collapse-id': String(collapseId).slice(0, 64) } : {}),
    }
    const req = client.request(headers)
    let status = 0
    let text = ''
    req.on('response', h => {
      status = Number(h[':status'] ?? 0)
    })
    req.setEncoding('utf8')
    req.on('data', chunk => {
      text += chunk
    })
    req.on('end', () => {
      let reason = ''
      try {
        reason = JSON.parse(text).reason ?? ''
      } catch {
        /* empty body on success */
      }
      if (reason === 'ExpiredProviderToken') providerToken(true)
      done(resolve, { status, reason })
    })
    req.on('error', e => done(reject, e))
    req.setTimeout(10_000, () => req.close())
    req.end(JSON.stringify(payload))
  })
}

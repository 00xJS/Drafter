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

export const apnsHostFor = env =>
  env === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com'

const defaultEnv = () => (process.env.APNS_ENV === 'sandbox' ? 'sandbox' : 'production')

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

/**
 * The link a push carries, as the iPhone app reads it. Pushes are written with
 * the site's full address, which a browser needs; the app's page is
 * capacitor://drafter, where that address names some other host and the tap
 * opened nothing. So Apple is handed the path and query alone — which every
 * build of the app reads, the ones from before src/links.ts inAppLink too.
 */
export function appLink(url) {
  const raw = String(url)
  if (!/^https?:\/\//i.test(raw)) return raw
  try {
    const u = new URL(raw)
    return `${u.pathname || '/'}${u.search}`
  } catch {
    return raw
  }
}

/** The web-push payload, translated. `url` rides along for the tap handler, as the app's own link (appLink). */
export function apnsPayload({ title, body, tag, url, badge }) {
  return {
    aps: {
      alert: { title: String(title ?? 'Drafter'), body: String(body ?? '') },
      sound: 'default',
      ...(tag ? { 'thread-id': String(tag) } : {}),
      ...(Number.isFinite(badge) ? { badge: Math.max(0, Math.floor(badge)) } : {}),
    },
    ...(url ? { url: appLink(url) } : {}),
  }
}

/**
 * Apple's way of saying "this device is gone, stop sending".
 * BadDeviceToken is NOT gone — it usually means sandbox/production host mismatch.
 */
export const isGoneReason = (status, reason) =>
  status === 410 || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic'

/**
 * The longest one notification may take, from connecting to Apple's answer.
 * Twice this (a BadDeviceToken retried on the other host) still leaves the
 * hourly digest time for everyone else inside Netlify's 30 seconds.
 */
export const APNS_TIMEOUT_MS = 8_000

/**
 * One notification to one device. Resolves { status, reason, env } for any HTTP
 * outcome; rejects when Apple could not be reached, or did not answer within
 * `timeoutMs`.
 *
 * That last one is the hard stop. A connection that stalls — TLS that never
 * completes, a stream Apple never answers — emits nothing at all: no error, no
 * end. The stream's own timeout only closed the stream, which settled nothing
 * either, so the promise waited for ever and the hourly digest sat on it until
 * Netlify killed the run. Now one timer covers the whole exchange: when it
 * fires the session is destroyed and the send rejects, like any other failure
 * to reach Apple. A stream that closes with no answer rejects at once.
 * `connect` is node:http2's, or a test's stand-in.
 * @param {string} deviceToken
 * @param {unknown} payload
 * @param {{ topic?: string, collapseId?: string, ttlSeconds?: number, env?: string, timeoutMs?: number, connect?: typeof http2.connect }} [opts]
 */
export function sendApns(
  deviceToken,
  payload,
  { topic = process.env.APNS_BUNDLE_ID, collapseId, ttlSeconds = 6 * 3600, env, timeoutMs = APNS_TIMEOUT_MS, connect = http2.connect } = {},
) {
  const useEnv = env === 'sandbox' || env === 'production' ? env : defaultEnv()
  return new Promise((resolve, reject) => {
    let client = null
    let settled = false
    const done = (fn, v, broken = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        // a session that stalled has nothing worth a polite goodbye
        if (broken) client?.destroy()
        else client?.close()
      } catch {
        /* already gone */
      }
      fn(v)
    }
    const timer = setTimeout(() => done(reject, new Error(`APNs did not answer within ${timeoutMs} ms`), true), timeoutMs)
    try {
      client = connect(apnsHostFor(useEnv))
    } catch (e) {
      done(reject, e, true)
      return
    }
    client.on('error', e => done(reject, e, true))
    let req
    try {
      req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${providerToken()}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + ttlSeconds),
        ...(collapseId ? { 'apns-collapse-id': String(collapseId).slice(0, 64) } : {}),
      })
    } catch (e) {
      // a key that will not sign, or a session already gone: a failure like any other, and the timer stops
      done(reject, e, true)
      return
    }
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
      done(resolve, { status, reason, env: useEnv })
    })
    req.on('error', e => done(reject, e, true))
    // after 'end' this settles nothing; before it, the stream is gone without an answer
    req.on('close', () => done(reject, new Error('APNs closed the stream without an answer'), true))
    req.end(JSON.stringify(payload))
  })
}

/**
 * Send with automatic sandbox/production retry on BadDeviceToken.
 * Returns { status, reason, env, envUpdated } — envUpdated when the working host
 * differs from what was tried first (caller should persist env on the subscription).
 */
export async function sendApnsWithRetry(deviceToken, payload, opts = {}) {
  const preferred = opts.env === 'sandbox' || opts.env === 'production' ? opts.env : defaultEnv()
  const first = await sendApns(deviceToken, payload, { ...opts, env: preferred })
  if (first.status >= 200 && first.status < 300) return { ...first, envUpdated: false }
  if (first.reason !== 'BadDeviceToken') return { ...first, envUpdated: false }
  const other = preferred === 'sandbox' ? 'production' : 'sandbox'
  const second = await sendApns(deviceToken, payload, { ...opts, env: other })
  if (second.status >= 200 && second.status < 300) return { ...second, envUpdated: true }
  // both failed — surface the first BadDeviceToken as a failure, not gone
  return { ...first, envUpdated: false }
}

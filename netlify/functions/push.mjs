// Web push subscriptions and digest preferences, per user.
//   GET  /api/push            { configured, publicKey, subscriptions, digestEmail, timezone }
//   POST /api/push { action } subscribe | unsubscribe | test | prefs
// VAPID keys come from the host: `npx web-push generate-vapid-keys` →
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (+ VAPID_SUBJECT, a mailto: or https:).

import { withCors } from './lib/cors.mjs'
import webpush from 'web-push'
import { getUser, settingsGet, settingsSet, settingsStoreConfigured } from './lib/session.mjs'
import { apnsConfigured, apnsPayload, isGoneReason, missingApnsEnv, sendApnsWithRetry } from './lib/apns.mjs'

// Two channels, one list: browser subscriptions carry an endpoint + keys and go
// through web-push; the iOS app's entries are { type: 'apns', token } and go
// straight to Apple. Either channel being set up makes push "configured".
export const webPushConfigured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)

export function pushConfigured() {
  return settingsStoreConfigured() && (webPushConfigured() || apnsConfigured())
}

export function configureWebPush() {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY)
}

const isApns = sub => sub?.type === 'apns' && typeof sub.token === 'string'

/**
 * Send to every subscription. Returns `gone` (expired endpoints to drop),
 * `failed` (everything else that errored), and `updated` (APNs entries whose
 * sandbox/production env was discovered and should be persisted).
 */
export async function sendToAll(subscriptions, payload) {
  const subs = subscriptions ?? []
  if (subs.some(sub => !isApns(sub)) && webPushConfigured()) configureWebPush()
  const gone = []
  const failed = []
  const updated = []
  await Promise.all(
    subs.map(async sub => {
      if (isApns(sub)) {
        if (!apnsConfigured()) return failed.push({ endpoint: sub.endpoint, kind: 'apns', statusCode: 501, body: `APNs is not configured on the host: set ${missingApnsEnv().join(', ')}` })
        try {
          const badge = Number.isFinite(payload.badge) ? payload.badge : undefined
          const { status, reason, env, envUpdated } = await sendApnsWithRetry(sub.token, apnsPayload({ ...payload, badge }), {
            collapseId: payload.tag,
            env: sub.env,
          })
          if (status >= 200 && status < 300) {
            if (envUpdated || (env && env !== sub.env)) updated.push({ ...sub, env })
            return
          }
          if (isGoneReason(status, reason)) gone.push(sub.endpoint)
          else failed.push({ endpoint: sub.endpoint, kind: 'apns', statusCode: status, body: reason })
        } catch (e) {
          failed.push({ endpoint: sub.endpoint, kind: 'apns', statusCode: 0, body: String(e?.message ?? e).slice(0, 200) })
        }
        return
      }
      if (!webPushConfigured()) return failed.push({ endpoint: sub.endpoint, kind: 'web', statusCode: 501, body: 'VAPID keys are not set on the host' })
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600 })
      } catch (e) {
        if (e?.statusCode === 404 || e?.statusCode === 410) gone.push(sub.endpoint)
        else failed.push({ endpoint: sub.endpoint, kind: 'web', statusCode: e?.statusCode ?? 0, body: String(e?.body ?? e?.message ?? '').slice(0, 200) })
      }
    }),
  )
  return { gone, failed, updated }
}

function explainPushFailure(failed) {
  const codes = [...new Set(failed.map(f => f.statusCode))]
  const apns = failed.filter(f => f.kind === 'apns')
  if (apns.length) {
    const reasons = [...new Set(apns.map(f => f.body).filter(Boolean))].join(', ')
    if (codes.includes(501)) return apns[0].body
    if (codes.includes(403)) return `Apple rejected the provider token (${reasons || '403'}). APNS_KEY_ID, APNS_TEAM_ID and APNS_PRIVATE_KEY must belong to one key from the Apple Developer portal, and APNS_BUNDLE_ID must match the app.`
    if (codes.includes(400)) return `Apple refused the request (${reasons || '400'}). A BadDeviceToken from a Simulator or Xcode build usually means APNS_ENV=sandbox is needed.`
    return `Apple refused the notification (${reasons || codes.join(', ')}).`
  }
  if (codes.includes(403) || codes.includes(401)) {
    return 'The push service rejected the VAPID credentials (403). VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be the matching pair from a single `npx web-push generate-vapid-keys` run — regenerate both, set both, redeploy, then turn push off and on again here.'
  }
  if (codes.includes(413)) return 'The notification payload was too large for the push service.'
  return `The push service refused the message (HTTP ${codes.join(', ') || 'unknown'}).`
}

const handler = async req => {
  const { user, response, unconfigured } = await getUser(req)
  if (response) return response
  if (unconfigured || !user) return Response.json({ error: 'Push needs a signed-in account (Supabase) — not available in local mode.' }, { status: 501 })
  const configured = pushConfigured()
  // what would make push work: the settings store always, plus at least one channel
  const missing = [
    !settingsStoreConfigured() && 'SUPABASE_SERVICE_KEY',
    !webPushConfigured() && !apnsConfigured() && 'VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (browsers) and/or APNS_KEY_ID + APNS_TEAM_ID + APNS_PRIVATE_KEY + APNS_BUNDLE_ID (iOS app)',
  ].filter(Boolean)

  try {
    if (req.method === 'GET') {
      const s = configured ? await settingsGet(user.id) : null
      return Response.json({
        configured,
        missing,
        webPush: webPushConfigured(),
        apns: apnsConfigured(),
        publicKey: process.env.VAPID_PUBLIC_KEY ?? null,
        subscriptions: (s?.push_subscriptions ?? []).map(x => x.endpoint),
        digestEmail: !!s?.digest_email,
        digestJournal: !!s?.digest_journal,
        // the client must render the SAVED hour, else an unrelated toggle
        // writes its default back over the user's choice
        digestHour: Number.isInteger(s?.digest_hour) ? s.digest_hour : 8,
        timezone: s?.timezone ?? null,
        email: user.email,
      })
    }
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    if (!configured) return Response.json({ error: `Push is not configured on the host: set ${missing.join(', ')}` }, { status: 501 })
    const body = await req.json().catch(() => ({}))
    const s = (await settingsGet(user.id)) ?? {}
    const subs = Array.isArray(s.push_subscriptions) ? s.push_subscriptions : []

    if (body.action === 'subscribe') {
      const sub = body.subscription
      let entry
      if (sub?.type === 'apns') {
        // the iOS app: a hex device token from Apple
        const token = String(sub.token ?? '')
        if (!/^[0-9a-f]{32,400}$/i.test(token)) return Response.json({ error: 'invalid device token' }, { status: 400 })
        if (!apnsConfigured()) return Response.json({ error: `APNs is not configured on the host: set ${missingApnsEnv().join(', ')}` }, { status: 501 })
        entry = { endpoint: `apns:${token}`, type: 'apns', token }
      } else {
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return Response.json({ error: 'invalid subscription' }, { status: 400 })
        if (!webPushConfigured()) return Response.json({ error: 'Browser push is not configured on the host: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY' }, { status: 501 })
        entry = { endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime ?? null }
      }
      const next = [...subs.filter(x => x.endpoint !== entry.endpoint), entry].slice(-8)
      await settingsSet(user.id, { push_subscriptions: next, timezone: typeof body.timezone === 'string' ? body.timezone : (s.timezone ?? null) })
      return Response.json({ ok: true, subscriptions: next.map(x => x.endpoint) })
    }
    if (body.action === 'unsubscribe') {
      const next = subs.filter(x => x.endpoint !== body.endpoint)
      await settingsSet(user.id, { push_subscriptions: next })
      return Response.json({ ok: true, subscriptions: next.map(x => x.endpoint) })
    }
    if (body.action === 'test') {
      const { gone, failed, updated } = await sendToAll(subs, { title: 'Drafter', body: 'Push reminders are on. You will get a digest each morning and a nudge when timed tasks come due.', tag: 'test' })
      let next = subs
      if (gone.length) next = next.filter(x => !gone.includes(x.endpoint))
      if (updated?.length) {
        const byEp = new Map(updated.map(u => [u.endpoint, u]))
        next = next.map(s => byEp.get(s.endpoint) ?? s)
      }
      if (next !== subs) await settingsSet(user.id, { push_subscriptions: next })
      if (failed.length) return Response.json({ error: explainPushFailure(failed) }, { status: 502 })
      const sent = next.length
      if (sent === 0) return Response.json({ error: 'No live subscriptions — turn push off and on again on this device.' }, { status: 409 })
      return Response.json({ ok: true, sent })
    }
    if (body.action === 'prefs') {
      await settingsSet(user.id, {
        digest_email: !!body.digestEmail,
        // opt-in: Sunday's unattended draft may read the week's journal; only written when sent,
        // so a toggle saved before migration 20260915 lands does not fail on the missing column
        ...(typeof body.digestJournal === 'boolean' ? { digest_journal: body.digestJournal } : {}),
        timezone: typeof body.timezone === 'string' ? body.timezone : (s.timezone ?? null),
        digest_hour: Number.isInteger(body.digestHour) ? Math.min(23, Math.max(0, body.digestHour)) : (s.digest_hour ?? 8),
      })
      return Response.json({ ok: true })
    }
    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    return Response.json({ error: e?.message ?? 'push settings unavailable' }, { status: e?.status === 501 ? 501 : 502 })
  }
}

export default withCors(handler)
